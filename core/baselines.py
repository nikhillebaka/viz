"""
Unified baseline model discovery and reconciliation across hubs, targets, and seasons.

Selects the most appropriate reference baseline dynamically using:
1. Explicit config overrides (per-target or hub-wide `default_baseline`)
2. Hubverse model metadata (`baseline_model: true`) and canonical naming (`baseline`, `*-baseline`)
3. Target and temporal scope coverage (picking a synced/sibling baseline automatically when the
   active repo lacks a baseline for a target or active season, without hardcoding hub names)
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Set

_VARIANT_SUFFIX_RE = re.compile(r"(?:_cat|_test|_alt|_v\d+|_old|_experimental)$", re.IGNORECASE)
_SOURCE_RANK = {"repo": 3, "hub": 2, "local": 1, "synthetic": 0}


def _bare_model_id(model_id: str) -> str:
    return model_id.split(":", 1)[1] if ":" in model_id else model_id


def _is_truthy(v: Any) -> bool:
    return v is True or str(v).strip().lower() in ("true", "yes", "1")


def baseline_tier(
    model_id: str,
    meta: Optional[Dict[str, Any]] = None,
    *,
    config_default: Optional[str] = None,
    target_config_default: Optional[str] = None,
) -> int:
    """
    Score how strongly a model identifies as a canonical reference baseline (0 = not a baseline):
      5: matches explicit config override (per-target or hub-wide)
      4: metadata sets baseline_model=true (and name is not a categorical/experimental variant)
      3: canonical baseline naming ('baseline', '*-baseline', '*_baseline')
      2: baseline variant (e.g. 'FluSight-baseline_cat') or metadata variant
    """
    mid = str(model_id or "").strip()
    if not mid:
        return 0
    if (target_config_default and mid == target_config_default) or (config_default and mid == config_default):
        return 5

    bare = _bare_model_id(mid)
    b_low = bare.lower()
    meta_flag = bool(meta and (_is_truthy(meta.get("baseline_model")) or _is_truthy(meta.get("baseline"))))
    is_variant = bool(_VARIANT_SUFFIX_RE.search(b_low))

    if meta_flag and not is_variant:
        return 4
    if not is_variant and (b_low == "baseline" or b_low.endswith("-baseline") or b_low.endswith("_baseline")):
        return 3
    if meta_flag or "baseline" in b_low:
        return 2
    return 0


def rank_baselines(
    models: Dict[str, Dict[str, Any]],
    *,
    model_meta: Optional[Dict[str, Dict[str, Any]]] = None,
    target: Optional[str] = None,
    dates: Optional[Iterable[str]] = None,
    season: Optional[str] = None,
    config_default: Optional[str] = None,
    target_config_default: Optional[str] = None,
    eligible_ids: Optional[Set[str]] = None,
) -> List[str]:
    """Return candidate baseline model IDs ordered from best match to fallback for the given scope."""
    if not models:
        return []

    date_set = {str(d) for d in dates if d} if dates is not None else None
    meta_map = model_meta or {}
    scored: List[tuple] = []

    for mid, info in models.items():
        if eligible_ids is not None and mid not in eligible_ids:
            continue
        tier = baseline_tier(
            mid,
            meta_map.get(mid),
            config_default=config_default,
            target_config_default=target_config_default,
        )
        if tier == 0:
            continue

        targets = info.get("targets") or []
        if target and targets and target not in targets:
            continue

        if date_set:
            m_dates = set(info.get("dates") or [])
            coverage = len(date_set & m_dates) / len(date_set)
            has_scope = 1 if coverage > 0 else 0
        elif season:
            m_seasons = set(info.get("seasons") or [])
            has_scope = 1 if season in m_seasons else 0
            coverage = float(has_scope)
        else:
            has_scope = 1
            coverage = 1.0

        full_enough = 1 if coverage >= 0.85 else 0
        src = info.get("source") or ("local" if info.get("is_local") else "repo")
        src_rank = _SOURCE_RANK.get(src, 0)
        scored.append((-has_scope, -full_enough, -tier, -src_rank, -coverage, mid))

    scored.sort()
    return [row[-1] for row in scored]


def resolve_baseline(
    models: Dict[str, Dict[str, Any]],
    **kwargs: Any,
) -> Optional[str]:
    """Return the top-ranked baseline model ID for the requested scope, or None."""
    ranked = rank_baselines(models, **kwargs)
    return ranked[0] if ranked else None


def target_baseline_override(config: Any, target: Optional[str]) -> Optional[str]:
    """Read optional per-target baseline override from `target_metadata.<target>.baseline`."""
    if config is None or not target:
        return None
    user_cfg = getattr(config, "_user_config", None) or {}
    meta = user_cfg.get("target_metadata", {}).get(target, {})
    if isinstance(meta, dict):
        val = meta.get("baseline") or meta.get("default_baseline")
        if val:
            return str(val).strip()
    return None


def build_manifest_baselines(
    models: Dict[str, Dict[str, Any]],
    *,
    model_meta: Optional[Dict[str, Dict[str, Any]]] = None,
    targets: Iterable[str] = (),
    seasons_map: Optional[Dict[str, Iterable[str]]] = None,
    config: Any = None,
    default_target: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Compute hub-wide, per-target, and per-(target, season) default baselines plus ordered candidates
    for `/api/next/manifest`.
    """
    user_cfg = getattr(config, "_user_config", None) or {}
    cfg_default = user_cfg.get("default_baseline")
    cfg_default = str(cfg_default).strip() if cfg_default else None

    target_list = list(targets)
    s_map = seasons_map or {}
    by_target: Dict[str, str] = {}
    by_target_season: Dict[str, Dict[str, str]] = {}

    for t in target_list:
        t_cfg = target_baseline_override(config, t)
        t_base = resolve_baseline(
            models,
            model_meta=model_meta,
            target=t,
            config_default=cfg_default,
            target_config_default=t_cfg,
        )
        if t_base:
            by_target[t] = t_base

        per_s: Dict[str, str] = {}
        for s_id, s_rounds in s_map.items():
            s_dates = list(s_rounds)
            sb = resolve_baseline(
                models,
                model_meta=model_meta,
                target=t,
                dates=s_dates or None,
                season=s_id,
                config_default=cfg_default,
                target_config_default=t_cfg,
            )
            if sb:
                # Only pin a season-specific baseline if it actually covers rounds in that season
                m_dates = set(models[sb].get("dates") or [])
                if (s_dates and (set(s_dates) & m_dates)) or (not s_dates and s_id in (models[sb].get("seasons") or [])):
                    per_s[s_id] = sb
        if per_s:
            by_target_season[t] = per_s

    overall = (
        by_target.get(default_target or "")
        or resolve_baseline(models, model_meta=model_meta, config_default=cfg_default)
    )
    candidates = rank_baselines(models, model_meta=model_meta, config_default=cfg_default)

    return {
        "default": overall,
        "by_target": by_target,
        "by_target_season": by_target_season,
        "candidates": candidates,
    }
