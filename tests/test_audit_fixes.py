"""Regression tests for security, storage, YAML, sync, ingest, truth, scoring, and cache fixes."""

from email.message import Message
import dataclasses
import gzip
import io
import json
import math
import os
from pathlib import Path
import socket
import socketserver
import struct
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.error
import urllib.request

import numpy as np
import polars as pl

import conftest  # noqa: F401
import server
from viz.core.cache_manager import CACHE_SCHEMA_VERSION, ParquetCacheManager
from viz.core.calendar import CalendarSpec
from viz.core.catalog import canonical_target_concept
from viz.core.ingest import NormalizationError, normalize_forecast_frame
from viz.core.metrics import (
    _ORACLE_MEMO,
    _ORACLE_MEMO_LOCK,
    _ORACLE_MEMO_MAX,
    _prepared_oracle,
    crps_ensemble_1d,
    energy_score,
)
from viz.core.truth import unpivot_wide_truth
from viz.core.workspace import HubManager
from viz.core.yaml_lite import parse_yaml_mapping
from viz.remote.store import RemoteStore
from viz.web.auth import (
    AuthUser,
    RequestIdentity,
    _USER_COOKIE_MAX_LEN,
    generate_session_id,
    hash_identity,
    make_user_cookie_value,
    parse_session_cookie,
    parse_user_cookie,
    resolve_request_user,
)
from viz.web.bundle import (
    MAX_METADATA_FILE_BYTES,
    RateLimitExceededError,
    StorageBudgetExceededError,
    UploadIncompatibleError,
    UploadTimeoutError,
    UploadTooLargeError,
    _BoundedDecompressStream,
    extract_vzb1_stream,
    validate_extracted_hub,
    validate_hubverse_relpath,
)
from viz.web.config import WebConfig, _sanitize_redirect_url
from viz.web.scheduler import WebSyncScheduler
from viz.web.sessions import WebWorkspaceStore


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _pack_vzb1(entries: list[tuple[str, bytes]]) -> bytes:
    buf = bytearray(b"VZB1")
    for rel_path, body in entries:
        p = rel_path.encode("utf-8")
        buf.extend(struct.pack("<I", len(p)))
        buf.extend(p)
        buf.extend(struct.pack("<Q", len(body)))
        buf.extend(body)
    buf.extend(struct.pack("<I", 0))
    return gzip.compress(bytes(buf))


