"""
High-performance forecast evaluation and scoring engine for Viz.
Built on Polars and NumPy for vectorized execution across quantile, PMF, and sample trajectories.

Implements Hubverse & FluSight evaluation methodology (Bracher et al. 2021, Cramer et al. 2022):
- Weighted Interval Score (WIS) via pinball loss decomposition
- Pairwise Tournament Relative WIS (Cramer et al. 2022)
- Population-standardized Rate WIS (per 100,000 population)
- Categorical/Ordinal PMF Ranked Probability Score (RPS), Log Score, and Brier Score
- Exact vectorized O(M log M) CRPS and multi-horizon Energy Score for sample trajectories
- Generalized aggregate vs primary location pooling and extra Hubverse task-ID dimensions (e.g. age_group)
"""

from __future__ import annotations

import math
import threading
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple, Union

import numpy as np
import polars as pl

from viz.core.parallel import ordered_map_outcomes

STANDARD_7_QUANTILES = [0.025, 0.10, 0.25, 0.50, 0.75, 0.90, 0.975]
STANDARD_23_QUANTILES = [
    0.01, 0.025, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30,
    0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70,
    0.75, 0.80, 0.85, 0.90, 0.95, 0.975, 0.99,
]
TASK_KEY_COLS = ["reference_date", "location", "horizon"]
LOG_SCORE_FLOOR = 1e-9

_NON_TASK_COLS = frozenset({
    "reference_date",
    "origin_date",
    "target",
    "horizon",
    "location",
    "target_end_date",
    "output_type",
    "output_type_id",
    "value",
    "oracle_value",
    "as_of",
    "model_id",
    "component_model_id",
    "year_week",
    "data_source",
    "observation",
    "date",
    "truth_date",
    "population",
    "location_name",
    "abbreviation",
})


def find_quantile_column(columns: List[str], q_val: float) -> Optional[str]:
    """Resolve quantile column names across floating-point formatting variants."""
    candidates = [str(q_val), f"{q_val:.3f}", f"{q_val:.2f}", f"{q_val:.1f}"]
    for c in candidates:
        if c in columns:
            return c
    for c in columns:
        try:
            if abs(float(c) - q_val) < 1e-4:
                return c
        except (ValueError, TypeError):
            pass
    return None


def compute_pinball_loss(
    y: Union[pl.Expr, float, np.ndarray],
    q: Union[pl.Expr, float, np.ndarray],
    alpha: Union[pl.Expr, float, np.ndarray],
) -> Union[pl.Expr, float, np.ndarray]:
    """Compute pinball loss: 2 * (I(y < q) - alpha) * (q - y)."""
    if isinstance(y, pl.Expr) or isinstance(q, pl.Expr) or isinstance(alpha, pl.Expr):
        y_expr = y if isinstance(y, pl.Expr) else pl.lit(y)
        q_expr = q if isinstance(q, pl.Expr) else pl.lit(q)
        a_expr = alpha if isinstance(alpha, pl.Expr) else pl.lit(alpha)
        return 2.0 * ((y_expr < q_expr).cast(pl.Float64) - a_expr) * (q_expr - y_expr)
    return 2.0 * (((y < q).astype(float) if hasattr(y < q, "astype") else float(y < q)) - alpha) * (q - y)


def _to_polars_df(data: Any) -> Optional[pl.DataFrame]:
    if data is None:
        return None
    if isinstance(data, pl.DataFrame):
        return data
    if isinstance(data, pl.LazyFrame):
        return data.collect()
    if hasattr(data, "to_dict") and hasattr(data, "columns"):
        try:
            return pl.from_pandas(data)
        except Exception:
            return None
    return None


def _resolve_extra_task_ids(
    f_cols: Sequence[str],
    o_cols: Optional[Sequence[str]] = None,
    explicit: Optional[Sequence[str]] = None,
) -> List[str]:
    """Identify extra stratification columns (e.g. `age_group`) shared between forecasts and truth."""
    f_set = set(f_cols)
    if explicit is not None:
        if o_cols is None:
            return sorted(str(c) for c in explicit if c in f_set)
        o_set = set(o_cols)
        return sorted(str(c) for c in explicit if c in f_set and c in o_set)
    if o_cols is None:
        return []
    o_set = set(o_cols)
    return sorted(c for c in f_set if c not in _NON_TASK_COLS and c in o_set)


def _prepare_oracle(
    o: pl.DataFrame,
    target: str,
    extra_task_ids: Optional[Sequence[str]] = None,
) -> Tuple[pl.DataFrame, List[str]]:
    """Truth rows for one target, one value per join key, plus the keys to join forecasts on."""
    if "target" in o.columns:
        o = o.filter(pl.col("target") == target)

    extra_cols = [str(c) for c in (extra_task_ids or ()) if c in o.columns]
    cast_oracle = [
        pl.col("location").cast(pl.String),
        pl.col("target_end_date").cast(pl.String),
        pl.col("oracle_value").cast(pl.Float64),
    ]
    if "horizon" in o.columns:
        cast_oracle.append(pl.col("horizon").cast(pl.Int32))
    for ec in extra_cols:
        cast_oracle.append(pl.col(ec).cast(pl.String))

    o = o.with_columns([c for c in cast_oracle if c.meta.output_name() in o.columns])

    base_keys = ["target_end_date", "location"] + extra_cols
    has_meaningful_horizon = False
    if "horizon" in o.columns:
        valid_h = o.filter(pl.col("horizon").is_not_null())
        if valid_h.height > 0:
            n_loc_date = valid_h.select(base_keys).n_unique()
            n_loc_date_h = valid_h.select(base_keys + ["horizon"]).n_unique()
            if n_loc_date_h > n_loc_date:
                n_with_vals = valid_h.select(base_keys + ["oracle_value"]).n_unique()
                if n_with_vals > n_loc_date:
                    has_meaningful_horizon = True

    join_keys = base_keys + (["horizon"] if has_meaningful_horizon else [])
    if "as_of" in o.columns:
        o = o.sort("as_of").group_by(join_keys).last()
    o = o.select(join_keys + ["oracle_value"]).drop_nulls().unique(subset=join_keys)
    return o, join_keys


_ORACLE_MEMO: Dict[Tuple[int, str, Tuple[str, ...]], Tuple[pl.DataFrame, pl.DataFrame, List[str]]] = {}
_ORACLE_MEMO_LOCK = threading.Lock()
_ORACLE_MEMO_MAX = 16


def _prepared_oracle(
    o: pl.DataFrame,
    target: str,
    extra_task_ids: Optional[Sequence[str]] = None,
) -> Tuple[pl.DataFrame, List[str]]:
    extra_key = tuple(sorted(str(c) for c in (extra_task_ids or ()) if c in o.columns))
    key = (id(o), target, extra_key)
    with _ORACLE_MEMO_LOCK:
        hit = _ORACLE_MEMO.get(key)
    if hit is not None and hit[0] is o:
        return hit[1], list(hit[2])
    prepared, join_keys = _prepare_oracle(o, target, extra_task_ids=extra_key)
    with _ORACLE_MEMO_LOCK:
        if len(_ORACLE_MEMO) >= _ORACLE_MEMO_MAX:
            _ORACLE_MEMO.clear()
        _ORACLE_MEMO[key] = (o, prepared, list(join_keys))
    return prepared, join_keys


