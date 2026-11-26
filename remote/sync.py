"""
Background sync engine that copies public Hubverse S3/GitHub hubs into the local viz cache.

Network access happens only here, only when the user asks for it (brand menu or `remote_sync.py`), and never
inside a request handler: the HTTP endpoints just start, inspect, or cancel a job running on its own thread.
Syncs are incremental (ETag/SHA + size diff against the manifest) and every file is validated and normalized
before it is atomically moved into place, so a failed or cancelled sync never leaves half-written data.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
import io
import json
import logging
import os
from pathlib import Path
import re
import threading
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple

import polars as pl

from viz.core.calendar import CalendarSpec, DEFAULT_FLUSIGHT_CALENDAR, infer_calendar
from viz.core.config import VizConfig
from viz.core.geo import GeoGraph, build_geo_graph
from viz.remote.hubs import HUB_ID_RE, HubSpec, hub_id_from_source, inspect_hub
from viz.remote.normalize import (
    NormalizationError, normalize_admissions, normalize_forecast, normalize_oracle, read_table,
)
from viz.remote.store import RemoteStore
from viz.remote.transports import (
    GitHubTransport,
    HubTransport,
    RemoteObject,
    S3Transport,
    SyncCancelled,
    TransportError,
    TransportNotFound,
    build_transport,
    validate_bucket_name,
    validate_github_repo,
)

logger = logging.getLogger("viz.remote")

FORECAST_KEY_RE = re.compile(r"^model-output/([^/]+)/(\d{4}-\d{2}-\d{2})-([^/]+)\.(parquet|csv)$")
SNAPSHOT_KEY_RE = re.compile(r"^auxiliary-data/target-data-archive/target-hospital-admissions_(\d{4}-\d{2}-\d{2})\.csv$")
ADMISSIONS_TARGET = "wk inc flu hosp"
MAX_WORKERS = 16
# Version of per-file normalization:
# v1 = quantiles only; v2 = added season peak rows; v3 = added sample trajectories, PMF bins, & CalendarSpec/GeoGraph
FILE_SCHEMA = 4  # bump whenever ingest/normalization output changes so synced files re-normalize


def _add_hub_warning(man: Dict[str, Any], msg: str) -> None:
    """Append a de-duplicated hub-level warning, keeping the most recent 50."""
    warnings = man.get("hub_warnings") or []
    if msg not in warnings:
        man["hub_warnings"] = (warnings + [msg])[-50:]


def _outdated(entry: Dict[str, Any]) -> bool:
    return int(entry.get("schema", 1)) < FILE_SCHEMA


def _is_known_skip(skipped: Dict[str, Any], o: RemoteObject) -> bool:
    entry = skipped.get(o.key)
    if not isinstance(entry, dict):
        return False
    return (
        entry.get("etag") == o.etag
        and int(entry.get("size", -1)) == o.size
        and not _outdated(entry)
    )


def _resolve_truth_plan(
    t_objs: Dict[str, RemoteObject],
    aux_objs: Optional[Dict[str, RemoteObject]] = None,
) -> Dict[str, Dict[str, Any]]:
    """Build canonical manifest descriptors for each supported upstream target-data layout."""
    plan: Dict[str, Dict[str, Any]] = {}
    oracle_obj = t_objs.get("target-data/oracle-output.parquet") or t_objs.get("target-data/oracle-output.csv")
    if oracle_obj is not None:
        plan["oracle"] = {
            "key": oracle_obj.key,
            "etag": oracle_obj.etag,
            "last_modified": oracle_obj.last_modified,
            "objs": [oracle_obj],
            "multi": False,
        }
    ts_obj = t_objs.get("target-data/time-series.parquet") or t_objs.get("target-data/time-series.csv")
    if ts_obj is not None:
        plan["time_series"] = {
            "key": ts_obj.key,
            "etag": ts_obj.etag,
            "last_modified": ts_obj.last_modified,
            "objs": [ts_obj],
            "multi": False,
        }
    latest_obj = t_objs.get("target-data/latest-data.parquet") or t_objs.get("target-data/latest-data.csv")
    if latest_obj is not None:
        plan["latest"] = {
            "key": latest_obj.key,
            "etag": latest_obj.etag,
            "last_modified": latest_obj.last_modified,
            "objs": [latest_obj],
            "multi": False,
        }
    else:
        respi_objs = sorted(
            (o for k, o in t_objs.items() if k.startswith("target-data/latest-") and k.endswith((".csv", ".parquet"))),
            key=lambda o: o.key,
        )
        nested_objs = sorted(
            (
                o for k, o in t_objs.items()
                if k.startswith("target-data/season_")
                and k.endswith((".csv", ".parquet"))
                and not k.endswith("-status.csv")
                and not Path(k).name.startswith("influenza-admissions")
            ),
            key=lambda o: o.key,
        )
        concat_objs = sorted(
            (
                o for k, o in (aux_objs or {}).items()
                if re.match(r"^auxiliary-data/concatenated_[^/]+data\.(csv|parquet)$", k)
            ),
            key=lambda o: o.key,
        ) if nested_objs else []
        multi_objs = respi_objs or (concat_objs + nested_objs)
        if multi_objs:
            lms = [o.last_modified for o in multi_objs if o.last_modified]
            plan["latest"] = {
                "key": ",".join(o.key for o in multi_objs),
                "etag": "|".join(f"{o.key}:{o.etag}" for o in multi_objs),
                "last_modified": max(lms) if lms else "",
                "objs": multi_objs,
                "multi": True,
            }
    adm_obj = t_objs.get("target-data/target-hospital-admissions.csv")
    if adm_obj is not None:
        plan["admissions"] = {
            "key": adm_obj.key,
            "etag": adm_obj.etag,
            "last_modified": adm_obj.last_modified,
            "objs": [adm_obj],
            "multi": False,
        }
    return plan


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_s3_time(ts: str) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def season_for_date(d: str, calendar: Optional[CalendarSpec] = None) -> str:
    if calendar is not None:
        return calendar.season_for_date(d)
    from viz.core.data_loader import SandboxDataLoader
    return SandboxDataLoader.get_flu_season_for_date(d)


def current_season(calendar: Optional[CalendarSpec] = None) -> str:
    return season_for_date(date.today().strftime("%Y-%m-%d"), calendar=calendar)


def _set_mtime(path: Path, ts_iso: str):
    dt = _parse_s3_time(ts_iso)
    if dt is not None:
        ts = dt.timestamp()
        os.utime(path, (ts, ts))


def _atomic_write_parquet(df: pl.DataFrame, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.tmp.{os.getpid()}.{threading.get_ident()}")
    try:
        df.write_parquet(tmp, compression="zstd")
        os.replace(tmp, dest)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _atomic_write_bytes(data: bytes, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.tmp.{os.getpid()}.{threading.get_ident()}")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, dest)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _atomic_write_json(data: Any, dest: Path):
    _atomic_write_bytes(json.dumps(data).encode("utf-8"), dest)


def _designated(yml_text: str) -> bool:
    return bool(re.search(r"^designated_model:\s*(true|yes)\s*$", yml_text, re.IGNORECASE | re.MULTILINE))


def _looks_like_github(source: str) -> bool:
    s = (source or "").strip()
    lower = s.lower()
    if lower.startswith("s3://"):
        return False
    if lower.startswith(("http://", "https://", "github.com/")):
        return True
    return "/" in s


def _source_label(src: Dict[str, Any]) -> str:
    return str(src.get("github_repo") or src.get("bucket") or src.get("label") or "archive")


class SyncJob:
    """Progress record for one sync; read by the UI through /api/remote/job."""

    def __init__(self, hub_id: str, seasons: List[str]):
        self.hub_id = hub_id
        self.seasons = seasons
        self.status = "running"  # running | done | error | cancelled
        self.phase = "Checking hub"
        self.files_total = 0
        self.files_done = 0
        self.bytes_done = 0
        self.bytes_total = 0
        self.error: Optional[str] = None
        self.summary: Dict[str, Any] = {}
        self.started_at = _utcnow()
        self.finished_at: Optional[str] = None
        self.cancel_event = threading.Event()
        self._lock = threading.Lock()

    def advance(self, n_bytes: int):
        with self._lock:
            self.files_done += 1
            self.bytes_done += n_bytes

    def to_dict(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "hub": self.hub_id,
                "seasons": self.seasons,
                "status": self.status,
                "phase": self.phase,
                "files_total": self.files_total,
                "files_done": self.files_done,
                "bytes_total": self.bytes_total,
                "bytes_done": self.bytes_done,
                "error": self.error,
                "summary": self.summary,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
            }


class RemoteManager:
    """Owns hub registration, compatibility checks, listing checks, and the (single) running sync job."""

    def __init__(
        self,
        store: RemoteStore,
        known_locations: Callable[[], Set[str]],
        is_non_negative: Callable[[str], bool],
        local_as_of_max: Callable[[], Optional[str]],
        on_inventory_change: Callable[[str, List[str]], None],
        client_factory: Callable[..., S3Transport] = S3Transport,
        is_compatible: Optional[Callable[[str], bool]] = None,
        transport_factory: Optional[Callable[..., HubTransport]] = None,
    ):
        self.store = store
        self._known_locations = known_locations
        self._is_non_negative = is_non_negative
        self._local_as_of_max = local_as_of_max
        self._on_inventory_change = on_inventory_change
        self._client_factory = client_factory
        self._is_compatible = is_compatible
        self._transport_factory = transport_factory
        self._jobs: Dict[str, SyncJob] = {}
        self._batch: Optional[Dict[str, Any]] = None
        self._batch_cancel = threading.Event()
        self._lock = threading.Lock()
        self._manifest_locks: Dict[str, threading.Lock] = {}
        self._status_cache: Dict[str, Tuple[Dict[str, Any], Dict[str, Any]]] = {}
        self._listing_cache: Dict[str, Tuple[float, List[Tuple[RemoteObject, str]]]] = {}

    # ---- status (no network) ----------------------------------------------------------------------------

    def hub_status(self, spec: HubSpec) -> Dict[str, Any]:
        man = self.store.load_manifest(spec.id) if self.store.has_data(spec.id) else None
        out: Dict[str, Any] = {
            **spec.to_dict(),
            "synced": man is not None,
            "enabled": self.store.is_enabled(spec.id),
            "compatible": bool(self._is_compatible(spec.id)) if self._is_compatible is not None else True,
        }
        job = self._jobs.get(spec.id)
        if job is not None:
            out["job"] = job.to_dict()
        if man is None:
            return out
        # The manifest snapshot object only changes when it is re-read or saved, so the O(files)
        # summary is memoized on its identity; anonymous status polling stays cheap.
        cached = self._status_cache.get(spec.id)
        if cached is not None and cached[0] is man:
            out.update(cached[1])
            return out
        summary: Dict[str, Any] = {}
        files = man["files"]
        shown = [
            f for f in files.values()
            if f.get("path") or f.get("samples_path") or f.get("pmf_path") or f.get("peak_path")
        ]
        models = {f["model"] for f in shown}
        dates = sorted({f["reference_date"] for f in shown})
        latest = dates[-1] if dates else None
        summary.update({
            "hub_name": man.get("hub_name"),
            "last_sync": man.get("last_sync"),
            "last_check": man.get("last_check"),
            "seasons": man.get("seasons", []),
            "calendar": man.get("calendar"),
            "files": len(files),
            "bytes": sum(int(f.get("stored_bytes", 0)) for f in files.values()),
            "models": len(models),
            "latest_round": latest,
            "latest_round_models": len({f["model"] for f in shown if f["reference_date"] == latest}),
            "truth": {
                k: {kk: v.get(kk) for kk in ("as_of", "max_date", "last_modified")}
                for k, v in man.get("truth", {}).items()
            },
            "warnings_count": sum(len(f.get("warnings", [])) for f in files.values()),
            "peak_outdated": sum(1 for f in files.values() if _outdated(f)),
            "pending": man.get("pending"),
        })
        self._status_cache[spec.id] = (man, summary)
        out.update(summary)
        return out

    def list_hubs(self) -> List[Dict[str, Any]]:
        return [self.hub_status(s) for s in self.store.hub_specs()]

    def get_job(self, hub_id: str) -> Optional[Dict[str, Any]]:
        job = self._jobs.get(hub_id)
        return job.to_dict() if job else None

    def batch_status(self) -> Optional[Dict[str, Any]]:
        with self._lock:
            if self._batch is None:
                return None
            return {
                **self._batch,
                "queued": list(self._batch.get("queued") or []),
                "completed": list(self._batch.get("completed") or []),
                "errors": dict(self._batch.get("errors") or {}),
            }

    def _is_busy_unlocked(self) -> bool:
        return any(j.status == "running" for j in self._jobs.values()) or bool(self._batch and self._batch.get("running"))

    def is_busy(self) -> bool:
        with self._lock:
            return self._is_busy_unlocked()

    def warnings(self, hub_id: str) -> List[Dict[str, Any]]:
        man = self.store.load_manifest(hub_id)
        rows = []
        for _, f in sorted(man["files"].items()):
            for w in f.get("warnings", []):
                rows.append({"model": f["model"], "reference_date": f["reference_date"], "message": w})
        for w in man.get("hub_warnings", []):
            rows.append({"model": None, "reference_date": None, "message": w})
        return rows

    # ---- registration & checks (network) ------------------------------------------------------------------

    def _client(self, bucket: str, cancel_event: Optional[threading.Event] = None) -> S3Transport:
        return self._client_factory(bucket, cancel_event=cancel_event)

    def _client_for_spec(self, spec: HubSpec, cancel_event: Optional[threading.Event] = None) -> HubTransport:
        if self._transport_factory is not None:
            return self._transport_factory(spec, cancel_event=cancel_event)
        if spec.transport == "s3":
            return self._client(spec.bucket, cancel_event=cancel_event)
        return build_transport(spec, cancel_event=cancel_event)

    def _client_for_source(self, src: Dict[str, Any], cancel_event: Optional[threading.Event] = None) -> HubTransport:
        sub_spec = HubSpec(
            id="archive",
            bucket=str(src.get("bucket") or ""),
            transport=str(src.get("transport") or ("github" if src.get("github_repo") else "s3")),
            github_repo=src.get("github_repo"),
            branch=str(src.get("branch") or "main"),
        )
        return self._client_for_spec(sub_spec, cancel_event=cancel_event)

    def _hub_calendar(self, hub_id: str, client: Optional[HubTransport] = None) -> CalendarSpec:
        tasks_path = self.store.hub_dir(hub_id) / "hub-config" / "tasks.json"
        if tasks_path.exists():
            try:
                tasks = json.loads(tasks_path.read_text(encoding="utf-8"))
                if isinstance(tasks, dict):
                    return infer_calendar(tasks)
            except Exception:
                pass
        if client is not None:
            try:
                tasks = json.loads(client.get("hub-config/tasks.json"))
                if isinstance(tasks, dict):
                    return infer_calendar(tasks)
            except Exception:
                pass
        return DEFAULT_FLUSIGHT_CALENDAR

    def add_hub(
        self,
        source: str,
        label: Optional[str] = None,
        *,
        transport: Optional[str] = None,
        branch: str = "main",
    ) -> Dict[str, Any]:
        """Validate an S3 bucket or GitHub `owner/repo` as a Hubverse hub and register it."""
        kind = (transport or ("github" if _looks_like_github(source) else "s3")).lower()
        if kind == "github":
            repo = validate_github_repo(source)
            existing = next(
                (s for s in self.store.hub_specs() if s.transport == "github" and s.github_repo == repo),
                None,
            )
            if existing:
                return {"ok": True, "hub": self.hub_status(existing), "already_registered": True}
            probe = HubSpec(
                id="probe",
                bucket="",
                transport="github",
                github_repo=repo,
                branch=(branch or "main").strip() or "main",
            )
            client = self._client_for_spec(probe)
            info = inspect_hub(client, self._known_locations())
            if not info.get("supported"):
                return {"ok": False, "supported": False, "reason": info.get("reason"), "name": info.get("name")}
            hub_id = hub_id_from_source(repo, [s.id for s in self.store.hub_specs()])
            name = (label or info.get("name") or repo).strip()[:60]
            short = re.sub(r"\s*(forecast\s*)?hub$", "", name, flags=re.IGNORECASE).strip()[:16] or hub_id
            spec = HubSpec(
                id=hub_id,
                bucket="",
                label=name,
                short_label=short,
                builtin=False,
                repo_url=info.get("repo_url") or f"https://github.com/{repo}",
                transport="github",
                github_repo=repo,
                branch=probe.branch,
            )
        else:
            bucket = validate_bucket_name(source)
            existing = next((s for s in self.store.hub_specs() if s.bucket == bucket), None)
            if existing:
                return {"ok": True, "hub": self.hub_status(existing), "already_registered": True}
            probe = HubSpec(id="probe", bucket=bucket, transport="s3")
            client = self._client_for_spec(probe)
            info = inspect_hub(client, self._known_locations())
            if not info.get("supported"):
                return {"ok": False, "supported": False, "reason": info.get("reason"), "name": info.get("name")}
            hub_id = hub_id_from_source(bucket, [s.id for s in self.store.hub_specs()])
            name = (label or info.get("name") or bucket).strip()[:60]
            short = re.sub(r"\s*(forecast\s*)?hub$", "", name, flags=re.IGNORECASE).strip()[:16] or hub_id
            spec = HubSpec(
                id=hub_id,
                bucket=bucket,
                label=name,
                short_label=short,
                builtin=False,
                repo_url=info.get("repo_url"),
                transport="s3",
            )
        assert HUB_ID_RE.match(spec.id)
        self.store.add_custom_hub(spec)
        return {"ok": True, "hub": self.hub_status(spec)}

    def _list_forecasts(self, client: HubTransport) -> List[RemoteObject]:
        return [o for o in client.list("model-output/") if FORECAST_KEY_RE.match(o.key)]

    def _list_primary_and_archives(
        self,
        spec: HubSpec,
        primary_client: HubTransport,
        cancel_event: Optional[threading.Event] = None,
    ) -> Tuple[List[Tuple[RemoteObject, str, Optional[HubTransport]]], List[str], bool]:
        """
        Return `(entries, archive_warnings, listing_complete)` where each entry is
        `(RemoteObject, source_label, client_or_none_for_primary)` across primary +
        any configured `archive_sources`, letting primary overwrite overlapping `(model, ref)` rounds.
        `listing_complete` is False if any source truncated or failed to list.
        """
        primary_objs = self._list_forecasts(primary_client)
        listing_complete = not bool(getattr(primary_client, "last_listing_truncated", False))
        archive_warnings: List[str] = []
        if not listing_complete:
            archive_warnings.append(
                f"Primary listing for '{spec.id}' was truncated upstream; keeping existing local rounds."
            )
        seen_round_models: Set[Tuple[str, str]] = set()
        combined: List[Tuple[RemoteObject, str, Optional[HubTransport]]] = []
        primary_tag = spec.github_repo or spec.bucket or spec.id

        # Deduplicate parquet vs csv within primary by preferring parquet
        sorted_primary = sorted(primary_objs, key=lambda o: (o.key.endswith(".csv"), o.key))
        for o in sorted_primary:
            m = FORECAST_KEY_RE.match(o.key)
            if not m:
                continue
            rk = (m.group(1), m.group(2))
            if rk in seen_round_models:
                continue
            seen_round_models.add(rk)
            combined.append((o, primary_tag, None))

        for src in spec.archive_sources or []:
            try:
                arch_client = self._client_for_source(src, cancel_event=cancel_event)
                arch_tag = _source_label(src)
                arch_objs = sorted(self._list_forecasts(arch_client), key=lambda o: (o.key.endswith(".csv"), o.key))
                if getattr(arch_client, "last_listing_truncated", False):
                    listing_complete = False
                    archive_warnings.append(
                        f"Archive source '{arch_tag}' listing was truncated; keeping existing local rounds."
                    )
                for o in arch_objs:
                    m = FORECAST_KEY_RE.match(o.key)
                    if not m:
                        continue
                    rk = (m.group(1), m.group(2))
                    if rk in seen_round_models:
                        continue
                    seen_round_models.add(rk)
                    combined.append((o, arch_tag, arch_client))
            except SyncCancelled:
                raise
            except (TransportError, OSError, ValueError) as exc:
                listing_complete = False
                archive_warnings.append(f"Archive source '{_source_label(src)}' unavailable: {exc}")

        return combined, archive_warnings, listing_complete

    def check(self, hub_id: str) -> Dict[str, Any]:
        """List the hub and summarize what is available and what changed since the last sync."""
        spec = self._require(hub_id)
        client = self._client_for_spec(spec)
        combined, _, listing_complete = self._list_primary_and_archives(spec, client)
        objs = [o for o, _, _ in combined]
        self._listing_cache[hub_id] = (time.time(), [(o, src) for o, src, _ in combined])
        cal = self._hub_calendar(hub_id, client=client)
        man = self.store.load_manifest(hub_id)
        synced_seasons = set(man.get("seasons", []))
        skipped_files = man.get("skipped_files") or {}

        seasons: Dict[str, Dict[str, Any]] = {}
        parsed_objs: List[Tuple[RemoteObject, str, str, str]] = []
        for o in objs:
            m = FORECAST_KEY_RE.match(o.key)
            model, ref = m.group(1), m.group(2)
            s = season_for_date(ref, calendar=cal)
            parsed_objs.append((o, model, ref, s))
            entry = seasons.setdefault(s, {"season": s, "files": 0, "bytes": 0, "models": set(), "rounds": {}})
            entry["files"] += 1
            entry["bytes"] += o.size
            entry["models"].add(model)
            entry["rounds"][ref] = entry["rounds"].get(ref, 0) + 1

        max_synced = max(synced_seasons) if synced_seasons else None
        newer_seasons = sorted(s for s in seasons if max_synced is not None and s > max_synced)
        check_seasons = synced_seasons | set(newer_seasons)

        new = changed = outdated = 0
        listed_synced_keys: Set[str] = set()
        for o, _, _, s in parsed_objs:
            if s in synced_seasons:
                listed_synced_keys.add(o.key)
            if s in check_seasons:
                if _is_known_skip(skipped_files, o):
                    continue
                have = man["files"].get(o.key)
                if have is None:
                    new += 1
                elif have.get("etag") != o.etag or int(have.get("size", -1)) != o.size:
                    changed += 1
                elif _outdated(have):
                    changed += 1
                    outdated += 1
        removed = (
            sum(
                1 for k, f in man["files"].items()
                if season_for_date(f["reference_date"], calendar=cal) in synced_seasons and k not in listed_synced_keys
            )
            if listing_complete and (bool(listed_synced_keys) or not man["files"])
            else 0
        )

        truth_changed = False
        truth_last_modified: Optional[str] = None
        if self.store.has_data(hub_id):
            try:
                t_objs = {o.key: o for o in client.list("target-data/")}
            except TransportError:
                t_objs = {}
            man_truth = man.get("truth", {})
            truth_plan = _resolve_truth_plan(t_objs)
            if t_objs and (not truth_plan or any(k.startswith("target-data/season_") for k in t_objs)):
                try:
                    aux_for_truth = {o.key: o for o in client.list("auxiliary-data/")}
                except TransportError:
                    aux_for_truth = {}
                truth_plan = _resolve_truth_plan(t_objs, aux_objs=aux_for_truth)
            for kind, t_desc in truth_plan.items():
                lm = t_desc.get("last_modified")
                if lm and (truth_last_modified is None or lm > truth_last_modified):
                    truth_last_modified = lm
                prev_t = man_truth.get(kind, {})
                if prev_t:
                    if prev_t.get("etag") != t_desc["etag"]:
                        truth_changed = True
                elif kind == "oracle" or not man_truth:
                    truth_changed = True

        season_list = []
        for s in sorted(seasons, reverse=True):
            e = seasons[s]
            rounds = sorted(e["rounds"].items(), reverse=True)
            season_list.append({
                "season": s,
                "files": e["files"],
                "bytes": e["bytes"],
                "models": len(e["models"]),
                "rounds": [{"date": d, "models": n} for d, n in rounds],
                "synced": s in synced_seasons,
            })
        latest = max((FORECAST_KEY_RE.match(o.key).group(2) for o in objs), default=None)
        pending = {
            "new": new,
            "changed": changed,
            "removed": removed,
            "outdated": outdated,
            "new_seasons": newer_seasons,
            "listing_incomplete": not listing_complete,
            "truth_changed": truth_changed,
            "truth_last_modified": truth_last_modified,
            "checked_at": _utcnow(),
            "latest_round": latest,
        }
        if self.store.has_data(hub_id):
            # Re-load under the per-hub manifest lock and merge only the check fields, so a sync that
            # finished while we were listing is never overwritten by this (older) snapshot.
            with self._manifest_lock(hub_id):
                fresh = self.store.load_manifest(hub_id, mutable=True)
                fresh["last_check"] = pending["checked_at"]
                fresh["pending"] = pending
                self.store.save_manifest(hub_id, fresh)
        return {
            "hub": hub_id,
            "current_season": current_season(calendar=cal),
            "seasons": season_list,
            "pending": pending,
            "synced": self.store.has_data(hub_id),
        }

    # ---- sync -------------------------------------------------------------------------------------------

    def _require(self, hub_id: str) -> HubSpec:
        spec = self.store.get_spec(hub_id)
        if spec is None:
            raise KeyError(f"Unknown hub '{hub_id}'")
        return spec

    def start_sync(self, hub_id: str, seasons: Optional[List[str]] = None) -> Dict[str, Any]:
        spec = self._require(hub_id)
        with self._lock:
            if self._is_busy_unlocked():
                running = next((j for j in self._jobs.values() if j.status == "running"), None)
                if running:
                    raise RuntimeError(f"A sync for '{running.hub_id}' is already running")
                raise RuntimeError("A batch sync is already in progress")
            if not seasons:
                man = self.store.load_manifest(hub_id)
                cal = self._hub_calendar(hub_id)
                base_seasons = list(man.get("seasons") or [current_season(calendar=cal)])
                rollover = list((man.get("pending") or {}).get("new_seasons") or [])
                if rollover:
                    base_seasons.append(max(rollover))
                seasons = base_seasons
            seasons = sorted({s for s in seasons if re.match(r"^\d{4}(-\d{4})?$", str(s))})
            if not seasons:
                raise ValueError("No valid seasons requested (expected e.g. '2026-2027' or '2025')")
            job = SyncJob(hub_id, seasons)
            self._jobs[hub_id] = job
        threading.Thread(target=self._run_sync, args=(spec, job), daemon=True, name=f"sync-{hub_id}").start()
        return job.to_dict()

    def cancel(self, hub_id: str) -> bool:
        job = self._jobs.get(hub_id)
        if job and job.status == "running":
            job.cancel_event.set()
            return True
        return False

    def start_sync_all(self, hub_ids: Optional[List[str]] = None) -> Dict[str, Any]:
        """Sequentially sync missing built-in hubs (or the supplied list of hub ids)."""
        with self._lock:
            if self._is_busy_unlocked():
                raise RuntimeError("A hub sync is already running")
            specs_by_id = {s.id: s for s in self.store.hub_specs()}
            if hub_ids:
                dedup_ids = list(dict.fromkeys(str(hid) for hid in hub_ids))
                targets = [specs_by_id[hid] for hid in dedup_ids if hid in specs_by_id]
            else:
                targets = [s for s in self.store.hub_specs() if s.builtin and not self.store.has_data(s.id)]
                if not targets:
                    targets = [s for s in self.store.hub_specs() if s.builtin]
            if not targets:
                return {
                    "running": False,
                    "total": 0,
                    "done": 0,
                    "current_hub": None,
                    "current_label": None,
                    "queued": [],
                    "completed": [],
                    "errors": {},
                    "cancelled": False,
                }
            self._batch_cancel.clear()
            self._batch = {
                "running": True,
                "total": len(targets),
                "done": 0,
                "current_hub": targets[0].id,
                "current_label": targets[0].label,
                "queued": [s.id for s in targets],
                "completed": [],
                "errors": {},
                "cancelled": False,
                "started_at": _utcnow(),
                "finished_at": None,
            }
        threading.Thread(target=self._run_batch, args=(targets,), daemon=True, name="sync-all").start()
        return self.batch_status()  # type: ignore[return-value]

    def cancel_all(self) -> bool:
        self._batch_cancel.set()
        any_hit = False
        for job in list(self._jobs.values()):
            if job.status == "running":
                job.cancel_event.set()
                any_hit = True
        with self._lock:
            if self._batch and self._batch.get("running"):
                self._batch["cancelled"] = True
                any_hit = True
        return any_hit

    def _run_batch(self, specs: List[HubSpec]):
        try:
            for spec in specs:
                if self._batch_cancel.is_set():
                    with self._lock:
                        if self._batch:
                            self._batch["cancelled"] = True
                    break
                with self._lock:
                    if self._batch:
                        self._batch["current_hub"] = spec.id
                        self._batch["current_label"] = spec.label
                seasons: List[str] = []
                try:
                    if self.store.has_data(spec.id):
                        man = self.store.load_manifest(spec.id)
                        seasons = list(man.get("seasons") or [])
                        rollover = list((man.get("pending") or {}).get("new_seasons") or [])
                        if rollover:
                            seasons.append(max(rollover))
                    if not seasons:
                        chk = self.check(spec.id)
                        avail = sorted(str(s["season"]) for s in (chk.get("seasons") or []) if s.get("season"))
                        if avail:
                            seasons = [avail[-1]]
                except Exception:
                    seasons = []
                if self._batch_cancel.is_set():
                    with self._lock:
                        if self._batch:
                            self._batch["cancelled"] = True
                    break
                if not seasons:
                    cal = self._hub_calendar(spec.id)
                    seasons = [current_season(calendar=cal)]
                seasons = sorted({str(s) for s in seasons if re.match(r"^\d{4}(-\d{4})?$", str(s))}) or [current_season()]

                job = SyncJob(spec.id, seasons)
                with self._lock:
                    self._jobs[spec.id] = job
                if self._batch_cancel.is_set():
                    job.cancel_event.set()
                self._run_sync(spec, job)
                with self._lock:
                    if self._batch:
                        self._batch["done"] += 1
                        if job.status == "done":
                            self._batch["completed"].append(spec.id)
                        elif job.status == "cancelled":
                            if self._batch_cancel.is_set():
                                self._batch["cancelled"] = True
                            else:
                                # Only this hub was cancelled; the batch carries on with the rest.
                                self._batch["errors"][spec.id] = "Cancelled"
                        else:
                            self._batch["errors"][spec.id] = job.error or "Sync failed"
                if self._batch_cancel.is_set():
                    break
        finally:
            with self._lock:
                if self._batch:
                    self._batch["running"] = False
                    self._batch["current_hub"] = None
                    self._batch["current_label"] = None
                    self._batch["finished_at"] = _utcnow()

    def remove(self, hub_id: str):
        self._require(hub_id)
        if self._jobs.get(hub_id) and self._jobs[hub_id].status == "running":
            raise RuntimeError("Cancel the running sync before removing this hub's data")
        self.store.remove_hub(hub_id)
        self._jobs.pop(hub_id, None)
        self._on_inventory_change(hub_id, [])

    def set_enabled(self, hub_id: str, enabled: bool):
        self._require(hub_id)
        self.store.set_enabled(hub_id, enabled)
        self._on_inventory_change(hub_id, [])

    def _manifest_lock(self, hub_id: str) -> threading.Lock:
        with self._lock:
            lk = self._manifest_locks.get(hub_id)
            if lk is None:
                lk = self._manifest_locks[hub_id] = threading.Lock()
            return lk

    def _run_sync(self, spec: HubSpec, job: SyncJob):
        man = self.store.load_manifest(spec.id, mutable=True)
        changed_models: Set[str] = set()
        outcome, phase, error = "done", "Done", None
        try:
            self._sync(spec, job, man, changed_models)
        except SyncCancelled:
            outcome, phase = "cancelled", "Cancelled"
        except (TransportError, NormalizationError, OSError, ValueError, pl.exceptions.PolarsError) as exc:
            outcome, phase, error = "error", "Failed", str(exc)
            logger.warning("Sync of hub %s failed: %s", spec.id, exc)
        except Exception as exc:  # pragma: no cover - defensive
            outcome, phase, error = "error", "Failed", f"Unexpected error: {exc}"
            logger.exception("Unexpected error syncing hub %s", spec.id)

        if outcome == "done" and (man.get("files") or man.get("truth")):
            try:
                with self._manifest_lock(spec.id):
                    self.store.save_manifest(spec.id, man)
            except OSError as exc:
                logger.error("Could not save manifest for %s: %s", spec.id, exc)
                outcome, phase, error = "error", "Failed", f"Could not save manifest: {exc}"
            else:
                if self.store.has_data(spec.id):
                    job.phase = "Indexing"
                    try:
                        self._on_inventory_change(spec.id, sorted(changed_models))
                    except Exception as exc:  # pragma: no cover
                        logger.warning("Post-sync indexing failed for %s: %s", spec.id, exc)
        job.error = error
        job.phase = phase
        job.finished_at = _utcnow()
        job.status = outcome

    def _sync(self, spec: HubSpec, job: SyncJob, man: Dict[str, Any], changed_models: Set[str]):
        client = self._client_for_spec(spec, cancel_event=job.cancel_event)

        # 1. Confirm Hubverse config & infer hub-specific CalendarSpec
        info = inspect_hub(client)
        if not info.get("supported"):
            raise ValueError(info.get("reason") or "This hub is not supported")
        hub_dir = self.store.hub_dir(spec.id)
        cfg_dir = hub_dir / "hub-config"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        for name in ("admin", "tasks"):
            _atomic_write_json(info[name], cfg_dir / f"{name}.json")
        hub_cfg = VizConfig(hub_dir)
        hub_cfg._parse_target_specs()  # warm cached target metadata before worker threads read it
        time_unit_for = hub_cfg.get_target_time_unit
        cal = infer_calendar(info.get("tasks"), targets=info.get("targets"))
        tz_name = info.get("timezone") or "UTC"
        man.update({
            "hub_id": spec.id,
            "bucket": spec.bucket,
            "github_repo": spec.github_repo,
            "transport": spec.transport,
            "hub_name": info.get("name"),
            "timezone": tz_name,
            "calendar": cal.to_dict(),
        })

        # 1b. Sync optional auxiliary-data/locations.csv so location validation fits this hub
        loc_dest = self.store.locations_path(spec.id)
        try:
            aux_objs = {o.key: o for o in client.list("auxiliary-data/")}
        except TransportError:
            aux_objs = {}
        loc_obj = aux_objs.get("auxiliary-data/locations.csv")
        if loc_obj and (man.get("locations_etag") != loc_obj.etag or not loc_dest.exists()):
            try:
                _atomic_write_bytes(client.get(loc_obj.key), loc_dest)
                man["locations_etag"] = loc_obj.etag
            except TransportError as exc:
                logger.info("Could not download auxiliary-data/locations.csv for %s: %s", spec.id, exc)

        hub_geo = build_geo_graph(
            loc_dest if loc_dest.exists() else None,
            tasks_config=info.get("tasks"),
            fallback_us=False,
        )
        known_locations = set(hub_geo.nodes.keys()) if hub_geo.nodes else self._known_locations()

        # 2. List forecasts (primary + archives) and diff against the manifest
        job.phase = "Listing forecasts"
        combined, archive_warnings, listing_complete = self._list_primary_and_archives(
            spec, client, cancel_event=job.cancel_event
        )
        self._listing_cache.pop(spec.id, None)
        if archive_warnings:
            man.setdefault("hub_warnings", [])
            for w in archive_warnings:
                if w not in man["hub_warnings"]:
                    man["hub_warnings"] = (man["hub_warnings"] + [w])[-50:]

        wanted: Dict[str, Tuple[RemoteObject, str, HubTransport]] = {}
        for o, src_tag, src_client in combined:
            m = FORECAST_KEY_RE.match(o.key)
            if not m:
                continue
            if season_for_date(m.group(2), calendar=cal) in job.seasons:
                wanted[o.key] = (o, src_tag, src_client or client)
        if not wanted and not man.get("files"):
            avail_seasons = sorted({
                s for o, _, _ in combined
                for m in [FORECAST_KEY_RE.match(o.key)]
                if m and (s := season_for_date(m.group(2), calendar=cal))
            })
            if avail_seasons:
                latest_season = avail_seasons[-1]
                job.seasons = [latest_season]
                for o, src_tag, src_client in combined:
                    m = FORECAST_KEY_RE.match(o.key)
                    if m and season_for_date(m.group(2), calendar=cal) == latest_season:
                        wanted[o.key] = (o, src_tag, src_client or client)

        def _all_paths_exist(entry: Dict[str, Any]) -> bool:
            for p_field in ("path", "samples_path", "pmf_path", "peak_path"):
                rel = entry.get(p_field)
                if rel and not (hub_dir / rel).exists():
                    return False
            return True

        skipped_files = man.setdefault("skipped_files", {})
        to_fetch = [
            (o, src_tag, src_client)
            for k, (o, src_tag, src_client) in wanted.items()
            if not _is_known_skip(skipped_files, o)
            and (
                k not in man["files"]
                or man["files"][k].get("etag") != o.etag
                or int(man["files"][k].get("size", -1)) != o.size
                or _outdated(man["files"][k])
                or not _all_paths_exist(man["files"][k])
            )
        ]
        had_season_files = any(
            season_for_date(f["reference_date"], calendar=cal) in job.seasons
            for f in man["files"].values()
        )
        safe_to_prune = listing_complete and (bool(wanted) or not had_season_files)
        removed = (
            [
                k for k, f in man["files"].items()
                if season_for_date(f["reference_date"], calendar=cal) in job.seasons and k not in wanted
            ]
            if safe_to_prune
            else []
        )
        if not safe_to_prune and had_season_files:
            msg = f"Skipped removing local rounds for {spec.id} because remote listing was incomplete."
            man.setdefault("hub_warnings", [])
            if msg not in man["hub_warnings"]:
                man["hub_warnings"] = (man["hub_warnings"] + [msg])[-50:]

        job.files_total = len(to_fetch)
        job.bytes_total = sum(o.size for o, _, _ in to_fetch)

        # 3. Download, validate, normalize, and atomically store each changed file
        job.phase = "Downloading forecasts"
        added = updated = failed = 0
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {
                pool.submit(
                    self._fetch_forecast,
                    src_client,
                    spec,
                    o,
                    src_tag,
                    known_locations,
                    cal,
                    hub_geo,
                    time_unit_for=time_unit_for,
                    cancel_event=job.cancel_event,
                ): o
                for o, src_tag, src_client in to_fetch
            }
            try:
                for fut in as_completed(futures):
                    if job.cancel_event.is_set():
                        raise SyncCancelled("Sync cancelled by user")
                    o = futures[fut]
                    try:
                        entry = fut.result()
                    except SyncCancelled:
                        raise
                    except (NormalizationError, ValueError, pl.exceptions.PolarsError) as exc:
                        failed += 1
                        m = FORECAST_KEY_RE.match(o.key)
                        skipped_files[o.key] = {
                            "etag": o.etag,
                            "size": o.size,
                            "schema": FILE_SCHEMA,
                            "model": m.group(1),
                            "reference_date": m.group(2),
                            "reason": str(exc),
                        }
                        man.setdefault("hub_warnings", [])
                        msg = f"Skipped {m.group(2)}-{m.group(1)}: {exc}"
                        if msg not in man["hub_warnings"]:
                            man["hub_warnings"] = (man["hub_warnings"] + [msg])[-50:]
                        job.advance(o.size)
                        continue
                    except (TransportError, OSError) as exc:
                        failed += 1
                        m = FORECAST_KEY_RE.match(o.key)
                        man.setdefault("hub_warnings", [])
                        msg = f"Skipped {m.group(2)}-{m.group(1)}: {exc}"
                        if msg not in man["hub_warnings"]:
                            man["hub_warnings"] = (man["hub_warnings"] + [msg])[-50:]
                        job.advance(o.size)
                        continue
                    skipped_files.pop(o.key, None)
                    prev = man["files"].get(o.key)
                    if prev is not None:
                        updated += 1
                        entry["first_fetched_at"] = prev.get("first_fetched_at") or prev.get("fetched_at")
                        entry["revisions"] = int(prev.get("revisions", 0))
                        if prev.get("etag") == o.etag:
                            entry["warnings"] += [
                                w for w in prev.get("warnings", [])
                                if "resubmitted upstream" in w and w not in entry["warnings"]
                            ]
                        else:
                            entry["revisions"] += 1
                            posted_note = (
                                f", posted {o.last_modified[:16].replace('T', ' ')} UTC"
                                if o.last_modified else ""
                            )
                            entry["warnings"].append(
                                f"{entry['reference_date']}-{entry['model']}: resubmitted upstream "
                                f"(revision {entry['revisions']}{posted_note})"
                            )
                    else:
                        added += 1
                    man["files"][o.key] = entry
                    changed_models.add(entry["model"])
                    job.advance(o.size)
            except BaseException:
                # Cancel or unexpected failure: stop queued downloads and signal in-flight ones, so the
                # executor does not keep writing files for a sync whose manifest will not be saved.
                job.cancel_event.set()
                for f in futures:
                    f.cancel()
                raise

        if job.cancel_event.is_set():
            raise SyncCancelled("Sync cancelled by user")

        # 4. Model metadata for every model we hold (best effort: never fails the forecast sync)
        job.phase = "Model metadata"
        try:
            self._sync_metadata(client, spec, man, cancel_event=job.cancel_event)
        except SyncCancelled:
            raise
        except Exception as exc:
            logger.warning("Model metadata sync failed for %s: %s", spec.id, exc)
            _add_hub_warning(man, f"Model metadata could not be refreshed: {exc}")

        # 5. Truth data across all supported target-data layouts. A truth failure keeps the previous
        # truth and still saves the forecast changes; `pending.truth_changed` stays set so the next
        # cycle retries truth only.
        job.phase = "Truth data"
        truth_error: Optional[str] = None
        try:
            truth_updated = self._sync_truth(
                client,
                spec,
                man,
                job,
                cal=cal,
                pad_single_digit_fips=hub_geo.uses_us_fips,
                aux_objs=aux_objs,
                target_ids=info.get("targets"),
            )
        except SyncCancelled:
            raise
        except (TransportError, NormalizationError, OSError, ValueError, pl.exceptions.PolarsError) as exc:
            truth_updated = False
            truth_error = str(exc)
            logger.warning("Truth sync failed for %s (keeping previous truth): %s", spec.id, exc)
            _add_hub_warning(man, f"Truth data could not be refreshed: {exc}")

        if job.cancel_event.is_set():
            raise SyncCancelled("Sync cancelled by user")

        # 6. Remove rounds that disappeared upstream, only after every fallible step succeeded, so a
        # failed sync never leaves the saved manifest pointing at deleted files.
        for k in removed:
            f = man["files"].pop(k)
            changed_models.add(f["model"])
            for p_field in ("path", "samples_path", "pmf_path", "peak_path"):
                rel = f.get(p_field)
                if rel and (hub_dir / rel).exists():
                    (hub_dir / rel).unlink(missing_ok=True)
        if safe_to_prune:
            for k in [
                k for k, sf in skipped_files.items()
                if sf.get("reference_date") and season_for_date(sf["reference_date"], calendar=cal) in job.seasons and k not in wanted
            ]:
                skipped_files.pop(k, None)

        man["seasons"] = sorted(set(man.get("seasons", [])) | set(job.seasons))
        man["last_sync"] = _utcnow()
        man["pending"] = {
            "new": 0,
            "changed": 0,
            "removed": 0,
            "outdated": 0,
            "new_seasons": [],
            "listing_incomplete": False,
            "truth_changed": truth_error is not None,
            "truth_error": truth_error,
            "checked_at": man["last_sync"],
            "latest_round": max((f["reference_date"] for f in man["files"].values()), default=None),
        }
        job.summary = {
            "added": added,
            "updated": updated,
            "removed": len(removed),
            "failed": failed,
            "models_changed": len(changed_models),
            "truth_updated": bool(truth_updated),
            "truth_error": truth_error,
        }

    def _fetch_forecast(
        self,
        client: HubTransport,
        spec: HubSpec,
        o: RemoteObject,
        source_repo: str,
        known_locations: Set[str],
        calendar: CalendarSpec,
        geo: GeoGraph,
        *,
        time_unit_for: Optional[Callable[[str], Optional[str]]] = None,
        cancel_event: Optional[threading.Event] = None,
    ) -> Dict[str, Any]:
        if cancel_event is not None and cancel_event.is_set():
            raise SyncCancelled("Sync cancelled by user")
        m = FORECAST_KEY_RE.match(o.key)
        model, ref, model2, ext = m.group(1), m.group(2), m.group(3), m.group(4)
        data = client.get(o.key)
        if cancel_event is not None and cancel_event.is_set():
            raise SyncCancelled("Sync cancelled by user")
        if o.size and len(data) != o.size:
            raise TransportError(f"truncated download ({len(data)} of {o.size} bytes)")
        df = read_table(data, f".{ext}")
        if df.is_empty():
            raise NormalizationError("file has no rows")

        norm, info = normalize_forecast(
            df,
            model,
            ref,
            known_locations,
            self._is_non_negative,
            calendar=calendar,
            geo=geo,
            time_unit_for=time_unit_for,
        )
        if cancel_event is not None and cancel_event.is_set():
            raise SyncCancelled("Sync cancelled by user")
        warnings = list(info["warnings"])
        if model2 != model:
            warnings.append(f"{ref}-{model}: file name model '{model2}' does not match folder")

        hub_dir = self.store.hub_dir(spec.id)
        stored = 0

        def _store_part(part: Optional[pl.DataFrame], subdir: str) -> str:
            nonlocal stored
            if cancel_event is not None and cancel_event.is_set():
                raise SyncCancelled("Sync cancelled by user")
            rel = Path(subdir) / model / f"{ref}-{model}.parquet"
            dest = hub_dir / rel
            if part is not None and not part.is_empty():
                _atomic_write_parquet(part, dest)
                _set_mtime(dest, o.last_modified)
                stored += dest.stat().st_size
                return str(rel)
            if dest.exists():
                dest.unlink(missing_ok=True)
            return ""

        q_rel = _store_part(norm, "model-output")
        s_rel = _store_part(info.get("samples"), "sample-output")
        p_rel = _store_part(info.get("pmf"), "pmf-output")
        pk_rel = _store_part(info.get("peak"), "peak-output")

        if not q_rel and not s_rel and not p_rel and not pk_rel:
            warnings.append(
                f"{ref}-{model}: no displayable quantile, sample, PMF, or peak forecasts "
                f"(found: {', '.join(info['output_types']) or 'none'})"
            )

        now = _utcnow()
        return {
            "model": model,
            "reference_date": ref,
            "source_repo": source_repo,
            "etag": o.etag,
            "size": o.size or len(data),
            "last_modified": o.last_modified,
            "fetched_at": now,
            "first_fetched_at": now,
            "path": q_rel,
            "samples_path": s_rel,
            "pmf_path": p_rel,
            "peak_path": pk_rel,
            "stored_bytes": stored,
            "rows": info["rows"],
            "sample_rows": info.get("sample_rows", 0),
            "pmf_rows": info.get("pmf_rows", 0),
            "targets": info["targets"],
            "output_types": info.get("output_types", []),
            "extra_task_ids": info.get("extra_task_ids", []),
            "from_samples": bool(info.get("derived_from_samples")),
            "samples": bool(s_rel),
            "pmf": bool(p_rel),
            "quantile_levels": info.get("quantile_levels", {}),
            "peak_targets": info.get("peak_targets", []),
            "schema": FILE_SCHEMA,
            "revisions": 0,
            "warnings": warnings,
        }

    def _sync_metadata(
        self,
        client: HubTransport,
        spec: HubSpec,
        man: Dict[str, Any],
        *,
        cancel_event: Optional[threading.Event] = None,
    ):
        models = {f["model"] for f in man["files"].values()}
        try:
            objs = client.list("model-metadata/")
        except TransportError as exc:
            logger.info("No model metadata for hub %s: %s", spec.id, exc)
            return
        by_model = {}
        for o in objs:
            name = o.key.rsplit("/", 1)[-1]
            stem, _, ext = name.rpartition(".")
            if ext in ("yml", "yaml") and stem in models:
                by_model[stem] = o
        todo = [
            o for m, o in by_model.items()
            if man["metadata"].get(m, {}).get("etag") != o.etag
            or not self.store.metadata_path(spec.id, m).exists()
        ]

        def fetch(o: RemoteObject):
            if cancel_event is not None and cancel_event.is_set():
                raise SyncCancelled("Sync cancelled by user")
            stem = o.key.rsplit("/", 1)[-1].rpartition(".")[0]
            raw = client.get(o.key)
            if cancel_event is not None and cancel_event.is_set():
                raise SyncCancelled("Sync cancelled by user")
            text = raw.decode("utf-8", errors="replace")
            path = self.store.metadata_path(spec.id, stem)
            _atomic_write_bytes(text.encode("utf-8"), path)
            return stem, {"etag": o.etag, "designated": _designated(text)}

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futs = [pool.submit(fetch, o) for o in todo]
            try:
                for fut in as_completed(futs):
                    if cancel_event is not None and cancel_event.is_set():
                        raise SyncCancelled("Sync cancelled by user")
                    try:
                        stem, meta = fut.result()
                        man["metadata"][stem] = meta
                    except SyncCancelled:
                        raise
                    except (TransportError, OSError) as exc:
                        logger.info("Model metadata download failed: %s", exc)
            except SyncCancelled:
                for f in futs:
                    f.cancel()
                raise

    def _sync_truth(
        self,
        client: HubTransport,
        spec: HubSpec,
        man: Dict[str, Any],
        job: SyncJob,
        *,
        cal: CalendarSpec = DEFAULT_FLUSIGHT_CALENDAR,
        pad_single_digit_fips: bool = True,
        aux_objs: Optional[Dict[str, RemoteObject]] = None,
        target_ids: Optional[List[str]] = None,
    ) -> bool:
        truth = man.setdefault("truth", {})
        objs = {o.key: o for o in client.list("target-data/")}
        today_iso = _utcnow()[:10]
        null_vals = ["", "NA", "null", "NaN", "None", "NULL"]
        plan = _resolve_truth_plan(objs, aux_objs=aux_objs)
        truth_updated = False

        def _read_truth_bytes(key: str, data: bytes) -> pl.DataFrame:
            if key.endswith(".parquet"):
                return read_table(data, ".parquet")
            return pl.read_csv(io.BytesIO(data), infer_schema_length=0, null_values=null_vals)

        def _sync_oracle_kind(kind: str, *, required: bool = False) -> bool:
            entry = plan.get(kind)
            dest = self.store.truth_path(spec.id, kind)
            if entry is None or (truth.get(kind, {}).get("etag") == entry["etag"] and dest.exists()):
                return False
            if entry["multi"]:
                frames = []
                for ro in entry["objs"]:
                    raw = _read_truth_bytes(ro.key, client.get(ro.key))
                    fname = Path(ro.key).stem
                    stem = fname[len("latest-"):].replace("_", " ") if fname.startswith("latest-") else None
                    fallback = ro.last_modified[:10] if ro.last_modified else today_iso
                    ldf = normalize_oracle(
                        raw,
                        fallback,
                        pad_single_digit_fips=pad_single_digit_fips,
                        default_target=stem,
                        target_ids=target_ids,
                    )
                    if not ldf.is_empty():
                        frames.append(ldf)
                if not frames:
                    return False
                df = pl.concat(frames, how="diagonal_relaxed")
                dedup_cols = [c for c in df.columns if c not in ("as_of", "oracle_value")]
                if dedup_cols:
                    df = df.unique(subset=dedup_cols, keep="last", maintain_order=True)
            else:
                obj = entry["objs"][0]
                raw = _read_truth_bytes(obj.key, client.get(obj.key))
                fallback = obj.last_modified[:10] if obj.last_modified else today_iso
                df = normalize_oracle(
                    raw,
                    fallback,
                    pad_single_digit_fips=pad_single_digit_fips,
                    target_ids=target_ids,
                )
                if df.is_empty():
                    if required:
                        raise NormalizationError("hub oracle-output has no rows" if kind == "oracle" else f"hub {kind} has no rows")
                    return False
            _atomic_write_parquet(df, dest)
            truth[kind] = {
                "key": entry["key"],
                "etag": entry["etag"],
                "last_modified": entry["last_modified"] or today_iso,
                "as_of": df.get_column("as_of").max(),
                "max_date": df.get_column("target_end_date").max(),
                "rows": df.height,
            }
            return True

        # 1-3. Oracle output, time-series, and latest-data / RespiCast `latest-*.csv` snapshots
        truth_updated |= _sync_oracle_kind("oracle", required=True)
        truth_updated |= _sync_oracle_kind("time_series")
        truth_updated |= _sync_oracle_kind("latest")

        # 4. Legacy FluSight weekly admissions CSV
        adm_entry = plan.get("admissions")
        dest = self.store.truth_path(spec.id, "admissions")
        if adm_entry is not None and (truth.get("admissions", {}).get("etag") != adm_entry["etag"] or not dest.exists()):
            adm_obj = adm_entry["objs"][0]
            raw = pl.read_csv(
                io.BytesIO(client.get(adm_obj.key)),
                schema_overrides={"location": pl.String, "value": pl.Float64, "date": pl.String},
                null_values=["", "NA", "NaN"],
            )
            adm = normalize_admissions(raw, ADMISSIONS_TARGET, pad_single_digit_fips=pad_single_digit_fips)
            _atomic_write_parquet(adm, dest)
            truth["admissions"] = {
                "key": adm_entry["key"],
                "etag": adm_entry["etag"],
                "last_modified": adm_entry["last_modified"] or today_iso,
                "max_date": adm.get_column("target_end_date").max(),
                "rows": adm.height,
            }
            truth_updated = True

        # 5. Point-in-time archive snapshots newer than bundled as-of vintages
        local_max = self._local_as_of_max() or ""
        try:
            if aux_objs is not None:
                snaps = [o for o in aux_objs.values() if SNAPSHOT_KEY_RE.match(o.key)]
            else:
                snaps = [o for o in client.list("auxiliary-data/target-data-archive/") if SNAPSHOT_KEY_RE.match(o.key)]
        except TransportError:
            snaps = []
        have = set(truth.get("as_of", {}).get("snapshots", []))
        wanted = []
        for o in snaps:
            d = SNAPSHOT_KEY_RE.match(o.key).group(1)
            if d > local_max and season_for_date(d, calendar=cal) in job.seasons and d not in have:
                wanted.append((d, o))
        if wanted:
            dest = self.store.truth_path(spec.id, "as_of")
            frames = [pl.read_parquet(dest)] if dest.exists() else []
            for d, o in sorted(wanted):
                raw = pl.read_csv(
                    io.BytesIO(client.get(o.key)),
                    schema_overrides={"location": pl.String, "value": pl.Float64, "date": pl.String},
                    null_values=["", "NA", "NaN"],
                )
                frames.append(normalize_admissions(raw, ADMISSIONS_TARGET, as_of=d, pad_single_digit_fips=pad_single_digit_fips))
                have.add(d)
            snap_df = pl.concat(frames, how="diagonal_relaxed").unique(
                subset=["as_of", "target", "location", "target_end_date"], keep="last"
            )
            _atomic_write_parquet(snap_df, dest)
            truth["as_of"] = {"snapshots": sorted(have), "as_of": max(have), "max_date": max(have)}
            truth_updated = True

        return truth_updated


class LocalAutoUpdater:
    """Background daemon that checks and updates synced enabled hubs once per day in local mode."""

    DEFAULT_INTERVAL_SECONDS = 86400.0
    DEFAULT_POLL_SECONDS = 900.0

    def __init__(
        self,
        hub_manager: Any,
        *,
        interval_seconds: float = DEFAULT_INTERVAL_SECONDS,
        poll_seconds: float = DEFAULT_POLL_SECONDS,
    ):
        self.mgr = hub_manager
        self.interval_seconds = max(60.0, float(interval_seconds))
        self.poll_seconds = max(1.0, float(poll_seconds))
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._wake_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._running = False

    @property
    def is_running(self) -> bool:
        with self._lock:
            return self._running

    def start(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._wake_event.clear()
            t = threading.Thread(target=self._loop, name="local-auto-updater", daemon=True)
            self._thread = t
            t.start()

    def stop(self) -> None:
        self._stop_event.set()
        self._wake_event.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout=2.0)

    def wake(self) -> None:
        self._wake_event.set()

    def is_due(self) -> bool:
        settings = self.mgr.remote_store.get_settings()
        if not settings.get("auto_update_daily"):
            return False
        last = settings.get("last_auto_update")
        if not last:
            return True
        dt = _parse_s3_time(str(last))
        if dt is None:
            return True
        return (datetime.now(timezone.utc) - dt).total_seconds() >= self.interval_seconds

    def run_once(self) -> bool:
        """Check and incrementally sync enabled synced hubs when daily auto-update is active."""
        settings = self.mgr.remote_store.get_settings()
        if not settings.get("auto_update_daily"):
            return False
        rmgr = self.mgr.shared_remote_mgr
        if rmgr.is_busy():
            return False
        with self._lock:
            if self._running:
                return False
            self._running = True

        succeeded = False
        try:
            specs = [
                s for s in self.mgr.remote_store.hub_specs()
                if self.mgr.remote_store.has_data(s.id) and self.mgr.remote_store.is_enabled(s.id)
            ]
            for spec in specs:
                if self._stop_event.is_set() or rmgr.is_busy():
                    break
                try:
                    chk = rmgr.check(spec.id)
                    p = chk.get("pending") or {}
                    needs = (p.get("new", 0) + p.get("changed", 0) + p.get("removed", 0)) > 0 or bool(p.get("truth_changed"))
                    if needs:
                        rmgr.start_sync(spec.id)
                        job = None
                        while not self._stop_event.is_set():
                            job = rmgr.get_job(spec.id)
                            if not job or job.get("status") != "running":
                                break
                            time.sleep(0.25)
                        if self._stop_event.is_set():
                            rmgr.cancel(spec.id)
                            break
                        if job and job.get("status") == "done":
                            succeeded = True
                    else:
                        succeeded = True
                except Exception as exc:
                    logger.warning("Local auto-update failed for hub %s: %s", spec.id, exc)

            if not self._stop_event.is_set() and hasattr(self.mgr, "briefing_feeds"):
                try:
                    st = self.mgr.briefing_feeds.get_status()
                    feeds = st.get("feeds") or {}
                    stale_ids = [fid for fid, f in feeds.items() if f.get("cached") and f.get("stale")]
                    if stale_ids:
                        after = self.mgr.briefing_feeds.refresh_sync(feed_ids=stale_ids, force=False)
                        after_feeds = after.get("feeds") or {}
                        if any((after_feeds.get(fid) or {}).get("error") is None for fid in stale_ids):
                            succeeded = True
                except Exception as exc:
                    logger.warning("Local auto-update briefing refresh failed: %s", exc)

            if succeeded and not self._stop_event.is_set():
                self.mgr.remote_store.record_auto_update(_utcnow())
            return succeeded
        finally:
            with self._lock:
                self._running = False

    def _loop(self) -> None:
        if self._stop_event.wait(5.0):
            return
        while not self._stop_event.is_set():
            try:
                if self.is_due():
                    self.run_once()
            except Exception as exc:
                logger.warning("Local auto-update cycle error: %s", exc)
            self._wake_event.wait(self.poll_seconds)
            self._wake_event.clear()
