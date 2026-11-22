"""
Unified evaluation and scoring engine for Viz.
Serves as the single source of truth for both the headless CLI (`score_cli.py`)
and the interactive web dashboard (`server.py`).
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import hashlib
import logging
import math
from pathlib import Path
import threading
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

import polars as pl

from viz.core.baselines import resolve_baseline, target_baseline_override
from viz.core.calendar import CalendarSpec
from viz.core.data_loader import SandboxDataLoader, date_to_season_and_week
from viz.core.metrics import (
    TASK_KEY_COLS,
    compute_pairwise_relative_wis,
    compute_pairwise_relative_wis_indexed,
    find_common_tasks,
    intersect_task_keys,
    model_task_keys,
    score_forecasts,
    score_pmf_forecasts,
    score_sample_forecasts,
    summarize_scored_tasks,
)
from viz.core.parallel import ordered_map, ordered_map_outcomes
from viz.core.peaks import is_peak_target
from viz.core.prescore import PreScoreStore

logger = logging.getLogger("viz.evaluation")


@dataclass
class EvaluationParams:
    """Parameters specifying the target, location, time scope, dimensions, and models for evaluation."""
    target: Optional[str] = None
    location: str = "all"
    date: str = "all"
    season: str = ""
    models: Optional[List[str]] = None
    baseline: Optional[str] = None
    fair: bool = False
    # Optional evaluation window within selected seasons:
    # weeks = "start-end" in hub season weeks; phase = pre | peak | post
    weeks: Optional[str] = None
    phase: Optional[str] = None
    # Optional horizons to score (e.g. [0, 1]). None: all horizons.
    horizons: Optional[List[int]] = None
    # Optional extra task-ID filters (e.g. {"age_group": "0-130"}).
    dims: Optional[Dict[str, str]] = None


PHASES = ("pre", "peak", "post")


def _common_tasks_frame(
    common_task_set: Optional[Set[Tuple[Any, ...]]],
    extra_task_ids: Sequence[str] = (),
) -> Optional[Any]:
    if not common_task_set:
        return common_task_set
    task_list = list(common_task_set)
    sample = task_list[0]
    data: Dict[str, List[Any]] = {
        "reference_date": [str(t[0]) for t in task_list],
        "location": [str(t[1]) for t in task_list],
        "horizon": [int(t[2]) for t in task_list],
    }
    if extra_task_ids and len(sample) >= 3 + len(extra_task_ids):
        for idx, ec in enumerate(extra_task_ids):
            data[ec] = [str(t[3 + idx]) for t in task_list]
    return pl.DataFrame(data)


def _finite_or_none(v: Any) -> Optional[float]:
    return float(v) if v is not None and not math.isnan(v) else None


def _shared_task_wis(
    task_df: pl.DataFrame,
    shared: pl.DataFrame,
    aggregate_locations: Optional[Set[str]] = None,
    extra_task_ids: Sequence[str] = (),
) -> Tuple[Optional[float], Optional[float]]:
    """Overall `(wis, wis_log)` of one model restricted to `shared` tasks."""
    join_cols = [c for c in list(TASK_KEY_COLS) + list(extra_task_ids) if c in task_df.columns and c in shared.columns]
    sub = task_df.join(shared, on=join_cols, how="semi")
    if sub.is_empty():
        return None, None
    agg_list = sorted(aggregate_locations) if aggregate_locations is not None else ["US"]
    is_agg = pl.col("location").is_in(agg_list) if agg_list else pl.lit(False)
    has_primary = bool(sub.select((~is_agg).any()).item())
    primary = sub.filter(~is_agg) if has_primary else sub.filter(is_agg)
    if primary.is_empty():
        return None, None
    wis, wis_log = primary.select(pl.col("wis").mean(), pl.col("wis_log").mean()).row(0)
    return _finite_or_none(wis), _finite_or_none(wis_log)


def _overall_wis_on_tasks(
    df,
    oracle,
    target,
    tasks,
    non_negative,
    *,
    aggregate_locations: Optional[Set[str]] = None,
    extra_task_ids: Sequence[str] = (),
) -> Tuple[Optional[float], Optional[float]]:
    sc = score_forecasts(
        df,
        oracle,
        target=target,
        common_tasks=tasks,
        non_negative=non_negative,
        extra_task_ids=extra_task_ids or None,
        aggregate_locations=aggregate_locations,
    )
    if not sc:
        return None, None
    return sc.get("overall", {}).get("wis"), sc.get("overall", {}).get("wis_log")


def parse_week_range(weeks: Optional[str]) -> Optional[Tuple[int, int]]:
    """Parse 'a-b' (season weeks, inclusive) into a clamped tuple; None or 'all' means full season."""
    if not weeks or str(weeks).strip().lower() in ("all", ""):
        return None
    try:
        a, b = (int(x) for x in str(weeks).replace(":", "-").split("-", 1))
    except ValueError as exc:
        raise ValueError(f"Invalid week range '{weeks}' (expected e.g. '10-24')") from exc
    a, b = max(1, min(a, b)), min(53, max(a, b))
    return None if (a, b) == (1, 53) else (a, b)


def parse_phase(phase: Optional[str]) -> Optional[str]:
    p = (phase or "").strip().lower()
    if p in ("", "all", "full"):
        return None
    if p not in PHASES:
        raise ValueError(f"Invalid phase '{phase}' (expected one of {', '.join(PHASES)})")
    return p


class WindowFilter:
    """Keeps only tasks whose forecast (target) week falls inside a season-week range and/or a phase."""

    def __init__(
        self,
        week_range: Optional[Tuple[int, int]],
        phase: Optional[str],
        phase_pairs: Optional[pl.DataFrame],
        peak_fraction: Optional[float] = None,
        calendar: Optional[CalendarSpec] = None,
    ):
        self.week_range = week_range
        self.phase = phase
        self.pairs = phase_pairs
        self.peak_fraction = peak_fraction
        self.calendar = calendar
        self._allowed_dates = set(phase_pairs.get_column("target_end_date").to_list()) if phase_pairs is not None else None
        self._weeks: Dict[str, int] = {}

    def _season_week(self, d: str) -> int:
        if d not in self._weeks:
            if self.calendar is not None:
                self._weeks[d] = self.calendar.date_to_season_and_week(d)[1]
            else:
                self._weeks[d] = date_to_season_and_week(d)[1]
        return self._weeks[d]

    def target_in_window(self, d: str) -> bool:
        if self.week_range and not (self.week_range[0] <= self._season_week(d) <= self.week_range[1]):
            return False
        return self._allowed_dates is None or d in self._allowed_dates

    def round_in_window(self, reference_date: str, horizons: Optional[Iterable[int]] = None) -> bool:
        """A round is in scope if any of its forecast weeks is in the window."""
        try:
            ref = datetime.strptime(reference_date, "%Y-%m-%d")
        except ValueError:
            return True
        offset_days = int(self.calendar.horizon_offset_days) if self.calendar is not None else 0
        hs = list(horizons) if horizons is not None else list(range(-1, 5))
        return any(
            self.target_in_window((ref + timedelta(weeks=int(h), days=offset_days)).strftime("%Y-%m-%d"))
            for h in hs
        )

    def apply(self, df: pl.DataFrame) -> pl.DataFrame:
        if df is None or df.is_empty():
            return df
        offset_days = int(self.calendar.horizon_offset_days) if self.calendar is not None else 0
        if "target_end_date" not in df.columns:
            df = df.with_columns(
                (pl.col("reference_date").cast(pl.String).str.to_date()
                 + pl.duration(days=pl.col("horizon").cast(pl.Int64) * 7 + offset_days))
                .dt.strftime("%Y-%m-%d")
                .alias("target_end_date")
            )
        df = df.with_columns(
            pl.col("target_end_date").cast(pl.String).str.slice(0, 10),
            pl.col("location").cast(pl.String),
        )
        if self.week_range:
            keep = [
                d for d in df.get_column("target_end_date").unique().to_list()
                if d and self.week_range[0] <= self._season_week(d) <= self.week_range[1]
            ]
            df = df.filter(pl.col("target_end_date").is_in(keep))
        if self.pairs is not None:
            df = df.join(self.pairs, on=["location", "target_end_date"], how="semi")
        return df

    def describe(self) -> Dict[str, Any]:
        return {
            "weeks": list(self.week_range) if self.week_range else None,
            "phase": self.phase,
            "peak_fraction": self.peak_fraction,
        }


@dataclass
class EvaluationResult:
    """Complete evaluation report with model comparisons, rankings, and scope metadata."""
    target: str
    location_filter: str
    date_filter: str
    season_filter: str
    scope_type: str
    selected_seasons: List[str]
    scope_dates_count: int
    scope_dates: Optional[List[str]]
    baseline_model: Optional[str]
    fair_intersection: bool
    common_task_status: str
    common_task_message: Optional[str]
    common_tasks_count: Optional[int]
    rankings: List[Dict[str, Any]]
    validation_warnings: List[str] = field(default_factory=list)
    window: Optional[Dict[str, Any]] = None
    is_categorical: bool = False
    ordinal: bool = False
    rank_metric: str = "wis"
    # Resolved scope, reused by task-level exports so they match the leaderboard exactly
    locations_filter: Optional[List[str]] = field(default=None, repr=False)
    common_task_set: Optional[Set[Tuple[Any, ...]]] = field(default=None, repr=False)
    window_filter: Optional[Any] = field(default=None, repr=False)
    aggregate_locations: Optional[Set[str]] = field(default=None, repr=False)
    extra_task_ids: Tuple[str, ...] = field(default=(), repr=False)
    dim_filter: Dict[str, str] = field(default_factory=dict, repr=False)

    def to_dict(self) -> Dict[str, Any]:
        """Convert evaluation result to JSON-serializable dictionary."""
        return {
            "target": self.target,
            "location_filter": self.location_filter,
            "date_filter": self.date_filter,
            "season_filter": self.season_filter,
            "scope_type": self.scope_type,
            "selected_seasons": self.selected_seasons,
            "scope_dates_count": self.scope_dates_count,
            "scope_dates": self.scope_dates,
            "baseline_model": self.baseline_model,
            "fair_intersection": self.fair_intersection,
            "common_task_status": self.common_task_status,
            "common_task_message": self.common_task_message,
            "common_tasks_count": self.common_tasks_count,
            "is_categorical": self.is_categorical,
            "ordinal": self.ordinal,
            "rank_metric": self.rank_metric,
            "rankings": self.rankings,
            "validation_warnings": self.validation_warnings,
            "window": self.window,
        }


@dataclass
class _ResolvedScope:
    """Resolved target, temporal/location/dim filters, model list, and baseline for an evaluation run."""
    target: str
    loc_param: str
    date_param: str
    season_param: str
    fair_flag: bool
    oracle: pl.DataFrame
    locations_filter: Optional[List[str]]
    agg_locs: Set[str]
    scope_type: str
    selected_seasons: List[str]
    dates_filter: Optional[List[str]]
    window_filter: Optional[WindowFilter]
    target_meta: Dict[str, Any]
    is_pmf_target: bool
    extra_cols: List[str]
    dim_filter: Dict[str, str]
    all_models: Dict[str, Dict[str, Any]]
    requested_model_ids: List[str]
    baseline_id: Optional[str]
    cfg_default: Optional[str]
    tgt_default: Optional[str]
    baseline_meta: Dict[str, Dict[str, Any]]
    models_to_load: List[str]
    model_meta_stats: Dict[str, Dict[str, Any]]
    total_scope_dates_count: int
    to_load: List[Tuple[str, List[str]]]
    horizon_set: Optional[List[int]]
    target_non_neg: bool
    pop_map: Optional[Dict[str, int]]
    season_hint: Optional[str]


class EvaluationEngine:
    """
    Decoupled evaluation orchestrator.
    Handles data extraction, temporal scoping, task intersection, incremental pre-scoring, and comparative scoring.
    """

    def __init__(self, base_dir: Path, data_loader: Optional[SandboxDataLoader] = None):
        self.base_dir = Path(base_dir).resolve()
        self.loader = data_loader or SandboxDataLoader(self.base_dir)
        self.config = self.loader.config
        self.prescore = PreScoreStore(self.loader.cache_mgr.cache_dir, self.loader)
        self._eval_cache: "OrderedDict[str, EvaluationResult]" = OrderedDict()
        self._eval_cache_size = 64
        self._eval_cache_lock = threading.Lock()
        self._eval_inflight: Dict[str, threading.Event] = {}
        self._loc_eval_cache: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._loc_eval_cache_size = 16
        self._loc_eval_cache_lock = threading.Lock()
        self._loc_eval_inflight: Dict[str, threading.Event] = {}
        self._sample_eval_cache: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._sample_eval_cache_size = 32
        self._sample_eval_cache_lock = threading.Lock()

    def clear_cache(self) -> None:
        """Clear leaderboard, per-location, and sample-trajectory evaluation caches."""
        with self._eval_cache_lock:
            self._eval_cache.clear()
        with self._loc_eval_cache_lock:
            self._loc_eval_cache.clear()
        with self._sample_eval_cache_lock:
            self._sample_eval_cache.clear()

    def _compute_cache_key(self, params: EvaluationParams, *, mode: str = "auto") -> str:
        oracle_pq = self.loader.cache_mgr.get_oracle_parquet()
        oracle_mtime = oracle_pq.stat().st_mtime if oracle_pq and oracle_pq.exists() else 0.0

        all_models = self.loader.scan_models()
        models = params.models or []
        if not models or "all" in [m.lower() for m in models]:
            models = list(all_models.keys())
        if mode == "auto":
            target_meta_for_key = self.config.get_target_metadata(params.target or self.config.get_default_target())
            is_pmf_key = bool(
                target_meta_for_key.get("is_categorical")
                and "quantile" not in (target_meta_for_key.get("output_types") or [])
            )
            eff_mode = "pmf" if is_pmf_key else "quantile"
        else:
            eff_mode = mode
        mtimes = []
        for mid in sorted(models):
            if hasattr(self.loader, "ensemble_mgr") and self.loader.ensemble_mgr.get_config(mid):
                cfg = self.loader.ensemble_mgr.get_config(mid)
                mtimes.append(
                    f"{mid}:synth:{cfg.method}:{cfg.spatial_split}:{cfg.missing_policy}:"
                    f"{cfg.models}:{cfg.state_models}:{cfg.national_models}:{cfg.created_at}"
                )
            else:
                info = all_models.get(mid)
                if info is not None and "raw_name" in info:
                    raw_id = str(info["raw_name"])
                    is_local = bool(info.get("is_local", False))
                else:
                    raw_id, is_local = self.loader._resolve_model_id_and_local(mid)
                if eff_mode == "samples":
                    if not (
                        (info or {}).get("has_samples")
                        or "sample" in ((info or {}).get("output_types") or [])
                    ):
                        continue
                    pq_s = self.loader.cache_mgr.get_model_samples_parquet(raw_id, is_local=is_local)
                    s_m = pq_s.stat().st_mtime if pq_s and pq_s.exists() else 0.0
                    mtimes.append(f"{mid}:samp:{s_m}")
                elif eff_mode == "pmf":
                    ots = (info or {}).get("output_types") or []
                    if ots and "pmf" not in ots:
                        continue
                    pq_p = self.loader.cache_mgr.get_model_pmf_parquet(raw_id, is_local=is_local)
                    p_m = pq_p.stat().st_mtime if pq_p and pq_p.exists() else 0.0
                    mtimes.append(f"{mid}:pmf:{p_m}")
                else:
                    ots = (info or {}).get("output_types") or []
                    if ots and "quantile" not in ots:
                        continue
                    pq = self.loader.cache_mgr.get_model_parquet(raw_id, is_local=is_local)
                    q_m = pq.stat().st_mtime if pq and pq.exists() else 0.0
                    mtimes.append(f"{mid}:{q_m}")

        dims_key = tuple(sorted((str(k), str(v)) for k, v in (params.dims or {}).items()))
        raw = (
            f"{params.target}|{params.location}|{params.date}|{params.season}|{params.weeks}|{params.phase}|"
            f"{sorted(models)}|{params.baseline}|{params.fair}|{oracle_mtime}|{mtimes}|{dims_key}"
        )
        if params.horizons is not None:
            raw += f"|horizons={sorted(set(int(h) for h in params.horizons))}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _baseline_meta(
        self,
        all_models: Dict[str, Dict[str, Any]],
        extra_ids: Tuple[Optional[str], ...] = (),
    ) -> Dict[str, Dict[str, Any]]:
        if not hasattr(self.loader, "get_model_metadata"):
            return {}
        watch = {mid for mid in extra_ids if mid}
        meta_map: Dict[str, Dict[str, Any]] = {}
        for mid, info in all_models.items():
            fam = str(info.get("family") or "").lower()
            mlow = mid.lower()
            if "baseline" in mlow or "null" in mlow or "persist" in mlow or fam == "baseline" or mid in watch:
                try:
                    m = self.loader.get_model_metadata(mid)
                    if isinstance(m, dict):
                        meta_map[mid] = m
                except Exception:
                    pass
        return meta_map

    def _build_window_filter(
        self, target: str, weeks: Optional[str], phase: Optional[str], calendar: Optional[CalendarSpec] = None
    ) -> Optional[WindowFilter]:
        week_range = parse_week_range(weeks)
        ph = parse_phase(phase)
        if week_range is None and ph is None:
            return None
        pairs = None
        if ph is not None:
            table = self.loader.get_truth_phases(target)
            pairs = table.filter(pl.col("phase") == ph).select(["location", "target_end_date"])
        return WindowFilter(week_range, ph, pairs, getattr(self.loader, "PEAK_FRACTION", None), calendar=calendar)

    @staticmethod
    def _weekly_wins(
        task_scores: Dict[str, pl.DataFrame],
        metric_cols: Tuple[Tuple[str, str], ...] = (("wis", "won"), ("wis_log", "won_log")),
        extra_task_ids: Sequence[str] = (),
    ) -> Dict[str, Dict[str, int]]:
        """Model with lowest mean score on shared weekly tasks wins that week (ties all win)."""
        keys = ["reference_date", "location", "horizon"] + list(extra_task_ids)
        primary_col = metric_cols[0][0]
        frames = []
        for mid, df in task_scores.items():
            if df is None or df.is_empty() or primary_col not in df.columns:
                continue
            avail_keys = [k for k in keys if k in df.columns]
            if len(avail_keys) < 3:
                continue
            cols = avail_keys + [mc for mc, _ in metric_cols if mc in df.columns]
            frames.append(df.select(cols).with_columns(pl.lit(mid).alias("model")))
        if len(frames) < 2:
            return {}
        long = pl.concat(frames, how="diagonal_relaxed").drop_nulls(primary_col)
        if long.is_empty():
            return {}
        active_keys = [k for k in keys if k in long.columns]
        n_week = long.group_by("reference_date").agg(pl.col("model").n_unique().alias("n"))
        shared = (
            long.group_by(active_keys).agg(pl.col("model").n_unique().alias("k"))
            .join(n_week, on="reference_date")
            .filter((pl.col("k") == pl.col("n")) & (pl.col("n") >= 2))
            .select(active_keys)
        )
        sub = long.join(shared, on=active_keys, how="semi")
        out: Dict[str, Dict[str, int]] = {}
        for metric, label in metric_cols:
            if metric not in sub.columns or sub[metric].drop_nulls().is_empty():
                continue
            means = sub.group_by(["reference_date", "model"]).agg(pl.col(metric).mean().alias("m"))
            best = means.group_by("reference_date").agg(pl.col("m").min().alias("best"))
            flagged = means.join(best, on="reference_date").with_columns(
                (pl.col("m") <= pl.col("best") * (1 + 1e-9) + 1e-12).alias("win")
            )
            for mid, won, competed in flagged.group_by("model").agg(
                pl.col("win").sum().alias("won"), pl.len().alias("competed")
            ).iter_rows():
                entry = out.setdefault(mid, {})
                entry[label] = int(won)
                entry["competed"] = int(competed)
        return out

    @staticmethod
    def _cache_get_or_run(
        cache: "OrderedDict[str, Any]",
        lock: threading.Lock,
        inflight: Dict[str, threading.Event],
        max_size: int,
        cache_key: str,
        force_refresh: bool,
        compute_fn: Any,
    ) -> Any:
        while True:
            with lock:
                if not force_refresh and cache_key in cache:
                    cache.move_to_end(cache_key)
                    return cache[cache_key]
                event = inflight.get(cache_key)
                if event is None or force_refresh:
                    event = threading.Event()
                    inflight[cache_key] = event
                    break
            event.wait()

        try:
            result = compute_fn()
            with lock:
                cache[cache_key] = result
                cache.move_to_end(cache_key)
                while len(cache) > max_size:
                    cache.popitem(last=False)
            return result
        finally:
            with lock:
                if inflight.get(cache_key) is event:
                    inflight.pop(cache_key, None)
            event.set()

    def evaluate(self, params: EvaluationParams, force_refresh: bool = False) -> EvaluationResult:
        """Execute evaluation across requested models according to the given parameters."""
        cache_key = self._compute_cache_key(params)
        return self._cache_get_or_run(
            self._eval_cache,
            self._eval_cache_lock,
            self._eval_inflight,
            self._eval_cache_size,
            cache_key,
            force_refresh,
            lambda: self._evaluate_uncached(params),
        )

    def evaluate_model_locations(
        self,
        model_id: str,
        params: EvaluationParams,
        force_refresh: bool = False,
    ) -> Dict[str, Any]:
        """Return per-location pairwise Relative WIS, WIS, and counts matching `evaluate(location=loc)`."""
        table = self._evaluate_locations_table(params, force_refresh=force_refresh)
        return {
            "model": model_id,
            "target": table["target"],
            "baseline": table["baseline"],
            "locations": table["models"].get(model_id, {}),
        }

    def _evaluate_locations_table(
        self,
        params: EvaluationParams,
        force_refresh: bool = False,
    ) -> Dict[str, Any]:
        loc_params = EvaluationParams(
            target=params.target,
            location="all",
            date=params.date,
            season=params.season,
            models=params.models,
            baseline=params.baseline,
            fair=params.fair,
            weeks=params.weeks,
            phase=params.phase,
            horizons=params.horizons,
            dims=params.dims,
        )
        cache_key = self._compute_cache_key(loc_params)
        return self._cache_get_or_run(
            self._loc_eval_cache,
            self._loc_eval_cache_lock,
            self._loc_eval_inflight,
            self._loc_eval_cache_size,
            cache_key,
            force_refresh,
            lambda: self._evaluate_locations_table_uncached(loc_params),
        )

    def _evaluate_locations_table_uncached(self, params: EvaluationParams) -> Dict[str, Any]:
        sc = self._resolve_eval_scope(params)
        if sc.is_pmf_target:
            return {"target": sc.target, "baseline": sc.baseline_id, "models": {}}

        prescored = self.prescore.get_model_task_scores(
            sc.target,
            [mid for mid, _ in sc.to_load],
            sc.all_models,
            sc.oracle,
            non_negative=sc.target_non_neg,
            extra_task_ids=sc.extra_cols,
        )
        scoped_frames: Dict[str, pl.DataFrame] = {}
        for mid, (tdf_full, _) in prescored.items():
            if tdf_full.is_empty():
                continue
            sub = self._filter_df_scope(
                tdf_full,
                locations=None,
                reference_dates=sc.dates_filter,
                horizons=sc.horizon_set,
                dim_filter=sc.dim_filter,
                window_filter=sc.window_filter,
            )
            if not sub.is_empty():
                scoped_frames[mid] = sub

        def _can_have_quantiles(mid: str) -> bool:
            info = sc.all_models.get(mid) or {}
            if info.get("is_synthetic"):
                return True
            ots = info.get("output_types") or []
            if ots and "quantile" not in ots:
                return False
            tgts = info.get("targets") or []
            if tgts and sc.target not in tgts:
                return False
            return True

        fallback_items = [(mid, ds) for mid, ds in sc.to_load if mid not in prescored and _can_have_quantiles(mid)]
        if fallback_items:
            def _score_fb(item: Tuple[str, List[str]]) -> Optional[pl.DataFrame]:
                mid, eval_dates = item
                m_df = self.loader.load_combined_forecasts(mid, eval_dates, as_polars=True)
                if m_df is None or m_df.is_empty():
                    return None
                m_df = self._filter_df_scope(
                    m_df,
                    horizons=sc.horizon_set,
                    dim_filter=sc.dim_filter,
                    window_filter=sc.window_filter,
                )
                if m_df.is_empty():
                    return None
                scored = score_forecasts(
                    m_df,
                    sc.oracle,
                    target=sc.target,
                    locations=None,
                    reference_dates=sc.dates_filter,
                    horizons=sc.horizon_set,
                    non_negative=sc.target_non_neg,
                    population_map=sc.pop_map,
                    extra_task_ids=sc.extra_cols or None,
                    aggregate_locations=sc.agg_locs,
                    return_task_df=True,
                )
                tdf = scored.get("task_df") if scored else None
                return tdf if (tdf is not None and not tdf.is_empty()) else None

            for (mid, _), tdf in zip(fallback_items, ordered_map(_score_fb, fallback_items)):
                if tdf is not None and not tdf.is_empty():
                    scoped_frames[mid] = tdf

        if not scoped_frames:
            return {"target": sc.target, "baseline": sc.baseline_id, "models": {}}

        model_list: List[str] = []
        model_idx_map: Dict[str, int] = {}
        frames: List[pl.DataFrame] = []
        for mid, df in scoped_frames.items():
            idx = len(model_list)
            model_list.append(mid)
            model_idx_map[mid] = idx
            sel = [
                pl.col("location").cast(pl.String),
                pl.col("reference_date").cast(pl.String),
                pl.col("horizon").cast(pl.Int64),
            ] + [
                pl.col(ec).cast(pl.String) for ec in sc.extra_cols if ec in df.columns
            ] + [
                pl.col("wis").cast(pl.Float64),
                (pl.col("wis_log").cast(pl.Float64) if "wis_log" in df.columns else pl.lit(None, dtype=pl.Float64).alias("wis_log")),
                pl.lit(idx, dtype=pl.Int32).alias("_m"),
            ]
            frames.append(df.select(sel))

        long = pl.concat(frames, how="diagonal_relaxed")
        parts = long.partition_by("location", as_dict=True)
        n_models = len(model_list)
        base_idx = model_idx_map.get(sc.baseline_id) if sc.baseline_id else None
        task_cols = ["reference_date", "horizon"] + [ec for ec in sc.extra_cols if ec in long.columns]
        scope_idxs = [model_idx_map[m] for m in sc.requested_model_ids if m in model_idx_map] if sc.fair_flag else []
        per_model: Dict[str, Dict[str, Dict[str, Any]]] = {m: {} for m in model_list}

        for loc_key, g in parts.items():
            loc = str(loc_key[0] if isinstance(loc_key, tuple) else loc_key)
            if sc.fair_flag and len(scope_idxs) > 1:
                shared = (
                    g.filter(pl.col("_m").is_in(scope_idxs))
                    .select(["_m", *task_cols])
                    .unique()
                    .group_by(task_cols)
                    .agg(pl.len().alias("_k"))
                    .filter(pl.col("_k") == len(scope_idxs))
                    .select(task_cols)
                )
                if shared.is_empty():
                    continue
                g = g.join(shared, on=task_cols, how="semi")

            stats = g.group_by("_m").agg(
                pl.col("wis").mean().alias("wis"),
                pl.col("wis_log").mean().alias("wis_log"),
                pl.len().alias("n"),
            )
            rel_lin, dir_lin = compute_pairwise_relative_wis_indexed(
                g, n_models, base_idx, "wis", task_cols
            )
            rel_log, dir_log = compute_pairwise_relative_wis_indexed(
                g, n_models, base_idx, "wis_log", task_cols
            )
            for m_idx, w, wl, cnt in stats.iter_rows():
                per_model[model_list[m_idx]][loc] = {
                    "rel_wis": rel_lin.get(m_idx),
                    "rel_wis_log": rel_log.get(m_idx),
                    "wis": _finite_or_none(w),
                    "wis_log": _finite_or_none(wl),
                    "direct_pct": dir_lin.get(m_idx),
                    "direct_pct_log": dir_log.get(m_idx),
                    "n": int(cnt),
                }

        return {"target": sc.target, "baseline": sc.baseline_id, "models": per_model}

    def _season_for_date(self, d: str) -> str:
        if hasattr(self.loader, "get_season_for_date"):
            return self.loader.get_season_for_date(d)
        return self.loader.get_flu_season_for_date(d)

    @staticmethod
    def _filter_df_scope(
        df: pl.DataFrame,
        *,
        target: Optional[str] = None,
        locations: Optional[List[str]] = None,
        reference_dates: Optional[List[str]] = None,
        horizons: Optional[List[int]] = None,
        dim_filter: Optional[Dict[str, str]] = None,
        window_filter: Optional[WindowFilter] = None,
    ) -> pl.DataFrame:
        out = df
        if target and "target" in out.columns:
            out = out.filter(pl.col("target") == target)
        if locations is not None and len(locations) > 0 and "all" not in locations:
            out = out.filter(pl.col("location").cast(pl.String).is_in(locations))
        if reference_dates is not None and len(reference_dates) > 0 and "all" not in reference_dates:
            out = out.filter(pl.col("reference_date").cast(pl.String).is_in(reference_dates))
        if horizons is not None and len(horizons) > 0:
            out = out.filter(pl.col("horizon").cast(pl.Int64).is_in(horizons))
        if dim_filter:
            for col, val in dim_filter.items():
                if col in out.columns:
                    vals_present = out.get_column(col).cast(pl.String).unique().to_list()
                    if val in vals_present:
                        out = out.filter(pl.col(col).cast(pl.String) == val)
        if window_filter is not None:
            out = window_filter.apply(out)
        return out

    def _resolve_eval_scope(self, params: EvaluationParams) -> _ResolvedScope:
        target = params.target or self.config.get_default_target()
        if is_peak_target(target):
            raise ValueError(
                f"'{target}' is a season peak target: it has no weekly horizons, so it is scored in the dashboard's "
                "Season Peak view rather than on the weekly leaderboard"
            )
        loc_param = (params.location or "all").strip()
        date_param = params.date or "all"
        season_param = (params.season or "").strip()
        fair_flag = bool(params.fair)

        cal = self.loader.get_calendar() if hasattr(self.loader, "get_calendar") else None
        geo = self.loader.get_geo_graph() if hasattr(self.loader, "get_geo_graph") else None

        oracle = self.loader.get_oracle(as_polars=True)
        if oracle is None or oracle.is_empty():
            raise ValueError("No oracle ground truth data found.")

        locations_filter: Optional[List[str]] = None
        if loc_param in ("states", "primary"):
            if geo is not None:
                locations_filter = geo.resolve_pool("all") or None
            else:
                locations_filter = [loc["id"] for loc in self.loader.get_locations().values() if loc["id"] != "US"]
        elif loc_param == "aggregates":
            if geo is not None:
                locations_filter = geo.resolve_pool("aggregates") or ["US"]
            else:
                locations_filter = ["US"]
        elif loc_param == "all" or not loc_param:
            locations_filter = None
        elif geo is not None and (loc_param.startswith(("level:", "region:")) or "," in loc_param):
            resolved = geo.resolve_pool(loc_param)
            locations_filter = resolved if resolved else [s.strip() for s in loc_param.split(",") if s.strip()]
        else:
            locations_filter = [loc_param]

        agg_locs = set(geo.aggregate_locations_in_scope()) if geo is not None else {"US"}

        forecast_seasons = self.loader.get_forecast_seasons()
        all_avail_seasons = self.loader.get_all_seasons()
        default_latest_season = (
            forecast_seasons[-1]
            if forecast_seasons
            else (all_avail_seasons[-1] if all_avail_seasons else self._season_for_date(datetime.now().strftime("%Y-%m-%d")))
        )

        scope_type = "date"
        selected_seasons: List[str] = []
        dates_filter: Optional[List[str]] = None

        if season_param:
            if season_param.lower() == "current":
                scope_type = "season"
                focal_season = (
                    self._season_for_date(date_param)
                    if (date_param and date_param != "all")
                    else default_latest_season
                )
                selected_seasons = [focal_season]
                dates_filter = self.loader.get_dates_for_season(focal_season)
            elif season_param.lower() == "all":
                scope_type = "all"
                selected_seasons = forecast_seasons or all_avail_seasons
                dates_filter = self.loader.get_dates_for_season("all")
            else:
                req_seasons = [s.strip() for s in season_param.split(",") if s.strip()]
                selected_seasons = req_seasons
                scope_type = "seasons" if len(req_seasons) > 1 else "season"
                dates_filter = self.loader.get_dates_for_seasons(req_seasons)
        else:
            if date_param == "all":
                scope_type = "all"
                selected_seasons = forecast_seasons or all_avail_seasons
                dates_filter = self.loader.get_dates_for_season("all")
            elif date_param:
                scope_type = "date"
                selected_seasons = [self._season_for_date(date_param)]
                dates_filter = [date_param]
            else:
                scope_type = "all"
                selected_seasons = forecast_seasons or all_avail_seasons
                dates_filter = self.loader.get_dates_for_season("all")

        window_filter = self._build_window_filter(target, params.weeks, params.phase, calendar=cal)
        target_meta = self.config.get_target_metadata(target)
        if window_filter is not None and dates_filter:
            hm_meta = target_meta.get("horizons") or {}
            win_hs = sorted({int(x) for x in (*(hm_meta.get("required") or ()), *(hm_meta.get("optional") or ()))})
            dates_filter = [d for d in dates_filter if window_filter.round_in_window(d, horizons=win_hs or None)]

        is_pmf_target = bool(
            target_meta.get("is_categorical")
            and "quantile" not in (target_meta.get("output_types") or [])
        )
        dim_defs = self.config.get_extra_task_ids(target)
        extra_cols = sorted(dim_defs.keys())
        dim_filter: Dict[str, str] = {}
        req_dims = params.dims or {}
        for col, dinfo in dim_defs.items():
            val = req_dims.get(col)
            if val is not None:
                if str(val).lower() != "all":
                    dim_filter[col] = str(val)
            elif dinfo.get("default"):
                dim_filter[col] = str(dinfo["default"])

        all_models = self.loader.scan_models()
        if not params.models:
            requested_model_ids = list(all_models.keys())
        else:
            requested_model_ids = [m.strip() for m in params.models if m.strip()]
            if "all" in [m.lower() for m in requested_model_ids]:
                requested_model_ids = list(all_models.keys())

        season_hint = selected_seasons[0] if len(selected_seasons) == 1 else None
        raw_cfg_default = getattr(self.config, "_user_config", {}).get("default_baseline")
        cfg_default = str(raw_cfg_default).strip() if raw_cfg_default else None
        tgt_default = target_baseline_override(self.config, target)
        baseline_meta = self._baseline_meta(all_models, (cfg_default, tgt_default))

        baseline_id = params.baseline.strip() if params.baseline else None
        if not baseline_id or baseline_id not in all_models:
            baseline_id = resolve_baseline(
                all_models,
                model_meta=baseline_meta,
                target=target,
                dates=dates_filter,
                season=season_hint,
                config_default=cfg_default,
                target_config_default=tgt_default,
            ) or self.config.get_default_baseline(list(all_models.keys()), target=target, model_meta=baseline_meta)

        models_to_load = list(requested_model_ids)
        if baseline_id and baseline_id not in models_to_load and baseline_id in all_models:
            models_to_load.append(baseline_id)

        model_meta_stats: Dict[str, Dict[str, Any]] = {}
        total_scope_dates_count = len(dates_filter) if dates_filter else 0
        to_load: List[Tuple[str, List[str]]] = []

        for mid in models_to_load:
            if mid not in all_models:
                continue
            available_dates = all_models[mid].get("dates", [])
            model_active_seasons = sorted({self._season_for_date(d) for d in available_dates})
            eval_dates = [d for d in dates_filter if d in available_dates] if dates_filter else available_dates
            model_meta_stats[mid] = {
                "available_scope_dates": eval_dates,
                "available_scope_dates_count": len(eval_dates),
                "total_scope_dates_count": total_scope_dates_count,
                "active_seasons": model_active_seasons,
                "has_scope_data": len(eval_dates) > 0,
            }
            if eval_dates:
                to_load.append((mid, eval_dates))

        horizon_set = sorted(set(int(h) for h in params.horizons)) if params.horizons is not None else None
        target_non_neg = self.config.is_target_non_negative(target)
        pop_map = self._population_map(target)

        return _ResolvedScope(
            target=target,
            loc_param=loc_param,
            date_param=date_param,
            season_param=season_param,
            fair_flag=fair_flag,
            oracle=oracle,
            locations_filter=locations_filter,
            agg_locs=agg_locs,
            scope_type=scope_type,
            selected_seasons=selected_seasons,
            dates_filter=dates_filter,
            window_filter=window_filter,
            target_meta=target_meta,
            is_pmf_target=is_pmf_target,
            extra_cols=extra_cols,
            dim_filter=dim_filter,
            all_models=all_models,
            requested_model_ids=requested_model_ids,
            baseline_id=baseline_id,
            cfg_default=cfg_default,
            tgt_default=tgt_default,
            baseline_meta=baseline_meta,
            models_to_load=models_to_load,
            model_meta_stats=model_meta_stats,
            total_scope_dates_count=total_scope_dates_count,
            to_load=to_load,
            horizon_set=horizon_set,
            target_non_neg=target_non_neg,
            pop_map=pop_map,
            season_hint=season_hint,
        )

    def _evaluate_uncached(self, params: EvaluationParams) -> EvaluationResult:
        sc_res = self._resolve_eval_scope(params)
        target = sc_res.target
        loc_param = sc_res.loc_param
        date_param = sc_res.date_param
        season_param = sc_res.season_param
        fair_flag = sc_res.fair_flag
        oracle = sc_res.oracle
        locations_filter = sc_res.locations_filter
        agg_locs = sc_res.agg_locs
        scope_type = sc_res.scope_type
        selected_seasons = sc_res.selected_seasons
        dates_filter = sc_res.dates_filter
        window_filter = sc_res.window_filter
        target_meta = sc_res.target_meta
        is_pmf_target = sc_res.is_pmf_target
        extra_cols = sc_res.extra_cols
        dim_filter = sc_res.dim_filter
        all_models = sc_res.all_models
        requested_model_ids = sc_res.requested_model_ids
        baseline_id = sc_res.baseline_id
        cfg_default = sc_res.cfg_default
        tgt_default = sc_res.tgt_default
        baseline_meta = sc_res.baseline_meta
        model_meta_stats = sc_res.model_meta_stats
        total_scope_dates_count = sc_res.total_scope_dates_count
        to_load = sc_res.to_load
        horizon_set = sc_res.horizon_set
        target_non_neg = sc_res.target_non_neg
        pop_map = sc_res.pop_map
        season_hint = sc_res.season_hint

        # Dispatch categorical/PMF targets vs quantile targets
        if is_pmf_target:
            return self._evaluate_pmf(
                target=target,
                target_meta=target_meta,
                oracle=oracle,
                loc_param=loc_param,
                date_param=date_param,
                season_param=season_param,
                scope_type=scope_type,
                selected_seasons=selected_seasons,
                dates_filter=dates_filter,
                locations_filter=locations_filter,
                agg_locs=agg_locs,
                horizon_set=horizon_set,
                window_filter=window_filter,
                dim_filter=dim_filter,
                extra_cols=extra_cols,
                fair_flag=fair_flag,
                all_models=all_models,
                requested_model_ids=requested_model_ids,
                baseline_id=baseline_id,
                cfg_default=cfg_default,
                tgt_default=tgt_default,
                baseline_meta=baseline_meta,
                model_meta_stats=model_meta_stats,
                to_load=to_load,
                season_hint=season_hint,
                total_scope_dates_count=total_scope_dates_count,
            )

        # 6. Pre-score fast path for persistent quantile models + fallback load for synthetic / uncached models
        def _model_supports_quantile_target(mid: str) -> bool:
            info = all_models.get(mid) or {}
            if info.get("is_synthetic"):
                return True
            ots = info.get("output_types") or []
            if ots and "quantile" not in ots:
                return False
            tgts = info.get("targets") or []
            if tgts and target not in tgts:
                return False
            return True

        load_mids = [mid for mid, _ in to_load if _model_supports_quantile_target(mid)]
        prescored = self.prescore.get_model_task_scores(
            target,
            load_mids,
            all_models,
            oracle,
            non_negative=target_non_neg,
            extra_task_ids=extra_cols,
        )

        # Models NOT covered by prescore (e.g. synthetic ensembles or custom non-parquet mocks)
        fallback_items = [
            (mid, ds)
            for mid, ds in to_load
            if mid not in prescored and _model_supports_quantile_target(mid)
        ]
        need_keys_for_prescored = fair_flag or window_filter is not None or horizon_set is not None

        def _load_raw(item: Tuple[str, List[str]]) -> Optional[pl.DataFrame]:
            mid, eval_dates = item
            m_df = self.loader.load_combined_forecasts(mid, eval_dates, as_polars=True)
            if m_df is None or m_df.is_empty():
                return m_df
            return self._filter_df_scope(
                m_df,
                horizons=horizon_set,
                dim_filter=dim_filter,
                window_filter=window_filter,
            )

        model_dfs: Dict[str, pl.DataFrame] = {}
        if fallback_items:
            for (mid, _), m_df in zip(fallback_items, ordered_map(_load_raw, fallback_items)):
                if m_df is not None and not m_df.is_empty():
                    model_dfs[mid] = m_df

        # Lightweight submitted-task keys for window/horizon scope trimming and fair intersection
        submitted_keys: Dict[str, pl.DataFrame] = {}
        if need_keys_for_prescored:
            prescored_mids = [mid for mid, _ in to_load if mid in prescored]

            def _scan_keys(mid: str) -> Optional[pl.DataFrame]:
                raw_id, is_local = self.loader._resolve_model_id_and_local(mid)
                lf = self.loader.cache_mgr.scan_model(raw_id, is_local=is_local)
                if lf is None:
                    return None
                q = lf.filter(pl.col("target") == target)
                names = q.collect_schema().names()
                if "output_type" in names:
                    q = q.filter(pl.col("output_type") == "quantile")
                eval_dates = model_meta_stats[mid]["available_scope_dates"]
                if eval_dates:
                    q = q.filter(pl.col("reference_date").is_in(eval_dates))
                if horizon_set is not None:
                    q = q.filter(pl.col("horizon").cast(pl.Int64).is_in(horizon_set))
                sel = [c for c in ("reference_date", "location", "horizon", "target_end_date", *extra_cols) if c in names]
                df_k = q.select(sel).unique().collect()
                if df_k.is_empty():
                    return None
                return self._filter_df_scope(
                    df_k,
                    locations=None,
                    dim_filter=dim_filter,
                    window_filter=window_filter,
                )

            if prescored_mids:
                for mid, kdf in zip(prescored_mids, ordered_map(_scan_keys, prescored_mids)):
                    if kdf is not None and not kdf.is_empty():
                        submitted_keys[mid] = kdf

            for mid, df in model_dfs.items():
                kt = model_task_keys(
                    df, target, locations=None, reference_dates=None, extra_task_ids=extra_cols
                )
                if kt is not None and not kt.is_empty():
                    if "target_end_date" in df.columns:
                        submitted_keys[mid] = df.filter(pl.col("target") == target).select(
                            [c for c in ("reference_date", "location", "horizon", "target_end_date", *extra_cols) if c in df.columns]
                        ).unique()
                    else:
                        submitted_keys[mid] = kt

        # 5b. With a window or horizon subset, report remaining rounds in scope
        if window_filter is not None or horizon_set is not None:
            remaining: Set[str] = set()
            active_key_mids = set(submitted_keys.keys()) | set(model_dfs.keys())
            for mid in active_key_mids:
                src_df = submitted_keys.get(mid) if mid in submitted_keys else model_dfs.get(mid)
                if src_df is None or src_df.is_empty():
                    continue
                scoped = (
                    src_df.filter(pl.col("location").cast(pl.String).is_in(locations_filter))
                    if locations_filter else src_df
                )
                ds = sorted({str(d) for d in scoped.get_column("reference_date").unique().to_list()})
                if mid in model_meta_stats:
                    model_meta_stats[mid]["available_scope_dates"] = ds
                    model_meta_stats[mid]["available_scope_dates_count"] = len(ds)
                if mid in requested_model_ids:
                    remaining.update(ds)
            for mid, stat in model_meta_stats.items():
                if mid not in active_key_mids:
                    stat["available_scope_dates"] = []
                    stat["available_scope_dates_count"] = 0
            total_scope_dates_count = len(remaining)
            dates_filter = sorted(remaining)
            for stat in model_meta_stats.values():
                stat["total_scope_dates_count"] = total_scope_dates_count

        # 6. Fair common task intersection
        common_task_set: Optional[Set[Tuple[Any, ...]]] = None
        common_task_status = "none"
        common_task_message: Optional[str] = None

        eval_source_frames: Dict[str, pl.DataFrame] = {}
        for m in requested_model_ids:
            if m in model_dfs:
                eval_source_frames[m] = model_dfs[m]
            elif m in submitted_keys:
                eval_source_frames[m] = submitted_keys[m]
            elif m in prescored:
                # Filter pre-scored task_df to dates/locations/dims if no window/horizon cut needed submitted_keys
                tdf_full, _ = prescored[m]
                if not tdf_full.is_empty():
                    eval_source_frames[m] = tdf_full

        if fair_flag and len(eval_source_frames) > 1:
            common_task_set = find_common_tasks(
                eval_source_frames,
                target=target,
                locations=locations_filter,
                reference_dates=dates_filter,
                extra_task_ids=extra_cols,
            )
            if not common_task_set:
                common_task_status = "empty_disjoint"
                disjoint_examples = []
                for mid in list(eval_source_frames.keys())[:3]:
                    m_dates = model_meta_stats.get(mid, {}).get("available_scope_dates", [])
                    if m_dates:
                        disjoint_examples.append(f"{mid} ({m_dates[0][:4]}–{m_dates[-1][:4]})")
                ex_str = ", ".join(disjoint_examples)
                common_task_message = (
                    f"Zero common tasks found across the selected models in this evaluation scope. "
                    f"Models have disjoint forecast rounds (e.g. {ex_str}). "
                    f"Turn off Common Tasks to evaluate each model on its active forecast rounds."
                )
            else:
                common_task_status = "ok"
                common_task_message = (
                    f"Evaluated strictly on {len(common_task_set):,} shared tasks across all {len(eval_source_frames)} models."
                )
        elif fair_flag and len(eval_source_frames) <= 1:
            common_task_status = "single_model"
            common_task_message = "Common tasks requires at least two models to compute an intersection."

        # 7. Score models (PreScoreStore slicing for persistent models, score_forecasts for fallback)
        scores_by_model: Dict[str, Dict[str, Any]] = {}
        if common_task_status != "empty_disjoint":
            common_tasks_arg = _common_tasks_frame(common_task_set, extra_task_ids=extra_cols)

            for mid, (tdf_full, mmeta) in prescored.items():
                if tdf_full.is_empty():
                    continue
                sub_tdf = self._filter_df_scope(
                    tdf_full,
                    locations=locations_filter,
                    reference_dates=dates_filter,
                    horizons=horizon_set,
                    dim_filter=dim_filter,
                    window_filter=window_filter,
                )
                if common_tasks_arg is not None and not sub_tdf.is_empty():
                    if isinstance(common_tasks_arg, pl.DataFrame):
                        join_cols = [c for c in list(TASK_KEY_COLS) + extra_cols if c in sub_tdf.columns and c in common_tasks_arg.columns]
                        sub_tdf = sub_tdf.join(common_tasks_arg, on=join_cols, how="semi")
                    else:
                        sub_tdf = pl.DataFrame()
                if sub_tdf.is_empty():
                    continue
                sc = summarize_scored_tasks(
                    sub_tdf,
                    present_quantiles=mmeta.get("present_quantiles"),
                    population_map=pop_map,
                    aggregate_locations=agg_locs,
                    negative_values_clipped=int(mmeta.get("negative_values_clipped", 0)),
                    extra_task_ids=extra_cols,
                    include_task_df=True,
                )
                if sc:
                    scores_by_model[mid] = sc

            if model_dfs:
                def _score_fb(df: pl.DataFrame) -> Dict[str, Any]:
                    return score_forecasts(
                        df,
                        oracle,
                        target=target,
                        locations=locations_filter,
                        reference_dates=dates_filter,
                        horizons=horizon_set,
                        common_tasks=common_tasks_arg,
                        non_negative=target_non_neg,
                        population_map=pop_map,
                        extra_task_ids=extra_cols or None,
                        aggregate_locations=agg_locs,
                        return_task_df=True,
                    )

                for mid, sc in zip(list(model_dfs.keys()), ordered_map(_score_fb, list(model_dfs.values()))):
                    if sc:
                        scores_by_model[mid] = sc

        # Pairwise tournament pool: primary jurisdictions whenever any primary is scored, else aggregates
        primary_pool = any(sc["metadata"]["has_states_data"] for sc in scores_by_model.values())
        agg_list = sorted(agg_locs)
        pool_filter = (~pl.col("location").is_in(agg_list)) if primary_pool else pl.col("location").is_in(agg_list)
        task_scores_by_model = {
            mid: sc["task_df"].filter(pool_filter)
            for mid, sc in scores_by_model.items()
            if "task_df" in sc and sc["task_df"] is not None
        }

        validation_warnings: List[str] = []
        effective_baseline = baseline_id if (baseline_id and baseline_id in task_scores_by_model) else None
        if not effective_baseline and task_scores_by_model:
            effective_baseline = resolve_baseline(
                all_models,
                model_meta=baseline_meta,
                target=target,
                dates=dates_filter,
                season=season_hint,
                config_default=cfg_default,
                target_config_default=tgt_default,
                eligible_ids=set(task_scores_by_model.keys()),
            )
            if not effective_baseline:
                for candidate in task_scores_by_model:
                    if "ensemble" in candidate.lower():
                        effective_baseline = candidate
                        break
            if not effective_baseline:
                effective_baseline = list(task_scores_by_model.keys())[0]
            missing_desc = f"Baseline '{baseline_id}' has no forecasts in this scope" if baseline_id else "No baseline model found"
            validation_warnings.append(
                f"{missing_desc}; relative WIS and Δ% are scaled to '{effective_baseline}' instead."
            )

        weekly_wins = self._weekly_wins(
            {m: df for m, df in task_scores_by_model.items() if m in requested_model_ids},
            extra_task_ids=extra_cols,
        )

        pairwise_tournament_rel_wis: Dict[str, Any] = {}
        pairwise_tournament_rel_wis_log: Dict[str, Any] = {}
        if task_scores_by_model:
            pairwise_tournament_rel_wis, pairwise_tournament_rel_wis_log = ordered_map(
                lambda col: compute_pairwise_relative_wis(
                    task_scores_by_model,
                    effective_baseline,
                    metric_col=col,
                    extra_task_ids=extra_cols,
                ),
                ["wis", "wis_log"],
            )

        # Pairwise task keys for Δ% vs baseline in unconstrained mode
        comparisons: List[Dict[str, Any]] = []
        ref_baseline_id = effective_baseline
        task_key_outcomes: Dict[str, Tuple[bool, Any]] = {}
        if ref_baseline_id and not (fair_flag and ref_baseline_id in scores_by_model):
            key_models = [ref_baseline_id] + [
                m for m in requested_model_ids if m != ref_baseline_id and m in scores_by_model
            ]
            key_models = list(dict.fromkeys(key_models))
            req_kcols = list(TASK_KEY_COLS) + extra_cols
            for km in key_models:
                if km in scores_by_model and "task_df" in scores_by_model[km]:
                    tdf_k = scores_by_model[km]["task_df"]
                    use_cols = [c for c in req_kcols if c in tdf_k.columns]
                    task_key_outcomes[km] = (True, tdf_k.select(use_cols).unique())
                elif km in model_dfs:
                    task_key_outcomes[km] = (
                        True,
                        model_task_keys(
                            model_dfs[km], target, locations_filter, dates_filter, extra_task_ids=extra_cols
                        ),
                    )
                else:
                    task_key_outcomes[km] = (True, None)

        # 8. Build rankings table
        for mid in requested_model_ids:
            if mid not in all_models:
                continue

            m_stat = model_meta_stats.get(mid, {})
            has_data = m_stat.get("has_scope_data", False)
            sc = scores_by_model.get(mid)
            is_local = all_models[mid].get("is_local", False)

            pending_truth = False
            no_location = False
            if has_data and sc is None and common_task_status != "empty_disjoint":
                if not _model_supports_quantile_target(mid):
                    pending_truth = False
                    no_location = True
                else:
                    m_df = model_dfs.get(mid)
                    if m_df is None and mid in submitted_keys:
                        m_df = submitted_keys[mid]
                    elif m_df is None:
                        # Lightweight check only when a model returned 0 scored tasks
                        eval_ds = m_stat.get("available_scope_dates", [])
                        m_df = _load_raw((mid, eval_ds)) if eval_ds else None
                    in_scope = m_df is not None and not m_df.is_empty()
                    if in_scope:
                        if "target" in m_df.columns:
                            m_df = m_df.filter(pl.col("target") == target)
                        if locations_filter:
                            m_df = m_df.filter(pl.col("location").cast(pl.String).is_in(locations_filter))
                        in_scope = not m_df.is_empty()
                    pending_truth = in_scope
                    no_location = not in_scope

            if not has_data or sc is None:
                seasons_str = ", ".join(selected_seasons) if selected_seasons else "selected scope"
                act_str = ", ".join(m_stat.get("active_seasons", []))
                status_note = f"Not active in {seasons_str}" + (f" (Active: {act_str})" if act_str else "")
                if common_task_status == "empty_disjoint" and has_data:
                    status_note = "Disjoint rounds from other models"
                elif pending_truth:
                    status_note = "Awaiting truth: no observations yet for these target weeks"
                elif no_location:
                    where = (
                        "these locations"
                        if locations_filter and len(locations_filter) > 1
                        else (loc_param if loc_param not in ("all", "states", "primary") else "this scope")
                    )
                    status_note = f"No {target} forecasts for {where} in this window"

                comparisons.append({
                    "model_id": mid,
                    "is_local": is_local,
                    "is_synthetic": all_models.get(mid, {}).get("is_synthetic", False),
                    "synthetic_config": all_models.get(mid, {}).get("synthetic_config"),
                    "has_data_in_scope": False if (not has_data or pending_truth or no_location) else (common_task_status != "empty_disjoint"),
                    "pending_truth": pending_truth,
                    "status_note": status_note,
                    "weeks_won": None,
                    "weeks_won_log": None,
                    "weeks_competed": None,
                    "active_seasons": m_stat.get("active_seasons", []),
                    "scope_rounds_available": m_stat.get("available_scope_dates_count", 0),
                    "scope_rounds_total": total_scope_dates_count,
                    "wis": None,
                    "wis_log": None,
                    "wis_7": None,
                    "quantile_count": 0,
                    "has_23_quantiles": False,
                    "pct_diff_vs_baseline": None,
                    "pct_diff_vs_baseline_log": None,
                    "relative_wis": None,
                    "relative_wis_log": None,
                    "wis_per_100k": None,
                    "baseline_model": ref_baseline_id,
                    "mae": None,
                    "mae_log": None,
                    "cov95": None,
                    "cov50": None,
                    "sharpness": None,
                    "decomp_sharpness": None,
                    "decomp_overpred": None,
                    "decomp_underpred": None,
                    "calibration": {},
                    "count": 0,
                    "evaluated_dates_count": 0,
                    "locations_count": 0,
                    "states_wis": None,
                    "us_wis": None,
                    "aggregate_wis": None,
                    "by_horizon": {},
                })
                continue

            wis = sc["overall"].get("wis")
            wis_log = sc["overall"].get("wis_log")
            mae_log = sc["overall"].get("mae_log")
            pct_diff = None
            pct_diff_log = None

            if ref_baseline_id:
                if mid == ref_baseline_id:
                    pct_diff = 0.0
                    pct_diff_log = 0.0 if wis_log is not None else None
                elif wis is not None:
                    if fair_flag and ref_baseline_id in scores_by_model:
                        base_wis_shared = scores_by_model[ref_baseline_id]["overall"].get("wis")
                        if base_wis_shared and base_wis_shared > 0:
                            pct_diff = ((wis - base_wis_shared) / base_wis_shared) * 100.0
                        base_wis_shared_log = scores_by_model[ref_baseline_id]["overall"].get("wis_log")
                        if base_wis_shared_log and base_wis_shared_log > 0 and wis_log is not None:
                            pct_diff_log = ((wis_log - base_wis_shared_log) / base_wis_shared_log) * 100.0
                    elif mid in task_key_outcomes and ref_baseline_id in task_key_outcomes:
                        shared_with_baseline = intersect_task_keys(
                            [task_key_outcomes[mid], task_key_outcomes[ref_baseline_id]],
                            extra_task_ids=extra_cols,
                        )
                        if shared_with_baseline is not None and not shared_with_baseline.is_empty():
                            base_wis_shared, base_wis_shared_log = _shared_task_wis(
                                scores_by_model[ref_baseline_id]["task_df"],
                                shared_with_baseline,
                                aggregate_locations=agg_locs,
                                extra_task_ids=extra_cols,
                            )
                            model_wis_shared, model_wis_shared_log = _shared_task_wis(
                                scores_by_model[mid]["task_df"],
                                shared_with_baseline,
                                aggregate_locations=agg_locs,
                                extra_task_ids=extra_cols,
                            )
                            if model_wis_shared is not None and base_wis_shared and base_wis_shared > 0:
                                pct_diff = ((model_wis_shared - base_wis_shared) / base_wis_shared) * 100.0
                            if model_wis_shared_log is not None and base_wis_shared_log and base_wis_shared_log > 0:
                                pct_diff_log = ((model_wis_shared_log - base_wis_shared_log) / base_wis_shared_log) * 100.0

            us_wis_val = sc["us"].get("wis") if sc.get("us") else None
            comparisons.append({
                "model_id": mid,
                "is_local": is_local,
                "is_synthetic": all_models.get(mid, {}).get("is_synthetic", False),
                "synthetic_config": all_models.get(mid, {}).get("synthetic_config"),
                "has_data_in_scope": True,
                "status_note": None,
                "weeks_won": weekly_wins.get(mid, {}).get("won"),
                "weeks_won_log": weekly_wins.get(mid, {}).get("won_log"),
                "weeks_competed": weekly_wins.get(mid, {}).get("competed"),
                "active_seasons": m_stat.get("active_seasons", []),
                "scope_rounds_available": m_stat.get("available_scope_dates_count", 0),
                "scope_rounds_total": total_scope_dates_count,
                "wis": wis,
                "wis_log": round(wis_log, 4) if wis_log is not None else None,
                "wis_7": sc["overall"].get("wis_7"),
                "quantile_count": sc["overall"].get("quantile_count", 23),
                "has_23_quantiles": sc["overall"].get("has_23_quantiles", True),
                "pct_diff_vs_baseline": round(pct_diff, 1) if pct_diff is not None else None,
                "pct_diff_vs_baseline_log": round(pct_diff_log, 1) if pct_diff_log is not None else None,
                "relative_wis": (
                    pairwise_tournament_rel_wis.get(mid, {}).get("relative_wis")
                    if isinstance(pairwise_tournament_rel_wis.get(mid), dict)
                    else pairwise_tournament_rel_wis.get(mid)
                ),
                "relative_wis_log": (
                    pairwise_tournament_rel_wis_log.get(mid, {}).get("relative_wis")
                    if isinstance(pairwise_tournament_rel_wis_log.get(mid), dict)
                    else pairwise_tournament_rel_wis_log.get(mid)
                ),
                "wis_per_100k": sc["overall"].get("wis_per_100k"),
                "baseline_model": ref_baseline_id,
                "mae": sc["overall"].get("mae"),
                "mae_log": round(mae_log, 4) if mae_log is not None else None,
                "cov95": sc["overall"].get("cov95"),
                "cov50": sc["overall"].get("cov50"),
                "sharpness": sc["overall"].get("sharpness"),
                "decomp_sharpness": sc["overall"].get("sharpness_component"),
                "decomp_overpred": sc["overall"].get("overprediction_penalty"),
                "decomp_underpred": sc["overall"].get("underprediction_penalty"),
                "calibration": sc["overall"].get("calibration", {}),
                "count": sc["overall"].get("count"),
                "evaluated_dates_count": sc.get("metadata", {}).get("dates_count", 1),
                "locations_count": sc.get("metadata", {}).get("locations_count", 1),
                "benchmark_pool": sc.get("metadata", {}).get("benchmark_pool", "states"),
                "states_wis": sc["states"].get("wis") if sc.get("states") else None,
                "us_wis": us_wis_val,
                "aggregate_wis": us_wis_val,
                "by_horizon": sc.get("by_horizon", {}),
            })

        comparisons.sort(
            key=lambda x: (
                not x["has_data_in_scope"],
                x["relative_wis"] is None,
                x["relative_wis"] if x["relative_wis"] is not None else float("inf"),
                x["wis"] if x["wis"] is not None else float("inf"),
            )
        )

        # 9. Collect validation warnings
        validation_warnings += self.loader.get_validation_warnings(requested_model_ids)
        for comp in comparisons:
            if comp["has_data_in_scope"] and comp["quantile_count"] < 7:
                validation_warnings.append(
                    f"Model '{comp['model_id']}' has only {comp['quantile_count']} quantiles (standard is 7 or 23)."
                )
        validation_warnings = sorted(set(validation_warnings))

        return EvaluationResult(
            target=target,
            location_filter=loc_param,
            date_filter=date_param,
            season_filter=season_param,
            scope_type=scope_type,
            selected_seasons=selected_seasons,
            scope_dates_count=total_scope_dates_count,
            scope_dates=dates_filter,
            baseline_model=ref_baseline_id or baseline_id,
            fair_intersection=fair_flag,
            common_task_status=common_task_status,
            common_task_message=common_task_message,
            common_tasks_count=len(common_task_set) if common_task_set is not None else None,
            rankings=comparisons,
            validation_warnings=validation_warnings,
            window=window_filter.describe() if window_filter is not None else None,
            locations_filter=locations_filter,
            common_task_set=common_task_set,
            window_filter=window_filter,
            aggregate_locations=agg_locs,
            extra_task_ids=tuple(extra_cols),
            dim_filter=dim_filter,
        )

    def _evaluate_pmf(
        self,
        *,
        target: str,
        target_meta: Dict[str, Any],
        oracle: pl.DataFrame,
        loc_param: str,
        date_param: str,
        season_param: str,
        scope_type: str,
        selected_seasons: List[str],
        dates_filter: Optional[List[str]],
        locations_filter: Optional[List[str]],
        agg_locs: Set[str],
        horizon_set: Optional[List[int]],
        window_filter: Optional[WindowFilter],
        dim_filter: Dict[str, str],
        extra_cols: List[str],
        fair_flag: bool,
        all_models: Dict[str, Dict[str, Any]],
        requested_model_ids: List[str],
        baseline_id: Optional[str],
        cfg_default: Optional[str],
        tgt_default: Optional[str],
        baseline_meta: Dict[str, Dict[str, Any]],
        model_meta_stats: Dict[str, Dict[str, Any]],
        to_load: List[Tuple[str, List[str]]],
        season_hint: Optional[str],
        total_scope_dates_count: int,
    ) -> EvaluationResult:
        """Evaluate categorical/ordinal PMF targets (RPS, Log Score, Brier Score)."""
        categories = target_meta.get("categories") or None
        ordinal = bool(categories and len(categories) >= 2)

        def _load_pmf(item: Tuple[str, List[str]]) -> Optional[pl.DataFrame]:
            mid, eval_dates = item
            raw_id, is_local = self.loader._resolve_model_id_and_local(mid)
            lf = self.loader.cache_mgr.scan_model_pmf(raw_id, is_local=is_local)
            df = None
            if lf is not None:
                df = lf.filter((pl.col("target") == target) & pl.col("reference_date").is_in(eval_dates)).collect()
            if df is None or df.is_empty():
                raw_df = self.loader.load_combined_forecasts(mid, eval_dates, as_polars=True)
                if raw_df is not None and not raw_df.is_empty() and "output_type" in raw_df.columns:
                    df = raw_df.filter((pl.col("target") == target) & (pl.col("output_type") == "pmf"))
            if df is None or df.is_empty():
                return None
            return self._filter_df_scope(
                df,
                horizons=horizon_set,
                dim_filter=dim_filter,
                window_filter=window_filter,
            )

        pmf_dfs: Dict[str, pl.DataFrame] = {}
        for (mid, _), df in zip(to_load, ordered_map(_load_pmf, to_load)):
            if df is not None and not df.is_empty():
                pmf_dfs[mid] = df

        scores_by_model: Dict[str, Dict[str, Any]] = {}
        if pmf_dfs:
            def _score_pmf(df: pl.DataFrame) -> Dict[str, Any]:
                return score_pmf_forecasts(
                    df,
                    oracle,
                    target,
                    categories=categories,
                    ordinal=ordinal,
                    locations=locations_filter,
                    reference_dates=dates_filter,
                    horizons=horizon_set,
                    extra_task_ids=extra_cols or None,
                    aggregate_locations=agg_locs,
                    return_task_df=True,
                )

            for mid, sc in zip(list(pmf_dfs.keys()), ordered_map(_score_pmf, list(pmf_dfs.values()))):
                if sc:
                    scores_by_model[mid] = sc

        primary_pool = any(sc["metadata"]["has_states_data"] for sc in scores_by_model.values())
        agg_list = sorted(agg_locs)
        pool_filter = (~pl.col("location").is_in(agg_list)) if primary_pool else pl.col("location").is_in(agg_list)
        task_scores = {
            mid: sc["task_df"].filter(pool_filter)
            for mid, sc in scores_by_model.items()
            if "task_df" in sc and sc["task_df"] is not None
        }
        rank_col = "rps" if ordinal else "log_score"
        effective_baseline = baseline_id if (baseline_id and baseline_id in task_scores) else None
        if not effective_baseline and task_scores:
            effective_baseline = resolve_baseline(
                all_models,
                model_meta=baseline_meta,
                target=target,
                dates=dates_filter,
                season=season_hint,
                config_default=cfg_default,
                target_config_default=tgt_default,
                eligible_ids=set(task_scores.keys()),
            ) or list(task_scores.keys())[0]

        rel_skill = (
            compute_pairwise_relative_wis(task_scores, effective_baseline, metric_col=rank_col, extra_task_ids=extra_cols)
            if task_scores else {}
        )

        comparisons: List[Dict[str, Any]] = []
        for mid in requested_model_ids:
            if mid not in all_models:
                continue
            m_stat = model_meta_stats.get(mid, {})
            has_data = m_stat.get("has_scope_data", False)
            sc = scores_by_model.get(mid)
            is_local = all_models[mid].get("is_local", False)
            if not has_data or sc is None:
                comparisons.append({
                    "model_id": mid,
                    "is_local": is_local,
                    "is_synthetic": False,
                    "has_data_in_scope": False,
                    "pending_truth": mid in pmf_dfs,
                    "status_note": "Awaiting categorical truth or no PMF forecasts in scope",
                    "active_seasons": m_stat.get("active_seasons", []),
                    "scope_rounds_available": m_stat.get("available_scope_dates_count", 0),
                    "scope_rounds_total": total_scope_dates_count,
                    "rps": None,
                    "log_score": None,
                    "brier": None,
                    "hit_mode": None,
                    "wis": None,
                    "relative_wis": None,
                    "baseline_model": effective_baseline,
                    "count": 0,
                    "by_horizon": {},
                })
                continue

            rs = rel_skill.get(mid, {}) if isinstance(rel_skill.get(mid), dict) else {}
            comparisons.append({
                "model_id": mid,
                "is_local": is_local,
                "is_synthetic": False,
                "has_data_in_scope": True,
                "status_note": None,
                "active_seasons": m_stat.get("active_seasons", []),
                "scope_rounds_available": m_stat.get("available_scope_dates_count", 0),
                "scope_rounds_total": total_scope_dates_count,
                "rps": sc["overall"].get("rps"),
                "log_score": sc["overall"].get("log_score"),
                "brier": sc["overall"].get("brier"),
                "hit_mode": sc["overall"].get("hit_mode"),
                "wis": None,
                "relative_wis": rs.get("relative_wis"),
                "pct_diff_vs_baseline": rs.get("direct_pct_vs_baseline"),
                "baseline_model": effective_baseline,
                "count": sc["overall"].get("count", 0),
                "evaluated_dates_count": sc.get("metadata", {}).get("dates_count", 1),
                "locations_count": sc.get("metadata", {}).get("locations_count", 1),
                "by_horizon": sc.get("by_horizon", {}),
            })

        comparisons.sort(
            key=lambda x: (
                not x["has_data_in_scope"],
                x.get(rank_col) is None,
                x.get(rank_col) if x.get(rank_col) is not None else float("inf"),
            )
        )

        return EvaluationResult(
            target=target,
            location_filter=loc_param,
            date_filter=date_param,
            season_filter=season_param,
            scope_type=scope_type,
            selected_seasons=selected_seasons,
            scope_dates_count=total_scope_dates_count,
            scope_dates=dates_filter,
            baseline_model=effective_baseline,
            fair_intersection=fair_flag,
            common_task_status="none",
            common_task_message=None,
            common_tasks_count=None,
            is_categorical=True,
            ordinal=ordinal,
            rank_metric=rank_col,
            rankings=comparisons,
            validation_warnings=sorted(set(self.loader.get_validation_warnings(requested_model_ids))),
            window=window_filter.describe() if window_filter is not None else None,
            locations_filter=locations_filter,
            common_task_set=None,
            window_filter=window_filter,
            aggregate_locations=agg_locs,
            extra_task_ids=tuple(extra_cols),
            dim_filter=dim_filter,
        )

    def _population_map(self, target: str) -> Optional[Dict[str, int]]:
        if self.config.get_target_metadata(target)["is_rate"]:
            return None
        return {loc: info["population"] for loc, info in self.loader.get_locations().items() if info.get("population")}

    def get_task_scores_dataframe(self, params: EvaluationParams) -> Optional[pl.DataFrame]:
        """Return task-level scores matching the exact scope of `evaluate(params)`."""
        target = params.target or self.config.get_default_target()
        oracle = self.loader.get_oracle(as_polars=True)
        if oracle is None or oracle.is_empty():
            return None

        result = self.evaluate(params)
        active_mids = [r["model_id"] for r in result.rankings if r.get("has_data_in_scope")]
        if not active_mids:
            return None

        pop_map = self._population_map(target)
        target_non_neg = self.config.is_target_non_negative(target)
        common_tasks_arg = _common_tasks_frame(result.common_task_set, extra_task_ids=result.extra_task_ids)

        def _task_scores(mid: str) -> Optional[pl.DataFrame]:
            df = self.loader.load_combined_forecasts(mid, result.scope_dates, as_polars=True)
            if df is None or df.is_empty():
                return None
            df = self._filter_df_scope(
                df,
                horizons=params.horizons,
                dim_filter=result.dim_filter,
                window_filter=result.window_filter,
            )
            if df.is_empty():
                return None
            sc = score_forecasts(
                df,
                oracle,
                target=target,
                locations=result.locations_filter,
                reference_dates=result.scope_dates,
                horizons=params.horizons,
                common_tasks=common_tasks_arg,
                non_negative=target_non_neg,
                population_map=pop_map,
                extra_task_ids=result.extra_task_ids or None,
                aggregate_locations=result.aggregate_locations,
                return_task_df=True,
            )
            if sc and "task_df" in sc and sc["task_df"] is not None:
                return sc["task_df"].with_columns(pl.lit(mid).alias("model_id"))
            return None

        dfs = [t_df for t_df in ordered_map(_task_scores, active_mids) if t_df is not None]
        if not dfs:
            return None
        return pl.concat(dfs, how="diagonal")

    def evaluate_samples(self, params: EvaluationParams) -> Dict[str, Any]:
        """Evaluate sample-trajectory forecasts using exact empirical CRPS and multi-horizon Energy Score."""
        cache_key = "samp|" + self._compute_cache_key(params, mode="samples")
        with self._sample_eval_cache_lock:
            hit = self._sample_eval_cache.get(cache_key)
            if hit is not None:
                self._sample_eval_cache.move_to_end(cache_key)
                return hit

        sc_res = self._resolve_eval_scope(params)
        target = sc_res.target
        oracle = sc_res.oracle
        locations_filter = sc_res.locations_filter
        agg_locs = sc_res.agg_locs
        dates_filter = sc_res.dates_filter
        window_filter = sc_res.window_filter
        dim_filter = sc_res.dim_filter
        extra_cols = sc_res.extra_cols
        all_models = sc_res.all_models
        requested_model_ids = sc_res.requested_model_ids
        baseline_id = sc_res.baseline_id
        cfg_default = sc_res.cfg_default
        tgt_default = sc_res.tgt_default
        baseline_meta = sc_res.baseline_meta
        model_meta_stats = sc_res.model_meta_stats
        to_load = sc_res.to_load
        horizon_set = sc_res.horizon_set
        season_hint = sc_res.season_hint
        total_scope_dates_count = sc_res.total_scope_dates_count

        # Filter to models likely carrying sample trajectories for this target
        sample_to_load = [
            (mid, eval_dates)
            for (mid, eval_dates) in to_load
            if (
                all_models.get(mid, {}).get("has_samples")
                or "sample" in (all_models.get(mid, {}).get("output_types") or [])
            )
            and (not all_models.get(mid, {}).get("targets") or target in all_models[mid]["targets"])
        ]

        def _load_sample_df(item: Tuple[str, List[str]]) -> Optional[pl.DataFrame]:
            mid, eval_dates = item
            raw_id, is_local = self.loader._resolve_model_id_and_local(mid)
            lf = self.loader.cache_mgr.scan_model_samples(raw_id, is_local=is_local)
            df = None
            if lf is not None:
                df = lf.filter((pl.col("target") == target) & pl.col("reference_date").is_in(eval_dates)).collect()
            if df is None or df.is_empty():
                raw_df = self.loader.load_combined_forecasts(mid, eval_dates, as_polars=True)
                if raw_df is not None and not raw_df.is_empty() and "output_type" in raw_df.columns:
                    df = raw_df.filter((pl.col("target") == target) & (pl.col("output_type") == "sample"))
            if df is None or df.is_empty():
                return None
            return self._filter_df_scope(
                df,
                horizons=horizon_set,
                dim_filter=dim_filter,
                window_filter=window_filter,
            )

        sample_dfs: Dict[str, pl.DataFrame] = {}
        for (mid, _), df in zip(sample_to_load, ordered_map(_load_sample_df, sample_to_load)):
            if df is not None and not df.is_empty():
                sample_dfs[mid] = df

        scores_by_model: Dict[str, Dict[str, Any]] = {}
        if sample_dfs:
            def _score_s(df: pl.DataFrame) -> Dict[str, Any]:
                return score_sample_forecasts(
                    df,
                    oracle,
                    target,
                    locations=locations_filter,
                    reference_dates=dates_filter,
                    horizons=horizon_set,
                    extra_task_ids=extra_cols or None,
                    aggregate_locations=agg_locs,
                    compute_energy_score=True,
                    return_task_df=True,
                )

            for mid, sc in zip(list(sample_dfs.keys()), ordered_map(_score_s, list(sample_dfs.values()))):
                if sc and sc.get("overall"):
                    scores_by_model[mid] = sc

        primary_pool = any((sc.get("metadata") or {}).get("states_count", 0) > 0 for sc in scores_by_model.values())
        agg_list = sorted(agg_locs)
        pool_filter = (~pl.col("location").is_in(agg_list)) if primary_pool else pl.col("location").is_in(agg_list)

        crps_task_scores: Dict[str, pl.DataFrame] = {}
        es_task_scores: Dict[str, pl.DataFrame] = {}
        for mid, sc in scores_by_model.items():
            tdf = sc.get("task_df")
            if tdf is not None and not tdf.is_empty():
                ft = tdf.filter(pool_filter)
                if not ft.is_empty():
                    crps_task_scores[mid] = ft
            edf = sc.get("energy_df")
            if edf is not None and not edf.is_empty():
                fe = edf.filter(pool_filter)
                if not fe.is_empty():
                    es_task_scores[mid] = fe

        effective_baseline = baseline_id if (baseline_id and baseline_id in crps_task_scores) else None
        if not effective_baseline and crps_task_scores:
            effective_baseline = resolve_baseline(
                all_models,
                model_meta=baseline_meta,
                target=target,
                dates=dates_filter,
                season=season_hint,
                config_default=cfg_default,
                target_config_default=tgt_default,
                eligible_ids=set(crps_task_scores.keys()),
            ) or max(
                crps_task_scores.keys(),
                key=lambda m: (crps_task_scores[m].height, "ensemble" in m.lower(), m),
            )

        rel_crps = (
            compute_pairwise_relative_wis(
                crps_task_scores,
                effective_baseline,
                metric_col="crps",
                extra_task_ids=extra_cols,
            )
            if crps_task_scores
            else {}
        )
        rel_es = (
            compute_pairwise_relative_wis(
                es_task_scores,
                effective_baseline if effective_baseline in es_task_scores else next(iter(es_task_scores.keys()), None),
                metric_col="energy_score",
                extra_task_ids=extra_cols,
            )
            if es_task_scores
            else {}
        )

        # Include sample-capable models (or all scored models)
        candidate_ids = [
            mid for mid in requested_model_ids
            if mid in scores_by_model
            or all_models.get(mid, {}).get("has_samples")
            or "sample" in (all_models.get(mid, {}).get("output_types") or [])
        ]

        rankings: List[Dict[str, Any]] = []
        for mid in candidate_ids:
            m_stat = model_meta_stats.get(mid, {})
            sc = scores_by_model.get(mid)
            if sc is None or not sc.get("overall") or sc["overall"].get("count", 0) == 0:
                rankings.append({
                    "model_id": mid,
                    "has_data_in_scope": False,
                    "crps": None,
                    "relative_crps": None,
                    "energy_score": None,
                    "relative_energy_score": None,
                    "count": 0,
                    "evaluated_dates_count": 0,
                    "locations_count": 0,
                    "scope_rounds_available": m_stat.get("available_scope_dates_count", 0),
                    "scope_rounds_total": total_scope_dates_count,
                    "by_horizon": {},
                })
                continue

            rc = rel_crps.get(mid, {}) if isinstance(rel_crps.get(mid), dict) else {}
            re = rel_es.get(mid, {}) if isinstance(rel_es.get(mid), dict) else {}
            ov = sc["overall"]
            meta = sc.get("metadata") or {}
            rankings.append({
                "model_id": mid,
                "has_data_in_scope": True,
                "crps": ov.get("crps"),
                "relative_crps": rc.get("relative_wis"),
                "energy_score": ov.get("energy_score"),
                "relative_energy_score": re.get("relative_wis"),
                "count": int(ov.get("count") or 0),
                "evaluated_dates_count": int(meta.get("dates_count") or 0),
                "locations_count": int(meta.get("locations_count") or 0),
                "scope_rounds_available": m_stat.get("available_scope_dates_count", 0),
                "scope_rounds_total": total_scope_dates_count,
                "by_horizon": sc.get("by_horizon", {}),
            })

        rankings.sort(
            key=lambda x: (
                not x["has_data_in_scope"],
                x["relative_crps"] is None,
                x["relative_crps"] if x["relative_crps"] is not None else float("inf"),
                x["crps"] if x["crps"] is not None else float("inf"),
                x["model_id"],
            )
        )

        payload = {
            "target": target,
            "location_filter": sc_res.loc_param,
            "date_filter": sc_res.date_param,
            "season_filter": sc_res.season_param,
            "selected_seasons": sc_res.selected_seasons,
            "scope_dates_count": total_scope_dates_count,
            "baseline_model": effective_baseline,
            "rankings": rankings,
        }
        with self._sample_eval_cache_lock:
            self._sample_eval_cache[cache_key] = payload
            self._sample_eval_cache.move_to_end(cache_key)
            while len(self._sample_eval_cache) > self._sample_eval_cache_size:
                self._sample_eval_cache.popitem(last=False)
        return payload