def summarize_scored_tasks(
    eval_df: pl.DataFrame,
    *,
    present_quantiles: Optional[List[float]] = None,
    sym_pairs: Optional[List[Tuple[float, str, str]]] = None,
    population_map: Optional[Dict[str, int]] = None,
    aggregate_locations: Optional[Iterable[str]] = None,
    negative_values_clipped: int = 0,
    extra_task_ids: Optional[Sequence[str]] = None,
    include_task_df: bool = False,
) -> Dict[str, Any]:
    """
    Aggregate per-task scores (`eval_df`) into summary metrics (`overall`, `states`/`primary`,
    `us`/`aggregates`, `by_horizon`, `metadata`). Shared between `score_forecasts` and `PreScoreStore`.
    """
    if eval_df.is_empty():
        return {}

    df = eval_df
    if population_map:
        pop_df = pl.DataFrame({
            "location": [str(k) for k in population_map.keys()],
            "population": [int(v) for v in population_map.values()],
        })
        if "population" in df.columns:
            df = df.drop("population")
        if "wis_per_100k" in df.columns:
            df = df.drop("wis_per_100k")
        df = df.join(pop_df, on="location", how="left")
        df = df.with_columns(
            pl.when((pl.col("population").is_not_null()) & (pl.col("population") > 0))
            .then((pl.col("wis") / pl.col("population")) * 100000.0)
            .otherwise(None)
            .alias("wis_per_100k")
        )
    elif "wis_per_100k" not in df.columns:
        df = df.with_columns(pl.lit(None, dtype=pl.Float64).alias("wis_per_100k"))

    agg_set = {str(x) for x in aggregate_locations} if aggregate_locations is not None else {"US"}
    agg_list = sorted(agg_set)
    is_agg_expr = pl.col("location").is_in(agg_list) if agg_list else pl.lit(False)
    has_primary = bool(df.select((~is_agg_expr).any()).item())
    has_agg = bool(df.select(is_agg_expr.any()).item())
    primary_eval = df.filter(~is_agg_expr) if has_primary else df.filter(is_agg_expr)

    # Infer calibration levels from sym_pairs or cov_<pct> columns present on the task DataFrame
    if sym_pairs is not None:
        calib_specs = [
            (round(1.0 - 2.0 * q_low, 3), f"cov_{int(round((1.0 - 2.0 * q_low) * 100))}")
            for q_low, _, _ in sym_pairs
        ]
    else:
        calib_specs = []
        for col in df.columns:
            if col.startswith("cov_") and col[4:].isdigit():
                pct = int(col[4:])
                if 1 <= pct <= 99:
                    calib_specs.append((round(pct / 100.0, 3), col))
        calib_specs.sort(key=lambda item: item[0], reverse=True)

    def _summarize_df(df_slice: pl.DataFrame) -> Dict[str, Any]:
        if df_slice.is_empty():
            return {
                "wis": None,
                "wis_log": None,
                "wis_7": None,
                "wis_per_100k": None,
                "mae": None,
                "mae_log": None,
                "cov95": None,
                "cov50": None,
                "sharpness": None,
                "sharpness_component": None,
                "overprediction_penalty": None,
                "underprediction_penalty": None,
                "calibration": {},
                "count": 0,
            }

        agg_exprs = [
            pl.col("wis").mean().alias("wis"),
            pl.col("wis_log").mean().alias("wis_log") if "wis_log" in df_slice.columns else pl.lit(None, dtype=pl.Float64).alias("wis_log"),
            pl.col("wis_7").mean().alias("wis_7") if "wis_7" in df_slice.columns else pl.lit(None, dtype=pl.Float64).alias("wis_7"),
            pl.col("wis_per_100k").mean().alias("wis_per_100k"),
            pl.col("mae").mean().alias("mae") if "mae" in df_slice.columns else pl.lit(None, dtype=pl.Float64).alias("mae"),
            pl.col("mae_log").mean().alias("mae_log") if "mae_log" in df_slice.columns else pl.lit(None, dtype=pl.Float64).alias("mae_log"),
            pl.col("cov95").mean().alias("cov95") if "cov95" in df_slice.columns else pl.lit(None, dtype=pl.Float64).alias("cov95"),
            pl.col("cov50").mean().alias("cov50") if "cov50" in df_slice.columns else pl.lit(None, dtype=pl.Float64).alias("cov50"),
            pl.col("sharpness").mean().alias("sharpness") if "sharpness" in df_slice.columns else pl.lit(None, dtype=pl.Float64).alias("sharpness"),
            pl.col("decomp_sharpness").mean().alias("decomp_sharpness") if "decomp_sharpness" in df_slice.columns else pl.lit(None, dtype=pl.Float64).alias("decomp_sharpness"),
            pl.col("decomp_overpred").mean().alias("decomp_overpred") if "decomp_overpred" in df_slice.columns else pl.lit(None, dtype=pl.Float64).alias("decomp_overpred"),
            pl.col("decomp_underpred").mean().alias("decomp_underpred") if "decomp_underpred" in df_slice.columns else pl.lit(None, dtype=pl.Float64).alias("decomp_underpred"),
            pl.len().alias("count"),
        ]
        for _, col_name in calib_specs:
            if col_name in df_slice.columns:
                agg_exprs.append(pl.col(col_name).mean().alias(col_name))

        res_row = df_slice.select(agg_exprs).to_dicts()[0]

        def _f(v: Any) -> Optional[float]:
            return float(v) if v is not None and not np.isnan(v) else None

        cov95_raw = _f(res_row.get("cov95"))
        cov50_raw = _f(res_row.get("cov50"))
        calib_dict = {}
        for nom_level, col_name in calib_specs:
            val = _f(res_row.get(col_name))
            if val is not None:
                calib_dict[float(nom_level)] = round(val * 100.0, 1)

        return {
            "wis": _f(res_row.get("wis")),
            "wis_log": _f(res_row.get("wis_log")),
            "wis_7": _f(res_row.get("wis_7")),
            "wis_per_100k": _f(res_row.get("wis_per_100k")),
            "mae": _f(res_row.get("mae")),
            "mae_log": _f(res_row.get("mae_log")),
            "cov95": cov95_raw * 100.0 if cov95_raw is not None else None,
            "cov50": cov50_raw * 100.0 if cov50_raw is not None else None,
            "sharpness": _f(res_row.get("sharpness")),
            "sharpness_component": _f(res_row.get("decomp_sharpness")),
            "overprediction_penalty": _f(res_row.get("decomp_overpred")),
            "underprediction_penalty": _f(res_row.get("decomp_underpred")),
            "calibration": calib_dict,
            "count": int(res_row["count"]),
        }

    q_list = list(present_quantiles or [])
    q_count = len(q_list)
    has_std_7 = set(STANDARD_7_QUANTILES).issubset(set(q_list)) if q_list else False
    has_std_23 = set(STANDARD_23_QUANTILES).issubset(set(q_list)) if q_list else False

    overall_summary = _summarize_df(primary_eval)
    overall_summary["quantile_count"] = q_count
    overall_summary["has_23_quantiles"] = has_std_23
    overall_summary["has_7_quantiles"] = has_std_7

    primary_summary = _summarize_df(df.filter(~is_agg_expr)) if has_primary else None
    agg_summary = _summarize_df(df.filter(is_agg_expr)) if has_agg else None

    by_horizon = {}
    for h in sorted(primary_eval.select(pl.col("horizon").unique()).to_series().to_list()):
        hdf = primary_eval.filter(pl.col("horizon") == h)
        by_horizon[int(h)] = _summarize_df(hdf)

    evaluated_dates = sorted(df.select(pl.col("reference_date").unique()).to_series().to_list())
    distinct_locs = sorted(df.select(pl.col("location").unique()).to_series().to_list())

    result_dict: Dict[str, Any] = {
        "overall": overall_summary,
        "states": primary_summary,
        "us": agg_summary,
        "primary": primary_summary,
        "aggregates": agg_summary,
        "by_horizon": by_horizon,
        "metadata": {
            "evaluated_dates": evaluated_dates,
            "dates_count": len(evaluated_dates),
            "locations_count": len(distinct_locs),
            "states_count": len([loc for loc in distinct_locs if loc not in agg_set]),
            "primary_count": len([loc for loc in distinct_locs if loc not in agg_set]),
            "total_tasks": len(df),
            "quantile_count": q_count,
            "present_quantiles": q_list,
            "is_state_benchmark": has_primary,
            "benchmark_pool": "states" if has_primary else "us",
            "aggregate_locations": agg_list,
            "extra_task_ids": list(extra_task_ids or ()),
            "has_us_data": has_agg,
            "has_states_data": has_primary,
            "negative_values_clipped": negative_values_clipped,
        },
    }
    if include_task_df:
        result_dict["task_df"] = df
    return result_dict


