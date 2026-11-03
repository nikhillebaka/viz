"""
Live hub data: compatibility checks, schema normalization, truth merging, and the full sync lifecycle
against a local fake S3 server (no network access). Also checks that the CLI never sees hub data.
"""

from datetime import date
import http.server
import io
import json
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest
import urllib.parse

import polars as pl

from viz.core.cache_manager import merge_truth_frames
from viz.core.data_loader import SandboxDataLoader
from viz.core.evaluation import EvaluationEngine, EvaluationParams
from viz.remote.hubs import assess_compatibility, hub_id_from_bucket
from viz.remote.normalize import normalize_forecast
from viz.remote.s3 import S3Client, validate_bucket_name
from viz.remote.sync import RemoteManager

TARGET = "wk inc flu hosp"
QUANTILES = [0.025, 0.25, 0.5, 0.75, 0.975]
SEASON = "2026-2027"
LOCATIONS = {"US", "01", "02"}


def flu_tasks(locations=("US", "01", "02"), targets=(TARGET,)):
    return {
        "rounds": [{
            "round_id_from_variable": True,
            "model_tasks": [{
                "task_ids": {
                    "target": {"required": None, "optional": list(targets)},
                    "location": {"required": None, "optional": list(locations)},
                },
                "output_type": {"quantile": {}},
            }],
        }]
    }


def forecast_parquet(model: str, ref: str, scale: float = 1.0, crossing: bool = False) -> bytes:
    """A hub-style parquet: date32 dates, int64 horizon, model_id column (as on the FluSight bucket)."""
    rows = []
    ref_d = date.fromisoformat(ref)
    for loc, base in (("US", 3000.0), ("01", 100.0), ("02", 40.0)):
        for h in (0, 1):
            ted = date.fromordinal(ref_d.toordinal() + 7 * h)
            for q in QUANTILES:
                v = base * scale * (0.6 + 0.8 * q)
                if crossing and loc == "01" and q == 0.975:
                    v = 0.0
                rows.append({"reference_date": ref_d, "location": loc, "horizon": h, "target": TARGET,
                             "target_end_date": ted, "output_type": "quantile", "output_type_id": str(q),
                             "value": v, "model_id": model})
    buf = io.BytesIO()
    pl.DataFrame(rows).with_columns(pl.col("horizon").cast(pl.Int64)).write_parquet(buf)
    return buf.getvalue()


class FakeS3:
    """Serves ListObjectsV2 (two keys per page, to exercise pagination) and GETs from an in-memory dict."""

    def __init__(self):
        self.objects = {}
        self.etags = {}
        self.requests = 0
        store = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                store.requests += 1
                parsed = urllib.parse.urlparse(self.path)
                q = urllib.parse.parse_qs(parsed.query)
                if parsed.path in ("", "/") and q.get("list-type") == ["2"]:
                    prefix = q.get("prefix", [""])[0]
                    keys = sorted(k for k in store.objects if k.startswith(prefix))
                    start = int(q.get("continuation-token", ["0"])[0])
                    page = keys[start:start + 2]
                    truncated = start + 2 < len(keys)
                    items = "".join(
                        f"<Contents><Key>{k}</Key><LastModified>2026-10-14T12:00:00.000Z</LastModified>"
                        f"<ETag>&quot;{store.etags[k]}&quot;</ETag><Size>{len(store.objects[k])}</Size></Contents>"
                        for k in page
                    )
                    nxt = f"<NextContinuationToken>{start + 2}</NextContinuationToken>" if truncated else ""
                    body = (
                        '<?xml version="1.0" encoding="UTF-8"?>'
                        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                        f"<IsTruncated>{'true' if truncated else 'false'}</IsTruncated>{nxt}{items}</ListBucketResult>"
                    ).encode()
                    self._reply(200, body)
                    return
                key = urllib.parse.unquote(parsed.path.lstrip("/"))
                if key in store.objects:
                    self._reply(200, store.objects[key])
                else:
                    self._reply(404, b"<Error><Code>NoSuchKey</Code></Error>")

            def _reply(self, code, body):
                self.send_response(code)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def put(self, key, data):
        if isinstance(data, str):
            data = data.encode()
        self.objects[key] = data
        self.etags[key] = f"etag{abs(hash(data)) % 10**9}"

    def delete(self, key):
        self.objects.pop(key, None)
        self.etags.pop(key, None)

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class TestCompatibility(unittest.TestCase):
    def test_flu_hub_supported(self):
        res = assess_compatibility({"name": "Flu"}, flu_tasks(), LOCATIONS)
        self.assertTrue(res["supported"], res["reason"])

    def test_covid_hub_rejected_with_flu_only_message(self):
        res = assess_compatibility({}, flu_tasks(targets=("wk inc covid hosp",)), LOCATIONS)
        self.assertFalse(res["supported"])
        self.assertIn("only supports flu", res["reason"])

    def test_mixed_pathogen_hub_rejected(self):
        res = assess_compatibility({}, flu_tasks(targets=(TARGET, "wk inc rsv hosp")), LOCATIONS)
        self.assertFalse(res["supported"])

    def test_city_level_flu_hub_rejected(self):
        res = assess_compatibility({}, flu_tasks(locations=("nyc", "boston", "chicago", "denver", "austin")), LOCATIONS)
        self.assertFalse(res["supported"])
        self.assertIn("locations", res["reason"])

    def test_bucket_names_only(self):
        self.assertEqual(validate_bucket_name("s3://my-flu-hub/"), "my-flu-hub")
        for bad in ("https://evil.example.com", "a", "../etc", "Bucket_Upper"):
            with self.assertRaises(ValueError):
                validate_bucket_name(bad)

    def test_hub_ids_avoid_reserved_and_taken(self):
        self.assertEqual(hub_id_from_bucket("cdcepi-flusight-forecast-hub", []), "flusight")
        self.assertEqual(hub_id_from_bucket("cdcepi-flusight-forecast-hub", ["flusight"]), "flusight2")
        self.assertNotEqual(hub_id_from_bucket("local", []), "local")


