#!/usr/bin/env python3
"""
FluSight Sandbox — Self-Contained Surveillance Data Rebuild Utility

Downloads, validates, and indexes official CDC FluSight Hub hospital admissions
ground truth (target-hospital-admissions.csv) into the self-contained
`viz/data/surveillance/` directory.

Surveillance Stream Details:
- Hospital Admissions (NHSN): Downloaded from upstream CDC FluSight / HealthData.gov.
- Emergency Department % (NSSP): Indexed directly from `target-data/oracle-output.csv`.
- Scaled ILI+ (ILINet): Historical outpatient influenza-like illness archive (2010–2023).
- Rate per 100k (FluSurv-NET): Historical laboratory-confirmed influenza rate archive (2010–2023).

Features:
- Completely portable: zero non-standard dependencies (Python standard library + Polars).
- Self-contained: stores all assets inside `viz/data/surveillance/`, with zero leakage to repo root.
- Offline-resilient: synthesizes admissions ground truth from `target-data/oracle-output.csv` if offline.
- Atomic Parquet cache re-indexing for instant sub-2ms query performance.

Usage:
    python viz/rebuild_surveillance.py
    python viz/rebuild_surveillance.py --force
    python viz/rebuild_surveillance.py --check-freshness
"""

import argparse
import logging
import os
import shutil
import sys
import urllib.error
import urllib.request
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from viz.core.cache_manager import ParquetCacheManager
from viz.core.data_loader import date_to_season_and_week

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("rebuild_surveillance")

DEFAULT_CDC_ADMISSIONS_URL = (
    "https://raw.githubusercontent.com/cdcepi/FluSight-forecast-hub/main/target-data/target-hospital-admissions.csv"
)
REICHLAB_DASHBOARD_TAR_URL = (
    "https://github.com/reichlab/flusight-dashboard/archive/refs/heads/ptc/data.tar.gz"
)
DELPHI_EPIDATA_BASE_URL = "https://api.delphi.cmu.edu/epidata"


def get_viz_paths(base_dir: Optional[Path] = None) -> Dict[str, Path]:
    """Resolve repository and self-contained viz paths."""
    if base_dir is None:
        curr = Path(__file__).resolve().parent
        if curr.name == "viz":
            viz_dir = curr
            repo_root = curr.parent
        else:
            repo_root = curr
            viz_dir = repo_root / "viz"
    else:
        repo_root = Path(base_dir).resolve()
        viz_dir = repo_root / "viz" if (repo_root / "viz").is_dir() else repo_root

    surveillance_dir = viz_dir / "data" / "surveillance"
    target_data_dir = repo_root / "target-data"
    cache_dir = viz_dir / ".cache"

    return {
        "repo_root": repo_root,
        "viz_dir": viz_dir,
        "surveillance_dir": surveillance_dir,
        "target_data_dir": target_data_dir,
        "cache_dir": cache_dir,
    }