def score_forecasts(
    forecast_df: Union[pl.DataFrame, pl.LazyFrame, Any],
    oracle_df: Union[pl.DataFrame, pl.LazyFrame, Any],
    target: str = "wk inc flu hosp",
    locations: Optional[List[str]] = None,
    reference_dates: Optional[List[str]] = None,
    horizons: Optional[List[int]] = None,
    common_tasks: Optional[Union[Set[Tuple[Any, ...]], pl.DataFrame, List[Tuple[Any, ...]]]] = None,
    non_negative: Optional[bool] = None,
    population_map: Optional[Dict[str, int]] = None,
    return_task_df: bool = False,
    extra_task_ids: Optional[Sequence[str]] = None,
    aggregate_locations: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """Score quantile forecasts against oracle truth with Polars SIMD execution."""
    f = _to_polars_df(forecast_df)
    o = _to_polars_df(oracle_df)

    if f is None or o is None or f.is_empty() or o.is_empty():
        return {}

    extra_cols = _resolve_extra_task_ids(f.columns, o.columns, extra_task_ids)

    cast_exprs = [
        pl.col("location").cast(pl.String),
        pl.col("horizon").fill_null(0).cast(pl.Int32),
        pl.col("output_type_id").cast(pl.Float64).round(3),
        pl.col("value").cast(pl.Float64),
        pl.col("reference_date").cast(pl.String),
        pl.col("target_end_date").cast(pl.String),
        pl.col("target").cast(pl.String),
    ] + [pl.col(ec).cast(pl.String) for ec in extra_cols]
    f = f.with_columns([c for c in cast_exprs if c.meta.output_name() in f.columns])

    f = f.filter(pl.col("target") == target)
    if "output_type" in f.columns:
        f = f.filter(pl.col("output_type") == "quantile")

    f = f.drop_nulls(subset=["value", "output_type_id", "target_end_date", "location", "horizon"] + extra_cols)

    is_non_neg = non_negative if non_negative is not None else any(
        k in target.lower() for k in ["hosp", "inc", "count", "prop", "visit", "death", "case", "admiss", "pct", "rate"]
    )
    neg_clipped_count = 0
    if is_non_neg:
        neg_clipped_count = f.filter(pl.col("value") < 0.0).height
        if neg_clipped_count > 0:
            f = f.with_columns(pl.col("value").clip(lower_bound=0.0))

    if locations is not None and len(locations) > 0 and "all" not in locations:
        f = f.filter(pl.col("location").is_in(locations))
    if reference_dates is not None and len(reference_dates) > 0 and "all" not in reference_dates:
        f = f.filter(pl.col("reference_date").is_in(reference_dates))
    if horizons is not None and len(horizons) > 0:
        f = f.filter(pl.col("horizon").is_in(horizons))

    if common_tasks is not None:
        if len(common_tasks) == 0:
            return {}
        if isinstance(common_tasks, pl.DataFrame):
            task_df = common_tasks
            join_on = [c for c in TASK_KEY_COLS + extra_cols if c in task_df.columns]
        else:
            task_list = list(common_tasks)
            sample_tup = task_list[0]
            data_dict: Dict[str, List[Any]] = {
                "reference_date": [str(t[0]) for t in task_list],
                "location": [str(t[1]) for t in task_list],
                "horizon": [int(t[2]) for t in task_list],
            }
            join_on = list(TASK_KEY_COLS)
            if len(sample_tup) >= 3 + len(extra_cols) and extra_cols:
                for idx, ec in enumerate(extra_cols):
                    data_dict[ec] = [str(t[3 + idx]) for t in task_list]
                    join_on.append(ec)
            task_df = pl.DataFrame(data_dict)
        f = f.join(task_df, on=join_on, how="inner")

    if f.is_empty():
        return {}

    present_quantiles = sorted(f.select(pl.col("output_type_id").unique()).to_series().to_list())
    has_std_7 = set(STANDARD_7_QUANTILES).issubset(set(present_quantiles))

    o_prep, join_keys = _prepared_oracle(o, target, extra_task_ids=extra_cols)
    merged = f.join(o_prep, on=join_keys, how="inner")
    if merged.is_empty():
        return {}

    group_keys = ["reference_date", "location", "horizon", "target_end_date"] + extra_cols
    if merged.select(group_keys + ["output_type_id"]).is_duplicated().any():
        merged = merged.unique(subset=group_keys + ["output_type_id"], keep="first", maintain_order=True)

    loss_cols: List[pl.Expr] = [
        (
            2.0
            * ((pl.col("oracle_value") < pl.col("value")).cast(pl.Float64) - pl.col("output_type_id"))
            * (pl.col("value") - pl.col("oracle_value"))
        ).alias("qloss")
    ]
    if is_non_neg:
        oracle_nonneg = pl.col("oracle_value").clip(lower_bound=0.0)
        pred_nonneg = pl.col("value").clip(lower_bound=0.0)
        log_oracle = (oracle_nonneg + 1.0).log()
        log_pred = (pred_nonneg + 1.0).log()
        loss_cols.append(
            (
                2.0
                * ((log_oracle < log_pred).cast(pl.Float64) - pl.col("output_type_id"))
                * (log_pred - log_oracle)
            ).alias("qloss_log")
        )
    else:
        loss_cols.append(pl.lit(None, dtype=pl.Float64).alias("qloss_log"))

    merged = merged.with_columns(loss_cols)

    wis_series = merged.group_by(group_keys).agg([
        pl.col("qloss").mean().alias("wis"),
        pl.col("qloss_log").mean().alias("wis_log") if is_non_neg else pl.lit(None, dtype=pl.Float64).alias("wis_log"),
    ])

    if has_std_7:
        wis7_df = (
            merged.filter(pl.col("output_type_id").is_in(STANDARD_7_QUANTILES))
            .group_by(group_keys)
            .agg([pl.col("qloss").mean().alias("wis_7")])
        )
        wis_series = wis_series.join(wis7_df, on=group_keys, how="left")
    else:
        wis_series = wis_series.with_columns(pl.lit(None, dtype=pl.Float64).alias("wis_7"))

    piv = merged.pivot(
        on="output_type_id",
        index=group_keys + ["oracle_value"],
        values="value",
        aggregate_function="first",
    )
    piv_cols = piv.columns

    quantiles_in_piv = []
    for c in piv_cols:
        try:
            quantiles_in_piv.append(float(c))
        except ValueError:
            pass
    quantiles_in_piv.sort()

    new_cols = []
    col_med = find_quantile_column(piv_cols, 0.50)
    if col_med is not None:
        new_cols.append((pl.col("oracle_value") - pl.col(col_med)).abs().alias("mae"))
        if is_non_neg:
            new_cols.append(
                (
                    (pl.col("oracle_value").clip(lower_bound=0.0) + 1.0).log()
                    - (pl.col(col_med).clip(lower_bound=0.0) + 1.0).log()
                ).abs().alias("mae_log")
            )
        else:
            new_cols.append(pl.lit(None, dtype=pl.Float64).alias("mae_log"))
    else:
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("mae"))
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("mae_log"))

    col_0025 = find_quantile_column(piv_cols, 0.025)
    col_0975 = find_quantile_column(piv_cols, 0.975)
    if col_0025 is not None and col_0975 is not None:
        new_cols.append(
            ((pl.col("oracle_value") >= pl.col(col_0025)) & (pl.col("oracle_value") <= pl.col(col_0975)))
            .cast(pl.Float64)
            .alias("cov95")
        )
        new_cols.append((pl.col(col_0975) - pl.col(col_0025)).clip(lower_bound=0.0).alias("sharpness"))
    else:
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("cov95"))
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("sharpness"))

    col_025 = find_quantile_column(piv_cols, 0.25)
    col_075 = find_quantile_column(piv_cols, 0.75)
    if col_025 is not None and col_075 is not None:
        new_cols.append(
            ((pl.col("oracle_value") >= pl.col(col_025)) & (pl.col("oracle_value") <= pl.col(col_075)))
            .cast(pl.Float64)
            .alias("cov50")
        )
    else:
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("cov50"))

    sym_pairs: List[Tuple[float, str, str]] = []
    for q_val in quantiles_in_piv:
        if q_val < 0.5:
            q_partner = round(1.0 - q_val, 4)
            c_low = find_quantile_column(piv_cols, q_val)
            c_high = find_quantile_column(piv_cols, q_partner)
            if c_low is not None and c_high is not None:
                sym_pairs.append((q_val, c_low, c_high))

    k_pairs = len(sym_pairs)
    if k_pairs > 0 and col_med is not None:
        norm_factor = 1.0 / (k_pairs + 0.5)
        sharp_terms = []
        over_terms = [0.5 * (pl.col(col_med) - pl.col("oracle_value")).clip(lower_bound=0.0)]
        under_terms = [0.5 * (pl.col("oracle_value") - pl.col(col_med)).clip(lower_bound=0.0)]

        for q_low, c_low, c_high in sym_pairs:
            alpha = 2.0 * q_low
            nom_cov = round(1.0 - alpha, 3)
            cov_col_name = f"cov_{int(round(nom_cov * 100))}"
            new_cols.append(
                ((pl.col("oracle_value") >= pl.col(c_low)) & (pl.col("oracle_value") <= pl.col(c_high)))
                .cast(pl.Float64)
                .alias(cov_col_name)
            )
            sharp_terms.append((alpha / 2.0) * (pl.col(c_high) - pl.col(c_low)).clip(lower_bound=0.0))
            over_terms.append((pl.col(c_low) - pl.col("oracle_value")).clip(lower_bound=0.0))
            under_terms.append((pl.col("oracle_value") - pl.col(c_high)).clip(lower_bound=0.0))

        sharp_sum = pl.sum_horizontal(sharp_terms) if sharp_terms else pl.lit(0.0)
        new_cols.append((sharp_sum * norm_factor).alias("decomp_sharpness"))
        new_cols.append((pl.sum_horizontal(over_terms) * norm_factor).alias("decomp_overpred"))
        new_cols.append((pl.sum_horizontal(under_terms) * norm_factor).alias("decomp_underpred"))
    else:
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("decomp_sharpness"))
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("decomp_overpred"))
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("decomp_underpred"))

    piv = piv.with_columns(new_cols)
    eval_df = wis_series.join(piv, on=group_keys, how="inner")

    return summarize_scored_tasks(
        eval_df,
        present_quantiles=present_quantiles,
        sym_pairs=sym_pairs,
        population_map=population_map,
        aggregate_locations=aggregate_locations,
        negative_values_clipped=neg_clipped_count,
        extra_task_ids=extra_cols,
        include_task_df=return_task_df,
    )


