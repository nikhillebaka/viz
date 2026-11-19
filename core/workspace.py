"""
Multi-hub workspace registry, per-hub runtime contexts, local directory browsing,
and optional native OS folder picker.

Supports two runtime modes:
- "local": users can inspect, browse, add, activate, and forget local Hubverse folders.
- "web": filesystem browsing, local hub registration, and OS path disclosure are disabled.
"""

from collections import OrderedDict
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
from typing import Any, Callable, Dict, List, Optional, Set

import polars as pl

from viz.core.cache_manager import LockRegistry
from viz.core.config import VizConfig
from viz.core.data_loader import SandboxDataLoader, _is_flu_hosp_target
from viz.core.evaluation import EvaluationEngine
from viz.core.next_api import NextData
from viz.core.paths import (
    APP_DIR,
    detect_enclosing_hub,
    get_data_dir,
    inspect_local_hub,
    is_hub_dir,
    slug_for_hub,
)
from viz.remote.store import RemoteStore
from viz.remote.sync import RemoteManager

logger = logging.getLogger("viz.workspace")

MAX_BROWSE_ENTRIES = 400


def _utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _coerce_path(path_str: Any) -> str:
    if isinstance(path_str, os.PathLike):
        return os.fspath(path_str)
    return str(path_str or "")


def _concise_hub_meta(raw_label: str, info: Dict[str, Any]) -> tuple[str, Optional[str]]:
    """Prefer concise folder/repo display name over multi-word admin.json descriptions."""
    desc = info.get("description")
    name = str(info.get("name") or raw_label or "Hub")
    if desc and raw_label.strip() == desc.strip():
        return name, desc
    if len(raw_label.strip()) > 40 and len(name) <= 40:
        return name, raw_label.strip()
    return raw_label or name, desc


def _atomic_write_json(path: Path, data: Any):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".tmp.{os.getpid()}.{threading.get_ident()}")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _peek_oracle_targets(base_dir: Path) -> List[str]:
    """Quickly peek distinct target names from target-data/oracle-output when tasks.json lacks them."""
    for name, reader in (
        ("oracle-output.parquet", pl.scan_parquet),
        ("oracle-output.csv", lambda p: pl.scan_csv(p, infer_schema_length=0)),
    ):
        p = base_dir / "target-data" / name
        if p.is_file():
            try:
                lf = reader(p)
                if "target" in lf.collect_schema().names():
                    vals = lf.select("target").drop_nulls().unique().collect().get_column("target").to_list()
                    return sorted(str(v).strip() for v in vals if str(v).strip())
            except Exception:
                return []
    return []


def _hub_uses_flu_surveillance(base_dir: Path, info: Dict[str, Any]) -> bool:
    """Attach bundled CDC FluSight NHSN/ILINet/FluSurv streams only to hubs with flu hosp targets."""
    targets = list(info.get("targets") or [])
    if not targets:
        targets = _peek_oracle_targets(base_dir)
    if targets:
        return any(_is_flu_hosp_target(t) for t in targets)
    # Fallback: an enclosing sandbox repo without tasks.json/oracle still gets bundled streams
    return base_dir == detect_enclosing_hub()


@dataclass
class LocalHubRecord:
    id: str
    path: str
    label: str
    added_at: str
    last_opened: str
    auto_detected: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "LocalHubRecord":
        return cls(
            id=str(data["id"]),
            path=str(data["path"]),
            label=str(data.get("label") or Path(str(data["path"])).name or data["id"]),
            added_at=str(data.get("added_at") or ""),
            last_opened=str(data.get("last_opened") or ""),
            auto_detected=bool(data.get("auto_detected", False)),
        )


