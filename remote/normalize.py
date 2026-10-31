"""
Schema normalization and data-quality checks for forecast and truth files downloaded from a hub.

Hub files drift in schema across seasons (horizon int32 vs int64, null horizons for peak targets, date32 vs
string dates, varying column order), so every file is coerced to the same canonical schema the local Parquet
cache uses before it is stored. Weekly quantile rows go to the forecast table the suite plots and scores;
season peak rows (peak size quantiles, peak-week pmfs) are split off into their own table (see viz.peaks).
"""

import io
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

import polars as pl

from viz.cache_manager import NULL_VALUES, filter_quantile_rows
from viz.peaks import extract_peak_rows, peak_quality_warnings

FORECAST_COLUMNS = [
    "reference_date", "target", "horizon", "location", "target_end_date",
    "output_type", "output_type_id", "value",
]
REQUIRED_COLUMNS = ["target", "location", "output_type", "output_type_id", "value"]


class NormalizationError(Exception):
    """A file that cannot be used at all (unreadable, or missing required columns)."""


def read_table(data: bytes, suffix: str) -> pl.DataFrame:
    if suffix == ".parquet":
        return pl.read_parquet(io.BytesIO(data))
    return pl.read_csv(
        io.BytesIO(data),
        schema_overrides={"location": pl.String, "output_type_id": pl.String, "value": pl.Float64},
        null_values=NULL_VALUES,
    )


def _as_iso_date(col: str, dtype: pl.DataType) -> pl.Expr:
    if dtype in (pl.Date, pl.Datetime) or isinstance(dtype, pl.Datetime):
        return pl.col(col).dt.strftime("%Y-%m-%d")
    return pl.col(col).cast(pl.String).str.slice(0, 10)


def _location_expr() -> pl.Expr:
    loc = pl.col("location").cast(pl.String).str.strip_chars()
    # Numeric FIPS codes must be two characters ("1" -> "01"); "US" and other codes are left alone
    return (
        pl.when(loc.str.contains(r"^\d$"))
        .then(loc.str.zfill(2))
        .otherwise(loc)
        .alias("location")
    )


