"""
Unified Cross-Hub Catalog and Multi-Hub Globe Aggregation for `/next/`.

Treats local workspaces and synced remote hubs as a single seamless set of data
providers indexed by canonical place (US states, MetroCast HSAs, EU countries)
and by pathogen/target, while deduplicating compatible remote hubs already
covered by a registered local workspace hub.
"""

from __future__ import annotations

import hashlib
import math
import re
import threading
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from viz.core.geo import EUROPE_REF, US_ABBR_TO_FIPS, US_STATES_REF

PATHOGEN_LABELS: Dict[str, Tuple[str, str]] = {
    "flu": ("influenza", "Influenza"),
    "influenza": ("influenza", "Influenza"),
    "covid": ("covid19", "COVID-19"),
    "covid19": ("covid19", "COVID-19"),
    "rsv": ("rsv", "RSV"),
    "respiratory_syndromic": ("syndromic", "ILI / ARI"),
    "syndromic": ("syndromic", "ILI / ARI"),
}

CONCEPT_LABELS: Dict[str, str] = {
    "flu_ed_share": "Influenza ED visits share",
    "flu_hosp": "Influenza hospital admissions",
    "flu_hosp_rate_change": "Influenza hospital admissions rate change",
    "ili_ed_share": "ILI ED visits share",
    "ili_ed_visits": "ILI ED visits",
    "ili_incidence": "ILI incidence",
    "ari_incidence": "ARI incidence",
    "covid_hosp": "COVID-19 hospital admissions",
    "covid_ed_share": "COVID-19 ED visits share",
    "rsv_hosp": "RSV hospital admissions",
    "rsv_ed_share": "RSV ED visits share",
}

_RE_ED = re.compile(r"\bed\b|ed_|_ed|emergency")
_RE_HOSP = re.compile(r"hosp|admit|admission|nhsn")
_RE_SHARE = re.compile(r"\bproportion\b|\bpercentage\b|\bpct\b|\bprop\b|\bshare\b|%")
_RE_ILI = re.compile(r"\bili\b|influenza-like|influenza like")
_RE_ARI = re.compile(r"\bari\b|acute respiratory")


def canonical_target_concept(
    target_id: str,
    metadata: Optional[Dict[str, Any]],
    pathogen: str,
    *,
    user_aliases: Optional[Dict[str, Dict[str, str]]] = None,
    hub_id: Optional[str] = None,
) -> Tuple[str, str, bool]:
    """
    Map a hub-specific target into `(concept_id, concept_label, ambiguous)`.
    Respects explicit user overrides first; falls back to semantic classification,
    marking unrecognized targets `ambiguous=True` so users can unify them via Data sources.
    """
    tm = metadata or {}
    if user_aliases and hub_id:
        explicit = (user_aliases.get(hub_id) or {}).get(target_id)
        if isinstance(explicit, str) and explicit.strip():
            cid = explicit.strip()
            return (cid, CONCEPT_LABELS.get(cid, tm.get("display_name") or target_id), False)

    disp = str(tm.get("display_name") or target_id)
    short = str(tm.get("short_name") or "")
    scale = str(tm.get("scale") or "").lower()
    text = f"{target_id} {disp} {short}".lower()

    if pathogen == "influenza" and (tm.get("is_categorical") or ("rate" in text and "change" in text)):
        cid = "flu_hosp_rate_change"
        return (cid, CONCEPT_LABELS[cid], False)

    is_share = scale in ("proportion", "percentage") or bool(_RE_SHARE.search(text))
    is_ed = bool(_RE_ED.search(text))
    is_hosp = bool(_RE_HOSP.search(text))
    is_ili = bool(_RE_ILI.search(text))
    is_ari = bool(_RE_ARI.search(text))
    is_inc = "incidence" in text

    if is_ili:
        if is_ed and is_share:
            return ("ili_ed_share", CONCEPT_LABELS["ili_ed_share"], False)
        if is_ed:
            return ("ili_ed_visits", CONCEPT_LABELS["ili_ed_visits"], False)
        if is_inc or pathogen == "syndromic":
            return ("ili_incidence", CONCEPT_LABELS["ili_incidence"], False)

    if is_ari and (is_inc or pathogen == "syndromic"):
        return ("ari_incidence", CONCEPT_LABELS["ari_incidence"], False)

    if is_ed and is_share:
        by_p = {"influenza": "flu_ed_share", "covid19": "covid_ed_share", "rsv": "rsv_ed_share"}
        cid = by_p.get(pathogen)
        if cid:
            return (cid, CONCEPT_LABELS[cid], False)

    if is_hosp:
        by_p = {"influenza": "flu_hosp", "covid19": "covid_hosp", "rsv": "rsv_hosp"}
        cid = by_p.get(pathogen)
        if cid:
            return (cid, CONCEPT_LABELS[cid], False)

    tid_low = re.sub(r"[^a-z0-9]+", "_", str(target_id).strip().lower()).strip("_") or "target"
    return (f"custom::{pathogen}::{tid_low}", disp, True)


def infer_pathogen(
    hub_id: str,
    label: str,
    spec: Any = None,
    targets: Optional[Iterable[str]] = None,
) -> Tuple[str, str]:
    """Infer canonical `(pathogen_key, pathogen_label)` from a HubSpec, targets, or hub label."""
    def _match_explicit(text: str) -> Optional[Tuple[str, str]]:
        if not text:
            return None
        if "covid" in text or "sars" in text:
            return ("covid19", "COVID-19")
        if re.search(r"(?<![a-z])rsv(?![a-z])", text):
            return ("rsv", "RSV")
        if _RE_ILI.search(text) or _RE_ARI.search(text) or "syndromic" in text:
            return ("syndromic", "ILI / ARI")
        if re.search(r"(?<![a-z])(flu|influenza)(?![a-z])|flusight", text):
            return ("influenza", "Influenza")
        return None

    # Explicit pathogen names in target IDs beat hub spec/folder slugs
    t_hay = " ".join(str(t) for t in (targets or [])).lower()
    if m := _match_explicit(t_hay):
        return m

    raw_p = str(getattr(spec, "pathogen", "") or "").strip().lower()
    if raw_p in PATHOGEN_LABELS:
        return PATHOGEN_LABELS[raw_p]

    h_hay = " ".join([str(label), str(hub_id)]).lower()
    if m := _match_explicit(h_hay):
        return m

    combined = f"{t_hay} {h_hay}"
    if "ed visits" in combined or "hosp" in combined:
        return ("influenza", "Influenza")
    clean = str(getattr(spec, "short_label", "") or label or hub_id).strip()
    return (clean.lower() or "other", clean or "Forecasts")