class TestWebAndSecurityFixes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data_dir = self.root / "data"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.scratch_dir = self.root / "scratch"
        self.scratch_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_strict_env_parsing_and_redirect_sanitization(self):
        with mock.patch.dict(os.environ, {"VIZ_TRUST_PROXY_AUTH": "maybe"}):
            with self.assertRaises(ValueError):
                WebConfig.from_env(self.data_dir)
        with mock.patch.dict(os.environ, {"VIZ_EPHEM_MAX_TOTAL_MB": "not-an-int"}):
            with self.assertRaises(ValueError):
                WebConfig.from_env(self.data_dir)
        with mock.patch.dict(os.environ, {"VIZ_SYNC_INTERVAL_HOURS": "bad"}):
            with self.assertRaises(ValueError):
                WebConfig.from_env(self.data_dir)
        for bad_float in ("nan", "inf", "-inf"):
            with mock.patch.dict(os.environ, {"VIZ_SYNC_INTERVAL_HOURS": bad_float}):
                with self.assertRaises(ValueError):
                    WebConfig.from_env(self.data_dir)
        with mock.patch.dict(os.environ, {"VIZ_COOKIE_SECURE": "sometimes"}):
            with self.assertRaises(ValueError):
                WebConfig.from_env(self.data_dir)

        self.assertEqual(_sanitize_redirect_url("/oauth2/start?rd=/"), "/oauth2/start?rd=/")
        self.assertEqual(_sanitize_redirect_url("https://idp.umass.edu/login"), "https://idp.umass.edu/login")
        self.assertEqual(_sanitize_redirect_url("http://localhost:4180/oauth2/start"), "http://localhost:4180/oauth2/start")
        for bad in (
            "http://localhost.evil.com/phish",
            "javascript:alert(1)",
            "data:text/html,<script>",
            "//evil.com/steal",
            "/oauth2\\bad",
        ):
            self.assertEqual(_sanitize_redirect_url(bad), "", f"expected empty for {bad}")

    def test_dev_user_and_proxy_secret_gating(self):
        with mock.patch.dict(os.environ, {"VIZ_MODE": "web", "VIZ_DEV_USER": "alice@umass.edu"}, clear=False):
            cfg_no_allow = WebConfig.from_env(self.data_dir)
            self.assertIsNone(resolve_request_user({}, cfg_no_allow))

        with mock.patch.dict(
            os.environ,
            {"VIZ_MODE": "web", "VIZ_ALLOW_DEV_USER": "1", "VIZ_DEV_USER": "alice@umass.edu"},
            clear=False,
        ):
            cfg_dev = WebConfig.from_env(self.data_dir)
            u_dev = resolve_request_user({}, cfg_dev)
            self.assertIsNotNone(u_dev)
            self.assertEqual(u_dev.email, "alice@umass.edu")

        # Proxy auth without VIZ_PROXY_SECRET fails closed, and overrides VIZ_DEV_USER
        with mock.patch.dict(
            os.environ,
            {
                "VIZ_MODE": "web",
                "VIZ_TRUST_PROXY_AUTH": "1",
                "VIZ_ALLOW_DEV_USER": "1",
                "VIZ_DEV_USER": "alice@umass.edu",
            },
            clear=False,
        ):
            cfg_proxy_no_secret = WebConfig.from_env(self.data_dir)
            self.assertIsNone(resolve_request_user({"X-Auth-Request-Email": "alice@umass.edu"}, cfg_proxy_no_secret))

        with mock.patch.dict(
            os.environ,
            {"VIZ_MODE": "web", "VIZ_TRUST_PROXY_AUTH": "1", "VIZ_PROXY_SECRET": "s3cr3t"},
            clear=False,
        ):
            cfg_proxy = WebConfig.from_env(self.data_dir)
            self.assertIsNone(resolve_request_user({"X-Auth-Request-Email": "alice@umass.edu"}, cfg_proxy))
            self.assertIsNone(
                resolve_request_user({"X-Auth-Request-Email": "alice@umass.edu", "X-Viz-Proxy-Secret": "wrong"}, cfg_proxy)
            )
            u_ok = resolve_request_user({"X-Auth-Request-Email": "alice@umass.edu", "X-Viz-Proxy-Secret": "s3cr3t"}, cfg_proxy)
            self.assertIsNotNone(u_ok)
            self.assertEqual(u_ok.email, "alice@umass.edu")

    def test_bundle_rejects_viz_config_large_metadata_and_target_only(self):
        self.assertIsNone(validate_hubverse_relpath("viz.config.json"))

        with mock.patch.dict(os.environ, {"VIZ_MODE": "web", "VIZ_SCRATCH_DIR": str(self.scratch_dir)}):
            cfg = WebConfig.from_env(self.data_dir)

        # Metadata > 64 KiB rejected during VZB1 extraction
        big_yml = b"team_name: A\nmodel_name: B\nmethods: |\n" + b"  hello world\n" * 6000
        self.assertGreater(len(big_yml), MAX_METADATA_FILE_BYTES)
        gz = _pack_vzb1([
            ("model-metadata/A-B.yml", big_yml),
            ("model-output/A-B/2025-11-22-A-B.csv", b"reference_date,target,horizon,location,target_end_date,output_type,output_type_id,value\n"),
        ])
        out_dir = self.root / "extract1"
        out_dir.mkdir()
        with self.assertRaises(UploadTooLargeError):
            extract_vzb1_stream(io.BytesIO(gz), len(gz), out_dir, cfg, is_gzip=True)

        # Target-data-only hub rejected at validation time
        hub_dir = self.root / "target_only"
        (hub_dir / "hub-config").mkdir(parents=True)
        (hub_dir / "target-data").mkdir(parents=True)
        (hub_dir / "hub-config" / "tasks.json").write_text("{}", encoding="utf-8")
        (hub_dir / "target-data" / "oracle-output.csv").write_text(
            "target_end_date,location,value\n2025-11-22,US,10\n",
            encoding="utf-8",
        )
        with self.assertRaises(UploadIncompatibleError):
            validate_extracted_hub(hub_dir)

    def test_non_evicting_scratch_budget_and_per_ip_limit(self):
        with mock.patch.dict(os.environ, {"VIZ_MODE": "web", "VIZ_SCRATCH_DIR": str(self.scratch_dir)}):
            base_cfg = WebConfig.from_env(self.data_dir)
        cfg = dataclasses.replace(
            base_cfg,
            ephem_max_total_bytes=4000,
            ephem_max_bytes_per_ip=2500,
            ephem_max_hubs_per_session=5,
        )
        store = WebWorkspaceStore(self.data_dir, cfg)

        # Session 1 occupies 2200 bytes under ephem_root/sess1/ephem_s1
        ws1 = store.ephem_root / "sess1" / "ephem_s1"
        (ws1 / "hub").mkdir(parents=True)
        (ws1 / "hub" / "data.bin").write_bytes(b"x" * 2200)
        (ws1 / "meta.json").write_text(
            json.dumps({
                "hub_id": "ephem_s1",
                "tier": "ephem",
                "owner_hash": "sess1",
                "client_ip_hash": "ip1",
                "last_accessed_at": time.time(),
            }),
            encoding="utf-8",
        )

        # Same IP exceeding 2500 bytes hits RateLimitExceededError (429), without deleting s1
        with self.assertRaises(RateLimitExceededError):
            store._enforce_ephem_limits(store.ephem_root / "sess2", 500, client_ip_hash="ip1")
        self.assertTrue(ws1.exists())

        # Different IP exceeding global 4000 bytes hits StorageBudgetExceededError (507), without deleting s1
        with self.assertRaises(StorageBudgetExceededError):
            store._enforce_ephem_limits(store.ephem_root / "sess3", 2000, client_ip_hash="ip2")
        self.assertTrue(ws1.exists())

    def test_client_ip_uses_rightmost_trusted_proxy_hop(self):
        with mock.patch.dict(os.environ, {"VIZ_MODE": "web"}):
            base_cfg = WebConfig.from_env(self.data_dir)
        fake_handler = server.SandboxRequestHandler.__new__(server.SandboxRequestHandler)
        fake_handler.client_address = ("10.244.0.1", 12345)
        fake_handler.headers = {"X-Forwarded-For": "203.0.113.9, 198.51.100.7, 10.0.0.5"}

        class _StubMgr:
            mode = "web"

            def __init__(self, wcfg):
                self.web_config = wcfg

        fake_handler._mgr = lambda: _StubMgr(dataclasses.replace(base_cfg, trusted_proxy_hops=0))
        self.assertEqual(fake_handler._client_ip(), "10.244.0.1")

        fake_handler._mgr = lambda: _StubMgr(dataclasses.replace(base_cfg, trusted_proxy_hops=1))
        self.assertEqual(fake_handler._client_ip(), "10.0.0.5")

        fake_handler._mgr = lambda: _StubMgr(dataclasses.replace(base_cfg, trusted_proxy_hops=2))
        self.assertEqual(fake_handler._client_ip(), "198.51.100.7")

    def test_cookie_parsing_resilience_unicode_and_tamper(self):
        with mock.patch.dict(
            os.environ,
            {"VIZ_MODE": "web", "VIZ_TRUST_PROXY_AUTH": "1", "VIZ_PROXY_SECRET": "cookie-secret"},
        ):
            cfg = WebConfig.from_env(self.data_dir)
        sid = generate_session_id()
        long_unicode_name = "Dr. Jöhn Döe — " + ("Ünicøde " * 250)
        u = AuthUser(user_id="alice@umass.edu", email="alice@umass.edu", display_name=long_unicode_name, user_hash="x")
        tok = make_user_cookie_value(u, cfg, now=1000.0)
        self.assertIsNotNone(tok)
        self.assertLessEqual(len(tok), _USER_COOKIE_MAX_LEN)

        # Malformed sibling cookie in same Cookie header + long total cookie header (> 200 chars)
        hdrs = {
            "Cookie": f"bad[name]=1; padding={'a' * 300}; viz_user={tok}; viz_sid={sid}",
        }
        parsed = parse_user_cookie(hdrs, cfg, now=1001.0)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed.email, "alice@umass.edu")
        self.assertEqual(parse_session_cookie(hdrs), sid)

        # Multiple Cookie headers (HTTPMessage)
        multi = Message()
        multi["Cookie"] = "other=1; malformed[cookie]=bad"
        multi["Cookie"] = f"viz_user=\"{tok}\"; viz_sid={sid}"
        self.assertIsNotNone(parse_user_cookie(multi, cfg, now=1001.0))
        self.assertEqual(parse_session_cookie(multi), sid)

        # Non-ASCII tampering in signed body fails closed
        body, sig = tok.split(".", 1)
        self.assertIsNone(parse_user_cookie({"Cookie": f"viz_user={body}é.{sig}"}, cfg, now=1001.0))

    def test_scheduler_exponential_backoff_shortens_wait_for_unsynced_failures(self):
        with mock.patch.dict(os.environ, {"VIZ_MODE": "web"}):
            cfg = WebConfig.from_env(self.data_dir)

        class _Store:
            def __init__(self, synced):
                self._synced = synced

            def has_data(self, hid):
                return hid in self._synced

        class _Mgr:
            def __init__(self, synced):
                self.remote_store = _Store(synced)

        store_synced = set()
        sched = WebSyncScheduler(_Mgr(store_synced), cfg)
        sync_sec = 6.0 * 3600.0
        # Default tick with no failures stays at 6h
        self.assertAlmostEqual(sched._next_sleep_seconds(sync_sec, sync_sec, now=1000.0), sync_sec)

        # 1st failure -> wakes ~900s (15 min) later instead of sleeping 6h
        sched._hub_failures["flusight"] = (1, 1000.0)
        self.assertAlmostEqual(sched._next_sleep_seconds(sync_sec, sync_sec, now=1000.0), 900.0)

        # 2nd failure -> wakes ~1800s (30 min) later
        sched._hub_failures["flusight"] = (2, 1000.0)
        self.assertAlmostEqual(sched._next_sleep_seconds(sync_sec, sync_sec, now=1000.0), 1800.0)

        # Once hub has synced data, backoff no longer forces early wakeups
        store_synced.add("flusight")
        self.assertAlmostEqual(sched._next_sleep_seconds(sync_sec, sync_sec, now=1000.0), sync_sec)

    def test_staging_leftover_nested_mtime_and_locked_list_expiry(self):
        with mock.patch.dict(
            os.environ,
            {"VIZ_MODE": "web", "VIZ_SCRATCH_DIR": str(self.scratch_dir), "VIZ_UPLOAD_MIN_KBPS": "128"},
        ):
            cfg = WebConfig.from_env(self.data_dir)
        store = WebWorkspaceStore(self.data_dir, cfg)

        # Nested activity keeps a staging directory alive past top-level dir mtime
        staging_dir = self.scratch_dir / ".staging" / "viz-up-slow"
        sub = staging_dir / "nested"
        sub.mkdir(parents=True)
        payload = sub / "chunk.bin"
        payload.write_bytes(b"abc")
        old_t = 1_000_000.0
        os.utime(sub, (old_t, old_t))
        os.utime(staging_dir, (old_t, old_t))
        recent_t = old_t + 950.0
        os.utime(payload, (recent_t, recent_t))
        self.assertEqual(store.cleanup_leftovers(max_age_seconds=900.0, now=recent_t + 100.0), 0)
        self.assertTrue(staging_dir.exists())
        self.assertEqual(store.cleanup_leftovers(max_age_seconds=900.0, now=recent_t + 901.0), 1)
        self.assertFalse(staging_dir.exists())

        # Double-checked lock in list_for_identity respects concurrent expiration bump
        sid = "session-renewed-id-1234567890"
        sid_hash = hash_identity(f"sid:{sid}")
        hid = "ephem_0123456789ab_renew"
        ws_dir = store.ephem_root / sid_hash / hid
        (ws_dir / "hub").mkdir(parents=True)
        meta_path = ws_dir / "meta.json"
        meta_path.write_text(
            json.dumps({
                "hub_id": hid,
                "tier": "ephem",
                "owner_hash": sid_hash,
                "expires_at": 1000.0,
                "last_accessed_at": 900.0,
            }),
            encoding="utf-8",
        )
        # Re-read under lock returns a renewed expiry -> item must stay alive
        from viz.web import sessions as sess_mod
        orig_read = sess_mod._read_json
        calls = {"n": 0}

        def _fake_read(p):
            calls["n"] += 1
            res = orig_read(p)
            if p == meta_path and calls["n"] >= 2 and isinstance(res, dict):
                res = dict(res, expires_at=5000.0)
            return res

        with mock.patch.object(sess_mod, "_read_json", side_effect=_fake_read):
            listed = store.list_for_identity(RequestIdentity(sid=sid, sid_hash=sid_hash, user=None), now=2000.0)
        self.assertEqual([w["id"] for w in listed["ephemeral"]], [hid])
        self.assertTrue(ws_dir.exists())

    def test_auth_login_logout_cookies_and_upload_timeout_408(self):
        # Unit check for _BoundedVzb1Stream calling read1() and raising UploadTimeoutError
        class _TrickleReader:
            def __init__(self):
                self.used_read1 = False

            def read1(self, n):
                self.used_read1 = True
                time.sleep(0.06)
                return b"a"

            def read(self, n):
                raise AssertionError("read() should not be preferred over read1()")

        tr = _TrickleReader()
        stream = _BoundedDecompressStream(
            tr,
            100,
            is_gzip=False,
            max_compressed=1024,
            max_uncompressed=1024,
            deadline=time.monotonic() + 0.03,
        )
        with self.assertRaises(UploadTimeoutError):
            stream._read_with_deadline(64)
            stream._read_with_deadline(64)
        self.assertTrue(tr.used_read1)

        prev_mgr = server.HUB_MANAGER
        prev_handler_mgr = getattr(server.SandboxRequestHandler, "hub_manager", None)
        with mock.patch.dict(
            os.environ,
            {
                "VIZ_MODE": "web",
                "VIZ_DATA_DIR": str(self.data_dir),
                "VIZ_SCRATCH_DIR": str(self.scratch_dir),
                "VIZ_AUTO_SYNC": "0",
                "VIZ_TRUST_PROXY_AUTH": "1",
                "VIZ_PROXY_SECRET": "login-secret",
                "VIZ_SSO_LOGOUT_URL": "/oauth2/sign_out",
            },
            clear=False,
        ):
            mgr = HubManager(data_dir=self.data_dir, mode="web", include_enclosing=False)
            server.HUB_MANAGER = mgr
            server.SandboxRequestHandler.hub_manager = mgr
            socketserver.ThreadingTCPServer.allow_reuse_address = True
            httpd = server.BoundedThreadingTCPServer(("127.0.0.1", 0), server.SandboxRequestHandler, max_workers=4)
            port = httpd.server_address[1]
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            opener = urllib.request.build_opener(_NoRedirect())
            try:
                # /auth/login exchanges proxy headers for signed viz_user cookie with private cache headers
                req = urllib.request.Request(f"http://127.0.0.1:{port}/auth/login?rd=/next/%3Ftab%3Dscores")
                req.add_header("X-Auth-Request-Email", "alice@umass.edu")
                req.add_header("X-Auth-Request-Preferred-Username", "Alice")
                req.add_header("X-Viz-Proxy-Secret", "login-secret")
                with self.assertRaises(urllib.error.HTTPError) as ctx:
                    opener.open(req, timeout=5)
                err_resp = ctx.exception
                try:
                    self.assertEqual(err_resp.code, 302)
                    self.assertEqual(err_resp.headers.get("Location"), "/next/?tab=scores")
                    self.assertIn("private", (err_resp.headers.get("Cache-Control") or "").lower())
                    self.assertIn("Cookie", err_resp.headers.get("Vary") or "")
                    set_cookies = err_resp.headers.get_all("Set-Cookie") or []
                    user_cookie_hdr = next((c for c in set_cookies if c.startswith("viz_user=")), "")
                    self.assertTrue(user_cookie_hdr)
                    cookie_pair = user_cookie_hdr.split(";", 1)[0]
                finally:
                    err_resp.close()

                # Signed viz_user cookie authenticates subsequent requests without proxy headers
                with urllib.request.urlopen(
                    urllib.request.Request(f"http://127.0.0.1:{port}/api/web/status", headers={"Cookie": cookie_pair}),
                    timeout=5,
                ) as st_resp:
                    st_data = json.loads(st_resp.read().decode("utf-8"))
                    self.assertTrue(st_data["auth"]["authenticated"])
                    self.assertEqual(st_data["auth"]["email"], "alice@umass.edu")

                # /auth/logout clears viz_user cookie (Max-Age=0) and sets private cache headers
                with self.assertRaises(urllib.error.HTTPError) as lo_ctx:
                    opener.open(urllib.request.Request(f"http://127.0.0.1:{port}/auth/logout"), timeout=5)
                lo_resp = lo_ctx.exception
                try:
                    self.assertEqual(lo_resp.code, 302)
                    self.assertEqual(lo_resp.headers.get("Location"), "/oauth2/sign_out")
                    self.assertIn("private", (lo_resp.headers.get("Cache-Control") or "").lower())
                    lo_cookies = lo_resp.headers.get_all("Set-Cookie") or []
                    self.assertTrue(any(c.startswith("viz_user=") and "Max-Age=0" in c for c in lo_cookies))
                finally:
                    lo_resp.close()

                # Live upload hitting wall-clock deadline returns HTTP 408 Request Timeout
                from viz.web import bundle as bundle_mod
                orig_stream_cls = bundle_mod._BoundedDecompressStream

                def _short_deadline_stream(*args, **kwargs):
                    kwargs["deadline"] = time.monotonic() + 0.05
                    return orig_stream_cls(*args, **kwargs)

                with mock.patch.object(bundle_mod, "_BoundedDecompressStream", side_effect=_short_deadline_stream):
                    with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
                        sock.sendall(
                            (
                                f"POST /api/web/upload HTTP/1.1\r\n"
                                f"Host: 127.0.0.1:{port}\r\n"
                                f"Content-Type: application/octet-stream\r\n"
                                f"Content-Length: 4096\r\n"
                                f"X-Viz-Upload: 1\r\n"
                                f"Connection: close\r\n\r\n"
                                f"VZB1"
                            ).encode("ascii")
                        )
                        time.sleep(0.1)
                        raw_http = b""
                        while True:
                            chunk = sock.recv(4096)
                            if not chunk:
                                break
                            raw_http += chunk
                        self.assertIn(b" 408 Request Timeout", raw_http)
            finally:
                httpd.shutdown()
                httpd.server_close()
                server.HUB_MANAGER = prev_mgr
                server.SandboxRequestHandler.hub_manager = prev_handler_mgr


