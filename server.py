"""
Self-contained, multi-threaded HTTP server for the Sandbox Visualization and Evaluation Suite.
Built on Python standard library http.server + socketserver with zero external web framework dependencies.
"""

import errno
import http.server
import json
import logging
from pathlib import Path
import shutil
import socket
import socketserver
import sys
import threading
import urllib.parse
from typing import List, Optional, Any

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from viz.core.config import VizConfig
from viz.core.data_loader import SandboxDataLoader
from viz.core.evaluation import EvaluationEngine, EvaluationParams
from viz.core.synthetic_ensemble import SyntheticEnsembleConfig
from viz.remote.s3 import S3Error
from viz.remote.sync import RemoteManager, current_season


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("viz.server")

STATIC_DIR = Path(__file__).resolve().parent / "static"
DATA_LOADER = SandboxDataLoader(BASE_DIR)
VIZ_CONFIG = VizConfig(BASE_DIR)
EVAL_ENGINE = EvaluationEngine(BASE_DIR, DATA_LOADER)


def _local_as_of_max() -> Optional[str]:
    """Latest vintage in the bundled as-of surveillance file; hub snapshots are only fetched beyond it."""
    path = DATA_LOADER.cache_mgr.surveillance_dir / "as-of-hospital-admissions.parquet"
    if not path.exists():
        return None
    try:
        import polars as pl
        return pl.scan_parquet(path).select(pl.col("as_of").max()).collect().item()
    except Exception:
        return None


def _on_hub_inventory_change(hub_id: str, changed_models: List[str]):
    """Invalidate every in-memory cache that depends on the model inventory or truth, then pre-build tables."""
    DATA_LOADER.invalidate_inventory()
    DATA_LOADER.ensemble_mgr.clear_cached_forecasts()
    with EVAL_ENGINE._eval_cache_lock:
        EVAL_ENGINE._eval_cache.clear()
    cache = DATA_LOADER.cache_mgr
    if not DATA_LOADER.remote_store.has_data(hub_id):
        shutil.rmtree(cache.hub_models_cache_dir / hub_id, ignore_errors=True)
    for name in changed_models:
        cache.get_model_parquet(f"{hub_id}:{name}")
        cache.get_model_peak_parquet(f"{hub_id}:{name}")
    cache.get_oracle_parquet()
    cache.get_admissions_parquet()
    cache.get_as_of_admissions_parquet()
    DATA_LOADER.scan_models(force_refresh=True)


REMOTE_MGR = RemoteManager(
    DATA_LOADER.remote_store,
    known_locations=lambda: set(DATA_LOADER.get_locations().keys()),
    is_non_negative=VIZ_CONFIG.is_target_non_negative,
    local_as_of_max=_local_as_of_max,
    on_inventory_change=_on_hub_inventory_change,
)