class TestNormalization(unittest.TestCase):
    def test_schema_drift_is_coerced(self):
        raw = pl.read_parquet(io.BytesIO(forecast_parquet("Team-a", "2026-10-10")))
        self.assertEqual(raw.schema["horizon"], pl.Int64)
        self.assertEqual(raw.schema["reference_date"], pl.Date)
        out, info = normalize_forecast(raw, "Team-a", "2026-10-10", LOCATIONS, lambda t: True)
        self.assertEqual(out.schema["horizon"], pl.Int32)
        self.assertEqual(out.schema["reference_date"], pl.String)
        self.assertEqual(out.schema["output_type_id"], pl.Float64)
        self.assertEqual(out["reference_date"].unique().to_list(), ["2026-10-10"])
        self.assertEqual(info["targets"], [TARGET])
        self.assertEqual(info["warnings"], [])

    def test_quality_findings(self):
        raw = pl.read_parquet(io.BytesIO(forecast_parquet("Team-a", "2026-10-10", crossing=True)))
        raw = raw.with_columns(pl.lit("Someone-else").alias("model_id"))
        raw = pl.concat([raw, raw.head(1).with_columns(pl.lit("9").alias("location"))])
        _, info = normalize_forecast(raw, "Team-a", "2026-10-10", LOCATIONS, lambda t: True)
        text = " | ".join(info["warnings"])
        self.assertIn("does not match folder", text)
        self.assertIn("crossing", text)
        self.assertIn("unknown location codes ['09']", text)

    def test_pmf_only_file_yields_no_rows(self):
        raw = pl.DataFrame({"target": ["wk flu hosp rate change"], "location": ["US"], "horizon": [0],
                            "output_type": ["pmf"], "output_type_id": ["increase"], "value": [0.4]})
        out, info = normalize_forecast(raw, "Team-a", "2026-10-10", LOCATIONS)
        self.assertTrue(out.is_empty())
        self.assertEqual(info["output_types"], ["pmf"])


class TestTruthMerge(unittest.TestCase):
    def test_newest_vintage_wins_and_gaps_are_filled(self):
        old = pl.DataFrame({"as_of": ["2026-07-08"] * 2, "location": ["US", "US"],
                            "target_end_date": ["2026-06-27", "2026-07-04"], "oracle_value": [10.0, 20.0]})
        new = pl.DataFrame({"as_of": ["2026-10-14"] * 2, "location": ["US", "US"],
                            "target_end_date": ["2026-07-04", "2026-10-10"], "oracle_value": [21.0, 99.0]})
        merged = merge_truth_frames([new, old], ["location", "target_end_date"]).sort("target_end_date")
        self.assertEqual(merged["oracle_value"].to_list(), [10.0, 21.0, 99.0])
        self.assertFalse(merged.select(["location", "target_end_date"]).is_duplicated().any())


