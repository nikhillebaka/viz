"""
Season peak forecasts: target conventions, row extraction, distribution summaries, and scoring.

Hubs that follow the FluSight convention pair each weekly target ('wk inc flu hosp') with two season-level
targets that have no horizon or target_end_date:
- size:   'peak inc flu hosp'       quantiles of the highest weekly value of the season
- timing: 'peak week inc flu hosp'  pmf over candidate weeks (output_type_id = the Saturday ending each week)

These rows never enter the weekly quantile tables used by the fan chart and leaderboard; they are kept in a
separate per-model "peak" table (canonical schema below) so the weekly code paths are unchanged.
"""

from datetime import date, datetime, timedelta
import math
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np
import polars as pl

PEAK_SCHEMA = {
    "reference_date": pl.String,
    "location": pl.String,
    "target": pl.String,
    "output_type": pl.String,
    "output_type_id": pl.String,
    "value": pl.Float64,
}
PEAK_COLUMNS = list(PEAK_SCHEMA)

# A pmf putting (almost) no mass on the observed week would score an infinite log score; cap it like a
# probability floor of 0.001 so one confident miss cannot dominate a season average
LOG_SCORE_FLOOR = 1e-3
INTERVALS = (0.5, 0.9)


# ---------------------------------------------------------------------------------------------------------
# Target conventions
# ---------------------------------------------------------------------------------------------------------

def is_peak_target(target: Any) -> bool:
    return isinstance(target, str) and target.strip().lower().startswith("peak ")


def is_peak_timing_target(target: Any) -> bool:
    return is_peak_target(target) and target.strip().lower().startswith("peak week ")


def _suffix(target: str) -> str:
    t = target.strip()
    low = t.lower()
    for prefix in ("peak week ", "peak ", "wk "):
        if low.startswith(prefix):
            return t[len(prefix):]
    return t


def peak_targets_for(base_target: str) -> Dict[str, str]:
    """The size and timing peak targets that belong to a weekly target ('wk inc flu hosp')."""
    if not base_target or is_peak_target(base_target):
        return {}
    suffix = _suffix(base_target)
    return {"size": f"peak {suffix}", "timing": f"peak week {suffix}"}


def base_target_for(peak_target: str, weekly_targets: Iterable[str]) -> Optional[str]:
    """The weekly target a peak target summarizes, among the targets the dashboard shows."""
    suffix = _suffix(peak_target).lower()
    for t in weekly_targets:
        if not is_peak_target(t) and _suffix(t).lower() == suffix:
            return t
    return None


# ---------------------------------------------------------------------------------------------------------
# Row extraction (shared by the repo cache builder and hub sync)
# ---------------------------------------------------------------------------------------------------------

def empty_peak_frame() -> pl.DataFrame:
    return pl.DataFrame(schema=PEAK_SCHEMA)


def extract_peak_rows(df: pl.DataFrame, reference_date: Optional[str] = None) -> pl.DataFrame:
    """
    Peak-target rows of one forecast file in the canonical peak schema: pmf rows for timing targets (dates as
    YYYY-MM-DD) and quantile rows for size targets (levels as rounded decimal strings). Other output types
    (samples, cdf) are dropped. Returns an empty frame when the file has no peak targets.
    """
    if df is None or df.is_empty() or "target" not in df.columns or "output_type" not in df.columns:
        return empty_peak_frame()
    sub = df.filter(pl.col("target").cast(pl.String).str.to_lowercase().str.starts_with("peak "))
    if sub.is_empty():
        return empty_peak_frame()

    if "reference_date" in sub.columns:
        dtype = sub.schema["reference_date"]
        ref = (pl.col("reference_date").dt.strftime("%Y-%m-%d") if dtype in (pl.Date, pl.Datetime) or isinstance(dtype, pl.Datetime)
               else pl.col("reference_date").cast(pl.String).str.slice(0, 10))
    else:
        ref = pl.lit(reference_date, dtype=pl.String)

    oid_dtype = sub.schema["output_type_id"]
    oid = (pl.col("output_type_id").dt.strftime("%Y-%m-%d") if oid_dtype in (pl.Date, pl.Datetime) or isinstance(oid_dtype, pl.Datetime)
           else pl.col("output_type_id").cast(pl.String).str.strip_chars())
    loc = pl.col("location").cast(pl.String).str.strip_chars()
    sub = sub.select([
        ref.alias("reference_date"),
        pl.when(loc.str.contains(r"^\d$")).then(loc.str.zfill(2)).otherwise(loc).alias("location"),
        pl.col("target").cast(pl.String),
        pl.col("output_type").cast(pl.String),
        oid.alias("output_type_id"),
        pl.col("value").cast(pl.Float64, strict=False),
    ])
    timing = sub.filter(
        pl.col("target").str.to_lowercase().str.starts_with("peak week ") & (pl.col("output_type") == "pmf")
    ).with_columns(pl.col("output_type_id").str.slice(0, 10))
    size = sub.filter(
        ~pl.col("target").str.to_lowercase().str.starts_with("peak week ") & (pl.col("output_type") == "quantile")
    )
    if not size.is_empty():
        levels = size.get_column("output_type_id").cast(pl.Float64, strict=False).round(4)
        size = size.with_columns(levels.cast(pl.String).alias("output_type_id")).drop_nulls("output_type_id")
    out = pl.concat([timing, size], how="vertical_relaxed").drop_nulls(["location", "output_type_id"])
    return out.select(PEAK_COLUMNS).cast(PEAK_SCHEMA)


