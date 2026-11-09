"""
Equivalence tests for the fast scoring paths. Each fast path is checked against the original
implementation it replaced, on randomized inputs and on the edge cases where they could diverge:

- compute_pairwise_relative_wis (matrix form) vs _pairwise_relative_wis_reference (original pair loop)
- per-model % vs baseline read from per-task scores (_shared_task_wis) vs re-scoring on the shared tasks
- find_common_tasks on threads vs sequentially, including its early exits
- whole evaluations on threads vs VIZ_THREADS=1, and vs the original baseline-comparison algorithm
- the memoized oracle preparation never serves a stale oracle

Self-contained: builds its own synthetic data, no repository data needed.
"""

from datetime import date, timedelta
import math
import os
from pathlib import Path
import random
import shutil
import tempfile
import unittest
from unittest import mock

import polars as pl

from viz.core.data_loader import SandboxDataLoader
from viz.core.evaluation import EvaluationEngine, EvaluationParams, _shared_task_wis
from viz.core.metrics import (
    _pairwise_relative_wis_reference,
    compute_pairwise_relative_wis,
    find_common_tasks,
    score_forecasts,
)

TARGET = "wk inc flu hosp"
LOCATIONS = ["US", "01", "02", "04", "05"]
POPULATION = {"US": 330_000_000, "01": 5_000_000, "02": 700_000, "04": 7_000_000, "05": 3_000_000}
QUANTILES_7 = [0.025, 0.1, 0.25, 0.5, 0.75, 0.9, 0.975]
QUANTILES_23 = [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5,
                0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.975, 0.99]
WEEKS = [date(2024, 11, 2) + timedelta(weeks=i) for i in range(10)]


def truth_value(loc: str, d: date) -> float:
    base = 3000.0 if loc == "US" else 40.0 + 30.0 * LOCATIONS.index(loc)
    return round(base * (1.0 + 0.4 * math.sin(WEEKS.index(d) / 2.0)), 1)


def oracle_frame() -> pl.DataFrame:
    rows = [{"as_of": "2025-06-01", "target": TARGET, "target_end_date": d.isoformat(), "location": loc,
             "output_type": "quantile", "oracle_value": truth_value(loc, d)} for loc in LOCATIONS for d in WEEKS]
    return pl.DataFrame(rows)


def random_forecasts(rng: random.Random, ref_dates, locations, quantiles, skip=0.25, horizons=(0, 1, 2, 3)) -> pl.DataFrame:
    """Quantile forecasts with random bias/width, randomly missing ~`skip` of the tasks."""
    rows = []
    for ref in ref_dates:
        for loc in locations:
            for h in horizons:
                ted = ref + timedelta(weeks=h)
                if ted not in WEEKS or rng.random() < skip:
                    continue
                center = truth_value(loc, ted) * rng.uniform(0.5, 1.6)
                width = rng.uniform(0.05, 0.9)
                for q in quantiles:
                    rows.append({"reference_date": ref.isoformat(), "target": TARGET, "horizon": h, "location": loc,
                                 "target_end_date": ted.isoformat(), "output_type": "quantile",
                                 "output_type_id": q, "value": max(0.0, center * (1 + width * (q - 0.5) * 2))})
    return pl.DataFrame(rows, schema_overrides={"horizon": pl.Int32})


def random_task_frame(rng: random.Random, n_tasks: int, p_keep: float) -> pl.DataFrame:
    """A per-task score frame shaped like score_forecasts' task_df (location/reference_date/horizon/wis/wis_log)."""
    rows = []
    for t in range(n_tasks):
        if rng.random() > p_keep:
            continue
        wis = rng.choice([0.0, rng.uniform(0, 1e-3), rng.uniform(0.1, 500.0), rng.uniform(0.1, 500.0)])
        wis_log = None if rng.random() < 0.05 else (float("nan") if rng.random() < 0.03 else rng.uniform(0, 3))
        rows.append({"location": LOCATIONS[t % len(LOCATIONS)], "reference_date": f"2024-{1 + (t // 25) % 12:02d}-{1 + t % 25:02d}",
                     "horizon": t % 4, "wis": wis, "wis_log": wis_log})
        if rng.random() < 0.02:  # a repeated task: the last value must win, as in the reference dict
            rows.append({**rows[-1], "wis": rng.uniform(0.1, 500.0)})
    return pl.DataFrame(rows, schema={"location": pl.String, "reference_date": pl.String, "horizon": pl.Int32,
                                      "wis": pl.Float64, "wis_log": pl.Float64})


