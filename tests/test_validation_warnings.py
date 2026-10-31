"""
Unit tests for data validation warnings and schema integrity checks.
Validates that empty files, unparseable CSVs, missing columns,
and local model collisions generate structured warnings.
"""

from pathlib import Path
import shutil
import tempfile
import unittest

import polars as pl
from viz.cache_manager import ParquetCacheManager
from viz.data_loader import SandboxDataLoader


class TestValidationWarnings(unittest.TestCase):
    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())
        self.model_out = self.test_dir / "model-output" / "bad-model"
        self.model_out.mkdir(parents=True)

        self.mgr = ParquetCacheManager(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_missing_required_columns_warning(self):
        """CSV missing 'value' column generates validation warning."""
        csv_file = self.model_out / "2025-01-11-bad-model.csv"
        # Missing 'value' column
        df = pl.DataFrame({
            "reference_date": ["2025-01-11"],
            "target_end_date": ["2025-01-18"],
            "location": ["US"],
            "target": ["wk inc flu hosp"],
            "horizon": [1],
            "output_type": ["quantile"],
            "output_type_id": [0.5],
        })
        df.write_csv(csv_file)

        pq = self.mgr.get_model_parquet("bad-model")
        # Should fail to generate parquet and record warning
        self.assertIsNone(pq)
        warnings = self.mgr.get_validation_warnings(["bad-model"])
        self.assertTrue(any("missing required columns" in w for w in warnings))

    def test_empty_file_warning(self):
        """Zero-row CSV generates validation warning."""
        csv_file = self.model_out / "2025-01-11-bad-model.csv"
        # Only header, 0 rows
        with open(csv_file, "w") as f:
            f.write("reference_date,target_end_date,location,target,horizon,output_type,output_type_id,value\n")

        pq = self.mgr.get_model_parquet("bad-model")
        self.assertIsNone(pq)
        warnings = self.mgr.get_validation_warnings(["bad-model"])
        self.assertTrue(any("contains zero data rows" in w for w in warnings))


if __name__ == "__main__":
    unittest.main()
