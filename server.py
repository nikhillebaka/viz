"""
Self-contained, multi-threaded HTTP server for the Sandbox Visualization and Evaluation Suite.
Built on Python standard library http.server + socketserver with zero external web framework dependencies.
"""

import errno
import gzip
import hashlib
import http.server
import json
import logging
import mimetypes
import os
from pathlib import Path
import socket
import socketserver
import sys
import threading
import urllib.parse
from typing import Any, Dict, List, Optional

import _bootstrap

APP_DIR = _bootstrap.ensure_viz_package()

from viz.core.config import VizConfig
from viz.core.paths import is_hub_dir
from viz.core.synthetic_ensemble import SyntheticEnsembleConfig
from viz.core.workspace import HubContext, HubManager
from viz.remote.s3 import S3Error
from viz.remote.sync import current_season
from viz.remote.transports import TransportError


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("viz.server")

STATIC_DIR = APP_DIR / "static"
NEXT_DIR = APP_DIR / "next"  # the new frontend, served beside classic at /next/
_FALLBACK_SERVER_CFG = VizConfig(APP_DIR, app_dir=APP_DIR).get_server_config()
MAX_JSON_BODY_BYTES = 1 * 1024 * 1024  # 1 MB cap on POST JSON payloads

HUB_MANAGER: Optional[HubManager] = None


class _BodyTooLargeError(Exception):
    """Raised when an incoming HTTP body exceeds MAX_JSON_BODY_BYTES."""


def _build_default_hub_manager() -> HubManager:
    mode = os.environ.get("VIZ_MODE", "local").strip().lower() or "local"
    data_dir_env = os.environ.get("VIZ_DATA_DIR", "").strip()
    data_dir = Path(data_dir_env).expanduser().resolve() if data_dir_env else None
    env_hub = os.environ.get("VIZ_HUB_DIR", "").strip()
    if env_hub:
        hub_path = Path(env_hub).expanduser()
        if is_hub_dir(hub_path):
            return HubManager(data_dir=data_dir, mode=mode, cli_hubs=[hub_path], include_enclosing=False)
        logger.warning("VIZ_HUB_DIR='%s' is not a valid hub directory; starting without it.", env_hub)
        return HubManager(data_dir=data_dir, mode=mode, cli_hubs=None, include_enclosing=False)
    return HubManager(data_dir=data_dir, mode=mode, cli_hubs=None, include_enclosing=True)


def init_hub_manager(
    data_dir: Optional[Path] = None,
    mode: Optional[str] = None,
    cli_hubs: Optional[List[Path]] = None,
    include_enclosing: bool = True,
) -> HubManager:
    global HUB_MANAGER
    resolved_mode = (mode or os.environ.get("VIZ_MODE", "local")).strip().lower() or "local"
    if data_dir is None:
        env_data = os.environ.get("VIZ_DATA_DIR", "").strip()
        if env_data:
            data_dir = Path(env_data).expanduser().resolve()
    HUB_MANAGER = HubManager(
        data_dir=data_dir,
        mode=resolved_mode,
        cli_hubs=cli_hubs,
        include_enclosing=include_enclosing,
    )
    SandboxRequestHandler.hub_manager = HUB_MANAGER
    return HUB_MANAGER


HUB_MANAGER = _build_default_hub_manager()


