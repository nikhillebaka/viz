"""
Unit tests for the EvaluationEngine.
Tests scope resolution, model loading, common task intersection,
custom baseline override, and output parity.
"""

import unittest
from pathlib import Path
from viz.evaluation import EvaluationEngine, EvaluationParams

BASE_DIR = Path(__file__).resolve().parent.parent.parent


class TestEvaluation(unittest.TestCase):
    def setUp(self):
        self.engine = EvaluationEngine(BASE_DIR)

    def test_single_date_evaluation(self):
        params = EvaluationParams(
            models=["UMass-flusion_spatial2_prod", "UMass-AR6_pooled"],
            date="2024-01-13",
            location="states",
            fair=False,
        )
        res = self.engine.evaluate(params)
        self.assertEqual(res.target, "wk inc flu hosp")
        self.assertEqual(res.location_filter, "states")
        self.assertEqual(len(res.rankings), 2)

        flusion = next(r for r in res.rankings if r["model_id"] == "UMass-flusion_spatial2_prod")
        self.assertTrue(flusion["has_data_in_scope"])
        self.assertAlmostEqual(flusion["wis"], 31.70, places=1)
        self.assertAlmostEqual(flusion["mae"], 44.23, places=1)

    def test_fair_intersection_mode(self):
        params = EvaluationParams(
            models=["UMass-flusion_spatial2_prod", "UMass-AR6_pooled"],
            date="2024-01-13",
            location="states",
            fair=True,
        )
        res = self.engine.evaluate(params)
        self.assertTrue(res.fair_intersection)
        self.assertEqual(res.common_task_status, "ok")
        self.assertEqual(res.common_tasks_count, 208)

    def test_custom_baseline_override(self):
        params = EvaluationParams(
            models=["UMass-AR6_pooled"],
            date="2024-01-13",
            location="states",
            baseline="UMass-flusion_spatial2_prod",
            fair=False,
        )
        res = self.engine.evaluate(params)
        self.assertEqual(res.baseline_model, "UMass-flusion_spatial2_prod")
        ar6 = res.rankings[0]
        self.assertEqual(ar6["model_id"], "UMass-AR6_pooled")
        self.assertIsNotNone(ar6["pct_diff_vs_baseline"])
        # AR6 WIS (59.76) vs flusion (31.70) -> ((59.76 - 31.70) / 31.70) * 100 ~ +88.5%
        self.assertGreater(ar6["pct_diff_vs_baseline"], 0)
        self.assertEqual(ar6["benchmark_pool"], "states")

    def test_no_baseline_graceful_handling(self):
        """When no baseline exists or is requested, rankings render without relative delta errors."""
        params = EvaluationParams(
            models=["UMass-AR6_pooled"],
            date="2024-01-13",
            location="states",
            baseline="non-existent-baseline-model",
            fair=False,
        )
        res = self.engine.evaluate(params)
        # Should fall back to FluSight-baseline if available, or None
        self.assertIsNotNone(res.rankings)
        self.assertEqual(len(res.rankings), 1)

    def test_evaluation_caching(self):
        """Repeated evaluation with identical parameters hits memory cache instantly."""
        params = EvaluationParams(
            models=["UMass-flusion_spatial2_prod"],
            date="2024-01-13",
            location="states",
            fair=False,
        )
        res1 = self.engine.evaluate(params)
        res2 = self.engine.evaluate(params)
        self.assertIs(res1, res2)  # Identical cached object reference

    def test_pairwise_tournament_relative_wis_integration(self):
        """Verify that pairwise tournament relative WIS and rate WIS are computed in evaluation."""
        params = EvaluationParams(
            models=["UMass-flusion_spatial2_prod", "UMass-AR6_pooled"],
            date="2024-01-13",
            location="states",
            baseline="FluSight-baseline",
            fair=False,
        )
        res = self.engine.evaluate(params)
        self.assertEqual(len(res.rankings), 2)
        flusion = next(r for r in res.rankings if r["model_id"] == "UMass-flusion_spatial2_prod")
        self.assertIn("relative_wis", flusion)
        self.assertIn("wis_per_100k", flusion)
        self.assertIsNotNone(flusion["relative_wis"])
        self.assertIsNotNone(flusion["wis_per_100k"])
        # Flusion relative WIS < 1.0 vs baseline
        self.assertLess(flusion["relative_wis"], 1.0)
        # Population rate WIS is scaled per 100k
        self.assertGreater(flusion["wis_per_100k"], 0.0)

    def test_task_scores_dataframe_export(self):
        """Verify that get_task_scores_dataframe returns full disaggregated scores."""
        params = EvaluationParams(
            models=["UMass-flusion_spatial2_prod"],
            date="2024-01-13",
            location="states",
            fair=False,
        )
        task_df = self.engine.get_task_scores_dataframe(params)
        self.assertIsNotNone(task_df)
        self.assertFalse(task_df.is_empty())
        self.assertIn("model_id", task_df.columns)
        self.assertIn("wis", task_df.columns)
        self.assertIn("location", task_df.columns)
        self.assertIn("target_end_date", task_df.columns)
        self.assertIn("horizon", task_df.columns)
        self.assertIn("wis_per_100k", task_df.columns)

    def test_log_scale_evaluation_metrics(self):
        """Verify that EvaluationEngine computes log WIS, log MAE, log relative WIS, and log baseline delta."""
        params = EvaluationParams(
            models=["UMass-flusion_spatial2_prod", "UMass-AR6_pooled"],
            date="2024-01-13",
            location="states",
            baseline="FluSight-baseline",
            fair=False,
        )
        res = self.engine.evaluate(params)
        self.assertEqual(len(res.rankings), 2)
        flusion = next(r for r in res.rankings if r["model_id"] == "UMass-flusion_spatial2_prod")
        self.assertIn("wis_log", flusion)
        self.assertIn("mae_log", flusion)
        self.assertIn("relative_wis_log", flusion)
        self.assertIn("pct_diff_vs_baseline_log", flusion)
        self.assertIsNotNone(flusion["wis_log"])
        self.assertIsNotNone(flusion["mae_log"])
        self.assertIsNotNone(flusion["relative_wis_log"])
        self.assertGreater(flusion["wis_log"], 0.0)
        self.assertGreater(flusion["mae_log"], 0.0)
        # Log WIS should be substantially lower than natural WIS
        self.assertLess(flusion["wis_log"], flusion["wis"])
        # Relative WIS on log scale vs baseline
        self.assertLess(flusion["relative_wis_log"], 1.0)


if __name__ == "__main__":
    unittest.main()