def assert_equivalent(test: unittest.TestCase, a, b, path="result"):
    """Deep equality, except floats may differ by 1e-12 relative.

    Polars group_by returns groups in no fixed order, so even the original engine's means can differ in
    the last bit or two between two identical runs. Everything that is not a float must match exactly.
    """
    if isinstance(a, float) and isinstance(b, float):
        if not (a == b or (math.isnan(a) and math.isnan(b))):
            test.assertLessEqual(abs(a - b), 1e-12 * max(1.0, abs(a), abs(b)), f"{path}: {a!r} != {b!r}")
        return
    test.assertIs(type(a), type(b), f"{path}: type {type(a).__name__} != {type(b).__name__}")
    if isinstance(a, dict):
        test.assertEqual(list(a.keys()), list(b.keys()), f"{path}: keys differ")
        for k in a:
            assert_equivalent(test, a[k], b[k], f"{path}.{k}")
    elif isinstance(a, (list, tuple)):
        test.assertEqual(len(a), len(b), f"{path}: lengths differ")
        for i, (x, y) in enumerate(zip(a, b)):
            assert_equivalent(test, x, y, f"{path}[{i}]")
    else:
        test.assertEqual(a, b, path)


def outcome(fn, *args, **kwargs):
    """A function's result, or the type and message of what it raised (so errors are compared too)."""
    try:
        return ("ok", fn(*args, **kwargs))
    except Exception as exc:
        return ("raised", type(exc).__name__, str(exc))


class TestPairwiseRelativeWisMatchesReference(unittest.TestCase):
    def assert_same(self, model_tasks, baseline, col):
        # Outputs are rounded to 4 (relative WIS) and 2 (% vs baseline) decimals, so they compare exactly
        self.assertEqual(
            outcome(compute_pairwise_relative_wis, model_tasks, baseline, metric_col=col),
            outcome(_pairwise_relative_wis_reference, model_tasks, baseline, metric_col=col),
        )

    def test_randomized(self):
        rng = random.Random(20261108)
        for _ in range(300):
            n_models = rng.randint(1, 12)
            n_tasks = rng.randint(1, 120)
            models = {f"m{i}": random_task_frame(rng, n_tasks, rng.choice([0.0, 0.2, 0.7, 1.0])) for i in range(n_models)}
            baseline = rng.choice([None, "m0", f"m{n_models - 1}", "absent"])
            for col in ("wis", "wis_log"):
                self.assert_same(models, baseline, col)

    def test_edge_cases(self):
        f = lambda rows, **schema: pl.DataFrame(rows, schema=schema or None)  # noqa: E731
        base = {"location": ["01", "02"], "reference_date": ["2024-01-06", "2024-01-06"], "horizon": [1, 1], "wis": [2.0, 4.0]}
        cases = [
            {},
            {"A": pl.DataFrame(base)},
            {"A": pl.DataFrame(base), "B": pl.DataFrame(base).with_columns(pl.col("wis") * 2)},
            {"A": pl.DataFrame(base), "Empty": pl.DataFrame(base).head(0)},
            {"A": pl.DataFrame(base), "NoMetric": pl.DataFrame(base).drop("wis")},
            {"A": pl.DataFrame(base), "AllNaN": pl.DataFrame(base).with_columns(pl.lit(float("nan")).alias("wis"))},
            {"A": pl.DataFrame(base), "Zero": pl.DataFrame(base).with_columns(pl.lit(0.0).alias("wis"))},
            {"A": pl.DataFrame(base), "Inf": pl.DataFrame(base).with_columns(pl.lit(float("inf")).alias("wis"))},
            {"A": pl.DataFrame(base), "IntWis": pl.DataFrame(base).with_columns(pl.col("wis").cast(pl.Int64))},
            {"A": pl.DataFrame(base), "NullLoc": pl.DataFrame(base).with_columns(pl.lit(None, pl.String).alias("location"))},
            {"A": pl.DataFrame(base), "TedOnly": pl.DataFrame(base).rename({"reference_date": "target_end_date"})},
            {"A": pl.DataFrame(base), "IntLoc": pl.DataFrame(base).with_columns(pl.col("location").cast(pl.Int64))},
            {"A": {("01", "2024-01-06", 1): 3.0}, "B": pl.DataFrame(base)},
            {"A": {("01", "2024-01-06", 1): 3.0, ("02", "2024-01-06", 1): float("nan")}, "B": {("01", "2024-01-06", 1): 1.0}},
            {"A": pl.DataFrame(base), "NotAFrame": None},
            {"Dup": pl.concat([pl.DataFrame(base), pl.DataFrame(base).with_columns(pl.col("wis") + 1)]), "A": pl.DataFrame(base)},
        ]
        for model_tasks in cases:
            for baseline in (None, "A", "B", "absent"):
                with self.subTest(models=list(model_tasks), baseline=baseline):
                    self.assert_same(model_tasks, baseline, "wis")

    def test_inf_still_raises_like_reference(self):
        base = pl.DataFrame({"location": ["01"], "reference_date": ["2024-01-06"], "horizon": [1], "wis": [2.0]})
        tasks = {"A": base, "Inf": base.with_columns(pl.lit(float("inf")).alias("wis"))}
        with self.assertRaises(ValueError):
            _pairwise_relative_wis_reference(tasks, "A")
        with self.assertRaises(ValueError):
            compute_pairwise_relative_wis(tasks, "A")


