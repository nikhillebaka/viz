"""
High-performance Parquet cache manager for FluSight Sandbox models and ground truth.
Enables instant Polars scanning and query execution on Apple Silicon and modern CPUs.
Auto-invalidates when underlying CSV files are added, modified, or deleted.
Fully thread-safe with atomic file writes to prevent race conditions.
"""

from collections import defaultdict
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import threading
import time
from typing import Callable, Dict, List, Optional, Set, Tuple, Any

import polars as pl

from viz.core.parallel import ordered_map
from viz.core.truth import (
    ADMISSIONS_KEYS,
    NULL_VALUES,
    ORACLE_KEYS,
    PRIORITY_ARCHIVE,
    PRIORITY_PEER,
    PRIORITY_REMOTE,
    PRIORITY_REPO,
    TruthSource,
    is_flu_hosp_target,
    merge_truth_frames,
    reconcile_truth_sources,
    reconcile_vintages,
)
from viz.remote.store import RemoteStore, TRUTH_FILES

logger = logging.getLogger("viz.cache")

SNAPSHOT_DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})\.csv$")


def filter_quantile_rows(df: pl.DataFrame) -> pl.DataFrame:
    """Keep quantile rows only and cast their output_type_id levels to rounded floats."""
    if "output_type" in df.columns:
        df = df.filter(pl.col("output_type") == "quantile")
    return df.with_columns(pl.col("output_type_id").cast(pl.Float64).round(3))


class LockRegistry:
    """Thread-safe lock dispenser to eliminate race conditions in lock creation."""

    def __init__(self):
        self._locks: Dict[str, threading.Lock] = {}
        self._master_lock = threading.Lock()

    def get(self, key: str) -> threading.Lock:
        with self._master_lock:
            if key not in self._locks:
                self._locks[key] = threading.Lock()
            return self._locks[key]


class WarningRegistry:
    """Thread-safe registry for dataset and schema validation warnings."""

    def __init__(self):
        self._warnings: Dict[str, List[str]] = defaultdict(list)
        self._lock = threading.Lock()

    def add_warning(self, source: str, message: str):
        with self._lock:
            if message not in self._warnings[source]:
                self._warnings[source].append(message)

    def get_warnings(self, sources: Optional[List[str]] = None) -> List[str]:
        with self._lock:
            if sources is None:
                all_w = []
                for w_list in self._warnings.values():
                    all_w.extend(w_list)
                return sorted(list(set(all_w)))
            selected = []
            for s in sources:
                selected.extend(self._warnings.get(s, []))
            return sorted(list(set(selected)))

    def clear(self, source: Optional[str] = None):
        with self._lock:
            if source:
                self._warnings.pop(source, None)
            else:
                self._warnings.clear()


