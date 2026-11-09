"""
High-performance forecast evaluation and scoring engine for the Sandbox.
Built on Polars for vectorized, multithreaded SIMD execution across Apple Silicon and x86_64.

Implements CDC FluSight and Hubverse evaluation methodology (Bracher et al. 2021, Cramer et al. 2022):
- Weighted Interval Score (WIS) via pinball loss formulation (mathematically identical to interval score sum:
  WIS = 1/(K + 0.5) * [ 0.5 * |y - m| + sum_{k=1}^K (alpha_k / 2) * IS_{alpha_k}(y) ]
  When pinball loss is formulated as 2 * (I(y < q) - alpha) * (q - y), the mean pinball loss across
  all 2K + 1 symmetric quantiles is mathematically identical to WIS).
- Pairwise Tournament Relative WIS (Cramer et al. 2022 Hubverse standard)
- Population-standardized Rate WIS (per 100,000 population) to prevent large-state dominance
- Mean Absolute Error (MAE)
- Empirical Coverage (95% CI target: 95.0%, 50% CI target: 50.0%)
- Sharpness (mean 95% prediction interval width)
- Strict backtesting integrity:
  * Separation of national (US) and state-level pooling to avoid scale distortion
  * Fair common task intersection across models with unbalanced dates/locations
  * Standardized 7-quantile comparison for models run with fast/short test configs
  * Horizon-by-horizon breakdown including h=0 (nowcast) and h=1..4 (projections)
  * Exact Bracher et al. error decomposition (sharpness + overprediction + underprediction == WIS)
  * Robust deduplication safety against accidental duplicate quantile rows in model submissions
"""

import math
import threading
from typing import Dict, List, Optional, Tuple, Any, Set, Union
import numpy as np
import polars as pl

from viz.core.parallel import ordered_map_outcomes

STANDARD_7_QUANTILES = [0.025, 0.10, 0.25, 0.50, 0.75, 0.90, 0.975]
STANDARD_23_QUANTILES = [
    0.01, 0.025, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30,
    0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70,
    0.75, 0.80, 0.85, 0.90, 0.95, 0.975, 0.99,
]


def find_quantile_column(columns: List[str], q_val: float) -> Optional[str]:
    """
    Robust resolver for quantile column names in DataFrames.
    Matches exact string representations ('0.025'), rounded forms ('0.025', '0.03', '0.5'),
    and floating point proximity (< 1e-4).
    """
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
    """
    Compute pinball loss (quantile loss):
    2 * ( I(y < q) - alpha ) * (q - y)

    For symmetric quantiles, the mean pinball loss is mathematically identical
    to the weighted interval score (WIS) interval decomposition (Bracher et al. 2021).
    """
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
    # Dynamic compatibility with pandas DataFrames if passed, without requiring top-level import
    if hasattr(data, "to_dict") and hasattr(data, "columns"):
        try:
            return pl.from_pandas(data)
        except Exception:
            return None
    return None


def _prepare_oracle(o: pl.DataFrame, target: str) -> Tuple[pl.DataFrame, List[str]]:
    """Truth rows for one target, one value per join key, plus the keys to join forecasts on."""
    if "target" in o.columns:
        o = o.filter(pl.col("target") == target)

    cast_oracle = [
        pl.col("location").cast(pl.String),
        pl.col("target_end_date").cast(pl.String),
        pl.col("oracle_value").cast(pl.Float64),
    ]
    if "horizon" in o.columns:
        cast_oracle.append(pl.col("horizon").cast(pl.Int32))

    o = o.with_columns([c for c in cast_oracle if c.meta.output_name() in o.columns])

    # Check if oracle has distinct values across horizons for the same (location, target_end_date)
    has_meaningful_horizon = False
    if "horizon" in o.columns:
        valid_h = o.filter(pl.col("horizon").is_not_null())
        if valid_h.height > 0:
            n_loc_date = valid_h.select(["location", "target_end_date"]).n_unique()
            n_loc_date_h = valid_h.select(["location", "target_end_date", "horizon"]).n_unique()
            if n_loc_date_h > n_loc_date:
                n_with_vals = valid_h.select(["location", "target_end_date", "oracle_value"]).n_unique()
                if n_with_vals > n_loc_date:
                    has_meaningful_horizon = True

    if has_meaningful_horizon:
        if "as_of" in o.columns:
            o = o.sort("as_of").group_by(["target_end_date", "location", "horizon"]).last()
        o = (
            o.select(["target_end_date", "location", "horizon", "oracle_value"])
            .drop_nulls()
            .unique(subset=["target_end_date", "location", "horizon"])
        )
        join_keys = ["target_end_date", "location", "horizon"]
    else:
        if "as_of" in o.columns:
            o = o.sort("as_of").group_by(["target_end_date", "location"]).last()
        o = (
            o.select(["target_end_date", "location", "oracle_value"])
            .drop_nulls()
            .unique(subset=["target_end_date", "location"])
        )
        join_keys = ["target_end_date", "location"]
    return o, join_keys


