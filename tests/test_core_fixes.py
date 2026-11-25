"""Regression tests for core fixes: YAML continuation, metadata/scan caching, ingest, heatmap, memos, matching."""

from datetime import date, timedelta
import logging
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest
from unittest import mock

import polars as pl

import conftest  # noqa: F401
from conftest import SYNTH_LOCATIONS, SYNTH_QUANTILES, SYNTH_SEASONS, SYNTH_TARGET, build_synthetic_hub
from viz.core import briefing_feeds, metrics
from viz.core.briefing_feeds import BriefingFeedStore
from viz.core.calendar import CalendarSpec, infer_calendar, target_name_implies_monthly, target_tokens
from viz.core.config import VizConfig
from viz.core.data_loader import SandboxDataLoader
from viz.core.ingest import NormalizationError, normalize_forecast_frame
from viz.core.truth import _match_wide_column_to_target
from viz.core.yaml_lite import parse_yaml_mapping


class TestYamlLite(unittest.TestCase):
    def test_wrapped_plain_scalar_keeps_dash_and_colon_lines(self):
        doc = (
            "team_name: T\n"
            "methods_long: Steps\n  - fit model\n  - ensemble\n"
            "data_inputs: This model uses\n  Note: data from NHSN\n  weekly\n"
            "license: CC-BY-4.0\n"
        )
        out = parse_yaml_mapping(doc)
        self.assertEqual(out["methods_long"], "Steps - fit model - ensemble")
        self.assertEqual(out["data_inputs"], "This model uses Note: data from NHSN weekly")
        self.assertEqual(out["license"], "CC-BY-4.0")
        self.assertNotIn("Note", out)

    def test_block_structures_still_parse(self):
        doc = (
            "model_contributors:\n"
            "  -   name: A\n      affiliation: U\n"
            "  - name: B long\n      wrapped\n    affiliation: V\n"
            "nested:\n  inner: 1\n  list:\n  - x\n  - y\n"
            "after: 2\n"
        )
        out = parse_yaml_mapping(doc)
        self.assertEqual(
            out["model_contributors"],
            [{"name": "A", "affiliation": "U"}, {"name": "B long wrapped", "affiliation": "V"}],
        )
        self.assertEqual(out["nested"], {"inner": 1, "list": ["x", "y"]})
        self.assertEqual(out["after"], 2)

    def test_keys_with_spaces_unicode_and_tab_indented_lists(self):
        out = parse_yaml_mapping("team name: X\néquipe: Y\n\"quoted key\": Z\na:\n\t- x\n\t- y\nb: 1\n")
        self.assertEqual(out["team name"], "X")
        self.assertEqual(out["équipe"], "Y")
        self.assertEqual(out["quoted key"], "Z")
        self.assertEqual(out["a"], ["x", "y"])
        self.assertEqual(out["b"], 1)

    def test_apostrophe_in_unquoted_flow_value_is_literal(self):
        doc = (
            "model_contributors: [\n  {name: O'Brien, affiliation: U},\n  {name: 'it''s', affiliation: V}\n]\n"
            "license: CC-BY-4.0\ndesignated_model: true\n"
        )
        out = parse_yaml_mapping(doc)
        self.assertEqual(
            out["model_contributors"],
            [{"name": "O'Brien", "affiliation": "U"}, {"name": "it's", "affiliation": "V"}],
        )
        self.assertEqual(out["license"], "CC-BY-4.0")
        self.assertIs(out["designated_model"], True)

    def test_continuation_parsing_stays_linear(self):
        def elapsed(n: int) -> float:
            doc = "a: x\n" + "  - more: words words\n" * n + "b: 1\n"
            t0 = time.perf_counter()
            out = parse_yaml_mapping(doc)
            self.assertEqual(out["b"], 1)
            return time.perf_counter() - t0

        small, big = elapsed(2000), elapsed(40000)
        self.assertLess(big, max(1.0, small * 60))


class _HubTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="viz-core-fixes-")).resolve()
        self.hub = build_synthetic_hub(self.tmp / "hub")
        self.loader = SandboxDataLoader(
            self.hub, include_remote=False, cache_dir=self.tmp / "cache", surveillance_dir=self.tmp / "surv"
        )

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_model(self, root: str, name: str, horizons=(0, 1), scale: float = 1.0) -> Path:
        d = self.hub / root / name
        d.mkdir(parents=True, exist_ok=True)
        ref = SYNTH_SEASONS["2024-2025"][3]
        rows = []
        for loc, *_ in SYNTH_LOCATIONS:
            for h in horizons:
                for q in SYNTH_QUANTILES:
                    rows.append({
                        "reference_date": ref.isoformat(),
                        "target": SYNTH_TARGET,
                        "horizon": h,
                        "target_end_date": (ref + timedelta(weeks=h)).isoformat(),
                        "location": loc,
                        "output_type": "quantile",
                        "output_type_id": q,
                        "value": 100.0 * scale * (0.5 + q),
                    })
        path = d / f"{ref.isoformat()}-{name}.csv"
        pl.DataFrame(rows).write_csv(path)
        return path