def peak_quality_warnings(peak: pl.DataFrame, label: str) -> List[str]:
    """Data-quality notes for one file's peak rows (pmfs that do not sum to one, crossing size quantiles)."""
    if peak.is_empty():
        return []
    warnings = []
    timing = peak.filter(pl.col("output_type") == "pmf")
    if not timing.is_empty():
        sums = timing.group_by(["target", "location"]).agg(pl.col("value").sum().alias("s"))
        bad = sums.filter((pl.col("s") - 1.0).abs() > 0.01).height
        if bad:
            warnings.append(f"{label}: {bad} peak-week pmfs do not sum to 1 (shown renormalized)")
        if timing.filter(pl.col("value") < 0).height:
            warnings.append(f"{label}: negative peak-week probabilities")
    size = peak.filter(pl.col("output_type") == "quantile")
    if not size.is_empty():
        crossed = (
            size.with_columns(pl.col("output_type_id").cast(pl.Float64).alias("_q"))
            .sort(["target", "location", "_q"])
            .group_by(["target", "location"], maintain_order=True)
            .agg((pl.col("value").diff() < -1e-9).any().alias("c"))
            .get_column("c").sum()
        )
        if crossed:
            warnings.append(f"{label}: {crossed} peak-size forecasts have crossing quantiles")
    return warnings


# ---------------------------------------------------------------------------------------------------------
# Distribution summaries
# ---------------------------------------------------------------------------------------------------------

