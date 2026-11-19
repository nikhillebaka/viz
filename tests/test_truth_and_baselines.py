"""
Self-contained unit and integration tests for:
- Cross-hub truth, admissions, and point-in-time vintage reconciliation
- Dynamic per-target, per-season, and cross-hub baseline discovery
- Filtering unstarted future rounds from tasks.json based on latest truth & forecasts
- Shared compatible S3 remote storage & upstream truth change detection
- Fast incremental local cache refresh & NextData/EvaluationEngine cache invalidation
- Concise workspace hub display names and metadata descriptions
"""

import json
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest

import polars as pl

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from conftest import APP_DIR  # noqa: E402,F401  (ensures viz package importability)
from tests.test_remote_hubs import FakeS3, flu_tasks, forecast_parquet  # noqa: E402
from tests.test_workspace import _build_synthetic_hub  # noqa: E402
from viz.core.baselines import baseline_tier, build_manifest_baselines  # noqa: E402
from viz.core.data_loader import SandboxDataLoader  # noqa: E402
from viz.core.evaluation import EvaluationEngine, EvaluationParams  # noqa: E402
from viz.core.next_api import NextData  # noqa: E402
from viz.core.paths import inspect_local_hub, short_hub_name  # noqa: E402
from viz.core.truth import (  # noqa: E402
    ORACLE_KEYS,
    PRIORITY_ARCHIVE,
    PRIORITY_PEER,
    PRIORITY_REPO,
    TruthSource,
    is_flu_hosp_target,
    reconcile_truth_sources,
    reconcile_vintages,
    reconcile_weekly_series,
)
from viz.core.workspace import HubManager, WorkspaceRegistry  # noqa: E402
from viz.remote.s3 import S3Client  # noqa: E402
from viz.remote.sync import RemoteManager  # noqa: E402

QUANTILES = [0.025, 0.25, 0.5, 0.75, 0.975]


