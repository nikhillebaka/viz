"""
Remote hub definitions and Hubverse structural compatibility checks.
Supports S3 buckets and GitHub repositories across influenza, COVID-19, RSV, and syndromic hubs.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
import re
from typing import Any, Dict, Iterable, List, Optional, Set

from viz.core.calendar import infer_calendar
from viz.remote.transports import TransportError, TransportNotFound, validate_bucket_name, validate_github_repo

HUB_ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,31}$")
# Prefixes already used for model namespaces elsewhere in the suite
RESERVED_HUB_IDS = {"local", "synthetic", "repo", "all", "hub"}
SUPPORTED_OUTPUT_TYPES = ("quantile", "sample", "pmf", "median")


@dataclass
class HubSpec:
    id: str
    bucket: str = ""
    label: str = ""
    short_label: str = ""
    builtin: bool = False
    repo_url: Optional[str] = None
    transport: str = "s3"  # "s3" | "github"
    github_repo: Optional[str] = None
    branch: str = "main"
    pathogen: str = "influenza"
    geography: str = "US"
    description: str = ""
    archive_sources: List[Dict[str, Any]] = field(default_factory=list)

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
        transport="s3",
        github_repo="cdcepi/FluSight-forecast-hub",
        branch="main",
        pathogen="influenza",
        geography="US",
        description="CDC / Reich Lab US Influenza Hospitalization & ED Visit Forecast Hub",
    ),
    HubSpec(
        id="flu_metrocast",
        bucket="",
        label="Flu MetroCast",
        short_label="MetroCast",
        builtin=True,
        repo_url="https://github.com/reichlab/flu-metrocast",
        transport="github",
        github_repo="reichlab/flu-metrocast",
        branch="main",
        pathogen="influenza",
        geography="US",
        description="epiENGAGE US sub-state / HSA Influenza ED visits & admissions hub",
    ),
    HubSpec(
        id="covid19",
        bucket="covid19-forecast-hub",
        label="US COVID-19 Forecast Hub",
        short_label="COVID-19",
        builtin=True,
        repo_url="https://github.com/CDCgov/covid19-forecast-hub",
        transport="s3",
        github_repo="CDCgov/covid19-forecast-hub",
        branch="main",
        pathogen="covid19",
        geography="US",
        description="CDC / Hubverse US COVID-19 hospitalization & rate-change hub",
    ),
    HubSpec(
        id="rsv",
        bucket="rsv-forecast-hub",
        label="US RSV Forecast Hub",
        short_label="US RSV",
        builtin=True,
        repo_url="https://github.com/CDCgov/rsv-forecast-hub",
        transport="s3",
        github_repo="CDCgov/rsv-forecast-hub",
        branch="main",
        pathogen="rsv",
        geography="US",
        description="CDC US RSV age-stratified hospitalization forecast hub",
    ),
    HubSpec(
        id="respicast_syndromic",
        bucket="",
        label="RespiCast Syndromic (ILI/ARI)",
        short_label="RespiCast",
        builtin=True,
        repo_url="https://github.com/european-modelling-hubs/RespiCast-SyndromicIndicators",
        transport="github",
        github_repo="european-modelling-hubs/RespiCast-SyndromicIndicators",
        branch="main",
        pathogen="respiratory_syndromic",
        geography="EU",
        description="European Modelling Hubs / ECDC ILI & ARI incidence forecasts (EU/EEA + UK)",
        archive_sources=[
            {
                "transport": "github",
                "github_repo": "european-modelling-hubs/flu-forecast-hub_archive",
                "branch": "main",
                "label": "RespiCast Flu Archive (2023–24)",
            },
            {
                "transport": "github",
                "github_repo": "european-modelling-hubs/ari-forecast-hub_archive",
                "branch": "main",
                "label": "RespiCast ARI Archive (2023–24)",
            },
        ],
    ),
    HubSpec(
        id="respicast_covid19",
        bucket="",
        label="RespiCast COVID-19",
        short_label="RespiCast COVID",
        builtin=True,
        repo_url="https://github.com/european-modelling-hubs/RespiCast-Covid19",
        transport="github",
        github_repo="european-modelling-hubs/RespiCast-Covid19",
        branch="main",
        pathogen="covid19",
        geography="EU",
        description="European Modelling Hubs COVID-19 short-term forecast hub",
    ),
    HubSpec(
        id="china_id",
        bucket="",
        label="China ID Forecast Hub",
        short_label="China ID",
        builtin=True,
        repo_url="https://github.com/dailypartita/China-Infectious-Disease-Forecast-Hub",
        transport="github",
        github_repo="dailypartita/China-Infectious-Disease-Forecast-Hub",
        branch="main",
        pathogen="multi",
        geography="CN",
        description="China Infectious Disease Forecast Hub (COVID-19, Influenza ILI, Dengue)",
    ),
    HubSpec(
        id="canada_rvdss",
        bucket="",
        label="Canada RVDSS",
        short_label="Canada RVDSS",
        builtin=True,
        repo_url="https://github.com/ai4castinghub/rvdss-forecast",
        transport="github",
        github_repo="ai4castinghub/rvdss-forecast",
        branch="main",
        pathogen="multi",
        geography="CA",
        description="Canada Respiratory Virus Detection Surveillance System forecast hub (Flu, COVID-19, RSV)",
    ),
    HubSpec(
        id="ontario_hosp",
        bucket="",
        label="Ontario Hospitalizations",
        short_label="Ontario Hosp",
        builtin=True,
        repo_url="https://github.com/ai4castinghub/hospitalization-forecast",
        transport="github",
        github_repo="ai4castinghub/hospitalization-forecast",
        branch="main",
        pathogen="multi",
        geography="CA-ON",
        description="Ontario regional hospital bed occupancy forecast hub (Flu, COVID-19, RSV)",
    ),
    HubSpec(
        id="bdbv_drc",
        bucket="bdbv-modeling-hub",
        label="DRC BDBV Hub",
        short_label="DRC BDBV",
        builtin=True,
        repo_url="https://github.com/InsightNet-US/BDBV-Modeling-Hub",
        transport="s3",
        pathogen="bdbv",
        geography="CD",
        description="InsightNet Bundibugyo Ebola (BDBV) Modeling Hub for the Democratic Republic of the Congo",
    ),
]


def hub_id_from_source(source: str, taken: Iterable[str]) -> str:
    """Derive a short, unique namespace id from an S3 bucket name or `owner/repo` slug."""
    raw = (source or "").strip()
    if "/" in raw:
        raw = raw.rsplit("/", 1)[-1]
    base = re.sub(r"[^a-z0-9]+", "_", raw.lower())
    for noise in ("_forecast_hub", "_hub", "cdcepi_", "cdcgov_", "reichlab_"):
        base = base.replace(noise, "")
    base = base.strip("_")[:24] or "hub"
    if not base[0].isalpha():
        base = f"h{base}"
    candidate, n = base, 2
    taken_set = set(taken) | RESERVED_HUB_IDS
    while candidate in taken_set:
        candidate = f"{base}{n}"
        n += 1
    return candidate


def hub_id_from_bucket(bucket: str, taken: Iterable[str]) -> str:
    """Backwards-compatible alias for `hub_id_from_source`."""
    return hub_id_from_source(bucket, taken)


def _task_values(tasks: Dict[str, Any], task_id: str) -> Set[str]:
    values: Set[str] = set()
    rounds = tasks.get("rounds") if isinstance(tasks, dict) else None
    if not isinstance(rounds, list):
        return values
    for rnd in rounds:
        if not isinstance(rnd, dict):
            continue
        mts = rnd.get("model_tasks")
        if not isinstance(mts, list):
            continue
        for mt in mts:
            if not isinstance(mt, dict):
                continue
            tids = mt.get("task_ids")
            if not isinstance(tids, dict):
                continue
            spec = tids.get(task_id)
            if not isinstance(spec, dict):
                continue
            for k in ("required", "optional"):
                v = spec.get(k)
                if isinstance(v, list):
                    values.update(str(x).strip() for x in v if x is not None and str(x).strip())
                elif v is not None and str(v).strip():
                    values.add(str(v).strip())
    return values


def _output_types(tasks: Dict[str, Any]) -> Set[str]:
    ots: Set[str] = set()
    rounds = tasks.get("rounds") if isinstance(tasks, dict) else None
    if not isinstance(rounds, list):
        return ots
    for rnd in rounds:
        if not isinstance(rnd, dict):
            continue
        mts = rnd.get("model_tasks")
        if not isinstance(mts, list):
            continue
        for mt in mts:
            if not isinstance(mt, dict):
                continue
            ot_map = mt.get("output_type")
            if isinstance(ot_map, dict):
                ots.update(str(k).strip().lower() for k in ot_map.keys() if k)
    return ots


def is_flu_target(target: str) -> bool:
    t = target.lower()
    return "flu" in t or "influenza" in t or " ili" in f" {t}"


def _infer_repo_url(admin: Dict[str, Any]) -> Optional[str]:
    repo = admin.get("repository") or {}
    if not isinstance(repo, dict):
        return None
    owner, name = repo.get("owner"), repo.get("name")
    if owner and name:
        return f"https://github.com/{owner}/{name}"
    if isinstance(name, str) and name.startswith(("http://", "https://")):
        return name
    return None


def assess_compatibility(
    admin: Dict[str, Any],
    tasks: Dict[str, Any],
    known_locations: Optional[Set[str]] = None,
) -> Dict[str, Any]:
    """
    Structural Hubverse schema compatibility check:
    Accepts any Hubverse hub with configured rounds/model_tasks, at least one target,
    and at least one supported output type (quantile, sample, pmf, median).
    """
    rounds = tasks.get("rounds") if isinstance(tasks, dict) else None
    targets = sorted(_task_values(tasks if isinstance(tasks, dict) else {}, "target"))
    output_types = sorted(_output_types(tasks if isinstance(tasks, dict) else {}))
    supported_ots = [ot for ot in output_types if ot in SUPPORTED_OUTPUT_TYPES]
    locations = _task_values(tasks if isinstance(tasks, dict) else {}, "location")

    supported, reason = True, ""
    if not rounds or not isinstance(rounds, list):
        supported = False
        reason = "Hub tasks.json defines no forecast rounds."
    elif not targets:
        supported = False
        reason = "Hub tasks.json defines no forecast targets."
    elif not supported_ots:
        shown = ", ".join(output_types[:4]) or "none"
        supported = False
        reason = (
            f"Unsupported output types ({shown}); viz supports "
            f"{', '.join(SUPPORTED_OUTPUT_TYPES)}."
        )

    cal = infer_calendar(tasks if isinstance(tasks, dict) else None, targets=targets)
    display_targets = [t for t in targets if not t.strip().lower().startswith("peak ")]
    repo_dict = admin.get("repository") if isinstance(admin, dict) else {}

    return {
        "supported": supported,
        "reason": reason,
        "name": (admin.get("name") or "") if isinstance(admin, dict) else "",
        "maintainer": (admin.get("maintainer") or "") if isinstance(admin, dict) else "",
        "timezone": (admin.get("timezone") or "UTC") if isinstance(admin, dict) else "UTC",
        "repository": repo_dict or {},
        "repo_url": _infer_repo_url(admin if isinstance(admin, dict) else {}),
        "targets": targets,
        "display_targets": display_targets or targets,
        "output_types": output_types,
        "locations_count": len(locations),
        "calendar": cal.to_dict(),
    }


def inspect_hub(client: Any, known_locations: Optional[Set[str]] = None) -> Dict[str, Any]:
    """Fetch hub-config/admin.json and tasks.json from any HubTransport and assess compatibility."""
    src_label = (
        getattr(client, "source_name", None)
        or getattr(client, "bucket", None)
        or getattr(client, "repo", None)
        or "hub"
    )
    try:
        admin = json.loads(client.get("hub-config/admin.json"))
        tasks = json.loads(client.get("hub-config/tasks.json"))
    except TransportNotFound:
        return {
            "supported": False,
            "reason": f"'{src_label}' does not look like a Hubverse hub (no hub-config/admin.json or tasks.json).",
        }
    except (ValueError, json.JSONDecodeError):
        return {"supported": False, "reason": f"'{src_label}' has an unreadable hub-config."}
    except TransportError:
        raise

    result = assess_compatibility(admin, tasks, known_locations)
    cloud = ((admin.get("cloud") or {}).get("host") or {}) if isinstance(admin, dict) else {}
    bucket = getattr(client, "bucket", None)
    if bucket and cloud.get("storage_location") and cloud.get("storage_location") != bucket:
        result["note"] = f"admin.json names storage location '{cloud.get('storage_location')}'."
    result["admin"] = admin
    result["tasks"] = tasks
    return result