class WorkspaceRegistry:
    """Persistent JSON registry of local hubs under `<data_dir>/workspace.json`."""

    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir).resolve()
        self.path = self.data_dir / "workspace.json"
        self._lock = threading.Lock()

    def _read_unlocked(self) -> Dict[str, Any]:
        default = {"version": 1, "active_hub": None, "hubs": []}
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if not isinstance(raw, dict):
                return default
            hubs = raw.get("hubs")
            if not isinstance(hubs, list):
                hubs = []
            return {
                "version": int(raw.get("version", 1)),
                "active_hub": raw.get("active_hub") if isinstance(raw.get("active_hub"), str) else None,
                "hubs": hubs,
            }
        except (OSError, ValueError):
            return default

    def list_hubs(self) -> List[LocalHubRecord]:
        with self._lock:
            raw = self._read_unlocked()
            records: List[LocalHubRecord] = []
            for item in raw["hubs"]:
                if isinstance(item, dict) and item.get("id") and item.get("path"):
                    records.append(LocalHubRecord.from_dict(item))
            return records

    def get_hub(self, hub_id: str) -> Optional[LocalHubRecord]:
        for rec in self.list_hubs():
            if rec.id == hub_id:
                return rec
        return None

    def find_by_path(self, path: Path) -> Optional[LocalHubRecord]:
        try:
            target = str(Path(path).expanduser().resolve())
        except (OSError, RuntimeError):
            return None
        for rec in self.list_hubs():
            try:
                if str(Path(rec.path).resolve()) == target:
                    return rec
            except (OSError, RuntimeError):
                if rec.path == target:
                    return rec
        return None

    def get_active_id(self) -> Optional[str]:
        with self._lock:
            return self._read_unlocked().get("active_hub")

    def set_active(self, hub_id: Optional[str]) -> bool:
        with self._lock:
            raw = self._read_unlocked()
            if hub_id is None:
                raw["active_hub"] = None
                _atomic_write_json(self.path, raw)
                return True
            now = _utcnow()
            found = False
            for item in raw["hubs"]:
                if isinstance(item, dict) and item.get("id") == hub_id:
                    item["last_opened"] = now
                    found = True
                    break
            if not found:
                return False
            raw["active_hub"] = hub_id
            _atomic_write_json(self.path, raw)
            return True

    def add_hub(
        self,
        path: Path,
        label: Optional[str] = None,
        auto_detected: bool = False,
        activate: bool = False,
    ) -> LocalHubRecord:
        try:
            resolved = Path(path).expanduser().resolve()
        except (OSError, RuntimeError) as exc:
            raise ValueError(f"Invalid path '{path}': {exc}") from exc

        if not resolved.exists():
            raise ValueError(f"Folder does not exist: {resolved}")
        if not resolved.is_dir():
            raise ValueError(f"Path is not a folder: {resolved}")
        if not is_hub_dir(resolved):
            raise ValueError(
                f"'{resolved.name or resolved}' does not look like a Hubverse hub "
                "(expected hub-config/tasks.json, model-output/, or target-data/)."
            )

        info = inspect_local_hub(resolved)
        clean_label = (label or "").strip()

        with self._lock:
            raw = self._read_unlocked()
            now = _utcnow()
            target_str = str(resolved)
            for item in raw["hubs"]:
                if not isinstance(item, dict):
                    continue
                try:
                    same = str(Path(str(item.get("path", ""))).resolve()) == target_str
                except (OSError, RuntimeError):
                    same = item.get("path") == target_str
                if same:
                    if clean_label:
                        item["label"] = clean_label
                    else:
                        concise_label, _ = _concise_hub_meta(str(item.get("label") or ""), info)
                        if concise_label:
                            item["label"] = concise_label
                    if activate:
                        item["last_opened"] = now
                        raw["active_hub"] = item["id"]
                    _atomic_write_json(self.path, raw)
                    return LocalHubRecord.from_dict(item)

            taken = [str(item.get("id")) for item in raw["hubs"] if isinstance(item, dict) and item.get("id")]
            display_label = clean_label or str(info.get("name") or resolved.name or "Hub")
            hub_id = slug_for_hub(display_label, resolved, taken)
            rec = LocalHubRecord(
                id=hub_id,
                path=target_str,
                label=display_label,
                added_at=now,
                last_opened=now if activate else "",
                auto_detected=auto_detected,
            )
            raw["hubs"].append(rec.to_dict())
            if activate or not raw.get("active_hub"):
                raw["active_hub"] = rec.id
            _atomic_write_json(self.path, raw)
            return rec

    def remove_hub(self, hub_id: str) -> bool:
        """Remove a hub entry from workspace.json only; never deletes files in the hub folder."""
        with self._lock:
            raw = self._read_unlocked()
            before = len(raw["hubs"])
            raw["hubs"] = [h for h in raw["hubs"] if not (isinstance(h, dict) and h.get("id") == hub_id)]
            if len(raw["hubs"]) == before:
                return False
            if raw.get("active_hub") == hub_id:
                raw["active_hub"] = None
            _atomic_write_json(self.path, raw)
            return True


