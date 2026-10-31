"""
Integration tests for the HTTP server API routes.
Uses http.client with a live test server on an ephemeral port.
"""

import http.client
import json
from pathlib import Path
import socketserver
import threading
import time
import unittest
import urllib.parse

from viz.server import SandboxRequestHandler

BASE_DIR = Path(__file__).resolve().parent.parent.parent


class TestServerAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        socketserver.ThreadingTCPServer.allow_reuse_address = True
        # Bind to port 0 to let OS select an available ephemeral port
        cls.httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), SandboxRequestHandler)
        cls.port = cls.httpd.server_address[1]
        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.server_thread.start()
        time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def _get(self, path: str, query: dict = None, headers: dict = None) -> tuple[int, dict]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        url = path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        conn.request("GET", url, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read().decode("utf-8")
        conn.close()
        return resp.status, json.loads(data)

    def _post(self, path: str, body: dict = None, headers: dict = None) -> tuple[int, dict]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        payload = json.dumps(body or {}).encode("utf-8")
        hdrs = {"Content-Type": "application/json"}
        if headers:
            hdrs.update(headers)
        conn.request("POST", path, body=payload, headers=hdrs)
        resp = conn.getresponse()
        data = resp.read().decode("utf-8")
        conn.close()
        return resp.status, json.loads(data)

    def test_status_endpoint(self):
        status, data = self._get("/api/status")
        self.assertEqual(status, 200)
        self.assertEqual(data["status"], "ok")
        self.assertGreater(data["models_count"], 0)

    def test_metadata_endpoint(self):
        status, data = self._get("/api/metadata")
        self.assertEqual(status, 200)
        self.assertIn("models", data)
        self.assertIn("targets", data)
        self.assertIn("recommended_models", data)
        self.assertIn("default_target", data)
        self.assertIn("default_baseline", data)

    def test_metrics_endpoint(self):
        status, data = self._get("/api/metrics", {
            "models": "UMass-flusion_spatial2_prod,UMass-AR6_pooled",
            "date": "2024-01-13",
            "location": "states",
            "fair": "false",
        })
        self.assertEqual(status, 200)
        self.assertIn("rankings", data)
        self.assertEqual(len(data["rankings"]), 2)
        flusion = next(r for r in data["rankings"] if r["model_id"] == "UMass-flusion_spatial2_prod")
        self.assertIsNotNone(flusion["wis"])

    def test_spatial_endpoint(self):
        status, data = self._get("/api/spatial", {
            "models": "UMass-flusion_spatial2_prod",
            "date": "2024-01-13",
            "target": "wk inc flu hosp",
            "horizon": "1",
        })
        self.assertEqual(status, 200)
        self.assertIn("states", data)
        self.assertEqual(data["selected_horizon"], "1")

    def test_cache_refresh_endpoint(self):
        # GET should be rejected with 405 Method Not Allowed
        get_status, get_data = self._get("/api/cache/refresh")
        self.assertEqual(get_status, 405)
        self.assertIn("error", get_data)

        # POST should succeed with 200 OK
        post_status, post_data = self._post("/api/cache/refresh")
        self.assertEqual(post_status, 200)
        self.assertEqual(post_data["status"], "ok")

    def test_ensemble_endpoints(self):
        # 1. Preview
        prev_status, prev_data = self._post("/api/ensemble/preview", {
            "models": ["UMass-flusion_spatial2_prod", "UMass-AR6_pooled"],
            "method": "median",
        })
        self.assertEqual(prev_status, 200)
        self.assertTrue(prev_data.get("valid"))
        self.assertEqual(prev_data.get("model_count"), 2)

        # 2. Create
        create_status, create_data = self._post("/api/ensemble/create", {
            "name": "Integration Test Ensemble",
            "method": "median",
            "models": ["UMass-flusion_spatial2_prod", "UMass-AR6_pooled"],
        })
        self.assertEqual(create_status, 200)
        self.assertEqual(create_data.get("status"), "ok")
        ens_id = create_data["ensemble"]["id"]
        self.assertTrue(ens_id.startswith("synth_"))

        # 3. List
        list_status, list_data = self._get("/api/ensemble/list")
        self.assertEqual(list_status, 200)
        found = any(e["id"] == ens_id for e in list_data.get("ensembles", []))
        self.assertTrue(found)

        # 4. Delete
        del_status, del_data = self._post("/api/ensemble/delete", {"ensemble_id": ens_id})
        self.assertEqual(del_status, 200)
        self.assertEqual(del_data.get("status"), "ok")


if __name__ == "__main__":
    unittest.main()

