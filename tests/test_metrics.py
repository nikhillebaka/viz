"""
Tests for scoring engine and interval evaluation metrics.
Covers pinball loss, WIS calculation, Bracher et al. decomposition equality,
empirical coverage, common task intersections, and generalized oracle schemas.
"""

import unittest
import polars as pl
import numpy as np

from viz.core.metrics import (
    compute_pinball_loss,
    score_forecasts,
    find_common_tasks,
    STANDARD_23_QUANTILES,
    STANDARD_7_QUANTILES,
)


class TestMetrics(unittest.TestCase):
    def test_pinball_loss_analytical(self):
        """Verify pinball loss matches exact analytical formula: 2 * (I(y < q) - alpha) * (q - y)."""
        # Overprediction: y=10, q=15, alpha=0.5
        loss_over = compute_pinball_loss(10.0, 15.0, 0.5)
        self.assertAlmostEqual(loss_over, 5.0)

        # Underprediction: y=10, q=6, alpha=0.5
        loss_under = compute_pinball_loss(10.0, 6.0, 0.5)
        self.assertAlmostEqual(loss_under, 4.0)

        # Extreme quantile: y=10, q=15, alpha=0.975 -> 2 * (1.0 - 0.975) * 5 = 2 * 0.025 * 5 = 0.25
        loss_q975 = compute_pinball_loss(10.0, 15.0, 0.975)
        self.assertAlmostEqual(loss_q975, 0.25)

    def test_wis_and_exact_decomposition(self):
        """
        Verify that score_forecasts calculates WIS correctly and satisfies:
        Sharpness + Overprediction Penalty + Underprediction Penalty == WIS
        """
        # Create a synthetic forecast for 1 task with 23 quantiles
        rows = []
        target_val = 100.0
        # Quantiles spaced symmetrically around median 105 (slight overprediction)
        for q in STANDARD_23_QUANTILES:
            z = (q - 0.5) * 40.0
            pred_val = 105.0 + z
            rows.append({
                "reference_date": "2025-01-11",
                "target_end_date": "2025-01-18",
                "location": "US",
                "target": "wk inc flu hosp",
                "horizon": 1,
                "output_type": "quantile",
                "output_type_id": q,
                "value": pred_val,
            })
        forecast_df = pl.DataFrame(rows)

        oracle_df = pl.DataFrame([{
            "target": "wk inc flu hosp",
            "target_end_date": "2025-01-18",
            "location": "US",
            "horizon": 1,
            "oracle_value": target_val,
        }])

        res = score_forecasts(forecast_df, oracle_df, target="wk inc flu hosp")
        self.assertTrue(bool(res))
        ov = res["overall"]

        wis = ov["wis"]
        sharpness_comp = ov["sharpness_component"]
        over_comp = ov["overprediction_penalty"]
        under_comp = ov["underprediction_penalty"]

        self.assertIsNotNone(wis)
        self.assertIsNotNone(sharpness_comp)
        self.assertIsNotNone(over_comp)
        self.assertIsNotNone(under_comp)

        # Exact decomposition check
        decomp_sum = sharpness_comp + over_comp + under_comp
        self.assertAlmostEqual(decomp_sum, wis, places=4)

        # MAE check: |105 - 100| = 5.0
        self.assertAlmostEqual(ov["mae"], 5.0, places=4)

    def test_oracle_without_horizon_column(self):
        """
        Verify that hubverse oracles lacking a 'horizon' column join cleanly on
        (target_end_date, location) across multiple horizons.
        """
        rows = []
        for h in [0, 1, 2]:
            for q in STANDARD_7_QUANTILES:
                rows.append({
                    "reference_date": "2025-01-11",
                    "target_end_date": f"2025-01-{11 + h * 7:02d}",
                    "location": "01",
                    "target": "wk inc flu hosp",
                    "horizon": h,
                    "output_type": "quantile",
                    "output_type_id": q,
                    "value": 50.0 + (q - 0.5) * 10.0,
                })
        forecast_df = pl.DataFrame(rows)

        # Oracle with NO horizon column
        oracle_df = pl.DataFrame([
            {"target": "wk inc flu hosp", "target_end_date": "2025-01-11", "location": "01", "oracle_value": 50.0},
            {"target": "wk inc flu hosp", "target_end_date": "2025-01-18", "location": "01", "oracle_value": 52.0},
            {"target": "wk inc flu hosp", "target_end_date": "2025-01-25", "location": "01", "oracle_value": 48.0},
        ])

        res = score_forecasts(forecast_df, oracle_df, target="wk inc flu hosp")
        self.assertTrue(bool(res))
        self.assertEqual(res["overall"]["count"], 3)  # all 3 horizons evaluated
        self.assertIn(0, res["by_horizon"])
        self.assertIn(1, res["by_horizon"])
        self.assertIn(2, res["by_horizon"])

    def test_find_common_tasks(self):
        """Verify fair intersection across models with overlapping and disjoint rounds."""
        def make_df(dates, locs, horizons):
            rows = []
            for d in dates:
                for loc in locs:
                    for h in horizons:
                        rows.append({
                            "reference_date": d,
                            "location": loc,
                            "horizon": h,
                            "target": "wk inc flu hosp",
                            "output_type": "quantile",
                            "output_type_id": 0.5,
                            "value": 10.0,
                        })
            return pl.DataFrame(rows)

        m1 = make_df(["2025-01-04", "2025-01-11"], ["US", "01"], [0, 1])
        m2 = make_df(["2025-01-11", "2025-01-18"], ["US", "01"], [0, 1])
        m3_disjoint = make_df(["2024-01-06"], ["US"], [0])

        # Overlapping intersection: 2025-01-11 for US and 01 with h in [0, 1] = 4 tasks
        common = find_common_tasks({"m1": m1, "m2": m2}, target="wk inc flu hosp")
        self.assertEqual(len(common), 4)

        # Disjoint intersection across all 3
        common_disjoint = find_common_tasks({"m1": m1, "m2": m2, "m3": m3_disjoint}, target="wk inc flu hosp")
        self.assertEqual(len(common_disjoint), 0)

    def test_wis_golden_analytical_verification(self):
        """
        Independent golden test: rigorously checks score_forecasts against hand-derived
        analytical values from Bracher et al. (2021) / scoringutils formula:
        y = 40.0, quantiles: [10.0, 20.0, 30.0, 38.0, 48.0, 55.0, 65.0]
        - MAE = |40 - 38| = 2.0
        - Sharpness = 65 - 10 = 55.0
        - Exact WIS = 20.75 / 7 = 2.964285714...
        - Sharpness component = 18.75 / 7 = 2.678571428...
        - Underprediction component = 2.0 / 7 = 0.285714285...
        - Overprediction component = 0.0
        - Coverage 95% = 100.0%, Coverage 50% = 100.0%
        """
        q_vals = [10.0, 20.0, 30.0, 38.0, 48.0, 55.0, 65.0]
        rows = []
        for q, val in zip(STANDARD_7_QUANTILES, q_vals):
            rows.append({
                "reference_date": "2025-01-11",
                "target_end_date": "2025-01-18",
                "location": "01",
                "target": "wk inc flu hosp",
                "horizon": 1,
                "output_type": "quantile",
                "output_type_id": q,
                "value": val,
            })
        forecast_df = pl.DataFrame(rows)
        oracle_df = pl.DataFrame([{
            "target": "wk inc flu hosp",
            "target_end_date": "2025-01-18",
            "location": "01",
            "horizon": 1,
            "oracle_value": 40.0,
        }])

        res = score_forecasts(forecast_df, oracle_df, target="wk inc flu hosp")
        self.assertTrue(bool(res))
        ov = res["overall"]

        expected_wis = 20.75 / 7.0
        expected_sharp = 18.75 / 7.0
        expected_under = 2.0 / 7.0
        expected_over = 0.0

        self.assertAlmostEqual(ov["mae"], 2.0, places=6)
        self.assertAlmostEqual(ov["sharpness"], 55.0, places=6)
        self.assertAlmostEqual(ov["wis"], expected_wis, places=6)
        self.assertAlmostEqual(ov["sharpness_component"], expected_sharp, places=6)
        self.assertAlmostEqual(ov["underprediction_penalty"], expected_under, places=6)
        self.assertAlmostEqual(ov["overprediction_penalty"], expected_over, places=6)
        self.assertAlmostEqual(ov["cov95"], 100.0, places=6)
        self.assertAlmostEqual(ov["cov50"], 100.0, places=6)

    def test_duplicate_quantile_robustness(self):
        """Verify that duplicate quantile rows in model submissions do not crash evaluation."""
        rows = []
        for q in STANDARD_7_QUANTILES:
            rows.append({
                "reference_date": "2025-01-11",
                "target_end_date": "2025-01-18",
                "location": "01",
                "target": "wk inc flu hosp",
                "horizon": 1,
                "output_type": "quantile",
                "output_type_id": q,
                "value": 100.0 + q * 10.0,
            })
        # Add an accidental duplicate row for quantile 0.50
        rows.append(dict(rows[3]))
        forecast_df = pl.DataFrame(rows)
        oracle_df = pl.DataFrame([{
            "target": "wk inc flu hosp",
            "target_end_date": "2025-01-18",
            "location": "01",
            "oracle_value": 105.0,
        }])

        # Should execute cleanly without DuplicateError
        res = score_forecasts(forecast_df, oracle_df, target="wk inc flu hosp")
        self.assertTrue(bool(res))
        self.assertIsNotNone(res["overall"]["wis"])

    def test_pairwise_tournament_relative_wis(self):
        """Verify pairwise tournament relative WIS calculation (Cramer et al. 2022)."""
        from viz.core.metrics import compute_pairwise_relative_wis

        # Create 3 models with known task WIS scores:
        # Task 1: m1=10, m2=20, base=20 -> m1 is 2x better than base and m2
        # Task 2: m1=15, m2=30, base=30
        task1 = ("2025-01-11", "01", 1)
        task2 = ("2025-01-18", "01", 1)

        model_tasks = {
            "m1": {task1: 10.0, task2: 15.0},      # mean = 12.5
            "m2": {task1: 20.0, task2: 30.0},      # mean = 25.0
            "base": {task1: 20.0, task2: 30.0},    # mean = 25.0
        }

        res = compute_pairwise_relative_wis(model_tasks, baseline_model="base")
        self.assertIn("m1", res)
        self.assertIn("m2", res)
        self.assertIn("base", res)

        # Baseline relative WIS is 1.0, direct diff is 0%
        self.assertAlmostEqual(res["base"]["relative_wis"], 1.0, places=3)
        self.assertAlmostEqual(res["base"]["direct_pct_vs_baseline"], 0.0, places=2)

        # m1 is twice as good (WIS is 0.5x of baseline)
        self.assertAlmostEqual(res["m1"]["relative_wis"], 0.5, places=3)
        self.assertAlmostEqual(res["m1"]["direct_pct_vs_baseline"], -50.0, places=2)

        # m2 is identical to base
        self.assertAlmostEqual(res["m2"]["relative_wis"], 1.0, places=3)
        self.assertAlmostEqual(res["m2"]["direct_pct_vs_baseline"], 0.0, places=2)

    def test_wis_23_quantiles_scoringutils_verification(self):
        """
        Verify exact agreement with the official Hubverse / R scoringutils formula
        across the complete 23-quantile grid (Bracher et al., 2021).
        Tests multiple scenarios: well-calibrated, underpredicting, and overpredicting.
        """
        from viz.core.metrics import STANDARD_23_QUANTILES

        # Quantile values for a synthetic symmetric forecast distribution centered at 50
        q_spread = [
            5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 38.0, 42.0, 45.0, 48.0,
            50.0,
            52.0, 55.0, 58.0, 62.0, 65.0, 70.0, 75.0, 80.0, 85.0, 90.0, 95.0
        ]
        self.assertEqual(len(q_spread), 23)

        scenarios = [
            52.0,   # Scenario A: inside central 50% interval
            8.0,    # Scenario B: below most quantiles (heavy underprediction)
            110.0,  # Scenario C: above all quantiles (heavy overprediction)
            50.0,   # Scenario D: exactly at the median
        ]

        # Independent reference calculation directly implementing scoringutils::score / Bracher et al. Box 1
        def scoringutils_reference_wis(y_true, quantiles, values):
            val_map = dict(zip(quantiles, values))
            m = val_map[0.5]

            # 11 central intervals
            k_pairs = [
                (0.01, 0.99), (0.025, 0.975), (0.05, 0.95), (0.1, 0.9),
                (0.15, 0.85), (0.2, 0.8), (0.25, 0.75), (0.3, 0.7),
                (0.35, 0.65), (0.4, 0.6), (0.45, 0.55),
            ]

            sharp_sum = 0.0
            over_sum = 0.0
            under_sum = 0.0

            for q_lo, q_hi in k_pairs:
                alpha = round(2.0 * q_lo, 4)
                w_k = alpha / 2.0
                l = val_map[q_lo]
                u = val_map[q_hi]

                # Sharpness: (u - l)
                sharp_sum += w_k * (u - l)

                # Overprediction: (2/alpha) * (l - y) * 1(y < l)
                if y_true < l:
                    over_sum += w_k * (2.0 / alpha) * (l - y_true)

                # Underprediction: (2/alpha) * (y - u) * 1(y > u)
                if y_true > u:
                    under_sum += w_k * (2.0 / alpha) * (y_true - u)

            # Median contribution
            if y_true < m:
                over_sum += 0.5 * (m - y_true)
            elif y_true > m:
                under_sum += 0.5 * (y_true - m)

            # Scaling factor 1 / (K + 0.5) = 1 / 11.5
            scale = 1.0 / 11.5
            ref_wis = scale * (sharp_sum + over_sum + under_sum)
            ref_sharp = scale * sharp_sum
            ref_over = scale * over_sum
            ref_under = scale * under_sum
            return ref_wis, ref_sharp, ref_over, ref_under

        for y_true in scenarios:
            forecast_rows = []
            for q, val in zip(STANDARD_23_QUANTILES, q_spread):
                forecast_rows.append({
                    "reference_date": "2025-01-11",
                    "target_end_date": "2025-01-18",
                    "location": "US",
                    "target": "wk inc flu hosp",
                    "horizon": 1,
                    "output_type": "quantile",
                    "output_type_id": q,
                    "value": val,
                })
            f_df = pl.DataFrame(forecast_rows)
            o_df = pl.DataFrame([{
                "target": "wk inc flu hosp",
                "target_end_date": "2025-01-18",
                "location": "US",
                "horizon": 1,
                "oracle_value": float(y_true),
            }])

            res = score_forecasts(f_df, o_df, target="wk inc flu hosp")
            self.assertTrue(bool(res))
            ov = res["overall"]

            exp_wis, exp_sharp, exp_over, exp_under = scoringutils_reference_wis(y_true, STANDARD_23_QUANTILES, q_spread)

            # Assert exact match to 6 decimal places with official scoringutils formulation
            self.assertAlmostEqual(ov["wis"], exp_wis, places=6)
            self.assertAlmostEqual(ov["sharpness_component"], exp_sharp, places=6)
            self.assertAlmostEqual(ov["overprediction_penalty"], exp_over, places=6)
            self.assertAlmostEqual(ov["underprediction_penalty"], exp_under, places=6)

            # Verify exact 3-part decomposition identity: WIS == Sharpness + Over + Under
            self.assertAlmostEqual(ov["wis"], ov["sharpness_component"] + ov["overprediction_penalty"] + ov["underprediction_penalty"], places=6)

    def test_log_scale_wis_and_mae(self):
        """Verify that score_forecasts calculates log-scale WIS and MAE using ln(y + 1)."""
        import math
        f_rows = []
        for q in STANDARD_23_QUANTILES:
            f_rows.append({
                "reference_date": "2025-01-11",
                "target_end_date": "2025-01-18",
                "location": "US",
                "target": "wk inc flu hosp",
                "horizon": 1,
                "output_type": "quantile",
                "output_type_id": q,
                "value": 100.0,
            })
        f_df = pl.DataFrame(f_rows)
        o_df = pl.DataFrame([{
            "target": "wk inc flu hosp",
            "target_end_date": "2025-01-18",
            "location": "US",
            "horizon": 1,
            "oracle_value": 100.0,
        }])

        res = score_forecasts(f_df, o_df, target="wk inc flu hosp")
        ov = res["overall"]
        self.assertIn("wis_log", ov)
        self.assertIn("mae_log", ov)
        # Perfect prediction: wis_log == 0.0 and mae_log == 0.0
        self.assertAlmostEqual(ov["wis_log"], 0.0, places=5)
        self.assertAlmostEqual(ov["mae_log"], 0.0, places=5)

        # Non-perfect prediction
        o_df_off = pl.DataFrame([{
            "target": "wk inc flu hosp",
            "target_end_date": "2025-01-18",
            "location": "US",
            "horizon": 1,
            "oracle_value": 50.0,
        }])
        res_off = score_forecasts(f_df, o_df_off, target="wk inc flu hosp")
        ov_off = res_off["overall"]
        self.assertGreater(ov_off["wis_log"], 0.0)
        expected_log_mae = abs(math.log(51.0) - math.log(101.0))
        self.assertAlmostEqual(ov_off["mae_log"], expected_log_mae, places=5)

    def test_log_pairwise_relative_wis(self):
        """Verify that compute_pairwise_relative_wis correctly scores models on the log scale."""
        from viz.core.metrics import compute_pairwise_relative_wis
        task1 = ("US", "2025-01-11", 1)
        task2 = ("US", "2025-01-18", 1)

        # Model A: wis=10, wis_log=0.5
        # Model B: wis=20, wis_log=0.25 (worse on natural, better on log)
        df_a = pl.DataFrame([
            {"location": "US", "reference_date": "2025-01-11", "horizon": 1, "wis": 10.0, "wis_log": 0.5},
            {"location": "US", "reference_date": "2025-01-18", "horizon": 1, "wis": 10.0, "wis_log": 0.5},
        ])
        df_b = pl.DataFrame([
            {"location": "US", "reference_date": "2025-01-11", "horizon": 1, "wis": 20.0, "wis_log": 0.25},
            {"location": "US", "reference_date": "2025-01-18", "horizon": 1, "wis": 20.0, "wis_log": 0.25},
        ])

        rel_nat = compute_pairwise_relative_wis({"A": df_a, "B": df_b}, baseline_model="B", metric_col="wis")
        self.assertAlmostEqual(rel_nat["A"]["relative_wis"], 0.5, places=3)

        rel_log = compute_pairwise_relative_wis({"A": df_a, "B": df_b}, baseline_model="B", metric_col="wis_log")
        self.assertAlmostEqual(rel_log["A"]["relative_wis"], 2.0, places=3)


if __name__ == "__main__":
    unittest.main()

