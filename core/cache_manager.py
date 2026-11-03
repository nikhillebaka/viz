"""
High-performance Parquet cache manager for FluSight Sandbox models and ground truth.
Enables instant Polars scanning and query execution on Apple Silicon and modern CPUs.
Auto-invalidates when underlying CSV files are added, modified, or deleted.
Fully thread-safe with atomic file writes to prevent race conditions.
"""

from collections import defaultdict
import json
import logging
import os
from pathlib import Path
import threading
from typing import Dict, List, Optional, Tuple, Any

import polars as pl

from viz.remote.store import RemoteStore

logger = logging.getLogger("viz.cache")

NULL_VALUES = ["", "NA", "null", "NaN", "None", "NULL"]
ORACLE_KEYS = ["target", "target_end_date", "location", "horizon", "output_type", "output_type_id"]
ADMISSIONS_KEYS = ["target", "location", "target_end_date", "horizon"]


def filter_quantile_rows(df: pl.DataFrame) -> pl.DataFrame:
    """Keep quantile rows only and cast their output_type_id levels to rounded floats."""
    if "output_type" in df.columns:
        df = df.filter(pl.col("output_type") == "quantile")
    return df.with_columns(pl.col("output_type_id").cast(pl.Float64).round(3))


def merge_truth_frames(frames: List[pl.DataFrame], keys: List[str]) -> pl.DataFrame:
    """
    Union truth tables so every observation comes from the most recent source and older sources only fill
    gaps. Frames are ordered oldest to newest; when an `as_of` column exists the newest vintage wins per key
    regardless of frame order. The result has exactly one row per key, so series never double up or break.
    """
    frames = [f for f in frames if f is not None and not f.is_empty()]
    if not frames:
        return pl.DataFrame()
    if len(frames) == 1:
        return frames[0]
    tagged = [f.with_columns(pl.lit(i).alias("_src")) for i, f in enumerate(frames)]
    df = pl.concat(tagged, how="diagonal_relaxed")
    order = ["_src"]
    if "as_of" in df.columns:
        df = df.with_columns(pl.col("as_of").cast(pl.String).fill_null(""))
        order = ["as_of", "_src"]
    keys = [k for k in keys if k in df.columns]
    return df.sort(order).unique(subset=keys, keep="last", maintain_order=True).drop("_src")


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

    def __init__(self, base_dir: Path, include_remote: bool = True):
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

        self.surveillance_dir = self.viz_dir / "data" / "surveillance"
        self.cache_dir = self.viz_dir / ".cache"

        self.models_cache_dir = self.cache_dir / "models"
        self.local_models_cache_dir = self.cache_dir / "local_models"
        self.hub_models_cache_dir = self.cache_dir / "hub_models"
        self.targets_cache_dir = self.cache_dir / "targets"
        self.remote_store = RemoteStore(self.cache_dir)

        self._model_locks = LockRegistry()
        self._target_locks = LockRegistry()
        self.warning_registry = WarningRegistry()
        self._missing_logged: set = set()

        self._ensure_dirs()

    def get_validation_warnings(self, sources: Optional[List[str]] = None) -> List[str]:
        """Return captured validation warnings for specified models or all models."""
        return self.warning_registry.get_warnings(sources)

    def _ensure_dirs(self):
        self.models_cache_dir.mkdir(parents=True, exist_ok=True)
        self.local_models_cache_dir.mkdir(parents=True, exist_ok=True)
        self.hub_models_cache_dir.mkdir(parents=True, exist_ok=True)
        self.targets_cache_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _compute_dir_fingerprint(csv_files: List[Path]) -> Dict[str, Any]:
        if not csv_files:
            return {"count": 0, "max_mtime": 0.0, "total_size": 0}
        max_mtime = max(f.stat().st_mtime for f in csv_files)
        total_size = sum(f.stat().st_size for f in csv_files)
        return {
            "count": len(csv_files),
            "max_mtime": max_mtime,
            "total_size": total_size,
        }

    def _is_cache_fresh(self, pq_path: Path, meta_path: Path, fingerprint: Dict[str, Any]) -> bool:
        if not pq_path.exists() or not meta_path.exists():
            return False
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                saved = json.load(f)
            return (
                saved.get("count") == fingerprint["count"]
                and abs(saved.get("max_mtime", 0.0) - fingerprint["max_mtime"]) < 1e-3
                and saved.get("total_size") == fingerprint["total_size"]
            )
        except Exception:
            return False

    def hub_key(self, model_id: str) -> Optional[Tuple[str, str]]:
        """Split a hub model key like 'flusight:UMass-flusion' into (hub_id, model). None for other models."""
        if not self.include_remote or ":" not in model_id:
            return None
        hub_id, _, name = model_id.partition(":")
        if hub_id in ("local", "synthetic") or not name or "/" in name or "\\" in name or name.startswith("."):
            return None
        if hub_id not in self.remote_store.active_hub_ids():
            return None
        return hub_id, name

    def get_model_parquet(self, model_id: str, is_local: bool = False) -> Optional[Path]:
        """
        Get path to the cached Parquet file for a model.
        Automatically converts and builds cache if stale or missing.
        Thread-safe: uses per-model locking and atomic file writes.
        """
        hub = self.hub_key(model_id)
        if hub is not None:
            # Hub models: normalized copies under .cache/remote/<hub>/model-output, consolidated per model
            source_dir = self.remote_store.model_dir(*hub)
            if not source_dir.is_dir():
                return None
            dest_dir = self.hub_models_cache_dir / hub[0]
            dest_dir.mkdir(parents=True, exist_ok=True)
            file_stem = hub[1]
        else:
            source_dir = (self.local_output_dir if is_local else self.model_output_dir) / model_id
            if not source_dir.exists() or not source_dir.is_dir():
                # If not found in preferred dir, check the other dir as fallback
                alt_dir = (self.model_output_dir if is_local else self.local_output_dir) / model_id
                if alt_dir.exists() and alt_dir.is_dir():
                    source_dir = alt_dir
                    is_local = not is_local
                else:
                    return None
            dest_dir = self.local_models_cache_dir if is_local else self.models_cache_dir
            file_stem = model_id

        pq_path = dest_dir / f"{file_stem}.parquet"
        meta_path = dest_dir / f"{file_stem}.meta.json"

        csv_files = sorted(source_dir.glob("*.csv"))
        parquet_files = sorted(source_dir.glob("*.parquet"))
        source_files = csv_files + parquet_files
        if not source_files:
            return None

        fp = self._compute_dir_fingerprint(source_files)

        # Quick check before lock
        if self._is_cache_fresh(pq_path, meta_path, fp):
            return pq_path

        lock = self._model_locks.get(model_id)
        with lock:
            # Double-check inside mutex
            if self._is_cache_fresh(pq_path, meta_path, fp):
                return pq_path

            dfs = []
            for f in source_files:
                d_str = f.name[:10]
                try:
                    if f.suffix == ".parquet":
                        df = pl.read_parquet(f)
                    else:
                        df = pl.read_csv(
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
                            },
                            null_values=NULL_VALUES,
                            ignore_errors=False,
                        )
                    if df.is_empty():
                        self.warning_registry.add_warning(
                            model_id, f"Forecast file '{f.name}' for model '{model_id}' contains zero data rows."
                        )
                        continue

                    # Validate required columns
                    missing_req = [c for c in ["location", "output_type_id", "value"] if c not in df.columns]
                    if missing_req:
                        self.warning_registry.add_warning(
                            model_id,
                            f"Forecast file '{f.name}' for model '{model_id}' is missing required columns: {missing_req}",
                        )
                        continue

                    if "reference_date" not in df.columns:
                        df = df.with_columns(pl.lit(d_str).alias("reference_date"))
                    else:
                        df = df.with_columns(pl.col("reference_date").cast(pl.String))

                    if "target_end_date" in df.columns:
                        df = df.with_columns(pl.col("target_end_date").cast(pl.String))

                    if "location" in df.columns:
                        df = df.with_columns(pl.col("location").cast(pl.String))

                    # Only quantile forecasts are scored or plotted; other output types (e.g. pmf) carry
                    # categorical output_type_ids, so drop them before casting quantile levels to floats.
                    # Season peak targets (no horizon or target end date) live in the separate peak table.
                    if "target" in df.columns:
                        df = df.filter(~pl.col("target").cast(pl.String).str.to_lowercase().str.starts_with("peak "))
                    df = filter_quantile_rows(df)
                    if df.is_empty():
                        continue

                    # Check for duplicate quantiles on identical tasks
                    check_cols = [c for c in ["target", "location", "horizon", "output_type_id"] if c in df.columns]
                    if df.select(check_cols).is_duplicated().any():
                        self.warning_registry.add_warning(
                            model_id,
                            f"Forecast file '{f.name}' for model '{model_id}' contains duplicate quantile values.",
                        )

                    dfs.append(df)
                except Exception as exc:
                    msg = f"Failed to parse forecast file '{f.name}' for model '{model_id}': {exc}"
                    logger.warning(msg)
                    self.warning_registry.add_warning(model_id, msg)
                    continue

            if not dfs:
                return None

            # Atomic write to temporary file then rename
            tid = f"{os.getpid()}_{threading.get_ident()}"
            tmp_pq = pq_path.with_suffix(f".tmp.{tid}.parquet")
            tmp_meta = meta_path.with_suffix(f".tmp.{tid}.json")

            try:
                combined = pl.concat(dfs, how="diagonal")
                combined.write_parquet(tmp_pq, compression="zstd")
                with open(tmp_meta, "w", encoding="utf-8") as f_meta:
                    json.dump(fp, f_meta)

                os.replace(tmp_pq, pq_path)
                os.replace(tmp_meta, meta_path)
                return pq_path
            except Exception as exc:
                logger.error("Failed to write parquet cache for model %s: %s", model_id, exc)
                return None
            finally:
                if tmp_pq.exists():
                    tmp_pq.unlink(missing_ok=True)
                if tmp_meta.exists():
                    tmp_meta.unlink(missing_ok=True)

    def get_model_peak_parquet(self, model_id: str, is_local: bool = False) -> Optional[Path]:
        """
        Season peak rows (peak size quantiles and peak week pmfs) for a model, consolidated into
        `<model>.peak.parquet` next to its weekly table. Built on first use from the same source files and
        refreshed by the same fingerprint, so the weekly tables and their caches are never touched.
        Returns None when the model submitted no peak forecasts.
        """
        hub = self.hub_key(model_id)
        if hub is not None:
            source_dir = self.remote_store.peak_dir(*hub)
            dest_dir = self.hub_models_cache_dir / hub[0]
            file_stem = hub[1]
        else:
            if model_id.startswith("local:"):
                model_id, is_local = model_id[6:], True
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

        source_files = sorted(source_dir.glob("*.csv")) + sorted(source_dir.glob("*.parquet"))
        if not source_files:
            return None
        fp = self._compute_dir_fingerprint(source_files)
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
            from viz.core.peaks import extract_peak_rows
            frames = []
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
                    peak = extract_peak_rows(df, reference_date=f.name[:10])
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

        fp = self._compute_dir_fingerprint(existing_sources)
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

    def get_oracle_parquet(self) -> Optional[Path]:
        """Get or create cached Parquet file for target-data/oracle-output (.parquet or .csv) atomically."""
        oracle_pq = self.target_data_dir / "oracle-output.parquet"
        oracle_csv = self.target_data_dir / "oracle-output.csv"
        oracle_source = oracle_pq if oracle_pq.exists() else (oracle_csv if oracle_csv.exists() else None)
        hub_files = self._hub_truth_files("oracle")
        if not oracle_source and not hub_files:
            return None

        def _build_oracle():
            if oracle_source is None:
                return None
            if oracle_source.suffix.lower() == ".parquet":
                df = pl.read_parquet(oracle_source)
            else:
                df = pl.read_csv(
                    oracle_source,
                    schema_overrides={
                        "location": pl.String,
                        "horizon": pl.Int32,
                        "oracle_value": pl.Float64,
                        "target_end_date": pl.String,
                        "target": pl.String,
                        "as_of": pl.String,
                    },
                    null_values=NULL_VALUES,
                    ignore_errors=False,
                )
            cols = [
                pl.col("location").cast(pl.String),
                pl.col("target_end_date").cast(pl.String),
                pl.col("oracle_value").cast(pl.Float64),
            ]
            if "horizon" in df.columns:
                cols.append(pl.col("horizon").fill_null(0).cast(pl.Int32))
            else:
                cols.append(pl.lit(0).cast(pl.Int32).alias("horizon"))
            if "target" in df.columns:
                cols.append(pl.col("target").cast(pl.String))
            return df.with_columns(cols)

        if not hub_files:
            return self._build_cached_table("oracle", [oracle_source], _build_oracle)

        def _build_merged_oracle():
            # Newest as_of vintage wins per observation; the repository oracle fills anything the hub lacks
            frames = [_build_oracle()] + [pl.read_parquet(p) for p in hub_files]
            return merge_truth_frames(frames, ORACLE_KEYS)

        sources = ([oracle_source] if oracle_source else []) + hub_files
        return self._build_cached_table("oracle_hub", sources, _build_merged_oracle)

    def _hub_truth_files(self, kind: str) -> List[Path]:
        """Truth tables copied from active hubs (empty for the CLI or when no hub is synced)."""
        if not self.include_remote:
            return []
        return self.remote_store.active_truth_files(kind)

    @staticmethod
    def _order_by_recency(frames: List[pl.DataFrame], date_col: str = "target_end_date") -> List[pl.DataFrame]:
        """Order truth frames oldest to newest by their latest observation, so the freshest source wins."""
        frames = [f for f in frames if f is not None and not f.is_empty()]
        return sorted(frames, key=lambda f: str(f.get_column(date_col).max() or ""))

    def scan_oracle(self) -> Optional[pl.LazyFrame]:
        """Return a Polars LazyFrame for oracle truth."""
        pq_path = self.get_oracle_parquet()
        if pq_path and pq_path.exists():
            return pl.scan_parquet(pq_path)
        return None

    def get_admissions_parquet(self, target: Optional[str] = None) -> Optional[Path]:
        """Get or create cached Parquet for target-hospital-admissions.csv atomically."""
        if not target:
            from viz.core.config import VizConfig
            target = VizConfig(self.base_dir).get_default_target()

        # 1. Prefer self-contained viz/data/surveillance/
        adm_csv = self.surveillance_dir / "target-hospital-admissions.csv"
        if not adm_csv.exists():
            # 2. Check legacy repo root auxiliary-data/surveillance/
            legacy_csv = self.auxiliary_data_dir / "surveillance" / "target-hospital-admissions.csv"
            if legacy_csv.exists():
                adm_csv = legacy_csv

        if adm_csv.exists():
            def _build_from_adm():
                df = pl.read_csv(
                    adm_csv,
                    schema_overrides={
                        "location": pl.String,
                        "date": pl.String,
                        "value": pl.Float64,
                    },
                    null_values=NULL_VALUES,
                    ignore_errors=False,
                )
                return (
                    df.with_columns([
                        pl.col("location").cast(pl.String),
                        pl.col("date").cast(pl.String).alias("target_end_date"),
                        pl.col("value").cast(pl.Float64).alias("oracle_value"),
                        pl.lit(target).alias("target"),
                        pl.lit(0).cast(pl.Int32).alias("horizon"),
                    ])
                    .select(["target", "location", "target_end_date", "horizon", "oracle_value"])
                    .drop_nulls(subset=["oracle_value", "target_end_date", "location"])
                )

            return self._admissions_with_hubs("admissions", [adm_csv], _build_from_adm, target)

        # 3. Graceful fallback: synthesize admissions series from target-data/oracle-output (.parquet or .csv)
        oracle_pq = self.target_data_dir / "oracle-output.parquet"
        oracle_csv = self.target_data_dir / "oracle-output.csv"
        oracle_source = oracle_pq if oracle_pq.exists() else (oracle_csv if oracle_csv.exists() else None)
        if oracle_source:
            def _build_from_oracle():
                if oracle_source.suffix.lower() == ".parquet":
                    df = pl.read_parquet(oracle_source)
                else:
                    df = pl.read_csv(
                        oracle_source,
                        schema_overrides={
                            "location": pl.String,
                            "target": pl.String,
                            "target_end_date": pl.String,
                            "oracle_value": pl.Float64,
                        },
                        null_values=NULL_VALUES,
                        ignore_errors=False,
                    )
                cols = [
                    pl.col("location").cast(pl.String),
                    pl.col("target_end_date").cast(pl.String),
                    pl.col("oracle_value").cast(pl.Float64),
                ]
                if "horizon" in df.columns:
                    cols.append(pl.col("horizon").fill_null(0).cast(pl.Int32))
                else:
                    cols.append(pl.lit(0).cast(pl.Int32).alias("horizon"))

                filtered = df.filter(pl.col("target") == target).with_columns(cols)
                return (
                    filtered.select(["target", "location", "target_end_date", "horizon", "oracle_value"])
                    .drop_nulls(subset=["oracle_value", "target_end_date", "location"])
                )

            return self._admissions_with_hubs("admissions", [oracle_source], _build_from_oracle, target)

        return self._admissions_with_hubs("admissions", [], lambda: None, target)

    def _admissions_with_hubs(self, cache_name: str, sources: List[Path], local_builder: Any, target: str) -> Optional[Path]:
        """Build the admissions series, overlaying any hub copies so the freshest source wins per week."""
        hub_files = self._hub_truth_files("admissions")
        if not hub_files:
            return self._build_cached_table(cache_name, sources, local_builder) if sources else None

        def _build_merged():
            hub_frames = [pl.read_parquet(p).with_columns(pl.lit(target).alias("target")) for p in hub_files]
            frames = self._order_by_recency([local_builder() if sources else None] + hub_frames)
            return merge_truth_frames(frames, ADMISSIONS_KEYS)

        return self._build_cached_table(f"{cache_name}_hub", sources + hub_files, _build_merged)

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

    def get_as_of_admissions_parquet(self) -> Optional[Path]:
        """Get or create cached Parquet for point-in-time as-of surveillance vintages."""
        as_of_file = self.surveillance_dir / "as-of-hospital-admissions.parquet"
        if not as_of_file.exists():
            self._log_missing_surveillance(as_of_file)
            return None

        def _build_from_as_of():
            return pl.read_parquet(as_of_file)

        hub_files = self._hub_truth_files("as_of")
        if not hub_files:
            return self._build_cached_table("as_of_admissions", [as_of_file], _build_from_as_of)

        def _build_merged_as_of():
            # Hub snapshots only add vintages newer than the bundled file; each (as_of, week) appears once
            local = _build_from_as_of()
            frames = [local] + [pl.read_parquet(p).select([c for c in local.columns if c in pl.read_parquet_schema(p)])
                                for p in hub_files]
            return merge_truth_frames(frames, ["as_of"] + ADMISSIONS_KEYS)

        return self._build_cached_table("as_of_admissions_hub", [as_of_file] + hub_files, _build_merged_as_of)

    def scan_as_of_admissions(self) -> Optional[pl.LazyFrame]:
        """Return a Polars LazyFrame for point-in-time as-of admissions surveillance data."""
        pq_path = self.get_as_of_admissions_parquet()
        if pq_path and pq_path.exists():
            return pl.scan_parquet(pq_path)
        return None

    def scan_admissions(self) -> Optional[pl.LazyFrame]:
        """Return a Polars LazyFrame for admissions surveillance truth."""
        pq_path = self.get_admissions_parquet()
        if pq_path and pq_path.exists():
            return pl.scan_parquet(pq_path)
        return None

    def get_ilinet_parquet(self) -> Optional[Path]:
        """Get or create cached Parquet for ilinet.csv atomically."""
        ili_csv = self.surveillance_dir / "ilinet.csv"
        if not ili_csv.exists():
            ili_csv = self.viz_dir / "data" / "seed" / "ilinet.csv"
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
            fsn_csv = self.viz_dir / "data" / "seed" / "flusurvnet.csv"
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

    def warmup_cache(self, model_ids: Optional[List[str]] = None) -> int:
        """
        Pre-cache models and target files in batch.
        Can be called on startup or on demand. Returns count of models cached.
        """
        self.get_oracle_parquet()
        self.get_admissions_parquet()
        self.get_initial_admissions_parquet()
        self.get_as_of_admissions_parquet()
        self.get_ilinet_parquet()
        self.get_flusurvnet_parquet()

        cached_count = 0
        all_dirs = []
        if self.model_output_dir.exists():
            for p in self.model_output_dir.iterdir():
                if p.is_dir() and not p.name.startswith("."):
                    if model_ids is None or p.name in model_ids:
                        all_dirs.append((p.name, False))
        if self.local_output_dir.exists():
            for p in self.local_output_dir.iterdir():
                if p.is_dir() and not p.name.startswith("."):
                    if model_ids is None or p.name in model_ids:
                        all_dirs.append((p.name, True))

        for mid, is_loc in all_dirs:
            p = self.get_model_parquet(mid, is_local=is_loc)
            if p is not None:
                cached_count += 1

        # Hub copies already on disk (never fetched here: warmup does no network access)
        if self.include_remote:
            for hub_id in self.remote_store.active_hub_ids():
                mo_dir = self.remote_store.hub_dir(hub_id) / "model-output"
                if not mo_dir.is_dir():
                    continue
                for p in mo_dir.iterdir():
                    key = f"{hub_id}:{p.name}"
                    if p.is_dir() and (model_ids is None or key in model_ids):
                        if self.get_model_parquet(key) is not None:
                            cached_count += 1

        return cached_count

    def clear_cache(self, model_id: Optional[str] = None):
        """Remove cached parquet and metadata files to force regeneration."""
        if model_id:
            hub = self.hub_key(model_id)
            if hub is not None:
                d = self.hub_models_cache_dir / hub[0]
                for suffix in (".parquet", ".meta.json", ".peak.parquet", ".peak.meta.json"):
                    (d / f"{hub[1]}{suffix}").unlink(missing_ok=True)
                return
            for d in [self.models_cache_dir, self.local_models_cache_dir]:
                for suffix in (".parquet", ".meta.json", ".peak.parquet", ".peak.meta.json"):
                    (d / f"{model_id}{suffix}").unlink(missing_ok=True)
        else:
            # Consolidated tables only; synced hub copies under .cache/remote are kept (removed via the UI)
            hub_dirs = [p for p in self.hub_models_cache_dir.iterdir() if p.is_dir()] if self.hub_models_cache_dir.exists() else []
            for d in [self.models_cache_dir, self.local_models_cache_dir, self.targets_cache_dir] + hub_dirs:
                if d.exists():
                    for f in d.iterdir():
                        if f.is_file():
                            f.unlink(missing_ok=True)