class TestTruthReconciliation(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="viz-truth-")).resolve()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_weekly_series_prefers_newest_vintage_between_oracle_and_admissions(self):
        oracle_df = pl.DataFrame({
            "target": ["wk inc flu hosp"] * 2,
            "location": ["US", "US"],
            "target_end_date": ["2026-10-31", "2026-11-07"],
            "oracle_value": [100.0, 120.0],
            "as_of": ["2026-11-11", "2026-11-11"],
        })
        admissions_df = pl.DataFrame({
            "location": ["US", "US", "US"],
            "target_end_date": ["2026-10-24", "2026-11-07", "2026-11-14"],
            "oracle_value": [90.0, 125.0, 150.0],
            "as_of": ["2026-11-18", "2026-11-18", "2026-11-18"],
        })
        weekly = reconcile_weekly_series(oracle_df, admissions_df, "wk inc flu hosp", include_admissions=True)
        got = dict(zip(weekly["target_end_date"].to_list(), weekly["value"].to_list()))
        self.assertEqual(got["2026-10-24"], 90.0)
        self.assertEqual(got["2026-10-31"], 100.0)
        self.assertEqual(got["2026-11-07"], 125.0)  # newer admissions overrides stale oracle
        self.assertEqual(got["2026-11-14"], 150.0)

        # Conversely, a newer oracle vintage wins over an older admissions table
        newer_oracle = oracle_df.with_columns(pl.lit("2026-11-25").alias("as_of"))
        weekly2 = reconcile_weekly_series(newer_oracle, admissions_df, "wk inc flu hosp", include_admissions=True)
        got2 = dict(zip(weekly2["target_end_date"].to_list(), weekly2["value"].to_list()))
        self.assertEqual(got2["2026-11-07"], 120.0)
        self.assertEqual(got2["2026-11-14"], 150.0)

    def test_same_vintage_conflict_warns_and_foreign_targets_filtered(self):
        warnings = []
        src_repo = TruthSource("repo", "repo", "oracle", PRIORITY_REPO)
        src_peer = TruthSource("peer:alt", "Sibling Flu", "oracle", PRIORITY_PEER)

        df_repo = pl.DataFrame({
            "as_of": ["2026-11-11"],
            "target": ["wk inc flu hosp"],
            "target_end_date": ["2026-11-07"],
            "location": ["US"],
            "horizon": [0],
            "output_type": ["quantile"],
            "output_type_id": [None],
            "oracle_value": [200.0],
        })
        df_peer = pl.DataFrame({
            "as_of": ["2026-11-11", "2026-11-11"],
            "target": ["wk inc flu hosp", "wk inc covid hosp"],
            "target_end_date": ["2026-11-07", "2026-11-07"],
            "location": ["US", "US"],
            "horizon": [1, 0],  # horizon-invariant value on US flu hosp
            "output_type": ["quantile", "quantile"],
            "output_type_id": [None, None],
            "oracle_value": [250.0, 999.0],
        })
        out = reconcile_truth_sources(
            [(src_repo, df_repo), (src_peer, df_peer)],
            ORACLE_KEYS,
            allowed_targets={"wk inc flu hosp"},
            allowed_locations={"US"},
            filter_external_only=True,
            collapse_constant_horizons=True,
            conflict_callback=warnings.append,
        )
        self.assertEqual(out["target"].unique().to_list(), ["wk inc flu hosp"])
        self.assertEqual(out["oracle_value"].to_list(), [200.0])  # repo priority beats peer tie
        self.assertEqual(len(warnings), 1)
        self.assertIn("Truth disagreement", warnings[0])
        self.assertIn("repo", warnings[0])
        self.assertIn("Sibling Flu", warnings[0])

    def test_vintages_preserve_all_snapshots_across_sources(self):
        s_arch = TruthSource("bundled", "surveillance", "as_of", PRIORITY_ARCHIVE)
        s_peer = TruthSource("peer:sib", "Sibling", "as_of", PRIORITY_PEER)
        df_a = pl.DataFrame({
            "as_of": ["2025-11-12", "2025-11-19"],
            "target": ["wk inc flu hosp"] * 2,
            "location": ["US", "US"],
            "target_end_date": ["2025-11-08", "2025-11-15"],
            "oracle_value": [100.0, 140.0],
        })
        df_p = pl.DataFrame({
            "as_of": ["2025-11-19", "2026-11-18"],
            "target": ["wk inc flu hosp"] * 2,
            "location": ["US", "US"],
            "target_end_date": ["2025-11-15", "2026-11-14"],
            "oracle_value": [142.0, 310.0],
        })
        merged = reconcile_vintages(
            [(s_arch, df_a), (s_peer, df_p)],
            allowed_targets={"wk inc flu hosp"},
            allowed_locations={"US"},
            filter_external_only=True,
        )
        self.assertEqual(merged.height, 3)
        v_map = {(r["as_of"], r["target_end_date"]): r["oracle_value"] for r in merged.iter_rows(named=True)}
        self.assertEqual(v_map[("2025-11-19", "2025-11-15")], 142.0)  # higher priority peer wins same-vintage tie
        self.assertEqual(v_map[("2026-11-18", "2026-11-14")], 310.0)

    def test_non_flu_hub_never_loads_bundled_flu_surveillance(self):
        covid = _build_synthetic_hub(
            self.tmp / "covid-hub",
            name="COVID Hub",
            target="wk inc covid hosp",
            model_names=("COVID-baseline",),
            truth_val=800.0,
        )
        surv_dir = self.tmp / "bundled-surv"
        surv_dir.mkdir(parents=True)
        pl.DataFrame({
            "location": ["US"],
            "date": ["2026-11-21"],
            "value": [99999.0],
        }).write_csv(surv_dir / "target-hospital-admissions.csv")

        loader = SandboxDataLoader(
            covid,
            include_remote=False,
            cache_dir=self.tmp / "cache",
            surveillance_dir=surv_dir,
        )
        self.assertFalse(is_flu_hosp_target("wk inc covid hosp"))
        adm_pq = loader.cache_mgr.get_admissions_parquet("wk inc covid hosp")
        if adm_pq is not None and adm_pq.exists():
            adm_dates = pl.read_parquet(adm_pq).get_column("target_end_date").to_list()
            self.assertNotIn("2026-11-21", adm_dates)
        # `_latest_truth_date` must remain anchored at COVID hub's 2024-01-20, not 2026-11-21 flu surveillance
        self.assertEqual(loader._latest_truth_date(), "2024-01-20")
        info = loader.get_truth_info()
        self.assertEqual(info["latest_observation"], "2024-01-20")


