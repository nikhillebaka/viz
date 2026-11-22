"""
Phase 4 unified cross-hub backend tests:
- Content-aware model-level deduplication across local repo and synced remote hubs
  (equal, stale fork + extra horizon, local ahead, disjoint union `merged:<hub>:<model>`,
  genuinely divergent forecasts kept distinct, `local-output/` untouched)
- Hub-level full & partial subsumption in `GET /api/next/catalog`
- Simultaneous multi-hub `GET /api/next/globe` (US states + EU + MetroCast HSAs)
"""

import http.server
import json
import shutil
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

import polars as pl

import conftest  # noqa: F401
from viz.core.workspace import HubManager
import viz.server as viz_server


def _write_forecast_rows(path: Path, ref_date: str, target: str, loc_vals: list[tuple[str, int, float]], *, parquet: bool = False):
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    for loc, horizon, val in loc_vals:
        rows.append({
            "reference_date": ref_date,
            "target": target,
            "horizon": horizon,
            "target_end_date": ref_date,
            "location": loc,
            "output_type": "quantile",
            "output_type_id": "0.5",
            "value": float(val),
        })
    df = pl.DataFrame(rows)
    if parquet:
        df.write_parquet(path)
    else:
        df.write_csv(path)


def _write_basic_us_hub(root: Path, targets: list[str], rounds: list[str]):
    (root / "hub-config").mkdir(parents=True, exist_ok=True)
    (root / "auxiliary-data").mkdir(parents=True, exist_ok=True)
    (root / "target-data").mkdir(parents=True, exist_ok=True)
    pl.DataFrame({
        "abbreviation": ["US", "MA"],
        "location": ["US", "25"],
        "location_name": ["United States", "Massachusetts"],
        "population": [334_000_000, 7_000_000],
    }).write_csv(root / "auxiliary-data" / "locations.csv")
    (root / "hub-config" / "tasks.json").write_text(json.dumps({
        "rounds": [{
            "model_tasks": [{
                "task_ids": {
                    "reference_date": {"optional": rounds},
                    "target": {"required": targets},
                    "location": {"required": ["US", "25"]},
                    "horizon": {"required": [0, 1]},
                },
                "output_type": {"quantile": {"output_type_id": {"required": ["0.5"]}}},
            }]
        }]
    }), encoding="utf-8")