def classify_geo_kind(locations: Dict[str, Dict[str, Any]], geo: Any) -> str:
    """Classify hub geography into `us-metrocast` | `us-states` | `eu-countries` | `other`."""
    levels = {str(v.get("level") or "").lower() for v in locations.values()}
    if levels & {"hsa", "region", "borough", "metro", "subnational"}:
        return "us-metrocast"
    ids = set(locations.keys())
    if "US" in ids or any(lid in US_STATES_REF for lid in ids):
        return "us-states"
    eu_keys = set(EUROPE_REF.keys()) | {"UK"}
    if ids & eu_keys:
        return "eu-countries"
    if any(str(v.get("canonical_id") or "").startswith("EU:") for v in locations.values()):
        return "eu-countries"
    if any(str(v.get("canonical_id") or "").startswith("US:") for v in locations.values()):
        return "us-states"
    return "other"


def canonical_place_key(hub_id: str, loc_id: str, loc: Dict[str, Any], geo_kind: str) -> Tuple[str, Optional[str], Optional[str]]:
    """
    Map a hub-specific location entry into `(canonical_place_key, state_fips, parent_key)`.
    Merges shared entities (e.g. `"25"` in FluSight/COVID/RSV & statewide `"MA"` in MetroCast;
    `"UK"` & `"GB"` across European hubs) while keeping MetroCast HSAs as distinct sub-state places.
    """
    cid = str(loc.get("canonical_id") or "")
    lvl = str(loc.get("level") or "").lower()

    if loc_id == "US" or cid == "US":
        return ("US", None, None)

    # US state (FIPS row in state hubs OR statewide aggregate row in MetroCast)
    if cid.startswith("US:"):
        parts = cid.split(":")
        if len(parts) == 2 and parts[1] in US_STATES_REF and len(parts[1]) == 2:
            return (parts[1], parts[1], "US")
        if len(parts) >= 3 and parts[1] in US_STATES_REF and len(parts[1]) == 2:
            if lvl == "state":
                return (parts[1], parts[1], "US")
            return (loc_id, parts[1], parts[1])

    if loc_id in US_STATES_REF and loc_id != "US":
        return (loc_id, loc_id, "US")

    # European country / sub-nation normalization (`UK` and `GB` share canonical key `GB`)
    if loc_id in ("UK", "GB") or cid in ("EU:GB", "CUSTOM:UK"):
        return ("GB", None, None)
    if cid.startswith("EU:"):
        code = cid[3:]
        parent = "GB" if code.startswith("GB-") else None
        return (code, None, parent)
    if loc_id in EUROPE_REF:
        parent = EUROPE_REF[loc_id].get("parent_id")
        return (loc_id, None, "GB" if parent == "GB" else parent)

    if geo_kind == "us-metrocast":
        abbr = str(loc.get("abbr") or "").upper()
        sfips = US_ABBR_TO_FIPS.get(abbr)
        if lvl == "state" and sfips:
            return (sfips, sfips, "US")
        return (loc_id, None, str(loc.get("parent_id") or "") or None)

    return (f"{hub_id}:{loc_id}", None, None)


def _finite(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v))


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)


