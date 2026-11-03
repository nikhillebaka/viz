"""
Unit and integration tests for self-contained surveillance data handling and rebuild utility.
Compatible with both standard library unittest and pytest test runners.
"""

from pathlib import Path
import tempfile
import unittest

import polars as pl

from viz.core.cache_manager import ParquetCacheManager
from viz.core.data_loader import SandboxDataLoader
from viz.rebuild_surveillance import (
    validate_admissions_csv,
    synthesize_admissions_from_oracle,
)

BASE_DIR = Path(__file__).resolve().parent.parent.parent


class TestSurveillanceRebuild(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repo_root = BASE_DIR

    def test_validate_admissions_csv(self):
        adm_csv = self.repo_root / "viz" / "data" / "surveillance" / "target-hospital-admissions.csv"
        if adm_csv.exists():
            result = validate_admissions_csv(adm_csv)
            self.assertTrue(result["valid"])
            self.assertGreater(result["total_rows"], 0)
            self.assertGreaterEqual(result["distinct_locations"], 50)
            self.assertIsNotNone(result["min_date"])
            self.assertIsNotNone(result["max_date"])

    def test_synthesize_admissions_from_oracle(self):
        oracle_csv = self.repo_root / "target-data" / "oracle-output.csv"
        if not oracle_csv.exists():
            self.skipTest("oracle-output.csv not found")

        with tempfile.TemporaryDirectory() as tmp_dir:
            dest_csv = Path(tmp_dir) / "synth_admissions.csv"
            ok = synthesize_admissions_from_oracle(oracle_csv, dest_csv)
            self.assertTrue(ok)
            self.assertTrue(dest_csv.exists())

            df = pl.read_csv(dest_csv, schema_overrides={"location": pl.String})
            self.assertIn("date", df.columns)
            self.assertIn("location", df.columns)
            self.assertIn("value", df.columns)
            self.assertGreater(len(df), 0)

    def test_cache_manager_self_contained_surveillance(self):
        cm = ParquetCacheManager(self.repo_root)
        self.assertTrue(cm.surveillance_dir.exists())
        self.assertTrue(cm.surveillance_dir.is_dir())

        pq = cm.get_admissions_parquet()
        self.assertIsNotNone(pq)
        self.assertTrue(pq.exists())

        lf = cm.scan_admissions()
        self.assertIsNotNone(lf)
        df = lf.collect()
        self.assertIn("target_end_date", df.columns)
        self.assertIn("location", df.columns)
        self.assertIn("oracle_value", df.columns)
        self.assertGreater(len(df), 0)

    def test_cache_manager_initial_admissions(self):
        cm = ParquetCacheManager(self.repo_root)
        pq = cm.get_initial_admissions_parquet()
        self.assertIsNotNone(pq)
        self.assertTrue(pq.exists())

        lf = cm.scan_initial_admissions()
        self.assertIsNotNone(lf)
        df = lf.collect()
        self.assertIn("target_end_date", df.columns)
        self.assertIn("location", df.columns)
        self.assertIn("oracle_value", df.columns)
        self.assertGreater(len(df), 0)

    def test_data_loader_surveillance_streams(self):
        dl = SandboxDataLoader(base_dir=self.repo_root)
        surv = dl.get_surveillance_streams(target="wk inc flu hosp", location="US", reference_date="2024-01-13")

        self.assertEqual(surv["location"], "US")
        self.assertEqual(surv["reference_date"], "2024-01-13")
        self.assertIn("nssp", surv)
        self.assertIn("historical_seasons", surv)
        self.assertGreater(len(surv["historical_seasons"]), 0)
        self.assertIn("unrevised", surv)
        self.assertTrue(surv["unrevised"]["available"])
        self.assertGreater(len(surv["unrevised"]["data"]), 0)
        self.assertEqual(surv["unrevised"]["season"], "2023/24")
        self.assertTrue(all(d["date"] <= surv["reference_date"] for d in surv["unrevised"]["data"]))

    def test_data_loader_unrevised_stream_latest_season(self):
        dl = SandboxDataLoader(base_dir=self.repo_root)
        surv = dl.get_surveillance_streams(target="wk inc flu hosp", location="US", reference_date="2026-05-30")
        self.assertIn("unrevised", surv)
        self.assertTrue(surv["unrevised"]["available"])
        self.assertGreater(len(surv["unrevised"]["data"]), 0)
        self.assertEqual(surv["unrevised"]["season"], "2025/26")
        self.assertTrue(all(d["date"] <= "2026-05-30" for d in surv["unrevised"]["data"]))

        # Verify dynamic update and cutoff termination for a mid-season reference date (2026-01-24)
        surv_mid = dl.get_surveillance_streams(target="wk inc flu hosp", location="US", reference_date="2026-01-24")
        self.assertTrue(surv_mid["unrevised"]["available"])
        mid_dates = [d["date"] for d in surv_mid["unrevised"]["data"]]
        self.assertIn("2026-01-17", mid_dates)
        self.assertNotIn("2026-01-24", mid_dates)
        self.assertNotIn("2026-01-31", mid_dates)
        self.assertEqual(max(mid_dates), "2026-01-17")  # Exactly terminates at cutoff line

        # Verify that unrevised initial report is lower than settled oracle truth for surge weeks
        truth = dl.get_ground_truth_series(target="wk inc flu hosp", location="US", reference_date="2026-05-30")
        truth_map = {d["date"]: d["value"] for d in (truth["history"] + truth["future"] + truth["season_remainder"])}
        unrev_map = {d["date"]: d["value"] for d in surv["unrevised"]["data"]}

        # 2026-01-03 peak: Initial report was ~39,067, settled truth was 42,626
        if "2026-01-03" in unrev_map and "2026-01-03" in truth_map:
            self.assertLess(unrev_map["2026-01-03"], truth_map["2026-01-03"])

        # 2026-02-14 surge: Initial report was ~13,812, settled truth was 16,444
        if "2026-02-14" in unrev_map and "2026-02-14" in truth_map:
            self.assertLess(unrev_map["2026-02-14"], truth_map["2026-02-14"])

    def test_as_of_vintage_revisions_across_timepoints(self):
        """Verify that past observation points revise upward/downward as the forecast reference date advances."""
        dl = SandboxDataLoader(base_dir=self.repo_root)
        surv_jan17 = dl.get_surveillance_streams(target="wk inc flu hosp", location="US", reference_date="2026-01-17")
        surv_jan24 = dl.get_surveillance_streams(target="wk inc flu hosp", location="US", reference_date="2026-01-24")
        surv_feb07 = dl.get_surveillance_streams(target="wk inc flu hosp", location="US", reference_date="2026-02-07")

        jan17_map = {d["date"]: d["value"] for d in surv_jan17["unrevised"]["data"]}
        jan24_map = {d["date"]: d["value"] for d in surv_jan24["unrevised"]["data"]}
        feb07_map = {d["date"]: d["value"] for d in surv_feb07["unrevised"]["data"]}

        # 2026-01-10 was reported in Jan 17, revised up in Jan 24, and revised up again in Feb 07
        self.assertIn("2026-01-10", jan17_map)
        self.assertIn("2026-01-10", jan24_map)
        self.assertIn("2026-01-10", feb07_map)
        self.assertLess(jan17_map["2026-01-10"], jan24_map["2026-01-10"])
        self.assertLess(jan24_map["2026-01-10"], feb07_map["2026-01-10"])

        # 2026-01-17 was reported on Jan 24, then revised up in Feb 07
        self.assertIn("2026-01-17", jan24_map)
        self.assertIn("2026-01-17", feb07_map)
        self.assertLess(jan24_map["2026-01-17"], feb07_map["2026-01-17"])


if __name__ == "__main__":
    unittest.main()