class TestModelDeduplication(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.data_dir = Path(tempfile.mkdtemp())
        _write_basic_us_hub(self.base, ["wk inc flu hosp"], ["2025-11-15", "2025-11-22", "2025-11-29"])
        (self.base / "model-metadata").mkdir(parents=True, exist_ok=True)

        mgr = HubManager(mode="local", data_dir=self.data_dir, cli_hubs=[self.base], include_enclosing=False)
        self.store = mgr.remote_store
        r_dir = self.store.hub_dir("flusight")
        _write_basic_us_hub(r_dir, ["wk inc flu hosp"], ["2025-11-15", "2025-11-22"])
        (r_dir / "model-metadata").mkdir(parents=True, exist_ok=True)

        manifest_files = {}

        def add_repo(name: str, round_list: list[tuple[str, list[tuple[str, int, float]]]]):
            for d, vals in round_list:
                _write_forecast_rows(self.base / "model-output" / name / f"{d}-{name}.csv", d, "wk inc flu hosp", vals)

        def add_local(name: str, round_list: list[tuple[str, list[tuple[str, int, float]]]]):
            for d, vals in round_list:
                _write_forecast_rows(self.base / "local-output" / name / f"{d}-{name}.csv", d, "wk inc flu hosp", vals)

        def add_remote(name: str, round_list: list[tuple[str, list[tuple[str, int, float]]]]):
            for d, vals in round_list:
                rel = f"model-output/{name}/{d}-{name}.parquet"
                _write_forecast_rows(r_dir / rel, d, "wk inc flu hosp", vals, parquet=True)
                manifest_files[rel] = {
                    "model": name,
                    "reference_date": d,
                    "path": rel,
                    "targets": ["wk inc flu hosp"],
                    "output_types": ["quantile"],
                    "extra_task_ids": [],
                    "last_modified": "2025-11-22T00:00:00Z",
                }

        base_vals = [("US", 0, 100.0), ("US", 1, 120.0), ("25", 0, 10.0), ("25", 1, 12.0)]
        r2_vals = [("US", 0, 200.0), ("US", 1, 220.0), ("25", 0, 20.0), ("25", 1, 22.0)]
        r3_vals = [("US", 0, 300.0), ("US", 1, 330.0), ("25", 0, 30.0), ("25", 1, 33.0)]

        # 1. Identical equal
        add_repo("Same-Model", [("2025-11-15", base_vals)])
        add_remote("Same-Model", [("2025-11-15", base_vals)])

        # 2. Stale fork + remote extra horizon -1 & newer round
        add_repo("Stale-Fork", [("2025-11-15", base_vals)])
        add_remote("Stale-Fork", [
            ("2025-11-15", [("US", -1, 90.0), ("25", -1, 9.0)] + base_vals),
            ("2025-11-22", r2_vals),
        ])

        # 3. Local strictly ahead (new uncommitted round)
        add_repo("Local-Ahead", [("2025-11-15", base_vals), ("2025-11-22", r2_vals)])
        add_remote("Local-Ahead", [("2025-11-15", base_vals)])

        # 4. Disjoint union (local has 11-15 + 11-29; remote has 11-15 + 11-22)
        add_repo("Merged-Union", [("2025-11-15", base_vals), ("2025-11-29", r3_vals)])
        add_remote("Merged-Union", [("2025-11-15", base_vals), ("2025-11-22", r2_vals)])
        (r_dir / "model-metadata" / "Merged-Union.yml").write_text(
            "team_name: Union Team\nmodel_abbr: Union\ndesignated_model: true\n",
            encoding="utf-8",
        )

        # 5. Divergent values on overlapping date (uncommitted local edit) -> kept separate
        add_repo("Fork-Divergent", [("2025-11-15", [("US", 0, 999.0), ("US", 1, 120.0), ("25", 0, 10.0), ("25", 1, 12.0)])])
        add_remote("Fork-Divergent", [("2025-11-15", base_vals)])

        # 6. local-output/ never deduplicated against remote hub
        add_local("Test-Exp", [("2025-11-15", base_vals)])
        add_remote("Test-Exp", [("2025-11-15", base_vals)])

        self.store.save_manifest("flusight", {
            "files": manifest_files,
            "metadata": {"Stale-Fork": {"designated": True}},
            "seasons": ["2025-2026"],
        })
        self.store.set_enabled("flusight", True)
        self.mgr = HubManager(mode="local", data_dir=self.data_dir, cli_hubs=[self.base], include_enclosing=False)

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)
        shutil.rmtree(self.data_dir, ignore_errors=True)

    def test_all_six_dedup_cases_and_fingerprint_invalidation(self):
        ctx = self.mgr.get_context(None)
        loader = ctx.loader
        models = loader.scan_models(force_refresh=True)

        # 1. Identical equal
        self.assertIn("Same-Model", models)
        self.assertNotIn("flusight:Same-Model", models)
        self.assertEqual(models["Same-Model"]["raw_name"], "Same-Model")

        # 2. Stale fork adopts newer remote rounds & extra horizons transparently
        self.assertIn("Stale-Fork", models)
        self.assertNotIn("flusight:Stale-Fork", models)
        self.assertEqual(models["Stale-Fork"]["raw_name"], "flusight:Stale-Fork")
        self.assertEqual(models["Stale-Fork"]["max_date"], "2025-11-22")
        sp_stale = loader.get_spatial_data("wk inc flu hosp", "2025-11-22", ["Stale-Fork"], horizon="all", precise=True)
        self.assertEqual(sp_stale["locations"]["25"]["models"]["Stale-Fork"][0]["median"], 20.0)

        # 3. Local ahead preserved
        self.assertIn("Local-Ahead", models)
        self.assertNotIn("flusight:Local-Ahead", models)
        self.assertEqual(models["Local-Ahead"]["raw_name"], "Local-Ahead")
        self.assertEqual(models["Local-Ahead"]["max_date"], "2025-11-22")

        # 4. Disjoint union merged:<hub>:<model> combines all 3 rounds + metadata
        self.assertIn("Merged-Union", models)
        self.assertNotIn("flusight:Merged-Union", models)
        self.assertEqual(models["Merged-Union"]["raw_name"], "merged:flusight:Merged-Union")
        self.assertEqual(models["Merged-Union"]["dates"], ["2025-11-15", "2025-11-22", "2025-11-29"])
        comb = loader.load_combined_forecasts("Merged-Union")
        self.assertEqual(sorted(comb.get_column("reference_date").unique().to_list()), ["2025-11-15", "2025-11-22", "2025-11-29"])
        meta = loader.get_model_metadata("Merged-Union")
        self.assertEqual(meta.get("team_name"), "Union Team")
        sp_union_22 = loader.get_spatial_data("wk inc flu hosp", "2025-11-22", ["Merged-Union"], horizon="all", precise=True)
        sp_union_29 = loader.get_spatial_data("wk inc flu hosp", "2025-11-29", ["Merged-Union"], horizon="all", precise=True)
        self.assertEqual(sp_union_22["locations"]["25"]["models"]["Merged-Union"][0]["median"], 20.0)
        self.assertEqual(sp_union_29["locations"]["25"]["models"]["Merged-Union"][0]["median"], 30.0)

        # 5. Divergent forecasts kept distinct
        self.assertIn("Fork-Divergent", models)
        self.assertIn("flusight:Fork-Divergent", models)

        # 6. local-output/ never deduplicated
        self.assertIn("Test-Exp", models)
        self.assertIn("flusight:Test-Exp", models)

        # Persisted fingerprint cache exists and invalidates if local CSV changes
        self.assertTrue((loader.cache_mgr.cache_dir / "model_dedup.json").is_file())
        edited_path = self.base / "model-output" / "Same-Model" / "2025-11-15-Same-Model.csv"
        _write_forecast_rows(edited_path, "2025-11-15", "wk inc flu hosp", [("US", 0, 777.0), ("25", 0, 10.0)])
        models_after = loader.scan_models(force_refresh=True)
        self.assertIn("Same-Model", models_after)
        self.assertIn("flusight:Same-Model", models_after)