class TestFutureRoundFilteringAndPeerSharing(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="viz-rounds-")).resolve()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_filters_unstarted_future_rounds_while_keeping_truth_and_forecast_rounds(self):
        hub = self.tmp / "flu-hub"
        (hub / "hub-config").mkdir(parents=True)
        (hub / "auxiliary-data").mkdir(parents=True)
        (hub / "target-data").mkdir(parents=True)
        (hub / "model-output" / "FluSight-baseline").mkdir(parents=True)

        pl.DataFrame({
            "abbreviation": ["US"],
            "location": ["US"],
            "location_name": ["United States"],
            "population": [330_000_000],
        }).write_csv(hub / "auxiliary-data" / "locations.csv")

        # tasks.json lists started rounds in 2025-2026 and 2026-2027 PLUS far-future rounds through 2027-05-29
        all_rounds = ["2025-11-22", "2026-10-31", "2026-11-07", "2026-11-14", "2026-11-21", "2026-11-28", "2027-05-29"]
        (hub / "hub-config" / "tasks.json").write_text(json.dumps({
            "rounds": [{
                "round_id_from_variable": True,
                "model_tasks": [{
                    "task_ids": {
                        "origin_date": {"optional": all_rounds, "required": None},
                        "target": {"required": ["wk inc flu hosp"], "optional": None},
                        "location": {"optional": ["US"], "required": None},
                    }
                }],
            }]
        }), encoding="utf-8")

        # Truth stops at 2026-11-14 (admissions overrides older 2026-11-07 oracle)
        pl.DataFrame({
            "as_of": ["2026-11-11"],
            "target": ["wk inc flu hosp"],
            "target_end_date": ["2026-11-07"],
            "location": ["US"],
            "horizon": [0],
            "output_type": ["quantile"],
            "output_type_id": [None],
            "oracle_value": [1200.0],
        }).write_csv(hub / "target-data" / "oracle-output.csv")
        pl.DataFrame({
            "as_of": ["2026-11-18", "2026-11-18"],
            "location": ["US", "US"],
            "date": ["2026-11-07", "2026-11-14"],
            "value": [1250.0, 1400.0],
        }).write_csv(hub / "target-data" / "target-hospital-admissions.csv")

        # Latest forecast is 2026-11-14
        rows = []
        for q in QUANTILES:
            rows.append({
                "reference_date": "2026-11-14",
                "target": "wk inc flu hosp",
                "horizon": 0,
                "target_end_date": "2026-11-14",
                "location": "US",
                "output_type": "quantile",
                "output_type_id": q,
                "value": 1400.0 * (0.8 + 0.4 * q),
            })
        pl.DataFrame(rows).write_csv(hub / "model-output" / "FluSight-baseline" / "2026-11-14-FluSight-baseline.csv")

        loader = SandboxDataLoader(hub, include_remote=False, cache_dir=self.tmp / "cache")
        filtered = loader.get_hub_seasons()
        self.assertEqual(filtered["2025-2026"], ["2025-11-22"])
        self.assertEqual(filtered["2026-2027"], ["2026-11-14", "2026-11-07", "2026-10-31"])
        self.assertNotIn("2026-11-21", filtered["2026-2027"])
        self.assertNotIn("2027-05-29", filtered["2026-2027"])

        raw = loader.get_hub_seasons(include_future=True)
        self.assertIn("2027-05-29", raw["2026-2027"])

    def test_peer_hub_truth_shared_only_when_target_compatible_and_remote_dir_shared(self):
        data_dir = self.tmp / "app-data"

        flu_main = _build_synthetic_hub(
            self.tmp / "flu-main",
            name="Main Flu Hub",
            target="wk inc flu hosp",
            model_names=("FluSight-baseline",),
            truth_val=1000.0,
        )
        flu_peer = _build_synthetic_hub(
            self.tmp / "flu-peer",
            name="Peer Flu Hub",
            target="wk inc flu hosp",
            model_names=("Alt-baseline",),
            truth_val=1500.0,
        )
        # Add a newer observation date on the flu peer
        pl.DataFrame({
            "as_of": ["2024-06-15"],
            "target": ["wk inc flu hosp"],
            "target_end_date": ["2024-01-27"],
            "location": ["US"],
            "horizon": [0],
            "output_type": ["quantile"],
            "output_type_id": [None],
            "oracle_value": [1888.0],
        }).write_csv(flu_peer / "target-data" / "oracle-output.csv")

        covid_hub = _build_synthetic_hub(
            self.tmp / "covid-hub",
            name="COVID-19 Hub",
            target="wk inc covid hosp",
            model_names=("COVID-baseline",),
            truth_val=5000.0,
        )

        # Put a shared S3 flusight hub under data_dir/remote/flusight
        remote_fs = data_dir / "remote" / "flusight"
        (remote_fs / "hub-config").mkdir(parents=True)
        (remote_fs / "target-data").mkdir(parents=True)
        (remote_fs / "hub-config" / "tasks.json").write_text(json.dumps(flu_tasks()), encoding="utf-8")
        (remote_fs / "manifest.json").write_text(json.dumps({
            "hub_name": "FluSight",
            "seasons": ["2023-2024"],
            "files": {},
            "truth": {"oracle": {"as_of": "2024-06-20"}},
        }), encoding="utf-8")
        pl.DataFrame({
            "as_of": ["2024-06-20"],
            "target": ["wk inc flu hosp"],
            "target_end_date": ["2024-02-03"],
            "location": ["US"],
            "horizon": [0],
            "output_type": ["quantile"],
            "output_type_id": [None],
            "oracle_value": [2111.0],
        }).write_parquet(remote_fs / "target-data" / "oracle.parquet")

        mgr = HubManager(data_dir=data_dir, mode="local", include_enclosing=False)
        r_main = mgr.add_local_hub(str(flu_main), activate=True)["hub"]
        r_peer = mgr.add_local_hub(str(flu_peer), activate=False)["hub"]
        r_covid = mgr.add_local_hub(str(covid_hub), activate=False)["hub"]
        self.assertIsNotNone(r_peer)

        ctx_main = mgr.get_context(r_main["id"])
        ctx_covid = mgr.get_context(r_covid["id"])
        # Shared remote_dir is the same directory across contexts
        self.assertEqual(ctx_main.remote_dir, data_dir / "remote")
        self.assertEqual(ctx_covid.remote_dir, data_dir / "remote")
        # Compatible flu peer & shared S3 FluSight truth appear in flu_main
        flu_oracle = ctx_main.loader.get_oracle()
        flu_dates = dict(zip(
            flu_oracle.filter(pl.col("location") == "US")["target_end_date"].to_list(),
            flu_oracle.filter(pl.col("location") == "US")["oracle_value"].to_list(),
        ))
        self.assertEqual(flu_dates["2024-01-27"], 1888.0)
        self.assertEqual(flu_dates["2024-02-03"], 2111.0)
        self.assertNotIn("wk inc covid hosp", flu_oracle["target"].to_list())
        self.assertEqual(ctx_main.loader.remote_store.root, data_dir / "remote")

        # COVID hub stays completely isolated from flu peer and S3 flusight
        covid_oracle = ctx_covid.loader.get_oracle()
        self.assertEqual(covid_oracle["target"].unique().to_list(), ["wk inc covid hosp"])
        self.assertEqual(ctx_covid.loader.cache_mgr.active_remote_hub_ids(), [])
        remote_statuses = {h["id"]: h for h in ctx_covid.remote_mgr.list_hubs()}
        self.assertFalse(remote_statuses["flusight"]["compatible"])


