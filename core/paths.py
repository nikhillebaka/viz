"""
Filesystem path resolution, Hubverse directory detection, and local hub inspection.

Decouples `viz` from needing to live inside a single hub directory:
- APP_DIR: where the `viz` codebase and bundled assets live.
- DATA_DIR: where workspace registry and per-hub caches live (defaults to APP_DIR/.cache or VIZ_DATA_DIR).
- hub_dir: any Hubverse-compatible folder anywhere on disk.
"""

import json
import os
from pathlib import Path
import re
from typing import Any, Dict, Iterable, List, Optional, Set

APP_DIR = Path(__file__).resolve().parent.parent
RESERVED_HUB_IDS = frozenset({"local", "synthetic", "repo", "all", "hub", "default", "none"})
HUB_SLUG_RE = re.compile(r"^[a-z][a-z0-9_-]{1,39}$")


def get_data_dir() -> Path:
    """Directory for viz workspace metadata and isolated per-hub caches."""
    env = os.environ.get("VIZ_DATA_DIR", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    return (APP_DIR / ".cache").resolve()


def is_hub_dir(path: Path) -> bool:
    """Return True if `path` looks like a Hubverse hub directory."""
    try:
        p = Path(path)
        if not p.is_dir():
            return False
        return (
            (p / "hub-config" / "tasks.json").is_file()
            or (p / "model-output").is_dir()
            or (p / "target-data").is_dir()
        )
    except OSError:
        return False


def detect_enclosing_hub() -> Optional[Path]:
    """Return APP_DIR.parent when viz is cloned directly inside a Hubverse hub."""
    parent = APP_DIR.parent.resolve()
    return parent if is_hub_dir(parent) else None


def _extract_targets(tasks_data: Dict[str, Any]) -> List[str]:
    targets: Set[str] = set()
    for rnd in tasks_data.get("rounds") or []:
        if not isinstance(rnd, dict):
            continue
        for mt in rnd.get("model_tasks") or []:
            if not isinstance(mt, dict):
                continue
            spec = (mt.get("task_ids") or {}).get("target") or {}
            if not isinstance(spec, dict):
                continue
            for key in ("required", "optional"):
                val = spec.get(key)
                if isinstance(val, list):
                    targets.update(str(x).strip() for x in val if x is not None and str(x).strip())
                elif isinstance(val, str) and val.strip():
                    targets.add(val.strip())
    return sorted(targets)


def _count_model_dirs(root: Path) -> int:
    count = 0
    for sub_name, skip in (("model-output", set()), ("local-output", {"synthetic"})):
        d = root / sub_name
        try:
            if not d.is_dir():
                continue
            for entry in d.iterdir():
                if entry.name.startswith(".") or entry.name in skip:
                    continue
                if entry.is_dir():
                    count += 1
        except OSError:
            continue
    return count


def _invalid_inspection(
    path: Path,
    *,
    exists: bool = False,
    is_dir: bool = False,
    error: Optional[str] = None,
) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "valid": False,
        "exists": exists,
        "is_dir": is_dir,
        "path": str(path),
        "name": path.name or str(path),
        "description": None,
        "maintainer": None,
        "repo_url": None,
        "targets": [],
        "model_count": 0,
        "has_tasks_config": False,
        "has_model_output": False,
        "has_target_data": False,
        "has_locations": False,
    }
    if error is not None:
        out["error"] = error
    return out


def short_hub_name(
    admin_name: Optional[str],
    repo: Optional[Dict[str, Any]],
    folder_name: str,
) -> tuple[str, Optional[str]]:
    """Return concise `(display_name, description)` so long admin.json sentences don't crowd the UI."""
    clean = (admin_name or "").strip()
    if clean and len(clean) <= 40:
        return clean, None
    repo_name = str(repo.get("name") or "").strip() if isinstance(repo, dict) else ""
    if "://" in repo_name:
        repo_name = repo_name.rstrip("/").rsplit("/", 1)[-1]
    concise = repo_name if (repo_name and len(repo_name) <= 40) else (folder_name or clean or "Hub")
    return concise, (clean or None)


