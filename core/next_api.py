"""
Data for the new frontend (served at /next/, endpoints under /api/next/).

Endpoints:
  manifest      calendar, hierarchical geo graph, targets, locations, seasons, and model metadata
  fan           one (target, season, location[, dims]): observed data + VZF2 (or VZF1) binary blocks
  trajectories  one (target, season, location, date[, dims]): sample trajectories as VZT1 binary blocks
  pmf           one (target, season, location[, date, dims]): categorical PMF distributions + oracle
"""

from __future__ import annotations

from collections import OrderedDict
import json
import logging
import re
import struct
import threading
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import polars as pl

from viz.core.baselines import build_manifest_baselines

logger = logging.getLogger("viz.next")

FAN_MAGIC_V1 = b"VZF1"
FAN_MAGIC_V2 = b"VZF2"
TRAJ_MAGIC = b"VZT1"


# what a model's metadata says it is fitted to, as the picker's "Data" filter: (label, pattern)
INPUT_KINDS = (
    ("NHSN admissions", r"nhsn|\bhhs\b|healthdata"),
    ("NSSP ED visits", r"nssp|emergency|\bed visit"),
    ("ILINet", r"ilinet|\bili\b"),
    ("FluSurv-NET", r"flusurv"),
    ("Lab tests", r"nrevss|clinical lab|positivity|test positiv"),
    ("COVID / RSV", r"covid|\brsv\b"),
    ("Vaccination", r"vaccin"),
    ("Weather", r"humidity|temperature|weather|climate"),
    ("Search trends", r"google|search trend"),
    ("Wastewater", r"wastewater"),
    ("Hub forecasts", r"flusight|other models|hub models|ensemble"),
)


def _inputs_of(text: str) -> List[str]:
    t = str(text or "").lower()
    return [label for label, pat in INPUT_KINDS if re.search(pat, t)]


def _truthy(v: Any) -> bool:
    return v is True or str(v).strip().lower() in ("true", "yes", "1")


def _season_label(season: str) -> str:
    return f"{season[:4]}–{season[7:9]}" if len(season) >= 9 else season


def _dims_cache_key(dims: Optional[Dict[str, str]]) -> Tuple[Tuple[str, str], ...]:
    if not dims:
        return ()
    return tuple(sorted((str(k), str(v)) for k, v in dims.items() if v is not None))