class TestMetadataAndInventoryCaching(_HubTestCase):
    def test_oversized_metadata_is_cached_and_warned_once(self):
        mid = next(iter(self.loader.scan_models()))
        meta_path = self.hub / "model-metadata" / f"{mid}.yml"
        meta_path.write_text("team_name: Big\nmethods: " + "x" * 70000 + "\n", encoding="utf-8")
        with self.assertLogs("viz.data_loader", level=logging.WARNING) as logs:
            first = self.loader.get_model_metadata(mid)
            second = self.loader.get_model_metadata(mid)
            logging.getLogger("viz.data_loader").warning("sentinel")
        oversized = [r for r in logs.output if "oversized" in r]
        self.assertEqual(len(oversized), 1)
        self.assertFalse(first["has_metadata_file"])
        self.assertEqual(first, second)

        meta_path.write_text("team_name: Small Team\n", encoding="utf-8")
        self.assertEqual(self.loader.get_model_metadata(mid)["team_name"], "Small Team")

    def test_scan_models_single_walk_ttl_and_structural_changes(self):
        self.loader.scan_models()
        walk = mock.patch.object(self.loader, "_walk_models_dirs", wraps=self.loader._walk_models_dirs)
        with walk as walked, mock.patch.object(self.loader, "_MODELS_DIR_SIG_TTL_S", 60.0):
            self.loader.scan_models()
            self.loader._compute_models_mtime()
            self.assertEqual(walked.call_count, 0, "TTL'd signature must not re-walk per call")

            # A new model folder changes the directory probe: picked up immediately, with ONE walk
            self._write_model("model-output", "Fresh-model")
            self.assertIn("Fresh-model", self.loader.scan_models())
            self.assertEqual(walked.call_count, 1)

            # In-place edit of an existing file is picked up once the TTL lapses
            path = self.hub / "model-output" / "Fresh-model" / f"{SYNTH_SEASONS['2024-2025'][3].isoformat()}-Fresh-model.csv"
            before = self.loader._models_dir_sig
            time.sleep(0.02)
            with open(path, "a", encoding="utf-8") as fh:  # in place: the folder mtime is unchanged
                fh.write("\n")
            self.loader.scan_models()
            self.assertEqual(self.loader._models_dir_sig, before)
            stamp, probe, sig, mtime = self.loader._models_dir_state_cache
            self.loader._models_dir_state_cache = (stamp - 120.0, probe, sig, mtime)
            self.loader.scan_models()
            self.assertNotEqual(self.loader._models_dir_sig, before)

    def test_rebuild_does_not_block_readers(self):
        models = self.loader.scan_models()
        mid = next(m for m in models if not models[m].get("is_synthetic"))
        started, release = threading.Event(), threading.Event()
        real_build = self.loader._build_models_inventory

        def slow_build():
            started.set()
            release.wait(10)
            return real_build()

        with mock.patch.object(self.loader, "_build_models_inventory", side_effect=slow_build):
            builder = threading.Thread(target=lambda: self.loader.scan_models(force_refresh=True))
            builder.start()
            try:
                self.assertTrue(started.wait(10))
                self.loader._models_dir_sig = ("stale",)  # readers now see a signature mismatch
                t0 = time.perf_counter()
                self.assertIs(self.loader.scan_models(), models)
                self.assertEqual(self.loader._resolve_model_id_and_local(mid), (mid, False))
                self.assertLess(time.perf_counter() - t0, 2.0)
            finally:
                release.set()
                builder.join(10)
        self.assertIsNot(self.loader.scan_models(), models)

    def test_resolve_model_id_refreshes_stale_inventory(self):
        self.loader.scan_models()
        self._write_model("local-output", "Only-local")
        self.assertEqual(self.loader._resolve_model_id_and_local("Only-local"), ("Only-local", True))

    def test_get_model_parquet_scans_once_and_keys_on_source_dir(self):
        mid = next(m for m, i in self.loader.scan_models().items() if not i.get("is_synthetic"))
        cm = self.loader.cache_mgr
        with mock.patch.object(type(cm), "_scan_source_dir", wraps=type(cm)._scan_source_dir) as scans:
            cm.invalidate_fresh_cache()
            self.assertIsNotNone(cm.get_model_parquet(mid))
            self.assertEqual(scans.call_count, 1)
            self.assertIsNotNone(cm.get_model_parquet(mid))
            self.assertEqual(scans.call_count, 2)
        src = str(self.hub / "model-output" / mid)
        self.assertTrue(any(k.startswith("q::") and k.endswith(src) for k in cm._fresh_pq_cache))


