"""
Parity test between CLI evaluation (`score_cli.py` / `EvaluationEngine`) and HTTP API.
Ensures identical metrics, rankings, window scoping, and export outputs across paths.
"""

import http.client
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.parse

import polars as pl

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from conftest import APP_DIR, build_synthetic_hub, start_test_server  # noqa: E402
from viz.core.data_loader import SandboxDataLoader  # noqa: E402
from viz.core.evaluation import EvaluationEngine, EvaluationParams  # noqa: E402
from viz.core.workspace import resolve_hub_storage  # noqa: E402


class TestCliApiParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = Path(tempfile.mkdtemp(prefix="viz-cli-parity-")).resolve()
        cls.hub_dir = build_synthetic_hub(cls._tmp / "hub")
        cls.cli_data_dir = cls._tmp / "cli-data"
        cls.cli_data_dir.mkdir(parents=True, exist_ok=True)
        cls._srv_ctx = start_test_server([cls.hub_dir])
        cls.port, cls.mgr = cls._srv_ctx.__enter__()
        storage = resolve_hub_storage(cls.hub_dir, cls._tmp / "engine-data", cli_fallback=True)
        cls.engine = EvaluationEngine(
            cls.hub_dir,
            SandboxDataLoader(
                cls.hub_dir,
                include_remote=False,
                cache_dir=storage["cache_dir"],
                surveillance_dir=storage["surveillance_dir"],
                seed_dir=storage["seed_dir"],
                app_dir=APP_DIR,
                synthetic_dir=storage["synthetic_dir"],
            ),
        )

    @classmethod
    def tearDownClass(cls):
        cls._srv_ctx.__exit__(None, None, None)
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def _run_cli(self, *args: str) -> subprocess.CompletedProcess:
        cmd = [
            sys.executable,
            str(APP_DIR / "score_cli.py"),
            "--hub", str(self.hub_dir),
            "--data-dir", str(self.cli_data_dir),
            *args,
        ]
        return subprocess.run(cmd, capture_output=True, text=True, check=True)

    def test_cli_vs_api_identical_metrics(self):
        models = ["Model-Alpha", "Model-Beta"]
        date = "2024-01-13"
        location = "states"

        cli_result = self.engine.evaluate(
            EvaluationParams(models=models, date=date, location=location, fair=False)
        ).to_dict()

        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        query = urllib.parse.urlencode({
            "models": ",".join(models),
            "date": date,
            "location": location,
            "fair": "false",
        })
        try:
            conn.request("GET", f"/api/metrics?{query}")
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            api_result = json.loads(resp.read().decode("utf-8"))
        finally:
            conn.close()

        self.assertEqual(len(cli_result["rankings"]), len(api_result["rankings"]))
        for cli_row, api_row in zip(cli_result["rankings"], api_result["rankings"]):
            self.assertEqual(cli_row["model_id"], api_row["model_id"])
            for field in ("wis", "mae", "cov95", "pct_diff_vs_baseline"):
                if cli_row[field] is not None:
                    self.assertAlmostEqual(cli_row[field], api_row[field], places=4)

    def test_window_parity_cli_vs_api(self):
        """Season + week range + peak phase scoping and weekly wins match across CLI and API."""
        models = "Model-Alpha,Model-Beta,FluSight-baseline"
        out = self._run_cli(
            "--models", models,
            "--season", "2023-2024,2024-2025",
            "--location", "states",
            "--weeks", "18-30",
            "--phase", "peak",
            "--format", "json",
        )
        cli = json.loads(out.stdout)

        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        query = urllib.parse.urlencode({
            "models": models,
            "season": "2023-2024,2024-2025",
            "location": "states",
            "weeks": "18-30",
            "phase": "peak",
            "fair": "false",
        })
        try:
            conn.request("GET", f"/api/metrics?{query}")
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            api = json.loads(resp.read().decode("utf-8"))
        finally:
            conn.close()

        ref = self.engine.evaluate(
            EvaluationParams(
                models=models.split(","),
                season="2023-2024,2024-2025",
                location="states",
                weeks="18-30",
                phase="peak",
                fair=False,
            )
        ).to_dict()

        self.assertGreater(cli["scope_dates_count"], 0)
        for got in (cli, api):
            self.assertEqual(got["window"], ref["window"])
            self.assertEqual(got["scope_dates_count"], ref["scope_dates_count"])
            for g_row, r_row in zip(got["rankings"], ref["rankings"]):
                self.assertEqual(g_row["model_id"], r_row["model_id"])
                self.assertEqual(g_row["count"], r_row["count"])
                self.assertEqual(g_row["weeks_won"], r_row["weeks_won"])
                if g_row["wis"] is not None:
                    self.assertAlmostEqual(g_row["wis"], r_row["wis"], places=5)

        self.assertEqual(cli["window"]["phase"], "peak")
        active = [r for r in api["rankings"] if r["has_data_in_scope"]]
        self.assertGreaterEqual(sum(r["weeks_won"] for r in active), max(r["weeks_competed"] for r in active))

    def test_invalid_window_is_a_client_error(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        try:
            conn.request("GET", "/api/metrics?" + urllib.parse.urlencode({
                "models": "FluSight-baseline",
                "phase": "summer",
            }))
            resp = conn.getresponse()
            resp.read()
            self.assertEqual(resp.status, 400)
        finally:
            conn.close()

    def test_cli_format_json_and_csv(self):
        out_dir = self._tmp / "fmt-out"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_json = out_dir / "scores.json"
        out_csv = out_dir / "scores.csv"

        self._run_cli(
            "--models", "Model-Alpha",
            "--date", "2024-01-13",
            "--location", "US",
            "--format", "json",
            "--out", str(out_json),
        )
        data = json.loads(out_json.read_text(encoding="utf-8"))
        self.assertEqual(len(data["rankings"]), 1)
        self.assertEqual(data["rankings"][0]["model_id"], "Model-Alpha")
        self.assertIn("relative_wis", data["rankings"][0])
        self.assertIn("wis_per_100k", data["rankings"][0])

        self._run_cli(
            "--models", "Model-Alpha",
            "--date", "2024-01-13",
            "--location", "US",
            "--format", "csv",
            "--out", str(out_csv),
        )
        csv_text = out_csv.read_text(encoding="utf-8")
        self.assertIn("model_id", csv_text)
        self.assertIn("Model-Alpha", csv_text)
        self.assertIn("wis_per_100k", csv_text)

    def test_cli_export_tasks_csv_and_parquet(self):
        out_dir = self._tmp / "tasks-out"
        out_dir.mkdir(parents=True, exist_ok=True)
        task_csv = out_dir / "tasks.csv"
        task_parquet = out_dir / "tasks.parquet"

        self._run_cli(
            "--models", "Model-Alpha",
            "--date", "2024-01-13",
            "--location", "US",
            "--export-tasks", str(task_csv),
        )
        df_csv = pl.read_csv(task_csv, schema_overrides={"location": pl.String})
        self.assertGreater(len(df_csv), 0)
        for col in ("wis", "reference_date", "location", "horizon"):
            self.assertIn(col, df_csv.columns)

        self._run_cli(
            "--models", "Model-Alpha",
            "--date", "2024-01-13",
            "--location", "US",
            "--export-tasks", str(task_parquet),
        )
        df_parquet = pl.read_parquet(task_parquet)
        self.assertEqual(len(df_parquet), len(df_csv))
        self.assertIn("wis", df_parquet.columns)


if __name__ == "__main__":
    unittest.main()
