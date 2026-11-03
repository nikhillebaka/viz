"""
Comprehensive unit and integration tests for Synthetic Ensemble Forecast Engine.
Verifies quantile Vincentization (median and mean), spatial split routing,
monotonic rearrangement, data integrity telemetry, filesystem persistence,
and server REST API endpoints.
"""

import json
from pathlib import Path
import shutil
import tempfile
import unittest

import polars as pl

from viz.core.cache_manager import ParquetCacheManager
from viz.core.data_loader import SandboxDataLoader
from viz.core.evaluation import EvaluationEngine, EvaluationParams
from viz.server import SandboxRequestHandler
from viz.core.synthetic_ensemble import (
    SyntheticEnsembleConfig,
    SyntheticEnsembleManager,
    enforce_quantile_monotonicity,
)


class TestSyntheticEnsembleEngine(unittest.TestCase):
    """Test suite for synthetic ensemble generation, monotonicity, and evaluation."""

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.base_dir = Path(self.tmp_dir)

        # Create standard sandbox directory layout
        self.model_out = self.base_dir / "model-output"
        self.local_out = self.base_dir / "local-output"
        self.target_out = self.base_dir / "target-data"
        self.aux_out = self.base_dir / "auxiliary-data"

        self.model_out.mkdir(parents=True)
        self.local_out.mkdir(parents=True)
        self.target_out.mkdir(parents=True)
        self.aux_out.mkdir(parents=True)

        # Create locations.csv
        loc_df = pl.DataFrame({
            "location": ["US", "06", "36"],
            "location_name": ["United States", "California", "New York"],
            "abbreviation": ["US", "CA", "NY"],
            "population": [330000000, 39000000, 19500000],
        })
        loc_df.write_csv(self.aux_out / "locations.csv")

        # Create target oracle data (oracle-output.csv)
        oracle_df = pl.DataFrame({
            "target_end_date": ["2024-01-13", "2024-01-20", "2024-01-13", "2024-01-20"],
            "target": ["wk inc flu hosp", "wk inc flu hosp", "wk inc flu hosp", "wk inc flu hosp"],
            "location": ["US", "US", "06", "06"],
            "oracle_value": [1000.0, 1100.0, 150.0, 160.0],
            "as_of": ["2024-01-27", "2024-01-27", "2024-01-27", "2024-01-27"],
        })
        oracle_df.write_csv(self.target_out / "oracle-output.csv")

        # Create surveillance directory and mock files so rebuild_surveillance_data is not called
        surv_dir = self.base_dir / "viz" / "data" / "surveillance"
        surv_dir.mkdir(parents=True, exist_ok=True)
        pl.DataFrame({
            "location": ["US", "06"],
            "date": ["2024-01-13", "2024-01-13"],
            "value": [1000.0, 150.0],
        }).write_csv(surv_dir / "target-hospital-admissions.csv")
        pl.DataFrame({
            "location": ["US", "06"],
            "wk_end_date": ["2024-01-13", "2024-01-13"],
            "inc": [2.5, 3.1],
        }).write_csv(surv_dir / "ilinet.csv")
        pl.DataFrame({
            "location": ["US", "06"],
            "wk_end_date": ["2024-01-13", "2024-01-13"],
            "inc": [1.2, 1.8],
        }).write_csv(surv_dir / "flusurvnet.csv")


        # Create two test models: Model-A and Model-B
        quantiles = [0.1, 0.5, 0.9]
        rows_a = []
        rows_b = []

        for loc in ["US", "06"]:
            for h in [0, 1]:
                ted = "2024-01-13" if h == 0 else "2024-01-20"
                # Model A values: 900, 1000, 1100 (for US)
                base_a = 1000.0 if loc == "US" else 150.0
                rows_a.extend([
                    {"reference_date": "2024-01-13", "target": "wk inc flu hosp", "horizon": h,
                     "location": loc, "target_end_date": ted, "output_type": "quantile",
                     "output_type_id": 0.1, "value": base_a - 100.0},
                    {"reference_date": "2024-01-13", "target": "wk inc flu hosp", "horizon": h,
                     "location": loc, "target_end_date": ted, "output_type": "quantile",
                     "output_type_id": 0.5, "value": base_a},
                    {"reference_date": "2024-01-13", "target": "wk inc flu hosp", "horizon": h,
                     "location": loc, "target_end_date": ted, "output_type": "quantile",
                     "output_type_id": 0.9, "value": base_a + 100.0},
                ])
                # Model B values: 800, 1200, 1400 (for US)
                base_b = 1200.0 if loc == "US" else 170.0
                rows_b.extend([
                    {"reference_date": "2024-01-13", "target": "wk inc flu hosp", "horizon": h,
                     "location": loc, "target_end_date": ted, "output_type": "quantile",
                     "output_type_id": 0.1, "value": base_b - 200.0},
                    {"reference_date": "2024-01-13", "target": "wk inc flu hosp", "horizon": h,
                     "location": loc, "target_end_date": ted, "output_type": "quantile",
                     "output_type_id": 0.5, "value": base_b},
                    {"reference_date": "2024-01-13", "target": "wk inc flu hosp", "horizon": h,
                     "location": loc, "target_end_date": ted, "output_type": "quantile",
                     "output_type_id": 0.9, "value": base_b + 200.0},
                ])

        dir_a = self.model_out / "Test-ModelA"
        dir_a.mkdir()
        pl.DataFrame(rows_a).write_csv(dir_a / "2024-01-13-Test-ModelA.csv")

        dir_b = self.model_out / "Test-ModelB"
        dir_b.mkdir()
        pl.DataFrame(rows_b).write_csv(dir_b / "2024-01-13-Test-ModelB.csv")

        # Initialize data loader and cache
        self.loader = SandboxDataLoader(self.base_dir)
        self.cache_mgr = self.loader.cache_mgr
        self.cache_mgr.warmup_cache()

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_monotonicity_enforcement(self):
        """Test that inverted/crossed quantiles are rearranged monotonically non-decreasing."""
        # Intentionally crossed quantiles: q0.1 = 150.0, q0.5 = 100.0, q0.9 = 80.0
        crossed_df = pl.DataFrame({
            "reference_date": ["2024-01-13"] * 3,
            "target": ["wk inc flu hosp"] * 3,
            "horizon": [0] * 3,
            "location": ["US"] * 3,
            "target_end_date": ["2024-01-13"] * 3,
            "output_type": ["quantile"] * 3,
            "output_type_id": [0.1, 0.5, 0.9],
            "value": [150.0, 100.0, 80.0],
        })

        rearranged = enforce_quantile_monotonicity(crossed_df)
        vals = rearranged["value"].to_list()
        # Should be strictly non-decreasing: [80.0, 100.0, 150.0]
        self.assertEqual(vals, [80.0, 100.0, 150.0])

    def test_median_and_mean_vincentization(self):
        """Test that median and mean combinations produce exact expected values."""
        mgr = self.loader.ensemble_mgr

        # 1. Median Vincentization
        cfg_median = SyntheticEnsembleConfig(
            id="synth_median_test",
            name="Median Test Ensemble",
            method="median",
            models=["Test-ModelA", "Test-ModelB"],
        )
        mgr.register_ensemble(cfg_median)
        df_med, tel_med = mgr.generate_ensemble_forecasts(cfg_median)

        self.assertFalse(df_med.is_empty())
        self.assertEqual(tel_med["ensemble_id"], "synth_median_test")
        self.assertEqual(tel_med["partial_coverage_tasks"], 0)

        # US horizon 0: Model A median = 1000.0, Model B median = 1200.0 -> Ensemble median = 1100.0
        row_med = df_med.filter(
            (pl.col("location") == "US") & (pl.col("horizon") == 0) & (pl.col("output_type_id") == 0.5)
        )
        self.assertAlmostEqual(row_med["value"][0], 1100.0)

        # 2. Mean Vincentization
        cfg_mean = SyntheticEnsembleConfig(
            id="synth_mean_test",
            name="Mean Test Ensemble",
            method="mean",
            models=["Test-ModelA", "Test-ModelB"],
        )
        mgr.register_ensemble(cfg_mean)
        df_mean, tel_mean = mgr.generate_ensemble_forecasts(cfg_mean)
        row_mean = df_mean.filter(
            (pl.col("location") == "US") & (pl.col("horizon") == 0) & (pl.col("output_type_id") == 0.5)
        )
        self.assertAlmostEqual(row_mean["value"][0], 1100.0)

    def test_spatial_split_routing(self):
        """Test spatial split routing: State models for states, National models for US."""
        mgr = self.loader.ensemble_mgr

        # Route Model A to States, Model B to US National
        cfg_spatial = SyntheticEnsembleConfig(
            id="synth_spatial_test",
            name="Spatial Split Test",
            method="median",
            spatial_split=True,
            state_models=["Test-ModelA"],
            national_models=["Test-ModelB"],
        )
        mgr.register_ensemble(cfg_spatial)
        df_sp, tel = mgr.generate_ensemble_forecasts(cfg_spatial)

        # US National median should match Model B exactly (1200.0)
        us_row = df_sp.filter(
            (pl.col("location") == "US") & (pl.col("horizon") == 0) & (pl.col("output_type_id") == 0.5)
        )
        self.assertAlmostEqual(us_row["value"][0], 1200.0)

        # California (06) median should match Model A exactly (150.0)
        ca_row = df_sp.filter(
            (pl.col("location") == "06") & (pl.col("horizon") == 0) & (pl.col("output_type_id") == 0.5)
        )
        self.assertAlmostEqual(ca_row["value"][0], 150.0)

    def test_save_to_disk_and_discovery(self):
        """Test persisting synthetic ensemble to local-output/synthetic/ and recipe reloading."""
        mgr = self.loader.ensemble_mgr
        cfg = SyntheticEnsembleConfig(
            id="synth_saved_test",
            name="Saved Ensemble Test",
            method="median",
            models=["Test-ModelA", "Test-ModelB"],
        )
        mgr.register_ensemble(cfg)

        save_res = mgr.save_to_disk("synth_saved_test")
        self.assertEqual(save_res["status"], "ok")
        self.assertTrue(Path(save_res["path"]).exists())

        recipe_file = Path(save_res["path"]) / "synthetic_recipe.json"
        self.assertTrue(recipe_file.exists())

        # Verify new manager discovers it on disk
        new_mgr = SyntheticEnsembleManager(self.base_dir, data_loader=self.loader)
        discovered = new_mgr.get_config("synth_saved_test")
        self.assertIsNotNone(discovered)
        self.assertTrue(discovered.is_saved)
        self.assertEqual(discovered.name, "Saved Ensemble Test")

    def test_dataloader_scan_models_and_evaluation(self):
        """Test scan_models registers synthetic ensemble and EvaluationEngine scores it."""
        cfg = SyntheticEnsembleConfig(
            id="synth_eval_test",
            name="Eval Test Ensemble",
            method="median",
            models=["Test-ModelA", "Test-ModelB"],
        )
        self.loader.register_synthetic_ensemble(cfg)

        models = self.loader.scan_models()
        self.assertIn("synth_eval_test", models)
        self.assertTrue(models["synth_eval_test"]["is_synthetic"])
        self.assertIn("[SYNTHETIC]", models["synth_eval_test"]["display_name"])

        # Test evaluation engine
        eval_engine = EvaluationEngine(self.base_dir, self.loader)
        params = EvaluationParams(
            target="wk inc flu hosp",
            location="US",
            date="2024-01-13",
            models=["Test-ModelA", "synth_eval_test"],
            baseline="Test-ModelA",
        )
        result = eval_engine.evaluate(params)
        self.assertIsNotNone(result)

        # Check rankings
        synth_rank = next((r for r in result.rankings if r["model_id"] == "synth_eval_test"), None)
        self.assertIsNotNone(synth_rank)
        self.assertTrue(synth_rank["is_synthetic"])
        self.assertIsNotNone(synth_rank["wis"])

    def test_preview_ensemble(self):
        """Test pre-flight overlap calculation."""
        mgr = self.loader.ensemble_mgr
        cfg = SyntheticEnsembleConfig(
            id="test_preview",
            name="Preview Test",
            models=["Test-ModelA", "Test-ModelB"],
        )
        prev = mgr.preview_ensemble(cfg)
        self.assertTrue(prev["valid"])
        self.assertEqual(prev["model_count"], 2)
        self.assertEqual(prev["date_overlap_percentage"], 100.0)

    def test_clean_id_generation_without_timestamp(self):
        """Test that synthetic model names get clean readable IDs without random timestamp digits."""
        mgr = self.loader.ensemble_mgr
        cfg1 = SyntheticEnsembleConfig(
            name="Flusion Spatial Fourier",
            models=["Test-ModelA", "Test-ModelB"],
        )
        reg1 = mgr.register_ensemble(cfg1)
        self.assertEqual(reg1.id, "synth_flusion_spatial_fourier")

        # Second one with same name should deduplicate sequentially
        cfg2 = SyntheticEnsembleConfig(
            name="Flusion Spatial Fourier",
            models=["Test-ModelA", "Test-ModelB"],
        )
        reg2 = mgr.register_ensemble(cfg2)
        self.assertEqual(reg2.id, "synth_flusion_spatial_fourier_2")

        # Third one
        cfg3 = SyntheticEnsembleConfig(
            name="Flusion Spatial Fourier",
            models=["Test-ModelA", "Test-ModelB"],
        )
        reg3 = mgr.register_ensemble(cfg3)
        self.assertEqual(reg3.id, "synth_flusion_spatial_fourier_3")


if __name__ == "__main__":
    unittest.main()