class SandboxRequestHandler(http.server.SimpleHTTPRequestHandler):
    """Custom request handler with multi-hub REST API routing and static file delivery."""

    hub_manager: Optional[HubManager] = HUB_MANAGER

    def __init__(self, *args, **kwargs):
        self._cache_control_override: Optional[str] = None
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def setup(self):
        try:
            self.request.settimeout(30.0)
        except Exception:
            pass
        super().setup()

    def _mgr(self) -> HubManager:
        mgr = self.hub_manager or HUB_MANAGER
        if mgr is None:
            mgr = init_hub_manager()
        return mgr

    def _server_config(self) -> dict:
        try:
            cfg = self._mgr().get_server_config()
            if cfg is not None:
                return cfg
        except Exception:
            pass
        return _FALLBACK_SERVER_CFG

    def end_headers(self):
        server_cfg = self._server_config()
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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Viz-Hub")
        cc = self._cache_control_override or "no-cache, no-store, must-revalidate"
        self._cache_control_override = None
        self.send_header("Cache-Control", cc)
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        try:
            self._route_get()
        except Exception as exc:
            logger.exception("Internal error processing GET %s: %s", self.path, exc)
            self._send_json(
                {"error": "Internal server error", "detail": "An internal error occurred while processing the request."},
                status=500,
            )

    def do_POST(self):
        try:
            self._route_post()
        except _BodyTooLargeError as exc:
            self._send_json({"error": str(exc)}, status=413)
        except Exception as exc:
            logger.exception("Internal error processing POST %s: %s", self.path, exc)
            self._send_json(
                {"error": "Internal server error", "detail": "An internal error occurred while processing the POST request."},
                status=500,
            )

    def _require_local_mutation(self, action: str) -> bool:
        """Gate persistent/server-mutating endpoints to local mode unless an authenticated session allows them."""
        if self._mgr().mode != "local":
            self._send_json({"error": f"{action} is disabled in web mode"}, status=403)
            return False
        return True

    def _requested_hub_id(self, query: dict, allow_hub_param: bool = True) -> Optional[str]:
        ws = query.get("workspace", [""])[0].strip()
        if ws:
            return ws
        hdr = (self.headers.get("X-Viz-Hub") or "").strip()
        if hdr:
            return hdr
        if allow_hub_param:
            h = query.get("hub", [""])[0].strip()
            if h:
                return h
        return None

    def _require_ctx(self, query: dict, allow_hub_param: bool = True) -> Optional[HubContext]:
        mgr = self._mgr()
        req_id = self._requested_hub_id(query, allow_hub_param=allow_hub_param)
        ctx = mgr.get_context(req_id)
        if ctx is None:
            msg = f"Unknown workspace hub '{req_id}'" if req_id else "No hub configured"
            self._send_json({"error": msg}, status=404)
            return None
        return ctx

    def _read_json_body(self) -> dict:
        """Safely parse JSON request body with strict byte-size cap."""
        raw_len = self.headers.get("Content-Length", "0")
        try:
            content_length = int(raw_len)
        except ValueError:
            return {}
        if content_length <= 0:
            return {}
        if content_length > MAX_JSON_BODY_BYTES:
            # Drain modest over-limit bodies in small chunks so HTTP clients receive the 413 cleanly
            # rather than hitting a TCP RST; drop huge bodies immediately with Connection: close.
            self.close_connection = True
            if content_length <= 4 * MAX_JSON_BODY_BYTES:
                remaining = content_length
                while remaining > 0:
                    chunk = self.rfile.read(min(remaining, 65536))
                    if not chunk:
                        break
                    remaining -= len(chunk)
            raise _BodyTooLargeError(
                f"Request body too large ({content_length} bytes; limit is {MAX_JSON_BODY_BYTES} bytes)"
            )
        try:
            body_bytes = self.rfile.read(content_length)
            return json.loads(body_bytes.decode("utf-8"))
        except Exception as exc:
            logger.warning("Failed to parse JSON body: %s", exc)
            return {}

    def _route_post(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        # Requiring a JSON content type forces a CORS preflight, so other sites open in the
        # browser cannot submit state-changing requests to this local server
        if path.startswith(("/api/ensemble/", "/api/remote/", "/api/workspace/", "/api/cache/")) and not self.headers.get("Content-Type", "").startswith("application/json"):
            self._send_json({"error": "This endpoint requires 'Content-Type: application/json'"}, status=415)
            return
        if path.startswith("/api/workspace/"):
            self._route_workspace_post(path)
            return
        if path.startswith("/api/remote/"):
            if not self._require_local_mutation("Remote hub actions"):
                return
            mgr = self._mgr()
            req_id = self._requested_hub_id(query, allow_hub_param=False)
            ctx = mgr.get_context(req_id)
            if req_id and ctx is None:
                self._send_json({"error": f"Unknown workspace hub '{req_id}'"}, status=404)
                return
            remote_mgr = ctx.remote_mgr if ctx is not None else mgr.shared_remote_mgr
            self._route_remote_post(remote_mgr, path)
            return
        if path == "/api/cache/refresh":
            if not self._require_local_mutation("Cache refresh"):
                return
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_cache_refresh(ctx)
        elif path == "/api/cache/clear":
            if not self._require_local_mutation("Cache clear"):
                return
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_cache_refresh(ctx, clear=True)
        elif path == "/api/ensemble/preview":
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_ensemble_preview(ctx)
        elif path == "/api/ensemble/create":
            if not self._require_local_mutation("Synthetic ensemble creation"):
                return
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_ensemble_create(ctx)
        elif path == "/api/ensemble/save":
            if not self._require_local_mutation("Saving synthetic ensembles"):
                return
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_ensemble_save(ctx)
        elif path in ("/api/ensemble/delete", "/api/ensemble/remove"):
            if not self._require_local_mutation("Deleting synthetic ensembles"):
                return
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_ensemble_delete(ctx)
        else:
            self._send_json({"error": f"POST endpoint '{path}' not found"}, status=404)

    def _route_get(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        mgr = self._mgr()

        # Static frontends
        if path == "/next" or path.startswith("/next/"):
            self._serve_dir(path, "/next", NEXT_DIR)
        elif path == "/classic" or path.startswith("/classic/"):
            self._serve_dir(path, "/classic", STATIC_DIR)
        # Workspace endpoints
        elif path == "/api/workspace":
            self._send_json(mgr.workspace_summary(requested_hub_id=self._requested_hub_id(query)))
        elif path == "/api/workspace/browse":
            if mgr.mode != "local":
                self._send_json({"error": "Local workspace browsing is disabled in web mode"}, status=403)
                return
            try:
                self._send_json(mgr.browse_directory(query.get("path", [""])[0]))
            except FileNotFoundError as exc:
                self._send_json({"error": str(exc)}, status=404)
            except PermissionError as exc:
                self._send_json({"error": str(exc)}, status=403)
            except ValueError as exc:
                self._send_json({"error": str(exc)}, status=400)
        # Next & core API routes
        elif path.startswith("/api/next/"):
            self._handle_next_api(path, query)
        elif path == "/api/status":
            self._handle_status(query)
        elif path == "/api/metadata":
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_metadata(ctx)
        elif path in ("/api/ensemble/list", "/api/ensembles"):
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_ensemble_list(ctx)
        elif path == "/api/forecast":
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_forecast(ctx, query)
        elif path == "/api/metrics":
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_metrics(ctx, query)
        elif path == "/api/spatial":
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_spatial(ctx, query)
        elif path == "/api/heatmap":
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_heatmap(ctx, query)
        elif path in ("/api/model-details", "/api/model_details", "/api/model_detail"):
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_model_details(ctx, query)
        elif path == "/api/surveillance":
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_surveillance(ctx, query)
        elif path == "/api/season-curves":
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_season_curves(ctx, query)
        elif path == "/api/peaks":
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_peaks(ctx, query)
        elif path == "/api/peak-map":
            ctx = self._require_ctx(query)
            if ctx is not None:
                self._handle_peak_map(ctx, query)
        elif path == "/api/remote/hubs":
            mgr = self._mgr()
            req_id = self._requested_hub_id(query, allow_hub_param=False)
            ctx = mgr.get_context(req_id)
            if req_id and ctx is None:
                self._send_json({"error": f"Unknown workspace hub '{req_id}'"}, status=404)
                return
            remote_mgr = ctx.remote_mgr if ctx is not None else mgr.shared_remote_mgr
            self._send_json({
                "hubs": remote_mgr.list_hubs(),
                "busy": remote_mgr.is_busy(),
                "current_season": current_season(),
            })
        elif path == "/api/remote/job":
            mgr = self._mgr()
            req_id = self._requested_hub_id(query, allow_hub_param=False)
            ctx = mgr.get_context(req_id)
            if req_id and ctx is None:
                self._send_json({"error": f"Unknown workspace hub '{req_id}'"}, status=404)
                return
            remote_mgr = ctx.remote_mgr if ctx is not None else mgr.shared_remote_mgr
            hub_id = query.get("hub", [""])[0]
            self._send_json({
                "job": remote_mgr.get_job(hub_id),
                "hub": next((h for h in remote_mgr.list_hubs() if h["id"] == hub_id), None),
            })
        elif path == "/api/remote/warnings":
            mgr = self._mgr()
            req_id = self._requested_hub_id(query, allow_hub_param=False)
            ctx = mgr.get_context(req_id)
            if req_id and ctx is None:
                self._send_json({"error": f"Unknown workspace hub '{req_id}'"}, status=404)
                return
            remote_mgr = ctx.remote_mgr if ctx is not None else mgr.shared_remote_mgr
            hub_id = query.get("hub", [""])[0]
            if remote_mgr.store.get_spec(hub_id) is None:
                self._send_json({"error": f"Unknown hub '{hub_id}'"}, status=404)
            else:
                self._send_json({"hub": hub_id, "warnings": remote_mgr.warnings(hub_id)})
        elif path in ("/api/cache/refresh", "/api/cache/clear"):
            self._send_json(
                {"error": "Method Not Allowed", "detail": "Cache refresh and clear operations must use HTTP POST."},
                status=405,
            )
        elif path == "/" or not path or path == "/index.html":
            # viz next is the default page; classic is at /classic/. A temporary redirect, so browsers
            # don't remember it; the query comes along (next reads classic's link parameters).
            self.send_response(302)
            self.send_header("Location", "/next/" + (f"?{parsed.query}" if parsed.query else ""))
            self.end_headers()
        else:
            # Fall back to static files in STATIC_DIR
            super().do_GET()

    # ---- the two frontends: viz next at /next/ (the default; / redirects there) and classic at /classic/ ----
    def _serve_dir(self, path: str, prefix: str, root: Path):
        if path == prefix:
            self.send_response(301)
            self.send_header("Location", prefix + "/")
            self.end_headers()
            return
        rel = urllib.parse.unquote(path[len(prefix) + 1:])
        root_resolved = root.resolve()
        target = (root_resolved / rel).resolve() if rel else root_resolved
        if target != root_resolved and root_resolved not in target.parents:
            self.send_error(404, "File not found")
            return
        if target.is_dir():
            if not path.endswith("/"):
                self.send_response(301)
                self.send_header("Location", path + "/")
                self.end_headers()
                return
            target = (target / "index.html").resolve()
        if root_resolved not in target.parents or not target.is_file():
            self.send_error(404, "File not found")
            return
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix in (".js", ".mjs"):
            ctype = "text/javascript"
        if ctype.startswith("text/") or ctype in ("application/json", "image/svg+xml"):
            ctype += "; charset=utf-8"
        self._serve_file(target, ctype)

    def _route_workspace_post(self, path: str):
        mgr = self._mgr()
        if mgr.mode != "local":
            self._send_json({"error": "Local workspace actions are disabled in web mode"}, status=403)
            return
        body = self._read_json_body()
        try:
            if path == "/api/workspace/inspect":
                self._send_json(mgr.inspect_path(str(body.get("path", ""))))
            elif path == "/api/workspace/add":
                res = mgr.add_local_hub(
                    str(body.get("path", "")),
                    label=body.get("label"),
                    activate=bool(body.get("activate", True)),
                )
                self._send_json(res)
            elif path == "/api/workspace/activate":
                hub_id = str(body.get("id") or body.get("hub") or "").strip()
                self._send_json(mgr.activate_hub(hub_id))
            elif path == "/api/workspace/remove":
                hub_id = str(body.get("id") or body.get("hub") or "").strip()
                self._send_json(mgr.remove_local_hub(hub_id, clear_cache=bool(body.get("clear_cache", False))))
            elif path == "/api/workspace/pick-dir":
                self._send_json(mgr.pick_native_directory(initial_dir=body.get("initial_dir")))
            elif path == "/api/workspace/target-aliases":
                hub_id = str(body.get("hub_id") or body.get("hub") or body.get("id") or "").strip()
                target_id = str(body.get("target_id") or body.get("target") or "").strip()
                concept_id = body.get("concept_id") if "concept_id" in body else body.get("concept")
                self._send_json(mgr.set_target_alias(hub_id, target_id, concept_id))
            else:
                self._send_json({"error": f"POST endpoint '{path}' not found"}, status=404)
        except KeyError as exc:
            self._send_json({"error": str(exc).strip("'")}, status=404)
        except PermissionError as exc:
            self._send_json({"error": str(exc)}, status=403)
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=400)

    def _handle_next_api(self, path: str, query: dict):
        name = path[len("/api/next/"):]
        mgr = self._mgr()
        if name == "catalog":
            cat = mgr.catalog.build_catalog()
            self._send_json(cat, etag=self._weak_etag(f"cat|{cat.get('stamp')}|{mgr.mode}"))
            return
        if name == "globe":
            globe = mgr.catalog.build_globe()
            self._send_json(globe, etag=self._weak_etag(f"globe|{globe.get('stamp')}|{mgr.mode}"))
            return
        if name == "manifest":
            req_id = self._requested_hub_id(query)
            ctx = mgr.get_context(req_id)
            if req_id and ctx is None:
                self._send_json({"error": f"Unknown workspace hub '{req_id}'"}, status=404)
                return
            if ctx is None:
                self._send_json({
                    "empty": True,
                    "mode": mgr.mode,
                    "hub": None,
                    "hub_id": None,
                    "workspace": mgr.workspace_summary(),
                    "workspace_hubs": [],
                    "targets": [],
                    "default_target": None,
                    "baseline": None,
                    "recommended": [],
                    "locations": [],
                    "seasons": [],
                    "models": [],
                    "hubs": [],
                    "latest": {"date": None, "season": None},
                    "truth": {},
                })
                return
            man = ctx.next_data.manifest()
            man["empty"] = False
            man["mode"] = mgr.mode
            man["hub_id"] = ctx.hub_id
            man["hub"] = ctx.display_label
            if ctx.description:
                man["hub_description"] = ctx.description
            else:
                man.pop("hub_description", None)
            if mgr.mode == "local":
                man["hub_path"] = str(ctx.base_dir)
            else:
                man.pop("hub_path", None)
            man["workspace_hubs"] = mgr.workspace_hubs_brief()
            man_etag = self._weak_etag(f"man|{man.get('stamp')}|{mgr.mode}|{ctx.hub_id}|{len(man['workspace_hubs'])}")
            self._send_json(man, etag=man_etag)
            return

        ctx = self._require_ctx(query)
        if ctx is None:
            return
        def_loc = self._default_location(ctx)
        if name == "fan":
            target = query.get("target", [ctx.config.get_default_target()])[0]
            season = query.get("season", [""])[0]
            location = query.get("location", [def_loc])[0] or def_loc
            dims = self._extract_dims(ctx, target, query)
            raw_ver = query.get("v", ["2"])[0].strip()
            try:
                ver = int(raw_ver)
            except ValueError:
                ver = 2
            if not season:
                self._send_json({"error": "Missing 'season' parameter"}, status=400)
                return
            payload = ctx.next_data.fan(target, season, location, dims=dims, version=ver)
            if payload is None:
                self._send_json({"error": f"No forecast rounds in season '{season}'"}, status=404)
                return
            stamp = ctx.next_data._stamp()
            fan_etag = self._weak_etag(f"fan|{ver}|{target}|{season}|{location}|{sorted((dims or {}).items())}|{stamp}")
            self._send_bytes(payload, "application/octet-stream", etag=fan_etag)
        elif name == "trajectories":
            target = query.get("target", [ctx.config.get_default_target()])[0]
            season = query.get("season", [ctx.loader.get_latest_season()])[0]
            location = query.get("location", [def_loc])[0] or def_loc
            ref_date = query.get("date", [""])[0].strip()
            if not ref_date:
                self._send_json({"error": "Missing 'date' parameter"}, status=400)
                return
            models_param = query.get("models", [""])[0]
            models = [m.strip() for m in models_param.split(",") if m.strip()] or None
            dims = self._extract_dims(ctx, target, query)
            payload = ctx.next_data.trajectories(target, season, location, ref_date, models=models, dims=dims)
            if payload is None:
                self._send_json({"error": "No trajectory samples found for the requested slice"}, status=404)
                return
            self._send_bytes(payload, "application/octet-stream")
        elif name == "pmf":
            target = query.get("target", [ctx.config.get_default_target()])[0]
            season = query.get("season", [ctx.loader.get_latest_season()])[0]
            location = query.get("location", [def_loc])[0] or def_loc
            ref_date = query.get("date", [""])[0].strip() or None
            models_param = query.get("models", [""])[0]
            models = [m.strip() for m in models_param.split(",") if m.strip()] or None
            dims = self._extract_dims(ctx, target, query)
            self._send_json(ctx.next_data.pmf(target, season, location, round_date=ref_date, models=models, dims=dims))
        elif name == "asof":
            season = query.get("season", [""])[0]
            if not season:
                self._send_json({"error": "Missing 'season' parameter"}, status=400)
                return
            target = query.get("target", [ctx.config.get_default_target()])[0]
            self._send_json(ctx.next_data.asof(target, season, query.get("location", [def_loc])[0] or def_loc))
        elif name == "heatmap":
            # /api/heatmap, plus the evaluation window: horizons=0,1 and dates=<rounds in scope>
            self._handle_heatmap(ctx, query, next_api=True)
        elif name == "spatial":
            # /api/spatial with values unrounded (proportions would round to 0.0)
            self._handle_spatial(ctx, query, precise=True)
        elif name == "surveillance":
            # /api/surveillance with the as-of series unrounded
            self._handle_surveillance(ctx, query, precise=True)
        elif name == "metrics":
            # /api/metrics, plus horizons=0,1 to score only those horizons (relative WIS computed on them)
            raw = query.get("horizons", [""])[0].strip()
            horizons = None
            if raw and raw.lower() != "all":
                try:
                    horizons = sorted({int(h) for h in raw.split(",") if h.strip()}) or None
                except ValueError:
                    self._send_json({"error": f"Invalid horizons '{raw}' (expected e.g. '0,1')"}, status=400)
                    return
            self._handle_metrics(ctx, query, horizons=horizons)
        else:
            self._send_json({"error": f"Unknown endpoint '{path}'"}, status=404)

    @staticmethod
    def _default_location(ctx: HubContext) -> str:
        try:
            return ctx.loader.get_geo_graph().default_location()
        except Exception:
            return "US"

    @staticmethod
    def _extract_dims(ctx: HubContext, target: str, query: dict) -> Optional[Dict[str, str]]:
        extra_defs = ctx.config.get_extra_task_ids(target)
        out: Dict[str, str] = {}
        raw_dims = query.get("dims", [""])[0].strip()
        if raw_dims:
            for item in raw_dims.split(","):
                if ":" in item:
                    k, v = item.split(":", 1)
                    if k.strip() and v.strip():
                        out[k.strip()] = v.strip()
        for col in extra_defs:
            val = query.get(col, [""])[0].strip()
            if val:
                out[col] = val
        return out or None

    @staticmethod
    def _weak_etag(seed: str) -> str:
        return f'W/"{hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]}"'

    @staticmethod
    def _etag_matches(header_val: Optional[str], etag: str) -> bool:
        if not header_val:
            return False
        raw = header_val.strip()
        if raw == "*":
            return True
        norm = etag[2:] if etag.startswith("W/") else etag
        for part in raw.split(","):
            tok = part.strip()
            tok_norm = tok[2:] if tok.startswith("W/") else tok
            if tok == etag or tok_norm == norm:
                return True
        return False

    def _send_bytes(
        self,
        raw_bytes: bytes,
        content_type: str,
        status: int = 200,
        *,
        etag: Optional[str] = None,
        allow_gzip: bool = True,
        cache_control: Optional[str] = None,
    ):
        cc = cache_control or "no-cache"
        if status == 200 and etag is not None:
            if self._etag_matches(self.headers.get("If-None-Match"), etag):
                self._cache_control_override = cc
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Vary", "Accept-Encoding")
                self.end_headers()
                return
            self._cache_control_override = cc

        body = raw_bytes
        use_gzip = False
        if allow_gzip and len(raw_bytes) > 1024:
            accept_enc = (self.headers.get("Accept-Encoding") or "").lower()
            if "gzip" in accept_enc:
                body = gzip.compress(raw_bytes, compresslevel=6)
                use_gzip = True

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if etag is not None and status == 200:
            self.send_header("ETag", etag)
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, data: Any, status: int = 200, *, etag: Optional[str] = None):
        self._send_bytes(json.dumps(data).encode("utf-8"), "application/json", status=status, etag=etag)

    def _serve_file(self, file_path: Path, content_type: str):
        if not file_path.exists():
            self.send_error(404, "File not found")
            return
        st = file_path.stat()
        etag = f'W/"{st.st_mtime_ns:x}-{st.st_size:x}"'
        base_type = content_type.split(";", 1)[0].strip().lower()
        allow_gzip = base_type.startswith("text/") or base_type in (
            "application/json",
            "image/svg+xml",
            "application/javascript",
        )
        immutable = file_path.suffix == ".woff2" or (
            file_path.suffix == ".json" and "geo" in file_path.parts
        )
        with open(file_path, "rb") as f:
            content = f.read()
        self._send_bytes(
            content,
            content_type,
            status=200,
            etag=etag,
            allow_gzip=allow_gzip,
            cache_control="public, max-age=3600" if immutable else "no-cache",
        )

    def _handle_status(self, query: dict):
        mgr = self._mgr()
        req_id = self._requested_hub_id(query)
        ctx = mgr.get_context(req_id)
        if req_id and ctx is None:
            self._send_json({"error": f"Unknown workspace hub '{req_id}'"}, status=404)
            return
        if ctx is None:
            self._send_json({
                "status": "ok",
                "mode": mgr.mode,
                "hub": None,
                "hub_id": None,
                "models_count": 0,
                "production_models": [],
                "local_test_models": [],
                "hub_models": [],
                "validation_warnings": [],
            })
            return
        models = ctx.loader.scan_models()
        warnings = ctx.loader.get_validation_warnings()
        self._send_json({
            "status": "ok",
            "mode": mgr.mode,
            "hub": ctx.base_dir.name,
            "hub_id": ctx.hub_id,
            "hub_label": ctx.display_label,
            "models_count": len(models),
            "production_models": [m for m, v in models.items() if not v["is_local"] and v.get("source") != "hub"],
            "local_test_models": [m for m, v in models.items() if v["is_local"]],
            "hub_models": [m for m, v in models.items() if v.get("source") == "hub"],
            "validation_warnings": warnings,
        })

    def _handle_cache_refresh(self, ctx: HubContext, clear: bool = False):
        if clear:
            ctx.loader.cache_mgr.clear_cache()
        ctx.invalidate_all()
        if clear:
            count = ctx.loader.cache_mgr.warmup_cache(include_remote_models=False)
            rebuilt = count
        else:
            stats = ctx.loader.cache_mgr.refresh_local_cache()
            count = stats["models_total"]
            rebuilt = stats["rebuilt"]
        ctx.loader.scan_models(force_refresh=True)
        self._send_json({
            "status": "ok",
            "message": "Parquet cache successfully cleared and rebuilt" if clear else "Parquet cache successfully refreshed",
            "models_cached": count,
            "rebuilt": rebuilt,
        })

    def _handle_model_details(self, ctx: HubContext, query: dict):
        model_id = query.get("model", query.get("model_id", [""]))[0].strip()
        if not model_id:
            self._send_json({"error": "Missing 'model' or 'model_id' parameter"}, status=400)
            return

        details = ctx.loader.get_model_details(model_id)
        if details is None:
            self._send_json({"error": f"Model '{model_id}' not found"}, status=404)
            return

        self._send_json(details)

    def _handle_metadata(self, ctx: HubContext):
        models = ctx.loader.scan_models()
        locations = ctx.loader.get_locations()

        # Model forecast dates
        model_dates_set = set()
        for m_info in models.values():
            model_dates_set.update(m_info.get("dates", []))

        # Official Hub round dates
        hub_seasons = ctx.loader.get_hub_seasons()
        hub_dates_set = set()
        for h_dates in hub_seasons.values():
            hub_dates_set.update(h_dates)

        # Historical surveillance dates
        adm_df = ctx.loader.get_admissions_ground_truth(as_polars=True)
        surv_dates_set = set()
        if adm_df is not None and not adm_df.is_empty():
            surv_dates_set.update(adm_df["target_end_date"].to_list())

        all_dates_set = model_dates_set | hub_dates_set | surv_dates_set
        sorted_dates = sorted(list(all_dates_set), reverse=True)

        # Build date_info map for UI date picker with fast O(1) set membership
        model_dates_sets = {m: set(m_info.get("dates", [])) for m, m_info in models.items()}
        date_info = {}
        for d in sorted_dates:
            s = ctx.loader.get_flu_season_for_date(d)
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
        recommended = ctx.config.get_recommended_models([m for m, v in models.items() if v.get("source") != "hub"])
        # Season peak targets are not selectable weekly targets; they are offered through `peak_targets`
        targets = ctx.config.get_weekly_targets()
        peak_targets = {}
        for t in targets:
            companions = ctx.loader.peaks.targets(t)
            if companions and ctx.loader.peaks.is_available(t):
                peak_targets[t] = companions

        sorted_seasons = ctx.loader.get_all_seasons()
        forecast_seasons = ctx.loader.get_forecast_seasons()
        season_summaries = ctx.loader.get_season_summaries()
        sorted_families = ctx.loader.get_all_families()
        latest_date = ctx.loader.get_latest_reference_date()
        latest_season = ctx.loader.get_latest_season()
        targets_meta = {t: ctx.config.get_target_metadata(t) for t in targets}
        for companions in peak_targets.values():
            for t in companions.values():
                targets_meta[t] = {**ctx.config.get_target_metadata(t), "is_peak": True}

        if self._mgr().mode != "local":
            exposed_models = {
                mid: {k: v for k, v in m_info.items() if k != "path"}
                for mid, m_info in models.items()
            }
        else:
            exposed_models = models

        self._send_json({
            "models": exposed_models,
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
            "default_target": ctx.config.get_default_target(),
            "default_baseline": ctx.config.get_default_baseline(
                [m for m, v in models.items() if v.get("source") != "hub"] or list(models.keys())
            ),
            "remote_hubs": [
                {k: h.get(k) for k in ("id", "label", "short_label", "synced", "enabled", "latest_round",
                                       "latest_round_models", "last_sync", "models", "pending", "peak_outdated")}
                for h in ctx.remote_mgr.list_hubs()
            ],
            "truth_info": ctx.loader.get_truth_info(),
        })

    def _handle_forecast(self, ctx: HubContext, query: dict):
        target = query.get("target", [ctx.config.get_default_target()])[0]
        def_loc = self._default_location(ctx)
        location = query.get("location", [def_loc])[0] or def_loc
        ref_date = query.get("date", [""])[0]
        models_param = query.get("models", [""])[0]
        model_ids = [m.strip() for m in models_param.split(",") if m.strip()]

        if not ref_date:
            self._send_json({"error": "Missing 'date' parameter"}, status=400)
            return

        truth = ctx.loader.get_ground_truth_series(target, location, ref_date)
        surveillance = ctx.loader.get_surveillance_streams(target, location, ref_date)

        model_results = []
        for mid in model_ids:
            fan_data = ctx.loader.get_model_fan_data(mid, target, location, ref_date)
            if fan_data:
                model_results.append(fan_data)

        # Season peak markers for the same round (only for targets with peak companions)
        peaks = None
        if location not in ("states", "all"):
            try:
                peaks = ctx.loader.peaks.round_overlay(target, location, ref_date, model_ids)
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

    def _handle_peaks(self, ctx: HubContext, query: dict):
        """Season Peak view: one round's peak forecasts, their evolution over the season, and peak skill."""
        target = query.get("target", [ctx.config.get_default_target()])[0]
        def_loc = self._default_location(ctx)
        location = query.get("location", [def_loc])[0] or def_loc
        if location in ("states", "all"):
            location = def_loc
        ref_date = query.get("date", [""])[0]
        models_param = query.get("models", [""])[0]
        if models_param.strip().lower() == "all":
            # every known model (what /next/ asks for when no selected model forecasts peaks)
            model_ids = list(ctx.loader.scan_models().keys())
        else:
            model_ids = [m.strip() for m in models_param.split(",") if m.strip()]
        scope = query.get("skill_scope", ["location"])[0]
        common = query.get("common", ["0"])[0].lower() in ("1", "true", "yes")
        if not ref_date:
            self._send_json({"error": "Missing 'date' parameter"}, status=400)
            return
        if scope not in ("location", "states"):
            self._send_json({"error": "skill_scope must be 'location' or 'states'"}, status=400)
            return
        view = ctx.loader.peaks.season_view(target, location, ref_date, model_ids, scope, common)
        # fallback=all (added for /next/): when none of the listed models forecast this round's peak, answer
        # for every known model instead, in the same request; the response says so with "fallback": true
        if (query.get("fallback", [""])[0] == "all" and model_ids and view.get("available")
                and not any(m.get("has_round") and (m.get("timing") or m.get("size")) for m in view.get("models", []))):
            view = ctx.loader.peaks.season_view(target, location, ref_date, list(ctx.loader.scan_models().keys()), scope, common)
            view["fallback"] = True
        self._send_json(view)

    def _handle_peak_map(self, ctx: HubContext, query: dict):
        target = query.get("target", [ctx.config.get_default_target()])[0]
        ref_date = query.get("date", [""])[0]
        model_id = query.get("model", [""])[0].strip()
        if not ref_date or not model_id:
            self._send_json({"error": "Missing 'date' or 'model' parameter"}, status=400)
            return
        self._send_json(ctx.loader.peaks.map_layer(target, ref_date, model_id))

    def _handle_surveillance(self, ctx: HubContext, query: dict, precise: bool = False):
        target = query.get("target", [ctx.config.get_default_target()])[0]
        def_loc = self._default_location(ctx)
        location = query.get("location", [def_loc])[0] or def_loc
        models = ctx.loader.scan_models()
        dates = [m.get("max_date") for m in models.values() if m.get("max_date")]
        fallback_date = max(dates) if dates else "2024-01-13"
        ref_date = query.get("date", [fallback_date])[0]
        surv = ctx.loader.get_surveillance_streams(target, location, ref_date, precise=precise)
        self._send_json(surv)

    def _handle_spatial(self, ctx: HubContext, query: dict, precise: bool = False):
        target = query.get("target", [ctx.config.get_default_target()])[0]
        ref_date = query.get("date", [""])[0]
        models_param = query.get("models", [""])[0]
        horizon_param = query.get("horizon", ["all"])[0]

        model_ids = [m.strip() for m in models_param.split(",") if m.strip()]
        if not model_ids:
            model_ids = list(ctx.loader.scan_models().keys())

        if not ref_date:
            self._send_json({"error": "Missing 'date' parameter"}, status=400)
            return

        spatial_data = ctx.loader.get_spatial_data(target, ref_date, model_ids, horizon=horizon_param, precise=precise)
        self._send_json(spatial_data)

    def _handle_heatmap(self, ctx: HubContext, query: dict, next_api: bool = False):
        mode = query.get("mode", [""])[0].strip() or None
        rows = query.get("rows", [""])[0].strip() or None
        cols = query.get("cols", [""])[0].strip() or None
        location = query.get("location", query.get("loc", ["states"]))[0].strip() or "states"
        target = query.get("target", [ctx.config.get_default_target()])[0].strip()
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
        fair = query.get("fair", ["0"])[0].strip().lower() in ("1", "true", "yes")

        model_ids = [m.strip() for m in models_param.split(",") if m.strip()] if models_param else None

        try:
            heatmap_data = ctx.loader.get_heatmap_data(
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
                fair=fair,
                **(self._heatmap_scope(query) if next_api else {}),
            )
            self._send_json(heatmap_data)
        except Exception as exc:
            logger.exception("Heatmap API generation error: %s", exc)
            self._send_json({"error": str(exc)}, status=500)

    @staticmethod
    def _heatmap_scope(query: dict) -> dict:
        """next/'s evaluation window for /api/next/heatmap: horizons=0,1 and dates=2025-11-01,… (rounds)."""
        out = {}
        raw_h = query.get("horizons", [""])[0].strip()
        if raw_h and raw_h.lower() != "all":
            out["horizons"] = sorted({int(h) for h in raw_h.split(",") if h.strip().lstrip("-").isdigit()}) or None
        raw_d = query.get("dates", [""])[0].strip()
        if raw_d:
            out["dates"] = [d.strip() for d in raw_d.split(",") if d.strip()] or None
        return out

    def _handle_season_curves(self, ctx: HubContext, query: dict):
        """Truth curves per season for one location, aligned by season week, with peak/pre/post phases."""
        target = query.get("target", [ctx.config.get_default_target()])[0]
        def_loc = self._default_location(ctx)
        location = query.get("location", [def_loc])[0] or def_loc
        if location in ("states", "all"):
            location = def_loc
        seasons_param = query.get("seasons", [""])[0]
        seasons = [s.strip() for s in seasons_param.split(",") if s.strip()] or ctx.loader.get_forecast_seasons()
        self._send_json(ctx.loader.get_season_curves(target, location, seasons))

    def _handle_metrics(self, ctx: HubContext, query: dict, horizons: Optional[List[int]] = None):
        from viz.core.evaluation import EvaluationParams

        target = query.get("target", [ctx.config.get_default_target()])[0]
        loc_param = query.get("location", ["all"])[0]
        date_param = query.get("date", ["all"])[0]
        season_param = query.get("season", [""])[0].strip()
        models_param = query.get("models", [""])[0]
        baseline_param = query.get("baseline", [""])[0].strip()
        fair_flag = query.get("fair", ["false"])[0].lower() in ["true", "1", "yes"]
        weeks_param = query.get("weeks", [""])[0].strip() or None
        phase_param = query.get("phase", [""])[0].strip() or None

        model_ids = [m.strip() for m in models_param.split(",") if m.strip()] if models_param else None
        dims = self._extract_dims(ctx, target, query)

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
            horizons=horizons,
            dims=dims,
        )

        try:
            result = ctx.eval_engine.evaluate(params)
            self._send_json(result.to_dict())
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=400)
        except Exception as exc:
            logger.warning("Metrics evaluation error: %s", exc)
            self._send_json({"error": str(exc)}, status=500)

    def _route_remote_post(self, remote_mgr: Any, path: str):
        """Hub sync endpoints. Only these (user-initiated) calls ever reach the network."""
        body = self._read_json_body()
        hub_id = str(body.get("hub", "")).strip()
        try:
            if path == "/api/remote/add":
                source = str(body.get("source") or body.get("bucket") or "").strip()
                transport = body.get("transport")
                branch = str(body.get("branch") or "main").strip() or "main"
                result = remote_mgr.add_hub(source, body.get("label"), transport=transport, branch=branch)
                self._send_json(result, status=200 if result.get("ok") else 422)
            elif path == "/api/remote/check":
                self._send_json(remote_mgr.check(hub_id))
            elif path == "/api/remote/sync":
                seasons = body.get("seasons")
                seasons = [str(x) for x in seasons] if isinstance(seasons, list) else None
                self._send_json({"job": remote_mgr.start_sync(hub_id, seasons)})
            elif path == "/api/remote/cancel":
                self._send_json({"cancelled": remote_mgr.cancel(hub_id)})
            elif path == "/api/remote/remove":
                remote_mgr.remove(hub_id)
                self._send_json({"status": "ok", "removed": hub_id})
            elif path == "/api/remote/toggle":
                remote_mgr.set_enabled(hub_id, bool(body.get("enabled", True)))
                self._send_json({"status": "ok", "hub": hub_id, "enabled": bool(body.get("enabled", True))})
            else:
                self._send_json({"error": f"POST endpoint '{path}' not found"}, status=404)
        except KeyError as exc:
            self._send_json({"error": str(exc).strip("'")}, status=404)
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=400)
        except RuntimeError as exc:
            self._send_json({"error": str(exc)}, status=409)
        except (S3Error, TransportError) as exc:
            self._send_json({"error": str(exc)}, status=502)

    def _handle_ensemble_list(self, ctx: HubContext):
        """List all registered session and persisted synthetic ensembles."""
        ensembles = ctx.loader.ensemble_mgr.list_ensembles()
        self._send_json({"status": "ok", "ensembles": ensembles})

    def _handle_ensemble_preview(self, ctx: HubContext):
        """Compute pre-flight task overlap and date alignment for candidate ensemble."""
        body = self._read_json_body()
        try:
            cfg = SyntheticEnsembleConfig.from_dict(body)
            preview = ctx.loader.ensemble_mgr.preview_ensemble(cfg)
            self._send_json(preview)
        except Exception as exc:
            logger.exception("Error during ensemble preview: %s", exc)
            self._send_json({"valid": False, "error": str(exc)}, status=400)

    def _handle_ensemble_create(self, ctx: HubContext):
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
            registered = ctx.loader.register_synthetic_ensemble(cfg)
            with ctx.eval_engine._eval_cache_lock:
                ctx.eval_engine._eval_cache.clear()

            if body.get("save_to_disk"):
                ctx.loader.save_synthetic_ensemble(registered.id)

            self._send_json({
                "status": "ok",
                "ensemble": registered.to_dict(),
            })
        except ValueError as exc:
            self._send_json({"error": str(exc)}, status=400)
        except Exception as exc:
            logger.exception("Error creating synthetic ensemble: %s", exc)
            self._send_json({"error": str(exc)}, status=500)

    def _handle_ensemble_save(self, ctx: HubContext):
        """Persist a registered synthetic ensemble to local-output/synthetic/<id>/."""
        body = self._read_json_body()
        ensemble_id = str(body.get("ensemble_id", "")).strip()
        if not ensemble_id:
            self._send_json({"error": "Missing 'ensemble_id' parameter"}, status=400)
            return

        try:
            res = ctx.loader.save_synthetic_ensemble(ensemble_id)
            with ctx.eval_engine._eval_cache_lock:
                ctx.eval_engine._eval_cache.clear()
            self._send_json(res)
        except Exception as exc:
            logger.exception("Error persisting synthetic ensemble: %s", exc)
            self._send_json({"error": str(exc)}, status=500)

    def _handle_ensemble_delete(self, ctx: HubContext):
        """Remove a synthetic ensemble from active registry and disk."""
        body = self._read_json_body()
        ensemble_id = str(body.get("ensemble_id", "")).strip()
        if not ensemble_id:
            self._send_json({"error": "Missing 'ensemble_id' parameter"}, status=400)
            return

        try:
            removed = ctx.loader.remove_synthetic_ensemble(ensemble_id)
            with ctx.eval_engine._eval_cache_lock:
                ctx.eval_engine._eval_cache.clear()
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


