"""
Remote hub definitions and the compatibility check run before any hub is synced.
The suite currently only displays influenza forecasts at US state/national level, so other hubs are rejected.
"""

from dataclasses import asdict, dataclass
import json
import re
from typing import Any, Dict, Iterable, List, Optional, Set

from viz.remote.s3 import S3Client, S3Error, S3NotFound

HUB_ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,31}$")
# Prefixes already used for model namespaces elsewhere in the suite
RESERVED_HUB_IDS = {"local", "synthetic", "repo", "all", "hub"}

FLU_ONLY_MESSAGE = "Viz only supports flu forecast hubs for now."
OTHER_PATHOGENS = ("covid", "rsv", "sars", "measles", "dengue", "mpox", "ebola")


@dataclass
class HubSpec:
    id: str
    bucket: str
    label: str
    short_label: str
    builtin: bool = False
    repo_url: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


BUILTIN_HUBS: List[HubSpec] = [
    HubSpec(
        id="flusight",
        bucket="cdcepi-flusight-forecast-hub",
        label="CDC FluSight",
        short_label="FluSight",
        builtin=True,
        repo_url="https://github.com/cdcepi/FluSight-forecast-hub",
    ),
]


def hub_id_from_bucket(bucket: str, taken: Iterable[str]) -> str:
    """Derive a short, unique namespace id (used in model keys like '<id>:Team-model') from a bucket name."""
    base = re.sub(r"[^a-z0-9]+", "_", bucket.lower())
    for noise in ("_forecast_hub", "_hub", "cdcepi_", "cdcgov_"):
        base = base.replace(noise, "")
    base = base.strip("_")[:24] or "hub"
    if not base[0].isalpha():
        base = f"h{base}"
    candidate, n = base, 2
    taken = set(taken) | RESERVED_HUB_IDS
    while candidate in taken:
        candidate = f"{base}{n}"
        n += 1
    return candidate


def _task_values(tasks: Dict[str, Any], task_id: str) -> Set[str]:
    values: Set[str] = set()
    for rnd in tasks.get("rounds", []) or []:
        for mt in rnd.get("model_tasks", []) or []:
            spec = (mt.get("task_ids") or {}).get(task_id) or {}
            for k in ("required", "optional"):
                v = spec.get(k)
                if isinstance(v, list):
                    values.update(str(x) for x in v if x is not None)
                elif v is not None:
                    values.add(str(v))
    return values


def _quantile_targets(tasks: Dict[str, Any]) -> Set[str]:
    out: Set[str] = set()
    for rnd in tasks.get("rounds", []) or []:
        for mt in rnd.get("model_tasks", []) or []:
            if "quantile" not in (mt.get("output_type") or {}):
                continue
            spec = (mt.get("task_ids") or {}).get("target") or {}
            for k in ("required", "optional"):
                v = spec.get(k)
                if isinstance(v, list):
                    out.update(str(x) for x in v if x is not None)
                elif v is not None:
                    out.add(str(v))
    return out


def is_flu_target(target: str) -> bool:
    t = target.lower()
    return ("flu" in t or "influenza" in t or " ili" in f" {t}") and not any(p in t for p in OTHER_PATHOGENS)


def assess_compatibility(admin: Dict[str, Any], tasks: Dict[str, Any], known_locations: Set[str]) -> Dict[str, Any]:
    """
    Decide whether a hub can be displayed: it must forecast at least one flu quantile target, carry no
    other pathogen's targets, and use the same US state/national location codes as the local hub.
    """
    targets = sorted(_task_values(tasks, "target"))
    flu_quantile = sorted(t for t in _quantile_targets(tasks) if is_flu_target(t))
    other = sorted(t for t in targets if not is_flu_target(t))
    locations = _task_values(tasks, "location")
    unknown_locs = sorted(locations - known_locations) if known_locations else []

    supported, reason = True, ""
    if not flu_quantile:
        supported = False
        shown = ", ".join(targets[:4]) or "none found"
        reason = f"{FLU_ONLY_MESSAGE} This hub's targets are: {shown}."
    elif other:
        supported = False
        reason = f"{FLU_ONLY_MESSAGE} This hub also forecasts non-flu targets ({', '.join(other[:3])})."
    elif locations and unknown_locs and len(unknown_locs) > max(3, len(locations) // 5):
        supported = False
        reason = (
            "Viz only supports hubs that forecast US states and the national total for now. "
            f"This hub uses other locations (e.g. {', '.join(unknown_locs[:3])})."
        )

    return {
        "supported": supported,
        "reason": reason,
        "name": admin.get("name") or "",
        "maintainer": admin.get("maintainer") or "",
        "timezone": admin.get("timezone") or "US/Eastern",
        "repository": admin.get("repository") or {},
        "targets": targets,
        "display_targets": flu_quantile,
    }


def inspect_hub(client: S3Client, known_locations: Set[str]) -> Dict[str, Any]:
    """Fetch hub-config/admin.json and tasks.json from a bucket and assess whether viz can display it."""
    try:
        admin = json.loads(client.get("hub-config/admin.json"))
        tasks = json.loads(client.get("hub-config/tasks.json"))
    except S3NotFound:
        return {
            "supported": False,
            "reason": f"Bucket '{client.bucket}' does not look like a Hubverse hub (no hub-config/admin.json or tasks.json).",
        }
    except (ValueError, json.JSONDecodeError):
        return {"supported": False, "reason": f"Bucket '{client.bucket}' has an unreadable hub-config."}
    except S3Error:
        raise
    result = assess_compatibility(admin, tasks, known_locations)
    cloud = (admin.get("cloud") or {}).get("host") or {}
    if cloud.get("storage_location") and cloud.get("storage_location") != client.bucket:
        result["note"] = f"admin.json names storage location '{cloud.get('storage_location')}'."
    result["admin"] = admin
    result["tasks"] = tasks
    return result
