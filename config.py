"""
Configuration and metadata discovery module for the Visualization and Evaluation Suite.
Dynamically discovers hub configuration from hub-config/tasks.json or an optional viz/config.json.
Provides zero-hardcoding defaults across any Hubverse or FluSight compatible repository.
"""

import json
import logging
from pathlib import Path
import sys
from typing import Dict, List, Optional, Any, Set

try:
    import tomllib
except ModuleNotFoundError:
    tomllib = None  # type: ignore

logger = logging.getLogger("viz.config")


class VizConfig:
    """
    Central configuration and discovery manager.
    Reads hub-config/tasks.json and optional viz/config.json or viz/config.toml with graceful fallbacks.
    """

    def __init__(self, base_dir: Path):
        self.base_dir = Path(base_dir).resolve()
        self.hub_config_dir = self.base_dir / "hub-config"
        self.viz_dir = self.base_dir / "viz"

        self._user_config: Dict[str, Any] = self._load_user_config()
        self._tasks_config: Optional[Dict[str, Any]] = self._load_tasks_config()

    def _load_user_config(self) -> Dict[str, Any]:
        """Load user-defined configuration from viz/config.json, viz/config.toml, etc."""
        candidates = [
            (self.viz_dir / "config.json", False),
            (self.viz_dir / "config.toml", False),
            (self.base_dir / "config.json", True),
            (self.base_dir / "config.toml", True),
        ]
        for path, require_viz_key in candidates:
            if not path.exists():
                continue
            if path.suffix == ".json":
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        if isinstance(data, dict):
                            if require_viz_key:
                                if "viz" in data and isinstance(data["viz"], dict):
                                    logger.info("Loaded custom visualizer config from %s ['viz']", path)
                                    return data["viz"]
                            else:
                                logger.info("Loaded custom visualizer config from %s", path)
                                return data
                except Exception as exc:
                    logger.warning("Failed to parse JSON config file %s: %s", path, exc)
            elif path.suffix == ".toml" and tomllib is not None:
                try:
                    with open(path, "rb") as f:
                        data = tomllib.load(f)
                        if isinstance(data, dict):
                            if require_viz_key:
                                if "viz" in data and isinstance(data["viz"], dict):
                                    logger.info("Loaded custom visualizer TOML config from %s ['viz']", path)
                                    return data["viz"]
                            else:
                                logger.info("Loaded custom visualizer TOML config from %s", path)
                                return data
                except Exception as exc:
                    logger.warning("Failed to parse TOML config file %s: %s", path, exc)
        return {}

    def _load_tasks_config(self) -> Optional[Dict[str, Any]]:
        """Load official Hubverse tasks.json if present."""
        tasks_file = self.hub_config_dir / "tasks.json"
        if tasks_file.exists():
            try:
                with open(tasks_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as exc:
                logger.warning("Failed to parse hub-config/tasks.json: %s", exc)
        return None

    def get_targets(self, discovered_targets: Optional[List[str]] = None) -> List[str]:
        """
        Get supported forecast targets in priority order.
        Discovers from:
        1. User config: `targets`
        2. hub-config/tasks.json: `model_tasks[*].task_ids.target`
        3. Dynamically discovered targets in oracle/model data
        4. Default fallback: ['wk inc flu hosp']
        """
        if "targets" in self._user_config and isinstance(self._user_config["targets"], list):
            return [str(t).strip() for t in self._user_config["targets"] if str(t).strip()]

        if self._tasks_config:
            targets_set: Set[str] = set()
            for r in self._tasks_config.get("rounds", []):
                for mt in r.get("model_tasks", []):
                    target_spec = mt.get("task_ids", {}).get("target", {})
                    req = target_spec.get("required") or []
                    opt = target_spec.get("optional") or []
                    if isinstance(req, list):
                        targets_set.update(req)
                    elif isinstance(req, str):
                        targets_set.add(req)
                    if isinstance(opt, list):
                        targets_set.update(opt)
                    elif isinstance(opt, str):
                        targets_set.add(opt)
            if targets_set:
                return sorted(list(targets_set))

        if discovered_targets:
            clean = sorted(list({str(t).strip() for t in discovered_targets if str(t).strip()}))
            if clean:
                return clean

        return ["wk inc flu hosp"]

    def get_weekly_targets(self, discovered_targets: Optional[List[str]] = None) -> List[str]:
        """Targets shown in the target selector: everything except season peak targets (see viz.peaks)."""
        return [t for t in self.get_targets(discovered_targets) if not t.strip().lower().startswith("peak ")]

    def get_default_target(self, discovered_targets: Optional[List[str]] = None) -> str:
        """Get the default active target variable."""
        if "default_target" in self._user_config:
            return str(self._user_config["default_target"]).strip()
        targets = self.get_weekly_targets(discovered_targets=discovered_targets)
        for preferred in ["wk inc flu hosp", "wk flu hosp rate change", "wk inc flu prop ed visits"]:
            if preferred in targets:
                return preferred
        return targets[0] if targets else "wk inc flu hosp"

    def is_target_non_negative(self, target: str) -> bool:
        """
        Determine if the target represents a non-negative quantity (counts, incidence, proportions).
        Config-driven with standard epidemiological naming fallbacks.
        """
        # User config override (`target_metadata` as documented; legacy `target_constraints` still honored)
        for section in ("target_metadata", "target_constraints"):
            override = self._user_config.get(section, {}).get(target, {})
            if "non_negative" in override:
                return bool(override["non_negative"])

        t_lower = target.lower()
        if "rate change" in t_lower or "difference" in t_lower or "diff" in t_lower or "growth" in t_lower:
            return False
        # Incidence, counts, admissions, visits, deaths, cases, proportions are non-negative
        return any(k in t_lower for k in ["hosp", "inc", "count", "prop", "visit", "death", "case", "admiss"])

    def get_target_metadata(self, target: str) -> Dict[str, Any]:
        """
        Get rich, dynamic metadata for a given target variable (display name, unit, rate/count flag).
        Driven by user configuration if specified, with intelligent epidemiological inference fallbacks.
        """
        target_overrides = self._user_config.get("target_metadata", {}).get(target, {})
        is_nn = self.is_target_non_negative(target)
        t_lower = target.lower()

        if t_lower.startswith("peak week "):
            default_display = "Season Peak Week"
            default_unit = "Week (PMF)"
            is_rate = False
            is_categorical = True
        elif t_lower.startswith("peak "):
            default_display = "Season Peak Size"
            default_unit = "Patients / Wk" if "hosp" in t_lower else "Value"
            is_rate = False
            is_categorical = False
        elif "rate change" in t_lower:
            default_display = "Flu Hosp Rate Change"
            default_unit = "Category (PMF)"
            is_rate = False
            is_categorical = True
        elif "hosp" in t_lower:
            default_display = "Incident Flu Admissions"
            default_unit = "Patients / Wk"
            is_rate = False
            is_categorical = False
        elif "prop" in t_lower or "visit" in t_lower:
            default_display = "ED Flu Visits Proportion"
            default_unit = "% ED Visits"
            is_rate = True
            is_categorical = False
        elif "rate" in t_lower:
            default_display = "Hospitalization Rate"
            default_unit = "Rate / 100k"
            is_rate = True
            is_categorical = False
        else:
            default_display = target.replace("_", " ").title()
            default_unit = "Value"
            is_rate = False
            is_categorical = False

        return {
            "target": target,
            "display_name": target_overrides.get("display_name", default_display),
            "unit": target_overrides.get("unit", default_unit),
            "is_rate": target_overrides.get("is_rate", is_rate),
            "is_categorical": target_overrides.get("is_categorical", is_categorical),
            "is_non_negative": target_overrides.get("non_negative", is_nn),
        }

    def get_default_baseline(self, available_models: Optional[List[str]] = None) -> Optional[str]:
        """
        Dynamically determine the default baseline model for relative scoring.
        Returns None if no legitimate baseline model is found or configured.
        Priority:
        1. User config: `default_baseline`
        2. Recognized hub baseline conventions:
           - Models ending in '-baseline' or named 'baseline'
           - Models containing 'flusight-baseline' or 'covidhub-baseline'
           - Models containing 'baseline' (case-insensitive)
        """
        if available_models is None:
            available_models = []

        cfg_baseline = self._user_config.get("default_baseline")
        if cfg_baseline and (not available_models or cfg_baseline in available_models):
            return str(cfg_baseline)

        if not available_models:
            return None

        # Look for explicit baseline models
        for m in available_models:
            m_lower = m.lower()
            if (
                m_lower.endswith("-baseline")
                or m_lower == "baseline"
                or "flusight-baseline" in m_lower
                or "covidhub-baseline" in m_lower
            ):
                return m

        for m in available_models:
            if "baseline" in m.lower():
                return m

        # If no baseline exists, return None rather than an arbitrary non-baseline model
        return None

    def get_recommended_models(self, available_models: Optional[List[str]] = None) -> List[str]:
        """
        Get list of recommended models to pre-select in the dashboard.
        Priority:
        1. User config: `priority_models` or `recommended_models`
        2. Standard reference ensembles, baselines, and production models
        3. First 5 available models
        """
        if available_models is None:
            available_models = []

        cfg_models = self._user_config.get("priority_models") or self._user_config.get("recommended_models")
        if cfg_models and isinstance(cfg_models, list):
            res = [m for m in cfg_models if m in available_models]
            if res:
                return res

        rec = []
        for m in available_models:
            m_lower = m.lower()
            if any(k in m_lower for k in ["baseline", "prod", "flusion", "ensemble"]):
                rec.append(m)

        if rec:
            return rec[:7]
        return available_models[:5]

    def get_server_config(self) -> Dict[str, Any]:
        """Get default server host, port, and allowed origins."""
        return {
            "port": int(self._user_config.get("port", 8501)),
            "host": str(self._user_config.get("host", "127.0.0.1")),
            "allowed_origins": self._user_config.get(
                "allowed_origins",
                ["http://127.0.0.1", "http://localhost", "http://127.0.0.1:8501", "http://localhost:8501"]
            ),
        }


# Backwards compatibility alias
SandboxConfig = VizConfig


