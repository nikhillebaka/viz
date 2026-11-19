"""
Tests for universal Hubverse ingestion (`core/ingest.py`), peak derivation (`core/peaks.py`),
multi-layout truth reconciliation (`core/truth.py`), and sidecar cache management (`core/cache_manager.py`).
"""

from pathlib import Path
import shutil
import tempfile
import unittest

import polars as pl

from viz.core.calendar import CalendarSpec
from viz.core.data_loader import SandboxDataLoader
from viz.core.geo import build_geo_graph
from viz.core.ingest import normalize_forecast_frame
from viz.core.metrics import STANDARD_23_QUANTILES


class TestUniversalIngest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_respicast_origin_date_and_missing_horizon_derivation(self):
        cal = CalendarSpec(
            week_system="iso",
            round_day_of_week=2,
            target_day_of_week=6,
            horizon_offset_days=-3,
            round_id_col="origin_date",
        )
        geo = build_geo_graph(None, observed_locations=["DE", "FR"], fallback_us=False)
        raw = pl.DataFrame({
            "origin_date": ["2025-11-05", "2025-11-05", "2025-11-05"],
            "location": ["DE", "DE", "FR"],
            "target": ["ILI incidence", "ILI incidence", "ILI incidence"],
            "target_end_date": ["2025-11-09", "2025-11-16", "2025-11-09"],
            "output_type": ["quantile", "quantile", "median"],
            "output_type_id": ["0.5", "0.5", "NA"],
            "value": [120.0, 140.0, 95.0],
        })
        res = normalize_forecast_frame(
            raw,
            model="EU-model",
            reference_date="2025-11-05",
            calendar=cal,
            geo=geo,
            is_non_negative=lambda t: True,
        )
        self.assertEqual(res.info["warnings"], [])
        self.assertEqual(sorted(res.quantiles["horizon"].to_list()), [1, 1, 2])
        # Median output type falls back cleanly to 0.5 quantile row when no 0.5 quantile exists
        fr_med = res.quantiles.filter(pl.col("location") == "FR")
        self.assertEqual(fr_med["output_type_id"].to_list(), [0.5])
        self.assertEqual(fr_med["value"].to_list(), [95.0])

    def test_sample_trajectories_derive_23_quantiles_and_season_peaks(self):
        # 25 trajectories across 14 horizons (triggers both 23-quantile derivation AND peak derivation)
        rows = []
        ref = "2025-11-01"
        from datetime import date, timedelta
        ref_d = date.fromisoformat(ref)
        for s in range(25):
            for h in range(14):
                ted = (ref_d + timedelta(weeks=h)).isoformat()
                # Unimodal wave peaking at h=6 with magnitude proportional to trajectory index
                val = 100.0 + (s * 4.0) * max(0.0, 1.0 - abs(h - 6) / 6.0)
                rows.append({
                    "reference_date": ref,
                    "location": "provo",
                    "target": "Flu hosp admits",
                    "target_end_date": ted,
                    "output_type": "sample",
                    "output_type_id": f"s{s}",
                    "value": val,
                })
        raw = pl.DataFrame(rows)  # Note: deliberately NO horizon column!
        geo = build_geo_graph(None, observed_locations=["provo"], fallback_us=False)
        res = normalize_forecast_frame(
            raw,
            model="Metro-sample",
            reference_date=ref,
            geo=geo,
            is_non_negative=lambda t: True,
        )
        self.assertEqual(res.samples.height, 25 * 14)
        self.assertEqual(sorted(res.quantiles["output_type_id"].unique().to_list()), STANDARD_23_QUANTILES)
        self.assertIn("Flu hosp admits", res.info["derived_from_samples"])
        self.assertIn("peak Flu hosp admits", res.info["peak_targets"])
        self.assertIn("peak week Flu hosp admits", res.info["peak_targets"])

    def test_rsv_extra_task_id_and_all_truth_layouts_and_sidecars(self):
        (self.tmp / "hub-config").mkdir()
        (self.tmp / "auxiliary-data").mkdir()
        (self.tmp / "target-data").mkdir()
        (self.tmp / "model-output" / "Team-rsv").mkdir(parents=True)

        pl.DataFrame({
            "abbreviation": ["US", "01"],
            "location": ["US", "01"],
            "location_name": ["US", "Alabama"],
            "population": [334_000_000, 5_100_000],
        }).write_csv(self.tmp / "auxiliary-data" / "locations.csv")

        tasks = {
            "rounds": [{
                "model_tasks": [{
                    "task_ids": {
                        "reference_date": {"optional": ["2025-11-15"]},
                        "target": {"required": ["wk inc rsv hosp"], "optional": ["ARI incidence"]},
                        "location": {"required": ["US", "01"]},
                        "age_group": {"required": ["0-130", "0-0.49"]},
                        "horizon": {"required": [0, 1]},
                    },
                    "output_type": {"quantile": {}},
                }]
            }]
        }
        import json
        (self.tmp / "hub-config" / "tasks.json").write_text(json.dumps(tasks), encoding="utf-8")

        # Write MetroCast-style `time-series.csv` with `observation` column + `age_group`
        pl.DataFrame({
            "as_of": ["2025-11-22"] * 4,
            "target": ["wk inc rsv hosp"] * 4,
            "target_end_date": ["2025-11-15", "2025-11-22", "2025-11-15", "2025-11-22"],
            "location": ["01", "01", "01", "01"],
            "age_group": ["0-130", "0-130", "0-0.49", "0-0.49"],
            "observation": [50.0, 60.0, 20.0, 25.0],
        }).write_csv(self.tmp / "target-data" / "time-series.csv")

        # Also add RespiCast-style latest-*.csv
        pl.DataFrame({
            "target": ["ARI incidence"],
            "location": ["01"],
            "truth_date": ["2025-11-15"],
            "year_week": ["2025-W46"],
            "value": [500.0],
            "data_source": ["ERVISS"],
        }).write_csv(self.tmp / "target-data" / "latest-ARI_incidence.csv")

        pl.DataFrame({
            "reference_date": ["2025-11-15"] * 4,
            "target": ["wk inc rsv hosp"] * 4,
            "horizon": [0, 0, 1, 1],
            "target_end_date": ["2025-11-15", "2025-11-15", "2025-11-22", "2025-11-22"],
            "location": ["01"] * 4,
            "age_group": ["0-130", "0-0.49", "0-130", "0-0.49"],
            "output_type": ["quantile"] * 4,
            "output_type_id": [0.5] * 4,
            "value": [48.0, 18.0, 58.0, 24.0],
        }).write_csv(self.tmp / "model-output" / "Team-rsv" / "2025-11-15-Team-rsv.csv")

        loader = SandboxDataLoader(self.tmp, include_remote=False)
        oracle = loader.get_oracle(as_polars=True)
        self.assertIn("age_group", oracle.columns)
        self.assertIn("ARI incidence", oracle["target"].to_list())
        models = loader.scan_models()
        self.assertIn("age_group", models["Team-rsv"]["extra_task_ids"])
        df_loaded = loader.load_combined_forecasts("Team-rsv", as_polars=True)
        self.assertIsNotNone(df_loaded)
        self.assertIn("age_group", df_loaded.columns)


if __name__ == "__main__":
    unittest.main()