def _shift(d: str, days: int) -> str:
    return (datetime.strptime(d, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")


def summarize_timing(dates: Sequence[str], probs: Sequence[float], data_cutoff: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    Summary of a peak-week pmf on its candidate weeks (sorted dates). Probabilities are renormalized when a
    submission does not sum exactly to one. Intervals are central: the 50% window runs from the week where
    the cumulative probability first reaches 25% to where it reaches 75%.
    """
    pairs = sorted((d, max(0.0, float(p))) for d, p in zip(dates, probs) if p is not None and not math.isnan(p))
    total = sum(p for _, p in pairs)
    if not pairs or total <= 0:
        return None
    ds = [d for d, _ in pairs]
    ps = [p / total for _, p in pairs]
    cdf = np.cumsum(ps)

    def q(level: float) -> str:
        idx = int(np.searchsorted(cdf, level - 1e-9))
        return ds[min(idx, len(ds) - 1)]

    mode_i = int(np.argmax(ps))
    out: Dict[str, Any] = {
        "dates": ds,
        "probs": [round(p, 6) for p in ps],
        "raw_sum": round(total, 4),
        "median": q(0.5),
        "mode": ds[mode_i],
        "mode_prob": round(ps[mode_i], 4),
        "i50": [q(0.25), q(0.75)],
        "i90": [q(0.05), q(0.95)],
    }
    if data_cutoff:
        out["p_passed"] = round(float(sum(p for d, p in zip(ds, ps) if d <= data_cutoff)), 4)
    return out


def _interp_quantile(levels: np.ndarray, values: np.ndarray, q: float) -> Optional[float]:
    if len(levels) == 0:
        return None
    hit = np.where(np.abs(levels - q) < 1e-6)[0]
    if len(hit):
        return float(values[hit[0]])
    if q < levels[0] or q > levels[-1]:
        return None
    return float(np.interp(q, levels, values))


def summarize_size(levels: Sequence[float], values: Sequence[float]) -> Optional[Dict[str, Any]]:
    """Median and 50%/90%/95% intervals of a peak-size quantile forecast (sorted, monotone-repaired)."""
    pairs = sorted((float(l), float(v)) for l, v in zip(levels, values) if v is not None and not math.isnan(v))
    if not pairs:
        return None
    lv = np.array([p[0] for p in pairs])
    vv = np.maximum.accumulate(np.array([p[1] for p in pairs]))
    med = _interp_quantile(lv, vv, 0.5)
    if med is None:
        return None
    out = {
        "median": med,
        "i50": [_interp_quantile(lv, vv, 0.25), _interp_quantile(lv, vv, 0.75)],
        "i90": [_interp_quantile(lv, vv, 0.05), _interp_quantile(lv, vv, 0.95)],
        "i95": [_interp_quantile(lv, vv, 0.025), _interp_quantile(lv, vv, 0.975)],
        "levels": [round(float(x), 4) for x in lv],
        "values": [float(x) for x in vv],
    }
    return out


# ---------------------------------------------------------------------------------------------------------
# Scoring against an observed (final) peak
# ---------------------------------------------------------------------------------------------------------

def week_index(d: str, origin: str) -> int:
    return round((datetime.strptime(d, "%Y-%m-%d") - datetime.strptime(origin, "%Y-%m-%d")).days / 7)


def score_timing(timing: Dict[str, Any], peak_dates: Sequence[str]) -> Optional[Dict[str, Any]]:
    """
    Scores of a peak-week pmf against the observed peak week(s):
    - log_score: -ln P(observed week), summing over weeks tied at the maximum, floored at LOG_SCORE_FLOOR
    - rps: ranked probability score over the ordered weeks (sum of squared CDF differences). With unit
      week spacing it is in weeks and equals the absolute week error for a forecast that is certain
    - week_error: forecast median week minus the observed peak week (signed, weeks)
    - in50 / in90: whether the observed week falls in the central 50% / 90% windows
    """
    if not timing or not peak_dates:
        return None
    ds, ps = timing["dates"], timing["probs"]
    obs = sorted(peak_dates)[0]
    origin = ds[0]
    # Weeks on a regular grid, so a missing candidate week counts as zero probability (not as no week)
    all_weeks = sorted(set(ds) | {obs})
    grid = [week_index(d, origin) for d in all_weeks]
    lo, hi = min(grid), max(grid)
    prob = np.zeros(hi - lo + 1)
    for d, p in zip(ds, ps):
        prob[week_index(d, origin) - lo] += p
    obs_i = week_index(obs, origin) - lo
    cdf = np.cumsum(prob)
    truth_cdf = (np.arange(len(prob)) >= obs_i).astype(float)
    rps = float(np.sum((cdf - truth_cdf) ** 2))

    tied = set(peak_dates)
    p_obs = float(sum(p for d, p in zip(ds, ps) if d in tied))
    return {
        "log_score": float(-math.log(max(p_obs, LOG_SCORE_FLOOR))),
        "p_observed": round(p_obs, 4),
        "rps": rps,
        "week_error": week_index(timing["median"], obs),
        "in50": timing["i50"][0] <= obs <= timing["i50"][1],
        "in90": timing["i90"][0] <= obs <= timing["i90"][1],
    }


def score_size(size: Dict[str, Any], observed: float) -> Optional[Dict[str, Any]]:
    """WIS (mean pinball loss, identical to the leaderboard's) plus median error and interval hits."""
    if not size or observed is None:
        return None
    lv = np.array(size["levels"])
    vv = np.array(size["values"])
    y = float(observed)
    wis = float(np.mean(2.0 * ((y < vv).astype(float) - lv) * (vv - y)))
    med = size["median"]
    i50, i90 = size["i50"], size["i90"]
    return {
        "wis": wis,
        "error": med - y,
        "pct_error": ((med - y) / y * 100.0) if y > 0 else None,
        "in50": None if None in i50 else bool(i50[0] <= y <= i50[1]),
        "in90": None if None in i90 else bool(i90[0] <= y <= i90[1]),
    }


# ---------------------------------------------------------------------------------------------------------
# Observed peaks
# ---------------------------------------------------------------------------------------------------------

def observed_peak(
    series: Sequence[Tuple[str, float]],
    window: Tuple[str, str],
    today: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    The observed peak of one location's season inside the forecast window [start, end] (inclusive), from a
    (date, value) weekly series. It is final once observations reach the end of the window; before that it
    is the provisional peak to date. Weeks tied at the maximum are all returned (dates[0] is the earliest).
    """
    start, end = window
    pts = [(d, float(v)) for d, v in series if v is not None and start <= d <= end and not math.isnan(v)]
    if not pts:
        return None
    pts.sort()
    peak_val = max(v for _, v in pts)
    dates = [d for d, v in pts if v == peak_val]
    last = pts[-1][0]
    return {
        "value": peak_val,
        "date": dates[0],
        "dates": dates,
        "last_observed": last,
        "final": last >= end,
        "window": [start, end],
    }


def default_window(season: str) -> Tuple[str, str]:
    """Forecast window when no submission tells us its candidate weeks: first Saturday of October to the last of May."""
    y = int(season[:4])
    d = date(y, 10, 1)
    d += timedelta(days=(5 - d.weekday()) % 7)
    e = date(y + 1, 5, 31)
    e -= timedelta(days=(e.weekday() - 5) % 7)
    return d.strftime("%Y-%m-%d"), e.strftime("%Y-%m-%d")
