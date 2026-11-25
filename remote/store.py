"""
On-disk layout for hub data copied into the viz cache, plus the hub registry and per-hub manifests.

viz/.cache/remote/
├── hubs.json                                          # registry: custom hubs and which hubs are shown
└── <hub_id>/
    ├── manifest.json                                  # synced objects (etag, size, timestamps, warnings)
    ├── auxiliary-data/locations.csv                   # optional hub locations table
    ├── hub-config/{admin,tasks}.json
    ├── model-metadata/<model>.yml
    ├── model-output/<model>/<date>-<model>.parquet    # normalized weekly quantile rows
    ├── sample-output/<model>/<date>-<model>.parquet   # normalized sample trajectories
    ├── pmf-output/<model>/<date>-<model>.parquet      # normalized categorical PMF rows
    ├── peak-output/<model>/<date>-<model>.parquet     # season peak rows (size quantiles, peak-week pmf)
    └── target-data/{oracle,admissions,as_of_snapshots,latest,time_series}.parquet

Nothing here touches the network; it is safe to use from request handlers and from the CLI.
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import shutil
import threading
from typing import Any, Dict, List, Optional, Set, Tuple

from viz.remote.hubs import BUILTIN_HUBS, HubSpec

logger = logging.getLogger("viz.remote.store")

_BUILTIN_DEFAULT_TARGETS: Dict[str, Set[str]] = {
    "flusight": {"wk inc flu hosp", "wk flu hosp rate change", "wk inc flu prop ed visits"},
    "flu_metrocast": {"Flu ED visits pct", "Flu hosp admits"},
    "covid19": {"wk inc covid hosp", "wk inc covid hosp rate change"},
    "rsv": {"wk inc rsv hosp"},
    "respicast_syndromic": {"ILI incidence", "ARI incidence"},
    "respicast_covid19": {"wk inc covid cases", "wk inc covid deaths", "wk inc covid hosp"},
    "china_id": {"wk inc covid prop ili", "wk inc flu prop ili", "mo inc dengue cases"},
    "canada_rvdss": {"pct wk flu lab det", "pct wk covid lab det", "pct wk rsv lab det"},
    "ontario_hosp": {"wk inc flu hosp", "wk inc covid hosp", "wk inc rsv hosp"},
    "bdbv_drc": {"wk inc confirmed cases", "wk R_t"},
}

TRUTH_FILES = {
    "oracle": "oracle.parquet",
    "admissions": "admissions.parquet",
    "as_of": "as_of_snapshots.parquet",
    "latest": "latest.parquet",
    "time_series": "time_series.parquet",
}

# Re-entrant: registry writers hold this lock while `_registry()` may quarantine a corrupt file,
# which takes it again. A plain Lock deadlocks every later write (and every manifest save).
_write_lock = threading.RLock()


def _fsync_dir(directory: Path) -> None:
    """Best-effort fsync of a directory so a completed rename survives power loss (POSIX only)."""
    if os.name != "posix":
        return
    try:
        fd = os.open(str(directory), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _atomic_write_json(path: Path, data: Any):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}.{threading.get_ident()}")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        _fsync_dir(path.parent)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _quarantine_corrupt_json(path: Path, reason: str) -> None:
    if not path.is_file():
        return
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = path.with_name(f"{path.stem}.corrupt.{stamp}{path.suffix}")
    n = 1
    while backup.exists():
        n += 1
        backup = path.with_name(f"{path.stem}.corrupt.{stamp}.{n}{path.suffix}")
    try:
        os.replace(path, backup)
        logger.error("Corrupt JSON in %s (%s); quarantined backup at %s", path, reason, backup)
    except OSError as exc:
        logger.error("Corrupt JSON in %s (%s); backup quarantine failed: %s", path, reason, exc)


def _read_json(path: Path, default: Any, *, quarantine_corrupt: bool = False) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return copy.deepcopy(default)
    except (ValueError, UnicodeDecodeError) as exc:
        if quarantine_corrupt:
            with _write_lock:
                _quarantine_corrupt_json(path, str(exc))
        else:
            logger.warning("Failed to parse JSON at %s: %s", path, exc)
        return copy.deepcopy(default)
    except OSError as exc:
        logger.warning("Could not read JSON at %s: %s", path, exc)
        return copy.deepcopy(default)
    if default is not None and type(data) is not type(default):
        if quarantine_corrupt:
            with _write_lock:
                _quarantine_corrupt_json(path, f"expected {type(default).__name__}, got {type(data).__name__}")
        return copy.deepcopy(default)
    return data


class RemoteStore:
    """Paths, registry, and manifests for hub copies under the shared remote cache root."""

    def __init__(self, cache_dir: Path, root: Optional[Path] = None):
        self.root = Path(root).resolve() if root is not None else (Path(cache_dir) / "remote")
        self.registry_path = self.root / "hubs.json"
        self._cache_lock = threading.RLock()
        self._active_cache: Optional[tuple] = None
        self._tasks_meta_cache: Dict[str, tuple] = {}
        self._manifest_cache: Dict[str, Tuple[Tuple[int, int], Dict[str, Any]]] = {}

    # ---- registry -------------------------------------------------------------------------------------

    def _registry(self) -> Dict[str, Any]:
        reg = _read_json(self.registry_path, {}, quarantine_corrupt=True)
        if not isinstance(reg, dict):
            reg = {}
        if not isinstance(reg.get("custom_hubs"), list):
            reg["custom_hubs"] = []
        if not isinstance(reg.get("enabled"), dict):
            reg["enabled"] = {}
        if not isinstance(reg.get("settings"), dict):
            reg["settings"] = {}
        return reg

    def get_settings(self) -> Dict[str, Any]:
        """Return persistent remote-sync preferences stored in hubs.json."""
        s = self._registry().get("settings") or {}
        return {
            "auto_update_daily": bool(s.get("auto_update_daily", False)),
            "last_auto_update": str(s["last_auto_update"]) if s.get("last_auto_update") else None,
        }

    def set_auto_update_daily(self, enabled: bool) -> Dict[str, Any]:
        with _write_lock:
            reg = self._registry()
            reg["settings"]["auto_update_daily"] = bool(enabled)
            _atomic_write_json(self.registry_path, reg)
            return self.get_settings()

    def record_auto_update(self, ts_iso: str) -> Dict[str, Any]:
        with _write_lock:
            reg = self._registry()
            reg["settings"]["last_auto_update"] = str(ts_iso)
            _atomic_write_json(self.registry_path, reg)
            return self.get_settings()

    def hub_specs(self) -> List[HubSpec]:
        specs = list(BUILTIN_HUBS)
        seen = {s.id for s in specs}
        for h in self._registry().get("custom_hubs", []):
            if not isinstance(h, dict):
                continue
            try:
                spec = HubSpec(
                    id=str(h["id"]),
                    bucket=str(h.get("bucket") or ""),
                    label=str(h.get("label") or h["id"]),
                    short_label=str(h.get("short_label") or h["id"]),
                    builtin=False,
                    repo_url=h.get("repo_url"),
                    transport=str(h.get("transport") or ("github" if h.get("github_repo") and not h.get("bucket") else "s3")),
                    github_repo=h.get("github_repo"),
                    branch=str(h.get("branch") or "main"),
                    pathogen=str(h.get("pathogen") or "influenza"),
                    geography=str(h.get("geography") or "US"),
                    description=str(h.get("description") or ""),
                    archive_sources=list(h.get("archive_sources") or []),
                )
            except (KeyError, TypeError):
                continue
            if spec.id not in seen:
                specs.append(spec)
                seen.add(spec.id)
        return specs

    def get_spec(self, hub_id: str) -> Optional[HubSpec]:
        return next((s for s in self.hub_specs() if s.id == hub_id), None)

    def add_custom_hub(self, spec: HubSpec):
        with _write_lock:
            reg = self._registry()
            reg["custom_hubs"] = [h for h in reg["custom_hubs"] if h.get("id") != spec.id] + [spec.to_dict()]
            _atomic_write_json(self.registry_path, reg)
            with self._cache_lock:
                self._active_cache = None

    def is_enabled(self, hub_id: str) -> bool:
        """A hub is shown when it has synced data, unless the user switched it off in the brand menu."""
        return bool(self._registry()["enabled"].get(hub_id, True))

    def set_enabled(self, hub_id: str, enabled: bool):
        with _write_lock:
            reg = self._registry()
            reg["enabled"][hub_id] = bool(enabled)
            _atomic_write_json(self.registry_path, reg)
            with self._cache_lock:
                self._active_cache = None
                self._tasks_meta_cache.pop(hub_id, None)

    def remove_hub(self, hub_id: str):
        """Delete a hub's copied data (and its registration if it was user-added)."""
        with _write_lock:
            d = self.hub_dir(hub_id)
            if d.exists():
                shutil.rmtree(d, ignore_errors=True)
            reg = self._registry()
            reg["custom_hubs"] = [h for h in reg["custom_hubs"] if h.get("id") != hub_id]
            reg["enabled"].pop(hub_id, None)
            _atomic_write_json(self.registry_path, reg)
            with self._cache_lock:
                self._manifest_cache.pop(hub_id, None)
                self._active_cache = None
                self._tasks_meta_cache.pop(hub_id, None)

    # ---- per-hub paths ----------------------------------------------------------------------------------

    def hub_dir(self, hub_id: str) -> Path:
        return self.root / hub_id

    def manifest_path(self, hub_id: str) -> Path:
        return self.hub_dir(hub_id) / "manifest.json"

    def model_dir(self, hub_id: str, model: str) -> Path:
        return self.hub_dir(hub_id) / "model-output" / model

    def sample_dir(self, hub_id: str, model: str) -> Path:
        return self.hub_dir(hub_id) / "sample-output" / model

    def pmf_dir(self, hub_id: str, model: str) -> Path:
        return self.hub_dir(hub_id) / "pmf-output" / model

    def peak_dir(self, hub_id: str, model: str) -> Path:
        return self.hub_dir(hub_id) / "peak-output" / model

    def metadata_path(self, hub_id: str, model: str) -> Path:
        return self.hub_dir(hub_id) / "model-metadata" / f"{model}.yml"

    def locations_path(self, hub_id: str) -> Path:
        return self.hub_dir(hub_id) / "auxiliary-data" / "locations.csv"

    def truth_path(self, hub_id: str, kind: str) -> Path:
        return self.hub_dir(hub_id) / "target-data" / TRUTH_FILES[kind]

    def has_data(self, hub_id: str) -> bool:
        p = self.manifest_path(hub_id)
        try:
            return p.is_file() and p.stat().st_size >= 2
        except OSError:
            return False

    def synced_hub_ids(self) -> List[str]:
        return [s.id for s in self.hub_specs() if self.has_data(s.id)]

    def active_hub_ids(self) -> List[str]:
        """Hubs whose data should appear in the dashboard: synced and not switched off (cached by mtime)."""
        if not self.root.exists():
            return []
        stamp = self.state_mtime()
        with self._cache_lock:
            cached = self._active_cache
            if cached is not None and cached[0] == stamp:
                return list(cached[1])
        active = [h for h in self.synced_hub_ids() if self.is_enabled(h)]
        with self._cache_lock:
            self._active_cache = (stamp, active)
        return list(active)

    def active_truth_files(self, kind: str, hub_ids: Optional[List[str]] = None) -> List[Path]:
        ids = self.active_hub_ids() if hub_ids is None else hub_ids
        return [p for p in (self.truth_path(h, kind) for h in ids) if p.exists()]

    def _tasks_summary(self, hub_id: str) -> tuple[Set[str], Set[str]]:
        stamp = self.state_mtime()
        with self._cache_lock:
            hit = self._tasks_meta_cache.get(hub_id)
            if hit is not None and hit[0] == stamp:
                return set(hit[1]), set(hit[2])
        targets: Set[str] = set()
        locations: Set[str] = set()
        tasks_path = self.hub_dir(hub_id) / "hub-config" / "tasks.json"
        tasks = _read_json(tasks_path, {})
        if isinstance(tasks, dict):
            for rnd in tasks.get("rounds") or []:
                if not isinstance(rnd, dict):
                    continue
                for mt in rnd.get("model_tasks") or []:
                    if not isinstance(mt, dict):
                        continue
                    tids = mt.get("task_ids") or {}
                    for bucket, col in ((targets, "target"), (locations, "location")):
                        spec = tids.get(col) or {}
                        if isinstance(spec, dict):
                            for k in ("required", "optional"):
                                v = spec.get(k)
                                if isinstance(v, list):
                                    bucket.update(str(x).strip() for x in v if x is not None and str(x).strip())
                                elif isinstance(v, str) and v.strip():
                                    bucket.add(v.strip())
        if not targets:
            man = self.load_manifest(hub_id)
            for f in (man.get("files") or {}).values():
                if isinstance(f, dict):
                    targets.update(str(t).strip() for t in (f.get("targets") or []) if str(t).strip())
        if not targets and hub_id in _BUILTIN_DEFAULT_TARGETS:
            targets = set(_BUILTIN_DEFAULT_TARGETS[hub_id])
        with self._cache_lock:
            self._tasks_meta_cache[hub_id] = (stamp, set(targets), set(locations))
        return targets, locations

    def hub_targets(self, hub_id: str) -> Set[str]:
        return set(self._tasks_summary(hub_id)[0])

    def hub_locations(self, hub_id: str) -> Set[str]:
        return set(self._tasks_summary(hub_id)[1])

    def is_compatible(
        self,
        hub_id: str,
        targets: Optional[Set[str]] = None,
        locations: Optional[Set[str]] = None,
    ) -> bool:
        """True when a remote hub shares targets (and locations, if known) with the active hub."""
        h_targets, h_locs = self._tasks_summary(hub_id)
        if targets and h_targets and not (targets & h_targets):
            return False
        if locations and h_locs:
            overlap = locations & h_locs
            if not overlap:
                return False
            if len(locations) > 3 and len(h_locs) > 3 and len(overlap) < min(len(locations), len(h_locs)) * 0.4:
                return False
        return True

    def compatible_hub_ids(
        self,
        targets: Optional[Set[str]] = None,
        locations: Optional[Set[str]] = None,
    ) -> List[str]:
        """Active synced hubs compatible with `targets` and `locations`."""
        return [h for h in self.active_hub_ids() if self.is_compatible(h, targets=targets, locations=locations)]

    # ---- manifest ---------------------------------------------------------------------------------------

    def load_manifest(self, hub_id: str, *, mutable: bool = False) -> Dict[str, Any]:
        """
        Return the hub's manifest.

        By default this is a shared, cached snapshot that callers must treat as READ-ONLY (it is
        replaced wholesale on save, never mutated in place). Pass `mutable=True` to get a private
        deep copy for code that edits the manifest before `save_manifest` (sync, check).
        """
        p = self.manifest_path(hub_id)
        sig: Optional[Tuple[int, int]] = None
        try:
            st = p.stat()
            sig = (st.st_mtime_ns, st.st_size)
        except OSError:
            sig = None

        if sig is not None:
            with self._cache_lock:
                cached = self._manifest_cache.get(hub_id)
            if cached is not None and cached[0] == sig:
                return copy.deepcopy(cached[1]) if mutable else cached[1]

        m = _read_json(p, {}, quarantine_corrupt=True)
        if not isinstance(m, dict):
            m = {}
        m.setdefault("files", {})
        m.setdefault("metadata", {})
        m.setdefault("truth", {})
        m.setdefault("seasons", [])
        if sig is not None and p.is_file():
            with self._cache_lock:
                self._manifest_cache[hub_id] = (sig, m)
        return copy.deepcopy(m) if mutable else m

    def save_manifest(self, hub_id: str, manifest: Dict[str, Any]):
        p = self.manifest_path(hub_id)
        snapshot = copy.deepcopy(manifest)
        with _write_lock:
            _atomic_write_json(p, snapshot)
            try:
                st = p.stat()
                sig = (st.st_mtime_ns, st.st_size)
            except OSError:
                sig = None
            with self._cache_lock:
                if sig is not None:
                    self._manifest_cache[hub_id] = (sig, snapshot)
                else:
                    self._manifest_cache.pop(hub_id, None)
                self._active_cache = None
                self._tasks_meta_cache.pop(hub_id, None)

    def state_mtime(self) -> float:
        """Combined modification stamp of the registry, manifests, tasks, and locations."""
        stamp = 0.0
        paths: List[Path] = [self.registry_path]
        for s in self.hub_specs():
            paths.append(self.manifest_path(s.id))
            paths.append(self.hub_dir(s.id) / "hub-config" / "tasks.json")
            paths.append(self.locations_path(s.id))
        for p in paths:
            try:
                stamp = max(stamp, p.stat().st_mtime)
            except OSError:
                pass
        return stamp
