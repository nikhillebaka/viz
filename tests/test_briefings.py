"""
Unit and integration tests for Place-First Live Briefings (`briefing_feeds.py`,
`briefings.py`, and HTTP briefing API endpoints).
"""

import gzip
import http.client
import json
from pathlib import Path
import shutil
import socketserver
import tempfile
import threading
import time
import unittest

import polars as pl

from viz.core.briefing_feeds import (
    FEED_SPECS,
    US_FIPS_TO_HHS,
    WHO_NH_VACCINE_REFERENCE,
    BriefingFeedStore,
    _iso_yearweek_to_sunday,
    fetch_ecdc_erviss,
)
from viz.core.catalog import display_model_name, rank_ensemble_candidates
from viz.core.workspace import HubManager
from viz.server import SandboxRequestHandler


def _fixture_router(fail_urls=()):
    """Deterministic in-memory HTTP fixture router covering all 8 external feeds."""

    def _fetch(url: str, _timeout: int) -> bytes:
        for pat in fail_urls:
            if pat in url:
                raise RuntimeError(f"Simulated network failure for {pat}")

        if "atcp-73re.json" in url:
            return json.dumps([
                {"state_territory": "Massachusetts", "pathogen_target": "Influenza A virus", "week_end": "2026-11-14", "mean_wval": "4.20", "sites": "18"},
                {"state_territory": "Massachusetts", "pathogen_target": "Influenza A virus", "week_end": "2026-11-07", "mean_wval": "3.50", "sites": "18"},
                {"state_territory": "Massachusetts", "pathogen_target": "SARS-CoV-2", "week_end": "2026-11-14", "mean_wval": "2.10", "sites": "18"},
                {"state_territory": "California", "pathogen_target": "Influenza A virus", "week_end": "2026-11-14", "mean_wval": "1.80", "sites": "30"},
            ]).encode("utf-8")

        if "5dqz-y4ea.json" in url:
            # Includes stale + newer `as_of` for identical (state, disease, date)
            return json.dumps([
                {"as_of": "2026-11-10T00:00:00.000", "disease": "Influenza", "state": "Massachusetts", "date": "2026-11-17T00:00:00.000", "median": "0.95", "lower": "0.85", "upper": "1.05", "p_growing": "0.30", "category": "Not Changing"},
                {"as_of": "2026-11-17T00:00:00.000", "disease": "Influenza", "state": "Massachusetts", "date": "2026-11-17T00:00:00.000", "median": "1.14", "lower": "1.05", "upper": "1.24", "p_growing": "0.97", "category": "Growing"},
                {"as_of": "2026-11-17T00:00:00.000", "disease": "Influenza", "state": "United States", "date": "2026-11-17T00:00:00.000", "median": "1.09", "lower": "1.03", "upper": "1.16", "p_growing": "0.91", "category": "Growing"},
            ]).encode("utf-8")

        if "vutn-jzwm.json" in url:
            return json.dumps([
                {"week_end": "2026-11-14T00:00:00.000", "pathogen": "Influenza", "geography": "Massachusetts", "percent_visits": "2.4"},
                {"week_end": "2026-11-07T00:00:00.000", "pathogen": "Influenza", "geography": "Massachusetts", "percent_visits": "1.8"},
                {"week_end": "2026-11-14T00:00:00.000", "pathogen": "Influenza", "geography": "United States", "percent_visits": "1.9"},
            ]).encode("utf-8")

        if "seuz-s2cv.json" in url:
            return json.dumps([
                {"week_end": "2026-11-14T00:00:00.000", "pathogen": "COVID-19", "percent_test_positivity": "4.6"},
                {"week_end": "2026-11-07T00:00:00.000", "pathogen": "COVID-19", "percent_test_positivity": "4.9"},
            ]).encode("utf-8")

        if "fluview_clinical" in url:
            return json.dumps({
                "result": 1,
                "epidata": [
                    {"release_date": "2026-11-20", "region": "nat", "epiweek": 202645, "total_specimens": 50000, "total_a": 900, "total_b": 100, "percent_positive": 2.0, "percent_a": 1.8, "percent_b": 0.2},
                    {"release_date": "2026-11-20", "region": "hhs1", "epiweek": 202645, "total_specimens": 4000, "total_a": 120, "total_b": 20, "percent_positive": 3.5, "percent_a": 3.0, "percent_b": 0.5},
                ],
            }).encode("utf-8")

        if "VIW_FNT" in url:
            return json.dumps({
                "value": [
                    {"ISO2": "US", "COUNTRY_AREA_TERRITORY": "United States of America", "WHOREGION": "AMR", "ISO_WEEKSTARTDATE": "2026-11-09", "SPEC_PROCESSED_NB": 12000, "AH1N12009": 40, "AH3": 160, "ANOTSUBTYPED": 50, "INF_A": 250, "INF_B": 30, "INF_ALL": 280, "RSV": 40, "RSV_PROCESSED": 500},
                    {"ISO2": "PL", "COUNTRY_AREA_TERRITORY": "Poland", "WHOREGION": "EUR", "ISO_WEEKSTARTDATE": "2026-11-09", "SPEC_PROCESSED_NB": 600, "AH1N12009": 12, "AH3": 18, "ANOTSUBTYPED": 4, "INF_A": 34, "INF_B": 6, "INF_ALL": 40, "RSV": 15, "RSV_PROCESSED": 200},
                ],
            }).encode("utf-8")

        if "api.ukhsa-dashboard.data.gov.uk" in url:
            return json.dumps({
                "results": [
                    {"geography": "England", "date": "2026-11-09", "metric_value": 5.4},
                    {"geography": "England", "date": "2026-11-02", "metric_value": 4.2},
                ]
            }).encode("utf-8")

        if "seasonal-flu_h3n2_ha_2y.json" in url:
            return json.dumps({
                "tree": {
                    "name": "root",
                    "children": [
                        {"name": "tip_na_1", "node_attrs": {"region": {"value": "North America"}, "subclade": {"value": "J.2"}}},
                        {"name": "tip_na_2", "node_attrs": {"region": {"value": "North America"}, "subclade": {"value": "J.2.2"}}},
                        {"name": "tip_eu_1", "node_attrs": {"region": {"value": "Europe"}, "subclade": {"value": "J.2"}}},
                    ],
                }
            }).encode("utf-8")

        if "seasonal-flu_h3n2_ha_2y_tip-frequencies.json" in url:
            return json.dumps({
                "pivots": [2026.75, 2026.85],
                "tip_na_1": {"frequencies": [0.3, 0.2]},
                "tip_na_2": {"frequencies": [0.1, 0.3]},
                "tip_eu_1": {"frequencies": [0.4, 0.4]},
            }).encode("utf-8")

        if "seasonal-flu_h1n1pdm_ha_2y.json" in url:
            return gzip.compress(json.dumps({
                "tree": {
                    "name": "root",
                    "children": [
                        {"name": "tip_h1_na", "node_attrs": {"region": {"value": "North America"}, "clade_membership": {"value": "5a.2a.1"}}},
                    ],
                }
            }).encode("utf-8"))

        if "seasonal-flu_h1n1pdm_ha_2y_tip-frequencies.json" in url:
            return json.dumps({
                "pivots": [2026.75, 2026.85],
                "tip_h1_na": {"frequencies": [0.5, 0.6]},
            }).encode("utf-8")

        if "ncov_open_north-america_6m.json" in url or "ncov_open_europe_6m.json" in url:
            reg = "North America" if "north-america" in url else "Europe"
            clade = "XFG" if reg == "North America" else "LP.8.1"
            return json.dumps({
                "tree": {
                    "name": "root",
                    "children": [
                        {"name": "cov_tip_1", "node_attrs": {"region": {"value": reg}, "clade_membership": {"value": clade}}},
                    ],
                }
            }).encode("utf-8")

        if "ncov_open_north-america_6m_tip-frequencies.json" in url or "ncov_open_europe_6m_tip-frequencies.json" in url:
            return json.dumps({
                "pivots": [2026.75, 2026.85],
                "cov_tip_1": {"frequencies": [0.7, 0.85]},
            }).encode("utf-8")

        if "sentinelTestsDetectionsPositivity.csv" in url:
            return (
                "survtype,countryname,yearweek,pathogen,pathogentype,pathogensubtype,indicator,age,value\n"
                "primary care sentinel,Poland,2026-W45,Influenza,Influenza,total,positivity,total,6.0\n"
                "primary care sentinel,Poland,2026-W46,Influenza,Influenza,total,positivity,total,7.5\n"
                "primary care sentinel,Poland,2026-W46,Influenza,Influenza,total,positivity,0-4,25.0\n"
                "primary care sentinel,EU/EEA,2026-W45,SARS-CoV-2,SARS-CoV-2,SARS-CoV-2,positivity,total,4.0\n"
                "primary care sentinel,EU/EEA,2026-W46,SARS-CoV-2,SARS-CoV-2,SARS-CoV-2,positivity,total,5.2\n"
            ).encode("utf-8")

        if "ILIARIRates.csv" in url:
            return (
                "survtype,countryname,yearweek,indicator,age,value\n"
                "primary care syndromic,Poland,2026-W45,ILIconsultationrate,total,272.3\n"
                "primary care syndromic,Poland,2026-W46,ILIconsultationrate,total,288.1\n"
                "primary care syndromic,Germany,2026-W46,ARIconsultationrate,total,1324.9\n"
            ).encode("utf-8")

        if "SARIRates.csv" in url:
            return (
                "survtype,countryname,yearweek,indicator,age,value\n"
                "SARI syndromic,Germany,2026-W46,SARIrate,total,8.6\n"
            ).encode("utf-8")

        raise RuntimeError(f"Unexpected fixture URL: {url}")

    return _fetch


