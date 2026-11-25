"""Regression tests for the second fix pass: store deadlock, sync failure handling, eviction order,
signed sign-in cookie, API admission control, upload deadline, and scheduler backoff."""

import dataclasses
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock

import conftest  # noqa: F401
import server
import test_remote_hubs as _remote_hub_tests  # imported as a module so its tests are not collected twice
from viz.remote.store import RemoteStore
from viz.web.auth import (
    USER_COOKIE_NAME,
    make_user_cookie_value,
    parse_user_cookie,
    resolve_proxy_header_user,
    resolve_request_user,
    safe_local_redirect,
)
from viz.web.bundle import UploadTimeoutError, _BoundedDecompressStream
from viz.web.config import WebConfig
from viz.web.scheduler import WebSyncScheduler
from viz.web.sessions import WebWorkspaceStore


def _web_cfg(data_dir: Path, **env) -> WebConfig:
    base = {"VIZ_MODE": "web", "VIZ_SCRATCH_DIR": str(data_dir / "scratch")}
    base.update(env)
    with mock.patch.dict(os.environ, base):
        return WebConfig.from_env(data_dir)


class TestRemoteStoreLocking(unittest.TestCase):
    def test_corrupt_registry_during_write_does_not_deadlock(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = RemoteStore(Path(tmp))
            store.registry_path.parent.mkdir(parents=True, exist_ok=True)
            store.registry_path.write_text("{not json", encoding="utf-8")

            t = threading.Thread(target=store.set_enabled, args=("flusight", False), daemon=True)
            t.start()
            t.join(timeout=5)
            self.assertFalse(t.is_alive(), "set_enabled deadlocked on a corrupt hubs.json")
            # The write went through, and later manifest saves are not blocked either.
            self.assertFalse(store.is_enabled("flusight"))
            store.save_manifest("flusight", {"files": {}})
            self.assertTrue(list(store.root.glob("hubs.corrupt.*.json")))


class TestSyncFailureHandling(unittest.TestCase):
    """Reuses the fake-S3 hub from test_remote_hubs without re-running its tests."""

    def setUp(self):
        _remote_hub_tests.TestSyncLifecycle.setUp(self)

    def tearDown(self):
        _remote_hub_tests.TestSyncLifecycle.tearDown(self)

    _sync = _remote_hub_tests.TestSyncLifecycle._sync

    def test_truth_failure_keeps_forecasts_and_retries_truth(self):
        with mock.patch(
            "viz.remote.sync.RemoteManager._sync_truth", side_effect=ValueError("oracle schema changed")
        ):
            job = self._sync()
        self.assertEqual(job["status"], "done", job.get("error"))
        self.assertEqual(job["summary"]["added"], 4)
        self.assertIn("oracle schema changed", job["summary"]["truth_error"])

        man = self.loader.remote_store.load_manifest("flusight")
        self.assertEqual(len(man["files"]), 4)
        self.assertTrue(man["pending"]["truth_changed"], "truth should be retried on the next cycle")
        self.assertTrue(any("Truth data could not be refreshed" in w for w in man.get("hub_warnings", [])))

        # The next sync re-downloads nothing and fills in truth.
        requests_before = self.s3.requests
        job2 = self._sync()
        self.assertEqual(job2["status"], "done", job2.get("error"))
        self.assertEqual(job2["summary"]["added"], 0)
        self.assertIsNone(job2["summary"]["truth_error"])
        self.assertFalse(self.loader.remote_store.load_manifest("flusight")["pending"]["truth_changed"])
        self.assertGreater(self.s3.requests, requests_before)

    def test_check_does_not_overwrite_a_newer_sync(self):
        self.assertEqual(self._sync()["status"], "done")
        res = self.mgr.check("flusight")
        man = self.loader.remote_store.load_manifest("flusight")
        self.assertEqual(len(man["files"]), 4)
        self.assertEqual(man["pending"]["checked_at"], res["pending"]["checked_at"])

    def test_readers_share_one_snapshot_and_status_is_memoized(self):
        self.assertEqual(self._sync()["status"], "done")
        store = self.loader.remote_store
        self.assertIs(store.load_manifest("flusight"), store.load_manifest("flusight"))
        spec = store.get_spec("flusight")
        a = self.mgr.hub_status(spec)
        b = self.mgr.hub_status(spec)
        self.assertEqual(a["files"], 4)
        self.assertEqual(a["files"], b["files"])


class TestEphemEvictionOrder(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _ws(self, store, sess, hub_id, size, *, ip="ip1", last=None):
        ws = store.ephem_root / sess / hub_id
        (ws / "hub").mkdir(parents=True)
        (ws / "hub" / "data.bin").write_bytes(b"x" * size)
        meta = {"hub_id": hub_id, "tier": "ephem", "client_ip_hash": ip, "created_at": last or time.time()}
        if last is not None:
            meta["last_accessed_at"] = last
        (ws / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        return ws

    def test_rejected_upload_keeps_own_hubs(self):
        cfg = dataclasses.replace(
            _web_cfg(self.data_dir),
            ephem_max_total_bytes=5000,
            ephem_max_bytes_per_ip=100_000,
            ephem_max_hubs_per_session=1,
        )
        store = WebWorkspaceStore(self.data_dir, cfg)
        own = self._ws(store, "sess1", "ephem_aaaaaaaaaaaa_a", 1000)
        other = self._ws(store, "sess2", "ephem_bbbbbbbbbbbb_b", 3500, ip="ip2")
        # Replacing own 1000 B hub still leaves 3500 + 2000 > 5000, and the other hub is active: reject.
        with self.assertRaises(Exception):
            store._enforce_ephem_limits(store.ephem_root / "sess1", 2000, client_ip_hash="ip1")
        self.assertTrue(own.exists(), "own hub must survive a rejected upload")
        self.assertTrue(other.exists(), "an active hub of another session is never evicted")

    def test_idle_hubs_of_others_are_reclaimed_when_full(self):
        cfg = dataclasses.replace(
            _web_cfg(self.data_dir), ephem_max_total_bytes=5000, ephem_max_bytes_per_ip=100_000
        )
        store = WebWorkspaceStore(self.data_dir, cfg)
        idle = self._ws(store, "sess2", "ephem_bbbbbbbbbbbb_b", 3500, ip="ip2", last=time.time() - 3600)
        store._enforce_ephem_limits(store.ephem_root / "sess1", 2000, client_ip_hash="ip1")
        self.assertFalse(idle.exists(), "a long-idle hub should be reclaimed for a new upload")


class TestSignedUserCookie(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = _web_cfg(
            Path(self.tmp.name), VIZ_TRUST_PROXY_AUTH="1", VIZ_PROXY_SECRET="s3cret-value", VIZ_USER_SESSION_HOURS="1"
        )

    def tearDown(self):
        self.tmp.cleanup()

    def _login_headers(self, **extra):
        h = {"X-Auth-Request-Email": "alice@umass.edu", "X-Viz-Proxy-Secret": "s3cret-value"}
        h.update(extra)
        return h

    def test_round_trip_tamper_and_expiry(self):
        user = resolve_proxy_header_user(self._login_headers(), self.cfg)
        self.assertEqual(user.email, "alice@umass.edu")
        value = make_user_cookie_value(user, self.cfg)
        cookie_hdr = {"Cookie": f"_oauth2_proxy={'z' * 900}; {USER_COOKIE_NAME}={value}"}
        parsed = parse_user_cookie(cookie_hdr, self.cfg)
        self.assertIsNotNone(parsed, "long Cookie headers must not truncate the session")
        self.assertEqual(parsed.user_hash, user.user_hash)
        self.assertEqual(resolve_request_user(cookie_hdr, self.cfg).user_hash, user.user_hash)

        body, sig = value.split(".")
        forged = body[:-2] + ("A" if body[-2] != "A" else "B") + body[-1] + "." + sig
        self.assertIsNone(parse_user_cookie({"Cookie": f"{USER_COOKIE_NAME}={forged}"}, self.cfg))
        self.assertIsNone(parse_user_cookie({"Cookie": f"{USER_COOKIE_NAME}={value}"}, self.cfg, now=time.time() + 7200))

        other = dataclasses.replace(self.cfg, proxy_secret="rotated")
        self.assertIsNone(parse_user_cookie({"Cookie": f"{USER_COOKIE_NAME}={value}"}, other))
        no_trust = dataclasses.replace(self.cfg, trust_proxy_auth=False)
        self.assertIsNone(parse_user_cookie({"Cookie": f"{USER_COOKIE_NAME}={value}"}, no_trust))

    def test_identity_headers_without_secret_are_ignored(self):
        self.assertIsNone(resolve_proxy_header_user({"X-Auth-Request-Email": "mallory@umass.edu"}, self.cfg))
        self.assertIsNone(
            resolve_request_user({"X-Auth-Request-Email": "mallory@umass.edu", "X-Viz-Proxy-Secret": "nope"}, self.cfg)
        )

    def test_safe_local_redirect(self):
        self.assertEqual(safe_local_redirect("/next/?hub=x"), "/next/?hub=x")
        for bad in ("https://evil.example", "//evil.example", "/\\evil", "javascript:alert(1)", "", None, "/a\nb"):
            self.assertEqual(safe_local_redirect(bad), "/next/", bad)

    def test_login_route_sets_cookie_and_redirects(self):
        mgr = mock.Mock()
        mgr.mode = "web"
        mgr.web_config = self.cfg
        handler = server.SandboxRequestHandler.__new__(server.SandboxRequestHandler)
        handler.headers = self._login_headers()
        handler._set_cookies = []
        sent = {}
        handler._send_redirect = lambda loc: sent.setdefault("location", loc)
        handler._send_json = lambda body, status=200: sent.setdefault("status", status)
        handler._handle_auth_login(mgr, {"rd": ["/next/?hub=flusight"]})
        self.assertEqual(sent.get("location"), "/next/?hub=flusight")
        self.assertTrue(any(c.startswith(f"{USER_COOKIE_NAME}=") and "HttpOnly" in c for c in handler._set_cookies))

        handler2 = server.SandboxRequestHandler.__new__(server.SandboxRequestHandler)
        handler2.headers = {"X-Auth-Request-Email": "mallory@umass.edu"}
        handler2._set_cookies = []
        sent2 = {}
        handler2._send_redirect = lambda loc: sent2.setdefault("location", loc)
        handler2._send_json = lambda body, status=200: sent2.setdefault("status", status)
        handler2._handle_auth_login(mgr, {})
        self.assertEqual(sent2.get("status"), 401)
        self.assertEqual(handler2._set_cookies, [])


class TestAdmissionControl(unittest.TestCase):
    def test_per_client_cap(self):
        srv = server.BoundedThreadingTCPServer(
            ("127.0.0.1", 0), server.SandboxRequestHandler, max_workers=8, max_per_client=2
        )
        try:
            self.assertTrue(srv.acquire_api_slot(timeout=0.01, client_key="a"))
            self.assertTrue(srv.acquire_api_slot(timeout=0.01, client_key="a"))
            self.assertFalse(srv.acquire_api_slot(timeout=0.01, client_key="a"))
            self.assertTrue(srv.acquire_api_slot(timeout=0.01, client_key="b"))
            srv.release_api_slot(client_key="a")
            self.assertTrue(srv.acquire_api_slot(timeout=0.01, client_key="a"))
            # Local mode passes no key: only the global cap applies.
            self.assertTrue(srv.acquire_api_slot(timeout=0.01))
        finally:
            srv.server_close()


class TestUploadDeadline(unittest.TestCase):
    def test_expired_deadline_raises_timeout(self):
        stream = _BoundedDecompressStream(
            io.BytesIO(b"VZB1" + b"\x00" * 16),
            20,
            is_gzip=False,
            max_compressed=1 << 20,
            max_uncompressed=1 << 20,
            deadline=time.monotonic() - 1,
        )
        with self.assertRaises(UploadTimeoutError):
            stream.read_exact(4)


class TestSchedulerBackoff(unittest.TestCase):
    def test_backoff_doubles_and_caps(self):
        sched = WebSyncScheduler.__new__(WebSyncScheduler)
        sched._lock = threading.Lock()
        sched._hub_failures = {}
        now = 10_000.0
        self.assertFalse(sched._in_backoff("h", now, 21600))
        sched._hub_failures["h"] = (1, now - 600)
        self.assertTrue(sched._in_backoff("h", now, 21600))  # 15 min after 1 failure
        sched._hub_failures["h"] = (1, now - 1000)
        self.assertFalse(sched._in_backoff("h", now, 21600))
        sched._hub_failures["h"] = (20, now - 3600)
        self.assertTrue(sched._in_backoff("h", now, 21600))  # capped at the sync interval
        self.assertFalse(sched._in_backoff("h", now + 21600, 21600))


if __name__ == "__main__":
    unittest.main()
