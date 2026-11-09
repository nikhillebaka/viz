"""
Data loader and caching layer for oracle truth, locations, and model outputs.
Supports both production 'model-output/' and local test 'local-output/'.
Pure-Polars implementation with zero stale in-memory dictionary caching.
"""

from datetime import datetime, date, timedelta
import functools
import json
import logging
from pathlib import Path
import re
import threading
from typing import Dict, List, Optional, Any, Set, Tuple, Union

import numpy as np
import polars as pl

try:
    import yaml
except ImportError:
    yaml = None

from viz.core.cache_manager import ParquetCacheManager, NULL_VALUES, filter_quantile_rows
from viz.core.config import VizConfig
from viz.core.metrics import find_quantile_column, score_forecasts
from viz.core.peak_data import PeakService
from viz.core.peaks import is_peak_target
from viz.core.synthetic_ensemble import SyntheticEnsembleManager, SyntheticEnsembleConfig

logger = logging.getLogger("viz.data_loader")

# US Department of Health and Human Services (HHS) 10 Public Health Regions
HHS_REGIONS: Dict[int, Dict[str, Any]] = {
    1: {"name": "Region 1 (New England)", "short": "New England", "states": ["CT", "ME", "MA", "NH", "RI", "VT"]},
    2: {"name": "Region 2 (New York & NJ)", "short": "New York & NJ", "states": ["NJ", "NY", "PR", "VI"]},
    3: {"name": "Region 3 (Mid-Atlantic)", "short": "Mid-Atlantic", "states": ["DE", "DC", "MD", "PA", "VA", "WV"]},
    4: {"name": "Region 4 (Southeast)", "short": "Southeast", "states": ["AL", "FL", "GA", "KY", "MS", "NC", "SC", "TN"]},
    5: {"name": "Region 5 (Great Lakes)", "short": "Great Lakes", "states": ["IL", "IN", "MI", "MN", "OH", "WI"]},
    6: {"name": "Region 6 (South Central)", "short": "South Central", "states": ["AR", "LA", "NM", "OK", "TX"]},
    7: {"name": "Region 7 (Central)", "short": "Central", "states": ["IA", "KS", "MO", "NE"]},
    8: {"name": "Region 8 (Mountain)", "short": "Mountain", "states": ["CO", "MT", "ND", "SD", "UT", "WY"]},
    9: {"name": "Region 9 (Pacific Southwest)", "short": "Pacific SW", "states": ["AZ", "CA", "HI", "NV", "AS", "GU", "MP"]},
    10: {"name": "Region 10 (Pacific Northwest)", "short": "Pacific NW", "states": ["AK", "ID", "OR", "WA"]},
}

STATE_TO_HHS_REGION: Dict[str, int] = {}
for r_id, r_info in HHS_REGIONS.items():
    for st in r_info["states"]:
        STATE_TO_HHS_REGION[st] = r_id



def date_to_season_and_week(dt: Any) -> Tuple[str, int]:
    """
    Convert a datetime or date string into standard CDC MMWR (season, season_week).
    Season starts at MMWR week 31 (early August) -> season_week 1.
    Handles 52- and 53-week years accurately with zero external dependency.
    """
    if isinstance(dt, str):
        d = datetime.strptime(dt.split(" ")[0], "%Y-%m-%d").date()
    elif hasattr(dt, "date"):
        d = dt.date()
    elif isinstance(dt, date):
        d = dt
    else:
        d = dt

    jan4 = date(d.year, 1, 4)
    start_sun = jan4 - timedelta(days=(jan4.weekday() + 1) % 7)

    if d < start_sun:
        prev_jan4 = date(d.year - 1, 1, 4)
        start_sun = prev_jan4 - timedelta(days=(prev_jan4.weekday() + 1) % 7)
        ew_year = d.year - 1
    else:
        next_jan4 = date(d.year + 1, 1, 4)
        next_start_sun = next_jan4 - timedelta(days=(next_jan4.weekday() + 1) % 7)
        if d >= next_start_sun:
            start_sun = next_start_sun
            ew_year = d.year + 1
        else:
            ew_year = d.year

    ew_week = (d - start_sun).days // 7 + 1

    if ew_week <= 30:
        season_start = ew_year - 1
        jan4_s = date(season_start, 1, 4)
        s_sun = jan4_s - timedelta(days=(jan4_s.weekday() + 1) % 7)
        sun53 = s_sun + timedelta(weeks=52)
        next_j4 = date(season_start + 1, 1, 4)
        next_ss = next_j4 - timedelta(days=(next_j4.weekday() + 1) % 7)
        weeks_prior = 53 if sun53 < next_ss else 52
        season_week = ew_week - 30 + weeks_prior
    else:
        season_start = ew_year
        season_week = ew_week - 30

    season_str = f"{season_start}/{str(season_start + 1)[-2:]}"
    return season_str, season_week


def _flu_season_for_date(date_str: Any) -> str:
    try:
        s_str, _ = date_to_season_and_week(date_str)
        start_yr = int(s_str.split("/")[0])
        return f"{start_yr}-{start_yr + 1}"
    except Exception:
        return "Unknown"


@functools.lru_cache(maxsize=65536)
def _flu_season_for_date_str(date_str: str) -> str:
    return _flu_season_for_date(date_str)


def _safe_to_pandas(df: Optional[pl.DataFrame]) -> Any:
    """Safely convert Polars DataFrame to pandas with explicit dependency error."""
    if df is None:
        return None
    try:
        return df.to_pandas()
    except Exception as exc:
        raise ImportError("Converting to pandas requires both 'pandas' and 'pyarrow' to be installed.") from exc