def inspect_local_hub(path: Path) -> Dict[str, Any]:
    """Fast read-only summary of a candidate local hub directory (never reads forecast files)."""
    raw_path = Path(path)
    try:
        p = raw_path.expanduser().resolve()
    except (OSError, RuntimeError) as exc:
        return _invalid_inspection(raw_path, error=str(exc))

    try:
        exists = p.exists()
        is_dir = p.is_dir()
    except OSError as exc:
        return _invalid_inspection(p, error=str(exc))

    if not is_dir:
        return _invalid_inspection(p, exists=exists, is_dir=False)

    has_tasks_config = False
    has_model_output = False
    has_target_data = False
    has_locations = False
    try:
        has_tasks_config = (p / "hub-config" / "tasks.json").is_file()
        has_model_output = (p / "model-output").is_dir()
        has_target_data = (p / "target-data").is_dir()
        has_locations = (p / "auxiliary-data" / "locations.csv").is_file()
    except OSError:
        pass

    valid = has_tasks_config or has_model_output or has_target_data
    name = p.name or "Hub"
    description: Optional[str] = None
    maintainer: Optional[str] = None
    repo_url: Optional[str] = None
    targets: List[str] = []

    admin_file = p / "hub-config" / "admin.json"
    if admin_file.is_file():
        try:
            admin = json.loads(admin_file.read_text(encoding="utf-8"))
            if isinstance(admin, dict):
                repo = admin.get("repository")
                name, description = short_hub_name(admin.get("name"), repo, p.name or "Hub")
                if admin.get("maintainer"):
                    maintainer = str(admin["maintainer"]).strip()
                if isinstance(repo, dict):
                    rn = str(repo.get("name") or "").strip()
                    ro = str(repo.get("owner") or "").strip()
                    if rn.startswith(("http://", "https://")):
                        repo_url = rn
                    elif ro and rn:
                        host = str(repo.get("host") or "github.com").strip().lower()
                        if host == "github":
                            host = "github.com"
                        repo_url = f"https://{host}/{ro}/{rn}"
                    elif repo.get("url"):
                        repo_url = str(repo["url"]).strip()
        except Exception:
            pass

    if has_tasks_config:
        try:
            tasks = json.loads((p / "hub-config" / "tasks.json").read_text(encoding="utf-8"))
            if isinstance(tasks, dict):
                targets = _extract_targets(tasks)
        except Exception:
            pass

    model_count = _count_model_dirs(p) if valid else 0

    return {
        "valid": valid,
        "exists": exists,
        "is_dir": is_dir,
        "path": str(p),
        "name": name,
        "description": description,
        "maintainer": maintainer,
        "repo_url": repo_url,
        "targets": targets,
        "model_count": model_count,
        "has_tasks_config": has_tasks_config,
        "has_model_output": has_model_output,
        "has_target_data": has_target_data,
        "has_locations": has_locations,
    }


def slug_for_hub(label_or_name: str, path: Path, taken: Iterable[str]) -> str:
    """Build a unique, URL-safe hub id matching `^[a-z][a-z0-9_-]{1,39}$`."""
    raw = (label_or_name or "").strip()
    source = raw if (raw and len(raw) <= 36) else (path.name or raw or "hub")
    base = re.sub(r"[^a-z0-9_-]+", "_", source.lower()).strip("_-")
    if not base:
        base = re.sub(r"[^a-z0-9_-]+", "_", (path.name or "").lower()).strip("_-")
    if not base:
        base = "hub"
    if not base[0].isalpha():
        base = f"h_{base}"
    if len(base) < 2:
        base = f"{base}_hub"
    base = base[:34].rstrip("_-") or "hub"
    if len(base) < 2:
        base = "hub"

    taken_set = set(taken) | RESERVED_HUB_IDS
    candidate = base
    suffix = 2
    while candidate in taken_set or not HUB_SLUG_RE.match(candidate):
        tail = f"_{suffix}"
        candidate = f"{base[:40 - len(tail)]}{tail}"
        suffix += 1
    return candidate