def download_file(url: str, dest_path: Path, timeout_sec: int = 30) -> bool:
    """Download a remote file atomically to destination path with timeout."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dest_path.with_suffix(".tmp.download")

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "FluSight-Sandbox-Viz/2.0"},
    )
    try:
        logger.info("Downloading official surveillance data from %s...", url)
        with urllib.request.urlopen(req, timeout=timeout_sec) as response:
            with open(tmp_path, "wb") as f_out:
                shutil.copyfileobj(response, f_out)

        os.replace(tmp_path, dest_path)
        logger.info("Successfully saved to %s (size: %.1f KB)", dest_path, dest_path.stat().st_size / 1024)
        return True
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
        logger.warning("Network download failed for %s: %s", url, exc)
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        return False


def synthesize_admissions_from_oracle(oracle_path: Path, dest_path: Path) -> bool:
    """Fallback: synthesize target-hospital-admissions.csv directly from oracle-output.csv."""
    if not oracle_path.exists():
        logger.error("Oracle ground truth file not found at %s", oracle_path)
        return False

    logger.info("Synthesizing admissions ground truth from %s...", oracle_path.name)
    try:
        df = pl.read_csv(
            oracle_path,
            schema_overrides={
                "location": pl.String,
                "target": pl.String,
                "target_end_date": pl.String,
                "oracle_value": pl.Float64,
            },
            null_values=["NA", "NaN", ""],
            ignore_errors=True,
        )
        hosp = (
            df.filter(pl.col("target") == "wk inc flu hosp")
            .rename({"target_end_date": "date", "oracle_value": "value"})
            .select(["date", "location", "value"])
            .drop_nulls()
            .sort(["location", "date"])
        )

        dest_path.parent.mkdir(parents=True, exist_ok=True)
        hosp.write_csv(dest_path)
        logger.info("Synthesized %d admissions records to %s", len(hosp), dest_path)
        return True
    except Exception as exc:
        logger.error("Failed to synthesize admissions from oracle: %s", exc)
        return False


def epiweek_to_saturday(year: int, week: int) -> str:
    """Calculate the Saturday calendar date for a given MMWR epiweek."""
    jan4 = date(year, 1, 4)
    sun_wk1 = jan4 - timedelta(days=(jan4.weekday() + 1) % 7)
    sat_wkN = sun_wk1 + timedelta(weeks=week - 1, days=6)
    return sat_wkN.strftime("%Y-%m-%d")


def fetch_and_update_flusurvnet(dest_path: Path, timeout_sec: int = 25) -> Dict[str, Any]:
    """
    Fetch upstream FluSurv-NET hospitalization rates (2023–present) from Delphi Epidata API,
    merging with the existing local archive. Completely adaptable across future seasons.
    """
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    old_df = pl.DataFrame()
    if dest_path.exists():
        try:
            old_df = pl.read_csv(
                dest_path,
                schema_overrides={
                    "location": pl.String,
                    "wk_end_date": pl.String,
                    "inc": pl.Float64,
                },
                null_values=["NA", "NaN", ""],
                ignore_errors=True,
            )
        except Exception as exc:
            logger.warning("Could not read existing flusurvnet.csv: %s", exc)

    loc_map = {
        "network_all": ("national", "US"),
        "CA": ("state", "06"),
        "CO": ("state", "08"),
        "CT": ("state", "09"),
        "GA": ("state", "13"),
        "MD": ("state", "24"),
        "MI": ("state", "26"),
        "MN": ("state", "27"),
        "NM": ("state", "35"),
        "NY_albany": ("state", "36"),
        "NY_rochester": ("state", "36"),
        "OH": ("state", "39"),
        "OR": ("state", "41"),
        "TN": ("state", "47"),
        "UT": ("state", "49"),
    }
    loc_str = ",".join(loc_map.keys())

    curr_year = datetime.now().year
    max_year = curr_year + (1 if datetime.now().month >= 8 else 0)
    ranges = [f"{y}40-{y+1}39" for y in range(2023, max_year + 1)]

    new_rows: List[Dict[str, Any]] = []
    for ew_range in ranges:
        url = f"{DELPHI_EPIDATA_BASE_URL}/flusurv/?locations={loc_str}&epiweeks={ew_range}"
        req = urllib.request.Request(url, headers={"User-Agent": "FluSight-Sandbox-Viz/2.0"})
        try:
            with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                import json
                data = json.loads(resp.read().decode())
                if data.get("result") == 1:
                    for r in data.get("epidata", []):
                        raw_loc = r.get("location")
                        if raw_loc not in loc_map:
                            continue
                        agg_level, fips = loc_map[raw_loc]
                        ew = int(r["epiweek"])
                        year, week = ew // 100, ew % 100
                        sat_date = epiweek_to_saturday(year, week)
                        d = date.fromisoformat(sat_date)
                        season_str, season_wk = date_to_season_and_week(d)
                        rate = r.get("rate_overall")
                        if rate is not None:
                            new_rows.append({
                                "agg_level": agg_level,
                                "location": fips,
                                "season": season_str,
                                "season_week": float(season_wk),
                                "wk_end_date": sat_date,
                                "inc": float(rate),
                                "source": "flusurvnet",
                            })
        except Exception as exc:
            logger.warning("FluSurv-NET fetch notice for range %s: %s", ew_range, exc)

    if new_rows:
        df_new = pl.DataFrame(new_rows)
        # Average NY Albany and Rochester to state level
        df_new = (
            df_new.group_by(["agg_level", "location", "season", "season_week", "wk_end_date", "source"])
            .agg(pl.col("inc").mean())
        )
        if not old_df.is_empty():
            df_new = df_new.select(old_df.columns)
            merged = pl.concat([old_df, df_new]).unique(subset=["location", "wk_end_date"], keep="last").sort(["location", "wk_end_date"])
        else:
            merged = df_new.sort(["location", "wk_end_date"])
        merged.write_csv(dest_path)
        logger.info("FluSurv-NET updated: %d total records (latest: %s)", len(merged), merged["wk_end_date"].max())
        return {"updated": True, "total_rows": len(merged), "max_date": merged["wk_end_date"].max()}

    return {"updated": False, "total_rows": len(old_df), "max_date": old_df["wk_end_date"].max() if not old_df.is_empty() else None}


def fetch_and_update_ilinet(dest_path: Path, locations_csv: Path, timeout_sec: int = 25) -> Dict[str, Any]:
    """
    Fetch upstream ILINet outpatient data (2023–present) from Delphi Epidata API for all jurisdictions,
    merging with the existing local archive. Completely adaptable across future seasons.
    """
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    old_df = pl.DataFrame()
    if dest_path.exists():
        try:
            old_df = pl.read_csv(
                dest_path,
                schema_overrides={
                    "location": pl.String,
                    "wk_end_date": pl.String,
                    "inc": pl.Float64,
                },
                null_values=["NA", "NaN", ""],
                ignore_errors=True,
            )
        except Exception as exc:
            logger.warning("Could not read existing ilinet.csv: %s", exc)

    fips_map = {"nat": ("national", "US")}
    if locations_csv.exists():
        loc_df = pl.read_csv(locations_csv, schema_overrides={"location": pl.String})
        for row in loc_df.iter_rows(named=True):
            abbr = str(row["abbreviation"]).lower()
            fips = str(row["location"])
            if abbr != "us":
                fips_map[abbr] = ("state", fips)

    abbr_list = list(fips_map.keys())
    curr_year = datetime.now().year
    max_year = curr_year + (1 if datetime.now().month >= 8 else 0)
    ranges = [f"{y}40-{y+1}39" for y in range(2023, max_year + 1)]

    new_rows: List[Dict[str, Any]] = []
    for ew_range in ranges:
        url = f"{DELPHI_EPIDATA_BASE_URL}/fluview/?regions={','.join(abbr_list)}&epiweeks={ew_range}"
        req = urllib.request.Request(url, headers={"User-Agent": "FluSight-Sandbox-Viz/2.0"})
        try:
            with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                import json
                data = json.loads(resp.read().decode())
                if data.get("result") == 1:
                    for r in data.get("epidata", []):
                        reg = str(r.get("region", "")).lower()
                        if reg not in fips_map:
                            continue
                        agg_level, fips = fips_map[reg]
                        ew = int(r["epiweek"])
                        year, week = ew // 100, ew % 100
                        sat_date = epiweek_to_saturday(year, week)
                        d = date.fromisoformat(sat_date)
                        season_str, season_wk = date_to_season_and_week(d)
                        val = r.get("wili") if reg == "nat" else (r.get("ili") or r.get("wili"))
                        if val is not None:
                            new_rows.append({
                                "agg_level": agg_level,
                                "location": fips,
                                "season": season_str,
                                "season_week": int(season_wk),
                                "wk_end_date": sat_date,
                                "inc": float(val),
                                "source": "ilinet",
                            })
        except Exception as exc:
            logger.warning("ILINet fetch notice for range %s: %s", ew_range, exc)

    if new_rows:
        df_new = pl.DataFrame(new_rows)
        if not old_df.is_empty():
            df_new = df_new.select(old_df.columns).cast({
                "season_week": old_df.schema["season_week"],
                "location": old_df.schema["location"],
            })
            merged = pl.concat([old_df, df_new]).unique(subset=["location", "wk_end_date"], keep="last").sort(["location", "wk_end_date"])
        else:
            merged = df_new.sort(["location", "wk_end_date"])
        merged.write_csv(dest_path)
        logger.info("ILINet updated: %d total records (latest: %s)", len(merged), merged["wk_end_date"].max())
        return {"updated": True, "total_rows": len(merged), "max_date": merged["wk_end_date"].max()}

    return {"updated": False, "total_rows": len(old_df), "max_date": old_df["wk_end_date"].max() if not old_df.is_empty() else None}


def validate_admissions_csv(csv_path: Path) -> Dict[str, Any]:
    """Validate admissions CSV format and return summary metrics."""
    if not csv_path.exists():
        return {"valid": False, "error": "File does not exist"}

    try:
        schema_ovr = {"location": pl.String, "value": pl.Float64, "weekly_rate": pl.Float64}
        df = pl.read_csv(
            csv_path,
            schema_overrides=schema_ovr,
            null_values=["NA", "NaN", ""],
            ignore_errors=True,
            n_rows=5000,
        )
        cols = set(df.columns)
        has_date = "date" in cols or "target_end_date" in cols
        has_loc = "location" in cols
        has_val = "value" in cols or "oracle_value" in cols

        if not (has_date and has_loc and has_val):
            return {"valid": False, "error": f"Missing required columns in {cols}"}

        date_col = "date" if "date" in cols else "target_end_date"
        full_df = pl.read_csv(
            csv_path,
            schema_overrides=schema_ovr,
            null_values=["NA", "NaN", ""],
            ignore_errors=True,
        )
        dates = full_df[date_col].drop_nulls()
        locations = full_df["location"].drop_nulls()

        return {
            "valid": True,
            "total_rows": len(full_df),
            "min_date": dates.min(),
            "max_date": dates.max(),
            "distinct_locations": locations.n_unique(),
        }
    except Exception as exc:
        return {"valid": False, "error": str(exc)}


def fetch_and_update_initial_admissions(
    dest_path: Path,
    repo_root: Optional[Path] = None,
    timeout_sec: int = 30,
) -> Dict[str, Any]:
    """
    Fetch and compile unrevised hospital admissions (first-published weekly snapshots)
    from CDC FluSight Forecast Hub's auxiliary-data/target-data-archive, preserving
    point-in-time initial surveillance records prior to retrospective backfill.
    """
    import io
    import json
    import re
    from concurrent.futures import ThreadPoolExecutor

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    if dest_path.exists() and dest_path.stat().st_size > 0:
        val = validate_admissions_csv(dest_path)
        if val.get("valid"):
            logger.info("Initial admissions archive already present (%d rows)", val.get("total_rows", 0))
            return {"updated": False, **val}

    logger.info("Compiling initial unrevised admissions from FluSight archive snapshots...")
    dfs = []

    # 1. Check local archive directory if present in sibling checkout or repo
    local_archive = None
    if repo_root:
        candidate = repo_root.parent / "FluSight-forecast-hub" / "auxiliary-data" / "target-data-archive"
        if candidate.is_dir():
            local_archive = candidate

    if local_archive and local_archive.is_dir():
        files = sorted(local_archive.glob("target-hospital-admissions_*.csv"))
        for f in files:
            m = re.search(r"\d{4}-\d{2}-\d{2}", f.name)
            if not m:
                continue
            try:
                sub_df = pl.read_csv(f, schema_overrides={"location": pl.String, "value": pl.Float64}, null_values=["NA", "NaN", ""], ignore_errors=True)
                sub_df = sub_df.with_columns(pl.lit(m.group()).alias("snap_date"))
                dfs.append(sub_df)
            except Exception as exc:
                logger.warning("Could not read local archive file %s: %s", f.name, exc)
    else:
        # 2. Fetch list from upstream GitHub repository
        api_url = "https://api.github.com/repos/cdcepi/FluSight-forecast-hub/contents/auxiliary-data/target-data-archive"
        req = urllib.request.Request(api_url, headers={"User-Agent": "FluSight-Sandbox-Viz/2.0"})
        adm_files = []
        try:
            with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                contents = json.loads(resp.read().decode())
                adm_files = sorted([f["name"] for f in contents if "target-hospital-admissions_" in f.get("name", "")])
        except Exception as exc:
            logger.warning("Failed to query GitHub archive directory: %s", exc)

        def _fetch_one(fname: str) -> Optional[pl.DataFrame]:
            u = f"https://raw.githubusercontent.com/cdcepi/FluSight-forecast-hub/main/auxiliary-data/target-data-archive/{fname}"
            r_req = urllib.request.Request(u, headers={"User-Agent": "FluSight-Sandbox-Viz/2.0"})
            m = re.search(r"\d{4}-\d{2}-\d{2}", fname)
            snap_d = m.group() if m else ""
            try:
                with urllib.request.urlopen(r_req, timeout=timeout_sec) as r_resp:
                    raw_bytes = r_resp.read()
                    sub_df = pl.read_csv(io.BytesIO(raw_bytes), schema_overrides={"location": pl.String, "value": pl.Float64}, null_values=["NA", "NaN", ""], ignore_errors=True)
                    return sub_df.with_columns(pl.lit(snap_d).alias("snap_date"))
            except Exception:
                return None

        if adm_files:
            with ThreadPoolExecutor(max_workers=16) as executor:
                results = list(executor.map(_fetch_one, adm_files))
                dfs = [df for df in results if df is not None and not df.is_empty()]

    if dfs:
        try:
            combined = pl.concat([df.select([c for c in ["date", "location", "location_name", "value", "weekly_rate", "snap_date"] if c in df.columns]) for df in dfs])
            combined = combined.sort("snap_date")
            first_seen = combined.unique(subset=["location", "date"], keep="first")
            first_seen = (
                first_seen.with_columns(
                    pl.when(pl.col("location") == "US")
                    .then(pl.lit("US"))
                    .otherwise(pl.col("location").str.zfill(2))
                    .alias("location")
                )
                .rename({"snap_date": "initial_report_date"})
                .sort(["location", "date"])
            )
            first_seen.write_csv(dest_path)
            val = validate_admissions_csv(dest_path)
            logger.info("Successfully compiled initial admissions: %d records to %s", len(first_seen), dest_path)
            return {"updated": True, **val}
        except Exception as exc:
            logger.error("Failed to process snapshot tables: %s", exc)

    return {"updated": False, "error": "No snapshot data available"}


def fetch_and_update_as_of_admissions(
    dest_path: Path,
    repo_root: Optional[Path] = None,
    timeout_sec: int = 60,
    force: bool = False,
) -> Dict[str, Any]:
    """
    Fetch and compile authoritative point-in-time as-of surveillance snapshots
    from the official Reich Lab FluSight Forecast Hub dashboard repository (ptc/data branch).
    Preserves exact historical target vintages across all locations and forecast reference dates.
    """
    import io
    import json
    import tarfile

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    if not force and dest_path.exists() and dest_path.stat().st_size > 0:
        try:
            df = pl.read_parquet(dest_path)
            # The archive is written in one shot from the full download, so presence means complete
            if "as_of" in df.columns:
                logger.info("As-of surveillance archive already present (%d rows); use --force to refresh", len(df))
                return {"updated": False, "valid": True, "total_rows": len(df)}
        except Exception:
            pass

    logger.info("Fetching official as-of surveillance snapshots from Reich Lab repository...")
    tar_bytes = None
    try:
        req = urllib.request.Request(
            REICHLAB_DASHBOARD_TAR_URL,
            headers={"User-Agent": "FluSight-Sandbox-Viz/2.0"},
        )
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            tar_bytes = resp.read()
        logger.info("Successfully downloaded Reich Lab targets archive (%d bytes)", len(tar_bytes))
    except Exception as exc:
        logger.warning("Could not download Reich Lab archive: %s", exc)

    if tar_bytes:
        try:
            rows = []
            with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:gz") as tar:
                for member in tar:
                    if not member.isfile() or "/targets/" not in member.name or not member.name.endswith(".json"):
                        continue
                    fname = Path(member.name).stem
                    parts = fname.split("_")
                    if len(parts) != 3:
                        continue
                    target_key, location, as_of = parts
                    target = "wk inc flu hosp" if target_key == "wk-inc-flu-hosp" else "wk inc flu prop ed visits"

                    f = tar.extractfile(member)
                    if f is None:
                        continue
                    try:
                        d = json.load(f)
                        dates = d.get("date", [])
                        ys = d.get("y", [])
                        dedup = {}
                        for dt, y in zip(dates, ys):
                            if y is not None:
                                dedup[dt] = float(y)
                        for dt, val in dedup.items():
                            rows.append((as_of, target, location, dt, 0, val))
                    except Exception:
                        pass

            if rows:
                formatted = (
                    pl.DataFrame(
                        rows,
                        schema=["as_of", "target", "location", "target_end_date", "horizon", "oracle_value"],
                        orient="row",
                    )
                    .with_columns(
                        pl.when(pl.col("location") == "US")
                        .then(pl.lit("US"))
                        .otherwise(pl.col("location").str.zfill(2))
                        .alias("location")
                    )
                    .sort(["target", "location", "as_of", "target_end_date"])
                )
                formatted.write_parquet(dest_path, compression="zstd")
                logger.info("Successfully compiled %d authoritative as-of records to %s", len(formatted), dest_path)
                return {"updated": True, "valid": True, "total_rows": len(formatted)}
        except Exception as exc:
            logger.error("Failed to parse Reich Lab targets archive: %s", exc)

    if dest_path.exists() and dest_path.stat().st_size > 0:
        return {"updated": False, "valid": True, "total_rows": len(pl.read_parquet(dest_path))}

    return {"updated": False, "error": "No snapshot data available"}


def seed_surveillance_history(paths: Dict[str, Path]) -> None:
    """Copy the bundled 2010-2023 ILINet / FluSurv-NET history into surveillance/ on first use.

    data/seed/ is tracked and never written, so updating the working copies in data/surveillance/
    (git-ignored) never leaves the viz checkout dirty or blocks `git pull`.
    """
    seed_dir = paths["viz_dir"] / "data" / "seed"
    for name in ("ilinet.csv", "flusurvnet.csv"):
        dest = paths["surveillance_dir"] / name
        seed = seed_dir / name
        if not dest.exists() and seed.exists():
            shutil.copy2(seed, dest)
            logger.info("Seeded %s from %s", dest.name, seed)


def rebuild_surveillance_data(
    base_dir: Optional[Path] = None,
    admissions_url: str = DEFAULT_CDC_ADMISSIONS_URL,
    force: bool = False,
) -> Dict[str, Any]:
    """
    Main programmatic entrypoint:
    Rebuilds self-contained surveillance datasets and refreshes Parquet caches.
    """
    paths = get_viz_paths(base_dir)
    surv_dir = paths["surveillance_dir"]
    surv_dir.mkdir(parents=True, exist_ok=True)
    seed_surveillance_history(paths)

    dest_adm = surv_dir / "target-hospital-admissions.csv"
    dest_init = surv_dir / "initial-hospital-admissions.csv"
    dest_as_of = surv_dir / "as-of-hospital-admissions.parquet"
    dest_ili = surv_dir / "ilinet.csv"
    dest_fsn = surv_dir / "flusurvnet.csv"
    downloaded = False

    # Clear target cache if force refresh requested
    if force:
        try:
            ParquetCacheManager(paths["repo_root"]).clear_cache()
        except Exception:
            pass

    # 1. Download or verify official admissions ground truth
    if force or not dest_adm.exists():
        downloaded = download_file(admissions_url, dest_adm)

    if not dest_adm.exists() or dest_adm.stat().st_size == 0:
        logger.info("Admissions CSV not present after download attempt. Falling back to local oracle synthesis...")
        synthesize_admissions_from_oracle(paths["target_data_dir"] / "oracle-output.csv", dest_adm)

    val_result = validate_admissions_csv(dest_adm)
    if not val_result.get("valid"):
        logger.warning("Admissions CSV validation warning: %s", val_result.get("error"))

    # 2. Update initial unrevised admissions archive and as-of vintages
    init_res = fetch_and_update_initial_admissions(dest_init, paths["repo_root"])
    as_of_res = fetch_and_update_as_of_admissions(dest_as_of, paths["repo_root"], force=force)

    # 3. Update ILINet and FluSurv-NET from Delphi Epidata API
    ili_res = fetch_and_update_ilinet(dest_ili, paths["repo_root"] / "auxiliary-data" / "locations.csv")
    fsn_res = fetch_and_update_flusurvnet(dest_fsn)

    # 4. Refresh Parquet cache atomically via ParquetCacheManager
    cache_mgr = ParquetCacheManager(paths["repo_root"])
    cached_adm = cache_mgr.get_admissions_parquet()
    cached_init = cache_mgr.get_initial_admissions_parquet()
    cached_as_of = cache_mgr.get_as_of_admissions_parquet()
    cached_ili = cache_mgr.get_ilinet_parquet()
    cached_fsn = cache_mgr.get_flusurvnet_parquet()

    report = {
        "status": "success",
        "timestamp": datetime.now().isoformat(),
        "surveillance_dir": str(surv_dir),
        "admissions_downloaded": downloaded,
        "admissions_metrics": val_result,
        "initial_admissions_metrics": init_res,
        "as_of_admissions_metrics": as_of_res,
        "ilinet_metrics": ili_res,
        "flusurvnet_metrics": fsn_res,
        "caches": {
            "admissions_parquet": str(cached_adm) if cached_adm else None,
            "initial_admissions_parquet": str(cached_init) if cached_init else None,
            "ilinet_parquet": str(cached_ili) if cached_ili else None,
            "flusurvnet_parquet": str(cached_fsn) if cached_fsn else None,
        },
    }

    logger.info("Surveillance rebuild complete. Admissions: %s to %s | Initial: %s | ILINet max: %s | FluSurv-NET max: %s",
                val_result.get("min_date"), val_result.get("max_date"),
                init_res.get("max_date"),
                ili_res.get("max_date"), fsn_res.get("max_date"))

    return report


def check_surveillance_freshness(base_dir: Optional[Path] = None) -> Dict[str, Any]:
    """Inspect and report temporal boundaries and row counts for all surveillance streams."""
    paths = get_viz_paths(base_dir)
    surv_dir = paths["surveillance_dir"]
    report: Dict[str, Any] = {}

    # Admissions (settled/revised)
    adm_csv = surv_dir / "target-hospital-admissions.csv"
    if adm_csv.exists():
        report["admissions"] = validate_admissions_csv(adm_csv)
    else:
        report["admissions"] = {"valid": False, "error": "target-hospital-admissions.csv not found"}

    # Initial Admissions (unrevised)
    init_csv = surv_dir / "initial-hospital-admissions.csv"
    if init_csv.exists():
        report["initial_admissions"] = validate_admissions_csv(init_csv)
    else:
        report["initial_admissions"] = {"valid": False, "error": "initial-hospital-admissions.csv not found"}

    # ILINet
    ili_csv = surv_dir / "ilinet.csv"
    if not ili_csv.exists():
        ili_csv = paths["viz_dir"] / "data" / "seed" / "ilinet.csv"
    if not ili_csv.exists():
        ili_csv = paths["repo_root"] / "auxiliary-data" / "surveillance" / "ilinet.csv"
    if ili_csv.exists():
        try:
            df = pl.read_csv(ili_csv, schema_overrides={"location": pl.String, "inc": pl.Float64}, null_values=["NA", "NaN", ""])
            dates = df["wk_end_date"].drop_nulls().to_list()
            report["ilinet"] = {
                "source": str(ili_csv),
                "total_rows": len(df),
                "min_date": min(dates) if dates else None,
                "max_date": max(dates) if dates else None,
                "locations_count": df["location"].n_unique(),
                "note": "Outpatient ILI surveillance archive (1997–present)",
            }
        except Exception as exc:
            report["ilinet"] = {"error": str(exc)}
    else:
        report["ilinet"] = {"error": "ilinet.csv not found"}

    # FluSurv-NET
    fsn_csv = surv_dir / "flusurvnet.csv"
    if not fsn_csv.exists():
        fsn_csv = paths["viz_dir"] / "data" / "seed" / "flusurvnet.csv"
    if not fsn_csv.exists():
        fsn_csv = paths["repo_root"] / "auxiliary-data" / "surveillance" / "flusurvnet.csv"
    if fsn_csv.exists():
        try:
            df = pl.read_csv(fsn_csv, schema_overrides={"location": pl.String, "inc": pl.Float64}, null_values=["NA", "NaN", ""])
            dates = df["wk_end_date"].drop_nulls().to_list()
            report["flusurvnet"] = {
                "source": str(fsn_csv),
                "total_rows": len(df),
                "min_date": min(dates) if dates else None,
                "max_date": max(dates) if dates else None,
                "locations_count": df["location"].n_unique(),
                "note": "Laboratory-confirmed rate archive (2010–present)",
            }
        except Exception as exc:
            report["flusurvnet"] = {"error": str(exc)}
    else:
        report["flusurvnet"] = {"error": "flusurvnet.csv not found"}

    # NSSP (from oracle)
    oracle_csv = paths["target_data_dir"] / "oracle-output.csv"
    if oracle_csv.exists():
        try:
            df = pl.read_csv(
                oracle_csv,
                schema_overrides={"location": pl.String, "oracle_value": pl.Float64},
                null_values=["NA", "N/A", "null", "", "NaN"],
            )
            nssp_df = df.filter(pl.col("target") == "wk inc flu prop ed visits")
            if not nssp_df.is_empty():
                dates = nssp_df["target_end_date"].to_list()
                report["nssp"] = {
                    "source": str(oracle_csv),
                    "total_rows": len(nssp_df),
                    "min_date": min(dates),
                    "max_date": max(dates),
                    "locations_count": nssp_df["location"].n_unique(),
                    "note": "Indexed directly from target-data/oracle-output.csv",
                }
        except Exception as exc:
            report["nssp"] = {"error": str(exc)}

    return report


def main():
    parser = argparse.ArgumentParser(
        description="Rebuild self-contained FluSight surveillance data and Parquet caches."
    )
    parser.add_argument(
        "--url",
        default=DEFAULT_CDC_ADMISSIONS_URL,
        help="Official CDC FluSight Hub admissions CSV URL",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force re-downloading upstream datasets even if existing file is present",
    )
    parser.add_argument(
        "--check-freshness",
        action="store_true",
        help="Check temporal coverage and record counts across all surveillance datasets without downloading",
    )
    args = parser.parse_args()

    if args.check_freshness:
        freshness = check_surveillance_freshness()
        print("\n" + "=" * 80)
        print("  SURVEILLANCE FRESHNESS & STREAM AUDIT")
        print("=" * 80)
        for stream, info in freshness.items():
            print(f"\n[{stream.upper()}]")
            for k, v in info.items():
                print(f"  • {k}: {v}")
        print("\n" + "=" * 80 + "\n")
        return

    report = rebuild_surveillance_data(admissions_url=args.url, force=args.force)
    print("\n" + "=" * 70)
    print("  SURVEILLANCE REBUILD REPORT")
    print("=" * 70)
    print(f"Directory:       {report['surveillance_dir']}")
    print(f"Admissions File: {report['admissions_metrics'].get('total_rows', 0):,} records "
          f"({report['admissions_metrics'].get('min_date')} to {report['admissions_metrics'].get('max_date')})")
    print(f"Parquet Cache:   {report['caches']['admissions_parquet']}")
    print("=" * 70 + "\n")


if __name__ == "__main__":
    main()
