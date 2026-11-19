"""
Unified universal Hubverse forecast normalizer shared by local ParquetCacheManager and remote hub sync.

Handles every Hubverse submission dialect without hub-specific hardcoding:
- `reference_date` OR `origin_date` round identifiers
- Missing `horizon` derived from `(target_end_date - reference_date - horizon_offset_days) // 7`
- Missing `target_end_date` derived from `reference_date + 7 * horizon + horizon_offset_days`
- Extra task-ID dimensions (e.g. `age_group` in RSV) preserved cleanly across quantile/sample/pmf/peak outputs
- Explicit `quantile` rows, `median` fallback mapped to `0.5`, `sample` trajectories, non-peak `pmf` distributions
- Automatic 23-quantile extraction from `sample` trajectories for sample-only rounds (`flu-metrocast` 2026-27)
- Automatic season peak size & peak-week PMF extraction from long-horizon sample trajectories (`max_h >= 12` weeks)
"""

from __future__ import annotations

from dataclasses import dataclass
import io
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

import polars as pl

from viz.core.calendar import CalendarSpec, DEFAULT_FLUSIGHT_CALENDAR
from viz.core.metrics import STANDARD_23_QUANTILES
from viz.core.peaks import PEAK_SCHEMA, empty_peak_frame, extract_peak_rows, peak_targets_for, peak_quality_warnings

NULL_VALUES = ["", "NA", "null", "NaN", "None", "NULL"]

CORE_FORECAST_COLUMNS = [
    "reference_date",
    "target",
    "horizon",
    "location",
    "target_end_date",
    "output_type",
    "output_type_id",
    "value",
]
REQUIRED_INPUT_COLUMNS = ["target", "location", "output_type", "output_type_id", "value"]
STANDARD_RAW_COLS = frozenset({
    "model_id",
    "reference_date",
    "origin_date",
    "target",
    "location",
    "horizon",
    "target_end_date",
    "output_type",
    "output_type_id",
    "value",
})

DERIVED_PEAK_MIN_HORIZONS = 12
DERIVED_PEAK_MIN_SAMPLES = 10


class NormalizationError(Exception):
    """Raised when a forecast or truth table cannot be parsed or lacks required columns."""


@dataclass
class NormalizedForecast:
    quantiles: pl.DataFrame
    samples: pl.DataFrame
    pmf: pl.DataFrame
    peaks: pl.DataFrame
    info: Dict[str, Any]


def read_forecast_bytes(data: bytes, suffix: str) -> pl.DataFrame:
    if suffix.lower() == ".parquet":
        return pl.read_parquet(io.BytesIO(data))
    return pl.read_csv(
        io.BytesIO(data),
        schema_overrides={"location": pl.String, "output_type_id": pl.String, "value": pl.Float64},
        null_values=NULL_VALUES,
    )


def _as_iso_date(col: str, dtype: pl.DataType) -> pl.Expr:
    if dtype in (pl.Date, pl.Datetime) or isinstance(dtype, pl.Datetime):
        return pl.col(col).dt.strftime("%Y-%m-%d")
    return pl.col(col).cast(pl.String).str.strip_chars().str.slice(0, 10)


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


def _derive_quantiles_from_samples(
    samples_df: pl.DataFrame,
    task_cols: List[str],
    quantile_levels: Sequence[float] = STANDARD_23_QUANTILES,
) -> pl.DataFrame:
    """Compute canonical quantiles per `(reference_date, target, location, horizon, ...)` from samples."""
    if samples_df.is_empty():
        return pl.DataFrame()
    aggs = [
        pl.col("value").cast(pl.Float64).quantile(float(q), interpolation="linear").alias(f"{float(q):.4f}")
        for q in quantile_levels
    ]
    wide = samples_df.group_by(task_cols, maintain_order=True).agg(aggs)
    q_cols = [f"{float(q):.4f}" for q in quantile_levels]
    long = wide.unpivot(
        index=task_cols,
        on=q_cols,
        variable_name="output_type_id",
        value_name="value",
    )
    return long.with_columns([
        pl.lit("quantile").alias("output_type"),
        pl.col("output_type_id").cast(pl.Float64).round(3),
        pl.col("value").cast(pl.Float64),
    ])


