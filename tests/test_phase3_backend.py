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


if __name__ == "__main__":
    unittest.main()