class SandboxDataLoader:
    """
    High-performance data loader for forecasts, surveillance streams, and ground truth.
    Powered directly by Polars SIMD queries and ParquetCacheManager.
    """

    def __init__(self, base_dir: Path, include_remote: bool = True):
        self.base_dir = Path(base_dir).resolve()
        # Hub data synced from S3 (viz/.cache/remote) is shown in the dashboard only, never in the CLI
        self.include_remote = include_remote
        self.model_output_dir = self.base_dir / "model-output"
        self.local_output_dir = self.base_dir / "local-output"
        self.target_data_dir = self.base_dir / "target-data"
        self.auxiliary_data_dir = self.base_dir / "auxiliary-data"
        self.model_metadata_dir = self.base_dir / "model-metadata"
        self.hub_config_dir = self.base_dir / "hub-config"
        self.config = VizConfig(self.base_dir)

        # Initialize transparent Parquet acceleration layer
        self.cache_mgr = ParquetCacheManager(self.base_dir, include_remote=include_remote)
        self.remote_store = self.cache_mgr.remote_store

        # Initialize Synthetic Ensemble Engine
        self.ensemble_mgr = SyntheticEnsembleManager(self.base_dir, data_loader=self)

        # Season peak forecasts (separate peak tables, never mixed into weekly forecasts)
        self.peaks = PeakService(self)

        self._locations_cache: Optional[Dict[str, Dict[str, Any]]] = None
        self._hub_seasons_cache: Optional[Dict[str, List[str]]] = None
        self._model_details_cache: Dict[str, Dict[str, Any]] = {}
        self._models_cache: Optional[Dict[str, Dict[str, Any]]] = None
        self._models_cache_mtime: float = -1.0
        self._models_cache_lock = threading.Lock()

    def get_locations(self) -> Dict[str, Dict[str, Any]]:
        """Get mapping of location code -> metadata (name, abbreviation, population)."""
        if self._locations_cache is not None:
            return self._locations_cache

        loc_file = self.auxiliary_data_dir / "locations.csv"
        locations = {}
        if loc_file.exists():
            try:
                df = pl.read_csv(
                    loc_file,
                    schema_overrides={"location": pl.String, "population": pl.Int64},
                    null_values=NULL_VALUES,
                    ignore_errors=False,
                )
                for row in df.iter_rows(named=True):
                    loc_id = str(row["location"])
                    pop = row.get("population")
                    locations[loc_id] = {
                        "id": loc_id,
                        "abbreviation": str(row.get("abbreviation") or loc_id),
                        "name": str(row.get("location_name") or loc_id),
                        "population": int(pop) if pop is not None else None,
                    }
            except Exception as exc:
                logger.warning("Error reading locations.csv: %s", exc)

        if "US" not in locations:
            locations["US"] = {"id": "US", "abbreviation": "US", "name": "United States", "population": None}

        self._locations_cache = locations
        return locations

    def get_admissions_ground_truth(self, as_polars: bool = True) -> Any:
        """Load official hospital admissions surveillance ground truth via accelerated Parquet cache."""
        lf = self.cache_mgr.scan_admissions()
        if lf is not None:
            df = lf.collect()
            return df if as_polars else _safe_to_pandas(df)
        return pl.DataFrame() if as_polars else None

    def get_oracle(self, as_polars: bool = True) -> Any:
        """Load oracle ground truth via accelerated Parquet cache."""
        lf = self.cache_mgr.scan_oracle()
        if lf is not None:
            df = lf.collect()
            return df if as_polars else _safe_to_pandas(df)
        return pl.DataFrame() if as_polars else None

    def get_validation_warnings(self, model_ids: Optional[List[str]] = None) -> List[str]:
        """Return captured validation warnings from cache manager and synthetic ensemble engine."""
        warnings = list(self.cache_mgr.get_validation_warnings(model_ids))
        if hasattr(self, "ensemble_mgr"):
            requested = model_ids if model_ids is not None else list(self.scan_models().keys())
            all_m = self.scan_models()
            for mid in requested:
                cfg = self.ensemble_mgr.get_config(mid)
                if cfg:
                    comp_models = (cfg.state_models + cfg.national_models) if cfg.spatial_split else cfg.models
                    missing_comp = [c for c in comp_models if c not in all_m]
                    if missing_comp:
                        warnings.append(
                            f"Synthetic ensemble '{cfg.name}' references missing models: {', '.join(missing_comp)}"
                        )
        return sorted(list(set(warnings)))

    def _compute_models_mtime(self) -> float:
        """Compute maximum modification time across model directories for cache invalidation."""
        mtime = 0.0
        try:
            if self.model_output_dir.exists():
                mtime = max(mtime, self.model_output_dir.stat().st_mtime)
                for p in self.model_output_dir.iterdir():
                    if p.is_dir() and not p.name.startswith("."):
                        mtime = max(mtime, p.stat().st_mtime)
            if self.local_output_dir.exists():
                mtime = max(mtime, self.local_output_dir.stat().st_mtime)
                for p in self.local_output_dir.iterdir():
                    if p.is_dir() and not p.name.startswith("."):
                        mtime = max(mtime, p.stat().st_mtime)
            synth_dir = self.local_output_dir / "synthetic"
            if synth_dir.exists():
                mtime = max(mtime, synth_dir.stat().st_mtime)
            if self.include_remote:
                mtime = max(mtime, self.remote_store.state_mtime())
        except Exception:
            pass
        return mtime

    # ------------------------------------------------------------------------------------------------
    # Season phases (pre-peak / peak / post-peak) per location, from observed truth
    # ------------------------------------------------------------------------------------------------

    PEAK_FRACTION = 0.6  # peak = contiguous weeks around the season maximum at >= 60% of that maximum

    def _weekly_truth(self, target: str) -> pl.DataFrame:
        """One observed value per (location, week) for a target: newest oracle vintage, admissions filling gaps."""
        frames = []
        lf_oracle = self.cache_mgr.scan_oracle()
        if lf_oracle is not None:
            o = lf_oracle.filter(pl.col("target") == target)
            names = o.collect_schema().names()
            if "output_type" in names:
                o = o.filter(pl.col("output_type").is_null() | (pl.col("output_type") != "pmf"))
            o = o.select(
                ["location", "target_end_date", "oracle_value"] + (["as_of"] if "as_of" in names else [])
            ).drop_nulls(["oracle_value"]).collect()
            if "as_of" in o.columns:
                o = o.sort("as_of").unique(subset=["location", "target_end_date"], keep="last").drop("as_of")
            else:
                o = o.unique(subset=["location", "target_end_date"], keep="first")
            frames.append(o)
        if "hosp" in target.lower():
            lf_adm = self.cache_mgr.scan_admissions()
            if lf_adm is not None:
                adm = lf_adm.select(["location", "target_end_date", "oracle_value"]).drop_nulls().collect()
                adm = adm.unique(subset=["location", "target_end_date"], keep="first")
                if frames:
                    adm = adm.join(frames[0], on=["location", "target_end_date"], how="anti")
                frames.append(adm)
        frames = [f for f in frames if not f.is_empty()]
        if not frames:
            return pl.DataFrame(schema={"location": pl.String, "target_end_date": pl.String, "oracle_value": pl.Float64})
        return pl.concat(frames, how="vertical_relaxed").rename({"oracle_value": "value"})

    def get_truth_phases(self, target: str) -> pl.DataFrame:
        """
        Weekly truth labelled with its season, season week, and phase for every location:
        'peak' is the contiguous run around the season maximum at >= PEAK_FRACTION of it, 'pre' and
        'post' are the weeks before and after. A season whose highest week is still one of its latest
        observations (and is not over) has not peaked yet, so all of its weeks are 'pre'.
        """
        sources = [self.cache_mgr.get_oracle_parquet(), self.cache_mgr.get_admissions_parquet()]
        stamp = (target,) + tuple((str(p), p.stat().st_mtime) if p and p.exists() else None for p in sources)
        cached = getattr(self, "_phase_cache", None)
        if cached is not None and cached[0] == stamp:
            return cached[1]

        weekly = self._weekly_truth(target)
        out_schema = {"location": pl.String, "target_end_date": pl.String, "season": pl.String,
                      "season_week": pl.Int32, "value": pl.Float64, "phase": pl.String}
        if weekly.is_empty():
            result = pl.DataFrame(schema=out_schema)
            self._phase_cache = (stamp, result)
            return result

        sw = {d: date_to_season_and_week(d) for d in weekly.get_column("target_end_date").unique().to_list()}
        season_of = {d: f"{v[0][:4]}-{int(v[0][:4]) + 1}" for d, v in sw.items()}
        weekly = weekly.with_columns(
            pl.col("target_end_date").replace_strict(season_of, return_dtype=pl.String).alias("season"),
            pl.col("target_end_date").replace_strict({d: v[1] for d, v in sw.items()}, return_dtype=pl.Int32).alias("season_week"),
        ).sort(["location", "season", "season_week"])

        phase_frames = []
        for (loc, season), g in weekly.group_by(["location", "season"], maintain_order=True):
            vals = g.get_column("value").to_list()
            n = len(vals)
            phases = [None] * n
            peak_val = max(vals) if vals else 0
            if n >= 3 and peak_val and peak_val > 0:
                i = vals.index(peak_val)
                season_end = self.get_season_calendar_bounds(int(season[:4]))[1]
                last_obs = g.get_column("target_end_date")[-1]
                still_open = (datetime.strptime(season_end, "%Y-%m-%d") - datetime.strptime(last_obs, "%Y-%m-%d")).days > 21
                if still_open and i >= n - 2:
                    phases = ["pre"] * n
                else:
                    a = b = i
                    floor = self.PEAK_FRACTION * peak_val
                    while a - 1 >= 0 and vals[a - 1] >= floor:
                        a -= 1
                    while b + 1 < n and vals[b + 1] >= floor:
                        b += 1
                    phases = ["pre"] * a + ["peak"] * (b - a + 1) + ["post"] * (n - b - 1)
            phase_frames.append(g.with_columns(pl.Series("phase", phases, dtype=pl.String)))

        result = pl.concat(phase_frames, how="vertical_relaxed").select(list(out_schema)).cast(out_schema)
        self._phase_cache = (stamp, result)
        return result

    def get_season_curves(self, target: str, location: str, seasons: List[str]) -> Dict[str, Any]:
        """Per-season truth curves for one location aligned by season week, with phases, for the scope picker."""
        table = self.get_truth_phases(target)
        sub = table.filter((pl.col("location") == str(location)) & pl.col("season").is_in(seasons))
        curves = []
        for season in sorted(seasons, reverse=True):
            g = sub.filter(pl.col("season") == season).sort("season_week")
            if g.is_empty():
                continue
            phases = g.get_column("phase").to_list()
            peak_weeks = [w for w, ph in zip(g.get_column("season_week").to_list(), phases) if ph == "peak"]
            curves.append({
                "season": season,
                "points": [
                    {"week": int(w), "date": d, "value": float(v), "phase": ph}
                    for w, d, v, ph in g.select(["season_week", "target_end_date", "value", "phase"]).iter_rows()
                ],
                "peak_weeks": [min(peak_weeks), max(peak_weeks)] if peak_weeks else None,
                "peaked": bool(peak_weeks),
            })

        # Month ticks on the season-week axis (MMWR week 31 = season week 1, early August)
        ref_start = int(seasons[0][:4]) if seasons else datetime.now().year
        start, _ = self.get_season_calendar_bounds(ref_start)
        first_sat = datetime.strptime(start, "%Y-%m-%d") + timedelta(days=6)
        ticks, last_month = [], None
        for w in range(1, 53):
            d = first_sat + timedelta(weeks=w - 1)
            if d.month != last_month:
                ticks.append({"week": w, "label": d.strftime("%b")})
                last_month = d.month
        week_dates = [(first_sat + timedelta(weeks=w - 1)).strftime("%Y-%m-%d") for w in range(1, 54)]
        return {
            "location": location,
            "target": target,
            "peak_fraction": self.PEAK_FRACTION,
            "curves": curves,
            "month_ticks": ticks,
            "reference_season": f"{ref_start}-{ref_start + 1}",
            "week_dates": week_dates,
        }

    def get_truth_info(self) -> Dict[str, Any]:
        """Which truth sources are merged (newest vintage wins per observation) and how current they are."""
        hubs = []
        if self.include_remote:
            hubs = [h for h in self.remote_store.active_hub_ids()
                    if self.remote_store.truth_path(h, "oracle").exists()]
        info: Dict[str, Any] = {"policy": "auto", "sources": ["repo"] + hubs, "as_of": None, "latest_observation": None}
        pq = self.cache_mgr.get_oracle_parquet()
        if pq is not None and pq.exists():
            try:
                lf = pl.scan_parquet(pq)
                names = lf.collect_schema().names()
                aggs = [pl.col("target_end_date").max().alias("latest")]
                if "as_of" in names:
                    aggs.append(pl.col("as_of").max().alias("as_of"))
                row = lf.select(aggs).collect().row(0, named=True)
                info["latest_observation"] = row.get("latest")
                info["as_of"] = row.get("as_of") or None
            except Exception as exc:
                logger.debug("Could not summarize oracle truth: %s", exc)
        return info

    def invalidate_inventory(self):
        """Drop in-memory inventory caches after hub data is synced, toggled, or removed."""
        with self._models_cache_lock:
            for key, info in (self._models_cache or {}).items():
                if info.get("source") == "hub":
                    self.cache_mgr.warning_registry.clear(key)
            self._models_cache = None
            self._models_cache_mtime = -1.0
        self._model_details_cache.clear()
        self._hub_seasons_cache = None

    def _scan_hub_models(self, taken: Set[str]) -> Dict[str, Dict[str, Any]]:
        """Inventory of models copied from active hubs, read from each hub's manifest (no Parquet scans)."""
        models: Dict[str, Dict[str, Any]] = {}
        for spec in self.remote_store.hub_specs():
            if spec.id not in self.remote_store.active_hub_ids():
                continue
            man = self.remote_store.load_manifest(spec.id)
            per_model: Dict[str, Dict[str, Any]] = {}
            peak_info: Dict[str, Dict[str, set]] = {}
            for f in man.get("files", {}).values():
                if f.get("peak_targets"):
                    pk = peak_info.setdefault(f["model"], {"targets": set(), "dates": set()})
                    pk["targets"].update(f["peak_targets"])
                    pk["dates"].add(f["reference_date"])
                if not f.get("path"):
                    continue
                pm = per_model.setdefault(f["model"], {"dates": set(), "targets": set(), "warnings": [],
                                                       "revisions": 0, "posted": ""})
                pm["dates"].add(f["reference_date"])
                pm["targets"].update(f.get("targets", []))
                pm["warnings"].extend(f.get("warnings", []))
                pm["revisions"] += int(f.get("revisions", 0))
                pm["posted"] = max(pm["posted"], f.get("last_modified", ""))
            meta = man.get("metadata", {})
            for name, pm in sorted(per_model.items()):
                key = f"{spec.id}:{name}"
                if key in taken:
                    continue
                dates = sorted(pm["dates"])
                for w in pm["warnings"]:
                    self.cache_mgr.warning_registry.add_warning(key, f"[{spec.short_label}] {w}")
                models[key] = {
                    "id": key,
                    "raw_name": key,
                    "display_name": name,
                    "is_local": False,
                    "is_synthetic": False,
                    "source": "hub",
                    "hub": spec.id,
                    "hub_label": spec.short_label,
                    "designated": bool(meta.get(name, {}).get("designated", False)),
                    "path": str(self.remote_store.model_dir(spec.id, name)),
                    "count": len(dates),
                    "dates": dates,
                    "seasons": sorted({self.get_flu_season_for_date(d) for d in dates}),
                    # Weekly targets only; season peak targets are listed separately
                    "targets": sorted(t for t in pm["targets"] if not is_peak_target(t)),
                    "peak_targets": sorted(peak_info.get(name, {}).get("targets", [])),
                    "peak_dates": sorted(peak_info.get(name, {}).get("dates", [])),
                    "family": self.infer_model_family(name),
                    "min_date": dates[0] if dates else None,
                    "max_date": dates[-1] if dates else None,
                    "last_posted": pm["posted"] or None,
                    "revision_count": pm["revisions"],
                    "warnings_count": len(pm["warnings"]),
                }
        return models

    def _get_model_targets(self, model_id: str, is_local: bool = False, files: Optional[List[Path]] = None) -> List[str]:
        """Detect and return distinct targets forecasted by the model, cached in meta.json."""
        dest_dir = self.cache_mgr.local_models_cache_dir if is_local else self.cache_mgr.models_cache_dir
        meta_path = dest_dir / f"{model_id}.meta.json"
        if meta_path.exists():
            try:
                with open(meta_path, "r", encoding="utf-8") as f_meta:
                    saved = json.load(f_meta)
                    if "targets" in saved and isinstance(saved["targets"], list):
                        return saved["targets"]
            except Exception:
                pass

        pq_path = dest_dir / f"{model_id}.parquet"
        if pq_path.exists():
            try:
                schema = pl.scan_parquet(pq_path).collect_schema()
                if "target" in schema.names():
                    tgts = sorted(pl.scan_parquet(pq_path).select("target").unique().collect()["target"].to_list())
                    if meta_path.exists():
                        try:
                            with open(meta_path, "r", encoding="utf-8") as f_meta:
                                saved = json.load(f_meta)
                            saved["targets"] = tgts
                            with open(meta_path, "w", encoding="utf-8") as f_meta:
                                json.dump(saved, f_meta)
                        except Exception:
                            pass
                    return tgts
            except Exception:
                pass

        targets: Set[str] = set()
        if files:
            sample_files = [files[0]] if len(files) == 1 else [files[0], files[-1]]
            for sample_f in sample_files:
                try:
                    if sample_f.suffix == ".parquet":
                        tgts = pl.scan_parquet(sample_f).select("target").unique().collect()["target"].to_list()
                        targets.update(tgts)
                    elif sample_f.suffix == ".csv":
                        df_sample = pl.read_csv(sample_f, columns=["target"], n_rows=100)
                        if "target" in df_sample.columns:
                            targets.update(df_sample["target"].unique().to_list())
                except Exception:
                    pass
        return sorted(list(targets))

    def scan_models(self, force_refresh: bool = False) -> Dict[str, Dict[str, Any]]:
        """
        Scan both model-output/ and local-output/ for available models.
        Returns dict of model_id -> metadata. Cached by directory mtime for high performance.
        Disambiguates name collisions between local and production models.
        """
        current_mtime = self._compute_models_mtime()
        with self._models_cache_lock:
            if not force_refresh and self._models_cache is not None and self._models_cache_mtime == current_mtime:
                return self._models_cache

            models = {}

            # 1. Production / Main model-output
            if self.model_output_dir.exists():
                for p in sorted(self.model_output_dir.iterdir()):
                    if p.is_dir() and not p.name.startswith("."):
                        forecast_files = sorted(list(p.glob("*.csv")) + list(p.glob("*.parquet")), key=lambda f: f.name)
                        if forecast_files:
                            dates = [f.name[:10] for f in forecast_files if len(f.name) >= 10]
                            seasons = sorted(list(set(self.get_flu_season_for_date(d) for d in dates)))
                            targets = [t for t in self._get_model_targets(p.name, is_local=False, files=forecast_files) if not is_peak_target(t)]
                            models[p.name] = {
                                "id": p.name,
                                "raw_name": p.name,
                                "display_name": p.name,
                                "is_local": False,
                                "is_synthetic": False,
                                "source": "repo",
                                "path": str(p),
                                "count": len(forecast_files),
                                "dates": dates,
                                "seasons": seasons,
                                "targets": targets,
                                "family": self.infer_model_family(p.name),
                                "min_date": dates[0] if dates else None,
                                "max_date": dates[-1] if dates else None,
                            }

            # 2. Local test runs in local-output (ignoring synthetic directory namespace)
            if self.local_output_dir.exists():
                for p in sorted(self.local_output_dir.iterdir()):
                    if p.is_dir() and not p.name.startswith(".") and p.name != "synthetic":
                        forecast_files = sorted(list(p.glob("*.csv")) + list(p.glob("*.parquet")), key=lambda f: f.name)
                        if forecast_files:
                            dates = [f.name[:10] for f in forecast_files if len(f.name) >= 10]
                            seasons = sorted(list(set(self.get_flu_season_for_date(d) for d in dates)))
                            model_key = p.name
                            display_name = f"{p.name} (Local)"
                            if p.name in models:
                                model_key = f"local:{p.name}"
                                msg = f"Model collision: '{p.name}' exists in both model-output/ and local-output/. Local run registered as '{model_key}'."
                                logger.info(msg)
                                self.cache_mgr.warning_registry.add_warning(model_key, msg)

                            targets = [t for t in self._get_model_targets(p.name, is_local=True, files=forecast_files) if not is_peak_target(t)]
                            models[model_key] = {
                                "id": model_key,
                                "raw_name": p.name,
                                "display_name": display_name,
                                "is_local": True,
                                "is_synthetic": False,
                                "source": "local",
                                "path": str(p),
                                "count": len(forecast_files),
                                "dates": dates,
                                "seasons": seasons,
                                "targets": targets,
                                "family": self.infer_model_family(p.name),
                                "min_date": dates[0] if dates else None,
                                "max_date": dates[-1] if dates else None,
                            }

            # 3. Models copied from live hubs (namespaced '<hub>:<model>', so they never collide with repo models)
            if self.include_remote:
                models.update(self._scan_hub_models(set(models)))

            # 4. Dynamic and saved synthetic ensembles
            if hasattr(self, "ensemble_mgr"):
                for ens in self.ensemble_mgr.list_ensembles():
                    eid = ens["id"]
                    comp_models = (ens.get("state_models", []) + ens.get("national_models", [])) if ens.get("spatial_split") else ens.get("models", [])
                    ens_dates_set = set()
                    ens_targets_set = set()
                    for c_mid in comp_models:
                        if c_mid in models:
                            ens_dates_set.update(models[c_mid].get("dates", []))
                            ens_targets_set.update(models[c_mid].get("targets", []))
                    ens_dates = sorted(list(ens_dates_set), reverse=True)
                    seasons = sorted(list(set(self.get_flu_season_for_date(d) for d in ens_dates)), reverse=True)
                    models[eid] = {
                        "id": eid,
                        "raw_name": eid,
                        "name": ens.get("name", eid),
                        "display_name": f"{ens.get('name', eid)} [SYNTHETIC]",
                        "is_local": True,
                        "is_synthetic": True,
                        "source": "synthetic",
                        "synthetic_config": ens,
                        "path": str(self.ensemble_mgr.synthetic_dir / eid) if ens.get("is_saved") else "",
                        "count": len(ens_dates),
                        "dates": ens_dates,
                        "seasons": seasons,
                        "targets": sorted(list(ens_targets_set)) if ens_targets_set else [],
                        "family": "Synthetic Ensemble",
                        "min_date": ens_dates[-1] if ens_dates else None,
                        "max_date": ens_dates[0] if ens_dates else None,
                    }

            self._models_cache = models
            self._models_cache_mtime = current_mtime
            return models

    def _resolve_model_id_and_local(self, model_id: str) -> Tuple[str, bool]:
        """Resolve model ID and whether it is a local run, handling 'local:' namespace."""
        models = self.scan_models()
        if model_id in models:
            info = models[model_id]
            return info.get("raw_name", model_id), info.get("is_local", False)
        if model_id.startswith("local:"):
            return model_id[6:], True
        return model_id, False

    @staticmethod
    def infer_model_family(model_id: str, meta: Optional[Dict[str, Any]] = None) -> str:
        """
        Dynamically infer a clean, readable family name from model_id or metadata.
        Zero hardcoding: uses regex word boundaries to prevent substring false-matches.
        """
        if meta and meta.get("model_family"):
            return str(meta["model_family"]).strip()

        # Strip team prefix if present: e.g. "UMass-flusion_spatial" -> "flusion_spatial"
        clean = model_id.split("-", 1)[1] if "-" in model_id else model_id

        # Normalize common abbreviations with word boundaries
        c_lower = clean.lower()
        if "flusion" in c_lower:
            return "Flusion"
        if "gbqr" in c_lower:
            return "GBQR"
        if re.search(r"\b(ar\d*|autoreg)\b", c_lower) or c_lower.startswith("ar_") or c_lower.startswith("ar-"):
            return "AR"
        if "baseline" in c_lower:
            return "Baseline"
        if "ensemble" in c_lower:
            return "Ensemble"

        # General rule: first segment before underscore/digit
        match = re.match(r"^([a-zA-Z]+)", clean)
        if match:
            family_cand = match.group(1).capitalize()
            if len(family_cand) >= 2:
                return family_cand

        return clean.capitalize()

    def get_all_families(self) -> List[str]:
        """Return list of distinct model families available in the sandbox."""
        models = self.scan_models()
        # Hub models are browsed in their own shelf; their inferred names would flood the family filter
        fams = {m["family"] for m in models.values() if m.get("family") and m.get("source") != "hub"}
        return sorted(list(fams))

    def load_forecast_file(
        self, model_id: str, reference_date: str, as_polars: bool = True
    ) -> Optional[Any]:
        """Load single forecast for a given model and date via Parquet cache, Synthetic engine, or CSV."""
        if hasattr(self, "ensemble_mgr") and self.ensemble_mgr.get_config(model_id):
            df = self.ensemble_mgr.get_forecasts(model_id, dates=[reference_date])
            if df is not None and not df.is_empty():
                sub = df.filter(pl.col("reference_date") == reference_date)
                if not sub.is_empty():
                    return sub if as_polars else _safe_to_pandas(sub)
            return None

        raw_id, is_local = self._resolve_model_id_and_local(model_id)
        lf = self.cache_mgr.scan_model(raw_id, is_local=is_local)

        if lf is not None:
            sub = lf.filter(pl.col("reference_date") == reference_date).collect()
            if not sub.is_empty():
                return sub if as_polars else _safe_to_pandas(sub)

        # Direct file fallback if cache miss (supports both CSV and Parquet)
        candidates = [
            self.local_output_dir / raw_id / f"{reference_date}-{raw_id}.parquet" if is_local else self.model_output_dir / raw_id / f"{reference_date}-{raw_id}.parquet",
            self.local_output_dir / raw_id / f"{reference_date}-{raw_id}.csv" if is_local else self.model_output_dir / raw_id / f"{reference_date}-{raw_id}.csv",
            self.model_output_dir / raw_id / f"{reference_date}-{raw_id}.parquet",
            self.model_output_dir / raw_id / f"{reference_date}-{raw_id}.csv",
            self.local_output_dir / raw_id / f"{reference_date}-{raw_id}.parquet",
            self.local_output_dir / raw_id / f"{reference_date}-{raw_id}.csv",
        ]
        file_path = next((c for c in candidates if c.exists()), None)
        if file_path is None:
            return None

        try:
            if file_path.suffix == ".parquet":
                df = pl.read_parquet(file_path)
            else:
                df = pl.read_csv(
                    file_path,
                    schema_overrides={
                        "location": pl.String,
                        "horizon": pl.Int32,
                        "output_type_id": pl.String,
                        "value": pl.Float64,
                        "reference_date": pl.String,
                        "target_end_date": pl.String,
                    },
                    null_values=NULL_VALUES,
                    ignore_errors=False,
                )
            if "reference_date" not in df.columns:
                df = df.with_columns(pl.lit(reference_date).alias("reference_date"))
            else:
                df = df.with_columns(pl.col("reference_date").cast(pl.String))
            df = filter_quantile_rows(df)
            return df if as_polars else _safe_to_pandas(df)
        except Exception as exc:
            logger.warning("Error reading %s: %s", file_path, exc)
            return None

    def load_combined_forecasts(
        self, model_id: str, dates: Optional[List[str]] = None, as_polars: bool = True
    ) -> Optional[Any]:
        """Load and concatenate forecasts for a model across specified dates via fast Parquet cache or Synthetic engine."""
        models = self.scan_models()
        if model_id not in models and not model_id.startswith("local:"):
            return None

        if hasattr(self, "ensemble_mgr") and self.ensemble_mgr.get_config(model_id):
            available_dates = set(models.get(model_id, {}).get("dates", []))
            if dates is None:
                eval_dates = sorted(list(available_dates))
            else:
                eval_dates = sorted([d for d in dates if d in available_dates])
            if not eval_dates:
                return None
            df = self.ensemble_mgr.get_forecasts(model_id, dates=eval_dates)
            if df is not None and not df.is_empty():
                sub = df.filter(pl.col("reference_date").is_in(eval_dates))
                return sub if as_polars else _safe_to_pandas(sub)
            return None

        raw_id, is_local = self._resolve_model_id_and_local(model_id)
        available_dates = set(models.get(model_id, {}).get("dates", []))
        if not available_dates and raw_id in models:
            available_dates = set(models[raw_id].get("dates", []))

        if dates is None:
            eval_dates = tuple(sorted(available_dates))
        else:
            eval_dates = tuple(sorted(d for d in dates if d in available_dates))

        if not eval_dates:
            return None

        lf = self.cache_mgr.scan_model(raw_id, is_local=is_local)

        if lf is not None:
            sub = lf.filter(pl.col("reference_date").is_in(eval_dates)).collect()
            if not sub.is_empty():
                return sub if as_polars else _safe_to_pandas(sub)

        # Fallback to loading date files individually
        dfs = []
        for d in eval_dates:
            f_df = self.load_forecast_file(model_id, d, as_polars=True)
            if f_df is not None and not f_df.is_empty():
                dfs.append(f_df)

        if not dfs:
            return None

        combined = pl.concat(dfs, how="diagonal")
        return combined if as_polars else _safe_to_pandas(combined)

    def register_synthetic_ensemble(self, config: SyntheticEnsembleConfig) -> SyntheticEnsembleConfig:
        """Register a new synthetic ensemble and invalidate model cache."""
        res = self.ensemble_mgr.register_ensemble(config)
        with self._models_cache_lock:
            self._models_cache = None
            self._models_cache_mtime = -1.0
        return res

    def remove_synthetic_ensemble(self, ensemble_id: str) -> bool:
        """Remove a session or persisted ensemble and invalidate model cache."""
        res = self.ensemble_mgr.remove_ensemble(ensemble_id)
        with self._models_cache_lock:
            self._models_cache = None
            self._models_cache_mtime = -1.0
        return res

    def save_synthetic_ensemble(self, ensemble_id: str) -> Dict[str, Any]:
        """Save a synthetic ensemble to disk and invalidate model cache."""
        res = self.ensemble_mgr.save_to_disk(ensemble_id)
        with self._models_cache_lock:
            self._models_cache = None
            self._models_cache_mtime = -1.0
        return res

    def get_ground_truth_series(
        self, target: str, location: str, reference_date: str, history_weeks: int = 16
    ) -> Dict[str, Any]:
        """
        Get ground truth time series with strict temporal alignment:
        - Past history: Known observations prior to the forecast window (< reference_date).
        - Forecast evaluation truth: Actual oracle outcomes covering the forecast horizons (target_end_date >= reference_date).
        - Anchor: Last historical point to allow continuous line connection.
        """
        lf_oracle = self.cache_mgr.scan_oracle()
        sub = pl.DataFrame()

        if lf_oracle is not None:
            o_filtered = (
                lf_oracle.filter((pl.col("target") == target) & (pl.col("location") == str(location)))
                .collect()
            )
            if not o_filtered.is_empty():
                if "as_of" in o_filtered.columns:
                    o_filtered = (
                        o_filtered.sort("as_of")
                        .group_by("target_end_date")
                        .last()
                    )
                sub = (
                    o_filtered.select(["target_end_date", "oracle_value"])
                    .drop_nulls()
                    .sort("target_end_date")
                )

        # Supplement with admissions surveillance ground truth for hospitalizations (covers back to 2020)
        if "hosp" in target.lower() or target == "wk inc flu hosp":
            lf_adm = self.cache_mgr.scan_admissions()
            if lf_adm is not None:
                adm_filtered = (
                    lf_adm.filter(pl.col("location") == str(location))
                    .select(["target_end_date", "oracle_value"])
                    .drop_nulls()
                    .collect()
                )
                if not adm_filtered.is_empty():
                    if sub.is_empty():
                        sub = adm_filtered.sort("target_end_date")
                    else:
                        existing_dates = set(sub["target_end_date"].to_list())
                        missing_adm = adm_filtered.filter(~pl.col("target_end_date").is_in(existing_dates))
                        if not missing_adm.is_empty():
                            sub = pl.concat([sub, missing_adm], how="vertical").sort("target_end_date")

        if sub.is_empty():
            return {
                "history": [],
                "future": [],
                "anchor": None,
                "season_remainder": [],
                "season_peak": 0.0,
                "peak_to_date": 0.0,
                "season_start_date": None,
                "season_end_date": None,
            }

        # Determine focal season bounds (exact MMWR week 31 start to week 30 end)
        try:
            s_str, _ = date_to_season_and_week(reference_date)
            focal_start_yr = int(s_str.split("/")[0])
            season_start_date, season_end_date = self.get_season_calendar_bounds(focal_start_yr)
        except Exception:
            season_start_date = "2000-01-01"
            season_end_date = "2099-12-31"

        # Focal season ground truth series
        season_sub = sub.filter(
            (pl.col("target_end_date") >= season_start_date) &
            (pl.col("target_end_date") <= season_end_date)
        )
        if season_sub.is_empty():
            season_sub = sub

        # History ends prior to reference_date and strictly bounded to focal season start
        history_df = season_sub.filter(
            (pl.col("target_end_date") < reference_date) &
            (pl.col("target_end_date") >= season_start_date)
        ).tail(history_weeks)

        # Future observations restricted to focal season
        future_all_df = season_sub.filter(
            (pl.col("target_end_date") >= reference_date) &
            (pl.col("target_end_date") <= season_end_date)
        )
        future_df = future_all_df.head(4)

        history_list = [
            {"date": str(r[0]), "value": float(r[1])}
            for r in history_df.select(["target_end_date", "oracle_value"]).iter_rows()
        ]
        future_list = [
            {"date": str(r[0]), "value": float(r[1])}
            for r in future_df.select(["target_end_date", "oracle_value"]).iter_rows()
        ]

        anchor = history_list[-1] if history_list else None

        season_remainder_list = []
        if future_df.height >= 1 and future_all_df.height > future_df.height:
            last_eval_date = str(future_df["target_end_date"][-1])
            remainder_df = future_all_df.filter(pl.col("target_end_date") >= last_eval_date)
            season_remainder_list = [
                {"date": str(r[0]), "value": float(r[1])}
                for r in remainder_df.select(["target_end_date", "oracle_value"]).iter_rows()
            ]

        # Calculate focal season true peak and peak to date
        all_season_vals = season_sub["oracle_value"].to_list() if not season_sub.is_empty() else []
        season_peak = max(all_season_vals) if all_season_vals else 0.0

        hist_vals = history_df["oracle_value"].to_list() if not history_df.is_empty() else []
        peak_to_date = max(hist_vals) if hist_vals else 0.0

        return {
            "history": history_list,
            "future": future_list,
            "anchor": anchor,
            "season_remainder": season_remainder_list,
            "season_peak": season_peak,
            "peak_to_date": peak_to_date,
            "season_start_date": season_start_date,
            "season_end_date": season_end_date,
        }

    def get_surveillance_streams(
        self,
        target: str = "wk inc flu hosp",
        location: str = "US",
        reference_date: Optional[str] = None,
        history_weeks: int = 24,
    ) -> Dict[str, Any]:
        """
        Load auxiliary surveillance streams (NSSP, ILINet, FluSurv-NET) and prior season waves
        for the given location and reference date window.
        """
        if not reference_date:
            reference_date = self.get_latest_reference_date() or datetime.now().strftime("%Y-%m-%d")
        result = {
            "location": location,
            "reference_date": reference_date,
            "nssp": {"available": False, "data": [], "unit": "% ED Visits", "label": "NSSP (% Flu ED Visits)"},
            "ilinet": {"available": False, "data": [], "unit": "Scaled ILI+", "label": "ILINet (ILI × % Lab-Pos)"},
            "flusurvnet": {"available": False, "data": [], "unit": "Rate per 100k", "label": "FluSurv-NET (Rate/100k)"},
            "prior_season": {"available": False, "data": [], "unit": "Hospitalizations", "label": "Prior Season (Aligned)"},
            "unrevised": {"available": False, "data": [], "unit": "Hospitalizations", "label": "As-of Reports"},
            "as_of": {"available": False, "data": [], "unit": "Hospitalizations", "label": "As-of Reports"},
            "historical_seasons": {},
        }

        try:
            ref_dt = datetime.strptime(reference_date, "%Y-%m-%d")
            window_start = (ref_dt - timedelta(weeks=history_weeks + 6)).strftime("%Y-%m-%d")
            window_end = (ref_dt + timedelta(weeks=12)).strftime("%Y-%m-%d")
        except Exception:
            window_start = "2020-01-01"
            window_end = "2030-01-01"
            ref_dt = None

        # 1. NSSP (% ED Visits) from oracle
        lf_oracle = self.cache_mgr.scan_oracle()
        if lf_oracle is not None:
            nssp_sub = (
                lf_oracle.filter(
                    (pl.col("target") == "wk inc flu prop ed visits")
                    & (pl.col("location") == str(location))
                    & (pl.col("target_end_date") >= window_start)
                    & (pl.col("target_end_date") <= window_end)
                )
                .collect()
            )
            if not nssp_sub.is_empty():
                if "as_of" in nssp_sub.columns:
                    nssp_sub = nssp_sub.sort("as_of").group_by("target_end_date").last()
                nssp_sub = nssp_sub.select(["target_end_date", "oracle_value"]).drop_nulls().sort("target_end_date")
                if not nssp_sub.is_empty():
                    nssp_data = [
                        {
                            "date": str(r[0]),
                            "value": float(r[1]),
                            "pct": round(float(r[1]) * 100, 2),
                        }
                        for r in nssp_sub.iter_rows()
                    ]
                    result["nssp"] = {
                        "available": True,
                        "data": nssp_data,
                        "unit": "% ED Visits",
                        "label": "NSSP (% Flu ED Visits)",
                        "peak": max(d["pct"] for d in nssp_data) if nssp_data else None,
                    }

        # 2. ILINet (Scaled Outpatient ILI x % Lab-Positive)
        lf_ili = self.cache_mgr.scan_ilinet()
        if lf_ili is not None:
            ili_sub = (
                lf_ili.filter(
                    (pl.col("location") == str(location))
                    & (pl.col("wk_end_date") >= window_start)
                    & (pl.col("wk_end_date") <= window_end)
                )
                .select(["wk_end_date", "inc"])
                .drop_nulls()
                .sort("wk_end_date")
                .collect()
            )
            if not ili_sub.is_empty():
                ili_data = [
                    {
                        "date": str(r[0]),
                        "pct": round(float(r[1]), 3),
                    }
                    for r in ili_sub.iter_rows()
                ]
                result["ilinet"] = {
                    "available": True,
                    "data": ili_data,
                    "unit": "Scaled ILI+",
                    "label": "ILINet (ILI × % Lab-Pos)",
                    "peak": max((d["pct"] for d in ili_data), default=None),
                }

        # 3. FluSurv-NET (Rate per 100k)
        lf_fsn = self.cache_mgr.scan_flusurvnet()
        if lf_fsn is not None:
            fsn_sub = (
                lf_fsn.filter(
                    (pl.col("location") == str(location))
                    & (pl.col("wk_end_date") >= window_start)
                    & (pl.col("wk_end_date") <= window_end)
                )
                .select(["wk_end_date", "inc"])
                .drop_nulls()
                .sort("wk_end_date")
                .collect()
            )
            if not fsn_sub.is_empty():
                fsn_data = [
                    {
                        "date": str(r[0]),
                        "rate": round(float(r[1]), 2),
                    }
                    for r in fsn_sub.iter_rows()
                ]
                result["flusurvnet"] = {
                    "available": True,
                    "data": fsn_data,
                    "unit": "Rate per 100k",
                    "label": "FluSurv-NET (Rate/100k)",
                    "peak": max((d["rate"] for d in fsn_data), default=None),
                }

        # 4. Historical Aligned Waves
        ref_season, _ = date_to_season_and_week(ref_dt) if ref_dt else (date_to_season_and_week(datetime.now())[0], 23)
        ref_start_year = int(ref_season.split("/")[0])

        ref_jan4 = date(ref_start_year, 1, 4)
        ref_start_sun = ref_jan4 - timedelta(days=(ref_jan4.weekday() + 1) % 7)
        ref_sun_wk31 = ref_start_sun + timedelta(weeks=30)
        ref_sat_wk31 = ref_sun_wk31 + timedelta(days=6)
        ref_calendar = {
            wk: (ref_sat_wk31 + timedelta(weeks=wk - 1)).strftime("%Y-%m-%d")
            for wk in range(1, 54)
        }

        # Load historical admissions
        lf_adm = self.cache_mgr.scan_admissions()
        if lf_adm is None:
            lf_oracle = self.cache_mgr.scan_oracle()
            if lf_oracle is not None:
                lf_adm = lf_oracle.filter(pl.col("target") == target)
        if lf_adm is not None:
            adm_all = (
                lf_adm.filter(pl.col("location") == str(location))
                .select(["target_end_date", "oracle_value"])
                .drop_nulls()
                .collect()
            )
            if not adm_all.is_empty():
                hist_rows_dict = {}
                for r in adm_all.iter_rows():
                    d_str = str(r[0])
                    v_val = float(r[1])
                    s_str, s_wk = date_to_season_and_week(d_str)
                    if s_str not in hist_rows_dict:
                        hist_rows_dict[s_str] = {}
                    hist_rows_dict[s_str][s_wk] = v_val

                sorted_hist_seasons = sorted(hist_rows_dict.keys(), reverse=True)
                for s_key in sorted_hist_seasons:
                    if s_key == ref_season:
                        continue
                    aligned_data = []
                    s_dict = hist_rows_dict[s_key]
                    for wk in range(1, 54):
                        if wk in s_dict and wk in ref_calendar:
                            aligned_data.append({
                                "date": ref_calendar[wk],
                                "value": round(s_dict[wk], 1),
                                "season_week": wk,
                            })
                    if aligned_data:
                        result["historical_seasons"][s_key] = {
                            "season": s_key,
                            "label": f"'{s_key[2:4]}–'{s_key[-2:]} Season",
                            "data": aligned_data,
                            "peak": max(d["value"] for d in aligned_data),
                        }

        # Prior season shortcut
        if result["historical_seasons"]:
            most_recent_prior = list(result["historical_seasons"].keys())[0]
            result["prior_season"] = {
                "available": True,
                "season": most_recent_prior,
                "label": result["historical_seasons"][most_recent_prior]["label"],
                "data": result["historical_seasons"][most_recent_prior]["data"],
                "unit": "Hospitalizations",
                "peak": result["historical_seasons"][most_recent_prior]["peak"],
            }

        # 5. Point-in-Time As-Of Surveillance Stream (capturing intermediate revisions up to reference_date)
        as_of_data = []
        chosen_as_of = None
        season_start = ref_calendar.get(1, window_start)

        lf_as_of = self.cache_mgr.scan_as_of_admissions()
        if lf_as_of is not None:
            try:
                avail_snaps = (
                    lf_as_of.filter(
                        (pl.col("target") == target)
                        & (pl.col("as_of") <= reference_date)
                    )
                    .select("as_of")
                    .unique()
                    .sort("as_of")
                    .collect()
                )["as_of"].to_list()

                if avail_snaps:
                    chosen_as_of = avail_snaps[-1]
                    snap_focal = (
                        lf_as_of.filter(
                            (pl.col("target") == target)
                            & (pl.col("as_of") == chosen_as_of)
                            & (pl.col("location") == str(location))
                            & (pl.col("target_end_date") >= season_start)
                            & (pl.col("target_end_date") < reference_date)
                        )
                        .select(["target_end_date", "oracle_value"])
                        .drop_nulls()
                        .sort("target_end_date")
                        .collect()
                    )
                    for r in snap_focal.iter_rows():
                        d_str = str(r[0])
                        v_val = float(r[1])
                        s_str, _ = date_to_season_and_week(d_str)
                        if s_str == ref_season:
                            as_of_data.append({
                                "date": d_str,
                                "value": round(v_val, 1),
                            })
            except Exception as exc:
                logger.warning("Failed querying as_of admissions: %s", exc)

        as_of_payload = {
            "available": len(as_of_data) > 0,
            "data": as_of_data,
            "label": f"Target as of {chosen_as_of}" if chosen_as_of else "As-of Reports",
            "as_of": chosen_as_of,
            "season": ref_season,
            "peak": max((d["value"] for d in as_of_data), default=None),
        }
        result["unrevised"] = as_of_payload
        result["as_of"] = as_of_payload

        return result

    def get_model_fan_data(
        self, model_id: str, target: str, location: str, reference_date: str
    ) -> Optional[Dict[str, Any]]:
        """
        Extract quantile fan data for plotting using fast Polars query:
        Returns target_end_dates, horizons, median, and 95%/80%/50% prediction intervals.
        """
        raw_id, is_local = self._resolve_model_id_and_local(model_id)
        lf = self.cache_mgr.scan_model(raw_id, is_local=is_local)

        if lf is None:
            df = self.load_forecast_file(model_id, reference_date, as_polars=True)
            if df is None or df.is_empty():
                return None
            sub = df.filter(
                (pl.col("target") == target)
                & (pl.col("location") == str(location))
                & (pl.col("horizon") >= 0)
                & (pl.col("output_type") == "quantile")
            )
        else:
            sub = (
                lf.filter(
                    (pl.col("reference_date") == reference_date)
                    & (pl.col("target") == target)
                    & (pl.col("location") == str(location))
                    & (pl.col("horizon") >= 0)
                    & (pl.col("output_type") == "quantile")
                )
                .collect()
            )

        if sub.is_empty():
            return None

        # Pivot quantiles
        piv = (
            sub.pivot(on="output_type_id", index=["target_end_date", "horizon"], values="value", aggregate_function="first")
            .sort("horizon")
        )

        if piv.is_empty():
            return None

        piv_cols = piv.columns

        def get_col_list(q_val: float) -> List[Optional[float]]:
            c = find_quantile_column(piv_cols, q_val)
            if c is not None and c in piv.columns:
                return [float(x) if x is not None and not np.isnan(x) else None for x in piv[c].to_list()]
            return [None] * len(piv)

        return {
            "model_id": model_id,
            "target_end_dates": [str(d) for d in piv["target_end_date"].to_list()],
            "horizons": [int(h) for h in piv["horizon"].to_list()],
            "median": get_col_list(0.5),
            "q95_lower": get_col_list(0.025),
            "q95_upper": get_col_list(0.975),
            "q80_lower": get_col_list(0.10),
            "q80_upper": get_col_list(0.90),
            "q50_lower": get_col_list(0.25),
            "q50_upper": get_col_list(0.75),
        }

    def _task_wis_lookup(self, forecast_df: pl.DataFrame, target: str) -> Dict[Tuple[str, str, int], float]:
        """True WIS per (location, reference_date, horizon) task, scored exactly as on the leaderboard."""
        sc = score_forecasts(
            forecast_df,
            self.get_oracle(as_polars=True),
            target=target,
            non_negative=self.config.is_target_non_negative(target),
            return_task_df=True,
        )
        if not sc:
            return {}
        return {
            (str(loc), str(rd), int(h)): float(w)
            for loc, rd, h, w in sc["task_df"].select(["location", "reference_date", "horizon", "wis"]).iter_rows()
            if w is not None
        }

    def get_spatial_data(
        self, target: str, reference_date: str, model_ids: List[str], horizon: Optional[Union[int, str]] = None
    ) -> Dict[str, Any]:
        """
        Extract multi-model spatial predictions, population-adjusted rates,
        growth trajectories, and evaluation metrics across all 50 states + DC + PR.
        """
        locations = self.get_locations()
        # Per-100k rates only make sense for counts; rate/proportion targets are already normalized
        per_100k = not self.config.get_target_metadata(target)["is_rate"]

        # Oracle truth
        lf_o = self.cache_mgr.scan_oracle()
        o_sub = pl.DataFrame()
        if lf_o is not None:
            o_sub = (
                lf_o.filter((pl.col("target") == target) & (pl.col("target_end_date") >= reference_date))
                .collect()
            )
            if not o_sub.is_empty():
                if "as_of" in o_sub.columns:
                    o_sub = o_sub.sort("as_of").group_by(["location", "target_end_date"]).last()
                o_sub = o_sub.select(["location", "target_end_date", "oracle_value"]).drop_nulls()

        states_data = {}
        for loc_id, loc_info in locations.items():
            if loc_id == "US":
                continue
            abbr = loc_info["abbreviation"]
            pop = loc_info.get("population")
            states_data[abbr] = {
                "fips": loc_id,
                "name": loc_info["name"],
                "population": pop,
                "truth": {},
                "truth_rate": {},
                "models": {},
            }

        if not o_sub.is_empty():
            for row in o_sub.iter_rows(named=True):
                loc = str(row["location"])
                if loc in locations and loc != "US":
                    abbr = locations[loc]["abbreviation"]
                    val = float(row["oracle_value"]) if row["oracle_value"] is not None and not np.isnan(row["oracle_value"]) else None
                    ted = str(row["target_end_date"])
                    pop = locations[loc].get("population") or 1
                    rate = round((val / pop) * 100000, 2) if per_100k and val is not None and pop > 1 else None
                    states_data[abbr]["truth"][ted] = val
                    states_data[abbr]["truth_rate"][ted] = rate

        available_horizons = set()
        dates_by_horizon = {}
        all_models_meta = self.scan_models()

        for mid in model_ids:
            is_local = all_models_meta.get(mid, {}).get("is_local", False) if mid in all_models_meta else False
            lf_m = self.cache_mgr.scan_model(mid, is_local=is_local)
            if lf_m is None:
                df_raw = self.load_forecast_file(mid, reference_date, as_polars=True)
                if df_raw is None or df_raw.is_empty():
                    continue
                sub = df_raw.filter(
                    (pl.col("target") == target)
                    & (pl.col("horizon") >= 0)
                    & (pl.col("output_type") == "quantile")
                )
            else:
                sub = (
                    lf_m.filter(
                        (pl.col("reference_date") == reference_date)
                        & (pl.col("target") == target)
                        & (pl.col("horizon") >= 0)
                        & (pl.col("output_type") == "quantile")
                    )
                    .collect()
                )

            if sub.is_empty():
                continue

            wis_lookup = self._task_wis_lookup(sub, target)

            piv = sub.pivot(
                on="output_type_id",
                index=["location", "horizon", "target_end_date"],
                values="value",
                aggregate_function="first",
            )

            piv_cols = piv.columns

            c_05 = find_quantile_column(piv_cols, 0.5)
            c_0025 = find_quantile_column(piv_cols, 0.025)
            c_0975 = find_quantile_column(piv_cols, 0.975)
            c_025 = find_quantile_column(piv_cols, 0.25)
            c_075 = find_quantile_column(piv_cols, 0.75)

            h0_medians = {}
            if c_05 is not None:
                h0_rows = piv.filter(pl.col("horizon") == 0).select(["location", c_05]).iter_rows()
                for loc, med in h0_rows:
                    if med is not None and not np.isnan(med):
                        h0_medians[str(loc)] = float(med)

            for row in piv.iter_rows(named=True):
                loc = str(row["location"])
                if loc not in locations or loc == "US":
                    continue
                abbr = locations[loc]["abbreviation"]
                h = int(row["horizon"])
                ted = str(row["target_end_date"])
                available_horizons.add(h)
                dates_by_horizon[h] = ted

                med = float(row[c_05]) if c_05 and row[c_05] is not None and not np.isnan(row[c_05]) else None
                q025 = float(row[c_0025]) if c_0025 and row[c_0025] is not None and not np.isnan(row[c_0025]) else None
                q975 = float(row[c_0975]) if c_0975 and row[c_0975] is not None and not np.isnan(row[c_0975]) else None
                q25 = float(row[c_025]) if c_025 and row[c_025] is not None and not np.isnan(row[c_025]) else None
                q75 = float(row[c_075]) if c_075 and row[c_075] is not None and not np.isnan(row[c_075]) else None
                wis = wis_lookup.get((loc, reference_date, h))

                pop = locations[loc].get("population") or 1
                rate = round((med / pop) * 100000, 2) if per_100k and med is not None and pop > 1 else None

                h0_val = h0_medians.get(loc)
                trend_pct = None
                if med is not None and h0_val is not None and h0_val > 0:
                    trend_pct = round(((med - h0_val) / h0_val) * 100, 1)

                truth_val = states_data[abbr]["truth"].get(ted)
                error = round(med - truth_val, 1) if med is not None and truth_val is not None else None

                if mid not in states_data[abbr]["models"]:
                    states_data[abbr]["models"][mid] = {}

                states_data[abbr]["models"][mid][h] = {
                    "median": round(med, 1) if med is not None else None,
                    "rate_per_100k": rate,
                    "q025": round(q025, 1) if q025 is not None else None,
                    "q975": round(q975, 1) if q975 is not None else None,
                    "q25": round(q25, 1) if q25 is not None else None,
                    "q75": round(q75, 1) if q75 is not None else None,
                    "trend_pct": trend_pct,
                    "wis": round(wis, 2) if wis is not None else None,
                    "error": error,
                    "target_end_date": ted,
                }

        sorted_horizons = sorted(list(available_horizons))
        return {
            "target": target,
            "reference_date": reference_date,
            "horizons": sorted_horizons,
            "dates_by_horizon": dates_by_horizon,
            "states": states_data,
            "selected_horizon": horizon if horizon is not None and horizon != "all" else None,
        }

    def get_heatmap_data(
        self,
        mode: Optional[str] = None,
        rows: Optional[str] = None,
        cols: Optional[str] = None,
        target: Optional[str] = None,
        metric: str = "rate",
        location: str = "states",
        reference_date: Optional[str] = None,
        date: Optional[str] = None,
        season: Optional[str] = None,
        horizon: Optional[Union[int, str]] = 1,
        model_id: Optional[str] = None,
        model: Optional[str] = None,
        model_ids: Optional[List[str]] = None,
        models: Optional[List[str]] = None,
        sort_by: str = "hhs_region",
        normalize: str = "none",
        include_inactive: Union[bool, str] = False,
    ) -> Dict[str, Any]:
        """
        Extract multi-dimensional matrix cross-sections for heatmap visualization:
        Directly driven by user-selected ROWS and COLS (Location, Model, Date, Horizon),
        with exact Leaderboard parity for TIME (Date, Season, Custom Seasons, All Time)
        and LOC (All States vs Single Location).
        """
        if isinstance(include_inactive, str):
            include_inactive = include_inactive.lower() in ("1", "true", "yes")
        else:
            include_inactive = bool(include_inactive)
        reference_date = reference_date or date
        model_id = model_id or model
        model_ids = model_ids or models

        target = target or self.config.get_default_target()
        locations = self.get_locations()
        all_models_meta = self.scan_models()
        # Per-100k rates only make sense for counts; rate/proportion targets are already normalized
        is_rate_target = self.config.get_target_metadata(target)["is_rate"]

        def per_100k(val: Optional[float], pop: int) -> Optional[float]:
            return round((val / pop) * 100000, 2) if not is_rate_target and val is not None and pop > 1 else None

        # Parse horizon integer if given
        h_int = 1
        if horizon is not None and str(horizon).isdigit():
            h_int = int(horizon)

        # -------------------------------------------------------------
        # Axis Resolution & Transpose Mapping
        # -------------------------------------------------------------
        transpose_needed = False
        if rows and cols:
            r = rows.lower().strip()
            c = cols.lower().strip()
            if (r, c) == ("location", "date"):
                mode = "wave"
            elif (r, c) == ("date", "location"):
                mode = "wave"
                transpose_needed = True
            elif (r, c) == ("location", "horizon"):
                mode = "horizon"
            elif (r, c) == ("horizon", "location"):
                mode = "horizon"
                transpose_needed = True
            elif (r, c) == ("model", "location"):
                mode = "model_loc"
            elif (r, c) == ("location", "model"):
                mode = "model_loc"
                transpose_needed = True
            elif (r, c) == ("model", "horizon"):
                mode = "model_h"
            elif (r, c) == ("horizon", "model"):
                mode = "model_h"
                transpose_needed = True
            elif (r, c) == ("model", "date"):
                mode = "model_date"
            elif (r, c) == ("date", "model"):
                mode = "model_date"
                transpose_needed = True
            elif (r, c) == ("date", "horizon"):
                mode = "date_h"
            elif (r, c) == ("horizon", "date"):
                mode = "date_h"
                transpose_needed = True
            else:
                mode = "wave"
        else:
            mode = mode or "wave"
            if mode == "wave":
                rows, cols = "location", "date"
            elif mode == "horizon":
                rows, cols = "location", "horizon"
            elif mode == "model_loc":
                rows, cols = "model", "location"
            elif mode == "model_h":
                rows, cols = "model", "horizon"
            elif mode == "model_date":
                rows, cols = "model", "date"
            elif mode == "date_h":
                rows, cols = "date", "horizon"
            else:
                rows, cols = "location", "date"

        # -------------------------------------------------------------
        # Jurisdiction Filter (All States vs Single Location / Region)
        # -------------------------------------------------------------
        all_state_items = [(abbr, loc_id, info) for loc_id, info in locations.items() if (abbr := info.get("abbreviation")) and loc_id != "US"]
        
        def resolve_state_items(loc_param: Optional[str]) -> List[Tuple[str, str, Dict[str, Any]]]:
            if not loc_param or loc_param.lower() in ("states", "all", ""):
                return all_state_items
            p = loc_param.strip()
            # HHS Region
            if p.lower().startswith("region "):
                try:
                    reg_num = int(p.split(" ")[1])
                    reg_states = set(HHS_REGIONS.get(reg_num, {}).get("states", []))
                    matched = [item for item in all_state_items if item[0] in reg_states]
                    if matched:
                        return matched
                except Exception:
                    pass
            # Abbreviation match (e.g. "CA", "MA")
            matched_abbr = [item for item in all_state_items if item[0].upper() == p.upper()]
            if matched_abbr:
                return matched_abbr
            # FIPS ID match (e.g. "06", "25")
            matched_fips = [item for item in all_state_items if item[1] == p]
            if matched_fips:
                return matched_fips
            # "US" National
            if p.upper() == "US" and "US" in locations:
                return [("US", "US", locations["US"])]
            return all_state_items

        state_items = resolve_state_items(location)
        abbr_to_fips = {abbr: loc_id for abbr, loc_id, _ in state_items}
        abbr_to_pop = {abbr: (info.get("population") or 1) for abbr, _, info in state_items}
        abbr_to_name = {abbr: info.get("name", abbr) for abbr, _, info in state_items}

        # -------------------------------------------------------------
        # Temporal Scope (Date, Season, Custom Seasons, All Time)
        # -------------------------------------------------------------
        all_dates = self.get_available_dates(target)
        if season and season != "all":
            if season == "current":
                focal_season = self.get_flu_season_for_date(all_dates[-1]) if all_dates else "2024-2025"
                seasons_set = {focal_season}
            else:
                seasons_set = {s.strip() for s in season.split(",") if s.strip()}
            scope_dates = [d for d in all_dates if self.get_flu_season_for_date(d) in seasons_set]
            if not scope_dates:
                for s in seasons_set:
                    scope_dates.extend(self.get_dates_for_season(s) or [])
                scope_dates = [d for d in scope_dates if d in all_dates]
                if not scope_dates:
                    scope_dates = all_dates
        elif reference_date and reference_date != "all":
            scope_dates = [reference_date] if reference_date in all_dates else ([all_dates[-1]] if all_dates else [])
        else:
            scope_dates = all_dates

        scope_dates = sorted(list(set(scope_dates)))
        if not scope_dates and all_dates:
            scope_dates = all_dates

        # -------------------------------------------------------------
        # Mode 1: Spatio-Temporal Wave Matrix (Location x Date)
        # -------------------------------------------------------------
        if mode == "wave":
            if not scope_dates or not state_items:
                return {
                    "mode": mode, "rows": rows, "cols": cols, "target": target, "location": location,
                    "metric": metric, "x_labels": [], "x_keys": [], "y_labels": [], "y_keys": [],
                    "matrix": [], "raw_matrix": [], "text_matrix": [], "cell_meta": {}, "summary": {},
                    "row_groups": [], "sort_by": sort_by, "normalize": normalize,
                }

            # Container for cell values: [abbr][date] -> dict
            grid_data: Dict[str, Dict[str, Dict[str, Any]]] = {abbr: {} for abbr, _, _ in state_items}

            # Is this ground truth or model forecast?
            is_truth_mode = (not model_id) or (model_id.lower() in ("truth", "oracle", "none"))

            if is_truth_mode:
                lf_o = self.cache_mgr.scan_oracle()
                if lf_o is not None:
                    target_locs = [loc_id for _, loc_id, _ in state_items]
                    df_o = (
                        lf_o.filter((pl.col("target") == target) & pl.col("target_end_date").is_in(scope_dates) & pl.col("location").is_in(target_locs))
                        .select(["location", "target_end_date", "oracle_value"])
                        .collect()
                    )
                    for row in df_o.iter_rows(named=True):
                        loc = str(row["location"])
                        ted = str(row["target_end_date"])
                        val = float(row["oracle_value"]) if row["oracle_value"] is not None and not np.isnan(row["oracle_value"]) else None
                        if loc in locations:
                            abbr = locations[loc].get("abbreviation", loc)
                            if abbr in grid_data:
                                pop = abbr_to_pop.get(abbr, 1)
                                rate = per_100k(val, pop)
                                grid_data[abbr][ted] = {
                                    "truth": val,
                                    "rate": rate,
                                    "count": val,
                                    "trend": None,
                                    "wis": None,
                                    "pop": pop,
                                    "name": abbr_to_name.get(abbr, abbr),
                                }
            else:
                raw_mid, is_loc = self._resolve_model_id_and_local(model_id)
                lf_m = self.cache_mgr.scan_model(raw_mid, is_local=is_loc)
                lf_o = self.cache_mgr.scan_oracle()
                df_o_map: Dict[Tuple[str, str], float] = {}
                target_locs = [loc_id for _, loc_id, _ in state_items]
                if lf_o is not None:
                    df_o = lf_o.filter((pl.col("target") == target) & pl.col("location").is_in(target_locs)).select(["location", "target_end_date", "oracle_value"]).collect()
                    for r in df_o.iter_rows(named=True):
                        if r["oracle_value"] is not None and not np.isnan(r["oracle_value"]):
                            df_o_map[(str(r["location"]), str(r["target_end_date"]))] = float(r["oracle_value"])

                if lf_m is not None:
                    sub = (
                        lf_m.filter(
                            (pl.col("target") == target)
                            & (pl.col("horizon") == h_int)
                            & (pl.col("output_type") == "quantile")
                            & pl.col("reference_date").is_in(scope_dates)
                            & pl.col("location").is_in(target_locs)
                        )
                        .collect()
                    )
                    if not sub.is_empty():
                        wis_lookup = self._task_wis_lookup(sub, target)
                        piv = sub.pivot(
                            on="output_type_id",
                            index=["location", "reference_date", "target_end_date"],
                            values="value",
                            aggregate_function="first",
                        )
                        cols_p = piv.columns
                        c_05 = find_quantile_column(cols_p, 0.5)
                        c_0025 = find_quantile_column(cols_p, 0.025)
                        c_0975 = find_quantile_column(cols_p, 0.975)

                        for row in piv.iter_rows(named=True):
                            loc = str(row["location"])
                            rd = str(row["reference_date"])
                            ted = str(row["target_end_date"])
                            if loc in locations:
                                abbr = locations[loc].get("abbreviation", loc)
                                if abbr in grid_data:
                                    med = float(row[c_05]) if c_05 and row[c_05] is not None and not np.isnan(row[c_05]) else None
                                    q025 = float(row[c_0025]) if c_0025 and row[c_0025] is not None and not np.isnan(row[c_0025]) else None
                                    q975 = float(row[c_0975]) if c_0975 and row[c_0975] is not None and not np.isnan(row[c_0975]) else None
                                    pop = abbr_to_pop.get(abbr, 1)
                                    rate = per_100k(med, pop)
                                    truth_val = df_o_map.get((loc, ted))
                                    wis = wis_lookup.get((loc, rd, h_int))

                                    grid_data[abbr][rd] = {
                                        "median": med,
                                        "rate": rate,
                                        "count": med,
                                        "q025": q025,
                                        "q975": q975,
                                        "truth": truth_val,
                                        "error": round(med - truth_val, 1) if (med is not None and truth_val is not None) else None,
                                        "wis": wis,
                                        "pop": pop,
                                        "name": abbr_to_name.get(abbr, abbr),
                                    }

            # Compute week-over-week trend for each state across dates
            for abbr, date_map in grid_data.items():
                prev_val = None
                for d in scope_dates:
                    cell = date_map.get(d)
                    if cell is not None:
                        val = cell.get("count") if is_truth_mode else cell.get("median")
                        if val is not None and prev_val is not None and prev_val > 0:
                            cell["trend"] = round(((val - prev_val) / prev_val) * 100, 1)
                        else:
                            cell["trend"] = None
                        if val is not None:
                            prev_val = val

            x_keys = scope_dates
            x_labels = [d for d in scope_dates]
            y_keys = [abbr for abbr, _, _ in state_items]
            y_labels = [abbr_to_name.get(abbr, abbr) if abbr != "US" else "US National" for abbr in y_keys]

            raw_matrix: List[List[Optional[float]]] = []
            cell_meta: Dict[str, Dict[str, Any]] = {}

            for abbr in y_keys:
                row_vals: List[Optional[float]] = []
                r_id = STATE_TO_HHS_REGION.get(abbr, 99)
                reg_name = HHS_REGIONS.get(r_id, {}).get("name", "Other")

                for d in x_keys:
                    c = grid_data.get(abbr, {}).get(d)
                    val = None
                    if c is not None:
                        if metric == "rate":
                            val = c.get("rate")
                        elif metric == "count":
                            val = c.get("count")
                        elif metric == "trend":
                            val = c.get("trend")
                        elif metric == "wis":
                            val = c.get("wis")
                        elif metric == "error":
                            val = c.get("error")
                        else:
                            val = c.get("rate")

                    row_vals.append(val)
                    cell_key = f"{abbr}:{d}"
                    cell_meta[cell_key] = {
                        "row": abbr,
                        "row_name": abbr_to_name.get(abbr, abbr),
                        "col": d,
                        "region_id": r_id,
                        "region_name": reg_name,
                        "metric_name": metric,
                        "metric_value": val,
                        "population": abbr_to_pop.get(abbr),
                        **(c or {}),
                    }
                raw_matrix.append(row_vals)

        # -------------------------------------------------------------
        # Mode 2: Forward Horizon Outlook (Location x Horizon)
        # -------------------------------------------------------------
        elif mode == "horizon":
            ref_date = reference_date or (scope_dates[-1] if scope_dates else (self.get_available_dates(target)[-1] if self.get_available_dates(target) else ""))
            m_target = model_id or (model_ids[0] if model_ids else "FluSight-baseline")
            raw_mid, is_loc = self._resolve_model_id_and_local(m_target)

            lf_m = self.cache_mgr.scan_model(raw_mid, is_local=is_loc)
            lf_o = self.cache_mgr.scan_oracle()

            horizons = [0, 1, 2, 3]
            x_keys = [str(h) for h in horizons]
            x_labels = [f"h={h}" + (" (Nowcast)" if h == 0 else f" (+{h} Wk)") for h in horizons]
            y_keys = [abbr for abbr, _, _ in state_items]
            y_labels = [abbr_to_name.get(abbr, abbr) if abbr != "US" else "US National" for abbr in y_keys]

            h_grid: Dict[str, Dict[int, Dict[str, Any]]] = {abbr: {} for abbr in y_keys}

            df_o_map: Dict[Tuple[str, str], float] = {}
            target_locs = [loc_id for _, loc_id, _ in state_items]
            if lf_o is not None:
                df_o = lf_o.filter((pl.col("target") == target) & (pl.col("target_end_date") >= ref_date) & pl.col("location").is_in(target_locs)).select(["location", "target_end_date", "oracle_value"]).collect()
                for r in df_o.iter_rows(named=True):
                    if r["oracle_value"] is not None and not np.isnan(r["oracle_value"]):
                        df_o_map[(str(r["location"]), str(r["target_end_date"]))] = float(r["oracle_value"])

            if lf_m is not None:
                sub = (
                    lf_m.filter(
                        (pl.col("target") == target)
                        & (pl.col("reference_date") == ref_date)
                        & (pl.col("output_type") == "quantile")
                        & pl.col("location").is_in(target_locs)
                    )
                    .collect()
                )
                if not sub.is_empty():
                    wis_lookup = self._task_wis_lookup(sub, target)
                    piv = sub.pivot(
                        on="output_type_id",
                        index=["location", "horizon", "target_end_date"],
                        values="value",
                        aggregate_function="first",
                    )
                    cols_p = piv.columns
                    c_05 = find_quantile_column(cols_p, 0.5)
                    c_0025 = find_quantile_column(cols_p, 0.025)
                    c_0975 = find_quantile_column(cols_p, 0.975)

                    h0_medians: Dict[str, float] = {}
                    if c_05 is not None:
                        for loc, h, med in piv.select(["location", "horizon", c_05]).iter_rows():
                            if int(h) == 0 and med is not None and not np.isnan(med):
                                h0_medians[str(loc)] = float(med)

                    for row in piv.iter_rows(named=True):
                        loc = str(row["location"])
                        h = int(row["horizon"])
                        ted = str(row["target_end_date"])
                        if loc in locations:
                            abbr = locations[loc].get("abbreviation", loc)
                            med = float(row[c_05]) if c_05 and row[c_05] is not None and not np.isnan(row[c_05]) else None
                            q025 = float(row[c_0025]) if c_0025 and row[c_0025] is not None and not np.isnan(row[c_0025]) else None
                            q975 = float(row[c_0975]) if c_0975 and row[c_0975] is not None and not np.isnan(row[c_0975]) else None
                            pop = abbr_to_pop.get(abbr, 1)
                            rate = per_100k(med, pop)

                            h0_val = h0_medians.get(loc)
                            trend_pct = round(((med - h0_val) / h0_val) * 100, 1) if (med is not None and h0_val is not None and h0_val > 0) else (0.0 if h == 0 else None)

                            truth_val = df_o_map.get((loc, ted))
                            wis = wis_lookup.get((loc, ref_date, h))

                            if abbr in h_grid:
                                h_grid[abbr][h] = {
                                    "median": med,
                                    "rate": rate,
                                    "count": med,
                                    "trend": trend_pct,
                                    "q025": q025,
                                    "q975": q975,
                                    "wis": wis,
                                    "error": round(med - truth_val, 1) if (med is not None and truth_val is not None) else None,
                                    "truth": truth_val,
                                    "target_end_date": ted,
                                    "pop": pop,
                                    "name": abbr_to_name.get(abbr, abbr),
                                }

            raw_matrix = []
            cell_meta = {}
            for abbr in y_keys:
                row_vals = []
                r_id = STATE_TO_HHS_REGION.get(abbr, 99)
                reg_name = HHS_REGIONS.get(r_id, {}).get("name", "Other")

                for h in horizons:
                    c = h_grid.get(abbr, {}).get(h)
                    val = None
                    if c is not None:
                        if metric == "rate":
                            val = c.get("rate")
                        elif metric == "count":
                            val = c.get("median")
                        elif metric == "trend":
                            val = c.get("trend")
                        elif metric == "wis":
                            val = c.get("wis")
                        elif metric == "error":
                            val = c.get("error")
                        else:
                            val = c.get("rate")

                    row_vals.append(val)
                    cell_key = f"{abbr}:{h}"
                    cell_meta[cell_key] = {
                        "row": abbr,
                        "row_name": abbr_to_name.get(abbr, abbr),
                        "col": str(h),
                        "col_label": f"h={h}",
                        "horizon": h,
                        "region_id": r_id,
                        "region_name": reg_name,
                        "metric_name": metric,
                        "metric_value": val,
                        **(c or {}),
                    }
                raw_matrix.append(row_vals)

        # -------------------------------------------------------------
        # Mode: Date x Horizon (Timeline Progression Across Horizons)
        # -------------------------------------------------------------
        elif mode == "date_h":
            m_target = model_id or (model_ids[0] if model_ids else "FluSight-baseline")
            raw_mid, is_loc = self._resolve_model_id_and_local(m_target)
            fips = state_items[0][1] if state_items else "US"
            abbr = state_items[0][0] if state_items else "US"
            pop = abbr_to_pop.get(abbr, 1) if state_items else 1

            lf_m = self.cache_mgr.scan_model(raw_mid, is_local=is_loc)
            lf_o = self.cache_mgr.scan_oracle()
            df_o_map: Dict[str, float] = {}
            if lf_o is not None:
                df_o = lf_o.filter((pl.col("target") == target) & (pl.col("location") == fips)).select(["target_end_date", "oracle_value"]).collect()
                for r in df_o.iter_rows(named=True):
                    if r["oracle_value"] is not None and not np.isnan(r["oracle_value"]):
                        df_o_map[str(r["target_end_date"])] = float(r["oracle_value"])

            horizons = [0, 1, 2, 3]
            x_keys = [str(h) for h in horizons]
            x_labels = [f"h={h}" + (" (Nowcast)" if h == 0 else f" (+{h} Wk)") for h in horizons]
            y_keys = scope_dates
            y_labels = [d for d in scope_dates]

            dh_grid: Dict[str, Dict[int, Dict[str, Any]]] = {d: {} for d in scope_dates}
            if lf_m is not None:
                sub = (
                    lf_m.filter(
                        (pl.col("target") == target)
                        & (pl.col("location") == fips)
                        & (pl.col("output_type") == "quantile")
                        & pl.col("reference_date").is_in(scope_dates)
                    )
                    .collect()
                )
                if not sub.is_empty():
                    wis_lookup = self._task_wis_lookup(sub, target)
                    piv = sub.pivot(
                        on="output_type_id",
                        index=["reference_date", "horizon", "target_end_date"],
                        values="value",
                        aggregate_function="first",
                    )
                    cols_p = piv.columns
                    c_05 = find_quantile_column(cols_p, 0.5)
                    c_0025 = find_quantile_column(cols_p, 0.025)
                    c_0975 = find_quantile_column(cols_p, 0.975)

                    for row in piv.iter_rows(named=True):
                        rd = str(row["reference_date"])
                        h = int(row["horizon"])
                        ted = str(row["target_end_date"])
                        med = float(row[c_05]) if c_05 and row[c_05] is not None and not np.isnan(row[c_05]) else None
                        q025 = float(row[c_0025]) if c_0025 and row[c_0025] is not None and not np.isnan(row[c_0025]) else None
                        q975 = float(row[c_0975]) if c_0975 and row[c_0975] is not None and not np.isnan(row[c_0975]) else None
                        rate = per_100k(med, pop)
                        truth_val = df_o_map.get(ted)
                        wis = wis_lookup.get((fips, rd, h))

                        if rd in dh_grid:
                            dh_grid[rd][h] = {
                                "median": med,
                                "rate": rate,
                                "count": med,
                                "truth": truth_val,
                                "wis": wis,
                                "error": round(med - truth_val, 1) if (med is not None and truth_val is not None) else None,
                            }

            raw_matrix = []
            cell_meta = {}
            for rd in y_keys:
                row_vals = []
                for h in horizons:
                    c = dh_grid.get(rd, {}).get(h)
                    val = None
                    if c is not None:
                        if metric == "rate":
                            val = c.get("rate")
                        elif metric == "count":
                            val = c.get("median")
                        elif metric == "wis":
                            val = c.get("wis")
                        elif metric == "error":
                            val = c.get("error")
                        else:
                            val = c.get("rate")
                    row_vals.append(val)
                    cell_key = f"{rd}:{h}"
                    cell_meta[cell_key] = {
                        "row": rd,
                        "col": str(h),
                        "col_label": f"h={h}",
                        "horizon": h,
                        "reference_date": rd,
                        "metric_name": metric,
                        "metric_value": val,
                        **(c or {}),
                    }
                raw_matrix.append(row_vals)

        # -------------------------------------------------------------
        # Mode 3, 4, 5: Model Comparisons (Model x Location, Model x H, Model x Date)
        # -------------------------------------------------------------
        else:
            cand_mids = model_ids if (model_ids and len(model_ids) > 0) else list(all_models_meta.keys())
            if not cand_mids:
                cand_mids = ["FluSight-baseline"]

            oracle = self.get_oracle(as_polars=True)
            pop_map = None if is_rate_target else {loc: info["population"] for loc, info in locations.items() if info.get("population")}
            target_non_neg = self.config.is_target_non_negative(target)

            target_loc_fips = {loc_id for _, loc_id, _ in state_items}

            # Task dataframes scored for each model
            model_task_dfs: Dict[str, pl.DataFrame] = {}
            for mid in cand_mids:
                raw_id, is_loc = self._resolve_model_id_and_local(mid)
                lf = self.cache_mgr.scan_model(raw_id, is_local=is_loc)
                if lf is None or oracle is None or oracle.is_empty():
                    continue
                sc = score_forecasts(
                    lf.collect(),
                    oracle,
                    target=target,
                    reference_dates=scope_dates,
                    non_negative=target_non_neg,
                    population_map=pop_map,
                    return_task_df=True,
                )
                if sc and "task_df" in sc and sc["task_df"] is not None:
                    # Restrict to the requested jurisdictions (all states excludes US national, as on the leaderboard)
                    model_task_dfs[mid] = sc["task_df"].filter(pl.col("location").is_in(list(target_loc_fips)))

            y_keys = cand_mids
            y_labels = [f"{mid} {'[LOCAL]' if all_models_meta.get(mid, {}).get('is_local') else ''}".strip() for mid in cand_mids]

            if mode == "model_loc":
                loc_to_abbr = {loc_id: abbr for abbr, loc_id, _ in state_items}
                x_keys = [abbr for abbr, _, _ in state_items]
                x_labels = [abbr_to_name.get(abbr, abbr) if abbr != "US" else "US National" for abbr in x_keys]

                raw_matrix = []
                cell_meta = {}

                for mid in y_keys:
                    tdf = model_task_dfs.get(mid)
                    loc_metrics: Dict[str, Dict[str, float]] = {}
                    if tdf is not None and not tdf.is_empty():
                        agg = tdf.group_by("location").agg([
                            pl.col("wis").mean().alias("wis"),
                            pl.col("wis_per_100k").mean().alias("wis_rate"),
                            pl.col("mae").mean().alias("mae") if "mae" in tdf.columns else pl.lit(None).alias("mae"),
                            pl.col("cov95").mean().alias("cov95") if "cov95" in tdf.columns else pl.lit(None).alias("cov95"),
                            pl.col("sharpness").mean().alias("sharpness") if "sharpness" in tdf.columns else pl.lit(None).alias("sharpness"),
                            pl.len().alias("task_count"),
                        ])
                        for row in agg.iter_rows(named=True):
                            loc = str(row["location"])
                            if loc in loc_to_abbr:
                                abbr = loc_to_abbr[loc]
                                loc_metrics[abbr] = {
                                    "wis": round(row["wis"], 2) if row["wis"] is not None and not np.isnan(row["wis"]) else None,
                                    "wis_rate": round(row["wis_rate"], 2) if row.get("wis_rate") is not None and not np.isnan(row["wis_rate"]) else None,
                                    "mae": round(row["mae"], 2) if row.get("mae") is not None and not np.isnan(row["mae"]) else None,
                                    "cov95": round(row["cov95"] * 100, 1) if row.get("cov95") is not None and not np.isnan(row["cov95"]) else None,
                                    "sharpness": round(row["sharpness"], 1) if row.get("sharpness") is not None and not np.isnan(row["sharpness"]) else None,
                                    "task_count": row.get("task_count", 0),
                                }

                    row_vals = []
                    for abbr in x_keys:
                        m_dict = loc_metrics.get(abbr, {})
                        val = m_dict.get(metric if metric in m_dict else "wis")
                        row_vals.append(val)
                        cell_key = f"{mid}:{abbr}"
                        cell_meta[cell_key] = {
                            "row": mid,
                            "col": abbr,
                            "location_name": abbr_to_name.get(abbr, abbr),
                            "metric_name": metric,
                            "metric_value": val,
                            **(m_dict or {}),
                        }
                    raw_matrix.append(row_vals)

            elif mode == "model_h":
                # X-axis: Horizons 0..3
                horizons = [0, 1, 2, 3]
                x_keys = [str(h) for h in horizons]
                x_labels = [f"h={h}" + (" (Nowcast)" if h == 0 else f" (+{h} Wk)") for h in horizons]

                raw_matrix = []
                cell_meta = {}

                for mid in y_keys:
                    tdf = model_task_dfs.get(mid)
                    h_metrics: Dict[int, Dict[str, float]] = {}
                    if tdf is not None and not tdf.is_empty():
                        agg = tdf.group_by("horizon").agg([
                            pl.col("wis").mean().alias("wis"),
                            pl.col("wis_per_100k").mean().alias("wis_rate"),
                            pl.col("mae").mean().alias("mae") if "mae" in tdf.columns else pl.lit(None).alias("mae"),
                            pl.col("cov95").mean().alias("cov95") if "cov95" in tdf.columns else pl.lit(None).alias("cov95"),
                            pl.col("sharpness").mean().alias("sharpness") if "sharpness" in tdf.columns else pl.lit(None).alias("sharpness"),
                            pl.len().alias("task_count"),
                        ])
                        for row in agg.iter_rows(named=True):
                            h = int(row["horizon"])
                            h_metrics[h] = {
                                "wis": round(row["wis"], 2) if row["wis"] is not None and not np.isnan(row["wis"]) else None,
                                "wis_rate": round(row["wis_rate"], 2) if row.get("wis_rate") is not None and not np.isnan(row["wis_rate"]) else None,
                                "mae": round(row["mae"], 2) if row.get("mae") is not None and not np.isnan(row["mae"]) else None,
                                "cov95": round(row["cov95"] * 100, 1) if row.get("cov95") is not None and not np.isnan(row["cov95"]) else None,
                                "sharpness": round(row["sharpness"], 1) if row.get("sharpness") is not None and not np.isnan(row["sharpness"]) else None,
                                "task_count": row.get("task_count", 0),
                            }

                    row_vals = []
                    for h in horizons:
                        m_dict = h_metrics.get(h, {})
                        val = m_dict.get(metric if metric in m_dict else "wis")
                        row_vals.append(val)
                        cell_key = f"{mid}:{h}"
                        cell_meta[cell_key] = {
                            "row": mid,
                            "col": str(h),
                            "horizon": h,
                            "metric_name": metric,
                            "metric_value": val,
                            **(m_dict or {}),
                        }
                    raw_matrix.append(row_vals)

            else:  # mode == "model_date"
                # X-axis: Dates across season
                x_keys = scope_dates
                x_labels = [d for d in scope_dates]

                raw_matrix = []
                cell_meta = {}

                for mid in y_keys:
                    tdf = model_task_dfs.get(mid)
                    d_metrics: Dict[str, Dict[str, float]] = {}
                    if tdf is not None and not tdf.is_empty():
                        agg = tdf.group_by("reference_date").agg([
                            pl.col("wis").mean().alias("wis"),
                            pl.col("wis_per_100k").mean().alias("wis_rate"),
                            pl.col("mae").mean().alias("mae") if "mae" in tdf.columns else pl.lit(None).alias("mae"),
                            pl.col("cov95").mean().alias("cov95") if "cov95" in tdf.columns else pl.lit(None).alias("cov95"),
                            pl.col("sharpness").mean().alias("sharpness") if "sharpness" in tdf.columns else pl.lit(None).alias("sharpness"),
                            pl.len().alias("task_count"),
                        ])
                        for row in agg.iter_rows(named=True):
                            rd = str(row["reference_date"])
                            d_metrics[rd] = {
                                "wis": round(row["wis"], 2) if row["wis"] is not None and not np.isnan(row["wis"]) else None,
                                "wis_rate": round(row["wis_rate"], 2) if row.get("wis_rate") is not None and not np.isnan(row["wis_rate"]) else None,
                                "mae": round(row["mae"], 2) if row.get("mae") is not None and not np.isnan(row["mae"]) else None,
                                "cov95": round(row["cov95"] * 100, 1) if row.get("cov95") is not None and not np.isnan(row["cov95"]) else None,
                                "sharpness": round(row["sharpness"], 1) if row.get("sharpness") is not None and not np.isnan(row["sharpness"]) else None,
                                "task_count": row.get("task_count", 0),
                            }

                    row_vals = []
                    for d in x_keys:
                        m_dict = d_metrics.get(d, {})
                        val = m_dict.get(metric if metric in m_dict else "wis")
                        row_vals.append(val)
                        cell_key = f"{mid}:{d}"
                        cell_meta[cell_key] = {
                            "row": mid,
                            "col": d,
                            "metric_name": metric,
                            "metric_value": val,
                            **(m_dict or {}),
                        }
                    raw_matrix.append(row_vals)

        # -------------------------------------------------------------
        # Prune Empty Leading & Trailing Shoulder Dates
        # -------------------------------------------------------------
        # In date-oriented matrices, weeks before a season starts or after it
        # closes often have 100% missing data across all locations/models.
        # We prune leading and trailing all-empty shoulder dates gracefully,
        # while deliberately PRESERVING internal missing dates ("black bars")
        # to reflect true data gaps within the season.
        if mode in ("wave", "model_date") and x_keys and raw_matrix:
            num_c = len(x_keys)
            num_r = len(raw_matrix)
            col_has_data = [
                any(
                    raw_matrix[r][c] is not None and not (isinstance(raw_matrix[r][c], float) and np.isnan(raw_matrix[r][c]))
                    for r in range(num_r)
                )
                for c in range(num_c)
            ]
            if any(col_has_data):
                first_c = col_has_data.index(True)
                last_c = num_c - 1 - col_has_data[::-1].index(True)
                if first_c > 0 or last_c < num_c - 1:
                    x_keys = x_keys[first_c : last_c + 1]
                    x_labels = x_labels[first_c : last_c + 1]
                    raw_matrix = [row[first_c : last_c + 1] for row in raw_matrix]

        elif mode == "date_h" and y_keys and raw_matrix:
            num_r = len(y_keys)
            num_c = len(raw_matrix[0]) if raw_matrix else 0
            row_has_data = [
                any(
                    raw_matrix[r][c] is not None and not (isinstance(raw_matrix[r][c], float) and np.isnan(raw_matrix[r][c]))
                    for c in range(num_c)
                )
                for r in range(num_r)
            ]
            if any(row_has_data):
                first_r = row_has_data.index(True)
                last_r = num_r - 1 - row_has_data[::-1].index(True)
                if first_r > 0 or last_r < num_r - 1:
                    y_keys = y_keys[first_r : last_r + 1]
                    y_labels = y_labels[first_r : last_r + 1]
                    raw_matrix = raw_matrix[first_r : last_r + 1]

        # -------------------------------------------------------------
        # Non-Reporting Models Detection & Partitioning
        # -------------------------------------------------------------
        # Identify models that did not forecast in the selected scope (season, date, etc.).
        # By default, exclude them from the primary matrix to prevent disjointed black rows,
        # while returning them in `inactive_models` with explicit explanations.
        # If `include_inactive=True`, partition them cleanly to the bottom under a divider.
        inactive_models: List[Dict[str, Any]] = []

        if mode in ("model_loc", "model_h", "model_date"):
            active_indices = []
            inactive_indices = []
            for idx, r_vals in enumerate(raw_matrix):
                if any(v is not None and not (isinstance(v, float) and np.isnan(v)) for v in r_vals):
                    active_indices.append(idx)
                else:
                    inactive_indices.append(idx)

            for idx in inactive_indices:
                mid = y_keys[idx]
                meta_info = all_models_meta.get(mid, {})
                m_seasons = meta_info.get("seasons", [])
                m_count = meta_info.get("count", 0)
                m_disp = meta_info.get("display_name", mid)

                if m_count == 0:
                    reason = "No forecast submissions found"
                elif season and season != "all":
                    if m_seasons:
                        reason = f"Active in {', '.join(m_seasons)} only (no forecasts in {season})"
                    else:
                        reason = f"No forecast submissions recorded for {season}"
                elif reference_date and reference_date != "all":
                    if m_seasons:
                        reason = f"Active in {', '.join(m_seasons)} (no forecast for {reference_date})"
                    else:
                        reason = f"No forecast for {reference_date}"
                else:
                    reason = "No forecasts in selected scope"

                inactive_models.append({
                    "id": mid,
                    "name": m_disp,
                    "reason": reason,
                    "seasons": m_seasons,
                    "count": m_count,
                    "min_date": meta_info.get("min_date"),
                    "max_date": meta_info.get("max_date"),
                    "is_local": meta_info.get("is_local", False),
                })

            if not include_inactive:
                # Primary heatmap contains only active reporting models
                y_keys = [y_keys[i] for i in active_indices]
                y_labels = [y_labels[i] for i in active_indices]
                raw_matrix = [raw_matrix[i] for i in active_indices]
            else:
                # Active models first, inactive models grouped at bottom
                active_keys = [y_keys[i] for i in active_indices]
                active_labels = [y_labels[i] for i in active_indices]
                active_rows = [raw_matrix[i] for i in active_indices]

                inactive_keys = [y_keys[i] for i in inactive_indices]
                inactive_labels = [f"[No Data] {y_labels[i]}" for i in inactive_indices]
                inactive_rows = [raw_matrix[i] for i in inactive_indices]

                y_keys = active_keys + inactive_keys
                y_labels = active_labels + inactive_labels
                raw_matrix = active_rows + inactive_rows

        elif mode in ("wave", "horizon", "date_h"):
            is_truth_mode = (not model_id) or (model_id.lower() in ("truth", "oracle", "none"))
            if not is_truth_mode and model_id:
                has_any_val = any(any(v is not None and not (isinstance(v, float) and np.isnan(v)) for v in r) for r in raw_matrix)
                if not has_any_val:
                    m_info = all_models_meta.get(model_id, {})
                    m_seasons = m_info.get("seasons", [])
                    reason = f"Active in {', '.join(m_seasons)} only (no forecasts in {season})" if m_seasons else f"No forecast submissions for {season}"
                    inactive_models.append({
                        "id": model_id,
                        "name": m_info.get("display_name", model_id),
                        "reason": reason,
                        "seasons": m_seasons,
                        "count": m_info.get("count", 0),
                        "min_date": m_info.get("min_date"),
                        "max_date": m_info.get("max_date"),
                        "is_local": m_info.get("is_local", False),
                    })

        # -------------------------------------------------------------
        # Row Sorting & Grouping
        # -------------------------------------------------------------
        row_groups: List[Dict[str, Any]] = []
        is_loc_y = (rows == "location")

        if is_loc_y and len(y_keys) > 1:
            pop_lookup = {loc_info.get("abbreviation"): (loc_info.get("population") or 0) for loc_info in locations.values()}

            if sort_by == "hhs_region":
                def region_sort_key(k: str):
                    return (STATE_TO_HHS_REGION.get(k, 99), k)
                sorted_indices = sorted(range(len(y_keys)), key=lambda i: region_sort_key(y_keys[i]))

            elif sort_by == "peak_timing":
                def peak_sort_key(i: int):
                    row = raw_matrix[i]
                    valid_pairs = [(c_idx, v) for c_idx, v in enumerate(row) if v is not None and not np.isnan(v)]
                    if not valid_pairs:
                        return (9999, 0)
                    best_c_idx, best_val = max(valid_pairs, key=lambda p: p[1])
                    return (best_c_idx, -best_val)
                sorted_indices = sorted(range(len(y_keys)), key=peak_sort_key)

            elif sort_by == "magnitude":
                def mag_sort_key(i: int):
                    row = raw_matrix[i]
                    valid = [v for v in row if v is not None and not np.isnan(v)]
                    return -np.mean(valid) if valid else 9999
                sorted_indices = sorted(range(len(y_keys)), key=mag_sort_key)

            elif sort_by == "population":
                sorted_indices = sorted(range(len(y_keys)), key=lambda i: -pop_lookup.get(y_keys[i], 0))

            else:  # "alphabetical"
                sorted_indices = sorted(range(len(y_keys)), key=lambda i: y_keys[i])

            y_keys = [y_keys[i] for i in sorted_indices]
            raw_matrix = [raw_matrix[i] for i in sorted_indices]
            y_labels = [y_labels[i] for i in sorted_indices]

            # Build HHS Region grouping brackets if sorted by region
            if sort_by == "hhs_region":
                curr_reg = None
                start_i = 0
                for idx, abbr in enumerate(y_keys):
                    reg_id = STATE_TO_HHS_REGION.get(abbr, 99)
                    if reg_id != curr_reg:
                        if curr_reg is not None and curr_reg in HHS_REGIONS:
                            row_groups.append({
                                "region_id": curr_reg,
                                "label": HHS_REGIONS[curr_reg]["name"],
                                "short": HHS_REGIONS[curr_reg]["short"],
                                "start_idx": start_i,
                                "end_idx": idx - 1,
                            })
                        curr_reg = reg_id
                        start_i = idx
                if curr_reg is not None and curr_reg in HHS_REGIONS:
                    row_groups.append({
                        "region_id": curr_reg,
                        "label": HHS_REGIONS[curr_reg]["name"],
                        "short": HHS_REGIONS[curr_reg]["short"],
                        "start_idx": start_i,
                        "end_idx": len(y_keys) - 1,
                    })

        # Column grouping by HHS Region when columns represent locations (e.g. Model x Location mode)
        col_groups: List[Dict[str, Any]] = []
        if cols == "location" and len(x_keys) > 1:
            def col_reg_key(k: str):
                return (STATE_TO_HHS_REGION.get(k, 99), k)
            x_sorted = sorted(range(len(x_keys)), key=lambda i: col_reg_key(x_keys[i]))
            x_keys = [x_keys[i] for i in x_sorted]
            x_labels = [x_labels[i] for i in x_sorted]
            raw_matrix = [[row[i] for i in x_sorted] for row in raw_matrix]

            curr_reg = None
            start_i = 0
            for idx, abbr in enumerate(x_keys):
                reg_id = STATE_TO_HHS_REGION.get(abbr, 99)
                if reg_id != curr_reg:
                    if curr_reg is not None and curr_reg in HHS_REGIONS:
                        col_groups.append({
                            "region_id": curr_reg,
                            "label": HHS_REGIONS[curr_reg]["name"],
                            "short": HHS_REGIONS[curr_reg]["short"],
                            "start_idx": start_i,
                            "end_idx": idx - 1,
                        })
                    curr_reg = reg_id
                    start_i = idx
            if curr_reg is not None and curr_reg in HHS_REGIONS:
                col_groups.append({
                    "region_id": curr_reg,
                    "label": HHS_REGIONS[curr_reg]["name"],
                    "short": HHS_REGIONS[curr_reg]["short"],
                    "start_idx": start_i,
                    "end_idx": len(x_keys) - 1,
                })

        elif rows == "model" and len(y_keys) > 1:
            active_count = len(y_keys) - len(inactive_models) if (include_inactive and inactive_models) else len(y_keys)
            if active_count > 1:
                active_slice_indices = list(range(active_count))
                if sort_by in ("performance", "magnitude"):
                    def model_perf_sort_key(i: int):
                        row = raw_matrix[i]
                        valid = [v for v in row if v is not None and not np.isnan(v)]
                        return np.mean(valid) if valid else 9999
                    active_sorted = sorted(active_slice_indices, key=model_perf_sort_key)
                elif sort_by == "alphabetical":
                    active_sorted = sorted(active_slice_indices, key=lambda i: y_keys[i])
                else:
                    active_sorted = active_slice_indices

                inactive_slice_indices = list(range(active_count, len(y_keys)))
                inactive_sorted = sorted(inactive_slice_indices, key=lambda i: y_keys[i])

                combined_sorted = active_sorted + inactive_sorted
                y_keys = [y_keys[i] for i in combined_sorted]
                y_labels = [y_labels[i] for i in combined_sorted]
                raw_matrix = [raw_matrix[i] for i in combined_sorted]
            elif active_count == 1 and include_inactive and inactive_models:
                inactive_slice_indices = list(range(1, len(y_keys)))
                inactive_sorted = sorted(inactive_slice_indices, key=lambda i: y_keys[i])
                combined_sorted = [0] + inactive_sorted
                y_keys = [y_keys[i] for i in combined_sorted]
                y_labels = [y_labels[i] for i in combined_sorted]
                raw_matrix = [raw_matrix[i] for i in combined_sorted]

        # -------------------------------------------------------------
        # Normalization
        # -------------------------------------------------------------
        matrix: List[List[Optional[float]]] = []

        if normalize == "row_min_max":
            for row in raw_matrix:
                valid = [v for v in row if v is not None and not np.isnan(v)]
                if not valid or max(valid) == min(valid):
                    matrix.append([0.0 if (v is not None and not np.isnan(v)) else None for v in row])
                else:
                    min_v, max_v = min(valid), max(valid)
                    denom = max_v - min_v
                    matrix.append([round((v - min_v) / denom, 4) if (v is not None and not np.isnan(v)) else None for v in row])
        elif normalize == "percentile":
            all_valid = sorted([v for row in raw_matrix for v in row if v is not None and not np.isnan(v)])
            if all_valid:
                n = len(all_valid)
                for row in raw_matrix:
                    row_pct = []
                    for v in row:
                        if v is None or np.isnan(v):
                            row_pct.append(None)
                        else:
                            rank = np.searchsorted(all_valid, v)
                            row_pct.append(round(float(rank) / n, 4))
                    matrix.append(row_pct)
            else:
                matrix = raw_matrix
        else:
            matrix = raw_matrix

        # -------------------------------------------------------------
        # Text Matrix for Hover and Tooltips
        # -------------------------------------------------------------
        text_matrix: List[List[str]] = []
        for r_idx, row in enumerate(raw_matrix):
            t_row = []
            for c_idx, v in enumerate(row):
                if v is None or np.isnan(v):
                    t_row.append("No Data")
                else:
                    if metric == "rate":
                        t_row.append(f"{v:.2f} / 100k")
                    elif metric == "count":
                        t_row.append(f"{v * 100:.2f}%" if is_rate_target else f"{int(round(v)):,} adm")
                    elif metric == "trend":
                        t_row.append(f"{v:+.1f}%")
                    elif metric == "cov95":
                        t_row.append(f"{v:.1f}%")
                    else:
                        t_row.append(f"{v:.2f}")
            text_matrix.append(t_row)

        # -------------------------------------------------------------
        # Transpose if requested (e.g. Cols on Y, Rows on X)
        # -------------------------------------------------------------
        if transpose_needed:
            x_keys, y_keys = y_keys, x_keys
            x_labels, y_labels = y_labels, x_labels
            matrix = [list(col) for col in zip(*matrix)] if matrix and matrix[0] else []
            raw_matrix = [list(col) for col in zip(*raw_matrix)] if raw_matrix and raw_matrix[0] else []
            text_matrix = [list(col) for col in zip(*text_matrix)] if text_matrix and text_matrix[0] else []
            row_groups = []

        # -------------------------------------------------------------
        # Summary Telemetry
        # -------------------------------------------------------------
        flat_valid = [v for row in raw_matrix for v in row if v is not None and not np.isnan(v)]
        summary: Dict[str, Any] = {
            "min": round(float(np.min(flat_valid)), 2) if flat_valid else 0.0,
            "max": round(float(np.max(flat_valid)), 2) if flat_valid else 0.0,
            "mean": round(float(np.mean(flat_valid)), 2) if flat_valid else 0.0,
            "total_cells": len(y_keys) * len(x_keys),
            "valid_cells": len(flat_valid),
            "completeness_pct": round((len(flat_valid) / (len(y_keys) * len(x_keys) or 1)) * 100, 1),
            "hotspot_cell": None,
            "fastest_surge": None,
            "earliest_peak": None,
        }

        if flat_valid and len(y_keys) > 0 and len(x_keys) > 0:
            max_v = float(np.max(flat_valid))
            for r_idx, row in enumerate(raw_matrix):
                for c_idx, v in enumerate(row):
                    if v == max_v:
                        summary["hotspot_cell"] = {
                            "row": y_keys[r_idx],
                            "row_label": y_labels[r_idx],
                            "col": x_keys[c_idx],
                            "col_label": x_labels[c_idx],
                            "val": max_v,
                        }
                        break
                if summary["hotspot_cell"]:
                    break

        best_trend = None
        for cell in cell_meta.values():
            tr = cell.get("trend")
            if tr is not None and (best_trend is None or tr > best_trend["growth"]):
                best_trend = {
                    "row": cell.get("row"),
                    "row_name": cell.get("row_name"),
                    "col": cell.get("col"),
                    "growth": tr,
                }
        summary["fastest_surge"] = best_trend

        return {
            "mode": mode,
            "rows": rows,
            "cols": cols,
            "target": target,
            "location": location,
            "metric": metric,
            "reference_date": reference_date,
            "season": season,
            "horizon": h_int,
            "model_id": model_id,
            "sort_by": sort_by,
            "normalize": normalize,
            "include_inactive": include_inactive,
            "inactive_models": inactive_models,
            "x_keys": x_keys,
            "x_labels": x_labels,
            "y_keys": y_keys,
            "y_labels": y_labels,
            "matrix": matrix,
            "raw_matrix": raw_matrix,
            "text_matrix": text_matrix,
            "cell_meta": cell_meta,
            "row_groups": row_groups,
            "col_groups": col_groups,
            "summary": summary,
        }

    def get_hub_seasons(self) -> Dict[str, List[str]]:
        """Extract official hub round dates grouped by season from tasks.json or scanned dates."""
        if self._hub_seasons_cache is not None:
            return self._hub_seasons_cache

        tasks_path = self.hub_config_dir / "tasks.json"
        seasons: Dict[str, List[str]] = {}
        if tasks_path.exists():
            try:
                data = json.loads(tasks_path.read_text(encoding="utf-8"))
                for r in data.get("rounds", []):
                    for mt in r.get("model_tasks", []):
                        ref_spec = mt.get("task_ids", {}).get("reference_date", {})
                        dates = (ref_spec.get("optional") or []) + (ref_spec.get("required") or [])
                        for d in dates:
                            s = self.get_flu_season_for_date(d)
                            if s not in seasons:
                                seasons[s] = []
                            if d not in seasons[s]:
                                seasons[s].append(d)
            except Exception as exc:
                logger.warning("Error reading hub tasks.json: %s", exc)

        for s in seasons:
            seasons[s].sort(reverse=True)

        self._hub_seasons_cache = seasons
        return seasons

    def get_all_seasons(self) -> List[str]:
        """Return all distinct seasons found in historical surveillance or model forecasts."""
        seasons_set = set()
        adm_df = self.get_admissions_ground_truth(as_polars=True)
        if adm_df is not None and not adm_df.is_empty():
            for d in adm_df.select(pl.col("target_end_date").unique())["target_end_date"].to_list():
                seasons_set.add(self.get_flu_season_for_date(str(d)))

        hub_seasons = self.get_hub_seasons()
        seasons_set.update(hub_seasons.keys())

        for m in self.scan_models().values():
            for d in m.get("dates", []):
                seasons_set.add(self.get_flu_season_for_date(d))

        return sorted(list(seasons_set), reverse=True)

    def get_dates_for_season(self, season: str) -> List[str]:
        """Return all reference dates belonging to a specific season."""
        dates_set = set()
        hub_seasons = self.get_hub_seasons()
        if season == "all":
            for d_list in hub_seasons.values():
                dates_set.update(d_list)
        elif season in hub_seasons:
            dates_set.update(hub_seasons[season])

        for m in self.scan_models().values():
            for d in m.get("dates", []):
                if season == "all" or self.get_flu_season_for_date(d) == season:
                    dates_set.add(d)

        return sorted(list(dates_set), reverse=True)

    def get_dates_for_seasons(self, seasons: List[str]) -> List[str]:
        """Return union of reference dates across a list of requested seasons."""
        combined = set()
        for s in seasons:
            combined.update(self.get_dates_for_season(s))
        return sorted(list(combined), reverse=True)

    def get_available_dates(self, target: Optional[str] = None) -> List[str]:
        """Return all distinct available dates from models, hub rounds, and surveillance data in chronological order."""
        dates_set: Set[str] = set()
        hub_seasons = self.get_hub_seasons()
        for d_list in hub_seasons.values():
            dates_set.update(d_list)
        for m in self.scan_models().values():
            dates_set.update(m.get("dates", []))
        adm_df = self.get_admissions_ground_truth(as_polars=True)
        if adm_df is not None and not adm_df.is_empty():
            dates_set.update([str(d) for d in adm_df["target_end_date"].unique().to_list()])
        return sorted(list(dates_set))

    def get_forecast_seasons(self) -> List[str]:
        """Return all seasons that have actual model forecasts or official hub rounds."""
        seasons_set = set()
        hub_seasons = self.get_hub_seasons()
        seasons_set.update(hub_seasons.keys())
        for m in self.scan_models().values():
            for d in m.get("dates", []):
                seasons_set.add(self.get_flu_season_for_date(d))
        return sorted([s for s in seasons_set if len(self.get_dates_for_season(s)) > 0])

    def get_latest_reference_date(self) -> Optional[str]:
        """Dynamically find the most recent forecast reference date available."""
        models = self.scan_models()
        dates_set: Set[str] = set()
        for m in models.values():
            dates_set.update(m.get("dates", []))
        if dates_set:
            return max(dates_set)
        adm_df = self.get_admissions_ground_truth(as_polars=True)
        if adm_df is not None and not adm_df.is_empty():
            return max(adm_df["target_end_date"].to_list())
        return None

    def get_latest_season(self) -> str:
        """Dynamically get the latest active flu season."""
        seasons = self.get_forecast_seasons()
        if seasons:
            return sorted(seasons, reverse=True)[0]
        latest_date = self.get_latest_reference_date()
        if latest_date:
            return self.get_flu_season_for_date(latest_date)
        now = datetime.now()
        year = now.year
        return f"{year}-{year+1}" if now.month >= 7 else f"{year-1}-{year}"

    def get_season_summaries(self) -> List[Dict[str, Any]]:
        """Return rich summaries for each forecast season for UI display and validation."""
        seasons = self.get_forecast_seasons()
        models = self.scan_models()
        res = []
        for s in seasons:
            dates = self.get_dates_for_season(s)
            active_models = [m for m, v in models.items() if any(d in dates for d in v.get("dates", []))]
            res.append({
                "season": s,
                "dates_count": len(dates),
                "first_date": dates[-1] if dates else None,
                "last_date": dates[0] if dates else None,
                "active_models_count": len(active_models),
                "active_models": active_models,
            })
        return res

    @staticmethod
    def get_season_calendar_bounds(start_year: int) -> Tuple[str, str]:
        """
        Return the exact (season_start_date, season_end_date) for a flu season starting in start_year.
        Flu season starts at Sunday of MMWR week 31 of start_year,
        and ends at Saturday of MMWR week 30 of (start_year + 1).
        """
        jan4 = date(start_year, 1, 4)
        start_sun = jan4 - timedelta(days=(jan4.weekday() + 1) % 7)
        sun_wk31 = start_sun + timedelta(weeks=30)

        next_jan4 = date(start_year + 1, 1, 4)
        next_start_sun = next_jan4 - timedelta(days=(next_jan4.weekday() + 1) % 7)
        sat_wk30 = next_start_sun + timedelta(weeks=29, days=6)

        return sun_wk31.strftime("%Y-%m-%d"), sat_wk30.strftime("%Y-%m-%d")

    @classmethod
    def get_flu_season_for_date(cls, date_str: str) -> str:
        """Map YYYY-MM-DD to flu season format 'YYYY-YYYY' using standard MMWR week 31 boundary."""
        if isinstance(date_str, str):
            return _flu_season_for_date_str(date_str)  # pure function of the string: memoized
        return _flu_season_for_date(date_str)

    def get_model_metadata(self, model_id: str) -> Dict[str, Any]:
        """
        Load metadata YAML for model from model-metadata/<model_id>.yml.
        If file is missing (e.g. local experimental model), generate clean inferred metadata.
        """
        raw_id, _ = self._resolve_model_id_and_local(model_id)
        hub = self.cache_mgr.hub_key(raw_id)
        if hub is not None:
            # Hub models read the YAML copied from the hub's model-metadata/ folder
            candidates = [self.remote_store.metadata_path(*hub)]
            model_id = hub[1]
        else:
            candidates = [
                self.model_metadata_dir / f"{raw_id}.yml",
                self.model_metadata_dir / f"{raw_id}.yaml",
                self.model_metadata_dir / f"{model_id}.yml",
                self.model_metadata_dir / f"{model_id}.yaml",
            ]
        meta_file = next((c for c in candidates if c.exists()), None)

        if meta_file is not None:
            try:
                raw_text = meta_file.read_text(encoding="utf-8")
                data = None
                if yaml is not None:
                    try:
                        parsed = yaml.safe_load(raw_text)
                        if isinstance(parsed, dict):
                            data = parsed
                    except Exception as y_err:
                        logger.debug("PyYAML load failed on %s: %s; falling back to parser", meta_file, y_err)

                if data is None:
                    data = self._parse_simple_yaml(raw_text)

                data["has_metadata_file"] = True
                data.setdefault("team_name", model_id.split("-")[0] if "-" in model_id else "Research Team")
                data.setdefault("team_abbr", model_id.split("-")[0] if "-" in model_id else "Team")
                data.setdefault("model_name", model_id.split("-", 1)[1].replace("_", " ").title() if "-" in model_id else model_id)
                data.setdefault("model_abbr", model_id.split("-", 1)[1] if "-" in model_id else model_id)
                data.setdefault("model_version", "1.0")
                data.setdefault("model_contributors", [])
                data.setdefault("license", "CC-BY-4.0")
                data.setdefault("website_url", None)
                data.setdefault("designated_model", False)
                data.setdefault("methods", "Statistical time-series forecast model.")
                data.setdefault("data_inputs", "Weekly incident flu hospitalizations.")
                data.setdefault("methods_long", data.get("methods", ""))
                data.setdefault("ensemble_of_models", False)
                data.setdefault("ensemble_of_hub_models", False)
                for key in ["methods", "methods_long", "data_inputs", "team_name", "model_name", "license"]:
                    if isinstance(data.get(key), str):
                        data[key] = data[key].strip()
                return data
            except Exception as exc:
                logger.warning("Error parsing %s: %s", meta_file, exc)

        # Fallback inferred metadata for models lacking a YAML file
        is_local = (self.local_output_dir / model_id).exists()
        team = model_id.split("-")[0] if "-" in model_id else "Local"
        name = model_id.split("-", 1)[1] if "-" in model_id else model_id
        return {
            "has_metadata_file": False,
            "team_name": f"{team} Team" if not is_local else "Local Experiment",
            "team_abbr": team,
            "model_name": name.replace("_", " ").title(),
            "model_abbr": name,
            "model_version": "experimental",
            "model_contributors": [{"name": "Sandbox Researcher", "affiliation": team}],
            "license": "CC-BY-4.0",
            "website_url": None,
            "designated_model": False,
            "methods": f"Forecast model ({model_id}) staged for sandbox evaluation.",
            "data_inputs": "Weekly incident flu hospitalizations.",
            "methods_long": f"Experimental model output generated for sandbox benchmarking ({model_id}).",
            "ensemble_of_models": False,
            "ensemble_of_hub_models": False,
        }

    @staticmethod
    def _parse_simple_yaml(text: str) -> Dict[str, Any]:
        """Robust YAML/JSON fallback parser for standard Hubverse model metadata schemas."""
        result: Dict[str, Any] = {}
        current_list_key = None
        current_list: List[Any] = []
        current_multiline_key = None
        current_multiline: List[str] = []

        lines = text.splitlines()
        for raw_line in lines:
            line = raw_line.rstrip()
            if not line or line.lstrip().startswith("#"):
                continue

            # Multi-line continuation
            if current_multiline_key:
                if raw_line.startswith("  ") or raw_line.startswith("\t"):
                    current_multiline.append(raw_line.strip())
                    continue
                else:
                    result[current_multiline_key] = " ".join(current_multiline)
                    current_multiline_key = None
                    current_multiline = []

            # List item continuation
            if line.startswith("  - ") or line.startswith("    - "):
                item_val = line.split("- ", 1)[1].strip().strip('"').strip("'")
                if current_list_key:
                    current_list.append(item_val)
                continue

            # Top-level or sub key-value
            if ":" in line and not line.startswith(" "):
                if current_list_key:
                    result[current_list_key] = current_list
                    current_list_key = None
                    current_list = []

                key, val = line.split(":", 1)
                key = key.strip()
                val = val.strip()

                if val in ("|", ">", "|-", ">-"):
                    current_multiline_key = key
                    current_multiline = []
                    continue

                if not val:
                    current_list_key = key
                    current_list = []
                    continue

                # Check if JSON flow-style array or object: e.g. [ { "name": ... } ]
                if (val.startswith("[") and val.endswith("]")) or (val.startswith("{") and val.endswith("}")):
                    try:
                        result[key] = json.loads(val)
                        continue
                    except Exception:
                        pass

                # Parse scalar types
                v_clean = val.strip('"').strip("'")
                if v_clean.lower() == "true":
                    result[key] = True
                elif v_clean.lower() == "false":
                    result[key] = False
                elif v_clean.isdigit():
                    result[key] = int(v_clean)
                else:
                    result[key] = v_clean

        if current_list_key:
            result[current_list_key] = current_list
        if current_multiline_key:
            result[current_multiline_key] = " ".join(current_multiline)

        return result

    def get_model_details(self, model_id: str) -> Optional[Dict[str, Any]]:
        """Construct comprehensive dossier for a model including schema, schedule, specs, and team info."""
        models = self.scan_models()
        if model_id not in models:
            raw_id, _ = self._resolve_model_id_and_local(model_id)
            if raw_id in models:
                model_id = raw_id
            else:
                return None

        m_info = models[model_id]
        raw_id, is_local = self._resolve_model_id_and_local(model_id)
        if m_info.get("is_synthetic") and hasattr(self, "ensemble_mgr"):
            cfg = self.ensemble_mgr.get_config(model_id)
            comp_models = (cfg.state_models + cfg.national_models) if cfg.spatial_split else cfg.models
            meta = {
                "team_name": "Synthetic Studio",
                "model_name": cfg.name,
                "model_abbr": cfg.id,
                "model_family": "Synthetic Ensemble",
                "ensemble_of_hub_models": True,
                "license": "CC-BY-4.0",
                "designated_model": False,
                "model_version": "1.0",
                "methods": f"Quantile {cfg.method.capitalize()} Vincentization with monotonic rearrangement across {len(comp_models)} component models: {', '.join(comp_models)}.",
                "description": cfg.description or f"Synthetic ensemble created in Ensemble Studio using {cfg.method.capitalize()} Vincentization.",
            }
        else:
            meta = self.get_model_metadata(model_id)

        # Build schedule calendar and round metrics
        dates = m_info.get("dates", [])
        dates_set = set(dates)
        hub_seasons = self.get_hub_seasons()
        all_hub_dates = set()
        for d_list in hub_seasons.values():
            all_hub_dates.update(d_list)

        rounds_list = []
        for d in dates:
            rounds_list.append({
                "date": d,
                "season": self.get_flu_season_for_date(d),
                "is_hub_round": d in all_hub_dates,
            })

        # Calculate filesystem disk footprint
        if m_info.get("source") == "hub":
            m_dir = Path(m_info["path"])
        else:
            m_dir = (self.local_output_dir if is_local else self.model_output_dir) / raw_id
        total_files = 0
        total_disk_bytes = 0
        if m_dir.exists() and m_dir.is_dir():
            for f in m_dir.iterdir():
                if f.is_file() and (f.suffix == ".csv" or f.suffix == ".parquet"):
                    total_files += 1
                    try:
                        total_disk_bytes += f.stat().st_size
                    except Exception:
                        pass

        if total_disk_bytes >= 1024 * 1024 * 1024:
            total_disk_human = f"{total_disk_bytes / (1024 * 1024 * 1024):.1f} GB"
        elif total_disk_bytes >= 1024 * 1024:
            total_disk_human = f"{total_disk_bytes / (1024 * 1024):.1f} MB"
        elif total_disk_bytes >= 1024:
            total_disk_human = f"{total_disk_bytes / 1024:.1f} KB"
        else:
            total_disk_human = f"{total_disk_bytes} B"

        locs = self.get_locations()
        loc_count = len(locs) if locs else 53

        specs = {
            "horizons": [0, 1, 2, 3],
            "targets": m_info.get("targets") or ["wk inc flu hosp"],
            "locations_count": loc_count,
            "total_files": total_files if total_files > 0 else len(dates),
            "total_disk_bytes": total_disk_bytes,
            "total_disk_human": total_disk_human,
            "total_predictions_est": len(dates) * loc_count * 4 * 23,
        }
        # Season peak forecasts submitted alongside the weekly targets (kept in a separate table)
        if not m_info.get("is_synthetic"):
            if m_info.get("source") == "hub":
                peak_targets, peak_dates = m_info.get("peak_targets", []), m_info.get("peak_dates", [])
            else:
                base = self.config.get_default_target()
                peak_dates = self.peaks.peak_dates(model_id, base)
                peak_targets = sorted(self.peaks.targets(base).values()) if peak_dates else []
            specs["peak_targets"] = peak_targets
            specs["peak_rounds"] = len(peak_dates)
            specs["peak_latest"] = peak_dates[-1] if peak_dates else None
        if m_info.get("is_synthetic") and hasattr(self, "ensemble_mgr"):
            cfg = self.ensemble_mgr.get_config(model_id)
            comp_models = (cfg.state_models + cfg.national_models) if cfg.spatial_split else cfg.models
            specs.update({
                "is_synthetic": True,
                "method": f"Quantile {cfg.method.capitalize()}",
                "spatial_split": cfg.spatial_split,
                "missing_policy": cfg.missing_policy,
                "component_models": comp_models,
            })

        # Build detailed season matrix objects with calendar tiles
        all_season_keys = sorted(
            list(set(list(hub_seasons.keys()) + list(m_info.get("seasons", [])))),
            reverse=True,
        )
        if m_info.get("source") == "hub":
            # Only seasons that were synced: absence elsewhere means "not downloaded", not "not submitted"
            synced = set(self.remote_store.load_manifest(m_info["hub"]).get("seasons", []))
            all_season_keys = sorted(synced | set(m_info.get("seasons", [])), reverse=True)
        seasons_list = []
        active_seasons = []

        for s in all_season_keys:
            hub_dates = hub_seasons.get(s, [])
            if not hub_dates:
                hub_dates = [d for d in dates if self.get_flu_season_for_date(d) == s]
            sub_dates = [d for d in hub_dates if d in dates_set]

            tiles = []
            for d in hub_dates:
                try:
                    d_dt = datetime.strptime(d, "%Y-%m-%d")
                    mo = d_dt.strftime("%b").upper()
                    dy = d_dt.strftime("%d")
                except Exception:
                    mo, dy = "W", d[-2:]
                is_sub = d in dates_set
                tiles.append({
                    "date": d,
                    "month": mo,
                    "day": dy,
                    "submitted": is_sub,
                    "loc_info": {
                        "is_full_coverage": True,
                        "locations_count": loc_count,
                        "total_locations": loc_count,
                        "missing_locations": [],
                    } if is_sub else None,
                })

            submitted_count = len(sub_dates)
            total_rounds = len(hub_dates)
            coverage_pct = round((submitted_count / total_rounds) * 100, 1) if total_rounds > 0 else 0.0

            if submitted_count > 0:
                active_seasons.append(s)

            seasons_list.append({
                "season": s,
                "submitted_count": submitted_count,
                "total_hub_rounds": total_rounds,
                "coverage_pct": coverage_pct,
                "status": "Complete" if (submitted_count == total_rounds and total_rounds > 0) else "Partial",
                "min_date": sub_dates[0] if sub_dates else None,
                "max_date": sub_dates[-1] if sub_dates else None,
                "partial_coverage_count": 0,
                "dates": tiles,
            })

        hub_info = None
        if m_info.get("source") == "hub":
            spec = self.remote_store.get_spec(m_info["hub"])
            man = self.remote_store.load_manifest(m_info["hub"])
            name = m_info["display_name"]
            submissions = sorted(
                (
                    {
                        "reference_date": f["reference_date"],
                        "posted": f.get("last_modified"),
                        "revisions": int(f.get("revisions", 0)),
                        "warnings": f.get("warnings", []),
                    }
                    for f in man.get("files", {}).values() if f.get("model") == name
                ),
                key=lambda r: r["reference_date"],
                reverse=True,
            )
            hub_info = {
                "hub": m_info["hub"],
                "label": spec.label if spec else m_info.get("hub_label"),
                "short_label": m_info.get("hub_label"),
                "bucket": spec.bucket if spec else None,
                "repo_url": spec.repo_url if spec else None,
                "s3_prefix": f"model-output/{name}/",
                "last_sync": man.get("last_sync"),
                "submissions": submissions,
            }

        return {
            "model_id": model_id,
            "display_name": m_info.get("display_name", model_id),
            "source": m_info.get("source", "local" if is_local else "repo"),
            "hub": hub_info,
            "designated": m_info.get("designated", meta.get("designated_model", False)),
            "is_local": is_local,
            "is_synthetic": m_info.get("is_synthetic", False),
            "synthetic_config": m_info.get("synthetic_config"),
            "family": m_info.get("family", "Unknown"),
            "forecasts_count": m_info.get("count", 0),
            "dates": dates,
            "first_date": dates[0] if dates else None,
            "last_date": dates[-1] if dates else None,
            "min_date": m_info.get("min_date"),
            "max_date": m_info.get("max_date"),
            "total_dates_count": len(dates),
            "active_seasons": active_seasons,
            "seasons": seasons_list,
            "specs": specs,
            "metadata": meta,
            "rounds": rounds_list,
        }
