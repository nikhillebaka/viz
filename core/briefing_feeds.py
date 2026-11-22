"""
Live external epidemiological, wastewater, epidemic-trend, virology, and genomic
clade feed fetcher and Parquet cache store for Place-First Briefings.

Every upstream feed is open and unauthenticated (Socrata CDC Open Data, CMU
Delphi Epidata, WHO RespiMart FluNet, UKHSA Data Dashboard, Nextstrain), making
both on-demand refresh and scheduled background refreshes in a persistent server
straightforward. Cached tables live as atomic Parquet files plus metadata JSON
under `<data_dir>/briefings/`.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
from datetime import date, datetime, timedelta, timezone
import gzip
import io
import json
import logging
import os
from pathlib import Path
import ssl
import tempfile
import threading
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple
import urllib.error
import urllib.parse
import urllib.request

import polars as pl

from viz.core.geo import (
    EUROPE_REF,
    HHS_REGIONS,
    STATE_TO_HHS_REGION,
    US_ABBR_TO_FIPS,
    US_NAME_TO_FIPS,
    US_STATES_REF,
)

logger = logging.getLogger("viz.briefing_feeds")

DEFAULT_HTTP_TIMEOUT_SEC = 25
USER_AGENT = "RespiViz-Briefings/1.0 (+https://github.com/cdcepi)"

# Two-digit US FIPS -> HHS Region number (1..10)
US_FIPS_TO_HHS: Dict[str, int] = {
    fips: int(STATE_TO_HHS_REGION[info["abbr"]])
    for fips, info in US_STATES_REF.items()
    if fips != "US" and info.get("abbr") in STATE_TO_HHS_REGION
}

_US_EXTRA_NAME_ALIASES: Dict[str, str] = {
    "united states": "US",
    "usa": "US",
    "national": "US",
    "nat": "US",
    "us": "US",
    "virgin islands": "78",
    "u.s. virgin islands": "78",
    "district of columbia": "11",
    "washington, d.c.": "11",
    "washington dc": "11",
    "new york city": "36",
    "nyc": "36",
}

_EU_EXTRA_ISO2_ALIASES: Dict[str, str] = {
    "EL": "GR",
    "UK": "GB",
}
_EU_NAME_TO_ISO2: Dict[str, str] = {
    info["name"].lower(): code
    for code, info in EUROPE_REF.items()
    if info.get("name")
}
_EU_NAME_TO_ISO2.update({
    "czech republic": "CZ",
    "united kingdom of great britain and northern ireland": "GB",
    "russian federation": "RU",
    "moldova": "MD",
    "republic of moldova": "MD",
    "türkiye": "TR",
    "turkiye": "TR",
})


WHO_NH_VACCINE_REFERENCE: List[Dict[str, Any]] = [
    {
        "season": "2026-27",
        "pathogen": "Influenza",
        "subtype": "A(H1N1)pdm09",
        "egg_strain": "A/Missouri/11/2025 (H1N1)pdm09-like",
        "cell_strain": "A/Missouri/11/2025 (H1N1)pdm09-like",
        "authority": "WHO NH (Feb 27, 2026)",
        "url": "https://www.who.int/publications/m/item/recommended-composition-of-influenza-virus-vaccines-for-use-in-the-2026-2027-northern-hemisphere-influenza-season",
    },
    {
        "season": "2026-27",
        "pathogen": "Influenza",
        "subtype": "A(H3N2)",
        "egg_strain": "A/Darwin/1454/2025 (H3N2)-like",
        "cell_strain": "A/Darwin/1415/2025 (H3N2)-like",
        "authority": "WHO NH (Feb 27, 2026)",
        "url": "https://www.who.int/publications/m/item/recommended-composition-of-influenza-virus-vaccines-for-use-in-the-2026-2027-northern-hemisphere-influenza-season",
    },
    {
        "season": "2026-27",
        "pathogen": "Influenza",
        "subtype": "B/Victoria",
        "egg_strain": "B/Tokyo/EIS13-175/2025 (B/Victoria)-like",
        "cell_strain": "B/Pennsylvania/14/2025 (B/Victoria)-like",
        "authority": "WHO NH (Feb 27, 2026)",
        "url": "https://www.who.int/publications/m/item/recommended-composition-of-influenza-virus-vaccines-for-use-in-the-2026-2027-northern-hemisphere-influenza-season",
    },
    {
        "season": "2026-27",
        "pathogen": "COVID-19",
        "subtype": "SARS-CoV-2",
        "egg_strain": "Monovalent XFG (US FDA) / LP.8.1 or contemporary JN.1 lineage (WHO TAG-CO-VAC)",
        "cell_strain": "Monovalent XFG / LP.8.1",
        "authority": "FDA VRBPAC / WHO TAG-CO-VAC",
        "url": "https://www.who.int/groups/technical-advisory-group-on-covid-19-vaccine-composition-(tag-co-vac)",
    },
    {
        "season": "2025-26",
        "pathogen": "Influenza",
        "subtype": "A(H1N1)pdm09",
        "egg_strain": "A/Victoria/4897/2022 (H1N1)pdm09-like",
        "cell_strain": "A/Wisconsin/67/2022 (H1N1)pdm09-like",
        "authority": "WHO NH (Feb 28, 2025)",
        "url": "https://www.who.int/publications/m/item/recommended-composition-of-influenza-virus-vaccines-for-use-in-the-2025-2026-northern-hemisphere-influenza-season",
    },
    {
        "season": "2025-26",
        "pathogen": "Influenza",
        "subtype": "A(H3N2)",
        "egg_strain": "A/Croatia/10136RV/2023 (H3N2)-like",
        "cell_strain": "A/District of Columbia/27/2023 (H3N2)-like",
        "authority": "WHO NH (Feb 28, 2025)",
        "url": "https://www.who.int/publications/m/item/recommended-composition-of-influenza-virus-vaccines-for-use-in-the-2025-2026-northern-hemisphere-influenza-season",
    },
    {
        "season": "2025-26",
        "pathogen": "Influenza",
        "subtype": "B/Victoria",
        "egg_strain": "B/Austria/1359417/2021 (B/Victoria)-like",
        "cell_strain": "B/Austria/1359417/2021 (B/Victoria)-like",
        "authority": "WHO NH (Feb 28, 2025)",
        "url": "https://www.who.int/publications/m/item/recommended-composition-of-influenza-virus-vaccines-for-use-in-the-2025-2026-northern-hemisphere-influenza-season",
    },
    {
        "season": "2025-26",
        "pathogen": "COVID-19",
        "subtype": "SARS-CoV-2",
        "egg_strain": "Monovalent LP.8.1 (JN.1 lineage)",
        "cell_strain": "Monovalent LP.8.1",
        "authority": "WHO TAG-CO-VAC / US FDA",
        "url": "https://www.who.int/groups/technical-advisory-group-on-covid-19-vaccine-composition-(tag-co-vac)",
    },
]


FEED_SPECS: Dict[str, Dict[str, Any]] = {
    "cdc_nwss": {
        "label": "CDC NWSS Wastewater",
        "source_url": "https://data.cdc.gov/resource/atcp-73re.json",
        "ttl_hours": 24.0,
        "scope": "US",
        "description": "State and national wastewater viral activity levels for Influenza A, SARS-CoV-2, and RSV.",
    },
    "cdc_cfa_rt": {
        "label": "CDC CFA Rt Epidemic Trends",
        "source_url": "https://data.cdc.gov/resource/5dqz-y4ea.json",
        "ttl_hours": 24.0,
        "scope": "US",
        "description": "Real-time time-varying reproduction number (Rt) and growth probability by state.",
    },
    "cdc_nssp_ed": {
        "label": "CDC NSSP Emergency Dept. Visits",
        "source_url": "https://data.cdc.gov/resource/vutn-jzwm.json",
        "ttl_hours": 24.0,
        "scope": "US",
        "description": "Weekly share of ED visits associated with Influenza, COVID-19, RSV, and Combined ARI.",
    },
    "cdc_nrevss": {
        "label": "CDC NREVSS Lab Positivity",
        "source_url": "https://data.cdc.gov/resource/seuz-s2cv.json",
        "ttl_hours": 24.0,
        "scope": "US",
        "description": "National sentinel laboratory percent positivity for COVID-19 and RSV.",
    },
    "delphi_fluview": {
        "label": "CMU Delphi FluView Clinical",
        "source_url": "https://api.delphi.cmu.edu/epidata/fluview_clinical/",
        "ttl_hours": 24.0,
        "scope": "US",
        "description": "Clinical laboratory influenza specimen totals, Influenza A/B detections, and % positivity by HHS region.",
    },
    "who_flunet": {
        "label": "WHO RespiMart FluNet",
        "source_url": "https://xmart-api-public.who.int/FLUMART/VIW_FNT",
        "ttl_hours": 24.0,
        "scope": "EU+US",
        "description": "Weekly virological detections for Influenza A(H1N1)pdm09, A(H3N2), A(unsubtyped), B, and RSV.",
    },
    "ukhsa_resp": {
        "label": "UKHSA Respiratory Surveillance",
        "source_url": "https://api.ukhsa-dashboard.data.gov.uk/",
        "ttl_hours": 24.0,
        "scope": "GB",
        "description": "England/UK weekly PCR testing positivity for Influenza, COVID-19, and RSV.",
    },
    "nextstrain_clades": {
        "label": "Nextstrain Clades (NA & Europe)",
        "source_url": "https://data.nextstrain.org/",
        "ttl_hours": 12.0,
        "scope": "US+EU",
        "description": "Regional circulating clade/subclade frequencies for Influenza A(H3N2), A(H1N1)pdm09, and SARS-CoV-2.",
    },
    "ecdc_erviss": {
        "label": "ECDC ERVISS Surveillance",
        "source_url": "https://github.com/EU-ECDC/Respiratory_viruses_weekly_data",
        "ttl_hours": 24.0,
        "scope": "EU",
        "description": "European sentinel test positivity (Influenza, SARS-CoV-2, RSV), primary care ILI/ARI consultation rates, and SARI hospitalization rates.",
    },
}

FEED_SCHEMAS: Dict[str, Dict[str, Any]] = {
    "cdc_nwss": {
        "location_id": pl.Utf8,
        "location_name": pl.Utf8,
        "pathogen": pl.Utf8,
        "week_end": pl.Utf8,
        "mean_wval": pl.Float64,
        "sites": pl.Int64,
        "is_national_agg": pl.Boolean,
    },
    "cdc_cfa_rt": {
        "location_id": pl.Utf8,
        "location_name": pl.Utf8,
        "pathogen": pl.Utf8,
        "date": pl.Utf8,
        "as_of": pl.Utf8,
        "median": pl.Float64,
        "lower": pl.Float64,
        "upper": pl.Float64,
        "p_growing": pl.Float64,
        "category": pl.Utf8,
    },
    "cdc_nssp_ed": {
        "location_id": pl.Utf8,
        "location_name": pl.Utf8,
        "pathogen": pl.Utf8,
        "week_end": pl.Utf8,
        "percent_visits": pl.Float64,
    },
    "cdc_nrevss": {
        "location_id": pl.Utf8,
        "region_label": pl.Utf8,
        "pathogen": pl.Utf8,
        "week_end": pl.Utf8,
        "percent_positivity": pl.Float64,
    },
    "delphi_fluview": {
        "region": pl.Utf8,
        "hhs_region": pl.Int64,
        "epiweek": pl.Int64,
        "week_end": pl.Utf8,
        "release_date": pl.Utf8,
        "total_specimens": pl.Int64,
        "total_a": pl.Int64,
        "total_b": pl.Int64,
        "percent_positive": pl.Float64,
        "percent_a": pl.Float64,
        "percent_b": pl.Float64,
    },
    "who_flunet": {
        "location_id": pl.Utf8,
        "country_name": pl.Utf8,
        "who_region": pl.Utf8,
        "week_start": pl.Utf8,
        "spec_processed": pl.Int64,
        "ah1n1pdm09": pl.Int64,
        "ah3n2": pl.Int64,
        "a_unsubtyped": pl.Int64,
        "inf_a": pl.Int64,
        "inf_b": pl.Int64,
        "inf_all": pl.Int64,
        "rsv": pl.Int64,
        "rsv_processed": pl.Int64,
    },
    "ukhsa_resp": {
        "location_id": pl.Utf8,
        "geography": pl.Utf8,
        "pathogen": pl.Utf8,
        "metric": pl.Utf8,
        "week_end": pl.Utf8,
        "value": pl.Float64,
    },
    "nextstrain_clades": {
        "pathogen": pl.Utf8,
        "subtype": pl.Utf8,
        "region": pl.Utf8,
        "date": pl.Utf8,
        "clade": pl.Utf8,
        "frequency": pl.Float64,
    },
    "ecdc_erviss": {
        "location_id": pl.Utf8,
        "country_name": pl.Utf8,
        "indicator": pl.Utf8,
        "pathogen": pl.Utf8,
        "week_end": pl.Utf8,
        "value": pl.Float64,
        "unit": pl.Utf8,
    },
}


# ---------------------------------------------------------------------------
# Normalization & HTTP helpers
# ---------------------------------------------------------------------------


def _empty_df(feed_id: str) -> pl.DataFrame:
    return pl.DataFrame(schema=FEED_SCHEMAS[feed_id])


def _safe_float(val: Any) -> Optional[float]:
    if val is None or val == "":
        return None
    try:
        f = float(val)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def _safe_int(val: Any) -> Optional[int]:
    if val is None or val == "":
        return None
    try:
        return int(round(float(val)))
    except (TypeError, ValueError):
        return None


def _iso_date_str(val: Any) -> Optional[str]:
    if val is None:
        return None
    s = str(val).strip()
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    return None


def _decimal_year_to_iso(dec_year: float) -> str:
    """Convert Nextstrain decimal year pivot (e.g. 2026.8808) -> YYYY-MM-DD."""
    year = int(dec_year)
    frac = max(0.0, float(dec_year) - year)
    start = date(year, 1, 1)
    days_in_year = 366 if (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)) else 365
    dt = start + timedelta(days=int(round(frac * days_in_year)))
    return dt.isoformat()


def _epiweek_to_saturday_iso(epiweek: int) -> Optional[str]:
    """Convert MMWR epiweek YYYYWW -> Saturday YYYY-MM-DD."""
    try:
        year = epiweek // 100
        week = epiweek % 100
        if week < 1 or week > 53:
            return None
        jan4 = date(year, 1, 4)
        # MMWR week 1 starts on the Sunday of the week containing Jan 4.
        days_since_sunday = (jan4.weekday() + 1) % 7
        wk1_sun = jan4 - timedelta(days=days_since_sunday)
        wk_sat = wk1_sun + timedelta(days=(week - 1) * 7 + 6)
        return wk_sat.isoformat()
    except (TypeError, ValueError):
        return None


def _iso_yearweek_to_sunday(yw: Any) -> Optional[str]:
    """Convert ISO year-week string 'YYYY-Www' -> Sunday YYYY-MM-DD."""
    s = str(yw or "").strip().upper()
    if "-W" in s:
        parts = s.split("-W", 1)
    elif "W" in s:
        parts = s.split("W", 1)
    else:
        return None
    if len(parts) != 2:
        return None
    try:
        year = int(parts[0])
        week = int(parts[1])
        return date.fromisocalendar(year, week, 7).isoformat()
    except (TypeError, ValueError):
        return None


def normalize_pathogen_name(raw: Any) -> str:
    s = str(raw or "").strip().lower()
    if not s:
        return "other"
    if "influenza" in s or "flu" in s:
        if "b" in s and "virus" not in s and "influenza b" in s:
            return "flu_b"
        return "flu"
    if "covid" in s or "sars-cov-2" in s or "sars" in s or "ncov" in s:
        return "covid-19"
    if "rsv" in s or "respiratory syncytial" in s:
        return "rsv"
    if "combined" in s or "ari" in s or "acute respiratory" in s:
        return "ari"
    return s


def resolve_us_location_id(raw: Any) -> Optional[str]:
    s = str(raw or "").strip()
    if not s:
        return None
    low = s.lower()
    if low in _US_EXTRA_NAME_ALIASES:
        return _US_EXTRA_NAME_ALIASES[low]
    if low in US_NAME_TO_FIPS:
        return US_NAME_TO_FIPS[low]
    up = s.upper()
    if up in US_ABBR_TO_FIPS:
        return US_ABBR_TO_FIPS[up]
    if s in US_STATES_REF:
        return s
    if s.isdigit() and len(s) <= 2:
        padded = s.zfill(2)
        if padded in US_STATES_REF:
            return padded
    return None


def resolve_eu_location_id(iso2: Any, country_name: Any = None) -> Optional[str]:
    code = str(iso2 or "").strip().upper()
    if code:
        code = _EU_EXTRA_ISO2_ALIASES.get(code, code)
        if code in EUROPE_REF or len(code) == 2:
            return code
    name_low = str(country_name or "").strip().lower()
    if name_low in _EU_NAME_TO_ISO2:
        return _EU_NAME_TO_ISO2[name_low]
    return None


def _default_http_get(url: str, timeout: int = DEFAULT_HTTP_TIMEOUT_SEC) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
        },
    )
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        raw = resp.read()
        enc = (resp.headers.get("Content-Encoding") or "").lower()
        if "gzip" in enc or raw[:2] == b"\x1f\x8b":
            return gzip.decompress(raw)
        return raw


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as tmp:
        tmp.write(data)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_name = tmp.name
    os.replace(tmp_name, path)


def _atomic_write_parquet(df: pl.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=str(path.parent),
        prefix=f".{path.stem}.",
        suffix=".parquet.tmp",
        delete=False,
    ) as tmp:
        tmp_name = tmp.name
    try:
        df.write_parquet(tmp_name)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Individual Live API Fetchers (pure bytes -> Polars DataFrame)
# ---------------------------------------------------------------------------


def _cutoff_date_str(days: int) -> str:
    return (date.today() - timedelta(days=days)).isoformat()


def fetch_cdc_nwss(http_get: Callable[[str, int], bytes]) -> pl.DataFrame:
    cutoff = _cutoff_date_str(240)
    params = urllib.parse.urlencode({
        "$select": (
            "state_territory,pathogen_target,week_end,"
            "avg(site_wval) as mean_wval,count(site) as sites"
        ),
        "$where": f"week_end >= '{cutoff}'",
        "$group": "state_territory,pathogen_target,week_end",
        "$order": "week_end DESC",
        "$limit": 50000,
    })
    url = f"https://data.cdc.gov/resource/atcp-73re.json?{params}"
    payload = json.loads(http_get(url, DEFAULT_HTTP_TIMEOUT_SEC).decode("utf-8"))
    rows: List[Dict[str, Any]] = []
    seen_us: set[tuple[str, str]] = set()
    for rec in payload:
        if not isinstance(rec, dict):
            continue
        loc_raw = rec.get("state_territory")
        loc_id = resolve_us_location_id(loc_raw)
        if not loc_id:
            continue
        wk = _iso_date_str(rec.get("week_end"))
        val = _safe_float(rec.get("mean_wval"))
        if not wk or val is None:
            continue
        pathogen = normalize_pathogen_name(rec.get("pathogen_target"))
        sites = _safe_int(rec.get("sites")) or 0
        loc_name = US_STATES_REF.get(loc_id, {}).get("name") or str(loc_raw)
        is_nat = loc_id == "US"
        if is_nat:
            seen_us.add((pathogen, wk))
        rows.append({
            "location_id": loc_id,
            "location_name": loc_name,
            "pathogen": pathogen,
            "week_end": wk,
            "mean_wval": val,
            "sites": sites,
            "is_national_agg": False,
        })

    if not rows:
        return _empty_df("cdc_nwss")

    df = pl.DataFrame(rows, schema=FEED_SCHEMAS["cdc_nwss"])
    # Synthesize site-weighted National WVAL aggregate where API has state rows only
    state_df = df.filter(pl.col("location_id") != "US")
    if state_df.height > 0:
        agg = (
            state_df
            .with_columns(
                pl.when(pl.col("sites") > 0).then(pl.col("sites")).otherwise(1).alias("_w")
            )
            .group_by(["pathogen", "week_end"])
            .agg([
                ((pl.col("mean_wval") * pl.col("_w")).sum() / pl.col("_w").sum()).alias("mean_wval"),
                pl.col("sites").sum().cast(pl.Int64).alias("sites"),
            ])
            .with_columns([
                pl.lit("US").alias("location_id"),
                pl.lit("United States").alias("location_name"),
                pl.lit(True).alias("is_national_agg"),
            ])
            .select(list(FEED_SCHEMAS["cdc_nwss"].keys()))
        )
        if seen_us:
            seen_df = pl.DataFrame([{"pathogen": p, "week_end": w} for (p, w) in seen_us])
            agg = agg.join(seen_df, on=["pathogen", "week_end"], how="anti")
        if agg.height > 0:
            df = pl.concat([df, agg], how="vertical")

    return df.sort(["pathogen", "location_id", "week_end"], descending=[False, False, True])


def fetch_cdc_cfa_rt(http_get: Callable[[str, int], bytes]) -> pl.DataFrame:
    cutoff = _cutoff_date_str(120)
    params = urllib.parse.urlencode({
        "$where": f"date >= '{cutoff}T00:00:00'",
        "$order": "date DESC",
        "$limit": 50000,
    })
    url = f"https://data.cdc.gov/resource/5dqz-y4ea.json?{params}"
    payload = json.loads(http_get(url, DEFAULT_HTTP_TIMEOUT_SEC).decode("utf-8"))
    best: Dict[tuple[str, str, str], Dict[str, Any]] = {}
    for rec in payload:
        if not isinstance(rec, dict):
            continue
        loc_id = resolve_us_location_id(rec.get("state"))
        if not loc_id:
            continue
        dt = _iso_date_str(rec.get("date"))
        as_of = _iso_date_str(rec.get("as_of")) or dt
        median = _safe_float(rec.get("median"))
        if not dt or median is None:
            continue
        pathogen = normalize_pathogen_name(rec.get("disease"))
        key = (loc_id, pathogen, dt)
        prev = best.get(key)
        if prev is not None and (prev["as_of"] or "") >= (as_of or ""):
            continue
        best[key] = {
            "location_id": loc_id,
            "location_name": US_STATES_REF.get(loc_id, {}).get("name") or str(rec.get("state")),
            "pathogen": pathogen,
            "date": dt,
            "as_of": as_of or "",
            "median": median,
            "lower": _safe_float(rec.get("lower")),
            "upper": _safe_float(rec.get("upper")),
            "p_growing": _safe_float(rec.get("p_growing")),
            "category": str(rec.get("category") or "").strip(),
        }
    if not best:
        return _empty_df("cdc_cfa_rt")
    return pl.DataFrame(list(best.values()), schema=FEED_SCHEMAS["cdc_cfa_rt"]).sort(
        ["pathogen", "location_id", "date"], descending=[False, False, True]
    )


def fetch_cdc_nssp_ed(http_get: Callable[[str, int], bytes]) -> pl.DataFrame:
    cutoff = _cutoff_date_str(240)
    params = urllib.parse.urlencode({
        "$where": f"week_end >= '{cutoff}T00:00:00'",
        "$order": "week_end DESC",
        "$limit": 50000,
    })
    url = f"https://data.cdc.gov/resource/vutn-jzwm.json?{params}"
    payload = json.loads(http_get(url, DEFAULT_HTTP_TIMEOUT_SEC).decode("utf-8"))
    rows: List[Dict[str, Any]] = []
    for rec in payload:
        if not isinstance(rec, dict):
            continue
        geo_raw = rec.get("geography")
        loc_id = resolve_us_location_id(geo_raw)
        if not loc_id:
            continue
        wk = _iso_date_str(rec.get("week_end"))
        pct = _safe_float(rec.get("percent_visits"))
        if not wk or pct is None:
            continue
        rows.append({
            "location_id": loc_id,
            "location_name": US_STATES_REF.get(loc_id, {}).get("name") or str(geo_raw),
            "pathogen": normalize_pathogen_name(rec.get("pathogen")),
            "week_end": wk,
            "percent_visits": pct,
        })
    if not rows:
        return _empty_df("cdc_nssp_ed")
    return pl.DataFrame(rows, schema=FEED_SCHEMAS["cdc_nssp_ed"]).sort(
        ["pathogen", "location_id", "week_end"], descending=[False, False, True]
    )


def fetch_cdc_nrevss(http_get: Callable[[str, int], bytes]) -> pl.DataFrame:
    cutoff = _cutoff_date_str(300)
    params = urllib.parse.urlencode({
        "$where": f"week_end >= '{cutoff}T00:00:00'",
        "$order": "week_end DESC",
        "$limit": 20000,
    })
    url = f"https://data.cdc.gov/resource/seuz-s2cv.json?{params}"
    payload = json.loads(http_get(url, DEFAULT_HTTP_TIMEOUT_SEC).decode("utf-8"))
    rows: List[Dict[str, Any]] = []
    for rec in payload:
        if not isinstance(rec, dict):
            continue
        wk = _iso_date_str(rec.get("week_end"))
        pct = _safe_float(rec.get("percent_test_positivity"))
        if not wk or pct is None:
            continue
        raw_reg = rec.get("hhs_region") or rec.get("region") or rec.get("geography") or "United States"
        loc_id = resolve_us_location_id(raw_reg) or str(raw_reg).strip()
        rows.append({
            "location_id": loc_id,
            "region_label": str(raw_reg).strip(),
            "pathogen": normalize_pathogen_name(rec.get("pathogen")),
            "week_end": wk,
            "percent_positivity": pct,
        })
    if not rows:
        return _empty_df("cdc_nrevss")
    return pl.DataFrame(rows, schema=FEED_SCHEMAS["cdc_nrevss"]).sort(
        ["pathogen", "location_id", "week_end"], descending=[False, False, True]
    )


def fetch_delphi_fluview(http_get: Callable[[str, int], bytes]) -> pl.DataFrame:
    today = date.today()
    start_yr = today.year - 1 if today.month >= 7 else today.year - 2
    end_yr = today.year + 1
    regions = ",".join(["nat", *[f"hhs{i}" for i in range(1, 11)]])
    url = (
        f"https://api.delphi.cmu.edu/epidata/fluview_clinical/"
        f"?regions={regions}&epiweeks={start_yr}40-{end_yr}52"
    )
    payload = json.loads(http_get(url, DEFAULT_HTTP_TIMEOUT_SEC).decode("utf-8"))
    epidata = payload.get("epidata") if isinstance(payload, dict) else None
    if not isinstance(epidata, list):
        return _empty_df("delphi_fluview")
    rows: List[Dict[str, Any]] = []
    for rec in epidata:
        if not isinstance(rec, dict):
            continue
        ew = _safe_int(rec.get("epiweek"))
        reg = str(rec.get("region") or "").strip().lower()
        if not ew or not reg:
            continue
        wk_end = _epiweek_to_saturday_iso(ew)
        if not wk_end:
            continue
        hhs_num: Optional[int] = None
        if reg.startswith("hhs") and reg[3:].isdigit():
            hhs_num = int(reg[3:])
        rows.append({
            "region": "US" if reg == "nat" else reg,
            "hhs_region": hhs_num,
            "epiweek": ew,
            "week_end": wk_end,
            "release_date": _iso_date_str(rec.get("release_date")) or "",
            "total_specimens": _safe_int(rec.get("total_specimens")),
            "total_a": _safe_int(rec.get("total_a")),
            "total_b": _safe_int(rec.get("total_b")),
            "percent_positive": _safe_float(rec.get("percent_positive")),
            "percent_a": _safe_float(rec.get("percent_a")),
            "percent_b": _safe_float(rec.get("percent_b")),
        })
    if not rows:
        return _empty_df("delphi_fluview")
    return pl.DataFrame(rows, schema=FEED_SCHEMAS["delphi_fluview"]).sort(
        ["region", "epiweek"], descending=[False, True]
    )


def fetch_who_flunet(http_get: Callable[[str, int], bytes]) -> pl.DataFrame:
    min_year = date.today().year - 1
    flt = f"ISO_YEAR ge {min_year} and (WHOREGION eq 'EUR' or ISO2 eq 'US')"
    sel = (
        "ISO2,COUNTRY_AREA_TERRITORY,WHOREGION,ISO_WEEKSTARTDATE,"
        "SPEC_PROCESSED_NB,AH1N12009,AH3,ANOTSUBTYPED,INF_A,INF_B,INF_ALL,RSV,RSV_PROCESSED"
    )
    params = urllib.parse.urlencode({
        "$filter": flt,
        "$select": sel,
        "$orderby": "ISO_WEEKSTARTDATE desc",
        "$top": 8000,
    })
    url = f"https://xmart-api-public.who.int/FLUMART/VIW_FNT?{params}"
    payload = json.loads(http_get(url, DEFAULT_HTTP_TIMEOUT_SEC).decode("utf-8"))
    values = payload.get("value") if isinstance(payload, dict) else None
    if not isinstance(values, list):
        return _empty_df("who_flunet")

    # Aggregate multiple sentinel/nonsentinel sources within each country+week
    grouped: Dict[tuple[str, str], Dict[str, Any]] = {}
    field_map = {
        "SPEC_PROCESSED_NB": "spec_processed",
        "AH1N12009": "ah1n1pdm09",
        "AH3": "ah3n2",
        "ANOTSUBTYPED": "a_unsubtyped",
        "INF_A": "inf_a",
        "INF_B": "inf_b",
        "INF_ALL": "inf_all",
        "RSV": "rsv",
        "RSV_PROCESSED": "rsv_processed",
    }
    for rec in values:
        if not isinstance(rec, dict):
            continue
        loc_id = resolve_eu_location_id(rec.get("ISO2"), rec.get("COUNTRY_AREA_TERRITORY"))
        wk = _iso_date_str(rec.get("ISO_WEEKSTARTDATE"))
        if not loc_id or not wk:
            continue
        key = (loc_id, wk)
        cur = grouped.get(key)
        if cur is None:
            cur = {
                "location_id": loc_id,
                "country_name": str(rec.get("COUNTRY_AREA_TERRITORY") or loc_id).strip(),
                "who_region": str(rec.get("WHOREGION") or "").strip(),
                "week_start": wk,
                **{v: 0 for v in field_map.values()},
            }
            grouped[key] = cur
        for api_col, out_col in field_map.items():
            iv = _safe_int(rec.get(api_col))
            if iv is not None and iv > 0:
                cur[out_col] += iv

    if not grouped:
        return _empty_df("who_flunet")
    return pl.DataFrame(list(grouped.values()), schema=FEED_SCHEMAS["who_flunet"]).sort(
        ["location_id", "week_start"], descending=[False, True]
    )


_UKHSA_METRICS: List[Tuple[str, str, str]] = [
    ("influenza", "Influenza", "influenza_testing_positivityByWeek"),
    ("rsv", "RSV", "RSV_testing_positivityByWeek"),
    ("covid-19", "COVID-19", "COVID-19_testing_positivity7DayRolling"),
]


def fetch_ukhsa_resp(http_get: Callable[[str, int], bytes]) -> pl.DataFrame:
    rows: List[Dict[str, Any]] = []
    cur_year = date.today().year
    years = (cur_year - 1, cur_year)
    success_count = 0
    last_err: Optional[Exception] = None
    for norm_path, topic, metric in _UKHSA_METRICS:
        for yr in years:
            url = (
                f"https://api.ukhsa-dashboard.data.gov.uk/themes/infectious_disease/"
                f"sub_themes/respiratory/topics/{urllib.parse.quote(topic)}/"
                f"geography_types/Nation/geographies/England/metrics/{urllib.parse.quote(metric)}"
                f"?age=all&year={yr}&page_size=365"
            )
            try:
                raw = http_get(url, DEFAULT_HTTP_TIMEOUT_SEC)
                if raw[:2] == b"\x1f\x8b":
                    raw = gzip.decompress(raw)
                payload = json.loads(raw.decode("utf-8"))
                success_count += 1
            except Exception as exc:
                logger.warning("UKHSA metric %s (%s) fetch failed: %s", metric, yr, exc)
                last_err = exc
                continue
            results = payload.get("results") if isinstance(payload, dict) else None
            if not isinstance(results, list):
                continue
            for rec in results:
                if not isinstance(rec, dict):
                    continue
                dt = _iso_date_str(rec.get("date"))
                val = _safe_float(rec.get("metric_value"))
                if not dt or val is None:
                    continue
                rows.append({
                    "location_id": "GB-ENG",
                    "geography": str(rec.get("geography") or "England"),
                    "pathogen": norm_path,
                    "metric": metric,
                    "week_end": dt,
                    "value": val,
                })
    if success_count == 0 and last_err is not None:
        raise last_err
    if not rows:
        return _empty_df("ukhsa_resp")
    return pl.DataFrame(rows, schema=FEED_SCHEMAS["ukhsa_resp"]).sort(
        ["pathogen", "week_end"], descending=[False, True]
    )


_NEXTSTRAIN_SPECS: List[Dict[str, Any]] = [
    {
        "pathogen": "flu",
        "subtype": "A(H3N2)",
        "tree_url": "https://data.nextstrain.org/seasonal-flu_h3n2_ha_2y.json",
        "freq_url": "https://data.nextstrain.org/seasonal-flu_h3n2_ha_2y_tip-frequencies.json",
        "fixed_region": None,
        "clade_keys": ("subclade", "clade_membership"),
    },
    {
        "pathogen": "flu",
        "subtype": "A(H1N1)pdm09",
        "tree_url": "https://data.nextstrain.org/seasonal-flu_h1n1pdm_ha_2y.json",
        "freq_url": "https://data.nextstrain.org/seasonal-flu_h1n1pdm_ha_2y_tip-frequencies.json",
        "fixed_region": None,
        "clade_keys": ("subclade", "clade_membership"),
    },
    {
        "pathogen": "covid-19",
        "subtype": "SARS-CoV-2",
        "tree_url": "https://data.nextstrain.org/ncov_open_north-america_6m.json",
        "freq_url": "https://data.nextstrain.org/ncov_open_north-america_6m_tip-frequencies.json",
        "fixed_region": "North America",
        "clade_keys": ("clade_membership", "Nextclade_pango"),
    },
    {
        "pathogen": "covid-19",
        "subtype": "SARS-CoV-2",
        "tree_url": "https://data.nextstrain.org/ncov_open_europe_6m.json",
        "freq_url": "https://data.nextstrain.org/ncov_open_europe_6m_tip-frequencies.json",
        "fixed_region": "Europe",
        "clade_keys": ("clade_membership", "Nextclade_pango"),
    },
]


def _extract_nextstrain_leaves(
    tree_data: Dict[str, Any],
    clade_keys: Tuple[str, ...],
) -> Dict[str, Tuple[str, str]]:
    """Iteratively extract tip_name -> (region, clade_label) from Auspice v2 JSON."""
    leaves: Dict[str, Tuple[str, str]] = {}
    root = tree_data.get("tree") if isinstance(tree_data, dict) else None
    if not isinstance(root, dict):
        return leaves
    stack: List[Dict[str, Any]] = [root]
    while stack:
        node = stack.pop()
        children = node.get("children")
        if isinstance(children, list) and children:
            stack.extend(c for c in children if isinstance(c, dict))
            continue
        name = node.get("name")
        if not name:
            continue
        attrs = node.get("node_attrs") or {}
        region_val = ""
        reg_obj = attrs.get("region")
        if isinstance(reg_obj, dict):
            region_val = str(reg_obj.get("value") or "").strip()
        clade_val = ""
        for k in clade_keys:
            c_obj = attrs.get(k)
            if isinstance(c_obj, dict) and c_obj.get("value"):
                v = str(c_obj["value"]).strip()
                if v and v.lower() not in {"unassigned", "unknown", "na"}:
                    clade_val = v
                    break
        if clade_val:
            leaves[str(name)] = (region_val, clade_val)
    return leaves


def _aggregate_nextstrain_dataset(
    spec: Dict[str, Any],
    tree_data: Dict[str, Any],
    freq_data: Dict[str, Any],
    max_pivots: int = 16,
) -> List[Dict[str, Any]]:
    pivots = freq_data.get("pivots")
    if not isinstance(pivots, list) or not pivots:
        return []
    leaves = _extract_nextstrain_leaves(tree_data, spec["clade_keys"])
    if not leaves:
        return []

    target_regions = (
        {spec["fixed_region"]}
        if spec["fixed_region"]
        else {"North America", "Europe"}
    )
    n_pivots = len(pivots)
    start_idx = max(0, n_pivots - max_pivots)

    # Accumulate clade sums per (region, pivot_idx)
    totals: Dict[Tuple[str, int], Dict[str, float]] = {}
    for tip_name, meta in leaves.items():
        reg_val, clade_val = meta
        reg = spec["fixed_region"] or reg_val
        if reg not in target_regions:
            continue
        tip_entry = freq_data.get(tip_name)
        if not isinstance(tip_entry, dict):
            continue
        freqs = tip_entry.get("frequencies")
        if not isinstance(freqs, list):
            continue
        limit = min(len(freqs), n_pivots)
        for idx in range(start_idx, limit):
            fv = _safe_float(freqs[idx])
            if fv is None or fv <= 0.0:
                continue
            bucket = totals.setdefault((reg, idx), {})
            bucket[clade_val] = bucket.get(clade_val, 0.0) + fv

    out: List[Dict[str, Any]] = []
    for (reg, idx), clade_map in totals.items():
        denom = sum(clade_map.values())
        if denom <= 0.0:
            continue
        iso_dt = _decimal_year_to_iso(float(pivots[idx]))
        # Normalize to region total = 1.0, sort major clades + fold tiny <0.02 into Other
        sorted_items = sorted(clade_map.items(), key=lambda kv: kv[1], reverse=True)
        other_sum = 0.0
        kept: List[Tuple[str, float]] = []
        for idx_rank, (clade_name, raw_sum) in enumerate(sorted_items):
            share = raw_sum / denom
            if idx_rank < 6 and share >= 0.015:
                kept.append((clade_name, round(share, 4)))
            else:
                other_sum += share
        if other_sum >= 0.005:
            kept.append(("Other", round(other_sum, 4)))
        for clade_name, share in kept:
            out.append({
                "pathogen": spec["pathogen"],
                "subtype": spec["subtype"],
                "region": reg,
                "date": iso_dt,
                "clade": clade_name,
                "frequency": share,
            })
    return out


def fetch_nextstrain_clades(http_get: Callable[[str, int], bytes]) -> pl.DataFrame:
    all_rows: List[Dict[str, Any]] = []
    success_count = 0
    last_err: Optional[Exception] = None
    for spec in _NEXTSTRAIN_SPECS:
        try:
            tree_bytes = http_get(spec["tree_url"], DEFAULT_HTTP_TIMEOUT_SEC)
            freq_bytes = http_get(spec["freq_url"], DEFAULT_HTTP_TIMEOUT_SEC)
            if tree_bytes[:2] == b"\x1f\x8b":
                tree_bytes = gzip.decompress(tree_bytes)
            if freq_bytes[:2] == b"\x1f\x8b":
                freq_bytes = gzip.decompress(freq_bytes)
            tree_data = json.loads(tree_bytes.decode("utf-8"))
            freq_data = json.loads(freq_bytes.decode("utf-8"))
            success_count += 1
        except Exception as exc:
            logger.warning("Nextstrain fetch failed for %s: %s", spec["subtype"], exc)
            last_err = exc
            continue
        all_rows.extend(_aggregate_nextstrain_dataset(spec, tree_data, freq_data))
    if success_count == 0 and last_err is not None:
        raise last_err
    if not all_rows:
        return _empty_df("nextstrain_clades")
    return pl.DataFrame(all_rows, schema=FEED_SCHEMAS["nextstrain_clades"]).sort(
        ["pathogen", "subtype", "region", "date", "frequency"],
        descending=[False, False, False, True, True],
    )


_ECDC_RAW_BASE = "https://raw.githubusercontent.com/EU-ECDC/Respiratory_viruses_weekly_data/main/data"
_ECDC_FILES: Tuple[Tuple[str, str], ...] = (
    ("sentinel_positivity", f"{_ECDC_RAW_BASE}/sentinelTestsDetectionsPositivity.csv"),
    ("ili_ari", f"{_ECDC_RAW_BASE}/ILIARIRates.csv"),
    ("sari", f"{_ECDC_RAW_BASE}/SARIRates.csv"),
)


def fetch_ecdc_erviss(http_get: Callable[[str, int], bytes]) -> pl.DataFrame:
    """Fetch weekly European respiratory surveillance CSVs from ECDC ERVISS."""
    cutoff = _cutoff_date_str(540)
    dedup: Dict[Tuple[str, str, str, str], Dict[str, Any]] = {}
    success_count = 0
    last_err: Optional[Exception] = None

    def _loc_for(country_name: Any) -> Optional[Tuple[str, str]]:
        cname = str(country_name or "").strip()
        if not cname:
            return None
        if cname.lower() in {"eu/eea", "eu-eea", "eu"}:
            return ("EU", "EU/EEA")
        code = resolve_eu_location_id(None, cname)
        return (code, cname) if code else None

    for kind, url in _ECDC_FILES:
        try:
            raw = http_get(url, DEFAULT_HTTP_TIMEOUT_SEC)
            if raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            text = raw.decode("utf-8", errors="replace")
            success_count += 1
        except Exception as exc:
            logger.warning("ECDC ERVISS fetch failed for %s: %s", kind, exc)
            last_err = exc
            continue

        for rec in csv.DictReader(io.StringIO(text)):
            age = str(rec.get("age") or "").strip().lower()
            if age != "total":
                continue
            wk = _iso_yearweek_to_sunday(rec.get("yearweek"))
            if not wk or wk < cutoff:
                continue
            val = _safe_float(rec.get("value"))
            if val is None or val < 0.0:
                continue
            loc = _loc_for(rec.get("countryname"))
            if not loc:
                continue
            loc_id, cname = loc

            if kind == "sentinel_positivity":
                if str(rec.get("indicator") or "").strip().lower() != "positivity":
                    continue
                subtype_raw = str(rec.get("pathogensubtype") or "").strip().lower()
                if subtype_raw and subtype_raw not in {"total", "sars-cov-2", "rsv"}:
                    continue
                norm_p = normalize_pathogen_name(rec.get("pathogen"))
                if norm_p not in {"flu", "covid-19", "rsv"}:
                    continue
                ind = "sentinel_positivity"
                path_val = norm_p
                unit = "%"
            elif kind == "ili_ari":
                ind_raw = str(rec.get("indicator") or "").strip()
                if ind_raw == "ILIconsultationrate":
                    ind = "ili_rate"
                elif ind_raw == "ARIconsultationrate":
                    ind = "ari_rate"
                else:
                    continue
                path_val = "syndromic"
                unit = "per 100k"
            else:
                if str(rec.get("indicator") or "").strip() != "SARIrate":
                    continue
                ind = "sari_rate"
                path_val = "syndromic"
                unit = "per 100k"

            dkey = (loc_id, ind, path_val, wk)
            if dkey not in dedup:
                dedup[dkey] = {
                    "location_id": loc_id,
                    "country_name": cname,
                    "indicator": ind,
                    "pathogen": path_val,
                    "week_end": wk,
                    "value": round(val, 2),
                    "unit": unit,
                }

    if success_count == 0 and last_err is not None:
        raise last_err
    if not dedup:
        return _empty_df("ecdc_erviss")
    return pl.DataFrame(list(dedup.values()), schema=FEED_SCHEMAS["ecdc_erviss"]).sort(
        ["location_id", "indicator", "pathogen", "week_end"],
        descending=[False, False, False, True],
    )


_FEED_FETCHERS: Dict[str, Callable[[Callable[[str, int], bytes]], pl.DataFrame]] = {
    "cdc_nwss": fetch_cdc_nwss,
    "cdc_cfa_rt": fetch_cdc_cfa_rt,
    "cdc_nssp_ed": fetch_cdc_nssp_ed,
    "cdc_nrevss": fetch_cdc_nrevss,
    "delphi_fluview": fetch_delphi_fluview,
    "who_flunet": fetch_who_flunet,
    "ukhsa_resp": fetch_ukhsa_resp,
    "nextstrain_clades": fetch_nextstrain_clades,
    "ecdc_erviss": fetch_ecdc_erviss,
}


# ---------------------------------------------------------------------------
# Feed Cache Store
# ---------------------------------------------------------------------------


def _extract_latest_week(df: pl.DataFrame) -> Optional[str]:
    if df.height == 0:
        return None
    for col in ("week_end", "date", "week_start"):
        if col in df.columns:
            val = df.select(pl.col(col).max()).item()
            if val:
                return str(val)[:10]
    return None


class BriefingFeedStore:
    """Thread-safe Parquet & metadata cache for external epidemiological feeds."""

    def __init__(
        self,
        data_dir: Path,
        fetcher: Optional[Callable[[str, int], bytes]] = None,
    ) -> None:
        self.data_dir = Path(data_dir)
        self.feeds_dir = self.data_dir / "briefings"
        self.meta_path = self.feeds_dir / "feeds_meta.json"
        self._fetcher: Callable[[str, int], bytes] = fetcher or _default_http_get
        self._lock = threading.Lock()
        self._mem_cache: Dict[str, Tuple[int, pl.DataFrame]] = {}
        self._refreshing = False
        self._last_refresh_started: Optional[str] = None
        self._last_refresh_finished: Optional[str] = None
        self._refresh_thread: Optional[threading.Thread] = None

    def feed_path(self, feed_id: str) -> Path:
        if feed_id not in FEED_SPECS:
            raise ValueError(f"Unknown briefing feed: {feed_id}")
        return self.feeds_dir / f"{feed_id}.parquet"

    def _load_meta_unlocked(self) -> Dict[str, Any]:
        if not self.meta_path.is_file():
            return {"feeds": {}, "last_refresh_started": None, "last_refresh_finished": None}
        try:
            raw = json.loads(self.meta_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                raw.setdefault("feeds", {})
                return raw
        except Exception as exc:
            logger.warning("Failed reading %s: %s", self.meta_path, exc)
        return {"feeds": {}, "last_refresh_started": None, "last_refresh_finished": None}

    def _save_meta_unlocked(self, meta: Dict[str, Any]) -> None:
        _atomic_write_bytes(
            self.meta_path,
            json.dumps(meta, indent=2, sort_keys=True).encode("utf-8"),
        )

    def invalidate_memory_cache(self, feed_id: Optional[str] = None) -> None:
        with self._lock:
            if feed_id is None:
                self._mem_cache.clear()
            else:
                self._mem_cache.pop(feed_id, None)

    def read_feed(self, feed_id: str) -> Optional[pl.DataFrame]:
        """Return cached Parquet DataFrame if present, memoized by file mtime_ns."""
        pq_path = self.feed_path(feed_id)
        try:
            stat = pq_path.stat()
        except FileNotFoundError:
            with self._lock:
                self._mem_cache.pop(feed_id, None)
            return None
        mtime_ns = stat.st_mtime_ns
        with self._lock:
            cached = self._mem_cache.get(feed_id)
            if cached is not None and cached[0] == mtime_ns:
                return cached[1]
        df = pl.read_parquet(pq_path)
        with self._lock:
            self._mem_cache[feed_id] = (mtime_ns, df)
        return df

    def _is_entry_stale(self, feed_id: str, entry: Dict[str, Any], now_ts: float) -> bool:
        pq_path = self.feed_path(feed_id)
        if not pq_path.is_file():
            return True
        fetched_ts = entry.get("fetched_epoch")
        if not isinstance(fetched_ts, (int, float)):
            return True
        ttl_sec = float(FEED_SPECS[feed_id]["ttl_hours"]) * 3600.0
        return (now_ts - float(fetched_ts)) > ttl_sec

    def get_status(self) -> Dict[str, Any]:
        with self._lock:
            meta = self._load_meta_unlocked()
            refreshing = self._refreshing
            started = self._last_refresh_started or meta.get("last_refresh_started")
            finished = self._last_refresh_finished or meta.get("last_refresh_finished")

        now_ts = time.time()
        feeds_meta = meta.get("feeds") or {}
        out_feeds: Dict[str, Dict[str, Any]] = {}
        any_cached = False
        for feed_id, spec in FEED_SPECS.items():
            pq_path = self.feed_path(feed_id)
            cached = pq_path.is_file()
            if cached:
                any_cached = True
            entry = dict(feeds_meta.get(feed_id) or {})
            out_feeds[feed_id] = {
                "id": feed_id,
                "label": spec["label"],
                "scope": spec["scope"],
                "source_url": spec["source_url"],
                "description": spec["description"],
                "ttl_hours": spec["ttl_hours"],
                "cached": cached,
                "stale": self._is_entry_stale(feed_id, entry, now_ts),
                "fetched_at": entry.get("fetched_at"),
                "rows": entry.get("rows", 0),
                "latest_week": entry.get("latest_week"),
                "error": entry.get("error"),
            }
        return {
            "refreshing": refreshing,
            "any_cached": any_cached,
            "last_refresh_started": started,
            "last_refresh_finished": finished,
            "feeds": out_feeds,
        }

    def refresh_sync(
        self,
        feed_ids: Optional[Sequence[str]] = None,
        force: bool = False,
    ) -> Dict[str, Any]:
        """Synchronously refresh requested feeds (or all feeds) and return status."""
        requested = list(feed_ids) if feed_ids else list(FEED_SPECS.keys())
        for fid in requested:
            if fid not in FEED_SPECS:
                raise ValueError(f"Unknown briefing feed: {fid}")

        started_iso = datetime.now(timezone.utc).isoformat()
        with self._lock:
            meta = self._load_meta_unlocked()
            self._refreshing = True
            self._last_refresh_started = started_iso

        try:
            now_ts = time.time()
            feeds_meta = dict(meta.get("feeds") or {})
            to_fetch: List[str] = []
            for fid in requested:
                entry = feeds_meta.get(fid) or {}
                if force or self._is_entry_stale(fid, entry, now_ts):
                    to_fetch.append(fid)

            results: Dict[str, Tuple[Optional[pl.DataFrame], Optional[str]]] = {}
            if to_fetch:
                workers = min(4, len(to_fetch))
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    fut_map = {
                        pool.submit(_FEED_FETCHERS[fid], self._fetcher): fid
                        for fid in to_fetch
                    }
                    for fut in as_completed(fut_map):
                        fid = fut_map[fut]
                        try:
                            df = fut.result()
                            results[fid] = (df, None)
                        except Exception as exc:
                            logger.warning("Briefing feed %s refresh failed: %s", fid, exc)
                            results[fid] = (None, str(exc))

            finished_iso = datetime.now(timezone.utc).isoformat()
            finished_epoch = time.time()

            # Persist Parquet files and update metadata cleanly
            with self._lock:
                meta = self._load_meta_unlocked()
                feeds_meta = dict(meta.get("feeds") or {})
                for fid, (df, err) in results.items():
                    prev = dict(feeds_meta.get(fid) or {})
                    if err is None and df is not None:
                        pq_path = self.feed_path(fid)
                        _atomic_write_parquet(df, pq_path)
                        try:
                            mtime_ns = pq_path.stat().st_mtime_ns
                            self._mem_cache[fid] = (mtime_ns, df)
                        except OSError:
                            self._mem_cache.pop(fid, None)
                        feeds_meta[fid] = {
                            "fetched_at": finished_iso,
                            "fetched_epoch": finished_epoch,
                            "rows": int(df.height),
                            "latest_week": _extract_latest_week(df),
                            "error": None,
                        }
                    else:
                        prev["error"] = err or "Unknown error"
                        prev["last_attempt_at"] = finished_iso
                        feeds_meta[fid] = prev

                meta["feeds"] = feeds_meta
                meta["last_refresh_started"] = started_iso
                meta["last_refresh_finished"] = finished_iso
                self._save_meta_unlocked(meta)
                self._last_refresh_finished = finished_iso
        finally:
            with self._lock:
                self._refreshing = False

        return self.get_status()

    def start_refresh(
        self,
        feed_ids: Optional[Sequence[str]] = None,
        force: bool = True,
    ) -> bool:
        """Spawn a non-blocking daemon refresh thread; returns False if already running."""
        with self._lock:
            if self._refreshing:
                return False
            self._refreshing = True
            self._last_refresh_started = datetime.now(timezone.utc).isoformat()

        def _worker() -> None:
            try:
                self.refresh_sync(feed_ids=feed_ids, force=force)
            except Exception as exc:
                logger.exception("Unhandled error in background briefing feed refresh: %s", exc)
                with self._lock:
                    self._refreshing = False

        t = threading.Thread(target=_worker, name="briefing-feed-refresh", daemon=True)
        self._refresh_thread = t
        t.start()
        return True
