"""
Unit and integration tests for Heatmap View:
- DataLoader.get_heatmap_data (all 5 matrix modes, sorting algorithms, normalizations)
- HTTP Server endpoint /api/heatmap
"""

import http.client
import json
from pathlib import Path
import socketserver
import threading
import time
import unittest
import urllib.parse

from viz.data_loader import SandboxDataLoader, HHS_REGIONS, STATE_TO_HHS_REGION
from viz.server import SandboxRequestHandler

BASE_DIR = Path(__file__).resolve().parent.parent.parent


class TestHeatmapDataLoader(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.loader = SandboxDataLoader(BASE_DIR)

    def test_hhs_regions_mapping(self):
        """Verify HHS Regions structure and complete state mapping."""
        self.assertEqual(len(HHS_REGIONS), 10)
        # Check that common states are properly mapped
        self.assertEqual(STATE_TO_HHS_REGION.get("MA"), 1)
        self.assertEqual(STATE_TO_HHS_REGION.get("NY"), 2)
        self.assertEqual(STATE_TO_HHS_REGION.get("PA"), 3)
        self.assertEqual(STATE_TO_HHS_REGION.get("GA"), 4)
        self.assertEqual(STATE_TO_HHS_REGION.get("IL"), 5)
        self.assertEqual(STATE_TO_HHS_REGION.get("TX"), 6)
        self.assertEqual(STATE_TO_HHS_REGION.get("MO"), 7)
        self.assertEqual(STATE_TO_HHS_REGION.get("CO"), 8)
        self.assertEqual(STATE_TO_HHS_REGION.get("CA"), 9)
        self.assertEqual(STATE_TO_HHS_REGION.get("WA"), 10)

    def test_mode_wave_basic(self):
        """Test Wave mode (Location x Date) matrix generation."""
        res = self.loader.get_heatmap_data(
            mode="wave",
            target="wk inc flu hosp",
            metric="rate",
            season="2024-2025",
            sort_by="hhs_region",
            normalize="none",
        )
        self.assertIn("x_labels", res)
        self.assertIn("y_labels", res)
        self.assertIn("matrix", res)
        self.assertIn("raw_matrix", res)
        self.assertIn("text_matrix", res)
        self.assertIn("summary", res)
        self.assertIn("row_groups", res)

        self.assertGreater(len(res["x_labels"]), 0, "Should have dates along x-axis")
        self.assertGreater(len(res["y_labels"]), 0, "Should have locations along y-axis")
        self.assertEqual(len(res["matrix"]), len(res["y_labels"]))
        if len(res["matrix"]) > 0:
            self.assertEqual(len(res["matrix"][0]), len(res["x_labels"]))

    def test_mode_wave_row_min_max_normalization(self):
        """Test that row_min_max normalizes row values to [0.0, 1.0]."""
        res = self.loader.get_heatmap_data(
            mode="wave",
            target="wk inc flu hosp",
            metric="rate",
            season="2024-2025",
            sort_by="peak_timing",
            normalize="row_min_max",
        )
        z = res["matrix"]
        for row in z:
            valid_vals = [v for v in row if v is not None]
            if len(valid_vals) > 0 and max(valid_vals) > min(valid_vals):
                self.assertAlmostEqual(max(valid_vals), 1.0, places=4)
                self.assertAlmostEqual(min(valid_vals), 0.0, places=4)

    def test_mode_wave_percentile_normalization(self):
        """Test that percentile normalizes non-null values to [0.0, 1.0]."""
        res = self.loader.get_heatmap_data(
            mode="wave",
            target="wk inc flu hosp",
            metric="admissions",
            season="2024-2025",
            sort_by="magnitude",
            normalize="percentile",
        )
        z = res["matrix"]
        all_vals = [v for row in z for v in row if v is not None]
        if all_vals:
            self.assertGreaterEqual(min(all_vals), 0.0)
            self.assertLessEqual(max(all_vals), 1.0)

    def test_mode_wave_season_filter(self):
        """Test that season parameter scopes dates correctly."""
        res_24_25 = self.loader.get_heatmap_data(
            mode="wave",
            target="wk inc flu hosp",
            season="2024-2025",
        )
        self.assertGreater(len(res_24_25["x_labels"]), 0)
        # All returned dates should belong to 2024-2025 season
        for d in res_24_25["x_labels"]:
            self.assertEqual(self.loader.get_flu_season_for_date(d), "2024-2025")

    def test_mode_horizon(self):
        """Test Horizon mode (Location x Horizon 0-3)."""
        res = self.loader.get_heatmap_data(
            mode="horizon",
            target="wk inc flu hosp",
            date="2024-01-13",
            model="UMass-flusion_spatial2_prod",
            sort_by="alphabetical",
            normalize="none",
        )
        self.assertIn("x_labels", res)
        # Should have 4 horizon columns: 0, 1, 2, 3
        self.assertTrue(any("h=0" in x or "0" in x for x in res["x_labels"]))
        self.assertGreater(len(res["y_labels"]), 0)

    def test_mode_model_loc(self):
        """Test Model Comparison across Locations mode."""
        res = self.loader.get_heatmap_data(
            mode="model_loc",
            target="wk inc flu hosp",
            date="2024-01-13",
            horizon=1,
            models=["UMass-flusion_spatial2_prod", "UMass-AR6_pooled"],
            normalize="none",
        )
        self.assertIn("y_labels", res)
        self.assertIn("x_labels", res)
        self.assertLessEqual(len(res["y_labels"]), 2)

    def test_mode_model_h(self):
        """Test Horizon Decay mode (Model x Horizon)."""
        res = self.loader.get_heatmap_data(
            mode="model_h",
            target="wk inc flu hosp",
            date="2024-01-13",
            models=["UMass-flusion_spatial2_prod", "UMass-AR6_pooled"],
            normalize="none",
        )
        self.assertIn("x_labels", res)
        self.assertEqual(len(res["x_labels"]), 4)  # 0, 1, 2, 3

    def test_mode_model_date(self):
        """Test Forecast Timeline across Dates mode."""
        res = self.loader.get_heatmap_data(
            mode="model_date",
            target="wk inc flu hosp",
            season="2024-2025",
            horizon=1,
            models=["UMass-flusion_spatial2_prod", "UMass-AR6_pooled"],
            normalize="none",
        )
        self.assertIn("x_labels", res)
        self.assertIn("y_labels", res)
        self.assertGreater(len(res["x_labels"]), 0)

    def test_shoulder_date_pruning(self):
        """Test that empty leading and trailing shoulder dates are pruned while internal dates remain."""
        res = self.loader.get_heatmap_data(
            rows="location",
            cols="date",
            target="wk inc flu hosp",
            season="2024-2025",
            model_id="FluSight-baseline",
        )
        raw = res["raw_matrix"]
        x_keys = res["x_keys"]
        self.assertGreater(len(x_keys), 0)
        # Verify that first date column and last date column have at least one non-null value
        first_col_has_data = any(raw[r][0] is not None for r in range(len(raw)))
        last_col_has_data = any(raw[r][-1] is not None for r in range(len(raw)))
        self.assertTrue(first_col_has_data, "First date column should have data (shoulder pruned)")
        self.assertTrue(last_col_has_data, "Last date column should have data (shoulder pruned)")

    def test_hhs_region_y_labels_and_grouping(self):
        """Test that sorting by HHS Region maintains clean y_labels and provides delineated row_groups."""
        res = self.loader.get_heatmap_data(
            rows="location",
            cols="date",
            target="wk inc flu hosp",
            sort_by="hhs_region",
        )
        self.assertIn("row_groups", res)
        self.assertGreater(len(res["row_groups"]), 0)
        # Verify row_groups has full geographic names
        first_grp = res["row_groups"][0]
        self.assertIn("Region", first_grp["label"])
        self.assertIn("start_idx", first_grp)
        self.assertIn("end_idx", first_grp)

        # Verify y_labels are clean and do not prepend ugly [Reg X] tags
        y_labels = res["y_labels"]
        self.assertFalse(any("[Reg " in lbl for lbl in y_labels), "y_labels should be clean and not contain [Reg X] prefix")

    def test_non_reporting_models_filtering(self):
        """Test that inactive models that did not forecast for a season are segregated and explained."""
        res = self.loader.get_heatmap_data(
            rows="model",
            cols="horizon",
            season="2024-2025",
            include_inactive=False,
        )
        self.assertIn("inactive_models", res)
        self.assertGreater(len(res["inactive_models"]), 0, "Should detect models that did not forecast in 2024-2025")
        
        # Verify that all returned rows in active matrix have actual forecast data
        for r_idx, row in enumerate(res["raw_matrix"]):
            self.assertTrue(
                any(v is not None for v in row),
                f"Row {res['y_keys'][r_idx]} in active matrix should have at least one valid forecast value"
            )

        # Verify reason metadata
        for im in res["inactive_models"]:
            self.assertIn("reason", im)
            self.assertIn("seasons", im)
            self.assertGreater(len(im["reason"]), 0)

    def test_non_reporting_models_include_inactive(self):
        """Test that include_inactive=True partitions inactive models at the bottom."""
        res = self.loader.get_heatmap_data(
            rows="model",
            cols="horizon",
            season="2024-2025",
            include_inactive=True,
        )
        self.assertIn("inactive_models", res)
        total_models = len(res["y_keys"])
        inactive_count = len(res["inactive_models"])
        active_count = total_models - inactive_count

        self.assertGreater(active_count, 0)
        self.assertGreater(inactive_count, 0)

        # Inactive rows should be partitioned at the bottom
        for i in range(active_count, total_models):
            self.assertTrue(res["y_labels"][i].startswith("[No Data] "))


class TestHeatmapServerAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        socketserver.ThreadingTCPServer.allow_reuse_address = True
        cls.httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), SandboxRequestHandler)
        cls.port = cls.httpd.server_address[1]
        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.server_thread.start()
        time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def _get(self, path: str, query: dict = None) -> tuple[int, dict]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        url = path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        conn.request("GET", url)
        resp = conn.getresponse()
        data = resp.read().decode("utf-8")
        conn.close()
        return resp.status, json.loads(data)

    def test_api_heatmap_default(self):
        status, data = self._get("/api/heatmap", {
            "mode": "wave",
            "target": "wk inc flu hosp",
            "metric": "rate",
            "season": "2024-2025",
            "sort_by": "hhs_region",
            "normalize": "row_min_max",
        })
        self.assertEqual(status, 200)
        self.assertEqual(data["mode"], "wave")
        self.assertEqual(data["normalize"], "row_min_max")
        self.assertIn("x_labels", data)
        self.assertIn("y_labels", data)
        self.assertIn("matrix", data)
        self.assertIn("summary", data)

    def test_api_heatmap_horizon_mode(self):
        status, data = self._get("/api/heatmap", {
            "mode": "horizon",
            "target": "wk inc flu hosp",
            "date": "2024-01-13",
            "model": "UMass-flusion_spatial2_prod",
            "normalize": "none",
        })
        self.assertEqual(status, 200)
        self.assertEqual(data["mode"], "horizon")
        self.assertIn("x_labels", data)
        self.assertIn("y_labels", data)

    def test_api_heatmap_rows_cols_selection(self):
        """Test API endpoint with direct rows and cols parameters."""
        status, data = self._get("/api/heatmap", {
            "rows": "location",
            "cols": "horizon",
            "target": "wk inc flu hosp",
            "date": "2024-01-13",
            "model": "UMass-flusion_spatial2_prod",
        })
        self.assertEqual(status, 200)
        self.assertEqual(data["rows"], "location")
        self.assertEqual(data["cols"], "horizon")
        self.assertEqual(data["mode"], "horizon")

    def test_api_heatmap_transposed_axes(self):
        """Test API endpoint with transposed axes (rows=date, cols=location)."""
        status, data = self._get("/api/heatmap", {
            "rows": "date",
            "cols": "location",
            "target": "wk inc flu hosp",
            "season": "2024-2025",
        })
        self.assertEqual(status, 200)
        self.assertEqual(data["rows"], "date")
        self.assertEqual(data["cols"], "location")
        # Dates should be on Y, Locations on X
        if data["y_keys"]:
            self.assertTrue("-" in data["y_keys"][0], "Y-keys should be dates (YYYY-MM-DD)")
        if data["x_keys"]:
            self.assertTrue(len(data["x_keys"][0]) <= 3, "X-keys should be state abbreviations")

    def test_api_heatmap_location_scope(self):
        """Test API endpoint with single-location scope (e.g. CA)."""
        status, data = self._get("/api/heatmap", {
            "rows": "location",
            "cols": "date",
            "location": "CA",
            "season": "2024-2025",
        })
        self.assertEqual(status, 200)
        self.assertEqual(data["y_keys"], ["CA"])
        self.assertEqual(len(data["matrix"]), 1)

    def test_api_heatmap_multi_season(self):
        """Test API endpoint with comma-separated multi-season aggregation."""
        status, data = self._get("/api/heatmap", {
            "rows": "location",
            "cols": "date",
            "season": "2023-2024,2024-2025",
        })
        self.assertEqual(status, 200)
        self.assertGreater(len(data["x_keys"]), 30, "Should include dates across multiple seasons")

    def test_api_heatmap_include_inactive(self):
        """Test API endpoint with include_inactive parameter."""
        # 1. Default (include_inactive=0)
        status, data_active = self._get("/api/heatmap", {
            "rows": "model",
            "cols": "horizon",
            "season": "2024-2025",
            "include_inactive": "0",
        })
        self.assertEqual(status, 200)
        self.assertIn("inactive_models", data_active)
        self.assertGreater(len(data_active["inactive_models"]), 0)

        # 2. With include_inactive=1
        status, data_all = self._get("/api/heatmap", {
            "rows": "model",
            "cols": "horizon",
            "season": "2024-2025",
            "include_inactive": "1",
        })
        self.assertEqual(status, 200)
        self.assertEqual(
            len(data_all["y_keys"]),
            len(data_active["y_keys"]) + len(data_active["inactive_models"])
        )


if __name__ == "__main__":
    unittest.main()

