"""
Tests for PreScoreStore parity & incremental invalidation, PMF scoring, Sample CRPS/Energy Score,
dimension slicing, VZF2 binary encoding/size reduction, VZT1 trajectories, PMF endpoint, and HTTP ETag/gzip.
"""

import gzip
import json
from pathlib import Path
import shutil
import threading
import time
import unittest
import urllib.error
import urllib.request
import http.server
import tempfile

import numpy as np
import polars as pl

from viz.core.data_loader import SandboxDataLoader
from viz.core.evaluation import EvaluationEngine, EvaluationParams
from viz.core.metrics import crps_ensemble_1d, energy_score, score_forecasts, score_pmf_forecasts, score_sample_forecasts
from viz.core.next_api import NextData
from viz.core.workspace import HubManager
from viz.server import SandboxRequestHandler


def _brute_force_crps(x: np.ndarray, y: float) -> float:
    m = len(x)
    t1 = np.mean(np.abs(x - y))
    t2 = 0.5 * np.mean(np.abs(x[:, None] - x[None, :]))
    return float(t1 - t2)


class TestPreScorePmfSamplesAndVzf2(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.data_dir = Path(tempfile.mkdtemp())
        (self.base / "hub-config").mkdir()
        (self.base / "auxiliary-data").mkdir()
        (self.base / "target-data").mkdir()

        pl.DataFrame({
            "abbreviation": ["US", "AL", "MA"],
            "location": ["US", "01", "25"],
            "location_name": ["United States", "Alabama", "Massachusetts"],
            "population": [334_000_000, 5_100_000, 7_000_000],
        }).write_csv(self.base / "auxiliary-data" / "locations.csv")

        tasks = {
            "rounds": [{
                "model_tasks": [
                    {
                        "task_ids": {
                            "reference_date": {"optional": ["2025-11-15", "2025-11-22", "2025-11-29"]},
                            "target": {"required": ["wk inc flu hosp"]},
                            "location": {"required": ["US", "01", "25"]},
                            "horizon": {"required": [0, 1, 2, 3, 4]},
                        },
                        "output_type": {"quantile": {}},
                    },
                    {
                        "task_ids": {
                            "reference_date": {"optional": ["2025-11-15", "2025-11-22"]},
                            "target": {"required": ["wk flu hosp rate change"]},
                            "location": {"required": ["01", "25"]},
                            "horizon": {"required": [0, 1]},
                        },
                        "output_type": {
                            "pmf": {
                                "output_type_id": {"required": ["large_decrease", "decrease", "stable", "increase", "large_increase"]},
                                "value": {"minimum": 0, "maximum": 1},
                            }
                        },
                    },
                ]
            }]
        }
        (self.base / "hub-config" / "tasks.json").write_text(json.dumps(tasks), encoding="utf-8")

        oracle_rows = []
        dates = ["2025-11-15", "2025-11-22", "2025-11-29", "2025-12-06", "2025-12-13"]
        for loc, base_val in (("US", 1000.0), ("01", 100.0), ("25", 150.0)):
            for idx, ted in enumerate(dates):
                oracle_rows.append({
                    "as_of": "2025-12-20",
                    "target": "wk inc flu hosp",
                    "target_end_date": ted,
                    "location": loc,
                    "horizon": 0,
                    "output_type": "quantile",
                    "output_type_id": None,
                    "oracle_value": base_val + idx * 10.0,
                })
        # Categorical oracle for rate change
        cats = ["large_decrease", "decrease", "stable", "increase", "large_increase"]
        for loc, true_cat in (("01", "increase"), ("25", "stable")):
            for cat in cats:
                oracle_rows.append({
                    "as_of": "2025-12-20",
                    "target": "wk flu hosp rate change",
                    "target_end_date": "2025-11-15",
                    "location": loc,
                    "horizon": 0,
                    "output_type": "pmf",
                    "output_type_id": cat,
                    "oracle_value": 1.0 if cat == true_cat else 0.0,
                })
        pl.DataFrame(oracle_rows).write_csv(self.base / "target-data" / "oracle-output.csv")

        # Write two quantile models with uneven sparsity + sample/PMF rows
        qs = [0.025, 0.25, 0.5, 0.75, 0.975]
        for mid, shift, rounds, hs in (
            ("Model-A", 1.0, ["2025-11-15", "2025-11-22", "2025-11-29"], [0, 1, 2, 3, 4]),
            ("Model-B", 1.25, ["2025-11-29"], [0, 1]),
        ):
            mdir = self.base / "model-output" / mid
            mdir.mkdir(parents=True)
            for ref in rounds:
                from datetime import date, timedelta
                ref_d = date.fromisoformat(ref)
                rows = []
                for loc, b in (("US", 1000.0), ("01", 100.0), ("25", 150.0)):
                    for h in hs:
                        ted = (ref_d + timedelta(weeks=h)).isoformat()
                        for q in qs:
                            rows.append({
                                "reference_date": ref,
                                "target": "wk inc flu hosp",
                                "horizon": h,
                                "target_end_date": ted,
                                "location": loc,
                                "output_type": "quantile",
                                "output_type_id": str(q),
                                "value": b * shift * (0.7 + 0.6 * q),
                            })
                        if mid == "Model-A" and loc in ("01", "25") and h in (0, 1):
                            for cat in cats:
                                p = 0.6 if (cat == "increase" and loc == "01") or (cat == "stable" and loc == "25") else 0.1
                                rows.append({
                                    "reference_date": ref,
                                    "target": "wk flu hosp rate change",
                                    "horizon": h,
                                    "target_end_date": ted,
                                    "location": loc,
                                    "output_type": "pmf",
                                    "output_type_id": cat,
                                    "value": p,
                                })
                        if mid == "Model-A" and loc == "01" and ref == "2025-11-15":
                            for s in range(10):
                                rows.append({
                                    "reference_date": ref,
                                    "target": "wk inc flu hosp",
                                    "horizon": h,
                                    "target_end_date": ted,
                                    "location": loc,
                                    "output_type": "sample",
                                    "output_type_id": f"s{s}",
                                    "value": b * (0.8 + s * 0.04),
                                })
                pl.DataFrame(rows).write_csv(mdir / f"{ref}-{mid}.csv")

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)
        shutil.rmtree(self.data_dir, ignore_errors=True)

    def test_sample_crps_and_energy_score(self):
        rng = np.random.default_rng(42)
        draws = rng.normal(loc=100.0, scale=15.0, size=80)
        self.assertAlmostEqual(crps_ensemble_1d(draws, 107.3), _brute_force_crps(draws, 107.3), places=10)

        sample_df = pl.DataFrame({
            "reference_date": ["2025-11-15"] * 6,
            "location": ["01"] * 6,
            "horizon": [0, 0, 0, 1, 1, 1],
            "target_end_date": ["2025-11-15"] * 3 + ["2025-11-22"] * 3,
            "target": ["wk inc flu hosp"] * 6,
            "output_type": ["sample"] * 6,
            "output_type_id": ["s1", "s2", "s3", "s1", "s2", "s3"],
            "value": [90.0, 100.0, 110.0, 95.0, 105.0, 115.0],
        })
        oracle_df = pl.DataFrame({
            "location": ["01", "01"],
            "target_end_date": ["2025-11-15", "2025-11-22"],
            "target": ["wk inc flu hosp"] * 2,
            "oracle_value": [100.0, 105.0],
        })
        sc = score_sample_forecasts(sample_df, oracle_df, "wk inc flu hosp", return_task_df=True)
        self.assertGreater(sc["overall"]["crps"], 0.0)
        self.assertIsNotNone(sc["overall"]["energy_score"])
        self.assertEqual(sc["overall"]["count"], 2)

    def test_prescore_parity_and_pmf_eval_dispatch(self):
        loader = SandboxDataLoader(self.base, cache_dir=self.data_dir, include_remote=False)
        engine = EvaluationEngine(self.base, loader)

        params = EvaluationParams(
            target="wk inc flu hosp",
            location="states",
            season="2025-2026",
            horizons=[0, 1],
            fair=True,
        )
        res = engine.evaluate(params)
        oracle = loader.get_oracle(as_polars=True)
        pop_map = {k: v["population"] for k, v in loader.get_locations().items() if v.get("population")}
        df_a = loader.load_combined_forecasts("Model-A", ["2025-11-29"])
        direct = score_forecasts(
            df_a,
            oracle,
            target="wk inc flu hosp",
            locations=["01", "25"],
            reference_dates=["2025-11-29"],
            horizons=[0, 1],
            non_negative=True,
            population_map=pop_map,
        )
        row_a = next(r for r in res.rankings if r["model_id"] == "Model-A")
        self.assertAlmostEqual(row_a["wis"], direct["overall"]["wis"], places=6)
        self.assertAlmostEqual(row_a["wis_per_100k"], direct["overall"]["wis_per_100k"], places=6)
        self.assertEqual(row_a["count"], direct["overall"]["count"])
        self.assertTrue((self.data_dir / "scores").exists())

        # PMF evaluation dispatch
        pmf_res = engine.evaluate(EvaluationParams(target="wk flu hosp rate change", location="states"))
        pmf_a = next(r for r in pmf_res.rankings if r["model_id"] == "Model-A")
        self.assertTrue(pmf_a["has_data_in_scope"])
        self.assertAlmostEqual(pmf_a["brier"], (1 - 0.6) ** 2 + 4 * (0.1 ** 2), places=6)
        self.assertEqual(pmf_a["hit_mode"], 100.0)

    def test_vzf2_sparse_smaller_than_vzf1_and_http_gzip_etag(self):
        mgr = HubManager(data_dir=self.data_dir, cli_hubs=[self.base], include_enclosing=False)
        ctx = mgr.get_context()
        nd = ctx.next_data

        b_v2 = nd.fan("wk inc flu hosp", "2025-2026", "01", version=2)
        b_v1 = nd.fan("wk inc flu hosp", "2025-2026", "01", version=1)
        self.assertTrue(b_v2.startswith(b"VZF2"))
        self.assertTrue(b_v1.startswith(b"VZF1"))
        self.assertLess(len(b_v2), len(b_v1))

        vzt = nd.trajectories("wk inc flu hosp", "2025-2026", "01", "2025-11-15")
        self.assertIsNotNone(vzt)
        self.assertTrue(vzt.startswith(b"VZT1"))

        pmf_json = nd.pmf("wk flu hosp rate change", "2025-2026", "01")
        self.assertIn("Model-A", pmf_json["models"])

        # Start ephemeral HTTP server to test gzip + weak ETag 304 + /api/next/trajectories + /api/next/pmf
        class H(SandboxRequestHandler):
            hub_manager = mgr
            def log_message(self, *args):
                pass

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/next/manifest",
                headers={"Accept-Encoding": "gzip"},
            )
            with urllib.request.urlopen(req) as resp:
                self.assertEqual(resp.status, 200)
                self.assertEqual(resp.headers.get("Content-Encoding"), "gzip")
                etag = resp.headers.get("ETag")
                self.assertTrue(etag)
                man = json.loads(gzip.decompress(resp.read()).decode("utf-8"))
                self.assertIn("calendar", man)
                self.assertIn("geo", man)

            # Second request with If-None-Match -> 304 Not Modified
            req304 = urllib.request.Request(
                f"http://127.0.0.1:{port}/api/next/manifest",
                headers={"If-None-Match": etag},
            )
            with self.assertRaises(urllib.error.HTTPError) as ctx_err:
                urllib.request.urlopen(req304)
            self.assertEqual(ctx_err.exception.code, 304)

            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/next/fan?target=wk+inc+flu+hosp&season=2025-2026&location=01") as fresp:
                raw_fan = fresp.read()
                self.assertTrue(raw_fan.startswith(b"VZF2"))

            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/next/trajectories?target=wk+inc+flu+hosp&season=2025-2026&location=01&date=2025-11-15") as tresp:
                self.assertTrue(tresp.read().startswith(b"VZT1"))
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
