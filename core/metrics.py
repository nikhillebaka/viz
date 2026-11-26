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

from collections import OrderedDict
import functools
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
    "round_id",
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
_INT_DTYPES = (pl.Int8, pl.Int16, pl.Int32, pl.Int64, pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64)


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


def _prepare_oracle_frame(oracle_df: Any, target: Optional[str]) -> Optional[pl.DataFrame]:
    """Push `target` filter onto a LazyFrame oracle before collecting; keep eager DataFrames as-is for memoization."""
    if oracle_df is None:
        return None
    if isinstance(oracle_df, pl.LazyFrame):
        if target is not None:
            schema = oracle_df.collect_schema()
            if "target" in schema:
                t_expr = (
                    pl.col("target") == target
                    if schema["target"] == pl.String
                    else (pl.col("target").cast(pl.String) == target)
                )
                oracle_df = oracle_df.filter(t_expr)
        return oracle_df.collect()
    return _to_polars_df(oracle_df)


def _prepare_forecast_frame(
    data: Any,
    *,
    target: Optional[str] = None,
    output_type: Optional[str] = None,
    locations: Optional[Sequence[str]] = None,
    reference_dates: Optional[Sequence[str]] = None,
    horizons: Optional[Sequence[int]] = None,
) -> Optional[pl.DataFrame]:
    """Push target/output_type/scope predicates down onto a LazyFrame before `.collect()` (or filter DataFrame once)."""
    if data is None:
        return None
    is_lazy = isinstance(data, pl.LazyFrame)
    if not is_lazy and not isinstance(data, pl.DataFrame):
        data = _to_polars_df(data)
        if data is None:
            return None
    if not is_lazy and data.is_empty():
        return data

    schema = data.collect_schema() if is_lazy else data.schema
    preds: List[pl.Expr] = []
    if target is not None and "target" in schema:
        preds.append(
            (pl.col("target") == target)
            if schema["target"] == pl.String
            else (pl.col("target").cast(pl.String) == target)
        )
    if output_type is not None and "output_type" in schema:
        preds.append(
            (pl.col("output_type") == output_type)
            if schema["output_type"] == pl.String
            else (pl.col("output_type").cast(pl.String) == output_type)
        )
    if locations is not None and len(locations) > 0 and "all" not in locations and "location" in schema:
        locs_str = [str(x) for x in locations]
        preds.append(
            pl.col("location").is_in(locs_str)
            if schema["location"] == pl.String
            else pl.col("location").cast(pl.String).is_in(locs_str)
        )
    if reference_dates is not None and len(reference_dates) > 0 and "all" not in reference_dates and "reference_date" in schema:
        rds_str = [str(x) for x in reference_dates]
        preds.append(
            pl.col("reference_date").is_in(rds_str)
            if schema["reference_date"] == pl.String
            else pl.col("reference_date").cast(pl.String).is_in(rds_str)
        )
    if horizons is not None and len(horizons) > 0 and "horizon" in schema:
        hs_int = [int(h) for h in horizons]
        h_dt = schema["horizon"]
        h_col = pl.col("horizon").fill_null(0)
        if h_dt not in _INT_DTYPES:
            h_col = h_col.cast(pl.Int64)
        preds.append(h_col.is_in(hs_int))

    if preds:
        expr = preds[0]
        for p in preds[1:]:
            expr = expr & p
        data = data.filter(expr)
    return data.collect() if is_lazy else data


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


# Small LRU memos keyed by `id(o)` of the caller's oracle DataFrame. Each entry pins its source
# frame and caches all prepared `(target, extra_key)` slices for that frame so multi-target hubs
# (>= 5 targets sharing one oracle table) never thrash the 4-frame ceiling.
_ORACLE_MEMO: "OrderedDict[int, Tuple[pl.DataFrame, Dict[Tuple[str, Tuple[str, ...]], Tuple[pl.DataFrame, List[str]]]]]" = OrderedDict()
_ORACLE_MEMO_LOCK = threading.Lock()
_ORACLE_MEMO_MAX = 4


def _memo_get(
    memo: "OrderedDict[int, Tuple[pl.DataFrame, Dict[Any, Any]]]",
    lock: threading.Lock,
    subkey: Any,
    o: pl.DataFrame,
) -> Optional[Tuple[pl.DataFrame, List[str]]]:
    oid = id(o)
    with lock:
        entry = memo.get(oid)
        if entry is None or entry[0] is not o:
            return None
        memo.move_to_end(oid)
        hit = entry[1].get(subkey)
        if hit is None:
            return None
        return hit[0], list(hit[1])


def _memo_put(
    memo: "OrderedDict[int, Tuple[pl.DataFrame, Dict[Any, Any]]]",
    lock: threading.Lock,
    subkey: Any,
    o: pl.DataFrame,
    prepared: pl.DataFrame,
    join_keys: List[str],
) -> None:
    oid = id(o)
    with lock:
        entry = memo.get(oid)
        if entry is None or entry[0] is not o:
            inner: Dict[Any, Any] = {}
            memo[oid] = (o, inner)
        else:
            inner = entry[1]
        inner[subkey] = (prepared, list(join_keys))
        memo.move_to_end(oid)
        while len(memo) > _ORACLE_MEMO_MAX:
            memo.popitem(last=False)


