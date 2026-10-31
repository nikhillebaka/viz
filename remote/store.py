"""
On-disk layout for hub data copied into the viz cache, plus the hub registry and per-hub manifests.

viz/.cache/remote/
├── hubs.json                         # registry: custom hubs and which hubs are shown in the dashboard
└── <hub_id>/
    ├── manifest.json                 # every copied S3 object (etag, size, timestamps, data-quality notes)
    ├── hub-config/{admin,tasks}.json
    ├── model-metadata/<model>.yml
    ├── model-output/<model>/<date>-<model>.parquet   # normalized weekly quantile rows
    ├── peak-output/<model>/<date>-<model>.parquet    # season peak rows (size quantiles, peak-week pmf)
    └── target-data/{oracle,admissions,as_of_snapshots}.parquet

Nothing here touches the network; it is safe to use from request handlers and from the CLI.
"""

import json
import os
from pathlib import Path
import shutil
import threading
from typing import Any, Dict, List, Optional

from viz.remote.hubs import BUILTIN_HUBS, HubSpec

TRUTH_FILES = {
    "oracle": "oracle.parquet",
    "admissions": "admissions.parquet",
    "as_of": "as_of_snapshots.parquet",
}

_write_lock = threading.Lock()


def _atomic_write_json(path: Path, data: Any):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".tmp.{os.getpid()}.{threading.get_ident()}")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def _read_json(path: Path, default: Any) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


class RemoteStore:
    """Paths, registry, and manifests for hub copies under viz/.cache/remote."""

    def __init__(self, cache_dir: Path):
        self.root = Path(cache_dir) / "remote"
        self.registry_path = self.root / "hubs.json"
        self._active_cache: Optional[tuple] = None

    # ---- registry -------------------------------------------------------------------------------------

    def _registry(self) -> Dict[str, Any]:
        reg = _read_json(self.registry_path, {})
        if not isinstance(reg, dict):
            reg = {}
        reg.setdefault("custom_hubs", [])
        reg.setdefault("enabled", {})
        return reg

    def hub_specs(self) -> List[HubSpec]:
        specs = list(BUILTIN_HUBS)
        seen = {s.id for s in specs}
        for h in self._registry().get("custom_hubs", []):
            try:
                spec = HubSpec(**{k: h[k] for k in ("id", "bucket", "label", "short_label")}, builtin=False,
                               repo_url=h.get("repo_url"))
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

    def is_enabled(self, hub_id: str) -> bool:
        """A hub is shown when it has synced data, unless the user switched it off in the brand menu."""
        return bool(self._registry()["enabled"].get(hub_id, True))

    def set_enabled(self, hub_id: str, enabled: bool):
        with _write_lock:
            reg = self._registry()
            reg["enabled"][hub_id] = bool(enabled)
            _atomic_write_json(self.registry_path, reg)

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

    # ---- per-hub paths ----------------------------------------------------------------------------------

    def hub_dir(self, hub_id: str) -> Path:
        return self.root / hub_id

    def manifest_path(self, hub_id: str) -> Path:
        return self.hub_dir(hub_id) / "manifest.json"

    def model_dir(self, hub_id: str, model: str) -> Path:
        return self.hub_dir(hub_id) / "model-output" / model

    def peak_dir(self, hub_id: str, model: str) -> Path:
        return self.hub_dir(hub_id) / "peak-output" / model

    def metadata_path(self, hub_id: str, model: str) -> Path:
        return self.hub_dir(hub_id) / "model-metadata" / f"{model}.yml"

    def truth_path(self, hub_id: str, kind: str) -> Path:
        return self.hub_dir(hub_id) / "target-data" / TRUTH_FILES[kind]

    def has_data(self, hub_id: str) -> bool:
        return self.manifest_path(hub_id).exists()

    def synced_hub_ids(self) -> List[str]:
        return [s.id for s in self.hub_specs() if self.has_data(s.id)]

    def active_hub_ids(self) -> List[str]:
        """Hubs whose data should appear in the dashboard: synced and not switched off (cached by mtime)."""
        if not self.root.exists():
            return []
        stamp = self.state_mtime()
        cached = self._active_cache
        if cached is not None and cached[0] == stamp:
            return cached[1]
        active = [h for h in self.synced_hub_ids() if self.is_enabled(h)]
        self._active_cache = (stamp, active)
        return active

    def active_truth_files(self, kind: str) -> List[Path]:
        return [p for p in (self.truth_path(h, kind) for h in self.active_hub_ids()) if p.exists()]

    # ---- manifest ---------------------------------------------------------------------------------------

    def load_manifest(self, hub_id: str) -> Dict[str, Any]:
        m = _read_json(self.manifest_path(hub_id), {})
        if not isinstance(m, dict):
            m = {}
        m.setdefault("files", {})
        m.setdefault("metadata", {})
        m.setdefault("truth", {})
        m.setdefault("seasons", [])
        return m

    def save_manifest(self, hub_id: str, manifest: Dict[str, Any]):
        _atomic_write_json(self.manifest_path(hub_id), manifest)

    def state_mtime(self) -> float:
        """Combined modification stamp of the registry and all manifests, for inventory cache invalidation."""
        stamp = 0.0
        for p in [self.registry_path] + [self.manifest_path(s.id) for s in self.hub_specs()]:
            try:
                stamp = max(stamp, p.stat().st_mtime)
            except OSError:
                pass
        return stamp
