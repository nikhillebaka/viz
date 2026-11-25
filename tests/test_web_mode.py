import gzip
import http.cookies
import io
import json
import os
from pathlib import Path
import shutil
import socketserver
import struct
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request

from core._bootstrap import ensure_viz_package

ensure_viz_package()

import polars as pl
import server
from viz.core.workspace import HubManager
from viz.remote.hubs import BUILTIN_HUBS
from viz.web.auth import RequestIdentity, auth_public_info, hash_identity, resolve_request_user
from viz.web.bundle import (
    UploadIncompatibleError,
    UploadTooLargeError,
    UploadValidationError,
    extract_vzb1_stream,
    validate_extracted_hub,
    validate_hubverse_relpath,
)
from viz.web.config import WebConfig


def _pack_vzb1(entries: list[tuple[str, bytes]], *, compress: bool = True) -> bytes:
    buf = bytearray(b"VZB1")
    for rel_path, body in entries:
        p = rel_path.encode("utf-8")
        buf.extend(struct.pack("<I", len(p)))
        buf.extend(p)
        buf.extend(struct.pack("<Q", len(body)))
        buf.extend(body)
    buf.extend(struct.pack("<I", 0))
    raw = bytes(buf)
    return gzip.compress(raw, compresslevel=6) if compress else raw