def score_pmf_forecasts(
    forecast_df: Union[pl.DataFrame, pl.LazyFrame, Any],
    oracle_df: Union[pl.DataFrame, pl.LazyFrame, Any],
    target: str,
    *,
    categories: Optional[Sequence[str]] = None,
    ordinal: bool = True,
    locations: Optional[List[str]] = None,
    reference_dates: Optional[List[str]] = None,
    horizons: Optional[List[int]] = None,
    extra_task_ids: Optional[Sequence[str]] = None,
    aggregate_locations: Optional[Iterable[str]] = None,
    return_task_df: bool = False,
) -> Dict[str, Any]:
    """
    Score categorical or ordinal PMF forecasts (Ranked Probability Score, Log Score, Brier Score, Hit Rate).
    """
    f = _to_polars_df(forecast_df)
    o = _to_polars_df(oracle_df)
    if f is None or o is None or f.is_empty() or o.is_empty():
        return {}

    extra_cols = _resolve_extra_task_ids(f.columns, o.columns, extra_task_ids)
    f = f.with_columns([
        pl.col("location").cast(pl.String),
        pl.col("horizon").fill_null(0).cast(pl.Int32),
        pl.col("output_type_id").cast(pl.String).str.strip_chars(),
        pl.col("value").cast(pl.Float64),
        pl.col("reference_date").cast(pl.String),
        pl.col("target_end_date").cast(pl.String),
        pl.col("target").cast(pl.String),
    ] + [pl.col(ec).cast(pl.String) for ec in extra_cols if ec in f.columns])

    f = f.filter(pl.col("target") == target)
    if "output_type" in f.columns:
        f = f.filter(pl.col("output_type") == "pmf")
    if locations is not None and len(locations) > 0 and "all" not in locations:
        f = f.filter(pl.col("location").is_in(locations))
    if reference_dates is not None and len(reference_dates) > 0 and "all" not in reference_dates:
        f = f.filter(pl.col("reference_date").is_in(reference_dates))
    if horizons is not None and len(horizons) > 0:
        f = f.filter(pl.col("horizon").is_in(horizons))
    f = f.drop_nulls(subset=["value", "output_type_id", "target_end_date", "location", "horizon"])
    if f.is_empty():
        return {}

    # Prepare categorical oracle observations
    if "target" in o.columns:
        o = o.filter(pl.col("target") == target)
    if "output_type" in o.columns and not o.filter(pl.col("output_type") == "pmf").is_empty():
        o = o.filter(pl.col("output_type") == "pmf")
    if o.is_empty():
        return {}

    # Extract true category per truth key where oracle_value == 1 (or max oracle_value)
    o = o.with_columns([
        pl.col("location").cast(pl.String),
        pl.col("target_end_date").cast(pl.String),
        pl.col("output_type_id").cast(pl.String).str.strip_chars().alias("true_category"),
        pl.col("oracle_value").cast(pl.Float64),
    ] + ([pl.col("horizon").cast(pl.Int32)] if "horizon" in o.columns else []) + [pl.col(ec).cast(pl.String) for ec in extra_cols if ec in o.columns])

    base_okeys = ["target_end_date", "location"] + extra_cols
    use_h_key = "horizon" in o.columns and o.filter(pl.col("horizon").is_not_null()).height > 0 and (
        o.select(base_okeys + ["horizon"]).n_unique() > o.select(base_okeys).n_unique()
    )
    okeys = base_okeys + (["horizon"] if use_h_key else [])
    if "as_of" in o.columns:
        o = o.sort("as_of")
    o_true = (
        o.filter(pl.col("oracle_value") > 0)
        .sort(okeys + ["oracle_value"])
        .group_by(okeys, maintain_order=True)
        .last()
        .select(okeys + ["true_category"])
        .drop_nulls()
    )
    if o_true.is_empty():
        return {}

    merged = f.join(o_true, on=okeys, how="inner")
    if merged.is_empty():
        return {}

    cat_order = [str(c) for c in categories] if categories else sorted(
        set(merged.get_column("output_type_id").to_list()) | set(merged.get_column("true_category").to_list())
    )
    cat_idx = {c: i for i, c in enumerate(cat_order)}
    K = len(cat_order)
    group_keys = ["reference_date", "location", "horizon", "target_end_date"] + extra_cols

    task_rows: List[Dict[str, Any]] = []
    for keys, g in merged.group_by(group_keys, maintain_order=True):
        probs = np.zeros(K, dtype=np.float64)
        for oid, val in zip(g.get_column("output_type_id").to_list(), g.get_column("value").to_list()):
            idx = cat_idx.get(str(oid))
            if idx is not None and val is not None and np.isfinite(val):
                probs[idx] += max(0.0, float(val))
        s = float(probs.sum())
        if s > 0 and abs(s - 1.0) > 1e-6:
            probs /= s
        true_cat = str(g.get_column("true_category")[0])
        y_idx = cat_idx.get(true_cat)
        if y_idx is None:
            continue
        p_true = float(probs[y_idx])
        log_score = float(-math.log(max(p_true, LOG_SCORE_FLOOR)))
        y_vec = np.zeros(K, dtype=np.float64)
        y_vec[y_idx] = 1.0
        brier = float(np.sum((probs - y_vec) ** 2))
        if ordinal and K > 1:
            cdf = np.cumsum(probs)
            truth_cdf = (np.arange(K) >= y_idx).astype(np.float64)
            rps = float(np.sum((cdf - truth_cdf) ** 2))
        else:
            rps = None
        pred_idx = int(np.argmax(probs))
        hit_mode = 1.0 if pred_idx == y_idx else 0.0

        row: Dict[str, Any] = dict(zip(group_keys, keys))
        row.update({
            "true_category": true_cat,
            "p_observed": p_true,
            "rps": rps,
            "log_score": log_score,
            "brier": brier,
            "hit_mode": hit_mode,
        })
        task_rows.append(row)

    if not task_rows:
        return {}
    task_df = pl.DataFrame(task_rows)
    agg_set = {str(x) for x in aggregate_locations} if aggregate_locations is not None else {"US"}
    is_agg = task_df["location"].is_in(sorted(agg_set)) if agg_set else pl.Series(values=[False] * task_df.height)
    primary_df = task_df.filter(~is_agg) if (~is_agg).any() else task_df.filter(is_agg)
    has_primary = bool((~is_agg).any())
    has_agg = bool(is_agg.any())

    def _agg_pmf(sub: pl.DataFrame) -> Dict[str, Any]:
        if sub.is_empty():
            return {"rps": None, "log_score": None, "brier": None, "hit_mode": None, "count": 0}
        return {
            "rps": float(sub["rps"].mean()) if ordinal and sub["rps"].drop_nulls().len() else None,
            "log_score": float(sub["log_score"].mean()),
            "brier": float(sub["brier"].mean()),
            "hit_mode": float(sub["hit_mode"].mean()) * 100.0,
            "count": int(sub.height),
        }

    overall = _agg_pmf(primary_df)
    by_horizon = {
        int(h): _agg_pmf(primary_df.filter(pl.col("horizon") == h))
        for h in sorted(primary_df.get_column("horizon").unique().to_list())
    }
    evaluated_dates = sorted(task_df.get_column("reference_date").unique().to_list())
    distinct_locs = sorted(task_df.get_column("location").unique().to_list())

    out: Dict[str, Any] = {
        "overall": overall,
        "states": _agg_pmf(task_df.filter(~is_agg)) if has_primary else None,
        "us": _agg_pmf(task_df.filter(is_agg)) if has_agg else None,
        "by_horizon": by_horizon,
        "metadata": {
            "evaluated_dates": evaluated_dates,
            "dates_count": len(evaluated_dates),
            "locations_count": len(distinct_locs),
            "states_count": len([loc for loc in distinct_locs if loc not in agg_set]),
            "total_tasks": task_df.height,
            "is_categorical": True,
            "ordinal": ordinal,
            "categories": cat_order,
            "aggregate_locations": sorted(agg_set),
            "has_us_data": has_agg,
            "has_states_data": has_primary,
        },
    }
    if return_task_df:
        out["task_df"] = task_df
    return out