class SandboxRequestHandler(http.server.SimpleHTTPRequestHandler):
    """Custom request handler with REST API routing and static file delivery."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def end_headers(self):
        server_cfg = VIZ_CONFIG.get_server_config()
        allowed = server_cfg.get("allowed_origins", ["*"])
        origin = self.headers.get("Origin")
        if "*" in allowed:
            self.send_header("Access-Control-Allow-Origin", "*")
        elif origin:
            origin_clean = origin.rstrip("/")
            is_match = False
            for a in allowed:
                a_clean = a.rstrip("/")
                if origin_clean == a_clean or a_clean == "*":
                    is_match = True
                    break
                if ("localhost" in a_clean or "127.0.0.1" in a_clean) and (
                    origin_clean.startswith("http://localhost:") or origin_clean.startswith("http://127.0.0.1:")
                ):
                    is_match = True
                    break
            if is_match:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        try:
            self._route_get()
        except Exception as exc:
            logger.exception("Internal error processing GET %s: %s", self.path, exc)
            self._send_json({"error": "Internal server error", "detail": "An internal error occurred while processing the request."}, status=500)

    def do_POST(self):
        try:
            self._route_post()
        except Exception as exc:
            logger.exception("Internal error processing POST %s: %s", self.path, exc)
            self._send_json({"error": "Internal server error", "detail": "An internal error occurred while processing the POST request."}, status=500)

    def _read_json_body(self) -> dict:
        """Safely parse JSON request body."""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length <= 0:
                return {}
            body_bytes = self.rfile.read(content_length)
            return json.loads(body_bytes.decode("utf-8"))
        except Exception as exc:
            logger.warning("Failed to parse JSON body: %s", exc)
            return {}

    def _route_post(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        # Requiring a JSON content type forces a CORS preflight, so other sites open in the
        # browser cannot submit state-changing requests to this local server
        if path.startswith(("/api/ensemble/", "/api/remote/")) and not self.headers.get("Content-Type", "").startswith("application/json"):
            self._send_json({"error": "This endpoint requires 'Content-Type: application/json'"}, status=415)
            return
        if path.startswith("/api/remote/"):
            self._route_remote_post(path)
            return
        if path == "/api/cache/refresh":
            self._handle_cache_refresh()
        elif path == "/api/cache/clear":
            self._handle_cache_refresh(clear=True)
        elif path == "/api/ensemble/preview":
            self._handle_ensemble_preview()
        elif path == "/api/ensemble/create":
            self._handle_ensemble_create()
        elif path == "/api/ensemble/save":
            self._handle_ensemble_save()
        elif path in ("/api/ensemble/delete", "/api/ensemble/remove"):
            self._handle_ensemble_delete()
        else:
            self._send_json({"error": f"POST endpoint '{path}' not found"}, status=404)

    def _route_get(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # API Routes
        if path == "/api/metadata":
            self._handle_metadata()
        elif path in ("/api/ensemble/list", "/api/ensembles"):
            self._handle_ensemble_list()
        elif path == "/api/forecast":
            self._handle_forecast(query)
        elif path == "/api/metrics":
            self._handle_metrics(query)
        elif path == "/api/spatial":
            self._handle_spatial(query)
        elif path == "/api/heatmap":
            self._handle_heatmap(query)
        elif path == "/api/status":
            self._handle_status()
        elif path in ("/api/model-details", "/api/model_details", "/api/model_detail"):
            self._handle_model_details(query)
        elif path == "/api/surveillance":
            self._handle_surveillance(query)
        elif path == "/api/season-curves":
            self._handle_season_curves(query)
        elif path == "/api/peaks":
            self._handle_peaks(query)
        elif path == "/api/peak-map":
            self._handle_peak_map(query)
        elif path == "/api/remote/hubs":
            self._send_json({"hubs": REMOTE_MGR.list_hubs(), "busy": REMOTE_MGR.is_busy(), "current_season": current_season()})
        elif path == "/api/remote/job":
            hub_id = query.get("hub", [""])[0]
            self._send_json({"job": REMOTE_MGR.get_job(hub_id), "hub": next((h for h in REMOTE_MGR.list_hubs() if h["id"] == hub_id), None)})
        elif path == "/api/remote/warnings":
            hub_id = query.get("hub", [""])[0]
            if DATA_LOADER.remote_store.get_spec(hub_id) is None:
                self._send_json({"error": f"Unknown hub '{hub_id}'"}, status=404)
            else:
                self._send_json({"hub": hub_id, "warnings": REMOTE_MGR.warnings(hub_id)})
        elif path in ("/api/cache/refresh", "/api/cache/clear"):
            self._send_json(
                {"error": "Method Not Allowed", "detail": "Cache refresh and clear operations must use HTTP POST."},
                status=405,
            )
        elif path == "/" or not path or path == "/index.html":
            self._serve_file(STATIC_DIR / "index.html", "text/html")
        else:
            # Fall back to static files in STATIC_DIR
            super().do_GET()

    def _send_json(self, data: Any, status: int = 200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_file(self, file_path: Path, content_type: str):
        if not file_path.exists():
            self.send_error(404, "File not found")
            return
        with open(file_path, "rb") as f:
            content = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _handle_status(self):
        models = DATA_LOADER.scan_models()
        warnings = DATA_LOADER.get_validation_warnings()
        self._send_json({
            "status": "ok",
            "hub": BASE_DIR.name,
            "models_count": len(models),
            "production_models": [m for m, v in models.items() if not v["is_local"] and v.get("source") != "hub"],
            "local_test_models": [m for m, v in models.items() if v["is_local"]],
            "hub_models": [m for m, v in models.items() if v.get("source") == "hub"],
            "validation_warnings": warnings,
        })

    def _handle_cache_refresh(self, clear: bool = False):
        if clear:
            DATA_LOADER.cache_mgr.clear_cache()
        DATA_LOADER.ensemble_mgr.clear_cached_forecasts()
        with EVAL_ENGINE._eval_cache_lock:
            EVAL_ENGINE._eval_cache.clear()
        count = DATA_LOADER.cache_mgr.warmup_cache()
        self._send_json({
            "status": "ok",
            "message": "Parquet cache successfully cleared and rebuilt" if clear else "Parquet cache successfully refreshed",
            "models_cached": count,
        })

    def _handle_model_details(self, query: dict):
        model_id = query.get("model", query.get("model_id", [""]))[0].strip()
        if not model_id:
            self._send_json({"error": "Missing 'model' or 'model_id' parameter"}, status=400)
            return

        details = DATA_LOADER.get_model_details(model_id)
        if details is None:
            self._send_json({"error": f"Model '{model_id}' not found"}, status=404)
            return

        self._send_json(details)

    def _handle_metadata(self):
        models = DATA_LOADER.scan_models()
        locations = DATA_LOADER.get_locations()

        # Model forecast dates
        model_dates_set = set()
        for m_info in models.values():
            model_dates_set.update(m_info.get("dates", []))

        # Official Hub round dates
        hub_seasons = DATA_LOADER.get_hub_seasons()
        hub_dates_set = set()
        for h_dates in hub_seasons.values():
            hub_dates_set.update(h_dates)

        # Historical surveillance dates
        adm_df = DATA_LOADER.get_admissions_ground_truth(as_polars=True)
        surv_dates_set = set()
        if adm_df is not None and not adm_df.is_empty():
            surv_dates_set.update(adm_df["target_end_date"].to_list())

        all_dates_set = model_dates_set | hub_dates_set | surv_dates_set
        sorted_dates = sorted(list(all_dates_set), reverse=True)

        # Build date_info map for UI date picker with fast O(1) set membership
        model_dates_sets = {m: set(m_info.get("dates", [])) for m, m_info in models.items()}
        date_info = {}
        for d in sorted_dates:
            s = DATA_LOADER.get_flu_season_for_date(d)
            m_count = sum(1 for m_set in model_dates_sets.values() if d in m_set)
            date_info[d] = {
                "date": d,
                "season": s,
                "model_count": m_count,
                "has_models": m_count > 0,
                "is_hub_round": d in hub_dates_set,
                "has_truth": d in surv_dates_set,
            }

        # Dynamic recommended models and targets from config / hub
        recommended = VIZ_CONFIG.get_recommended_models([m for m, v in models.items() if v.get("source") != "hub"])
        # Season peak targets are not selectable weekly targets; they are offered through `peak_targets`
        targets = VIZ_CONFIG.get_weekly_targets()
        peak_targets = {}
        for t in targets:
            companions = DATA_LOADER.peaks.targets(t)
            if companions and DATA_LOADER.peaks.is_available(t):
                peak_targets[t] = companions

        sorted_seasons = DATA_LOADER.get_all_seasons()
        forecast_seasons = DATA_LOADER.get_forecast_seasons()
        season_summaries = DATA_LOADER.get_season_summaries()
        sorted_families = DATA_LOADER.get_all_families()
        latest_date = DATA_LOADER.get_latest_reference_date()
        latest_season = DATA_LOADER.get_latest_season()
        targets_meta = {t: VIZ_CONFIG.get_target_metadata(t) for t in targets}
        for companions in peak_targets.values():
            for t in companions.values():
                targets_meta[t] = {**VIZ_CONFIG.get_target_metadata(t), "is_peak": True}

        self._send_json({
            "models": models,
            "recommended_models": recommended,
            "locations": list(locations.values()),
            "dates": sorted_dates,
            "forecast_dates": sorted(list(model_dates_set), reverse=True),
            "date_info": date_info,
            "seasons": sorted_seasons,
            "forecast_seasons": forecast_seasons,
            "season_summaries": season_summaries,
            "families": sorted_families,
            "targets": targets,
            "targets_meta": targets_meta,
            "peak_targets": peak_targets,
            "latest_date": latest_date,
            "latest_season": latest_season,
            "default_target": VIZ_CONFIG.get_default_target(),
            "default_baseline": VIZ_CONFIG.get_default_baseline(
                [m for m, v in models.items() if v.get("source") != "hub"] or list(models.keys())
            ),
            "remote_hubs": [
                {k: h.get(k) for k in ("id", "label", "short_label", "synced", "enabled", "latest_round",
                                       "latest_round_models", "last_sync", "models", "pending", "peak_outdated")}
                for h in REMOTE_MGR.list_hubs()
            ],
            "truth_info": DATA_LOADER.get_truth_info(),
        })


    def _handle_forecast(self, query: dict):
        target = query.get("target", [VIZ_CONFIG.get_default_target()])[0]
        location = query.get("location", ["US"])[0]
        ref_date = query.get("date", [""])[0]
        models_param = query.get("models", [""])[0]
        model_ids = [m.strip() for m in models_param.split(",") if m.strip()]

        if not ref_date:
            self._send_json({"error": "Missing 'date' parameter"}, status=400)
            return

        truth = DATA_LOADER.get_ground_truth_series(target, location, ref_date)
        surveillance = DATA_LOADER.get_surveillance_streams(target, location, ref_date)

        model_results = []
        for mid in model_ids:
            fan_data = DATA_LOADER.get_model_fan_data(mid, target, location, ref_date)
            if fan_data:
                model_results.append(fan_data)

        # Season peak markers for the same round (only for targets with peak companions)
        peaks = None
        if location not in ("states", "all"):
            try:
                peaks = DATA_LOADER.peaks.round_overlay(target, location, ref_date, model_ids)
            except Exception as exc:
                logger.warning("Peak overlay failed: %s", exc)

        self._send_json({
            "target": target,
            "location": location,
            "reference_date": ref_date,
            "truth": truth,
            "surveillance": surveillance,
            "models": model_results,
            "peaks": peaks,
        })

    def _handle_peaks(self, query: dict):
        """Season Peak view: one round's peak forecasts, their evolution over the season, and peak skill."""
        target = query.get("target", [VIZ_CONFIG.get_default_target()])[0]
        location = query.get("location", ["US"])[0] or "US"
        if location in ("states", "all"):
            location = "US"
        ref_date = query.get("date", [""])[0]
        models_param = query.get("models", [""])[0]
        model_ids = [m.strip() for m in models_param.split(",") if m.strip()]
        scope = query.get("skill_scope", ["location"])[0]
        common = query.get("common", ["0"])[0].lower() in ("1", "true", "yes")
        if not ref_date:
            self._send_json({"error": "Missing 'date' parameter"}, status=400)
            return
        if scope not in ("location", "states"):
            self._send_json({"error": "skill_scope must be 'location' or 'states'"}, status=400)
            return
        self._send_json(DATA_LOADER.peaks.season_view(target, location, ref_date, model_ids, scope, common))

    def _handle_peak_map(self, query: dict):
        target = query.get("target", [VIZ_CONFIG.get_default_target()])[0]
        ref_date = query.get("date", [""])[0]
        model_id = query.get("model", [""])[0].strip()
        if not ref_date or not model_id:
            self._send_json({"error": "Missing 'date' or 'model' parameter"}, status=400)
            return
        self._send_json(DATA_LOADER.peaks.map_layer(target, ref_date, model_id))

    def _handle_surveillance(self, query: dict):
        target = query.get("target", [VIZ_CONFIG.get_default_target()])[0]
        location = query.get("location", ["US"])[0]
        models = DATA_LOADER.scan_models()
        dates = [m.get("max_date") for m in models.values() if m.get("max_date")]
        fallback_date = max(dates) if dates else "2024-01-13"
        ref_date = query.get("date", [fallback_date])[0]
        surv = DATA_LOADER.get_surveillance_streams(target, location, ref_date)
        self._send_json(surv)

    def _handle_spatial(self, query: dict):
        target = query.get("target", [VIZ_CONFIG.get_default_target()])[0]
        ref_date = query.get("date", [""])[0]
        models_param = query.get("models", [""])[0]
        horizon_param = query.get("horizon", ["all"])[0]

        model_ids = [m.strip() for m in models_param.split(",") if m.strip()]
        if not model_ids:
            model_ids = list(DATA_LOADER.scan_models().keys())

        if not ref_date:
            self._send_json({"error": "Missing 'date' parameter"}, status=400)
            return

        spatial_data = DATA_LOADER.get_spatial_data(target, ref_date, model_ids, horizon=horizon_param)
        self._send_json(spatial_data)

    def _handle_heatmap(self, query: dict):
        mode = query.get("mode", [""])[0].strip() or None
        rows = query.get("rows", [""])[0].strip() or None
        cols = query.get("cols", [""])[0].strip() or None
        location = query.get("location", query.get("loc", ["states"]))[0].strip() or "states"
        target = query.get("target", [VIZ_CONFIG.get_default_target()])[0].strip()
        metric = query.get("metric", ["rate"])[0].strip()
        ref_date = query.get("date", [""])[0].strip() or None
        season = query.get("season", [""])[0].strip() or None
        horizon = query.get("horizon", ["1"])[0].strip()
        model_id = query.get("model", [""])[0].strip() or None
        models_param = query.get("models", [""])[0].strip()
        sort_by = query.get("sort_by", ["hhs_region"])[0].strip()
        normalize = query.get("normalize", ["none"])[0].strip()
        include_inactive_param = query.get("include_inactive", ["0"])[0].strip().lower()
        include_inactive = include_inactive_param in ("1", "true", "yes")

        model_ids = [m.strip() for m in models_param.split(",") if m.strip()] if models_param else None

        try:
            heatmap_data = DATA_LOADER.get_heatmap_data(
                mode=mode,
                rows=rows,
                cols=cols,
                target=target,
                metric=metric,
                location=location,
                reference_date=ref_date,
                season=season,
                horizon=horizon,
                model_id=model_id,
                model_ids=model_ids,
                sort_by=sort_by,
                normalize=normalize,
                include_inactive=include_inactive,
            )
            self._send_json(heatmap_data)
        except Exception as exc:
            logger.exception("Heatmap API generation error: %s", exc)
            self._send_json({"error": str(exc)}, status=500)

    def _handle_season_curves(self, query: dict):
        """Truth curves per season for one location, aligned by season week, with peak/pre/post phases."""
        target = query.get("target", [VIZ_CONFIG.get_default_target()])[0]
        location = query.get("location", ["US"])[0] or "US"
        if location in ("states", "all"):
            location = "US"
        seasons_param = query.get("seasons", [""])[0]
        seasons = [s.strip() for s in seasons_param.split(",") if s.strip()] or DATA_LOADER.get_forecast_seasons()
        self._send_json(DATA_LOADER.get_season_curves(target, location, seasons))

    def _handle_metrics(self, query: dict):
        target = query.get("target", [VIZ_CONFIG.get_default_target()])[0]
        loc_param = query.get("location", ["all"])[0]
        date_param = query.get("date", ["all"])[0]
        season_param = query.get("season", [""])[0].strip()
        models_param = query.get("models", [""])[0]
        baseline_param = query.get("baseline", [""])[0].strip()
        fair_flag = query.get("fair", ["false"])[0].lower() in ["true", "1", "yes"]
        weeks_param = query.get("weeks", [""])[0].strip() or None
        phase_param = query.get("phase", [""])[0].strip() or None

        model_ids = [m.strip() for m in models_param.split(",") if m.strip()] if models_param else None

        params = EvaluationParams(
            target=target,
            location=loc_param,
            date=date_param,
            season=season_param,
            models=model_ids,
            baseline=baseline_param if baseline_param else None,
            fair=fair_flag,
            weeks=weeks_param,
            phase=phase_param,
        )

        try:
            result = EVAL_ENGINE.evaluate(params)
            self._send_json(result.to_dict())
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=400)
        except Exception as exc:
            logger.warning("Metrics evaluation error: %s", exc)
            self._send_json({"error": str(exc)}, status=500)

    def _route_remote_post(self, path: str):
        """Hub sync endpoints. Only these (user-initiated) calls ever reach the network."""
        body = self._read_json_body()
        hub_id = str(body.get("hub", "")).strip()
        try:
            if path == "/api/remote/add":
                result = REMOTE_MGR.add_hub(str(body.get("bucket", "")), body.get("label"))
                self._send_json(result, status=200 if result.get("ok") else 422)
            elif path == "/api/remote/check":
                self._send_json(REMOTE_MGR.check(hub_id))
            elif path == "/api/remote/sync":
                seasons = body.get("seasons")
                seasons = [str(x) for x in seasons] if isinstance(seasons, list) else None
                self._send_json({"job": REMOTE_MGR.start_sync(hub_id, seasons)})
            elif path == "/api/remote/cancel":
                self._send_json({"cancelled": REMOTE_MGR.cancel(hub_id)})
            elif path == "/api/remote/remove":
                REMOTE_MGR.remove(hub_id)
                self._send_json({"status": "ok", "removed": hub_id})
            elif path == "/api/remote/toggle":
                REMOTE_MGR.set_enabled(hub_id, bool(body.get("enabled", True)))
                self._send_json({"status": "ok", "hub": hub_id, "enabled": bool(body.get("enabled", True))})
            else:
                self._send_json({"error": f"POST endpoint '{path}' not found"}, status=404)
        except KeyError as exc:
            self._send_json({"error": str(exc).strip("'")}, status=404)
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=400)
        except RuntimeError as exc:
            self._send_json({"error": str(exc)}, status=409)
        except S3Error as exc:
            self._send_json({"error": str(exc)}, status=502)

    def _handle_ensemble_list(self):
        """List all registered session and persisted synthetic ensembles."""
        ensembles = DATA_LOADER.ensemble_mgr.list_ensembles()
        self._send_json({"status": "ok", "ensembles": ensembles})

    def _handle_ensemble_preview(self):
        """Compute pre-flight task overlap and date alignment for candidate ensemble."""
        body = self._read_json_body()
        try:
            cfg = SyntheticEnsembleConfig.from_dict(body)
            preview = DATA_LOADER.ensemble_mgr.preview_ensemble(cfg)
            self._send_json(preview)
        except Exception as exc:
            logger.exception("Error during ensemble preview: %s", exc)
            self._send_json({"valid": False, "error": str(exc)}, status=400)

    def _handle_ensemble_create(self):
        """Register a new session synthetic ensemble."""
        body = self._read_json_body()
        name = str(body.get("name", "")).strip()
        if not name:
            self._send_json({"error": "Ensemble name cannot be empty"}, status=400)
            return

        method = str(body.get("method", "median")).lower()
        if method not in ("median", "mean"):
            self._send_json({"error": f"Invalid method '{method}'. Must be 'median' or 'mean'."}, status=400)
            return

        spatial_split = bool(body.get("spatial_split", False))
        missing_policy = str(body.get("missing_policy", "flexible")).lower()
        if missing_policy not in ("flexible", "strict"):
            missing_policy = "flexible"

        if spatial_split:
            state_models = [str(m).strip() for m in body.get("state_models", []) if str(m).strip()]
            national_models = [str(m).strip() for m in body.get("national_models", []) if str(m).strip()]
            if not state_models or not national_models:
                self._send_json({"error": "Spatial split requires at least one state model and one national model."}, status=400)
                return
            models = sorted(list(set(state_models + national_models)))
        else:
            models = [str(m).strip() for m in body.get("models", []) if str(m).strip()]
            if len(models) < 2:
                self._send_json({"error": "An ensemble requires at least 2 constituent models."}, status=400)
                return
            state_models = []
            national_models = []

        cfg = SyntheticEnsembleConfig(
            id=str(body.get("id", "")).strip(),
            name=name,
            method=method,
            models=models,
            spatial_split=spatial_split,
            state_models=state_models,
            national_models=national_models,
            missing_policy=missing_policy,
            description=str(body.get("description", "")).strip(),
        )

        try:
            registered = DATA_LOADER.register_synthetic_ensemble(cfg)
            with EVAL_ENGINE._eval_cache_lock:
                EVAL_ENGINE._eval_cache.clear()

            if body.get("save_to_disk"):
                DATA_LOADER.save_synthetic_ensemble(registered.id)

            self._send_json({
                "status": "ok",
                "ensemble": registered.to_dict(),
            })
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=400)
        except Exception as exc:
            logger.exception("Error creating synthetic ensemble: %s", exc)
            self._send_json({"error": str(exc)}, status=500)

    def _handle_ensemble_save(self):
        """Persist a registered synthetic ensemble to local-output/synthetic/<id>/."""
        body = self._read_json_body()
        ensemble_id = str(body.get("ensemble_id", "")).strip()
        if not ensemble_id:
            self._send_json({"error": "Missing 'ensemble_id' parameter"}, status=400)
            return

        try:
            res = DATA_LOADER.save_synthetic_ensemble(ensemble_id)
            with EVAL_ENGINE._eval_cache_lock:
                EVAL_ENGINE._eval_cache.clear()
            self._send_json(res)
        except Exception as exc:
            logger.exception("Error persisting synthetic ensemble: %s", exc)
            self._send_json({"error": str(exc)}, status=500)

    def _handle_ensemble_delete(self):
        """Remove a synthetic ensemble from active registry and disk."""
        body = self._read_json_body()
        ensemble_id = str(body.get("ensemble_id", "")).strip()
        if not ensemble_id:
            self._send_json({"error": "Missing 'ensemble_id' parameter"}, status=400)
            return

        try:
            removed = DATA_LOADER.remove_synthetic_ensemble(ensemble_id)
            with EVAL_ENGINE._eval_cache_lock:
                EVAL_ENGINE._eval_cache.clear()
            if removed:
                self._send_json({"status": "ok", "ensemble_id": ensemble_id})
            else:
                self._send_json({"error": f"Ensemble '{ensemble_id}' not found"}, status=404)
        except Exception as exc:
            logger.exception("Error deleting synthetic ensemble: %s", exc)
            self._send_json({"error": str(exc)}, status=500)



