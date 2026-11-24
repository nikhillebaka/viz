"""
Self-contained unit and integration tests for surveillance data handling,
oracle-to-admissions synthesis, initial/revised streams, and as-of vintage cutoffs.
"""

from pathlib import Path
import shutil
import sys
import tempfile
import unittest

import polars as pl

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from conftest import APP_DIR, SYNTH_TARGET, build_synthetic_hub  # noqa: E402
from viz.core.cache_manager import ParquetCacheManager  # noqa: E402
from viz.core.data_loader import SandboxDataLoader  # noqa: E402
from viz.rebuild_surveillance import (  # noqa: E402
    synthesize_admissions_from_oracle,
    validate_admissions_csv,
)


class TestSurveillanceRebuild(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = Path(tempfile.mkdtemp(prefix="viz-surv-test-")).resolve()
        cls.hub_dir = build_synthetic_hub(cls._tmp / "hub", with_surveillance_vintages=True)
        cls.empty_surv_dir = cls._tmp / "empty-surv"
        cls.empty_surv_dir.mkdir(parents=True, exist_ok=True)
        cls.synth_surv_dir = cls._tmp / "synth-surv"
        cls.synth_surv_dir.mkdir(parents=True, exist_ok=True)

        oracle_csv = cls.hub_dir / "target-data" / "oracle-output.csv"
        adm_csv = cls.synth_surv_dir / "target-hospital-admissions.csv"
        synthesize_admissions_from_oracle(oracle_csv, adm_csv)
        # Create an initial-admissions stream scaled down by 10% relative to settled admissions.
        pl.read_csv(adm_csv, schema_overrides={"location": pl.String}).with_columns(
            (pl.col("value") * 0.9).round(1).alias("value")
        ).write_csv(cls.synth_surv_dir / "initial-hospital-admissions.csv")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def test_validate_admissions_csv(self):
        synth_adm = self.synth_surv_dir / "target-hospital-admissions.csv"
        res_synth = validate_admissions_csv(synth_adm)
        self.assertTrue(res_synth["valid"])
        self.assertGreater(res_synth["total_rows"], 0)
        self.assertEqual(res_synth["distinct_locations"], 7)

        bundled = APP_DIR / "data" / "surveillance" / "target-hospital-admissions.csv"
        if bundled.exists():
            res_bundled = validate_admissions_csv(bundled)
            self.assertTrue(res_bundled["valid"])
            self.assertGreaterEqual(res_bundled["distinct_locations"], 50)

    def test_synthesize_admissions_from_oracle(self):
        oracle_csv = self.hub_dir / "target-data" / "oracle-output.csv"
        dest_csv = self._tmp / "re-synth-admissions.csv"
        self.assertTrue(synthesize_admissions_from_oracle(oracle_csv, dest_csv))
        self.assertTrue(dest_csv.exists())
        df = pl.read_csv(dest_csv, schema_overrides={"location": pl.String})
        self.assertEqual(set(["date", "location", "value"]).issubset(df.columns), True)
        self.assertGreater(len(df), 0)

    def test_cache_manager_admissions_and_initial_admissions(self):
        cm = ParquetCacheManager(
            self.hub_dir,
            include_remote=False,
            cache_dir=self._tmp / "cm-cache",
            surveillance_dir=self.synth_surv_dir,
        )
        adm_pq = cm.get_admissions_parquet(target=SYNTH_TARGET)
        self.assertIsNotNone(adm_pq)
        self.assertTrue(adm_pq.exists())
        adm_df = cm.scan_admissions(target=SYNTH_TARGET).collect()
        for col in ("target_end_date", "location", "oracle_value"):
            self.assertIn(col, adm_df.columns)
        self.assertGreater(len(adm_df), 0)

        init_pq = cm.get_initial_admissions_parquet()
        self.assertIsNotNone(init_pq)
        self.assertTrue(init_pq.exists())
        init_df = cm.scan_initial_admissions().collect()
        for col in ("target_end_date", "location", "oracle_value"):
            self.assertIn(col, init_df.columns)
        self.assertGreater(len(init_df), 0)

    def test_surveillance_streams_nssp_and_historical_seasons(self):
        dl = SandboxDataLoader(
            self.hub_dir,
            include_remote=False,
            cache_dir=self._tmp / "dl-cache-1",
            surveillance_dir=self.empty_surv_dir,
        )
        surv = dl.get_surveillance_streams(target=SYNTH_TARGET, location="US", reference_date="2025-01-18")
        self.assertEqual(surv["location"], "US")
        self.assertEqual(surv["reference_date"], "2025-01-18")
        self.assertTrue(surv["nssp"]["available"])
        self.assertGreater(len(surv["nssp"]["data"]), 0)
        self.assertIn("2023-2024", surv["historical_seasons"])
        self.assertTrue(surv["prior_season"]["available"])
        self.assertTrue(surv["unrevised"]["available"])
        self.assertEqual(surv["unrevised"]["season"], "2024-2025")

    def test_as_of_vintage_revisions_and_cutoff(self):
        """Past observation weeks revise upward across successive reference dates and respect cutoffs."""
        dl = SandboxDataLoader(
            self.hub_dir,
            include_remote=False,
            cache_dir=self._tmp / "dl-cache-2",
            surveillance_dir=self.empty_surv_dir,
        )
        jan04 = dl.get_surveillance_streams(target=SYNTH_TARGET, location="US", reference_date="2025-01-04")
        jan11 = dl.get_surveillance_streams(target=SYNTH_TARGET, location="US", reference_date="2025-01-11")
        jan18 = dl.get_surveillance_streams(target=SYNTH_TARGET, location="US", reference_date="2025-01-18")

        for ref, payload in (("2025-01-04", jan04), ("2025-01-11", jan11), ("2025-01-18", jan18)):
            self.assertTrue(payload["unrevised"]["available"])
            dates = [d["date"] for d in payload["unrevised"]["data"]]
            self.assertTrue(all(d < ref for d in dates), f"Expected strictly < {ref}, got {dates}")

        m04 = {d["date"]: d["value"] for d in jan04["unrevised"]["data"]}
        m11 = {d["date"]: d["value"] for d in jan11["unrevised"]["data"]}
        m18 = {d["date"]: d["value"] for d in jan18["unrevised"]["data"]}

        self.assertLess(m04["2024-12-28"], m11["2024-12-28"])
        self.assertLess(m11["2024-12-28"], m18["2024-12-28"])
        self.assertLess(m11["2025-01-04"], m18["2025-01-04"])


if __name__ == "__main__":
    unittest.main()