class TestCoreAndSyncAuditFixes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_yaml_lite_performance_bom_quotes_comments_and_flow(self):
        # 128 KB multiline description parses in well under 0.5 s (O(N), not quadratic)
        big_lines = "\n".join(f"  line {i}: value {i}" for i in range(5000))
        big_yaml = (
            "\ufeffteam_name: 'UMass' # team comment\n"
            "model_name: It's a model # real comment\n"
            'meta: {a: "x, y # kept", b: [1, "two, three", true]} # tail comment\n'
            'notes: [\n'
            '  "item #1", # element [ignored] comment\n'
            '  "item #2"\n'
            ']\n'
            f"methods_long: |\n{big_lines}\n"
        )
        self.assertGreater(len(big_yaml), 64 * 1024)
        t0 = time.monotonic()
        parsed = parse_yaml_mapping(big_yaml)
        elapsed = time.monotonic() - t0
        self.assertLess(elapsed, 0.5)
        self.assertEqual(parsed["team_name"], "UMass")
        self.assertEqual(parsed["model_name"], "It's a model")
        self.assertEqual(parsed["meta"], {"a": "x, y # kept", "b": [1, "two, three", True]})
        self.assertEqual(parsed["notes"], ["item #1", "item #2"])
        self.assertIn("line 4999: value 4999", parsed["methods_long"])

    def test_remote_store_deep_copy_and_corrupt_json_quarantine(self):
        store = RemoteStore(self.root / "remote")
        store.save_manifest("flusight", {"synced_seasons": ["2025-2026"], "rounds": {"2025-11-22": {"m": 1}}})
        # Readers share one cached read-only snapshot (no per-call deep copy on hot paths)...
        self.assertIs(store.load_manifest("flusight"), store.load_manifest("flusight"))
        # ...while writers get a private copy that never leaks into the shared snapshot.
        snap = store.load_manifest("flusight", mutable=True)
        snap["rounds"]["mutated"] = 999
        snap["synced_seasons"].append("tampered")

        fresh = store.load_manifest("flusight")
        self.assertNotIn("mutated", fresh["rounds"])
        self.assertEqual(fresh["synced_seasons"], ["2025-2026"])

        # Saving replaces the snapshot wholesale; a reader holding the old one is unaffected.
        old_snapshot = fresh
        store.save_manifest("flusight", snap)
        self.assertIn("mutated", store.load_manifest("flusight")["rounds"])
        self.assertNotIn("mutated", old_snapshot["rounds"])

        hubs_file = store.root / "hubs.json"
        hubs_file.parent.mkdir(parents=True, exist_ok=True)
        hubs_file.write_text("{corrupt-json", encoding="utf-8")
        specs = store.hub_specs()
        self.assertGreater(len(specs), 0)
        quarantined = list(store.root.glob("hubs.corrupt.*.json"))
        self.assertTrue(quarantined, "expected corrupt hubs.json to be quarantined")

    def test_truth_measure_family_guard_and_monthly_ingest(self):
        df_wide = pl.DataFrame({
            "target_end_date": ["2025-11-22"],
            "location": ["US"],
            "flu_pct_positive": [12.5],
        })
        self.assertIsNone(unpivot_wide_truth(df_wide, ["wk inc flu hosp"]))

        # Proportion column must never map onto a count target even in the same ED family
        df_wide_ed = pl.DataFrame({
            "target_end_date": ["2025-11-22"],
            "location": ["US"],
            "influenza_pct_ed_visits": [4.2],
        })
        self.assertIsNone(unpivot_wide_truth(df_wide_ed, ["wk inc flu ed visits"]))

        # Monthly forecast target derives integer horizon & month-start / month-end target_end_date
        cal = CalendarSpec()
        mo_df = pl.DataFrame({
            "reference_date": ["2025-10-01", "2025-10-01", "2024-02-29", "2024-04-30"],
            "target": ["mo inc dengue cases"] * 4,
            "horizon": [None, 2, 1, 1],
            "target_end_date": ["2025-11-01", None, None, None],
            "location": ["CN"] * 4,
            "output_type": ["quantile"] * 4,
            "output_type_id": ["0.5"] * 4,
            "value": [10.0, 12.0, 15.0, 18.0],
        })
        norm = normalize_forecast_frame(
            mo_df,
            model="GZNL-Test",
            reference_date="2025-10-01",
            calendar=cal,
            known_locations={"CN"},
        )
        rows = sorted(norm.quantiles.iter_rows(named=True), key=lambda r: (r["reference_date"], r["horizon"]))
        self.assertEqual([(r["reference_date"], r["horizon"], r["target_end_date"]) for r in rows], [
            ("2024-02-29", 1, "2024-03-31"),
            ("2024-04-30", 1, "2024-05-31"),
            ("2025-10-01", 1, "2025-11-01"),
            ("2025-10-01", 2, "2025-12-01"),
        ])

        # Off-cadence target_end_date (4 days from Saturday reference_date) with null horizon fails derivation loudly
        bad_df = pl.DataFrame({
            "reference_date": ["2025-11-22"],
            "target": ["wk inc flu hosp"],
            "horizon": [None],
            "target_end_date": ["2025-11-26"],
            "location": ["US"],
            "output_type": ["quantile"],
            "output_type_id": ["0.5"],
            "value": [100.0],
        })
        with self.assertRaises(NormalizationError):
            normalize_forecast_frame(bad_df, model="Bad-Model", reference_date="2025-11-22")

    def test_metrics_finite_filter_and_ontario_bed_occupancy(self):
        clean = crps_ensemble_1d(np.array([10.0, 20.0]), 15.0)
        noisy = crps_ensemble_1d(np.array([10.0, float("nan"), float("inf"), 20.0]), 15.0)
        self.assertAlmostEqual(clean, noisy, places=12)
        self.assertTrue(math.isnan(crps_ensemble_1d(np.array([float("nan")]), 15.0)))
        self.assertTrue(math.isnan(crps_ensemble_1d(np.array([10.0, 20.0]), float("nan"))))

        es_clean = energy_score(np.array([[1.0, 2.0], [3.0, 4.0]]), np.array([2.0, 3.0]))
        es_noisy = energy_score(np.array([[1.0, 2.0], [float("nan"), 3.0], [3.0, 4.0]]), np.array([2.0, 3.0]))
        self.assertAlmostEqual(es_clean, es_noisy, places=12)
        self.assertTrue(math.isnan(energy_score(np.array([[float("nan"), 1.0]]), np.array([1.0, 1.0]))))

        beds = canonical_target_concept("flu_hosp_beds", {"display_name": "Influenza hospital bed occupancy"}, "influenza")
        adm = canonical_target_concept("wk inc flu hosp", {"display_name": "Weekly flu hospitalizations"}, "influenza")
        self.assertEqual(beds[0], "flu_hosp_beds")
        self.assertEqual(adm[0], "flu_hosp")
        self.assertEqual(beds[2], False)

    def test_cache_manager_schema_sentinel_and_file_mtime_invalidation(self):
        hub_dir = self.root / "hub"
        (hub_dir / "hub-config").mkdir(parents=True)
        (hub_dir / "model-output" / "M-1").mkdir(parents=True)
        (hub_dir / "hub-config" / "tasks.json").write_text("{}", encoding="utf-8")
        csv_path = hub_dir / "model-output" / "M-1" / "2025-11-22-M-1.csv"
        csv_path.write_text(
            "reference_date,target,horizon,location,target_end_date,output_type,output_type_id,value\n"
            "2025-11-22,wk inc flu hosp,0,US,2025-11-22,quantile,0.5,10\n",
            encoding="utf-8",
        )
        cache_dir = hub_dir / "viz" / ".cache"
        mgr = ParquetCacheManager(hub_dir, include_remote=False, cache_dir=cache_dir)
        pq1 = mgr.get_model_parquet("M-1")
        self.assertIsNotNone(pq1)
        self.assertEqual(pl.read_parquet(pq1).get_column("value").to_list(), [10.0])

        # Overwriting the same CSV preserves directory entry count while changing file mtime/size
        time.sleep(0.02)
        csv_path.write_text(
            "reference_date,target,horizon,location,target_end_date,output_type,output_type_id,value\n"
            "2025-11-22,wk inc flu hosp,0,US,2025-11-22,quantile,0.5,425.5\n",
            encoding="utf-8",
        )
        pq2 = mgr.get_model_parquet("M-1")
        self.assertIsNotNone(pq2)
        self.assertEqual(pl.read_parquet(pq2).get_column("value").to_list(), [425.5])

        # Stale schema sentinel wipes derived cache cleanly while keeping hub files intact
        sentinel = cache_dir / ".cache_schema_version"
        self.assertEqual(int(sentinel.read_text(encoding="utf-8").strip()), CACHE_SCHEMA_VERSION)
        sentinel.write_text("1\n", encoding="utf-8")
        ParquetCacheManager(hub_dir, include_remote=False, cache_dir=cache_dir)
        self.assertEqual(int(sentinel.read_text(encoding="utf-8").strip()), CACHE_SCHEMA_VERSION)
        self.assertFalse(pq2.exists())
        self.assertTrue(csv_path.exists())

    def test_oracle_memo_caches_many_targets_per_frame_and_bounds_frames(self):
        with _ORACLE_MEMO_LOCK:
            _ORACLE_MEMO.clear()
        oracle_a = pl.DataFrame({
            "location": ["US"] * 6,
            "target_end_date": ["2025-11-22"] * 6,
            "target": [f"t{i}" for i in range(6)],
            "oracle_value": [float(i + 1) for i in range(6)],
        })
        for i in range(6):
            _prepared_oracle(oracle_a, f"t{i}")
        with _ORACLE_MEMO_LOCK:
            self.assertEqual(len(_ORACLE_MEMO), 1)
            self.assertEqual(len(_ORACLE_MEMO[id(oracle_a)][1]), 6)

        # Adding _ORACLE_MEMO_MAX newer distinct oracle frames evicts oracle_a cleanly
        others = [
            pl.DataFrame({"location": ["US"], "target_end_date": ["2025-11-22"], "target": ["t0"], "oracle_value": [float(k)]})
            for k in range(_ORACLE_MEMO_MAX)
        ]
        for df in others:
            _prepared_oracle(df, "t0")
        with _ORACLE_MEMO_LOCK:
            self.assertEqual(len(_ORACLE_MEMO), _ORACLE_MEMO_MAX)
            self.assertNotIn(id(oracle_a), _ORACLE_MEMO)
