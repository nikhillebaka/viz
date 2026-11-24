"""
Comprehensive unit tests for the 4 international short-term Hubverse hubs
(`china_id`, `canada_rvdss`, `ontario_hosp`, `bdbv_drc`) covering:
- wide multi-target truth unpivoting & nested `season_*`/`concatenated_*` discovery
- international GeoGraph parsing (`geo_abbr`/`geo_name`/`geo_type`, parent-by-name 3-level DRC)
- target semantics (`is_step_ahead=False` exclusion, `wk R_t` scale, monthly `time_unit`)
- API `manifest`/`fan` proportion->percentage auto-promotion & `time_unit` emission
- cross-hub catalog unification (`CA-ON`) and unified Globe aggregation (`build_globe`)
"""

import json
from pathlib import Path
import shutil
import struct
import tempfile
import unittest

import polars as pl

import conftest  # noqa: F401
from viz.core.catalog import (
    WorkspaceCatalog,
    canonical_place_key,
    canonical_target_concept,
    classify_geo_kind,
    infer_pathogen,
)
from viz.core.config import VizConfig
from viz.core.geo import build_geo_graph
from viz.core.ingest import normalize_forecast_frame
from viz.core.truth import TruthSource, reconcile_truth_sources, unpivot_wide_truth
from viz.core.workspace import HubManager
from viz.remote.hubs import BUILTIN_HUBS
from viz.remote.sync import RemoteObject, _resolve_truth_plan