# (oracle object, target) -> prepared truth. Keyed on object identity; the entry keeps a reference to the
# oracle frame so its id() can never be reused by another object while the entry exists.
_ORACLE_MEMO: Dict[Tuple[int, str], Tuple[pl.DataFrame, pl.DataFrame, List[str]]] = {}
_ORACLE_MEMO_LOCK = threading.Lock()
_ORACLE_MEMO_MAX = 8


def _prepared_oracle(o: pl.DataFrame, target: str) -> Tuple[pl.DataFrame, List[str]]:
    key = (id(o), target)
    with _ORACLE_MEMO_LOCK:
        hit = _ORACLE_MEMO.get(key)
    if hit is not None and hit[0] is o:
        return hit[1], list(hit[2])
    prepared, join_keys = _prepare_oracle(o, target)
    with _ORACLE_MEMO_LOCK:
        if len(_ORACLE_MEMO) >= _ORACLE_MEMO_MAX:
            _ORACLE_MEMO.clear()
        _ORACLE_MEMO[key] = (o, prepared, list(join_keys))
    return prepared, join_keys


def score_forecasts(
    forecast_df: Union[pl.DataFrame, pl.LazyFrame, Any],
    oracle_df: Union[pl.DataFrame, pl.LazyFrame, Any],
    target: str = "wk inc flu hosp",
    locations: Optional[List[str]] = None,
    reference_dates: Optional[List[str]] = None,
    horizons: Optional[List[int]] = None,
    common_tasks: Optional[Union[Set[Tuple[str, str, int]], pl.DataFrame, List[Tuple[str, str, int]]]] = None,
    non_negative: Optional[bool] = None,
    population_map: Optional[Dict[str, int]] = None,
    return_task_df: bool = False,
) -> Dict[str, Any]:
    """
    Score a forecast DataFrame against oracle truth DataFrame with rigorous validation.
    Optimized with Polars SIMD expressions across Apple Silicon and multithreaded CPUs.

    Parameters:
        forecast_df: Model predictions (Polars DataFrame or LazyFrame)
        oracle_df: Ground truth observations
        target: Evaluation target ('wk inc flu hosp', 'wk inc flu prop ed visits')
        locations: List of location FIPS or 'US'. If None or contains both US and states,
                   state-level evaluation is separated from national.
        reference_dates: List of reference dates to score.
        horizons: List of integer horizons (e.g. [0, 1, 2, 3]).
        common_tasks: Optional set or DataFrame of (reference_date, location, horizon) tuples to
                      enforce strict intersection evaluation against other models.
        non_negative: Whether to constrain predictions to non-negative values (defaults to target heuristics).
        population_map: Optional mapping of location code -> population to compute population-rate WIS (per 100k).
        return_task_df: If True, include per-task evaluation DataFrame in returned dictionary.

    Returns:
        Dictionary containing overall, states, us, by_horizon, evaluation metadata, and optional task_df.
    """
    f = _to_polars_df(forecast_df)
    o = _to_polars_df(oracle_df)

    if f is None or o is None or f.is_empty() or o.is_empty():
        return {}

    # Standardize column types
    cast_exprs = [
        pl.col("location").cast(pl.String),
        pl.col("horizon").fill_null(0).cast(pl.Int32),
        pl.col("output_type_id").cast(pl.Float64).round(3),
        pl.col("value").cast(pl.Float64),
        pl.col("reference_date").cast(pl.String),
        pl.col("target_end_date").cast(pl.String),
        pl.col("target").cast(pl.String),
    ]
    f = f.with_columns([c for c in cast_exprs if c.meta.output_name() in f.columns])

    # Filter target and output_type
    f = f.filter(pl.col("target") == target)
    if "output_type" in f.columns:
        f = f.filter(pl.col("output_type") == "quantile")

    # Drop nulls
    f = f.drop_nulls(subset=["value", "output_type_id", "target_end_date", "location", "horizon"])

    # Non-negative constraint for count/incidence/proportion targets
    is_non_neg = non_negative if non_negative is not None else any(
        k in target.lower() for k in ["hosp", "inc", "count", "prop", "visit", "death", "case", "admiss"]
    )
    neg_clipped_count = 0
    if is_non_neg:
        neg_rows = f.filter(pl.col("value") < 0.0)
        neg_clipped_count = neg_rows.height
        if neg_clipped_count > 0:
            f = f.with_columns(pl.col("value").clip(lower_bound=0.0))

    # Filter locations
    if locations is not None and len(locations) > 0 and "all" not in locations:
        f = f.filter(pl.col("location").is_in(locations))

    # Filter reference dates
    if reference_dates is not None and len(reference_dates) > 0 and "all" not in reference_dates:
        f = f.filter(pl.col("reference_date").is_in(reference_dates))

    # Filter horizons
    if horizons is not None and len(horizons) > 0:
        f = f.filter(pl.col("horizon").is_in(horizons))

    # Apply common task intersection filter if provided
    if common_tasks is not None:
        if len(common_tasks) == 0:
            return {}
        if isinstance(common_tasks, pl.DataFrame):
            task_df = common_tasks
        else:
            task_list = list(common_tasks)
            task_df = pl.DataFrame({
                "reference_date": [str(t[0]) for t in task_list],
                "location": [str(t[1]) for t in task_list],
                "horizon": [int(t[2]) for t in task_list],
            })
        f = f.join(task_df, on=["reference_date", "location", "horizon"], how="inner")

    if f.is_empty():
        return {}

    # Inspect quantiles present in forecast
    present_quantiles = sorted(f.select(pl.col("output_type_id").unique()).to_series().to_list())
    quantile_count = len(present_quantiles)
    has_std_7 = set(STANDARD_7_QUANTILES).issubset(set(present_quantiles))
    has_std_23 = set(STANDARD_23_QUANTILES).issubset(set(present_quantiles))

    # Clean and filter oracle truth (identical for every model scored against the same oracle, so memoized)
    o, join_keys = _prepared_oracle(o, target)

    # Merge forecasts with oracle truth
    merged = f.join(o, on=join_keys, how="inner")
    if merged.is_empty():
        return {}

    group_keys = ["reference_date", "location", "horizon", "target_end_date"]

    # Deduplicate before scoring if submission contained duplicate quantiles for the same task
    if merged.select(group_keys + ["output_type_id"]).is_duplicated().any():
        merged = merged.unique(subset=group_keys + ["output_type_id"], keep="first", maintain_order=True)

    # Compute quantile pinball loss per row (both natural count scale and log scale ln(y + 1))
    oracle_nonneg = pl.col("oracle_value").clip(lower_bound=0.0)
    pred_nonneg = pl.col("value").clip(lower_bound=0.0)
    log_oracle = (oracle_nonneg + 1.0).log()
    log_pred = (pred_nonneg + 1.0).log()

    merged = merged.with_columns([
        (
            2.0
            * ((pl.col("oracle_value") < pl.col("value")).cast(pl.Float64) - pl.col("output_type_id"))
            * (pl.col("value") - pl.col("oracle_value"))
        ).alias("qloss"),
        (
            2.0
            * ((log_oracle < log_pred).cast(pl.Float64) - pl.col("output_type_id"))
            * (log_pred - log_oracle)
        ).alias("qloss_log"),
    ])

    # 1. Primary WIS: mean pinball loss across all available quantiles for this forecast unit
    wis_series = merged.group_by(group_keys).agg([
        pl.col("qloss").mean().alias("wis"),
        pl.col("qloss_log").mean().alias("wis_log"),
    ])

    # Standardized 7-quantile WIS for fair comparison between short runs and full runs
    if has_std_7:
        wis7_df = (
            merged.filter(pl.col("output_type_id").is_in(STANDARD_7_QUANTILES))
            .group_by(group_keys)
            .agg([pl.col("qloss").mean().alias("wis_7")])
        )
        wis_series = wis_series.join(wis7_df, on=group_keys, how="left")
    else:
        wis_series = wis_series.with_columns(pl.lit(None, dtype=pl.Float64).alias("wis_7"))

    # 2. Pivot quantiles for MAE, coverage, sharpness, and Bracher error decomposition
    piv = merged.pivot(
        on="output_type_id",
        index=group_keys + ["oracle_value"],
        values="value",
        aggregate_function="first",
    )

    piv_cols = piv.columns

    # Detect present quantile columns in pivoted table
    quantiles_in_piv = []
    for c in piv_cols:
        try:
            val = float(c)
            quantiles_in_piv.append(val)
        except ValueError:
            pass
    quantiles_in_piv.sort()

    new_cols = []

    # Median MAE (q0.50) on natural scale and log scale ln(y + 1)
    col_med = find_quantile_column(piv_cols, 0.50)
    if col_med is not None:
        new_cols.append((pl.col("oracle_value") - pl.col(col_med)).abs().alias("mae"))
        new_cols.append(
            (
                (pl.col("oracle_value").clip(lower_bound=0.0) + 1.0).log()
                - (pl.col(col_med).clip(lower_bound=0.0) + 1.0).log()
            ).abs().alias("mae_log")
        )
    else:
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("mae"))
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("mae_log"))

    # 95% Coverage & Sharpness: oracle in [q0.025, q0.975]
    col_0025 = find_quantile_column(piv_cols, 0.025)
    col_0975 = find_quantile_column(piv_cols, 0.975)
    has_95 = (col_0025 is not None) and (col_0975 is not None)
    if has_95:
        new_cols.append(
            ((pl.col("oracle_value") >= pl.col(col_0025)) & (pl.col("oracle_value") <= pl.col(col_0975)))
            .cast(pl.Float64)
            .alias("cov95")
        )
        new_cols.append((pl.col(col_0975) - pl.col(col_0025)).clip(lower_bound=0.0).alias("sharpness"))
    else:
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("cov95"))
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("sharpness"))

    # 50% Coverage: oracle in [q0.25, q0.75]
    col_025 = find_quantile_column(piv_cols, 0.25)
    col_075 = find_quantile_column(piv_cols, 0.75)
    has_50 = (col_025 is not None) and (col_075 is not None)
    if has_50:
        new_cols.append(
            ((pl.col("oracle_value") >= pl.col(col_025)) & (pl.col("oracle_value") <= pl.col(col_075)))
            .cast(pl.Float64)
            .alias("cov50")
        )
    else:
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("cov50"))

    # Find symmetric pairs for Bracher decomposition & calibration curve
    sym_pairs = []
    for q_val in quantiles_in_piv:
        if q_val < 0.5:
            q_partner = round(1.0 - q_val, 4)
            c_low = find_quantile_column(piv_cols, q_val)
            c_high = find_quantile_column(piv_cols, q_partner)
            if c_low is not None and c_high is not None:
                sym_pairs.append((q_val, c_low, c_high))

    K_pairs = len(sym_pairs)
    has_decomp = (K_pairs > 0) and (col_med is not None)

    if has_decomp:
        norm_factor = 1.0 / (K_pairs + 0.5)
        # Median contribution: 0.5 * max(0, m - y) and 0.5 * max(0, y - m)
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
        over_sum = pl.sum_horizontal(over_terms)
        under_sum = pl.sum_horizontal(under_terms)

        new_cols.append((sharp_sum * norm_factor).alias("decomp_sharpness"))
        new_cols.append((over_sum * norm_factor).alias("decomp_overpred"))
        new_cols.append((under_sum * norm_factor).alias("decomp_underpred"))
    else:
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("decomp_sharpness"))
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("decomp_overpred"))
        new_cols.append(pl.lit(None, dtype=pl.Float64).alias("decomp_underpred"))

    piv = piv.with_columns(new_cols)

    # Combine metrics per forecast unit
    eval_df = wis_series.join(piv, on=group_keys, how="inner")

    # Add population rate standardization if population map provided
    if population_map:
        pop_df = pl.DataFrame({
            "location": [str(k) for k in population_map.keys()],
            "population": [int(v) for v in population_map.values()],
        })
        eval_df = eval_df.join(pop_df, on="location", how="left")
        eval_df = eval_df.with_columns([
            pl.when((pl.col("population").is_not_null()) & (pl.col("population") > 0))
            .then((pl.col("wis") / pl.col("population")) * 100000.0)
            .otherwise(None)
            .alias("wis_per_100k")
        ])
    else:
        eval_df = eval_df.with_columns(pl.lit(None, dtype=pl.Float64).alias("wis_per_100k"))

    # Statistical Separation: National (US) vs States
    is_us_col = eval_df["location"] == "US"
    has_states = bool((~is_us_col).any())
    has_us_data = bool(is_us_col.any())

    # Primary benchmark: if states present, overall is state benchmark (excluding US)
    if has_states:
        primary_eval = eval_df.filter(pl.col("location") != "US")
    else:
        primary_eval = eval_df.filter(pl.col("location") == "US")

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

        # Vectorized aggregation expressions
        agg_exprs = [
            pl.col("wis").mean().alias("wis"),
            pl.col("wis_log").mean().alias("wis_log") if "wis_log" in df_slice.columns else pl.lit(None, dtype=pl.Float64).alias("wis_log"),
            pl.col("wis_7").mean().alias("wis_7"),
            pl.col("wis_per_100k").mean().alias("wis_per_100k"),
            pl.col("mae").mean().alias("mae"),
            pl.col("mae_log").mean().alias("mae_log") if "mae_log" in df_slice.columns else pl.lit(None, dtype=pl.Float64).alias("mae_log"),
            pl.col("cov95").mean().alias("cov95"),
            pl.col("cov50").mean().alias("cov50"),
            pl.col("sharpness").mean().alias("sharpness"),
            pl.col("decomp_sharpness").mean().alias("decomp_sharpness"),
            pl.col("decomp_overpred").mean().alias("decomp_overpred"),
            pl.col("decomp_underpred").mean().alias("decomp_underpred"),
            pl.len().alias("count"),
        ]

        # Calibration columns
        calib_cols = [c for c in df_slice.columns if c.startswith("cov_") and c not in ("cov95", "cov50")]
        for c in calib_cols:
            agg_exprs.append(pl.col(c).mean().alias(c))

        res_row = df_slice.select(agg_exprs).to_dicts()[0]

        wis_val = res_row.get("wis")
        wis_log_val = res_row.get("wis_log")
        wis7_val = res_row.get("wis_7")
        wis_rate_val = res_row.get("wis_per_100k")
        mae_val = res_row.get("mae")
        mae_log_val = res_row.get("mae_log")
        cov95_val = res_row.get("cov95") * 100.0 if res_row.get("cov95") is not None else None
        cov50_val = res_row.get("cov50") * 100.0 if res_row.get("cov50") is not None else None
        sharp_val = res_row.get("sharpness")
        sharp_comp = res_row.get("decomp_sharpness")
        over_comp = res_row.get("decomp_overpred")
        under_comp = res_row.get("decomp_underpred")

        calib_dict = {}
        for q_low, _, _ in sym_pairs:
            nom_level = round(1.0 - 2.0 * q_low, 3)
            col_name = f"cov_{int(round(nom_level * 100))}"
            if col_name in res_row and res_row[col_name] is not None:
                calib_dict[float(nom_level)] = round(float(res_row[col_name]) * 100.0, 1)

        return {
            "wis": float(wis_val) if wis_val is not None and not np.isnan(wis_val) else None,
            "wis_log": float(wis_log_val) if wis_log_val is not None and not np.isnan(wis_log_val) else None,
            "wis_7": float(wis7_val) if wis7_val is not None and not np.isnan(wis7_val) else None,
            "wis_per_100k": float(wis_rate_val) if wis_rate_val is not None and not np.isnan(wis_rate_val) else None,
            "mae": float(mae_val) if mae_val is not None and not np.isnan(mae_val) else None,
            "mae_log": float(mae_log_val) if mae_log_val is not None and not np.isnan(mae_log_val) else None,
            "cov95": float(cov95_val) if cov95_val is not None and not np.isnan(cov95_val) else None,
            "cov50": float(cov50_val) if cov50_val is not None and not np.isnan(cov50_val) else None,
            "sharpness": float(sharp_val) if sharp_val is not None and not np.isnan(sharp_val) else None,
            "sharpness_component": float(sharp_comp) if sharp_comp is not None and not np.isnan(sharp_comp) else None,
            "overprediction_penalty": float(over_comp) if over_comp is not None and not np.isnan(over_comp) else None,
            "underprediction_penalty": float(under_comp) if under_comp is not None and not np.isnan(under_comp) else None,
            "calibration": calib_dict,
            "count": int(res_row["count"]),
        }

    overall_summary = _summarize_df(primary_eval)
    overall_summary["quantile_count"] = quantile_count
    overall_summary["has_23_quantiles"] = has_std_23
    overall_summary["has_7_quantiles"] = has_std_7

    states_summary = _summarize_df(eval_df.filter(pl.col("location") != "US")) if has_states else None
    us_summary = _summarize_df(eval_df.filter(pl.col("location") == "US")) if has_us_data else None

    # Horizon breakdown across the primary evaluation frame
    by_horizon = {}
    for h in sorted(primary_eval.select(pl.col("horizon").unique()).to_series().to_list()):
        hdf = primary_eval.filter(pl.col("horizon") == h)
        by_horizon[int(h)] = _summarize_df(hdf)

    evaluated_dates = sorted(eval_df.select(pl.col("reference_date").unique()).to_series().to_list())
    distinct_locs = sorted(eval_df.select(pl.col("location").unique()).to_series().to_list())

    result_dict: Dict[str, Any] = {
        "overall": overall_summary,
        "states": states_summary,
        "us": us_summary,
        "by_horizon": by_horizon,
        "metadata": {
            "evaluated_dates": evaluated_dates,
            "dates_count": len(evaluated_dates),
            "locations_count": len(distinct_locs),
            "states_count": len([loc for loc in distinct_locs if loc != "US"]),
            "total_tasks": len(eval_df),
            "quantile_count": quantile_count,
            "present_quantiles": present_quantiles,
            "is_state_benchmark": has_states,
            "benchmark_pool": "states" if has_states else "us",
            "has_us_data": has_us_data,
            "has_states_data": has_states,
            "negative_values_clipped": neg_clipped_count,
        },
    }

    if return_task_df:
        result_dict["task_df"] = eval_df

    return result_dict


