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
FILE_SCHEMA = 3


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


def _resolve_truth_plan(t_objs: Dict[str, RemoteObject]) -> Dict[str, Dict[str, Any]]:
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
        if respi_objs:
            lms = [o.last_modified for o in respi_objs if o.last_modified]
            plan["latest"] = {
                "key": ",".join(o.key for o in respi_objs),
                "etag": "|".join(f"{o.key}:{o.etag}" for o in respi_objs),
                "last_modified": max(lms) if lms else "",
                "objs": respi_objs,
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
    tmp = dest.with_suffix(f".tmp.{os.getpid()}.{threading.get_ident()}.parquet")
    try:
        df.write_parquet(tmp, compression="zstd")
        os.replace(tmp, dest)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _atomic_write_bytes(data: bytes, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(f".tmp.{os.getpid()}.{threading.get_ident()}")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, dest)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


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
        self._lock = threading.Lock()
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
        files = man["files"]
        shown = [
            f for f in files.values()
            if f.get("path") or f.get("samples_path") or f.get("pmf_path") or f.get("peak_path")
        ]
        models = {f["model"] for f in shown}
        dates = sorted({f["reference_date"] for f in shown})
        latest = dates[-1] if dates else None
        out.update({
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
        return out

    def list_hubs(self) -> List[Dict[str, Any]]:
        return [self.hub_status(s) for s in self.store.hub_specs()]

    def get_job(self, hub_id: str) -> Optional[Dict[str, Any]]:
        job = self._jobs.get(hub_id)
        return job.to_dict() if job else None

    def is_busy(self) -> bool:
        return any(j.status == "running" for j in self._jobs.values())

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
    ) -> Tuple[List[Tuple[RemoteObject, str, Optional[HubTransport]]], List[str]]:
        """
        Return list of `(RemoteObject, source_label, client_or_none_for_primary)` across primary +
        any configured `archive_sources`, letting primary overwrite overlapping `(model, ref)` rounds.
        """
        primary_objs = self._list_forecasts(primary_client)
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

        archive_warnings: List[str] = []
        for src in spec.archive_sources or []:
            try:
                arch_client = self._client_for_source(src, cancel_event=cancel_event)
                arch_tag = _source_label(src)
                arch_objs = sorted(self._list_forecasts(arch_client), key=lambda o: (o.key.endswith(".csv"), o.key))
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
                archive_warnings.append(f"Archive source '{_source_label(src)}' unavailable: {exc}")

        return combined, archive_warnings

    def check(self, hub_id: str) -> Dict[str, Any]:
        """List the hub and summarize what is available and what changed since the last sync."""
        spec = self._require(hub_id)
        client = self._client_for_spec(spec)
        combined, _ = self._list_primary_and_archives(spec, client)
        objs = [o for o, _, _ in combined]
        self._listing_cache[hub_id] = (time.time(), [(o, src) for o, src, _ in combined])
        cal = self._hub_calendar(hub_id, client=client)
        man = self.store.load_manifest(hub_id)
        synced_seasons = set(man.get("seasons", []))
        skipped_files = man.get("skipped_files") or {}

        seasons: Dict[str, Dict[str, Any]] = {}
        new = changed = outdated = 0
        listed_keys: Set[str] = set()
        for o in objs:
            m = FORECAST_KEY_RE.match(o.key)
            model, ref = m.group(1), m.group(2)
            s = season_for_date(ref, calendar=cal)
            entry = seasons.setdefault(s, {"season": s, "files": 0, "bytes": 0, "models": set(), "rounds": {}})
            entry["files"] += 1
            entry["bytes"] += o.size
            entry["models"].add(model)
            entry["rounds"][ref] = entry["rounds"].get(ref, 0) + 1
            if s in synced_seasons:
                listed_keys.add(o.key)
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
        removed = sum(
            1 for k, f in man["files"].items()
            if season_for_date(f["reference_date"], calendar=cal) in synced_seasons and k not in listed_keys
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
            "truth_changed": truth_changed,
            "truth_last_modified": truth_last_modified,
            "checked_at": _utcnow(),
            "latest_round": latest,
        }
        if self.store.has_data(hub_id):
            man["last_check"] = pending["checked_at"]
            man["pending"] = pending
            self.store.save_manifest(hub_id, man)
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
            if self.is_busy():
                running = next(j for j in self._jobs.values() if j.status == "running")
                raise RuntimeError(f"A sync for '{running.hub_id}' is already running")
            if not seasons:
                man = self.store.load_manifest(hub_id)
                cal = self._hub_calendar(hub_id)
                seasons = man.get("seasons") or [current_season(calendar=cal)]
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

    def _run_sync(self, spec: HubSpec, job: SyncJob):
        man = self.store.load_manifest(spec.id)
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

        if man.get("files") or man.get("truth"):
            try:
                self.store.save_manifest(spec.id, man)
            except OSError as exc:
                logger.error("Could not save manifest for %s: %s", spec.id, exc)
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
        (hub_dir / "hub-config").mkdir(parents=True, exist_ok=True)
        for name in ("admin", "tasks"):
            with open(hub_dir / "hub-config" / f"{name}.json", "w", encoding="utf-8") as f:
                json.dump(info[name], f)
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
            "seasons": sorted(set(man.get("seasons", [])) | set(job.seasons)),
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
        combined, archive_warnings = self._list_primary_and_archives(spec, client, cancel_event=job.cancel_event)
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
                man["seasons"] = sorted(set(man.get("seasons", [])) | {latest_season})
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
        removed = [
            k for k, f in man["files"].items()
            if season_for_date(f["reference_date"], calendar=cal) in job.seasons and k not in wanted
        ]
        job.files_total = len(to_fetch)
        job.bytes_total = sum(o.size for o, _, _ in to_fetch)

        # 3. Download, validate, normalize, and atomically store each changed file
        job.phase = "Downloading forecasts"
        added = updated = failed = 0
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {
                pool.submit(
                    self._fetch_forecast, src_client, spec, o, src_tag, known_locations, cal, hub_geo
                ): o
                for o, src_tag, src_client in to_fetch
            }
            try:
                for fut in as_completed(futures):
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
            except SyncCancelled:
                for f in futures:
                    f.cancel()
                raise

        for k in removed:
            f = man["files"].pop(k)
            changed_models.add(f["model"])
            for p_field in ("path", "samples_path", "pmf_path", "peak_path"):
                rel = f.get(p_field)
                if rel and (hub_dir / rel).exists():
                    (hub_dir / rel).unlink(missing_ok=True)
        for k in [
            k for k, sf in skipped_files.items()
            if sf.get("reference_date") and season_for_date(sf["reference_date"], calendar=cal) in job.seasons and k not in wanted
        ]:
            skipped_files.pop(k, None)

        # 4. Model metadata for every model we hold
        job.phase = "Model metadata"
        self._sync_metadata(client, spec, man)

        # 5. Truth data across all supported target-data layouts
        job.phase = "Truth data"
        truth_updated = self._sync_truth(
            client, spec, man, job, cal=cal, pad_single_digit_fips=hub_geo.uses_us_fips, aux_objs=aux_objs
        )

        man["last_sync"] = _utcnow()
        man["pending"] = {
            "new": 0,
            "changed": 0,
            "removed": 0,
            "outdated": 0,
            "truth_changed": False,
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
    ) -> Dict[str, Any]:
        m = FORECAST_KEY_RE.match(o.key)
        model, ref, model2, ext = m.group(1), m.group(2), m.group(3), m.group(4)
        data = client.get(o.key)
        if o.size and len(data) != o.size:
            raise NormalizationError(f"truncated download ({len(data)} of {o.size} bytes)")
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
        )
        warnings = list(info["warnings"])
        if model2 != model:
            warnings.append(f"{ref}-{model}: file name model '{model2}' does not match folder")

        hub_dir = self.store.hub_dir(spec.id)
        stored = 0

        def _store_part(part: Optional[pl.DataFrame], subdir: str) -> str:
            nonlocal stored
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

    def _sync_metadata(self, client: HubTransport, spec: HubSpec, man: Dict[str, Any]):
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
            stem = o.key.rsplit("/", 1)[-1].rpartition(".")[0]
            text = client.get(o.key).decode("utf-8", errors="replace")
            path = self.store.metadata_path(spec.id, stem)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            return stem, {"etag": o.etag, "designated": _designated(text)}

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            for fut in as_completed([pool.submit(fetch, o) for o in todo]):
                try:
                    stem, meta = fut.result()
                    man["metadata"][stem] = meta
                except SyncCancelled:
                    raise
                except (TransportError, OSError) as exc:
                    logger.info("Model metadata download failed: %s", exc)

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
    ) -> bool:
        truth = man.setdefault("truth", {})
        objs = {o.key: o for o in client.list("target-data/")}
        today_iso = _utcnow()[:10]
        null_vals = ["", "NA", "null", "NaN", "None", "NULL"]
        plan = _resolve_truth_plan(objs)
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
                    stem = Path(ro.key).stem[len("latest-"):].replace("_", " ")
                    fallback = ro.last_modified[:10] if ro.last_modified else today_iso
                    ldf = normalize_oracle(raw, fallback, pad_single_digit_fips=pad_single_digit_fips, default_target=stem)
                    if not ldf.is_empty():
                        frames.append(ldf)
                if not frames:
                    return False
                df = pl.concat(frames, how="diagonal_relaxed")
            else:
                obj = entry["objs"][0]
                raw = _read_truth_bytes(obj.key, client.get(obj.key))
                fallback = obj.last_modified[:10] if obj.last_modified else today_iso
                df = normalize_oracle(raw, fallback, pad_single_digit_fips=pad_single_digit_fips)
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
