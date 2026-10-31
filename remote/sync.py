"""
Background sync engine that copies a public hub's forecasts and truth data into the local viz cache.

Network access happens only here, only when the user asks for it (brand menu or `remote_sync.py`), and never
inside a request handler: the HTTP endpoints just start, inspect, or cancel a job running on its own thread.
Syncs are incremental (S3 ETag + size diff against the manifest) and every file is validated and normalized
before it is atomically moved into place, so a failed or cancelled sync never leaves half-written data.
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
import threading
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple

import polars as pl

from viz.remote.hubs import HUB_ID_RE, HubSpec, hub_id_from_bucket, inspect_hub
from viz.remote.normalize import (
    NormalizationError, normalize_admissions, normalize_forecast, normalize_oracle, read_table,
)
from viz.remote.s3 import S3Client, S3Error, S3Object, SyncCancelled, validate_bucket_name
from viz.remote.store import RemoteStore

logger = logging.getLogger("viz.remote")

FORECAST_KEY_RE = re.compile(r"^model-output/([^/]+)/(\d{4}-\d{2}-\d{2})-([^/]+)\.(parquet|csv)$")
SNAPSHOT_KEY_RE = re.compile(r"^auxiliary-data/target-data-archive/target-hospital-admissions_(\d{4}-\d{2}-\d{2})\.csv$")
ADMISSIONS_TARGET = "wk inc flu hosp"
MAX_WORKERS = 16
# Version of the per-file normalization. Files stored by an older version are re-downloaded on the next sync
# (and counted as changed by a check): version 2 keeps season peak rows that version 1 dropped.
FILE_SCHEMA = 2


def _outdated(entry: Dict[str, Any]) -> bool:
    return int(entry.get("schema", 1)) < FILE_SCHEMA


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_s3_time(ts: str) -> Optional[datetime]:
    try:
        return datetime.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def season_for_date(d: str) -> str:
    from viz.data_loader import SandboxDataLoader
    return SandboxDataLoader.get_flu_season_for_date(d)


def current_season() -> str:
    return season_for_date(date.today().strftime("%Y-%m-%d"))


def _set_mtime(path: Path, s3_time: str):
    dt = _parse_s3_time(s3_time)
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


def _designated(yml_text: str) -> bool:
    return bool(re.search(r"^designated_model:\s*(true|yes)\s*$", yml_text, re.IGNORECASE | re.MULTILINE))


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
        client_factory: Callable[..., S3Client] = S3Client,
    ):
        self.store = store
        self._known_locations = known_locations
        self._is_non_negative = is_non_negative
        self._local_as_of_max = local_as_of_max
        self._on_inventory_change = on_inventory_change
        self._client_factory = client_factory
        self._jobs: Dict[str, SyncJob] = {}
        self._lock = threading.Lock()
        self._listing_cache: Dict[str, Tuple[float, List[S3Object]]] = {}

    # ---- status (no network) ----------------------------------------------------------------------------

    def hub_status(self, spec: HubSpec) -> Dict[str, Any]:
        man = self.store.load_manifest(spec.id) if self.store.has_data(spec.id) else None
        out: Dict[str, Any] = {**spec.to_dict(), "synced": man is not None, "enabled": self.store.is_enabled(spec.id)}
        job = self._jobs.get(spec.id)
        if job is not None:
            out["job"] = job.to_dict()
        if man is None:
            return out
        files = man["files"]
        # Count only files with displayable (quantile) forecasts, matching what the model bar shows
        shown = [f for f in files.values() if f.get("path")]
        models = {f["model"] for f in shown}
        dates = sorted({f["reference_date"] for f in shown})
        latest = dates[-1] if dates else None
        out.update({
            "hub_name": man.get("hub_name"),
            "last_sync": man.get("last_sync"),
            "last_check": man.get("last_check"),
            "seasons": man.get("seasons", []),
            "files": len(files),
            "bytes": sum(int(f.get("stored_bytes", 0)) for f in files.values()),
            "models": len(models),
            "latest_round": latest,
            "latest_round_models": len({f["model"] for f in shown if f["reference_date"] == latest}),
            "truth": {k: {kk: v.get(kk) for kk in ("as_of", "max_date", "last_modified")} for k, v in man.get("truth", {}).items()},
            "warnings_count": sum(len(f.get("warnings", [])) for f in files.values()),
            # Files stored before season peak rows were kept; a sync re-reads them
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
        for key, f in sorted(man["files"].items()):
            for w in f.get("warnings", []):
                rows.append({"model": f["model"], "reference_date": f["reference_date"], "message": w})
        for w in man.get("hub_warnings", []):
            rows.append({"model": None, "reference_date": None, "message": w})
        return rows

    # ---- registration & checks (network) ------------------------------------------------------------------

    def _client(self, bucket: str, cancel_event: Optional[threading.Event] = None) -> S3Client:
        return self._client_factory(bucket, cancel_event=cancel_event)

    def add_hub(self, bucket: str, label: Optional[str] = None) -> Dict[str, Any]:
        """Validate a bucket as a displayable flu hub and register it. Raises ValueError for bad input."""
        bucket = validate_bucket_name(bucket)
        existing = next((s for s in self.store.hub_specs() if s.bucket == bucket), None)
        if existing:
            return {"ok": True, "hub": self.hub_status(existing), "already_registered": True}
        info = inspect_hub(self._client(bucket), self._known_locations())
        if not info.get("supported"):
            return {"ok": False, "supported": False, "reason": info.get("reason"), "name": info.get("name")}
        hub_id = hub_id_from_bucket(bucket, [s.id for s in self.store.hub_specs()])
        name = (label or info.get("name") or bucket).strip()[:60]
        short = re.sub(r"\s*(forecast\s*)?hub$", "", name, flags=re.IGNORECASE).strip()[:14] or hub_id
        repo = info.get("repository") or {}
        repo_url = f"https://github.com/{repo['owner']}/{repo['name']}" if repo.get("owner") and repo.get("name") else None
        spec = HubSpec(id=hub_id, bucket=bucket, label=name, short_label=short, builtin=False, repo_url=repo_url)
        assert HUB_ID_RE.match(spec.id)
        self.store.add_custom_hub(spec)
        return {"ok": True, "hub": self.hub_status(spec)}

    def _list_forecasts(self, client: S3Client) -> List[S3Object]:
        return [o for o in client.list("model-output/") if FORECAST_KEY_RE.match(o.key)]

    def check(self, hub_id: str) -> Dict[str, Any]:
        """List the hub (one cheap paginated call) and summarize what is available and what changed."""
        spec = self._require(hub_id)
        client = self._client(spec.bucket)
        objs = self._list_forecasts(client)
        self._listing_cache[hub_id] = (time.time(), objs)
        man = self.store.load_manifest(hub_id)
        synced_seasons = set(man.get("seasons", []))

        seasons: Dict[str, Dict[str, Any]] = {}
        new = changed = outdated = 0
        listed_keys = set()
        for o in objs:
            m = FORECAST_KEY_RE.match(o.key)
            model, ref = m.group(1), m.group(2)
            s = season_for_date(ref)
            entry = seasons.setdefault(s, {"season": s, "files": 0, "bytes": 0, "models": set(), "rounds": {}})
            entry["files"] += 1
            entry["bytes"] += o.size
            entry["models"].add(model)
            entry["rounds"][ref] = entry["rounds"].get(ref, 0) + 1
            if s in synced_seasons:
                listed_keys.add(o.key)
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
            if season_for_date(f["reference_date"]) in synced_seasons and k not in listed_keys
        )

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
        pending = {"new": new, "changed": changed, "removed": removed, "outdated": outdated,
                   "checked_at": _utcnow(), "latest_round": latest}
        if self.store.has_data(hub_id):
            man["last_check"] = pending["checked_at"]
            man["pending"] = pending
            self.store.save_manifest(hub_id, man)
        return {
            "hub": hub_id,
            "current_season": current_season(),
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
                seasons = man.get("seasons") or [current_season()]
            seasons = sorted({s for s in seasons if re.match(r"^\d{4}-\d{4}$", s)})
            if not seasons:
                raise ValueError("No valid seasons requested (expected e.g. '2026-2027')")
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
        except (S3Error, NormalizationError, OSError, ValueError, pl.exceptions.PolarsError) as exc:
            outcome, phase, error = "error", "Failed", str(exc)
            logger.warning("Sync of hub %s failed: %s", spec.id, exc)
        except Exception as exc:  # pragma: no cover - defensive
            outcome, phase, error = "error", "Failed", f"Unexpected error: {exc}"
            logger.exception("Unexpected error syncing hub %s", spec.id)

        # Keep whatever finished cleanly, even after a cancel or error, so the next sync resumes from there
        if man.get("files") or man.get("truth"):
            try:
                self.store.save_manifest(spec.id, man)
            except OSError as exc:
                logger.error("Could not save manifest for %s: %s", spec.id, exc)
        # Rebuild consolidated caches before reporting completion, so the first view after a sync is fast
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
        client = self._client(spec.bucket, cancel_event=job.cancel_event)
        known_locations = self._known_locations()

        # 1. Confirm the hub is still a displayable flu hub and record its config
        info = inspect_hub(client, known_locations)
        if not info.get("supported"):
            raise ValueError(info.get("reason") or "This hub is not supported")
        hub_dir = self.store.hub_dir(spec.id)
        (hub_dir / "hub-config").mkdir(parents=True, exist_ok=True)
        for name in ("admin", "tasks"):
            with open(hub_dir / "hub-config" / f"{name}.json", "w", encoding="utf-8") as f:
                json.dump(info[name], f)
        tz_name = info.get("timezone") or "US/Eastern"
        man.update({
            "hub_id": spec.id,
            "bucket": spec.bucket,
            "hub_name": info.get("name"),
            "timezone": tz_name,
            "seasons": sorted(set(man.get("seasons", [])) | set(job.seasons)),
        })

        # 2. List forecasts and diff against the manifest
        job.phase = "Listing forecasts"
        cached = self._listing_cache.pop(spec.id, None)
        objs = cached[1] if cached and time.time() - cached[0] < 120 else self._list_forecasts(client)
        wanted = {
            o.key: o for o in objs
            if season_for_date(FORECAST_KEY_RE.match(o.key).group(2)) in job.seasons
        }
        # Prefer parquet when a hub mirrors both formats for the same round
        stems: Dict[str, str] = {}
        for key in sorted(wanted, key=lambda k: k.endswith(".csv")):
            stem = key.rsplit(".", 1)[0]
            if stem in stems:
                wanted.pop(key)
            else:
                stems[stem] = key
        to_fetch = [
            o for k, o in wanted.items()
            if k not in man["files"]
            or man["files"][k].get("etag") != o.etag
            or int(man["files"][k].get("size", -1)) != o.size
            or _outdated(man["files"][k])
            or not (hub_dir / man["files"][k].get("path", "__missing__")).exists()
            or (man["files"][k].get("peak_path") and not (hub_dir / man["files"][k]["peak_path"]).exists())
        ]
        removed = [
            k for k, f in man["files"].items()
            if season_for_date(f["reference_date"]) in job.seasons and k not in wanted
        ]
        job.files_total = len(to_fetch)
        job.bytes_total = sum(o.size for o in to_fetch)

        # 3. Download, validate, normalize, and atomically store each changed file
        job.phase = "Downloading forecasts"
        added = updated = failed = 0
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {pool.submit(self._fetch_forecast, client, spec, o, known_locations): o for o in to_fetch}
            try:
                for fut in as_completed(futures):
                    o = futures[fut]
                    try:
                        entry = fut.result()
                    except SyncCancelled:
                        raise
                    except (S3Error, NormalizationError, OSError, ValueError, pl.exceptions.PolarsError) as exc:
                        failed += 1
                        m = FORECAST_KEY_RE.match(o.key)
                        man.setdefault("hub_warnings", [])
                        msg = f"Skipped {m.group(2)}-{m.group(1)}: {exc}"
                        if msg not in man["hub_warnings"]:
                            man["hub_warnings"] = (man["hub_warnings"] + [msg])[-50:]
                        job.advance(o.size)
                        continue
                    prev = man["files"].get(o.key)
                    if prev is not None:
                        updated += 1
                        entry["first_fetched_at"] = prev.get("first_fetched_at") or prev.get("fetched_at")
                        entry["revisions"] = int(prev.get("revisions", 0))
                        if prev.get("etag") == o.etag:
                            # Same upstream file, re-read by a newer normalization: keep its history notes
                            entry["warnings"] += [w for w in prev.get("warnings", [])
                                                  if "resubmitted upstream" in w and w not in entry["warnings"]]
                        else:
                            entry["revisions"] += 1
                            entry["warnings"].append(
                                f"{entry['reference_date']}-{entry['model']}: resubmitted upstream "
                                f"(revision {entry['revisions']}, posted {o.last_modified[:16].replace('T', ' ')} UTC)"
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
            for rel in (f.get("path"), f.get("peak_path")):
                if rel and (hub_dir / rel).exists():
                    (hub_dir / rel).unlink(missing_ok=True)

        # 4. Model metadata for every model we hold (small YAML files)
        job.phase = "Model metadata"
        self._sync_metadata(client, spec, man)

        # 5. Truth data so live rounds can be plotted against current observations and scored
        job.phase = "Truth data"
        self._sync_truth(client, spec, man, job)

        man["last_sync"] = _utcnow()
        man["pending"] = {"new": 0, "changed": 0, "removed": 0, "checked_at": man["last_sync"],
                          "latest_round": max((f["reference_date"] for f in man["files"].values()), default=None)}
        job.summary = {
            "added": added, "updated": updated, "removed": len(removed), "failed": failed,
            "models_changed": len(changed_models),
        }

    def _fetch_forecast(self, client: S3Client, spec: HubSpec, o: S3Object,
                        known_locations: Set[str]) -> Dict[str, Any]:
        m = FORECAST_KEY_RE.match(o.key)
        model, ref, model2, ext = m.group(1), m.group(2), m.group(3), m.group(4)
        data = client.get(o.key)
        if len(data) != o.size:
            raise NormalizationError(f"truncated download ({len(data)} of {o.size} bytes)")
        df = read_table(data, f".{ext}")
        if df.is_empty():
            raise NormalizationError("file has no rows")
        norm, info = normalize_forecast(df, model, ref, known_locations, self._is_non_negative)
        warnings = list(info["warnings"])
        if model2 != model:
            warnings.append(f"{ref}-{model}: file name model '{model2}' does not match folder")

        rel = Path("model-output") / model / f"{ref}-{model}.parquet"
        dest = self.store.hub_dir(spec.id) / rel
        stored = 0
        if not norm.is_empty():
            _atomic_write_parquet(norm, dest)
            _set_mtime(dest, o.last_modified)
            stored = dest.stat().st_size
        elif dest.exists():
            dest.unlink(missing_ok=True)
        peak = info["peak"]
        peak_rel = Path("peak-output") / model / f"{ref}-{model}.parquet"
        peak_dest = self.store.hub_dir(spec.id) / peak_rel
        if not peak.is_empty():
            _atomic_write_parquet(peak, peak_dest)
            _set_mtime(peak_dest, o.last_modified)
            stored += peak_dest.stat().st_size
        elif peak_dest.exists():
            peak_dest.unlink(missing_ok=True)
        if norm.is_empty() and peak.is_empty():
            warnings.append(
                f"{ref}-{model}: not shown, only {', '.join(info['output_types']) or 'no'} forecasts (viz displays quantile forecasts)"
            )
        now = _utcnow()
        return {
            "model": model,
            "reference_date": ref,
            "etag": o.etag,
            "size": o.size,
            "last_modified": o.last_modified,
            "fetched_at": now,
            "first_fetched_at": now,
            "path": str(rel) if not norm.is_empty() else "",
            "stored_bytes": stored,
            "rows": info["rows"],
            "targets": info["targets"],
            "quantile_levels": info.get("quantile_levels", {}),
            "peak_path": str(peak_rel) if not peak.is_empty() else "",
            "peak_targets": info.get("peak_targets", []),
            "schema": FILE_SCHEMA,
            "revisions": 0,
            "warnings": warnings,
        }

    def _sync_metadata(self, client: S3Client, spec: HubSpec, man: Dict[str, Any]):
        models = {f["model"] for f in man["files"].values()}
        try:
            objs = client.list("model-metadata/")
        except S3Error as exc:
            logger.info("No model metadata for hub %s: %s", spec.id, exc)
            return
        by_model = {}
        for o in objs:
            name = o.key.rsplit("/", 1)[-1]
            stem, _, ext = name.rpartition(".")
            if ext in ("yml", "yaml") and stem in models:
                by_model[stem] = o
        todo = [o for m, o in by_model.items() if man["metadata"].get(m, {}).get("etag") != o.etag
                or not self.store.metadata_path(spec.id, m).exists()]

        def fetch(o: S3Object):
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
                except (S3Error, OSError) as exc:
                    logger.info("Model metadata download failed: %s", exc)

    def _sync_truth(self, client: S3Client, spec: HubSpec, man: Dict[str, Any], job: SyncJob):
        truth = man.setdefault("truth", {})
        objs = {o.key: o for o in client.list("target-data/")}

        # Oracle output (scoring truth for every target; also the NSSP stream)
        oracle_obj = objs.get("target-data/oracle-output.parquet") or objs.get("target-data/oracle-output.csv")
        dest = self.store.truth_path(spec.id, "oracle")
        if oracle_obj and (truth.get("oracle", {}).get("etag") != oracle_obj.etag or not dest.exists()):
            data = client.get(oracle_obj.key)
            if oracle_obj.key.endswith(".parquet"):
                raw = read_table(data, ".parquet")
            else:
                raw = pl.read_csv(
                    data,
                    schema_overrides={"location": pl.String, "output_type_id": pl.String, "oracle_value": pl.Float64,
                                      "as_of": pl.String, "target_end_date": pl.String, "target": pl.String},
                    null_values=["", "NA", "null", "NaN", "None", "NULL"],
                )
            oracle = normalize_oracle(raw, oracle_obj.last_modified[:10])
            if oracle.is_empty():
                raise NormalizationError("hub oracle-output has no rows")
            _atomic_write_parquet(oracle, dest)
            truth["oracle"] = {
                "key": oracle_obj.key, "etag": oracle_obj.etag, "last_modified": oracle_obj.last_modified,
                "as_of": oracle.get_column("as_of").max(), "max_date": oracle.get_column("target_end_date").max(),
                "rows": oracle.height,
            }

        # Weekly admissions series (long history back to 2022 for the chart and prior-season waves)
        adm_obj = objs.get("target-data/target-hospital-admissions.csv")
        dest = self.store.truth_path(spec.id, "admissions")
        if adm_obj and (truth.get("admissions", {}).get("etag") != adm_obj.etag or not dest.exists()):
            raw = pl.read_csv(client.get(adm_obj.key), schema_overrides={"location": pl.String, "value": pl.Float64,
                                                                         "date": pl.String},
                              null_values=["", "NA", "NaN"])
            adm = normalize_admissions(raw, ADMISSIONS_TARGET)
            _atomic_write_parquet(adm, dest)
            truth["admissions"] = {
                "key": adm_obj.key, "etag": adm_obj.etag, "last_modified": adm_obj.last_modified,
                "max_date": adm.get_column("target_end_date").max(), "rows": adm.height,
            }

        # Point-in-time snapshots newer than the bundled as-of vintages, for the synced seasons only
        local_max = self._local_as_of_max() or ""
        try:
            snaps = [o for o in client.list("auxiliary-data/target-data-archive/") if SNAPSHOT_KEY_RE.match(o.key)]
        except S3Error:
            snaps = []
        have = set(truth.get("as_of", {}).get("snapshots", []))
        wanted = []
        for o in snaps:
            d = SNAPSHOT_KEY_RE.match(o.key).group(1)
            if d > local_max and season_for_date(d) in job.seasons and d not in have:
                wanted.append((d, o))
        if wanted:
            dest = self.store.truth_path(spec.id, "as_of")
            frames = [pl.read_parquet(dest)] if dest.exists() else []
            for d, o in sorted(wanted):
                raw = pl.read_csv(client.get(o.key), schema_overrides={"location": pl.String, "value": pl.Float64,
                                                                       "date": pl.String},
                                  null_values=["", "NA", "NaN"])
                frames.append(normalize_admissions(raw, ADMISSIONS_TARGET, as_of=d))
                have.add(d)
            snap_df = pl.concat(frames, how="diagonal_relaxed").unique(
                subset=["as_of", "target", "location", "target_end_date"], keep="last")
            _atomic_write_parquet(snap_df, dest)
            truth["as_of"] = {"snapshots": sorted(have), "as_of": max(have), "max_date": max(have)}
