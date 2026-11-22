"""
Place-First Live Briefing assembler.

Combines Hubverse multi-hub forecasts, categorical PMFs, season peak outlooks,
local skill calibration, and cached live external surveillance/virology/clade
feeds into a strictly factual, place-first JSON payload served at
`/api/next/briefing`.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import logging
import math
import threading
from typing import Any, Dict, List, Optional, Tuple

import polars as pl

from viz.core.briefing_feeds import (
    US_FIPS_TO_HHS,
    WHO_NH_VACCINE_REFERENCE,
    BriefingFeedStore,
)
from viz.core.evaluation import EvaluationParams
from viz.core.geo import EUROPE_REF, HHS_REGIONS, US_STATES_REF

logger = logging.getLogger("viz.briefings")


def _finite(v: Any) -> bool:
    return v is not None and isinstance(v, (int, float)) and math.isfinite(float(v))


def _pct_delta(cur: Optional[float], prev: Optional[float]) -> Optional[float]:
    if not _finite(cur) or not _finite(prev) or float(prev) == 0.0:
        return None
    return round(((float(cur) - float(prev)) / abs(float(prev))) * 100.0, 1)


def _fmt_num(val: Optional[float], unit: str = "", per_100k: bool = False) -> str:
    if not _finite(val):
        return "—"
    v = float(val)
    if "%" in unit:
        return f"{v:.2f}%" if abs(v) < 10 else f"{v:.1f}%"
    if abs(v) >= 1000 and not per_100k:
        return f"{int(round(v)):,}"
    if abs(v) >= 100:
        return f"{v:.0f}"
    if abs(v) >= 10:
        return f"{v:.1f}"
    return f"{v:.2f}"


def _short_unit(unit: str, per_100k: bool = False) -> str:
    u = (unit or "").strip()
    if per_100k:
        if "per 100" in u.lower():
            return u
        return f"{u} per 100k".strip()
    return u


def _pick_representative_model(ctx: Any, target_id: str, ref_date: Optional[str]) -> Optional[str]:
    models = ctx.loader.scan_models()
    candidates: List[Tuple[int, str]] = []
    for mid, info in models.items():
        t_list = info.get("targets") or []
        if t_list and target_id not in t_list:
            continue
        dates = info.get("dates") or []
        if ref_date and dates and ref_date not in dates:
            continue
        low = mid.lower()
        tier = 4
        if info.get("designated") and "ensemble" in low:
            tier = 0
        elif "ensemble" in low:
            tier = 1
        elif info.get("designated"):
            tier = 2
        elif info.get("is_baseline"):
            tier = 5
        candidates.append((tier, mid))
    if not candidates:
        return None
    candidates.sort(key=lambda x: (x[0], x[1].lower()))
    return candidates[0][1]


def _pick_latest_round_for_target(ctx: Any, target_id: str) -> Optional[str]:
    models = ctx.loader.scan_models()
    ens_dates: List[str] = []
    all_dates: List[str] = []
    for mid, info in models.items():
        t_list = info.get("targets") or []
        if not t_list or target_id in t_list:
            m_dates = info.get("dates") or []
            all_dates.extend(m_dates)
            if info.get("designated") or "ensemble" in mid.lower():
                ens_dates.extend(m_dates)
    if ens_dates:
        return max(ens_dates)
    if all_dates:
        return max(all_dates)
    for s in sorted(ctx.loader.get_forecast_seasons() or [], reverse=True):
        rs = ctx.loader.get_dates_for_season(s)
        if rs:
            return max(rs)
    return ctx.loader.get_latest_reference_date()


def _resolve_jurisdiction(place_info: Dict[str, Any]) -> Dict[str, Any]:
    """Determine country scope, US FIPS/HHS mapping, and Nextstrain region cleanly."""
    pkey = str(place_info.get("key") or "")
    geo_kind = str(place_info.get("geo_kind") or "")
    sfips = place_info.get("state_fips")

    is_us = (
        pkey == "US"
        or pkey in US_STATES_REF
        or sfips in US_STATES_REF
        or geo_kind in ("us-states", "us-metrocast")
    )
    if is_us:
        state_fips = pkey if pkey in US_STATES_REF else sfips
        hhs_num = US_FIPS_TO_HHS.get(state_fips) if state_fips and state_fips != "US" else None
        hhs_meta = HHS_REGIONS.get(hhs_num) if hhs_num else None
        feed_loc = state_fips if state_fips in US_STATES_REF else "US"
        feed_loc_name = US_STATES_REF.get(feed_loc, {}).get("name") or place_info.get("name") or "United States"
        return {
            "jurisdiction_scope": "us",
            "country_iso2": "US",
            "clade_region": "North America",
            "us_feed_loc": feed_loc,
            "us_feed_loc_name": feed_loc_name,
            "hhs_region": hhs_num,
            "hhs_region_label": hhs_meta["name"] if hhs_meta else None,
            "hhs_region_short": hhs_meta["short"] if hhs_meta else None,
        }

    if pkey == "GB" or pkey.startswith("GB-") or geo_kind == "uk-nations":
        return {
            "jurisdiction_scope": "gb",
            "country_iso2": "GB",
            "clade_region": "Europe",
            "us_feed_loc": None,
            "us_feed_loc_name": None,
            "hhs_region": None,
            "hhs_region_label": None,
            "hhs_region_short": None,
        }

    iso2 = pkey.split("-", 1)[0].upper() if pkey else None
    if iso2 and (iso2 in EUROPE_REF or geo_kind == "eu-countries"):
        return {
            "jurisdiction_scope": "eu",
            "country_iso2": iso2,
            "clade_region": "Europe",
            "us_feed_loc": None,
            "us_feed_loc_name": None,
            "hhs_region": None,
            "hhs_region_label": None,
            "hhs_region_short": None,
        }

    return {
        "jurisdiction_scope": "other",
        "country_iso2": None,
        "clade_region": None,
        "us_feed_loc": None,
        "us_feed_loc_name": None,
        "hhs_region": None,
        "hhs_region_label": None,
        "hhs_region_short": None,
    }


def _match_place_key(requested: Optional[str], places: Dict[str, Dict[str, Any]]) -> Tuple[str, bool]:
    """Resolve user-supplied place key / abbr / name cleanly with deterministic default."""
    if not places:
        return "", False
    if requested:
        raw = requested.strip()
        if raw in places:
            return raw, False
        low = raw.lower()
        for k, info in places.items():
            if k.lower() == low or str(info.get("abbr") or "").lower() == low or str(info.get("name") or "").lower() == low:
                return k, False
            for h in info.get("hubs") or []:
                if str(h.get("location_id") or "").lower() == low:
                    return k, False

    if "US" in places:
        return "US", bool(requested)
    # Prefer national-level place or highest-population place in catalog
    countries = [k for k, v in places.items() if v.get("level") == "country"]
    pool = countries or list(places.keys())
    best = max(pool, key=lambda k: (float(places[k].get("population") or 0), k))
    return best, bool(requested)


class BriefingBuilder:
    """Builds cached, multi-hub Place-First Briefings enriched with live external feeds."""

    def __init__(self, hub_manager: Any, feed_store: BriefingFeedStore) -> None:
        self.mgr = hub_manager
        self.feed_store = feed_store
        self._lock = threading.Lock()
        self._cache: Dict[str, Tuple[str, Dict[str, Any]]] = {}

    def invalidate(self) -> None:
        with self._lock:
            self._cache.clear()

    def _get_provider_contexts(self) -> Dict[str, Any]:
        """Map active hub_id -> HubContext across workspace and synced remote hubs."""
        _, providers, _ = self.mgr.catalog._gather_providers()
        return {p["id"]: p["ctx"] for p in providers}

    def _compute_sparklines(
        self,
        ctx: Any,
        target_id: str,
        location_ids: List[str],
        per_100k_pops: Dict[str, Optional[float]],
        limit: int = 10,
        is_proportion: bool = False,
    ) -> Dict[str, Dict[str, Any]]:
        """Batch extract last `limit` observed values + 1-wk change across many peer locations in one query."""
        if not location_ids:
            return {}
        try:
            df = ctx.loader._weekly_truth(target_id)
            if df is None or df.is_empty():
                return {}
            sub = (
                df.filter(pl.col("location").cast(pl.Utf8).is_in([str(x) for x in location_ids]))
                .select(["location", "target_end_date", "value"])
                .sort(["location", "target_end_date"])
            )
            if sub.is_empty():
                return {}
            out: Dict[str, Dict[str, Any]] = {}
            for loc_id, group in sub.group_by("location", maintain_order=False):
                lid = str(loc_id[0] if isinstance(loc_id, tuple) else loc_id)
                tail_rows = group.tail(limit).select(["target_end_date", "value"]).iter_rows()
                dates: List[str] = []
                vals: List[float] = []
                pop = per_100k_pops.get(lid)
                scale = (1e5 / float(pop)) if (_finite(pop) and float(pop) > 1) else (100.0 if is_proportion else 1.0)
                for d, v in tail_rows:
                    if _finite(v):
                        dates.append(str(d)[:10])
                        vals.append(round(float(v) * scale, 3))
                if not vals:
                    continue
                cur = vals[-1]
                prev = vals[-2] if len(vals) >= 2 else None
                out[lid] = {
                    "dates": dates,
                    "values": vals,
                    "latest": cur,
                    "latest_date": dates[-1],
                    "pct_1wk": _pct_delta(cur, prev),
                }
            return out
        except Exception as exc:
            logger.debug("Sparkline query failed for %s: %s", target_id, exc)
            return {}

    def _build_signal_entry(
        self,
        ctx: Any,
        hub_id: str,
        hub_label: str,
        hub_short: str,
        location_id: str,
        population: Optional[float],
        stream_summary: Optional[Dict[str, Any]],
        target_id: str,
        cat_streams: List[Dict[str, Any]],
        pathogen: str,
        pathogen_label: str,
    ) -> Optional[Dict[str, Any]]:
        tm = ctx.config.get_target_metadata(target_id)
        if tm.get("is_categorical"):
            return None

        ref_date = _pick_latest_round_for_target(ctx, target_id) or (stream_summary or {}).get("ref_date")
        if not ref_date:
            return None
        cal = ctx.loader.get_calendar()
        season = cal.season_for_date(ref_date)
        all_seasons = sorted(ctx.loader.get_forecast_seasons() or [season], reverse=True)
        curves_seasons = all_seasons[:4] if season in all_seasons else [season, *all_seasons[:3]]

        per_100k = bool(tm.get("per_100k_capable", False) and _finite(population) and float(population) > 1)
        is_proportion = (tm.get("scale") == "proportion") and not per_100k
        scale_factor = (1e5 / float(population)) if per_100k else (100.0 if is_proportion else 1.0)
        unit = "%" if is_proportion else _short_unit(tm.get("unit") or "", per_100k=per_100k)
        model_id = _pick_representative_model(ctx, target_id, ref_date)

        # 1. Observed + Prior Seasons via get_season_curves
        observed: List[Dict[str, Any]] = []
        prior_seasons: List[Dict[str, Any]] = []
        week_dates: List[str] = []
        season_curves_data: Dict[str, Any] = {}
        try:
            season_curves_data = ctx.loader.get_season_curves(target_id, location_id, curves_seasons)
            week_dates = list(season_curves_data.get("week_dates") or [])
            for c in season_curves_data.get("curves") or []:
                s_name = c.get("season")
                pts = [
                    {
                        "week": int(p["week"]),
                        "date": str(p["date"])[:10],
                        "value": round(float(p["value"]) * scale_factor, 3),
                        "raw_value": float(p["value"]),
                        "phase": p.get("phase"),
                    }
                    for p in (c.get("points") or [])
                    if _finite(p.get("value"))
                ]
                if not pts:
                    continue
                if s_name == season:
                    observed = pts
                else:
                    # Align onto focal season calendar week dates for X-axis overlay
                    aligned_pts = []
                    for pt in pts:
                        wk_idx = int(pt["week"]) - 1
                        mapped_date = week_dates[wk_idx] if 0 <= wk_idx < len(week_dates) else None
                        if mapped_date:
                            aligned_pts.append({
                                "week": pt["week"],
                                "date": mapped_date,
                                "orig_date": pt["date"],
                                "value": pt["value"],
                            })
                    peak_pt = max(pts, key=lambda x: x["value"])
                    prior_seasons.append({
                        "season": s_name,
                        "peak_value": peak_pt["value"],
                        "peak_date": peak_pt["date"],
                        "peak_week": peak_pt["week"],
                        "points": aligned_pts,
                    })
        except Exception as exc:
            logger.debug("Season curves failed for %s/%s: %s", target_id, location_id, exc)

        # Fall back to _weekly_truth tail if focal season not in get_season_curves yet
        if not observed:
            try:
                wt = ctx.loader._weekly_truth(target_id)
                sub = wt.filter(pl.col("location") == str(location_id)).sort("target_end_date").tail(26)
                for idx, (d, v) in enumerate(sub.select(["target_end_date", "value"]).iter_rows()):
                    if _finite(v):
                        observed.append({
                            "week": idx + 1,
                            "date": str(d)[:10],
                            "value": round(float(v) * scale_factor, 3),
                            "raw_value": float(v),
                            "phase": None,
                        })
            except Exception:
                pass

        # 2. Representative Ensemble Forecast Fan
        fan_payload: Optional[Dict[str, Any]] = None
        if model_id:
            try:
                raw_fan = ctx.loader.get_model_fan_data(model_id, target_id, location_id, ref_date)
                if raw_fan and raw_fan.get("target_end_dates"):
                    def _scale_arr(arr: List[Optional[float]]) -> List[Optional[float]]:
                        return [round(float(x) * scale_factor, 3) if _finite(x) else None for x in arr]

                    fan_payload = {
                        "model_id": model_id,
                        "ref_date": ref_date,
                        "horizons": raw_fan["horizons"],
                        "target_end_dates": [str(d)[:10] for d in raw_fan["target_end_dates"]],
                        "median": _scale_arr(raw_fan["median"]),
                        "q50_lower": _scale_arr(raw_fan["q50_lower"]),
                        "q50_upper": _scale_arr(raw_fan["q50_upper"]),
                        "q80_lower": _scale_arr(raw_fan["q80_lower"]),
                        "q80_upper": _scale_arr(raw_fan["q80_upper"]),
                        "q95_lower": _scale_arr(raw_fan["q95_lower"]),
                        "q95_upper": _scale_arr(raw_fan["q95_upper"]),
                    }
            except Exception as exc:
                logger.debug("Fan fetch failed for %s/%s: %s", model_id, location_id, exc)

        # Latest observation & forecast summary stats
        latest_obs_pt = observed[-1] if observed else None
        prev_obs_pt = observed[-2] if len(observed) >= 2 else None
        latest_obs = latest_obs_pt["value"] if latest_obs_pt else (stream_summary or {}).get("observed")
        prev_obs = prev_obs_pt["value"] if prev_obs_pt else None
        obs_date = latest_obs_pt["date"] if latest_obs_pt else (stream_summary or {}).get("obs_date")
        pct_change_1wk = _pct_delta(latest_obs, prev_obs)

        fc_end_median = None
        fc_end_date = None
        fc_end_q95 = None
        fc_horizon = None
        fc_change_pct = None
        if fan_payload and fan_payload["median"]:
            # Last non-null forecast median (usually 3- or 4-week horizon)
            for idx in range(len(fan_payload["median"]) - 1, -1, -1):
                mv = fan_payload["median"][idx]
                if _finite(mv):
                    fc_end_median = mv
                    fc_end_date = fan_payload["target_end_dates"][idx]
                    fc_horizon = fan_payload["horizons"][idx]
                    fc_end_q95 = [fan_payload["q95_lower"][idx], fan_payload["q95_upper"][idx]]
                    fc_change_pct = _pct_delta(mv, latest_obs)
                    break

        # 3. Matched Rate-Change Categorical PMF from the same hub
        rate_change_pmf: Optional[Dict[str, Any]] = None
        matched_cats = [c for c in cat_streams if c.get("hub_id") == hub_id]
        if matched_cats:
            cat_spec = matched_cats[0]
            try:
                pmf_models = [model_id] if model_id else None
                pmf_res = ctx.next_data.pmf(
                    cat_spec["target_id"],
                    season,
                    str(cat_spec.get("location_id") or location_id),
                    round_date=ref_date,
                    models=pmf_models,
                )
                m_map = pmf_res.get("models") or {}
                if not m_map and pmf_models:
                    pmf_res = ctx.next_data.pmf(
                        cat_spec["target_id"],
                        season,
                        str(cat_spec.get("location_id") or location_id),
                        round_date=ref_date,
                    )
                    m_map = pmf_res.get("models") or {}
                if m_map:
                    chosen_m = next(iter(m_map.keys()))
                    by_ref = m_map.get(chosen_m) or {}
                    r_map = by_ref.get(ref_date) or (next(iter(by_ref.values())) if by_ref else {})
                    if r_map:
                        sorted_hs = sorted(r_map.keys(), key=lambda x: int(x))
                        pref_h = "1" if "1" in r_map else sorted_hs[0]
                        slot = r_map[pref_h]
                        rate_change_pmf = {
                            "target_id": cat_spec["target_id"],
                            "label": cat_spec.get("short") or cat_spec.get("label") or cat_spec["target_id"],
                            "ref_date": ref_date,
                            "horizon": int(pref_h),
                            "target_end_date": slot.get("target_end_date"),
                            "model_id": chosen_m,
                            "categories": pmf_res.get("categories") or list((slot.get("probs") or {}).keys()),
                            "probs": slot.get("probs") or {},
                        }
            except Exception as exc:
                logger.debug("PMF briefing fetch failed for %s: %s", cat_spec.get("target_id"), exc)

        # 4. Season Peak Outlook via peaks.season_view (when target has peak targets)
        peak_outlook: Optional[Dict[str, Any]] = None
        if model_id and hasattr(ctx.loader, "peaks") and ctx.loader.peaks.is_available(target_id):
            try:
                pk_res = ctx.loader.peaks.season_view(
                    target_id,
                    str(location_id),
                    ref_date,
                    [model_id],
                    skill_scope="location",
                )
                if pk_res and pk_res.get("models"):
                    m_pk = pk_res["models"][0]
                    timing = m_pk.get("timing")
                    size = m_pk.get("size")
                    obs_pk = pk_res.get("observed")
                    if timing or size:
                        def _scale_val(val: Any) -> Optional[float]:
                            return round(float(val) * scale_factor, 3) if _finite(val) else None

                        def _scale_pair(pair: Any) -> Optional[List[Optional[float]]]:
                            if not isinstance(pair, (list, tuple)) or len(pair) < 2:
                                return None
                            return [_scale_val(pair[0]), _scale_val(pair[1])]

                        peak_outlook = {
                            "model_id": model_id,
                            "timing": {
                                "median": timing.get("median"),
                                "mode": timing.get("mode"),
                                "mode_prob": timing.get("mode_prob"),
                                "i50": timing.get("i50"),
                                "i90": timing.get("i90"),
                            } if timing else None,
                            "size": {
                                "median": _scale_val(size.get("median")),
                                "i50": _scale_pair(size.get("i50")),
                                "i90": _scale_pair(size.get("i90")),
                                "i95": _scale_pair(size.get("i95")),
                            } if size else None,
                            "observed": {
                                "value": _scale_val(obs_pk.get("value")),
                                "dates": obs_pk.get("dates"),
                                "final": bool(obs_pk.get("final")),
                            } if obs_pk else None,
                        }
            except Exception as exc:
                logger.debug("Peak outlook failed for %s/%s: %s", target_id, location_id, exc)

        t_short = tm.get("short_name") or tm.get("display_name") or target_id
        label = f"{pathogen_label} · {t_short}" if pathogen_label.lower() not in t_short.lower() else t_short
        return {
            "signal_id": f"{hub_id}::{target_id}",
            "hub_id": hub_id,
            "hub_label": hub_label,
            "hub_short": hub_short,
            "target_id": target_id,
            "target_short": t_short,
            "label": label,
            "pathogen": pathogen,
            "pathogen_label": pathogen_label,
            "location_id": location_id,
            "season": season,
            "ref_date": ref_date,
            "obs_date": obs_date,
            "horizon_offset_days": int(cal.horizon_offset_days),
            "scale": tm.get("scale") or "count",
            "unit": unit,
            "raw_unit": tm.get("unit") or "",
            "per_100k": per_100k,
            "model_id": model_id,
            "latest_obs": latest_obs,
            "prev_obs": prev_obs,
            "pct_change_1wk": pct_change_1wk,
            "forecast_end_median": fc_end_median,
            "forecast_end_date": fc_end_date,
            "forecast_end_q95": fc_end_q95,
            "forecast_horizon": fc_horizon,
            "forecast_change_pct": fc_change_pct,
            "activity": (stream_summary or {}).get("activity"),
            "observed": observed,
            "prior_seasons": prior_seasons,
            "fan": fan_payload,
            "rate_change_pmf": rate_change_pmf,
            "peak_outlook": peak_outlook,
            "calibration": None,  # populated separately for focal calibration section
        }

    def _evaluate_signal_calibration(
        self,
        ctx: Any,
        signal: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        """Evaluate local forecast skill at this place + target for the current season."""
        try:
            res = ctx.eval_engine.evaluate(
                EvaluationParams(
                    target=signal["target_id"],
                    location=str(signal["location_id"]),
                    season=signal["season"],
                )
            )
            ranked = [r for r in res.rankings if r.get("has_data_in_scope")]
            if not ranked:
                return None
            top_rows = []
            focal_entry = None
            err_scale = 100.0 if (signal.get("scale") == "proportion" and not signal.get("per_100k")) else 1.0
            for idx, r in enumerate(ranked):
                row = {
                    "rank": idx + 1,
                    "model_id": r.get("model_id"),
                    "relative_wis": round(float(r["relative_wis"]), 2) if _finite(r.get("relative_wis")) else None,
                    "wis": round(float(r["wis"]) * err_scale, 2) if _finite(r.get("wis")) else None,
                    "mae": round(float(r["mae"]) * err_scale, 2) if _finite(r.get("mae")) else None,
                    "cov50": round(float(r["cov50"]), 1) if _finite(r.get("cov50")) else None,
                    "cov95": round(float(r["cov95"]), 1) if _finite(r.get("cov95")) else None,
                    "count": int(r.get("count") or 0),
                    "rounds": int(r.get("scope_rounds_available") or 0),
                }
                if r.get("model_id") == signal.get("model_id"):
                    focal_entry = row
                if len(top_rows) < 6:
                    top_rows.append(row)

            # Ensure focal ensemble appears even if ranked below top 6
            if focal_entry and all(t["model_id"] != focal_entry["model_id"] for t in top_rows):
                top_rows.append(focal_entry)

            return {
                "signal_id": signal["signal_id"],
                "signal_label": signal["label"],
                "hub_id": signal["hub_id"],
                "target_id": signal["target_id"],
                "location_id": signal["location_id"],
                "season": signal["season"],
                "baseline_model": res.baseline_model,
                "focal_model": focal_entry,
                "total_models": len(ranked),
                "models": top_rows,
            }
        except Exception as exc:
            logger.debug("Local calibration eval failed for %s: %s", signal.get("signal_id"), exc)
            return None

    def _build_external_feeds_payload(
        self,
        juris: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Extract place-matched series from all locally cached external Parquet feeds."""
        scope = juris["jurisdiction_scope"]
        us_loc = juris["us_feed_loc"]
        us_loc_name = juris["us_feed_loc_name"]
        hhs_reg = juris["hhs_region"]
        iso2 = juris["country_iso2"]
        clade_region = juris["clade_region"]

        cfa_rt_items: List[Dict[str, Any]] = []
        wastewater_items: List[Dict[str, Any]] = []
        ed_visit_items: List[Dict[str, Any]] = []
        nrevss_items: List[Dict[str, Any]] = []
        flu_subtypes: Optional[Dict[str, Any]] = None
        ukhsa_items: List[Dict[str, Any]] = []
        clades_list: List[Dict[str, Any]] = []

        # 1. CDC CFA Rt (US state or National)
        if scope == "us" and us_loc:
            df_rt = self.feed_store.read_feed("cdc_cfa_rt")
            if df_rt is not None and df_rt.height > 0:
                sub = df_rt.filter(pl.col("location_id") == us_loc).sort("date")
                for (path_val,), grp in sub.group_by(["pathogen"], maintain_order=True):
                    tail = grp.tail(16)
                    pts = [
                        {
                            "date": str(r[0])[:10],
                            "median": round(float(r[1]), 3),
                            "lower": round(float(r[2]), 3) if _finite(r[2]) else None,
                            "upper": round(float(r[3]), 3) if _finite(r[3]) else None,
                            "p_growing": round(float(r[4]), 3) if _finite(r[4]) else None,
                            "category": r[5],
                        }
                        for r in tail.select(["date", "median", "lower", "upper", "p_growing", "category"]).iter_rows()
                    ]
                    if pts:
                        latest = pts[-1]
                        cfa_rt_items.append({
                            "pathogen": str(path_val),
                            "label": "Influenza" if path_val == "flu" else ("COVID-19" if path_val == "covid-19" else str(path_val).upper()),
                            "geo_scope": us_loc_name,
                            "latest": latest,
                            "series": pts,
                        })

        # 2. CDC NWSS Wastewater (US state or site-weighted US aggregate)
        if scope == "us" and us_loc:
            df_nw = self.feed_store.read_feed("cdc_nwss")
            if df_nw is not None and df_nw.height > 0:
                sub = df_nw.filter(pl.col("location_id") == us_loc).sort("week_end")
                for (path_val,), grp in sub.group_by(["pathogen"], maintain_order=True):
                    tail = grp.tail(16)
                    pts = [
                        {
                            "date": str(r[0])[:10],
                            "value": round(float(r[1]), 2),
                            "sites": int(r[2] or 0),
                            "is_national_agg": bool(r[3]),
                        }
                        for r in tail.select(["week_end", "mean_wval", "sites", "is_national_agg"]).iter_rows()
                    ]
                    if pts:
                        cur = pts[-1]
                        prev = pts[-2] if len(pts) >= 2 else None
                        wastewater_items.append({
                            "pathogen": str(path_val),
                            "label": "Influenza A" if path_val == "flu" else ("SARS-CoV-2" if path_val == "covid-19" else "RSV"),
                            "geo_scope": us_loc_name if not cur["is_national_agg"] else f"{us_loc_name} (site-weighted avg)",
                            "latest_date": cur["date"],
                            "latest_wval": cur["value"],
                            "sites": cur["sites"],
                            "pct_1wk": _pct_delta(cur["value"], prev["value"] if prev else None),
                            "series": pts,
                        })

        # 3. CDC NSSP Emergency Dept. Visits %
        if scope == "us" and us_loc:
            df_ed = self.feed_store.read_feed("cdc_nssp_ed")
            if df_ed is not None and df_ed.height > 0:
                sub = df_ed.filter(pl.col("location_id") == us_loc).sort("week_end")
                for (path_val,), grp in sub.group_by(["pathogen"], maintain_order=True):
                    tail = grp.tail(16)
                    pts = [
                        {"date": str(r[0])[:10], "value": round(float(r[1]), 2)}
                        for r in tail.select(["week_end", "percent_visits"]).iter_rows()
                    ]
                    if pts:
                        cur = pts[-1]
                        prev = pts[-2] if len(pts) >= 2 else None
                        lbl = {"flu": "Influenza", "covid-19": "COVID-19", "rsv": "RSV", "ari": "Combined ARI"}.get(str(path_val), str(path_val))
                        ed_visit_items.append({
                            "pathogen": str(path_val),
                            "label": lbl,
                            "geo_scope": us_loc_name,
                            "latest_date": cur["date"],
                            "latest_pct": cur["value"],
                            "pct_1wk": _pct_delta(cur["value"], prev["value"] if prev else None),
                            "series": pts,
                        })

        # 4. CDC NREVSS National / Regional Lab Positivity (COVID-19 & RSV)
        if scope == "us":
            df_nr = self.feed_store.read_feed("cdc_nrevss")
            if df_nr is not None and df_nr.height > 0:
                # Prefer matching location_id, else national "US"
                sub = df_nr.filter(pl.col("location_id") == us_loc)
                geo_used = us_loc_name
                if sub.is_empty():
                    sub = df_nr.filter(pl.col("location_id") == "US")
                    geo_used = "United States (National sentinel labs)"
                sub = sub.sort("week_end")
                for (path_val,), grp in sub.group_by(["pathogen"], maintain_order=True):
                    tail = grp.tail(16)
                    pts = [
                        {"date": str(r[0])[:10], "value": round(float(r[1]), 2)}
                        for r in tail.select(["week_end", "percent_positivity"]).iter_rows()
                    ]
                    if pts:
                        cur = pts[-1]
                        prev = pts[-2] if len(pts) >= 2 else None
                        nrevss_items.append({
                            "pathogen": str(path_val),
                            "label": "COVID-19" if path_val == "covid-19" else ("RSV" if path_val == "rsv" else str(path_val).upper()),
                            "geo_scope": geo_used,
                            "latest_date": cur["date"],
                            "latest_pct": cur["value"],
                            "pct_1wk": _pct_delta(cur["value"], prev["value"] if prev else None),
                            "series": pts,
                        })

        # 5. Influenza Subtype Breakdown (Delphi HHS Clinical + WHO FluNet)
        df_who = self.feed_store.read_feed("who_flunet")
        df_delphi = self.feed_store.read_feed("delphi_fluview")

        if scope == "us":
            delphi_reg = f"hhs{hhs_reg}" if hhs_reg else "US"
            delphi_scope_label = juris.get("hhs_region_label") or "United States (National Clinical Labs)"
            delphi_series: List[Dict[str, Any]] = []
            if df_delphi is not None and df_delphi.height > 0:
                sub = df_delphi.filter(pl.col("region") == delphi_reg).sort("week_end").tail(16)
                if sub.is_empty() and delphi_reg != "US":
                    sub = df_delphi.filter(pl.col("region") == "US").sort("week_end").tail(16)
                    delphi_scope_label = "United States (National Clinical Labs)"
                for r in sub.select(["week_end", "total_specimens", "total_a", "total_b", "percent_positive", "percent_a", "percent_b"]).iter_rows():
                    delphi_series.append({
                        "date": str(r[0])[:10],
                        "specimens": int(r[1] or 0),
                        "inf_a": int(r[2] or 0),
                        "inf_b": int(r[3] or 0),
                        "pct_pos": round(float(r[4]), 2) if _finite(r[4]) else None,
                        "pct_a": round(float(r[5]), 2) if _finite(r[5]) else None,
                        "pct_b": round(float(r[6]), 2) if _finite(r[6]) else None,
                    })

            who_us_series: List[Dict[str, Any]] = []
            if df_who is not None and df_who.height > 0:
                sub_w = df_who.filter(pl.col("location_id") == "US").sort("week_start").tail(16)
                for r in sub_w.select(["week_start", "spec_processed", "ah1n1pdm09", "ah3n2", "a_unsubtyped", "inf_a", "inf_b", "rsv"]).iter_rows():
                    who_us_series.append({
                        "date": str(r[0])[:10],
                        "spec_processed": int(r[1] or 0),
                        "ah1n1pdm09": int(r[2] or 0),
                        "ah3n2": int(r[3] or 0),
                        "a_unsubtyped": int(r[4] or 0),
                        "inf_a": int(r[5] or 0),
                        "inf_b": int(r[6] or 0),
                        "rsv": int(r[7] or 0),
                    })

            if delphi_series or who_us_series:
                # Merge weekly WHO H1N1/H3N2 subtype composition with Delphi regional clinical positivity
                latest_d = delphi_series[-1] if delphi_series else None
                # Latest WHO week with positive flu detections
                latest_w = next((x for x in reversed(who_us_series) if (x["inf_a"] + x["inf_b"]) > 0), who_us_series[-1] if who_us_series else None)
                flu_subtypes = {
                    "source": "Delphi FluView Clinical + WHO FluNet",
                    "geo_scope": delphi_scope_label,
                    "subtyping_geo_scope": "United States (WHO FluNet)",
                    "latest_date": (latest_d or {}).get("date") or (latest_w or {}).get("date"),
                    "percent_positive": (latest_d or {}).get("pct_pos"),
                    "total_specimens": (latest_d or {}).get("specimens"),
                    "latest_counts": latest_w,
                    "delphi_latest": latest_d,
                    "series": who_us_series if who_us_series else delphi_series,
                    "clinical_series": delphi_series,
                }
        elif iso2 and df_who is not None and df_who.height > 0:
            sub_w = df_who.filter(pl.col("location_id") == iso2).sort("week_start").tail(16)
            geo_scope = EUROPE_REF.get(iso2, {}).get("name") or iso2
            if sub_w.is_empty():
                # Aggregate WHO European Region counts cleanly when country hasn't reported individually
                eur_df = df_who.filter(pl.col("who_region") == "EUR")
                if eur_df.height > 0:
                    sub_w = (
                        eur_df.group_by("week_start")
                        .agg([
                            pl.col("spec_processed").sum(),
                            pl.col("ah1n1pdm09").sum(),
                            pl.col("ah3n2").sum(),
                            pl.col("a_unsubtyped").sum(),
                            pl.col("inf_a").sum(),
                            pl.col("inf_b").sum(),
                            pl.col("rsv").sum(),
                        ])
                        .sort("week_start")
                        .tail(16)
                    )
                    geo_scope = "WHO European Region (aggregate)"
            if sub_w.height > 0:
                who_series = [
                    {
                        "date": str(r[0])[:10],
                        "spec_processed": int(r[1] or 0),
                        "ah1n1pdm09": int(r[2] or 0),
                        "ah3n2": int(r[3] or 0),
                        "a_unsubtyped": int(r[4] or 0),
                        "inf_a": int(r[5] or 0),
                        "inf_b": int(r[6] or 0),
                        "rsv": int(r[7] or 0),
                    }
                    for r in sub_w.select(["week_start", "spec_processed", "ah1n1pdm09", "ah3n2", "a_unsubtyped", "inf_a", "inf_b", "rsv"]).iter_rows()
                ]
                latest_w = next((x for x in reversed(who_series) if (x["inf_a"] + x["inf_b"]) > 0), who_series[-1])
                spec_nb = latest_w.get("spec_processed") or 0
                flu_pos = latest_w.get("inf_a", 0) + latest_w.get("inf_b", 0)
                pct_pos = round((flu_pos / spec_nb) * 100.0, 2) if spec_nb > 0 else None
                flu_subtypes = {
                    "source": "WHO RespiMart FluNet",
                    "geo_scope": geo_scope,
                    "subtyping_geo_scope": geo_scope,
                    "latest_date": latest_w["date"],
                    "percent_positive": pct_pos,
                    "total_specimens": spec_nb,
                    "latest_counts": latest_w,
                    "series": who_series,
                }

        # 6. UKHSA England / UK Respiratory PCR Positivity
        if scope == "gb":
            df_uk = self.feed_store.read_feed("ukhsa_resp")
            if df_uk is not None and df_uk.height > 0:
                for (path_val,), grp in df_uk.sort("week_end").group_by(["pathogen"], maintain_order=True):
                    tail = grp.tail(16)
                    pts = [{"date": str(r[0])[:10], "value": round(float(r[1]), 2)} for r in tail.select(["week_end", "value"]).iter_rows()]
                    if pts:
                        cur = pts[-1]
                        prev = pts[-2] if len(pts) >= 2 else None
                        ukhsa_items.append({
                            "pathogen": str(path_val),
                            "label": {"influenza": "Influenza", "covid-19": "COVID-19", "rsv": "RSV"}.get(str(path_val), str(path_val).title()),
                            "geo_scope": "England (UKHSA PCR testing)",
                            "latest_date": cur["date"],
                            "latest_pct": cur["value"],
                            "pct_1wk": _pct_delta(cur["value"], prev["value"] if prev else None),
                            "series": pts,
                        })

        # 7. Nextstrain Clade Frequencies (regional North America / Europe)
        if clade_region:
            df_ns = self.feed_store.read_feed("nextstrain_clades")
            if df_ns is not None and df_ns.height > 0:
                sub = df_ns.filter(pl.col("region") == clade_region)
                for (path_val, sub_val), grp in sub.group_by(["pathogen", "subtype"], maintain_order=True):
                    dates = sorted({str(d)[:10] for d in grp.get_column("date").to_list()})
                    if not dates:
                        continue
                    dates = dates[-12:]
                    latest_dt = dates[-1]
                    # Keep clades ordered by latest date share (descending, Other last)
                    latest_rows = grp.filter(pl.col("date") == latest_dt)
                    latest_map = {
                        str(r[0]): round(float(r[1]) * 100.0, 1)
                        for r in latest_rows.select(["clade", "frequency"]).iter_rows()
                    }
                    all_clades = sorted(
                        {str(c) for c in grp.filter(pl.col("date").is_in(dates)).get_column("clade").to_list()},
                        key=lambda c: (c == "Other", -(latest_map.get(c, 0.0)), c),
                    )
                    date_idx = {d: i for i, d in enumerate(dates)}
                    series_by_clade: Dict[str, List[float]] = {c: [0.0] * len(dates) for c in all_clades}
                    for dt_s, cl_s, freq in grp.filter(pl.col("date").is_in(dates)).select(["date", "clade", "frequency"]).iter_rows():
                        di = date_idx.get(str(dt_s)[:10])
                        if di is not None and str(cl_s) in series_by_clade and _finite(freq):
                            series_by_clade[str(cl_s)][di] = round(float(freq) * 100.0, 1)
                    latest_shares = [
                        {"clade": c, "pct": latest_map[c]}
                        for c in all_clades
                        if c in latest_map and latest_map[c] > 0.0
                    ]
                    clades_list.append({
                        "pathogen": str(path_val),
                        "subtype": str(sub_val),
                        "region": clade_region,
                        "latest_date": latest_dt,
                        "dates": dates,
                        "clades": all_clades,
                        "series_by_clade": series_by_clade,
                        "latest_shares": latest_shares,
                    })

        return {
            "cfa_rt": cfa_rt_items,
            "wastewater": wastewater_items,
            "ed_visits": ed_visit_items,
            "nrevss_positivity": nrevss_items,
            "flu_subtypes": flu_subtypes,
            "ukhsa_positivity": ukhsa_items,
            "clades": clades_list,
        }

    def _build_peers_section(
        self,
        place_info: Dict[str, Any],
        juris: Dict[str, Any],
        catalog: Dict[str, Any],
        globe: Dict[str, Any],
        ctxs: Dict[str, Any],
        primary_sig: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Build child subregion table (e.g. HSAs or states) and regional peer table."""
        pkey = place_info["key"]
        regions = globe.get("regions") or {}
        places = catalog.get("places") or {}

        # Grab cached CFA Rt and NWSS latest per location_id for enrichment
        rt_by_loc: Dict[str, Dict[str, Any]] = {}
        df_rt = self.feed_store.read_feed("cdc_cfa_rt")
        focal_path = primary_sig["pathogen"] if primary_sig else "flu"
        if df_rt is not None and df_rt.height > 0:
            sub_rt = df_rt.filter(pl.col("pathogen") == focal_path).sort("date")
            for loc_id, dt_s, med, p_grow, cat in sub_rt.select(["location_id", "date", "median", "p_growing", "category"]).iter_rows():
                rt_by_loc[str(loc_id)] = {
                    "median": round(float(med), 2) if _finite(med) else None,
                    "p_growing": round(float(p_grow), 2) if _finite(p_grow) else None,
                    "category": cat,
                    "date": str(dt_s)[:10],
                }

        who_pos_by_loc: Dict[str, Dict[str, Any]] = {}
        df_who = self.feed_store.read_feed("who_flunet")
        if df_who is not None and df_who.height > 0:
            for loc_id, wk_s, spec_nb, inf_all in df_who.sort("week_start").select(["location_id", "week_start", "spec_processed", "inf_all"]).iter_rows():
                if spec_nb and spec_nb > 0:
                    who_pos_by_loc[str(loc_id)] = {
                        "pct_pos": round((float(inf_all or 0) / float(spec_nb)) * 100.0, 1),
                        "date": str(wk_s)[:10],
                    }

        def _make_peer_rows(
            peer_keys: List[str],
            hub_id: Optional[str],
            target_id: Optional[str],
            use_per_100k: bool,
            is_proportion: bool = False,
        ) -> List[Dict[str, Any]]:
            # Map catalog place_key -> hub location_id for batch sparkline query
            loc_by_pkey: Dict[str, str] = {}
            pops_by_loc: Dict[str, Optional[float]] = {}
            for k in peer_keys:
                p_ent = places.get(k)
                if not p_ent:
                    continue
                if hub_id:
                    for h in p_ent.get("hubs") or []:
                        if h["hub_id"] == hub_id:
                            lid = str(h["location_id"])
                            loc_by_pkey[k] = lid
                            pops_by_loc[lid] = p_ent.get("population") if use_per_100k else None
                            break

            sparks: Dict[str, Dict[str, Any]] = {}
            if hub_id and target_id and hub_id in ctxs and loc_by_pkey:
                sparks = self._compute_sparklines(
                    ctxs[hub_id],
                    target_id,
                    list(set(loc_by_pkey.values())),
                    pops_by_loc,
                    is_proportion=is_proportion,
                )

            rows: List[Dict[str, Any]] = []
            for k in peer_keys:
                p_ent = places.get(k)
                g_reg = regions.get(k) or {}
                if not p_ent:
                    continue
                lid = loc_by_pkey.get(k)
                sp = sparks.get(lid or "") or {}
                # Fall back to matching globe stream stats if sparkline target differs
                matched_stream = next(
                    (s for s in (g_reg.get("streams") or []) if target_id and s.get("target_id") == target_id and s.get("hub_id") == hub_id),
                    None,
                )
                fallback_obs = (matched_stream or {}).get("observed")
                if fallback_obs is not None and is_proportion:
                    fallback_obs = round(float(fallback_obs) * 100.0, 3)
                val = sp.get("latest") if sp.get("latest") is not None else fallback_obs
                pct_1wk = sp.get("pct_1wk") if sp.get("pct_1wk") is not None else (matched_stream or {}).get("trend_pct")
                rt_info = rt_by_loc.get(k)
                who_info = who_pos_by_loc.get(k)
                rows.append({
                    "key": k,
                    "name": p_ent["name"],
                    "abbr": p_ent["abbr"],
                    "level": p_ent["level"],
                    "value": val,
                    "activity": (matched_stream or {}).get("activity") or g_reg.get("composite_activity"),
                    "pct_1wk": pct_1wk,
                    "sparkline": sp.get("values") or [],
                    "rt": rt_info,
                    "who_pct_pos": (who_info or {}).get("pct_pos"),
                })
            # Sort descending by activity/value so highest intensity appears first
            rows.sort(
                key=lambda r: (
                    r["activity"] is None,
                    -(float(r["activity"]) if r["activity"] is not None else 0.0),
                    -(float(r["value"]) if r["value"] is not None else 0.0),
                    r["name"],
                )
            )
            return rows

        # Group 1: Direct subregions (e.g., states within US, HSAs within MA/TX/etc.)
        child_keys = [k for k in (place_info.get("children") or []) if k in places]
        subregion_rows: List[Dict[str, Any]] = []
        subregion_label = ""
        if child_keys:
            # Find shared hub+target that covers child keys (prefer MetroCast if children are non-states)
            child_sample = places[child_keys[0]]
            sub_hub = None
            sub_target = None
            sub_unit = ""
            sub_per_100k = False
            sub_is_prop = False
            if primary_sig and any(h["hub_id"] == primary_sig["hub_id"] for h in child_sample.get("hubs") or []):
                sub_hub = primary_sig["hub_id"]
                sub_target = primary_sig["target_id"]
                sub_unit = primary_sig["unit"]
                sub_per_100k = primary_sig["per_100k"]
                sub_is_prop = (primary_sig.get("scale") == "proportion") and not sub_per_100k
            elif child_sample.get("hubs"):
                h0 = child_sample["hubs"][0]
                sub_hub = h0["hub_id"]
                t0 = (h0.get("targets") or [{}])[0]
                sub_target = t0.get("target_id") or t0.get("id")
                if sub_hub in ctxs and sub_target:
                    tm0 = ctxs[sub_hub].config.get_target_metadata(sub_target)
                    sub_per_100k = bool(tm0.get("per_100k_capable")) and bool(child_sample.get("population"))
                    sub_is_prop = (tm0.get("scale") == "proportion") and not sub_per_100k
                    sub_unit = "%" if sub_is_prop else _short_unit(tm0.get("unit") or "", per_100k=sub_per_100k)
            subregion_rows = _make_peer_rows(child_keys, sub_hub, sub_target, sub_per_100k, is_proportion=sub_is_prop)
            if pkey == "US":
                subregion_label = "US States & Jurisdictions"
            else:
                subregion_label = f"Sub-regions within {place_info['name']}"
            return {
                "title": subregion_label,
                "unit": sub_unit,
                "focal_key": pkey,
                "rows": subregion_rows[:24],
                "total_count": len(subregion_rows),
            }

        # Group 2: Peer states in same HHS region or European neighbor countries
        peer_keys: List[str] = []
        peer_title = ""
        if juris["jurisdiction_scope"] == "us" and juris["hhs_region"]:
            hhs_num = juris["hhs_region"]
            peer_keys = [
                k for k, info in places.items()
                if US_FIPS_TO_HHS.get(k) == hhs_num and info.get("level") == "state"
            ]
            peer_title = f"HHS {HHS_REGIONS[hhs_num]['name']}"
        elif juris["jurisdiction_scope"] in ("eu", "gb"):
            peer_keys = [
                k for k, info in places.items()
                if info.get("geo_kind") in ("eu-countries", "uk-nations") and info.get("level") == "country"
            ]
            if not peer_keys:
                peer_keys = [k for k, info in places.items() if info.get("geo_kind") in ("eu-countries", "uk-nations")]
            peer_title = "European & UK Peer Jurisdictions"

        if peer_keys and pkey not in peer_keys:
            peer_keys.append(pkey)

        if peer_keys and primary_sig:
            peer_is_prop = (primary_sig.get("scale") == "proportion") and not primary_sig.get("per_100k")
            peer_rows = _make_peer_rows(
                peer_keys,
                primary_sig["hub_id"],
                primary_sig["target_id"],
                primary_sig["per_100k"],
                is_proportion=peer_is_prop,
            )
            return {
                "title": peer_title or "Regional Comparison",
                "unit": primary_sig["unit"],
                "focal_key": pkey,
                "rows": peer_rows[:20],
                "total_count": len(peer_rows),
            }

        return {"title": "Regional Comparison", "unit": "", "focal_key": pkey, "rows": [], "total_count": 0}

    @staticmethod
    def _compose_summary(
        place_info: Dict[str, Any],
        juris: Dict[str, Any],
        signals: List[Dict[str, Any]],
        ext: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Generate strictly factual, non-opinionated plain-English epidemiological notes."""
        name = place_info["name"]
        sentences: List[str] = []

        if signals:
            lead = signals[0]
            obs_str = _fmt_num(lead.get("latest_obs"), lead.get("unit") or "", lead.get("per_100k", False))
            unit_str = f" {lead['unit']}" if lead.get("unit") and "%" not in lead["unit"] else ""
            date_clause = f" in the week ending {lead['obs_date']}" if lead.get("obs_date") else ""
            delta = lead.get("pct_change_1wk")
            if delta is not None:
                dir_word = "higher" if delta > 0 else ("lower" if delta < 0 else "unchanged")
                delta_str = f" ({abs(delta):.1f}% {dir_word} than the prior week)" if delta != 0 else " (unchanged from the prior week)"
            else:
                delta_str = ""
            sentences.append(
                f"In {name}, {lead['label']} stood at {obs_str}{unit_str}{date_clause}{delta_str}."
            )

            other_sigs = [s for s in signals[1:] if _finite(s.get("latest_obs"))][:2]
            if other_sigs:
                others = []
                for s in other_sigs:
                    val_s = _fmt_num(s.get("latest_obs"), s.get("unit") or "", s.get("per_100k", False))
                    u_s = f" {s['unit']}" if s.get("unit") and "%" not in s["unit"] else ""
                    others.append(f"{s['label']} at {val_s}{u_s}")
                sentences.append(f"Other connected indicators for {name} report " + " and ".join(others) + ".")

            if _finite(lead.get("forecast_end_median")) and lead.get("forecast_end_date"):
                fc_str = _fmt_num(lead["forecast_end_median"], lead.get("unit") or "", lead.get("per_100k", False))
                q95 = lead.get("forecast_end_q95") or [None, None]
                band = ""
                if _finite(q95[0]) and _finite(q95[1]):
                    lo_s = _fmt_num(q95[0], lead.get("unit") or "", lead.get("per_100k", False))
                    hi_s = _fmt_num(q95[1], lead.get("unit") or "", lead.get("per_100k", False))
                    band = f" (95% interval {lo_s}–{hi_s})"
                sentences.append(
                    f"The {lead.get('model_id') or 'hub ensemble'} median projection for {lead['forecast_end_date']} is {fc_str}{unit_str}{band}."
                )
        else:
            sentences.append(f"{name} has no quantitative hub forecast streams currently synced.")

        # Factual Rt & virological context if cached
        rt_parts: List[str] = []
        for item in ext.get("cfa_rt") or []:
            lat = item.get("latest") or {}
            if _finite(lat.get("median")):
                pg = f", Pr(growing) {int(round(lat['p_growing'] * 100))}%" if _finite(lat.get("p_growing")) else ""
                rt_parts.append(f"{item['label']} Rt = {lat['median']:.2f} ({lat.get('category') or 'estimated'}{pg})")
        if rt_parts:
            sentences.append(f"CDC CFA estimates indicate " + "; ".join(rt_parts) + ".")

        sub_info = ext.get("flu_subtypes")
        if sub_info and sub_info.get("latest_counts"):
            c = sub_info["latest_counts"]
            tot_a_sub = (c.get("ah1n1pdm09") or 0) + (c.get("ah3n2") or 0)
            if tot_a_sub > 0:
                h3_pct = round((c.get("ah3n2", 0) / tot_a_sub) * 100)
                h1_pct = 100 - h3_pct
                sentences.append(
                    f"Among subtyped Influenza A specimens in {sub_info.get('subtyping_geo_scope')}, "
                    f"A(H3N2) accounted for {h3_pct}% and A(H1N1)pdm09 for {h1_pct}% in the week of {c.get('date')}."
                )

        return {
            "headline": f"{name} — Respiratory Activity & Forecast Summary",
            "paragraphs": sentences,
            "scope_note": (
                f"Sub-state indicators reflect state ({juris['us_feed_loc_name']}) or {juris['hhs_region_label']} surveillance where local laboratory feeds are aggregated."
                if place_info.get("level") not in ("state", "country", "nation") and juris["jurisdiction_scope"] == "us"
                else None
            ),
        }

    @staticmethod
    def _compose_kpis(
        place_info: Dict[str, Any],
        signals: List[Dict[str, Any]],
        ext: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        kpis: List[Dict[str, Any]] = []
        if signals:
            lead = signals[0]
            u = lead.get("unit") or ""
            p100 = lead.get("per_100k", False)
            d1 = lead.get("pct_change_1wk")
            delta_str = f"{d1:+.1f}% wk/wk" if d1 is not None else "latest obs"
            kpis.append({
                "label": lead["target_short"],
                "value": _fmt_num(lead.get("latest_obs"), u, p100),
                "unit": u if "%" not in u else "",
                "sub": f"{delta_str} · {lead.get('obs_date') or ''}".strip(" ·"),
            })
            if _finite(lead.get("forecast_end_median")):
                fd = lead.get("forecast_change_pct")
                kpis.append({
                    "label": f"Ensemble ({lead.get('forecast_end_date')})",
                    "value": _fmt_num(lead["forecast_end_median"], u, p100),
                    "unit": u if "%" not in u else "",
                    "sub": (f"{fd:+.1f}% vs latest" if fd is not None else lead.get("model_id") or "Projection"),
                })

        for item in (ext.get("cfa_rt") or [])[:2]:
            lat = item.get("latest") or {}
            if _finite(lat.get("median")):
                pg = f" · P(grow) {int(round(lat['p_growing'] * 100))}%" if _finite(lat.get("p_growing")) else ""
                kpis.append({
                    "label": f"{item['label']} Rt",
                    "value": f"{lat['median']:.2f}",
                    "unit": "",
                    "sub": f"{lat.get('category') or ''}{pg}".strip(" ·"),
                })

        nwss_list = ext.get("wastewater") or []
        if nwss_list:
            # Prefer pathogen matching primary signal
            pref_p = signals[0]["pathogen"] if signals else "flu"
            match = next((w for w in nwss_list if w["pathogen"] == pref_p), nwss_list[0])
            w_d = match.get("pct_1wk")
            kpis.append({
                "label": f"Wastewater ({match['label']})",
                "value": f"{match['latest_wval']:.2f}",
                "unit": "WVAL",
                "sub": f"{match['sites']} sites · {w_d:+.1f}% wk/wk" if w_d is not None else f"{match['sites']} sites",
            })

        ed_list = ext.get("ed_visits") or []
        if ed_list:
            pref_p = signals[0]["pathogen"] if signals else "flu"
            match_ed = next((e for e in ed_list if e["pathogen"] == pref_p), ed_list[0])
            ed_d = match_ed.get("pct_1wk")
            kpis.append({
                "label": f"ED Visits ({match_ed['label']})",
                "value": f"{match_ed['latest_pct']:.1f}%",
                "unit": "",
                "sub": f"{ed_d:+.1f}% wk/wk · {match_ed['latest_date']}" if ed_d is not None else match_ed["latest_date"],
            })

        uk_list = ext.get("ukhsa_positivity") or []
        if uk_list and not ed_list:
            m_uk = uk_list[0]
            kpis.append({
                "label": f"UKHSA PCR ({m_uk['label']})",
                "value": f"{m_uk['latest_pct']:.1f}%",
                "unit": "",
                "sub": m_uk["latest_date"],
            })

        sub_info = ext.get("flu_subtypes")
        if sub_info and sub_info.get("percent_positive") is not None:
            kpis.append({
                "label": "Flu Test Positivity",
                "value": f"{sub_info['percent_positive']:.1f}%",
                "unit": "",
                "sub": f"{sub_info['geo_scope']} · {sub_info.get('latest_date') or ''}".strip(" ·"),
            })

        clades = ext.get("clades") or []
        if clades:
            pref_p = signals[0]["pathogen"] if signals else "flu"
            m_cl = next((c for c in clades if c["pathogen"] == pref_p and c.get("latest_shares")), clades[0])
            if m_cl.get("latest_shares"):
                top_cl = m_cl["latest_shares"][0]
                kpis.append({
                    "label": f"Top {m_cl['subtype']} Clade",
                    "value": top_cl["clade"],
                    "unit": f"{top_cl['pct']:.0f}%",
                    "sub": f"{m_cl['region']} · {m_cl['latest_date']}",
                })

        return kpis[:6]

    def build_briefing(self, place_key: Optional[str] = None) -> Dict[str, Any]:
        """Construct complete factual Place-First Briefing payload for `place_key`."""
        catalog = self.mgr.catalog.build_catalog()
        globe = self.mgr.catalog.build_globe()
        feed_status = self.feed_store.get_status()
        places = catalog.get("places") or {}

        resolved_key, missing_req = _match_place_key(place_key, places)
        feed_stamp_sig = "|".join(
            f"{k}:{v.get('fetched_at') or ''}:{v.get('rows') or 0}"
            for k, v in sorted((feed_status.get("feeds") or {}).items())
        )
        cache_stamp = hashlib.sha1(
            f"{catalog.get('stamp','')}|{globe.get('stamp','')}|{feed_stamp_sig}".encode("utf-8")
        ).hexdigest()[:16]

        if resolved_key:
            with self._lock:
                cached = self._cache.get(resolved_key)
                if cached is not None and cached[0] == cache_stamp:
                    payload = dict(cached[1])
                    payload["requested_place_missing"] = missing_req
                    payload["feed_status"] = feed_status
                    return payload

        if not resolved_key or resolved_key not in places:
            return {
                "empty": True,
                "requested_place": place_key,
                "requested_place_missing": bool(place_key),
                "place": None,
                "place_chooser": [],
                "signals": [],
                "kpis": [],
                "peers": {"title": "Regional Comparison", "unit": "", "focal_key": None, "rows": [], "total_count": 0},
                "virology": {"feeds_cached": feed_status["any_cached"], "clades": [], "vaccine_reference": WHO_NH_VACCINE_REFERENCE},
                "calibration": [],
                "sources": {"hubs": [], "feeds": list((feed_status.get("feeds") or {}).values())},
                "feed_status": feed_status,
                "meta": {
                    "reporting_week": None,
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "cache_stamp": cache_stamp,
                },
            }

        place_info = places[resolved_key]
        globe_reg = (globe.get("regions") or {}).get(resolved_key) or {}
        juris = _resolve_jurisdiction(place_info)
        ctxs = self._get_provider_contexts()
        cat_streams = globe_reg.get("categorical_streams") or []
        stream_by_sig = {s["signal_id"]: s for s in (globe_reg.get("streams") or [])}

        signals: List[Dict[str, Any]] = []
        contrib_hubs: List[Dict[str, Any]] = []
        for h_ent in place_info.get("hubs") or []:
            hid = h_ent["hub_id"]
            ctx = ctxs.get(hid)
            if ctx is None:
                continue
            lid = str(h_ent["location_id"])
            hub_latest_ref = None
            hub_latest_obs = None
            for t_ent in h_ent.get("targets") or []:
                tid = t_ent.get("target_id") or t_ent.get("id")
                if not tid:
                    continue
                sig_id = f"{hid}::{tid}"
                s_entry = self._build_signal_entry(
                    ctx=ctx,
                    hub_id=hid,
                    hub_label=h_ent["hub_label"],
                    hub_short=h_ent["hub_short"],
                    location_id=lid,
                    population=place_info.get("population"),
                    stream_summary=stream_by_sig.get(sig_id),
                    target_id=tid,
                    cat_streams=cat_streams,
                    pathogen=h_ent["pathogen"],
                    pathogen_label=h_ent["pathogen_label"],
                )
                if s_entry is not None:
                    signals.append(s_entry)
                    if s_entry.get("ref_date"):
                        hub_latest_ref = max(hub_latest_ref or "", s_entry["ref_date"])
                    if s_entry.get("obs_date"):
                        hub_latest_obs = max(hub_latest_obs or "", s_entry["obs_date"])
            contrib_hubs.append({
                "hub_id": hid,
                "label": h_ent["hub_label"],
                "short": h_ent["hub_short"],
                "location_id": lid,
                "pathogen": h_ent["pathogen_label"],
                "latest_ref_date": hub_latest_ref,
                "latest_obs_date": hub_latest_obs,
            })

        # Sort signals: observed series first, flagship count/rate targets ahead of proportions, then activity
        def _signal_rank(s: Dict[str, Any]) -> Tuple[Any, ...]:
            tid_low = str(s.get("target_id") or "").lower()
            is_flagship = s.get("scale") != "proportion" and any(k in tid_low for k in ("hosp", "admission", "ili", "ari"))
            return (
                s.get("latest_obs") is None,
                0 if is_flagship else (1 if s.get("scale") != "proportion" else 2),
                -(float(s["activity"]) if _finite(s.get("activity")) else -1.0),
                s["pathogen_label"],
                s["target_short"],
            )

        signals.sort(key=_signal_rank)

        # Evaluate local skill calibration for up to 3 connected signals cleanly
        calibrations: List[Dict[str, Any]] = []
        for s in signals[:3]:
            ctx = ctxs.get(s["hub_id"])
            if ctx is None:
                continue
            cal_item = self._evaluate_signal_calibration(ctx, s)
            if cal_item:
                s["calibration"] = cal_item
                calibrations.append(cal_item)

        ext = self._build_external_feeds_payload(juris)
        peers = self._build_peers_section(
            place_info,
            juris,
            catalog,
            globe,
            ctxs,
            signals[0] if signals else None,
        )
        summary = self._compose_summary(place_info, juris, signals, ext)
        kpis = self._compose_kpis(place_info, signals, ext)

        # Determine reporting week across signals + external feeds
        all_dates = [
            d for d in (
                [s.get("obs_date") for s in signals]
                + [s.get("ref_date") for s in signals]
                + [f.get("latest_week") for f in (feed_status.get("feeds") or {}).values()]
            )
            if d
        ]
        reporting_week = max(all_dates) if all_dates else None

        parent_key = place_info.get("parent_key")
        parent_ent = places.get(parent_key) if parent_key else None

        chooser = sorted(
            [
                {
                    "key": k,
                    "name": v["name"],
                    "abbr": v["abbr"],
                    "level": v["level"],
                    "geo_kind": v["geo_kind"],
                    "state_fips": v.get("state_fips"),
                    "parent_key": v.get("parent_key"),
                    "hub_count": len(v.get("hubs") or []),
                }
                for k, v in places.items()
            ],
            key=lambda x: (
                0 if x["key"] == "US" else (1 if x["level"] in ("country", "nation", "state") else 2),
                x["name"],
            ),
        )

        # Determine relevant seasons in WHO vaccine reference (latest season first)
        current_vacc_season = "2026-27"
        if signals and signals[0].get("season") and signals[0]["season"] in {"2025-26", "2026-27"}:
            current_vacc_season = signals[0]["season"]

        payload: Dict[str, Any] = {
            "empty": False,
            "requested_place": place_key,
            "requested_place_missing": missing_req,
            "place": {
                "key": resolved_key,
                "name": place_info["name"],
                "abbr": place_info["abbr"],
                "level": place_info["level"],
                "geo_kind": place_info["geo_kind"],
                "state_fips": place_info.get("state_fips"),
                "population": place_info.get("population"),
                "parent": (
                    {"key": parent_ent["key"], "name": parent_ent["name"], "abbr": parent_ent["abbr"]}
                    if parent_ent
                    else None
                ),
                **juris,
            },
            "place_chooser": chooser,
            "meta": {
                "reporting_week": reporting_week,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "cache_stamp": cache_stamp,
            },
            "summary": summary,
            "kpis": kpis,
            "signals": signals,
            "peers": peers,
            "virology": {
                "feeds_cached": feed_status["any_cached"],
                "refreshing": feed_status["refreshing"],
                **ext,
                "vaccine_season": current_vacc_season,
                "vaccine_reference": WHO_NH_VACCINE_REFERENCE,
            },
            "calibration": calibrations,
            "sources": {
                "hubs": contrib_hubs,
                "feeds": list((feed_status.get("feeds") or {}).values()),
            },
            "feed_status": feed_status,
        }

        with self._lock:
            self._cache[resolved_key] = (cache_stamp, payload)
        return payload