class TestSharedTaskWis(unittest.TestCase):
    """% vs baseline: reading the shared tasks out of per-task scores == re-scoring on those tasks."""

    def test_matches_rescoring_on_shared_tasks(self):
        rng = random.Random(7)
        oracle = oracle_frame()
        refs = WEEKS[:7]
        for trial in range(40):
            locs = rng.choice([LOCATIONS, ["US"], LOCATIONS[1:], ["US", "02"]])
            quantiles = rng.choice([QUANTILES_7, QUANTILES_23, [0.25, 0.5, 0.75]])
            df = random_forecasts(rng, refs, locs, quantiles, skip=rng.choice([0.0, 0.3, 0.7]))
            other = random_forecasts(rng, refs, LOCATIONS, QUANTILES_23, skip=0.5)
            if df.is_empty():
                continue
            task_df = score_forecasts(df, oracle, target=TARGET, non_negative=True, population_map=POPULATION,
                                      return_task_df=True)["task_df"]
            shared = find_common_tasks({"m": df, "b": other}, target=TARGET)
            if not shared:
                continue
            shared_df = pl.DataFrame(sorted(shared), schema={"reference_date": pl.String, "location": pl.String,
                                                             "horizon": pl.Int32}, orient="row")
            expected = score_forecasts(df, oracle, target=TARGET, common_tasks=shared, non_negative=True)
            want = (expected["overall"]["wis"], expected["overall"]["wis_log"]) if expected else (None, None)
            got = _shared_task_wis(task_df, shared_df)
            with self.subTest(trial=trial):
                for g, w in zip(got, want):
                    if w is None:
                        self.assertIsNone(g)
                    else:
                        self.assertAlmostEqual(g, w, delta=1e-12 * max(1.0, abs(w)))


class TestThreadedPathsMatchSequential(unittest.TestCase):
    def test_find_common_tasks_threads_and_early_exit(self):
        rng = random.Random(3)
        for _ in range(20):
            dfs = {f"m{i}": random_forecasts(rng, WEEKS[:6], LOCATIONS, QUANTILES_7, skip=0.3) for i in range(rng.randint(2, 9))}
            with mock.patch.dict(os.environ, {"VIZ_THREADS": "1"}):
                sequential = find_common_tasks(dfs, target=TARGET, locations=["01", "02", "US"])
            with mock.patch.dict(os.environ, {"VIZ_THREADS": "8"}):
                threaded = find_common_tasks(dfs, target=TARGET, locations=["01", "02", "US"])
            self.assertEqual(sequential, threaded)

        good = random_forecasts(rng, WEEKS[:3], LOCATIONS, QUANTILES_7, skip=0.0)
        broken = pl.DataFrame({"no_target_column": [1]})
        empty = good.head(0)
        with mock.patch.dict(os.environ, {"VIZ_THREADS": "8"}):
            # A model with no tasks ends the intersection before a later broken model is ever looked at...
            self.assertEqual(find_common_tasks({"a": good, "e": empty, "x": broken}, target=TARGET), set())
            # ...but a broken model that a sequential loop would reach still raises.
            with self.assertRaises(Exception):
                find_common_tasks({"a": good, "x": broken, "e": empty}, target=TARGET)