def _percentile(sorted_vals: List[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    pos = int(_clamp(q, 0.0, 1.0) * (len(sorted_vals) - 1))
    return float(sorted_vals[pos])


def _region_label_for(geo_kind: str) -> str:
    if geo_kind == "eu-countries":
        return "Europe"
    if geo_kind == "us-metrocast":
        return "US · MetroCast"
    if geo_kind == "us-states":
        return "US"
    return "Other"


class WorkspaceCatalog:
    """Thread-safe cross-hub catalog and multi-hub globe aggregator."""

    def __init__(self, hub_manager: Any):
        self.mgr = hub_manager
        self._lock = threading.RLock()
        self._catalog_stamp: Optional[Tuple[Any, ...]] = None
        self._catalog_cache: Optional[Dict[str, Any]] = None
        self._globe_hub_cache: Dict[str, Tuple[Tuple[Any, ...], Dict[str, Any]]] = {}
        self._globe_cache: Optional[Tuple[str, Dict[str, Any]]] = None

    def invalidate(self):
        """Drop cached cross-hub catalog and globe spatial snapshots."""
        with self._lock:
            self._catalog_stamp = None
            self._catalog_cache = None
            self._globe_hub_cache.clear()
            self._globe_cache = None

    def _state_stamp(self) -> Tuple[Any, ...]:
        mgr = self.mgr
        local_recs = [(r.id, r.path) for r in mgr.registry.list_hubs()]
        remote_ids = tuple(mgr.remote_store.synced_hub_ids())
        enabled_mask = tuple((rid, mgr.remote_store.is_enabled(rid)) for rid in remote_ids)
        aliases = mgr.registry.get_target_aliases()
        aliases_stamp = tuple(sorted((hid, tuple(sorted(m.items()))) for hid, m in aliases.items()))
        return (
            mgr.mode,
            mgr.default_hub_id(),
            tuple(local_recs),
            mgr.remote_store.state_mtime(),
            enabled_mask,
            aliases_stamp,
        )

    def _gather_providers(self) -> Tuple[Optional[str], List[Dict[str, Any]], Dict[str, str]]:
        """
        Assemble deduplicated provider hubs (registered local hubs first, then non-subsumed
        synced remote hubs). Returns `(active_hub_id, providers, subsumed_map)`.
        """
        mgr = self.mgr
        active_id = mgr.default_hub_id()
        user_aliases = mgr.registry.get_target_aliases()
        records = list(mgr.registry.list_hubs())
        # Evaluate the active local hub first so it takes precedence cleanly
        records.sort(key=lambda r: (0 if r.id == active_id else 1, r.id))

        providers: List[Dict[str, Any]] = []
        local_profiles: List[Dict[str, Any]] = []

        for rec in records:
            ctx = mgr.get_context(rec.id)
            if ctx is None:
                continue
            weekly = list(ctx.config.get_weekly_targets())
            has_rounds = any(ctx.loader.get_dates_for_season(s) for s in ctx.loader.get_forecast_seasons())
            if not weekly or not has_rounds:
                continue
            locs = ctx.loader.get_locations()
            geo_kind = classify_geo_kind(locs, ctx.loader.get_geo_graph())
            local_concepts: Set[str] = set()
            for lt in weekly:
                tm = ctx.config.get_target_metadata(lt)
                tp, _ = infer_pathogen(rec.id, ctx.display_label, targets=[lt])
                cid, _, ambig = canonical_target_concept(lt, tm, tp, user_aliases=user_aliases, hub_id=rec.id)
                if not ambig:
                    local_concepts.add(cid)
            local_profiles.append({
                "id": rec.id,
                "targets": set(ctx.config.get_targets()),
                "weekly": set(weekly),
                "concepts": local_concepts,
                "geo_kind": geo_kind,
                "locations": set(locs.keys()),
            })
            providers.append({
                "id": rec.id,
                "ctx": ctx,
                "kind": "local",
                "remote_id": None,
                "spec": None,
                "allowed_targets": None,  # all targets allowed
            })

        subsumed_map: Dict[str, str] = {}
        from viz.core.workspace import REMOTE_HUB_PREFIX

        for rid in mgr.remote_store.synced_hub_ids():
            ws_id = f"{REMOTE_HUB_PREFIX}{rid}"
            ctx = mgr.get_context(ws_id)
            if ctx is None:
                continue
            r_weekly = list(ctx.config.get_weekly_targets())
            has_rounds = any(ctx.loader.get_dates_for_season(s) for s in ctx.loader.get_forecast_seasons())
            if not r_weekly or not has_rounds:
                continue
            r_weekly_set = set(r_weekly)
            spec = mgr.remote_store.get_spec(rid)
            r_locs_dict = ctx.loader.get_locations()
            r_locs = set(r_locs_dict.keys())
            r_geo_kind = classify_geo_kind(r_locs_dict, ctx.loader.get_geo_graph())
            r_concepts: Dict[str, Tuple[str, str, bool]] = {}
            for rt in r_weekly:
                tm = ctx.config.get_target_metadata(rt)
                rp, _ = infer_pathogen(ws_id, ctx.display_label, spec=spec, targets=[rt])
                r_concepts[rt] = canonical_target_concept(rt, tm, rp, user_aliases=user_aliases, hub_id=ws_id)

            covered_targets: Set[str] = set()
            best_local: Optional[str] = None
            for lp in local_profiles:
                if lp["geo_kind"] != r_geo_kind:
                    continue
                # Pass targets=None to allow renamed/aliased local targets with matching
                # canonical concepts in the same geography to subsume equivalent remote targets.
                if not mgr.remote_store.is_compatible(rid, targets=None, locations=lp["locations"]):
                    continue
                loc_overlap = lp["locations"] & r_locs
                if lp["locations"] and r_locs:
                    if not loc_overlap:
                        continue
                    if len(lp["locations"]) > 3 and len(r_locs) > 3 and len(loc_overlap) < min(len(lp["locations"]), len(r_locs)) * 0.4:
                        continue
                overlap: Set[str] = set()
                for rt in r_weekly_set:
                    if rt in lp["weekly"]:
                        overlap.add(rt)
                        continue
                    rcid, _, r_ambig = r_concepts[rt]
                    if not r_ambig and rcid in lp["concepts"]:
                        overlap.add(rt)
                if overlap:
                    covered_targets.update(overlap)
                    if best_local is None:
                        best_local = lp["id"]

            if best_local is not None and covered_targets >= r_weekly_set:
                subsumed_map[ws_id] = best_local
                continue

            allowed = [t for t in r_weekly if t not in covered_targets]
            if not allowed:
                subsumed_map[ws_id] = best_local or ""
                continue

            providers.append({
                "id": ws_id,
                "ctx": ctx,
                "kind": "remote",
                "remote_id": rid,
                "spec": spec,
                "allowed_targets": set(allowed) if covered_targets else None,
            })

        return active_id, providers, subsumed_map

    def build_catalog(self) -> Dict[str, Any]:
        """Build or return the cached unified cross-hub catalog of providers, targets, and places."""
        stamp = self._state_stamp()
        with self._lock:
            if self._catalog_cache is not None and self._catalog_stamp == stamp:
                return self._catalog_cache

        active_id, providers, subsumed_map = self._gather_providers()
        user_aliases = self.mgr.registry.get_target_aliases()
        hubs_out: List[Dict[str, Any]] = []
        targets_out: List[Dict[str, Any]] = []
        places: Dict[str, Dict[str, Any]] = {}
        children_by_parent: Dict[str, Set[str]] = {}
        stamp_parts: List[str] = [str(active_id or "")]

        for prov in providers:
            hub_id: str = prov["id"]
            ctx = prov["ctx"]
            spec = prov["spec"]
            allowed_targets: Optional[Set[str]] = prov["allowed_targets"]

            all_weekly = list(ctx.config.get_weekly_targets())
            weekly = [t for t in all_weekly if allowed_targets is None or t in allowed_targets]
            if not weekly:
                continue

            models = ctx.loader.scan_models()
            latest_round: Optional[str] = None
            for s in ctx.loader.get_forecast_seasons():
                rs = ctx.loader.get_dates_for_season(s)
                if rs:
                    top = max(rs)
                    if latest_round is None or top > latest_round:
                        latest_round = top

            geo = ctx.loader.get_geo_graph()
            locs = ctx.loader.get_locations()
            geo_kind = classify_geo_kind(locs, geo)
            region_label = _region_label_for(geo_kind)
            pathogen, pathogen_label = infer_pathogen(hub_id, ctx.display_label, spec=spec, targets=weekly)
            short_label = (getattr(spec, "short_label", None) if spec else None) or ctx.display_label
            hub_def_loc = geo.default_location()

            stamp_parts.append(f"{hub_id}:{ctx.next_data._stamp()}")
            hubs_out.append({
                "id": hub_id,
                "label": ctx.display_label,
                "short_label": short_label,
                "kind": prov["kind"],
                "remote_id": prov["remote_id"],
                "pathogen": pathogen,
                "pathogen_label": pathogen_label,
                "geo_kind": geo_kind,
                "region_label": region_label,
                "default_location": hub_def_loc,
                "latest_round": latest_round,
                "model_count": len(models),
                "targets_count": len(weekly),
                "active": hub_id == active_id,
            })

            hub_aliases = user_aliases.get(hub_id) or {}
            season_start = None
            if latest_round:
                try:
                    cal = ctx.loader.get_calendar()
                    season_start = cal.season_bounds(cal.season_for_date(latest_round))[0]
                except Exception:
                    season_start = None
            hub_target_entries: List[Dict[str, Any]] = []
            valid_locs_by_target: Dict[str, Set[str]] = {}
            for tid in weekly:
                tm = ctx.config.get_target_metadata(tid)
                t_path, t_path_label = infer_pathogen(hub_id, ctx.display_label, spec=spec, targets=[tid])
                cid, clabel, ambig = canonical_target_concept(
                    tid, tm, t_path, user_aliases=user_aliases, hub_id=hub_id
                )
                valid_locs = ctx.next_data.valid_locations_for_target(tid)
                if not valid_locs:
                    continue
                valid_locs_by_target[tid] = valid_locs
                obs_by_loc = ctx.next_data._observed(tid)
                target_def_loc = hub_def_loc
                if target_def_loc not in valid_locs:
                    target_def_loc = next(iter(sorted(valid_locs)))
                if obs_by_loc:
                    def_dates = obs_by_loc.get(target_def_loc, ([], []))[0]
                    has_active_def = bool(def_dates) and (
                        any(d >= season_start for d in def_dates) if season_start else True
                    )
                    if not has_active_def:
                        candidates = []
                        for lid, (dates, _) in obs_by_loc.items():
                            if dates and lid in valid_locs:
                                recent = sum(1 for d in dates if d >= season_start) if season_start else len(dates)
                                if recent:
                                    pop = locs[lid].get("population") or 0
                                    candidates.append((1, pop, recent, lid))
                        if not candidates:
                            for lid, (dates, _) in obs_by_loc.items():
                                if dates and lid in valid_locs:
                                    pop = locs[lid].get("population") or 0
                                    candidates.append((0, pop, len(dates), lid))
                        if candidates:
                            candidates.sort(key=lambda item: (-item[0], -item[1], -item[2], item[3]))
                            target_def_loc = candidates[0][3]

                t_rec = {
                    "key": f"{hub_id}::{tid}",
                    "hub_id": hub_id,
                    "hub_label": ctx.display_label,
                    "hub_short": short_label,
                    "target_id": tid,
                    "label": tm.get("display_name") or tid,
                    "short": tm.get("short_name") or (tm.get("display_name") or tid),
                    "concept_id": cid,
                    "concept_label": clabel,
                    "ambiguous": ambig,
                    "user_aliased": tid in hub_aliases,
                    "default_location": target_def_loc,
                    "pathogen": t_path,
                    "pathogen_label": t_path_label,
                    "geo_kind": geo_kind,
                    "region_label": region_label,
                    "is_categorical": bool(tm.get("is_categorical")),
                    "output_types": list(tm.get("output_types") or ["quantile"]),
                    "scale": tm.get("scale") or "count",
                    "unit": tm.get("unit") or "",
                    "per_100k_capable": bool(tm.get("per_100k_capable", False)),
                    "dimensions": tm.get("dimensions") or {},
                    "location_count": len(valid_locs),
                }
                targets_out.append(t_rec)
                hub_target_entries.append({
                    "target_id": tid,
                    "label": t_rec["label"],
                    "short": t_rec["short"],
                    "concept_id": cid,
                    "concept_label": clabel,
                    "pathogen": t_path,
                    "pathogen_label": t_path_label,
                    "is_categorical": t_rec["is_categorical"],
                })

            for lid, ldict in locs.items():
                loc_targets = [
                    te for te in hub_target_entries
                    if lid in valid_locs_by_target.get(te["target_id"], ())
                ]
                if not loc_targets:
                    continue
                pkey, sfips, parent_key = canonical_place_key(hub_id, lid, ldict, geo_kind)
                if parent_key and parent_key != pkey:
                    children_by_parent.setdefault(parent_key, set()).add(pkey)

                name = "United States" if pkey == "US" else ("United Kingdom" if pkey == "GB" else (ldict.get("name") or lid))
                abbr = "UK" if pkey == "GB" else (ldict.get("abbreviation") or ldict.get("abbr") or lid)
                lvl = str(ldict.get("level") or "custom")
                if pkey == "25" or (sfips and pkey == sfips and pkey in US_STATES_REF):
                    ref = US_STATES_REF[pkey]
                    name = ref["name"]
                    abbr = ref["abbr"]
                    lvl = ref["level"]

                p_entry = places.get(pkey)
                if p_entry is None:
                    p_entry = {
                        "key": pkey,
                        "name": name,
                        "abbr": abbr,
                        "level": lvl,
                        "geo_kind": "us-metrocast" if geo_kind == "us-metrocast" and lvl != "state" else (
                            "us-states" if pkey == "US" or (pkey in US_STATES_REF) else geo_kind
                        ),
                        "state_fips": sfips,
                        "parent_key": parent_key,
                        "lat": ldict.get("lat"),
                        "lon": ldict.get("lon"),
                        "population": ldict.get("population"),
                        "hubs": [],
                    }
                    places[pkey] = p_entry
                else:
                    # Prefer US-state canonical metadata/population when multiple hubs share a state key
                    if geo_kind == "us-states" and pkey in US_STATES_REF:
                        p_entry["name"] = US_STATES_REF[pkey]["name"]
                        p_entry["abbr"] = US_STATES_REF[pkey]["abbr"]
                        p_entry["level"] = US_STATES_REF[pkey]["level"]
                        p_entry["geo_kind"] = "us-states"
                    if p_entry.get("lat") is None and ldict.get("lat") is not None:
                        p_entry["lat"] = ldict.get("lat")
                        p_entry["lon"] = ldict.get("lon")
                    if p_entry.get("population") is None and ldict.get("population") is not None:
                        p_entry["population"] = ldict.get("population")

                if not any(h["hub_id"] == hub_id for h in p_entry["hubs"]):
                    p_entry["hubs"].append({
                        "hub_id": hub_id,
                        "hub_label": ctx.display_label,
                        "hub_short": short_label,
                        "location_id": lid,
                        "pathogen": pathogen,
                        "pathogen_label": pathogen_label,
                        "region_label": region_label,
                        "targets": loc_targets,
                    })

        for parent_k, kids in children_by_parent.items():
            if parent_k in places:
                places[parent_k]["children"] = sorted(kids)

        payload = {
            "stamp": hashlib.sha1("|".join(stamp_parts).encode("utf-8")).hexdigest()[:16],
            "active_hub": active_id,
            "resolved_active_hub": subsumed_map.get(active_id or "", active_id),
            "hubs": hubs_out,
            "targets": targets_out,
            "concepts": [{"id": cid, "label": lbl} for cid, lbl in CONCEPT_LABELS.items()],
            "target_aliases": user_aliases,
            "places": places,
            "subsumed_map": subsumed_map,
        }
        with self._lock:
            self._catalog_stamp = stamp
            self._catalog_cache = payload
        return payload

    # ------------------------------------------------------------------ Multi-Hub Globe

    @staticmethod
    def _pick_representative_models(
        models: Dict[str, Dict[str, Any]],
        target: str,
        ref_date: Optional[str],
        *,
        get_meta: Optional[Any] = None,
        hub_id: Optional[str] = None,
    ) -> List[str]:
        """Select 1-2 representative official hub ensemble models covering `target` at `ref_date`."""
        return rank_ensemble_candidates(models, target, ref_date, get_meta=get_meta, hub_id=hub_id)[:2]

    def _compute_hub_globe_slice(self, prov: Dict[str, Any], catalog_places: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
        """Extract cached spatial summaries for one provider hub across its weekly targets."""
        hub_id: str = prov["id"]
        ctx = prov["ctx"]
        spec = prov["spec"]
        allowed_targets: Optional[Set[str]] = prov["allowed_targets"]
        stamp_key = (ctx.next_data._stamp(), tuple(sorted(allowed_targets)) if allowed_targets else None)

        with self._lock:
            cached = self._globe_hub_cache.get(hub_id)
            if cached is not None and cached[0] == stamp_key:
                return cached[1]

        all_weekly = list(ctx.config.get_weekly_targets())
        weekly = [t for t in all_weekly if allowed_targets is None or t in allowed_targets]
        geo = ctx.loader.get_geo_graph()
        locs = ctx.loader.get_locations()
        geo_kind = classify_geo_kind(locs, geo)
        short_label = (getattr(spec, "short_label", None) if spec else None) or ctx.display_label
        models = ctx.loader.scan_models()
        agg_ids = geo.aggregate_locations_in_scope()

        # Find latest round with data across seasons
        latest_round: Optional[str] = None
        for s in ctx.loader.get_forecast_seasons():
            rs = ctx.loader.get_dates_for_season(s)
            if rs:
                top = max(rs)
                if latest_round is None or top > latest_round:
                    latest_round = top

        signals: List[Dict[str, Any]] = []
        cat_targets: List[Dict[str, Any]] = []
        place_streams: Dict[str, List[Dict[str, Any]]] = {}

        for tid in weekly:
            tm = ctx.config.get_target_metadata(tid)
            if tm.get("is_categorical"):
                vlocs = ctx.next_data.valid_locations_for_target(tid)
                cat_targets.append({
                    "hub_id": hub_id,
                    "hub_short": short_label,
                    "target_id": tid,
                    "short": tm.get("short_name") or tm.get("display_name") or tid,
                    "label": tm.get("display_name") or tid,
                    "is_categorical": True,
                    "_valid_locs": set(vlocs) if vlocs else None,
                })
                continue
            if not latest_round:
                continue

            # Pick latest round actually forecasted by models for this target if possible
            t_rounds: List[str] = []
            for info in models.values():
                if not info.get("targets") or tid in info["targets"]:
                    t_rounds.extend(info.get("dates") or [])
            ref_date = max(t_rounds) if t_rounds else latest_round
            rep_models = self._pick_representative_models(
                models,
                tid,
                ref_date,
                get_meta=ctx.loader.get_model_metadata,
                hub_id=hub_id,
            )

            spatial = ctx.loader.get_spatial_data(tid, ref_date, rep_models, horizon="all", precise=True)
            avail_h = spatial.get("available_horizons") or []
            base_h = 1 if 1 in avail_h else (avail_h[0] if avail_h else None)
            trend_h = next((x for x in avail_h if x > 0), base_h)
            dates_by_h = spatial.get("dates_by_horizon") or {}
            h0_key = 0 if 0 in avail_h else (avail_h[0] if avail_h else None)
            h0_ted = dates_by_h.get(h0_key) if h0_key is not None else None
            per_100k = bool(tm.get("per_100k_capable", False))

            sig_id = f"{hub_id}::{tid}"
            t_path, t_path_label = infer_pathogen(hub_id, ctx.display_label, spec=spec, targets=[tid])
            t_short = tm.get("short_name") or tm.get("display_name") or tid

            raw_entries: List[Tuple[str, str, Dict[str, Any]]] = []
            leaf_obs_vals: List[float] = []
            leaf_fc_vals: List[float] = []
            leaf_activities_by_parent: Dict[str, List[float]] = {}

            spatial_locs = spatial.get("locations") or {}
            for lid, ldict in locs.items():
                pkey, sfips, _ = canonical_place_key(hub_id, lid, ldict, geo_kind)
                rec = spatial_locs.get(lid) or {}
                pop = rec.get("population") or ldict.get("population") or 0
                use_rate = bool(per_100k and _finite(pop) and float(pop) > 1)

                truth_map = rec.get("truth") or {}
                obs_date: Optional[str] = None
                raw_obs: Any = None
                if h0_ted and truth_map.get(h0_ted) is not None:
                    obs_date = h0_ted
                    raw_obs = truth_map[h0_ted]
                elif truth_map:
                    sorted_td = sorted(k for k, v in truth_map.items() if v is not None)
                    if sorted_td:
                        obs_date = sorted_td[-1]
                        raw_obs = truth_map[obs_date]
                obs_val = ((float(raw_obs) / float(pop)) * 1e5 if use_rate else float(raw_obs)) if _finite(raw_obs) else None

                fc_val: Optional[float] = None
                trend_pct: Optional[float] = None
                entry_m: Optional[str] = None
                m_dict = rec.get("models") or {}
                for mid in [*rep_models, *list(m_dict.keys())]:
                    m_horiz = m_dict.get(mid)
                    if m_horiz and base_h is not None and (base_h in m_horiz or str(base_h) in m_horiz):
                        ent = m_horiz.get(base_h) or m_horiz.get(str(base_h))
                        raw_fc = ent.get("rate_per_100k") if use_rate else ent.get("median")
                        if not _finite(raw_fc) and use_rate:
                            raw_fc = (float(ent["median"]) / float(pop)) * 1e5 if _finite(ent.get("median")) else None
                        if _finite(raw_fc):
                            fc_val = float(raw_fc)
                        t_ent = (m_horiz.get(trend_h) or m_horiz.get(str(trend_h)) or ent) if trend_h is not None else ent
                        if t_ent and _finite(t_ent.get("trend_pct")):
                            trend_pct = float(t_ent["trend_pct"])
                        entry_m = mid
                        break

                is_agg = lid in agg_ids
                if not is_agg:
                    if obs_val is not None:
                        leaf_obs_vals.append(obs_val)
                    if fc_val is not None:
                        leaf_fc_vals.append(fc_val)

                raw_entries.append((
                    pkey,
                    lid,
                    {
                        "is_agg": is_agg,
                        "sfips": sfips,
                        "observed": round(obs_val, 5 if (tm.get("scale") == "proportion" and not use_rate) else 3) if obs_val is not None else None,
                        "forecast": round(fc_val, 5 if (tm.get("scale") == "proportion" and not use_rate) else 3) if fc_val is not None else None,
                        "trend_pct": round(trend_pct, 2) if trend_pct is not None else None,
                        "use_rate": use_rate,
                        "ref_date": ref_date,
                        "obs_date": obs_date,
                        "model": entry_m,
                    },
                ))

            if not leaf_obs_vals and not leaf_fc_vals and not any(e[2]["observed"] is not None or e[2]["forecast"] is not None for e in raw_entries):
                continue

            domain_vals = sorted(leaf_obs_vals or leaf_fc_vals)
            fc_domain = sorted(leaf_fc_vals or leaf_obs_vals)
            if domain_vals:
                lo = _percentile(domain_vals, 0.05) if len(domain_vals) >= 8 else 0.0
                hi = _percentile(domain_vals, 0.95) if len(domain_vals) >= 8 else domain_vals[-1]
                lo = max(0.0, lo)
                hi = max(lo + 1e-6, hi if hi > 0 else domain_vals[-1] or 1.0)
            else:
                lo, hi = 0.0, 1.0

            if fc_domain:
                fc_lo = max(0.0, _percentile(fc_domain, 0.05) if len(fc_domain) >= 8 else 0.0)
                fc_hi = _percentile(fc_domain, 0.95) if len(fc_domain) >= 8 else fc_domain[-1]
                fc_hi = max(fc_lo + 1e-6, fc_hi if fc_hi > 0 else fc_domain[-1] or 1.0)
            else:
                fc_lo, fc_hi = lo, hi

            # Compute normalized activity for each non-aggregate leaf first so count-based
            # national totals without populations can fall back cleanly to leaf-mean activity.
            pending_agg: List[Tuple[str, Dict[str, Any]]] = []
            for pkey, lid, st in raw_entries:
                if st["observed"] is None and st["forecast"] is None:
                    continue
                prim = st["observed"] if st["observed"] is not None else st["forecast"]
                act = _clamp((prim - lo) / max(1e-9, hi - lo), 0.0, 1.0) if prim is not None else None
                fc_prim = st["forecast"] if st["forecast"] is not None else st["observed"]
                fc_act = _clamp((fc_prim - fc_lo) / max(1e-9, fc_hi - fc_lo), 0.0, 1.0) if fc_prim is not None else None

                stream = {
                    "signal_id": sig_id,
                    "hub_id": hub_id,
                    "hub_short": short_label,
                    "target_id": tid,
                    "target_short": t_short,
                    "pathogen": t_path,
                    "pathogen_label": t_path_label,
                    "location_id": lid,
                    "geo_kind": geo_kind,
                    "observed": st["observed"],
                    "forecast": st["forecast"],
                    "trend_pct": st["trend_pct"],
                    "activity": round(act, 4) if act is not None else None,
                    "forecast_activity": round(fc_act, 4) if fc_act is not None else None,
                    "use_rate": st["use_rate"],
                    "scale": tm.get("scale") or "count",
                    "unit": tm.get("unit") or "",
                    "ref_date": st["ref_date"],
                    "obs_date": st["obs_date"],
                }
                if st["is_agg"] and not st["use_rate"]:
                    pending_agg.append((pkey, stream))
                else:
                    if not st["is_agg"] and act is not None:
                        leaf_activities_by_parent.setdefault("US", []).append(act)
                    place_streams.setdefault(pkey, []).append(stream)

            for pkey, stream in pending_agg:
                leaf_acts = leaf_activities_by_parent.get(pkey)
                if leaf_acts:
                    stream["activity"] = round(sum(leaf_acts) / len(leaf_acts), 4)
                place_streams.setdefault(pkey, []).append(stream)

            signals.append({
                "id": sig_id,
                "hub_id": hub_id,
                "hub_short": short_label,
                "target_id": tid,
                "label": f"{t_path_label} · {t_short}" if t_path_label.lower() not in t_short.lower() else t_short,
                "short": t_short,
                "pathogen": t_path,
                "pathogen_label": t_path_label,
                "geo_kind": geo_kind,
                "scale": tm.get("scale") or "count",
                "unit": tm.get("unit") or "",
                "per_100k": any(e[2]["use_rate"] for e in raw_entries),
                "lo": round(lo, 3),
                "hi": round(hi, 3),
                "fc_lo": round(fc_lo, 3),
                "fc_hi": round(fc_hi, 3),
                "ref_date": ref_date,
            })

        result = {
            "geo_kind": geo_kind,
            "signals": signals,
            "cat_targets": cat_targets,
            "place_streams": place_streams,
            "metro_ids": [
                pkey
                for pkey in (
                    canonical_place_key(hub_id, lid, ldict, geo_kind)[0]
                    for lid, ldict in locs.items()
                    if lid not in agg_ids
                )
            ] if geo_kind == "us-metrocast" else [],
            "metro_state_fips": sorted({
                sfips
                for sfips in (
                    canonical_place_key(hub_id, lid, ldict, geo_kind)[1]
                    for lid, ldict in locs.items()
                    if lid not in agg_ids
                )
                if sfips
            }) if geo_kind == "us-metrocast" else [],
        }

        with self._lock:
            self._globe_hub_cache[hub_id] = (stamp_key, result)
        return result

    def build_globe(self) -> Dict[str, Any]:
        """Aggregate comparable activity signals across ALL active providers for the unified monochrome Globe."""
        cat = self.build_catalog()
        with self._lock:
            if self._globe_cache is not None and self._globe_cache[0] == cat["stamp"]:
                return self._globe_cache[1]
        active_id, providers, _ = self._gather_providers()

        signals_out: List[Dict[str, Any]] = []
        regions: Dict[str, Dict[str, Any]] = {}
        has_us_states = False
        has_eu = False
        has_metrocast = False
        metro_ids: Set[str] = set()
        metro_state_fips: Set[str] = set()
        stamp_parts: List[str] = [cat["stamp"]]

        # Seed all catalog places so even places without quantitative streams remain clickable
        for pkey, pinfo in cat["places"].items():
            regions[pkey] = {
                "key": pkey,
                "name": pinfo["name"],
                "abbr": pinfo["abbr"],
                "level": pinfo["level"],
                "geo_kind": pinfo["geo_kind"],
                "state_fips": pinfo.get("state_fips"),
                "parent_key": pinfo.get("parent_key"),
                "population": pinfo.get("population"),
                "children": pinfo.get("children") or [],
                "streams": [],
                "categorical_streams": [],
                "composite_activity": None,
                "composite_forecast_activity": None,
                "composite_trend_pct": None,
            }

        cat_by_hub: Dict[str, List[Dict[str, Any]]] = {}
        for prov in providers:
            sl = self._compute_hub_globe_slice(prov, cat["places"])
            gk = sl["geo_kind"]
            if gk == "us-states":
                has_us_states = True
            elif gk == "eu-countries":
                has_eu = True
            elif gk == "us-metrocast":
                has_metrocast = True
                has_us_states = True
                metro_ids.update(sl["metro_ids"])
                metro_state_fips.update(sl["metro_state_fips"])

            signals_out.extend(sl["signals"])
            cat_by_hub[prov["id"]] = sl["cat_targets"]
            for pkey, streams in sl["place_streams"].items():
                reg = regions.get(pkey)
                if reg is not None:
                    reg["streams"].extend(streams)
            stamp_parts.append(f"{prov['id']}:{len(sl['signals'])}")

        # Attach categorical targets per region via catalog place hubs (scoped to valid locations)
        cat_meta_lookup = {
            (t.get("hub_id"), t.get("target_id") or t.get("id")): t
            for t in (cat.get("targets") or [])
            if t.get("is_categorical")
        }
        for pkey, pinfo in cat["places"].items():
            reg = regions[pkey]
            for h_ent in pinfo.get("hubs") or []:
                hid = h_ent["hub_id"]
                lid = str(h_ent["location_id"])
                for ct in cat_by_hub.get(hid, []):
                    vlocs = ct.get("_valid_locs")
                    if vlocs is not None and lid not in vlocs:
                        continue
                    tmeta_cat = cat_meta_lookup.get((hid, ct["target_id"])) or {}
                    entry = {k: v for k, v in ct.items() if k != "_valid_locs"}
                    entry["location_id"] = lid
                    if tmeta_cat.get("concept_id"):
                        entry["concept_id"] = tmeta_cat["concept_id"]
                    if tmeta_cat.get("pathogen"):
                        entry["pathogen"] = tmeta_cat["pathogen"]
                    reg["categorical_streams"].append(entry)

        # Compute composite relative activity (max across connected streams at the region)
        for reg in regions.values():
            acts = [s["activity"] for s in reg["streams"] if _finite(s.get("activity"))]
            fc_acts = [s["forecast_activity"] for s in reg["streams"] if _finite(s.get("forecast_activity"))]
            trends = [s["trend_pct"] for s in reg["streams"] if _finite(s.get("trend_pct"))]
            if acts:
                reg["composite_activity"] = max(acts)
            if fc_acts:
                reg["composite_forecast_activity"] = max(fc_acts)
            if trends:
                # Pick trend from the stream driving peak composite activity (else first trend)
                primary = max(
                    (s for s in reg["streams"] if _finite(s.get("activity")) and _finite(s.get("trend_pct"))),
                    key=lambda s: float(s["activity"]),
                    default=None,
                )
                reg["composite_trend_pct"] = primary["trend_pct"] if primary else trends[0]

        composite = [{"id": "all", "label": "All connected", "kind": "composite"}] if len(signals_out) > 1 else []
        globe_payload = {
            "stamp": hashlib.sha1("|".join(stamp_parts).encode("utf-8")).hexdigest()[:16],
            "active_hub": active_id,
            "signals": composite + signals_out,
            "regions": regions,
            "coverage": {
                "has_us_states": has_us_states,
                "has_eu": has_eu,
                "has_metrocast": has_metrocast,
                "metro_ids": sorted(metro_ids),
                "metro_state_fips": sorted(metro_state_fips),
            },
        }
        with self._lock:
            self._globe_cache = (cat["stamp"], globe_payload)
        return globe_payload


def display_model_name(model_id: Optional[str]) -> Optional[str]:
    """Strip internal `<hub>:` remote namespace prefix for clean UI display."""
    if not model_id:
        return model_id
    return str(model_id).split(":", 1)[-1]


_ENSEMBLE_CANONICAL_SUFFIXES = frozenset({
    "ensemble",
    "hubensemble",
    "ensemble_mean",
    "ensemble_median",
    "ensemble_short",
})
_ENSEMBLE_SECONDARY_MARKERS = (
    "hjudge",
    "trained",
    "lop",
    "equal",
    "_cat",
    "-cat",
    "dist_",
    "_dist",
    "national_cat",
)


def _strip_namespace(mid: str) -> str:
    return str(mid).split(":", 1)[-1]


def _is_baseline_name(mid: str, info: Dict[str, Any]) -> bool:
    if info.get("is_baseline"):
        return True
    low = _strip_namespace(mid).lower()
    return low == "baseline" or low.endswith("-baseline") or low.endswith("-quantilebaseline") or "_baseline" in low


def rank_ensemble_candidates(
    models: Dict[str, Dict[str, Any]],
    target: Optional[str],
    ref_date: Optional[str] = None,
    *,
    get_meta: Optional[Any] = None,
    hub_id: Optional[str] = None,
) -> List[str]:
    """Rank models covering `target` (and optional `ref_date`) preferring official hub ensembles.

    Tier 0: Non-baseline hub-prefixed canonical ensemble (e.g., FluSight-ensemble,
            CovidHub-ensemble, RSVHub-ensemble, respicast-hubEnsemble).
    Tier 1: Non-baseline with YAML `ensemble_of_hub_models=True` and `designated=False`.
    Tier 2: Non-baseline with YAML `ensemble_of_hub_models=True` (e.g., epiENGAGE-ensemble_short).
    Tier 3: Non-baseline with `designated=False` and `"ensemble"` in name.
    Tier 4: Remaining non-baseline `"ensemble"` models ordered by longest round history.
    Tier 5: Any remaining non-baseline model ordered by longest round history.
    """
    hub_prefixes: Set[str] = set()
    for mid, info in models.items():
        if _is_baseline_name(mid, info):
            raw = _strip_namespace(mid).lower()
            team, sep, _ = raw.partition("-")
            if sep and team:
                hub_prefixes.add(team)
    if hub_id:
        clean_hid = str(hub_id).lower().removeprefix("remote_")
        for tok in clean_hid.replace("-", "_").split("_"):
            if len(tok) >= 3 and tok not in {"flu", "covid", "covid19", "rsv", "hub", "local", "syndromic"}:
                hub_prefixes.add(tok)
        hub_prefixes.add(clean_hid.replace("_", ""))

    scored: List[Tuple[int, int, int, str, str]] = []
    for mid, info in models.items():
        t_list = info.get("targets") or []
        if target and t_list and target not in t_list:
            continue
        dates = info.get("dates") or []
        if ref_date and dates and ref_date not in dates:
            continue
        if _is_baseline_name(mid, info):
            continue

        stripped = _strip_namespace(mid)
        low = stripped.lower()
        team_low, sep, model_part = low.partition("-")
        suffix = model_part if sep else low
        is_secondary = any(tok in low for tok in _ENSEMBLE_SECONDARY_MARKERS)
        is_canon = (suffix in _ENSEMBLE_CANONICAL_SUFFIXES) or ("hubensemble" in low)

        yaml_ens = False
        if get_meta is not None and not is_secondary and (
            "ensemble" in low or "hub" in low or team_low in hub_prefixes
        ):
            try:
                md = get_meta(mid)
                yaml_ens = isinstance(md, dict) and md.get("ensemble_of_hub_models") is True
            except Exception:
                yaml_ens = False

        designated = bool(info.get("designated"))
        has_ens_word = "ensemble" in low

        if not is_secondary and (team_low in hub_prefixes or "hubensemble" in low) and (is_canon or yaml_ens):
            tier = 0
        elif not is_secondary and yaml_ens and not designated:
            tier = 1
        elif not is_secondary and yaml_ens:
            tier = 2
        elif not is_secondary and not designated and has_ens_word:
            tier = 3
        elif not is_secondary and has_ens_word:
            tier = 4
        elif has_ens_word:
            tier = 5
        else:
            tier = 6

        if suffix in {"ensemble", "hubensemble"}:
            sub_p = 0
        elif any(k in suffix for k in ("short", "mean", "median")):
            sub_p = 1
        elif "long" in suffix:
            sub_p = 2
        else:
            sub_p = 3

        scored.append((tier, sub_p, -len(dates), low, mid))

    scored.sort()
    return [mid for *_, mid in scored]