_INT_DTYPES = (pl.Int8, pl.Int16, pl.Int32, pl.Int64, pl.UInt8, pl.UInt16, pl.UInt32)


def _canonical_task_frame(val: Any, metric_col: str) -> Optional[pl.DataFrame]:
    """
    One model's task scores as columns (loc, rd, h, w), keyed exactly as the reference loop keys them:
    str(location), str(reference_date or else target_end_date), int(horizon), last value wins on repeats,
    null / NaN scores dropped. Returns None for any input the reference loop would treat differently
    (dicts, unusual dtypes, null horizons), so the caller falls back to the reference implementation.
    """
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
    empty = pl.DataFrame(schema={"loc": pl.String, "rd": pl.String, "h": pl.Int64, "w": pl.Float64})
    if metric_col not in schema:
        return empty  # row.get(metric_col) is None for every row: the model has no scores
    w_dtype = schema[metric_col]
    if not (w_dtype.is_float() or w_dtype in _INT_DTYPES):
        return None
    if val.is_empty():
        return empty
    return (
        val.select(
            pl.col("location").fill_null("None").alias("loc"),  # str(None) == "None"
            pl.col(rd_col).fill_null("None").alias("rd"),
            pl.col("horizon").cast(pl.Int64).alias("h"),
            pl.col(metric_col).cast(pl.Float64).alias("w"),
        )
        .filter(pl.col("w").is_not_null() & pl.col("w").is_not_nan())
        .unique(subset=["loc", "rd", "h"], keep="last", maintain_order=True)
    )