class TestHeatmapFairNowcastOnly(_HubTestCase):
    def test_nowcast_only_model_does_not_blank_fair_heatmap(self):
        d = self.hub / "model-output" / "Nowcast-only"
        d.mkdir(parents=True)
        for ref in SYNTH_SEASONS["2024-2025"][1:7]:
            rows = [
                {
                    "reference_date": ref.isoformat(), "target": SYNTH_TARGET, "horizon": -1,
                    "target_end_date": (ref - timedelta(weeks=1)).isoformat(), "location": loc,
                    "output_type": "quantile", "output_type_id": q, "value": 50.0 + 100.0 * q,
                }
                for loc, *_ in SYNTH_LOCATIONS for q in SYNTH_QUANTILES
            ]
            pl.DataFrame(rows).write_csv(d / f"{ref.isoformat()}-Nowcast-only.csv")
        kwargs = dict(rows="model", cols="location", metric="wis", location="states", season="2024-2025",
                      horizon="all", fair=True)
        base = self.loader.get_heatmap_data(model_ids=["Model-Alpha", "Model-Beta"], **kwargs)
        with_nowcast = self.loader.get_heatmap_data(model_ids=["Model-Alpha", "Model-Beta", "Nowcast-only"], **kwargs)
        self.assertGreater(with_nowcast["cell_meta"]["Model-Alpha:WA"]["task_count"], 0)
        for key in ("Model-Alpha:WA", "Model-Beta:WA", "Model-Alpha:CA"):
            self.assertEqual(with_nowcast["cell_meta"][key]["task_count"], base["cell_meta"][key]["task_count"])


class TestIngestRowLevelResolution(unittest.TestCase):
    def _frame(self, target, ref, teds):
        return pl.DataFrame({
            "reference_date": [ref] * len(teds),
            "target": [target] * len(teds),
            "horizon": [None] * len(teds),
            "target_end_date": teds,
            "location": ["US"] * len(teds),
            "output_type": ["quantile"] * len(teds),
            "output_type_id": ["0.5"] * len(teds),
            "value": [10.0] * len(teds),
        }, schema_overrides={"horizon": pl.Int32})

    def test_off_cadence_rows_are_dropped_with_warning(self):
        df = self._frame("wk inc flu hosp", "2025-11-22", ["2025-11-22", "2025-11-29", "2025-11-26"])
        res = normalize_forecast_frame(df, model="M", reference_date="2025-11-22", calendar=CalendarSpec())
        self.assertEqual(sorted(res.quantiles["horizon"].to_list()), [0, 1])
        self.assertTrue(any("dropped 1 step-ahead row" in w for w in res.info["warnings"]))
        with self.assertRaises(NormalizationError):
            normalize_forecast_frame(self._frame("wk inc flu hosp", "2025-11-22", ["2025-11-26"]),
                                     model="M", reference_date="2025-11-22")

    def test_monthly_detection_by_name_and_configured_time_unit(self):
        teds = ["2024-02-29", "2024-03-31"]
        res = normalize_forecast_frame(self._frame("monthly cases", "2024-01-31", teds),
                                       model="M", reference_date="2024-01-31", calendar=CalendarSpec())
        self.assertEqual(sorted(res.quantiles["horizon"].to_list()), [1, 2])

        # Configured time unit wins over the name: "wk cases" stepping monthly, "mo cases" stepping weekly
        res_cfg = normalize_forecast_frame(self._frame("wk cases", "2024-01-31", teds), model="M",
                                           reference_date="2024-01-31", calendar=CalendarSpec(),
                                           time_unit_for=lambda t: "month")
        self.assertEqual(sorted(res_cfg.quantiles["horizon"].to_list()), [1, 2])
        res_wk = normalize_forecast_frame(self._frame("mo cases", "2024-01-06", ["2024-01-13"]), model="M",
                                          reference_date="2024-01-06", calendar=CalendarSpec(),
                                          time_unit_for=lambda t: "week")
        self.assertEqual(res_wk.quantiles["horizon"].to_list(), [1])

    def test_config_exposes_time_unit(self):
        tmp = Path(tempfile.mkdtemp(prefix="viz-cfg-"))
        try:
            cfg = VizConfig(build_synthetic_hub(tmp / "hub"))
            self.assertEqual(cfg.get_target_time_unit("monthly cases"), "month")
            self.assertEqual(cfg.get_target_time_unit(SYNTH_TARGET), "week")
            self.assertEqual(cfg.get_target_metadata("mo inc dengue cases")["time_unit"], "month")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestOracleMemoBounded(unittest.TestCase):
    def test_memo_cap_and_identity_hits(self):
        def oracle(v: float) -> pl.DataFrame:
            return pl.DataFrame({"target": [SYNTH_TARGET], "location": ["US"], "target_end_date": ["2024-01-06"],
                                 "output_type_id": ["stable"], "oracle_value": [v]})

        frames = [oracle(float(i)) for i in range(8)]
        for o in frames:
            metrics._prepared_oracle(o, SYNTH_TARGET)
            metrics._prepared_pmf_oracle(o, SYNTH_TARGET)
        self.assertLessEqual(len(metrics._ORACLE_MEMO), 4)
        self.assertLessEqual(len(metrics._PMF_ORACLE_MEMO), 4)
        a, _ = metrics._prepared_oracle(frames[-1], SYNTH_TARGET)
        b, _ = metrics._prepared_oracle(frames[-1], SYNTH_TARGET)
        self.assertIs(a, b)
        self.assertEqual(a["oracle_value"].to_list(), [7.0])