def _build_us_and_eu_workspace(root: Path, data_dir: Path) -> HubManager:
    """Create minimal US Flu + MA MetroCast HSA hub and EU Poland hub in isolated temp dirs."""
    us_hub = root / "us_flu_hub"
    (us_hub / "hub-config").mkdir(parents=True, exist_ok=True)
    (us_hub / "auxiliary-data").mkdir(parents=True, exist_ok=True)
    (us_hub / "target-data").mkdir(parents=True, exist_ok=True)

    pl.DataFrame({
        "abbreviation": ["US", "MA", "Boston", "CA"],
        "location": ["US", "25", "boston-ma", "06"],
        "location_name": ["United States", "Massachusetts", "Boston, MA", "California"],
        "population": [334_000_000, 7_000_000, 1_900_000, 39_000_000],
    }).write_csv(us_hub / "auxiliary-data" / "locations.csv")

    (us_hub / "hub-config" / "tasks.json").write_text(json.dumps({
        "rounds": [{
            "model_tasks": [
                {
                    "task_ids": {
                        "reference_date": {"optional": ["2026-11-14", "2026-11-21"]},
                        "target": {"required": ["wk inc flu hosp"]},
                        "location": {"required": ["US", "25", "boston-ma", "06"]},
                        "horizon": {"required": [0, 1]},
                    },
                    "output_type": {"quantile": {"output_type_id": {"required": ["0.025", "0.25", "0.5", "0.75", "0.975"]}}},
                },
                {
                    "task_ids": {
                        "reference_date": {"optional": ["2026-11-14", "2026-11-21"]},
                        "target": {"required": ["wk flu hosp rate change"]},
                        "location": {"required": ["US", "25"]},
                        "horizon": {"required": [0, 1]},
                    },
                    "output_type": {"pmf": {"output_type_id": {"required": ["large_decrease", "decrease", "stable", "increase", "large_increase"]}}},
                },
            ]
        }]
    }), encoding="utf-8")

    # Oracle observations covering two seasons + 2 rounds
    pl.DataFrame({
        "target": ["wk inc flu hosp"] * 8,
        "location": ["US", "US", "25", "25", "boston-ma", "boston-ma", "06", "25"],
        "target_end_date": ["2026-11-07", "2026-11-14", "2026-11-07", "2026-11-14", "2026-11-07", "2026-11-14", "2026-11-14", "2025-11-15"],
        "oracle_value": [1200.0, 1500.0, 45.0, 60.0, 12.0, 18.0, 180.0, 32.0],
    }).write_parquet(us_hub / "target-data" / "oracle.parquet")

    # Ensemble and baseline models
    for mid, mult in [("FluSight-ensemble", 1.0), ("FluSight-baseline", 0.85)]:
        for rdate, ted0, ted1, obs_mult in [
            ("2026-11-14", "2026-11-14", "2026-11-21", 1.0),
            ("2026-11-21", "2026-11-21", "2026-11-28", 1.1),
        ]:
            q_rows = []
            for loc, base_val in [("US", 1500.0), ("25", 60.0), ("boston-ma", 18.0), ("06", 180.0)]:
                for h_idx, ted in [(0, ted0), (1, ted1)]:
                    med = base_val * (1.0 + 0.08 * h_idx) * mult * obs_mult
                    for qid, qmult in [("0.025", 0.6), ("0.25", 0.85), ("0.5", 1.0), ("0.75", 1.15), ("0.975", 1.5)]:
                        q_rows.append({
                            "reference_date": rdate,
                            "target": "wk inc flu hosp",
                            "horizon": h_idx,
                            "target_end_date": ted,
                            "location": loc,
                            "output_type": "quantile",
                            "output_type_id": qid,
                            "value": med * qmult,
                        })
            for loc in ["US", "25"]:
                for cat, prob in [("large_decrease", 0.05), ("decrease", 0.15), ("stable", 0.35), ("increase", 0.35), ("large_increase", 0.10)]:
                    q_rows.append({
                        "reference_date": rdate,
                        "target": "wk flu hosp rate change",
                        "horizon": 1,
                        "target_end_date": ted1,
                        "location": loc,
                        "output_type": "pmf",
                        "output_type_id": cat,
                        "value": prob,
                    })
            df_m = pl.DataFrame(q_rows)
            p_m = us_hub / "model-output" / mid / f"{rdate}-{mid}.parquet"
            p_m.parent.mkdir(parents=True, exist_ok=True)
            df_m.write_parquet(p_m)

    # EU hub for Poland ("PL")
    eu_hub = root / "eu_respicast"
    (eu_hub / "hub-config").mkdir(parents=True, exist_ok=True)
    (eu_hub / "auxiliary-data").mkdir(parents=True, exist_ok=True)
    (eu_hub / "target-data").mkdir(parents=True, exist_ok=True)
    pl.DataFrame({
        "location": ["PL", "DE"],
        "location_name": ["Poland", "Germany"],
        "population": [36_620_000, 83_445_000],
    }).write_csv(eu_hub / "auxiliary-data" / "locations.csv")
    (eu_hub / "hub-config" / "tasks.json").write_text(json.dumps({
        "rounds": [{
            "model_tasks": [{
                "task_ids": {
                    "reference_date": {"optional": ["2026-11-18"]},
                    "target": {"required": ["ILI incidence"]},
                    "location": {"required": ["PL", "DE"]},
                    "horizon": {"required": [1, 2]},
                },
                "output_type": {"quantile": {"output_type_id": {"required": ["0.025", "0.5", "0.975"]}}},
            }]
        }]
    }), encoding="utf-8")
    pl.DataFrame({
        "target": ["ILI incidence"] * 4,
        "location": ["PL", "PL", "DE", "DE"],
        "target_end_date": ["2026-11-08", "2026-11-15", "2026-11-08", "2026-11-15"],
        "oracle_value": [210.0, 245.0, 310.0, 340.0],
    }).write_parquet(eu_hub / "target-data" / "oracle.parquet")
    eu_rows = []
    for loc, base in [("PL", 245.0), ("DE", 340.0)]:
        for h_idx, ted in [(1, "2026-11-22"), (2, "2026-11-29")]:
            for qid, qm in [("0.025", 0.7), ("0.5", 1.0), ("0.975", 1.35)]:
                eu_rows.append({
                    "reference_date": "2026-11-18",
                    "target": "ILI incidence",
                    "horizon": h_idx,
                    "target_end_date": ted,
                    "location": loc,
                    "output_type": "quantile",
                    "output_type_id": qid,
                    "value": base * qm,
                })
    p_eu = eu_hub / "model-output" / "RespiCast-ensemble" / "2026-11-18-RespiCast-ensemble.parquet"
    p_eu.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(eu_rows).write_parquet(p_eu)

    return HubManager(
        data_dir=data_dir,
        cli_hubs=[us_hub, eu_hub],
        include_enclosing=False,
    )


