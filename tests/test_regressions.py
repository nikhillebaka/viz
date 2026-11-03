"""
Self-contained regression tests built on a tiny synthetic hub (no repository data).
Covers scoring edge cases, synthetic ensemble safety and caching, heatmap metric
parity with the leaderboard, task-export scope, and evaluation cache invalidation.
"""

from pathlib import Path
import shutil
import tempfile
import unittest

import polars as pl

from viz.core.data_loader import SandboxDataLoader
from viz.core.evaluation import EvaluationEngine, EvaluationParams
from viz.core.metrics import compute_pairwise_relative_wis, score_forecasts
from viz.core.synthetic_ensemble import SyntheticEnsembleConfig

TARGET = "wk inc flu hosp"
ED_TARGET = "wk inc flu prop ed visits"
REF_DATE = "2024-01-13"
QUANTILES = [0.025, 0.25, 0.5, 0.75, 0.975]
TRUTH = {"US": 3000.0, "01": 100.0, "02": 40.0}
POPULATION = {"US": 330_000_000, "01": 5_000_000, "02": 700_000}


def forecast_rows(scale: float, target: str = TARGET, locations=("US", "01", "02"), quantiles=QUANTILES):
    """Quantile rows centred on truth x scale, for horizons 0 and 1."""
    rows = []
    for loc in locations:
        for h, ted in ((0, "2024-01-13"), (1, "2024-01-20")):
            center = TRUTH[loc] * scale if target == TARGET else 0.02 * scale
            for q in quantiles:
                rows.append({
                    "location": loc,
                    "horizon": h,
                    "target_end_date": ted,
                    "reference_date": REF_DATE,
                    "target": target,
                    "output_type": "quantile",
                    "output_type_id": q,
                    "value": center * (0.6 + 0.8 * q),
                })
    return pl.DataFrame(rows)


