"""
Unified evaluation and scoring engine for the Sandbox suite.
Serves as the single source of truth for both the headless CLI (score_cli.py)
and the interactive web dashboard (server.py).
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
import hashlib
import logging
from pathlib import Path
import threading
from typing import Dict, List, Optional, Any, Set, Tuple

import polars as pl

from viz.peaks import is_peak_target
from viz.config import VizConfig
from viz.data_loader import SandboxDataLoader, date_to_season_and_week
from viz.metrics import score_forecasts, find_common_tasks, compute_pairwise_relative_wis

logger = logging.getLogger("viz.evaluation")


@dataclass
class EvaluationParams:
    """Parameters specifying the target, location, time scope, and models for evaluation."""
    target: Optional[str] = None
    location: str = "all"
    date: str = "all"
    season: str = ""
    models: Optional[List[str]] = None
    baseline: Optional[str] = None
    fair: bool = False
    # Optional evaluation window within the selected seasons, applied to the forecast (target) week:
    # weeks = "start-end" in season weeks (1 = MMWR week 31, early August); phase = pre | peak | post
    weeks: Optional[str] = None
    phase: Optional[str] = None


PHASES = ("pre", "peak", "post")


def parse_week_range(weeks: Optional[str]) -> Optional[Tuple[int, int]]:
    """Parse 'a-b' (season weeks, inclusive) into a clamped tuple; None or 'all' means the whole season."""
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
    """Keeps only tasks whose forecast (target) week falls inside a season-week range and/or a phase.

    Phases are assigned per location from that location's own truth curve, so with 'All States' each
    state is scored on its own peak weeks rather than the national peak.
    """

    def __init__(self, week_range: Optional[Tuple[int, int]], phase: Optional[str],
                 phase_pairs: Optional[pl.DataFrame], peak_fraction: Optional[float] = None):
        self.week_range = week_range
        self.phase = phase
        self.pairs = phase_pairs
        self.peak_fraction = peak_fraction
        self._allowed_dates = set(phase_pairs.get_column("target_end_date").to_list()) if phase_pairs is not None else None
        self._weeks: Dict[str, int] = {}

    def _season_week(self, d: str) -> int:
        if d not in self._weeks:
            self._weeks[d] = date_to_season_and_week(d)[1]
        return self._weeks[d]

    def target_in_window(self, d: str) -> bool:
        if self.week_range and not (self.week_range[0] <= self._season_week(d) <= self.week_range[1]):
            return False
        return self._allowed_dates is None or d in self._allowed_dates

    def round_in_window(self, reference_date: str) -> bool:
        """A round is in scope if any of its forecast weeks (horizons -1..3) is in the window."""
        try:
            ref = datetime.strptime(reference_date, "%Y-%m-%d")
        except ValueError:
            return True
        return any(self.target_in_window((ref + timedelta(weeks=h)).strftime("%Y-%m-%d")) for h in range(-1, 4))

    def apply(self, df: pl.DataFrame) -> pl.DataFrame:
        if df is None or df.is_empty():
            return df
        if "target_end_date" not in df.columns:
            df = df.with_columns(
                (pl.col("reference_date").cast(pl.String).str.to_date() + pl.duration(weeks=pl.col("horizon")))
                .dt.strftime("%Y-%m-%d").alias("target_end_date")
            )
        df = df.with_columns(pl.col("target_end_date").cast(pl.String).str.slice(0, 10), pl.col("location").cast(pl.String))
        if self.week_range:
            keep = [d for d in df.get_column("target_end_date").unique().to_list()
                    if d and self.week_range[0] <= self._season_week(d) <= self.week_range[1]]
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
    # Resolved scope, reused by task-level exports so they match the leaderboard exactly
    locations_filter: Optional[List[str]] = field(default=None, repr=False)
    common_task_set: Optional[Set[Tuple[str, str, int]]] = field(default=None, repr=False)
    window_filter: Optional[Any] = field(default=None, repr=False)

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
            "rankings": self.rankings,
            "validation_warnings": self.validation_warnings,
            "window": self.window,
        }


class EvaluationEngine:
    """
    Decoupled evaluation orchestrator.
    Handles data extraction, temporal scoping, task intersection, and comparative scoring.
    Thread-safe with an in-memory cache for instant responses to repeated queries.
    """

    def __init__(self, base_dir: Path, data_loader: Optional[SandboxDataLoader] = None):
        self.base_dir = Path(base_dir).resolve()
        self.loader = data_loader or SandboxDataLoader(self.base_dir)
        self.config = VizConfig(self.base_dir)
        self._eval_cache: Dict[str, EvaluationResult] = {}
        self._eval_cache_lock = threading.Lock()

    def _compute_cache_key(self, params: EvaluationParams) -> str:
        """Compute SHA256 cache key based on evaluation parameters and file mtimes."""
        oracle_pq = self.loader.cache_mgr.get_oracle_parquet()
        oracle_mtime = oracle_pq.stat().st_mtime if oracle_pq and oracle_pq.exists() else 0.0

        models = params.models or []
        if not models or "all" in [m.lower() for m in models]:
            models = list(self.loader.scan_models().keys())
        mtimes = []
        for mid in sorted(models):
            if hasattr(self.loader, "ensemble_mgr") and self.loader.ensemble_mgr.get_config(mid):
                cfg = self.loader.ensemble_mgr.get_config(mid)
                mtimes.append(f"{mid}:synth:{cfg.method}:{cfg.spatial_split}:{cfg.missing_policy}:{cfg.models}:{cfg.state_models}:{cfg.national_models}:{cfg.created_at}")
            else:
                raw_id, is_local = self.loader._resolve_model_id_and_local(mid)
                pq = self.loader.cache_mgr.get_model_parquet(raw_id, is_local=is_local)
                mtimes.append(f"{mid}:{pq.stat().st_mtime if pq and pq.exists() else 0.0}")

        raw = (
            f"{params.target}|{params.location}|{params.date}|{params.season}|{params.weeks}|{params.phase}|"
            f"{sorted(models)}|{params.baseline}|{params.fair}|{oracle_mtime}|{mtimes}"
        )
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _build_window_filter(self, target: str, weeks: Optional[str], phase: Optional[str]) -> Optional[WindowFilter]:
        week_range = parse_week_range(weeks)
        ph = parse_phase(phase)
        if week_range is None and ph is None:
            return None
        pairs = None
        if ph is not None:
            table = self.loader.get_truth_phases(target)
            pairs = table.filter(pl.col("phase") == ph).select(["location", "target_end_date"])
        return WindowFilter(week_range, ph, pairs, getattr(self.loader, "PEAK_FRACTION", None))

    @staticmethod
    def _weekly_wins(task_scores: Dict[str, pl.DataFrame]) -> Dict[str, Dict[str, int]]:
        """
        For each round, the model with the lowest mean WIS on the tasks every competing model forecast
        that week wins it (ties all win). Returns {model: {won, won_log, competed}}.
        """
        keys = ["reference_date", "location", "horizon"]
        frames = []
        for mid, df in task_scores.items():
            if df is None or df.is_empty() or "wis" not in df.columns or not all(k in df.columns for k in keys):
                continue
            cols = keys + [c for c in ("wis", "wis_log") if c in df.columns]
            frames.append(df.select(cols).with_columns(pl.lit(mid).alias("model")))
        if len(frames) < 2:
            return {}
        long = pl.concat(frames, how="diagonal_relaxed").drop_nulls("wis")
        n_week = long.group_by("reference_date").agg(pl.col("model").n_unique().alias("n"))
        shared = (
            long.group_by(keys).agg(pl.col("model").n_unique().alias("k"))
            .join(n_week, on="reference_date")
            .filter((pl.col("k") == pl.col("n")) & (pl.col("n") >= 2))
            .select(keys)
        )
        sub = long.join(shared, on=keys, how="semi")
        out: Dict[str, Dict[str, int]] = {}
        for metric, label in (("wis", "won"), ("wis_log", "won_log")):
            if metric not in sub.columns:
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

    def evaluate(self, params: EvaluationParams, force_refresh: bool = False) -> EvaluationResult:
        """Execute evaluation across requested models according to the given parameters."""
        cache_key = self._compute_cache_key(params)
        with self._eval_cache_lock:
            if not force_refresh and cache_key in self._eval_cache:
                return self._eval_cache[cache_key]

        target = params.target or self.config.get_default_target()
        if is_peak_target(target):
            raise ValueError(
                f"'{target}' is a season peak target: it has no weekly horizons, so it is scored in the dashboard's "
                "Season Peak view rather than on the weekly leaderboard"
            )
        loc_param = params.location or "all"
        date_param = params.date or "all"
        season_param = (params.season or "").strip()
        fair_flag = bool(params.fair)

        # 1. Oracle ground truth
        oracle = self.loader.get_oracle(as_polars=True)
        if oracle is None or oracle.is_empty():
            raise ValueError("No oracle ground truth data found.")

        # 2. Location filtering
        locations_filter: Optional[List[str]] = None
        if loc_param == "states":
            locations_filter = [
                loc["id"] for loc in self.loader.get_locations().values() if loc["id"] != "US"
            ]
        elif loc_param == "US":
            locations_filter = ["US"]
        elif loc_param != "all" and loc_param:
            locations_filter = [loc_param]

        # 3. Temporal scope resolution
        forecast_seasons = self.loader.get_forecast_seasons()
        all_avail_seasons = self.loader.get_all_seasons()
        default_latest_season = (
            forecast_seasons[-1]
            if forecast_seasons
            else (all_avail_seasons[-1] if all_avail_seasons else f"{datetime.now().year - 1}-{datetime.now().year}")
        )

        scope_type = "date"
        selected_seasons: List[str] = []
        dates_filter: Optional[List[str]] = None

        if season_param:
            if season_param.lower() == "current":
                scope_type = "season"
                focal_season = (
                    self.loader.get_flu_season_for_date(date_param)
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
                selected_seasons = [self.loader.get_flu_season_for_date(date_param)]
                dates_filter = [date_param]
            else:
                scope_type = "all"
                selected_seasons = forecast_seasons or all_avail_seasons
                dates_filter = self.loader.get_dates_for_season("all")

        # 3b. Optional window within the season(s): week range and/or phase of the forecast (target) week
        window_filter = self._build_window_filter(target, params.weeks, params.phase)
        if window_filter is not None and dates_filter:
            dates_filter = [d for d in dates_filter if window_filter.round_in_window(d)]

        # 4. Model selection & discovery
        all_models = self.loader.scan_models()
        if not params.models:
            requested_model_ids = list(all_models.keys())
        else:
            requested_model_ids = [m.strip() for m in params.models if m.strip()]
            if "all" in [m.lower() for m in requested_model_ids]:
                requested_model_ids = list(all_models.keys())

        # Determine baseline model dynamically (returns None if no genuine baseline exists)
        baseline_id = params.baseline.strip() if params.baseline else None
        if not baseline_id or baseline_id not in all_models:
            baseline_id = self.config.get_default_baseline(list(all_models.keys()))

        # If baseline is valid and not in requested models, load it in background for pairwise comparisons
        models_to_load = list(requested_model_ids)
        if baseline_id and baseline_id not in models_to_load and baseline_id in all_models:
            models_to_load.append(baseline_id)

        # 5. Load forecasts in scope
        model_dfs: Dict[str, pl.DataFrame] = {}
        model_meta_stats: Dict[str, Dict[str, Any]] = {}
        total_scope_dates_count = len(dates_filter) if dates_filter else 0

        for mid in models_to_load:
            if mid not in all_models:
                continue
            available_dates = all_models[mid].get("dates", [])
            model_active_seasons = sorted(
                list({self.loader.get_flu_season_for_date(d) for d in available_dates})
            )
            eval_dates = (
                [d for d in dates_filter if d in available_dates]
                if dates_filter
                else available_dates
            )

            model_meta_stats[mid] = {
                "available_scope_dates": eval_dates,
                "available_scope_dates_count": len(eval_dates),
                "total_scope_dates_count": total_scope_dates_count,
                "active_seasons": model_active_seasons,
                "has_scope_data": len(eval_dates) > 0,
            }

            if not eval_dates:
                continue

            m_df = self.loader.load_combined_forecasts(mid, eval_dates, as_polars=True)
            if m_df is not None and window_filter is not None:
                m_df = window_filter.apply(m_df)
            if m_df is not None and not m_df.is_empty():
                model_dfs[mid] = m_df

        # 5b. With a window, report the rounds that actually have forecast weeks inside it at these locations
        if window_filter is not None:
            remaining: Set[str] = set()
            for mid, df in model_dfs.items():
                scoped = df.filter(pl.col("location").cast(pl.String).is_in(locations_filter)) if locations_filter else df
                ds = sorted({str(d) for d in scoped.get_column("reference_date").unique().to_list()})
                if mid in model_meta_stats:
                    model_meta_stats[mid]["available_scope_dates"] = ds
                    model_meta_stats[mid]["available_scope_dates_count"] = len(ds)
                if mid in requested_model_ids:
                    remaining.update(ds)
            for mid, stat in model_meta_stats.items():
                if mid not in model_dfs:
                    stat["available_scope_dates"] = []
                    stat["available_scope_dates_count"] = 0
            total_scope_dates_count = len(remaining)
            dates_filter = sorted(remaining)
            for stat in model_meta_stats.values():
                stat["total_scope_dates_count"] = total_scope_dates_count

        # 6. Fair common task intersection
        common_task_set: Optional[Set[Tuple[str, str, int]]] = None
        common_task_status = "none"
        common_task_message: Optional[str] = None

        eval_model_dfs = {m: model_dfs[m] for m in requested_model_ids if m in model_dfs}

        if fair_flag and len(eval_model_dfs) > 1:
            common_task_set = find_common_tasks(
                eval_model_dfs,
                target=target,
                locations=locations_filter,
                reference_dates=dates_filter,
            )
            if not common_task_set:
                common_task_status = "empty_disjoint"
                disjoint_examples = []
                for mid in list(eval_model_dfs.keys())[:3]:
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
                    f"Evaluated strictly on {len(common_task_set):,} shared tasks across all {len(eval_model_dfs)} models."
                )
        elif fair_flag and len(eval_model_dfs) <= 1:
            common_task_status = "single_model"
            common_task_message = "Common tasks requires at least two models to compute an intersection."

        # 7. Score models that have data in scope
        scores_by_model: Dict[str, Dict[str, Any]] = {}
        target_non_neg = self.config.is_target_non_negative(target)
        pop_map = self._population_map(target)

        if common_task_status != "empty_disjoint":
            for mid, df in model_dfs.items():
                sc = score_forecasts(
                    df,
                    oracle,
                    target=target,
                    locations=locations_filter,
                    reference_dates=dates_filter,
                    common_tasks=common_task_set,
                    non_negative=target_non_neg,
                    population_map=pop_map,
                    return_task_df=True,
                )
                if sc:
                    scores_by_model[mid] = sc

        # Compute Hubverse/FluSight pairwise tournament relative WIS (Cramer et al. 2022) on the same
        # location pool as the WIS column: states only whenever any state is scored, else national
        states_pool = any(sc["metadata"]["has_states_data"] for sc in scores_by_model.values())
        pool_filter = (pl.col("location") != "US") if states_pool else (pl.col("location") == "US")
        task_scores_by_model = {
            mid: sc["task_df"].filter(pool_filter)
            for mid, sc in scores_by_model.items()
            if "task_df" in sc and sc["task_df"] is not None
        }

        # Resolve effective baseline for tournament scaling
        validation_warnings: List[str] = []
        effective_baseline = baseline_id if (baseline_id and baseline_id in task_scores_by_model) else None
        if not effective_baseline and task_scores_by_model:
            for candidate in task_scores_by_model:
                if "baseline" in candidate.lower():
                    effective_baseline = candidate
                    break
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
            {m: df for m, df in task_scores_by_model.items() if m in requested_model_ids}
        )

        pairwise_tournament_rel_wis: Dict[str, Any] = {}
        pairwise_tournament_rel_wis_log: Dict[str, Any] = {}
        if task_scores_by_model:
            pairwise_tournament_rel_wis = compute_pairwise_relative_wis(task_scores_by_model, effective_baseline, metric_col="wis")
            pairwise_tournament_rel_wis_log = compute_pairwise_relative_wis(task_scores_by_model, effective_baseline, metric_col="wis_log")

        # 8. Compute relative delta % vs baseline (strictly on identical task subsets)
        comparisons: List[Dict[str, Any]] = []
        baseline_wis_cache: Dict[Tuple[str, Any], Optional[float]] = {}
        baseline_wis_log_cache: Dict[Tuple[str, Any], Optional[float]] = {}
        ref_baseline_id = effective_baseline

        for mid in requested_model_ids:
            if mid not in all_models:
                continue

            m_stat = model_meta_stats.get(mid, {})
            has_data = m_stat.get("has_scope_data", False)
            sc = scores_by_model.get(mid)
            is_local = all_models[mid].get("is_local", False)

            # Forecasts for this target and location exist in scope, but none of their target weeks has
            # been observed yet (a live round); distinct from a model that never forecast this location
            pending_truth = False
            no_location = False
            if has_data and sc is None and common_task_status != "empty_disjoint":
                m_df = model_dfs.get(mid)
                in_scope = m_df is not None and not m_df.is_empty()
                if in_scope:
                    m_df = m_df.filter(pl.col("target") == target) if "target" in m_df.columns else m_df
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
                    where = "these locations" if locations_filter and len(locations_filter) > 1 else (loc_param if loc_param not in ("all", "states") else "this scope")
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
                    "by_horizon": {},
                })
                continue

            wis = sc["overall"].get("wis")
            wis_log = sc["overall"].get("wis_log")
            mae_log = sc["overall"].get("mae_log")
            pct_diff = None
            pct_diff_log = None

            # Pairwise relative WIS vs baseline (evaluated on STRICTLY IDENTICAL task subsets)
            if ref_baseline_id:
                if mid == ref_baseline_id:
                    pct_diff = 0.0
                    pct_diff_log = 0.0
                elif wis is not None:
                    if fair_flag and ref_baseline_id in scores_by_model:
                        # In fair mode, all models and baseline were evaluated on the mutual common_task_set
                        base_wis_shared = scores_by_model[ref_baseline_id]["overall"].get("wis")
                        if base_wis_shared and base_wis_shared > 0:
                            pct_diff = ((wis - base_wis_shared) / base_wis_shared) * 100.0
                        base_wis_shared_log = scores_by_model[ref_baseline_id]["overall"].get("wis_log")
                        if base_wis_shared_log and base_wis_shared_log > 0 and wis_log is not None:
                            pct_diff_log = ((wis_log - base_wis_shared_log) / base_wis_shared_log) * 100.0
                    else:
                        # Unconstrained mode: evaluate BOTH mid and baseline strictly on their pairwise shared tasks
                        shared_with_baseline = find_common_tasks(
                            {mid: model_dfs[mid], ref_baseline_id: model_dfs[ref_baseline_id]},
                            target=target,
                            locations=locations_filter,
                            reference_dates=dates_filter,
                        )
                        if shared_with_baseline:
                            shared_task_key = frozenset(shared_with_baseline)

                            # Evaluate baseline on shared tasks
                            if (ref_baseline_id, shared_task_key) in baseline_wis_cache:
                                base_wis_shared = baseline_wis_cache[(ref_baseline_id, shared_task_key)]
                                base_wis_shared_log = baseline_wis_log_cache.get((ref_baseline_id, shared_task_key))
                            else:
                                base_sc = score_forecasts(
                                    model_dfs[ref_baseline_id],
                                    oracle,
                                    target=target,
                                    common_tasks=shared_with_baseline,
                                    non_negative=target_non_neg,
                                )
                                base_wis_shared = base_sc.get("overall", {}).get("wis") if base_sc else None
                                base_wis_shared_log = base_sc.get("overall", {}).get("wis_log") if base_sc else None
                                baseline_wis_cache[(ref_baseline_id, shared_task_key)] = base_wis_shared
                                baseline_wis_log_cache[(ref_baseline_id, shared_task_key)] = base_wis_shared_log

                            # Evaluate THIS model strictly on the same shared tasks
                            if (mid, shared_task_key) in baseline_wis_cache:
                                model_wis_shared = baseline_wis_cache[(mid, shared_task_key)]
                                model_wis_shared_log = baseline_wis_log_cache.get((mid, shared_task_key))
                            else:
                                mid_sc = score_forecasts(
                                    model_dfs[mid],
                                    oracle,
                                    target=target,
                                    common_tasks=shared_with_baseline,
                                    non_negative=target_non_neg,
                                )
                                model_wis_shared = mid_sc.get("overall", {}).get("wis") if mid_sc else None
                                model_wis_shared_log = mid_sc.get("overall", {}).get("wis_log") if mid_sc else None
                                baseline_wis_cache[(mid, shared_task_key)] = model_wis_shared
                                baseline_wis_log_cache[(mid, shared_task_key)] = model_wis_shared_log

                            if model_wis_shared is not None and base_wis_shared and base_wis_shared > 0:
                                pct_diff = ((model_wis_shared - base_wis_shared) / base_wis_shared) * 100.0
                            if model_wis_shared_log is not None and base_wis_shared_log and base_wis_shared_log > 0:
                                pct_diff_log = ((model_wis_shared_log - base_wis_shared_log) / base_wis_shared_log) * 100.0

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
                "relative_wis": pairwise_tournament_rel_wis.get(mid, {}).get("relative_wis") if isinstance(pairwise_tournament_rel_wis.get(mid), dict) else pairwise_tournament_rel_wis.get(mid),
                "relative_wis_log": pairwise_tournament_rel_wis_log.get(mid, {}).get("relative_wis") if isinstance(pairwise_tournament_rel_wis_log.get(mid), dict) else pairwise_tournament_rel_wis_log.get(mid),
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
                "states_wis": sc.get("states", {}).get("wis") if sc.get("states") else None,
                "us_wis": sc.get("us", {}).get("wis") if sc.get("us") else None,
                "by_horizon": sc.get("by_horizon", {}),
            })

        # Sort: active models by tournament relative WIS (comparable across unequal task sets), then raw WIS
        comparisons.sort(
            key=lambda x: (
                not x["has_data_in_scope"],
                x["relative_wis"] is None,
                x["relative_wis"] if x["relative_wis"] is not None else float("inf"),
                x["wis"] if x["wis"] is not None else float("inf"),
            )
        )

        # 9. Collect validation warnings across loaded models and evaluation
        validation_warnings += self.loader.get_validation_warnings(requested_model_ids)
        for comp in comparisons:
            if comp["has_data_in_scope"] and comp["quantile_count"] < 7:
                validation_warnings.append(
                    f"Model '{comp['model_id']}' has only {comp['quantile_count']} quantiles (standard is 7 or 23)."
                )

        validation_warnings = sorted(list(set(validation_warnings)))

        result = EvaluationResult(
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
        )

        with self._eval_cache_lock:
            # Maintain cache size within bounds
            if len(self._eval_cache) > 64:
                self._eval_cache.clear()
            self._eval_cache[cache_key] = result

        return result

    def _population_map(self, target: str) -> Optional[Dict[str, int]]:
        """Location populations for per-100k WIS; None for targets that are already rates or proportions."""
        if self.config.get_target_metadata(target)["is_rate"]:
            return None
        return {loc: info["population"] for loc, info in self.loader.get_locations().items() if info.get("population")}

    def get_task_scores_dataframe(self, params: EvaluationParams) -> Optional[pl.DataFrame]:
        """
        Return task-level scores (location x date x horizon x model scores) as a unified DataFrame.
        Uses the exact scope of the matching leaderboard (locations, dates, common tasks).
        Enables researchers to export disaggregated scores for further statistical analysis or R integration.
        """
        target = params.target or self.config.get_default_target()
        oracle = self.loader.get_oracle(as_polars=True)
        if oracle is None or oracle.is_empty():
            return None

        # Execute evaluation to resolve scope and common tasks
        result = self.evaluate(params)
        active_mids = [r["model_id"] for r in result.rankings if r.get("has_data_in_scope")]
        if not active_mids:
            return None

        pop_map = self._population_map(target)
        target_non_neg = self.config.is_target_non_negative(target)

        dfs = []
        for mid in active_mids:
            df = self.loader.load_combined_forecasts(mid, result.scope_dates, as_polars=True)
            if df is not None and result.window_filter is not None:
                df = result.window_filter.apply(df)
            if df is None or df.is_empty():
                continue
            sc = score_forecasts(
                df,
                oracle,
                target=target,
                locations=result.locations_filter,
                reference_dates=result.scope_dates,
                common_tasks=result.common_task_set,
                non_negative=target_non_neg,
                population_map=pop_map,
                return_task_df=True,
            )
            if sc and "task_df" in sc and sc["task_df"] is not None:
                t_df = sc["task_df"].with_columns(pl.lit(mid).alias("model_id"))
                dfs.append(t_df)

        if not dfs:
            return None
        return pl.concat(dfs, how="diagonal")
