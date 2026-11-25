"""Background auto-sync scheduler for built-in public hubs and briefing feeds in web mode."""

from __future__ import annotations

from datetime import datetime, timezone
import logging
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from viz.core.paths import APP_DIR
from viz.core.workspace import REMOTE_HUB_PREFIX
from viz.remote.sync import current_season
from viz.web.config import WebConfig

logger = logging.getLogger("viz.web.scheduler")


def _safe_hub_error(exc: Exception) -> str:
    msg = (str(exc) or "").lower()
    if "rate limit" in msg or "429" in msg:
        return "Upstream rate limit exceeded; will retry automatically."
    if "access denied" in msg or "401" in msg or "403" in msg:
        return "Upstream access error; will retry automatically."
    if "timeout" in msg or "timed out" in msg or "network" in msg or "connection" in msg:
        return "Network error communicating with hub repository."
    if "not found" in msg or "404" in msg:
        return "Remote hub resource not found."
    return "Hub sync failed; will retry on next schedule."


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
        self._last_sync_at: float = 0.0
        self._last_briefing_at: float = 0.0
        self._last_surv_at: float = 0.0
        self._next_run_at: Optional[float] = None
        self._hub_errors: Dict[str, str] = {}
        # hub_id -> (consecutive failures, time of last failure); drives exponential retry backoff
        self._hub_failures: Dict[str, Tuple[int, float]] = {}

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

    def _next_sleep_seconds(self, tick_sec: float, sync_sec: float, *, now: Optional[float] = None) -> float:
        """Sleep until the regular cadence OR the earliest unsynced-hub backoff retry, whichever is sooner."""
        wait_sec = max(1.0, float(tick_sec))
        now_ts = time.time() if now is None else now
        with self._lock:
            failures = list(self._hub_failures.items())
        for hub_id, (n, last) in failures:
            if n <= 0 or self.mgr.remote_store.has_data(hub_id):
                continue
            delay = min(sync_sec, 900.0 * (2 ** min(n - 1, 8)))
            rem = max(5.0, (last + delay) - now_ts)
            if rem < wait_sec:
                wait_sec = rem
        return wait_sec

    def _loop(self) -> None:
        sync_sec = max(900.0, float(self.cfg.sync_interval_hours) * 3600.0)
        brief_sec = max(900.0, float(self.cfg.briefing_refresh_hours) * 3600.0)
        tick_sec = min(sync_sec, brief_sec)
        # Short initial delay lets HTTP server bind & respond to /healthz immediately
        if self._stop_event.wait(2.0):
            return
        while not self._stop_event.is_set():
            try:
                self.run_once()
            except Exception as exc:
                logger.exception("Web auto-sync cycle failed: %s", exc)
            wait_sec = self._next_sleep_seconds(tick_sec, sync_sec)
            with self._lock:
                self._next_run_at = time.time() + wait_sec
            if self._stop_event.wait(wait_sec):
                break

    def _refresh_surveillance_if_needed(self) -> None:
        if (APP_DIR / "data" / "surveillance" / "target-hospital-admissions.csv").is_file():
            return
        surv_dir = self.mgr.data_dir / "surveillance"
        now = time.time()
        if (surv_dir / "target-hospital-admissions.csv").is_file() and (now - self._last_surv_at) < 86400.0:
            return
        flu_specs = {"flusight", "flu_metrocast"}
        if not any(s.id in flu_specs for s in self.target_specs()):
            return
        try:
            from viz.rebuild_surveillance import rebuild_surveillance_data
            rebuild_surveillance_data(
                surveillance_dir=surv_dir,
                skip_cache_warmup=True,
                refresh_admissions_after_hours=20.0,
                refresh_as_of_after_hours=24.0 * 7,
            )
            self._last_surv_at = time.time()
        except Exception as exc:
            logger.warning("Web surveillance refresh failed: %s", exc)

    def _refresh_briefings_if_due(self) -> None:
        brief_sec = max(900.0, float(self.cfg.briefing_refresh_hours) * 3600.0)
        now = time.time()
        try:
            status = self.mgr.briefing_feeds.get_status(max_age_hours=self.cfg.briefing_refresh_hours)
            feeds = status.get("feeds") or {}
            due_by_timer = (now - self._last_briefing_at) >= brief_sec
            needs_refresh = any(f.get("stale") or not f.get("cached") for f in feeds.values())
            if due_by_timer and needs_refresh:
                self.mgr.briefing_feeds.refresh_sync(force=False, max_age_hours=self.cfg.briefing_refresh_hours)
                self._last_briefing_at = time.time()
            elif needs_refresh and not any(f.get("cached") for f in feeds.values()):
                self.mgr.briefing_feeds.refresh_sync(force=False, max_age_hours=self.cfg.briefing_refresh_hours)
                self._last_briefing_at = time.time()
        except Exception as exc:
            logger.warning("Web auto-sync briefing feed refresh failed: %s", exc)

    def run_once(self) -> None:
        """Run one incremental check + sync pass over due target hubs and briefing feeds."""
        with self._lock:
            if self._running:
                return
            self._running = True

        try:
            if not self._stop_event.is_set():
                self._refresh_briefings_if_due()
            if not self._stop_event.is_set():
                self._refresh_surveillance_if_needed()

            sync_sec = max(900.0, float(self.cfg.sync_interval_hours) * 3600.0)
            now = time.time()
            rmgr = self.mgr.shared_remote_mgr
            specs = self.target_specs()
            full_pass_due = (now - self._last_sync_at) >= sync_sec
            # Unsynced hubs trigger an early pass, but a hub that keeps failing backs off
            # exponentially so it cannot force a full check of every hub on every tick.
            unsynced_ready = [
                s for s in specs
                if not self.mgr.remote_store.has_data(s.id) and not self._in_backoff(s.id, now, sync_sec)
            ]
            if full_pass_due or unsynced_ready:
                todo = specs if full_pass_due else unsynced_ready
                for spec in todo:
                    if self._stop_event.is_set():
                        break
                    if not full_pass_due and self._in_backoff(spec.id, now, sync_sec):
                        continue
                    with self._lock:
                        self._current_hub = spec.id
                    try:
                        self._sync_single_hub(rmgr, spec)
                        with self._lock:
                            self._hub_errors.pop(spec.id, None)
                            self._hub_failures.pop(spec.id, None)
                    except Exception as exc:
                        logger.warning("Web auto-sync failed for hub %s: %s", spec.id, exc)
                        with self._lock:
                            self._hub_errors[spec.id] = _safe_hub_error(exc)
                            n, _ = self._hub_failures.get(spec.id, (0, 0.0))
                            self._hub_failures[spec.id] = (n + 1, time.time())
                    finally:
                        with self._lock:
                            self._current_hub = None
                if full_pass_due:
                    self._last_sync_at = time.time()
        finally:
            with self._lock:
                self._running = False
                self._last_run_at = time.time()

    def _in_backoff(self, hub_id: str, now: float, cap_sec: float) -> bool:
        """True while a repeatedly failing hub is inside its retry delay (15 min doubling, capped)."""
        with self._lock:
            n, last = self._hub_failures.get(hub_id, (0, 0.0))
        if n <= 0:
            return False
        delay = min(cap_sec, 900.0 * (2 ** min(n - 1, 8)))
        return (now - last) < delay

    def _sync_single_hub(self, rmgr: Any, spec: Any) -> None:
        hub_id = spec.id
        has_data = self.mgr.remote_store.has_data(hub_id)
        seasons: Optional[List[str]] = list(self.cfg.sync_seasons) if self.cfg.sync_seasons else None

        should_sync = not has_data
        if has_data:
            chk = rmgr.check(hub_id)
            p = chk.get("pending") or {}
            rollover = list(p.get("new_seasons") or [])
            if (p.get("new", 0) + p.get("changed", 0) + p.get("removed", 0)) > 0 or p.get("truth_changed") or rollover:
                should_sync = True
                if seasons is None and rollover:
                    man_seasons = list(self.mgr.remote_store.load_manifest(hub_id).get("seasons") or [])
                    seasons = sorted(set(man_seasons) | {max(rollover)})
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
            if self._stop_event.wait(0.5):
                break

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
