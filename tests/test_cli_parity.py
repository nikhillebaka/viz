"""
Parity test between CLI evaluation engine and Server HTTP API.
Ensures that both access paths produce mathematically identical metrics,
rankings, and scope resolutions for identical parameters.
"""

import http.client
import json
from pathlib import Path
import socketserver
import threading
import time
import unittest
import urllib.parse

from viz.data_loader import SandboxDataLoader
from viz.evaluation import EvaluationEngine, EvaluationParams
from viz.server import SandboxRequestHandler

BASE_DIR = Path(__file__).resolve().parent.parent.parent


class TestCliApiParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        socketserver.ThreadingTCPServer.allow_reuse_address = True
        cls.httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), SandboxRequestHandler)
        cls.port = cls.httpd.server_address[1]
        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.server_thread.start()
        time.sleep(0.1)
        cls.engine = EvaluationEngine(BASE_DIR)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def test_cli_vs_api_identical_metrics(self):
        models = ["UMass-flusion_spatial2_prod", "UMass-AR6_pooled"]
        date = "2024-01-13"
        location = "states"

        # 1. Direct Engine evaluation (same as score_cli.py)
        params = EvaluationParams(
            models=models,
            date=date,
            location=location,
            fair=False,
        )
        cli_result = self.engine.evaluate(params).to_dict()

        # 2. HTTP Server API evaluation
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        query = urllib.parse.urlencode({
            "models": ",".join(models),
            "date": date,
            "location": location,
            "fair": "false",
        })
        conn.request("GET", f"/api/metrics?{query}")
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        api_result = json.loads(resp.read().decode("utf-8"))
        conn.close()

        # Verify exact numerical parity across rankings
        self.assertEqual(len(cli_result["rankings"]), len(api_result["rankings"]))
        for cli_row, api_row in zip(cli_result["rankings"], api_result["rankings"]):
            self.assertEqual(cli_row["model_id"], api_row["model_id"])
            if cli_row["wis"] is not None:
                self.assertAlmostEqual(cli_row["wis"], api_row["wis"], places=5)
            if cli_row["mae"] is not None:
                self.assertAlmostEqual(cli_row["mae"], api_row["mae"], places=5)
            if cli_row["cov95"] is not None:
                self.assertAlmostEqual(cli_row["cov95"], api_row["cov95"], places=5)
            if cli_row["pct_diff_vs_baseline"] is not None:
                self.assertAlmostEqual(cli_row["pct_diff_vs_baseline"], api_row["pct_diff_vs_baseline"], places=4)

    def test_window_parity_cli_vs_api(self):
        """Season + week range + phase scoping and weekly wins match between the CLI and the API."""
        import subprocess
        import sys
        models = "UMass-flusion_spatial2_prod,UMass-AR6_pooled,FluSight-baseline"
        cmd = [sys.executable, str(BASE_DIR / "viz" / "score_cli.py"), "--models", models,
               "--season", "2023-2024,2024-2025", "--location", "states", "--weeks", "14-30",
               "--phase", "peak", "--format", "json"]
        out = subprocess.run(cmd, capture_output=True, text=True, cwd=BASE_DIR, check=True)
        cli = json.loads(out.stdout)

        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        query = urllib.parse.urlencode({"models": models, "season": "2023-2024,2024-2025", "location": "states",
                                        "weeks": "14-30", "phase": "peak", "fair": "false"})
        conn.request("GET", f"/api/metrics?{query}")
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        api = json.loads(resp.read().decode("utf-8"))
        conn.close()

        params = EvaluationParams(models=models.split(","), season="2023-2024,2024-2025", location="states",
                                  weeks="14-30", phase="peak")
        # The CLI never uses synced hub data (models or truth); the dashboard merges hub truth when a hub
        # is synced, so each path is checked against an engine configured the same way.
        cli_engine = EvaluationEngine(BASE_DIR, SandboxDataLoader(BASE_DIR, include_remote=False))
        for got, ref in ((cli, cli_engine.evaluate(params).to_dict()), (api, self.engine.evaluate(params).to_dict())):
            self.assertEqual(got["window"], ref["window"])
            self.assertEqual(got["scope_dates_count"], ref["scope_dates_count"])
            for c, a in zip(got["rankings"], ref["rankings"]):
                self.assertEqual(c["model_id"], a["model_id"])
                self.assertEqual(c["count"], a["count"])
                self.assertEqual(c["weeks_won"], a["weeks_won"])
                if c["wis"] is not None:
                    self.assertAlmostEqual(c["wis"], a["wis"], places=5)
        self.assertEqual(cli["window"]["phase"], "peak")
        # Every scored round has at least one winner
        active = [r for r in api["rankings"] if r["has_data_in_scope"]]
        self.assertGreaterEqual(sum(r["weeks_won"] for r in active), max(r["weeks_competed"] for r in active))

    def test_invalid_window_is_a_client_error(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        conn.request("GET", "/api/metrics?" + urllib.parse.urlencode({"models": "FluSight-baseline", "phase": "summer"}))
        resp = conn.getresponse()
        resp.read()
        conn.close()
        self.assertEqual(resp.status, 400)

    def test_cli_format_json_and_csv(self):
        import subprocess
        import sys
        import tempfile

        with tempfile.TemporaryDirectory() as tmpdir:
            out_json = Path(tmpdir) / "scores.json"
            out_csv = Path(tmpdir) / "scores.csv"

            # 1. Test JSON format and file output
            cmd_json = [
                sys.executable,
                str(BASE_DIR / "viz" / "score_cli.py"),
                "--models", "UMass-AR6_pooled",
                "--date", "2024-01-13",
                "--location", "US",
                "--format", "json",
                "--out", str(out_json)
            ]
            res_json = subprocess.run(cmd_json, capture_output=True, text=True)
            self.assertEqual(res_json.returncode, 0, msg=res_json.stderr)
            self.assertTrue(out_json.exists())
            data = json.loads(out_json.read_text())
            self.assertIn("rankings", data)
            self.assertEqual(len(data["rankings"]), 1)
            self.assertEqual(data["rankings"][0]["model_id"], "UMass-AR6_pooled")
            self.assertIn("relative_wis", data["rankings"][0])
            self.assertIn("wis_per_100k", data["rankings"][0])

            # 2. Test CSV format and file output
            cmd_csv = [
                sys.executable,
                str(BASE_DIR / "viz" / "score_cli.py"),
                "--models", "UMass-AR6_pooled",
                "--date", "2024-01-13",
                "--location", "US",
                "--format", "csv",
                "--out", str(out_csv)
            ]
            res_csv = subprocess.run(cmd_csv, capture_output=True, text=True)
            self.assertEqual(res_csv.returncode, 0, msg=res_csv.stderr)
            self.assertTrue(out_csv.exists())
            csv_text = out_csv.read_text()
            self.assertIn("model_id", csv_text)
            self.assertIn("UMass-AR6_pooled", csv_text)
            self.assertIn("wis_per_100k", csv_text)

    def test_cli_export_tasks_csv_and_parquet(self):
        import subprocess
        import sys
        import tempfile

        with tempfile.TemporaryDirectory() as tmpdir:
            task_csv = Path(tmpdir) / "tasks.csv"
            task_parquet = Path(tmpdir) / "tasks.parquet"

            # Test task export to CSV
            cmd_csv = [
                sys.executable,
                str(BASE_DIR / "viz" / "score_cli.py"),
                "--models", "UMass-AR6_pooled",
                "--date", "2024-01-13",
                "--location", "US",
                "--export-tasks", str(task_csv)
            ]
            res_csv = subprocess.run(cmd_csv, capture_output=True, text=True)
            self.assertEqual(res_csv.returncode, 0, msg=res_csv.stderr)
            self.assertTrue(task_csv.exists())

            # Read back exported tasks CSV via Polars
            import polars as pl
            df_csv = pl.read_csv(task_csv, schema_overrides={"location": pl.String})
            self.assertGreater(len(df_csv), 0)
            self.assertIn("wis", df_csv.columns)
            self.assertIn("reference_date", df_csv.columns)
            self.assertIn("location", df_csv.columns)
            self.assertIn("horizon", df_csv.columns)

            # Test task export to Parquet
            cmd_parquet = [
                sys.executable,
                str(BASE_DIR / "viz" / "score_cli.py"),
                "--models", "UMass-AR6_pooled",
                "--date", "2024-01-13",
                "--location", "US",
                "--export-tasks", str(task_parquet)
            ]
            res_parquet = subprocess.run(cmd_parquet, capture_output=True, text=True)
            self.assertEqual(res_parquet.returncode, 0, msg=res_parquet.stderr)
            self.assertTrue(task_parquet.exists())

            df_parquet = pl.read_parquet(task_parquet)
            self.assertEqual(len(df_parquet), len(df_csv))
            self.assertIn("wis", df_parquet.columns)


if __name__ == "__main__":
    unittest.main()