class TestInternationalTruthAndIngest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_wide_truth_unpivoting_for_rvdss_and_ontario(self):
        rvdss_wide = pl.DataFrame({
            "time_value": ["2025-11-15", "2025-11-22"],
            "geo_value": ["on", "ca"],
            "flu_pct_positive": [12.4, 9.8],
            "sarscov2_pct_positive": [18.1, 16.5],
            "rsv_pct_positive": [4.2, 3.9],
        })
        long_rvdss = unpivot_wide_truth(
            rvdss_wide,
            target_ids=["pct wk flu lab det", "pct wk covid lab det", "pct wk rsv lab det"],
        )
        self.assertIsNotNone(long_rvdss)
        self.assertEqual(long_rvdss.height, 6)
        self.assertEqual(
            set(long_rvdss["target"].to_list()),
            {"pct wk flu lab det", "pct wk covid lab det", "pct wk rsv lab det"},
        )
        self.assertEqual(set(long_rvdss["location"].to_list()), {"on", "ca"})

        ont_wide = pl.DataFrame({
            "time": ["2025-11-15"],
            "geo_value": ["Toronto"],
            "flu": [110.0],
            "covid": [240.0],
            "rsv": [45.0],
        })
        long_ont = unpivot_wide_truth(
            ont_wide,
            target_ids=["wk inc flu hosp", "wk inc covid hosp", "wk inc rsv hosp", "peak inc flu hosp"],
        )
        self.assertIsNotNone(long_ont)
        self.assertEqual(
            set(long_ont["target"].to_list()),
            {"wk inc flu hosp", "wk inc covid hosp", "wk inc rsv hosp"},
        )
        self.assertEqual(long_ont["location"].unique().to_list(), ["Toronto"])

    def test_reconcile_nested_and_concatenated_truth_sources(self):
        aux_csv = self.tmp / "concatenated_rvdss_data.csv"
        pl.DataFrame({
            "time_value": ["2024-11-16", "2025-11-15"],
            "geo_value": ["ca", "ca"],
            "flu_pct_positive": [5.0, 10.0],
        }).write_csv(aux_csv)

        season_csv = self.tmp / "target_rvdss_data.csv"
        pl.DataFrame({
            "time_value": ["2025-11-15", "2025-11-22"],
            "geo_value": ["ca", "ca"],
            "flu_pct_positive": [11.2, 14.6],
        }).write_csv(season_csv)

        df = reconcile_truth_sources(
            [
                (TruthSource("aux_concat", "concat", "latest", 2, aux_csv), pl.read_csv(aux_csv)),
                (TruthSource("season_25", "season", "latest", 1, season_csv), pl.read_csv(season_csv)),
            ],
            keys=["location", "target_end_date"],
            allowed_targets={"pct wk flu lab det"},
            target_ids=["pct wk flu lab det"],
        )
        self.assertEqual(df.height, 3)
        by_date = dict(zip(df["target_end_date"].to_list(), df["oracle_value"].to_list()))
        self.assertAlmostEqual(by_date["2024-11-16"], 5.0)
        # Newer season snapshot (priority 1) overrides historical concatenation (priority 2)
        self.assertAlmostEqual(by_date["2025-11-15"], 11.2)
        self.assertAlmostEqual(by_date["2025-11-22"], 14.6)

    def test_resolve_truth_plan_skips_status_and_admissions_files(self):
        t_objs = {
            "target-data/season_2024_2025/hospitalization-data.csv": RemoteObject("target-data/season_2024_2025/hospitalization-data.csv", "s1", 10, "e1"),
            "target-data/season_2025_2026/hospitalization-data.csv": RemoteObject("target-data/season_2025_2026/hospitalization-data.csv", "s2", 10, "e2"),
            "target-data/season_2025_2026/hospitalization-status.csv": RemoteObject("target-data/season_2025_2026/hospitalization-status.csv", "st", 10, "e3"),
            "target-data/season_2025_2026/influenza-admissions.csv": RemoteObject("target-data/season_2025_2026/influenza-admissions.csv", "adm", 10, "e4"),
        }
        aux_objs = {
            "auxiliary-data/concatenated_hospitalization_data.csv": RemoteObject("auxiliary-data/concatenated_hospitalization_data.csv", "c1", 10, "e5"),
            "auxiliary-data/phu_region_mapping.csv": RemoteObject("auxiliary-data/phu_region_mapping.csv", "p1", 10, "e6"),
        }
        plan = _resolve_truth_plan(t_objs, aux_objs)
        self.assertIn("latest", plan)
        self.assertTrue(plan["latest"]["multi"])
        multi_paths = [o.key for o in plan["latest"]["objs"]]
        self.assertIn("auxiliary-data/concatenated_hospitalization_data.csv", multi_paths)
        self.assertIn("target-data/season_2024_2025/hospitalization-data.csv", multi_paths)
        self.assertIn("target-data/season_2025_2026/hospitalization-data.csv", multi_paths)
        self.assertFalse(any("status" in p or "admissions" in p for p in multi_paths))

    def test_ingest_forecast_date_alias_and_drops_non_step_ahead_null_horizons(self):
        geo = build_geo_graph(None, observed_locations=["CD", "CD-BU"], fallback_us=False)
        raw = pl.DataFrame({
            "reference_date": ["2025-10-12", "2025-10-12", "2025-10-12"],
            "forecast_date": ["2025-10-12", "2025-10-12", "2025-10-12"],
            "location": ["CD", "CD-BU", "CD"],
            "target": ["wk inc confirmed cases", "wk R_t", "cumulative cases"],
            "target_end_date": ["2025-10-19", "2025-10-05", None],
            "horizon": [None, None, None],
            "output_type": ["quantile", "quantile", "quantile"],
            "output_type_id": ["0.5", "0.5", "0.5"],
            "value": [12.0, 1.08, 420.0],
        })
        res = normalize_forecast_frame(
            raw,
            model="DRC-model",
            reference_date="2025-10-12",
            geo=geo,
            is_non_negative=lambda t: True,
        )
        # cumulative cases (both horizon and target_end_date null) dropped safely
        self.assertEqual(res.quantiles.height, 2)
        rt_row = res.quantiles.filter(pl.col("target") == "wk R_t")
        self.assertEqual(rt_row["horizon"].to_list(), [-1])