def _prepared_oracle(
    o: pl.DataFrame,
    target: str,
    extra_task_ids: Optional[Sequence[str]] = None,
) -> Tuple[pl.DataFrame, List[str]]:
    extra_key = tuple(sorted(str(c) for c in (extra_task_ids or ()) if c in o.columns))
    subkey = (target, extra_key)
    hit = _memo_get(_ORACLE_MEMO, _ORACLE_MEMO_LOCK, subkey, o)
    if hit is not None:
        return hit
    prepared, join_keys = _prepare_oracle(o, target, extra_task_ids=extra_key)
    _memo_put(_ORACLE_MEMO, _ORACLE_MEMO_LOCK, subkey, o, prepared, join_keys)
    return prepared, join_keys


_PMF_ORACLE_MEMO: "OrderedDict[int, Tuple[pl.DataFrame, Dict[Tuple[str, Tuple[str, ...]], Tuple[pl.DataFrame, List[str]]]]]" = OrderedDict()
_PMF_ORACLE_MEMO_LOCK = threading.Lock()


def _prepare_pmf_oracle(
    o: pl.DataFrame,
    target: str,
    extra_task_ids: Optional[Sequence[str]] = None,
) -> Tuple[pl.DataFrame, List[str]]:
    """Extract canonical `(join_keys + ["true_category"])` truth table for PMF targets."""
    if "target" in o.columns:
        o = o.filter(pl.col("target") == target)
    if "output_type" in o.columns and not o.filter(pl.col("output_type") == "pmf").head(1).is_empty():
        o = o.filter(pl.col("output_type") == "pmf")
    if o.is_empty():
        return pl.DataFrame(), []

    extra_cols = [str(c) for c in (extra_task_ids or ()) if c in o.columns]
    o = o.with_columns(
        [
            pl.col("location").cast(pl.String),
            pl.col("target_end_date").cast(pl.String),
            pl.col("output_type_id").cast(pl.String).str.strip_chars().alias("true_category"),
            pl.col("oracle_value").cast(pl.Float64),
        ]
        + ([pl.col("horizon").cast(pl.Int32)] if "horizon" in o.columns else [])
        + [pl.col(ec).cast(pl.String) for ec in extra_cols]
    )

    base_okeys = ["target_end_date", "location"] + extra_cols
    use_h_key = False
    if "horizon" in o.columns:
        valid_h = o.filter(pl.col("horizon").is_not_null())
        if valid_h.height > 0:
            use_h_key = valid_h.select(base_okeys + ["horizon"]).n_unique() > valid_h.select(base_okeys).n_unique()
    okeys = base_okeys + (["horizon"] if use_h_key else [])
    sort_cols = okeys + (["as_of"] if "as_of" in o.columns else []) + ["oracle_value"]
    o_true = (
        o.filter(pl.col("oracle_value") > 0)
        .sort(sort_cols)
        .group_by(okeys, maintain_order=False)
        .last()
        .select(okeys + ["true_category"])
        .drop_nulls()
    )
    return o_true, okeys


def _prepared_pmf_oracle(
    o: pl.DataFrame,
    target: str,
    extra_task_ids: Optional[Sequence[str]] = None,
) -> Tuple[pl.DataFrame, List[str]]:
    extra_key = tuple(sorted(str(c) for c in (extra_task_ids or ()) if c in o.columns))
    subkey = (target, extra_key)
    hit = _memo_get(_PMF_ORACLE_MEMO, _PMF_ORACLE_MEMO_LOCK, subkey, o)
    if hit is not None:
        return hit
    prepared, join_keys = _prepare_pmf_oracle(o, target, extra_task_ids=extra_key)
    _memo_put(_PMF_ORACLE_MEMO, _PMF_ORACLE_MEMO_LOCK, subkey, o, prepared, join_keys)
    return prepared, join_keys


def attach_wis_per_100k(df: pl.DataFrame, population_map: Optional[Dict[str, int]]) -> pl.DataFrame:
    """Attach population-normalized `wis_per_100k` using vectorized mapping without a join DataFrame."""
    if df.is_empty():
        return df if "wis_per_100k" in df.columns else df.with_columns(pl.lit(None, dtype=pl.Float64).alias("wis_per_100k"))
    if population_map:
        pop_floats = {str(k): float(v) for k, v in population_map.items() if v is not None and v > 0}
        if pop_floats:
            pop_expr = pl.col("location").cast(pl.String).replace_strict(pop_floats, default=None, return_dtype=pl.Float64)
            return df.with_columns(
                pl.when(pop_expr.is_not_null())
                .then((pl.col("wis") / pop_expr) * 100000.0)
                .otherwise(None)
                .alias("wis_per_100k")
            )
        return df.with_columns(pl.lit(None, dtype=pl.Float64).alias("wis_per_100k"))
    if "wis_per_100k" not in df.columns:
        return df.with_columns(pl.lit(None, dtype=pl.Float64).alias("wis_per_100k"))
    return df