def run_server(
    port: Optional[int] = None,
    host: Optional[str] = None,
    hubs: Optional[List[str]] = None,
    mode: Optional[str] = None,
    data_dir: Optional[str] = None,
    no_auto_hub: bool = False,
):
    """Launch the threaded HTTP server with transparent cache warmup."""
    if hubs or mode is not None or data_dir is not None or no_auto_hub or HUB_MANAGER is None:
        try:
            cli_paths = [Path(h) for h in hubs] if hubs else None
            d_dir = Path(data_dir).expanduser().resolve() if data_dir else None
            init_hub_manager(
                data_dir=d_dir,
                mode=mode,
                cli_hubs=cli_paths,
                include_enclosing=not no_auto_hub,
            )
        except ValueError as exc:
            sys.stderr.write(f"\nERROR: {exc}\n\n")
            sys.exit(1)

    mgr = HUB_MANAGER
    assert mgr is not None
    active_ctx = mgr.get_context(None)

    # SO_REUSEADDR lets a restart reuse a port stuck in TIME_WAIT on macOS/Linux. On Windows it
    # would instead let a second server bind a port that is already in use, so it stays off there.
    socketserver.ThreadingTCPServer.allow_reuse_address = sys.platform != "win32"
    socketserver.ThreadingTCPServer.daemon_threads = True

    server_cfg = active_ctx.config.get_server_config() if active_ctx else _FALLBACK_SERVER_CFG
    final_port = port if port is not None else server_cfg["port"]
    final_host = host if host is not None else server_cfg["host"]

    try:
        httpd = socketserver.ThreadingTCPServer((final_host, final_port), SandboxRequestHandler)
    except OSError as exc:
        if exc.errno not in (errno.EADDRINUSE, 10048):  # 10048 = WSAEADDRINUSE
            raise
        suggestion = _next_free_port(final_host, final_port + 1)
        launcher = "run.bat" if sys.platform == "win32" else "./run.sh"
        hub_desc = str(active_ctx.base_dir) if active_ctx else "standalone workspace"
        sys.stderr.write(
            f"\nERROR: port {final_port} on {final_host} is already in use, probably by another viz server.\n"
            f"Nothing was started. Anything answering at http://{final_host}:{final_port} is that other server,\n"
            f"not this hub ({hub_desc}).\n"
        )
        if suggestion:
            sys.stderr.write(f"Start on a free port instead:  {launcher} {suggestion}\n\n")
        sys.exit(1)

    # Warm up Parquet cache in background thread when an active hub is present
    if active_ctx is not None:
        def _warmup_background(ctx_to_warm: HubContext):
            try:
                ctx_to_warm.loader.cache_mgr.warmup_cache()
            except Exception as exc:
                logger.warning("Background cache warmup error: %s", exc)

        threading.Thread(target=_warmup_background, args=(active_ctx,), daemon=True).start()

    hub_banner = (
        f"{active_ctx.display_label} ({active_ctx.base_dir})"
        if active_ctx is not None
        else "None (open UI to connect a local hub)"
    )

    with httpd:
        print(f"\n========================================================")
        print(f"  viz — Hubverse Visualization & Evaluation Server")
        print(f"  Mode:    {mgr.mode}")
        print(f"  URL:     http://{final_host}:{final_port}")
        print(f"  Hub:     {hub_banner}")
        print(f"  Data:    {mgr.data_dir}")
        print(f"  Engine:  Polars (Vectorized SIMD) + Parquet Acceleration")
        print(f"  Serving: {NEXT_DIR}  (classic: {STATIC_DIR})")
        print(f"  Press Ctrl+C to terminate.")
        print(f"========================================================\n", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            httpd.server_close()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="viz — Hubverse Forecast Visualizer & Evaluator")
    parser.add_argument("--hub", action="append", default=None, help="Path to a local Hubverse hub (repeatable)")
    parser.add_argument("--port", type=int, default=None, help="Port to bind (default from config or 8501)")
    parser.add_argument("--host", type=str, default=None, help="Host interface (default: 127.0.0.1)")
    parser.add_argument("--mode", choices=["local", "web"], default=None, help="Runtime mode: local (default) or web")
    parser.add_argument("--data-dir", type=str, default=None, help="Override directory for workspace & caches")
    parser.add_argument("--no-auto-hub", action="store_true", help="Do not auto-register an enclosing parent hub")
    args = parser.parse_args()
    run_server(
        port=args.port,
        host=args.host,
        hubs=args.hub,
        mode=args.mode,
        data_dir=args.data_dir,
        no_auto_hub=args.no_auto_hub,
    )
