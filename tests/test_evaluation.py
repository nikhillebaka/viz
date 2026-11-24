"""
Unit tests for the EvaluationEngine.
Tests scope resolution, model loading, fair task intersection, custom baseline
override, caching, pairwise relative WIS, task export, and log-scale scoring.
"""

from pathlib import Path
import shutil
import sys
import tempfile
import unittest

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from conftest import SYNTH_TARGET, build_synthetic_hub  # noqa: E402
from viz.core.data_loader import SandboxDataLoader  # noqa: E402
from viz.core.evaluation import EvaluationEngine, EvaluationParams  # noqa: E402


class TestEvaluation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = Path(tempfile.mkdtemp(prefix="viz-eval-test-")).resolve()
        cls.hub_dir = build_synthetic_hub(cls._tmp / "hub")
        cls.loader = SandboxDataLoader(
            cls.hub_dir,
            include_remote=False,
            cache_dir=cls._tmp / "cache",
            surveillance_dir=cls._tmp / "surv",
        )
        cls.engine = EvaluationEngine(cls.hub_dir, cls.loader)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def test_single_date_evaluation(self):
        params = EvaluationParams(
            models=["Model-Alpha", "Model-Beta"],
            date="2024-01-13",
            location="states",
            fair=False,
        )
        res = self.engine.evaluate(params)
        self.assertEqual(res.target, SYNTH_TARGET)
        self.assertEqual(res.location_filter, "states")
        self.assertEqual(len(res.rankings), 2)

        alpha = next(r for r in res.rankings if r["model_id"] == "Model-Alpha")
        beta = next(r for r in res.rankings if r["model_id"] == "Model-Beta")
        self.assertTrue(alpha["has_data_in_scope"])
        self.assertTrue(beta["has_data_in_scope"])
        self.assertEqual(alpha["count"], 24)  # 6 states * 4 horizons
        self.assertEqual(beta["count"], 20)   # 5 states (WA omitted on 2024-01-13) * 4 horizons
        self.assertLess(alpha["wis"], beta["wis"])
        self.assertLess(alpha["mae"], beta["mae"])

    def test_fair_intersection_mode(self):
        params = EvaluationParams(
            models=["Model-Alpha", "Model-Beta"],
            date="2024-01-13",
            location="states",
            fair=True,
        )
        res = self.engine.evaluate(params)
        self.assertTrue(res.fair_intersection)
        self.assertEqual(res.common_task_status, "ok")
        self.assertEqual(res.common_tasks_count, 20)
        for row in res.rankings:
            self.assertEqual(row["count"], 20)

    def test_custom_baseline_override(self):
        params = EvaluationParams(
            models=["Model-Beta"],
            date="2024-01-13",
            location="states",
            baseline="Model-Alpha",
            fair=False,
        )
        res = self.engine.evaluate(params)
        self.assertEqual(res.baseline_model, "Model-Alpha")
        beta = res.rankings[0]
        self.assertEqual(beta["model_id"], "Model-Beta")
        self.assertIsNotNone(beta["pct_diff_vs_baseline"])
        self.assertGreater(beta["pct_diff_vs_baseline"], 0)
        self.assertEqual(beta["benchmark_pool"], "states")

    def test_no_baseline_graceful_handling(self):
        """Unknown baseline falls back cleanly without failing evaluation."""
        params = EvaluationParams(
            models=["Model-Alpha"],
            date="2024-01-13",
            location="states",
            baseline="non-existent-baseline-model",
            fair=False,
        )
        res = self.engine.evaluate(params)
        self.assertIsNotNone(res.rankings)
        self.assertEqual(len(res.rankings), 1)
        self.assertEqual(res.baseline_model, "FluSight-baseline")

    def test_evaluation_caching(self):
        """Repeated evaluation with identical parameters returns the cached result object."""
        params = EvaluationParams(
            models=["Model-Alpha"],
            date="2024-01-13",
            location="states",
            fair=False,
        )
        res1 = self.engine.evaluate(params)
        res2 = self.engine.evaluate(params)
        self.assertIs(res1, res2)

    def test_pairwise_tournament_relative_wis_integration(self):
        """Verify pairwise tournament relative WIS and rate WIS are computed vs baseline."""
        params = EvaluationParams(
            models=["Model-Alpha", "Model-Beta"],
            date="2024-01-13",
            location="states",
            baseline="FluSight-baseline",
            fair=False,
        )
        res = self.engine.evaluate(params)
        self.assertEqual(len(res.rankings), 2)
        alpha = next(r for r in res.rankings if r["model_id"] == "Model-Alpha")
        self.assertIsNotNone(alpha["relative_wis"])
        self.assertIsNotNone(alpha["wis_per_100k"])
        self.assertLess(alpha["relative_wis"], 1.0)
        self.assertGreater(alpha["wis_per_100k"], 0.0)

    def test_task_scores_dataframe_export(self):
        """Verify get_task_scores_dataframe returns disaggregated task-level scores."""
        params = EvaluationParams(
            models=["Model-Alpha"],
            date="2024-01-13",
            location="states",
            fair=False,
        )
        task_df = self.engine.get_task_scores_dataframe(params)
        self.assertIsNotNone(task_df)
        self.assertFalse(task_df.is_empty())
        for col in ("model_id", "wis", "location", "target_end_date", "horizon", "wis_per_100k"):
            self.assertIn(col, task_df.columns)

    def test_log_scale_evaluation_metrics(self):
        """Verify log WIS, log MAE, log relative WIS, and log baseline delta."""
        params = EvaluationParams(
            models=["Model-Alpha", "Model-Beta"],
            date="2024-01-13",
            location="states",
            baseline="FluSight-baseline",
            fair=False,
        )
        res = self.engine.evaluate(params)
        alpha = next(r for r in res.rankings if r["model_id"] == "Model-Alpha")
        for key in ("wis_log", "mae_log", "relative_wis_log", "pct_diff_vs_baseline_log"):
            self.assertIn(key, alpha)
            self.assertIsNotNone(alpha[key])
        self.assertGreater(alpha["wis_log"], 0.0)
        self.assertGreater(alpha["mae_log"], 0.0)
        self.assertLess(alpha["wis_log"], alpha["wis"])
        self.assertLess(alpha["relative_wis_log"], 1.0)


if __name__ == "__main__":
    unittest.main()