def compute_pairwise_relative_wis(
    model_task_wis: Dict[str, Any],
    baseline_model: Optional[str] = None,
    metric_col: str = "wis",
) -> Dict[str, Dict[str, Optional[float]]]:
    """
    Pairwise tournament relative WIS (Cramer et al. 2022 / Hubverse standard). Same inputs and output as
    `_pairwise_relative_wis_reference`, which defines the method; this computes every pair at once.

    For each pair (i, j) the reference takes the mean WIS of each model over their shared tasks. With a
    tasks x models matrix V of scores (0 where a model has no score) and M of presence flags (1/0):
        C = M^T M   shared-task counts,   S = V^T M   S[i, j] = sum of i's WIS over tasks j also has,
    so mean_i_on_shared(i, j) = S[i, j] / C[i, j], and the ratio is (S[i, j] / C) / (S[j, i] / C).
    Everything after the ratios (geometric mean in the same model order, baseline scaling, rounding) is
    the reference code path. Inputs it cannot represent exactly (dict inputs, unusual dtypes, null
    horizons, non-finite scores) are handed to the reference implementation unchanged.
    """
    models = list(model_task_wis.keys())
    if not models:
        return {}
    frames: List[pl.DataFrame] = []
    for m in models:
        f = _canonical_task_frame(model_task_wis[m], metric_col)
        if f is None:
            return _pairwise_relative_wis_reference(model_task_wis, baseline_model, metric_col)
        frames.append(f)

    n = len(models)
    long = pl.concat(
        [f.with_columns(pl.lit(i, dtype=pl.Int64).alias("m")) for i, f in enumerate(frames) if f.height],
        how="vertical",
    ) if any(f.height for f in frames) else None
    if long is None:
        return _pairwise_relative_wis_reference(model_task_wis, baseline_model, metric_col)
    w = long.get_column("w").to_numpy()
    if not np.isfinite(w).all():
        # inf / -inf make the reference raise or produce 0-ratios; keep its exact behaviour
        return _pairwise_relative_wis_reference(model_task_wis, baseline_model, metric_col)

    task_ids = long.select(pl.struct("loc", "rd", "h").rank("dense").cast(pl.Int64) - 1).to_series().to_numpy()
    model_ids = long.get_column("m").to_numpy()
    n_tasks = int(task_ids.max()) + 1
    V = np.zeros((n_tasks, n), dtype=np.float64)
    P = np.zeros((n_tasks, n), dtype=np.float64)
    V[task_ids, model_ids] = w
    P[task_ids, model_ids] = 1.0
    C = P.T @ P  # exact: integer counts far below 2**53
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
        # ascending model order == the reference's dict insertion order, so the log-sum adds in the same order
        pairwise_ratios[m] = {models[j]: r for j, r in ratio_rows[i]}

    return _relative_wis_from_ratios(models, pairwise_ratios, baseline_model, baseline_model in model_task_wis)