def crps_ensemble_1d(samples: np.ndarray, y: float) -> float:
    """
    Exact empirical CRPS in O(M log M) time:
        CRPS = mean(|x_i - y|) - (1 / (2 M^2)) * sum_{i,j} |x_i - x_j|
    where sum_{i,j} |x_i - x_j| = 2 * sum_{i=0}^{M-1} (2*i - M + 1) * x_(i).
    """
    x = np.sort(np.asarray(samples, dtype=np.float64))
    m = x.size
    if m == 0:
        return float("nan")
    term1 = float(np.mean(np.abs(x - float(y))))
    if m == 1:
        return term1
    weights = (2.0 * np.arange(m, dtype=np.float64) - m + 1.0)
    term2 = float(np.dot(weights, x)) / (m * m)
    return max(0.0, term1 - term2)


def energy_score(trajectories: np.ndarray, y_vec: np.ndarray) -> float:
    """
    Multi-horizon Energy Score over M trajectories in R^D (trajectories shape `(M, D)`, `y_vec` shape `(D,)`):
        ES = (1/M) * sum ||X_i - y||_2 - (1/(2 M^2)) * sum_{i,j} ||X_i - X_j||_2
    """
    X = np.asarray(trajectories, dtype=np.float64)
    y = np.asarray(y_vec, dtype=np.float64)
    m = X.shape[0]
    if m == 0:
        return float("nan")
    term1 = float(np.mean(np.linalg.norm(X - y, axis=1)))
    if m == 1:
        return term1
    diffs = X[:, None, :] - X[None, :, :]
    pair_norms = np.linalg.norm(diffs, axis=2)
    term2 = 0.5 * float(np.mean(pair_norms))
    return max(0.0, term1 - term2)


