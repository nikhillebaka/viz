"""Ephemeral session workspaces (Tier 1) and SSO hot/cold compressed workspaces (Tier 2)."""

from __future__ import annotations

from datetime import datetime, timezone
import hmac
import json
import logging
import os
from pathlib import Path
import re
import shutil
import tarfile
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from viz.core.paths import inspect_local_hub, slug_for_hub
from viz.core.workspace import LocalHubRecord
from viz.web.auth import RequestIdentity
from viz.web.bundle import (
    BundleStats,
    RateLimitExceededError,
    StorageBudgetExceededError,
    UploadTooLargeError,
    validate_hubverse_relpath,
)
from viz.web.config import WebConfig

logger = logging.getLogger("viz.web.sessions")

EPHEM_PREFIX = "ephem_"
USER_PREFIX = "user_"
_HUB_ID_PATTERN = re.compile(r"^(ephem|user)_([a-f0-9]{12})_([a-z][a-z0-9_-]{0,23})$")
_SAFE_SLUG_TAIL_LEN = 20
_TOUCH_INTERVAL_SECONDS = 60.0


def is_private_hub_id(hub_id: Optional[str]) -> bool:
    """Return True if `hub_id` belongs to a per-session or per-user web upload."""
    if not hub_id:
        return False
    return bool(_HUB_ID_PATTERN.match(hub_id.strip()))