def resolve_hub_storage(
    base_dir: Path,
    data_dir: Path,
    hub_id: Optional[str] = None,
    cli_fallback: bool = False,
) -> Dict[str, Any]:
    """Resolve isolated cache, surveillance, seed, and synthetic directories for a hub."""
    resolved_base = Path(base_dir).resolve()
    resolved_data = Path(data_dir).resolve()
    enclosing = detect_enclosing_hub()
    default_data_dir = (APP_DIR / ".cache").resolve()
    is_enclosing_default = (
        enclosing is not None and resolved_base == enclosing and resolved_data == default_data_dir
    )

    info = inspect_local_hub(resolved_base)
    uses_flu_surv = _hub_uses_flu_surveillance(resolved_base, info)

    remote_dir = (resolved_data / "remote").resolve()
    if is_enclosing_default:
        cache_dir = default_data_dir
        hub_models_cache_dir = (default_data_dir / "hub_models").resolve()
        synthetic_dir = resolved_base / "local-output" / "synthetic"
    else:
        if hub_id:
            cache_dir = (resolved_data / "hubs" / hub_id).resolve()
        elif cli_fallback:
            digest = hashlib.sha1(str(resolved_base).encode("utf-8")).hexdigest()[:8]
            slug = f"{slug_for_hub(resolved_base.name or 'hub', resolved_base, ())[:28]}_{digest}"
            cache_dir = (resolved_data / "cli" / slug).resolve()
        else:
            slug = slug_for_hub(resolved_base.name or "hub", resolved_base, ())
            cache_dir = (resolved_data / "hubs" / slug).resolve()
        hub_models_cache_dir = (resolved_data / "remote_cache").resolve()
        hub_local_synth = resolved_base / "local-output" / "synthetic"
        synthetic_dir = (
            hub_local_synth if (resolved_base / "local-output").is_dir() else (cache_dir / "synthetic")
        )

    app_surv = APP_DIR / "data" / "surveillance"
    app_seed = APP_DIR / "data" / "seed"
    if uses_flu_surv and app_surv.is_dir():
        surveillance_dir = app_surv
        seed_dir = app_seed if app_seed.is_dir() else (cache_dir / "seed")
    elif uses_flu_surv:
        surveillance_dir = cache_dir / "surveillance"
        seed_dir = app_seed if app_seed.is_dir() else (cache_dir / "seed")
    else:
        surveillance_dir = cache_dir / "surveillance"
        seed_dir = cache_dir / "seed"

    return {
        "is_enclosing_default": is_enclosing_default,
        "cache_dir": cache_dir,
        "remote_dir": remote_dir,
        "hub_models_cache_dir": hub_models_cache_dir,
        "surveillance_dir": surveillance_dir,
        "seed_dir": seed_dir,
        "synthetic_dir": synthetic_dir,
        "uses_flu_surveillance": uses_flu_surv,
        "targets": info.get("targets") or [],
    }


class ScopedRemoteManager:
    """Per-HubContext view over a shared RemoteManager so sync jobs never race across workspaces."""

    def __init__(self, shared: RemoteManager, is_compatible: Callable[[str], bool]):
        self._shared = shared
        self._is_compatible = is_compatible

    @property
    def store(self) -> RemoteStore:
        return self._shared.store

    def hub_status(self, spec: Any) -> Dict[str, Any]:
        out = self._shared.hub_status(spec)
        out["compatible"] = bool(self._is_compatible(spec.id))
        return out

    def list_hubs(self) -> List[Dict[str, Any]]:
        return [self.hub_status(s) for s in self._shared.store.hub_specs()]

    def get_job(self, hub_id: str) -> Optional[Dict[str, Any]]:
        return self._shared.get_job(hub_id)

    def is_busy(self) -> bool:
        return self._shared.is_busy()

    def warnings(self, hub_id: str) -> List[Dict[str, Any]]:
        return self._shared.warnings(hub_id)

    def add_hub(self, bucket: str, label: Optional[str] = None) -> Dict[str, Any]:
        res = self._shared.add_hub(bucket, label)
        if res.get("ok") and isinstance(res.get("hub"), dict):
            res = {**res, "hub": {**res["hub"], "compatible": bool(self._is_compatible(res["hub"]["id"]))}}
        return res

    def check(self, hub_id: str) -> Dict[str, Any]:
        return self._shared.check(hub_id)

    def start_sync(self, hub_id: str, seasons: Optional[List[str]] = None) -> Dict[str, Any]:
        return self._shared.start_sync(hub_id, seasons)

    def cancel(self, hub_id: str) -> bool:
        return self._shared.cancel(hub_id)

    def remove(self, hub_id: str):
        return self._shared.remove(hub_id)

    def set_enabled(self, hub_id: str, enabled: bool):
        return self._shared.set_enabled(hub_id, enabled)