_SUMMARY_MEAN_COLS = (
    ("wis", "wis"),
    ("wis_log", "wis_log"),
    ("wis_7", "wis_7"),
    ("wis_per_100k", "wis_per_100k"),
    ("mae", "mae"),
    ("mae_log", "mae_log"),
    ("cov95", "cov95"),
    ("cov50", "cov50"),
    ("sharpness", "sharpness"),
    ("decomp_sharpness", "sharpness_component"),
    ("decomp_overpred", "overprediction_penalty"),
    ("decomp_underpred", "underprediction_penalty"),
)


def _finite_float(v: Any) -> Optional[float]:
    return float(v) if v is not None and not np.isnan(v) else None


def _build_summary_agg_exprs(cols: Sequence[str], calib_specs: Sequence[Tuple[float, str]]) -> List[pl.Expr]:
    col_set = set(cols)
    exprs: List[pl.Expr] = [
        pl.col(c).mean().alias(c) if c in col_set else pl.lit(None, dtype=pl.Float64).alias(c)
        for c, _ in _SUMMARY_MEAN_COLS
    ]
    exprs.append(pl.len().alias("count"))
    for _, col_name in calib_specs:
        if col_name in col_set:
            exprs.append(pl.col(col_name).mean().alias(col_name))
    return exprs


def _summary_from_row(res_row: Dict[str, Any], calib_specs: Sequence[Tuple[float, str]]) -> Dict[str, Any]:
    cov95_raw = _finite_float(res_row.get("cov95"))
    cov50_raw = _finite_float(res_row.get("cov50"))
    calib_dict: Dict[float, float] = {}
    for nom_level, col_name in calib_specs:
        val = _finite_float(res_row.get(col_name))
        if val is not None:
            calib_dict[float(nom_level)] = round(val * 100.0, 1)

    return {
        "wis": _finite_float(res_row.get("wis")),
        "wis_log": _finite_float(res_row.get("wis_log")),
        "wis_7": _finite_float(res_row.get("wis_7")),
        "wis_per_100k": _finite_float(res_row.get("wis_per_100k")),
        "mae": _finite_float(res_row.get("mae")),
        "mae_log": _finite_float(res_row.get("mae_log")),
        "cov95": cov95_raw * 100.0 if cov95_raw is not None else None,
        "cov50": cov50_raw * 100.0 if cov50_raw is not None else None,
        "sharpness": _finite_float(res_row.get("sharpness")),
        "sharpness_component": _finite_float(res_row.get("decomp_sharpness")),
        "overprediction_penalty": _finite_float(res_row.get("decomp_overpred")),
        "underprediction_penalty": _finite_float(res_row.get("decomp_underpred")),
        "calibration": calib_dict,
        "count": int(res_row["count"]),
    }


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

    df = attach_wis_per_100k(eval_df, population_map)

    agg_set = {str(x) for x in aggregate_locations} if aggregate_locations is not None else {"US"}
    agg_list = sorted(agg_set)
    is_agg_expr = pl.col("location").is_in(agg_list) if agg_list else pl.lit(False)
    has_primary_val, has_agg_val = df.select((~is_agg_expr).any().alias("_hp"), is_agg_expr.any().alias("_ha")).row(0)
    has_primary = bool(has_primary_val)
    has_agg = bool(has_agg_val)
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

    agg_exprs = _build_summary_agg_exprs(df.columns, calib_specs)

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
        return _summary_from_row(df_slice.select(agg_exprs).to_dicts()[0], calib_specs)

    q_list = list(present_quantiles or [])
    q_count = len(q_list)
    has_std_7 = set(STANDARD_7_QUANTILES).issubset(set(q_list)) if q_list else False
    has_std_23 = set(STANDARD_23_QUANTILES).issubset(set(q_list)) if q_list else False

    primary_base = _summarize_df(primary_eval)
    overall_summary = {
        **primary_base,
        "quantile_count": q_count,
        "has_23_quantiles": has_std_23,
        "has_7_quantiles": has_std_7,
    }

    primary_summary = dict(primary_base) if has_primary else None
    if has_agg:
        agg_summary = _summarize_df(df.filter(is_agg_expr)) if has_primary else dict(primary_base)
    else:
        agg_summary = None

    by_horizon: Dict[int, Dict[str, Any]] = {}
    if not primary_eval.is_empty():
        h_rows = (
            primary_eval.group_by("horizon")
            .agg(agg_exprs)
            .sort("horizon")
            .to_dicts()
        )
        for row_dict in h_rows:
            h_val = row_dict.get("horizon")
            if h_val is not None:
                by_horizon[int(h_val)] = _summary_from_row(row_dict, calib_specs)

    evaluated_dates = sorted(df.get_column("reference_date").unique().to_list())
    distinct_locs = sorted(df.get_column("location").unique().to_list())

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