class NextData:
    """Builds and caches payloads behind /api/next/*."""

    def __init__(
        self,
        loader,
        config,
        remote_mgr=None,
        fan_cache_size: int = 48,
        hub_meta: Optional[Dict[str, Any]] = None,
    ):
        self.loader = loader
        self.config = config
        self.remote_mgr = remote_mgr
        self.hub_meta = dict(hub_meta) if hub_meta else {}
        self._lock = threading.Lock()
        self._fan_cache: "OrderedDict[Tuple, Tuple[Tuple, bytes]]" = OrderedDict()
        self._fan_inflight: Dict[Tuple, threading.Event] = {}
        self._fan_cache_size = fan_cache_size
        self._meta_cache: Dict[str, Dict[str, Any]] = {}
        self._meta_stamp: Optional[float] = None
        self._truth_cache: Dict[str, Tuple[Tuple, Dict[str, Tuple[List[str], List[float]]]]] = {}

    # ------------------------------------------------------------------ stamps
    def invalidate(self):
        """Drop all cached Next payloads and metadata after truth or model inventory updates."""
        with self._lock:
            self._fan_cache.clear()
            self._truth_cache.clear()
            self._meta_cache.clear()
            self._meta_stamp = None

    def _stamp(self) -> Tuple:
        """Changes whenever forecasts, truth, or hub round schedules change on disk."""
        cache = self.loader.cache_mgr
        parts: List[Any] = [self.loader._compute_models_mtime()]
        for getter in (
            cache.get_oracle_parquet,
            cache.get_admissions_parquet,
            cache.get_as_of_admissions_parquet,
        ):
            try:
                p = getter()
                parts.append(p.stat().st_mtime if p is not None and p.exists() else None)
            except Exception:
                parts.append(None)
        tasks_path = self.loader.hub_config_dir / "tasks.json"
        try:
            parts.append(tasks_path.stat().st_mtime if tasks_path.exists() else None)
        except Exception:
            parts.append(None)
        return tuple(parts)

    def _resolve_dims(self, target: str, requested_dims: Optional[Dict[str, str]]) -> Dict[str, str]:
        """Resolve requested + default extra task-ID dimension filters for a target."""
        dim_defs = self.config.get_extra_task_ids(target)
        out: Dict[str, str] = {}
        req = requested_dims or {}
        for col, dinfo in dim_defs.items():
            val = req.get(col)
            if val is not None:
                sval = str(val).strip()
                if sval and sval.lower() != "all":
                    out[col] = sval
            elif dinfo.get("default"):
                out[col] = str(dinfo["default"])
        return out

    # ------------------------------------------------------------------ manifest
    def _model_meta(self, model_id: str, info: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            cached = self._meta_cache.get(model_id)
        if cached is not None:
            return cached
        raw = info.get("raw_name", model_id)
        hub_key = self.loader.cache_mgr.hub_key(raw)
        bare = hub_key[1] if hub_key else raw
        team, _, abbr = bare.partition("-")
        if not abbr:
            team, abbr = "", bare
        meta: Dict[str, Any] = {}
        if not info.get("is_synthetic"):
            try:
                meta = self.loader.get_model_metadata(model_id) or {}
            except Exception as exc:
                logger.debug("metadata for %s: %s", model_id, exc)
        has_file = bool(meta.get("has_metadata_file"))
        out = {
            "team": str(meta.get("team_abbr") or team) if has_file else team,
            "abbr": str(meta.get("model_abbr") or abbr) if has_file else abbr,
            "team_name": str(meta.get("team_name")) if has_file and meta.get("team_name") else None,
            "designated": bool(meta.get("designated_model")) if has_file else False,
            "has_metadata": has_file,
            "inputs": _inputs_of(meta.get("data_inputs")) if has_file else [],
            "ensemble": _truthy(meta.get("ensemble_of_models")) if has_file else False,
            "baseline": _truthy(meta.get("baseline_model")) if has_file else False,
            "name": (
                str(meta.get("model_name")).strip()
                if has_file
                and meta.get("model_name")
                and str(meta.get("model_name")).strip().lower()
                not in (str(meta.get("model_abbr") or abbr).lower(), "none", "null", "nan")
                else None
            ),
        }
        if info.get("is_synthetic"):
            out["abbr"] = str(info.get("name") or model_id)
            out["team"] = ""
        with self._lock:
            self._meta_cache[model_id] = out
        return out

    def manifest(self) -> Dict[str, Any]:
        loader, config = self.loader, self.config
        models = loader.scan_models()
        mtime = loader._compute_models_mtime()
        with self._lock:
            if self._meta_stamp != mtime:
                self._meta_cache.clear()
                self._meta_stamp = mtime

        cal = loader.get_calendar()
        geo = loader.get_geo_graph()

        target_meta = []
        for t in config.get_weekly_targets():
            m = config.get_target_metadata(t)
            target_meta.append({
                "id": t,
                "label": m.get("display_name") or t,
                "short": m.get("short_name") or (m.get("display_name") or t),
                "unit": m.get("unit") or "",
                "is_rate": bool(m.get("is_rate")),
                "is_categorical": bool(m.get("is_categorical")),
                "scale": m.get("scale") or "count",
                "non_negative": bool(m.get("is_non_negative", True)),
                "per_100k_capable": bool(m.get("per_100k_capable", False)),
                "output_types": list(m.get("output_types") or ["quantile"]),
                "categories": list(m.get("categories") or []),
                "dimensions": m.get("dimensions") or {},
                "horizons": m.get("horizons") or {"required": [], "optional": []},
            })

        hub_seasons = loader.get_hub_seasons()
        seasons = []
        for s in loader.get_forecast_seasons():
            rounds = sorted(loader.get_dates_for_season(s))
            if not rounds:
                continue
            start, end = loader.get_season_bounds(s)
            seasons.append({
                "id": s,
                "label": cal.season_label(s),
                "rounds": rounds,
                "hub_rounds": sorted(hub_seasons.get(s, [])),
                "start": start,
                "end": end,
            })

        spellings: Dict[str, Dict[str, int]] = {}
        for info in models.values():
            fam = info.get("family") or ""
            spellings.setdefault(fam.lower(), {}).setdefault(fam, 0)
            spellings[fam.lower()][fam] += 1
        family_name = {
            key: next((f for f in forms if f.isupper()), max(forms, key=forms.get))
            for key, forms in spellings.items()
        }

        model_list = []
        for mid, info in models.items():
            meta = self._model_meta(mid, info)
            fam = family_name.get((info.get("family") or "").lower(), "")
            hub_key = loader.cache_mgr.hub_key(info.get("raw_name", mid)) if info.get("source") == "hub" else None
            model_list.append({
                "id": mid,
                "abbr": meta["abbr"],
                "team": meta["team"],
                "team_name": meta["team_name"],
                "family": fam,
                "source": info.get("source") or ("local" if info.get("is_local") else "repo"),
                "hub": hub_key[0] if hub_key else None,
                "designated": meta["designated"],
                "has_metadata": meta["has_metadata"],
                "seasons": info.get("seasons") or [],
                "targets": info.get("targets") or [],
                "output_types": info.get("output_types") or ["quantile"],
                "has_samples": bool(info.get("has_samples", False)),
                "has_pmf": bool(info.get("has_pmf", False)),
                "from_samples": bool(info.get("from_samples", False)),
                "first": info.get("min_date"),
                "last": info.get("max_date"),
                "rounds": len(info.get("dates") or []),
                "kind": (
                    "ensemble"
                    if info.get("is_synthetic") or meta["ensemble"] or fam.lower() == "ensemble"
                    else "baseline"
                    if meta["baseline"] or fam.lower() == "baseline"
                    else "individual"
                ),
                "inputs": meta["inputs"],
                "name": meta["name"],
            })

        agg_ids = geo.aggregate_locations_in_scope()
        locations = []
        for lid, l in loader.get_locations().items():
            node = geo.nodes.get(lid)
            locations.append({
                "id": lid,
                "abbr": l.get("abbreviation") or lid,
                "name": "United States" if lid == "US" else (l.get("name") or lid),
                "population": l.get("population"),
                "canonical_id": node.canonical_id if node else l.get("canonical_id", lid),
                "level": node.level if node else l.get("level", "unknown"),
                "parent_id": node.parent_id if node else l.get("parent_id"),
                "region": node.region if node else l.get("region"),
                "lat": node.lat if node else l.get("lat"),
                "lon": node.lon if node else l.get("lon"),
                "is_aggregate": lid in agg_ids or bool(node.is_hub_aggregate if node else l.get("is_aggregate")),
            })

        hubs = []
        if self.remote_mgr is not None:
            try:
                hubs = [
                    {
                        k: h.get(k)
                        for k in (
                            "id",
                            "label",
                            "short_label",
                            "synced",
                            "enabled",
                            "compatible",
                            "transport",
                            "pathogen",
                            "geography",
                        )
                    }
                    for h in self.remote_mgr.list_hubs()
                ]
            except Exception as exc:
                logger.debug("hub list: %s", exc)

        repo_ids = [m for m, v in models.items() if v.get("source") != "hub"]
        meta_by_id = {m["id"]: {"baseline_model": m["kind"] == "baseline"} for m in model_list}
        seasons_map = {s["id"]: s["rounds"] for s in seasons}
        baselines_info = build_manifest_baselines(
            models,
            model_meta=meta_by_id,
            targets=[t["id"] for t in target_meta],
            seasons_map=seasons_map,
            config=config,
            default_target=config.get_default_target(),
        )
        default_baseline = (
            baselines_info.get("default")
            or config.get_default_baseline(
                repo_ids or list(models.keys()),
                target=config.get_default_target(),
                model_meta=meta_by_id,
            )
        )
        geo_sum = geo.geo_summary()
        out = {
            "hub": self.hub_meta.get("label") or loader.base_dir.name,
            "hub_id": self.hub_meta.get("id"),
            "calendar": cal.to_dict(),
            "geo": geo_sum,
            "default_location": geo_sum.get("default_location"),
            "targets": target_meta,
            "default_target": config.get_default_target(),
            "baseline": default_baseline,
            "baselines": baselines_info,
            "recommended": config.get_recommended_models(repo_ids),
            "locations": locations,
            "seasons": seasons,
            "models": model_list,
            "hubs": hubs,
            "latest": {"date": loader.get_latest_reference_date(), "season": loader.get_latest_season()},
            "truth": loader.get_truth_info(),
            "stamp": "|".join(str(x) for x in self._stamp()),
        }
        if self.hub_meta.get("description"):
            out["hub_description"] = self.hub_meta["description"]
        if self.hub_meta.get("mode"):
            out["mode"] = self.hub_meta["mode"]
        if self.hub_meta.get("path"):
            out["hub_path"] = self.hub_meta["path"]
        return out

    # ------------------------------------------------------------------ observed data
    def _observed(self, target: str) -> Dict[str, Tuple[List[str], List[float]]]:
        """Weekly observed values per location (newest vintage)."""
        stamp = self._stamp()[1:]
        with self._lock:
            hit = self._truth_cache.get(target)
        if hit is not None and hit[0] == stamp:
            return hit[1]
        weekly = self.loader._weekly_truth(target).sort(["location", "target_end_date"])
        out: Dict[str, Tuple[List[str], List[float]]] = {}
        for (loc,), g in weekly.group_by(["location"], maintain_order=True):
            out[str(loc)] = (g.get_column("target_end_date").to_list(), g.get_column("value").to_list())
        with self._lock:
            if len(self._truth_cache) >= 32:
                self._truth_cache.clear()
            self._truth_cache[target] = (stamp, out)
        return out

    # ------------------------------------------------------------------ fan (VZF1 & VZF2)
    def asof(self, target: str, season: str, location: str) -> Dict[str, Any]:
        """Target snapshots as published at every round of a season."""
        loader = self.loader
        rounds = sorted(loader.get_dates_for_season(season))
        out: Dict[str, Any] = {"target": target, "season": season, "location": location, "rounds": {}, "snapshots": {}}
        lf = loader.cache_mgr.scan_as_of_admissions()
        if lf is None or not rounds:
            return out
        start, end = loader.get_season_bounds(season)
        try:
            df = (
                lf.filter(
                    (pl.col("target") == target)
                    & (pl.col("location") == str(location))
                    & (pl.col("as_of").cast(pl.Utf8) <= rounds[-1])
                    & (pl.col("target_end_date").cast(pl.Utf8) >= str(start))
                    & (pl.col("target_end_date").cast(pl.Utf8) <= str(end))
                )
                .select([pl.col("as_of").cast(pl.Utf8), pl.col("target_end_date").cast(pl.Utf8), pl.col("oracle_value")])
                .drop_nulls()
                .sort(["as_of", "target_end_date"])
                .collect()
            )
        except Exception as exc:
            logger.warning("next asof: %s", exc)
            return out
        if df.is_empty():
            return out
        snaps: Dict[str, List[Tuple[str, float]]] = {}
        for a, d, v in df.iter_rows():
            snaps.setdefault(a[:10], []).append((d[:10], float(v)))
        keys = sorted(snaps)
        k = -1
        for r in rounds:
            while k + 1 < len(keys) and keys[k + 1] <= r:
                k += 1
            if k < 0:
                continue
            snap = keys[k]
            pts = [[d, v] for d, v in snaps[snap] if d < r]
            if pts:
                out["rounds"][r] = pts
                out["snapshots"][r] = snap
        return out

    def fan(
        self,
        target: str,
        season: str,
        location: str,
        *,
        dims: Optional[Dict[str, str]] = None,
        version: int = 2,
    ) -> Optional[bytes]:
        """
        Everything the fan chart draws for `(target, season, location[, dims])`:
          - `version=2` (`VZF2`, default): sparse `(len(m.rounds), len(m.horizons), Q)` blocks + `horizon_offset_days` + `dims`
          - `version=1` (`VZF1`): legacy dense `(R, H, Q)` blocks
        """
        ver = 1 if int(version) == 1 else 2
        resolved_dims = self._resolve_dims(target, dims)
        key = (target, season, str(location), _dims_cache_key(resolved_dims), ver)
        stamp = self._stamp()
        cache_key = (key, stamp)
        while True:
            with self._lock:
                hit = self._fan_cache.get(key)
                if hit is not None and hit[0] == stamp:
                    self._fan_cache.move_to_end(key)
                    return hit[1]
                event = self._fan_inflight.get(cache_key)
                if event is None:
                    event = threading.Event()
                    self._fan_inflight[cache_key] = event
                    break
            event.wait()

        try:
            payload = self._build_fan_payload(target, season, location, resolved_dims=resolved_dims, version=ver)
            if payload is not None:
                with self._lock:
                    self._fan_cache[key] = (stamp, payload)
                    self._fan_cache.move_to_end(key)
                    while len(self._fan_cache) > self._fan_cache_size:
                        self._fan_cache.popitem(last=False)
            return payload
        finally:
            with self._lock:
                if self._fan_inflight.get(cache_key) is event:
                    self._fan_inflight.pop(cache_key, None)
            event.set()

    def _build_fan_payload(
        self,
        target: str,
        season: str,
        location: str,
        *,
        resolved_dims: Dict[str, str],
        version: int = 2,
    ) -> Optional[bytes]:
        loader = self.loader
        rounds = sorted(loader.get_dates_for_season(season))
        if not rounds:
            return None
        cal = loader.get_calendar()
        start, end = cal.season_bounds(season)
        prev_start, prev_end = cal.season_bounds(cal.prev_season(season))
        models = loader.scan_models()
        round_set = set(rounds)

        ids, frames = [], []
        for mid, info in models.items():
            if not round_set.intersection(info.get("dates") or []):
                continue
            if info.get("targets") and target not in info["targets"]:
                continue
            lazy = None
            if info.get("is_synthetic"):
                try:
                    df = loader.load_combined_forecasts(mid, dates=rounds, as_polars=True)
                    lazy = df.lazy() if df is not None and not df.is_empty() else None
                except Exception as exc:
                    logger.warning("ensemble %s: %s", mid, exc)
            else:
                lazy = loader.cache_mgr.scan_model(info.get("raw_name", mid), is_local=info.get("is_local", False))
            if lazy is None:
                continue
            names = lazy.collect_schema().names()
            q_lf = lazy.filter(
                pl.col("reference_date").is_in(rounds)
                & (pl.col("target") == target)
                & (pl.col("location") == str(location))
                & (pl.col("output_type") == "quantile")
            )
            for dcol, dval in resolved_dims.items():
                if dcol in names:
                    q_lf = q_lf.filter(pl.col(dcol).cast(pl.String) == dval)
            ids.append(mid)
            frames.append(
                q_lf.select([
                    pl.col("reference_date"),
                    pl.col("horizon").cast(pl.Int32),
                    pl.col("output_type_id").cast(pl.Float64).round(4).alias("q"),
                    pl.col("value").cast(pl.Float64),
                ])
            )

        collected = pl.collect_all(frames) if frames else []
        present: List[Tuple[str, pl.DataFrame]] = []
        has_any_non_neg_h = any(
            not df.filter(pl.col("horizon") >= 0).is_empty() for df in collected if not df.is_empty()
        )
        for mid, df in zip(ids, collected):
            if df.is_empty():
                continue
            if has_any_non_neg_h:
                df = df.filter(pl.col("horizon") >= 0)
            if not df.is_empty():
                present.append((mid, df))

        d_all, v_all = self._observed(target).get(str(location), ([], []))
        obs = [(d, v) for d, v in zip(d_all, v_all) if start <= d <= end]
        prior = [v for d, v in zip(d_all, v_all) if prev_start <= d <= prev_end]

        latest_obs = obs[-1][0] if obs else None
        latest_model_round = max(
            (str(df.get_column("reference_date").max())[:10] for _, df in present),
            default=None,
        )
        data_caps = [d for d in (latest_obs, latest_model_round) if d]
        if data_caps:
            cap_round = max(data_caps)
            trimmed = [r for r in rounds if r <= cap_round]
            if trimmed:
                rounds = trimmed
        round_index = {r: i for i, r in enumerate(rounds)}

        quantiles = sorted({float(q) for _, df in present for q in df.get_column("q").unique().to_list() if q is not None})
        obs_horizons = sorted({int(h) for _, df in present for h in df.get_column("horizon").unique().to_list() if h is not None})
        if obs_horizons:
            min_h, max_h = min(obs_horizons), max(obs_horizons)
            if min_h >= 0:
                horizons = list(range(0, max(max_h, 3) + 1))
            else:
                horizons = list(range(min_h, max_h + 1))
        else:
            horizons = [0, 1, 2, 3]
        h_index = {h: i for i, h in enumerate(horizons)}
        R, H, Q = len(rounds), len(horizons), len(quantiles)
        q_index = {q: i for i, q in enumerate(quantiles)}

        body = [np.asarray([v for _, v in obs], dtype="<f4")]
        offset = len(obs)
        header_models = []

        for mid, df in present:
            dense = np.full((R, H, Q), np.nan, dtype="<f4")
            ri = df.get_column("reference_date").replace_strict(round_index, default=-1, return_dtype=pl.Int32).to_numpy()
            hi = df.get_column("horizon").replace_strict(h_index, default=-1, return_dtype=pl.Int32).to_numpy()
            qi = df.get_column("q").replace_strict(q_index, default=-1, return_dtype=pl.Int32).to_numpy()
            ok = (ri >= 0) & (hi >= 0) & (qi >= 0)
            dense[ri[ok], hi[ok], qi[ok]] = df.get_column("value").to_numpy()[ok]

            m_r_idx = np.flatnonzero(~np.isnan(dense).all(axis=(1, 2)))
            if version == 1:
                header_models.append({"id": mid, "offset": offset, "rounds": m_r_idx.tolist()})
                body.append(dense.reshape(-1))
                offset += dense.size
            else:
                m_h_idx = np.flatnonzero(~np.isnan(dense).all(axis=(0, 2)))
                if m_r_idx.size and m_h_idx.size:
                    sparse = dense[np.ix_(m_r_idx, m_h_idx)].astype("<f4", copy=False)
                else:
                    sparse = np.empty((0, 0, Q), dtype="<f4")
                header_models.append({
                    "id": mid,
                    "offset": offset,
                    "rounds": m_r_idx.tolist(),
                    "horizons": [horizons[i] for i in m_h_idx],
                })
                flat = sparse.reshape(-1)
                body.append(flat)
                offset += flat.size

        if version == 1:
            magic = FAN_MAGIC_V1
            header: Dict[str, Any] = {
                "target": target,
                "season": season,
                "location": str(location),
                "start": start,
                "end": end,
                "rounds": rounds,
                "horizons": horizons,
                "quantiles": quantiles,
                "observed": {"dates": [d for d, _ in obs], "offset": 0, "length": len(obs)},
                "prior_max": max(prior) if prior else None,
                "models": header_models,
            }
        else:
            magic = FAN_MAGIC_V2
            header = {
                "version": 2,
                "target": target,
                "season": season,
                "location": str(location),
                "start": start,
                "end": end,
                "horizon_offset_days": int(cal.horizon_offset_days),
                "dims": resolved_dims,
                "rounds": rounds,
                "horizons": horizons,
                "quantiles": quantiles,
                "observed": {"dates": [d for d, _ in obs], "offset": 0, "length": len(obs)},
                "prior_max": max(prior) if prior else None,
                "models": header_models,
            }

        head = json.dumps(header, separators=(",", ":")).encode("utf-8")
        head += b" " * (-len(head) % 4)
        return magic + struct.pack("<I", len(head)) + head + np.concatenate(body).tobytes()

    # ------------------------------------------------------------------ sample trajectories (VZT1)
    def trajectories(
        self,
        target: str,
        season: str,
        location: str,
        round_date: str,
        *,
        models: Optional[List[str]] = None,
        dims: Optional[Dict[str, str]] = None,
        max_samples: int = 100,
    ) -> Optional[bytes]:
        """
        Sample trajectories for one `(target, location, reference_date)` packed as `VZT1` binary:
          "VZT1" | uint32 LE header length | header JSON | float32 LE body `(n_samples x n_horizons)` per model
        """
        loader = self.loader
        cal = loader.get_calendar()
        resolved_dims = self._resolve_dims(target, dims)
        all_models = loader.scan_models()
        candidate_ids = [m for m in (models or list(all_models.keys())) if m in all_models]

        ids, frames = [], []
        for mid in candidate_ids:
            info = all_models[mid]
            if info.get("targets") and target not in info["targets"]:
                continue
            lf = loader.cache_mgr.scan_model_samples(info.get("raw_name", mid), is_local=info.get("is_local", False))
            if lf is None:
                continue
            names = lf.collect_schema().names()
            q = lf.filter(
                (pl.col("reference_date") == round_date)
                & (pl.col("target") == target)
                & (pl.col("location") == str(location))
            )
            for dcol, dval in resolved_dims.items():
                if dcol in names:
                    q = q.filter(pl.col(dcol).cast(pl.String) == dval)
            ids.append(mid)
            frames.append(
                q.select([
                    pl.col("horizon").cast(pl.Int32),
                    pl.col("output_type_id").cast(pl.String).alias("sid"),
                    pl.col("value").cast(pl.Float64),
                ])
            )

        collected = pl.collect_all(frames) if frames else []
        present = [(mid, df) for mid, df in zip(ids, collected) if not df.is_empty()]
        if not present:
            return None

        global_h = sorted({int(h) for _, df in present for h in df.get_column("horizon").unique().to_list() if h is not None})
        body: List[np.ndarray] = []
        offset = 0
        header_models: List[Dict[str, Any]] = []
        cap = max(1, int(max_samples))

        for mid, df in present:
            sample_ids = sorted(df.get_column("sid").unique().to_list())[:cap]
            m_horizons = sorted(h for h in df.get_column("horizon").unique().to_list() if h is not None)
            s_idx = {s: i for i, s in enumerate(sample_ids)}
            h_idx = {h: i for i, h in enumerate(m_horizons)}
            block = np.full((len(sample_ids), len(m_horizons)), np.nan, dtype="<f4")
            si = df.get_column("sid").replace_strict(s_idx, default=-1, return_dtype=pl.Int32).to_numpy()
            hi = df.get_column("horizon").replace_strict(h_idx, default=-1, return_dtype=pl.Int32).to_numpy()
            ok = (si >= 0) & (hi >= 0)
            block[si[ok], hi[ok]] = df.get_column("value").to_numpy()[ok]
            flat = block.reshape(-1)
            header_models.append({
                "id": mid,
                "offset": offset,
                "n_samples": len(sample_ids),
                "sample_ids": sample_ids,
                "horizons": m_horizons,
            })
            body.append(flat)
            offset += flat.size

        header = {
            "version": 1,
            "target": target,
            "season": season,
            "location": str(location),
            "reference_date": round_date,
            "horizon_offset_days": int(cal.horizon_offset_days),
            "dims": resolved_dims,
            "horizons": global_h,
            "models": header_models,
        }
        head = json.dumps(header, separators=(",", ":")).encode("utf-8")
        head += b" " * (-len(head) % 4)
        arr = np.concatenate(body) if body else np.empty(0, dtype="<f4")
        return TRAJ_MAGIC + struct.pack("<I", len(head)) + head + arr.tobytes()

    # ------------------------------------------------------------------ categorical PMF
    def pmf(
        self,
        target: str,
        season: str,
        location: str,
        *,
        round_date: Optional[str] = None,
        models: Optional[List[str]] = None,
        dims: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Categorical / ordinal PMF distributions per model, round, and horizon plus observed category."""
        loader = self.loader
        cal = loader.get_calendar()
        resolved_dims = self._resolve_dims(target, dims)
        rounds = [round_date] if round_date else sorted(loader.get_dates_for_season(season))
        all_models = loader.scan_models()
        candidate_ids = [m for m in (models or list(all_models.keys())) if m in all_models]
        t_meta = self.config.get_target_metadata(target)
        categories = list(t_meta.get("categories") or [])

        ids, frames = [], []
        for mid in candidate_ids:
            info = all_models[mid]
            if info.get("targets") and target not in info["targets"]:
                continue
            lf = loader.cache_mgr.scan_model_pmf(info.get("raw_name", mid), is_local=info.get("is_local", False))
            if lf is None:
                continue
            names = lf.collect_schema().names()
            q = lf.filter((pl.col("target") == target) & (pl.col("location") == str(location)))
            if rounds:
                q = q.filter(pl.col("reference_date").is_in(rounds))
            for dcol, dval in resolved_dims.items():
                if dcol in names:
                    q = q.filter(pl.col(dcol).cast(pl.String) == dval)
            ids.append(mid)
            frames.append(
                q.select([
                    pl.col("reference_date").cast(pl.String),
                    pl.col("horizon").cast(pl.Int32),
                    pl.col("target_end_date").cast(pl.String),
                    pl.col("output_type_id").cast(pl.String),
                    pl.col("value").cast(pl.Float64),
                ])
            )

        collected = pl.collect_all(frames) if frames else []
        seen_cats = set(categories)
        models_out: Dict[str, Dict[str, Dict[str, Any]]] = {}
        active_rounds: set[str] = set()

        for mid, df in zip(ids, collected):
            if df.is_empty():
                continue
            m_map: Dict[str, Dict[str, Any]] = {}
            for ref, h, ted, cat, val in df.iter_rows():
                r_str = str(ref)
                h_str = str(int(h))
                c_str = str(cat)
                seen_cats.add(c_str)
                active_rounds.add(r_str)
                slot = m_map.setdefault(r_str, {}).setdefault(h_str, {"target_end_date": str(ted), "probs": {}})
                slot["probs"][c_str] = round(float(val), 6) if val is not None and np.isfinite(val) else 0.0
            if m_map:
                models_out[mid] = m_map

        if not categories:
            categories = sorted(seen_cats)

        # Extract observed categorical outcomes in season window
        start, end = cal.season_bounds(season)
        observed_list: List[Dict[str, Any]] = []
        lf_o = loader.cache_mgr.scan_oracle()
        if lf_o is not None:
            o_names = lf_o.collect_schema().names()
            if "output_type_id" in o_names:
                oq = lf_o.filter(
                    (pl.col("target") == target)
                    & (pl.col("location") == str(location))
                    & (pl.col("target_end_date") >= start)
                    & (pl.col("target_end_date") <= end)
                    & (pl.col("oracle_value") > 0)
                )
                for dcol, dval in resolved_dims.items():
                    if dcol in o_names:
                        oq = oq.filter(pl.col(dcol).cast(pl.String) == dval)
                odf = oq.select([
                    pl.col("target_end_date").cast(pl.String),
                    pl.col("output_type_id").cast(pl.String),
                    pl.col("oracle_value").cast(pl.Float64),
                ] + ([pl.col("as_of").cast(pl.String)] if "as_of" in o_names else [])).collect()
                if not odf.is_empty():
                    if "as_of" in odf.columns:
                        odf = odf.sort("as_of").group_by("target_end_date").last()
                    else:
                        odf = odf.sort("oracle_value").group_by("target_end_date").last()
                    for ted, cat, val in odf.sort("target_end_date").select(["target_end_date", "output_type_id", "oracle_value"]).iter_rows():
                        observed_list.append({"date": str(ted), "category": str(cat), "value": float(val)})

        return {
            "target": target,
            "season": season,
            "location": str(location),
            "horizon_offset_days": int(cal.horizon_offset_days),
            "dims": resolved_dims,
            "categories": categories,
            "ordinal": len(categories) >= 2,
            "rounds": sorted(active_rounds) or sorted(rounds),
            "observed": observed_list,
            "models": models_out,
        }