class TestTokenMatching(unittest.TestCase):
    def test_wide_truth_count_column_never_maps_to_proportion_target(self):
        targets = ["wk inc flu hosp", "wk inc flu prop ed visits"]
        self.assertIsNone(_match_wide_column_to_target("influenza_ed_visits", targets))
        self.assertEqual(_match_wide_column_to_target("influenza_pct_ed_visits", targets), "wk inc flu prop ed visits")
        self.assertEqual(_match_wide_column_to_target("flu_admissions", targets), "wk inc flu hosp")

    def test_rt_is_matched_as_a_token(self):
        self.assertEqual(VizConfig._clean_short_target("wk inc r_t", "rate", None), "Effective Rₜ")
        self.assertNotEqual(VizConfig._clean_short_target("deaths per_thousand", "count", None), "Effective Rₜ")
        tmp = Path(tempfile.mkdtemp(prefix="viz-cfg-"))
        try:
            cfg = VizConfig(build_synthetic_hub(tmp / "hub"))
            self.assertEqual(cfg.get_target_metadata("wk r_t")["unit"], "Rₜ")
            self.assertNotEqual(cfg.get_target_metadata("wk deaths per_thousand")["unit"], "Rₜ")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_calendar_ili_ari_tokens(self):
        self.assertEqual(target_tokens("wk inc ili_ed"), {"wk", "inc", "ili", "ed"})
        self.assertTrue(target_name_implies_monthly("monthly cases"))
        self.assertFalse(target_name_implies_monthly("wk inc mortality"))
        outbreak = ["wk inc dengue cases", "wk variant mobility index"]
        self.assertEqual(infer_calendar(None, targets=outbreak).season_mode, "continuous")
        self.assertEqual(infer_calendar(None, targets=["wk inc dengue cases", "wk inc ili"]).season_mode,
                         "respiratory_nh")


class TestBriefingFeedShrinkGuard(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="viz-feed-shrink-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_sharp_row_drop_keeps_previous_cache(self):
        fid = "cdc_nwss"
        size = {"n": 200}

        def fake(_fetcher):
            n = size["n"]
            start = date(2026, 1, 3)
            return pl.DataFrame({"week_end": [(start + timedelta(weeks=i % 40)).isoformat() for i in range(n)],
                                 "value": [float(i) for i in range(n)]}), None

        store = BriefingFeedStore(self.tmp, fetcher=lambda url, timeout: b"")
        with mock.patch.dict(briefing_feeds._FEED_CHECKED_FETCHERS, {fid: fake}):
            self.assertEqual(store.refresh_sync([fid], force=True)["feeds"][fid]["rows"], 200)
            size["n"] = 60
            st = store.refresh_sync([fid], force=True)["feeds"][fid]
            self.assertIn("suspected schema change", st["error"])
            self.assertEqual(st["rows"], 200)
            self.assertEqual(store.read_feed(fid).height, 200)
            self.assertTrue(store.get_status()["feeds"][fid]["cached"])
            size["n"] = 150
            st = store.refresh_sync([fid], force=True)["feeds"][fid]
            self.assertEqual(st["rows"], 150)
            self.assertIsNone(st["error"])


if __name__ == "__main__":
    unittest.main()
