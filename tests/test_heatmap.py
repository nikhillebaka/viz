"""
Unit and integration tests for Heatmap View:
- DataLoader.get_heatmap_data (rows/cols matrix modes, normalizations, grouping,
  inactive-model segregation, shoulder-date pruning, fair shared-task comparison)
- HTTP endpoints (/api/next/heatmap and legacy /api/heatmap)
"""

import http.client
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import urllib.parse

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from conftest import SYNTH_TARGET, build_synthetic_hub, start_test_server  # noqa: E402
from viz.core.data_loader import HHS_REGIONS, STATE_TO_HHS_REGION, SandboxDataLoader  # noqa: E402


class TestHeatmapDataLoader(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = Path(tempfile.mkdtemp(prefix="viz-hm-loader-")).resolve()
        cls.hub_dir = build_synthetic_hub(cls._tmp / "hub")
        cls.loader = SandboxDataLoader(
            cls.hub_dir,
            include_remote=False,
            cache_dir=cls._tmp / "cache",
            surveillance_dir=cls._tmp / "surv",
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def test_hhs_regions_mapping(self):
        """Verify HHS Regions structure and state-to-region mapping."""
        self.assertEqual(len(HHS_REGIONS), 10)
        expected = {
            "MA": 1, "NY": 2, "PA": 3, "GA": 4, "IL": 5,
            "TX": 6, "MO": 7, "CO": 8, "CA": 9, "WA": 10,
        }
        for abbr, reg in expected.items():
            self.assertEqual(STATE_TO_HHS_REGION.get(abbr), reg)

    def test_wave_matrix_normalizations_season_and_shoulder_pruning(self):
        """Verify wave matrix normalizations, season scoping, and empty-shoulder pruning."""
        res_rm = self.loader.get_heatmap_data(
            rows="location",
            cols="date",
            target=SYNTH_TARGET,
            metric="rate",
            season="2024-2025",
            sort_by="peak_timing",
            normalize="row_min_max",
        )
        for key in ("x_labels", "y_labels", "matrix", "raw_matrix", "text_matrix", "summary", "row_groups"):
            self.assertIn(key, res_rm)
        self.assertGreater(len(res_rm["x_labels"]), 0)
        self.assertGreater(len(res_rm["y_labels"]), 0)
        self.assertEqual(len(res_rm["matrix"]), len(res_rm["y_labels"]))
        self.assertEqual(len(res_rm["matrix"][0]), len(res_rm["x_labels"]))

        for row in res_rm["matrix"]:
            vals = [v for v in row if v is not None]
            if len(vals) > 1 and max(vals) > min(vals):
                self.assertAlmostEqual(max(vals), 1.0, places=4)
                self.assertAlmostEqual(min(vals), 0.0, places=4)

        res_pct = self.loader.get_heatmap_data(
            rows="location",
            cols="date",
            target=SYNTH_TARGET,
            metric="admissions",
            season="2024-2025",
            sort_by="magnitude",
            normalize="percentile",
        )
        all_pct = [v for row in res_pct["matrix"] for v in row if v is not None]
        self.assertTrue(all_pct)
        self.assertGreaterEqual(min(all_pct), 0.0)
        self.assertLessEqual(max(all_pct), 1.0)
        for d in res_pct["x_keys"]:
            self.assertEqual(self.loader.get_season_for_date(d), "2024-2025")

        # FluSight-baseline only forecasts indices 1..6 of 10 oracle weeks -> shoulder weeks prune away
        res_pruned = self.loader.get_heatmap_data(
            rows="location",
            cols="date",
            target=SYNTH_TARGET,
            season="2024-2025",
            model_id="FluSight-baseline",
        )
        raw = res_pruned["raw_matrix"]
        self.assertTrue(any(raw[r][0] is not None for r in range(len(raw))))
        self.assertTrue(any(raw[r][-1] is not None for r in range(len(raw))))
        self.assertLess(len(res_pruned["x_keys"]), 10)

    def test_hhs_region_y_labels_and_grouping(self):
        """Sorting by HHS region populates row_groups and keeps y_labels clean."""
        res = self.loader.get_heatmap_data(
            rows="location",
            cols="date",
            target=SYNTH_TARGET,
            sort_by="hhs_region",
        )
        self.assertGreater(len(res["row_groups"]), 0)
        first_grp = res["row_groups"][0]
        self.assertIn("Region", first_grp["label"])
        self.assertIn("start_idx", first_grp)
        self.assertIn("end_idx", first_grp)
        self.assertFalse(any("[Reg " in lbl for lbl in res["y_labels"]))

    def test_model_and_horizon_cross_sections(self):
        """Exercise location x horizon, model x location, model x horizon, and model x date."""
        loc_h = self.loader.get_heatmap_data(
            rows="location",
            cols="horizon",
            target=SYNTH_TARGET,
            date="2024-01-13",
            model_id="Model-Alpha",
            sort_by="alphabetical",
            normalize="none",
        )
        self.assertEqual(len(loc_h["x_labels"]), 4)
        self.assertGreater(len(loc_h["y_labels"]), 0)

        m_loc = self.loader.get_heatmap_data(
            rows="model",
            cols="location",
            target=SYNTH_TARGET,
            date="2024-01-13",
            horizon=1,
            model_ids=["Model-Alpha", "Model-Beta"],
            normalize="none",
        )
        self.assertEqual(len(m_loc["y_labels"]), 2)

        m_h = self.loader.get_heatmap_data(
            rows="model",
            cols="horizon",
            target=SYNTH_TARGET,
            date="2024-01-13",
            model_ids=["Model-Alpha", "Model-Beta"],
            normalize="none",
        )
        self.assertEqual(len(m_h["x_labels"]), 4)

        m_date = self.loader.get_heatmap_data(
            rows="model",
            cols="date",
            target=SYNTH_TARGET,
            season="2024-2025",
            horizon=1,
            model_ids=["Model-Alpha", "Model-Beta"],
            normalize="none",
        )
        self.assertGreater(len(m_date["x_labels"]), 0)
        self.assertEqual(len(m_date["y_labels"]), 2)

    def test_inactive_models_filtering_and_partitioning(self):
        """Inactive 2023-2024-only model is segregated unless include_inactive=True."""
        res_active = self.loader.get_heatmap_data(
            rows="model",
            cols="horizon",
            target=SYNTH_TARGET,
            season="2024-2025",
            include_inactive=False,
        )
        inactive_ids = {im["id"] for im in res_active["inactive_models"]}
        self.assertIn("Model-Legacy", inactive_ids)
        self.assertNotIn("Model-Legacy", res_active["y_keys"])
        for row in res_active["raw_matrix"]:
            self.assertTrue(any(v is not None for v in row))
        for im in res_active["inactive_models"]:
            self.assertTrue(im.get("reason"))
            self.assertIn("seasons", im)

        res_all = self.loader.get_heatmap_data(
            rows="model",
            cols="horizon",
            target=SYNTH_TARGET,
            season="2024-2025",
            include_inactive=True,
        )
        total = len(res_all["y_keys"])
        inactive_count = len(res_all["inactive_models"])
        active_count = total - inactive_count
        self.assertGreater(active_count, 0)
        self.assertGreater(inactive_count, 0)
        for idx in range(active_count, total):
            self.assertTrue(res_all["y_labels"][idx].startswith("[No Data] "))

    def test_fair_shared_tasks_model_loc(self):
        """With fair=True, model_loc compares models strictly on shared (loc, ref_date, horizon) tasks."""
        unfair = self.loader.get_heatmap_data(
            rows="model",
            cols="location",
            metric="wis",
            location="states",
            season="2024-2025",
            horizon="all",
            model_ids=["Model-Alpha", "Model-Beta"],
            fair=False,
        )
        fair = self.loader.get_heatmap_data(
            rows="model",
            cols="location",
            metric="wis",
            location="states",
            season="2024-2025",
            horizon="all",
            model_ids=["Model-Alpha", "Model-Beta"],
            fair=True,
        )
        self.assertEqual(unfair["cell_meta"]["Model-Alpha:WA"]["task_count"], 24)
        self.assertEqual(unfair["cell_meta"]["Model-Beta:WA"]["task_count"], 20)
        for abbr in fair["x_keys"]:
            ca = fair["cell_meta"].get(f"Model-Alpha:{abbr}", {}).get("task_count", 0)
            cb = fair["cell_meta"].get(f"Model-Beta:{abbr}", {}).get("task_count", 0)
            self.assertEqual(ca, cb, f"Shared task counts must match in {abbr} (Alpha={ca}, Beta={cb})")
        self.assertEqual(fair["cell_meta"]["Model-Alpha:WA"]["task_count"], 20)


class TestHeatmapServerAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = Path(tempfile.mkdtemp(prefix="viz-hm-srv-")).resolve()
        cls.hub_dir = build_synthetic_hub(cls._tmp / "hub")
        cls._srv_ctx = start_test_server([cls.hub_dir])
        cls.port, cls.mgr = cls._srv_ctx.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls._srv_ctx.__exit__(None, None, None)
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def _get(self, path: str, query: dict | None = None) -> tuple[int, dict]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        url = f"{path}?{urllib.parse.urlencode(query)}" if query else path
        try:
            conn.request("GET", url)
            resp = conn.getresponse()
            return resp.status, json.loads(resp.read().decode("utf-8"))
        finally:
            conn.close()

    def test_api_next_heatmap_axes_transpose_and_scope(self):
        status, data = self._get("/api/next/heatmap", {
            "rows": "location",
            "cols": "date",
            "target": SYNTH_TARGET,
            "metric": "rate",
            "season": "2024-2025",
            "sort_by": "hhs_region",
            "normalize": "row_min_max",
        })
        self.assertEqual(status, 200)
        self.assertEqual(data["mode"], "wave")
        self.assertEqual(data["normalize"], "row_min_max")
        self.assertGreater(len(data["x_labels"]), 0)

        t_status, transposed = self._get("/api/next/heatmap", {
            "rows": "date",
            "cols": "location",
            "target": SYNTH_TARGET,
            "season": "2024-2025",
        })
        self.assertEqual(t_status, 200)
        self.assertEqual(transposed["rows"], "date")
        self.assertEqual(transposed["cols"], "location")
        self.assertIn("-", transposed["y_keys"][0])
        self.assertLessEqual(len(transposed["x_keys"][0]), 3)

        s_status, scoped = self._get("/api/next/heatmap", {
            "rows": "model",
            "cols": "location",
            "metric": "wis",
            "target": SYNTH_TARGET,
            "season": "2024-2025",
            "horizons": "0,1",
            "dates": "2025-01-04,2025-01-11",
            "models": "Model-Alpha,Model-Beta",
        })
        self.assertEqual(s_status, 200)
        self.assertEqual(scoped["cell_meta"]["Model-Alpha:CA"]["task_count"], 4)

    def test_api_next_heatmap_location_and_multi_season(self):
        status, single_loc = self._get("/api/next/heatmap", {
            "rows": "location",
            "cols": "date",
            "location": "CA",
            "season": "2024-2025",
        })
        self.assertEqual(status, 200)
        self.assertEqual(single_loc["y_keys"], ["CA"])
        self.assertEqual(len(single_loc["matrix"]), 1)

        m_status, multi = self._get("/api/next/heatmap", {
            "rows": "location",
            "cols": "date",
            "season": "2023-2024,2024-2025",
        })
        self.assertEqual(m_status, 200)
        self.assertGreaterEqual(len(multi["x_keys"]), 12)

    def test_api_next_heatmap_include_inactive(self):
        st_act, data_active = self._get("/api/next/heatmap", {
            "rows": "model",
            "cols": "horizon",
            "season": "2024-2025",
            "include_inactive": "0",
        })
        self.assertEqual(st_act, 200)
        self.assertGreater(len(data_active["inactive_models"]), 0)

        st_all, data_all = self._get("/api/next/heatmap", {
            "rows": "model",
            "cols": "horizon",
            "season": "2024-2025",
            "include_inactive": "1",
        })
        self.assertEqual(st_all, 200)
        self.assertEqual(
            len(data_all["y_keys"]),
            len(data_active["y_keys"]) + len(data_active["inactive_models"]),
        )

    def test_api_legacy_heatmap_route_compatibility(self):
        status, data = self._get("/api/heatmap", {
            "mode": "wave",
            "season": "2024-2025",
            "normalize": "row_min_max",
        })
        self.assertEqual(status, 200)
        self.assertEqual(data["mode"], "wave")
        self.assertGreater(len(data["matrix"]), 0)


if __name__ == "__main__":
    unittest.main()