class TestInternationalGeoAndConfig(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_rvdss_geo_abbr_hierarchy_and_resolve_pool(self):
        loc_csv = self.tmp / "locations.csv"
        pl.DataFrame({
            "geo_type": ["nation", "region", "region", "province", "province", "province", "territory"],
            "geo_abbr": ["ca", "atlantic", "prairies", "on", "ab", "nb", "yt"],
            "geo_name": ["Canada", "Atlantic", "Prairies", "Ontario", "Alberta", "New Brunswick", "Yukon"],
        }).write_csv(loc_csv)
        geo = build_geo_graph(loc_csv)
        self.assertFalse(geo.uses_us_fips)
        self.assertEqual(geo.default_location(), "ca")
        self.assertEqual(geo.nodes["ca"].abbr, "CA")
        self.assertEqual(geo.nodes["on"].canonical_id, "CA:ON")
        self.assertEqual(geo.nodes["ab"].parent_id, "prairies")
        self.assertEqual(geo.nodes["nb"].parent_id, "atlantic")
        self.assertEqual(set(geo.aggregate_locations_in_scope()), {"ca", "atlantic", "prairies"})
        self.assertEqual(set(geo.resolve_pool("all")), {"on", "ab", "nb", "yt"})
        self.assertEqual(set(geo.resolve_pool("states")), {"on", "ab", "nb", "yt"})

    def test_bdbv_three_level_hierarchy_via_parent_names(self):
        loc_csv = self.tmp / "locations.csv"
        pl.DataFrame({
            "location": ["CD", "CD-BU", "CD-KN", "CD-BU-01", "CD-BU-02", "CD-KN-01"],
            "location_name": ["DRC", "Bas Uele", "Kinshasa", "Aketi", "Ango", "Bandalungwa"],
            "location_type": ["country", "province", "province", "health zone", "health zone", "health zone"],
            "parent": ["", "DRC", "DRC", "Bas Uele", "Bas Uele", "Kinshasa"],
        }).write_csv(loc_csv)
        geo = build_geo_graph(loc_csv)
        self.assertEqual(geo.default_location(), "CD")
        self.assertEqual(geo.nodes["CD-BU"].parent_id, "CD")
        self.assertEqual(geo.nodes["CD-BU-01"].parent_id, "CD-BU")
        self.assertEqual(geo.nodes["CD-BU-01"].level, "health_zone")
        self.assertEqual(geo.nodes["CD-KN-01"].region, "Kinshasa")
        self.assertEqual(set(geo.resolve_pool("all")), {"CD-BU-01", "CD-BU-02", "CD-KN-01"})
        self.assertEqual(set(geo.resolve_pool("states")), {"CD-BU", "CD-KN"})
        self.assertEqual(set(geo.resolve_pool("aggregates")), {"CD", "CD-BU", "CD-KN"})

    def test_config_r_t_scale_monthly_time_unit_and_non_step_ahead_exclusion(self):
        (self.tmp / "hub-config").mkdir()
        (self.tmp / "hub-config" / "tasks.json").write_text(json.dumps({
            "rounds": [{
                "model_tasks": [{
                    "task_ids": {
                        "reference_date": {"optional": ["2025-10-01"]},
                        "target": {"optional": ["wk inc confirmed cases", "wk R_t", "cumulative cases", "mo inc dengue cases"]},
                        "horizon": {"optional": [-2, -1, 0, 1]},
                        "location": {"optional": ["CD", "CN"]},
                    },
                    "output_type": {"quantile": {"output_type_id": {"required": [0.5]}}},
                    "target_metadata": [
                        {"target_id": "wk inc confirmed cases", "target_name": "Weekly incident confirmed cases", "target_units": "count", "is_step_ahead": True, "time_unit": "week"},
                        {"target_id": "wk R_t", "target_name": "Weekly effective reproduction number", "target_units": "count", "is_step_ahead": True, "time_unit": "week"},
                        {"target_id": "cumulative cases", "target_name": "Current cumulative cases", "target_units": "cases", "is_step_ahead": False},
                        {"target_id": "mo inc dengue cases", "target_name": "Monthly reported dengue cases", "target_units": "count", "is_step_ahead": True, "time_unit": "month"},
                    ],
                }]
            }]
        }), encoding="utf-8")

        cfg = VizConfig(self.tmp)
        weekly = cfg.get_weekly_targets()
        self.assertNotIn("cumulative cases", weekly)
        self.assertEqual(set(weekly), {"wk inc confirmed cases", "wk R_t", "mo inc dengue cases"})

        rt_meta = cfg.get_target_metadata("wk R_t")
        self.assertEqual(rt_meta["scale"], "rate")
        self.assertTrue(rt_meta["is_rate"])
        self.assertFalse(rt_meta["per_100k_capable"])
        self.assertEqual(rt_meta["unit"], "R\u209c")
        self.assertTrue(rt_meta["is_non_negative"])

        den_meta = cfg.get_target_metadata("mo inc dengue cases")
        self.assertEqual(den_meta["time_unit"], "month")
        self.assertEqual(den_meta["scale"], "count")


class TestInternationalApiCatalogAndGlobe(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_builtin_hub_specs_registered(self):
        by_id = {h.id: h for h in BUILTIN_HUBS}
        for hid in ("china_id", "canada_rvdss", "ontario_hosp", "bdbv_drc"):
            self.assertIn(hid, by_id)
        self.assertEqual(by_id["bdbv_drc"].transport, "s3")
        self.assertEqual(by_id["bdbv_drc"].bucket, "bdbv-modeling-hub")

    def _make_hub(self, slug: str, tasks: dict, locations: dict | None, truth: pl.DataFrame, forecasts: dict[str, pl.DataFrame], yaml_meta: dict[str, str] | None = None) -> Path:
        root = self.tmp / slug
        (root / "hub-config").mkdir(parents=True)
        (root / "hub-config" / "tasks.json").write_text(json.dumps(tasks), encoding="utf-8")
        if locations is not None:
            (root / "auxiliary-data").mkdir(parents=True)
            pl.DataFrame(locations).write_csv(root / "auxiliary-data" / "locations.csv")
        (root / "target-data").mkdir(parents=True)
        truth.write_csv(root / "target-data" / "oracle-output.csv")
        for mid, fdf in forecasts.items():
            mdir = root / "model-output" / mid
            mdir.mkdir(parents=True)
            ref0 = str(fdf["reference_date"][0])[:10] if "reference_date" in fdf.columns and not fdf.is_empty() else "2025-11-15"
            fdf.write_csv(mdir / f"{ref0}-{mid}.csv")
        if yaml_meta:
            (root / "model-metadata").mkdir(parents=True)
            for fname, body in yaml_meta.items():
                (root / "model-metadata" / fname).write_text(body, encoding="utf-8")
        return root

    def test_china_percentage_promotion_monthly_fan_and_ontario_rvdss_unification(self):
        china_dir = self._make_hub(
            "china-hub",
            tasks={
                "rounds": [{
                    "model_tasks": [{
                        "task_ids": {
                            "reference_date": {"optional": ["2025-10-01", "2025-11-01"]},
                            "target": {"optional": ["wk inc flu prop ili", "mo inc dengue cases"]},
                            "horizon": {"optional": [0, 1]},
                            "location": {"optional": ["CN"]},
                        },
                        "output_type": {"quantile": {"output_type_id": {"required": [0.025, 0.25, 0.5, 0.75, 0.975]}}},
                        "target_metadata": [
                            {"target_id": "wk inc flu prop ili", "target_units": "proportion", "is_step_ahead": True, "time_unit": "week"},
                            {"target_id": "mo inc dengue cases", "target_units": "count", "is_step_ahead": True, "time_unit": "month"},
                        ],
                    }]
                }]
            },
            locations=None,
            truth=pl.DataFrame({
                "target": ["wk inc flu prop ili", "wk inc flu prop ili", "mo inc dengue cases", "mo inc dengue cases"],
                "target_end_date": ["2025-11-01", "2025-11-08", "2025-09-01", "2025-10-01"],
                "location": ["CN", "CN", "CN", "CN"],
                "oracle_value": [18.4, 24.6, 520.0, 610.0],
            }),
            forecasts={
                "CNCovidHub-ensemble": pl.DataFrame({
                    "reference_date": ["2025-10-01"] * 5 + ["2025-11-01"] * 5,
                    "horizon": [1] * 5 + [0] * 5,
                    "target": ["mo inc dengue cases"] * 5 + ["wk inc flu prop ili"] * 5,
                    "location": ["CN"] * 10,
                    "output_type": ["quantile"] * 10,
                    "output_type_id": [0.025, 0.25, 0.5, 0.75, 0.975] * 2,
                    "value": [400.0, 460.0, 500.0, 540.0, 600.0, 15.0, 20.0, 25.0, 30.0, 35.0],
                }),
            },
            yaml_meta={"CNCovidHub-ensemble.yaml": "team_abbr: CNCovidHub\nmodel_name: ensemble\ndesignated_model: true\n"},
        )

        rvdss_dir = self._make_hub(
            "rvdss-hub",
            tasks={
                "rounds": [{
                    "model_tasks": [{
                        "task_ids": {
                            "reference_date": {"optional": ["2025-11-15"]},
                            "target": {"optional": ["pct wk flu lab det"]},
                            "horizon": {"optional": [0, 1]},
                            "location": {"optional": ["ca", "on"]},
                        },
                        "output_type": {"quantile": {"output_type_id": {"required": [0.5]}}},
                        "target_metadata": [{"target_id": "pct wk flu lab det", "target_units": "percentage", "is_step_ahead": True}],
                    }]
                }]
            },
            locations={
                "geo_type": ["nation", "province"],
                "geo_abbr": ["ca", "on"],
                "geo_name": ["Canada", "Ontario"],
            },
            truth=pl.DataFrame({
                "target": ["pct wk flu lab det", "pct wk flu lab det"],
                "target_end_date": ["2025-11-15", "2025-11-15"],
                "location": ["ca", "on"],
                "oracle_value": [11.0, 14.0],
            }),
            forecasts={
                "RVDSS-ensemble": pl.DataFrame({
                    "reference_date": ["2025-11-15", "2025-11-15"],
                    "horizon": [1, 1],
                    "target": ["pct wk flu lab det", "pct wk flu lab det"],
                    "location": ["ca", "on"],
                    "output_type": ["quantile", "quantile"],
                    "output_type_id": [0.5, 0.5],
                    "value": [12.0, 15.0],
                }),
            },
        )

        ontario_dir = self._make_hub(
            "ontario-hub",
            tasks={
                "rounds": [{
                    "model_tasks": [{
                        "task_ids": {
                            "reference_date": {"optional": ["2025-11-15"]},
                            "target": {"optional": ["wk inc flu hosp"]},
                            "horizon": {"optional": [0, 1]},
                            "location": {"optional": ["Ontario", "Toronto", "Central", "East", "West", "North East", "North West"]},
                        },
                        "output_type": {"quantile": {"output_type_id": {"required": [0.5]}}},
                        "target_metadata": [{"target_id": "wk inc flu hosp", "target_units": "count", "is_step_ahead": True}],
                    }]
                }]
            },
            locations=None,
            truth=pl.DataFrame({
                "target": ["wk inc flu hosp", "wk inc flu hosp"],
                "target_end_date": ["2025-11-15", "2025-11-15"],
                "location": ["Ontario", "Toronto"],
                "oracle_value": [300.0, 95.0],
            }),
            forecasts={
                "ON-ensemble": pl.DataFrame({
                    "reference_date": ["2025-11-15", "2025-11-15"],
                    "horizon": [1, 1],
                    "target": ["wk inc flu hosp", "wk inc flu hosp"],
                    "location": ["Ontario", "Toronto"],
                    "output_type": ["quantile", "quantile"],
                    "output_type_id": [0.5, 0.5],
                    "value": [310.0, 98.0],
                }),
            },
        )

        # Register all 3 local workspaces without touching real user state
        data_dir = self.tmp / "data"
        mgr = HubManager(data_dir=data_dir, mode="local", include_enclosing=False)
        hub_ids = {}
        for p in (china_dir, rvdss_dir, ontario_dir):
            res = mgr.add_local_hub(str(p))
            self.assertTrue(res["ok"], res)
            hub_ids[p.name] = res["hub"]["id"]
        china_ctx = mgr.get_context(hub_ids["china-hub"])

        man = china_ctx.next_data.manifest()
        t_by_id = {t["id"]: t for t in man["targets"]}
        # China 0-100 ILI proportion auto-promoted to percentage
        self.assertEqual(t_by_id["wk inc flu prop ili"]["scale"], "percentage")
        # Monthly dengue carries time_unit="month" in manifest and VZF2 header
        self.assertEqual(t_by_id["mo inc dengue cases"]["time_unit"], "month")
        fan_bytes = china_ctx.next_data.fan("mo inc dengue cases", man["seasons"][0]["id"], "CN")
        self.assertIsNotNone(fan_bytes)
        hlen = struct.unpack("<I", fan_bytes[4:8])[0]
        hdr = json.loads(fan_bytes[8:8 + hlen].decode("utf-8"))
        self.assertEqual(hdr["time_unit"], "month")

        cat = WorkspaceCatalog(mgr).build_catalog()
        # Both RVDSS ("on") and Ontario Hosp ("Ontario") unify under CA-ON
        self.assertIn("CA-ON", cat["places"])
        on_hubs = {h["hub_id"] for h in cat["places"]["CA-ON"]["hubs"]}
        self.assertEqual(len(on_hubs), 2)
        self.assertIn("CA-ON:Toronto", cat["places"])
        self.assertIn("CN", cat["places"])
        # Lab positivity and ILI positivity map to structured concepts
        cids = {t["target_id"]: t["concept_id"] for t in cat["targets"]}
        self.assertEqual(cids["pct wk flu lab det"], "flu_lab_positivity")
        self.assertEqual(cids["wk inc flu prop ili"], "flu_ili_positivity")
        self.assertEqual(cids["wk inc flu hosp"], "flu_hosp")

        globe = WorkspaceCatalog(mgr).build_globe()
        self.assertTrue(globe["coverage"]["has_cn"])
        self.assertTrue(globe["coverage"]["has_ca_provinces"])
        self.assertTrue(globe["coverage"]["has_ca_ontario"])
        self.assertIsNotNone(globe["regions"]["CA-ON"]["lat"])
        self.assertIsNotNone(globe["regions"]["CN"]["lat"])

    def test_geo_kind_classification_and_place_keys(self):
        self.assertEqual(classify_geo_kind({"CD": {"level": "country"}, "CD-BU": {"level": "province"}, "CD-BU-01": {"level": "health_zone"}}), "cd-provinces")
        self.assertEqual(classify_geo_kind({"Ontario": {"level": "province"}, "Toronto": {"level": "region"}}), "ca-ontario")
        self.assertEqual(classify_geo_kind({"ca": {"canonical_id": "CA"}, "on": {"canonical_id": "CA:ON"}}), "ca-provinces")
        self.assertEqual(classify_geo_kind({"CN": {"canonical_id": "CN"}}), "cn-national")
        self.assertEqual(canonical_place_key("h", "CD-BU-01", {"parent_id": "CD-BU", "level": "health_zone"}, "cd-provinces"), ("CD-BU-01", None, "CD-BU"))
        self.assertEqual(infer_pathogen("bdbv_drc", "DRC BDBV Hub", targets=["wk R_t"])[0], "bdbv")
        self.assertEqual(canonical_target_concept("wk R_t", {"scale": "rate", "display_name": "Weekly effective reproduction number"}, "bdbv")[0], "rt")

    def test_sample_only_model_scored_and_evaluated(self):
        from viz.core.evaluation import EvaluationParams

        drc_dir = self._make_hub(
            "drc-sample-hub",
            tasks={
                "rounds": [{
                    "model_tasks": [{
                        "task_ids": {
                            "reference_date": {"optional": ["2025-11-08", "2025-11-15"]},
                            "target": {"optional": ["wk inc confirmed cases"]},
                            "horizon": {"optional": [0, 1]},
                            "location": {"optional": ["CD", "CD-KN"]},
                        },
                        "output_type": {"sample": {"output_type_id": {"required": None}}},
                        "target_metadata": [{"target_id": "wk inc confirmed cases", "target_units": "count", "is_step_ahead": True}],
                    }]
                }]
            },
            locations={
                "location": ["CD", "CD-KN", "CD-KN-01"],
                "location_name": ["DRC", "Kinshasa", "Bandalungwa"],
                "location_type": ["country", "province", "health zone"],
                "parent": ["", "DRC", "Kinshasa"],
            },
            truth=pl.DataFrame({
                "target": ["wk inc confirmed cases"] * 4,
                "target_end_date": ["2025-11-08", "2025-11-15"] * 2,
                "location": ["CD", "CD", "CD-KN-01", "CD-KN-01"],
                "oracle_value": [25.0, 30.0, 10.0, 12.0],
            }),
            forecasts={
                "Team-Sample": pl.DataFrame({
                    "reference_date": ["2025-11-08"] * 6,
                    "horizon": [0, 0, 0, 1, 1, 1],
                    "target": ["wk inc confirmed cases"] * 6,
                    "location": ["CD-KN-01"] * 6,
                    "output_type": ["sample"] * 6,
                    "output_type_id": ["s1", "s2", "s3", "s1", "s2", "s3"],
                    "value": [8.0, 10.0, 12.0, 10.0, 12.0, 14.0],
                }),
            },
        )
        mgr = HubManager(data_dir=self.tmp / "data2", mode="local", include_enclosing=False)
        res = mgr.add_local_hub(str(drc_dir))
        self.assertTrue(res["ok"], res)
        ctx = mgr.get_context(res["hub"]["id"])
        ev = ctx.eval_engine.evaluate(EvaluationParams(target="wk inc confirmed cases", season="2025-2026", location="all"))
        ranked = [r for r in ev.rankings if r.get("has_data_in_scope")]
        self.assertEqual(len(ranked), 1)
        self.assertEqual(ranked[0]["model_id"], "Team-Sample")
        self.assertIsNotNone(ranked[0]["wis"])

    def test_check_after_nested_and_concat_truth_sync_reports_no_updates(self):
        from viz.remote.store import RemoteStore
        from viz.remote.sync import RemoteManager
        from viz.remote.hubs import HubSpec

        # Fake GitHub-style transport with nested target-data/season_* + auxiliary-data/concatenated_*
        files = {
            "hub-config/admin.json": json.dumps({"name": "Nested Truth Hub"}).encode("utf-8"),
            "hub-config/tasks.json": json.dumps({
                "rounds": [{
                    "round_id": "reference_date",
                    "model_tasks": [{
                        "task_ids": {
                            "reference_date": {"optional": ["2026-10-24"]},
                            "target": {"optional": ["wk inc flu hosp"]},
                            "location": {"optional": ["Ontario", "Toronto"]},
                            "horizon": {"optional": [0, 1]},
                        },
                        "output_type": {"quantile": {"output_type_id": {"required": [0.5]}}},
                    }],
                }]
            }).encode("utf-8"),
            "auxiliary-data/locations.csv": b"geo_abbr,geo_name,geo_type\nOntario,Ontario,province\nToronto,Toronto,region\n",
            "auxiliary-data/concatenated_hospitalization_data.csv": b"time,geo_value,flu\n2025-11-15,Toronto,12\n",
            "target-data/season_2026_2027/hospitalization-data.csv": b"time,geo_value,flu\n2026-10-17,Toronto,18\n",
            "model-output/AI4Casting_Hub-Ensemble_v1/2026-10-24-AI4Casting_Hub-Ensemble_v1.csv": (
                b"reference_date,target,horizon,location,target_end_date,output_type,output_type_id,value\n"
                b"2026-10-24,wk inc flu hosp,0,Toronto,2026-10-24,quantile,0.5,20\n"
            ),
        }
        etags = {k: f"sha-{abs(hash(v)) % 10**8}" for k, v in files.items()}

        class FakeTransport:
            def __init__(self, spec, cancel_event=None):
                self.bucket = spec.bucket
                self.repo = spec.github_repo

            def list(self, prefix=""):
                return [
                    RemoteObject(key=k, last_modified="", size=len(v), etag=etags[k])
                    for k, v in sorted(files.items())
                    if k.startswith(prefix)
                ]

            def get(self, key):
                return files[key]

        store = RemoteStore(self.tmp / "cache")
        spec = HubSpec(
            id="ontario_hosp",
            label="Ontario Hosp",
            short_label="Ontario",
            transport="github",
            github_repo="ai4castinghub/hospitalization-forecast",
            geography="CA-ON",
        )
        store._registry()
        rmgr = RemoteManager(
            store=store,
            known_locations=lambda: {"Ontario", "Toronto"},
            is_non_negative=lambda t: True,
            local_as_of_max=lambda: None,
            on_inventory_change=lambda h, ms: None,
            transport_factory=lambda s, cancel_event=None: FakeTransport(s, cancel_event=cancel_event),
        )
        # Wait on sync using direct _run_sync via SyncJob
        from viz.remote.sync import SyncJob
        job = SyncJob("ontario_hosp", ["2026-2027"])
        rmgr._run_sync(spec, job)
        self.assertEqual(job.status, "done", job.error)
        chk = rmgr.check("ontario_hosp")
        p = chk["pending"]
        self.assertFalse(p["truth_changed"], p)
        self.assertEqual(p["new"], 0)
        self.assertEqual(p["changed"], 0)
        self.assertEqual(p["removed"], 0)

    def test_drc_ignores_non_weekly_rounds_and_matches_sunday_asof_snapshots(self):
        drc_dir = self._make_hub(
            "drc-asof-hub",
            tasks={
                "rounds": [
                    {
                        "round_id": "reference_date",
                        "model_tasks": [{
                            "task_ids": {
                                "reference_date": {"optional": ["2026-08-02", "2026-08-03", "2026-10-08"]},
                                "target": {"required": ["cumulative cases"]},
                                "location": {"optional": ["CD"]},
                            },
                            "output_type": {"quantile": {"output_type_id": {"required": [0.5]}}},
                            "target_metadata": [{"target_id": "cumulative cases", "target_units": "cases", "is_step_ahead": False}],
                        }],
                    },
                    {
                        "round_id": "reference_date",
                        "model_tasks": [{
                            "task_ids": {
                                "reference_date": {"optional": ["2026-10-31", "2026-11-07"]},
                                "target": {"optional": ["wk inc confirmed cases"]},
                                "horizon": {"optional": [0, 1]},
                                "location": {"optional": ["CD"]},
                            },
                            "output_type": {"sample": {"output_type_id": {"required": None}}},
                            "target_metadata": [{"target_id": "wk inc confirmed cases", "target_units": "count", "is_step_ahead": True}],
                        }],
                    },
                ]
            },
            locations={"location": ["CD"], "location_name": ["DRC"], "location_type": ["country"]},
            truth=pl.DataFrame({
                "as_of": ["2026-11-01", "2026-11-01", "2026-11-08", "2026-11-08", "2026-11-08"],
                "target": ["wk inc confirmed cases"] * 5,
                "target_end_date": ["2026-10-24", "2026-10-31", "2026-10-24", "2026-10-31", "2026-11-07"],
                "location": ["CD"] * 5,
                "oracle_value": [381.0, 150.0, 482.0, 349.0, 68.0],
            }),
            forecasts={
                "Team-Sample": pl.DataFrame({
                    "reference_date": ["2026-10-31", "2026-10-31"],
                    "horizon": [0, 1],
                    "target": ["wk inc confirmed cases", "wk inc confirmed cases"],
                    "location": ["CD", "CD"],
                    "output_type": ["quantile", "quantile"],
                    "output_type_id": [0.5, 0.5],
                    "value": [400.0, 350.0],
                }),
            },
        )
        # Write as-of snapshots parquet directly where Loader expects it
        (drc_dir / "target-data" / "time-series.csv").write_text(
            "as_of,target,target_end_date,location,oracle_value\n"
            "2026-11-01,wk inc confirmed cases,2026-10-24,CD,381\n"
            "2026-11-01,wk inc confirmed cases,2026-10-31,CD,150\n"
            "2026-11-08,wk inc confirmed cases,2026-10-24,CD,482\n"
            "2026-11-08,wk inc confirmed cases,2026-10-31,CD,349\n"
            "2026-11-08,wk inc confirmed cases,2026-11-07,CD,68\n",
            encoding="utf-8",
        )
        mgr = HubManager(data_dir=self.tmp / "data_drc", mode="local", include_enclosing=False)
        res = mgr.add_local_hub(str(drc_dir))
        self.assertTrue(res["ok"], res)
        ctx = mgr.get_context(res["hub"]["id"])
        # Non-weekly Sunday/August rounds from `cumulative cases` are excluded
        self.assertEqual(ctx.loader.get_forecast_seasons(), ["2026-2027"])
        self.assertEqual(ctx.loader.get_dates_for_season("2026-2027"), ["2026-11-07", "2026-10-31"])
        # Sunday as_of (2026-11-01) aligns cleanly to Saturday round 2026-10-31, with points d < r
        # First force as_of parquet write via cache_mgr / truth scan
        pl.DataFrame({
            "as_of": ["2026-11-01", "2026-11-01", "2026-11-08", "2026-11-08", "2026-11-08"],
            "target": ["wk inc confirmed cases"] * 5,
            "target_end_date": ["2026-10-24", "2026-10-31", "2026-10-24", "2026-10-31", "2026-11-07"],
            "location": ["CD"] * 5,
            "oracle_value": [381.0, 150.0, 482.0, 349.0, 68.0],
        }).write_parquet(ctx.loader.cache_mgr.get_as_of_admissions_parquet())
        asof = ctx.next_data.asof("wk inc confirmed cases", "2026-2027", "CD")
        self.assertEqual(asof["snapshots"], {"2026-10-31": "2026-11-01", "2026-11-07": "2026-11-08"})
        self.assertEqual(asof["rounds"]["2026-10-31"], [["2026-10-24", 381.0]])
        self.assertEqual(asof["rounds"]["2026-11-07"], [["2026-10-24", 482.0], ["2026-10-31", 349.0]])


if __name__ == "__main__":
    unittest.main()
