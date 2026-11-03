"""
Evaluation windows: per-location season phases, week-range and phase scoping of the leaderboard,
and the weekly "Wins" count. Built on a tiny synthetic hub (no repository data).
"""

from datetime import date, timedelta
from pathlib import Path
import shutil
import tempfile
import unittest

import polars as pl

from viz.core.data_loader import SandboxDataLoader, date_to_season_and_week
from viz.core.evaluation import EvaluationEngine, EvaluationParams, parse_phase, parse_week_range

TARGET = "wk inc flu hosp"
QUANTILES = [0.025, 0.25, 0.5, 0.75, 0.975]
SEASON = "2024-2025"
# Saturdays from early October 2024 through May 2025 (season weeks ~10-42)
WEEKS = [date(2024, 10, 5) + timedelta(weeks=i) for i in range(34)]


def curve(peak_index: int, height: float):
    """A triangular epidemic curve peaking at WEEKS[peak_index]."""
    return [max(1.0, height * (1 - abs(i - peak_index) / 6)) for i in range(len(WEEKS))]


TRUTH = {"US": curve(14, 1000.0), "01": curve(10, 100.0), "02": curve(20, 50.0)}


class TestWindowParsing(unittest.TestCase):
    def test_week_ranges(self):
        self.assertIsNone(parse_week_range(None))
        self.assertIsNone(parse_week_range("all"))
        self.assertIsNone(parse_week_range("1-53"))
        self.assertEqual(parse_week_range("24-10"), (10, 24))
        self.assertEqual(parse_week_range("0-99"), None)
        with self.assertRaises(ValueError):
            parse_week_range("soon")

    def test_phases(self):
        self.assertIsNone(parse_phase("full"))
        self.assertEqual(parse_phase("Peak"), "peak")
        with self.assertRaises(ValueError):
            parse_phase("summer")


