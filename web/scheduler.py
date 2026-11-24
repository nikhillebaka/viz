"""Background auto-sync scheduler for built-in public hubs and briefing feeds in web mode."""

from __future__ import annotations

from datetime import datetime, timezone
import logging
import threading
import time
from typing import Any, Dict, List, Optional

from viz.core.workspace import REMOTE_HUB_PREFIX
from viz.remote.sync import current_season
from viz.web.config import WebConfig

logger = logging.getLogger("viz.web.scheduler")


def _utc_iso(ts: Optional[float] = None) -> Optional[str]:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class WebSyncScheduler:
    """Periodically syncs configured public hubs (default: all BUILTIN_HUBS) and briefing feeds."""

    def __init__(self, hub_manager: Any, cfg: WebConfig):
        self.mgr = hub_manager
        self.cfg = cfg
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._current_hub: Optional[str] = None
        self._last_run_at: Optional[float] = None
        self._next_run_at: Optional[float] = None
        self._hub_errors: Dict[str, str] = {}

    def target_specs(self) -> List[Any]:
        """Return ordered HubSpec objects managed by web auto-sync."""
        specs = list(self.mgr.remote_store.hub_specs())
        if self.cfg.public_hubs:
            allow = set(self.cfg.public_hubs)
            specs = [s for s in specs if s.id in allow]
        # Ensure built-ins without local data sync first on cold start
        specs.sort(key=lambda s: (1 if self.mgr.remote_store.has_data(s.id) else 0, not getattr(s, "builtin", False)))
        return specs

    def start(self) -> None:
        """Launch background auto-sync loop if enabled."""
        if not self.cfg.auto_sync:
            return
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop_event.clear()
            t = threading.Thread(target=self._loop, name="web-auto-sync", daemon=True)
            self._thread = t
            t.start()

    def stop(self) -> None:
        """Stop the background sync scheduler cleanly."""
        self._stop_event.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout=2.0)

    def _loop(self) -> None:
        interval_sec = max(900.0, float(self.cfg.sync_interval_hours) * 3600.0)
        # Short initial delay lets HTTP server bind & respond to /healthz immediately
        if self._stop_event.wait(2.0):
            return
        while not self._stop_event.is_set():
            try:
                self.run_once()
            except Exception as exc:
                logger.exception("Web auto-sync cycle failed: %s", exc)
            with self._lock:
                self._next_run_at = time.time() + interval_sec
            if self._stop_event.wait(interval_sec):
                break

    def run_once(self) -> None:
        """Run one incremental check + sync pass over all target hubs, then refresh briefings."""
        with self._lock:
            if self._running:
                return
            self._running = True

        try:
            rmgr = self.mgr.shared_remote_mgr
            specs = self.target_specs()
            for spec in specs:
                if self._stop_event.is_set():
                    break
                with self._lock:
                    self._current_hub = spec.id
                try:
                    self._sync_single_hub(rmgr, spec)
                    with self._lock:
                        self._hub_errors.pop(spec.id, None)
                except Exception as exc:
                    msg = str(exc) or exc.__class__.__name__
                    logger.warning("Web auto-sync failed for hub %s: %s", spec.id, msg)
                    with self._lock:
                        self._hub_errors[spec.id] = msg[:200]
                finally:
                    with self._lock:
                        self._current_hub = None

            if not self._stop_event.is_set():
                try:
                    status = self.mgr.briefing_feeds.get_status()
                    feeds = status.get("feeds") or {}
                    if any(f.get("stale") or not f.get("cached") for f in feeds.values()):
                        self.mgr.briefing_feeds.refresh_sync(force=False)
                except Exception as exc:
                    logger.warning("Web auto-sync briefing feed refresh failed: %s", exc)
        finally:
            with self._lock:
                self._running = False
                self._last_run_at = time.time()

    def _sync_single_hub(self, rmgr: Any, spec: Any) -> None:
        hub_id = spec.id
        has_data = self.mgr.remote_store.has_data(hub_id)
        seasons: Optional[List[str]] = list(self.cfg.sync_seasons) if self.cfg.sync_seasons else None

        should_sync = not has_data
        if has_data:
            chk = rmgr.check(hub_id)
            p = chk.get("pending") or {}
            if (p.get("new", 0) + p.get("changed", 0) + p.get("removed", 0)) > 0 or p.get("truth_changed"):
                should_sync = True
            elif seasons:
                man_seasons = set(self.mgr.remote_store.load_manifest(hub_id).get("seasons") or [])
                if any(s not in man_seasons for s in seasons):
                    should_sync = True

        if not should_sync:
            return

        if seasons is None and not has_data:
            try:
                chk = rmgr.check(hub_id)
                avail = sorted(str(s["season"]) for s in (chk.get("seasons") or []) if s.get("season"))
                if avail:
                    seasons = [avail[-1]]
                else:
                    cal = rmgr._hub_calendar(hub_id)
                    seasons = [current_season(calendar=cal)]
            except Exception:
                try:
                    cal = rmgr._hub_calendar(hub_id)
                    seasons = [current_season(calendar=cal)]
                except Exception:
                    seasons = None

        rmgr.start_sync(hub_id, seasons=seasons)
        # Wait synchronously inside this scheduler worker so hubs sync sequentially without starving upstream APIs
        while not self._stop_event.is_set():
            job = rmgr.get_job(hub_id)
            if not job or job.get("status") != "running":
                if job and job.get("status") == "error":
                    raise RuntimeError(str(job.get("error") or "sync failed"))
                break
            time.sleep(0.5)

        if self._stop_event.is_set():
            rmgr.cancel(hub_id)
            return

        ctx = self.mgr.get_context(f"{REMOTE_HUB_PREFIX}{hub_id}")
        if ctx is not None:
            ctx.loader.cache_mgr.warmup_cache()

    def get_telemetry(self) -> Dict[str, Any]:
        """Return read-only sync status & hub freshness telemetry for `/api/web/status`."""
        with self._lock:
            running = self._running
            cur_hub = self._current_hub
            last_run = self._last_run_at
            next_run = self._next_run_at
            errors = dict(self._hub_errors)

        rmgr = self.mgr.shared_remote_mgr
        hubs_out: List[Dict[str, Any]] = []
        for spec in self.target_specs():
            st = rmgr.hub_status(spec)
            job = rmgr.get_job(spec.id)
            is_syncing = bool((job and job.get("status") == "running") or cur_hub == spec.id)
            hubs_out.append({
                "id": spec.id,
                "label": st.get("label") or spec.label,
                "short_label": st.get("short_label") or spec.short_label,
                "geography": st.get("geography") or spec.geography,
                "description": st.get("description") or spec.description,
                "repo_url": st.get("repo_url") or spec.repo_url,
                "synced": bool(st.get("synced")),
                "syncing": is_syncing,
                "enabled": bool(st.get("enabled", True)),
                "models": int(st.get("models") or 0),
                "files": int(st.get("files") or 0),
                "bytes": int(st.get("bytes") or 0),
                "last_sync": st.get("last_sync"),
                "latest_round": st.get("latest_round"),
                "latest_round_models": int(st.get("latest_round_models") or 0),
                "truth": st.get("truth"),
                "error": errors.get(spec.id),
            })

        return {
            "auto_sync": bool(self.cfg.auto_sync),
            "interval_hours": self.cfg.sync_interval_hours,
            "running": running,
            "current_hub": cur_hub,
            "last_run": _utc_iso(last_run),
            "next_run": _utc_iso(next_run),
            "hubs": hubs_out,
        }