class TestEvaluationEquivalence(unittest.TestCase):
    """Whole leaderboards on a synthetic hub with uneven model coverage."""

    @classmethod
    def setUpClass(cls):
        rng = random.Random(11)
        cls.base = Path(tempfile.mkdtemp())
        (cls.base / "viz").mkdir()
        (cls.base / "auxiliary-data").mkdir()
        (cls.base / "target-data").mkdir()
        pl.DataFrame({"abbreviation": LOCATIONS, "location": LOCATIONS, "location_name": LOCATIONS,
                      "population": [POPULATION[x] for x in LOCATIONS]}).write_csv(cls.base / "auxiliary-data" / "locations.csv")
        oracle_frame().write_csv(cls.base / "target-data" / "oracle-output.csv")
        specs = {
            "FluSight-baseline": (WEEKS[:7], LOCATIONS, QUANTILES_23, 0.0),
            "Team-full": (WEEKS[:7], LOCATIONS, QUANTILES_23, 0.1),
            "Team-sparse": (WEEKS[:7], LOCATIONS, QUANTILES_23, 0.6),
            "Team-states": (WEEKS[2:7], LOCATIONS[1:], QUANTILES_7, 0.2),
            "Team-us": (WEEKS[:5], ["US"], QUANTILES_23, 0.0),
            "Team-late": (WEEKS[4:7], LOCATIONS, [0.25, 0.5, 0.75], 0.0),
            "Team-early": (WEEKS[:2], LOCATIONS[:3], QUANTILES_7, 0.0),
        }
        for name, (refs, locs, qs, skip) in specs.items():
            out = cls.base / "model-output" / name
            out.mkdir(parents=True)
            df = random_forecasts(rng, refs, locs, qs, skip=skip)
            for ref in refs:
                part = df.filter(pl.col("reference_date") == ref.isoformat())
                if not part.is_empty():
                    part.write_csv(out / f"{ref.isoformat()}-{name}.csv")
        cls.loader = SandboxDataLoader(cls.base, include_remote=False)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base, ignore_errors=True)

    PARAMS = [
        dict(location=loc, date=d, fair=fair, baseline=b, models=m)
        for loc in ("all", "states", "US", "02")
        for d in ("all", WEEKS[3].isoformat())
        for fair in (False, True)
        for b in (None, "Team-full")
        for m in (None, ["Team-sparse", "Team-states", "Team-us"])
    ]

    def evaluate(self, threads: str, **kw):
        with mock.patch.dict(os.environ, {"VIZ_THREADS": threads}):
            return EvaluationEngine(self.base, self.loader).evaluate(EvaluationParams(target=TARGET, **kw)).to_dict()

    def test_threads_do_not_change_results(self):
        for kw in self.PARAMS:
            with self.subTest(**kw):
                assert_equivalent(self, self.evaluate("1", **kw), self.evaluate("8", **kw))

    def test_pct_vs_baseline_matches_rescoring(self):
        """The original algorithm: find_common_tasks({model, baseline}), then score both on those tasks."""
        oracle = self.loader.get_oracle(as_polars=True)
        checked = 0
        for kw in self.PARAMS:
            if kw["fair"]:
                continue
            res = EvaluationEngine(self.base, self.loader).evaluate(EvaluationParams(target=TARGET, **kw))
            base = res.baseline_model
            locs = res.locations_filter
            for row in res.rankings:
                mid = row["model_id"]
                if not row["has_data_in_scope"] or mid == base or row["wis"] is None:
                    continue
                dfs = {m: self.loader.load_combined_forecasts(m, res.scope_dates) for m in (mid, base)}
                shared = find_common_tasks(dfs, target=TARGET, locations=locs, reference_dates=res.scope_dates)
                expected, expected_log = None, None
                if shared:
                    s_m = score_forecasts(dfs[mid], oracle, target=TARGET, common_tasks=shared, non_negative=True)
                    s_b = score_forecasts(dfs[base], oracle, target=TARGET, common_tasks=shared, non_negative=True)
                    mw, bw = (s_m or {}).get("overall", {}), (s_b or {}).get("overall", {})
                    if mw.get("wis") is not None and bw.get("wis"):
                        expected = round((mw["wis"] - bw["wis"]) / bw["wis"] * 100.0, 1)
                    if mw.get("wis_log") is not None and bw.get("wis_log"):
                        expected_log = round((mw["wis_log"] - bw["wis_log"]) / bw["wis_log"] * 100.0, 1)
                with self.subTest(model=mid, **kw):
                    self.assertEqual(row["pct_diff_vs_baseline"], expected)
                    self.assertEqual(row["pct_diff_vs_baseline_log"], expected_log)
                checked += 1
        self.assertGreater(checked, 50)


class TestOracleMemo(unittest.TestCase):
    def test_new_oracle_is_never_served_stale(self):
        rng = random.Random(5)
        df = random_forecasts(rng, WEEKS[:3], LOCATIONS, QUANTILES_7, skip=0.0)
        o1 = oracle_frame()
        o2 = o1.with_columns(pl.col("oracle_value") * 1.5)
        first = score_forecasts(df, o1, target=TARGET)["overall"]["wis"]
        second = score_forecasts(df, o2, target=TARGET)["overall"]["wis"]
        again = score_forecasts(df, o1, target=TARGET)["overall"]["wis"]
        self.assertNotEqual(first, second)
        self.assertEqual(first, again)
        del o1, o2
        for scale in (2.0, 3.0, 4.0):  # fresh objects (ids may be recycled) must give fresh results
            o = oracle_frame().with_columns(pl.col("oracle_value") * scale)
            fresh = score_forecasts(df, o.clone(), target=TARGET)["overall"]["wis"]
            self.assertEqual(score_forecasts(df, o, target=TARGET)["overall"]["wis"], fresh)


if __name__ == "__main__":
    unittest.main()