def _derive_peaks_from_samples(
    samples_df: pl.DataFrame,
    extra_cols: List[str],
    *,
    min_horizons: int = DERIVED_PEAK_MIN_HORIZONS,
    min_samples: int = DERIVED_PEAK_MIN_SAMPLES,
) -> pl.DataFrame:
    """
    When a sample-based model submits long joint trajectories (>= 12 horizons, >= 10 trajectories),
    derive season peak size quantiles (`peak <suffix>`) and peak week PMFs (`peak week <suffix>`).
    """
    if samples_df.is_empty():
        return empty_peak_frame()
    valid = samples_df.drop_nulls(["reference_date", "target", "location", "target_end_date", "output_type_id", "value"])
    if valid.is_empty():
        return empty_peak_frame()

    traj_group = ["reference_date", "target", "location"] + extra_cols
    traj_key = traj_group + ["output_type_id"]

    # Keep only trajectory groups covering >= min_horizons distinct weeks and >= min_samples trajectories
    counts = valid.group_by(traj_group).agg([
        pl.col("target_end_date").n_unique().alias("_n_weeks"),
        pl.col("output_type_id").n_unique().alias("_n_samples"),
    ]).filter(
        (pl.col("_n_weeks") >= min_horizons) & (pl.col("_n_samples") >= min_samples)
    )
    if counts.is_empty():
        return empty_peak_frame()

    eligible = valid.join(counts.select(traj_group), on=traj_group, how="semi")
    # For each individual sample trajectory, pick peak value and earliest week achieving that peak
    traj_peaks = (
        eligible.sort(traj_key + ["value", "target_end_date"], descending=[False] * len(traj_key) + [True, False])
        .group_by(traj_key, maintain_order=True)
        .agg([
            pl.col("value").first().cast(pl.Float64).alias("peak_val"),
            pl.col("target_end_date").first().cast(pl.String).alias("peak_week"),
        ])
    )
    if traj_peaks.is_empty():
        return empty_peak_frame()

    # Map base target -> (size_target, timing_target) using shared peak naming convention
    base_targets = sorted({str(t) for t in traj_peaks.get_column("target").unique().to_list()})
    size_name_map = {t: peak_targets_for(t)["size"] for t in base_targets if peak_targets_for(t)}
    timing_name_map = {t: peak_targets_for(t)["timing"] for t in base_targets if peak_targets_for(t)}
    if not size_name_map:
        return empty_peak_frame()

    # 1. Peak size quantiles across trajectories
    q_aggs = [pl.col("peak_val").quantile(float(q), interpolation="linear").alias(f"{float(q):.4f}") for q in STANDARD_23_QUANTILES]
    q_cols = [f"{float(q):.4f}" for q in STANDARD_23_QUANTILES]
    size_df = (
        traj_peaks.group_by(traj_group, maintain_order=True)
        .agg(q_aggs)
        .unpivot(index=traj_group, on=q_cols, variable_name="output_type_id", value_name="value")
        .with_columns([
            pl.col("target").replace_strict(size_name_map, return_dtype=pl.String).alias("target"),
            pl.lit("quantile").alias("output_type"),
            pl.col("output_type_id").cast(pl.Float64).round(4).cast(pl.String),
            pl.col("value").cast(pl.Float64),
        ])
    )

    # 2. Peak week PMF across trajectories
    n_by_group = traj_peaks.group_by(traj_group).agg(pl.len().cast(pl.Float64).alias("_n_traj"))
    timing_df = (
        traj_peaks.group_by(traj_group + ["peak_week"], maintain_order=True)
        .agg(pl.len().cast(pl.Float64).alias("_hits"))
        .join(n_by_group, on=traj_group, how="inner")
        .with_columns([
            pl.col("target").replace_strict(timing_name_map, return_dtype=pl.String).alias("target"),
            pl.lit("pmf").alias("output_type"),
            pl.col("peak_week").alias("output_type_id"),
            (pl.col("_hits") / pl.col("_n_traj")).alias("value"),
        ])
        .drop(["peak_week", "_hits", "_n_traj"])
    )

    schema = {**PEAK_SCHEMA, **{c: pl.String for c in extra_cols}}
    cols = ["reference_date", "location", "target", "output_type", "output_type_id", "value"] + extra_cols
    return pl.concat([timing_df.select(cols), size_df.select(cols)], how="vertical_relaxed").cast(schema)


