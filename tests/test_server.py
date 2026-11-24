"""
Integration tests for core HTTP server API routes using HubManager on an ephemeral port.
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


class TestServerAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = Path(tempfile.mkdtemp(prefix="viz-srv-test-")).resolve()
        cls.hub_dir = build_synthetic_hub(cls._tmp / "hub")
        cls._srv_ctx = start_test_server([cls.hub_dir])
        cls.port, cls.mgr = cls._srv_ctx.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls._srv_ctx.__exit__(None, None, None)
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def _request(
        self,
        method: str,
        path: str,
        *,
        query: dict | None = None,
        body: dict | None = None,
    ) -> tuple[int, dict]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        url = f"{path}?{urllib.parse.urlencode(query)}" if query else path
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        try:
            conn.request(method, url, body=payload, headers=headers)
            resp = conn.getresponse()
            data = json.loads(resp.read().decode("utf-8"))
            return resp.status, data
        finally:
            conn.close()

    def test_status_metadata_and_manifest_endpoints(self):
        status_code, status_data = self._request("GET", "/api/status")
        self.assertEqual(status_code, 200)
        self.assertEqual(status_data["status"], "ok")
        self.assertEqual(status_data["mode"], "local")
        self.assertEqual(status_data["models_count"], 4)

        meta_code, meta_data = self._request("GET", "/api/metadata")
        self.assertEqual(meta_code, 200)
        self.assertEqual(meta_data["default_target"], SYNTH_TARGET)
        self.assertEqual(meta_data["default_baseline"], "FluSight-baseline")
        for key in ("models", "targets", "recommended_models"):
            self.assertIn(key, meta_data)

        man_code, man_data = self._request("GET", "/api/next/manifest")
        self.assertEqual(man_code, 200)
        self.assertFalse(man_data.get("empty"))
        self.assertEqual(man_data["default_target"], SYNTH_TARGET)
        self.assertEqual(man_data["baseline"], "FluSight-baseline")
        self.assertGreaterEqual(len(man_data["locations"]), 7)
        self.assertEqual(sorted(s["id"] for s in man_data["seasons"]), ["2023-2024", "2024-2025"])

    def test_metrics_and_next_metrics_endpoints(self):
        status, data = self._request("GET", "/api/metrics", query={
            "models": "Model-Alpha,Model-Beta",
            "date": "2024-01-13",
            "location": "states",
            "fair": "false",
        })
        self.assertEqual(status, 200)
        self.assertEqual(len(data["rankings"]), 2)
        alpha = next(r for r in data["rankings"] if r["model_id"] == "Model-Alpha")
        self.assertIsNotNone(alpha["wis"])

        next_status, next_data = self._request("GET", "/api/next/metrics", query={
            "models": "Model-Alpha,Model-Beta",
            "date": "2024-01-13",
            "location": "states",
            "horizons": "0,1",
            "fair": "true",
        })
        self.assertEqual(next_status, 200)
        next_alpha = next(r for r in next_data["rankings"] if r["model_id"] == "Model-Alpha")
        self.assertEqual(next_alpha["count"], 10)  # 5 shared states * 2 horizons

    def test_spatial_and_next_spatial_endpoints(self):
        for route in ("/api/spatial", "/api/next/spatial"):
            status, data = self._request("GET", route, query={
                "models": "Model-Alpha",
                "date": "2024-01-13",
                "target": SYNTH_TARGET,
                "horizon": "1",
            })
            self.assertEqual(status, 200)
            self.assertIn("states", data)
            self.assertEqual(data["selected_horizon"], "1")

    def test_cache_refresh_endpoint(self):
        get_status, get_data = self._request("GET", "/api/cache/refresh")
        self.assertEqual(get_status, 405)
        self.assertIn("error", get_data)

        post_status, post_data = self._request("POST", "/api/cache/refresh", body={})
        self.assertEqual(post_status, 200)
        self.assertEqual(post_data["status"], "ok")

    def test_ensemble_http_lifecycle(self):
        prev_status, prev_data = self._request("POST", "/api/ensemble/preview", body={
            "models": ["Model-Alpha", "Model-Beta"],
            "method": "median",
        })
        self.assertEqual(prev_status, 200)
        self.assertTrue(prev_data.get("valid"))
        self.assertEqual(prev_data.get("model_count"), 2)

        create_status, create_data = self._request("POST", "/api/ensemble/create", body={
            "name": "Integration Test Ensemble",
            "method": "median",
            "models": ["Model-Alpha", "Model-Beta"],
        })
        self.assertEqual(create_status, 200)
        self.assertEqual(create_data.get("status"), "ok")
        ens_id = create_data["ensemble"]["id"]
        self.assertTrue(ens_id.startswith("synth_"))

        list_status, list_data = self._request("GET", "/api/ensemble/list")
        self.assertEqual(list_status, 200)
        self.assertTrue(any(e["id"] == ens_id for e in list_data.get("ensembles", [])))

        del_status, del_data = self._request("POST", "/api/ensemble/delete", body={"ensemble_id": ens_id})
        self.assertEqual(del_status, 200)
        self.assertEqual(del_data.get("status"), "ok")


if __name__ == "__main__":
    unittest.main()
