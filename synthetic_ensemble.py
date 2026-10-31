"""
Synthetic ensemble generation and evaluation engine.
Supports quantile Vincentization (median and mean), optional spatial splitting (states vs US national),
strict monotonicity enforcement (quantile rearrangement), and data integrity tracking.
"""

from dataclasses import dataclass, field, asdict
from datetime import datetime
import json
import logging
from pathlib import Path
import re
import threading
from typing import Dict, List, Optional, Any, Set, Tuple

import polars as pl

from viz.cache_manager import NULL_VALUES

logger = logging.getLogger("viz.synthetic_ensemble")

# Ensemble IDs double as directory names under local-output/synthetic/, so restrict them to safe characters
ENSEMBLE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
MAX_CACHED_FORECASTS = 32


@dataclass
class SyntheticEnsembleConfig:
    """Specification for an on-the-fly or persisted synthetic ensemble."""
    id: str = ""
    name: str = "Synthetic Ensemble"
    method: str = "median"  # "median" or "mean"
    models: List[str] = field(default_factory=list)
    spatial_split: bool = False
    state_models: List[str] = field(default_factory=list)
    national_models: List[str] = field(default_factory=list)
    missing_policy: str = "flexible"  # "flexible" (with warning tracking) or "strict"
    created_at: str = ""
    is_saved: bool = False
    description: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SyntheticEnsembleConfig":
        return cls(
            id=data.get("id", ""),
            name=data.get("name", "Synthetic Ensemble"),
            method=data.get("method", "median"),
            models=list(data.get("models", [])),
            spatial_split=bool(data.get("spatial_split", False)),
            state_models=list(data.get("state_models", [])),
            national_models=list(data.get("national_models", [])),
            missing_policy=data.get("missing_policy", "flexible"),
            created_at=data.get("created_at", ""),
            is_saved=bool(data.get("is_saved", False)),
            description=data.get("description", ""),
        )


def enforce_quantile_monotonicity(df: pl.DataFrame) -> pl.DataFrame:
    """
    Ensure quantile predictions are strictly non-decreasing across quantile levels
    within each (reference_date, target, horizon, location, target_end_date) task.
    Implements standard quantile rearrangement to prevent quantile crossing.
    """
    if df.is_empty():
        return df

    group_cols = ["reference_date", "target", "horizon", "location", "target_end_date", "output_type"]
    avail_group = [c for c in group_cols if c in df.columns]

    # Sort quantiles by output_type_id, then sort values monotonically
    return (
        df.sort(avail_group + ["output_type_id"])
        .with_columns(
            pl.col("value")
            .sort()
            .over(avail_group)
            .alias("value")
        )
    )