def normalize_forecast_frame(
    df: pl.DataFrame,
    *,
    model: str,
    reference_date: str,
    calendar: Optional[CalendarSpec] = None,
    geo: Any = None,
    known_locations: Optional[Set[str]] = None,
    is_non_negative: Optional[Callable[[str], bool]] = None,
    derive_quantiles_from_samples: bool = True,
    derive_peaks_from_samples: bool = True,
) -> NormalizedForecast:
    """
    Normalize a raw Hubverse forecast table (CSV or Parquet) into canonical quantiles, samples,
    PMFs, and season peaks, deriving missing horizons and optional sample summaries automatically.
    """
    if df is None or df.is_empty():
        raise NormalizationError("file has no rows")

    # Map origin_date -> reference_date seamlessly (RespiCast)
    if "reference_date" not in df.columns and "origin_date" in df.columns:
        df = df.rename({"origin_date": "reference_date"})

    missing = [c for c in REQUIRED_INPUT_COLUMNS if c not in df.columns]
    if missing:
        raise NormalizationError(f"missing required columns {missing}")

    cal = calendar or DEFAULT_FLUSIGHT_CALENDAR
    pad_fips = True if geo is None else bool(getattr(geo, "uses_us_fips", False))
    warnings: List[str] = []
    fname = f"{reference_date}-{model}"

    if "model_id" in df.columns:
        ids = {str(x) for x in df.get_column("model_id").unique().to_list() if x is not None}
        if ids and ids != {model}:
            warnings.append(f"{fname}: model_id column {sorted(ids)} does not match folder '{model}'")

    extra_cols = sorted(c for c in df.columns if c not in STANDARD_RAW_COLS)

    exprs: List[pl.Expr] = [
        pl.col("target").cast(pl.String).str.strip_chars(),
        _location_expr(pad_single_digit_fips=pad_fips),
        pl.col("output_type").cast(pl.String).str.strip_chars().str.to_lowercase(),
        pl.col("output_type_id").cast(pl.String).str.strip_chars(),
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
    for ec in extra_cols:
        exprs.append(pl.col(ec).cast(pl.String).str.strip_chars())
    df = df.with_columns(exprs)

    ref_dates = {x for x in df.get_column("reference_date").unique().to_list() if x is not None}
    if ref_dates and ref_dates != {reference_date}:
        warnings.append(f"{fname}: reference_date column {sorted(ref_dates)[:3]} does not match the file name")

    all_targets = sorted({str(t) for t in df.get_column("target").unique().to_list() if t is not None})
    output_types = sorted({str(t) for t in df.get_column("output_type").unique().to_list() if t is not None})

    # Extract explicit season peak rows BEFORE deriving missing weekly horizons (peaks have no horizon)
    explicit_peaks = extract_peak_rows(
        df,
        reference_date,
        pad_single_digit_fips=pad_fips,
        extra_task_ids=extra_cols,
    )
    weekly_raw = df.filter(~pl.col("target").str.to_lowercase().str.starts_with("peak "))

    # Vectorized derivation of missing horizon or target_end_date on weekly rows
    if not weekly_raw.is_empty():
        has_null_h = weekly_raw.get_column("horizon").null_count() > 0
        has_null_ted = weekly_raw.get_column("target_end_date").null_count() > 0
        if has_null_h and "target_end_date" in weekly_raw.columns:
            ref_dt = pl.col("reference_date").str.to_date("%Y-%m-%d", strict=False)
            ted_dt = pl.col("target_end_date").str.to_date("%Y-%m-%d", strict=False)
            adj = (ted_dt - ref_dt).dt.total_days() - int(cal.horizon_offset_days)
            h_est = (adj.cast(pl.Float64) / 7.0).round(0)
            derived_h = pl.when((adj - h_est * 7.0).abs() <= 2.0).then(h_est.cast(pl.Int32)).otherwise(None)
            weekly_raw = weekly_raw.with_columns(
                pl.when(pl.col("horizon").is_null()).then(derived_h).otherwise(pl.col("horizon")).alias("horizon")
            )
        if has_null_ted:
            ref_dt = pl.col("reference_date").str.to_date("%Y-%m-%d", strict=False)
            derived_ted = (
                ref_dt + pl.duration(days=pl.col("horizon").cast(pl.Int64) * 7 + int(cal.horizon_offset_days))
            ).dt.strftime("%Y-%m-%d")
            weekly_raw = weekly_raw.with_columns(
                pl.when(pl.col("target_end_date").is_null() | (pl.col("target_end_date") == ""))
                .then(derived_ted)
                .otherwise(pl.col("target_end_date"))
                .alias("target_end_date")
            )

    task_key_cols = ["reference_date", "target", "location", "horizon", "target_end_date"] + extra_cols
    select_base = ["reference_date", "target", "horizon", "location", "target_end_date"] + extra_cols + ["output_type", "output_type_id", "value"]

    # 1. Explicit quantiles (plus RespiCast `median` rows where quantile 0.5 is absent)
    q_part = weekly_raw.filter(pl.col("output_type") == "quantile")
    if not q_part.is_empty():
        try:
            q_part = q_part.with_columns(pl.col("output_type_id").cast(pl.Float64, strict=False).round(3))
            if q_part.get_column("output_type_id").null_count() > 0:
                bad_cnt = q_part.get_column("output_type_id").null_count()
                raise ValueError(f"{bad_cnt} non-numeric quantile output_type_id values")
        except Exception as exc:
            raise NormalizationError(f"quantile levels are not numeric ({exc})") from exc
        q_part = q_part.select(select_base)

    med_part = weekly_raw.filter(pl.col("output_type") == "median")
    if not med_part.is_empty():
        med_rows = med_part.with_columns([
            pl.lit("quantile").alias("output_type"),
            pl.lit(0.5, dtype=pl.Float64).alias("output_type_id"),
        ]).select(select_base)
        if not q_part.is_empty():
            existing_med = q_part.filter((pl.col("output_type_id") - 0.5).abs() < 1e-6).select(task_key_cols).unique()
            med_rows = med_rows.join(existing_med, on=task_key_cols, how="anti")
            if not med_rows.is_empty():
                q_part = pl.concat([q_part, med_rows], how="vertical_relaxed")
        else:
            q_part = med_rows

    # 2. Sample trajectories
    s_raw = weekly_raw.filter(pl.col("output_type") == "sample")
    sample_cols = ["reference_date", "target", "horizon", "location", "target_end_date"] + extra_cols + ["output_type_id", "value"]
    samples_df = (
        s_raw.select(sample_cols).with_columns(pl.col("value").cast(pl.Float32))
        if not s_raw.is_empty()
        else pl.DataFrame(schema={
            "reference_date": pl.String, "target": pl.String, "horizon": pl.Int32,
            "location": pl.String, "target_end_date": pl.String,
            **{c: pl.String for c in extra_cols},
            "output_type_id": pl.String, "value": pl.Float32,
        })
    )

    # Derive canonical quantiles from sample trajectories when tasks lack explicit quantiles
    derived_from_samples: Set[str] = set()
    if derive_quantiles_from_samples and not samples_df.is_empty():
        s_for_q = samples_df.drop_nulls(task_key_cols + ["value"])
        if not q_part.is_empty():
            existing_tasks = q_part.select(task_key_cols).unique()
            s_for_q = s_for_q.join(existing_tasks, on=task_key_cols, how="anti")
        if not s_for_q.is_empty():
            derived_q = _derive_quantiles_from_samples(s_for_q, task_key_cols).select(select_base)
            if not derived_q.is_empty():
                derived_from_samples.update(
                    str(t) for t in derived_q.get_column("target").unique().to_list() if t is not None
                )
                q_part = pl.concat([q_part, derived_q], how="vertical_relaxed") if not q_part.is_empty() else derived_q

    if q_part.is_empty():
        q_part = pl.DataFrame(schema={
            "reference_date": pl.String, "target": pl.String, "horizon": pl.Int32,
            "location": pl.String, "target_end_date": pl.String,
            **{c: pl.String for c in extra_cols},
            "output_type": pl.String, "output_type_id": pl.Float64, "value": pl.Float64,
        })

    # 3. Weekly categorical/ordinal PMF forecasts
    pmf_raw = weekly_raw.filter(pl.col("output_type") == "pmf")
    pmf_cols = ["reference_date", "target", "horizon", "location", "target_end_date"] + extra_cols + ["output_type_id", "value"]
    pmf_df = (
        pmf_raw.select(pmf_cols)
        if not pmf_raw.is_empty()
        else pl.DataFrame(schema={
            "reference_date": pl.String, "target": pl.String, "horizon": pl.Int32,
            "location": pl.String, "target_end_date": pl.String,
            **{c: pl.String for c in extra_cols},
            "output_type_id": pl.String, "value": pl.Float64,
        })
    )
    if not pmf_df.is_empty():
        sums = pmf_df.group_by(["target", "location", "horizon"] + extra_cols).agg(
            pl.col("value").sum().alias("_s"),
            pl.len().alias("_n"),
        )
        bad_pmf = sums.filter(((pl.col("_n") >= 2) & ((pl.col("_s") - 1.0).abs() > 0.01)) | (pl.col("_s") > 1.01)).height
        if bad_pmf:
            warnings.append(f"{fname}: {bad_pmf} PMF tasks do not sum to 1")
        if pmf_df.filter(pl.col("value") < 0).height:
            warnings.append(f"{fname}: negative PMF probabilities")

    # 4. Derive season peaks from long-horizon sample trajectories when explicit peak targets aren't present
    peaks_df = explicit_peaks
    if derive_peaks_from_samples and not samples_df.is_empty():
        derived_peaks = _derive_peaks_from_samples(samples_df, extra_cols)
        if not derived_peaks.is_empty():
            if peaks_df.is_empty():
                peaks_df = derived_peaks
            else:
                existing_pk = peaks_df.select(["reference_date", "location", "target"] + [c for c in extra_cols if c in peaks_df.columns]).unique()
                extra_derived = derived_peaks.join(
                    existing_pk,
                    on=["reference_date", "location", "target"] + [c for c in extra_cols if c in peaks_df.columns],
                    how="anti",
                )
                if not extra_derived.is_empty():
                    peaks_df = pl.concat([peaks_df, extra_derived], how="diagonal_relaxed")

    warnings.extend(peak_quality_warnings(peaks_df, fname))
    peak_targets = sorted({str(t) for t in peaks_df.get_column("target").unique().to_list()}) if peaks_df.height else []

    q_targets = sorted({str(t) for t in q_part.get_column("target").unique().to_list()}) if q_part.height else []
    pmf_targets = sorted({str(t) for t in pmf_df.get_column("target").unique().to_list()}) if pmf_df.height else []

    info: Dict[str, Any] = {
        "targets": sorted(set(q_targets) | set(pmf_targets)),
        "quantile_targets": q_targets,
        "pmf_targets": pmf_targets,
        "all_targets": all_targets,
        "output_types": output_types,
        "extra_task_ids": extra_cols,
        "derived_from_samples": sorted(derived_from_samples),
        "rows": q_part.height,
        "sample_rows": samples_df.height,
        "pmf_rows": pmf_df.height,
        "warnings": warnings,
        "peak": peaks_df,
        "peak_targets": peak_targets,
    }

    if not q_part.is_empty():
        task_cols = ["target", "location", "horizon", "target_end_date"] + extra_cols
        levels = q_part.group_by("target").agg(pl.col("output_type_id").n_unique().alias("n"))
        info["quantile_levels"] = {r[0]: int(r[1]) for r in levels.iter_rows()}

        null_vals = q_part.get_column("value").null_count()
        if null_vals:
            warnings.append(f"{fname}: {null_vals} quantile values are missing")

        if q_part.select(task_cols + ["output_type_id"]).is_duplicated().any():
            warnings.append(f"{fname}: duplicate quantile rows for the same task")

        crossing = (
            q_part.drop_nulls("value")
            .sort(task_cols + ["output_type_id"], nulls_last=True)
            .group_by(task_cols, maintain_order=True)
            .agg((pl.col("value").diff() < -1e-9).any().alias("crossed"))
            .get_column("crossed")
            .sum()
        )
        if crossing:
            warnings.append(f"{fname}: {crossing} forecast tasks have crossing (non-monotone) quantiles")

        if is_non_negative is not None:
            neg_targets = [t for t in q_targets if is_non_negative(t)]
            if neg_targets:
                n_neg = q_part.filter(pl.col("target").is_in(neg_targets) & (pl.col("value") < 0)).height
                if n_neg:
                    warnings.append(f"{fname}: {n_neg} negative values for non-negative targets")

        if known_locations:
            locs = {str(x) for x in q_part.get_column("location").unique().to_list()}
            unknown = sorted(locs - known_locations)
            if unknown:
                warnings.append(f"{fname}: unknown location codes {unknown[:5]}")

    if known_locations and not pmf_df.is_empty():
        pmf_locs = {str(x) for x in pmf_df.get_column("location").unique().to_list()}
        unknown_pmf = sorted(pmf_locs - known_locations)
        if unknown_pmf:
            warnings.append(f"{fname}: unknown location codes {unknown_pmf[:5]}")

    return NormalizedForecast(
        quantiles=q_part,
        samples=samples_df,
        pmf=pmf_df,
        peaks=peaks_df,
        info=info,
    )