def _norm_and_join_quantiles(
    forecast_df: Union[pl.DataFrame, pl.LazyFrame, Any],
    oracle_df: Union[pl.DataFrame, pl.LazyFrame, Any],
    *,
    target: str,
    locations: Optional[List[str]] = None,
    reference_dates: Optional[List[str]] = None,
    horizons: Optional[List[int]] = None,
    common_tasks: Optional[Union[Set[Tuple[Any, ...]], pl.DataFrame, List[Tuple[Any, ...]]]] = None,
    non_negative: Optional[bool] = None,
    extra_task_ids: Optional[Sequence[str]] = None,
    preserve_cols: Optional[Sequence[str]] = None,
    count_negatives: bool = False,
) -> Optional[Tuple[pl.DataFrame, List[str], List[str], bool, int]]:
    """Shared predicate pushdown, quantile normalization, optional negative count, and oracle inner join."""
    f = _prepare_forecast_frame(
        forecast_df,
        target=target,
        output_type="quantile",
        locations=locations,
        reference_dates=reference_dates,
        horizons=horizons,
    )
    o = _prepare_oracle_frame(oracle_df, target)
    if f is None or o is None or f.is_empty() or o.is_empty():
        return None

    extra_cols = _resolve_extra_task_ids(f.columns, o.columns, extra_task_ids)
    p_cols = [
        str(c)
        for c in (preserve_cols or ())
        if c in f.columns and c not in extra_cols and c not in TASK_KEY_COLS and c != "target_end_date"
    ]

    cast_exprs = [
        pl.col("location").cast(pl.String),
        pl.col("horizon").fill_null(0).cast(pl.Int32),
        pl.col("output_type_id").cast(pl.Float64).round(3),
        pl.col("value").cast(pl.Float64),
        pl.col("reference_date").cast(pl.String),
        pl.col("target_end_date").cast(pl.String),
        pl.col("target").cast(pl.String),
    ] + [pl.col(ec).cast(pl.String) for ec in extra_cols + p_cols]
    f = f.with_columns([c for c in cast_exprs if c.meta.output_name() in f.columns])
    f = f.drop_nulls(subset=["value", "output_type_id", "target_end_date", "location", "horizon"] + extra_cols + p_cols)

    is_non_neg = non_negative if non_negative is not None else any(
        k in target.lower() for k in ["hosp", "inc", "count", "prop", "visit", "death", "case", "admiss", "pct", "rate"]
    )
    neg_clipped_count = 0
    if is_non_neg and not f.is_empty():
        if count_negatives:
            neg_clipped_count = int(f.select((pl.col("value") < 0.0).sum()).item() or 0)
            if neg_clipped_count > 0:
                f = f.with_columns(pl.col("value").clip(lower_bound=0.0))
        else:
            f = f.with_columns(pl.col("value").clip(lower_bound=0.0))

    if common_tasks is not None:
        if len(common_tasks) == 0:
            return None
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
        return None

    o_prep, join_keys = _prepared_oracle(o, target, extra_task_ids=extra_cols)
    merged = f.join(o_prep, on=join_keys, how="inner")
    if merged.is_empty():
        return None

    group_keys = p_cols + ["reference_date", "location", "horizon", "target_end_date"] + extra_cols
    if merged.select(group_keys + ["output_type_id"]).is_duplicated().any():
        merged = merged.unique(subset=group_keys + ["output_type_id"], keep="first", maintain_order=True)

    return merged, group_keys, extra_cols, is_non_neg, neg_clipped_count