class TestBaselines(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="viz-base-")).resolve()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_baseline_tier_and_per_target_season_manifest(self):
        self.assertEqual(baseline_tier("FluSight-baseline", config_default="FluSight-baseline"), 5)
        self.assertEqual(baseline_tier("custom-null", {"baseline_model": True}), 4)
        self.assertEqual(baseline_tier("flusight:FluSight-baseline"), 3)
        self.assertEqual(baseline_tier("FluSight-baseline_cat"), 2)
        self.assertEqual(baseline_tier("UMass-gbq"), 0)

        models = {
            "FluSight-baseline": {
                "source": "repo", "targets": ["wk inc flu hosp"],
                "seasons": ["2026-2027"], "dates": ["2026-10-10", "2026-10-17"],
            },
            "FluSight-baseline_cat": {
                "source": "repo", "targets": ["wk inc flu hosp"],
                "seasons": ["2026-2027"], "dates": ["2026-10-10", "2026-10-17"],
            },
            "flusight:FluSight-baseline": {
                "source": "hub", "targets": ["wk inc flu hosp"],
                "seasons": ["2023-2024", "2026-2027"],
                "dates": ["2023-10-14", "2026-10-10", "2026-10-17"],
            },
            "flusight:FluSight-prop-baseline": {
                "source": "hub", "targets": ["wk inc flu prop ed visits"],
                "seasons": ["2026-2027"], "dates": ["2026-10-10"],
            },
            "Team-model": {
                "source": "repo", "targets": ["wk inc flu hosp", "wk inc flu prop ed visits"],
                "seasons": ["2023-2024", "2026-2027"], "dates": ["2023-10-14", "2026-10-10"],
            },
        }
        info = build_manifest_baselines(
            models,
            model_meta={},
            targets=["wk inc flu hosp", "wk inc flu prop ed visits"],
            seasons_map={"2023-2024": ["2023-10-14"], "2026-2027": ["2026-10-10", "2026-10-17"]},
            default_target="wk inc flu hosp",
        )
        self.assertEqual(info["default"], "FluSight-baseline")
        self.assertEqual(info["by_target"]["wk inc flu prop ed visits"], "flusight:FluSight-prop-baseline")
        self.assertEqual(info["by_target_season"]["wk inc flu hosp"]["2023-2024"], "flusight:FluSight-baseline")
        self.assertEqual(info["by_target_season"]["wk inc flu hosp"]["2026-2027"], "FluSight-baseline")

    def test_evaluation_picks_target_and_season_baseline_without_fallback_warning(self):
        hub = _build_synthetic_hub(
            self.tmp / "multi-target-hub",
            name="Multi Target Hub",
            target="wk inc flu hosp",
            model_names=("FluSight-baseline", "Team-alpha"),
            truth_val=1000.0,
        )
        # Add an ED visits target covered by an alternate baseline + Team-alpha
        tasks = json.loads((hub / "hub-config" / "tasks.json").read_text(encoding="utf-8"))
        tasks["rounds"][0]["model_tasks"][0]["task_ids"]["target"] = {
            "required": ["wk inc flu hosp", "wk inc flu prop ed visits"],
            "optional": None,
        }
        (hub / "hub-config" / "tasks.json").write_text(json.dumps(tasks), encoding="utf-8")

        oracle = pl.read_csv(hub / "target-data" / "oracle-output.csv")
        ed_oracle = oracle.with_columns([
            pl.lit("wk inc flu prop ed visits").alias("target"),
            pl.lit(0.05).alias("oracle_value"),
        ])
        pl.concat([oracle, ed_oracle]).write_csv(hub / "target-data" / "oracle-output.csv")

        for mid, scale in (("ED-baseline", 1.0), ("Team-alpha", 1.1)):
            mdir = hub / "model-output" / mid
            mdir.mkdir(parents=True, exist_ok=True)
            rows = []
            for loc in ("US", "25"):
                for h, ted in ((0, "2024-01-13"), (1, "2024-01-20")):
                    for q in QUANTILES:
                        rows.append({
                            "reference_date": "2024-01-13",
                            "target": "wk inc flu prop ed visits",
                            "horizon": h,
                            "target_end_date": ted,
                            "location": loc,
                            "output_type": "quantile",
                            "output_type_id": q,
                            "value": 0.05 * scale * (0.8 + 0.4 * q),
                        })
            pl.DataFrame(rows).write_csv(mdir / "2024-01-13-ed.csv")

        loader = SandboxDataLoader(hub, include_remote=False, cache_dir=self.tmp / "cache")
        engine = EvaluationEngine(hub, loader)
        res = engine.evaluate(EvaluationParams(target="wk inc flu prop ed visits", location="US", season="2023-2024"))
        self.assertEqual(res.baseline_model, "ED-baseline")
        self.assertFalse(any("scaled to" in w for w in res.validation_warnings))

        man = NextData(loader, loader.config).manifest()
        self.assertEqual(man["baselines"]["by_target"]["wk inc flu prop ed visits"], "ED-baseline")
        self.assertEqual(man["baselines"]["by_target"]["wk inc flu hosp"], "FluSight-baseline")