def _port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def _next_free_port(host: str, start: int) -> Optional[int]:
    for candidate in range(start, min(start + 100, 65536)):
        if _port_is_free(host, candidate):
            return candidate
    return None


def run_server(port: Optional[int] = None, host: Optional[str] = None):
    """Launch the threaded HTTP server with transparent cache warmup."""
    # SO_REUSEADDR lets a restart reuse a port stuck in TIME_WAIT on macOS/Linux. On Windows it
    # would instead let a second server bind a port that is already in use, so it stays off there.
    socketserver.ThreadingTCPServer.allow_reuse_address = sys.platform != "win32"

    server_cfg = VIZ_CONFIG.get_server_config()
    final_port = port if port is not None else server_cfg["port"]
    final_host = host if host is not None else server_cfg["host"]

    try:
        httpd = socketserver.ThreadingTCPServer((final_host, final_port), SandboxRequestHandler)
    except OSError as exc:
        if exc.errno not in (errno.EADDRINUSE, 10048):  # 10048 = WSAEADDRINUSE
            raise
        suggestion = _next_free_port(final_host, final_port + 1)
        launcher = "viz\\run.bat" if sys.platform == "win32" else "./viz/run.sh"
        sys.stderr.write(
            f"\nERROR: port {final_port} on {final_host} is already in use, probably by another viz server.\n"
            f"Nothing was started. Anything answering at http://{final_host}:{final_port} is that other server,\n"
            f"not this hub ({BASE_DIR}).\n"
        )
        if suggestion:
            sys.stderr.write(f"Start on a free port instead:  {launcher} {suggestion}\n\n")
        sys.exit(1)

    # Warm up Parquet cache in background thread
    def _warmup_background():
        try:
            DATA_LOADER.cache_mgr.warmup_cache()
        except Exception as exc:
            logger.warning("Background cache warmup error: %s", exc)

    threading.Thread(target=_warmup_background, daemon=True).start()

    with httpd:
        print(f"\n========================================================")
        print(f"  Sandbox Visualization & Evaluation Server Online")
        print(f"  URL: http://{final_host}:{final_port}")
        print(f"  Hub: {BASE_DIR}")
        print(f"  Engine: Polars (Vectorized SIMD) + Parquet Acceleration")
        print(f"  Serving: {STATIC_DIR}")
        print(f"  Press Ctrl+C to terminate.")
        print(f"========================================================\n", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            httpd.server_close()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Forecast Sandbox Visualizer & Evaluator")
    parser.add_argument("--port", type=int, default=None, help="Port to bind (default from config or 8501)")
    parser.add_argument("--host", type=str, default=None, help="Host interface (default: 127.0.0.1)")
    args = parser.parse_args()
    run_server(port=args.port, host=args.host)