def score_task_wis(
    forecast_df: Union[pl.DataFrame, pl.LazyFrame, Any],
    oracle_df: Union[pl.DataFrame, pl.LazyFrame, Any],
    target: str = "wk inc flu hosp",
    *,
    locations: Optional[List[str]] = None,
    reference_dates: Optional[List[str]] = None,
    horizons: Optional[List[int]] = None,
    non_negative: Optional[bool] = None,
    extra_task_ids: Optional[Sequence[str]] = None,
    preserve_cols: Optional[Sequence[str]] = None,
) -> pl.DataFrame:
    """Fast per-task WIS scorer: computes exact pinball-mean `wis` without pivots or summaries."""
    prepared = _norm_and_join_quantiles(
        forecast_df,
        oracle_df,
        target=target,
        locations=locations,
        reference_dates=reference_dates,
        horizons=horizons,
        non_negative=non_negative,
        extra_task_ids=extra_task_ids,
        preserve_cols=preserve_cols,
        count_negatives=False,
    )
    if prepared is None:
        return pl.DataFrame()
    merged, group_keys, _, _, _ = prepared
    qloss_expr = (
        2.0
        * ((pl.col("oracle_value") < pl.col("value")).cast(pl.Float64) - pl.col("output_type_id"))
        * (pl.col("value") - pl.col("oracle_value"))
    )
    return merged.group_by(group_keys).agg(qloss_expr.mean().alias("wis"))


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
    prepared = _norm_and_join_quantiles(
        forecast_df,
        oracle_df,
        target=target,
        locations=locations,
        reference_dates=reference_dates,
        horizons=horizons,
        common_tasks=common_tasks,
        non_negative=non_negative,
        extra_task_ids=extra_task_ids,
        count_negatives=True,
    )
    if prepared is None:
        return {}
    merged, group_keys, extra_cols, is_non_neg, neg_clipped_count = prepared

    present_quantiles = sorted(merged.get_column("output_type_id").unique().to_list())
    has_std_7 = set(STANDARD_7_QUANTILES).issubset(set(present_quantiles))

    qloss_expr = (
        2.0
        * ((pl.col("oracle_value") < pl.col("value")).cast(pl.Float64) - pl.col("output_type_id"))
        * (pl.col("value") - pl.col("oracle_value"))
    )
    loss_cols: List[pl.Expr] = [qloss_expr.alias("qloss")]
    if is_non_neg:
        log_oracle = (pl.col("oracle_value").clip(lower_bound=0.0) + 1.0).log()
        log_pred = (pl.col("value").clip(lower_bound=0.0) + 1.0).log()
        loss_cols.append(
            (
                2.0
                * ((log_oracle < log_pred).cast(pl.Float64) - pl.col("output_type_id"))
                * (log_pred - log_oracle)
            ).alias("qloss_log")
        )

    merged = merged.with_columns(loss_cols)

    wis_aggs: List[pl.Expr] = [
        pl.col("qloss").mean().alias("wis"),
        pl.col("qloss_log").mean().alias("wis_log") if is_non_neg else pl.lit(None, dtype=pl.Float64).alias("wis_log"),
        (
            pl.col("qloss").filter(pl.col("output_type_id").is_in(STANDARD_7_QUANTILES)).mean().alias("wis_7")
            if has_std_7
            else pl.lit(None, dtype=pl.Float64).alias("wis_7")
        ),
    ]
    wis_series = merged.group_by(group_keys).agg(wis_aggs)

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
    Score categorical or ordinal PMF forecasts (Ranked Probability Score, Log Score, Brier Score, Hit Rate)
    using vectorized Polars category aggregation and NumPy matrix operations.
    """
    f = _prepare_forecast_frame(
        forecast_df,
        target=target,
        output_type="pmf",
        locations=locations,
        reference_dates=reference_dates,
        horizons=horizons,
    )
    o = _prepare_oracle_frame(oracle_df, target)
    if f is None or o is None or f.is_empty() or o.is_empty():
        return {}

    extra_cols = _resolve_extra_task_ids(f.columns, o.columns, extra_task_ids)
    f = f.with_columns(
        [
            pl.col("location").cast(pl.String),
            pl.col("horizon").fill_null(0).cast(pl.Int32),
            pl.col("output_type_id").cast(pl.String).str.strip_chars(),
            pl.col("value").cast(pl.Float64),
            pl.col("reference_date").cast(pl.String),
            pl.col("target_end_date").cast(pl.String),
            pl.col("target").cast(pl.String),
        ]
        + [pl.col(ec).cast(pl.String) for ec in extra_cols]
    )
    f = f.drop_nulls(subset=["value", "output_type_id", "target_end_date", "location", "horizon"] + extra_cols)
    if f.is_empty():
        return {}

    o_true, okeys = _prepared_pmf_oracle(o, target, extra_task_ids=extra_cols)
    if o_true.is_empty():
        return {}

    merged = f.join(o_true, on=okeys, how="inner")
    if merged.is_empty():
        return {}

    if categories:
        cat_order = [str(c) for c in categories]
    else:
        cat_order = sorted(
            set(merged.get_column("output_type_id").unique().to_list())
            | set(merged.get_column("true_category").unique().to_list())
        )
    K = len(cat_order)
    if K == 0:
        return {}
    cat_idx = {c: i for i, c in enumerate(cat_order)}
    group_keys = ["reference_date", "location", "horizon", "target_end_date"] + extra_cols

    # Keep all tasks with a valid observed category (even if all predicted probabilities are 0 / unmapped)
    with_y = merged.with_columns(
        pl.col("true_category").replace_strict(cat_idx, default=-1, return_dtype=pl.Int32).alias("_y_idx"),
        pl.col("output_type_id").replace_strict(cat_idx, default=-1, return_dtype=pl.Int32).alias("_c_idx"),
    ).filter(pl.col("_y_idx") >= 0)
    if with_y.is_empty():
        return {}

    tasks = (
        with_y.group_by(group_keys, maintain_order=True)
        .agg(
            pl.col("_y_idx").first().alias("_y_idx"),
            pl.col("true_category").first().alias("true_category"),
        )
        .with_row_index("_tid")
    )
    n_tasks = tasks.height
    if n_tasks == 0:
        return {}

    valid_mass = (
        with_y.filter((pl.col("_c_idx") >= 0) & pl.col("value").is_finite() & (pl.col("value") > 0.0))
        .group_by(group_keys + ["_c_idx"], maintain_order=False)
        .agg(pl.col("value").sum().alias("_p"))
    )
    P = np.zeros((n_tasks, K), dtype=np.float64)
    if not valid_mass.is_empty():
        indexed = valid_mass.join(tasks.select(group_keys + ["_tid"]), on=group_keys, how="inner")
        if not indexed.is_empty():
            P[
                indexed.get_column("_tid").to_numpy(),
                indexed.get_column("_c_idx").to_numpy(),
            ] = indexed.get_column("_p").to_numpy()

    y_idx = tasks.get_column("_y_idx").to_numpy()
    totals = P.sum(axis=1)
    need_norm = (totals > 0.0) & (np.abs(totals - 1.0) > 1e-6)
    if np.any(need_norm):
        P[need_norm] /= totals[need_norm, None]

    row_ar = np.arange(n_tasks)
    p_obs = P[row_ar, y_idx]
    log_score = -np.log(np.maximum(p_obs, LOG_SCORE_FLOOR))
    brier = np.sum(P * P, axis=1) - 2.0 * p_obs + 1.0
    hit_mode = ((totals > 0.0) & (np.argmax(P, axis=1) == y_idx)).astype(np.float64)

    task_cols: List[Any] = [
        pl.Series("p_observed", p_obs, dtype=pl.Float64),
        pl.Series("log_score", log_score, dtype=pl.Float64),
        pl.Series("brier", brier, dtype=pl.Float64),
        pl.Series("hit_mode", hit_mode, dtype=pl.Float64),
    ]
    if ordinal and K > 1:
        cdf = np.cumsum(P, axis=1)
        truth_cdf = (np.arange(K)[None, :] >= y_idx[:, None]).astype(np.float64)
        rps = np.sum((cdf - truth_cdf) ** 2, axis=1)
        task_cols.append(pl.Series("rps", rps, dtype=pl.Float64))
    else:
        task_cols.append(pl.lit(None, dtype=pl.Float64).alias("rps"))

    task_df = tasks.drop(["_tid", "_y_idx"]).with_columns(task_cols)

    agg_set = {str(x) for x in aggregate_locations} if aggregate_locations is not None else {"US"}
    agg_list = sorted(agg_set)
    is_agg_expr = pl.col("location").is_in(agg_list) if agg_list else pl.lit(False)
    has_primary_val, has_agg_val = task_df.select((~is_agg_expr).any().alias("_hp"), is_agg_expr.any().alias("_ha")).row(0)
    has_primary = bool(has_primary_val)
    has_agg = bool(has_agg_val)
    primary_df = task_df.filter(~is_agg_expr) if has_primary else task_df.filter(is_agg_expr)

    pmf_aggs = [
        (pl.col("rps").mean().alias("rps") if (ordinal and K > 1) else pl.lit(None, dtype=pl.Float64).alias("rps")),
        pl.col("log_score").mean().alias("log_score"),
        pl.col("brier").mean().alias("brier"),
        (pl.col("hit_mode").mean() * 100.0).alias("hit_mode"),
        pl.len().alias("count"),
    ]

    def _pmf_row_to_dict(row: Dict[str, Any]) -> Dict[str, Any]:
        if not row or int(row.get("count") or 0) == 0:
            return {"rps": None, "log_score": None, "brier": None, "hit_mode": None, "count": 0}
        return {
            "rps": _finite_float(row.get("rps")) if (ordinal and K > 1) else None,
            "log_score": float(row["log_score"]),
            "brier": float(row["brier"]),
            "hit_mode": float(row["hit_mode"]),
            "count": int(row["count"]),
        }

    overall = _pmf_row_to_dict(primary_df.select(pmf_aggs).to_dicts()[0]) if not primary_df.is_empty() else _pmf_row_to_dict({})
    states_summary = dict(overall) if has_primary else None
    if has_agg:
        us_summary = (
            _pmf_row_to_dict(task_df.filter(is_agg_expr).select(pmf_aggs).to_dicts()[0])
            if has_primary
            else dict(overall)
        )
    else:
        us_summary = None

    by_horizon: Dict[int, Dict[str, Any]] = {}
    if not primary_df.is_empty():
        for row in primary_df.group_by("horizon").agg(pmf_aggs).sort("horizon").to_dicts():
            h_val = row.get("horizon")
            if h_val is not None:
                by_horizon[int(h_val)] = _pmf_row_to_dict(row)

    evaluated_dates = sorted(task_df.get_column("reference_date").unique().to_list())
    distinct_locs = sorted(task_df.get_column("location").unique().to_list())

    out: Dict[str, Any] = {
        "overall": overall,
        "states": states_summary,
        "us": us_summary,
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
            "aggregate_locations": agg_list,
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
    y_val = float(y)
    if not np.isfinite(y_val):
        return float("nan")
    x = np.asarray(samples, dtype=np.float64).ravel()
    x = np.sort(x[np.isfinite(x)])
    m = x.size
    if m == 0:
        return float("nan")
    term1 = float(np.mean(np.abs(x - y_val)))
    if m == 1:
        return term1
    weights = (2.0 * np.arange(m, dtype=np.float64) - m + 1.0)
    term2 = float(np.dot(weights, x)) / (m * m)
    return max(0.0, term1 - term2)


@functools.lru_cache(maxsize=64)
def _triu_idx(m: int) -> Tuple[np.ndarray, np.ndarray]:
    """Cached strictly-upper-triangular index pairs for exact pairwise Euclidean sums."""
    return np.triu_indices(m, k=1)


def energy_score(trajectories: np.ndarray, y_vec: np.ndarray) -> float:
    """
    Multi-horizon Energy Score over M trajectories in R^D (trajectories shape `(M, D)`, `y_vec` shape `(D,)`):
        ES = (1/M) * sum ||X_i - y||_2 - (1/(2 M^2)) * sum_{i,j} ||X_i - X_j||_2
    """
    X = np.asarray(trajectories, dtype=np.float64)
    y = np.asarray(y_vec, dtype=np.float64)
    if X.ndim != 2 or X.shape[0] == 0 or X.shape[1] == 0 or y.shape != (X.shape[1],) or not np.all(np.isfinite(y)):
        return float("nan")
    X = X[np.all(np.isfinite(X), axis=1)]
    m = X.shape[0]
    if m == 0:
        return float("nan")
    term1 = float(np.mean(np.linalg.norm(X - y, axis=1)))
    if m == 1:
        return term1
    if m <= 256:
        iu, ju = _triu_idx(m)
        pair_dists = np.linalg.norm(X[iu] - X[ju], axis=1)
        term2 = float(pair_dists.sum()) / (m * m)
    else:
        total_pair = 0.0
        step = 128
        for start in range(0, m, step):
            stop = min(m, start + step)
            diffs = X[start:stop, None, :] - X[None, :, :]
            total_pair += float(np.linalg.norm(diffs, axis=2).sum())
        term2 = 0.5 * total_pair / (m * m)
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
    """Score probabilistic sample trajectories via pure-Polars exact O(M log M) CRPS and batched Energy Score."""
    f = _prepare_forecast_frame(
        sample_df,
        target=target,
        output_type="sample",
        locations=locations,
        reference_dates=reference_dates,
        horizons=horizons,
    )
    o = _prepare_oracle_frame(oracle_df, target)
    if f is None or o is None or f.is_empty() or o.is_empty():
        return {}

    extra_cols = _resolve_extra_task_ids(f.columns, o.columns, extra_task_ids)
    f = f.with_columns(
        [
            pl.col("location").cast(pl.String),
            pl.col("horizon").fill_null(0).cast(pl.Int32),
            pl.col("output_type_id").cast(pl.String),
            pl.col("value").cast(pl.Float64),
            pl.col("reference_date").cast(pl.String),
            pl.col("target_end_date").cast(pl.String),
            pl.col("target").cast(pl.String),
        ]
        + [pl.col(ec).cast(pl.String) for ec in extra_cols]
    )
    f = f.drop_nulls(subset=["value", "output_type_id", "target_end_date", "location", "horizon"] + extra_cols)
    if f.is_empty():
        return {}

    o_prep, join_keys = _prepared_oracle(o, target, extra_task_ids=extra_cols)
    merged = f.join(o_prep, on=join_keys, how="inner")
    if merged.is_empty():
        return {}

    valid = merged.filter(pl.col("value").is_finite() & pl.col("oracle_value").is_finite())
    if valid.is_empty():
        return {}

    group_keys = ["reference_date", "location", "horizon", "target_end_date"] + extra_cols
    m_expr = pl.len().over(group_keys).cast(pl.Float64)
    task_df = (
        valid.sort(group_keys + ["value"])
        .with_columns(
            pl.int_range(0, pl.len()).over(group_keys).cast(pl.Float64).alias("_i"),
            m_expr.alias("_m"),
        )
        .group_by(group_keys, maintain_order=True)
        .agg(
            pl.col("oracle_value").first().alias("oracle_value"),
            (
                (pl.col("value") - pl.col("oracle_value")).abs().mean()
                - ((2.0 * pl.col("_i") - pl.col("_m") + 1.0) * pl.col("value")).sum()
                / (pl.col("_m").first() * pl.col("_m").first())
            )
            .clip(lower_bound=0.0)
            .alias("crps"),
            pl.len().cast(pl.Int64).alias("n_samples"),
        )
    )

    agg_set = {str(x) for x in aggregate_locations} if aggregate_locations is not None else {"US"}
    agg_list = sorted(agg_set)
    is_agg_expr = pl.col("location").is_in(agg_list) if agg_list else pl.lit(False)
    has_primary = bool(task_df.select((~is_agg_expr).any()).item())
    primary_df = task_df.filter(~is_agg_expr) if has_primary else task_df.filter(is_agg_expr)

    mean_energy: Optional[float] = None
    energy_df: Optional[pl.DataFrame] = None
    if compute_energy_score and valid.height > 0:
        round_keys = ["reference_date", "location"] + extra_cols
        piv_x = valid.pivot(
            on="horizon",
            index=round_keys + ["output_type_id"],
            values="value",
            aggregate_function="first",
        )
        h_cols = [c for c in piv_x.columns if c not in round_keys and c != "output_type_id"]
        if len(h_cols) >= 2:
            tasks_es = (
                valid.group_by(round_keys + ["horizon"], maintain_order=True)
                .agg(pl.col("oracle_value").first())
                .pivot(on="horizon", index=round_keys, values="oracle_value", aggregate_function="first")
                .with_row_index("_gid")
            )
            y_sel = [
                pl.col(c).cast(pl.Float64) if c in tasks_es.columns else pl.lit(None, dtype=pl.Float64).alias(c)
                for c in h_cols
            ]
            Y_all = tasks_es.select(y_sel).to_numpy()
            piv_x_g = (
                piv_x.join(tasks_es.select(round_keys + ["_gid"]), on=round_keys, how="inner")
                .sort("_gid", maintain_order=True)
            )
            gids_arr = piv_x_g.get_column("_gid").to_numpy()
            n_rows_x = len(gids_arr)
            if n_rows_x > 0:
                X_all = piv_x_g.select([pl.col(c).cast(pl.Float64) for c in h_cols]).to_numpy()
                locs_list = tasks_es.get_column("location").to_list()
                chg = np.flatnonzero(gids_arr[1:] != gids_arr[:-1]) + 1
                starts = np.concatenate(([0], chg))
                ends = np.concatenate((chg, [n_rows_x]))
                kept_gids: List[int] = []
                kept_scores: List[float] = []
                primary_es_vals: List[float] = []

                for s_idx, e_idx in zip(starts, ends):
                    if e_idx - s_idx < 2:
                        continue
                    gid = int(gids_arr[s_idx])
                    X_g = X_all[s_idx:e_idx]
                    y_g = Y_all[gid]
                    present_h = ~np.all(np.isnan(X_g), axis=0) & np.isfinite(y_g)
                    if int(present_h.sum()) < 2:
                        continue
                    X_sub = X_g[:, present_h]
                    valid_rows = np.all(np.isfinite(X_sub), axis=1)
                    if not np.all(valid_rows):
                        if int(valid_rows.sum()) < 2:
                            continue
                        X_sub = X_sub[valid_rows]
                    if X_sub.shape[0] > 200:
                        idx = np.linspace(0, X_sub.shape[0] - 1, 200, dtype=int)
                        X_sub = X_sub[idx]
                    es_v = energy_score(X_sub, y_g[present_h])
                    if math.isfinite(es_v):
                        kept_gids.append(gid)
                        kept_scores.append(es_v)
                        if not has_primary or str(locs_list[gid]) not in agg_set:
                            primary_es_vals.append(es_v)

                if primary_es_vals:
                    mean_energy = float(np.mean(primary_es_vals))
                if kept_gids and return_task_df:
                    energy_df = (
                        tasks_es[kept_gids]
                        .select(round_keys)
                        .with_columns(
                            pl.lit(0, dtype=pl.Int64).alias("horizon"),
                            pl.Series("energy_score", kept_scores, dtype=pl.Float64),
                        )
                    )

    by_horizon: Dict[int, Dict[str, Any]] = {}
    if not primary_df.is_empty():
        for h_val, crps_mean, cnt in (
            primary_df.group_by("horizon")
            .agg(pl.col("crps").mean().alias("crps"), pl.len().alias("count"))
            .sort("horizon")
            .iter_rows()
        ):
            by_horizon[int(h_val)] = {"crps": float(crps_mean), "count": int(cnt)}

    evaluated_dates = sorted(task_df.get_column("reference_date").unique().to_list())
    distinct_locs = sorted(task_df.get_column("location").unique().to_list())
    overall_crps = primary_df.select(pl.col("crps").mean()).item() if not primary_df.is_empty() else None

    out: Dict[str, Any] = {
        "overall": {
            "crps": float(overall_crps) if overall_crps is not None else float("nan"),
            "energy_score": mean_energy,
            "count": int(primary_df.height),
        },
        "by_horizon": by_horizon,
        "metadata": {
            "evaluated_dates": evaluated_dates,
            "dates_count": len(evaluated_dates),
            "locations_count": len(distinct_locs),
            "states_count": len([loc for loc in distinct_locs if loc not in agg_set]),
            "total_tasks": task_df.height,
        },
    }
    if return_task_df:
        out["task_df"] = task_df
        out["energy_df"] = energy_df
    return out


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