class TestSyncCheckRefreshAndLabels(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="viz-polish-")).resolve()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_remote_check_detects_upstream_truth_change(self):
        base = self.tmp / "repo"
        (base / "viz").mkdir(parents=True)
        (base / "auxiliary-data").mkdir()
        (base / "target-data").mkdir()
        pl.DataFrame({
            "abbreviation": ["US"], "location": ["US"], "location_name": ["US"], "population": [330_000_000],
        }).write_csv(base / "auxiliary-data" / "locations.csv")

        s3 = FakeS3()
        try:
            s3.put("hub-config/admin.json", json.dumps({"name": "FluSight", "timezone": "US/Eastern"}))
            s3.put("hub-config/tasks.json", json.dumps(flu_tasks(locations=("US",))))
            s3.put("model-output/FluSight-baseline/2026-10-10-FluSight-baseline.parquet", forecast_parquet("FluSight-baseline", "2026-10-10"))
            oracle_v1 = '"as_of","target","target_end_date","location","horizon","output_type","output_type_id","oracle_value"\n' \
                        '2026-10-14,"wk inc flu hosp",2026-10-10,"US",0,"quantile",NA,1000\n'
            s3.put("target-data/oracle-output.csv", oracle_v1)

            loader = SandboxDataLoader(base, cache_dir=self.tmp / "cache")
            url = s3.url
            mgr = RemoteManager(
                loader.remote_store,
                known_locations=lambda: set(loader.get_locations()),
                is_non_negative=lambda t: True,
                local_as_of_max=lambda: None,
                on_inventory_change=lambda h, m: loader.invalidate_inventory(),
                client_factory=lambda b, cancel_event=None: _bind_fake(S3Client(b, cancel_event=cancel_event, retries=0), url),
            )
            mgr.start_sync("flusight", ["2026-2027"])
            deadline = time.time() + 15
            while time.time() < deadline and mgr.get_job("flusight")["status"] == "running":
                time.sleep(0.05)
            self.assertEqual(mgr.get_job("flusight")["status"], "done", mgr.get_job("flusight").get("error"))

            chk1 = mgr.check("flusight")["pending"]
            self.assertFalse(chk1["truth_changed"])

            # Upstream truth updates even without new forecast files
            oracle_v2 = oracle_v1 + '2026-10-21,"wk inc flu hosp",2026-10-17,"US",0,"quantile",NA,1150\n'
            s3.put("target-data/oracle-output.csv", oracle_v2)
            chk2 = mgr.check("flusight")["pending"]
            self.assertTrue(chk2["truth_changed"])
            self.assertEqual((chk2["new"], chk2["changed"], chk2["removed"]), (0, 0, 0))
        finally:
            s3.close()

    def test_fast_refresh_local_cache_only_rebuilds_changed_models(self):
        hub = _build_synthetic_hub(
            self.tmp / "refresh-hub",
            name="Refresh Hub",
            target="wk inc flu hosp",
            model_names=("ModelA", "ModelB"),
            truth_val=1000.0,
        )
        loader = SandboxDataLoader(hub, include_remote=False, cache_dir=self.tmp / "cache")
        loader.cache_mgr.warmup_cache(include_remote_models=False)
        stats1 = loader.cache_mgr.refresh_local_cache()
        self.assertEqual(stats1["rebuilt"], 0)

        # Modify ModelA only and verify only ModelA is rebuilt
        p_a = hub / "model-output" / "ModelA" / "2024-01-13-ModelA.csv"
        df_a = pl.read_csv(p_a).with_columns((pl.col("value") * 1.1).alias("value"))
        time.sleep(0.02)
        df_a.write_csv(p_a)
        stats2 = loader.cache_mgr.refresh_local_cache()
        self.assertEqual(stats2["models_total"], 2)
        self.assertEqual(stats2["rebuilt"], 1)

    def test_concise_hub_names_and_respicast_repo_url(self):
        hub_dir = self.tmp / "FluSight-sandbox-hub"
        _build_synthetic_hub(
            hub_dir,
            name="Reich Lab Forecasting Testbed for 2025-2026 and 2026-2027 seasons with extra notes",
            target="wk inc flu hosp",
            model_names=("M1",),
        )
        (hub_dir / "hub-config" / "admin.json").write_text(json.dumps({
            "name": "Reich Lab Forecasting Testbed for 2025-2026 and 2026-2027 seasons with extra notes",
            "repository": {"host": "github", "owner": "european-modelling-hubs", "name": "https://github.com/european-modelling-hubs/RespiCast-SyndromicIndicators"},
        }), encoding="utf-8")

        info = inspect_local_hub(hub_dir)
        self.assertEqual(info["name"], "RespiCast-SyndromicIndicators")
        self.assertIn("Testbed", info["description"])
        self.assertEqual(info["repo_url"], "https://github.com/european-modelling-hubs/RespiCast-SyndromicIndicators")

        short, desc = short_hub_name("A very long verbose sentence describing this forecasting repository hub", None, "flusight-hub")
        self.assertEqual(short, "flusight-hub")
        self.assertIn("verbose sentence", desc)

        reg = WorkspaceRegistry(self.tmp)
        rec1 = reg.add_hub(str(hub_dir), label="Reich Lab Forecasting Testbed for 2025-2026 and 2026-2027 seasons with extra notes")
        # Updating/re-adding with no custom label upgrades legacy verbose description label to concise name
        rec2 = reg.add_hub(str(hub_dir), activate=True)
        self.assertEqual(rec1.id, rec2.id)
        self.assertEqual(rec2.label, "RespiCast-SyndromicIndicators")


def _bind_fake(client, url):
    client.base_url = url
    return client


if __name__ == "__main__":
    unittest.main()