class SyntheticEnsembleManager:
    """
    Central manager for session-bound and persisted synthetic ensembles.
    Handles forecast synthesis, quantile vincentization, data integrity audits,
    and filesystem export to 'local-output/synthetic/'.
    """

    def __init__(self, base_dir: Path, data_loader: Any = None):
        self.base_dir = Path(base_dir).resolve()
        self.data_loader = data_loader
        self.synthetic_dir = self.base_dir / "local-output" / "synthetic"
        self._session_ensembles: Dict[str, SyntheticEnsembleConfig] = {}
        self._cached_forecasts: Dict[Tuple[str, Tuple[str, ...]], pl.DataFrame] = {}
        self._lock = threading.Lock()

        # Discover previously saved synthetic ensembles on disk
        self._discover_saved_ensembles()

    def _discover_saved_ensembles(self):
        """Scan local-output/synthetic/ for persisted ensemble configurations."""
        if not self.synthetic_dir.exists():
            return

        for p in self.synthetic_dir.iterdir():
            if p.is_dir() and not p.name.startswith("."):
                manifest = p / "synthetic_recipe.json"
                if manifest.exists():
                    try:
                        with open(manifest, "r", encoding="utf-8") as f:
                            data = json.load(f)
                            config = SyntheticEnsembleConfig.from_dict(data)
                            if config.id != p.name:
                                logger.warning("Skipping synthetic recipe %s: id does not match its directory", manifest)
                                continue
                            config.is_saved = True
                            self._session_ensembles[config.id] = config
                    except Exception as exc:
                        logger.warning("Failed to load synthetic recipe %s: %s", manifest, exc)

    def register_ensemble(self, config: SyntheticEnsembleConfig) -> SyntheticEnsembleConfig:
        """Register a new session ensemble."""
        if config.id and not ENSEMBLE_ID_PATTERN.match(config.id):
            raise ValueError(f"Invalid ensemble id '{config.id}': use only letters, digits, '_' and '-'.")
        with self._lock:
            if not config.id:
                clean_name = re.sub(r"[^a-zA-Z0-9_-]", "_", config.name.lower()).strip("_")
                clean_name = re.sub(r"_+", "_", clean_name)
                base_id = f"synth_{clean_name}" if clean_name else "synth_ensemble"
                candidate_id = base_id
                counter = 2
                while candidate_id in self._session_ensembles or (self.synthetic_dir / candidate_id).exists():
                    candidate_id = f"{base_id}_{counter}"
                    counter += 1
                config.id = candidate_id
            if not config.created_at:
                config.created_at = datetime.now().isoformat()

            self._session_ensembles[config.id] = config
            self._invalidate_cached_forecasts(config.id)
            return config

    def _invalidate_cached_forecasts(self, ensemble_id: str):
        """Drop every cached forecast frame for an ensemble (cache keys are (ensemble_id, dates)). Caller holds the lock."""
        for key in [k for k in self._cached_forecasts if k[0] == ensemble_id]:
            del self._cached_forecasts[key]

    def clear_cached_forecasts(self):
        """Drop all cached ensemble forecasts (e.g. after constituent model files change)."""
        with self._lock:
            self._cached_forecasts.clear()

    def _ensemble_dir(self, ensemble_id: str) -> Path:
        """Resolve an ensemble's persistence directory, refusing anything outside local-output/synthetic/."""
        ens_dir = (self.synthetic_dir / ensemble_id).resolve()
        if not ENSEMBLE_ID_PATTERN.match(ensemble_id) or ens_dir.parent != self.synthetic_dir.resolve():
            raise ValueError(f"Invalid ensemble id '{ensemble_id}'.")
        return ens_dir

    def remove_ensemble(self, ensemble_id: str) -> bool:
        """Remove a session or persisted ensemble."""
        with self._lock:
            config = self._session_ensembles.pop(ensemble_id, None)
            self._invalidate_cached_forecasts(ensemble_id)

            if config and config.is_saved:
                ens_dir = self._ensemble_dir(ensemble_id)
                if ens_dir.exists():
                    try:
                        import shutil
                        shutil.rmtree(ens_dir)
                    except Exception as exc:
                        logger.warning("Failed to delete saved ensemble directory %s: %s", ens_dir, exc)
            return config is not None

    def get_config(self, ensemble_id: str) -> Optional[SyntheticEnsembleConfig]:
        """Retrieve configuration for a synthetic ensemble."""
        with self._lock:
            return self._session_ensembles.get(ensemble_id)

    def list_ensembles(self) -> List[Dict[str, Any]]:
        """Return list of all registered session and persisted ensembles."""
        with self._lock:
            return [c.to_dict() for c in self._session_ensembles.values()]

    def save_to_disk(self, ensemble_id: str) -> Dict[str, Any]:
        """
        Persist a synthetic ensemble into local-output/synthetic/<ensemble_id>/.
        Writes synthetic_recipe.json and standard Hubverse CSV files per reference date.
        """
        with self._lock:
            config = self._session_ensembles.get(ensemble_id)
            if not config:
                raise ValueError(f"Synthetic ensemble '{ensemble_id}' not found.")

        # Generate complete forecast dataset
        df, telemetry = self.generate_ensemble_forecasts(config)
        if df.is_empty():
            raise ValueError(f"Synthetic ensemble '{ensemble_id}' produced no forecast data.")

        target_dir = self._ensemble_dir(ensemble_id)
        target_dir.mkdir(parents=True, exist_ok=True)

        # Write partitioned CSVs per reference_date
        dates = df["reference_date"].unique().to_list()
        csv_count = 0
        for d in dates:
            sub = df.filter(pl.col("reference_date") == d)
            # Remove internal component tracking column before saving standard Hubverse CSV
            export_cols = [c for c in sub.columns if c not in ("component_model_id", "model_id")]
            csv_path = target_dir / f"{d}-{ensemble_id}.csv"
            sub.select(export_cols).write_csv(csv_path)
            csv_count += 1

        # Write recipe manifest last, so only fully written ensembles are marked as saved
        manifest_path = target_dir / "synthetic_recipe.json"
        config.is_saved = True
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(config.to_dict(), f, indent=2)

        return {
            "status": "ok",
            "ensemble_id": ensemble_id,
            "path": str(target_dir),
            "csv_count": csv_count,
            "telemetry": telemetry,
        }

    def preview_ensemble(self, config: SyntheticEnsembleConfig) -> Dict[str, Any]:
        """
        Compute pre-flight coverage overlap and task counts before officially creating an ensemble.
        Enables the UI to warn the user about date or task coverage mismatches.
        """
        if not self.data_loader:
            return {"error": "DataLoader not configured"}

        if config.spatial_split:
            comp_models = sorted(list(set(config.state_models + config.national_models)))
        else:
            comp_models = sorted(list(set(config.models)))

        if len(comp_models) < 2:
            return {
                "valid": False,
                "error": "At least 2 constituent models are required to form an ensemble.",
                "model_count": len(comp_models),
            }

        all_models = self.data_loader.scan_models()
        missing_models = [m for m in comp_models if m not in all_models]
        if missing_models:
            return {
                "valid": False,
                "error": f"Models not found: {missing_models}",
            }

        # Calculate date overlap
        model_dates = {m: set(all_models[m].get("dates", [])) for m in comp_models}
        common_dates = set.intersection(*model_dates.values()) if model_dates else set()
        union_dates = set.union(*model_dates.values()) if model_dates else set()

        # Date coverage summary
        date_overlap_pct = (len(common_dates) / len(union_dates) * 100) if union_dates else 0.0

        return {
            "valid": True,
            "component_models": comp_models,
            "model_count": len(comp_models),
            "method": config.method,
            "spatial_split": config.spatial_split,
            "common_dates_count": len(common_dates),
            "union_dates_count": len(union_dates),
            "date_overlap_percentage": round(date_overlap_pct, 1),
            "common_dates": sorted(list(common_dates), reverse=True),
            "union_dates": sorted(list(union_dates), reverse=True),
            "has_date_mismatch": len(common_dates) < len(union_dates),
            "missing_policy": config.missing_policy,
        }

    def generate_ensemble_forecasts(
        self, config: SyntheticEnsembleConfig, dates: Optional[List[str]] = None
    ) -> Tuple[pl.DataFrame, Dict[str, Any]]:
        """
        Synthesize combined forecasts from constituent models using vectorized Polars.
        Applies quantile Vincentization, spatial routing, monotonicity enforcement,
        and telemetry tracking for data integrity.
        """
        if not self.data_loader:
            raise RuntimeError("DataLoader not attached to SyntheticEnsembleManager")

        # Determine models needed
        if config.spatial_split:
            state_models = set(config.state_models)
            national_models = set(config.national_models)
            all_models = list(state_models | national_models)
        else:
            state_models = set(config.models)
            national_models = set(config.models)
            all_models = list(set(config.models))

        if len(all_models) < 1:
            return pl.DataFrame(), {"error": "No constituent models configured"}

        # Load forecasts for each model
        loaded_dfs = []
        for mid in all_models:
            m_df = self.data_loader.load_combined_forecasts(mid, dates=dates, as_polars=True)
            if m_df is not None and not m_df.is_empty():
                # Filter to quantiles and ensure required schema
                req_cols = ["reference_date", "target", "horizon", "location", "output_type_id", "value"]
                if all(c in m_df.columns for c in req_cols):
                    filtered = m_df.filter(
                        (pl.col("output_type") == "quantile") if "output_type" in m_df.columns else pl.lit(True)
                    ).with_columns([
                        pl.lit(mid).alias("component_model_id"),
                        pl.col("output_type_id").cast(pl.Float64).round(3),
                        pl.col("horizon").cast(pl.Int32),
                        pl.col("location").cast(pl.String),
                        pl.col("reference_date").cast(pl.String),
                        pl.col("value").cast(pl.Float64),
                    ])
                    if "target_end_date" not in filtered.columns:
                        filtered = filtered.with_columns(pl.col("reference_date").alias("target_end_date"))
                    else:
                        filtered = filtered.with_columns(pl.col("target_end_date").cast(pl.String))
                    loaded_dfs.append(filtered)

        if not loaded_dfs:
            return pl.DataFrame(), {"total_tasks": 0, "warnings": ["No data available for constituent models."]}

        combined_raw = pl.concat(loaded_dfs, how="diagonal")

        # Apply spatial split routing
        if config.spatial_split:
            state_slice = combined_raw.filter(
                (pl.col("location") != "US") & (pl.col("component_model_id").is_in(list(state_models)))
            )
            national_slice = combined_raw.filter(
                (pl.col("location") == "US") & (pl.col("component_model_id").is_in(list(national_models)))
            )
            routed = pl.concat([state_slice, national_slice], how="diagonal")
        else:
            routed = combined_raw

        if routed.is_empty():
            return pl.DataFrame(), {"total_tasks": 0, "warnings": ["No forecast rows after spatial filtering."]}

        task_cols = ["reference_date", "target", "horizon", "location", "target_end_date"]
        group_cols = task_cols + ["output_type_id"]

        # Members contributing to each task, and to each quantile level within it
        routed = routed.with_columns([
            pl.col("component_model_id").n_unique().over(task_cols).alias("n_task_models"),
            pl.col("component_model_id").n_unique().over(group_cols).alias("n_level_models"),
        ])

        # Keep only quantile levels submitted by every member of a task, so each task's distribution
        # pools one consistent member set (e.g. a 7-quantile member restricts that task to those 7 levels)
        dropped_levels = routed.filter(pl.col("n_level_models") < pl.col("n_task_models")).select(group_cols).n_unique()
        routed = routed.filter(pl.col("n_level_models") == pl.col("n_task_models"))

        # Expected member count per task: national pool for US when spatially split, state pool otherwise
        n_expected = (
            pl.when(pl.col("location") == "US").then(pl.lit(len(national_models))).otherwise(pl.lit(len(state_models)))
            if config.spatial_split
            else pl.lit(len(state_models))
        )
        tasks = routed.select(task_cols + ["n_task_models"]).unique(subset=task_cols).with_columns(
            n_expected.alias("n_models_expected")
        )

        # Track telemetry on partial vs full task coverage
        total_tasks = len(tasks)
        partial_count = len(tasks.filter(pl.col("n_task_models") < pl.col("n_models_expected")))
        full_count = total_tasks - partial_count

        warnings = []
        if partial_count > 0:
            pct = (partial_count / total_tasks * 100) if total_tasks > 0 else 0
            omitted = "were dropped" if config.missing_policy == "strict" else "pool only the members present"
            warnings.append(
                f"Synthetic ensemble '{config.name}' has partial member coverage on {partial_count} / {total_tasks} "
                f"tasks ({pct:.1f}%); those tasks {omitted}."
            )
        if dropped_levels > 0:
            warnings.append(
                f"Synthetic ensemble '{config.name}' omitted {dropped_levels} task quantile levels not submitted by every member."
            )

        # Apply missing policy (whole tasks, never individual quantile rows)
        if config.missing_policy == "strict":
            complete = tasks.filter(pl.col("n_task_models") >= pl.col("n_models_expected")).select(task_cols)
            routed = routed.join(complete, on=task_cols, how="semi")

        # Aggregate across component models per quantile
        agg_expr = (
            pl.col("value").median() if config.method == "median" else pl.col("value").mean()
        )
        filtered = routed.group_by(group_cols).agg(agg_expr.alias("value"))

        # Add output_type and model_id
        final_df = filtered.with_columns([
            pl.lit("quantile").alias("output_type"),
            pl.lit(config.id).alias("model_id"),
        ])

        # Enforce quantile monotonicity
        final_df = enforce_quantile_monotonicity(final_df)

        telemetry = {
            "ensemble_id": config.id,
            "total_tasks": total_tasks,
            "full_coverage_tasks": full_count,
            "partial_coverage_tasks": partial_count,
            "missing_policy": config.missing_policy,
            "warnings": warnings,
            "evaluated_dates_count": final_df["reference_date"].n_unique() if not final_df.is_empty() else 0,
        }

        return final_df, telemetry

    def get_forecasts(
        self, ensemble_id: str, dates: Optional[List[str]] = None
    ) -> Optional[pl.DataFrame]:
        """Retrieve synthetic forecasts for a registered ensemble, with caching."""
        config = self.get_config(ensemble_id)
        if not config:
            return None

        cache_key = (ensemble_id, tuple(sorted(dates)) if dates else ())
        with self._lock:
            if cache_key in self._cached_forecasts:
                return self._cached_forecasts[cache_key]

        df, _ = self.generate_ensemble_forecasts(config, dates=dates)
        if not df.is_empty():
            with self._lock:
                # Keep memory bounded: each evaluation scope caches its own date subset
                if len(self._cached_forecasts) >= MAX_CACHED_FORECASTS:
                    self._cached_forecasts.clear()
                self._cached_forecasts[cache_key] = df
            return df
        return None