def _relative_wis_from_ratios(
    models: List[str],
    pairwise_ratios: Dict[str, Dict[str, float]],
    baseline_model: Optional[str],
    baseline_present: bool,
) -> Dict[str, Dict[str, Optional[float]]]:
    """Geometric-mean skill, baseline scaling, direct % vs baseline and rounding (the reference's tail)."""
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


def _pairwise_relative_wis_reference(
    model_task_wis: Dict[str, Any],
    baseline_model: Optional[str] = None,
    metric_col: str = "wis",
) -> Dict[str, Dict[str, Optional[float]]]:
    """
    Reference (original) implementation, kept verbatim: the definition the fast path is tested against,
    and the fallback for inputs the fast path does not handle.

    Compute pairwise tournament relative WIS (Cramer et al. 2022 / Hubverse standard):
    For every pair of models (m, m'), calculate theta_{m, m'} = mean(WIS_m) / mean(WIS_m')
    on their shared tasks T_{m, m'}.
    The geometric mean across all paired models m' gives model m's unscaled relative skill theta_m.
    Scaled by theta_baseline gives the tournament relative WIS (1.0 = baseline, <1.0 = better).
    Without a baseline_model the unscaled theta is returned; a baseline with no scores yields None.
    Also returns direct pairwise pct_diff vs baseline on shared tasks.
    Supports either natural count scale (metric_col='wis') or log scale ln(y+1) (metric_col='wis_log').
    """
    converted: Dict[str, Dict[Tuple[str, str, int], float]] = {}
    for m, val in model_task_wis.items():
        if isinstance(val, pl.DataFrame):
            m_dict = {}
            for row in val.iter_rows(named=True):
                loc = str(row.get("location", ""))
                rd = str(row.get("reference_date", row.get("target_end_date", "")))
                h = int(row.get("horizon", 0))
                w = row.get(metric_col)
                if w is not None and not np.isnan(w):
                    m_dict[(loc, rd, h)] = float(w)
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
                r12 = mean1 / mean2
                r21 = mean2 / mean1
                pairwise_ratios[m1][m2] = r12
                pairwise_ratios[m2][m1] = r21

    # Geometric mean ratio per model (requires a comparison against another model, unless it is the only one)
    unscaled_theta: Dict[str, Optional[float]] = {}
    for m, ratios in pairwise_ratios.items():
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

        # Direct percentage diff vs baseline on pairwise shared tasks
        direct_pct: Optional[float] = None
        if baseline_model and baseline_model in converted:
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