def _utcnow_iso(ts: Optional[float] = None) -> str:
    dt = datetime.fromtimestamp(time.time() if ts is None else ts, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _dir_bytes(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    for root, _, files in os.walk(path):
        for fn in files:
            try:
                total += (Path(root) / fn).stat().st_size
            except OSError:
                pass
    return total


def _atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix(f".tmp.{os.getpid()}.{threading.get_ident()}")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True)
        os.replace(tmp, path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _short_slug(name: str, existing: List[str]) -> str:
    raw = slug_for_hub(name or "hub", Path(name or "hub"), existing)
    tail = raw[:_SAFE_SLUG_TAIL_LEN].rstrip("_-") or "hub"
    cand = tail
    n = 2
    taken = set(existing)
    while cand in taken:
        suffix = f"_{n}"
        cand = f"{tail[:_SAFE_SLUG_TAIL_LEN - len(suffix)]}{suffix}"
        n += 1
    return cand


def _pack_tar_gz(src_dir: Path, archive_path: Path) -> int:
    archive_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = archive_path.with_suffix(f".tmp.{os.getpid()}.{threading.get_ident()}.tar.gz")
    src_root = src_dir.resolve()
    try:
        with tarfile.open(tmp, "w:gz", compresslevel=6) as tf:
            for root, dirs, files in os.walk(src_root):
                dirs.sort()
                files.sort()
                for fn in files:
                    fp = Path(root) / fn
                    if fp.is_symlink():
                        continue
                    rel = fp.relative_to(src_root).as_posix()
                    if validate_hubverse_relpath(rel) is None:
                        continue
                    tf.add(fp, arcname=rel, recursive=False)
        size = tmp.stat().st_size
        os.replace(tmp, archive_path)
        try:
            os.chmod(archive_path, 0o600)
        except OSError:
            pass
        return size
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _unpack_tar_gz(archive_path: Path, dest_dir: Path, cfg: WebConfig) -> None:
    """Safely unpack a user workspace tar.gz validating every member path, type, and byte cap."""
    dest_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    dest_root = dest_dir.resolve()
    total_bytes = 0
    file_count = 0
    with tarfile.open(archive_path, "r:gz") as tf:
        for member in tf.getmembers():
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError(f"Unsafe non-regular archive entry: {member.name}")
            rel = validate_hubverse_relpath(member.name)
            if rel is None:
                raise ValueError(f"Disallowed archive entry: {member.name}")
            file_count += 1
            if file_count > cfg.max_files:
                raise ValueError("Archive exceeds file count cap")
            if member.size < 0 or total_bytes + member.size > cfg.max_uncompressed_bytes:
                raise ValueError("Archive exceeds size cap")
            total_bytes += member.size

            target = (dest_root / rel).resolve()
            if dest_root not in target.parents:
                raise ValueError("Archive path traversal detected")
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            src = tf.extractfile(member)
            if src is None:
                raise ValueError(f"Unreadable archive member: {rel}")
            with src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst, length=65536)
            try:
                os.chmod(target, 0o600)
            except OSError:
                pass


# Another session's temporary hub may be reclaimed for a new upload only after this much idle time.
EPHEM_RECLAIM_IDLE_SECONDS = 10 * 60

class WebWorkspaceStore:
    """
    Manages private uploaded Hubverse workspaces for Tier 1 (30-min ephemeral) and
    Tier 2 (SSO-authenticated persistent with 24h idle gzip archival).
    """

    def __init__(
        self,
        data_dir: Path,
        cfg: WebConfig,
        on_evict: Optional[Callable[[str], None]] = None,
    ):
        self.data_dir = Path(data_dir).resolve()
        self.cfg = cfg
        self.ephem_root = (cfg.scratch_dir / "ephem").resolve()
        self.users_root = (self.data_dir / "users").resolve()
        self._on_evict = on_evict
        self._global_lock = threading.RLock()
        self._meta_lock = threading.Lock()
        self._item_locks: Dict[str, threading.Lock] = {}
        self._last_touch: Dict[str, float] = {}
        self._stop_event = threading.Event()
        self._reaper_thread: Optional[threading.Thread] = None
        self._last_cold_sweep = 0.0

    def _lock_for(self, hub_id: str) -> threading.Lock:
        with self._meta_lock:
            lk = self._item_locks.get(hub_id)
            if lk is None:
                lk = threading.Lock()
                self._item_locks[hub_id] = lk
            return lk

    def _untrack_hub(self, hub_id: Optional[str]) -> None:
        if not hub_id:
            return
        with self._meta_lock:
            self._last_touch.pop(hub_id, None)
            lk = self._item_locks.get(hub_id)
            if lk is not None and lk.acquire(blocking=False):
                try:
                    self._item_locks.pop(hub_id, None)
                finally:
                    lk.release()

    def _prune_bookkeeping(self) -> None:
        with self._meta_lock:
            if len(self._item_locks) <= 512 and len(self._last_touch) <= 512:
                return
            live_ids: set[str] = set()
            for root in (self.ephem_root, self.users_root):
                if not root.is_dir():
                    continue
                try:
                    for owner_dir in root.iterdir():
                        if owner_dir.is_dir():
                            for ws_dir in owner_dir.iterdir():
                                if ws_dir.is_dir():
                                    meta = _read_json(ws_dir / "meta.json")
                                    if meta and meta.get("hub_id"):
                                        live_ids.add(str(meta["hub_id"]))
                except OSError:
                    pass
            for hid in list(self._last_touch):
                if hid not in live_ids:
                    self._last_touch.pop(hid, None)
            for hid in list(self._item_locks):
                if hid not in live_ids:
                    lk = self._item_locks.get(hid)
                    if lk is not None and lk.acquire(blocking=False):
                        try:
                            self._item_locks.pop(hid, None)
                        finally:
                            lk.release()

    def cleanup_leftovers(self, *, max_age_seconds: float = 900.0, now: Optional[float] = None) -> int:
        """Remove abandoned `.staging/*`, `hub.wake.*`, and temp files older than `max_age_seconds`."""
        ts = time.time() if now is None else now
        cleaned = 0
        for base in (self.cfg.scratch_dir / ".staging", self.data_dir / ".staging"):
            if not base.is_dir():
                continue
            for ent in list(base.iterdir()):
                try:
                    age = ts - ent.stat().st_mtime
                except OSError:
                    continue
                if max_age_seconds <= 0.0 or age >= max_age_seconds:
                    shutil.rmtree(ent, ignore_errors=True) if ent.is_dir() else ent.unlink(missing_ok=True)
                    cleaned += 1
        for root in (self.ephem_root, self.users_root):
            if not root.is_dir():
                continue
            for owner_dir in list(root.iterdir()):
                if not owner_dir.is_dir():
                    continue
                for ws_dir in list(owner_dir.iterdir()):
                    if not ws_dir.is_dir():
                        continue
                    for ent in list(ws_dir.iterdir()):
                        name = ent.name
                        if not (name.startswith("hub.wake.") or ".tmp." in name):
                            continue
                        try:
                            age = ts - ent.stat().st_mtime
                        except OSError:
                            continue
                        if max_age_seconds <= 0.0 or age >= max_age_seconds:
                            shutil.rmtree(ent, ignore_errors=True) if ent.is_dir() else ent.unlink(missing_ok=True)
                            cleaned += 1
        return cleaned

    def start(self) -> None:
        """Start the background TTL reaper and cold archival maintenance thread."""
        with self._global_lock:
            if self._reaper_thread is not None and self._reaper_thread.is_alive():
                return
            try:
                self.cleanup_leftovers(max_age_seconds=0.0)
            except Exception as exc:
                logger.warning("Startup leftover cleanup warning: %s", exc)
            self._stop_event.clear()
            t = threading.Thread(target=self._maintenance_loop, name="web-reaper", daemon=True)
            self._reaper_thread = t
            t.start()

    def stop(self) -> None:
        """Signal the maintenance daemon to exit."""
        self._stop_event.set()
        t = self._reaper_thread
        if t is not None and t.is_alive():
            t.join(timeout=2.0)

    def _maintenance_loop(self) -> None:
        while not self._stop_event.wait(60.0):
            now = time.time()
            try:
                self.reap_expired(now=now)
                self.cleanup_leftovers(max_age_seconds=900.0, now=now)
                self._prune_bookkeeping()
            except Exception as exc:
                logger.warning("Ephemeral workspace reaper error: %s", exc)
            if now - self._last_cold_sweep >= 600.0:
                self._last_cold_sweep = now
                try:
                    self.archive_cold_workspaces(now=now)
                except Exception as exc:
                    logger.warning("Cold workspace archiver error: %s", exc)

    # ---- creation ---------------------------------------------------------------------------------

    def save_uploaded_hub(
        self,
        staging_dir: Path,
        hub_name: str,
        info: Dict[str, Any],
        stats: BundleStats,
        identity: RequestIdentity,
        *,
        tier: str = "ephem",
        client_ip_hash: Optional[str] = None,
        now: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Promote a validated `staging_dir` into an owned Tier 1 or Tier 2 private workspace."""
        ts = time.time() if now is None else now
        clean_tier = "persistent" if (tier == "persistent" and identity.user is not None) else "ephem"
        clean_name = (hub_name or info.get("name") or "Uploaded Hub").strip()[:80] or "Uploaded Hub"

        if clean_tier == "persistent":
            assert identity.user is not None
            owner_hash = identity.user.user_hash
            owner_dir = self.users_root / owner_hash
            prefix = USER_PREFIX
        else:
            if not identity.sid_hash:
                raise ValueError("Missing session hash for ephemeral upload")
            owner_hash = identity.sid_hash
            owner_dir = self.ephem_root / owner_hash
            prefix = EPHEM_PREFIX

        with self._global_lock:
            if clean_tier == "persistent":
                self._enforce_user_quota(owner_dir, stats.extracted_bytes)
            else:
                self._enforce_ephem_limits(
                    owner_dir,
                    stats.extracted_bytes,
                    client_ip_hash=client_ip_hash,
                    exclude_staging_dir=staging_dir,
                    now=ts,
                )

            owner_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            existing_tails = [p.name for p in owner_dir.iterdir() if p.is_dir()]
            tail = _short_slug(clean_name, existing_tails)
            hub_id = f"{prefix}{owner_hash[:12]}_{tail}"
            ws_dir = (owner_dir / tail).resolve()

            meta: Dict[str, Any] = {
                "version": 1,
                "hub_id": hub_id,
                "tier": clean_tier,
                "owner_hash": owner_hash,
                "label": clean_name,
                "description": info.get("description"),
                "created_at": ts,
                "last_accessed_at": ts,
                "expires_at": (ts + self.cfg.ephem_ttl_seconds) if clean_tier == "ephem" else None,
                "state": "hot",
                "file_count": stats.file_count,
                "extracted_bytes": stats.extracted_bytes,
                "archive_bytes": 0,
                "model_count": int(info.get("model_count") or 0),
                "targets_count": len(info.get("targets") or []),
            }
            if clean_tier == "ephem" and client_ip_hash:
                meta["client_ip_hash"] = client_ip_hash

            # Assemble meta.json and hub/ inside a staging container first so ws_dir never appears
            # in owner_dir without a valid meta.json (prevents reaper races).
            staged_ws = staging_dir.parent / f"ws.tmp.{os.getpid()}.{threading.get_ident()}"
            if staged_ws.exists():
                shutil.rmtree(staged_ws, ignore_errors=True)
            staged_ws.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                shutil.move(str(staging_dir), str(staged_ws / "hub"))
                _atomic_write_json(staged_ws / "meta.json", meta)
                if ws_dir.exists():
                    shutil.rmtree(ws_dir, ignore_errors=True)
                shutil.move(str(staged_ws), str(ws_dir))
            finally:
                if staged_ws.exists():
                    shutil.rmtree(staged_ws, ignore_errors=True)

            with self._meta_lock:
                self._last_touch[hub_id] = ts

        return self._public_summary(meta, ws_dir, now=ts)

    def _enforce_ephem_limits(
        self,
        owner_dir: Path,
        incoming_bytes: int,
        *,
        client_ip_hash: Optional[str] = None,
        exclude_staging_dir: Optional[Path] = None,
        now: Optional[float] = None,
    ) -> None:
        self.reap_expired(now=now)
        ts = time.time() if now is None else float(now)

        # 1. Plan (but do not yet perform) eviction of this session's own oldest hubs beyond its cap.
        #    Budgets are checked against the post-eviction state, and nothing is deleted unless the
        #    upload is going to be accepted, so a rejected upload never costs the user a hub.
        own_evict: List[Tuple[Path, Dict[str, Any], int]] = []
        if owner_dir.is_dir():
            own = self._scan_owner_dirs(owner_dir)
            while len(own) >= self.cfg.ephem_max_hubs_per_session:
                d, m = own.pop(0)
                own_evict.append((d, m, _dir_bytes(d)))
        own_evict_dirs = {d for d, _, _ in own_evict}

        # 2. Per-client-IP cap (excluding hubs this upload would replace).
        all_ws: List[Tuple[Path, Dict[str, Any], int]] = []
        if self.ephem_root.is_dir():
            for sess_dir in self.ephem_root.iterdir():
                if not sess_dir.is_dir():
                    continue
                for ws_dir in sess_dir.iterdir():
                    if ws_dir.is_dir() and ws_dir not in own_evict_dirs:
                        all_ws.append((ws_dir, _read_json(ws_dir / "meta.json") or {}, _dir_bytes(ws_dir)))
        if client_ip_hash:
            ip_used = sum(b for _, m, b in all_ws if m.get("client_ip_hash") == client_ip_hash)
            if ip_used + incoming_bytes > self.cfg.ephem_max_bytes_per_ip:
                raise RateLimitExceededError(
                    "Temporary upload storage quota reached for your address; delete an existing temporary hub or wait for it to expire."
                )

        # 3. Global scratch budget. Other sessions' hubs are only reclaimed once they have been idle
        #    for a while (oldest first); recently used hubs are never evicted for someone else.
        staging_bytes = self._staging_bytes(exclude=exclude_staging_dir)
        total = sum(b for _, _, b in all_ws) + staging_bytes
        reclaim: List[Tuple[Path, Dict[str, Any], int]] = []
        if total + incoming_bytes > self.cfg.ephem_max_total_bytes:
            idle_cutoff = ts - EPHEM_RECLAIM_IDLE_SECONDS
            candidates = sorted(
                (
                    item for item in all_ws
                    if float(item[1].get("last_accessed_at") or item[1].get("created_at") or ts) <= idle_cutoff
                ),
                key=lambda item: float(item[1].get("last_accessed_at") or item[1].get("created_at") or 0.0),
            )
            for item in candidates:
                if total + incoming_bytes <= self.cfg.ephem_max_total_bytes:
                    break
                reclaim.append(item)
                total -= item[2]
            if total + incoming_bytes > self.cfg.ephem_max_total_bytes:
                raise StorageBudgetExceededError(
                    "Temporary upload scratch storage is currently full; please try again shortly."
                )

        # 4. Accepted: now perform the planned evictions.
        for d, m, _ in own_evict + reclaim:
            hid = m.get("hub_id")
            if hid:
                with self._lock_for(str(hid)):
                    self._drop_workspace_dir(d, str(hid))
            else:
                self._drop_workspace_dir(d, None)

    def _enforce_user_quota(self, owner_dir: Path, incoming_bytes: int) -> None:
        if self.users_root.is_dir():
            total_users_bytes = _dir_bytes(self.users_root)
            if total_users_bytes + incoming_bytes > self.cfg.users_max_total_bytes:
                raise StorageBudgetExceededError(
                    "Server persistent hub storage is full; please contact an administrator or use temporary storage."
                )
        if not owner_dir.is_dir():
            if incoming_bytes > self.cfg.user_quota_bytes:
                raise UploadTooLargeError(
                    f"Upload ({incoming_bytes // (1024 * 1024)} MB) exceeds per-account storage quota "
                    f"({self.cfg.user_quota_bytes // (1024 * 1024)} MB)."
                )
            return
        own = self._scan_owner_dirs(owner_dir)
        if len(own) >= self.cfg.user_max_hubs:
            raise UploadTooLargeError(
                f"Account limit reached ({self.cfg.user_max_hubs} saved hubs). Delete an existing saved hub first."
            )
        used = sum(_dir_bytes(d) for d, _ in own)
        if used + incoming_bytes > self.cfg.user_quota_bytes:
            raise UploadTooLargeError(
                f"Account storage quota ({self.cfg.user_quota_bytes // (1024 * 1024)} MB) exceeded. "
                "Delete a saved hub to free space."
            )

    @staticmethod
    def _scan_owner_dirs(owner_dir: Path) -> List[Tuple[Path, Dict[str, Any]]]:
        items: List[Tuple[Path, Dict[str, Any]]] = []
        if not owner_dir.is_dir():
            return items
        for d in owner_dir.iterdir():
            if d.is_dir():
                meta = _read_json(d / "meta.json") or {}
                items.append((d, meta))
        items.sort(key=lambda item: float(item[1].get("last_accessed_at") or item[1].get("created_at") or 0.0))
        return items

    def _staging_bytes(self, exclude: Optional[Path] = None) -> int:
        staging_dir = (self.cfg.scratch_dir / ".staging").resolve()
        if not staging_dir.is_dir():
            return 0
        ex = exclude.resolve() if exclude is not None else None
        total = 0
        for ent in staging_dir.iterdir():
            if ex is not None and ent.resolve() == ex:
                continue
            total += _dir_bytes(ent) if ent.is_dir() else (ent.stat().st_size if ent.is_file() else 0)
        return total

    def _ephem_total_bytes(self) -> int:
        return _dir_bytes(self.ephem_root) if self.ephem_root.is_dir() else 0

    def _drop_workspace_dir(self, ws_dir: Path, hub_id: Optional[str]) -> None:
        if hub_id and self._on_evict is not None:
            try:
                self._on_evict(hub_id)
            except Exception:
                pass
        shutil.rmtree(ws_dir, ignore_errors=True)
        self._untrack_hub(hub_id)
        parent = ws_dir.parent
        try:
            if parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()
        except OSError:
            pass

    # ---- resolution & authorization ---------------------------------------------------------------

    def _locate_workspace_dir(self, hub_id: str, identity: RequestIdentity) -> Optional[Tuple[Path, Dict[str, Any], str]]:
        m = _HUB_ID_PATTERN.match((hub_id or "").strip())
        if not m:
            return None
        kind, prefix_hex, tail = m.group(1), m.group(2), m.group(3)
        if kind == "ephem":
            if not identity.sid_hash or not hmac.compare_digest(identity.sid_hash[:12], prefix_hex):
                return None
            expected_owner = identity.sid_hash
            ws_dir = (self.ephem_root / expected_owner / tail).resolve()
            root_bound = self.ephem_root
        else:
            if identity.user is None or not hmac.compare_digest(identity.user.user_hash[:12], prefix_hex):
                return None
            expected_owner = identity.user.user_hash
            ws_dir = (self.users_root / expected_owner / tail).resolve()
            root_bound = self.users_root

        if root_bound not in ws_dir.parents or not ws_dir.is_dir():
            return None
        meta = _read_json(ws_dir / "meta.json")
        if not meta or not hmac.compare_digest(str(meta.get("owner_hash") or ""), expected_owner):
            return None
        if meta.get("hub_id") != hub_id:
            return None
        return ws_dir, meta, expected_owner

    def authorize_and_resolve(
        self,
        hub_id: str,
        identity: RequestIdentity,
        *,
        now: Optional[float] = None,
    ) -> Optional[Tuple[LocalHubRecord, Path]]:
        """
        Verify strict caller ownership of `hub_id`, wake cold Tier 2 archives if needed,
        update sliding expiration / access timestamps, and return `(LocalHubRecord, storage_root)`.
        """
        located = self._locate_workspace_dir(hub_id, identity)
        if located is None:
            return None
        ws_dir, _, _ = located
        ts = time.time() if now is None else now

        with self._lock_for(hub_id):
            meta = _read_json(ws_dir / "meta.json")
            if not meta:
                return None

            if meta.get("tier") == "ephem":
                exp = float(meta.get("expires_at") or 0.0)
                if exp and ts >= exp:
                    self._drop_workspace_dir(ws_dir, hub_id)
                    return None

            hub_dir = ws_dir / "hub"
            if meta.get("state") == "cold" or not hub_dir.is_dir():
                archive_path = ws_dir / "archive.tar.gz"
                if not archive_path.is_file():
                    return None
                self._wake_cold_unlocked(ws_dir, meta, archive_path, ts)

            if not hub_dir.is_dir():
                return None

            last_touch = self._last_touch.get(hub_id, 0.0)
            if ts - last_touch >= _TOUCH_INTERVAL_SECONDS or now is not None:
                meta["last_accessed_at"] = ts
                if meta.get("tier") == "ephem":
                    meta["expires_at"] = ts + self.cfg.ephem_ttl_seconds
                _atomic_write_json(ws_dir / "meta.json", meta)
                with self._meta_lock:
                    self._last_touch[hub_id] = ts

            rec = LocalHubRecord(
                id=hub_id,
                path=str(hub_dir.resolve()),
                label=str(meta.get("label") or hub_id),
                added_at=_utcnow_iso(meta.get("created_at")),
                last_opened=_utcnow_iso(ts),
                auto_detected=False,
            )
            return rec, ws_dir

    def _wake_cold_unlocked(
        self,
        ws_dir: Path,
        meta: Dict[str, Any],
        archive_path: Path,
        ts: float,
    ) -> None:
        tmp_hub = ws_dir / f"hub.wake.{os.getpid()}.{threading.get_ident()}"
        hub_dir = ws_dir / "hub"
        try:
            _unpack_tar_gz(archive_path, tmp_hub, self.cfg)
            if hub_dir.exists():
                shutil.rmtree(hub_dir, ignore_errors=True)
            os.replace(tmp_hub, hub_dir)
            meta["state"] = "hot"
            meta["last_accessed_at"] = ts
            meta["archive_bytes"] = 0
            _atomic_write_json(ws_dir / "meta.json", meta)
            # Remove compressed archive once hot hub/ is restored so quota doesn't double-count
            archive_path.unlink(missing_ok=True)
        finally:
            if tmp_hub.exists():
                shutil.rmtree(tmp_hub, ignore_errors=True)

    # ---- listing & deletion -----------------------------------------------------------------------

    def _public_summary(self, meta: Dict[str, Any], ws_dir: Path, *, now: float) -> Dict[str, Any]:
        tier = str(meta.get("tier") or "ephem")
        exp = meta.get("expires_at")
        ttl_rem = max(0, int(round(float(exp) - now))) if tier == "ephem" and exp is not None else None
        hub_dir = ws_dir / "hub"
        state = str(meta.get("state") or ("hot" if hub_dir.is_dir() else "cold"))
        size_bytes = (
            int(meta.get("archive_bytes") or 0)
            if state == "cold"
            else (int(meta.get("extracted_bytes") or 0) or _dir_bytes(ws_dir))
        )
        return {
            "id": meta["hub_id"],
            "label": meta.get("label") or meta["hub_id"],
            "description": meta.get("description"),
            "tier": tier,
            "kind": "ephem" if tier == "ephem" else "persistent",
            "state": state,
            "model_count": int(meta.get("model_count") or 0),
            "targets_count": int(meta.get("targets_count") or 0),
            "file_count": int(meta.get("file_count") or 0),
            "bytes": size_bytes,
            "ttl_seconds_remaining": ttl_rem,
            "created_at": _utcnow_iso(meta.get("created_at")),
            "last_accessed_at": _utcnow_iso(meta.get("last_accessed_at")),
        }

    def list_for_identity(self, identity: RequestIdentity, *, now: Optional[float] = None) -> Dict[str, Any]:
        """Return only the requesting session's ephemeral hubs and (if signed in) persistent hubs."""
        ts = time.time() if now is None else now
        ephem_items: List[Dict[str, Any]] = []
        if identity.sid_hash:
            sess_dir = (self.ephem_root / identity.sid_hash).resolve()
            if self.ephem_root in sess_dir.parents and sess_dir.is_dir():
                for ws_dir, meta in self._scan_owner_dirs(sess_dir):
                    hid = meta.get("hub_id")
                    if not hid or not hmac.compare_digest(str(meta.get("owner_hash") or ""), identity.sid_hash):
                        continue
                    exp = float(meta.get("expires_at") or 0.0)
                    if exp and ts >= exp:
                        self._drop_workspace_dir(ws_dir, hid)
                        continue
                    ephem_items.append(self._public_summary(meta, ws_dir, now=ts))

        user_items: List[Dict[str, Any]] = []
        used_user_bytes = 0
        if identity.user is not None:
            u_dir = (self.users_root / identity.user.user_hash).resolve()
            if self.users_root in u_dir.parents and u_dir.is_dir():
                for ws_dir, meta in self._scan_owner_dirs(u_dir):
                    if not meta.get("hub_id") or not hmac.compare_digest(
                        str(meta.get("owner_hash") or ""), identity.user.user_hash
                    ):
                        continue
                    used_user_bytes += _dir_bytes(ws_dir)
                    user_items.append(self._public_summary(meta, ws_dir, now=ts))

        return {
            "ephemeral": ephem_items,
            "persistent": user_items,
            "all": ephem_items + user_items,
            "user_used_bytes": used_user_bytes,
            "user_quota_bytes": self.cfg.user_quota_bytes if identity.user is not None else 0,
        }

    def delete_workspace(self, hub_id: str, identity: RequestIdentity) -> bool:
        """Delete a caller-owned workspace (`ephem_*` or `user_*`)."""
        located = self._locate_workspace_dir(hub_id, identity)
        if located is None:
            return False
        ws_dir, _, _ = located
        with self._lock_for(hub_id):
            self._drop_workspace_dir(ws_dir, hub_id)
        return True

    # ---- maintenance ------------------------------------------------------------------------------

    def reap_expired(self, *, now: Optional[float] = None) -> int:
        """Delete expired Tier 1 ephemeral workspaces and return count deleted."""
        ts = time.time() if now is None else now
        if not self.ephem_root.is_dir():
            return 0
        deleted = 0
        with self._global_lock:
            for sess_dir in list(self.ephem_root.iterdir()):
                if not sess_dir.is_dir():
                    continue
                for ws_dir in list(sess_dir.iterdir()):
                    if not ws_dir.is_dir():
                        continue
                    meta = _read_json(ws_dir / "meta.json")
                    if not meta:
                        try:
                            age = ts - ws_dir.stat().st_mtime
                        except OSError:
                            age = 0.0
                        if age >= 60.0:
                            self._drop_workspace_dir(ws_dir, None)
                            deleted += 1
                        continue
                    exp = float(meta.get("expires_at") or 0.0)
                    if exp and ts >= exp:
                        hid = meta.get("hub_id")
                        with self._lock_for(str(hid or ws_dir)):
                            meta_fresh = _read_json(ws_dir / "meta.json")
                            if not meta_fresh:
                                continue
                            fresh_exp = float(meta_fresh.get("expires_at") or 0.0)
                            if fresh_exp and ts >= fresh_exp:
                                self._drop_workspace_dir(ws_dir, meta_fresh.get("hub_id"))
                                deleted += 1
                try:
                    if sess_dir.is_dir() and not any(sess_dir.iterdir()):
                        sess_dir.rmdir()
                except OSError:
                    pass
        return deleted

    def archive_cold_workspaces(self, *, now: Optional[float] = None) -> int:
        """Compress idle Tier 2 SSO workspaces past `user_cold_after_seconds` into archive.tar.gz."""
        ts = time.time() if now is None else now
        if not self.users_root.is_dir():
            return 0
        archived = 0
        for user_dir in list(self.users_root.iterdir()):
            if not user_dir.is_dir():
                continue
            for ws_dir in list(user_dir.iterdir()):
                if not ws_dir.is_dir():
                    continue
                meta = _read_json(ws_dir / "meta.json")
                if not meta or meta.get("state") == "cold":
                    continue
                hid = meta.get("hub_id")
                last = float(meta.get("last_accessed_at") or meta.get("created_at") or 0.0)
                if ts - last < self.cfg.user_cold_after_seconds:
                    continue
                if not hid:
                    continue
                with self._lock_for(hid):
                    meta_fresh = _read_json(ws_dir / "meta.json")
                    if not meta_fresh or meta_fresh.get("state") == "cold":
                        continue
                    last_fresh = float(meta_fresh.get("last_accessed_at") or meta_fresh.get("created_at") or 0.0)
                    if ts - last_fresh < self.cfg.user_cold_after_seconds:
                        continue
                    hub_dir = ws_dir / "hub"
                    archive_path = ws_dir / "archive.tar.gz"
                    if hub_dir.is_dir():
                        arch_size = _pack_tar_gz(hub_dir, archive_path)
                    elif archive_path.is_file():
                        arch_size = archive_path.stat().st_size
                    else:
                        continue
                    if self._on_evict is not None:
                        try:
                            self._on_evict(hid)
                        except Exception:
                            pass
                    for sub in ("hub", "cache", "hub_models", "synthetic"):
                        p = ws_dir / sub
                        if p.exists():
                            shutil.rmtree(p, ignore_errors=True)
                    for ent in list(ws_dir.iterdir()):
                        if ent.name.startswith("hub.wake."):
                            shutil.rmtree(ent, ignore_errors=True)
                    meta_fresh["state"] = "cold"
                    meta_fresh["archive_bytes"] = arch_size
                    meta_fresh["archived_at"] = ts
                    _atomic_write_json(ws_dir / "meta.json", meta_fresh)
                    archived += 1
        return archived