class TestUnifiedCatalogAndGlobe(unittest.TestCase):
    def setUp(self):
        self.local_flu = Path(tempfile.mkdtemp())
        self.data_dir = Path(tempfile.mkdtemp())
        _write_basic_us_hub(self.local_flu, ["wk inc flu hosp"], ["2025-11-22"])
        _write_forecast_rows(
            self.local_flu / "model-output" / "Flu-ensemble" / "2025-11-22-Flu-ensemble.csv",
            "2025-11-22", "wk inc flu hosp",
            [("US", 0, 3500.0), ("US", 1, 3800.0), ("25", 0, 140.0), ("25", 1, 160.0)],
        )
        pl.DataFrame({
            "target": ["wk inc flu hosp", "wk inc flu hosp"],
            "location": ["US", "25"],
            "target_end_date": ["2025-11-22", "2025-11-22"],
            "oracle_value": [3340.0, 140.0],
        }).write_csv(self.local_flu / "target-data" / "oracle-output.csv")

        boot_mgr = HubManager(mode="local", data_dir=self.data_dir, cli_hubs=[self.local_flu], include_enclosing=False)
        store = boot_mgr.remote_store

        # 1. flusight: identical target + extra categorical target (tests partial subsumption!)
        fs = store.hub_dir("flusight")
        _write_basic_us_hub(fs, ["wk inc flu hosp", "wk flu hosp rate change"], ["2025-11-22"])
        (fs / "pmf-output" / "Flu-ens").mkdir(parents=True, exist_ok=True)
        pl.DataFrame({
            "reference_date": ["2025-11-22", "2025-11-22"],
            "target": ["wk flu hosp rate change", "wk flu hosp rate change"],
            "horizon": [1, 1],
            "target_end_date": ["2025-11-29", "2025-11-29"],
            "location": ["25", "25"],
            "output_type": ["pmf", "pmf"],
            "output_type_id": ["stable", "increase"],
            "value": [0.4, 0.6],
        }).write_parquet(fs / "pmf-output" / "Flu-ens" / "2025-11-22-Flu-ens.parquet")
        store.save_manifest("flusight", {
            "files": {
                "pmf": {
                    "model": "Flu-ens",
                    "reference_date": "2025-11-22",
                    "pmf_path": "pmf-output/Flu-ens/2025-11-22-Flu-ens.parquet",
                    "pmf": True,
                    "targets": ["wk flu hosp rate change"],
                    "output_types": ["pmf"],
                }
            },
            "seasons": ["2025-2026"],
        })

        # 2. covid19: full US COVID hub
        cov = store.hub_dir("covid19")
        _write_basic_us_hub(cov, ["wk inc covid hosp"], ["2025-11-22"])
        (cov / "model-output" / "COVID-ens").mkdir(parents=True, exist_ok=True)
        _write_forecast_rows(
            cov / "model-output" / "COVID-ens" / "2025-11-22-COVID-ens.parquet",
            "2025-11-22", "wk inc covid hosp",
            [("US", 0, 1200.0), ("US", 1, 1300.0), ("25", 0, 60.0), ("25", 1, 70.0)],
            parquet=True,
        )
        pl.DataFrame({
            "target": ["wk inc covid hosp", "wk inc covid hosp"],
            "location": ["US", "25"],
            "target_end_date": ["2025-11-22", "2025-11-22"],
            "oracle_value": [1250.0, 56.0],
        }).write_parquet(cov / "target-data" / "oracle.parquet")
        store.save_manifest("covid19", {
            "files": {
                "q": {
                    "model": "COVID-ens",
                    "reference_date": "2025-11-22",
                    "path": "model-output/COVID-ens/2025-11-22-COVID-ens.parquet",
                    "targets": ["wk inc covid hosp"],
                    "output_types": ["quantile"],
                }
            },
            "seasons": ["2025-2026"],
        })

        # 3. flu_metrocast: MA statewide + boston HSA
        mc = store.hub_dir("flu_metrocast")
        (mc / "hub-config").mkdir(parents=True, exist_ok=True)
        (mc / "auxiliary-data").mkdir(parents=True, exist_ok=True)
        (mc / "target-data").mkdir(parents=True, exist_ok=True)
        (mc / "model-output" / "MC-ens").mkdir(parents=True, exist_ok=True)
        pl.DataFrame({
            "location": ["massachusetts", "boston"],
            "location_name": ["Massachusetts (All)", "Boston, MA"],
            "original_location_code": ["All", "boston"],
            "state": ["Massachusetts", "Massachusetts"],
            "state_abb": ["MA", "MA"],
            "location_type": ["state", "hsa"],
            "population": [7_000_000, 1_900_000],
        }).write_csv(mc / "auxiliary-data" / "locations.csv")
        (mc / "hub-config" / "tasks.json").write_text(json.dumps({
            "rounds": [{
                "model_tasks": [{
                    "task_ids": {
                        "reference_date": {"optional": ["2025-11-22"]},
                        "target": {"required": ["Flu ED visits pct"]},
                        "location": {"required": ["massachusetts", "boston"]},
                        "horizon": {"required": [0, 1]},
                    },
                    "output_type": {"quantile": {"output_type_id": {"required": ["0.5"]}}},
                }]
            }]
        }), encoding="utf-8")
        _write_forecast_rows(
            mc / "model-output" / "MC-ens" / "2025-11-22-MC-ens.parquet",
            "2025-11-22", "Flu ED visits pct",
            [("massachusetts", 1, 2.4), ("boston", 1, 3.1)],
            parquet=True,
        )
        pl.DataFrame({
            "target": ["Flu ED visits pct", "Flu ED visits pct"],
            "location": ["massachusetts", "boston"],
            "target_end_date": ["2025-11-22", "2025-11-22"],
            "oracle_value": [2.1, 2.9],
        }).write_parquet(mc / "target-data" / "oracle.parquet")
        store.save_manifest("flu_metrocast", {
            "files": {
                "q": {
                    "model": "MC-ens",
                    "reference_date": "2025-11-22",
                    "path": "model-output/MC-ens/2025-11-22-MC-ens.parquet",
                    "targets": ["Flu ED visits pct"],
                    "output_types": ["quantile"],
                }
            },
            "seasons": ["2025-2026"],
        })

        # 4. respicast_syndromic: DE, FR, UK -> UK normalized to canonical "GB"
        rc = store.hub_dir("respicast_syndromic")
        (rc / "hub-config").mkdir(parents=True, exist_ok=True)
        (rc / "target-data").mkdir(parents=True, exist_ok=True)
        (rc / "model-output" / "RC-ens").mkdir(parents=True, exist_ok=True)
        (rc / "hub-config" / "tasks.json").write_text(json.dumps({
            "rounds": [{
                "model_tasks": [{
                    "task_ids": {
                        "reference_date": {"optional": ["2025-11-19"]},
                        "target": {"required": ["ILI incidence"]},
                        "location": {"required": ["DE", "FR", "UK"]},
                        "horizon": {"required": [1]},
                    },
                    "output_type": {"quantile": {"output_type_id": {"required": ["0.5"]}}},
                }]
            }]
        }), encoding="utf-8")
        _write_forecast_rows(
            rc / "model-output" / "RC-ens" / "2025-11-19-RC-ens.parquet",
            "2025-11-19", "ILI incidence",
            [("DE", 1, 900.0), ("FR", 1, 500.0), ("UK", 1, 420.0)],
            parquet=True,
        )
        pl.DataFrame({
            "target": ["ILI incidence", "ILI incidence", "ILI incidence"],
            "location": ["DE", "FR", "UK"],
            "target_end_date": ["2025-11-16", "2025-11-16", "2025-11-16"],
            "oracle_value": [850.0, 460.0, 390.0],
        }).write_parquet(rc / "target-data" / "oracle.parquet")
        store.save_manifest("respicast_syndromic", {
            "files": {
                "q": {
                    "model": "RC-ens",
                    "reference_date": "2025-11-19",
                    "path": "model-output/RC-ens/2025-11-19-RC-ens.parquet",
                    "targets": ["ILI incidence"],
                    "output_types": ["quantile"],
                }
            },
            "seasons": ["2025-2026"],
        })

        self.mgr = HubManager(mode="local", data_dir=self.data_dir, cli_hubs=[self.local_flu], include_enclosing=False)

    def tearDown(self):
        shutil.rmtree(self.local_flu, ignore_errors=True)
        shutil.rmtree(self.data_dir, ignore_errors=True)

    def test_catalog_subsumption_and_multi_hub_globe_and_http(self):
        cat = self.mgr.catalog.build_catalog()
        tkeys = {t["key"] for t in cat["targets"]}
        # Partial subsumption: local already has wk inc flu hosp, so remote_flusight only adds its uncovered PMF target
        self.assertIn("remote_flusight::wk flu hosp rate change", tkeys)
        self.assertNotIn("remote_flusight::wk inc flu hosp", tkeys)

        # Canonical Massachusetts ("25") unites local flu + COVID + MetroCast statewide + child boston
        ma = cat["places"]["25"]
        ma_hub_map = {h["hub_id"]: h["location_id"] for h in ma["hubs"]}
        self.assertIn(self.mgr.default_hub_id(), ma_hub_map)
        self.assertEqual(ma_hub_map["remote_covid19"], "25")
        self.assertEqual(ma_hub_map["remote_flu_metrocast"], "massachusetts")
        self.assertEqual(ma["children"], ["boston"])

        # Canonical GB absorbs EU location_id "UK"
        gb = cat["places"]["GB"]
        self.assertEqual(gb["hubs"][0]["location_id"], "UK")

        # Full subsumption: when remote rsv mirrors local rsv targets completely, subsumed_map omits remote_rsv
        rsv_dir = self.mgr.remote_store.hub_dir("rsv")
        _write_basic_us_hub(rsv_dir, ["wk inc flu hosp"], ["2025-11-22"])
        self.mgr.remote_store.save_manifest("rsv", {
            "files": {"a": {"model": "Rsv", "reference_date": "2025-11-22", "path": "x", "targets": ["wk inc flu hosp"], "output_types": ["quantile"]}},
            "seasons": ["2025-2026"],
        })
        (rsv_dir / "model-output" / "Rsv").mkdir(parents=True, exist_ok=True)
        _write_forecast_rows(rsv_dir / "model-output" / "Rsv" / "2025-11-22-Rsv.parquet", "2025-11-22", "wk inc flu hosp", [("US", 0, 10.0)], parquet=True)
        self.mgr.catalog.invalidate()
        cat2 = self.mgr.catalog.build_catalog()
        self.assertEqual(cat2["subsumed_map"].get("remote_rsv"), self.mgr.default_hub_id())
        self.assertNotIn("remote_rsv", {h["id"] for h in cat2["hubs"]})

        # Simultaneous multi-hub Globe
        gl = self.mgr.catalog.build_globe()
        self.assertTrue(gl["coverage"]["has_us_states"])
        self.assertTrue(gl["coverage"]["has_eu"])
        self.assertTrue(gl["coverage"]["has_metrocast"])
        self.assertEqual(gl["coverage"]["metro_ids"], ["boston"])
        self.assertIn("25", gl["regions"])
        self.assertIn("DE", gl["regions"])
        self.assertIn("GB", gl["regions"])
        self.assertGreaterEqual(len(gl["regions"]["25"]["streams"]), 2)
        self.assertIsNotNone(gl["regions"]["DE"]["composite_activity"])

        # Live HTTP server endpoints return 200 without ?workspace=
        old_mgr = viz_server.HUB_MANAGER
        old_cls_mgr = viz_server.SandboxRequestHandler.hub_manager
        viz_server.HUB_MANAGER = self.mgr
        viz_server.SandboxRequestHandler.hub_manager = self.mgr
        try:
            srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), viz_server.SandboxRequestHandler)
            port = srv.server_address[1]
            t = threading.Thread(target=srv.serve_forever, daemon=True)
            t.start()
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/next/catalog", timeout=5) as r1:
                    self.assertEqual(r1.status, 200)
                    cjson = json.loads(r1.read().decode("utf-8"))
                    self.assertIn("places", cjson)
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/next/globe", timeout=5) as r2:
                    self.assertEqual(r2.status, 200)
                    gjson = json.loads(r2.read().decode("utf-8"))
                    self.assertTrue(gjson["coverage"]["has_eu"])
            finally:
                srv.shutdown()
                srv.server_close()
        finally:
            viz_server.HUB_MANAGER = old_mgr
            viz_server.SandboxRequestHandler.hub_manager = old_cls_mgr

    def test_respicast_calendar_and_target_unification(self):
        import struct
        from viz.core.calendar import infer_calendar
        from viz.core.catalog import canonical_target_concept

        # 1. RespiCast 1-indexed origin_date (Wed -> Sun): h=1 is -3d, so h=0 offset is -10d
        rc_tasks = {
            "rounds": [{
                "round_id": "origin_date",
                "model_tasks": [{
                    "task_ids": {
                        "origin_date": {"required": ["2026-11-18"]},
                        "horizon": {"required": [1, 2, 3, 4]},
                    }
                }],
            }]
        }
        cal_rc = infer_calendar(rc_tasks, observed_target_dates=["2026-11-08", "2026-11-15"])
        self.assertEqual(cal_rc.horizon_offset_days, -10)

        # Zero-indexed origin_date stays -3d
        rc_zero = {
            "rounds": [{
                "round_id": "origin_date",
                "model_tasks": [{
                    "task_ids": {
                        "origin_date": {"required": ["2026-11-18"]},
                        "horizon": {"required": [0, 1, 2, 3]},
                    }
                }],
            }]
        }
        cal_zero = infer_calendar(rc_zero, observed_target_dates=["2026-11-08", "2026-11-15"])
        self.assertEqual(cal_zero.horizon_offset_days, -3)

        # VZF2 payload with empirical target_end_date encodes horizon_offset_days == -10 when Wed->Sun @ h=1
        rc2_vzf = Path(tempfile.mkdtemp())
        d_vzf = Path(tempfile.mkdtemp())
        try:
            _write_basic_us_hub(rc2_vzf, ["wk inc flu hosp"], ["2025-11-22"])
            m_vzf = HubManager(mode="local", data_dir=d_vzf, cli_hubs=[rc2_vzf], include_enclosing=False)
            rc_emp = m_vzf.remote_store.hub_dir("respicast_syndromic")
            (rc_emp / "hub-config").mkdir(parents=True, exist_ok=True)
            (rc_emp / "target-data").mkdir(parents=True, exist_ok=True)
            (rc_emp / "model-output" / "RC-emp").mkdir(parents=True, exist_ok=True)
            (rc_emp / "hub-config" / "tasks.json").write_text(json.dumps({
                "rounds": [{
                    "round_id": "origin_date",
                    "model_tasks": [{
                        "task_ids": {
                            "origin_date": {"required": ["2026-11-18"]},
                            "target": {"required": ["ILI incidence"]},
                            "location": {"required": ["FR"]},
                            "horizon": {"required": [1, 2]},
                        },
                        "output_type": {"quantile": {"output_type_id": {"required": ["0.5"]}}},
                    }],
                }]
            }), encoding="utf-8")
            pl.DataFrame({
                "reference_date": ["2026-11-18", "2026-11-18"],
                "target": ["ILI incidence", "ILI incidence"],
                "horizon": [1, 2],
                "target_end_date": ["2026-11-15", "2026-11-22"],
                "location": ["FR", "FR"],
                "output_type": ["quantile", "quantile"],
                "output_type_id": ["0.5", "0.5"],
                "value": [400.0, 410.0],
            }).write_parquet(rc_emp / "model-output" / "RC-emp" / "2026-11-18-RC-emp.parquet")
            pl.DataFrame({
                "location": ["FR"],
                "location_name": ["France"],
                "population": [67000000],
            }).write_csv(rc_emp / "target-data" / "locations.csv")
            pl.DataFrame({
                "target": ["ILI incidence"],
                "location": ["FR"],
                "target_end_date": ["2026-11-08"],
                "oracle_value": [390.0],
            }).write_parquet(rc_emp / "target-data" / "oracle.parquet")
            m_vzf.remote_store.save_manifest("respicast_syndromic", {
                "files": {"q": {"model": "RC-emp", "reference_date": "2026-11-18", "path": "model-output/RC-emp/2026-11-18-RC-emp.parquet", "targets": ["ILI incidence"], "output_types": ["quantile"]}},
                "seasons": ["2026-2027"],
            })
            rc_ctx = m_vzf.get_context("remote_respicast_syndromic")
            buf = rc_ctx.next_data.fan("ILI incidence", "2026-2027", "FR", version=2)
            self.assertIsNotNone(buf)
            hlen = struct.unpack("<I", buf[4:8])[0]
            header = json.loads(buf[8:8 + hlen].decode("utf-8"))
            self.assertEqual(header["horizon_offset_days"], -10)
        finally:
            shutil.rmtree(rc2_vzf, ignore_errors=True)
            shutil.rmtree(d_vzf, ignore_errors=True)

        # 2. Semantic concept unification & oracle-backed per-target default_location
        c_prop, _, a_prop = canonical_target_concept("proportion of ed visits due to flu", {"scale": "proportion"}, "influenza")
        c_pct, _, a_pct = canonical_target_concept("Flu ED visits pct", {"scale": "percentage", "display_name": "Percentage of ED visits due to influenza"}, "influenza")
        self.assertEqual(c_prop, "flu_ed_share")
        self.assertEqual(c_pct, "flu_ed_share")
        self.assertFalse(a_prop)
        self.assertFalse(a_pct)

        # Local fork with renamed Flu ED proportion target + custom ambiguous target
        fork = Path(tempfile.mkdtemp())
        d2 = Path(tempfile.mkdtemp())
        try:
            _write_basic_us_hub(fork, ["proportion of weekly incident ED visits due to flu", "my custom signal"], ["2025-11-22"])
            _write_forecast_rows(
                fork / "model-output" / "Local-Ens" / "2025-11-22-Local-Ens.csv",
                "2025-11-22", "proportion of weekly incident ED visits due to flu",
                [("US", 0, 0.04), ("25", 0, 0.05)],
            )
            _write_forecast_rows(
                fork / "model-output" / "Local-Ens" / "2025-11-22-Local-Ens-2.csv",
                "2025-11-22", "my custom signal",
                [("US", 0, 12.0), ("25", 0, 1.0)],
            )
            pl.DataFrame({
                "target": ["proportion of weekly incident ED visits due to flu", "my custom signal"],
                "location": ["US", "US"],
                "target_end_date": ["2025-11-22", "2025-11-22"],
                "oracle_value": [0.038, 11.0],
            }).write_csv(fork / "target-data" / "oracle-output.csv")

            m2 = HubManager(mode="local", data_dir=d2, cli_hubs=[fork], include_enclosing=False)
            # Remote flusight carrying wk inc flu prop ed visits + Europe RespiCast ILI without DE in oracle
            fs2 = m2.remote_store.hub_dir("flusight")
            _write_basic_us_hub(fs2, ["wk inc flu prop ed visits", "wk flu hosp rate change"], ["2025-11-22"])
            _write_forecast_rows(
                fs2 / "model-output" / "FS-ens" / "2025-11-22-FS-ens.parquet",
                "2025-11-22", "wk inc flu prop ed visits", [("US", 0, 4.1)], parquet=True,
            )
            m2.remote_store.save_manifest("flusight", {
                "files": {"a": {"model": "FS-ens", "reference_date": "2025-11-22", "path": "model-output/FS-ens/2025-11-22-FS-ens.parquet", "targets": ["wk inc flu prop ed visits"], "output_types": ["quantile"]}},
                "seasons": ["2025-2026"],
            })
            rc2 = m2.remote_store.hub_dir("respicast_syndromic")
            (rc2 / "hub-config").mkdir(parents=True, exist_ok=True)
            (rc2 / "target-data").mkdir(parents=True, exist_ok=True)
            pl.DataFrame({
                "location": ["DE", "FR"],
                "location_name": ["Germany", "France"],
                "population": [83000000, 67000000],
            }).write_csv(rc2 / "target-data" / "locations.csv")
            (rc2 / "hub-config" / "tasks.json").write_text(json.dumps({
                "rounds": [{
                    "round_id": "origin_date",
                    "model_tasks": [{
                        "task_ids": {
                            "origin_date": {"required": ["2025-11-19"]},
                            "target": {"required": ["ARI incidence", "ILI incidence"]},
                            "horizon": {"required": [1]},
                        },
                        "output_type": {"quantile": {"output_type_id": {"required": [0.5]}}},
                    }],
                }]
            }))
            (rc2 / "model-output" / "RC-ens").mkdir(parents=True, exist_ok=True)
            _write_forecast_rows(
                rc2 / "model-output" / "RC-ens" / "2025-11-19-RC-ens.parquet",
                "2025-11-19", "ILI incidence", [("FR", 1, 150.0)], parquet=True,
            )
            pl.DataFrame({
                "target": ["ARI incidence", "ILI incidence"],
                "location": ["DE", "FR"],
                "target_end_date": ["2025-11-16", "2025-11-16"],
                "oracle_value": [900.0, 140.0],
            }).write_parquet(rc2 / "target-data" / "oracle.parquet")
            m2.remote_store.save_manifest("respicast_syndromic", {
                "files": {"a": {"model": "RC-ens", "reference_date": "2025-11-19", "path": "model-output/RC-ens/2025-11-19-RC-ens.parquet", "targets": ["ILI incidence"], "output_types": ["quantile"]}},
                "seasons": ["2025-2026"],
            })

            cat = m2.catalog.build_catalog()
            cat_keys = {t["key"] for t in cat["targets"]}
            # Renamed local flu prop target subsumes remote_flusight::wk inc flu prop ed visits cleanly
            self.assertNotIn("remote_flusight::wk inc flu prop ed visits", cat_keys)
            ili_rec = next(t for t in cat["targets"] if t["key"] == "remote_respicast_syndromic::ILI incidence")
            self.assertEqual(ili_rec["default_location"], "FR")

            local_hid = m2.default_hub_id()
            custom_rec = next(t for t in cat["targets"] if t["key"] == f"{local_hid}::my custom signal")
            self.assertTrue(custom_rec["ambiguous"])

            # POST /api/workspace/target-aliases persists override and updates catalog
            old_m = viz_server.HUB_MANAGER
            old_cm = viz_server.SandboxRequestHandler.hub_manager
            viz_server.HUB_MANAGER = m2
            viz_server.SandboxRequestHandler.hub_manager = m2
            try:
                srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), viz_server.SandboxRequestHandler)
                port = srv.server_address[1]
                th = threading.Thread(target=srv.serve_forever, daemon=True)
                th.start()
                try:
                    req = urllib.request.Request(
                        f"http://127.0.0.1:{port}/api/workspace/target-aliases",
                        data=json.dumps({"hub_id": local_hid, "target_id": "my custom signal", "concept_id": "flu_hosp"}).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        self.assertEqual(resp.status, 200)
                        body = json.loads(resp.read().decode("utf-8"))
                        self.assertEqual(body["target_aliases"][local_hid]["my custom signal"], "flu_hosp")
                        updated = next(t for t in body["catalog"]["targets"] if t["key"] == f"{local_hid}::my custom signal")
                        self.assertEqual(updated["concept_id"], "flu_hosp")
                        self.assertFalse(updated["ambiguous"])
                        self.assertTrue(updated["user_aliased"])
                finally:
                    srv.shutdown()
                    srv.server_close()
            finally:
                viz_server.HUB_MANAGER = old_m
                viz_server.SandboxRequestHandler.hub_manager = old_cm

            # Persisted in workspace.json across HubManager reload
            m2_reloaded = HubManager(mode="local", data_dir=d2, cli_hubs=[fork], include_enclosing=False)
            self.assertEqual(m2_reloaded.registry.get_target_aliases()[local_hid]["my custom signal"], "flu_hosp")

            # Places only advertise targets actually present at that location (DE has ARI only, FR has ILI only)
            de_hub = next((h for h in cat["places"]["DE"]["hubs"] if h["hub_id"] == "remote_respicast_syndromic"), None)
            fr_hub = next((h for h in cat["places"]["FR"]["hubs"] if h["hub_id"] == "remote_respicast_syndromic"), None)
            self.assertIsNotNone(de_hub)
            self.assertIsNotNone(fr_hub)
            self.assertEqual([t["target_id"] for t in de_hub["targets"]], ["ARI incidence"])
            self.assertEqual([t["target_id"] for t in fr_hub["targets"]], ["ILI incidence"])
        finally:
            shutil.rmtree(fork, ignore_errors=True)
            shutil.rmtree(d2, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