def score_sample_forecasts(
    sample_df: Union[pl.DataFrame, pl.LazyFrame, Any],
    oracle_df: Union[pl.DataFrame, pl.LazyFrame, Any],
    target: str,
    *,
    locations: Optional[List[str]] = None,
    reference_dates: Optional[List[str]] = None,
    horizons: Optional[List[int]] = None,
    extra_task_ids: Optional[Sequence[str]] = None,
    aggregate_locations: Optional[Iterable[str]] = None,
    compute_energy_score: bool = True,
    return_task_df: bool = False,
) -> Dict[str, Any]:
    """Score probabilistic sample trajectories via exact empirical CRPS and multi-horizon Energy Score."""
    f = _to_polars_df(sample_df)
    o = _to_polars_df(oracle_df)
    if f is None or o is None or f.is_empty() or o.is_empty():
        return {}

    extra_cols = _resolve_extra_task_ids(f.columns, o.columns, extra_task_ids)
    f = f.with_columns([
        pl.col("location").cast(pl.String),
        pl.col("horizon").fill_null(0).cast(pl.Int32),
        pl.col("output_type_id").cast(pl.String),
        pl.col("value").cast(pl.Float64),
        pl.col("reference_date").cast(pl.String),
        pl.col("target_end_date").cast(pl.String),
        pl.col("target").cast(pl.String),
    ] + [pl.col(ec).cast(pl.String) for ec in extra_cols if ec in f.columns])

    f = f.filter(pl.col("target") == target)
    if "output_type" in f.columns:
        f = f.filter(pl.col("output_type") == "sample")
    if locations is not None and len(locations) > 0 and "all" not in locations:
        f = f.filter(pl.col("location").is_in(locations))
    if reference_dates is not None and len(reference_dates) > 0 and "all" not in reference_dates:
        f = f.filter(pl.col("reference_date").is_in(reference_dates))
    if horizons is not None and len(horizons) > 0:
        f = f.filter(pl.col("horizon").is_in(horizons))
    f = f.drop_nulls(subset=["value", "output_type_id", "target_end_date", "location", "horizon"])
    if f.is_empty():
        return {}

    o_prep, join_keys = _prepared_oracle(o, target, extra_task_ids=extra_cols)
    merged = f.join(o_prep, on=join_keys, how="inner")
    if merged.is_empty():
        return {}

    group_keys = ["reference_date", "location", "horizon", "target_end_date"] + extra_cols
    crps_rows: List[Dict[str, Any]] = []
    for keys, g in merged.group_by(group_keys, maintain_order=True):
        vals = g.get_column("value").to_numpy()
        y_val = float(g.get_column("oracle_value")[0])
        row = dict(zip(group_keys, keys))
        row["oracle_value"] = y_val
        row["crps"] = crps_ensemble_1d(vals, y_val)
        row["n_samples"] = int(vals.size)
        crps_rows.append(row)

    task_df = pl.DataFrame(crps_rows)
    mean_energy: Optional[float] = None
    if compute_energy_score and merged.height > 0:
        es_vals: List[float] = []
        round_keys = ["reference_date", "location"] + extra_cols
        for _, rg in merged.group_by(round_keys, maintain_order=True):
            piv = rg.pivot(
                on="horizon",
                index="output_type_id",
                values="value",
                aggregate_function="first",
            )
            h_cols = [c for c in piv.columns if c != "output_type_id"]
            if len(h_cols) < 2:
                continue
            piv_clean = piv.drop_nulls(subset=h_cols)
            if piv_clean.height < 2:
                continue
            obs_by_h = {
                str(r["horizon"]): float(r["oracle_value"])
                for r in rg.select(["horizon", "oracle_value"]).unique().iter_rows(named=True)
            }
            if not all(hc in obs_by_h for hc in h_cols):
                continue
            mat = piv_clean.select(h_cols).to_numpy()
            y_vec = np.asarray([obs_by_h[hc] for hc in h_cols], dtype=np.float64)
            es_vals.append(energy_score(mat, y_vec))
        if es_vals:
            mean_energy = float(np.mean(es_vals))

    agg_set = {str(x) for x in aggregate_locations} if aggregate_locations is not None else {"US"}
    is_agg = task_df["location"].is_in(sorted(agg_set)) if agg_set else pl.Series(values=[False] * task_df.height)
    primary_df = task_df.filter(~is_agg) if (~is_agg).any() else task_df.filter(is_agg)

    out: Dict[str, Any] = {
        "overall": {
            "crps": float(primary_df["crps"].mean()),
            "energy_score": mean_energy,
            "count": int(primary_df.height),
        },
        "by_horizon": {
            int(h): {"crps": float(primary_df.filter(pl.col("horizon") == h)["crps"].mean()), "count": int(primary_df.filter(pl.col("horizon") == h).height)}
            for h in sorted(primary_df.get_column("horizon").unique().to_list())
        },
    }
    if return_task_df:
        out["task_df"] = task_df
    return out


_INT_DTYPES = (pl.Int8, pl.Int16, pl.Int32, pl.Int64, pl.UInt8, pl.UInt16, pl.UInt32)


def _canonical_task_frame(
    val: Any,
    metric_col: str,
    extra_task_ids: Optional[Sequence[str]] = None,
) -> Optional[pl.DataFrame]:
    if not isinstance(val, pl.DataFrame):
        return None
    schema = val.schema
    if schema.get("location") != pl.String:
        return None
    rd_col = "reference_date" if "reference_date" in schema else ("target_end_date" if "target_end_date" in schema else None)
    if rd_col is None or schema[rd_col] != pl.String:
        return None
    if schema.get("horizon") not in _INT_DTYPES or val.get_column("horizon").null_count():
        return None
    extra_cols = [str(c) for c in (extra_task_ids or ()) if c in schema]
    empty_schema = {"loc": pl.String, "rd": pl.String, "h": pl.Int64, **{ec: pl.String for ec in extra_cols}, "w": pl.Float64}
    empty = pl.DataFrame(schema=empty_schema)
    if metric_col not in schema:
        return empty
    w_dtype = schema[metric_col]
    if not (w_dtype.is_float() or w_dtype in _INT_DTYPES):
        return None
    if val.is_empty():
        return empty
    sel = [
        pl.col("location").fill_null("None").alias("loc"),
        pl.col(rd_col).fill_null("None").alias("rd"),
        pl.col("horizon").cast(pl.Int64).alias("h"),
    ] + [pl.col(ec).cast(pl.String).fill_null("None") for ec in extra_cols] + [
        pl.col(metric_col).cast(pl.Float64).alias("w"),
    ]
    return (
        val.select(sel)
        .filter(pl.col("w").is_not_null() & pl.col("w").is_not_nan())
        .unique(subset=["loc", "rd", "h"] + extra_cols, keep="last", maintain_order=True)
    )