class TestSyncLifecycle(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        (self.base / "viz").mkdir()
        (self.base / "auxiliary-data").mkdir()
        (self.base / "target-data").mkdir()
        (self.base / "model-output" / "FluSight-baseline").mkdir(parents=True)
        pl.DataFrame({"abbreviation": ["US", "AL", "AK"], "location": ["US", "01", "02"],
                      "location_name": ["US", "Alabama", "Alaska"],
                      "population": [330_000_000, 5_000_000, 700_000]}).write_csv(self.base / "auxiliary-data" / "locations.csv")
        # Repository truth is older and stops before the live round
        pl.DataFrame({"as_of": ["2026-07-08"] * 3, "target": [TARGET] * 3, "target_end_date": ["2026-07-04"] * 3,
                      "location": ["US", "01", "02"], "horizon": [0] * 3, "output_type": ["quantile"] * 3,
                      "output_type_id": [None] * 3, "oracle_value": [500.0, 20.0, 9.0]}).write_csv(
            self.base / "target-data" / "oracle-output.csv")
        # A repository model with the same name as a hub model (namespacing must keep them apart)
        repo = pl.read_parquet(io.BytesIO(forecast_parquet("FluSight-baseline", "2026-10-10", scale=2.0)))
        repo.with_columns(pl.col("reference_date").cast(pl.String), pl.col("target_end_date").cast(pl.String)).drop(
            "model_id").write_csv(self.base / "model-output" / "FluSight-baseline" / "2026-10-10-FluSight-baseline.csv")

        self.s3 = FakeS3()
        self.s3.put("hub-config/admin.json", json.dumps({"name": "Test Flu Hub", "timezone": "US/Eastern"}))
        self.s3.put("hub-config/tasks.json", json.dumps(flu_tasks()))
        for model in ("FluSight-baseline", "Team-a"):
            for ref in ("2026-10-10", "2026-10-17"):
                self.s3.put(f"model-output/{model}/{ref}-{model}.parquet", forecast_parquet(model, ref))
        self.s3.put("model-output/Team-a/2025-12-06-Team-a.parquet", forecast_parquet("Team-a", "2025-12-06"))
        self.s3.put("model-metadata/Team-a.yml", "team_name: Team A\ndesignated_model: true\n")
        oracle_rows = ['"as_of","target","target_end_date","location","horizon","output_type","output_type_id","oracle_value"']
        for loc, v in (("US", 3000), ("01", 100), ("02", 40)):
            oracle_rows.append(f'2026-10-14,"{TARGET}",2026-07-04,"{loc}",0,"quantile",NA,{v // 5}')
            oracle_rows.append(f'2026-10-14,"{TARGET}",2026-10-10,"{loc}",0,"quantile",NA,{v}')
        self.s3.put("target-data/oracle-output.csv", "\n".join(oracle_rows) + "\n")

        self.loader = SandboxDataLoader(self.base)
        fake_url = self.s3.url

        def client_factory(bucket, cancel_event=None):
            c = S3Client(bucket, cancel_event=cancel_event, retries=0)
            c.base_url = fake_url
            return c

        def on_change(hub_id, models):
            self.loader.invalidate_inventory()

        self.mgr = RemoteManager(
            self.loader.remote_store,
            known_locations=lambda: set(self.loader.get_locations()),
            is_non_negative=lambda t: True,
            local_as_of_max=lambda: None,
            on_inventory_change=on_change,
            client_factory=client_factory,
        )

    def tearDown(self):
        self.s3.close()
        shutil.rmtree(self.base, ignore_errors=True)

    def _sync(self, seasons=(SEASON,)):
        self.mgr.start_sync("flusight", list(seasons))
        deadline = time.time() + 30
        while time.time() < deadline:
            job = self.mgr.get_job("flusight")
            if job["status"] != "running":
                return job
            time.sleep(0.05)
        self.fail("sync did not finish")

    def test_nothing_is_synced_until_asked(self):
        self.assertEqual(self.s3.requests, 0)
        self.assertFalse(any(m.get("source") == "hub" for m in self.loader.scan_models().values()))

    def test_check_lists_seasons_without_downloading(self):
        res = self.mgr.check("flusight")
        seasons = {s["season"]: s for s in res["seasons"]}
        self.assertEqual(seasons[SEASON]["files"], 4)
        self.assertEqual(seasons["2025-2026"]["files"], 1)
        self.assertFalse(self.loader.remote_store.has_data("flusight"))

    def test_full_sync_lifecycle(self):
        job = self._sync()
        self.assertEqual(job["status"], "done", job.get("error"))
        self.assertEqual(job["summary"]["added"], 4)  # 2025-26 file not requested

        models = self.loader.scan_models(force_refresh=True)
        self.assertIn("FluSight-baseline", models)
        self.assertIn("flusight:FluSight-baseline", models)
        self.assertIn("flusight:Team-a", models)
        team = models["flusight:Team-a"]
        self.assertEqual(team["source"], "hub")
        self.assertEqual(team["dates"], ["2026-10-10", "2026-10-17"])
        self.assertTrue(team["designated"])

        # Repo and hub models with the same name stay distinct
        repo_fan = self.loader.get_model_fan_data("FluSight-baseline", TARGET, "US", "2026-10-10")
        hub_fan = self.loader.get_model_fan_data("flusight:FluSight-baseline", TARGET, "US", "2026-10-10")
        self.assertAlmostEqual(repo_fan["median"][0] / hub_fan["median"][0], 2.0)

        # Merged truth: hub vintage wins on overlaps, no duplicate keys, live week now observed
        oracle = self.loader.get_oracle()
        self.assertFalse(oracle.select(["target", "target_end_date", "location", "horizon"]).is_duplicated().any())
        us_jul = oracle.filter((pl.col("location") == "US") & (pl.col("target_end_date") == "2026-07-04"))
        self.assertEqual(us_jul["oracle_value"].to_list(), [600.0])  # hub vintage (repo had 500)
        self.assertEqual(self.loader.get_truth_info()["as_of"], "2026-10-14")

        # The scored round works; the live round reports pending truth instead of a fake score
        engine = EvaluationEngine(self.base, self.loader)
        res = engine.evaluate(EvaluationParams(models=["flusight:Team-a"], location="US", date="2026-10-10"))
        self.assertEqual(res.rankings[0]["count"], 1)
        res = engine.evaluate(EvaluationParams(models=["flusight:Team-a"], location="US", date="2026-10-17"))
        self.assertTrue(res.rankings[0]["pending_truth"])
        self.assertFalse(any("quantiles" in w for w in res.validation_warnings))

        # Incremental: an upstream resubmission and a deletion
        self.s3.put("model-output/Team-a/2026-10-17-Team-a.parquet", forecast_parquet("Team-a", "2026-10-17", scale=1.5))
        self.s3.delete("model-output/FluSight-baseline/2026-10-17-FluSight-baseline.parquet")
        pending = self.mgr.check("flusight")["pending"]
        self.assertEqual((pending["new"], pending["changed"], pending["removed"]), (0, 1, 1))
        job = self._sync()
        self.assertEqual((job["summary"]["added"], job["summary"]["updated"], job["summary"]["removed"]), (0, 1, 1))
        models = self.loader.scan_models(force_refresh=True)
        self.assertEqual(models["flusight:FluSight-baseline"]["dates"], ["2026-10-10"])
        self.assertEqual(models["flusight:Team-a"]["revision_count"], 1)
        fan = self.loader.get_model_fan_data("flusight:Team-a", TARGET, "US", "2026-10-17")
        self.assertAlmostEqual(fan["median"][0], 3000 * 1.5 * 1.0)

        # Hiding the hub removes its models and its truth; data stays on disk
        self.mgr.set_enabled("flusight", False)
        models = self.loader.scan_models(force_refresh=True)
        self.assertFalse(any(m.get("source") == "hub" for m in models.values()))
        self.assertEqual(self.loader.get_truth_info()["as_of"], "2026-07-08")
        self.assertTrue(self.loader.remote_store.has_data("flusight"))
        self.mgr.set_enabled("flusight", True)

        # Removing deletes the local copy
        self.mgr.remove("flusight")
        self.assertFalse(self.loader.remote_store.has_data("flusight"))
        self.assertFalse(any(m.get("source") == "hub" for m in self.loader.scan_models(force_refresh=True).values()))

    def test_cli_loader_ignores_hub_data(self):
        self.assertEqual(self._sync()["status"], "done")
        cli = SandboxDataLoader(self.base, include_remote=False)
        models = cli.scan_models()
        self.assertFalse(any(m.get("source") == "hub" or ":" in k for k, m in models.items()))
        self.assertEqual(cli.get_truth_info()["as_of"], "2026-07-08")
        self.assertIsNone(cli.cache_mgr.scan_model("flusight:Team-a"))

    def test_corrupt_file_is_skipped_not_loaded(self):
        self.s3.put("model-output/Team-a/2026-10-17-Team-a.parquet", b"not a parquet file")
        job = self._sync()
        self.assertEqual(job["status"], "done", job.get("error"))
        self.assertEqual(job["summary"]["failed"], 1)
        self.assertEqual(self.loader.scan_models(force_refresh=True)["flusight:Team-a"]["dates"], ["2026-10-10"])
        self.assertTrue(any("Skipped" in w["message"] for w in self.mgr.warnings("flusight")))

    def test_unsupported_hub_is_not_registered(self):
        self.s3.put("hub-config/tasks.json", json.dumps(flu_tasks(targets=("wk inc covid hosp",))))
        res = self.mgr.add_hub("some-covid-hub")
        self.assertFalse(res["ok"])
        self.assertIn("only supports flu", res["reason"])
        self.assertEqual([s.id for s in self.loader.remote_store.hub_specs()], ["flusight"])


if __name__ == "__main__":
    unittest.main()