class TestRegressions(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        (self.base / "auxiliary-data").mkdir()
        (self.base / "target-data").mkdir()
        pl.DataFrame({
            "abbreviation": ["US", "AL", "AK"],
            "location": ["US", "01", "02"],
            "location_name": ["US", "Alabama", "Alaska"],
            "population": [POPULATION["US"], POPULATION["01"], POPULATION["02"]],
        }).write_csv(self.base / "auxiliary-data" / "locations.csv")

        oracle_rows = []
        for loc, val in TRUTH.items():
            for ted in ("2024-01-13", "2024-01-20"):
                oracle_rows.append({"as_of": "2024-06-01", "target": TARGET, "target_end_date": ted,
                                    "location": loc, "output_type": "quantile", "oracle_value": val})
                oracle_rows.append({"as_of": "2024-06-01", "target": ED_TARGET, "target_end_date": ted,
                                    "location": loc, "output_type": "quantile", "oracle_value": 0.02})
        pl.DataFrame(oracle_rows).write_csv(self.base / "target-data" / "oracle-output.csv")

        self.write_model("FluSight-baseline", forecast_rows(1.6))
        self.write_model("Good-model", forecast_rows(1.05))
        self.write_model("Ok-model", forecast_rows(1.2))
        self.loader = SandboxDataLoader(self.base)
        self.engine = EvaluationEngine(self.base, self.loader)

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def write_model(self, model_id: str, df: pl.DataFrame, text_suffix: str = ""):
        model_dir = self.base / "model-output" / model_id
        model_dir.mkdir(parents=True, exist_ok=True)
        path = model_dir / f"{REF_DATE}-{model_id}.csv"
        df.write_csv(path)
        if text_suffix:
            with open(path, "a", encoding="utf-8") as f:
                f.write(text_suffix)

    # --- Scoring core -------------------------------------------------------

    def test_duplicate_quantile_rows_do_not_change_wis(self):
        df = forecast_rows(1.3)
        oracle = self.loader.get_oracle()
        clean = score_forecasts(df, oracle)["overall"]
        dup = score_forecasts(pl.concat([df, df.filter(pl.col("output_type_id") == 0.975)]), oracle)["overall"]
        self.assertAlmostEqual(clean["wis"], dup["wis"], places=9)
        decomp = dup["sharpness_component"] + dup["overprediction_penalty"] + dup["underprediction_penalty"]
        self.assertAlmostEqual(decomp, dup["wis"], places=9)

    def test_pairwise_relative_wis_never_mixes_scales(self):
        tasks = pl.DataFrame({"location": ["01"], "reference_date": [REF_DATE], "horizon": [1],
                              "wis": [10.0], "wis_log": [None]}, schema_overrides={"wis_log": pl.Float64})
        res = compute_pairwise_relative_wis({"A": tasks, "B": tasks}, "A", metric_col="wis_log")
        self.assertIsNone(res["B"]["relative_wis"])
        missing = compute_pairwise_relative_wis({"A": tasks.with_columns(pl.lit(1.0).alias("wis_log"))}, "Absent", "wis_log")
        self.assertIsNone(missing["A"]["relative_wis"])

    def test_tournament_uses_same_location_pool_as_wis(self):
        all_locs = self.engine.evaluate(EvaluationParams(location="all", date=REF_DATE))
        states = self.engine.evaluate(EvaluationParams(location="states", date=REF_DATE))
        rel_all = {r["model_id"]: r["relative_wis"] for r in all_locs.rankings}
        rel_states = {r["model_id"]: r["relative_wis"] for r in states.rankings}
        self.assertEqual(rel_all, rel_states)
        self.assertEqual([r["model_id"] for r in all_locs.rankings][0], "Good-model")

    def test_missing_baseline_falls_back_with_warning(self):
        shutil.rmtree(self.base / "model-output" / "FluSight-baseline")
        res = EvaluationEngine(self.base, SandboxDataLoader(self.base)).evaluate(
            EvaluationParams(models=["Good-model", "Ok-model"], location="states", date=REF_DATE))
        self.assertIn(res.baseline_model, ("Good-model", "Ok-model"))
        self.assertTrue(any("scaled to" in w for w in res.validation_warnings))

    def test_rate_targets_have_no_per_100k_wis(self):
        self.write_model("Ed-model", forecast_rows(1.1, target=ED_TARGET))
        res = self.engine.evaluate(EvaluationParams(models=["Ed-model"], target=ED_TARGET, location="states", date=REF_DATE))
        self.assertIsNone(res.rankings[0]["wis_per_100k"])
        self.assertIsNotNone(res.rankings[0]["wis_log"])

    def test_task_export_matches_leaderboard_scope(self):
        params = EvaluationParams(models=["Good-model", "Ok-model"], location="US", date=REF_DATE, fair=True)
        res = self.engine.evaluate(params)
        export = self.engine.get_task_scores_dataframe(params)
        self.assertEqual(export["location"].unique().to_list(), ["US"])
        self.assertEqual(export.height, sum(r["count"] for r in res.rankings))

    def test_eval_cache_sees_newly_added_models(self):
        before = self.engine.evaluate(EvaluationParams(location="states", date=REF_DATE))
        self.write_model("New-model", forecast_rows(1.1))
        after = self.engine.evaluate(EvaluationParams(location="states", date=REF_DATE))
        self.assertNotIn("New-model", [r["model_id"] for r in before.rankings])
        self.assertIn("New-model", [r["model_id"] for r in after.rankings])

    def test_pmf_rows_do_not_drop_forecast_file(self):
        self.write_model("Pmf-model", forecast_rows(1.1),
                         text_suffix=f"01,1,2024-01-20,{REF_DATE},wk flu hosp rate change,pmf,large_increase,0.1\n")
        df = self.loader.load_combined_forecasts("Pmf-model")
        self.assertIsNotNone(df)
        self.assertEqual(df["output_type"].unique().to_list(), ["quantile"])
        self.assertEqual(self.loader.get_validation_warnings(["Pmf-model"]), [])

    # --- Heatmap parity -----------------------------------------------------

    def test_heatmap_wis_matches_leaderboard_wis(self):
        task_df = score_forecasts(forecast_rows(1.2), self.loader.get_oracle(), return_task_df=True)["task_df"]
        true_wis = {(r["location"], r["horizon"]): r["wis"] for r in task_df.iter_rows(named=True)}
        hm = self.loader.get_heatmap_data(mode="horizon", metric="wis", reference_date=REF_DATE,
                                          model_id="Ok-model", location="states")
        fips = {"AL": "01", "AK": "02"}
        for i, abbr in enumerate(hm["y_keys"]):
            for j, h in enumerate(hm["x_keys"]):
                if hm["raw_matrix"][i][j] is not None:
                    self.assertAlmostEqual(hm["raw_matrix"][i][j], true_wis[(fips[abbr], int(h))], places=6)

    def test_heatmap_model_axis_metrics_are_all_available(self):
        for mode in ("model_loc", "model_h", "model_date"):
            values = {}
            for metric in ("wis", "wis_rate", "sharpness"):
                hm = self.loader.get_heatmap_data(mode=mode, metric=metric, reference_date=REF_DATE,
                                                  model_ids=["Ok-model"], location="states")
                self.assertEqual(hm["y_keys"], ["Ok-model"], f"{mode}/{metric}")
                values[metric] = hm["raw_matrix"][0]
            # Each metric is its own quantity, never a silent fallback to WIS
            self.assertNotEqual(values["wis"], values["wis_rate"], mode)
            self.assertNotEqual(values["wis"], values["sharpness"], mode)
        # States-only scope never pools the national forecast
        h_states = self.loader.get_heatmap_data(mode="model_h", metric="wis", reference_date=REF_DATE,
                                                model_ids=["Ok-model"], location="states")
        loc_states = self.loader.get_heatmap_data(mode="model_loc", metric="wis", reference_date=REF_DATE,
                                                  model_ids=["Ok-model"], location="states")
        mean_h = sum(h_states["raw_matrix"][0][:2]) / 2
        mean_loc = sum(loc_states["raw_matrix"][0]) / 2
        self.assertAlmostEqual(mean_h, mean_loc, places=1)

    # --- Synthetic ensembles ------------------------------------------------

    def test_ensemble_ids_cannot_escape_synthetic_dir(self):
        with self.assertRaises(ValueError):
            self.loader.register_synthetic_ensemble(
                SyntheticEnsembleConfig(id="../../model-output/Good-model", name="x", models=["Good-model", "Ok-model"]))
        self.assertTrue((self.base / "model-output" / "Good-model").exists())

    def test_recreated_ensemble_does_not_serve_stale_forecasts(self):
        def median_at_01(ens_id):
            df = self.loader.load_combined_forecasts(ens_id)
            return df.filter((pl.col("location") == "01") & (pl.col("horizon") == 1)
                             & (pl.col("output_type_id") == 0.5))["value"][0]

        first = self.loader.register_synthetic_ensemble(
            SyntheticEnsembleConfig(name="ens", models=["Good-model", "FluSight-baseline"], method="mean"))
        v1 = median_at_01(first.id)
        self.loader.remove_synthetic_ensemble(first.id)
        second = self.loader.register_synthetic_ensemble(
            SyntheticEnsembleConfig(name="ens", models=["Good-model", "Ok-model"], method="mean"))
        self.assertEqual(first.id, second.id)
        self.assertNotAlmostEqual(v1, median_at_01(second.id))

    def test_flexible_ensemble_pools_consistent_members_per_task(self):
        self.write_model("Three-q", forecast_rows(1.1, quantiles=[0.25, 0.5, 0.75]))
        cfg = self.loader.register_synthetic_ensemble(
            SyntheticEnsembleConfig(name="mix", models=["Good-model", "Three-q"]))
        df, telemetry = self.loader.ensemble_mgr.generate_ensemble_forecasts(cfg)
        self.assertEqual(sorted(df["output_type_id"].unique().to_list()), [0.25, 0.5, 0.75])
        self.assertEqual(telemetry["partial_coverage_tasks"], 0)


if __name__ == "__main__":
    unittest.main()
