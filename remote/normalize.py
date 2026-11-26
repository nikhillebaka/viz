"""
Schema normalization and data-quality checks for forecast and truth files downloaded from a hub.

Delegates forecast normalization to `viz.core.ingest` so local repos and remote hubs share
one canonical pipeline supporting quantiles, sample trajectories, PMFs, derived horizons,
and extra Hubverse task IDs.
"""

from typing import Any, Callable, Dict, Optional, Sequence, Set, Tuple

import polars as pl

from viz.core.calendar import CalendarSpec
from viz.core.ingest import (
    CORE_FORECAST_COLUMNS,
    NormalizationError,
    REQUIRED_INPUT_COLUMNS,
    normalize_forecast_frame,
    read_forecast_bytes,
)
from viz.core.truth import DATE_COL_ALIASES, LOC_COL_ALIASES, TRUTH_EXTRA_IGNORE, unpivot_wide_truth

FORECAST_COLUMNS = CORE_FORECAST_COLUMNS
REQUIRED_COLUMNS = REQUIRED_INPUT_COLUMNS

read_table = read_forecast_bytes


def _as_iso_date(col: str, dtype: pl.DataType) -> pl.Expr:
    if dtype in (pl.Date, pl.Datetime) or isinstance(dtype, pl.Datetime):
        return pl.col(col).dt.strftime("%Y-%m-%d")
    return pl.col(col).cast(pl.String).str.slice(0, 10)


def _location_expr(pad_single_digit_fips: bool = True) -> pl.Expr:
    loc = pl.col("location").cast(pl.String).str.strip_chars()
    if pad_single_digit_fips:
        return (
            pl.when(loc.str.contains(r"^\d$"))
            .then(loc.str.zfill(2))
            .otherwise(loc)
            .alias("location")
        )
    return loc.alias("location")


def normalize_forecast(
    df: pl.DataFrame,
    model: str,
    reference_date: str,
    known_locations: Optional[Set[str]] = None,
    is_non_negative: Optional[Callable[[str], bool]] = None,
    *,
    calendar: Optional[CalendarSpec] = None,
    geo: Any = None,
    time_unit_for: Optional[Callable[[str], Optional[str]]] = None,
) -> Tuple[pl.DataFrame, Dict[str, Any]]:
    """
    Coerce one model-output file into canonical quantile/sample/pmf/peak tables and collect
    data-quality findings. Returns `(quantile_rows, info)` for backwards compatibility, with
    `info["samples"]` and `info["pmf"]` populated alongside `info["peak"]`.
    """
    res = normalize_forecast_frame(
        df,
        model=model,
        reference_date=reference_date,
        calendar=calendar,
        geo=geo,
        known_locations=known_locations,
        is_non_negative=is_non_negative,
        time_unit_for=time_unit_for,
    )
    info = dict(res.info)
    info["samples"] = res.samples
    info["pmf"] = res.pmf
    return res.quantiles, info


def normalize_oracle(
    df: pl.DataFrame,
    fallback_as_of: str,
    *,
    pad_single_digit_fips: bool = True,
    default_target: Optional[str] = None,
    target_ids: Optional[Sequence[str]] = None,
) -> pl.DataFrame:
    """Coerce a hub oracle / time-series / wide multi-target surveillance table to canonical oracle schema."""
    if target_ids and "target" not in df.columns and not any(c in df.columns for c in ("oracle_value", "observation", "value")):
        wide = unpivot_wide_truth(df, target_ids)
        if wide is not None:
            df = wide

    rename_map = {}
    if "location" not in df.columns:
        for alt in LOC_COL_ALIASES:
            if alt != "location" and alt in df.columns:
                rename_map[alt] = "location"
                break
    if "oracle_value" not in df.columns:
        for alt in ("observation", "value"):
            if alt in df.columns:
                rename_map[alt] = "oracle_value"
                break
    if "target_end_date" not in df.columns:
        for alt in DATE_COL_ALIASES:
            if alt != "target_end_date" and alt in df.columns:
                rename_map[alt] = "target_end_date"
                break
    if rename_map:
        df = df.rename(rename_map)

    if "as_of" not in df.columns:
        df = df.with_columns(pl.lit(fallback_as_of).alias("as_of"))
    exprs = [
        _as_iso_date("as_of", df.schema["as_of"]).alias("as_of"),
        (
            pl.col("target").cast(pl.String)
            if "target" in df.columns
            else pl.lit(default_target or "value").alias("target")
        ),
        _as_iso_date("target_end_date", df.schema["target_end_date"]).alias("target_end_date"),
        _location_expr(pad_single_digit_fips=pad_single_digit_fips),
        pl.col("oracle_value").cast(pl.Float64, strict=False),
    ]
    exprs.append(
        pl.col("horizon").fill_null(0).cast(pl.Int32, strict=False)
        if "horizon" in df.columns else pl.lit(0).cast(pl.Int32).alias("horizon")
    )
    exprs.append(
        pl.col("output_type").cast(pl.String)
        if "output_type" in df.columns else pl.lit(None, dtype=pl.String).alias("output_type")
    )
    exprs.append(
        pl.col("output_type_id").cast(pl.String)
        if "output_type_id" in df.columns else pl.lit(None, dtype=pl.String).alias("output_type_id")
    )
    extra_cols = sorted(
        c for c in df.columns
        if c not in TRUTH_EXTRA_IGNORE and c not in {"as_of", "target", "target_end_date", "location", "horizon", "output_type", "output_type_id", "oracle_value"}
    )
    for ec in extra_cols:
        exprs.append(pl.col(ec).cast(pl.String).str.strip_chars())
    df = df.with_columns(exprs)
    return df.select([
        "as_of", "target", "target_end_date", "location", "horizon", "output_type", "output_type_id", "oracle_value",
    ] + extra_cols).drop_nulls(subset=["target", "target_end_date", "location", "oracle_value"])


def normalize_admissions(
    df: pl.DataFrame,
    target: str,
    as_of: Optional[str] = None,
    *,
    pad_single_digit_fips: bool = True,
) -> pl.DataFrame:
    """Coerce a target-hospital-admissions / latest-data / time-series style table to cached truth schema."""
    rename_map = {}
    if "target_end_date" not in df.columns:
        for alt in ("date", "truth_date"):
            if alt in df.columns:
                rename_map[alt] = "target_end_date"
                break
    if "oracle_value" not in df.columns:
        for alt in ("observation", "value"):
            if alt in df.columns:
                rename_map[alt] = "oracle_value"
                break
    if rename_map:
        df = df.rename(rename_map)

    out = df.with_columns([
        _location_expr(pad_single_digit_fips=pad_single_digit_fips),
        _as_iso_date("target_end_date", df.schema["target_end_date"]).alias("target_end_date"),
        pl.col("oracle_value").cast(pl.Float64, strict=False),
        (pl.col("target").cast(pl.String) if "target" in df.columns else pl.lit(target).alias("target")),
        pl.lit(0).cast(pl.Int32).alias("horizon"),
    ])
    cols = ["target", "location", "target_end_date", "horizon", "oracle_value"]
    if as_of is not None:
        out = out.with_columns(pl.lit(as_of).alias("as_of"))
        cols = ["as_of"] + cols
    elif "as_of" in out.columns:
        out = out.with_columns(_as_iso_date("as_of", out.schema["as_of"]).alias("as_of"))
        cols = ["as_of"] + cols
    return out.select(cols).drop_nulls(subset=["oracle_value", "target_end_date", "location"])
