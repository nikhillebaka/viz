"""
Unified ground-truth and point-in-time vintage reconciliation across hubs.

Rules applied uniformly to scoring oracle, surveillance admissions, weekly chart series, and as-of
vintages:
- Across sources covering the same (target, location, target_end_date), the newest publication
  vintage (`as_of`, falling back to inferred vintage / latest observation date when a source lacks
  `as_of`) wins per observation; older sources fill missing historical weeks or targets.
- When two sources tie on effective vintage and explicitness, deterministic source precedence applies
  (active repo > synced S3 hub > sibling workspace hub > bundled surveillance archive), and numeric
  disagreements at the same vintage emit one concise summary warning.
- Target and location filtering ensures external sources never leak foreign targets or geographies.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple
import re

import polars as pl

NULL_VALUES = ["", "NA", "null", "NaN", "None", "NULL"]
ORACLE_KEYS = ["target", "target_end_date", "location", "horizon", "output_type", "output_type_id"]
ADMISSIONS_KEYS = ["target", "location", "target_end_date", "horizon"]
DATE_COL_ALIASES = ("target_end_date", "truth_date", "date", "time_value", "time")
LOC_COL_ALIASES = ("location", "geo_value", "geo_abbr")
TRUTH_EXTRA_IGNORE = frozenset({
    "year_week",
    "data_source",
    "initial_report_date",
    "observation_date",
    "state",
    "state_abb",
    "location_name",
    "location_type",
    "geo_type",
    "geo_name",
    "season",
    "Season",
    "population",
})
_TRUTH_CORE_COLS = frozenset({
    "as_of",
    "target",
    "target_end_date",
    "location",
    "horizon",
    "output_type",
    "output_type_id",
    "oracle_value",
})

PRIORITY_REPO = 40
PRIORITY_REMOTE = 30
PRIORITY_PEER = 20
PRIORITY_ARCHIVE = 10

_VALUE_DIFF_REL_TOL = 1e-6


def is_flu_hosp_target(target: str) -> bool:
    """True only for influenza hospitalization targets (never COVID/RSV/other pathogen targets)."""
    t = str(target or "").lower()
    if any(p in t for p in ("covid", "rsv", "sars", "measles", "dengue", "mpox", "ebola")):
        return False
    return "hosp" in t and ("flu" in t or "influenza" in t)


@dataclass(frozen=True)
class TruthSource:
    """Descriptor for one ground-truth or vintage source participating in reconciliation."""

    source_id: str
    label: str
    kind: str  # "oracle" | "admissions" | "time_series" | "as_of"
    priority: int
    path: Optional[Path] = None
    inferred_as_of: Optional[str] = None


def normalize_location_expr(col: str = "location", *, pad_single_digit_fips: bool = True) -> pl.Expr:
    """Coerce location IDs to string and optionally left-pad single-digit numeric FIPS codes ('1' -> '01')."""
    loc = pl.col(col).cast(pl.String).str.strip_chars()
    if pad_single_digit_fips:
        return pl.when(loc.str.contains(r"^\d$")).then(loc.str.zfill(2)).otherwise(loc).alias(col)
    return loc.alias(col)


def iso_date_expr(col: str, dtype: pl.DataType) -> pl.Expr:
    """Coerce Date/Datetime/String column to ISO 'YYYY-MM-DD' string."""
    if dtype in (pl.Date, pl.Datetime) or isinstance(dtype, pl.Datetime):
        return pl.col(col).dt.strftime("%Y-%m-%d").alias(col)
    return pl.col(col).cast(pl.String).str.strip_chars().str.slice(0, 10).alias(col)


def _frame_max_date(df: pl.DataFrame, col: str = "target_end_date") -> str:
    if df.is_empty() or col not in df.columns:
        return ""
    val = df.select(iso_date_expr(col, df.schema[col]).max()).item()
    return str(val)[:10] if val else ""


_WIDE_PATHOGEN_ALIASES: Tuple[Tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"sarscov2|sars_cov_2|covid19|covid"), "covid"),
    (re.compile(r"influenza|\bflu\b"), "flu"),
    (re.compile(r"\brsv\b"), "rsv"),
    (re.compile(r"dengue"), "dengue"),
    (re.compile(r"ebola|\bbdbv\b|\bbvbd\b"), "ebola"),
    (re.compile(r"\bili\b"), "ili"),
    (re.compile(r"\bari\b"), "ari"),
)


def _truth_pathogen(text: str) -> Optional[str]:
    norm = re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).strip()
    for pat, label in _WIDE_PATHOGEN_ALIASES:
        if pat.search(norm):
            return label
    return None


def _match_wide_column_to_target(col_name: str, target_ids: Sequence[str]) -> Optional[str]:
    weekly = [str(t).strip() for t in target_ids if str(t).strip() and not str(t).strip().lower().startswith("peak ")]
    candidates = weekly or [str(t).strip() for t in target_ids if str(t).strip()]
    if not candidates:
        return None
    col_low = col_name.lower()
    col_toks = set(re.sub(r"[^a-z0-9]+", " ", col_low).split())
    col_path = _truth_pathogen(col_low)
    best_tgt: Optional[str] = None
    best_score = -1000
    for t in candidates:
        t_low = t.lower()
        t_toks = set(re.sub(r"[^a-z0-9]+", " ", t_low).split())
        t_path = _truth_pathogen(t_low)
        if col_path and t_path and col_path != t_path:
            continue
        score = 0
        if col_path and col_path == t_path:
            score += 10
        if (col_toks & {"pct", "positive", "prop", "percent"}) and (t_toks & {"pct", "prop", "positive", "percent"}):
            score += 3
        if (col_toks & {"hosp", "hospitalization", "bed"}) and (t_toks & {"hosp", "admit", "admissions"}):
            score += 3
        if "ed" in col_toks and "ed" in t_toks:
            score += 3
        if "case" in col_low and "case" in t_low:
            score += 3
        if t_low == col_low:
            score += 20
        if t_low.startswith("peak "):
            score -= 5
        if score > best_score:
            best_score = score
            best_tgt = t
    if best_score >= 10:
        return best_tgt
    if len(candidates) == 1 and col_low in ("value", "observation", "admissions", "cases", "count"):
        return candidates[0]
    return None


def unpivot_wide_truth(df: pl.DataFrame, target_ids: Sequence[str] = ()) -> Optional[pl.DataFrame]:
    """
    Convert wide multi-target Hubverse surveillance CSVs (e.g. `time_value, geo_value, flu_pct_positive,
    rsv_pct_positive, sarscov2_pct_positive` or `time, geo_value, covid, flu, rsv`) into long
    `["target", "location", "target_end_date", "oracle_value"]` frames without hardcoding column names.
    Returns `None` if `df` is already long-form or cannot be unambiguously matched.
    """
    if df is None or df.is_empty():
        return None
    if "target" in df.columns and any(c in df.columns for c in ("oracle_value", "observation", "value")):
        return None
    if not target_ids:
        return None

    date_col = next((c for c in DATE_COL_ALIASES if c in df.columns), None)
    loc_col = next((c for c in LOC_COL_ALIASES if c in df.columns), None)
    if date_col is None or loc_col is None:
        return None

    skip = set(DATE_COL_ALIASES) | set(LOC_COL_ALIASES) | TRUTH_EXTRA_IGNORE | {
        "as_of", "horizon", "output_type", "output_type_id", "target", "oracle_value", "observation", "value",
    }
    col_map: Dict[str, str] = {}
    used_targets: Set[str] = set()
    for col in df.columns:
        if col in skip:
            continue
        tgt = _match_wide_column_to_target(col, target_ids)
        if tgt and tgt not in used_targets:
            col_map[col] = tgt
            used_targets.add(tgt)
    if not col_map:
        return None

    renames: Dict[str, str] = {}
    if loc_col != "location":
        renames[loc_col] = "location"
    if date_col != "target_end_date":
        renames[date_col] = "target_end_date"
    work = df.rename(renames) if renames else df

    id_cols = [c for c in ("as_of", "location", "target_end_date") if c in work.columns]
    val_cols = list(col_map.keys())
    work = work.with_columns([pl.col(c).cast(pl.Float64, strict=False) for c in val_cols])
    long = work.unpivot(
        index=id_cols,
        on=val_cols,
        variable_name="_wide_col",
        value_name="oracle_value",
    )
    out = long.with_columns(
        pl.col("_wide_col").replace_strict(col_map, return_dtype=pl.String).alias("target")
    ).drop("_wide_col").drop_nulls(subset=["oracle_value", "target_end_date", "location"])
    cols = (["as_of"] if "as_of" in out.columns else []) + ["target", "location", "target_end_date", "oracle_value"]
    return out.select(cols) if not out.is_empty() else None


def _standardize_truth_frame(
    df: pl.DataFrame,
    target_default: Optional[str] = None,
    *,
    pad_single_digit_fips: bool = True,
    target_ids: Optional[Sequence[str]] = None,
) -> Optional[pl.DataFrame]:
    """Normalize column names (`observation`/`value`, `truth_date`/`date`/`time_value`, `geo_value`) and dtypes."""
    if df is None or df.is_empty():
        return None
    if target_ids and "target" not in df.columns and not any(c in df.columns for c in ("oracle_value", "observation", "value")):
        wide = unpivot_wide_truth(df, target_ids)
        if wide is not None:
            df = wide

    rename_map: Dict[str, str] = {}
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

    if not {"location", "target_end_date", "oracle_value"}.issubset(df.columns):
        return None

    extra_cols = sorted(c for c in df.columns if c not in _TRUTH_CORE_COLS and c not in TRUTH_EXTRA_IGNORE)
    exprs: List[pl.Expr] = [
        normalize_location_expr("location", pad_single_digit_fips=pad_single_digit_fips),
        iso_date_expr("target_end_date", df.schema["target_end_date"]),
        pl.col("oracle_value").cast(pl.Float64, strict=False),
    ]
    if "target" in df.columns:
        exprs.append(pl.col("target").cast(pl.String).str.strip_chars())
    elif target_default is not None:
        exprs.append(pl.lit(target_default).alias("target"))
    if "horizon" in df.columns:
        exprs.append(pl.col("horizon").fill_null(0).cast(pl.Int32, strict=False))
    else:
        exprs.append(pl.lit(0).cast(pl.Int32).alias("horizon"))
    if "as_of" in df.columns:
        exprs.append(iso_date_expr("as_of", df.schema["as_of"]))
    if "output_type" in df.columns:
        exprs.append(pl.col("output_type").cast(pl.String))
    if "output_type_id" in df.columns:
        exprs.append(pl.col("output_type_id").cast(pl.String))
    for ec in extra_cols:
        exprs.append(pl.col(ec).cast(pl.String).str.strip_chars())

    out = df.with_columns(exprs).drop([c for c in TRUTH_EXTRA_IGNORE if c in df.columns]).filter(
        pl.col("location").is_not_null()
        & (pl.col("location") != "")
        & pl.col("target_end_date").is_not_null()
        & (pl.col("target_end_date") != "")
        & pl.col("oracle_value").is_not_null()
        & ~pl.col("oracle_value").is_nan()
    )
    return None if out.is_empty() else out


def _annotate_vintage(
    df: pl.DataFrame,
    *,
    priority: int,
    ord_idx: int,
    source_id: str,
    label: str,
    inferred_as_of: Optional[str] = None,
) -> pl.DataFrame:
    fallback = (inferred_as_of or "").strip()[:10] or _frame_max_date(df)
    if "as_of" in df.columns:
        raw_as_of = pl.col("as_of").cast(pl.String).str.strip_chars().fill_null("")
        has_explicit = (raw_as_of != "") & ~raw_as_of.is_in(NULL_VALUES)
        eff_expr = pl.when(has_explicit).then(raw_as_of.str.slice(0, 10)).otherwise(pl.lit(fallback))
        exp_expr = pl.when(has_explicit).then(pl.lit(1, dtype=pl.Int8)).otherwise(pl.lit(0, dtype=pl.Int8))
    else:
        eff_expr = pl.lit(fallback)
        exp_expr = pl.lit(0, dtype=pl.Int8)

    return df.with_columns([
        eff_expr.alias("_eff_as_of"),
        exp_expr.alias("_as_of_explicit"),
        pl.lit(int(priority), dtype=pl.Int32).alias("_priority"),
        pl.lit(int(ord_idx), dtype=pl.Int32).alias("_ord"),
        pl.lit(source_id).alias("_src_id"),
        pl.lit(label).alias("_src_label"),
    ])


def _collapse_invariant_horizons(df: pl.DataFrame, varying_targets: Set[str], extra_cols: Sequence[str] = ()) -> pl.DataFrame:
    """Drop redundant replicated horizons per source for targets whose truth does not vary by horizon."""
    if df.is_empty() or "target" not in df.columns:
        return df
    group_base = [c for c in ("_src_id", "_ord", "target", "target_end_date", "location", *extra_cols, "output_type", "output_type_id", "_eff_as_of") if c in df.columns]
    const_df = df.filter(~pl.col("target").is_in(list(varying_targets))) if varying_targets else df
    vary_df = df.filter(pl.col("target").is_in(list(varying_targets))) if varying_targets else pl.DataFrame()
    if not const_df.is_empty():
        const_df = (
            const_df.with_columns((pl.col("horizon") == 0).alias("_h0"))
            .sort("_h0")
            .unique(subset=group_base, keep="last", maintain_order=True)
            .drop("_h0")
            .with_columns(pl.lit(0).cast(pl.Int32).alias("horizon"))
        )
    if vary_df.is_empty():
        return const_df
    if const_df.is_empty():
        return vary_df
    return pl.concat([const_df, vary_df], how="diagonal_relaxed")


def _detect_same_vintage_conflicts(
    df: pl.DataFrame,
    keys: List[str],
    conflict_callback: Callable[[str], None],
) -> None:
    """Emit at most one summary warning per (target, winning source, losing source) when same-vintage values differ."""
    active_keys = [k for k in keys if k in df.columns]
    if not active_keys or "oracle_value" not in df.columns:
        return

    top = df.sort(["_eff_as_of", "_as_of_explicit", "_priority", "_ord"]).with_columns([
        pl.col("_eff_as_of").last().over(active_keys).alias("_win_eff"),
        pl.col("_as_of_explicit").last().over(active_keys).alias("_win_exp"),
        pl.col("_src_id").last().over(active_keys).alias("_win_src"),
        pl.col("_src_label").last().over(active_keys).alias("_win_label"),
        pl.col("oracle_value").last().over(active_keys).alias("_win_val"),
    ])
    tied = top.filter(
        (pl.col("_eff_as_of") == pl.col("_win_eff"))
        & (pl.col("_as_of_explicit") == pl.col("_win_exp"))
        & (pl.col("_src_id") != pl.col("_win_src"))
    )
    if tied.is_empty():
        return

    diff = (pl.col("oracle_value") - pl.col("_win_val")).abs()
    tol = _VALUE_DIFF_REL_TOL * pl.max_horizontal(pl.lit(1.0), pl.col("_win_val").abs())
    conflicts = tied.filter(diff > tol)
    if conflicts.is_empty():
        return

    group_cols = (["target"] if "target" in conflicts.columns else []) + ["_win_eff", "_win_label", "_src_label"]
    summary = conflicts.group_by(group_cols).agg(
        pl.struct(active_keys).n_unique().alias("_n_obs")
    )
    for row in summary.iter_rows(named=True):
        tgt = row.get("target") or "truth"
        vint = row.get("_win_eff") or "unknown"
        winner = row["_win_label"]
        loser = row["_src_label"]
        n_obs = int(row["_n_obs"])
        noun = "observation" if n_obs == 1 else "observations"
        conflict_callback(
            f"Truth disagreement on '{tgt}' (as_of {vint}): {n_obs} {noun} differed between {winner} and {loser}; kept {winner}."
        )


def merge_truth_frames(frames: List[pl.DataFrame], keys: List[str]) -> pl.DataFrame:
    """
    Union truth tables so every observation comes from the most recent vintage and older sources only fill
    gaps. When `as_of` exists on any frame, the newest effective vintage wins per key regardless of frame order;
    when no frame carries `as_of`, frames are assumed oldest-to-newest.
    """
    frames = [f for f in frames if f is not None and not f.is_empty()]
    if not frames:
        return pl.DataFrame()
    if len(frames) == 1:
        return frames[0]

    has_any_as_of = any("as_of" in f.columns for f in frames)
    tagged: List[pl.DataFrame] = []
    for i, f in enumerate(frames):
        if has_any_as_of:
            tagged.append(_annotate_vintage(f, priority=0, ord_idx=i, source_id=str(i), label=str(i)))
        else:
            tagged.append(f.with_columns(pl.lit(i, dtype=pl.Int32).alias("_ord")))

    df = pl.concat(tagged, how="diagonal_relaxed")
    active_keys = [k for k in keys if k in df.columns]
    if has_any_as_of:
        order = ["_eff_as_of", "_as_of_explicit", "_priority", "_ord"]
        out = df.sort(order).unique(subset=active_keys, keep="last", maintain_order=True)
        if "as_of" in out.columns:
            raw_a = pl.col("as_of").cast(pl.String).str.strip_chars().fill_null("")
            out = out.with_columns(
                pl.when(raw_a == "").then(pl.col("_eff_as_of")).otherwise(raw_a).alias("as_of")
            )
        drop_cols = [c for c in ("_eff_as_of", "_as_of_explicit", "_priority", "_ord", "_src_id", "_src_label") if c in out.columns]
        return out.drop(drop_cols)

    return df.sort("_ord").unique(subset=active_keys, keep="last", maintain_order=True).drop("_ord")


def reconcile_truth_sources(
    sources: List[Tuple[TruthSource, pl.DataFrame]],
    keys: List[str],
    *,
    allowed_targets: Optional[Set[str]] = None,
    allowed_locations: Optional[Set[str]] = None,
    filter_external_only: bool = False,
    external_priority_below: int = PRIORITY_REPO,
    collapse_constant_horizons: bool = False,
    target_default: Optional[str] = None,
    conflict_callback: Optional[Callable[[str], None]] = None,
    pad_single_digit_fips: bool = True,
    target_ids: Optional[Sequence[str]] = None,
) -> pl.DataFrame:
    """
    Reconcile normalized truth frames across local repos, S3 hubs, sibling workspace hubs, and archives.
    Returns one row per unique observation key with canonical column types.
    """
    prepared: List[Tuple[TruthSource, pl.DataFrame]] = []
    extra_cols_set: Set[str] = set()
    eff_target_ids = list(target_ids) if target_ids is not None else (sorted(allowed_targets) if allowed_targets else None)
    for src, raw in sources:
        df = _standardize_truth_frame(
            raw,
            target_default=target_default,
            pad_single_digit_fips=pad_single_digit_fips,
            target_ids=eff_target_ids,
        )
        if df is None:
            continue
        extra_cols_set.update(c for c in df.columns if c not in _TRUTH_CORE_COLS and c not in TRUTH_EXTRA_IGNORE)
        apply_filter = (not filter_external_only) or (src.priority < external_priority_below)
        if apply_filter:
            if allowed_targets and "target" in df.columns:
                df = df.filter(pl.col("target").is_in(list(allowed_targets)))
            if allowed_locations and "location" in df.columns:
                df = df.filter(pl.col("location").is_in(list(allowed_locations)))
        if not df.is_empty():
            prepared.append((src, df))

    if not prepared:
        return pl.DataFrame()
    extra_cols = sorted(extra_cols_set)

    # Check once per source/target whether oracle values actually differ across horizons
    varying_targets: Set[str] = set()
    if collapse_constant_horizons:
        for _, df_s in prepared:
            if "target" not in df_s.columns or "horizon" not in df_s.columns:
                continue
            non_pmf = (
                df_s.filter(pl.col("output_type").is_null() | (pl.col("output_type") != "pmf"))
                if "output_type" in df_s.columns else df_s
            )
            if non_pmf.is_empty():
                continue
            check_cols = [c for c in ("target", "location", *extra_cols, "target_end_date", "as_of", "output_type_id") if c in non_pmf.columns]
            v_tgts = (
                non_pmf.group_by(check_cols)
                .agg(pl.col("oracle_value").n_unique().alias("_nv"))
                .filter(pl.col("_nv") > 1)
                .select("target")
                .unique()
                .get_column("target")
                .to_list()
            )
            varying_targets.update(str(t) for t in v_tgts if t is not None)

    annotated: List[pl.DataFrame] = []
    for idx, (src, df_s) in enumerate(prepared):
        ann = _annotate_vintage(
            df_s,
            priority=src.priority,
            ord_idx=idx,
            source_id=src.source_id,
            label=src.label,
            inferred_as_of=src.inferred_as_of,
        )
        annotated.append(ann)

    combined = pl.concat(annotated, how="diagonal_relaxed")
    if "as_of" not in combined.columns:
        combined = combined.with_columns(pl.col("_eff_as_of").alias("as_of"))
    else:
        combined = combined.with_columns(
            pl.when(pl.col("as_of").cast(pl.String).fill_null("").str.strip_chars() == "")
            .then(pl.col("_eff_as_of"))
            .otherwise(pl.col("as_of"))
            .alias("as_of")
        )

    base_keys = list(dict.fromkeys(list(keys) + extra_cols))
    if not collapse_constant_horizons:
        active_keys = [k for k in base_keys if k in combined.columns]
        if conflict_callback is not None:
            _detect_same_vintage_conflicts(combined, active_keys, conflict_callback)
        out = combined.sort(["_eff_as_of", "_as_of_explicit", "_priority", "_ord"]).unique(
            subset=active_keys, keep="last", maintain_order=True
        )
        drop_cols = [c for c in ("_eff_as_of", "_as_of_explicit", "_priority", "_ord", "_src_id", "_src_label") if c in out.columns]
        return out.drop(drop_cols)

    # Split PMF (horizon-indexed categorical distributions) vs continuous targets
    has_ot = "output_type" in combined.columns
    pmf_part = combined.filter(pl.col("output_type") == "pmf") if has_ot else pl.DataFrame()
    cont_part = combined.filter(pl.col("output_type").is_null() | (pl.col("output_type") != "pmf")) if has_ot else combined

    full_oracle_keys = list(dict.fromkeys(ORACLE_KEYS + extra_cols))
    results: List[pl.DataFrame] = []
    for part, dedup_keys, is_cont in (
        (pmf_part, [k for k in full_oracle_keys if k in combined.columns], False),
        (cont_part, None, True),
    ):
        if part.is_empty():
            continue
        if is_cont:
            collapsed = _collapse_invariant_horizons(part, varying_targets, extra_cols=extra_cols)
            const_keys = [k for k in full_oracle_keys if k != "horizon" and k in collapsed.columns]
            vary_keys = [k for k in full_oracle_keys if k in collapsed.columns]
            has_tgt = "target" in collapsed.columns
            sub_const = collapsed.filter(~pl.col("target").is_in(list(varying_targets))) if (has_tgt and varying_targets) else (pl.DataFrame() if varying_targets else collapsed)
            sub_vary = collapsed.filter(pl.col("target").is_in(list(varying_targets))) if (has_tgt and varying_targets) else pl.DataFrame()
            for sub, klist in ((sub_const, const_keys), (sub_vary, vary_keys)):
                if sub.is_empty():
                    continue
                if conflict_callback is not None:
                    _detect_same_vintage_conflicts(sub, klist, conflict_callback)
                results.append(
                    sub.sort(["_eff_as_of", "_as_of_explicit", "_priority", "_ord"]).unique(
                        subset=klist, keep="last", maintain_order=True
                    )
                )
        else:
            if conflict_callback is not None:
                _detect_same_vintage_conflicts(part, dedup_keys, conflict_callback)
            results.append(
                part.sort(["_eff_as_of", "_as_of_explicit", "_priority", "_ord"]).unique(
                    subset=dedup_keys, keep="last", maintain_order=True
                )
            )

    if not results:
        return pl.DataFrame()
    out = pl.concat(results, how="diagonal_relaxed")
    drop_cols = [c for c in ("_eff_as_of", "_as_of_explicit", "_priority", "_ord", "_src_id", "_src_label") if c in out.columns]
    return out.drop(drop_cols)


def reconcile_weekly_series(
    oracle_df: Optional[pl.DataFrame],
    admissions_df: Optional[pl.DataFrame],
    target: str,
    *,
    include_admissions: bool = False,
    dims: Optional[Dict[str, str]] = None,
    pad_single_digit_fips: bool = True,
) -> pl.DataFrame:
    """
    Build one canonical weekly observed series per `(location, target_end_date)` for a target:
    reconciles oracle (non-PMF) and admissions by newest effective vintage, filtering optional
    extra task-ID dimensions (`dims`, e.g. `age_group`) when present.
    """
    empty = pl.DataFrame(schema={"location": pl.String, "target_end_date": pl.String, "value": pl.Float64})
    sources: List[Tuple[TruthSource, pl.DataFrame]] = []

    if oracle_df is not None and not oracle_df.is_empty():
        o = oracle_df
        if "target" in o.columns:
            o = o.filter(pl.col("target") == target)
        if "output_type" in o.columns:
            o = o.filter(pl.col("output_type").is_null() | (pl.col("output_type") != "pmf"))
        if dims:
            for dcol, dval in dims.items():
                if dcol in o.columns and dval is not None:
                    o = o.filter(pl.col(dcol).cast(pl.String) == str(dval))
        if not o.is_empty():
            cols = [c for c in ("target", "location", "target_end_date", "oracle_value", "as_of") if c in o.columns]
            sources.append((
                TruthSource(source_id="oracle", label="oracle", kind="oracle", priority=20),
                o.select(cols),
            ))

    if include_admissions and admissions_df is not None and not admissions_df.is_empty():
        adm = admissions_df
        if "target" in adm.columns:
            adm = adm.filter(pl.col("target") == target)
        if dims:
            for dcol, dval in dims.items():
                if dcol in adm.columns and dval is not None:
                    adm = adm.filter(pl.col(dcol).cast(pl.String) == str(dval))
        adm_cols = [c for c in ("location", "target_end_date", "oracle_value", "as_of") if c in adm.columns]
        if {"location", "target_end_date", "oracle_value"}.issubset(adm_cols) and not adm.is_empty():
            sources.append((
                TruthSource(source_id="admissions", label="admissions", kind="admissions", priority=10),
                adm.select(adm_cols).with_columns(pl.lit(target).alias("target")),
            ))

    if not sources:
        return empty

    merged = reconcile_truth_sources(
        sources,
        ["target", "location", "target_end_date"],
        target_default=target,
        pad_single_digit_fips=pad_single_digit_fips,
    )
    if merged.is_empty():
        return empty
    return (
        merged.select(["location", "target_end_date", pl.col("oracle_value").alias("value")])
        .sort(["location", "target_end_date"])
    )


def reconcile_vintages(
    sources: List[Tuple[TruthSource, pl.DataFrame]],
    *,
    allowed_targets: Optional[Set[str]] = None,
    allowed_locations: Optional[Set[str]] = None,
    filter_external_only: bool = True,
    external_priority_below: int = PRIORITY_REPO,
    pad_single_digit_fips: bool = True,
) -> pl.DataFrame:
    """
    Merge historical point-in-time (`as_of`) surveillance/oracle snapshots across hubs while preserving
    every distinct `(as_of, target, location, [extra_task_ids...], target_end_date)` snapshot.
    """
    schema = {
        "as_of": pl.String,
        "target": pl.String,
        "location": pl.String,
        "target_end_date": pl.String,
        "horizon": pl.Int32,
        "oracle_value": pl.Float64,
    }
    frames: List[pl.DataFrame] = []
    extra_cols_set: Set[str] = set()
    for idx, (src, raw) in enumerate(sources):
        df = _standardize_truth_frame(raw, pad_single_digit_fips=pad_single_digit_fips)
        if df is None:
            continue
        if "output_type" in df.columns:
            df = df.filter(pl.col("output_type").is_null() | (pl.col("output_type") != "pmf"))
        if df.is_empty():
            continue
        if "as_of" not in df.columns:
            if not src.inferred_as_of:
                continue
            df = df.with_columns(pl.lit(src.inferred_as_of[:10]).alias("as_of"))
        else:
            df = df.filter(pl.col("as_of").is_not_null() & (pl.col("as_of") != "") & ~pl.col("as_of").is_in(NULL_VALUES))
        if "target" not in df.columns:
            continue
        apply_filter = (not filter_external_only) or (src.priority < external_priority_below)
        if apply_filter:
            if allowed_targets:
                df = df.filter(pl.col("target").is_in(list(allowed_targets)))
            if allowed_locations:
                df = df.filter(pl.col("location").is_in(list(allowed_locations)))
        if df.is_empty():
            continue
        df_extra = [c for c in df.columns if c not in _TRUTH_CORE_COLS and c not in TRUTH_EXTRA_IGNORE]
        extra_cols_set.update(df_extra)
        frames.append(
            df.select(["as_of", "target", "location", "target_end_date", "horizon", "oracle_value"] + df_extra)
            .with_columns([
                pl.lit(int(src.priority), dtype=pl.Int32).alias("_priority"),
                pl.lit(int(idx), dtype=pl.Int32).alias("_ord"),
            ])
        )

    if not frames:
        return pl.DataFrame(schema=schema)

    extra_cols = sorted(extra_cols_set)
    full_schema = {**schema, **{c: pl.String for c in extra_cols}}
    dedup_keys = ["as_of", "target", "location", "target_end_date"] + extra_cols
    merged = (
        pl.concat(frames, how="diagonal_relaxed")
        .sort(["_priority", "_ord"])
        .unique(subset=dedup_keys, keep="last", maintain_order=True)
        .drop(["_priority", "_ord"])
        .cast(full_schema)
        .sort(["target", "location"] + extra_cols + ["as_of", "target_end_date"])
    )
    return merged