def _sample_hub_entries() -> list[tuple[str, bytes]]:
    admin = json.dumps({
        "name": "Test Epi Hub",
        "maintainer": "Epi Team",
        "repository": {"owner": "example", "name": "test-epi-hub"},
    }).encode("utf-8")
    tasks = json.dumps({
        "schema_version": "https://raw.githubusercontent.com/hubverse-org/schemas/main/v3.0.1/tasks-schema.json",
        "rounds": [{
            "round_id_from_variable": True,
            "round_id": "reference_date",
            "model_tasks": [{
                "task_ids": {
                    "reference_date": {"required": ["2025-11-22"], "optional": None},
                    "target": {"required": ["wk inc flu hosp"], "optional": None},
                    "horizon": {"required": [0, 1], "optional": [2]},
                    "location": {"required": ["US", "25"], "optional": None},
                },
                "output_type": {
                    "quantile": {
                        "output_type_id": {"required": [0.025, 0.25, 0.5, 0.75, 0.975]},
                        "value": {"type": "double", "minimum": 0},
                    }
                },
                "target_metadata": [{
                    "target_id": "wk inc flu hosp",
                    "target_name": "Weekly incident flu hospitalizations",
                    "target_units": "count",
                    "target_keys": {"target": "wk inc flu hosp"},
                    "target_type": "discrete",
                    "is_step_ahead": True,
                    "time_unit": "week",
                }],
            }],
        }],
    }).encode("utf-8")

    fc_csv = (
        "reference_date,target,horizon,target_end_date,location,output_type,output_type_id,value\n"
        "2025-11-22,wk inc flu hosp,0,2025-11-22,25,quantile,0.025,10\n"
        "2025-11-22,wk inc flu hosp,0,2025-11-22,25,quantile,0.25,14\n"
        "2025-11-22,wk inc flu hosp,0,2025-11-22,25,quantile,0.5,18\n"
        "2025-11-22,wk inc flu hosp,0,2025-11-22,25,quantile,0.75,24\n"
        "2025-11-22,wk inc flu hosp,0,2025-11-22,25,quantile,0.975,32\n"
        "2025-11-22,wk inc flu hosp,1,2025-11-29,25,quantile,0.025,12\n"
        "2025-11-22,wk inc flu hosp,1,2025-11-29,25,quantile,0.25,16\n"
        "2025-11-22,wk inc flu hosp,1,2025-11-29,25,quantile,0.5,22\n"
        "2025-11-22,wk inc flu hosp,1,2025-11-29,25,quantile,0.75,29\n"
        "2025-11-22,wk inc flu hosp,1,2025-11-29,25,quantile,0.975,38\n"
    ).encode("utf-8")

    oracle_csv = (
        "as_of,target,target_end_date,location,output_type,oracle_value\n"
        "2025-12-06,wk inc flu hosp,2025-11-15,25,quantile,15\n"
        "2025-12-06,wk inc flu hosp,2025-11-22,25,quantile,19\n"
        "2025-12-06,wk inc flu hosp,2025-11-29,25,quantile,21\n"
    ).encode("utf-8")

    locs_csv = (
        "abbreviation,location,location_name,population,count_rate1per100k\n"
        "US,US,US,331449281,3.31449281\n"
        "MA,25,Massachusetts,7029917,0.07029917\n"
    ).encode("utf-8")

    meta_yml = b"team_name: Test\nmodel_name: ModelA\nmodel_abbr: Test-ModelA\n"

    return [
        ("hub-config/admin.json", admin),
        ("hub-config/tasks.json", tasks),
        ("auxiliary-data/locations.csv", locs_csv),
        ("model-metadata/Test-ModelA.yml", meta_yml),
        ("model-output/Test-ModelA/2025-11-22-Test-ModelA.csv", fc_csv),
        ("target-data/oracle-output.csv", oracle_csv),
    ]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class TestWebModeSecurityAndWorkspaces(unittest.TestCase):
    def setUp(self):
        self._tmp = Path(tempfile.mkdtemp(prefix="viz_web_test_"))
        self.data_dir = self._tmp / "data"
        self.scratch_dir = self._tmp / "scratch"
        self.data_dir.mkdir(parents=True)
        self.scratch_dir.mkdir(parents=True)
        self._orig_env = os.environ.copy()
        self._prev_mgr = server.HUB_MANAGER
        self._prev_handler_mgr = server.SandboxRequestHandler.hub_manager

    def tearDown(self):
        server.HUB_MANAGER = self._prev_mgr
        server.SandboxRequestHandler.hub_manager = self._prev_handler_mgr
        os.environ.clear()
        os.environ.update(self._orig_env)
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _start_web_server(self, extra_env: dict[str, str] | None = None):
        os.environ["VIZ_MODE"] = "web"
        os.environ["VIZ_DATA_DIR"] = str(self.data_dir)
        os.environ["VIZ_SCRATCH_DIR"] = str(self.scratch_dir)
        os.environ["VIZ_AUTO_SYNC"] = "0"
        if extra_env:
            os.environ.update(extra_env)

        mgr = HubManager(data_dir=self.data_dir, mode="web", include_enclosing=False)
        server.HUB_MANAGER = mgr
        server.SandboxRequestHandler.hub_manager = mgr
        socketserver.ThreadingTCPServer.allow_reuse_address = True
        httpd = server.BoundedThreadingTCPServer(("127.0.0.1", 0), server.SandboxRequestHandler, max_workers=8)
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        return mgr, httpd, port

    def _http(self, method: str, port: int, path: str, body: bytes | None = None, headers: dict | None = None):
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=body, method=method)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        opener = urllib.request.build_opener(_NoRedirect)
        try:
            with opener.open(req, timeout=10) as resp:
                return resp.status, dict(resp.headers.items()), resp.read()
        except urllib.error.HTTPError as err:
            return err.code, dict(err.headers.items()), err.read()

    # ---- bundle path & stream security ----

    def test_validate_hubverse_relpath_strict_allowlist(self):
        self.assertEqual(validate_hubverse_relpath("hub-config/tasks.json"), "hub-config/tasks.json")
        self.assertEqual(
            validate_hubverse_relpath("model-output/Team-Mod/2025-11-22-Team-Mod.parquet"),
            "model-output/Team-Mod/2025-11-22-Team-Mod.parquet",
        )
        self.assertEqual(validate_hubverse_relpath("model-metadata/Team-Mod.yml"), "model-metadata/Team-Mod.yml")
        self.assertEqual(validate_hubverse_relpath("target-data/oracle-output.csv"), "target-data/oracle-output.csv")
        self.assertEqual(
            validate_hubverse_relpath("auxiliary-data/target-data-archive/target-hospital-admissions_2025-11-01.csv"),
            "auxiliary-data/target-data-archive/target-hospital-admissions_2025-11-01.csv",
        )

        bad_paths = [
            "../etc/passwd",
            "model-output/../../evil.parquet",
            "/etc/passwd",
            "hub-config\\tasks.json",
            "model-output/Team-Mod/evil\x00.parquet",
            "model-output/Team-Mod/run.py",
            "model-output/Team-Mod/script.sh",
            ".git/config",
            "model-output/.hidden/a.parquet",
            "model-output/synthetic/2025-11-22.parquet",
            "src/app.py",
            "README.md",
            "index.html",
        ]
        for p in bad_paths:
            self.assertIsNone(validate_hubverse_relpath(p), f"expected rejection for {p!r}")

    def test_vzb1_rejects_traversal_and_gzip_bombs(self):
        cfg = WebConfig.from_env(self.data_dir)
        # Disallowed file path inside archive
        evil_payload = _pack_vzb1([("../etc/passwd", b"root:x:0:0")], compress=True)
        with self.assertRaises(UploadValidationError):
            extract_vzb1_stream(io.BytesIO(evil_payload), len(evil_payload), self.scratch_dir / "stage1", cfg, is_gzip=True)

        # Bad magic
        bad_magic = gzip.compress(b"NOT_VZB1_PAYLOAD")
        with self.assertRaises(UploadValidationError):
            extract_vzb1_stream(io.BytesIO(bad_magic), len(bad_magic), self.scratch_dir / "stage2", cfg, is_gzip=True)

        # Zip bomb bounded during streaming decompression (small uncompressed cap)
        os.environ["VIZ_UPLOAD_MAX_UNCOMPRESSED_MB"] = "1"
        small_cfg = WebConfig.from_env(self.data_dir)
        bomb = _pack_vzb1([("target-data/huge.csv", b"0" * (2 * 1024 * 1024))], compress=True)
        self.assertLess(len(bomb), small_cfg.max_compressed_bytes)
        with self.assertRaises(UploadTooLargeError):
            extract_vzb1_stream(io.BytesIO(bomb), len(bomb), self.scratch_dir / "stage3", small_cfg, is_gzip=True)

        # Incompatible tasks.json rejected with 422-mapped UploadIncompatibleError
        bad_tasks = json.dumps({"rounds": []}).encode("utf-8")
        incompat = _pack_vzb1([
            ("hub-config/tasks.json", bad_tasks),
            ("target-data/oracle-output.csv", b"target_end_date,location,oracle_value\n2025-11-22,25,10\n"),
        ], compress=False)
        stage4 = self.scratch_dir / "stage4"
        extract_vzb1_stream(io.BytesIO(incompat), len(incompat), stage4, cfg, is_gzip=False)
        with self.assertRaises(UploadIncompatibleError):
            validate_extracted_hub(stage4)

    # ---- Tier 1 HTTP upload, isolation, security headers, TTL ----

    def test_ephemeral_upload_isolation_ttl_and_security_headers(self):
        mgr, httpd, port = self._start_web_server({"VIZ_UPLOAD_RATE_PER_MIN": "3"})
        try:
            # 1. Health / ready probes + CSP security headers
            st, hdrs, raw = self._http("GET", port, "/healthz")
            self.assertEqual(st, 200)
            self.assertEqual(json.loads(raw)["ok"], True)
            self.assertEqual(hdrs.get("X-Content-Type-Options"), "nosniff")
            self.assertEqual(hdrs.get("X-Frame-Options"), "SAMEORIGIN")
            csp = hdrs.get("Content-Security-Policy", "")
            self.assertIn("script-src 'self'", csp)
            self.assertNotIn("'unsafe-inline' 'self'", csp.split("script-src", 1)[1].split(";", 1)[0])
            self.assertNotIn("Access-Control-Allow-Origin", hdrs)

            st_r, _, raw_r = self._http("GET", port, "/readyz")
            self.assertEqual(st_r, 200)
            self.assertTrue(json.loads(raw_r)["ready"])

            # 2. Missing X-Viz-Upload fails CSRF check
            payload = _pack_vzb1(_sample_hub_entries(), compress=True)
            st_nohdr, _, _ = self._http(
                "POST",
                port,
                "/api/web/upload",
                body=payload,
                headers={"Content-Type": "application/octet-stream", "Content-Encoding": "gzip"},
            )
            self.assertEqual(st_nohdr, 400)

            # 3. Upload valid Hubverse folder ephemerally (with X-Forwarded-Proto: https -> Secure cookie)
            st_up, up_hdrs, up_raw = self._http(
                "POST",
                port,
                "/api/web/upload",
                body=payload,
                headers={
                    "Content-Type": "application/octet-stream",
                    "Content-Encoding": "gzip",
                    "X-Viz-Upload": "1",
                    "X-Viz-Hub-Name": "My%20Local%20Hub",
                    "X-Forwarded-Proto": "https",
                },
            )
            self.assertEqual(st_up, 201, up_raw.decode("utf-8", "replace"))
            set_cookie = up_hdrs.get("Set-Cookie", "")
            self.assertIn("viz_sid=", set_cookie)
            self.assertIn("HttpOnly", set_cookie)
            self.assertIn("SameSite=Lax", set_cookie)
            self.assertIn("Secure", set_cookie)
            jar = http.cookies.SimpleCookie()
            jar.load(set_cookie)
            cookie_hdr = f"viz_sid={jar['viz_sid'].value}"

            hub_info = json.loads(up_raw)["hub"]
            hid = hub_info["id"]
            self.assertTrue(hid.startswith("ephem_"))

            # 4. Owner can query manifest, forecast, metrics, status (with Cache-Control: private, no-store)
            for ep in (
                f"/api/next/manifest?workspace={hid}",
                f"/api/forecast?workspace={hid}&target=wk%20inc%20flu%20hosp&location=25&date=2025-11-22&models=Test-ModelA",
                f"/api/next/metrics?workspace={hid}&target=wk%20inc%20flu%20hosp&location=25&season=2025-2026&horizons=0,1",
                "/api/web/status",
            ):
                st_ok, h_ok, _ = self._http("GET", port, ep, headers={"Cookie": cookie_hdr})
                self.assertEqual(st_ok, 200, f"failed endpoint {ep}")
                self.assertEqual(h_ok.get("Cache-Control"), "private, no-store")

            # 5. Another visitor / no cookie gets 404 and private hub never leaks into global catalog/workspace
            st_anon, _, _ = self._http("GET", port, f"/api/next/manifest?workspace={hid}")
            self.assertEqual(st_anon, 404)
            st_other, _, _ = self._http(
                "GET", port, f"/api/next/manifest?workspace={hid}", headers={"Cookie": "viz_sid=DifferentSessionToken123456"}
            )
            self.assertEqual(st_other, 404)

            _, _, raw_cat = self._http("GET", port, "/api/next/catalog")
            self.assertNotIn(hid, json.dumps(json.loads(raw_cat)))
            _, _, raw_ws = self._http("GET", port, "/api/workspace")
            self.assertNotIn(hid, json.dumps(json.loads(raw_ws)))

            # 6. Rate limiting triggers 429 on rapid bursts (rate limit = 3/min; upload #2 & #3 ok, #4 triggers 429)
            for idx in range(2):
                st_burst, _, _ = self._http(
                    "POST",
                    port,
                    "/api/web/upload",
                    body=payload,
                    headers={
                        "Content-Type": "application/octet-stream",
                        "Content-Encoding": "gzip",
                        "X-Viz-Upload": "1",
                        "Cookie": cookie_hdr,
                    },
                )
                self.assertEqual(st_burst, 201, f"burst {idx} failed")

            st_429, _, _ = self._http(
                "POST",
                port,
                "/api/web/upload",
                body=payload,
                headers={
                    "Content-Type": "application/octet-stream",
                    "Content-Encoding": "gzip",
                    "X-Viz-Upload": "1",
                    "Cookie": cookie_hdr,
                },
            )
            self.assertEqual(st_429, 429)

            # 7. TTL reaper deletes expired ephemeral folders & evicts private HubContext
            reaped = mgr.web_store.reap_expired(now=9e12)
            self.assertGreaterEqual(reaped, 1)
            st_exp, _, _ = self._http("GET", port, f"/api/next/manifest?workspace={hid}", headers={"Cookie": cookie_hdr})
            self.assertEqual(st_exp, 404)

            # 8. Multi-chunk (>400 KiB) upload streams cleanly without BufferError
            big_csv_rows = "\n".join(
                f"2025-11-22,wk inc flu hosp,0,2025-11-22,25,quantile,0.5,{i}" for i in range(9000)
            )
            big_fc = (
                "reference_date,target,horizon,target_end_date,location,output_type,output_type_id,value\n"
                + big_csv_rows + "\n"
            ).encode("utf-8")
            self.assertGreater(len(big_fc), 400_000)
            large_payload = _pack_vzb1([
                e if not e[0].startswith("model-output/") else (e[0], big_fc)
                for e in _sample_hub_entries()
            ], compress=True)
            multi_stage = self.scratch_dir / "stage_multi"
            m_stats = extract_vzb1_stream(
                io.BytesIO(large_payload),
                len(large_payload),
                multi_stage,
                WebConfig.from_env(self.data_dir),
                is_gzip=True,
            )
            self.assertGreater(m_stats.extracted_bytes, 400_000)
            self.assertEqual((multi_stage / "model-output/Test-ModelA/2025-11-22-Test-ModelA.csv").read_bytes(), big_fc)

            # 9. Scheduler telemetry covers all BUILTIN_HUBS dynamically
            tele = mgr.web_scheduler.get_telemetry()
            self.assertEqual([h["id"] for h in tele["hubs"]], [s.id for s in BUILTIN_HUBS])
        finally:
            httpd.shutdown()
            httpd.server_close()

    # ---- Tier 2 SSO proxy trust gating, hot/cold compression & quotas ----

    def test_sso_proxy_trust_gating_hot_cold_archival_and_quotas(self):
        # 1. With VIZ_TRUST_PROXY_AUTH=0, forged proxy headers MUST be ignored
        untrusted_cfg = WebConfig.from_env(self.data_dir)
        self.assertIsNone(
            resolve_request_user({"X-Auth-Request-Email": "attacker@umass.edu", "X-Auth-Request-User": "attacker"}, untrusted_cfg)
        )

        # 2. Launch with VIZ_TRUST_PROXY_AUTH=1 and VIZ_PROXY_SECRET (fails closed without secret)
        proxy_secret = "test-proxy-secret"
        mgr, httpd, port = self._start_web_server({
            "VIZ_TRUST_PROXY_AUTH": "1",
            "VIZ_PROXY_SECRET": proxy_secret,
            "VIZ_SSO_LOGIN_URL": "/oauth2/start",
            "VIZ_USER_MAX_HUBS": "2",
        })
        try:
            payload = _pack_vzb1(_sample_hub_entries(), compress=True)
            # Missing or wrong proxy secret fails closed even when X-Auth-Request-Email is set
            for bad_hdr in (
                {"X-Auth-Request-Email": "alice@umass.edu"},
                {"X-Auth-Request-Email": "alice@umass.edu", "X-Viz-Proxy-Secret": "wrong-secret"},
            ):
                st_bad, _, raw_bad = self._http("GET", port, "/api/web/status", headers=bad_hdr)
                self.assertEqual(st_bad, 200)
                self.assertFalse(json.loads(raw_bad)["auth"]["authenticated"])

            # Anonymous caller trying tier=persistent gets 401
            st_401, _, _ = self._http(
                "POST",
                port,
                "/api/web/upload",
                body=payload,
                headers={
                    "X-Auth-Request-Email": "alice@umass.edu",
                    "Content-Type": "application/octet-stream",
                    "Content-Encoding": "gzip",
                    "X-Viz-Upload": "1",
                    "X-Viz-Storage-Tier": "persistent",
                },
            )
            self.assertEqual(st_401, 401)

            # Authenticated User A (with valid proxy secret) uploads to persistent tier
            hdr_a = {
                "X-Auth-Request-Email": "alice@umass.edu",
                "X-Auth-Request-Preferred-Username": "Alice",
                "X-Viz-Proxy-Secret": proxy_secret,
            }
            st_a, _, raw_a = self._http(
                "POST",
                port,
                "/api/web/upload",
                body=payload,
                headers={
                    **hdr_a,
                    "Content-Type": "application/octet-stream",
                    "Content-Encoding": "gzip",
                    "X-Viz-Upload": "1",
                    "X-Viz-Storage-Tier": "persistent",
                    "X-Viz-Hub-Name": "Alice Research Hub",
                },
            )
            self.assertEqual(st_a, 201, raw_a.decode("utf-8", "replace"))
            hub_a = json.loads(raw_a)["hub"]
            hid_a = hub_a["id"]
            self.assertTrue(hid_a.startswith("user_"))
            self.assertEqual(hub_a["state"], "hot")

            # Authenticated User B cannot access User A's persistent hub
            hdr_b = {"X-Auth-Request-Email": "bob@github.com", "X-Viz-Proxy-Secret": proxy_secret}
            st_b, _, _ = self._http("GET", port, f"/api/next/manifest?workspace={hid_a}", headers=hdr_b)
            self.assertEqual(st_b, 404)

            # Delete blocked for User B (404)
            st_del_b, _, _ = self._http(
                "POST",
                port,
                "/api/web/workspaces/delete",
                body=json.dumps({"id": hid_a}).encode("utf-8"),
                headers={**hdr_b, "Content-Type": "application/json"},
            )
            self.assertEqual(st_del_b, 404)

            # Trigger cold compression after >24h idle
            user_hash_a = hash_identity("alice@umass.edu")
            ws_dir = next((self.data_dir / "users" / user_hash_a).iterdir())
            archived_n = mgr.web_store.archive_cold_workspaces(now=9e12)
            self.assertEqual(archived_n, 1)
            self.assertTrue((ws_dir / "archive.tar.gz").is_file())
            self.assertFalse((ws_dir / "hub").exists())

            # Next access by User A transparently wakes cold archive & returns valid manifest
            st_wake, _, raw_wake = self._http("GET", port, f"/api/next/manifest?workspace={hid_a}", headers=hdr_a)
            self.assertEqual(st_wake, 200)
            man = json.loads(raw_wake)
            self.assertEqual(man["hub_id"], hid_a)
            self.assertTrue((ws_dir / "hub").is_dir())

            # Upload 2nd hub ok; 3rd exceeds VIZ_USER_MAX_HUBS=2 -> 413
            st_a2, _, _ = self._http(
                "POST",
                port,
                "/api/web/upload",
                body=payload,
                headers={
                    **hdr_a,
                    "Content-Type": "application/octet-stream",
                    "Content-Encoding": "gzip",
                    "X-Viz-Upload": "1",
                    "X-Viz-Storage-Tier": "persistent",
                    "X-Viz-Hub-Name": "Hub 2",
                },
            )
            self.assertEqual(st_a2, 201)
            st_a3, _, _ = self._http(
                "POST",
                port,
                "/api/web/upload",
                body=payload,
                headers={
                    **hdr_a,
                    "Content-Type": "application/octet-stream",
                    "Content-Encoding": "gzip",
                    "X-Viz-Upload": "1",
                    "X-Viz-Storage-Tier": "persistent",
                    "X-Viz-Hub-Name": "Hub 3",
                },
            )
            self.assertEqual(st_a3, 413)

            # Owner can delete persistent hub cleanly
            st_del_a, _, _ = self._http(
                "POST",
                port,
                "/api/web/workspaces/delete",
                body=json.dumps({"id": hid_a}).encode("utf-8"),
                headers={**hdr_a, "Content-Type": "application/json"},
            )
            self.assertEqual(st_del_a, 200)
            st_gone, _, _ = self._http("GET", port, f"/api/next/manifest?workspace={hid_a}", headers=hdr_a)
            self.assertEqual(st_gone, 404)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_auth_public_info_hides_when_unconfigured(self):
        cfg = WebConfig.from_env(self.data_dir)
        info = auth_public_info(None, cfg)
        self.assertFalse(info["enabled"])
        self.assertFalse(info["authenticated"])


if __name__ == "__main__":
    unittest.main()
