"""
Self-contained unit and integration tests for multi-hub workspace management,
standalone execution without enclosing hub data, HTTP workspace/multi-hub routing,
web mode isolation, and CLI `--hub` support.
"""

import http.client
import json
import os
from pathlib import Path
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse

import polars as pl

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from conftest import APP_DIR  # noqa: E402
from viz.core.data_loader import _is_flu_hosp_target  # noqa: E402
from viz.core.paths import (  # noqa: E402
    RESERVED_HUB_IDS,
    inspect_local_hub,
    is_hub_dir,
    slug_for_hub,
)
from viz.core.workspace import HubManager, WorkspaceRegistry  # noqa: E402
from viz.server import SandboxRequestHandler  # noqa: E402

QUANTILES = [0.025, 0.25, 0.5, 0.75, 0.975]
REF_DATE = "2024-01-13"
TARGET_END_DATES = [(0, "2024-01-13"), (1, "2024-01-20")]


def _snapshot_tree(root: Path) -> set[str]:
    """Return sorted relative POSIX paths for every directory and file under `root`."""
    entries = set()
    for p in root.rglob("*"):
        entries.add(p.relative_to(root).as_posix())
    return entries


def _build_synthetic_hub(
    hub_dir: Path,
    *,
    name: str,
    target: str,
    model_names: tuple[str, ...],
    owner: str = "org",
    truth_val: float = 1200.0,
) -> Path:
    """Create a minimal valid Hubverse repository folder (completely self-contained)."""
    (hub_dir / "hub-config").mkdir(parents=True, exist_ok=True)
    (hub_dir / "auxiliary-data").mkdir(parents=True, exist_ok=True)
    (hub_dir / "target-data").mkdir(parents=True, exist_ok=True)
    (hub_dir / "model-output").mkdir(parents=True, exist_ok=True)

    (hub_dir / "hub-config" / "admin.json").write_text(
        json.dumps(
            {
                "name": name,
                "maintainer": "Test Maintainer",
                "repository": {"host": "github", "owner": owner, "name": hub_dir.name},
            }
        ),
        encoding="utf-8",
    )
    (hub_dir / "hub-config" / "tasks.json").write_text(
        json.dumps(
            {
                "schema_version": "https://raw.githubusercontent.com/hubverse-org/schemas/main/v3.0.0/tasks-schema.json",
                "rounds": [
                    {
                        "round_id_from_variable": True,
                        "round_id": "reference_date",
                        "model_tasks": [
                            {
                                "task_ids": {
                                    "reference_date": {"required": None, "optional": [REF_DATE]},
                                    "location": {"required": None, "optional": ["US", "25"]},
                                    "horizon": {"required": None, "optional": [0, 1]},
                                    "target": {"required": [target], "optional": None},
                                },
                                "output_type": {
                                    "quantile": {"output_type_id": {"required": QUANTILES}}
                                },
                            }
                        ],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    pl.DataFrame(
        {
            "abbreviation": ["US", "MA"],
            "location": ["US", "25"],
            "location_name": ["United States", "Massachusetts"],
            "population": [330_000_000, 7_000_000],
        }
    ).write_csv(hub_dir / "auxiliary-data" / "locations.csv")

    oracle_rows = []
    for loc, mult in (("US", 1.0), ("25", 0.05)):
        for _, ted in TARGET_END_DATES:
            oracle_rows.append(
                {
                    "as_of": "2024-06-01",
                    "target": target,
                    "target_end_date": ted,
                    "location": loc,
                    "output_type": "quantile",
                    "oracle_value": truth_val * mult,
                }
            )
    pl.DataFrame(oracle_rows).write_csv(hub_dir / "target-data" / "oracle-output.csv")

    for idx, model_id in enumerate(model_names):
        mdir = hub_dir / "model-output" / model_id
        mdir.mkdir(parents=True, exist_ok=True)
        rows = []
        scale = 1.05 + idx * 0.2
        for loc, mult in (("US", 1.0), ("25", 0.05)):
            for h, ted in TARGET_END_DATES:
                center = truth_val * mult * scale
                for q in QUANTILES:
                    rows.append(
                        {
                            "reference_date": REF_DATE,
                            "target": target,
                            "horizon": h,
                            "target_end_date": ted,
                            "location": loc,
                            "output_type": "quantile",
                            "output_type_id": q,
                            "value": center * (0.7 + 0.6 * q),
                        }
                    )
        pl.DataFrame(rows).write_csv(mdir / f"{REF_DATE}-{model_id}.csv")

    return hub_dir


class TestPathsAndRegistry(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="viz-ws-unit-")).resolve()
        self.data_dir = self.tmp / "data"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_bootstrap_and_flu_target_guard(self):
        from core._bootstrap import ensure_viz_package
        self.assertEqual(ensure_viz_package(), APP_DIR)
        self.assertTrue(_is_flu_hosp_target("wk inc flu hosp"))
        self.assertFalse(_is_flu_hosp_target("wk inc covid hosp"))
        self.assertFalse(_is_flu_hosp_target("wk inc rsv hosp"))
        self.assertFalse(_is_flu_hosp_target("wk inc flu prop ed visits"))

    def test_inspect_and_slug_generation(self):
        plain = self.tmp / "plain-dir"
        plain.mkdir()
        self.assertFalse(is_hub_dir(plain))

        hub = _build_synthetic_hub(
            self.tmp / "covid-hub",
            name="US COVID-19 Forecast Hub",
            target="wk inc covid hosp",
            model_names=("COVID-baseline", "COVID-ensemble"),
            owner="CDCgov",
        )
        self.assertTrue(is_hub_dir(hub))
        info = inspect_local_hub(hub)
        self.assertTrue(info["valid"])
        self.assertEqual(info["name"], "US COVID-19 Forecast Hub")
        self.assertEqual(info["repo_url"], "https://github.com/CDCgov/covid-hub")
        self.assertEqual(info["targets"], ["wk inc covid hosp"])
        self.assertEqual(info["model_count"], 2)

        # Reserved word & duplicate collision handling
        s_reserved = slug_for_hub("remote", hub, ())
        self.assertNotIn(s_reserved, RESERVED_HUB_IDS)
        s1 = slug_for_hub("My Hub", hub, ())
        s2 = slug_for_hub("My Hub", hub, [s1])
        self.assertNotEqual(s1, s2)
        self.assertTrue(s1.startswith("my_hub"))
        self.assertTrue(s2.startswith("my_hub_2"))

    def test_registry_crud_never_deletes_hub_files(self):
        hub_a = _build_synthetic_hub(
            self.tmp / "hub-a",
            name="Flu Hub",
            target="wk inc flu hosp",
            model_names=("FluSight-baseline", "Flu-ModA"),
        )
        hub_b = _build_synthetic_hub(
            self.tmp / "hub-b",
            name="COVID Hub",
            target="wk inc covid hosp",
            model_names=("Covid-ModA",),
        )
        reg = WorkspaceRegistry(self.data_dir)
        rec_a = reg.add_hub(hub_a, activate=True)
        # Adding again with a symlink/non-canonical or duplicate path deduplicates cleanly
        rec_a_dup = reg.add_hub(hub_a, activate=False)
        self.assertEqual(rec_a.id, rec_a_dup.id)
        rec_b = reg.add_hub(hub_b, activate=False)

        # Persistence check with a fresh WorkspaceRegistry instance
        reg2 = WorkspaceRegistry(self.data_dir)
        self.assertEqual(reg2.get_active_id(), rec_a.id)
        self.assertEqual([h.id for h in reg2.list_hubs()], [rec_a.id, rec_b.id])
        self.assertTrue(reg2.set_active(rec_b.id))
        self.assertEqual(WorkspaceRegistry(self.data_dir).get_active_id(), rec_b.id)

        snap_before = _snapshot_tree(hub_a)
        self.assertTrue(reg2.remove_hub(rec_a.id))
        self.assertEqual(_snapshot_tree(hub_a), snap_before)
        self.assertTrue((hub_a / "model-output" / "FluSight-baseline").is_dir())


class TestHubManagerAndHttpIsolation(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="viz-ws-http-")).resolve()
        self.data_dir = self.tmp / "viz_data"
        self.hubs_root = self.tmp / "repos"
        self.hubs_root.mkdir()
        (self.hubs_root / "notes").mkdir()

        self.flu_hub = _build_synthetic_hub(
            self.hubs_root / "FluSight-forecast-hub",
            name="FluSight Hub",
            target="wk inc flu hosp",
            model_names=("FluSight-baseline", "FluTeam-Alpha"),
            owner="cdcepi",
        )
        self.covid_hub = _build_synthetic_hub(
            self.hubs_root / "covid19-forecast-hub",
            name="COVID-19 Hub",
            target="wk inc covid hosp",
            model_names=("CovidTeam-Beta",),
            owner="CDCgov",
        )

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _start_server(self, mgr: HubManager):
        class IsolatedHandler(SandboxRequestHandler):
            hub_manager = mgr

        socketserver.ThreadingTCPServer.allow_reuse_address = True
        httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), IsolatedHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        time.sleep(0.05)
        return httpd, httpd.server_address[1]

    @staticmethod
    def _req(method: str, port: int, path: str, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        hdrs = dict(headers or {})
        payload = None
        if isinstance(body, (bytes, bytearray)):
            payload = bytes(body)
        elif body is not None:
            hdrs.setdefault("Content-Type", "application/json")
            payload = json.dumps(body).encode("utf-8")
        conn.request(method, path, body=payload, headers=hdrs)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        return resp.status, raw

    def test_hub_manager_isolation_and_surveillance_quarantine(self):
        flu_before = _snapshot_tree(self.flu_hub)
        covid_before = _snapshot_tree(self.covid_hub)

        mgr = HubManager(data_dir=self.data_dir, mode="local", include_enclosing=False)
        flu_res = mgr.add_local_hub(self.flu_hub, activate=True)
        covid_res = mgr.add_local_hub(self.covid_hub, activate=False)
        flu_id = flu_res["hub"]["id"]
        covid_id = covid_res["hub"]["id"]
        self.assertNotEqual(flu_id, covid_id)

        flu_ctx = mgr.get_context(flu_id)
        covid_ctx = mgr.get_context(covid_id)
        self.assertIsNotNone(flu_ctx)
        self.assertIsNotNone(covid_ctx)

        # Caches live outside both external hub directories and are separate per hub id
        self.assertNotEqual(flu_ctx.cache_dir, covid_ctx.cache_dir)
        self.assertTrue(str(flu_ctx.cache_dir).startswith(str(self.data_dir)))
        self.assertTrue(str(covid_ctx.cache_dir).startswith(str(self.data_dir)))

        # COVID hub must not point surveillance_dir at bundled CDC FluSight NHSN/ILINet assets
        self.assertEqual(covid_ctx.surveillance_dir, covid_ctx.cache_dir / "surveillance")
        covid_manifest = covid_ctx.next_data.manifest()
        flu_manifest = flu_ctx.next_data.manifest()
        self.assertEqual([t["id"] for t in covid_manifest["targets"]], ["wk inc covid hosp"])
        self.assertEqual([t["id"] for t in flu_manifest["targets"]], ["wk inc flu hosp"])
        self.assertEqual({m["id"] for m in covid_manifest["models"]}, {"CovidTeam-Beta"})
        self.assertEqual({m["id"] for m in flu_manifest["models"]}, {"FluSight-baseline", "FluTeam-Alpha"})

        # External hub repositories were never written to
        self.assertEqual(_snapshot_tree(self.flu_hub), flu_before)
        self.assertEqual(_snapshot_tree(self.covid_hub), covid_before)

    def test_http_zero_hub_multi_hub_and_browse(self):
        mgr = HubManager(data_dir=self.data_dir, mode="local", include_enclosing=False)
        httpd, port = self._start_server(mgr)
        try:
            # 1. Zero-hub startup state
            st, raw = self._req("GET", port, "/api/next/manifest")
            self.assertEqual(st, 200)
            man0 = json.loads(raw)
            self.assertTrue(man0["empty"])
            self.assertEqual(man0["mode"], "local")
            self.assertEqual(man0["workspace_hubs"], [])

            st, raw = self._req("GET", port, "/api/workspace")
            self.assertEqual(st, 200)
            ws0 = json.loads(raw)
            self.assertEqual(ws0["hubs"], [])

            st, _ = self._req("GET", port, "/api/next/fan?target=wk+inc+flu+hosp&season=2023-2024&location=US")
            self.assertEqual(st, 404)

            st, _ = self._req("GET", port, "/next/")
            self.assertEqual(st, 200)

            # 2. Browse + inspect + add both hubs
            st, raw = self._req(
                "GET", port, f"/api/workspace/browse?{urllib.parse.urlencode({'path': str(self.hubs_root)})}"
            )
            self.assertEqual(st, 200)
            b = json.loads(raw)
            by_name = {e["name"]: e for e in b["entries"]}
            self.assertTrue(by_name["FluSight-forecast-hub"]["is_hub"])
            self.assertTrue(by_name["covid19-forecast-hub"]["is_hub"])
            self.assertFalse(by_name["notes"]["is_hub"])

            st, raw = self._req("POST", port, "/api/workspace/inspect", {"path": str(self.covid_hub)})
            self.assertEqual(st, 200)
            self.assertTrue(json.loads(raw)["valid"])

            st, raw = self._req("POST", port, "/api/workspace/add", {"path": str(self.flu_hub), "activate": True})
            self.assertEqual(st, 200)
            flu_id = json.loads(raw)["hub"]["id"]

            st, raw = self._req("POST", port, "/api/workspace/add", {"path": str(self.covid_hub), "activate": False})
            self.assertEqual(st, 200)
            covid_id = json.loads(raw)["hub"]["id"]

            # 3. Same-server multi-hub concurrency via ?workspace=<id> without changing active hub
            st_f, raw_f = self._req("GET", port, f"/api/next/manifest?workspace={urllib.parse.quote(flu_id)}")
            st_c, raw_c = self._req("GET", port, f"/api/next/manifest?workspace={urllib.parse.quote(covid_id)}")
            self.assertEqual(st_f, 200)
            self.assertEqual(st_c, 200)
            mf, mc = json.loads(raw_f), json.loads(raw_c)
            self.assertFalse(mf["empty"])
            self.assertEqual(mf["hub_id"], flu_id)
            self.assertEqual([t["id"] for t in mf["targets"]], ["wk inc flu hosp"])
            self.assertEqual(mc["hub_id"], covid_id)
            self.assertEqual([t["id"] for t in mc["targets"]], ["wk inc covid hosp"])
            self.assertEqual(mgr.default_hub_id(), flu_id)

            # 4. /api/remote/* must NOT treat ?hub=<remote_hub_id> as the workspace id
            st_r, raw_r = self._req(
                "GET", port, f"/api/remote/hubs?workspace={urllib.parse.quote(covid_id)}&hub=flusight"
            )
            self.assertEqual(st_r, 200)
            self.assertIn("hubs", json.loads(raw_r))

            # Unknown workspace returns 404
            st_u, _ = self._req("GET", port, "/api/next/manifest?workspace=nonexistent_id")
            self.assertEqual(st_u, 404)

            # 5. Remove hub leaves directory on disk intact
            covid_snap = _snapshot_tree(self.covid_hub)
            st_del, _ = self._req("POST", port, "/api/workspace/remove", {"id": covid_id})
            self.assertEqual(st_del, 200)
            self.assertEqual(_snapshot_tree(self.covid_hub), covid_snap)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_web_mode_disables_filesystem_routes_and_redacts_paths(self):
        mgr = HubManager(data_dir=self.data_dir, mode="web", cli_hubs=[self.covid_hub], include_enclosing=False)
        httpd, port = self._start_server(mgr)
        try:
            st, raw = self._req("GET", port, "/api/workspace")
            self.assertEqual(st, 200)
            ws = json.loads(raw)
            self.assertEqual(ws["mode"], "web")
            self.assertEqual(len(ws["hubs"]), 1)
            self.assertNotIn("path", ws["hubs"][0])
            self.assertFalse(ws["native_picker_available"])
            self.assertIsNone(ws["home_dir"])

            st, raw = self._req("GET", port, "/api/next/manifest")
            self.assertEqual(st, 200)
            man = json.loads(raw)
            self.assertNotIn("hub_path", man)

            st_b, _ = self._req("GET", port, "/api/workspace/browse")
            self.assertEqual(st_b, 403)
            st_i, _ = self._req("POST", port, "/api/workspace/inspect", {"path": str(self.flu_hub)})
            self.assertEqual(st_i, 403)
            st_a, _ = self._req("POST", port, "/api/workspace/add", {"path": str(self.flu_hub)})
            self.assertEqual(st_a, 403)

            # Mutating remote/cache/ensemble POST routes are blocked in web mode
            for p, payload in (
                ("/api/remote/add", {"bucket": "cdcepi-flusight-forecast-hub"}),
                ("/api/remote/sync", {"hub": "flusight"}),
                ("/api/cache/refresh", {}),
                ("/api/cache/clear", {}),
                ("/api/ensemble/create", {"name": "x", "models": ["CovidTeam-Beta", "other"]}),
                ("/api/ensemble/save", {"ensemble_id": "synth_x"}),
                ("/api/ensemble/delete", {"ensemble_id": "synth_x"}),
            ):
                st_m, _ = self._req("POST", port, p, payload)
                self.assertEqual(st_m, 403, f"expected 403 for {p} in web mode")

            # Read-only ensemble preview remains permitted
            st_prev, _ = self._req("POST", port, "/api/ensemble/preview", {"models": ["CovidTeam-Beta"], "method": "median"})
            self.assertEqual(st_prev, 200)

            # /api/metadata redacts local filesystem model paths in web mode
            st_meta, raw_meta = self._req("GET", port, "/api/metadata")
            self.assertEqual(st_meta, 200)
            meta = json.loads(raw_meta)
            self.assertTrue(meta["models"])
            for m_info in meta["models"].values():
                self.assertNotIn("path", m_info)

            # Oversized JSON bodies are rejected with 413
            big_payload = b'{"x":"' + (b"a" * (1024 * 1024 + 64)) + b'"}'
            st_big, _ = self._req("POST", port, "/api/ensemble/preview", big_payload, headers={"Content-Type": "application/json"})
            self.assertEqual(st_big, 413)

            # Missing JSON Content-Type is rejected with 415 even on /api/cache/refresh
            st_ct, _ = self._req("POST", port, "/api/cache/refresh", b"{}", headers={"Content-Type": "text/plain"})
            self.assertEqual(st_ct, 415)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_remote_default_hub_persists_across_restarts(self):
        mgr = HubManager(data_dir=self.data_dir, mode="local", include_enclosing=False)
        self.assertIsNone(mgr.default_hub_id())
        for rid in ("flusight", "flu_metrocast"):
            mgr.remote_store.hub_dir(rid).mkdir(parents=True, exist_ok=True)
            mgr.remote_store.save_manifest(rid, {"files": {}, "seasons": ["2025-2026"]})

        # the first hub synced with nothing open becomes the startup hub
        mgr._on_remote_inventory_change("flusight", [])
        self.assertEqual(mgr.default_hub_id(), "remote_flusight")

        # opening another remote hub makes it the default, and a fresh server keeps it
        mgr.activate_hub("remote_flu_metrocast")
        restarted = HubManager(data_dir=self.data_dir, mode="local", include_enclosing=False)
        self.assertEqual(restarted.default_hub_id(), "remote_flu_metrocast")
        self.assertEqual(restarted.workspace_summary()["default_hub"], "remote_flu_metrocast")

        # removing the default's data falls back to the other synced hub
        shutil.rmtree(restarted.remote_store.hub_dir("flu_metrocast"))
        restarted._on_remote_inventory_change("flu_metrocast", [])
        self.assertEqual(restarted.default_hub_id(), "remote_flusight")
        with self.assertRaises(KeyError):
            restarted.activate_hub("remote_unknown")

    def test_score_cli_external_hub_without_writing_into_hub(self):
        before = _snapshot_tree(self.covid_hub)
        cmd = [
            sys.executable,
            str(APP_DIR / "score_cli.py"),
            "--hub",
            str(self.covid_hub),
            "--data-dir",
            str(self.data_dir),
            "--models",
            "all",
            "--format",
            "json",
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(res.stdout)
        self.assertEqual(data["target"], "wk inc covid hosp")
        self.assertEqual([r["model_id"] for r in data["rankings"]], ["CovidTeam-Beta"])
        self.assertTrue(data["rankings"][0]["has_data_in_scope"])
        self.assertEqual(_snapshot_tree(self.covid_hub), before)


if __name__ == "__main__":
    unittest.main()