def find_common_tasks(
    model_dfs: Dict[str, Any],
    target: str = "wk inc flu hosp",
    locations: Optional[List[str]] = None,
    reference_dates: Optional[List[str]] = None,
) -> Set[Tuple[str, str, int]]:
    """
    Find the intersection of (reference_date, location, horizon) tasks
    that are present across ALL specified models.

    Ensures 100% fair backtest comparison without survivorship or off-peak bias.
    Optimized via Arrow joins across models.
    """
    if not model_dfs:
        return set()

    # Task extraction runs per model on threads; the intersection below replays the sequential loop
    # exactly (stops at the first model with no tasks, raises only what that loop would have reached).
    outcomes = ordered_map_outcomes(
        lambda df_raw: model_task_keys(df_raw, target, locations, reference_dates),
        list(model_dfs.values()),
    )
    common_df = intersect_task_keys(outcomes)
    if common_df is None or common_df.is_empty():
        return set()

    rows = common_df.iter_rows()
    return set((str(r[0]), str(r[1]), int(r[2])) for r in rows)


TASK_KEY_COLS = ["reference_date", "location", "horizon"]


def model_task_keys(
    df_raw: Any,
    target: str,
    locations: Optional[List[str]] = None,
    reference_dates: Optional[List[str]] = None,
) -> Optional[pl.DataFrame]:
    """
    One model's distinct (reference_date, location, horizon) tasks as find_common_tasks defines them,
    or None when the model contributes no tasks (which makes any intersection containing it empty).
    """
    df = _to_polars_df(df_raw)
    if df is None or df.is_empty():
        return None

    sub = df.filter(pl.col("target") == target)
    if "output_type" in sub.columns:
        sub = sub.filter(pl.col("output_type") == "quantile")

    if locations is not None and len(locations) > 0 and "all" not in locations:
        sub = sub.filter(pl.col("location").is_in(locations))

    if reference_dates is not None and len(reference_dates) > 0 and "all" not in reference_dates:
        sub = sub.filter(pl.col("reference_date").is_in(reference_dates))

    if sub.is_empty():
        return None

    # Fast task extraction: median (0.50) if present, else distinct task tuples
    if "output_type_id" in sub.columns:
        has_med = (sub.select((pl.col("output_type_id") == 0.50).any()).to_series()[0])
        if has_med:
            sub = sub.filter(pl.col("output_type_id") == 0.50)

    tasks = (
        sub.select([
            pl.col("reference_date").cast(pl.String),
            pl.col("location").cast(pl.String),
            pl.col("horizon").fill_null(0).cast(pl.Int32),
        ])
        .drop_nulls()
        .unique()
    )

    if tasks.is_empty():
        return None
    return tasks


def intersect_task_keys(outcomes: List[Tuple[bool, Any]]) -> Optional[pl.DataFrame]:
    """Intersect per-model task keys in order, exactly like the original sequential loop (None = empty)."""
    common_df: Optional[pl.DataFrame] = None
    for ok, tasks in outcomes:
        if not ok:
            raise tasks
        if tasks is None:
            return None
        common_df = tasks if common_df is None else common_df.join(tasks, on=TASK_KEY_COLS, how="inner")
        if common_df.is_empty():
            return None
    return common_df