def compute_pairwise_relative_wis(
    model_task_wis: Dict[str, Any],
    baseline_model: Optional[str] = None,
    metric_col: str = "wis",
    extra_task_ids: Optional[Sequence[str]] = None,
) -> Dict[str, Dict[str, Optional[float]]]:
    """Pairwise tournament relative WIS (or relative RPS/log score when `metric_col` differs)."""
    models = list(model_task_wis.keys())
    if not models:
        return {}
    extra_cols = sorted(str(c) for c in (extra_task_ids or ()))
    frames: List[pl.DataFrame] = []
    for m in models:
        f = _canonical_task_frame(model_task_wis[m], metric_col, extra_task_ids=extra_cols)
        if f is None or (extra_cols and not all(ec in f.columns for ec in extra_cols)):
            if not extra_cols:
                return _pairwise_relative_wis_reference(model_task_wis, baseline_model, metric_col)
            # Fall back to reference only when inputs aren't canonical; strip absent extra_cols
            avail_extra = [ec for ec in extra_cols if f is not None and ec in f.columns]
            if avail_extra != extra_cols:
                return _pairwise_relative_wis_reference(model_task_wis, baseline_model, metric_col, extra_task_ids=extra_cols)
            return _pairwise_relative_wis_reference(model_task_wis, baseline_model, metric_col)
        frames.append(f)

    n = len(models)
    long = pl.concat(
        [f.with_columns(pl.lit(i, dtype=pl.Int64).alias("m")) for i, f in enumerate(frames) if f.height],
        how="vertical",
    ) if any(f.height for f in frames) else None
    if long is None:
        return _pairwise_relative_wis_reference(model_task_wis, baseline_model, metric_col, extra_task_ids=extra_cols)
    w = long.get_column("w").to_numpy()
    if not np.isfinite(w).all():
        return _pairwise_relative_wis_reference(model_task_wis, baseline_model, metric_col, extra_task_ids=extra_cols)

    rank_cols = ["loc", "rd", "h"] + [ec for ec in extra_cols if ec in long.columns]
    task_ids = long.select(pl.struct(*rank_cols).rank("dense").cast(pl.Int64) - 1).to_series().to_numpy()
    model_ids = long.get_column("m").to_numpy()
    n_tasks = int(task_ids.max()) + 1
    V = np.zeros((n_tasks, n), dtype=np.float64)
    P = np.zeros((n_tasks, n), dtype=np.float64)
    V[task_ids, model_ids] = w
    P[task_ids, model_ids] = 1.0
    C = P.T @ P
    S = V.T @ P

    has_tasks = [bool(C[i, i] > 0) for i in range(n)]
    pairwise_ratios: Dict[str, Dict[str, float]] = {m: {} for m in models}
    ratio_rows: List[List[Tuple[int, float]]] = [[] for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i == j:
                if has_tasks[i]:
                    ratio_rows[i].append((j, 1.0))
                continue
            c = C[i, j]
            if c <= 0:
                continue
            mean_i = float(S[i, j]) / float(c)
            mean_j = float(S[j, i]) / float(c)
            if mean_i > 0 and mean_j > 0:
                ratio_rows[i].append((j, mean_i / mean_j))
    for i, m in enumerate(models):
        pairwise_ratios[m] = {models[j]: r for j, r in ratio_rows[i]}

    return _relative_wis_from_ratios(models, pairwise_ratios, baseline_model, baseline_model in model_task_wis)


def _relative_wis_from_ratios(
    models: List[str],
    pairwise_ratios: Dict[str, Dict[str, float]],
    baseline_model: Optional[str],
    baseline_present: bool,
) -> Dict[str, Dict[str, Optional[float]]]:
    n = len(models)
    unscaled_theta: Dict[str, Optional[float]] = {}
    for m in models:
        ratios = pairwise_ratios[m]
        if len(ratios) > 1 or (n == 1 and ratios):
            log_sum = sum(math.log(r) for r in ratios.values())
            unscaled_theta[m] = math.exp(log_sum / len(ratios))
        else:
            unscaled_theta[m] = None

    base_theta = unscaled_theta.get(baseline_model) if baseline_model else None

    results: Dict[str, Dict[str, Optional[float]]] = {}
    for m in models:
        theta_m = unscaled_theta.get(m)
        if not baseline_model:
            rel_wis = theta_m
        elif theta_m is not None and base_theta is not None and base_theta > 0:
            rel_wis = theta_m / base_theta
        else:
            rel_wis = None

        direct_pct: Optional[float] = None
        if baseline_model and baseline_present:
            if m == baseline_model:
                direct_pct = 0.0
            elif baseline_model in pairwise_ratios.get(m, {}):
                direct_ratio = pairwise_ratios[m][baseline_model]
                direct_pct = (direct_ratio - 1.0) * 100.0

        results[m] = {
            "relative_wis": round(rel_wis, 4) if rel_wis is not None else None,
            "unscaled_skill": round(theta_m, 4) if theta_m is not None else None,
            "direct_pct_vs_baseline": round(direct_pct, 2) if direct_pct is not None else None,
        }
    return results


def compute_pairwise_relative_wis_indexed(
    df: pl.DataFrame,
    n_models: int,
    base_idx: Optional[int],
    metric_col: str,
    task_cols: Sequence[str],
) -> Tuple[Dict[int, float], Dict[int, float]]:
    """Vectorized pairwise tournament relative WIS for a single partitioned location DataFrame."""
    if base_idx is None or base_idx < 0 or base_idx >= n_models or metric_col not in df.columns:
        return {}, {}

    f = df.filter(pl.col(metric_col).is_not_null() & pl.col(metric_col).is_finite())
    if f.is_empty():
        return {}, {}

    t_cols = list(task_cols)
    f = f.unique(subset=["_m", *t_cols], keep="last")
    tids = f.select(pl.struct(*t_cols).rank("dense").cast(pl.Int64) - 1).to_series().to_numpy()
    mids = f.get_column("_m").to_numpy()
    w = f.get_column(metric_col).cast(pl.Float64).to_numpy()
    n_tasks = int(tids.max()) + 1

    V = np.zeros((n_tasks, n_models), dtype=np.float64)
    P = np.zeros((n_tasks, n_models), dtype=np.float64)
    V[tids, mids] = w
    P[tids, mids] = 1.0
    C = P.T @ P
    S = V.T @ P

    has_tasks = np.diag(C) > 0
    if not has_tasks[base_idx]:
        return {}, {}

    valid = (C > 0) & (S > 0) & (S.T > 0)
    np.fill_diagonal(valid, has_tasks)
    with np.errstate(divide="ignore", invalid="ignore"):
        mean_i = np.where(C > 0, S / C, 0.0)
        ratios = np.where(valid, mean_i / mean_i.T, 1.0)
        np.fill_diagonal(ratios, 1.0)
        log_r = np.where(valid, np.log(ratios), 0.0)

    cnt = valid.sum(axis=1)
    active_n = int(has_tasks.sum())
    ok = (cnt > 1) | ((active_n == 1) & (cnt == 1))
    theta = np.full(n_models, np.nan, dtype=np.float64)
    theta[ok] = np.exp(log_r[ok].sum(axis=1) / cnt[ok])

    base_theta = theta[base_idx]
    if not (np.isfinite(base_theta) and base_theta > 0):
        return {}, {}

    rel: Dict[int, float] = {base_idx: 1.0}
    direct: Dict[int, float] = {base_idx: 0.0}
    for i in range(n_models):
        if i == base_idx:
            continue
        if np.isfinite(theta[i]):
            rel[i] = round(float(theta[i] / base_theta), 4)
        if valid[i, base_idx]:
            direct[i] = round((float(ratios[i, base_idx]) - 1.0) * 100.0, 2)
    return rel, direct


def _pairwise_relative_wis_reference(
    model_task_wis: Dict[str, Any],
    baseline_model: Optional[str] = None,
    metric_col: str = "wis",
    extra_task_ids: Optional[Sequence[str]] = None,
) -> Dict[str, Dict[str, Optional[float]]]:
    """Reference implementation for dict inputs, non-finite values, or irregular dtypes."""
    extra_cols = [str(c) for c in (extra_task_ids or ())]
    converted: Dict[str, Dict[Tuple[Any, ...], float]] = {}
    for m, val in model_task_wis.items():
        if isinstance(val, pl.DataFrame):
            m_dict: Dict[Tuple[Any, ...], float] = {}
            for row in val.iter_rows(named=True):
                loc = str(row.get("location", ""))
                rd = str(row.get("reference_date", row.get("target_end_date", "")))
                h = int(row.get("horizon", 0))
                w = row.get(metric_col)
                if w is not None and not np.isnan(w):
                    key = (loc, rd, h) + tuple(str(row.get(ec, "")) for ec in extra_cols)
                    m_dict[key] = float(w)
            converted[m] = m_dict
        elif isinstance(val, dict):
            converted[m] = val
        else:
            converted[m] = {}

    models = list(converted.keys())
    if not models:
        return {}

    n = len(models)
    pairwise_ratios: Dict[str, Dict[str, float]] = {m: {} for m in models}
    for i in range(n):
        m1 = models[i]
        tasks1 = converted[m1]
        for j in range(i, n):
            m2 = models[j]
            tasks2 = converted[m2]
            if m1 == m2:
                if tasks1:
                    pairwise_ratios[m1][m2] = 1.0
                continue
            shared = set(tasks1.keys()).intersection(set(tasks2.keys()))
            if not shared:
                continue
            mean1 = sum(tasks1[t] for t in shared) / len(shared)
            mean2 = sum(tasks2[t] for t in shared) / len(shared)
            if mean1 > 0 and mean2 > 0:
                pairwise_ratios[m1][m2] = mean1 / mean2
                pairwise_ratios[m2][m1] = mean2 / mean1

    return _relative_wis_from_ratios(models, pairwise_ratios, baseline_model, baseline_model in converted)


def find_common_tasks(
    model_dfs: Dict[str, Any],
    target: str = "wk inc flu hosp",
    locations: Optional[List[str]] = None,
    reference_dates: Optional[List[str]] = None,
    extra_task_ids: Optional[Sequence[str]] = None,
    output_type: str = "quantile",
) -> Set[Tuple[Any, ...]]:
    """Find intersection of `(reference_date, location, horizon[, *extra_task_ids])` tasks across models."""
    if not model_dfs:
        return set()

    extra_cols = sorted(str(c) for c in (extra_task_ids or ()))
    outcomes = ordered_map_outcomes(
        lambda df_raw: model_task_keys(
            df_raw,
            target,
            locations,
            reference_dates,
            extra_task_ids=extra_cols,
            output_type=output_type,
        ),
        list(model_dfs.values()),
    )
    common_df = intersect_task_keys(outcomes, extra_task_ids=extra_cols)
    if common_df is None or common_df.is_empty():
        return set()

    if not extra_cols:
        return set((str(r[0]), str(r[1]), int(r[2])) for r in common_df.iter_rows())
    return set(
        (str(r[0]), str(r[1]), int(r[2])) + tuple(str(x) for x in r[3:])
        for r in common_df.iter_rows()
    )


def model_task_keys(
    df_raw: Any,
    target: str,
    locations: Optional[List[str]] = None,
    reference_dates: Optional[List[str]] = None,
    extra_task_ids: Optional[Sequence[str]] = None,
    output_type: str = "quantile",
) -> Optional[pl.DataFrame]:
    """One model's distinct task keys as DataFrame, or None when no tasks contribute."""
    df = _to_polars_df(df_raw)
    if df is None or df.is_empty():
        return None

    sub = df.filter(pl.col("target") == target) if "target" in df.columns else df
    if "output_type" in sub.columns and output_type:
        sub = sub.filter(pl.col("output_type") == output_type)
    if locations is not None and len(locations) > 0 and "all" not in locations:
        sub = sub.filter(pl.col("location").is_in(locations))
    if reference_dates is not None and len(reference_dates) > 0 and "all" not in reference_dates:
        sub = sub.filter(pl.col("reference_date").is_in(reference_dates))
    if sub.is_empty():
        return None

    if output_type == "quantile" and "output_type_id" in sub.columns:
        has_med = sub.select((pl.col("output_type_id") == 0.50).any()).to_series()[0]
        if has_med:
            sub = sub.filter(pl.col("output_type_id") == 0.50)

    extra_cols = [str(c) for c in (extra_task_ids or ()) if c in sub.columns]
    sel = [
        pl.col("reference_date").cast(pl.String),
        pl.col("location").cast(pl.String),
        pl.col("horizon").fill_null(0).cast(pl.Int32),
    ] + [pl.col(ec).cast(pl.String) for ec in extra_cols]
    tasks = sub.select(sel).drop_nulls().unique()
    return None if tasks.is_empty() else tasks


def intersect_task_keys(
    outcomes: List[Tuple[bool, Any]],
    extra_task_ids: Optional[Sequence[str]] = None,
) -> Optional[pl.DataFrame]:
    """Intersect per-model task keys in order (None = empty intersection)."""
    extra_cols = [str(c) for c in (extra_task_ids or ())]
    common_df: Optional[pl.DataFrame] = None
    for ok, tasks in outcomes:
        if not ok:
            raise tasks
        if tasks is None:
            return None
        if common_df is None:
            common_df = tasks
        else:
            on_cols = [c for c in TASK_KEY_COLS + extra_cols if c in common_df.columns and c in tasks.columns]
            common_df = common_df.join(tasks, on=on_cols, how="inner")
        if common_df.is_empty():
            return None
    return common_df