class TestEvaluationWindow(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        (self.base / "viz").mkdir()
        (self.base / "auxiliary-data").mkdir()
        (self.base / "target-data").mkdir()
        pl.DataFrame({
            "abbreviation": ["US", "AL", "AK"], "location": ["US", "01", "02"],
            "location_name": ["US", "Alabama", "Alaska"], "population": [330_000_000, 5_000_000, 700_000],
        }).write_csv(self.base / "auxiliary-data" / "locations.csv")
        rows = []
        for loc, vals in TRUTH.items():
            for d, v in zip(WEEKS, vals):
                rows.append({"as_of": "2025-07-01", "target": TARGET, "target_end_date": d.isoformat(),
                             "location": loc, "horizon": 0, "output_type": "quantile",
                             "output_type_id": None, "oracle_value": v})
        pl.DataFrame(rows).write_csv(self.base / "target-data" / "oracle-output.csv")

        # "Good" is centred on truth; "High" over-predicts by 30% everywhere; "Wide" is centred but very wide
        for name in ("Team-good", "Team-high", "Team-wide"):
            out = self.base / "model-output" / name
            out.mkdir(parents=True)
            for ref in WEEKS[:-1]:
                fr = []
                for loc, vals in TRUTH.items():
                    for h in (0, 1):
                        ted = ref + timedelta(weeks=h)
                        if ted not in WEEKS:
                            continue
                        i = WEEKS.index(ted)
                        center = vals[i] * (1.3 if name == "Team-high" else 1.0)
                        spread = 0.1 if name != "Team-wide" else 0.9
                        for q in QUANTILES:
                            fr.append({"reference_date": ref.isoformat(), "target": TARGET, "horizon": h,
                                       "location": loc, "target_end_date": ted.isoformat(),
                                       "output_type": "quantile", "output_type_id": q,
                                       "value": center * (1 + spread * (q - 0.5) * 2)})
                pl.DataFrame(fr).write_csv(out / f"{ref.isoformat()}-{name}.csv")

        self.loader = SandboxDataLoader(self.base, include_remote=False)
        self.engine = EvaluationEngine(self.base, self.loader)
        self.models = ["Team-good", "Team-high", "Team-wide"]

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def test_peaks_are_assigned_per_location(self):
        phases = self.loader.get_truth_phases(TARGET).filter(pl.col("season") == SEASON)
        peak_dates = {
            loc: sorted(phases.filter((pl.col("location") == loc) & (pl.col("phase") == "peak"))["target_end_date"].to_list())
            for loc in TRUTH
        }
        for loc, idx in (("US", 14), ("01", 10), ("02", 20)):
            self.assertIn(WEEKS[idx].isoformat(), peak_dates[loc])
            # >= 60% of the max on a triangle 6 weeks wide -> 2 weeks either side of the top
            self.assertEqual(len(peak_dates[loc]), 5)
        self.assertNotEqual(peak_dates["01"], peak_dates["02"])
        pre = phases.filter((pl.col("location") == "US") & (pl.col("phase") == "pre"))["target_end_date"].max()
        self.assertLess(pre, WEEKS[12].isoformat())

    def test_ongoing_season_has_not_peaked(self):
        # Truncate the oracle right at a still-rising week, well before the season ends
        oracle = pl.read_csv(self.base / "target-data" / "oracle-output.csv", schema_overrides={"location": pl.String})
        oracle.filter(pl.col("target_end_date") <= WEEKS[9].isoformat()).write_csv(self.base / "target-data" / "oracle-output.csv")
        loader = SandboxDataLoader(self.base, include_remote=False)
        phases = loader.get_truth_phases(TARGET).filter(pl.col("location") == "US")
        self.assertEqual(set(phases["phase"].to_list()), {"pre"})
        curves = loader.get_season_curves(TARGET, "US", [SEASON])
        self.assertFalse(curves["curves"][0]["peaked"])

    def test_phase_window_scores_only_each_locations_peak_weeks(self):
        res = self.engine.evaluate(EvaluationParams(models=self.models, location="all", season=SEASON, phase="peak"))
        self.assertEqual(res.window["phase"], "peak")
        task_df = self.engine.get_task_scores_dataframe(
            EvaluationParams(models=self.models, location="all", season=SEASON, phase="peak"))
        phases = self.loader.get_truth_phases(TARGET).filter(pl.col("phase") == "peak")
        allowed = {(l, d) for l, d in phases.select(["location", "target_end_date"]).iter_rows()}
        seen = {(str(l), str(d)) for l, d in task_df.select(["location", "target_end_date"]).iter_rows()}
        self.assertTrue(seen)
        self.assertTrue(seen <= allowed, seen - allowed)
        # States-only pooling: each state's peak tasks, 5 peak weeks x 2 states, h0 and h1 where in range
        good = next(r for r in res.rankings if r["model_id"] == "Team-good")
        self.assertGreater(good["count"], 0)

    def test_week_range_restricts_target_weeks(self):
        res = self.engine.evaluate(EvaluationParams(models=self.models, location="US", season=SEASON, weeks="20-24"))
        task_df = self.engine.get_task_scores_dataframe(
            EvaluationParams(models=self.models, location="US", season=SEASON, weeks="20-24"))
        weeks = {date_to_season_and_week(str(d))[1] for d in task_df["target_end_date"].to_list()}
        self.assertTrue(weeks and min(weeks) >= 20 and max(weeks) <= 24)
        self.assertEqual(res.window["weeks"], [20, 24])
        self.assertLessEqual(res.scope_dates_count, 6)

    def test_weekly_wins(self):
        res = self.engine.evaluate(EvaluationParams(models=self.models, location="US", season=SEASON))
        by = {r["model_id"]: r for r in res.rankings}
        competed = by["Team-good"]["weeks_competed"]
        self.assertEqual(competed, res.scope_dates_count)
        # The model centred on truth with tight intervals wins every round
        self.assertEqual(by["Team-good"]["weeks_won"], competed)
        self.assertEqual(by["Team-high"]["weeks_won"], 0)
        self.assertIsNotNone(by["Team-wide"]["weeks_won_log"])

    def test_season_curves_payload(self):
        curves = self.loader.get_season_curves(TARGET, "01", [SEASON])
        c = curves["curves"][0]
        self.assertEqual(c["season"], SEASON)
        self.assertTrue(c["peaked"])
        self.assertEqual(curves["month_ticks"][0]["label"], "Aug")
        self.assertEqual(len(curves["week_dates"]), 53)


if __name__ == "__main__":
    unittest.main()