class TestBriefingFeedsAndBuilder(unittest.TestCase):
    def setUp(self):
        self.tmp_root = Path(tempfile.mkdtemp(prefix="viz_briefing_test_"))
        self.data_dir = self.tmp_root / "data"
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.tmp_root, ignore_errors=True)

    def test_constants_and_vaccine_reference(self):
        self.assertEqual(US_FIPS_TO_HHS["25"], 1)
        self.assertEqual(US_FIPS_TO_HHS["06"], 9)
        seasons = {r["season"] for r in WHO_NH_VACCINE_REFERENCE}
        self.assertIn("2026-27", seasons)
        self.assertIn("2025-26", seasons)

    def test_rank_ensemble_candidates_prefers_official_hub_ensemble(self):
        models = {
            "flusight:CADPH-FluCAT_Ensemble": {"designated": True, "targets": ["wk inc flu hosp"], "dates": ["2026-11-21"] * 90},
            "flusight:FluSight-HJudge_ensemble": {"designated": False, "targets": ["wk inc flu hosp"], "dates": ["2026-11-21"] * 35},
            "flusight:FluSight-lop_norm": {"designated": False, "targets": ["wk inc flu hosp"], "dates": ["2026-11-21"] * 92},
            "flusight:FluSight-baseline": {"designated": False, "is_baseline": True, "targets": ["wk inc flu hosp"], "dates": ["2026-11-21"] * 92},
            "flusight:FluSight-ensemble": {"designated": False, "targets": ["wk inc flu hosp"], "dates": ["2026-11-21"] * 92},
        }
        meta = {
            "flusight:FluSight-ensemble": {"ensemble_of_hub_models": True},
            "flusight:CADPH-FluCAT_Ensemble": {"ensemble_of_hub_models": False},
        }
        ranked = rank_ensemble_candidates(
            models,
            "wk inc flu hosp",
            "2026-11-21",
            get_meta=lambda m: meta.get(m, {}),
            hub_id="reich_lab_forecasting_testbed_for",
        )
        self.assertEqual(ranked[0], "flusight:FluSight-ensemble")
        self.assertEqual(display_model_name(ranked[0]), "FluSight-ensemble")
        self.assertNotIn("flusight:FluSight-baseline", ranked)

    def test_all_eight_feeds_fetch_cache_ttl_and_partial_failure(self):
        store = BriefingFeedStore(self.data_dir, fetcher=_fixture_router())
        st0 = store.get_status()
        self.assertFalse(st0["any_cached"])
        self.assertEqual(set(st0["feeds"].keys()), set(FEED_SPECS.keys()))

        st1 = store.refresh_sync(force=True)
        self.assertTrue(st1["any_cached"])
        self.assertFalse(st1["refreshing"])
        for fid, entry in st1["feeds"].items():
            self.assertTrue(entry["cached"], f"{fid} should be cached")
            self.assertFalse(entry["stale"], f"{fid} should be fresh")
            self.assertIsNone(entry["error"], f"{fid} had unexpected error: {entry.get('error')}")
            self.assertGreater(entry["rows"], 0, f"{fid} returned 0 rows")

        # Verify site-weighted National aggregate synthesis in CDC NWSS
        df_nw = store.read_feed("cdc_nwss")
        self.assertIsNotNone(df_nw)
        us_nw = df_nw.filter((pl.col("location_id") == "US") & (pl.col("pathogen") == "flu") & (pl.col("week_end") == "2026-11-14"))
        self.assertEqual(us_nw.height, 1)
        # weighted avg of (4.2*18 + 1.8*30) / 48 = 2.7
        self.assertAlmostEqual(us_nw["mean_wval"].item(), 2.7, places=2)

        # Verify CFA Rt deduplicated to newest as_of (1.14, Growing)
        df_rt = store.read_feed("cdc_cfa_rt")
        ma_rt = df_rt.filter((pl.col("location_id") == "25") & (pl.col("pathogen") == "flu"))
        self.assertEqual(ma_rt.height, 1)
        self.assertAlmostEqual(ma_rt["median"].item(), 1.14, places=2)
        self.assertEqual(ma_rt["category"].item(), "Growing")

        # Verify Nextstrain regional clade sums (~1.0 within North America H3N2)
        df_ns = store.read_feed("nextstrain_clades")
        na_h3 = df_ns.filter((pl.col("region") == "North America") & (pl.col("subtype") == "A(H3N2)") & (pl.col("date") == df_ns["date"].max()))
        self.assertAlmostEqual(sum(na_nw for na_nw in na_h3["frequency"].to_list()), 1.0, places=2)

        # Memoized read_feed returns same cached DataFrame instance on unchanged mtime
        self.assertIs(store.read_feed("cdc_nwss"), df_nw)

        # Refresh with partial upstream failure preserves existing Parquet file cleanly
        failing_store = BriefingFeedStore(self.data_dir, fetcher=_fixture_router(fail_urls=("atcp-73re.json",)))
        st2 = failing_store.refresh_sync(force=True)
        self.assertIsNotNone(st2["feeds"]["cdc_nwss"]["error"])
        self.assertTrue(st2["feeds"]["cdc_nwss"]["cached"])
        self.assertGreater(failing_store.read_feed("cdc_nwss").height, 0)

    def test_briefing_builder_us_ma_substate_and_poland(self):
        mgr = _build_us_and_eu_workspace(self.tmp_root, self.data_dir)
        mgr.briefing_feeds = BriefingFeedStore(self.data_dir, fetcher=_fixture_router())
        mgr.briefings.feed_store = mgr.briefing_feeds

        # 1. Uncached external feeds -> no fabricated surveillance metrics
        uncached_us = mgr.briefings.build_briefing("US")
        self.assertFalse(uncached_us["empty"])
        self.assertFalse(uncached_us["virology"]["feeds_cached"])
        self.assertEqual(uncached_us["virology"]["wastewater"], [])
        self.assertEqual(uncached_us["place"]["key"], "US")

        # 2. Populate external feeds
        mgr.briefing_feeds.refresh_sync(force=True)

        # Massachusetts state briefing
        ma = mgr.briefings.build_briefing("25")
        self.assertEqual(ma["place"]["key"], "25")
        self.assertEqual(ma["place"]["hhs_region"], 1)
        self.assertGreaterEqual(len(ma["signals"]), 1)
        sig0 = ma["signals"][0]
        self.assertIsNotNone(sig0["fan"])
        self.assertEqual(sig0["model_display"], "FluSight-ensemble")
        self.assertIsNotNone(sig0["rate_change_pmf"])
        self.assertEqual(len(ma["virology"]["wastewater"]), 2)
        self.assertEqual(len(ma["virology"]["cfa_rt"]), 1)
        self.assertIsNotNone(ma["virology"]["flu_subtypes"])
        self.assertGreaterEqual(len(ma["virology"]["clades"]), 2)
        self.assertEqual(ma["calibration"], [])
        self.assertTrue(any(k.get("signal_id") == sig0["signal_id"] for k in ma["kpis"]))
        # Ensure strict factual prose (no loaded adjectives/medical advice)
        prose = " ".join(ma["summary"]["paragraphs"]).lower()
        for banned in ("alarming", "surge", "crisis", "panic", "you should"):
            self.assertNotIn(banned, prose)

        # US briefing carries sub-region deep-link metadata for peer rows
        us = mgr.briefings.build_briefing("US")
        self.assertIsNotNone(us["peers"].get("hub_id"))
        self.assertIsNotNone(us["peers"].get("target_id"))
        if us["peers"]["rows"]:
            self.assertIn("location_id", us["peers"]["rows"][0])

        # Poland has no sub-regions so peers section should be empty, and includes ECDC ERVISS + WHO fallback
        pl_brief = mgr.briefings.build_briefing("PL")
        self.assertEqual(pl_brief["place"]["key"], "PL")
        self.assertEqual(pl_brief["place"]["clade_region"], "Europe")
        self.assertIsNotNone(pl_brief["virology"]["flu_subtypes"])
        self.assertEqual(pl_brief["virology"]["wastewater"], [])  # zero US-only mock panels for Poland
        self.assertEqual(pl_brief["peers"]["rows"], [])
        ecdc = pl_brief["virology"].get("ecdc_surveillance") or []
        self.assertTrue(any(e["indicator"] == "sentinel_positivity" and e["pathogen"] == "flu" and e["latest_value"] == 7.5 for e in ecdc))
        self.assertTrue(any(e["indicator"] == "sentinel_positivity" and e["pathogen"] == "covid-19" and "EU/EEA" in e["geo_scope"] for e in ecdc))
        self.assertTrue(any(e["indicator"] == "ili_rate" and e["latest_value"] == 288.1 for e in ecdc))
        # WHO FluNet RSV fallback present since Poland has no RSV row in mock ECDC
        self.assertTrue(any(e["source"] == "WHO FluNet" and e["pathogen"] == "rsv" for e in ecdc))

    def test_ecdc_erviss_parser_and_partial_failure(self):
        self.assertEqual(_iso_yearweek_to_sunday("2026-W46"), "2026-11-15")
        df = fetch_ecdc_erviss(_fixture_router(fail_urls=("SARIRates.csv",)))
        self.assertGreater(df.height, 0)
        # Age 0-4 filtered out; only total retained
        pl_flu = df.filter((pl.col("location_id") == "PL") & (pl.col("pathogen") == "flu") & (pl.col("week_end") == "2026-11-15"))
        self.assertEqual(pl_flu.height, 1)
        self.assertAlmostEqual(pl_flu["value"].item(), 7.5, places=2)
        self.assertEqual(df.filter(pl.col("location_id") == "EU").height, 2)

    def test_briefing_http_endpoints(self):
        mgr = _build_us_and_eu_workspace(self.tmp_root, self.data_dir)
        mgr.briefing_feeds = BriefingFeedStore(self.data_dir, fetcher=_fixture_router())
        mgr.briefings.feed_store = mgr.briefing_feeds
        mgr.briefing_feeds.refresh_sync(force=True)

        class _TestHandler(SandboxRequestHandler):
            hub_manager = mgr
            def log_message(self, format, *args):
                return

        socketserver.ThreadingTCPServer.allow_reuse_address = True
        httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _TestHandler)
        port = httpd.server_address[1]
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        conn = None
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            conn.request("GET", "/api/next/briefing?place=25")
            resp = conn.getresponse()
            body = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(resp.status, 200)
            self.assertEqual(body["place"]["key"], "25")

            conn.request("GET", "/api/next/briefing/status")
            resp = conn.getresponse()
            st = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(resp.status, 200)
            self.assertTrue(st["any_cached"])

            # POST /api/briefing/refresh rejects non-JSON Content-Type
            conn.request("POST", "/api/briefing/refresh", body="{}", headers={"Content-Type": "text/plain"})
            resp = conn.getresponse()
            resp.read()
            self.assertEqual(resp.status, 415)

            # POST /api/briefing/refresh accepts valid JSON and triggers background thread
            conn.request("POST", "/api/briefing/refresh", body=json.dumps({"feeds": ["cdc_nwss"], "force": False}), headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
            ref_body = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(resp.status, 202)
            self.assertIn("status", ref_body)
            # Wait briefly so background thread exits before tearDown removes temp dir
            for _ in range(40):
                if not mgr.briefing_feeds.get_status()["refreshing"]:
                    break
                time.sleep(0.05)

            # Bad feed id -> 400
            conn.request("POST", "/api/briefing/refresh", body=json.dumps({"feeds": ["nonexistent_feed"]}), headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
            resp.read()
            self.assertEqual(resp.status, 400)
        finally:
            if conn is not None:
                conn.close()
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
