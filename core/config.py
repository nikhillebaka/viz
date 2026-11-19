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

from viz.core.calendar import CalendarSpec, infer_calendar

try:
    import tomllib
except ModuleNotFoundError:
    tomllib = None  # type: ignore

logger = logging.getLogger("viz.config")

STANDARD_TASK_ID_COLS = frozenset({
    "reference_date",
    "origin_date",
    "target",
    "location",
    "horizon",
    "target_end_date",
})


class VizConfig:
    """
    Central configuration and discovery manager.
    Reads hub-config/tasks.json and optional viz/config.json or viz/config.toml with graceful fallbacks.
    """

    def __init__(self, base_dir: Path, app_dir: Optional[Path] = None):
        self.base_dir = Path(base_dir).resolve()
        self.hub_config_dir = self.base_dir / "hub-config"
        self.app_dir = Path(app_dir).resolve() if app_dir is not None else None
        self.viz_dir = self.app_dir if self.app_dir is not None else (self.base_dir / "viz")

        self._user_config: Dict[str, Any] = self._load_user_config()
        self._tasks_config: Optional[Dict[str, Any]] = self._load_tasks_config()
        self._target_specs_cache: Optional[Dict[str, Dict[str, Any]]] = None
        self._calendar_cache: Optional[CalendarSpec] = None

    @staticmethod
    def _task_list(spec: Any) -> List[Any]:
        if not isinstance(spec, dict):
            return []
        out: List[Any] = []
        for k in ("required", "optional"):
            v = spec.get(k)
            if isinstance(v, list):
                out.extend(v)
            elif v is not None:
                out.append(v)
        return out

    def _parse_target_specs(self) -> Dict[str, Dict[str, Any]]:
        """Extract rich per-target metadata, output types, extra task IDs, and bounds from tasks.json."""
        if self._target_specs_cache is not None:
            return self._target_specs_cache
        specs: Dict[str, Dict[str, Any]] = {}
        tasks = self._tasks_config
        if not isinstance(tasks, dict):
            self._target_specs_cache = specs
            return specs

        def _entry(t: str) -> Dict[str, Any]:
            return specs.setdefault(t, {
                "target_name": None,
                "target_units": None,
                "target_type": None,
                "description": None,
                "is_step_ahead": None,
                "time_unit": None,
                "output_types": [],
                "categories": [],
                "required_horizons": [],
                "optional_horizons": [],
                "extra_task_ids": {},
                "value_min": None,
                "value_max": None,
                "compound_taskid_set": None,
            })

        for rnd in tasks.get("rounds") or []:
            if not isinstance(rnd, dict):
                continue
            for mt in rnd.get("model_tasks") or []:
                if not isinstance(mt, dict):
                    continue
                tids = mt.get("task_ids") or {}
                tgts = [str(x).strip() for x in self._task_list(tids.get("target")) if str(x).strip()]
                if not tgts:
                    continue

                ot_map = mt.get("output_type") or {}
                ot_names = [str(k).strip() for k in ot_map.keys() if isinstance(k, str)]
                req_h, opt_h = [], []
                h_spec = tids.get("horizon") or {}
                if isinstance(h_spec, dict):
                    for bucket, key in ((req_h, "required"), (opt_h, "optional")):
                        vals = h_spec.get(key)
                        if isinstance(vals, list):
                            for v in vals:
                                try:
                                    bucket.append(int(v))
                                except (TypeError, ValueError):
                                    pass

                extra_dims: Dict[str, List[str]] = {}
                for col, dim_spec in tids.items():
                    if col in STANDARD_TASK_ID_COLS or not isinstance(dim_spec, dict):
                        continue
                    vals = [str(x).strip() for x in self._task_list(dim_spec) if x is not None and str(x).strip()]
                    if vals:
                        extra_dims[col] = vals

                pmf_cats: List[str] = []
                if isinstance(ot_map.get("pmf"), dict):
                    oid_spec = ot_map["pmf"].get("output_type_id") or {}
                    pmf_cats = [str(x).strip() for x in self._task_list(oid_spec) if x is not None and str(x).strip()]

                val_min: Optional[float] = None
                val_max: Optional[float] = None
                compound_set: Optional[List[str]] = None
                for ot_name, ot_cfg in ot_map.items():
                    if not isinstance(ot_cfg, dict):
                        continue
                    val_cfg = ot_cfg.get("value") or {}
                    if isinstance(val_cfg, dict):
                        if isinstance(val_cfg.get("minimum"), (int, float)):
                            mn = float(val_cfg["minimum"])
                            val_min = mn if val_min is None else min(val_min, mn)
                        if isinstance(val_cfg.get("maximum"), (int, float)):
                            mx = float(val_cfg["maximum"])
                            val_max = mx if val_max is None else max(val_max, mx)
                    if ot_name == "sample":
                        params = ot_cfg.get("output_type_id_params") or {}
                        cset = params.get("compound_taskid_set")
                        if isinstance(cset, list) and cset:
                            compound_set = [str(c).strip() for c in cset]

                tmeta_list = mt.get("target_metadata") or []
                tmeta_by_id: Dict[str, Dict[str, Any]] = {}
                for tm in tmeta_list:
                    if isinstance(tm, dict) and tm.get("target_id"):
                        tmeta_by_id[str(tm["target_id"]).strip()] = tm

                for t in tgts:
                    ent = _entry(t)
                    for ot in ot_names:
                        if ot not in ent["output_types"]:
                            ent["output_types"].append(ot)
                    if pmf_cats and not ent["categories"]:
                        ent["categories"] = list(pmf_cats)
                    ent["required_horizons"] = sorted(set(ent["required_horizons"]) | set(req_h))
                    ent["optional_horizons"] = sorted(set(ent["optional_horizons"]) | set(opt_h))
                    for dcol, dvals in extra_dims.items():
                        cur = ent["extra_task_ids"].setdefault(dcol, [])
                        for dv in dvals:
                            if dv not in cur:
                                cur.append(dv)
                    if val_min is not None:
                        ent["value_min"] = val_min if ent["value_min"] is None else min(ent["value_min"], val_min)
                    if val_max is not None:
                        ent["value_max"] = val_max if ent["value_max"] is None else max(ent["value_max"], val_max)
                    if compound_set and not ent["compound_taskid_set"]:
                        ent["compound_taskid_set"] = compound_set
                    tm = tmeta_by_id.get(t) or (tmeta_list[0] if len(tmeta_list) == 1 and isinstance(tmeta_list[0], dict) else None)
                    if tm:
                        for k in ("target_name", "target_units", "target_type", "description", "is_step_ahead", "time_unit"):
                            if tm.get(k) is not None:
                                ent[k] = tm[k]

        self._target_specs_cache = specs
        return specs

    def get_calendar(
        self,
        *,
        observed_rounds: Optional[List[str]] = None,
        observed_target_dates: Optional[List[str]] = None,
        observed_pairs: Optional[List[Any]] = None,
    ) -> CalendarSpec:
        """Infer or return the hub's CalendarSpec (cached when called without dynamic overrides)."""
        if observed_rounds is None and observed_target_dates is None and observed_pairs is None:
            if self._calendar_cache is not None:
                return self._calendar_cache
            cal = infer_calendar(
                self._tasks_config,
                targets=self.get_targets(),
                user_override=self._user_config.get("calendar"),
            )
            self._calendar_cache = cal
            return cal
        return infer_calendar(
            self._tasks_config,
            observed_rounds=observed_rounds,
            observed_target_dates=observed_target_dates,
            observed_pairs=observed_pairs,
            targets=self.get_targets(),
            user_override=self._user_config.get("calendar"),
        )

    def get_extra_task_ids(self, target: Optional[str] = None) -> Dict[str, Dict[str, Any]]:
        """
        Discover extra Hubverse task_id dimensions beyond core columns (e.g. RSV `age_group`).
        Returns `{col: {"values": [...], "default": default_value}}`.
        """
        specs = self._parse_target_specs()
        merged: Dict[str, List[str]] = {}
        items = [specs[target]] if (target and target in specs) else list(specs.values())
        for ent in items:
            for col, vals in ent.get("extra_task_ids", {}).items():
                cur = merged.setdefault(col, [])
                for v in vals:
                    if v not in cur:
                        cur.append(v)

        user_defaults = self._user_config.get("default_dimensions") or {}
        out: Dict[str, Dict[str, Any]] = {}
        for col, vals in merged.items():
            if not vals:
                continue
            pref = str(user_defaults.get(col) or "").strip()
            default_val = pref if pref in vals else None
            if default_val is None:
                for cand in ("0-130", "0-99", "overall", "all", "total", "All"):
                    hit = next((v for v in vals if v.lower() == cand.lower()), None)
                    if hit is not None:
                        default_val = hit
                        break
            out[col] = {
                "values": vals,
                "default": default_val if default_val is not None else vals[0],
            }
        return out

    def _load_user_config(self) -> Dict[str, Any]:
        """Load user-defined configuration from viz/config.json, viz/config.toml, etc."""
        in_hub_viz = (self.base_dir / "viz").resolve()
        candidates = [
            (in_hub_viz / "config.json", False),
            (in_hub_viz / "config.toml", False),
        ]
        if self.app_dir is not None and self.app_dir != in_hub_viz:
            candidates.extend([
                (self.app_dir / "config.json", False),
                (self.app_dir / "config.toml", False),
            ])
        candidates.extend([
            (self.base_dir / "config.json", True),
            (self.base_dir / "config.toml", True),
        ])
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
        """Targets shown in the target selector: everything except season peak targets (see viz.core.peaks)."""
        return [t for t in self.get_targets(discovered_targets) if not t.strip().lower().startswith("peak ")]

    def get_default_target(self, discovered_targets: Optional[List[str]] = None) -> str:
        """Get the default active target variable."""
        if "default_target" in self._user_config:
            return str(self._user_config["default_target"]).strip()
        targets = self.get_weekly_targets(discovered_targets=discovered_targets)
        for preferred in ["wk inc flu hosp", "wk inc covid hosp", "wk inc rsv hosp", "Flu ED visits pct", "ILI incidence"]:
            if preferred in targets:
                return preferred
        specs = self._parse_target_specs()
        for t in targets:
            ent = specs.get(t) or {}
            ots = ent.get("output_types") or []
            if "quantile" in ots or "sample" in ots:
                return t
        return targets[0] if targets else "wk inc flu hosp"

    def is_target_non_negative(self, target: str) -> bool:
        """
        Determine if the target represents a non-negative quantity (counts, incidence, proportions).
        Config-driven via tasks.json bounds with standard epidemiological naming fallbacks.
        """
        for section in ("target_metadata", "target_constraints"):
            override = self._user_config.get(section, {}).get(target, {})
            if "non_negative" in override:
                return bool(override["non_negative"])

        t_lower = target.lower()
        if "rate change" in t_lower or "difference" in t_lower or "diff" in t_lower or "growth" in t_lower:
            return False

        spec = self._parse_target_specs().get(target)
        if spec:
            if spec.get("target_type") in ("ordinal", "nominal"):
                return False
            if spec.get("value_min") is not None:
                return float(spec["value_min"]) >= 0.0

        return any(k in t_lower for k in ["hosp", "inc", "count", "prop", "visit", "death", "case", "admiss", "pct", "rate"])

    @staticmethod
    def _clean_short_target(target: str, scale: str, tmeta_name: Optional[str]) -> str:
        t_low = target.lower()
        if "flu hosp rate change" in t_low:
            return "Rate change"
        if "ed visits" in t_low or "ed visit" in t_low:
            if "ili" in t_low:
                return "ILI ED %" if scale in ("proportion", "percentage") else "ILI ED"
            if "flu" in t_low:
                return "Flu ED %" if scale in ("proportion", "percentage") else "Flu ED"
            if "covid" in t_low:
                return "COVID ED %"
            if "rsv" in t_low:
                return "RSV ED %"
            return "ED visits"
        if "ili incidence" in t_low:
            return "ILI / 100k"
        if "ari incidence" in t_low:
            return "ARI / 100k"
        if "hosp" in t_low or "admit" in t_low:
            if "covid" in t_low:
                return "COVID admissions"
            if "rsv" in t_low:
                return "RSV admissions"
            return "Flu admissions"
        return target if len(target) <= 22 else (tmeta_name or target)[:22]

    def get_target_metadata(self, target: str) -> Dict[str, Any]:
        """
        Get rich, dynamic metadata for a given target variable: display_name, short_name, unit,
        scale ('count'|'proportion'|'percentage'|'rate'|'ordinal_pmf'|'nominal_pmf'|'peak_week_pmf'),
        per_100k_capable, output_types, categories, dimensions, horizons.
        """
        target_overrides = self._user_config.get("target_metadata", {}).get(target, {})
        spec = self._parse_target_specs().get(target) or {}
        is_nn = self.is_target_non_negative(target)
        t_lower = target.lower()
        t_units_raw = str(spec.get("target_units") or "").strip()
        t_units_low = t_units_raw.lower()
        t_type = str(spec.get("target_type") or "").strip().lower()
        output_types = list(spec.get("output_types") or [])
        categories = list(spec.get("categories") or [])
        val_min = spec.get("value_min")
        val_max = spec.get("value_max")

        if t_lower.startswith("peak week "):
            scale = "peak_week_pmf"
            is_rate = False
            is_categorical = True
            default_display = "Season Peak Week"
            default_unit = "Week (PMF)"
        elif t_lower.startswith("peak "):
            scale = "count" if "hosp" in t_lower or "admit" in t_lower or "visit" in t_lower else "rate"
            is_rate = scale != "count"
            is_categorical = False
            default_display = "Season Peak Size"
            default_unit = "Patients / Wk" if scale == "count" else (t_units_raw or "Value")
        elif t_type in ("ordinal", "nominal") or ("pmf" in output_types and "quantile" not in output_types and "sample" not in output_types) or "rate change" in t_lower:
            scale = "ordinal_pmf" if (t_type == "ordinal" or "rate change" in t_lower) else "nominal_pmf"
            is_rate = False
            is_categorical = True
            default_display = str(spec.get("target_name") or "").strip() or ("Flu Hosp Rate Change" if "rate change" in t_lower else target)
            default_unit = "Category (PMF)"
        elif t_units_low == "percentage" or "pct" in t_lower or (val_max == 100 and (val_min is None or val_min >= 0)):
            scale = "percentage"
            is_rate = True
            is_categorical = False
            default_display = str(spec.get("target_name") or "").strip() or target
            default_unit = "%"
        elif t_units_low == "proportion" or " prop " in f" {t_lower} " or (val_max == 1 and val_min == 0 and t_units_low != "count"):
            scale = "proportion"
            is_rate = True
            is_categorical = False
            default_display = str(spec.get("target_name") or "").strip() or "ED Visits Proportion"
            default_unit = "% ED Visits"
        elif "100,000" in t_units_low or "100k" in t_units_low or "incidence" in t_lower or ("rate" in t_lower and "rate change" not in t_lower):
            scale = "rate"
            is_rate = True
            is_categorical = False
            default_display = str(spec.get("target_name") or "").strip() or target
            default_unit = "Cases / 100k" if "case" in t_units_low or "incidence" in t_lower else "Rate / 100k"
        elif "hosp" in t_lower or "admit" in t_lower or t_units_low == "count":
            scale = "count"
            is_rate = False
            is_categorical = False
            if spec.get("target_name"):
                default_display = str(spec["target_name"]).strip()
            elif "covid" in t_lower:
                default_display = "Incident COVID-19 Admissions"
            elif "rsv" in t_lower:
                default_display = "Incident RSV Admissions"
            else:
                default_display = "Incident Flu Admissions"
            default_unit = "Patients / Wk" if ("hosp" in t_lower or "admit" in t_lower) else ("Visits / Wk" if "visit" in t_lower else "Count")
        else:
            scale = "count"
            is_rate = False
            is_categorical = False
            default_display = str(spec.get("target_name") or "").strip() or target.replace("_", " ").title()
            default_unit = t_units_raw or "Value"

        final_scale = str(target_overrides.get("scale") or scale)
        final_is_rate = bool(target_overrides.get("is_rate", is_rate or final_scale in ("proportion", "percentage", "rate")))
        final_short = str(target_overrides.get("short_name") or self._clean_short_target(target, final_scale, spec.get("target_name")))
        dims = self.get_extra_task_ids(target)

        return {
            "target": target,
            "display_name": target_overrides.get("display_name", default_display),
            "short_name": final_short,
            "unit": target_overrides.get("unit", default_unit),
            "scale": final_scale,
            "is_rate": final_is_rate,
            "is_categorical": target_overrides.get("is_categorical", is_categorical),
            "is_non_negative": target_overrides.get("non_negative", is_nn),
            "per_100k_capable": bool(target_overrides.get("per_100k_capable", final_scale == "count" and not final_is_rate)),
            "output_types": output_types,
            "categories": categories,
            "dimensions": dims,
            "horizons": {
                "required": list(spec.get("required_horizons") or []),
                "optional": list(spec.get("optional_horizons") or []),
            },
            "compound_taskid_set": spec.get("compound_taskid_set"),
        }

    def get_default_baseline(
        self,
        available_models: Optional[List[str]] = None,
        *,
        target: Optional[str] = None,
        model_meta: Optional[Dict[str, Dict[str, Any]]] = None,
    ) -> Optional[str]:
        """
        Dynamically determine the default baseline model for relative scoring.
        Returns None if no legitimate baseline model is found or configured.
        """
        from viz.core.baselines import baseline_tier, target_baseline_override

        cfg_baseline = self._user_config.get("default_baseline")
        target_cfg = target_baseline_override(self, target)
        if not available_models:
            return str(target_cfg or cfg_baseline) if (target_cfg or cfg_baseline) else None

        meta_map = model_meta or {}
        best: Optional[str] = None
        best_score = (0, 0)
        for idx, m in enumerate(available_models):
            tier = baseline_tier(
                m,
                meta_map.get(m),
                config_default=str(cfg_baseline) if cfg_baseline else None,
                target_config_default=target_cfg,
            )
            if tier > 0:
                score = (tier, -idx)
                if score > best_score:
                    best_score = score
                    best = m
        return best

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


