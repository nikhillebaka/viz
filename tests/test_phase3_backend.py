"""
Phase 3 backend unit tests:
- Unopinionated `VizConfig.get_recommended_models` (zero hardcoded team/model bias)
- `NextData.manifest()` `state_fips` enrichment for canonical US/MetroCast IDs
- `SandboxDataLoader.get_spatial_data()` unique `locations` map (no city/abbr collisions),
  `available_horizons`, and `-14d` oracle truth lookback for offset reference dates (e.g. RespiCast)
"""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

import polars as pl

from viz.core.workspace import HubManager


class TestPhase3Backend(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.data_dir = Path(tempfile.mkdtemp())
        (self.base / "hub-config").mkdir()
        (self.base / "auxiliary-data").mkdir()
        (self.base / "target-data").mkdir()

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)
        shutil.rmtree(self.data_dir, ignore_errors=True)

    def test_recommended_models_unopinionated_and_ensemble_only(self):
        pl.DataFrame({
            "abbreviation": ["US"],
            "location": ["US"],
            "location_name": ["United States"],
            "population": [334_000_000],
        }).write_csv(self.base / "auxiliary-data" / "locations.csv")

        (self.base / "hub-config" / "tasks.json").write_text(json.dumps({
            "rounds": [{
                "model_tasks": [{
                    "task_ids": {
                        "reference_date": {"optional": ["2025-11-15"]},
                        "target": {"required": ["wk inc flu hosp"]},
                        "location": {"required": ["US"]},
                        "horizon": {"required": [0, 1]},
                    },
                    "output_type": {"quantile": {}},
                }]
            }]
        }), encoding="utf-8")

        for mid in ("UMass-flusion", "CMU-prod", "Hub-ensemble", "Alt-ensemble", "Third-ensemble", "Hub-baseline"):
            mdir = self.base / "model-output" / mid
            mdir.mkdir(parents=True)
            pl.DataFrame({
                "reference_date": ["2025-11-15", "2025-11-15"],
                "target": ["wk inc flu hosp", "wk inc flu hosp"],
                "horizon": [0, 1],
                "target_end_date": ["2025-11-15", "2025-11-22"],
                "location": ["US", "US"],
                "output_type": ["quantile", "quantile"],
                "output_type_id": ["0.5", "0.5"],
                "value": [100.0, 105.0],
            }).write_csv(mdir / f"2025-11-15-{mid}.csv")

        (self.base / "model-metadata").mkdir()
        (self.base / "model-metadata" / "Hub-baseline.yaml").write_text(
            "team_name: Hub\nmodel_name: baseline\ndesignated_model: true\n",
            encoding="utf-8",
        )

        mgr = HubManager(mode="local", data_dir=self.data_dir, cli_hubs=[self.base])
        ctx = mgr.get_context(None)
        cfg = ctx.config

        # Without explicit config: never suggest 'flusion'/'prod' heuristically; select only ensembles (<=2)
        recs = cfg.get_recommended_models(
            available_models=["UMass-flusion", "CMU-prod", "Hub-ensemble", "Alt-ensemble", "Third-ensemble", "Hub-baseline"],
            model_meta={
                "UMass-flusion": {"ensemble": False, "baseline_model": False},
                "CMU-prod": {"ensemble": False, "baseline_model": False},
                "Hub-ensemble": {"ensemble": True, "baseline_model": False},
                "Alt-ensemble": {"ensemble": True, "baseline_model": False},
                "Third-ensemble": {"ensemble": True, "baseline_model": False},
                "Hub-baseline": {"ensemble": False, "baseline_model": True},
            },
        )
        self.assertEqual(recs, ["Alt-ensemble", "Hub-ensemble"])
        self.assertNotIn("UMass-flusion", recs)
        self.assertNotIn("CMU-prod", recs)
        self.assertNotIn("Hub-baseline", recs)

        # When no ensembles exist at all, return empty list (never inject fake defaults)
        no_ens = cfg.get_recommended_models(
            available_models=["UMass-flusion", "CMU-prod"],
            model_meta={
                "UMass-flusion": {"ensemble": False, "baseline_model": False},
                "CMU-prod": {"ensemble": False, "baseline_model": False},
            },
        )
        self.assertEqual(no_ens, [])

        # When explicit priority_models / recommended_models is configured, honor it
        cfg._user_config["recommended_models"] = ["UMass-flusion"]
        explicit = cfg.get_recommended_models(available_models=["UMass-flusion", "Hub-ensemble"])
        self.assertEqual(explicit, ["UMass-flusion"])

    def test_manifest_state_fips_and_spatial_locations_unique_and_offset_truth(self):
        # Simulate sub-state HSAs with colliding city names ("Portland, ME" vs "Portland, OR")
        # and an offset oracle truth date (-3d relative to reference_date, like RespiCast Wed -> Sun).
        pl.DataFrame({
            "location": ["massachusetts", "portland", "portland-or"],
            "location_name": ["Massachusetts", "Portland", "Portland"],
            "original_location_code": ["All", "55", "112"],
            "state": ["Massachusetts", "Maine", "Oregon"],
            "state_abb": ["MA", "ME", "OR"],
            "location_type": ["state", "hsa_nci_id", "hsa_nci_id"],
            "population": [7_000_000, 300_000, 1_800_000],
        }).write_csv(self.base / "auxiliary-data" / "locations.csv")

        (self.base / "hub-config" / "tasks.json").write_text(json.dumps({
            "rounds": [{
                "model_tasks": [{
                    "task_ids": {
                        "reference_date": {"optional": ["2025-11-19"]},
                        "target": {"required": ["wk inc ari"]},
                        "location": {"required": ["massachusetts", "portland", "portland-or"]},
                        "horizon": {"required": [0, 1]},
                    },
                    "output_type": {"quantile": {}},
                }]
            }]
        }), encoding="utf-8")

        # Oracle dated 2025-11-16 (Sunday, -3 days before Wednesday ref_date 2025-11-19)
        pl.DataFrame([
            {"as_of": "2025-12-01", "target": "wk inc ari", "target_end_date": "2025-11-16", "location": "massachusetts", "oracle_value": 50.0},
            {"as_of": "2025-12-01", "target": "wk inc ari", "target_end_date": "2025-11-16", "location": "portland", "oracle_value": 111.0},
            {"as_of": "2025-12-01", "target": "wk inc ari", "target_end_date": "2025-11-16", "location": "portland-or", "oracle_value": 222.0},
        ]).write_csv(self.base / "target-data" / "oracle-output.csv")

        mdir = self.base / "model-output" / "Test-ensemble"
        mdir.mkdir(parents=True)
        pl.DataFrame([
            {"reference_date": "2025-11-19", "target": "wk inc ari", "horizon": 0, "target_end_date": "2025-11-16", "location": "massachusetts", "output_type": "quantile", "output_type_id": "0.5", "value": 52.0},
            {"reference_date": "2025-11-19", "target": "wk inc ari", "horizon": 1, "target_end_date": "2025-11-23", "location": "massachusetts", "output_type": "quantile", "output_type_id": "0.5", "value": 60.0},
            {"reference_date": "2025-11-19", "target": "wk inc ari", "horizon": 0, "target_end_date": "2025-11-16", "location": "portland", "output_type": "quantile", "output_type_id": "0.5", "value": 115.0},
            {"reference_date": "2025-11-19", "target": "wk inc ari", "horizon": 1, "target_end_date": "2025-11-23", "location": "portland", "output_type": "quantile", "output_type_id": "0.5", "value": 120.0},
            {"reference_date": "2025-11-19", "target": "wk inc ari", "horizon": 0, "target_end_date": "2025-11-16", "location": "portland-or", "output_type": "quantile", "output_type_id": "0.5", "value": 230.0},
            {"reference_date": "2025-11-19", "target": "wk inc ari", "horizon": 1, "target_end_date": "2025-11-23", "location": "portland-or", "output_type": "quantile", "output_type_id": "0.5", "value": 250.0},
        ]).write_csv(mdir / "2025-11-19-Test-ensemble.csv")

        mgr = HubManager(mode="local", data_dir=self.data_dir, cli_hubs=[self.base])
        ctx = mgr.get_context(None)
        man = ctx.next_data.manifest()
        loc_by_id = {l["id"]: l for l in man["locations"]}

        self.assertEqual(loc_by_id["massachusetts"]["state_fips"], "25")
        self.assertEqual(loc_by_id["portland"]["state_fips"], "23")
        self.assertEqual(loc_by_id["portland-or"]["state_fips"], "41")

        sp = ctx.loader.get_spatial_data("wk inc ari", "2025-11-19", ["Test-ensemble"], horizon="all", precise=True)
        self.assertEqual(sp["available_horizons"], [0, 1])
        self.assertIn("locations", sp)
        locs = sp["locations"]
        self.assertIn("portland", locs)
        self.assertIn("portland-or", locs)
        self.assertEqual(locs["portland"]["truth"].get("2025-11-16"), 111.0)
        self.assertEqual(locs["portland-or"]["truth"].get("2025-11-16"), 222.0)
        self.assertAlmostEqual(locs["portland-or"]["models"]["Test-ensemble"][1]["median"], 250.0)

        # Sparse/empty sample slice returns valid empty VZT1 payload instead of failing with None/404
        import struct
        vzt = ctx.next_data.trajectories("wk inc ari", "2025-2026", "portland", "2025-11-19")
        self.assertIsNotNone(vzt)
        self.assertTrue(vzt.startswith(b"VZT1"))
        hlen = struct.unpack("<I", vzt[4:8])[0]
        hdr = json.loads(vzt[8:8 + hlen].decode("utf-8"))
        self.assertEqual(hdr["models"], [])
        self.assertEqual(hdr["horizons"], [])

    def test_builtin_hubs_catalog_and_metrocast_github_transport(self):
        from viz.remote.hubs import BUILTIN_HUBS

        by_id = {h.id: h for h in BUILTIN_HUBS}
        self.assertEqual(
            set(by_id.keys()),
            {"flusight", "flu_metrocast", "covid19", "rsv", "respicast_syndromic", "respicast_covid19"},
        )
        self.assertEqual(by_id["flu_metrocast"].transport, "github")
        self.assertEqual(by_id["flu_metrocast"].github_repo, "reichlab/flu-metrocast")

    def test_standalone_remote_hub_and_hubless_api(self):
        import http.server
        import struct
        import threading
        import urllib.error
        import urllib.request
        from unittest import mock
        from viz.core.workspace import ScopedRemoteManager
        from viz.remote.hubs import HubSpec
        import viz.server as viz_server

        mgr_ws = HubManager(data_dir=self.data_dir, include_enclosing=False)
        # 1. Verify ScopedRemoteManager accepts transport & branch kwargs cleanly
        with mock.patch.object(mgr_ws.shared_remote_mgr, "add_hub", return_value={"ok": True, "hub": {"id": "flusight"}}) as m_add:
            scoped = ScopedRemoteManager(mgr_ws.shared_remote_mgr, is_compatible=lambda _: True)
            out = scoped.add_hub("reichlab/flu-metrocast", "Flu MetroCast", transport="github", branch="main")
            self.assertTrue(out["ok"])
            m_add.assert_called_once_with("reichlab/flu-metrocast", "Flu MetroCast", transport="github", branch="main")

        # 2. Populate a synced standalone remote hub ("rsv") including quantile + sample-only + pmf-only + oracle.parquet
        r_dir = mgr_ws.remote_store.hub_dir("rsv")
        (r_dir / "hub-config").mkdir(parents=True)
        (r_dir / "auxiliary-data").mkdir(parents=True)
        (r_dir / "target-data").mkdir(parents=True)
        (r_dir / "model-output" / "Q-Ens").mkdir(parents=True)
        (r_dir / "sample-output" / "S-Only").mkdir(parents=True)
        (r_dir / "pmf-output" / "P-Only").mkdir(parents=True)

        pl.DataFrame({
            "abbreviation": ["US"],
            "location": ["US"],
            "location_name": ["United States"],
            "population": [334_000_000],
        }).write_csv(r_dir / "auxiliary-data" / "locations.csv")

        (r_dir / "hub-config" / "tasks.json").write_text(json.dumps({
            "rounds": [{
                "model_tasks": [
                    {
                        "task_ids": {
                            "reference_date": {"optional": ["2025-11-22"]},
                            "target": {"required": ["wk inc rsv hosp"]},
                            "location": {"required": ["US"]},
                            "horizon": {"required": [0, 1]},
                        },
                        "output_type": {"quantile": {}, "sample": {}},
                    },
                    {
                        "task_ids": {
                            "reference_date": {"optional": ["2025-11-22"]},
                            "target": {"required": ["wk rsv rate change"]},
                            "location": {"required": ["US"]},
                            "horizon": {"required": [0]},
                        },
                        "output_type": {
                            "pmf": {"output_type_id": {"required": ["decrease", "stable", "increase"]}},
                        },
                    },
                ]
            }]
        }), encoding="utf-8")

        pl.DataFrame([
            {"as_of": "2025-12-01", "target": "wk inc rsv hosp", "target_end_date": "2025-11-22", "location": "US", "output_type": None, "output_type_id": None, "oracle_value": 420.0},
            {"as_of": "2025-12-01", "target": "wk rsv rate change", "target_end_date": "2025-11-22", "location": "US", "output_type": "pmf", "output_type_id": "increase", "oracle_value": 1.0},
        ]).write_parquet(r_dir / "target-data" / "oracle.parquet")

        pl.DataFrame([
            {"reference_date": "2025-11-22", "target": "wk inc rsv hosp", "horizon": 0, "target_end_date": "2025-11-22", "location": "US", "output_type": "quantile", "output_type_id": "0.5", "value": 430.0},
            {"reference_date": "2025-11-22", "target": "wk inc rsv hosp", "horizon": 1, "target_end_date": "2025-11-29", "location": "US", "output_type": "quantile", "output_type_id": "0.5", "value": 460.0},
        ]).write_parquet(r_dir / "model-output" / "Q-Ens" / "2025-11-22-Q-Ens.parquet")

        pl.DataFrame([
            {"reference_date": "2025-11-22", "target": "wk inc rsv hosp", "horizon": 0, "target_end_date": "2025-11-22", "location": "US", "output_type": "sample", "output_type_id": "draw0", "value": 410.0},
            {"reference_date": "2025-11-22", "target": "wk inc rsv hosp", "horizon": 1, "target_end_date": "2025-11-29", "location": "US", "output_type": "sample", "output_type_id": "draw0", "value": 450.0},
        ]).write_parquet(r_dir / "sample-output" / "S-Only" / "2025-11-22-S-Only.parquet")

        pl.DataFrame([
            {"reference_date": "2025-11-22", "target": "wk rsv rate change", "horizon": 0, "target_end_date": "2025-11-22", "location": "US", "output_type": "pmf", "output_type_id": "decrease", "value": 0.1},
            {"reference_date": "2025-11-22", "target": "wk rsv rate change", "horizon": 0, "target_end_date": "2025-11-22", "location": "US", "output_type": "pmf", "output_type_id": "stable", "value": 0.2},
            {"reference_date": "2025-11-22", "target": "wk rsv rate change", "horizon": 0, "target_end_date": "2025-11-22", "location": "US", "output_type": "pmf", "output_type_id": "increase", "value": 0.7},
        ]).write_parquet(r_dir / "pmf-output" / "P-Only" / "2025-11-22-P-Only.parquet")

        mgr_ws.remote_store.save_manifest("rsv", {
            "files": {
                "model-output/Q-Ens/2025-11-22-Q-Ens.csv": {
                    "model": "Q-Ens", "reference_date": "2025-11-22",
                    "path": "model-output/Q-Ens/2025-11-22-Q-Ens.parquet",
                    "targets": ["wk inc rsv hosp"], "output_types": ["quantile"], "extra_task_ids": [],
                },
                "model-output/S-Only/2025-11-22-S-Only.csv": {
                    "model": "S-Only", "reference_date": "2025-11-22",
                    "samples_path": "sample-output/S-Only/2025-11-22-S-Only.parquet",
                    "targets": ["wk inc rsv hosp"], "output_types": ["sample"], "extra_task_ids": [], "samples": True,
                },
                "model-output/P-Only/2025-11-22-P-Only.csv": {
                    "model": "P-Only", "reference_date": "2025-11-22",
                    "pmf_path": "pmf-output/P-Only/2025-11-22-P-Only.parquet",
                    "targets": ["wk rsv rate change"], "output_types": ["pmf"], "extra_task_ids": [], "pmf": True,
                },
            },
            "seasons": ["2025-2026"],
            "metadata": {},
            "truth": {"oracle": {"as_of": "2025-12-01"}},
        })

        # HubManager opens remote_rsv standalone with oracle truth + quantile/sample/pmf models
        self.assertTrue(any(h["id"] == "remote_rsv" for h in mgr_ws.workspace_hubs_brief()))
        r_ctx = mgr_ws.get_context("remote_rsv")
        self.assertIsNotNone(r_ctx)
        man = r_ctx.next_data.manifest()
        m_ids = {m["id"] for m in man["models"]}
        self.assertEqual(m_ids, {"Q-Ens", "S-Only", "P-Only"})

        fan_bytes = r_ctx.next_data.fan("wk inc rsv hosp", "2025-2026", "US")
        self.assertIsNotNone(fan_bytes)
        self.assertTrue(fan_bytes.startswith(b"VZF"))

        vzt = r_ctx.next_data.trajectories("wk inc rsv hosp", "2025-2026", "US", "2025-11-22", models=["S-Only"])
        self.assertTrue(vzt.startswith(b"VZT1"))
        hlen = struct.unpack("<I", vzt[4:8])[0]
        self.assertEqual([m["id"] for m in json.loads(vzt[8:8 + hlen])["models"]], ["S-Only"])

        pmf_data = r_ctx.next_data.pmf("wk rsv rate change", "2025-2026", "US")
        self.assertIn("P-Only", pmf_data["models"])
        self.assertEqual(pmf_data["observed"][0]["category"], "increase")

        # Hubless server mode exposes /api/remote/hubs cleanly with all 6 builtin suggestions
        data_empty = Path(tempfile.mkdtemp())
        try:
            empty_mgr = HubManager(data_dir=data_empty, mode="local", include_enclosing=False)

            class Handler(viz_server.SandboxRequestHandler):
                hub_manager = empty_mgr
                def log_message(self, *args):
                    pass

            srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            port = srv.server_address[1]
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/remote/hubs") as resp:
                    self.assertEqual(resp.status, 200)
                    payload = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(len(payload["hubs"]), 6)
            finally:
                srv.shutdown()
                srv.server_close()
        finally:
            shutil.rmtree(data_empty, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
