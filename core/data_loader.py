"""
Data loader and caching layer for oracle truth, locations, and model outputs.
Supports both production 'model-output/' and local test 'local-output/'.
Pure-Polars implementation with zero stale in-memory dictionary caching.
"""

from datetime import datetime, date, timedelta
import functools
import json
import logging
import os
from pathlib import Path
import re
import threading
from typing import Dict, List, Optional, Any, Set, Tuple, Union

import numpy as np
import polars as pl

from viz.core.cache_manager import ParquetCacheManager, NULL_VALUES, filter_quantile_rows
from viz.core.calendar import CalendarSpec, infer_calendar
from viz.core.config import VizConfig
from viz.core.geo import GeoGraph, HHS_REGIONS, STATE_TO_HHS_REGION, build_geo_graph
from viz.core.metrics import find_quantile_column, score_forecasts
from viz.core.peak_data import PeakService
from viz.core.peaks import is_peak_target
from viz.core.synthetic_ensemble import SyntheticEnsembleManager, SyntheticEnsembleConfig
from viz.core.truth import is_flu_hosp_target, reconcile_weekly_series

logger = logging.getLogger("viz.data_loader")



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


_is_flu_hosp_target = is_flu_hosp_target


class SandboxDataLoader:
    """
    High-performance data loader for forecasts, surveillance streams, and ground truth.
    Powered directly by Polars SIMD queries and ParquetCacheManager.
    """

    def __init__(
        self,
        base_dir: Path,
        include_remote: bool = True,
        cache_dir: Optional[Path] = None,
        surveillance_dir: Optional[Path] = None,
        seed_dir: Optional[Path] = None,
        app_dir: Optional[Path] = None,
        synthetic_dir: Optional[Path] = None,
        remote_dir: Optional[Path] = None,
        hub_models_cache_dir: Optional[Path] = None,
        peer_truth_provider: Optional[Any] = None,
        remote_store: Optional[Any] = None,
    ):
        self.base_dir = Path(base_dir).resolve()
        # Hub data synced from S3 (viz/.cache/remote) is shown in the dashboard only, never in the CLI
        self.include_remote = include_remote
        self.model_output_dir = self.base_dir / "model-output"
        self.local_output_dir = self.base_dir / "local-output"
        self.target_data_dir = self.base_dir / "target-data"
        self.auxiliary_data_dir = self.base_dir / "auxiliary-data"
        self.model_metadata_dir = self.base_dir / "model-metadata"
        self.hub_config_dir = self.base_dir / "hub-config"
        self.config = VizConfig(self.base_dir, app_dir=app_dir)

        # Initialize transparent Parquet acceleration layer
        self.cache_mgr = ParquetCacheManager(
            self.base_dir,
            include_remote=include_remote,
            cache_dir=cache_dir,
            surveillance_dir=surveillance_dir,
            seed_dir=seed_dir,
            remote_dir=remote_dir,
            hub_models_cache_dir=hub_models_cache_dir,
            peer_truth_provider=peer_truth_provider,
            allowed_targets_provider=lambda: set(self.config.get_targets()),
            allowed_locations_provider=lambda: set(self.get_locations().keys()),
            calendar_provider=self.get_calendar,
            geo_provider=self.get_geo_graph,
            is_non_negative_provider=self.config.is_target_non_negative,
            remote_store=remote_store,
        )
        self.remote_store = self.cache_mgr.remote_store

        # Initialize Synthetic Ensemble Engine
        self.ensemble_mgr = SyntheticEnsembleManager(
            self.base_dir,
            data_loader=self,
            synthetic_dir=synthetic_dir,
        )

        # Season peak forecasts (separate peak tables, never mixed into weekly forecasts)
        self.peaks = PeakService(self)

        self._locations_cache: Optional[Dict[str, Dict[str, Any]]] = None
        self._geo_cache: Optional[GeoGraph] = None
        self._calendar_cache: Optional[CalendarSpec] = None
        self._hub_seasons_cache: Optional[Dict[str, List[str]]] = None
        self._raw_hub_seasons_cache: Optional[Dict[str, List[str]]] = None
        self._tasks_mtime: float = -1.0
        self._hub_seasons_sig: Optional[Tuple[Any, ...]] = None
        self._model_details_cache: Dict[str, Dict[str, Any]] = {}
        self._models_cache: Optional[Dict[str, Dict[str, Any]]] = None
        self._models_cache_mtime: float = -1.0
        self._models_cache_lock = threading.Lock()
        self._dedup_lock = threading.Lock()
        self._phase_cache: Dict[str, Tuple[Tuple[Any, ...], pl.DataFrame]] = {}
        self._phase_cache_lock = threading.Lock()

    def get_calendar(self) -> CalendarSpec:
        """Return the inferred or configured CalendarSpec for this hub."""
        if self._calendar_cache is not None:
            return self._calendar_cache
        cal = self.config.get_calendar()
        self._calendar_cache = cal
        return cal

    def get_season_for_date(self, date_str: Any) -> str:
        """Map a date string or date into the hub's season identifier."""
        return self.get_calendar().season_for_date(date_str)

    def get_season_bounds(self, season_or_year: Any) -> Tuple[str, str]:
        """Return inclusive (start_iso, end_iso) for a season identifier or start year."""
        return self.get_calendar().season_bounds(season_or_year)

    def get_geo_graph(self) -> GeoGraph:
        """Build or return the hub's hierarchical GeoGraph (safe against truth/model reentrancy)."""
        if self._geo_cache is not None:
            return self._geo_cache

        loc_file = self.auxiliary_data_dir / "locations.csv"
        if not loc_file.exists() and self.include_remote and self.remote_store is not None:
            try:
                for hid in self.cache_mgr.active_remote_hub_ids():
                    cand = self.remote_store.locations_path(hid)
                    if cand is not None and cand.exists():
                        loc_file = cand
                        break
            except Exception:
                pass

        tasks_cfg = getattr(self.config, "_tasks_config", None)
        if tasks_cfg is None:
            tasks_cfg = self.config._load_tasks_config()
        observed_locs: Optional[List[str]] = None
        if not loc_file.exists():
            # Fallback for CSV-free hubs (e.g. RespiCast) when parquet truth already exists on disk.
            cand_pqs = []
            for pq_name in ("oracle.parquet", "admissions.parquet", "latest.parquet", "time_series.parquet"):
                cand_pqs.append(self.cache_mgr.targets_cache_dir / pq_name)
                cand_pqs.append(self.cache_mgr.target_data_dir / pq_name)
            for pq_path in cand_pqs:
                if pq_path.exists():
                    try:
                        observed_locs = (
                            pl.scan_parquet(pq_path)
                            .select("location")
                            .unique()
                            .collect()["location"]
                            .drop_nulls()
                            .cast(pl.String)
                            .to_list()
                        )
                        if observed_locs:
                            break
                    except Exception:
                        pass

        graph = build_geo_graph(
            loc_file if loc_file.exists() else None,
            tasks_config=tasks_cfg,
            observed_locations=observed_locs,
            fallback_us=True,
        )
        self._geo_cache = graph
        return graph

    def get_locations(self) -> Dict[str, Dict[str, Any]]:
        """Get mapping of location code -> metadata (name, abbreviation, population, hierarchy)."""
        if self._locations_cache is not None:
            return self._locations_cache
        locations = self.get_geo_graph().to_legacy_locations_map()
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
        """Compute maximum modification time across model directories and forecast files for cache invalidation."""
        mtime = 0.0
        try:
            for root in (
                self.model_output_dir,
                self.local_output_dir,
                self.base_dir / "sample-output",
                self.base_dir / "pmf-output",
                self.base_dir / "peak-output",
            ):
                if not root.exists():
                    continue
                mtime = max(mtime, root.stat().st_mtime)
                with os.scandir(root) as it:
                    for ent in it:
                        if ent.name.startswith(".") or (root == self.local_output_dir and ent.name == "synthetic"):
                            continue
                        if not ent.is_dir():
                            continue
                        mtime = max(mtime, ent.stat().st_mtime)
                        try:
                            with os.scandir(ent.path) as sub:
                                for fent in sub:
                                    if fent.name.startswith("."):
                                        continue
                                    ext = os.path.splitext(fent.name)[1].lower()
                                    if ext in (".csv", ".parquet") and fent.is_file():
                                        mtime = max(mtime, fent.stat().st_mtime)
                        except OSError:
                            pass
            synth_dir = self.ensemble_mgr.synthetic_dir
            if synth_dir.exists():
                mtime = max(mtime, synth_dir.stat().st_mtime)
            if self.include_remote:
                mtime = max(mtime, self.remote_store.state_mtime())
            manifest_file = self.base_dir / "manifest.json"
            if manifest_file.is_file():
                mtime = max(mtime, manifest_file.stat().st_mtime)
        except Exception:
            pass
        return mtime

    # ------------------------------------------------------------------------------------------------
    # Season phases (pre-peak / peak / post-peak) per location, from observed truth
    # ------------------------------------------------------------------------------------------------

    PEAK_FRACTION = 0.6  # peak = contiguous weeks around the season maximum at >= 60% of that maximum

    def _weekly_truth(self, target: str) -> pl.DataFrame:
        """One observed value per (location, week) for a target: newest vintage wins across oracle and admissions."""
        oracle_df: Optional[pl.DataFrame] = None
        lf_oracle = self.cache_mgr.scan_oracle()
        if lf_oracle is not None:
            o = lf_oracle.filter(pl.col("target") == target)
            names = o.collect_schema().names()
            if "output_type" in names:
                o = o.filter(pl.col("output_type").is_null() | (pl.col("output_type") != "pmf"))
            cols = [c for c in ("target", "location", "target_end_date", "oracle_value", "as_of") if c in names]
            oracle_df = o.select(cols).collect()

        adm_df: Optional[pl.DataFrame] = None
        use_adm = _is_flu_hosp_target(target)
        if use_adm:
            lf_adm = self.cache_mgr.scan_admissions(target=target)
            if lf_adm is not None:
                adm_names = lf_adm.collect_schema().names()
                adm_cols = [c for c in ("target", "location", "target_end_date", "oracle_value", "as_of") if c in adm_names]
                if {"location", "target_end_date", "oracle_value"}.issubset(adm_cols):
                    lf_adm_f = lf_adm.filter(pl.col("target") == target) if "target" in adm_cols else lf_adm
                    adm_df = lf_adm_f.select(adm_cols).collect()

        return reconcile_weekly_series(
            oracle_df,
            adm_df,
            target,
            include_admissions=use_adm,
        )

    def get_truth_phases(self, target: str) -> pl.DataFrame:
        """
        Weekly truth labelled with its season, season week, and phase for every location:
        'peak' is the contiguous run around the season maximum at >= PEAK_FRACTION of it, 'pre' and
        'post' are the weeks before and after. A season whose highest week is still one of its latest
        observations (and is not over) has not peaked yet, so all of its weeks are 'pre'.
        """
        sources = [
            self.cache_mgr.get_oracle_parquet(),
            self.cache_mgr.get_admissions_parquet(target=target) if _is_flu_hosp_target(target) else None,
        ]
        stamp = (target,) + tuple((str(p), p.stat().st_mtime) if p and p.exists() else None for p in sources)
        with self._phase_cache_lock:
            cached = self._phase_cache.get(target)
            if cached is not None and cached[0] == stamp:
                return cached[1]

        weekly = self._weekly_truth(target)
        out_schema = {"location": pl.String, "target_end_date": pl.String, "season": pl.String,
                      "season_week": pl.Int32, "value": pl.Float64, "phase": pl.String}
        if weekly.is_empty():
            result = pl.DataFrame(schema=out_schema)
            with self._phase_cache_lock:
                self._phase_cache[target] = (stamp, result)
            return result

        cal = self.get_calendar()
        sw = {d: cal.date_to_season_and_week(d) for d in weekly.get_column("target_end_date").unique().to_list()}
        season_of = {d: v[0] for d, v in sw.items()}
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
                season_end = cal.season_bounds(season)[1]
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
        with self._phase_cache_lock:
            if len(self._phase_cache) >= 32:
                self._phase_cache.clear()
            self._phase_cache[target] = (stamp, result)
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

        # Month ticks on the hub's season-week axis (week 1 -> week 52)
        cal = self.get_calendar()
        ref_season = seasons[0] if seasons else cal.season_for_date(datetime.now())
        first_sat = cal.first_week_end_in_season(ref_season)
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
            "reference_season": ref_season,
            "week_dates": week_dates,
        }

    def get_truth_info(self) -> Dict[str, Any]:
        """Which truth sources are merged (newest vintage wins per observation) and how current they are."""
        has_flu_hosp = any(_is_flu_hosp_target(t) for t in self.config.get_targets())
        hubs: List[str] = []
        if self.include_remote:
            for h in self.cache_mgr.active_remote_hub_ids():
                has_oracle = self.remote_store.truth_path(h, "oracle").exists()
                has_adm = has_flu_hosp and self.remote_store.truth_path(h, "admissions").exists()
                if has_oracle or has_adm:
                    hubs.append(h)
        peers = [f"peer:{p['hub_id']}" for p in self.cache_mgr._peer_truth_descriptors()]

        info: Dict[str, Any] = {
            "policy": "latest_vintage",
            "sources": ["repo"] + hubs + peers,
            "as_of": None,
            "latest_observation": None,
            "by_target": {},
        }
        pq = self.cache_mgr.get_oracle_parquet()
        if pq is not None and pq.exists():
            try:
                lf = pl.scan_parquet(pq)
                names = lf.collect_schema().names()
                valid = (
                    lf.filter(pl.col("output_type").is_null() | (pl.col("output_type") != "pmf"))
                    if "output_type" in names else lf
                )
                aggs = [pl.col("target_end_date").max().alias("latest")]
                if "as_of" in names:
                    aggs.append(pl.col("as_of").max().alias("as_of"))
                row = valid.select(aggs).collect().row(0, named=True)
                if row.get("latest"):
                    info["latest_observation"] = str(row["latest"])[:10]
                if row.get("as_of"):
                    info["as_of"] = str(row["as_of"])[:10]
                if "target" in names:
                    per_t = (
                        valid.group_by("target")
                        .agg(pl.col("target_end_date").max().alias("latest"))
                        .collect()
                    )
                    for r in per_t.iter_rows(named=True):
                        if r.get("target") and r.get("latest"):
                            info["by_target"][str(r["target"])] = str(r["latest"])[:10]
            except Exception as exc:
                logger.debug("Could not summarize oracle truth: %s", exc)

        if has_flu_hosp:
            adm_pq = self.cache_mgr.get_admissions_parquet()
            if adm_pq is not None and adm_pq.exists():
                try:
                    lf_adm = pl.scan_parquet(adm_pq)
                    names = lf_adm.collect_schema().names()
                    aggs = [pl.col("target_end_date").max().alias("latest")]
                    if "as_of" in names:
                        aggs.append(pl.col("as_of").max().alias("as_of"))
                    row = lf_adm.select(aggs).collect().row(0, named=True)
                    adm_latest = str(row["latest"])[:10] if row.get("latest") else None
                    adm_asof = str(row["as_of"])[:10] if row.get("as_of") else None
                    if adm_latest and (info["latest_observation"] is None or adm_latest > info["latest_observation"]):
                        info["latest_observation"] = adm_latest
                    if adm_asof and (info["as_of"] is None or adm_asof > info["as_of"]):
                        info["as_of"] = adm_asof
                    if adm_latest:
                        for t in self.config.get_targets():
                            if _is_flu_hosp_target(t):
                                prev = info["by_target"].get(t)
                                if prev is None or adm_latest > prev:
                                    info["by_target"][t] = adm_latest
                except Exception as exc:
                    logger.debug("Could not summarize admissions truth: %s", exc)
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
        self._raw_hub_seasons_cache = None
        self._tasks_mtime = -1.0
        self._hub_seasons_sig = None
        self._locations_cache = None
        self._geo_cache = None
        self._calendar_cache = None
        with self._phase_cache_lock:
            self._phase_cache.clear()

    def _models_from_remote_manifest(
        self,
        man: Dict[str, Any],
        *,
        prefix: Optional[str],
        source: str,
        hub_id: Optional[str],
        hub_label: Optional[str],
        base_dir: Path,
        taken: Set[str],
    ) -> Dict[str, Dict[str, Any]]:
        """Build model inventory entries from a synced remote hub's `manifest.json` without Parquet scans."""
        models: Dict[str, Dict[str, Any]] = {}
        cal = self.get_calendar()
        per_model: Dict[str, Dict[str, Any]] = {}
        peak_info: Dict[str, Dict[str, set]] = {}
        for f in man.get("files", {}).values():
            if not isinstance(f, dict) or not f.get("model"):
                continue
            if f.get("peak_targets"):
                pk = peak_info.setdefault(f["model"], {"targets": set(), "dates": set()})
                pk["targets"].update(f["peak_targets"])
                pk["dates"].add(f["reference_date"])
            if not (f.get("path") or f.get("samples_path") or f.get("pmf_path")):
                continue
            pm = per_model.setdefault(
                f["model"],
                {
                    "dates": set(),
                    "targets": set(),
                    "output_types": set(),
                    "extra_task_ids": set(),
                    "has_samples": False,
                    "has_pmf": False,
                    "from_samples": False,
                    "warnings": [],
                    "revisions": 0,
                    "posted": "",
                },
            )
            pm["dates"].add(f["reference_date"])
            pm["targets"].update(f.get("targets", []))
            pm["output_types"].update(f.get("output_types", []))
            pm["extra_task_ids"].update(f.get("extra_task_ids", []))
            pm["has_samples"] = pm["has_samples"] or bool(f.get("samples")) or ("sample" in f.get("output_types", []))
            pm["has_pmf"] = pm["has_pmf"] or bool(f.get("pmf")) or ("pmf" in f.get("output_types", []))
            pm["from_samples"] = pm["from_samples"] or bool(f.get("from_samples"))
            pm["warnings"].extend(f.get("warnings", []))
            pm["revisions"] += int(f.get("revisions", 0))
            pm["posted"] = max(pm["posted"], f.get("last_modified", ""))
        meta = man.get("metadata", {})
        for name, pm in sorted(per_model.items()):
            key = f"{prefix}:{name}" if prefix else name
            if key in taken:
                continue
            dates = sorted(pm["dates"])
            for w in pm["warnings"]:
                msg = f"[{hub_label}] {w}" if hub_label else str(w)
                self.cache_mgr.warning_registry.add_warning(key, msg)
            entry: Dict[str, Any] = {
                "id": key,
                "raw_name": key,
                "display_name": name,
                "is_local": False,
                "is_synthetic": False,
                "source": source,
                "designated": bool(meta.get(name, {}).get("designated", False)),
                "path": str(base_dir / "model-output" / name),
                "count": len(dates),
                "dates": dates,
                "seasons": sorted({cal.season_for_date(d) for d in dates}),
                # Weekly targets only; season peak targets are listed separately
                "targets": sorted(t for t in pm["targets"] if not is_peak_target(t)),
                "output_types": sorted(pm["output_types"]),
                "extra_task_ids": sorted(pm["extra_task_ids"]),
                "has_samples": pm["has_samples"],
                "has_pmf": pm["has_pmf"],
                "from_samples": pm["from_samples"],
                "peak_targets": sorted(peak_info.get(name, {}).get("targets", [])),
                "peak_dates": sorted(peak_info.get(name, {}).get("dates", [])),
                "family": self.infer_model_family(name),
                "min_date": dates[0] if dates else None,
                "max_date": dates[-1] if dates else None,
                "last_posted": pm["posted"] or None,
                "revision_count": pm["revisions"],
                "warnings_count": len(pm["warnings"]),
            }
            if hub_id is not None:
                entry["hub"] = hub_id
            if hub_label is not None:
                entry["hub_label"] = hub_label
            models[key] = entry
        return models

    def _scan_hub_models(self, taken: Set[str]) -> Dict[str, Dict[str, Any]]:
        """Inventory of models copied from active compatible hubs, read from each hub's manifest (no Parquet scans)."""
        models: Dict[str, Dict[str, Any]] = {}
        active_hubs = set(self.cache_mgr.active_remote_hub_ids())
        for spec in self.remote_store.hub_specs():
            if spec.id not in active_hubs:
                continue
            man = self.remote_store.load_manifest(spec.id)
            models.update(
                self._models_from_remote_manifest(
                    man,
                    prefix=spec.id,
                    source="hub",
                    hub_id=spec.id,
                    hub_label=spec.short_label,
                    base_dir=self.remote_store.hub_dir(spec.id),
                    taken=taken | set(models),
                )
            )
        return models

    def _read_model_meta(
        self, model_id: str, is_local: bool = False, files: Optional[List[Path]] = None
    ) -> Dict[str, Any]:
        """Read cached model summary (targets, output_types, sidecar presence) from meta.json or parquet/raw fallback."""
        dest_dir = self.cache_mgr.local_models_cache_dir if is_local else self.cache_mgr.models_cache_dir
        sidecar_samples_dir = (self.base_dir / "sample-output" / model_id) if not is_local else None
        has_sidecar_samples = bool(
            sidecar_samples_dir and sidecar_samples_dir.is_dir() and any(sidecar_samples_dir.glob("*.parquet"))
        )
        meta_path = dest_dir / f"{model_id}.meta.json"
        if meta_path.exists():
            try:
                with open(meta_path, "r", encoding="utf-8") as f_meta:
                    saved = json.load(f_meta)
                    if isinstance(saved, dict) and isinstance(saved.get("targets"), list):
                        return {
                            "targets": list(saved["targets"]),
                            "output_types": list(saved.get("output_types") or []),
                            "extra_task_ids": list(saved.get("extra_task_ids") or []),
                            "has_samples": bool(saved.get("has_samples", False)) or (dest_dir / f"{model_id}.samples.parquet").exists() or has_sidecar_samples,
                            "has_pmf": bool(saved.get("has_pmf", (dest_dir / f"{model_id}.pmf.parquet").exists())),
                            "from_samples": bool(saved.get("from_samples", False)),
                        }
            except Exception:
                pass

        pq_path = dest_dir / f"{model_id}.parquet"
        has_samples = (dest_dir / f"{model_id}.samples.parquet").exists() or has_sidecar_samples
        has_pmf = (dest_dir / f"{model_id}.pmf.parquet").exists()
        tgts_set: Set[str] = set()
        ots_set: Set[str] = set()
        for cand_pq, ot_label in (
            (pq_path, "quantile"),
            (dest_dir / f"{model_id}.samples.parquet", "sample"),
            (dest_dir / f"{model_id}.pmf.parquet", "pmf"),
        ):
            if not cand_pq.exists():
                continue
            try:
                schema = pl.scan_parquet(cand_pq).collect_schema()
                if "target" in schema.names():
                    tgts_set.update(pl.scan_parquet(cand_pq).select("target").unique().collect()["target"].to_list())
                if "output_type" in schema.names():
                    ots_set.update(pl.scan_parquet(cand_pq).select("output_type").unique().collect()["output_type"].to_list())
                else:
                    ots_set.add(ot_label)
            except Exception:
                pass
        if tgts_set:
            tgts = sorted(str(t) for t in tgts_set if t is not None)
            ots = sorted(str(o) for o in ots_set if o is not None)
            lock_key = f"meta::{'local' if is_local else 'repo'}::{model_id}"
            with self.cache_mgr._model_locks.get(lock_key):
                if meta_path.exists():
                    tmp_meta = meta_path.with_suffix(f".tmp.{os.getpid()}.{threading.get_ident()}.json")
                    try:
                        with open(meta_path, "r", encoding="utf-8") as f_meta:
                            saved = json.load(f_meta)
                        saved["targets"] = tgts
                        if ots:
                            saved["output_types"] = ots
                        saved["has_samples"] = has_samples
                        saved["has_pmf"] = has_pmf
                        with open(tmp_meta, "w", encoding="utf-8") as f_meta:
                            json.dump(saved, f_meta)
                        os.replace(tmp_meta, meta_path)
                    except Exception:
                        pass
                    finally:
                        tmp_meta.unlink(missing_ok=True)
            return {
                "targets": tgts,
                "output_types": ots,
                "extra_task_ids": [],
                "has_samples": has_samples,
                "has_pmf": has_pmf,
                "from_samples": False,
            }

        from viz.core.ingest import STANDARD_RAW_COLS

        targets: Set[str] = set()
        output_types: Set[str] = set()
        extra_task_ids: Set[str] = set()
        if files:
            sample_files = [files[0]] if len(files) == 1 else [files[0], files[-1]]
            for sample_f in sample_files:
                try:
                    if sample_f.suffix == ".parquet":
                        lf_s = pl.scan_parquet(sample_f)
                        s_cols = lf_s.collect_schema().names()
                        extra_task_ids.update(c for c in s_cols if c not in STANDARD_RAW_COLS)
                        if "target" in s_cols:
                            targets.update(lf_s.select("target").unique().collect()["target"].to_list())
                        if "output_type" in s_cols:
                            output_types.update(lf_s.select("output_type").unique().collect()["output_type"].to_list())
                    elif sample_f.suffix == ".csv":
                        df_sample = pl.read_csv(sample_f, n_rows=200)
                        extra_task_ids.update(c for c in df_sample.columns if c not in STANDARD_RAW_COLS)
                        if "target" in df_sample.columns:
                            targets.update(df_sample["target"].drop_nulls().unique().to_list())
                        if "output_type" in df_sample.columns:
                            output_types.update(df_sample["output_type"].drop_nulls().unique().to_list())
                except Exception:
                    pass
        return {
            "targets": sorted(str(t) for t in targets if t is not None),
            "output_types": sorted(str(o) for o in output_types if o is not None),
            "extra_task_ids": sorted(extra_task_ids),
            "has_samples": has_samples or ("sample" in output_types),
            "has_pmf": has_pmf or ("pmf" in output_types),
            "from_samples": False,
        }

    def _get_model_targets(self, model_id: str, is_local: bool = False, files: Optional[List[Path]] = None) -> List[str]:
        """Detect and return distinct targets forecasted by the model, cached in meta.json."""
        return self._read_model_meta(model_id, is_local=is_local, files=files)["targets"]

    @staticmethod
    def _find_round_file(directory: Path, date_str: str) -> Optional[Path]:
        """Find a single forecast file for `date_str` inside `directory`, preferring Parquet."""
        if not directory.is_dir():
            return None
        for ext in (".parquet", ".csv"):
            matches = sorted(directory.glob(f"{date_str}-*{ext}"))
            if matches:
                return matches[0]
        return None

    def _read_round_values(self, file_path: Path) -> Optional[pl.DataFrame]:
        """Read a single CSV/Parquet round file with canonical key + value columns for dedup comparison."""
        try:
            if file_path.suffix.lower() == ".parquet":
                df = pl.read_parquet(file_path)
            else:
                df = pl.read_csv(
                    file_path,
                    schema_overrides={
                        "location": pl.String,
                        "output_type_id": pl.String,
                        "target": pl.String,
                        "output_type": pl.String,
                        "reference_date": pl.String,
                        "origin_date": pl.String,
                        "horizon": pl.Int32,
                        "value": pl.Float64,
                    },
                    null_values=NULL_VALUES,
                    ignore_errors=False,
                )
        except Exception as exc:
            logger.debug("Dedup read failed on %s: %s", file_path, exc)
            return None

        if df.is_empty():
            return None
        pad_fips = bool(getattr(self.get_geo_graph(), "uses_us_fips", True))
        cols = set(df.columns)
        exprs = [
            (pl.col("target").cast(pl.String) if "target" in cols else pl.lit("")).fill_null("").alias("target"),
            (pl.col("location").cast(pl.String) if "location" in cols else pl.lit("")).fill_null("").alias("location"),
            (
                pl.col("horizon").cast(pl.Float64, strict=False).cast(pl.Int32, strict=False)
                if "horizon" in cols else pl.lit(-999999, dtype=pl.Int32)
            ).fill_null(-999999).alias("horizon"),
            (pl.col("output_type").cast(pl.String) if "output_type" in cols else pl.lit("quantile")).fill_null("").alias("output_type"),
            (pl.col("output_type_id").cast(pl.String) if "output_type_id" in cols else pl.lit("")).fill_null("").alias("output_type_id"),
            (pl.col("value").cast(pl.Float64, strict=False) if "value" in cols else pl.lit(None, dtype=pl.Float64)).fill_nan(None).alias("value"),
        ]
        out = df.select(exprs)
        if pad_fips:
            out = out.with_columns(
                pl.when(pl.col("location").str.contains(r"^\d$"))
                .then("0" + pl.col("location"))
                .otherwise(pl.col("location"))
                .alias("location")
            )
        return out.unique(subset=["target", "location", "horizon", "output_type", "output_type_id"], keep="last")

    def _remote_model_fingerprint(self, hub_id: str, hub_model_name: str) -> Dict[str, Any]:
        """Combined file fingerprint across remote model, sample, and pmf output folders."""
        count = 0
        total_size = 0
        max_mtime = 0.0
        for d in (
            self.remote_store.model_dir(hub_id, hub_model_name),
            self.remote_store.sample_dir(hub_id, hub_model_name),
            self.remote_store.pmf_dir(hub_id, hub_model_name),
        ):
            _, fp = self.cache_mgr._scan_source_files(d)
            count += fp["count"]
            total_size += fp["total_size"]
            max_mtime = max(max_mtime, fp["max_mtime"])
        return {"count": count, "total_size": total_size, "max_mtime": max_mtime}

    def _models_values_match(self, repo_name: str, hub_id: str, hub_model_name: str, common_dates: List[str]) -> bool:
        """
        Return True when a repo model and a remote hub model agree in forecast values on sampled overlapping rounds.
        Results are persisted in `<cache_dir>/model_dedup.json` keyed by file fingerprints.
        """
        if not common_dates:
            return False
        _, repo_fp = self.cache_mgr._scan_source_files(self.model_output_dir / repo_name)
        hub_fp = self._remote_model_fingerprint(hub_id, hub_model_name)
        cur_fp = {"repo": repo_fp, "hub": hub_fp}

        dedup_path = self.cache_mgr.cache_dir / "model_dedup.json"
        cache_key = f"{repo_name}|{hub_id}:{hub_model_name}"
        with self._dedup_lock:
            if dedup_path.is_file():
                try:
                    saved = json.loads(dedup_path.read_text(encoding="utf-8"))
                    ent = saved.get(cache_key) if isinstance(saved, dict) else None
                    if isinstance(ent, dict) and ent.get("fp") == cur_fp:
                        return bool(ent.get("match"))
                except (OSError, ValueError):
                    pass

        picks: List[str] = []
        for idx in (-1, 0, len(common_dates) // 2):
            d = common_dates[idx]
            if d not in picks:
                picks.append(d)

        key_cols = ["target", "location", "horizon", "output_type", "output_type_id"]
        verified_any = False
        matched = True
        for d in picks:
            local_file = self._find_round_file(self.model_output_dir / repo_name, d)
            if local_file is None:
                continue
            hub_frames = []
            for hdir in (
                self.remote_store.model_dir(hub_id, hub_model_name),
                self.remote_store.pmf_dir(hub_id, hub_model_name),
                self.remote_store.sample_dir(hub_id, hub_model_name),
            ):
                hf = self._find_round_file(hdir, d)
                if hf is not None:
                    hdf = self._read_round_values(hf)
                    if hdf is not None and not hdf.is_empty():
                        hub_frames.append(hdf)
            if not hub_frames:
                continue
            df_l = self._read_round_values(local_file)
            if df_l is None or df_l.is_empty():
                continue
            df_h = pl.concat(hub_frames, how="vertical").unique(subset=key_cols, keep="first")
            joined = df_l.join(df_h, on=key_cols, how="inner", suffix="_hub")
            if joined.is_empty():
                continue
            verified_any = True
            diff_ok = (
                (pl.col("value").is_null() & pl.col("value_hub").is_null())
                | (
                    pl.col("value").is_not_null()
                    & pl.col("value_hub").is_not_null()
                    & (
                        (pl.col("value") - pl.col("value_hub")).abs()
                        <= 1e-5 * pl.max_horizontal(pl.lit(1.0), pl.col("value").abs(), pl.col("value_hub").abs())
                    )
                )
            )
            if not bool(joined.select(diff_ok.all()).item()):
                matched = False
                break

        result = bool(verified_any and matched)
        with self._dedup_lock:
            existing: Dict[str, Any] = {}
            if dedup_path.is_file():
                try:
                    raw = json.loads(dedup_path.read_text(encoding="utf-8"))
                    if isinstance(raw, dict):
                        existing = raw
                except (OSError, ValueError):
                    existing = {}
            existing[cache_key] = {"fp": cur_fp, "match": result}
            dedup_path.parent.mkdir(parents=True, exist_ok=True)
            tid = f"{os.getpid()}_{threading.get_ident()}"
            tmp = dedup_path.with_suffix(f".tmp.{tid}.json")
            try:
                tmp.write_text(json.dumps(existing), encoding="utf-8")
                os.replace(tmp, dedup_path)
            finally:
                tmp.unlink(missing_ok=True)
        return result

    def _deduplicate_repo_and_hub_models(self, models: Dict[str, Dict[str, Any]]) -> None:
        """Merge remote hub duplicates with identical local repo models while preserving genuine local forks."""
        for hub_key_id, hub_info in list(models.items()):
            if hub_info.get("source") != "hub":
                continue
            hub_id = hub_info.get("hub")
            name = hub_info.get("display_name") or (hub_key_id.split(":", 1)[1] if ":" in hub_key_id else "")
            if not hub_id or not name or name not in models:
                continue
            repo_info = models[name]
            if repo_info.get("source") != "repo":
                continue

            repo_dates = set(repo_info.get("dates") or [])
            hub_dates = set(hub_info.get("dates") or [])
            common = sorted(repo_dates & hub_dates)
            if not common or not self._models_values_match(name, hub_id, name, common):
                continue

            merged_targets = sorted(set(repo_info.get("targets") or []) | set(hub_info.get("targets") or []))
            merged_ot = sorted(set(repo_info.get("output_types") or []) | set(hub_info.get("output_types") or []))
            merged_extra = sorted(set(repo_info.get("extra_task_ids") or []) | set(hub_info.get("extra_task_ids") or []))
            merged_peaks_t = sorted(set(repo_info.get("peak_targets") or []) | set(hub_info.get("peak_targets") or []))
            merged_peaks_d = sorted(set(repo_info.get("peak_dates") or []) | set(hub_info.get("peak_dates") or []))
            designated = bool(repo_info.get("designated") or hub_info.get("designated"))
            has_samples = bool(repo_info.get("has_samples") or hub_info.get("has_samples"))
            has_pmf = bool(repo_info.get("has_pmf") or hub_info.get("has_pmf"))
            from_samples = bool(repo_info.get("from_samples") or hub_info.get("from_samples"))

            if hub_dates <= repo_dates:
                needs_hub_sidecar = bool(
                    (hub_info.get("has_samples") and not repo_info.get("has_samples"))
                    or (hub_info.get("has_pmf") and not repo_info.get("has_pmf"))
                )
                repo_info["designated"] = designated
                repo_info["targets"] = merged_targets
                repo_info["output_types"] = merged_ot
                repo_info["extra_task_ids"] = merged_extra
                repo_info["has_samples"] = has_samples
                repo_info["has_pmf"] = has_pmf
                repo_info["from_samples"] = from_samples
                if needs_hub_sidecar:
                    repo_info["raw_name"] = f"merged:{hub_id}:{name}"
                if merged_peaks_t:
                    repo_info["peak_targets"] = merged_peaks_t
                if merged_peaks_d:
                    repo_info["peak_dates"] = merged_peaks_d
                repo_info["dedup_from_hub"] = hub_id
            elif repo_dates < hub_dates:
                dates = list(hub_info.get("dates") or [])
                repo_info.update({
                    "raw_name": hub_key_id,
                    "dates": dates,
                    "seasons": list(hub_info.get("seasons") or []),
                    "targets": merged_targets,
                    "output_types": merged_ot,
                    "extra_task_ids": merged_extra,
                    "has_samples": has_samples,
                    "has_pmf": has_pmf,
                    "from_samples": from_samples,
                    "peak_targets": merged_peaks_t,
                    "peak_dates": merged_peaks_d,
                    "count": len(dates),
                    "min_date": hub_info.get("min_date"),
                    "max_date": hub_info.get("max_date"),
                    "designated": designated,
                    "dedup_from_hub": hub_id,
                })
            else:
                union_dates = sorted(repo_dates | hub_dates)
                repo_info.update({
                    "raw_name": f"merged:{hub_id}:{name}",
                    "dates": union_dates,
                    "seasons": sorted(set(repo_info.get("seasons") or []) | set(hub_info.get("seasons") or [])),
                    "targets": merged_targets,
                    "output_types": merged_ot,
                    "extra_task_ids": merged_extra,
                    "has_samples": has_samples,
                    "has_pmf": has_pmf,
                    "from_samples": from_samples,
                    "peak_targets": merged_peaks_t,
                    "peak_dates": merged_peaks_d,
                    "count": len(union_dates),
                    "min_date": union_dates[0] if union_dates else None,
                    "max_date": union_dates[-1] if union_dates else None,
                    "designated": designated,
                    "dedup_from_hub": hub_id,
                })
            del models[hub_key_id]

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

            cal = self.get_calendar()
            models = {}

            # 1. Production / Main model-output (or synced remote manifest.json when opened standalone)
            base_manifest_file = self.base_dir / "manifest.json"
            used_standalone_manifest = False
            if not self.include_remote and base_manifest_file.is_file():
                try:
                    standalone_man = json.loads(base_manifest_file.read_text(encoding="utf-8"))
                    if isinstance(standalone_man, dict) and isinstance(standalone_man.get("files"), dict):
                        models.update(
                            self._models_from_remote_manifest(
                                standalone_man,
                                prefix=None,
                                source="repo",
                                hub_id=None,
                                hub_label=None,
                                base_dir=self.base_dir,
                                taken=set(),
                            )
                        )
                        used_standalone_manifest = True
                except (OSError, ValueError):
                    pass

            if not used_standalone_manifest and self.model_output_dir.exists():
                for p in sorted(self.model_output_dir.iterdir()):
                    if p.is_dir() and not p.name.startswith("."):
                        forecast_files = sorted(list(p.glob("*.csv")) + list(p.glob("*.parquet")), key=lambda f: f.name)
                        if forecast_files:
                            dates = [f.name[:10] for f in forecast_files if len(f.name) >= 10]
                            seasons = sorted(list(set(cal.season_for_date(d) for d in dates)))
                            mmeta = self._read_model_meta(p.name, is_local=False, files=forecast_files)
                            targets = [t for t in mmeta["targets"] if not is_peak_target(t)]
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
                                "output_types": mmeta["output_types"],
                                "extra_task_ids": mmeta["extra_task_ids"],
                                "has_samples": mmeta["has_samples"],
                                "has_pmf": mmeta["has_pmf"],
                                "from_samples": mmeta["from_samples"],
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
                            seasons = sorted(list(set(cal.season_for_date(d) for d in dates)))
                            model_key = p.name
                            display_name = f"{p.name} (Local)"
                            if p.name in models:
                                model_key = f"local:{p.name}"
                                msg = f"Model collision: '{p.name}' exists in both model-output/ and local-output/. Local run registered as '{model_key}'."
                                logger.info(msg)
                                self.cache_mgr.warning_registry.add_warning(model_key, msg)

                            mmeta = self._read_model_meta(p.name, is_local=True, files=forecast_files)
                            targets = [t for t in mmeta["targets"] if not is_peak_target(t)]
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
                                "output_types": mmeta["output_types"],
                                "extra_task_ids": mmeta["extra_task_ids"],
                                "has_samples": mmeta["has_samples"],
                                "has_pmf": mmeta["has_pmf"],
                                "from_samples": mmeta["from_samples"],
                                "family": self.infer_model_family(p.name),
                                "min_date": dates[0] if dates else None,
                                "max_date": dates[-1] if dates else None,
                            }

            # 3. Models copied from live hubs (namespaced '<hub>:<model>', so they never collide with repo models)
            if self.include_remote:
                models.update(self._scan_hub_models(set(models)))
                self._deduplicate_repo_and_hub_models(models)

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
                    seasons = sorted(list(set(cal.season_for_date(d) for d in ens_dates)), reverse=True)
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
                        "output_types": ["quantile"],
                        "extra_task_ids": [],
                        "has_samples": False,
                        "has_pmf": False,
                        "from_samples": False,
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

        # Direct file fallback if cache miss (supports CSV, Parquet, hub:, and merged: keys)
        merged = self.cache_mgr.merged_key(raw_id)
        hub = self.cache_mgr.hub_key(raw_id)
        if merged is not None:
            m_hub, m_name = merged
            candidates = [
                self.model_output_dir / m_name / f"{reference_date}-{m_name}.parquet",
                self.model_output_dir / m_name / f"{reference_date}-{m_name}.csv",
                self.remote_store.model_dir(m_hub, m_name) / f"{reference_date}-{m_name}.parquet",
                self.remote_store.model_dir(m_hub, m_name) / f"{reference_date}-{m_name}.csv",
            ]
        elif hub is not None:
            candidates = [
                self.remote_store.model_dir(*hub) / f"{reference_date}-{hub[1]}.parquet",
                self.remote_store.model_dir(*hub) / f"{reference_date}-{hub[1]}.csv",
            ]
        else:
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
        sub = (
            self._weekly_truth(target)
            .filter(pl.col("location") == str(location))
            .select(["target_end_date", pl.col("value").alias("oracle_value")])
            .sort("target_end_date")
        )

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

        # Determine focal season bounds using hub calendar
        try:
            cal = self.get_calendar()
            s_str = cal.season_for_date(reference_date)
            season_start_date, season_end_date = cal.season_bounds(s_str)
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
        precise: bool = False,
    ) -> Dict[str, Any]:
        """
        Load auxiliary surveillance streams (NSSP, ILINet, FluSurv-NET) and prior season waves
        for the given location and reference date window.

        precise=True leaves the as-of series unrounded (old viz rounds it to 1 decimal, which turns
        proportions into 0.0); the default output is unchanged.
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
        cal = self.get_calendar()
        ref_season, _ = cal.date_to_season_and_week(ref_dt) if ref_dt else cal.date_to_season_and_week(datetime.now())
        first_wk_end = cal.first_week_end_in_season(ref_season)
        ref_calendar = {
            wk: (first_wk_end + timedelta(weeks=wk - 1)).strftime("%Y-%m-%d")
            for wk in range(1, 54)
        }

        # Load historical admissions (flu hosp only) or oracle truth for this target
        lf_adm = self.cache_mgr.scan_admissions(target=target) if _is_flu_hosp_target(target) else None
        if lf_adm is not None and "target" in lf_adm.collect_schema().names():
            lf_adm = lf_adm.filter(pl.col("target") == target)
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
                    s_str, s_wk = cal.date_to_season_and_week(d_str)
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
                        label = f"'{s_key[2:4]}–'{s_key[-2:]} Season" if "-" in s_key else f"{s_key} Season"
                        result["historical_seasons"][s_key] = {
                            "season": s_key,
                            "label": label,
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
                        if cal.season_for_date(d_str) == ref_season:
                            as_of_data.append({
                                "date": d_str,
                                "value": v_val if precise else round(v_val, 1),
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
        self, target: str, reference_date: str, model_ids: List[str], horizon: Optional[Union[int, str]] = None,
        precise: bool = False,
    ) -> Dict[str, Any]:
        """
        Extract multi-model spatial predictions, population-adjusted rates,
        growth trajectories, and evaluation metrics across all 50 states + DC + PR.

        precise=True leaves forecast values, errors and WIS unrounded (the default rounds them, which
        turns proportion targets into 0.0); the default output is unchanged.
        """
        def rnd(v: Optional[float], n: int) -> Optional[float]:
            if v is None:
                return None
            return v if precise else round(v, n)

        locations = self.get_locations()
        # Per-100k rates only make sense for counts; rate/proportion targets are already normalized
        per_100k = not self.config.get_target_metadata(target)["is_rate"]

        # Oracle truth (include -14d window so negative horizon_offset_days such as RespiCast h=0 are retained)
        try:
            obs_since = (date.fromisoformat(str(reference_date)[:10]) - timedelta(days=14)).isoformat()
        except ValueError:
            obs_since = reference_date
        lf_o = self.cache_mgr.scan_oracle()
        o_sub = pl.DataFrame()
        if lf_o is not None:
            o_sub = (
                lf_o.filter((pl.col("target") == target) & (pl.col("target_end_date") >= obs_since))
                .collect()
            )
            if not o_sub.is_empty():
                if "as_of" in o_sub.columns:
                    o_sub = o_sub.sort("as_of").group_by(["location", "target_end_date"]).last()
                o_sub = o_sub.select(["location", "target_end_date", "oracle_value"]).drop_nulls()

        geo = self.get_geo_graph()
        primary_ids = set(geo.resolve_pool("all") or [l for l in locations if l != "US"])
        agg_ids = set(geo.aggregate_locations_in_scope())
        spatial_ids = primary_ids | agg_ids

        states_data = {}
        locations_data = {}
        for loc_id, loc_info in locations.items():
            if loc_id not in spatial_ids:
                continue
            abbr = loc_info["abbreviation"]
            pop = loc_info.get("population")
            rec = {
                "id": loc_id,
                "fips": loc_id,
                "abbr": abbr,
                "name": loc_info["name"],
                "population": pop,
                "truth": {},
                "truth_rate": {},
                "models": {},
            }
            locations_data[loc_id] = rec
            if loc_id in primary_ids and abbr not in states_data:
                states_data[abbr] = rec

        if not o_sub.is_empty():
            for row in o_sub.iter_rows(named=True):
                loc = str(row["location"])
                if loc in locations and loc in spatial_ids:
                    val = float(row["oracle_value"]) if row["oracle_value"] is not None and not np.isnan(row["oracle_value"]) else None
                    ted = str(row["target_end_date"])
                    pop = locations[loc].get("population") or 1
                    rate = round((val / pop) * 100000, 2) if per_100k and val is not None and pop > 1 else None
                    locations_data[loc]["truth"][ted] = val
                    locations_data[loc]["truth_rate"][ted] = rate

        available_horizons = set()
        dates_by_horizon = {}
        all_models_meta = self.scan_models()

        for mid in model_ids:
            raw_mid, is_local = self._resolve_model_id_and_local(mid)
            lf_m = self.cache_mgr.scan_model(raw_mid, is_local=is_local)
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

            base_h = 0
            h_vals = [int(x) for x in piv.get_column("horizon").to_list() if x is not None]
            if h_vals:
                base_h = 0 if 0 in h_vals else min(h_vals)

            h0_medians = {}
            if c_05 is not None:
                h0_rows = piv.filter(pl.col("horizon") == base_h).select(["location", c_05]).iter_rows()
                for loc, med in h0_rows:
                    if med is not None and not np.isnan(med):
                        h0_medians[str(loc)] = float(med)

            for row in piv.iter_rows(named=True):
                loc = str(row["location"])
                if loc not in locations or loc not in spatial_ids:
                    continue
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

                loc_rec = locations_data[loc]
                truth_val = loc_rec["truth"].get(ted)
                error = rnd(med - truth_val, 1) if med is not None and truth_val is not None else None

                if mid not in loc_rec["models"]:
                    loc_rec["models"][mid] = {}

                loc_rec["models"][mid][h] = {
                    "median": rnd(med, 1),
                    "rate_per_100k": rate,
                    "q025": rnd(q025, 1),
                    "q975": rnd(q975, 1),
                    "q25": rnd(q25, 1),
                    "q75": rnd(q75, 1),
                    "trend_pct": trend_pct,
                    "wis": rnd(wis, 2),
                    "error": error,
                    "target_end_date": ted,
                }

        sorted_horizons = sorted(list(available_horizons))
        return {
            "target": target,
            "reference_date": reference_date,
            "horizons": sorted_horizons,
            "available_horizons": sorted_horizons,
            "dates_by_horizon": dates_by_horizon,
            "states": states_data,
            "locations": locations_data,
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
        horizons: Optional[List[int]] = None,
        dates: Optional[List[str]] = None,
        fair: Union[bool, str] = False,
    ) -> Dict[str, Any]:
        """
        horizons / dates (optional, default off so existing callers are unchanged): score only these
        horizons, and only these reference dates within the season scope (the next/ evaluation window).
        fair (optional, default False): restrict model comparison modes to shared tasks across all requested models.

        Extract multi-dimensional matrix cross-sections for heatmap visualization:
        Directly driven by user-selected ROWS and COLS (Location, Model, Date, Horizon),
        with exact Leaderboard parity for TIME (Date, Season, Custom Seasons, All Time)
        and LOC (All States vs Single Location).
        """
        if isinstance(fair, str):
            fair = fair.lower() in ("1", "true", "yes")
        else:
            fair = bool(fair)
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
        # Jurisdiction Filter (Primary Jurisdictions vs Aggregates / Region)
        # -------------------------------------------------------------
        geo = self.get_geo_graph()
        primary_ids = set(geo.resolve_pool("all") or [l for l in locations if l != "US"])
        all_state_items = [
            (info.get("abbreviation") or loc_id, loc_id, info)
            for loc_id, info in locations.items()
            if (info.get("abbreviation") or loc_id) and loc_id in primary_ids
        ]

        def resolve_state_items(loc_param: Optional[str]) -> List[Tuple[str, str, Dict[str, Any]]]:
            if not loc_param or loc_param.lower() in ("states", "primary", "all", ""):
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
            # GeoGraph hierarchical/aggregate pools (aggregates, level:*, region:*)
            if p.lower() == "aggregates" or p.lower().startswith(("level:", "region:")):
                pooled = geo.resolve_pool(p)
                if pooled:
                    return [
                        (locations[lid].get("abbreviation") or lid, lid, locations[lid])
                        for lid in pooled
                        if lid in locations
                    ]
            # Abbreviation match (e.g. "CA", "MA", "DE")
            matched_abbr = [item for item in all_state_items if item[0].upper() == p.upper()]
            if matched_abbr:
                return matched_abbr
            # Location ID match (e.g. "06", "25", "provo")
            matched_fips = [item for item in all_state_items if item[1] == p]
            if matched_fips:
                return matched_fips
            # Explicit aggregate / "US" national match
            if p in locations:
                info = locations[p]
                return [(info.get("abbreviation") or p, p, info)]
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
        cal = self.get_calendar()
        if season and season != "all":
            if season == "current":
                focal_season = cal.season_for_date(all_dates[-1]) if all_dates else cal.season_for_date(datetime.now())
                seasons_set = {focal_season}
            else:
                seasons_set = {s.strip() for s in season.split(",") if s.strip()}
            scope_dates = [d for d in all_dates if cal.season_for_date(d) in seasons_set]
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
        if dates:
            keep = set(dates)
            scope_dates = [d for d in scope_dates if d in keep]

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
                if lf_m is None and all_models_meta.get(model_id, {}).get("is_synthetic") and scope_dates:
                    df_syn = self.load_combined_forecasts(model_id, dates=scope_dates, as_polars=True)
                    lf_m = df_syn.lazy() if df_syn is not None and not df_syn.is_empty() else None
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
            def_base = self.config.get_default_baseline(list(all_models_meta.keys()), target=target)
            m_target = model_id or (model_ids[0] if model_ids else (def_base or (next(iter(all_models_meta.keys()), ""))))
            raw_mid, is_loc = self._resolve_model_id_and_local(m_target)

            lf_m = self.cache_mgr.scan_model(raw_mid, is_local=is_loc)
            if lf_m is None and all_models_meta.get(m_target, {}).get("is_synthetic") and ref_date:
                df_syn = self.load_combined_forecasts(m_target, dates=[ref_date], as_polars=True)
                lf_m = df_syn.lazy() if df_syn is not None and not df_syn.is_empty() else None
            lf_o = self.cache_mgr.scan_oracle()

            def _resolve_h_cols(df_sub: Optional[pl.DataFrame]) -> List[int]:
                if horizons:
                    return sorted(set(int(h) for h in horizons))
                if df_sub is not None and not df_sub.is_empty() and "horizon" in df_sub.columns:
                    hs = sorted(int(h) for h in df_sub.get_column("horizon").drop_nulls().unique().to_list() if int(h) >= 0)
                    if hs:
                        return hs
                tmeta_h = self.config.get_target_metadata(target).get("horizons") or {}
                meta_hs = sorted({int(h) for h in (*(tmeta_h.get("required") or ()), *(tmeta_h.get("optional") or ())) if int(h) >= 0})
                return meta_hs or [0, 1, 2, 3]

            target_locs = [loc_id for _, loc_id, _ in state_items]
            sub = pl.DataFrame()
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
            eff_horizons = _resolve_h_cols(sub)
            x_keys = [str(h) for h in eff_horizons]
            x_labels = [f"h={h}" + (" (Nowcast)" if h == 0 else f" (+{h} Wk)") for h in eff_horizons]
            y_keys = [abbr for abbr, _, _ in state_items]
            y_labels = [abbr_to_name.get(abbr, abbr) if abbr != "US" else "US National" for abbr in y_keys]

            h_grid: Dict[str, Dict[int, Dict[str, Any]]] = {abbr: {} for abbr in y_keys}

            df_o_map: Dict[Tuple[str, str], float] = {}
            if lf_o is not None and ref_date:
                try:
                    obs_since = (datetime.strptime(ref_date[:10], "%Y-%m-%d").date() + timedelta(days=int(cal.horizon_offset_days) - 7)).isoformat()
                except ValueError:
                    obs_since = ref_date
                o_q = lf_o.filter((pl.col("target") == target) & (pl.col("target_end_date") >= obs_since) & pl.col("location").is_in(target_locs))
                if "output_type" in o_q.collect_schema().names():
                    o_q = o_q.filter(pl.col("output_type").is_null() | (pl.col("output_type") != "pmf"))
                df_o = o_q.collect()
                if not df_o.is_empty():
                    if "as_of" in df_o.columns:
                        df_o = df_o.sort("as_of").group_by(["location", "target_end_date"]).last()
                    for r in df_o.select(["location", "target_end_date", "oracle_value"]).iter_rows(named=True):
                        if r["oracle_value"] is not None and not np.isnan(r["oracle_value"]):
                            df_o_map[(str(r["location"]), str(r["target_end_date"]))] = float(r["oracle_value"])

            if not sub.is_empty():
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

                for h in eff_horizons:
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
            def_base = self.config.get_default_baseline(list(all_models_meta.keys()), target=target)
            m_target = model_id or (model_ids[0] if model_ids else (def_base or next(iter(all_models_meta.keys()), "")))
            raw_mid, is_loc = self._resolve_model_id_and_local(m_target)
            fips = state_items[0][1] if state_items else "US"
            abbr = state_items[0][0] if state_items else "US"
            pop = abbr_to_pop.get(abbr, 1) if state_items else 1

            lf_m = self.cache_mgr.scan_model(raw_mid, is_local=is_loc)
            if lf_m is None and all_models_meta.get(m_target, {}).get("is_synthetic") and scope_dates:
                df_syn = self.load_combined_forecasts(m_target, dates=scope_dates, as_polars=True)
                lf_m = df_syn.lazy() if df_syn is not None and not df_syn.is_empty() else None
            lf_o = self.cache_mgr.scan_oracle()
            df_o_map: Dict[str, float] = {}
            if lf_o is not None:
                o_q = lf_o.filter((pl.col("target") == target) & (pl.col("location") == fips))
                if "output_type" in o_q.collect_schema().names():
                    o_q = o_q.filter(pl.col("output_type").is_null() | (pl.col("output_type") != "pmf"))
                df_o = o_q.collect()
                if not df_o.is_empty():
                    if "as_of" in df_o.columns:
                        df_o = df_o.sort("as_of").group_by("target_end_date").last()
                    for r in df_o.select(["target_end_date", "oracle_value"]).iter_rows(named=True):
                        if r["oracle_value"] is not None and not np.isnan(r["oracle_value"]):
                            df_o_map[str(r["target_end_date"])] = float(r["oracle_value"])

            sub = pl.DataFrame()
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
            if horizons:
                eff_horizons = sorted(set(int(h) for h in horizons))
            elif not sub.is_empty() and "horizon" in sub.columns:
                hs = sorted(int(h) for h in sub.get_column("horizon").drop_nulls().unique().to_list() if int(h) >= 0)
                eff_horizons = hs or [0, 1, 2, 3]
            else:
                tmeta_h = self.config.get_target_metadata(target).get("horizons") or {}
                eff_horizons = sorted({int(h) for h in (*(tmeta_h.get("required") or ()), *(tmeta_h.get("optional") or ())) if int(h) >= 0}) or [0, 1, 2, 3]
            x_keys = [str(h) for h in eff_horizons]
            x_labels = [f"h={h}" + (" (Nowcast)" if h == 0 else f" (+{h} Wk)") for h in eff_horizons]
            y_keys = scope_dates
            y_labels = [d for d in scope_dates]

            dh_grid: Dict[str, Dict[int, Dict[str, Any]]] = {d: {} for d in scope_dates}
            if not sub.is_empty():
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
                for h in eff_horizons:
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
                def_b = self.config.get_default_baseline(list(all_models_meta.keys()), target=target)
                cand_mids = [def_b] if def_b else []

            oracle = self.get_oracle(as_polars=True)
            pop_map = None if is_rate_target else {loc: info["population"] for loc, info in locations.items() if info.get("population")}
            target_non_neg = self.config.is_target_non_negative(target)

            target_loc_fips = {loc_id for _, loc_id, _ in state_items}

            # Task dataframes scored for each model
            model_task_dfs: Dict[str, pl.DataFrame] = {}
            for mid in cand_mids:
                raw_id, is_loc = self._resolve_model_id_and_local(mid)
                lf = self.cache_mgr.scan_model(raw_id, is_local=is_loc)
                if lf is None and all_models_meta.get(mid, {}).get("is_synthetic") and scope_dates:
                    df_syn = self.load_combined_forecasts(mid, dates=scope_dates, as_polars=True)
                    lf = df_syn.lazy() if df_syn is not None and not df_syn.is_empty() else None
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
                    tdf_m = sc["task_df"].filter(pl.col("location").is_in(list(target_loc_fips)))
                    if horizons and "horizon" in tdf_m.columns:
                        tdf_m = tdf_m.filter(pl.col("horizon").is_in(list(horizons)))
                    model_task_dfs[mid] = tdf_m

            if fair and len(cand_mids) >= 2:
                present_tdfs = [model_task_dfs.get(m) for m in cand_mids]
                if any(tdf is None or tdf.is_empty() for tdf in present_tdfs):
                    for mid in list(model_task_dfs.keys()):
                        model_task_dfs[mid] = model_task_dfs[mid].head(0)
                else:
                    extra_dim_cols = [
                        c for c in self.config.get_extra_task_ids(target)
                        if all(c in tdf.columns for tdf in present_tdfs)
                    ]
                    join_cols = ["location", "reference_date", "horizon"] + extra_dim_cols
                    common = present_tdfs[0].select(join_cols).unique()
                    for tdf in present_tdfs[1:]:
                        common = common.join(tdf.select(join_cols).unique(), on=join_cols, how="inner")
                    for mid in cand_mids:
                        model_task_dfs[mid] = model_task_dfs[mid].join(common, on=join_cols, how="inner")

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
                                    "wis": round(row["wis"], 4) if row["wis"] is not None and not np.isnan(row["wis"]) else None,
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
                if horizons:
                    eff_horizons = sorted(set(int(h) for h in horizons))
                else:
                    obs_hs = sorted({
                        int(hv)
                        for tdf in model_task_dfs.values()
                        if tdf is not None and not tdf.is_empty() and "horizon" in tdf.columns
                        for hv in tdf.get_column("horizon").drop_nulls().unique().to_list()
                        if int(hv) >= 0
                    })
                    eff_horizons = obs_hs or [0, 1, 2, 3]
                x_keys = [str(h) for h in eff_horizons]
                x_labels = [f"h={h}" + (" (Nowcast)" if h == 0 else f" (+{h} Wk)") for h in eff_horizons]

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
                    for h in eff_horizons:
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

    def _latest_truth_date(self) -> Optional[str]:
        """Return the latest observed target_end_date across reconciled oracle and admissions Parquets."""
        getters = [self.cache_mgr.get_oracle_parquet]
        if any(_is_flu_hosp_target(t) for t in self.config.get_targets()):
            getters.append(self.cache_mgr.get_admissions_parquet)

        latest: Optional[str] = None
        for getter in getters:
            try:
                pq = getter()
                if pq is None or not pq.exists():
                    continue
                lf = pl.scan_parquet(pq)
                names = lf.collect_schema().names()
                if "target_end_date" not in names:
                    continue
                if "output_type" in names:
                    lf = lf.filter(pl.col("output_type").is_null() | (pl.col("output_type") != "pmf"))
                val = lf.select(pl.col("target_end_date").drop_nulls().max()).collect().item()
                if val:
                    s_val = str(val)[:10]
                    if latest is None or s_val > latest:
                        latest = s_val
            except Exception as exc:
                logger.debug("Could not read latest truth date: %s", exc)
        return latest

    def _truth_sig(self) -> Tuple[Any, ...]:
        """Lightweight mtime signature across truth Parquets and target-data inputs."""
        sig: List[Any] = []
        for sub_name in ("oracle", "oracle_hub", "admissions", "admissions_hub"):
            p = self.cache_mgr.targets_cache_dir / f"{sub_name}.parquet"
            try:
                sig.append(p.stat().st_mtime if p.exists() else None)
            except OSError:
                sig.append(None)
        try:
            if self.target_data_dir.is_dir():
                sig.append(self.target_data_dir.stat().st_mtime)
                children = sorted(
                    (f.name, f.stat().st_mtime)
                    for f in self.target_data_dir.iterdir()
                    if f.is_file() and not f.name.startswith(".")
                )
                sig.append(tuple(children))
            else:
                sig.append(None)
        except OSError:
            sig.append(None)
        return tuple(sig)

    def _parse_hub_seasons_unlocked(self) -> Dict[str, List[str]]:
        """Parse raw round dates from hub-config/tasks.json, re-reading if tasks.json changes on disk."""
        tasks_path = self.hub_config_dir / "tasks.json"
        mtime = -1.0
        try:
            if tasks_path.exists():
                mtime = tasks_path.stat().st_mtime
        except OSError:
            pass
        if self._raw_hub_seasons_cache is not None and abs(mtime - self._tasks_mtime) < 1e-6:
            return self._raw_hub_seasons_cache

        cal = self.get_calendar()
        seasons: Dict[str, List[str]] = {}
        if tasks_path.exists():
            try:
                data = json.loads(tasks_path.read_text(encoding="utf-8"))
                for r in data.get("rounds", []):
                    for mt in r.get("model_tasks", []):
                        task_ids = mt.get("task_ids", {})
                        ref_spec = task_ids.get("reference_date") or task_ids.get("origin_date") or {}
                        dates = (ref_spec.get("optional") or []) + (ref_spec.get("required") or [])
                        for d in dates:
                            s = cal.season_for_date(d)
                            if s not in seasons:
                                seasons[s] = []
                            if d not in seasons[s]:
                                seasons[s].append(d)
            except Exception as exc:
                logger.warning("Error reading hub tasks.json: %s", exc)

        for s in seasons:
            seasons[s].sort(reverse=True)

        self._raw_hub_seasons_cache = seasons
        self._tasks_mtime = mtime
        return seasons

    def get_hub_seasons(self, include_future: bool = False) -> Dict[str, List[str]]:
        """Extract official hub round dates grouped by season, excluding unstarted future rounds by default."""
        raw = self._parse_hub_seasons_unlocked()
        if include_future:
            return {s: list(ds) for s, ds in raw.items()}

        sig = (self._tasks_mtime, self._compute_models_mtime(), self._truth_sig())
        if self._hub_seasons_cache is not None and self._hub_seasons_sig == sig:
            return {s: list(ds) for s, ds in self._hub_seasons_cache.items()}

        forecast_dates: Set[str] = set()
        for m in self.scan_models().values():
            forecast_dates.update(str(d) for d in (m.get("dates") or []) if d)
        latest_forecast = max(forecast_dates) if forecast_dates else None
        latest_truth = self._latest_truth_date()
        caps = [d for d in (latest_forecast, latest_truth) if d]
        cap = max(caps) if caps else None

        if cap is None:
            filtered = {s: list(ds) for s, ds in raw.items()}
        else:
            filtered = {}
            for s, ds in raw.items():
                kept = [d for d in ds if d <= cap or d in forecast_dates]
                if kept:
                    filtered[s] = kept

        self._hub_seasons_cache = filtered
        self._hub_seasons_sig = sig
        return {s: list(ds) for s, ds in filtered.items()}

    def get_all_seasons(self) -> List[str]:
        """Return all distinct seasons found in historical surveillance or model forecasts."""
        cal = self.get_calendar()
        seasons_set = set()
        truth_df = self.get_admissions_ground_truth(as_polars=True)
        if truth_df is None or truth_df.is_empty():
            truth_df = self.get_oracle(as_polars=True)
        if truth_df is not None and not truth_df.is_empty() and "target_end_date" in truth_df.columns:
            for d in truth_df.select(pl.col("target_end_date").unique())["target_end_date"].to_list():
                if d is not None:
                    seasons_set.add(cal.season_for_date(str(d)))

        hub_seasons = self.get_hub_seasons()
        seasons_set.update(hub_seasons.keys())

        for m in self.scan_models().values():
            for d in m.get("dates", []):
                seasons_set.add(cal.season_for_date(d))

        return sorted(list(seasons_set), reverse=True)

    def get_dates_for_season(self, season: str) -> List[str]:
        """Return all reference dates belonging to a specific season."""
        cal = self.get_calendar()
        dates_set = set()
        hub_seasons = self.get_hub_seasons()
        if season == "all":
            for d_list in hub_seasons.values():
                dates_set.update(d_list)
        elif season in hub_seasons:
            dates_set.update(hub_seasons[season])

        for m in self.scan_models().values():
            for d in m.get("dates", []):
                if season == "all" or cal.season_for_date(d) == season:
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
        truth_df = self.get_admissions_ground_truth(as_polars=True)
        if truth_df is None or truth_df.is_empty():
            truth_df = self.get_oracle(as_polars=True)
        if truth_df is not None and not truth_df.is_empty() and "target_end_date" in truth_df.columns:
            dates_set.update([str(d) for d in truth_df["target_end_date"].unique().to_list() if d is not None])
        return sorted(list(dates_set))

    def get_forecast_seasons(self) -> List[str]:
        """Return all seasons that have actual model forecasts or official hub rounds."""
        cal = self.get_calendar()
        seasons_set = set()
        hub_seasons = self.get_hub_seasons()
        seasons_set.update(hub_seasons.keys())
        for m in self.scan_models().values():
            for d in m.get("dates", []):
                seasons_set.add(cal.season_for_date(d))
        return sorted([s for s in seasons_set if len(self.get_dates_for_season(s)) > 0])

    def get_latest_reference_date(self) -> Optional[str]:
        """Dynamically find the most recent forecast reference date available."""
        models = self.scan_models()
        dates_set: Set[str] = set()
        for m in models.values():
            dates_set.update(m.get("dates", []))
        if dates_set:
            return max(dates_set)
        truth_df = self.get_admissions_ground_truth(as_polars=True)
        if truth_df is None or truth_df.is_empty():
            truth_df = self.get_oracle(as_polars=True)
        if truth_df is not None and not truth_df.is_empty() and "target_end_date" in truth_df.columns:
            vals = [str(d) for d in truth_df["target_end_date"].drop_nulls().to_list()]
            if vals:
                return max(vals)
        return None

    def get_latest_season(self) -> str:
        """Dynamically get the latest active season."""
        seasons = self.get_forecast_seasons()
        if seasons:
            return sorted(seasons, reverse=True)[0]
        latest_date = self.get_latest_reference_date()
        if latest_date:
            return self.get_season_for_date(latest_date)
        return self.get_season_for_date(datetime.now())

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
        merged = self.cache_mgr.merged_key(raw_id)
        hub = self.cache_mgr.hub_key(raw_id)
        if merged is not None:
            m_hub, m_name = merged
            candidates = [
                self.model_metadata_dir / f"{m_name}.yml",
                self.model_metadata_dir / f"{m_name}.yaml",
                self.remote_store.metadata_path(m_hub, m_name),
            ]
            model_id = m_name
        elif hub is not None:
            # Hub models read the YAML copied from the hub's model-metadata/ folder (fallback local repo copy)
            candidates = [
                self.remote_store.metadata_path(*hub),
                self.model_metadata_dir / f"{hub[1]}.yml",
                self.model_metadata_dir / f"{hub[1]}.yaml",
            ]
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

    _YAML_KEY_RE = re.compile(
        r'^(?:"([A-Za-z0-9_.-]+)"|\'([A-Za-z0-9_.-]+)\'|([A-Za-z0-9_.-]+))\s*:(?:\s+(.*))?$'
    )

    @classmethod
    def _match_yaml_key_val(cls, s: str) -> Optional[Tuple[str, str]]:
        m = cls._YAML_KEY_RE.match(s)
        if not m:
            return None
        key = m.group(1) or m.group(2) or m.group(3)
        rest = m.group(4) if m.group(4) is not None else ""
        return key, rest

    @staticmethod
    def _strip_yaml_inline_comment(s: str) -> str:
        in_sq = False
        in_dq = False
        esc = False
        for i, ch in enumerate(s):
            if esc:
                esc = False
                continue
            if ch == "\\" and in_dq:
                esc = True
                continue
            if ch == "'" and not in_dq:
                in_sq = not in_sq
            elif ch == '"' and not in_sq:
                in_dq = not in_dq
            elif ch == "#" and not in_sq and not in_dq:
                if i == 0 or s[i - 1].isspace():
                    return s[:i].rstrip()
        return s.rstrip()

    @staticmethod
    def _has_unclosed_yaml_quote(s: str) -> bool:
        t = s.lstrip()
        if not t or t[0] not in ('"', "'"):
            return False
        q = t[0]
        esc = False
        i = 1
        while i < len(t):
            ch = t[i]
            if esc:
                esc = False
                i += 1
                continue
            if ch == "\\" and q == '"':
                esc = True
                i += 1
                continue
            if ch == "'" and q == "'" and i + 1 < len(t) and t[i + 1] == "'":
                i += 2
                continue
            if ch == q:
                return False
            i += 1
        return True

    @classmethod
    def _parse_yaml_scalar(cls, val: str) -> Any:
        v = cls._strip_yaml_inline_comment(val.strip())
        if not v:
            return None
        if v.startswith('"') and v.endswith('"') and len(v) >= 2:
            inner = v[1:-1]
            inner_norm = re.sub(r"\\\s+\\\s*", " ", inner)
            try:
                return json.loads('"' + inner_norm + '"')
            except Exception:
                return (
                    inner_norm.replace('\\"', '"')
                    .replace("\\n", "\n")
                    .replace("\\t", "\t")
                    .replace("\\ ", " ")
                    .replace("\\\\", "\\")
                )
        if v.startswith("'") and v.endswith("'") and len(v) >= 2:
            return v[1:-1].replace("''", "'")
        low = v.lower()
        if low in ("true", "yes"):
            return True
        if low in ("false", "no"):
            return False
        if low in ("null", "~"):
            return None
        if re.fullmatch(r"-?\d+", v):
            if len(v.lstrip("-")) > 1 and v.lstrip("-").startswith("0"):
                return v
            return int(v)
        if re.fullmatch(r"-?\d+\.\d+", v):
            try:
                return float(v)
            except ValueError:
                pass
        return v

    @classmethod
    def _parse_yaml_flow(cls, text: str) -> Any:
        cleaned = re.sub(r",\s*([\]\}])", r"\1", text.strip())
        for candidate in (
            cleaned,
            re.sub(r'([{\s,])([A-Za-z_][A-Za-z0-9_.-]*)\s*:(?=\s)', r'\1"\2":', cleaned),
        ):
            try:
                return json.loads(candidate)
            except Exception:
                pass
        s = cleaned.strip()
        if s.startswith("[") and s.endswith("]"):
            inner = s[1:-1].strip()
            if not inner:
                return []
            if "{" not in inner and "[" not in inner:
                return [cls._parse_yaml_scalar(p.strip()) for p in inner.split(",") if p.strip()]
        return s

    @classmethod
    def _parse_simple_yaml(cls, text: str) -> Dict[str, Any]:
        """Self-contained YAML/JSON parser for Hubverse model metadata schemas."""
        stripped_all = text.strip()
        if stripped_all.startswith("{"):
            parsed_flow = cls._parse_yaml_flow(stripped_all)
            if isinstance(parsed_flow, dict):
                return parsed_flow

        raw_lines = text.splitlines()
        non_empty = [
            (len(l) - len(l.lstrip(" ")), l)
            for l in raw_lines
            if l.strip() and not l.lstrip().startswith("#") and l.strip() not in ("---", "...")
        ]
        if not non_empty:
            return {}
        key_indents = [
            ind for ind, l in non_empty
            if not l.lstrip().startswith("-") and cls._match_yaml_key_val(l.lstrip()) is not None
        ]
        base_indent = min(key_indents) if key_indents else 0

        result: Dict[str, Any] = {}
        n = len(raw_lines)
        i = 0

        def is_top_key(line: str) -> bool:
            s = line.lstrip(" ")
            ind = len(line) - len(s)
            if ind != base_indent or s.startswith("-") or s.startswith("#"):
                return False
            return cls._match_yaml_key_val(s) is not None

        def consume_flow(first_chunk: str, idx: int) -> Tuple[Any, int]:
            open_ch = first_chunk[0]
            close_ch = "]" if open_ch == "[" else "}"
            buf = [first_chunk]
            depth = 0
            in_sq = in_dq = esc = False

            def scan_depth(chunk: str, d: int, sq: bool, dq: bool, es: bool) -> Tuple[int, bool, bool, bool]:
                for ch in chunk:
                    if es:
                        es = False
                        continue
                    if ch == "\\" and dq:
                        es = True
                        continue
                    if ch == "'" and not dq:
                        sq = not sq
                    elif ch == '"' and not sq:
                        dq = not dq
                    elif not sq and not dq:
                        if ch == open_ch:
                            d += 1
                        elif ch == close_ch:
                            d -= 1
                return d, sq, dq, es

            depth, in_sq, in_dq, esc = scan_depth(first_chunk, depth, in_sq, in_dq, esc)
            while depth > 0 and idx < n:
                nl = cls._strip_yaml_inline_comment(raw_lines[idx])
                buf.append(nl)
                depth, in_sq, in_dq, esc = scan_depth(nl, depth, in_sq, in_dq, esc)
                idx += 1
            return cls._parse_yaml_flow("\n".join(buf)), idx

        def consume_scalar_lines(first_val: str, idx: int, min_cont_indent: int) -> Tuple[Any, int]:
            parts = [first_val]
            while idx < n:
                cur_joined = " ".join(p for p in parts if p)
                unclosed = cls._has_unclosed_yaml_quote(cur_joined)
                nl = raw_lines[idx]
                if not nl.strip():
                    if unclosed:
                        parts.append("")
                        idx += 1
                        continue
                    k = idx + 1
                    while k < n and not raw_lines[k].strip():
                        k += 1
                    if (
                        k < n
                        and not is_top_key(raw_lines[k])
                        and (len(raw_lines[k]) - len(raw_lines[k].lstrip(" "))) > min_cont_indent
                        and not raw_lines[k].lstrip().startswith("#")
                        and not raw_lines[k].lstrip().startswith("- ")
                    ):
                        idx += 1
                        continue
                    break
                if not unclosed and nl.lstrip().startswith("#"):
                    idx += 1
                    continue
                if not unclosed and is_top_key(nl):
                    break
                ns = nl.lstrip(" ")
                nind = len(nl) - len(ns)
                if not unclosed and nind <= min_cont_indent:
                    break
                if not unclosed and (ns.startswith("- ") or ns == "-" or cls._match_yaml_key_val(ns) is not None):
                    if min_cont_indent > base_indent:
                        break
                parts.append(ns.rstrip() if unclosed else cls._strip_yaml_inline_comment(ns))
                idx += 1
            joined = " ".join(p for p in parts if p != "")
            return cls._parse_yaml_scalar(joined), idx

        while i < n:
            line = raw_lines[i]
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or stripped in ("---", "..."):
                i += 1
                continue
            if not is_top_key(line):
                i += 1
                continue

            s = line.lstrip(" ")
            kv = cls._match_yaml_key_val(s)
            if kv is None:
                i += 1
                continue
            key, rest = kv
            val = cls._strip_yaml_inline_comment(rest.strip()) if not cls._has_unclosed_yaml_quote(rest.strip()) else rest.strip()
            i += 1

            # Case 1: Block scalar | or >
            if re.match(r"^[|>][-+]?\d*$", val):
                style = val[0]
                block_lines: List[str] = []
                block_indent: Optional[int] = None
                while i < n:
                    nl = raw_lines[i]
                    if not nl.strip():
                        block_lines.append("")
                        i += 1
                        continue
                    ind = len(nl) - len(nl.lstrip(" "))
                    if ind <= base_indent and (is_top_key(nl) or nl.lstrip().startswith("#")):
                        if is_top_key(nl):
                            break
                        i += 1
                        continue
                    if ind <= base_indent:
                        break
                    if block_indent is None:
                        block_indent = ind
                    block_lines.append(nl[min(len(nl), block_indent):].rstrip())
                    i += 1
                while block_lines and not block_lines[-1]:
                    block_lines.pop()
                if style == "|":
                    result[key] = "\n".join(block_lines)
                else:
                    paras: List[str] = []
                    cur: List[str] = []
                    for bl in block_lines:
                        if not bl:
                            if cur:
                                paras.append(" ".join(cur))
                                cur = []
                            paras.append("")
                        else:
                            cur.append(bl.strip())
                    if cur:
                        paras.append(" ".join(cur))
                    result[key] = "\n".join(paras)
                continue

            # Case 2: Flow array [...] or object {...} on key line
            if val.startswith("[") or val.startswith("{"):
                result[key], i = consume_flow(val, i)
                continue

            # Case 3: Empty val on key line
            if not val:
                j = i
                while j < n and (not raw_lines[j].strip() or raw_lines[j].lstrip().startswith("#")):
                    j += 1
                if j >= n or is_top_key(raw_lines[j]):
                    result[key] = None
                    i = j
                    continue
                next_line = raw_lines[j]
                next_s = next_line.lstrip(" ")
                next_ind = len(next_line) - len(next_s)

                if next_s.startswith("[") or next_s.startswith("{"):
                    first_flow = cls._strip_yaml_inline_comment(next_s)
                    result[key], i = consume_flow(first_flow, j + 1)
                    continue

                if next_s.startswith("- ") or next_s == "-":
                    items: List[Any] = []
                    i = j
                    list_indent = next_ind
                    while i < n:
                        nl = raw_lines[i]
                        if not nl.strip() or nl.lstrip().startswith("#"):
                            i += 1
                            continue
                        if is_top_key(nl):
                            break
                        ns = nl.lstrip(" ")
                        nind = len(nl) - len(ns)
                        if nind < list_indent or not (ns.startswith("- ") or ns == "-"):
                            break
                        after_dash = ns[1:].strip()
                        i += 1
                        sub_kv = cls._match_yaml_key_val(after_dash)
                        item_is_dict = sub_kv is not None
                        if not after_dash:
                            k = i
                            while k < n and (not raw_lines[k].strip() or raw_lines[k].lstrip().startswith("#")):
                                k += 1
                            if k < n and not is_top_key(raw_lines[k]):
                                ks = raw_lines[k].lstrip(" ")
                                kind = len(raw_lines[k]) - len(ks)
                                if kind > list_indent and cls._match_yaml_key_val(ks) is not None:
                                    item_is_dict = True
                        if item_is_dict:
                            obj: Dict[str, Any] = {}
                            if sub_kv is not None:
                                sk, sv = sub_kv
                                sv_clean = cls._strip_yaml_inline_comment(sv.strip()) if not cls._has_unclosed_yaml_quote(sv.strip()) else sv.strip()
                                obj[sk], i = consume_scalar_lines(sv_clean, i, list_indent + 1)
                            while i < n:
                                sl = raw_lines[i]
                                if not sl.strip() or sl.lstrip().startswith("#"):
                                    i += 1
                                    continue
                                if is_top_key(sl):
                                    break
                                ss = sl.lstrip(" ")
                                sind = len(sl) - len(ss)
                                if sind <= list_indent:
                                    break
                                skv = cls._match_yaml_key_val(ss)
                                if skv is not None:
                                    sk, sv = skv
                                    sv_clean = cls._strip_yaml_inline_comment(sv.strip()) if not cls._has_unclosed_yaml_quote(sv.strip()) else sv.strip()
                                    i += 1
                                    obj[sk], i = consume_scalar_lines(sv_clean, i, sind)
                                else:
                                    i += 1
                            items.append(obj)
                        else:
                            sv_clean = cls._strip_yaml_inline_comment(after_dash) if not cls._has_unclosed_yaml_quote(after_dash) else after_dash
                            item_val, i = consume_scalar_lines(sv_clean, i, list_indent)
                            items.append(item_val)
                    result[key] = items
                    continue
                elif next_ind > base_indent:
                    sv_clean = cls._strip_yaml_inline_comment(next_s) if not cls._has_unclosed_yaml_quote(next_s) else next_s
                    result[key], i = consume_scalar_lines(sv_clean, j + 1, base_indent)
                    continue

            # Case 4: Inline scalar on key line
            result[key], i = consume_scalar_lines(val, i, base_indent)

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

        cal = self.get_calendar()
        rounds_list = []
        for d in dates:
            rounds_list.append({
                "date": d,
                "season": cal.season_for_date(d),
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
        m_targets = m_info.get("targets") or [self.config.get_default_target()]
        t_meta = self.config.get_target_metadata(m_targets[0])
        h_meta = t_meta.get("horizons") or {}
        horizons = sorted(set((h_meta.get("required") or []) + (h_meta.get("optional") or []))) or [0, 1, 2, 3]

        specs = {
            "horizons": horizons,
            "targets": m_targets,
            "output_types": m_info.get("output_types") or ["quantile"],
            "has_samples": bool(m_info.get("has_samples", False)),
            "has_pmf": bool(m_info.get("has_pmf", False)),
            "locations_count": loc_count,
            "total_files": total_files if total_files > 0 else len(dates),
            "total_disk_bytes": total_disk_bytes,
            "total_disk_human": total_disk_human,
            "total_predictions_est": len(dates) * loc_count * len(horizons) * 23,
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
                hub_dates = [d for d in dates if cal.season_for_date(d) == s]
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