class HubContext:
    """Isolated runtime stack (loader, caches, evaluation, remote sync, next API) for one local hub."""

    def __init__(
        self,
        record: LocalHubRecord,
        data_dir: Path,
        mode: str = "local",
        *,
        peer_truth_provider: Optional[Callable[[Path, Set[str]], List[Dict[str, Any]]]] = None,
        on_shared_change: Optional[Callable[[], None]] = None,
        shared_remote_store: Optional[RemoteStore] = None,
        shared_remote_mgr: Optional[RemoteManager] = None,
    ):
        self.hub_id = record.id
        self.record = record
        self.base_dir = Path(record.path).resolve()
        self.data_dir = Path(data_dir).resolve()
        self.mode = mode
        self._peer_truth_provider = peer_truth_provider
        self._on_shared_change = on_shared_change

        info = inspect_local_hub(self.base_dir)
        self.display_label, self.description = _concise_hub_meta(record.label, info)
        storage = resolve_hub_storage(self.base_dir, self.data_dir, hub_id=self.hub_id)
        self.is_enclosing_default = storage["is_enclosing_default"]
        self.cache_dir = storage["cache_dir"]
        self.remote_dir = storage["remote_dir"]
        self.hub_models_cache_dir = storage["hub_models_cache_dir"]
        self.synthetic_dir = storage["synthetic_dir"]
        self.surveillance_dir = storage["surveillance_dir"]
        self.seed_dir = storage["seed_dir"]

        self.loader = SandboxDataLoader(
            self.base_dir,
            include_remote=True,
            cache_dir=self.cache_dir,
            remote_dir=self.remote_dir,
            hub_models_cache_dir=self.hub_models_cache_dir,
            surveillance_dir=self.surveillance_dir,
            seed_dir=self.seed_dir,
            app_dir=APP_DIR,
            synthetic_dir=self.synthetic_dir,
            peer_truth_provider=self._peers_for_loader,
            remote_store=shared_remote_store,
        )
        self.config: VizConfig = self.loader.config
        self.eval_engine = EvaluationEngine(self.base_dir, self.loader)
        if shared_remote_mgr is not None:
            self.remote_mgr: Any = ScopedRemoteManager(shared_remote_mgr, is_compatible=self._is_remote_compatible)
        else:
            self.remote_mgr = RemoteManager(
                self.loader.remote_store,
                known_locations=lambda: set(self.loader.get_locations().keys()),
                is_non_negative=self.config.is_target_non_negative,
                local_as_of_max=self._local_as_of_max,
                on_inventory_change=self._on_hub_inventory_change,
                is_compatible=self._is_remote_compatible,
            )
        hub_meta = {
            "id": self.hub_id,
            "label": self.display_label,
            "description": self.description,
            "mode": self.mode,
            "path": str(self.base_dir) if self.mode == "local" else None,
        }
        self.next_data = NextData(self.loader, self.config, remote_mgr=self.remote_mgr, hub_meta=hub_meta)

    def _peers_for_loader(self) -> List[Dict[str, Any]]:
        if self._peer_truth_provider is None:
            return []
        targets = set(self.config.get_targets())
        return self._peer_truth_provider(self.base_dir, targets)

    def _is_remote_compatible(self, remote_hub_id: str) -> bool:
        targets = set(self.config.get_targets())
        locs = set(self.loader.get_locations().keys())
        return self.loader.remote_store.is_compatible(remote_hub_id, targets=targets, locations=locs)

    def _local_as_of_max(self) -> Optional[str]:
        """Latest vintage in the bundled as-of surveillance file; hub snapshots are only fetched beyond it."""
        path = self.loader.cache_mgr.surveillance_dir / "as-of-hospital-admissions.parquet"
        if not path.exists():
            return None
        try:
            return pl.scan_parquet(path).select(pl.col("as_of").max()).collect().item()
        except Exception:
            return None

    def invalidate_all(self):
        """Clear every in-memory and derived score cache layer on this HubContext."""
        self.loader.invalidate_inventory()
        self.loader.ensemble_mgr.clear_cached_forecasts()
        with self.eval_engine._eval_cache_lock:
            self.eval_engine._eval_cache.clear()
        if hasattr(self.eval_engine, "prescore"):
            self.eval_engine.prescore.invalidate()
        self.next_data.invalidate()

    def _on_hub_inventory_change(self, hub_id: str, changed_models: List[str], *, propagate: bool = True):
        """Invalidate every in-memory cache for this workspace hub after a remote sync/toggle/remove."""
        self.invalidate_all()
        cache = self.loader.cache_mgr
        if not self.loader.remote_store.has_data(hub_id):
            shutil.rmtree(cache.hub_models_cache_dir / hub_id, ignore_errors=True)
        for name in changed_models:
            cache.get_model_parquet(f"{hub_id}:{name}")
            cache.get_model_peak_parquet(f"{hub_id}:{name}")
        cache.get_oracle_parquet()
        cache.get_admissions_parquet()
        cache.get_as_of_admissions_parquet()
        self.loader.scan_models(force_refresh=True)
        if propagate and self._on_shared_change is not None:
            self._on_shared_change()


def native_picker_available() -> bool:
    """Return True if an OS folder selection dialog command is available."""
    if sys.platform == "darwin":
        return shutil.which("osascript") is not None
    if sys.platform == "win32":
        return (shutil.which("powershell") or shutil.which("pwsh")) is not None
    return (shutil.which("zenity") or shutil.which("kdialog")) is not None