class ParquetCacheManager:
    """
    Transparent Parquet caching layer for model outputs and surveillance targets.
    Manages per-model consolidated Parquet tables and target data with automatic
    mtime-based cache validation, per-model mutexes, and atomic filesystem renames.
    """

    def __init__(
        self,
        base_dir: Path,
        include_remote: bool = True,
        cache_dir: Optional[Path] = None,
        surveillance_dir: Optional[Path] = None,
        seed_dir: Optional[Path] = None,
        remote_dir: Optional[Path] = None,
        hub_models_cache_dir: Optional[Path] = None,
        peer_truth_provider: Optional[Callable[[], List[Dict[str, Any]]]] = None,
        allowed_targets_provider: Optional[Callable[[], Set[str]]] = None,
        allowed_locations_provider: Optional[Callable[[], Set[str]]] = None,
        remote_store: Optional[RemoteStore] = None,
        calendar_provider: Optional[Callable[[], Any]] = None,
        geo_provider: Optional[Callable[[], Any]] = None,
        is_non_negative_provider: Optional[Callable[[str], bool]] = None,
    ):
        self.base_dir = Path(base_dir).resolve()
        # Hub data synced from S3 is only used by the dashboard; the CLI scores repository models only
        self.include_remote = include_remote
        self.model_output_dir = self.base_dir / "model-output"
        self.local_output_dir = self.base_dir / "local-output"
        self.target_data_dir = self.base_dir / "target-data"
        self.auxiliary_data_dir = self.base_dir / "auxiliary-data"
        self.repo_root = self.base_dir

        # Determine viz directory and self-contained surveillance path
        if (self.base_dir / "viz").is_dir():
            self.viz_dir = self.base_dir / "viz"
        elif (self.base_dir / "static").is_dir() and (self.base_dir / "server.py").is_file():
            self.viz_dir = self.base_dir
        else:
            self.viz_dir = self.base_dir / "viz"

        self.surveillance_dir = (
            Path(surveillance_dir).resolve()
            if surveillance_dir is not None
            else (self.viz_dir / "data" / "surveillance")
        )
        self.cache_dir = (
            Path(cache_dir).resolve()
            if cache_dir is not None
            else (self.viz_dir / ".cache")
        )
        if seed_dir is not None:
            self.seed_dir = Path(seed_dir).resolve()
        elif (self.viz_dir / "data" / "seed").is_dir():
            self.seed_dir = self.viz_dir / "data" / "seed"
        else:
            from viz.core.paths import APP_DIR
            self.seed_dir = APP_DIR / "data" / "seed"

        self.models_cache_dir = self.cache_dir / "models"
        self.local_models_cache_dir = self.cache_dir / "local_models"
        self.hub_models_cache_dir = (
            Path(hub_models_cache_dir).resolve()
            if hub_models_cache_dir is not None
            else (self.cache_dir / "hub_models")
        )
        self.targets_cache_dir = self.cache_dir / "targets"
        self.remote_store = remote_store if remote_store is not None else RemoteStore(self.cache_dir, root=remote_dir)
        self._peer_truth_provider = peer_truth_provider
        self._allowed_targets_provider = allowed_targets_provider
        self._allowed_locations_provider = allowed_locations_provider
        self._calendar_provider = calendar_provider
        self._geo_provider = geo_provider
        self._is_non_negative_provider = is_non_negative_provider

        self._model_locks = LockRegistry()
        self._target_locks = LockRegistry()
        self.warning_registry = WarningRegistry()
        self._missing_logged: set = set()
        self._fresh_lock = threading.Lock()
        self._fresh_pq_cache: Dict[str, Tuple[Optional[Path], int]] = {}

        self._ensure_dirs()

    def _calendar(self):
        if self._calendar_provider is not None:
            return self._calendar_provider()
        from viz.core.config import VizConfig
        return VizConfig(self.base_dir).get_calendar()

    def _geo(self):
        if self._geo_provider is not None:
            return self._geo_provider()
        return None

    def _pad_fips(self) -> bool:
        geo = self._geo()
        if geo is not None:
            return bool(getattr(geo, "uses_us_fips", True))
        return True

    def get_validation_warnings(self, sources: Optional[List[str]] = None) -> List[str]:
        """Return captured validation warnings for specified models or all models."""
        return self.warning_registry.get_warnings(sources)

    def _ensure_dirs(self):
        self.models_cache_dir.mkdir(parents=True, exist_ok=True)
        self.local_models_cache_dir.mkdir(parents=True, exist_ok=True)
        self.hub_models_cache_dir.mkdir(parents=True, exist_ok=True)
        self.targets_cache_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _scan_source_files(source_dir: Path) -> Tuple[List[Path], Dict[str, Any]]:
        """Single-pass os.scandir collection of .csv/.parquet files plus fingerprint metadata."""
        entries: List[Tuple[str, Path, os.stat_result]] = []
        try:
            with os.scandir(source_dir) as it:
                for ent in it:
                    if ent.name.startswith("."):
                        continue
                    ext = os.path.splitext(ent.name)[1].lower()
                    if ext not in (".csv", ".parquet"):
                        continue
                    if ent.is_file():
                        st = ent.stat()
                        entries.append((ent.name, Path(ent.path), st))
        except OSError:
            return [], {"count": 0, "max_mtime": 0.0, "total_size": 0}

        if not entries:
            return [], {"count": 0, "max_mtime": 0.0, "total_size": 0}
        # CSVs sorted then Parquets sorted to match prior ordering cleanly
        entries.sort(key=lambda item: (0 if item[1].suffix.lower() == ".csv" else 1, item[0]))
        files = [item[1] for item in entries]
        fp = {
            "count": len(entries),
            "max_mtime": max(item[2].st_mtime for item in entries),
            "total_size": sum(item[2].st_size for item in entries),
        }
        return files, fp

    @staticmethod
    def _compute_dir_fingerprint(csv_files: List[Path]) -> Dict[str, Any]:
        if not csv_files:
            return {"count": 0, "max_mtime": 0.0, "total_size": 0}
        stats = [f.stat() for f in csv_files]
        return {
            "count": len(csv_files),
            "max_mtime": max(st.st_mtime for st in stats),
            "total_size": sum(st.st_size for st in stats),
        }

    def _is_cache_fresh(self, pq_path: Path, meta_path: Path, fingerprint: Dict[str, Any]) -> bool:
        if not pq_path.exists() or not meta_path.exists():
            return False
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                saved = json.load(f)
            if (
                saved.get("count") != fingerprint["count"]
                or abs(saved.get("max_mtime", 0.0) - fingerprint["max_mtime"]) >= 1e-3
                or saved.get("total_size") != fingerprint["total_size"]
            ):
                return False
            if "paths" in fingerprint and saved.get("paths") != fingerprint["paths"]:
                return False
            return True
        except Exception:
            return False

    def active_remote_hub_ids(self) -> List[str]:
        """Remote S3 hubs enabled AND compatible with the active hub's targets/locations."""
        if not self.include_remote:
            return []
        stamp = self.remote_store.state_mtime()
        with self._fresh_lock:
            hit = self._fresh_pq_cache.get("__active_remote_hub_ids__")
        if hit is not None and hit[1] == stamp:  # type: ignore[comparison-overlap]
            return list(hit[0])  # type: ignore[arg-type]
        targets = self._allowed_targets_provider() if self._allowed_targets_provider else None
        locations = self._allowed_locations_provider() if self._allowed_locations_provider else None
        if targets or locations:
            res = self.remote_store.compatible_hub_ids(targets=targets, locations=locations)
        else:
            res = self.remote_store.active_hub_ids()
        with self._fresh_lock:
            self._fresh_pq_cache["__active_remote_hub_ids__"] = (tuple(res), stamp)  # type: ignore[assignment]
        return res

    def hub_key(self, model_id: str) -> Optional[Tuple[str, str]]:
        """Split a hub model key like 'flusight:UMass-flusion' into (hub_id, model). None for other models."""
        if not self.include_remote or ":" not in model_id:
            return None
        hub_id, _, name = model_id.partition(":")
        if hub_id in ("local", "synthetic", "merged") or not name or "/" in name or "\\" in name or name.startswith("."):
            return None
        if hub_id not in self.active_remote_hub_ids():
            return None
        return hub_id, name

    def merged_key(self, model_id: str) -> Optional[Tuple[str, str]]:
        """Split a virtual deduplicated union key 'merged:<hub_id>:<model>' into (hub_id, model)."""
        if not self.include_remote or not model_id.startswith("merged:"):
            return None
        rest = model_id[7:]
        hub_id, _, name = rest.partition(":")
        if not hub_id or not name or "/" in name or "\\" in name or name.startswith("."):
            return None
        if hub_id not in self.active_remote_hub_ids():
            return None
        return hub_id, name

    def _merge_parquets(
        self,
        repo_pq: Optional[Path],
        hub_pq: Optional[Path],
        dest_pq: Path,
        meta_path: Path,
        lock_key: str,
    ) -> Optional[Path]:
        """Union repo and remote Parquets for the same model, preferring local repo rounds on date overlap."""
        repo_ok = repo_pq is not None and repo_pq.is_file()
        hub_ok = hub_pq is not None and hub_pq.is_file()
        if not repo_ok and not hub_ok:
            return None
        if not repo_ok:
            return hub_pq
        if not hub_ok:
            return repo_pq

        r_st, h_st = repo_pq.stat(), hub_pq.stat()
        fp = {
            "repo_mtime": r_st.st_mtime,
            "repo_size": r_st.st_size,
            "hub_mtime": h_st.st_mtime,
            "hub_size": h_st.st_size,
        }

        def _is_merge_fresh() -> bool:
            if not dest_pq.is_file() or not meta_path.is_file():
                return False
            try:
                saved = json.loads(meta_path.read_text(encoding="utf-8"))
                return (
                    saved.get("repo_size") == fp["repo_size"]
                    and saved.get("hub_size") == fp["hub_size"]
                    and abs(saved.get("repo_mtime", 0.0) - fp["repo_mtime"]) < 1e-3
                    and abs(saved.get("hub_mtime", 0.0) - fp["hub_mtime"]) < 1e-3
                )
            except (OSError, ValueError):
                return False

        if _is_merge_fresh():
            return dest_pq

        with self._model_locks.get(lock_key):
            if _is_merge_fresh():
                return dest_pq
            repo_df = pl.read_parquet(repo_pq)
            hub_df = pl.read_parquet(hub_pq)
            if "reference_date" in repo_df.columns:
                repo_df = repo_df.with_columns(pl.col("reference_date").cast(pl.String))
                repo_dates = repo_df.get_column("reference_date").unique().drop_nulls().to_list()
            else:
                repo_dates = []
            if "reference_date" in hub_df.columns:
                hub_df = hub_df.with_columns(pl.col("reference_date").cast(pl.String))
                hub_extra = hub_df.filter(~pl.col("reference_date").is_in(repo_dates)) if repo_dates else hub_df
            else:
                hub_extra = hub_df.head(0)

            combined = repo_df if hub_extra.is_empty() else pl.concat([repo_df, hub_extra], how="diagonal_relaxed")
            dest_pq.parent.mkdir(parents=True, exist_ok=True)
            self._atomic_write_parquet(combined, dest_pq)
            tid = f"{os.getpid()}_{threading.get_ident()}"
            tmp_meta = meta_path.with_suffix(f".tmp.{tid}.json")
            try:
                with open(tmp_meta, "w", encoding="utf-8") as fm:
                    json.dump(fp, fm)
                os.replace(tmp_meta, meta_path)
            finally:
                tmp_meta.unlink(missing_ok=True)
            return dest_pq

    def _resolve_model_paths(self, model_id: str, is_local: bool = False) -> Optional[Tuple[Path, Path, str, Optional[Tuple[str, str]], bool]]:
        """Resolve `(source_dir, dest_dir, file_stem, hub_tuple_or_None, is_local)` for a model."""
        hub = self.hub_key(model_id)
        if hub is not None:
            source_dir = self.remote_store.model_dir(*hub)
            if not source_dir.is_dir():
                return None
            dest_dir = self.hub_models_cache_dir / hub[0]
            dest_dir.mkdir(parents=True, exist_ok=True)
            return source_dir, dest_dir, hub[1], hub, False

        if model_id.startswith("local:"):
            model_id, is_local = model_id[6:], True
        source_dir = (self.local_output_dir if is_local else self.model_output_dir) / model_id
        if not source_dir.exists() or not source_dir.is_dir():
            alt_dir = (self.model_output_dir if is_local else self.local_output_dir) / model_id
            if alt_dir.exists() and alt_dir.is_dir():
                source_dir = alt_dir
                is_local = not is_local
            else:
                return None
        dest_dir = self.local_models_cache_dir if is_local else self.models_cache_dir
        dest_dir.mkdir(parents=True, exist_ok=True)
        return source_dir, dest_dir, model_id, None, is_local

    @staticmethod
    def _atomic_write_parquet(df: pl.DataFrame, dest: Path):
        tid = f"{os.getpid()}_{threading.get_ident()}"
        tmp = dest.with_suffix(f".tmp.{tid}.parquet")
        try:
            df.write_parquet(tmp, compression="zstd")
            os.replace(tmp, dest)
        finally:
            tmp.unlink(missing_ok=True)

    @staticmethod
    def _read_model_file(f: Path) -> pl.DataFrame:
        if f.suffix.lower() == ".parquet":
            return pl.read_parquet(f)
        return pl.read_csv(
            f,
            schema_overrides={
                "location": pl.String,
                "horizon": pl.Int32,
                "output_type_id": pl.String,
                "value": pl.Float64,
                "output_type": pl.String,
                "target": pl.String,
                "target_end_date": pl.String,
                "reference_date": pl.String,
                "origin_date": pl.String,
                "age_group": pl.String,
            },
            null_values=NULL_VALUES,
            ignore_errors=False,
        )

    def _consolidate_sidecar_parquets(self, source_dir: Path, dest_pq: Path, meta_path: Path, model_id: str, prefix: str) -> Optional[Path]:
        """Consolidate pre-normalized remote sidecar files (sample-output / pmf-output) into one Parquet."""
        if not source_dir.is_dir():
            return None
        files, fp = self._scan_source_files(source_dir)
        if not files:
            return None
        if self._is_cache_fresh(dest_pq, meta_path, fp):
            return dest_pq
        with self._model_locks.get(f"{prefix}::{model_id}"):
            if self._is_cache_fresh(dest_pq, meta_path, fp):
                return dest_pq
            frames = []
            for f in files:
                try:
                    df = pl.read_parquet(f) if f.suffix.lower() == ".parquet" else pl.read_csv(f, null_values=NULL_VALUES)
                    if not df.is_empty():
                        frames.append(df)
                except Exception as exc:
                    logger.warning("Skipping %s file %s: %s", prefix, f, exc)
            if not frames:
                dest_pq.unlink(missing_ok=True)
                return None
            combined = pl.concat(frames, how="diagonal_relaxed")
            self._atomic_write_parquet(combined, dest_pq)
            tid = f"{os.getpid()}_{threading.get_ident()}"
            tmp_meta = meta_path.with_suffix(f".tmp.{tid}.json")
            try:
                with open(tmp_meta, "w", encoding="utf-8") as fm:
                    json.dump(fp, fm)
                os.replace(tmp_meta, meta_path)
            finally:
                tmp_meta.unlink(missing_ok=True)
            return dest_pq

    def _get_merged_artifact(
        self,
        hub_id: str,
        name: str,
        suffix: str,
        meta_suffix: str,
        fetch_fn: Any,
        lock_prefix: str,
    ) -> Optional[Path]:
        """Resolve and merge repo + remote Parquet artifacts for `merged:<hub_id>:<name>`."""
        repo_pq = fetch_fn(name, is_local=False)
        hub_pq = fetch_fn(f"{hub_id}:{name}", is_local=False)
        return self._merge_parquets(
            repo_pq,
            hub_pq,
            self.models_cache_dir / f"{name}.merged.{hub_id}{suffix}",
            self.models_cache_dir / f"{name}.merged.{hub_id}{meta_suffix}",
            f"merged::{lock_prefix}::{hub_id}::{name}",
        )

    def get_model_parquet(self, model_id: str, is_local: bool = False) -> Optional[Path]:
        """
        Build/return consolidated quantile Parquet (plus samples, pmf, and derived peak sidecars)
        via unified `viz.core.ingest.normalize_forecast_frame`.
        Thread-safe with per-model locking and atomic filesystem replacement.
        """
        from viz.core.ingest import NormalizationError, normalize_forecast_frame

        fast_key = f"q::{int(bool(is_local))}::{model_id}"

        merged = self.merged_key(model_id)
        if merged is not None:
            return self._get_merged_artifact(
                merged[0], merged[1], ".parquet", ".meta.json", self.get_model_parquet, "q"
            )

        resolved = self._resolve_model_paths(model_id, is_local=is_local)
        if resolved is None:
            return None
        source_dir, dest_dir, file_stem, hub, is_local = resolved
        try:
            dir_mtime_ns = source_dir.stat().st_mtime_ns
        except OSError:
            dir_mtime_ns = -1

        with self._fresh_lock:
            hit = self._fresh_pq_cache.get(fast_key)
        if hit is not None and dir_mtime_ns >= 0 and hit[1] == dir_mtime_ns:
            p = hit[0]
            if p is None or p.exists():
                return p

        def _memo(p: Optional[Path]) -> Optional[Path]:
            if dir_mtime_ns >= 0:
                with self._fresh_lock:
                    self._fresh_pq_cache[fast_key] = (p, dir_mtime_ns)
            return p

        is_remote_dir = (hub is not None) or (not is_local and (self.base_dir / "manifest.json").is_file())

        pq_path = dest_dir / f"{file_stem}.parquet"
        samples_pq = dest_dir / f"{file_stem}.samples.parquet"
        pmf_pq = dest_dir / f"{file_stem}.pmf.parquet"
        peak_pq = dest_dir / f"{file_stem}.peak.parquet"
        meta_path = dest_dir / f"{file_stem}.meta.json"
        peak_meta_path = dest_dir / f"{file_stem}.peak.meta.json"

        source_files, fp = self._scan_source_files(source_dir)
        if not source_files:
            return None

        # Quick check before lock (if meta is fresh and marks quantile-empty, skip rebuild cleanly)
        if self._is_cache_fresh(pq_path, meta_path, fp):
            return _memo(pq_path)
        if not pq_path.exists() and meta_path.exists():
            try:
                saved = json.loads(meta_path.read_text(encoding="utf-8"))
                if (
                    saved.get("empty_quantiles")
                    and saved.get("count") == fp["count"]
                    and saved.get("total_size") == fp["total_size"]
                    and abs(saved.get("max_mtime", 0.0) - fp["max_mtime"]) < 1e-3
                ):
                    return _memo(None)
            except Exception:
                pass

        lock_key = f"{'local' if is_local else ('hub' if hub else 'repo')}::{model_id}"
        lock = self._model_locks.get(lock_key)
        with lock:
            if self._is_cache_fresh(pq_path, meta_path, fp):
                return _memo(pq_path)

            cal = self._calendar()
            geo = self._geo()
            known_locs = set(geo.nodes.keys()) if geo is not None and geo.nodes else None

            q_dfs: List[pl.DataFrame] = []
            s_dfs: List[pl.DataFrame] = []
            p_dfs: List[pl.DataFrame] = []
            pk_dfs: List[pl.DataFrame] = []
            all_targets: Set[str] = set()
            q_targets: Set[str] = set()
            pmf_targets: Set[str] = set()
            pk_targets: Set[str] = set()
            output_types: Set[str] = set()
            extra_task_ids: Set[str] = set()
            derived_targets: Set[str] = set()
            quality_warnings: List[str] = []

            for f in source_files:
                d_str = f.name[:10]
                try:
                    df = self._read_model_file(f)
                    if df.is_empty():
                        self.warning_registry.add_warning(
                            model_id, f"Forecast file '{f.name}' for model '{model_id}' contains zero data rows."
                        )
                        continue

                    if is_remote_dir and "output_type" in df.columns and df.select((pl.col("output_type") == "quantile").all()).item():
                        # Already-normalized remote parquet: validate quickly and keep canonical columns
                        missing_req = [c for c in ["location", "output_type_id", "value"] if c not in df.columns]
                        if missing_req:
                            raise NormalizationError(f"missing required columns: {missing_req}")
                        norm = filter_quantile_rows(df)
                        if not norm.is_empty():
                            q_dfs.append(norm)
                            if "target" in norm.columns:
                                qt = {str(t) for t in norm.get_column("target").unique().to_list() if t}
                                q_targets.update(qt)
                                all_targets.update(qt)
                            output_types.add("quantile")
                            from viz.core.ingest import STANDARD_RAW_COLS
                            extra_task_ids.update(c for c in norm.columns if c not in STANDARD_RAW_COLS)
                        continue

                    res = normalize_forecast_frame(
                        df,
                        model=model_id,
                        reference_date=d_str,
                        calendar=cal,
                        geo=geo,
                        known_locations=known_locs,
                        is_non_negative=self._is_non_negative_provider,
                    )
                    for w in res.info.get("warnings") or []:
                        if "unknown location codes" not in w or known_locs:
                            quality_warnings.append(w)
                    all_targets.update(res.info.get("all_targets") or [])
                    output_types.update(res.info.get("output_types") or [])
                    extra_task_ids.update(res.info.get("extra_task_ids") or [])
                    derived_targets.update(res.info.get("derived_from_samples") or [])
                    if not res.quantiles.is_empty():
                        q_dfs.append(res.quantiles)
                        q_targets.update(res.info.get("quantile_targets") or [])
                    if not res.samples.is_empty():
                        s_dfs.append(res.samples)
                    if not res.pmf.is_empty():
                        p_dfs.append(res.pmf)
                        pmf_targets.update(res.info.get("pmf_targets") or [])
                    if not res.peaks.is_empty():
                        pk_dfs.append(res.peaks)
                        pk_targets.update(res.info.get("peak_targets") or [])
                except NormalizationError as exc:
                    msg = f"Forecast file '{f.name}' for model '{model_id}' is {exc}"
                    logger.warning(msg)
                    self.warning_registry.add_warning(model_id, msg)
                    continue
                except Exception as exc:
                    msg = f"Failed to parse forecast file '{f.name}' for model '{model_id}': {exc}"
                    logger.warning(msg)
                    self.warning_registry.add_warning(model_id, msg)
                    continue

            if not q_dfs and not s_dfs and not p_dfs and not pk_dfs:
                return None

            tid = f"{os.getpid()}_{threading.get_ident()}"
            tmp_meta = meta_path.with_suffix(f".tmp.{tid}.json")
            try:
                if q_dfs:
                    combined_q = pl.concat(q_dfs, how="diagonal_relaxed")
                    self._atomic_write_parquet(combined_q, pq_path)
                else:
                    pq_path.unlink(missing_ok=True)

                if s_dfs:
                    self._atomic_write_parquet(pl.concat(s_dfs, how="diagonal_relaxed"), samples_pq)
                elif not is_remote_dir:
                    samples_pq.unlink(missing_ok=True)

                if p_dfs:
                    self._atomic_write_parquet(pl.concat(p_dfs, how="diagonal_relaxed"), pmf_pq)
                elif not is_remote_dir:
                    pmf_pq.unlink(missing_ok=True)

                if pk_dfs:
                    combined_pk = pl.concat(pk_dfs, how="diagonal_relaxed").unique(
                        subset=[c for c in ("reference_date", "location", "target", "output_type", "output_type_id", *sorted(extra_task_ids)) if c in pk_dfs[0].columns],
                        keep="last",
                    )
                    self._atomic_write_parquet(combined_pk, peak_pq)
                    tmp_pk_meta = peak_meta_path.with_suffix(f".tmp.{tid}.json")
                    with open(tmp_pk_meta, "w", encoding="utf-8") as fpk:
                        json.dump({**fp, "empty": False}, fpk)
                    os.replace(tmp_pk_meta, peak_meta_path)

                meta_payload = {
                    **fp,
                    "targets": sorted(all_targets or q_targets | pmf_targets),
                    "quantile_targets": sorted(q_targets),
                    "pmf_targets": sorted(pmf_targets),
                    "peak_targets": sorted(pk_targets),
                    "output_types": sorted(output_types),
                    "extra_task_ids": sorted(extra_task_ids),
                    "from_samples": sorted(derived_targets),
                    "has_samples": bool(s_dfs),
                    "has_pmf": bool(p_dfs),
                    "has_peaks": bool(pk_dfs),
                    "empty_quantiles": not bool(q_dfs),
                    "quality_warnings": quality_warnings[:50],
                }
                with open(tmp_meta, "w", encoding="utf-8") as f_meta:
                    json.dump(meta_payload, f_meta)
                os.replace(tmp_meta, meta_path)
                return _memo(pq_path if q_dfs else None)
            except Exception as exc:
                logger.error("Failed to write parquet cache for model %s: %s", model_id, exc)
                return None
            finally:
                tmp_meta.unlink(missing_ok=True)

    def get_model_samples_parquet(self, model_id: str, is_local: bool = False) -> Optional[Path]:
        """Get or build consolidated weekly sample-trajectory Parquet (`<model>.samples.parquet`)."""
        merged = self.merged_key(model_id)
        if merged is not None:
            return self._get_merged_artifact(
                merged[0], merged[1], ".samples.parquet", ".samples.meta.json", self.get_model_samples_parquet, "samples"
            )
        hub = self.hub_key(model_id)
        if hub is not None:
            s_dir = self.remote_store.sample_dir(*hub)
            if not s_dir.is_dir():
                return None
            dest_dir = self.hub_models_cache_dir / hub[0]
            dest_dir.mkdir(parents=True, exist_ok=True)
            return self._consolidate_sidecar_parquets(
                s_dir, dest_dir / f"{hub[1]}.samples.parquet", dest_dir / f"{hub[1]}.samples.meta.json", model_id, "samples"
            )
        if not is_local and not model_id.startswith("local:"):
            s_dir = self.base_dir / "sample-output" / model_id
            if s_dir.is_dir():
                self.models_cache_dir.mkdir(parents=True, exist_ok=True)
                return self._consolidate_sidecar_parquets(
                    s_dir,
                    self.models_cache_dir / f"{model_id}.samples.parquet",
                    self.models_cache_dir / f"{model_id}.samples.meta.json",
                    model_id,
                    "samples",
                )
        resolved = self._resolve_model_paths(model_id, is_local=is_local)
        if resolved is None:
            return None
        _, dest_dir, file_stem, _, is_local = resolved
        self.get_model_parquet(model_id, is_local=is_local)
        p = dest_dir / f"{file_stem}.samples.parquet"
        return p if p.is_file() else None

    def get_model_pmf_parquet(self, model_id: str, is_local: bool = False) -> Optional[Path]:
        """Get or build consolidated weekly PMF Parquet (`<model>.pmf.parquet`)."""
        merged = self.merged_key(model_id)
        if merged is not None:
            return self._get_merged_artifact(
                merged[0], merged[1], ".pmf.parquet", ".pmf.meta.json", self.get_model_pmf_parquet, "pmf"
            )
        hub = self.hub_key(model_id)
        if hub is not None:
            p_dir = self.remote_store.pmf_dir(*hub)
            if not p_dir.is_dir():
                return None
            dest_dir = self.hub_models_cache_dir / hub[0]
            dest_dir.mkdir(parents=True, exist_ok=True)
            return self._consolidate_sidecar_parquets(
                p_dir, dest_dir / f"{hub[1]}.pmf.parquet", dest_dir / f"{hub[1]}.pmf.meta.json", model_id, "pmf"
            )
        if not is_local and not model_id.startswith("local:"):
            p_dir = self.base_dir / "pmf-output" / model_id
            if p_dir.is_dir():
                self.models_cache_dir.mkdir(parents=True, exist_ok=True)
                return self._consolidate_sidecar_parquets(
                    p_dir,
                    self.models_cache_dir / f"{model_id}.pmf.parquet",
                    self.models_cache_dir / f"{model_id}.pmf.meta.json",
                    model_id,
                    "pmf",
                )
        resolved = self._resolve_model_paths(model_id, is_local=is_local)
        if resolved is None:
            return None
        _, dest_dir, file_stem, _, is_local = resolved
        self.get_model_parquet(model_id, is_local=is_local)
        p = dest_dir / f"{file_stem}.pmf.parquet"
        return p if p.is_file() else None

    def scan_model_samples(self, model_id: str, is_local: bool = False) -> Optional[pl.LazyFrame]:
        p = self.get_model_samples_parquet(model_id, is_local=is_local)
        return pl.scan_parquet(p) if (p and p.exists()) else None

    def scan_model_pmf(self, model_id: str, is_local: bool = False) -> Optional[pl.LazyFrame]:
        p = self.get_model_pmf_parquet(model_id, is_local=is_local)
        return pl.scan_parquet(p) if (p and p.exists()) else None

    def get_model_peak_parquet(self, model_id: str, is_local: bool = False) -> Optional[Path]:
        """
        Season peak rows (peak size quantiles and peak week pmfs) for a model, consolidated into
        `<model>.peak.parquet` next to its weekly table. Built on first use from the same source files and
        refreshed by the same fingerprint, so the weekly tables and their caches are never touched.
        Returns None when the model submitted no peak forecasts.
        """
        merged = self.merged_key(model_id)
        if merged is not None:
            return self._get_merged_artifact(
                merged[0], merged[1], ".peak.parquet", ".peak.meta.json", self.get_model_peak_parquet, "peak"
            )
        hub = self.hub_key(model_id)
        if hub is not None:
            source_dir = self.remote_store.peak_dir(*hub)
            dest_dir = self.hub_models_cache_dir / hub[0]
            file_stem = hub[1]
        else:
            if model_id.startswith("local:"):
                model_id, is_local = model_id[6:], True
            if not is_local:
                pk_dir = self.base_dir / "peak-output" / model_id
                if pk_dir.is_dir():
                    self.models_cache_dir.mkdir(parents=True, exist_ok=True)
                    return self._consolidate_sidecar_parquets(
                        pk_dir,
                        self.models_cache_dir / f"{model_id}.peak.parquet",
                        self.models_cache_dir / f"{model_id}.peak.meta.json",
                        model_id,
                        "peak",
                    )
            source_dir = (self.local_output_dir if is_local else self.model_output_dir) / model_id
            if not source_dir.is_dir():
                alt_dir = (self.model_output_dir if is_local else self.local_output_dir) / model_id
                if not alt_dir.is_dir():
                    return None
                source_dir, is_local = alt_dir, not is_local
            dest_dir = self.local_models_cache_dir if is_local else self.models_cache_dir
            file_stem = model_id
        if not source_dir.is_dir():
            return None

        source_files, fp = self._scan_source_files(source_dir)
        if not source_files:
            return None
        pq_path = dest_dir / f"{file_stem}.peak.parquet"
        meta_path = dest_dir / f"{file_stem}.peak.meta.json"

        def fresh() -> Optional[Tuple[bool, Optional[Path]]]:
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    saved = json.load(f)
            except (OSError, ValueError):
                return None
            if (saved.get("count") != fp["count"] or saved.get("total_size") != fp["total_size"]
                    or abs(saved.get("max_mtime", 0.0) - fp["max_mtime"]) >= 1e-3):
                return None
            if saved.get("empty"):
                return True, None
            return (True, pq_path) if pq_path.exists() else None

        hit = fresh()
        if hit is not None:
            return hit[1]

        with self._model_locks.get(f"peak::{model_id}"):
            hit = fresh()
            if hit is not None:
                return hit[1]
            # For local/repo models that only submit weekly trajectories (sample-only long-term models),
            # normalize through get_model_parquet first so derived season peaks are materialized cleanly.
            if hub is None:
                has_sample = False
                for f in source_files[:1]:
                    try:
                        lf_chk = pl.scan_parquet(f) if f.suffix.lower() == ".parquet" else pl.scan_csv(f, infer_schema_length=0, null_values=NULL_VALUES)
                        names = lf_chk.collect_schema().names()
                        if "output_type" in names and not lf_chk.filter(pl.col("output_type") == "sample").head(1).collect().is_empty():
                            has_sample = True
                    except Exception:
                        pass
                if has_sample:
                    self.get_model_parquet(model_id, is_local=is_local)
                    hit = fresh()
                    if hit is not None:
                        return hit[1]
            from viz.core.peaks import extract_peak_rows
            frames = []
            pad_fips = self._pad_fips()
            for f in source_files:
                try:
                    if f.suffix == ".parquet":
                        lf = pl.scan_parquet(f)
                    else:
                        lf = pl.scan_csv(f, infer_schema_length=0, null_values=NULL_VALUES)
                    names = lf.collect_schema().names()
                    if "target" not in names or "output_type" not in names:
                        continue
                    df = lf.filter(pl.col("target").cast(pl.String).str.to_lowercase().str.starts_with("peak ")).collect()
                    if df.is_empty():
                        continue
                    peak = extract_peak_rows(df, reference_date=f.name[:10], pad_single_digit_fips=pad_fips)
                    if not peak.is_empty():
                        frames.append(peak)
                except Exception as exc:
                    logger.warning("Skipping peak rows of %s: %s", f, exc)

            dest_dir.mkdir(parents=True, exist_ok=True)
            tid = f"{os.getpid()}_{threading.get_ident()}"
            tmp_pq = pq_path.with_suffix(f".tmp.{tid}.parquet")
            tmp_meta = meta_path.with_suffix(f".tmp.{tid}.json")
            try:
                if frames:
                    pl.concat(frames, how="vertical_relaxed").unique(
                        subset=["reference_date", "location", "target", "output_type", "output_type_id"], keep="last"
                    ).write_parquet(tmp_pq, compression="zstd")
                    os.replace(tmp_pq, pq_path)
                else:
                    pq_path.unlink(missing_ok=True)
                with open(tmp_meta, "w", encoding="utf-8") as f_meta:
                    json.dump({**fp, "empty": not frames}, f_meta)
                os.replace(tmp_meta, meta_path)
            except Exception as exc:
                logger.error("Failed to write peak cache for model %s: %s", model_id, exc)
                return None
            finally:
                tmp_pq.unlink(missing_ok=True)
                tmp_meta.unlink(missing_ok=True)
            return pq_path if frames else None

    def scan_model_peaks(self, model_id: str, is_local: bool = False) -> Optional[pl.LazyFrame]:
        pq_path = self.get_model_peak_parquet(model_id, is_local=is_local)
        if pq_path and pq_path.exists():
            return pl.scan_parquet(pq_path)
        return None

    def scan_model(self, model_id: str, is_local: bool = False) -> Optional[pl.LazyFrame]:
        """Return a Polars LazyFrame for the given model with predicate pushdown enabled."""
        if model_id.startswith("local:"):
            model_id = model_id[6:]
            is_local = True
        pq_path = self.get_model_parquet(model_id, is_local=is_local)
        if pq_path and pq_path.exists():
            return pl.scan_parquet(pq_path)
        return None


    def _build_cached_table(
        self,
        cache_name: str,
        source_files: List[Path],
        builder_fn: Any,
        extra_meta: Optional[Dict[str, Any]] = None,
    ) -> Optional[Path]:
        """
        Thread-safe, atomic builder for cached Parquet tables.
        Validates freshness via mtimes and sizes; builds via builder_fn if stale.
        Eliminates duplicate boilerplate across ground-truth and surveillance caches.
        """
        existing_sources = [f for f in source_files if f.exists()]
        if not existing_sources:
            return None

        pq_path = self.targets_cache_dir / f"{cache_name}.parquet"
        meta_path = self.targets_cache_dir / f"{cache_name}.meta.json"

        fp = {
            **self._compute_dir_fingerprint(existing_sources),
            "paths": [str(f) for f in existing_sources],
            **(extra_meta or {}),
        }
        if self._is_cache_fresh(pq_path, meta_path, fp):
            return pq_path

        with self._target_locks.get(cache_name):
            if self._is_cache_fresh(pq_path, meta_path, fp):
                return pq_path

            tid = f"{os.getpid()}_{threading.get_ident()}"
            tmp_pq = pq_path.with_suffix(f".tmp.{tid}.parquet")
            tmp_meta = meta_path.with_suffix(f".tmp.{tid}.json")

            try:
                df = builder_fn()
                if df is None or df.is_empty():
                    pq_path.unlink(missing_ok=True)
                    meta_path.unlink(missing_ok=True)
                    return None
                df.write_parquet(tmp_pq, compression="zstd")
                with open(tmp_meta, "w", encoding="utf-8") as f_meta:
                    json.dump(fp, f_meta)

                os.replace(tmp_pq, pq_path)
                os.replace(tmp_meta, meta_path)
                return pq_path
            except Exception as exc:
                logger.error("Failed to build %s parquet cache: %s", cache_name, exc)
                return None
            finally:
                if tmp_pq.exists():
                    tmp_pq.unlink(missing_ok=True)
                if tmp_meta.exists():
                    tmp_meta.unlink(missing_ok=True)

    def _log_missing_surveillance(self, path: Path):
        """Point at the rebuild script once per missing file (downloads never run inside a request)."""
        key = f"missing:{path.name}"
        if key not in self._missing_logged:
            self._missing_logged.add(key)
            logger.info("Surveillance file %s not found; run `python viz/rebuild_surveillance.py` to fetch it.", path)

    def _allowed_scope(self) -> Tuple[Optional[Set[str]], Optional[Set[str]]]:
        targets = self._allowed_targets_provider() if self._allowed_targets_provider else None
        locs = self._allowed_locations_provider() if self._allowed_locations_provider else None
        return (targets or None), (locs or None)

    def _read_truth_file(self, path: Path) -> Optional[pl.DataFrame]:
        try:
            if path.suffix.lower() == ".parquet":
                return pl.read_parquet(path)
            return pl.read_csv(
                path,
                schema_overrides={
                    "location": pl.String,
                    "geo_value": pl.String,
                    "geo_abbr": pl.String,
                    "horizon": pl.Int32,
                    "oracle_value": pl.Float64,
                    "observation": pl.Float64,
                    "value": pl.Float64,
                    "target_end_date": pl.String,
                    "truth_date": pl.String,
                    "date": pl.String,
                    "time_value": pl.String,
                    "time": pl.String,
                    "target": pl.String,
                    "as_of": pl.String,
                    "output_type": pl.String,
                    "output_type_id": pl.String,
                    "age_group": pl.String,
                    "Season": pl.String,
                    "season": pl.String,
                },
                null_values=NULL_VALUES,
                ignore_errors=False,
            )
        except Exception as exc:
            logger.warning("Failed reading truth file %s: %s", path, exc)
            return None

    def _peer_truth_descriptors(self) -> List[Dict[str, Any]]:
        if not self._peer_truth_provider:
            return []
        return list(self._peer_truth_provider())

    def _remote_oracle_inferred_as_of(self, hub_id: str, kind: str) -> Optional[str]:
        man = self.remote_store.load_manifest(hub_id)
        entry = (man.get("truth") or {}).get(kind) or {}
        return entry.get("as_of") or ((entry.get("last_modified") or "")[:10] or None) or entry.get("max_date")

    @staticmethod
    def _first_existing(paths: List[Path]) -> Optional[Path]:
        return next((p for p in paths if p.exists() and p.is_file()), None)

    def get_oracle_parquet(self) -> Optional[Path]:
        """
        Reconcile oracle/truth observations across ALL Hubverse `target-data/` layouts
        (`oracle-output`, `time-series`, `latest-data`, RespiCast `latest-*.csv`), compatible
        remote hubs, and sibling local hubs.
        """
        sources: List[TruthSource] = []

        repo_oracle = self._first_existing([
            self.target_data_dir / "oracle-output.parquet",
            self.target_data_dir / "oracle-output.csv",
            self.target_data_dir / "oracle.parquet",
        ])
        if repo_oracle is not None:
            sources.append(TruthSource(source_id="repo", label="repo", kind="oracle", priority=PRIORITY_REPO, path=repo_oracle))

        repo_ts = self._first_existing([
            self.target_data_dir / "time-series.parquet",
            self.target_data_dir / "time-series.csv",
            self.target_data_dir / "time_series.parquet",
        ])
        if repo_ts is not None:
            sources.append(TruthSource(source_id="repo_ts", label="repo time-series", kind="time_series", priority=PRIORITY_REPO - 1, path=repo_ts))

        repo_latest = self._first_existing([
            self.target_data_dir / "latest-data.parquet",
            self.target_data_dir / "latest-data.csv",
            self.target_data_dir / "latest.parquet",
        ])
        if repo_latest is not None:
            sources.append(TruthSource(source_id="repo_latest", label="repo latest", kind="latest", priority=PRIORITY_REPO - 2, path=repo_latest))

        if self.target_data_dir.is_dir():
            for p_respi in sorted(self.target_data_dir.glob("latest-*.csv")):
                if p_respi.name != "latest-data.csv":
                    sources.append(TruthSource(
                        source_id=f"repo_respi:{p_respi.name}",
                        label=p_respi.stem,
                        kind="latest",
                        priority=PRIORITY_REPO - 2,
                        path=p_respi,
                    ))
            if not sources:
                season_files = sorted(
                    p for p in self.target_data_dir.glob("season_*/*")
                    if p.is_file()
                    and p.suffix.lower() in (".csv", ".parquet")
                    and not p.name.endswith("-status.csv")
                    and not p.name.startswith("influenza-admissions")
                )
                if season_files and self.auxiliary_data_dir.is_dir():
                    for p_aux in sorted(self.auxiliary_data_dir.glob("concatenated_*data*")):
                        if p_aux.is_file() and p_aux.suffix.lower() in (".csv", ".parquet"):
                            sources.append(TruthSource(
                                source_id=f"repo_concat:{p_aux.name}",
                                label=p_aux.stem,
                                kind="latest",
                                priority=PRIORITY_REPO - 4,
                                path=p_aux,
                            ))
                for p_s in season_files:
                    sources.append(TruthSource(
                        source_id=f"repo_season:{p_s.parent.name}/{p_s.name}",
                        label=p_s.parent.name,
                        kind="latest",
                        priority=PRIORITY_REPO - 3,
                        path=p_s,
                    ))

        remote_ids = self.active_remote_hub_ids()
        for hub_id in remote_ids:
            for kind, prio_off in (("oracle", 0), ("time_series", -1), ("latest", -2)):
                if kind not in TRUTH_FILES:
                    continue
                p = self.remote_store.truth_path(hub_id, kind)
                if p.exists():
                    sources.append(TruthSource(
                        source_id=f"remote:{hub_id}:{kind}",
                        label=hub_id,
                        kind=kind,
                        priority=PRIORITY_REMOTE + prio_off,
                        path=p,
                        inferred_as_of=self._remote_oracle_inferred_as_of(hub_id, kind),
                    ))

        for peer in self._peer_truth_descriptors():
            p_base = Path(peer["base_dir"]) / "target-data"
            p_oracle = self._first_existing([
                p_base / "oracle-output.parquet",
                p_base / "oracle-output.csv",
                p_base / "time-series.parquet",
                p_base / "time-series.csv",
                p_base / "latest-data.parquet",
                p_base / "latest-data.csv",
            ])
            if p_oracle is not None:
                sources.append(TruthSource(
                    source_id=f"peer:{peer['hub_id']}",
                    label=peer["label"],
                    kind="oracle",
                    priority=PRIORITY_PEER,
                    path=p_oracle,
                ))

        if not sources:
            return None

        has_external = any(s.priority < PRIORITY_REPO - 5 for s in sources)
        cache_name = "oracle_hub" if has_external else "oracle"
        file_paths = [s.path for s in sources if s.path is not None]
        allowed_targets, allowed_locations = self._allowed_scope()
        pad_fips = self._pad_fips()

        def _build_reconciled() -> Optional[pl.DataFrame]:
            from viz.core.config import VizConfig
            cfg = VizConfig(self.base_dir)
            default_target = cfg.get_default_target()
            all_target_ids = cfg.get_targets()
            self.warning_registry.clear("truth")
            pairs: List[Tuple[TruthSource, pl.DataFrame]] = []
            for src in sources:
                if src.path is None:
                    continue
                df = self._read_truth_file(src.path)
                if df is not None and not df.is_empty():
                    pairs.append((src, df))
            if not pairs:
                return None
            return reconcile_truth_sources(
                pairs,
                ORACLE_KEYS,
                allowed_targets=allowed_targets,
                allowed_locations=allowed_locations,
                filter_external_only=True,
                collapse_constant_horizons=True,
                target_default=default_target,
                conflict_callback=lambda msg: self.warning_registry.add_warning("truth", msg),
                pad_single_digit_fips=pad_fips,
                target_ids=all_target_ids,
            )

        return self._build_cached_table(cache_name, file_paths, _build_reconciled)

    def _hub_truth_files(self, kind: str) -> List[Path]:
        """Truth tables copied from active compatible hubs (empty for the CLI or when no hub is synced)."""
        return self.remote_store.active_truth_files(kind, hub_ids=self.active_remote_hub_ids())

    def scan_oracle(self) -> Optional[pl.LazyFrame]:
        """Return a Polars LazyFrame for oracle truth."""
        pq_path = self.get_oracle_parquet()
        if pq_path and pq_path.exists():
            return pl.scan_parquet(pq_path)
        return None

    def get_admissions_parquet(self, target: Optional[str] = None) -> Optional[Path]:
        """Reconcile admissions surveillance across repo target-data, surveillance archives, S3 hubs, and sibling hubs."""
        from viz.core.config import VizConfig
        cfg = VizConfig(self.base_dir)
        if not target:
            target = next((t for t in cfg.get_weekly_targets() if is_flu_hosp_target(t)), None) or cfg.get_default_target()

        _, allowed_locations = self._allowed_scope()
        sources: List[TruthSource] = []
        repo_adm = self._first_existing([
            self.target_data_dir / "admissions.parquet",
            self.target_data_dir / "target-hospital-admissions.csv",
        ])
        if repo_adm is not None:
            sources.append(TruthSource(source_id="repo_adm", label="repo", kind="admissions", priority=PRIORITY_REPO, path=repo_adm))
        legacy_adm = self.auxiliary_data_dir / "surveillance" / "target-hospital-admissions.csv"
        if legacy_adm.is_file():
            sources.append(TruthSource(source_id="repo_aux_adm", label="repo archive", kind="admissions", priority=PRIORITY_REPO - 5, path=legacy_adm))

        for hub_id in self.active_remote_hub_ids():
            p = self.remote_store.truth_path(hub_id, "admissions")
            if p.exists():
                sources.append(TruthSource(
                    source_id=f"remote:{hub_id}",
                    label=hub_id,
                    kind="admissions",
                    priority=PRIORITY_REMOTE,
                    path=p,
                    inferred_as_of=self._remote_oracle_inferred_as_of(hub_id, "admissions"),
                ))

        for peer in self._peer_truth_descriptors():
            p_adm = Path(peer["base_dir"]) / "target-data" / "target-hospital-admissions.csv"
            if p_adm.is_file():
                sources.append(TruthSource(
                    source_id=f"peer:{peer['hub_id']}",
                    label=peer["label"],
                    kind="admissions",
                    priority=PRIORITY_PEER,
                    path=p_adm,
                ))

        bundled_adm = self.surveillance_dir / "target-hospital-admissions.csv"
        if is_flu_hosp_target(target) and (not allowed_locations or "US" in allowed_locations) and bundled_adm.is_file():
            sources.append(TruthSource(source_id="bundled_surv", label="surveillance", kind="admissions", priority=PRIORITY_ARCHIVE, path=bundled_adm))

        # Graceful fallback when no admissions CSV exists anywhere: synthesize from repo truth tables
        if not sources:
            repo_oracle = self._first_existing([
                self.target_data_dir / "oracle-output.parquet",
                self.target_data_dir / "oracle-output.csv",
                self.target_data_dir / "oracle.parquet",
                self.target_data_dir / "latest-data.parquet",
                self.target_data_dir / "latest-data.csv",
                self.target_data_dir / "latest.parquet",
                self.target_data_dir / "time-series.parquet",
                self.target_data_dir / "time-series.csv",
                self.target_data_dir / "time_series.parquet",
            ])
            if repo_oracle is not None:
                sources.append(TruthSource(source_id="repo_oracle_adm", label="repo oracle", kind="oracle", priority=PRIORITY_REPO, path=repo_oracle))

        if not sources:
            return None

        has_external = any(s.priority in (PRIORITY_REMOTE, PRIORITY_PEER) for s in sources)
        base_name = "admissions_hub" if has_external else "admissions"
        default_flu_hosp = next((t for t in cfg.get_weekly_targets() if is_flu_hosp_target(t)), None) or "wk inc flu hosp"
        cache_name = base_name if target == default_flu_hosp else f"{base_name}_{hashlib.sha1(target.encode('utf-8')).hexdigest()[:8]}"
        file_paths = [s.path for s in sources if s.path is not None]

        def _build_merged_admissions() -> Optional[pl.DataFrame]:
            pairs: List[Tuple[TruthSource, pl.DataFrame]] = []
            for src in sources:
                if src.path is None:
                    continue
                df = self._read_truth_file(src.path)
                if df is None or df.is_empty():
                    continue
                if "target" in df.columns:
                    df = df.filter(pl.col("target") == target)
                else:
                    df = df.with_columns(pl.lit(target).alias("target"))
                if "output_type" in df.columns:
                    df = df.filter(pl.col("output_type").is_null() | (pl.col("output_type") != "pmf"))
                if not df.is_empty():
                    pairs.append((src, df))
            if not pairs:
                return None
            out = reconcile_truth_sources(
                pairs,
                ADMISSIONS_KEYS,
                allowed_locations=allowed_locations,
                filter_external_only=True,
                target_default=target,
                pad_single_digit_fips=self._pad_fips(),
            )
            keep_cols = [c for c in ("target", "location", "target_end_date", "horizon", "oracle_value", "as_of") if c in out.columns]
            return out.select(keep_cols)

        return self._build_cached_table(cache_name, file_paths, _build_merged_admissions, extra_meta={"target": target})

    def get_initial_admissions_parquet(self, target: Optional[str] = None) -> Optional[Path]:
        """Get or create cached Parquet for initial-hospital-admissions.csv atomically."""
        if not target:
            from viz.core.config import VizConfig
            target = VizConfig(self.base_dir).get_default_target()

        init_csv = self.surveillance_dir / "initial-hospital-admissions.csv"
        if not init_csv.exists():
            legacy_csv = self.auxiliary_data_dir / "surveillance" / "initial-hospital-admissions.csv"
            if legacy_csv.exists():
                init_csv = legacy_csv

        if init_csv.exists():
            def _build_from_init():
                df = pl.read_csv(
                    init_csv,
                    schema_overrides={
                        "location": pl.String,
                        "date": pl.String,
                        "value": pl.Float64,
                    },
                    null_values=NULL_VALUES,
                    ignore_errors=False,
                )
                cols = [
                    pl.col("location").cast(pl.String),
                    pl.col("date").cast(pl.String).alias("target_end_date"),
                    pl.col("value").cast(pl.Float64).alias("oracle_value"),
                    pl.lit(target).alias("target"),
                    pl.lit(0).cast(pl.Int32).alias("horizon"),
                ]
                if "initial_report_date" in df.columns:
                    cols.append(pl.col("initial_report_date").cast(pl.String))
                select_cols = ["target", "location", "target_end_date", "horizon", "oracle_value"]
                if "initial_report_date" in df.columns:
                    select_cols.append("initial_report_date")
                return (
                    df.with_columns(cols)
                    .select(select_cols)
                    .drop_nulls(subset=["oracle_value", "target_end_date", "location"])
                )

            return self._build_cached_table("initial_admissions", [init_csv], _build_from_init)

        return None

    def scan_initial_admissions(self) -> Optional[pl.LazyFrame]:
        """Return a Polars LazyFrame for initial (unrevised) admissions surveillance data."""
        pq_path = self.get_initial_admissions_parquet()
        if pq_path and pq_path.exists():
            return pl.scan_parquet(pq_path)
        return None

    def _archive_snapshot_sources(self, base_dir: Path, source_prefix: str, label: str, priority: int, default_target: str) -> List[TruthSource]:
        archive_dir = base_dir / "auxiliary-data" / "target-data-archive"
        if not archive_dir.is_dir():
            return []
        out: List[TruthSource] = []
        try:
            for p in sorted(archive_dir.glob("*.csv")):
                m = SNAPSHOT_DATE_RE.search(p.name)
                if m:
                    out.append(TruthSource(
                        source_id=f"{source_prefix}_arch:{p.name}",
                        label=label,
                        kind="as_of",
                        priority=priority,
                        path=p,
                        inferred_as_of=m.group(1),
                    ))
        except OSError:
            pass
        return out

    def get_as_of_admissions_parquet(self) -> Optional[Path]:
        """Reconcile point-in-time `as_of` surveillance & oracle vintages across all compatible sources."""
        from viz.core.config import VizConfig
        default_target = VizConfig(self.base_dir).get_default_target()
        allowed_targets, allowed_locations = self._allowed_scope()
        sources: List[TruthSource] = []

        as_of_file = self.surveillance_dir / "as-of-hospital-admissions.parquet"
        if any(is_flu_hosp_target(t) for t in (allowed_targets or {default_target})) and as_of_file.is_file():
            sources.append(TruthSource(source_id="bundled_asof", label="surveillance", kind="as_of", priority=PRIORITY_ARCHIVE, path=as_of_file))

        repo_asof = self.target_data_dir / "as_of_snapshots.parquet"
        if repo_asof.is_file():
            sources.append(TruthSource(source_id="repo_asof_vint", label="repo snapshots", kind="as_of", priority=PRIORITY_REPO, path=repo_asof))

        repo_ts = self._first_existing([
            self.target_data_dir / "time-series.parquet",
            self.target_data_dir / "time-series.csv",
            self.target_data_dir / "time_series.parquet",
        ])
        if repo_ts is not None:
            sources.append(TruthSource(source_id="repo_ts_vint", label="repo time-series", kind="time_series", priority=PRIORITY_REPO - 1, path=repo_ts))

        sources.extend(self._archive_snapshot_sources(self.base_dir, "repo", "repo archive", PRIORITY_REPO, default_target))
        repo_oracle = self._first_existing([
            self.target_data_dir / "oracle-output.parquet",
            self.target_data_dir / "oracle-output.csv",
            self.target_data_dir / "oracle.parquet",
        ])
        if repo_oracle is not None:
            sources.append(TruthSource(source_id="repo_oracle_vint", label="repo", kind="oracle", priority=PRIORITY_REPO - 2, path=repo_oracle))

        for hub_id in self.active_remote_hub_ids():
            p_asof = self.remote_store.truth_path(hub_id, "as_of")
            if p_asof.exists():
                sources.append(TruthSource(source_id=f"remote_asof:{hub_id}", label=hub_id, kind="as_of", priority=PRIORITY_REMOTE, path=p_asof))
            p_ts = self.remote_store.truth_path(hub_id, "time_series") if "time_series" in TRUTH_FILES else None
            if p_ts is not None and p_ts.exists():
                sources.append(TruthSource(source_id=f"remote_ts:{hub_id}", label=hub_id, kind="time_series", priority=PRIORITY_REMOTE - 1, path=p_ts))
            p_ora = self.remote_store.truth_path(hub_id, "oracle")
            if p_ora.exists():
                sources.append(TruthSource(
                    source_id=f"remote_ora:{hub_id}",
                    label=hub_id,
                    kind="oracle",
                    priority=PRIORITY_REMOTE - 2,
                    path=p_ora,
                    inferred_as_of=self._remote_oracle_inferred_as_of(hub_id, "oracle"),
                ))

        for peer in self._peer_truth_descriptors():
            p_dir = Path(peer["base_dir"])
            sources.extend(self._archive_snapshot_sources(p_dir, f"peer:{peer['hub_id']}", peer["label"], PRIORITY_PEER, default_target))
            p_ora = self._first_existing([
                p_dir / "target-data" / "oracle-output.parquet",
                p_dir / "target-data" / "oracle-output.csv",
            ])
            if p_ora is not None:
                sources.append(TruthSource(
                    source_id=f"peer_ora:{peer['hub_id']}",
                    label=peer["label"],
                    kind="oracle",
                    priority=PRIORITY_PEER - 1,
                    path=p_ora,
                ))

        if not sources:
            return None

        has_external = any(s.priority <= PRIORITY_REMOTE and s.source_id != "bundled_asof" for s in sources)
        cache_name = "as_of_admissions_hub" if has_external else "as_of_admissions"
        file_paths = [s.path for s in sources if s.path is not None]

        def _build_reconciled_vintages() -> Optional[pl.DataFrame]:
            pairs: List[Tuple[TruthSource, pl.DataFrame]] = []
            for src in sources:
                if src.path is None:
                    continue
                df = self._read_truth_file(src.path)
                if df is None or df.is_empty():
                    continue
                if "target" not in df.columns and src.kind == "as_of":
                    df = df.with_columns(pl.lit(default_target).alias("target"))
                pairs.append((src, df))
            if not pairs:
                return None
            return reconcile_vintages(
                pairs,
                allowed_targets=allowed_targets,
                allowed_locations=allowed_locations,
                filter_external_only=True,
                pad_single_digit_fips=self._pad_fips(),
            )

        return self._build_cached_table(cache_name, file_paths, _build_reconciled_vintages)

    def scan_as_of_admissions(self) -> Optional[pl.LazyFrame]:
        """Return a Polars LazyFrame for point-in-time as-of admissions surveillance data."""
        pq_path = self.get_as_of_admissions_parquet()
        if pq_path and pq_path.exists():
            return pl.scan_parquet(pq_path)
        return None

    def scan_admissions(self, target: Optional[str] = None) -> Optional[pl.LazyFrame]:
        """Return a Polars LazyFrame for admissions surveillance truth."""
        pq_path = self.get_admissions_parquet(target=target)
        if pq_path and pq_path.exists():
            return pl.scan_parquet(pq_path)
        return None

    def get_ilinet_parquet(self) -> Optional[Path]:
        """Get or create cached Parquet for ilinet.csv atomically."""
        ili_csv = self.surveillance_dir / "ilinet.csv"
        if not ili_csv.exists():
            ili_csv = self.seed_dir / "ilinet.csv"
        if not ili_csv.exists():
            legacy_csv = self.auxiliary_data_dir / "surveillance" / "ilinet.csv"
            if legacy_csv.exists():
                ili_csv = legacy_csv
            else:
                self._log_missing_surveillance(self.surveillance_dir / "ilinet.csv")
                return None

        def _build_ilinet():
            return pl.read_csv(
                ili_csv,
                schema_overrides={
                    "location": pl.String,
                    "wk_end_date": pl.String,
                    "inc": pl.Float64,
                },
                null_values=NULL_VALUES,
                ignore_errors=False,
            )

        return self._build_cached_table("ilinet", [ili_csv], _build_ilinet)

    def scan_ilinet(self) -> Optional[pl.LazyFrame]:
        """Return a Polars LazyFrame for ILINet outpatient surveillance."""
        pq_path = self.get_ilinet_parquet()
        if pq_path and pq_path.exists():
            return pl.scan_parquet(pq_path)
        return None

    def get_flusurvnet_parquet(self) -> Optional[Path]:
        """Get or create cached Parquet for flusurvnet.csv atomically."""
        fsn_csv = self.surveillance_dir / "flusurvnet.csv"
        if not fsn_csv.exists():
            fsn_csv = self.seed_dir / "flusurvnet.csv"
        if not fsn_csv.exists():
            legacy_csv = self.auxiliary_data_dir / "surveillance" / "flusurvnet.csv"
            if legacy_csv.exists():
                fsn_csv = legacy_csv
            else:
                self._log_missing_surveillance(self.surveillance_dir / "flusurvnet.csv")
                return None

        def _build_flusurvnet():
            return pl.read_csv(
                fsn_csv,
                schema_overrides={
                    "location": pl.String,
                    "wk_end_date": pl.String,
                    "inc": pl.Float64,
                },
                null_values=NULL_VALUES,
                ignore_errors=False,
            )

        return self._build_cached_table("flusurvnet", [fsn_csv], _build_flusurvnet)

    def scan_flusurvnet(self) -> Optional[pl.LazyFrame]:
        """Return a Polars LazyFrame for FluSurv-NET rate surveillance."""
        pq_path = self.get_flusurvnet_parquet()
        if pq_path and pq_path.exists():
            return pl.scan_parquet(pq_path)
        return None

    def warmup_cache(self, model_ids: Optional[List[str]] = None, include_remote_models: bool = True) -> int:
        """
        Pre-cache models and target files in parallel batch.
        Can be called on startup or on demand. Returns count of models cached.
        """
        self.get_oracle_parquet()
        self.get_admissions_parquet()
        self.get_initial_admissions_parquet()
        self.get_as_of_admissions_parquet()
        self.get_ilinet_parquet()
        self.get_flusurvnet_parquet()

        tasks: List[Tuple[str, bool]] = []
        if self.model_output_dir.exists():
            for p in self.model_output_dir.iterdir():
                if p.is_dir() and not p.name.startswith("."):
                    if model_ids is None or p.name in model_ids:
                        tasks.append((p.name, False))
        if self.local_output_dir.exists():
            for p in self.local_output_dir.iterdir():
                if p.is_dir() and not p.name.startswith(".") and p.name != "synthetic":
                    if model_ids is None or p.name in model_ids:
                        tasks.append((p.name, True))

        if include_remote_models and self.include_remote:
            for hub_id in self.active_remote_hub_ids():
                mo_dir = self.remote_store.hub_dir(hub_id) / "model-output"
                if not mo_dir.is_dir():
                    continue
                for p in mo_dir.iterdir():
                    key = f"{hub_id}:{p.name}"
                    if p.is_dir() and (model_ids is None or key in model_ids):
                        tasks.append((key, False))

        results = ordered_map(lambda item: self.get_model_parquet(item[0], is_local=item[1]), tasks)
        return sum(1 for p in results if p is not None)

    def refresh_local_cache(self) -> Dict[str, int]:
        """
        Fast incremental refresh for truth/surveillance tables and modified local models.
        Avoids blocking on untouched models or remote S3 mirrors (which sync manages).
        """
        self.get_oracle_parquet()
        self.get_admissions_parquet()
        self.get_initial_admissions_parquet()
        self.get_as_of_admissions_parquet()
        self.get_ilinet_parquet()
        self.get_flusurvnet_parquet()

        to_rebuild: List[Tuple[str, bool]] = []
        total_dirs = 0
        for root, is_loc, dest_dir in (
            (self.model_output_dir, False, self.models_cache_dir),
            (self.local_output_dir, True, self.local_models_cache_dir),
        ):
            if not root.is_dir():
                continue
            for p in root.iterdir():
                if not p.is_dir() or p.name.startswith(".") or (is_loc and p.name == "synthetic"):
                    continue
                total_dirs += 1
                pq_path = dest_dir / f"{p.name}.parquet"
                meta_path = dest_dir / f"{p.name}.meta.json"
                # Rebuild local-output runs immediately, plus any already-cached model whose files changed
                if is_loc or pq_path.exists():
                    source_files, fp = self._scan_source_files(p)
                    if source_files and not self._is_cache_fresh(pq_path, meta_path, fp):
                        to_rebuild.append((p.name, is_loc))

        rebuilt = 0
        if to_rebuild:
            res = ordered_map(lambda item: self.get_model_parquet(item[0], is_local=item[1]), to_rebuild)
            rebuilt = sum(1 for p in res if p is not None)
        return {"models_total": total_dirs, "rebuilt": rebuilt}

    def clear_cache(self, model_id: Optional[str] = None):
        """Remove cached parquet and metadata files to force regeneration."""
        with self._fresh_lock:
            self._fresh_pq_cache.clear()
        suffixes = (".parquet", ".meta.json", ".peak.parquet", ".peak.meta.json", ".samples.parquet", ".samples.meta.json", ".pmf.parquet", ".pmf.meta.json")
        if model_id:
            merged = self.merged_key(model_id)
            if merged is not None:
                hub_id, base_name = merged
                for suffix in suffixes:
                    (self.models_cache_dir / f"{base_name}.merged.{hub_id}{suffix}").unlink(missing_ok=True)
                self.clear_cache(base_name)
                self.clear_cache(f"{hub_id}:{base_name}")
                return
            hub = self.hub_key(model_id)
            if hub is not None:
                d = self.hub_models_cache_dir / hub[0]
                for suffix in suffixes:
                    (d / f"{hub[1]}{suffix}").unlink(missing_ok=True)
                return
            for d in [self.models_cache_dir, self.local_models_cache_dir]:
                for suffix in suffixes:
                    (d / f"{model_id}{suffix}").unlink(missing_ok=True)
        else:
            # Consolidated tables only; synced hub copies under .cache/remote are kept (removed via the UI)
            hub_dirs = [p for p in self.hub_models_cache_dir.iterdir() if p.is_dir()] if self.hub_models_cache_dir.exists() else []
            for d in [self.models_cache_dir, self.local_models_cache_dir, self.targets_cache_dir, self.cache_dir / "scores"] + hub_dirs:
                if d.exists():
                    for f in d.iterdir():
                        if f.is_file():
                            f.unlink(missing_ok=True)