def normalize_forecast(
    df: pl.DataFrame,
    model: str,
    reference_date: str,
    known_locations: Optional[Set[str]] = None,
    is_non_negative: Optional[Callable[[str], bool]] = None,
) -> Tuple[pl.DataFrame, Dict[str, Any]]:
    """
    Coerce one model-output file to the canonical quantile schema and collect data-quality findings.
    Returns (quantile_rows, info) where info has targets, row counts, quantile levels and warnings, plus
    `peak` (the file's season peak rows in the peak schema) and `peak_targets`.
    """
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise NormalizationError(f"missing required columns {missing}")

    warnings: List[str] = []
    fname = f"{reference_date}-{model}"

    if "model_id" in df.columns:
        ids = {str(x) for x in df.get_column("model_id").unique().to_list() if x is not None}
        if ids and ids != {model}:
            warnings.append(f"{fname}: model_id column {sorted(ids)} does not match folder '{model}'")

    exprs = [
        pl.col("target").cast(pl.String),
        _location_expr(),
        pl.col("output_type").cast(pl.String),
        pl.col("output_type_id").cast(pl.String),
        pl.col("value").cast(pl.Float64, strict=False),
    ]
    if "reference_date" in df.columns:
        exprs.append(_as_iso_date("reference_date", df.schema["reference_date"]).alias("reference_date"))
    else:
        exprs.append(pl.lit(reference_date).alias("reference_date"))
    if "target_end_date" in df.columns:
        exprs.append(_as_iso_date("target_end_date", df.schema["target_end_date"]).alias("target_end_date"))
    else:
        exprs.append(pl.lit(None, dtype=pl.String).alias("target_end_date"))
    if "horizon" in df.columns:
        exprs.append(pl.col("horizon").cast(pl.Int32, strict=False))
    else:
        exprs.append(pl.lit(None, dtype=pl.Int32).alias("horizon"))
    df = df.with_columns(exprs)

    ref_dates = {x for x in df.get_column("reference_date").unique().to_list() if x is not None}
    if ref_dates and ref_dates != {reference_date}:
        warnings.append(f"{fname}: reference_date column {sorted(ref_dates)[:3]} does not match the file name")

    all_targets = sorted({str(t) for t in df.get_column("target").unique().to_list() if t is not None})
    output_types = sorted({str(t) for t in df.get_column("output_type").unique().to_list() if t is not None})

    peak = extract_peak_rows(df, reference_date)
    peak_targets = sorted({str(t) for t in peak.get_column("target").unique().to_list()}) if peak.height else []
    warnings.extend(peak_quality_warnings(peak, fname))
    df = df.filter(~pl.col("target").str.to_lowercase().str.starts_with("peak "))

    try:
        q = filter_quantile_rows(df)
    except Exception as exc:
        raise NormalizationError(f"quantile levels are not numeric ({exc})") from exc
    q = q.select(FORECAST_COLUMNS)

    info: Dict[str, Any] = {
        "targets": sorted({str(t) for t in q.get_column("target").unique().to_list()}) if q.height else [],
        "all_targets": all_targets,
        "output_types": output_types,
        "rows": q.height,
        "warnings": warnings,
        "peak": peak,
        "peak_targets": peak_targets,
    }
    if q.is_empty():
        return q, info

    task_cols = ["target", "location", "horizon", "target_end_date"]

    levels = q.group_by("target").agg(pl.col("output_type_id").n_unique().alias("n"))
    info["quantile_levels"] = {r[0]: int(r[1]) for r in levels.iter_rows()}

    null_vals = q.get_column("value").null_count()
    if null_vals:
        warnings.append(f"{fname}: {null_vals} quantile values are missing")

    if q.select(task_cols + ["output_type_id"]).is_duplicated().any():
        warnings.append(f"{fname}: duplicate quantile rows for the same task")

    crossing = (
        q.drop_nulls("value")
        .sort(task_cols + ["output_type_id"], nulls_last=True)
        .group_by(task_cols, maintain_order=True)
        .agg((pl.col("value").diff() < -1e-9).any().alias("crossed"))
        .get_column("crossed")
        .sum()
    )
    if crossing:
        warnings.append(f"{fname}: {crossing} forecast tasks have crossing (non-monotone) quantiles")

    if is_non_negative is not None:
        neg_targets = [t for t in info["targets"] if is_non_negative(t)]
        if neg_targets:
            n_neg = q.filter(pl.col("target").is_in(neg_targets) & (pl.col("value") < 0)).height
            if n_neg:
                warnings.append(f"{fname}: {n_neg} negative values for non-negative targets")

    if known_locations:
        locs = {str(x) for x in q.get_column("location").unique().to_list()}
        unknown = sorted(locs - known_locations)
        if unknown:
            warnings.append(f"{fname}: unknown location codes {unknown[:5]}")

    return q, info


def normalize_oracle(df: pl.DataFrame, fallback_as_of: str) -> pl.DataFrame:
    """Coerce a hub oracle-output table to the cache schema used by ParquetCacheManager.get_oracle_parquet."""
    cols = {c: c for c in df.columns}
    if "as_of" not in cols:
        df = df.with_columns(pl.lit(fallback_as_of).alias("as_of"))
    exprs = [
        _as_iso_date("as_of", df.schema["as_of"]).alias("as_of"),
        pl.col("target").cast(pl.String),
        _as_iso_date("target_end_date", df.schema["target_end_date"]).alias("target_end_date"),
        _location_expr(),
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
    df = df.with_columns(exprs)
    return df.select([
        "as_of", "target", "target_end_date", "location", "horizon", "output_type", "output_type_id", "oracle_value",
    ])


def normalize_admissions(df: pl.DataFrame, target: str, as_of: Optional[str] = None) -> pl.DataFrame:
    """Coerce a target-hospital-admissions style table (date, location, value) to the cached truth schema."""
    out = df.with_columns([
        _location_expr(),
        pl.col("date").cast(pl.String).str.slice(0, 10).alias("target_end_date"),
        pl.col("value").cast(pl.Float64, strict=False).alias("oracle_value"),
        pl.lit(target).alias("target"),
        pl.lit(0).cast(pl.Int32).alias("horizon"),
    ])
    cols = ["target", "location", "target_end_date", "horizon", "oracle_value"]
    if as_of is not None:
        out = out.with_columns(pl.lit(as_of).alias("as_of"))
        cols = ["as_of"] + cols
    return out.select(cols).drop_nulls(subset=["oracle_value", "target_end_date", "location"])