class HubManager:
    """Manages registered local hubs, lazily loads HubContexts, and serves local directory browsing."""

    def __init__(
        self,
        data_dir: Optional[Path] = None,
        mode: str = "local",
        cli_hubs: Optional[List[Path]] = None,
        include_enclosing: bool = True,
        max_loaded: int = 8,
    ):
        clean_mode = (mode or "local").strip().lower()
        if clean_mode not in ("local", "web"):
            raise ValueError(f"Invalid mode '{mode}' (expected 'local' or 'web')")
        self.mode = clean_mode
        self.data_dir = Path(data_dir).resolve() if data_dir is not None else get_data_dir()
        self.registry = WorkspaceRegistry(self.data_dir)
        self.max_loaded = max(1, int(max_loaded))
        self._lock = threading.RLock()
        self._ctx_locks = LockRegistry()
        self._contexts: "OrderedDict[str, HubContext]" = OrderedDict()
        self._server_config_lock = threading.Lock()
        self._cached_server_cfg: Optional[Dict[str, Any]] = None
        self.remote_store = RemoteStore(self.data_dir, root=(self.data_dir / "remote").resolve())
        self.shared_remote_mgr = RemoteManager(
            self.remote_store,
            known_locations=self._shared_known_locations,
            is_non_negative=self._shared_is_non_negative,
            local_as_of_max=self._shared_local_as_of_max,
            on_inventory_change=self._on_remote_inventory_change,
        )

        # Startup registration & active hub selection
        cli_list = [Path(p) for p in (cli_hubs or []) if str(p).strip()]
        if cli_list:
            first_rec: Optional[LocalHubRecord] = None
            for idx, hp in enumerate(cli_list):
                rec = self.registry.add_hub(hp, activate=(idx == 0))
                if first_rec is None:
                    first_rec = rec
            if first_rec is not None:
                self.registry.set_active(first_rec.id)
        else:
            enclosing = detect_enclosing_hub() if include_enclosing else None
            if enclosing is not None:
                # Inside-hub invocation always activates the enclosing hub on startup so tests and
                # direct `./viz/run.sh` launches land on the enclosing repo immediately.
                self.registry.add_hub(enclosing, auto_detected=True, activate=True)
            else:
                active_id = self.registry.get_active_id()
                active_rec = self.registry.get_hub(active_id) if active_id else None
                if not active_rec or not is_hub_dir(Path(active_rec.path)):
                    fallback = next(
                        (r for r in self.registry.list_hubs() if is_hub_dir(Path(r.path))),
                        None,
                    )
                    self.registry.set_active(fallback.id if fallback else None)

    def default_hub_id(self) -> Optional[str]:
        active_id = self.registry.get_active_id()
        if active_id:
            rec = self.registry.get_hub(active_id)
            if rec and Path(rec.path).is_dir():
                return rec.id
        for rec in self.registry.list_hubs():
            if Path(rec.path).is_dir():
                return rec.id
        return None

    def get_context(self, hub_id: Optional[str] = None) -> Optional[HubContext]:
        target_id = (hub_id or "").strip() or self.default_hub_id()
        if not target_id:
            return None

        with self._lock:
            cached = self._contexts.get(target_id)
            if cached is not None:
                if cached.base_dir.is_dir():
                    self._contexts.move_to_end(target_id)
                    return cached
                self._contexts.pop(target_id, None)

        with self._ctx_locks.get(target_id):
            with self._lock:
                cached = self._contexts.get(target_id)
                if cached is not None and cached.base_dir.is_dir():
                    self._contexts.move_to_end(target_id)
                    return cached
                self._contexts.pop(target_id, None)

            rec = self.registry.get_hub(target_id)
            if rec is None or not Path(rec.path).is_dir():
                return None

            ctx = HubContext(
                rec,
                self.data_dir,
                mode=self.mode,
                peer_truth_provider=self._peer_truth_sources,
                on_shared_change=lambda exclude_id=target_id: self._invalidate_all_contexts(exclude_id=exclude_id),
                shared_remote_store=self.remote_store,
                shared_remote_mgr=self.shared_remote_mgr,
            )
            with self._lock:
                self._contexts[target_id] = ctx
                self._contexts.move_to_end(target_id)
                while len(self._contexts) > self.max_loaded:
                    self._contexts.popitem(last=False)
            if hub_id is None or target_id == self.default_hub_id():
                with self._server_config_lock:
                    self._cached_server_cfg = ctx.config.get_server_config()
            return ctx

    def get_server_config(self) -> Optional[Dict[str, Any]]:
        """Cached server CORS/host config for fast response headers without loading hubs under lock."""
        with self._server_config_lock:
            if self._cached_server_cfg is not None:
                return self._cached_server_cfg
        default_id = self.default_hub_id()
        if not default_id:
            return None
        with self._lock:
            ctx = self._contexts.get(default_id)
        if ctx is not None:
            cfg = ctx.config.get_server_config()
        else:
            rec = self.registry.get_hub(default_id)
            if rec is None or not Path(rec.path).is_dir():
                return None
            cfg = VizConfig(Path(rec.path), app_dir=APP_DIR).get_server_config()
        with self._server_config_lock:
            self._cached_server_cfg = cfg
        return cfg

    def _refresh_cached_server_config(self):
        with self._server_config_lock:
            self._cached_server_cfg = None
        self.get_server_config()

    def _shared_known_locations(self) -> Set[str]:
        ctx = self._peek_active_context()
        return set(ctx.loader.get_locations().keys()) if ctx is not None else set()

    def _shared_is_non_negative(self, target: str) -> bool:
        ctx = self._peek_active_context()
        if ctx is not None:
            return ctx.config.is_target_non_negative(target)
        return VizConfig(APP_DIR, app_dir=APP_DIR).is_target_non_negative(target)

    def _shared_local_as_of_max(self) -> Optional[str]:
        path = APP_DIR / "data" / "surveillance" / "as-of-hospital-admissions.parquet"
        if not path.is_file():
            return None
        try:
            return pl.scan_parquet(path).select(pl.col("as_of").max()).collect().item()
        except Exception:
            return None

    def _peek_active_context(self) -> Optional[HubContext]:
        default_id = self.default_hub_id()
        with self._lock:
            if default_id and default_id in self._contexts:
                return self._contexts[default_id]
            return next(reversed(self._contexts.values()), None) if self._contexts else None

    def _on_remote_inventory_change(self, hub_id: str, changed_models: List[str]):
        with self._lock:
            loaded = list(self._contexts.values())
        if not loaded:
            return
        loaded[0]._on_hub_inventory_change(hub_id, changed_models, propagate=False)
        for ctx in loaded[1:]:
            ctx.invalidate_all()
            if not self.remote_store.has_data(hub_id):
                shutil.rmtree(ctx.hub_models_cache_dir / hub_id, ignore_errors=True)
            ctx.loader.scan_models(force_refresh=True)

    def _invalidate_all_contexts(self, exclude_id: Optional[str] = None):
        with self._lock:
            items = [(hid, ctx) for hid, ctx in self._contexts.items() if hid != exclude_id]
        for _, ctx in items:
            try:
                ctx.invalidate_all()
            except Exception:
                pass

    def _peer_truth_sources(self, active_base: Path, active_targets: Set[str]) -> List[Dict[str, Any]]:
        """Discover compatible sibling local hubs registered in the workspace for truth/vintage sharing."""
        peers: List[Dict[str, Any]] = []
        active_res = Path(active_base).resolve()
        for rec in self.registry.list_hubs():
            try:
                p = Path(rec.path).expanduser().resolve()
            except (OSError, RuntimeError):
                continue
            if p == active_res or not is_hub_dir(p):
                continue
            info = inspect_local_hub(p)
            peer_targets = set(info.get("targets") or [])
            if not peer_targets:
                peer_targets = set(_peek_oracle_targets(p))
            if active_targets and peer_targets and not (active_targets & peer_targets):
                continue
            label, _ = _concise_hub_meta(rec.label, info)
            peers.append({"hub_id": rec.id, "label": label, "base_dir": p})
        return peers

    def _ensure_local_mode(self):
        if self.mode != "local":
            raise PermissionError("Local workspace actions are disabled in web mode")

    def add_local_hub(
        self,
        path_str: Any,
        label: Optional[str] = None,
        activate: bool = True,
    ) -> Dict[str, Any]:
        self._ensure_local_mode()
        raw = _coerce_path(path_str)
        if not raw.strip():
            raise ValueError("Path is required")
        p = Path(raw).expanduser().resolve()
        existing = self.registry.find_by_path(p)
        rec = self.registry.add_hub(p, label=label, activate=activate)
        with self._lock:
            self._contexts.pop(rec.id, None)
        self._invalidate_all_contexts(exclude_id=rec.id)
        if activate:
            self._refresh_cached_server_config()
        return {
            "ok": True,
            "already_registered": existing is not None,
            "hub": self._hub_entry(rec, active_id=self.registry.get_active_id()),
            "workspace": self.workspace_summary(),
        }

    def activate_hub(self, hub_id: str) -> Dict[str, Any]:
        self._ensure_local_mode()
        rec = self.registry.get_hub(hub_id)
        if rec is None:
            raise KeyError(f"Unknown hub '{hub_id}'")
        if not Path(rec.path).is_dir():
            raise ValueError(f"Hub folder no longer exists: {rec.path}")
        self.registry.set_active(hub_id)
        self._refresh_cached_server_config()
        return {
            "ok": True,
            "active_hub": hub_id,
            "workspace": self.workspace_summary(requested_hub_id=hub_id),
        }

    def remove_local_hub(self, hub_id: str, clear_cache: bool = False) -> Dict[str, Any]:
        self._ensure_local_mode()
        rec = self.registry.get_hub(hub_id)
        if rec is None:
            raise KeyError(f"Unknown hub '{hub_id}'")

        with self._lock:
            self._contexts.pop(hub_id, None)

        self.registry.remove_hub(hub_id)
        self._invalidate_all_contexts()

        if clear_cache:
            hubs_root = (self.data_dir / "hubs").resolve()
            hub_cache = (hubs_root / hub_id).resolve()
            if hub_cache.parent == hubs_root and hub_cache.exists():
                shutil.rmtree(hub_cache, ignore_errors=True)

        # Pick another valid hub if active was cleared
        if not self.registry.get_active_id():
            next_rec = next((r for r in self.registry.list_hubs() if Path(r.path).is_dir()), None)
            if next_rec is not None:
                self.registry.set_active(next_rec.id)
        self._refresh_cached_server_config()

        return {
            "ok": True,
            "removed": hub_id,
            "workspace": self.workspace_summary(),
        }

    def _hub_entry(self, rec: LocalHubRecord, active_id: Optional[str]) -> Dict[str, Any]:
        p = Path(rec.path)
        info = inspect_local_hub(p)
        exists = bool(info.get("valid"))
        label, description = _concise_hub_meta(rec.label, info)
        entry: Dict[str, Any] = {
            "id": rec.id,
            "label": label,
            "description": description,
            "active": rec.id == active_id,
            "exists": exists,
            "auto_detected": rec.auto_detected,
            "model_count": info.get("model_count", 0),
            "targets": info.get("targets", []),
            "targets_count": len(info.get("targets", [])),
            "repo_url": info.get("repo_url"),
            "last_opened": rec.last_opened,
        }
        if self.mode == "local":
            entry["path"] = str(p)
        return entry

    def workspace_summary(self, requested_hub_id: Optional[str] = None) -> Dict[str, Any]:
        records = self.registry.list_hubs()
        active_id = requested_hub_id if (requested_hub_id and any(r.id == requested_hub_id for r in records)) else self.default_hub_id()
        hubs = [self._hub_entry(r, active_id) for r in records]
        return {
            "mode": self.mode,
            "active_hub": active_id,
            "hubs": hubs,
            "native_picker_available": native_picker_available() if self.mode == "local" else False,
            "home_dir": str(Path.home()) if self.mode == "local" else None,
        }

    def workspace_hubs_brief(self) -> List[Dict[str, Any]]:
        """Lightweight registered hub list included inside /api/next/manifest."""
        active_id = self.default_hub_id()
        out = []
        for rec in self.registry.list_hubs():
            p = Path(rec.path)
            info = inspect_local_hub(p)
            label, _ = _concise_hub_meta(rec.label, info)
            item: Dict[str, Any] = {
                "id": rec.id,
                "label": label,
                "active": rec.id == active_id,
                "exists": is_hub_dir(p),
            }
            if self.mode == "local":
                item["path"] = rec.path
            out.append(item)
        return out

    def inspect_path(self, path_str: Any) -> Dict[str, Any]:
        self._ensure_local_mode()
        raw = _coerce_path(path_str)
        if not raw.strip():
            raise ValueError("Path is required")
        info = inspect_local_hub(Path(raw))
        existing = self.registry.find_by_path(Path(info["path"])) if info.get("exists") else None
        info["registered_id"] = existing.id if existing else None
        return info

    def browse_directory(self, path_str: Optional[Any] = None) -> Dict[str, Any]:
        self._ensure_local_mode()
        raw = _coerce_path(path_str).strip()
        target = Path(raw).expanduser() if raw else Path.home()
        try:
            current = target.resolve()
        except (OSError, RuntimeError) as exc:
            raise ValueError(f"Cannot resolve '{target}': {exc}") from exc

        if not current.exists():
            raise FileNotFoundError(f"Directory not found: {current}")
        if not current.is_dir():
            raise ValueError(f"Not a directory: {current}")

        entries: List[Dict[str, Any]] = []
        try:
            children = list(current.iterdir())
        except OSError as exc:
            raise PermissionError(f"Cannot read directory '{current}': {exc}") from exc

        registered_by_path = {}
        for r in self.registry.list_hubs():
            try:
                registered_by_path[str(Path(r.path).resolve())] = r.id
            except (OSError, RuntimeError):
                pass

        for child in children:
            if child.name.startswith("."):
                continue
            try:
                if not child.is_dir():
                    continue
                resolved_child = child.resolve()
            except OSError:
                continue
            hub = is_hub_dir(resolved_child)
            item: Dict[str, Any] = {
                "name": child.name,
                "path": str(resolved_child),
                "is_hub": hub,
                "registered_id": registered_by_path.get(str(resolved_child)),
            }
            if hub:
                info = inspect_local_hub(resolved_child)
                item["hub_name"] = info.get("name") or child.name
                item["targets_count"] = len(info.get("targets") or [])
                item["model_count"] = info.get("model_count", 0)
            entries.append(item)

        entries.sort(key=lambda e: (not e["is_hub"], e["name"].lower()))
        truncated = len(entries) > MAX_BROWSE_ENTRIES
        if truncated:
            entries = entries[:MAX_BROWSE_ENTRIES]

        # Quick-jump roots: Home + unique parents of registered hubs (e.g. ~/Github)
        roots: List[Dict[str, str]] = []
        seen_roots = set()

        def _add_root(label: str, p: Path):
            try:
                rp = p.resolve()
                s = str(rp)
                if rp.is_dir() and s not in seen_roots:
                    seen_roots.add(s)
                    roots.append({"label": label, "path": s})
            except OSError:
                pass

        _add_root("Home", Path.home())
        enclosing = detect_enclosing_hub()
        if enclosing is not None:
            _add_root(enclosing.parent.name or "Parent", enclosing.parent)
        for r in self.registry.list_hubs():
            p = Path(r.path)
            if p.parent != p:
                _add_root(p.parent.name or str(p.parent), p.parent)

        current_hub = None
        if is_hub_dir(current):
            current_hub = inspect_local_hub(current)
            current_hub["registered_id"] = registered_by_path.get(str(current))

        return {
            "path": str(current),
            "name": current.name or str(current),
            "parent": str(current.parent) if current.parent != current else None,
            "current_hub": current_hub,
            "entries": entries,
            "truncated": truncated,
            "roots": roots,
        }

    def pick_native_directory(self, initial_dir: Optional[str] = None) -> Dict[str, Any]:
        """Launch native OS folder picker (local mode only)."""
        self._ensure_local_mode()
        if not native_picker_available():
            return {"ok": False, "cancelled": False, "error": "Native folder picker is unavailable on this system"}

        init_path = Path.home()
        if initial_dir and initial_dir.strip():
            try:
                cand = Path(initial_dir).expanduser().resolve()
                if cand.is_dir():
                    init_path = cand
            except OSError:
                pass
        init_str = str(init_path)

        try:
            if sys.platform == "darwin":
                script = (
                    "on run argv\n"
                    "  set initDir to POSIX file (item 1 of argv)\n"
                    '  set chosenFolder to choose folder with prompt "Select a Hubverse hub folder" default location initDir\n'
                    "  return POSIX path of chosenFolder\n"
                    "end run"
                )
                res = subprocess.run(
                    ["osascript", "-e", script, init_str],
                    capture_output=True,
                    text=True,
                    timeout=120,
                    shell=False,
                )
                if res.returncode != 0:
                    err = (res.stderr or "").strip()
                    if "-128" in err or "cancel" in err.lower():
                        return {"ok": True, "cancelled": True}
                    return {"ok": False, "cancelled": False, "error": err or "Folder picker failed"}
                chosen = res.stdout.strip()
            elif sys.platform == "win32":
                ps = shutil.which("powershell") or shutil.which("pwsh")
                ps_script = (
                    "Add-Type -AssemblyName System.Windows.Forms; "
                    "$f = New-Object System.Windows.Forms.FolderBrowserDialog; "
                    "$f.Description = 'Select a Hubverse hub folder'; "
                    "if ($env:VIZ_PICK_INIT) { $f.SelectedPath = $env:VIZ_PICK_INIT }; "
                    "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }"
                )
                env = {**os.environ, "VIZ_PICK_INIT": init_str}
                res = subprocess.run(
                    [ps, "-NoProfile", "-STA", "-Command", ps_script],
                    capture_output=True,
                    text=True,
                    timeout=120,
                    shell=False,
                    env=env,
                )
                if res.returncode != 0:
                    return {"ok": False, "cancelled": False, "error": (res.stderr or "").strip() or "Folder picker failed"}
                chosen = res.stdout.strip()
                if not chosen:
                    return {"ok": True, "cancelled": True}
            else:
                zenity = shutil.which("zenity")
                kdialog = shutil.which("kdialog")
                if zenity:
                    cmd = [zenity, "--file-selection", "--directory", "--title=Select a Hubverse hub folder", f"--filename={init_str}/"]
                elif kdialog:
                    cmd = [kdialog, "--getexistingdirectory", init_str]
                else:
                    return {"ok": False, "cancelled": False, "error": "No folder picker available"}
                res = subprocess.run(cmd, capture_output=True, text=True, timeout=120, shell=False)
                if res.returncode != 0:
                    return {"ok": True, "cancelled": True}
                chosen = res.stdout.strip()
        except subprocess.TimeoutExpired:
            return {"ok": False, "cancelled": False, "error": "Folder picker timed out"}
        except OSError as exc:
            return {"ok": False, "cancelled": False, "error": str(exc)}

        if not chosen:
            return {"ok": True, "cancelled": True}

        chosen_path = Path(chosen).expanduser().resolve()
        info = inspect_local_hub(chosen_path)
        existing = self.registry.find_by_path(chosen_path)
        info["registered_id"] = existing.id if existing else None
        return {
            "ok": True,
            "cancelled": False,
            "path": str(chosen_path),
            "inspection": info,
        }
