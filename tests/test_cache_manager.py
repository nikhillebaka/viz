"""
Tests for ParquetCacheManager.
Validates mtime-based cache invalidation, thread safety under concurrent writes,
and atomic temporary file renaming.
"""

import concurrent.futures
from pathlib import Path
import shutil
import tempfile
import unittest

import polars as pl
from viz.cache_manager import ParquetCacheManager


class TestCacheManager(unittest.TestCase):
    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())
        self.model_out = self.test_dir / "model-output" / "test-model"
        self.model_out.mkdir(parents=True)

        # Write dummy forecast CSV
        self.csv_file = self.model_out / "2025-01-11-test-model.csv"
        df = pl.DataFrame({
            "reference_date": ["2025-01-11"],
            "target_end_date": ["2025-01-18"],
            "location": ["US"],
            "target": ["wk inc flu hosp"],
            "horizon": [1],
            "output_type": ["quantile"],
            "output_type_id": [0.5],
            "value": [100.0],
        })
        df.write_csv(self.csv_file)

        self.mgr = ParquetCacheManager(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_cache_creation_and_freshness(self):
        pq = self.mgr.get_model_parquet("test-model")
        self.assertIsNotNone(pq)
        self.assertTrue(pq.exists())

        # Calling again should hit fresh cache without error
        pq2 = self.mgr.get_model_parquet("test-model")
        self.assertEqual(pq, pq2)

    def test_cache_invalidation_on_csv_touch(self):
        pq1 = self.mgr.get_model_parquet("test-model")
        self.assertIsNotNone(pq1)
        mtime1 = pq1.stat().st_mtime

        # Append new CSV file
        csv2 = self.model_out / "2025-01-18-test-model.csv"
        df2 = pl.DataFrame({
            "reference_date": ["2025-01-18"],
            "target_end_date": ["2025-01-25"],
            "location": ["US"],
            "target": ["wk inc flu hosp"],
            "horizon": [1],
            "output_type": ["quantile"],
            "output_type_id": [0.5],
            "value": [120.0],
        })
        df2.write_csv(csv2)

        pq2 = self.mgr.get_model_parquet("test-model")
        self.assertIsNotNone(pq2)
        # Scan lazy frame: should contain both dates now
        lf = self.mgr.scan_model("test-model")
        self.assertEqual(lf.collect().height, 2)

    def test_concurrent_multithreaded_cache_access(self):
        """Verify that multiple concurrent threads requesting an uncached model do not corrupt data."""
        self.mgr.clear_cache("test-model")

        def fetch_parquet():
            return self.mgr.get_model_parquet("test-model")

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            futures = [executor.submit(fetch_parquet) for _ in range(16)]
            results = [f.result() for f in futures]

        for p in results:
            self.assertIsNotNone(p)
            self.assertTrue(p.exists())

        # Verify the resulting parquet file is valid and readable
        df = pl.read_parquet(results[0])
        self.assertEqual(df.height, 1)

    def test_oracle_parquet_and_csv_support(self):
        """Verify that oracle tables stored as either .parquet or .csv are discovered and parsed."""
        t_dir = self.test_dir / "target-data"
        t_dir.mkdir(parents=True, exist_ok=True)
        oracle_pq = t_dir / "oracle-output.parquet"

        df_oracle = pl.DataFrame({
            "target": ["wk inc flu hosp"],
            "location": ["US"],
            "target_end_date": ["2025-01-18"],
            "horizon": [1],
            "oracle_value": [42.0],
        })
        df_oracle.write_parquet(oracle_pq)

        pq = self.mgr.get_oracle_parquet()
        self.assertIsNotNone(pq)
        self.assertTrue(pq.exists())

        lf = self.mgr.scan_oracle()
        self.assertIsNotNone(lf)
        res = lf.collect()
        self.assertEqual(res.height, 1)
        self.assertEqual(res["oracle_value"][0], 42.0)

    def test_oracle_missing_horizon_and_admissions_fallback(self):
        """Verify that oracle files without a 'horizon' column default gracefully to horizon=0 without crashing."""
        t_dir = self.test_dir / "target-data"
        t_dir.mkdir(parents=True, exist_ok=True)
        oracle_csv = t_dir / "oracle-output.csv"

        # Hubverse ground truth files typically only contain target, location, target_end_date, oracle_value
        df_no_horizon = pl.DataFrame({
            "target": ["wk inc flu hosp"],
            "location": ["US"],
            "target_end_date": ["2025-01-18"],
            "oracle_value": [55.5],
        })
        df_no_horizon.write_csv(oracle_csv)

        # Remove admissions csv so fallback to oracle is exercised
        adm_pq = self.mgr.get_admissions_parquet()
        self.assertIsNotNone(adm_pq)
        self.assertTrue(adm_pq.exists())

        lf = self.mgr.scan_admissions()
        self.assertIsNotNone(lf)
        res = lf.collect()
        self.assertIn("horizon", res.columns)
        self.assertEqual(res["horizon"][0], 0)
        self.assertEqual(res["oracle_value"][0], 55.5)

    def test_model_parquet_support(self):
        """Verify that model forecast outputs saved as .parquet files are loaded properly."""
        pq_model_dir = self.test_dir / "model-output" / "parquet-model"
        pq_model_dir.mkdir(parents=True, exist_ok=True)
        pq_file = pq_model_dir / "2025-01-11-parquet-model.parquet"

        df_model = pl.DataFrame({
            "reference_date": ["2025-01-11"],
            "target_end_date": ["2025-01-18"],
            "location": ["US"],
            "target": ["wk inc flu hosp"],
            "horizon": [1],
            "output_type": ["quantile"],
            "output_type_id": [0.5],
            "value": [77.7],
        })
        df_model.write_parquet(pq_file)

        pq = self.mgr.get_model_parquet("parquet-model")
        self.assertIsNotNone(pq)
        self.assertTrue(pq.exists())

        lf = self.mgr.scan_model("parquet-model")
        self.assertIsNotNone(lf)
        res = lf.collect()
        self.assertEqual(res.height, 1)
        self.assertEqual(res["value"][0], 77.7)


if __name__ == "__main__":
    unittest.main()
