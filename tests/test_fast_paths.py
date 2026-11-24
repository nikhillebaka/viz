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

import numpy as np
import polars as pl

import conftest  # noqa: F401
from viz.core.data_loader import SandboxDataLoader
from viz.core.evaluation import EvaluationEngine, EvaluationParams, _shared_task_wis
from viz.core.metrics import (
    LOG_SCORE_FLOOR,
    _pairwise_relative_wis_reference,
    compute_pairwise_relative_wis,
    crps_ensemble_1d,
    energy_score,
    find_common_tasks,
    score_forecasts,
    score_pmf_forecasts,
    score_sample_forecasts,
    score_task_wis,
    summarize_scored_tasks,
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

    def test_loader_get_oracle_caches_identity_and_refreshes_on_rewrite(self):
        with tempfile.TemporaryDirectory(prefix="viz-ora-cache-") as tmp:
            base = Path(tmp)
            (base / "viz").mkdir()
            (base / "auxiliary-data").mkdir()
            (base / "target-data").mkdir()
            pl.DataFrame({
                "abbreviation": LOCATIONS,
                "location": LOCATIONS,
                "location_name": LOCATIONS,
                "population": [POPULATION[x] for x in LOCATIONS],
            }).write_csv(base / "auxiliary-data" / "locations.csv")
            o1 = oracle_frame()
            ora_csv = base / "target-data" / "oracle-output.csv"
            o1.write_csv(ora_csv)
            loader = SandboxDataLoader(base, include_remote=False, cache_dir=base / "cache", surveillance_dir=base / "surv")
            first = loader.get_oracle(as_polars=True)
            second = loader.get_oracle(as_polars=True)
            self.assertIs(first, second)
            pq = loader.cache_mgr.get_oracle_parquet()
            o2 = o1.with_columns(pl.col("oracle_value") * 2.0)
            o2.write_parquet(pq)
            # Ensure bumped mtime & distinct size trigger fresh read immediately
            refreshed = loader.get_oracle(as_polars=True)
            self.assertIsNot(first, refreshed)
            self.assertAlmostEqual(
                float(refreshed["oracle_value"].sum()),
                float(first["oracle_value"].sum()) * 2.0,
                places=6,
            )


def _reference_pmf_loop(
    f: pl.DataFrame,
    o: pl.DataFrame,
    target: str,
    categories,
    ordinal: bool,
    extra_cols=(),
    aggregate_locations=("US",),
):
    """Exact original Python group_by PMF loop reference."""
    merged = (
        f.filter((pl.col("target") == target) & (pl.col("output_type") == "pmf"))
        .with_columns(
            pl.col("location").cast(pl.String),
            pl.col("horizon").fill_null(0).cast(pl.Int32),
            pl.col("output_type_id").cast(pl.String).str.strip_chars(),
            pl.col("value").cast(pl.Float64),
            pl.col("reference_date").cast(pl.String),
            pl.col("target_end_date").cast(pl.String),
            *[pl.col(c).cast(pl.String) for c in extra_cols],
        )
        .drop_nulls(subset=["value", "output_type_id", "target_end_date", "location", "horizon"])
        .join(
            o.filter(pl.col("target") == target)
            .with_columns(
                pl.col("location").cast(pl.String),
                pl.col("target_end_date").cast(pl.String),
                pl.col("output_type_id").cast(pl.String).str.strip_chars().alias("true_category"),
                pl.col("oracle_value").cast(pl.Float64),
                *[pl.col(c).cast(pl.String) for c in extra_cols],
            )
            .filter(pl.col("oracle_value") > 0)
            .select(["target_end_date", "location", *extra_cols, "true_category"]),
            on=["target_end_date", "location", *extra_cols],
            how="inner",
        )
    )
    if merged.is_empty():
        return {}
    cat_order = [str(c) for c in categories] if categories else sorted(
        set(merged.get_column("output_type_id").to_list()) | set(merged.get_column("true_category").to_list())
    )
    cat_idx = {c: i for i, c in enumerate(cat_order)}
    K = len(cat_order)
    group_keys = ["reference_date", "location", "horizon", "target_end_date", *extra_cols]
    task_rows = []
    for keys, g in merged.group_by(group_keys, maintain_order=True):
        probs = np.zeros(K, dtype=np.float64)
        for oid, val in zip(g.get_column("output_type_id").to_list(), g.get_column("value").to_list()):
            idx = cat_idx.get(str(oid))
            if idx is not None and val is not None and np.isfinite(val):
                probs[idx] += max(0.0, float(val))
        s = float(probs.sum())
        if s > 0 and abs(s - 1.0) > 1e-6:
            probs /= s
        true_cat = str(g.get_column("true_category")[0])
        y_idx = cat_idx.get(true_cat)
        if y_idx is None:
            continue
        p_true = float(probs[y_idx])
        log_score = float(-math.log(max(p_true, LOG_SCORE_FLOOR)))
        y_vec = np.zeros(K, dtype=np.float64)
        y_vec[y_idx] = 1.0
        brier = float(np.sum((probs - y_vec) ** 2))
        rps = float(np.sum((np.cumsum(probs) - (np.arange(K) >= y_idx).astype(np.float64)) ** 2)) if (ordinal and K > 1) else None
        hit_mode = 1.0 if (s > 0.0 and int(np.argmax(probs)) == y_idx) else 0.0
        row = dict(zip(group_keys, keys))
        row.update({"true_category": true_cat, "p_observed": p_true, "rps": rps, "log_score": log_score, "brier": brier, "hit_mode": hit_mode})
        task_rows.append(row)
    if not task_rows:
        return {}
    task_df = pl.DataFrame(task_rows)
    agg_set = set(aggregate_locations)
    is_agg = task_df["location"].is_in(sorted(agg_set))
    has_primary = bool((~is_agg).any())
    primary_df = task_df.filter(~is_agg) if has_primary else task_df.filter(is_agg)

    def _agg(sub):
        return {
            "rps": float(sub["rps"].mean()) if ordinal and K > 1 else None,
            "log_score": float(sub["log_score"].mean()),
            "brier": float(sub["brier"].mean()),
            "hit_mode": float(sub["hit_mode"].mean()) * 100.0,
            "count": int(sub.height),
        }

    return {
        "overall": _agg(primary_df),
        "states": _agg(task_df.filter(~is_agg)) if has_primary else None,
        "us": _agg(task_df.filter(is_agg)) if bool(is_agg.any()) else None,
        "by_horizon": {int(h): _agg(primary_df.filter(pl.col("horizon") == h)) for h in sorted(primary_df.get_column("horizon").unique().to_list())},
        "task_rows": task_df.sort(group_keys).to_dicts(),
    }


class TestPmfVectorizedMatchesReference(unittest.TestCase):
    def test_pmf_randomized_edge_cases_and_lazy(self):
        rng = random.Random(20261124)
        cats = ["large_decrease", "decrease", "stable", "increase", "large_increase"]
        target = "wk flu hosp rate change"
        for trial in range(25):
            ordinal = trial % 3 != 0
            use_extra = trial % 2 == 0
            refs = WEEKS[:4]
            o_rows = []
            f_rows = []
            for d in WEEKS[:8]:
                for loc in LOCATIONS[:4]:
                    ages = ["overall", "0-17"] if use_extra else [None]
                    for age in ages:
                        tc = rng.choice(cats)
                        row = {"target": target, "target_end_date": d.isoformat(), "location": loc,
                               "output_type": "pmf", "output_type_id": tc, "oracle_value": 1.0}
                        if use_extra:
                            row["age_group"] = age
                        o_rows.append(row)
            for ref in refs:
                for loc in LOCATIONS[:4]:
                    ages = ["overall", "0-17"] if use_extra else [None]
                    for age in ages:
                        for h in (0, 1, 2):
                            ted = ref + timedelta(weeks=h)
                            if ted not in WEEKS[:8] or rng.random() < 0.2:
                                continue
                            mode = rng.choice(["normal", "unnorm", "zero", "dup", "partial"])
                            if mode == "zero":
                                vals = [0.0, -0.1, 0.0, float("nan"), 0.0]
                            elif mode == "unnorm":
                                raw = [rng.uniform(0.1, 5.0) for _ in cats]
                                vals = raw
                            else:
                                raw = [rng.random() for _ in cats]
                                s = sum(raw) or 1.0
                                vals = [x / s for x in raw]
                            used_cats = cats[:3] if mode == "partial" else cats
                            for idx, cat in enumerate(used_cats):
                                fr = {"target": target, "reference_date": ref.isoformat(), "horizon": h,
                                      "location": loc, "target_end_date": ted.isoformat(), "output_type": "pmf",
                                      "output_type_id": cat, "value": vals[idx]}
                                if use_extra:
                                    fr["age_group"] = age
                                f_rows.append(fr)
                            if mode == "dup":
                                dup = dict(f_rows[-1])
                                dup["value"] = 0.25
                                f_rows.append(dup)
            f_df = pl.DataFrame(f_rows, schema_overrides={"horizon": pl.Int32})
            o_df = pl.DataFrame(o_rows)
            extra = ["age_group"] if use_extra else None
            ref_out = _reference_pmf_loop(f_df, o_df, target, cats, ordinal, extra_cols=extra or ())
            got = score_pmf_forecasts(f_df, o_df, target, categories=cats, ordinal=ordinal, extra_task_ids=extra, return_task_df=True)
            got_lazy = score_pmf_forecasts(f_df.lazy(), o_df.lazy(), target, categories=cats, ordinal=ordinal, extra_task_ids=extra, return_task_df=True)
            group_keys = ["reference_date", "location", "horizon", "target_end_date", *(extra or ())]
            for cand in (got, got_lazy):
                with self.subTest(trial=trial):
                    for k in ("overall", "states", "us", "by_horizon"):
                        assert_equivalent(self, cand[k], ref_out[k], f"pmf.{k}")
                    cand_rows = cand["task_df"].select(group_keys + ["true_category", "p_observed", "rps", "log_score", "brier", "hit_mode"]).sort(group_keys).to_dicts()
                    assert_equivalent(self, cand_rows, ref_out["task_rows"], "pmf.task_rows")


class TestSampleVectorizedMatchesReference(unittest.TestCase):
    def test_crps_and_energy_score_equivalence_heterogeneous_horizons(self):
        rng = random.Random(99)
        o_df = oracle_frame()
        # Homogeneous + heterogeneous horizons across locations/dates, plus M=1/2/50/260
        rows = []
        for idx, ref in enumerate(WEEKS[:4]):
            for loc in LOCATIONS[:4]:
                hs = (0, 1) if (idx + LOCATIONS.index(loc)) % 3 == 0 else (0, 1, 2, 3)
                m = 1 if (loc == "02" and idx == 3) else 45
                for sid in range(m):
                    for h in hs:
                        if sid == 0 and h == 2 and loc == "01":
                            continue  # missing one horizon on one sample id
                        ted = ref + timedelta(weeks=h)
                        if ted not in WEEKS:
                            continue
                        val = truth_value(loc, ted) * rng.uniform(0.7, 1.3)
                        rows.append({
                            "target": TARGET,
                            "reference_date": ref.isoformat(),
                            "horizon": h,
                            "location": loc,
                            "target_end_date": ted.isoformat(),
                            "output_type": "sample",
                            "output_type_id": f"s{sid}",
                            "value": val,
                        })
        s_df = pl.DataFrame(rows, schema_overrides={"horizon": pl.Int32})
        got = score_sample_forecasts(s_df, o_df, TARGET, compute_energy_score=True, return_task_df=True)
        got_lazy = score_sample_forecasts(s_df.lazy(), o_df.lazy(), TARGET, compute_energy_score=True, return_task_df=True)
        assert_equivalent(self, {k: got[k] for k in ("overall", "by_horizon", "metadata")}, {k: got_lazy[k] for k in ("overall", "by_horizon", "metadata")})

        # Reference per-task CRPS via crps_ensemble_1d + naive energy_score
        merged = s_df.join(o_df.select(["target_end_date", "location", "oracle_value"]), on=["target_end_date", "location"], how="inner")
        ref_crps = {}
        for (rd, loc, h, ted), g in merged.group_by(["reference_date", "location", "horizon", "target_end_date"]):
            ref_crps[(rd, loc, int(h), ted)] = crps_ensemble_1d(g["value"].to_numpy(), float(g["oracle_value"][0]))
        for row in got["task_df"].iter_rows(named=True):
            key = (row["reference_date"], row["location"], int(row["horizon"]), row["target_end_date"])
            self.assertAlmostEqual(row["crps"], ref_crps[key], delta=1e-12 * max(1.0, abs(ref_crps[key])))

        # Reference naive Energy Score per (reference_date, location)
        ref_es = {}
        for (rd, loc), rg in merged.group_by(["reference_date", "location"], maintain_order=True):
            piv = rg.pivot(on="horizon", index="output_type_id", values="value", aggregate_function="first")
            h_cols = [c for c in piv.columns if c != "output_type_id"]
            if len(h_cols) < 2:
                continue
            piv_clean = piv.drop_nulls(subset=h_cols)
            if piv_clean.height < 2:
                continue
            obs_by_h = {str(r["horizon"]): float(r["oracle_value"]) for r in rg.select(["horizon", "oracle_value"]).unique().iter_rows(named=True)}
            mat = piv_clean.select(h_cols).to_numpy()
            y_vec = np.asarray([obs_by_h[hc] for hc in h_cols], dtype=np.float64)
            # Naive N^2 Energy Score
            t1 = float(np.mean(np.linalg.norm(mat - y_vec, axis=1)))
            t2 = 0.5 * float(np.mean(np.linalg.norm(mat[:, None, :] - mat[None, :, :], axis=2)))
            ref_es[(rd, loc)] = max(0.0, t1 - t2)
        for row in got["energy_df"].iter_rows(named=True):
            exp = ref_es[(row["reference_date"], row["location"])]
            self.assertAlmostEqual(row["energy_score"], exp, delta=1e-12 * max(1.0, abs(exp)))

        # Exercise energy_score chunked path (m > 256) vs exact N^2 formula
        mat_big = np.random.default_rng(1).normal(1000.0, 0.01, size=(270, 4))
        y_big = np.array([1000.0, 1000.0, 1000.0, 1000.0])
        exact_big = max(0.0, float(np.mean(np.linalg.norm(mat_big - y_big, axis=1))) - 0.5 * float(np.mean(np.linalg.norm(mat_big[:, None, :] - mat_big[None, :, :], axis=2))))
        self.assertAlmostEqual(energy_score(mat_big, y_big), exact_big, delta=1e-12)


class TestQuantileFastPathsAndLazyPushdown(unittest.TestCase):
    def test_score_task_wis_and_lazy_pushdown_match_score_forecasts(self):
        rng = random.Random(17)
        o_df = oracle_frame()
        f1 = random_forecasts(rng, WEEKS[:5], LOCATIONS, QUANTILES_23, skip=0.2)
        f2 = random_forecasts(rng, WEEKS[:5], LOCATIONS, QUANTILES_7, skip=0.3)

        locs = ["01", "02", "05"]
        refs = [WEEKS[1].isoformat(), WEEKS[3].isoformat()]
        hs = [0, 2]
        eager = score_forecasts(f1, o_df, TARGET, locations=locs, reference_dates=refs, horizons=hs, non_negative=True, return_task_df=True)
        lazy = score_forecasts(f1.lazy(), o_df.lazy(), TARGET, locations=locs, reference_dates=refs, horizons=hs, non_negative=True, return_task_df=True)
        for sec in ("overall", "states", "us", "by_horizon", "metadata"):
            assert_equivalent(self, lazy[sec], eager[sec], f"lazy.{sec}")

        # Single-model score_task_wis
        tw1 = score_task_wis(f1.lazy(), o_df, TARGET, locations=locs, reference_dates=refs, horizons=hs, non_negative=True)
        want1 = {
            (r["reference_date"], r["location"], int(r["horizon"]), r["target_end_date"]): r["wis"]
            for r in eager["task_df"].iter_rows(named=True)
        }
        for r in tw1.iter_rows(named=True):
            k = (r["reference_date"], r["location"], int(r["horizon"]), r["target_end_date"])
            self.assertAlmostEqual(r["wis"], want1[k], delta=1e-12)
        self.assertEqual(tw1.height, len(want1))

        # Batched multi-model score_task_wis with preserve_cols=["_mid"]
        eager2 = score_forecasts(f2, o_df, TARGET, locations=locs, reference_dates=refs, horizons=hs, non_negative=True, return_task_df=True)
        want2 = {
            (r["reference_date"], r["location"], int(r["horizon"]), r["target_end_date"]): r["wis"]
            for r in eager2["task_df"].iter_rows(named=True)
        }
        batch = pl.concat([f1.with_columns(pl.lit("m1").alias("_mid")), f2.with_columns(pl.lit("m2").alias("_mid"))])
        tw_batch = score_task_wis(batch, o_df, TARGET, locations=locs, reference_dates=refs, horizons=hs, non_negative=True, preserve_cols=["_mid"])
        self.assertEqual(tw_batch.height, len(want1) + len(want2))
        for r in tw_batch.iter_rows(named=True):
            ref_map = want1 if r["_mid"] == "m1" else want2
            k = (r["reference_date"], r["location"], int(r["horizon"]), r["target_end_date"])
            self.assertAlmostEqual(r["wis"], ref_map[k], delta=1e-12)

        # summarize_scored_tasks direct equivalence on overall vs states/us/by_horizon
        res_sum = summarize_scored_tasks(eager["task_df"], population_map=POPULATION)
        self.assertIsNotNone(res_sum["states"])
        self.assertAlmostEqual(res_sum["overall"]["wis"], res_sum["states"]["wis"], places=12)

    def test_pmf_all_zero_probabilities_hit_mode_is_zero(self):
        from viz.core.metrics import score_pmf_forecasts
        cats = ["decrease", "stable", "increase"]
        # Task predicts 0 mass across all categories while oracle is index 0 ("decrease")
        f_df = pl.DataFrame({
            "reference_date": ["2026-11-14"] * 3,
            "target": ["wk flu hosp rate change"] * 3,
            "horizon": [0, 0, 0],
            "target_end_date": ["2026-11-14"] * 3,
            "location": ["25"] * 3,
            "output_type": ["pmf"] * 3,
            "output_type_id": cats,
            "value": [0.0, 0.0, 0.0],
        })
        o_df = pl.DataFrame({
            "target": ["wk flu hosp rate change"],
            "location": ["25"],
            "target_end_date": ["2026-11-14"],
            "oracle_value": [1.0],
            "output_type": ["pmf"],
            "output_type_id": ["decrease"],
        })
        res = score_pmf_forecasts(
            f_df, o_df, "wk flu hosp rate change",
            categories=cats,
        )
        self.assertAlmostEqual(res["overall"]["hit_mode"], 0.0, places=6)


if __name__ == "__main__":
    unittest.main()
