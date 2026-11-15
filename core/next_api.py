"""
Data for the new frontend (served at /next/, endpoints under /api/next/).

Old viz asks the server one question per view (a forecast for these models on this date). The new
frontend moves through time continuously, so it asks for whole slices instead and keeps them:

  manifest    what exists: targets, locations, seasons and their rounds, every model with light metadata
  fan         one (target, season, location): observed data and every model's quantile forecasts for
              every round of that season, as one compact binary block

Nothing here changes what old viz reads; it only uses the loaders and caches that already exist.
"""

from __future__ import annotations

import json
import logging
import re
import struct
import threading
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import polars as pl

logger = logging.getLogger("viz.next")

FAN_MAGIC = b"VZF1"


# what a model's metadata says it is fitted to, as the picker's "Data" filter: (label, pattern) over the
# data_inputs text, lower-cased; a model can match several
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


class NextData:
    """Builds and caches the payloads behind /api/next/*."""

    def __init__(self, loader, config, remote_mgr=None, fan_cache_size: int = 48):
        self.loader = loader
        self.config = config
        self.remote_mgr = remote_mgr
        self._lock = threading.Lock()
        self._fan_cache: "OrderedDict[Tuple, Tuple[Tuple, bytes]]" = OrderedDict()
        self._fan_cache_size = fan_cache_size
        self._meta_cache: Dict[str, Dict[str, Any]] = {}
        self._meta_stamp: Optional[float] = None
        self._truth_cache: Dict[str, Tuple[Tuple, Dict[str, Tuple[List[str], List[float]]]]] = {}

    # ------------------------------------------------------------------ stamps
    def _stamp(self) -> Tuple:
        """Changes whenever forecasts or truth change on disk; every cache here is keyed by it."""
        cache = self.loader.cache_mgr
        parts: List[Any] = [self.loader._compute_models_mtime()]
        for getter in (cache.get_oracle_parquet, cache.get_admissions_parquet):
            try:
                p = getter()
                parts.append(p.stat().st_mtime if p is not None and p.exists() else None)
            except Exception:
                parts.append(None)
        return tuple(parts)

    # ------------------------------------------------------------------ manifest
    def _model_meta(self, model_id: str, info: Dict[str, Any]) -> Dict[str, Any]:
        """The light metadata the picker and labels need; the full record stays behind /api/model-details."""
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
            except Exception as exc:  # a malformed YAML must not take the manifest down
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
            # the metadata's readable name ("GBQR with NSSP, ILINet, FluSurv-NET"), when it says more than the abbreviation
            "name": str(meta.get("model_name")).strip() if has_file and meta.get("model_name") and str(meta.get("model_name")).strip().lower() not in (str(meta.get("model_abbr") or abbr).lower(), "none", "null", "nan") else None,
        }
        if info.get("is_synthetic"):
            out["abbr"] = str(info.get("name") or model_id)
            out["team"] = ""
        self._meta_cache[model_id] = out
        return out

    def manifest(self) -> Dict[str, Any]:
        loader, config = self.loader, self.config
        models = loader.scan_models()
        mtime = loader._compute_models_mtime()
        if self._meta_stamp != mtime:
            self._meta_cache.clear()
            self._meta_stamp = mtime

        target_meta = []
        for t in config.get_weekly_targets():
            m = config.get_target_metadata(t)
            target_meta.append({
                "id": t,
                "label": m.get("display_name") or t,
                # a short name for the Target bubble; config can set target_metadata.<target>.short_name
                "short": m.get("short_name") or ("Flu admissions" if "hosp" in t.lower() else "ED visits" if "visit" in t.lower() else (m.get("display_name") or t)),
                "unit": m.get("unit") or "",
                "is_rate": bool(m.get("is_rate")),
                # how values read: whole counts, or a share of something (drawn and formatted as percent)
                "scale": "proportion" if " prop " in f" {t} " else "count",
                "non_negative": bool(m.get("is_non_negative", True)),
            })

        hub_seasons = loader.get_hub_seasons()
        seasons = []
        for s in loader.get_forecast_seasons():
            rounds = sorted(loader.get_dates_for_season(s))
            if not rounds:
                continue
            start, end = loader.get_season_calendar_bounds(int(s[:4]))
            seasons.append({
                "id": s,
                "label": _season_label(s),
                "rounds": rounds,
                "hub_rounds": sorted(hub_seasons.get(s, [])),
                "start": start,
                "end": end,
            })

        # one spelling per family: old viz infers "AR" for some ids and "Ar" for others
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
                "family": family_name.get((info.get("family") or "").lower(), ""),
                "source": info.get("source") or ("local" if info.get("is_local") else "repo"),
                "hub": hub_key[0] if hub_key else None,
                "designated": meta["designated"],
                "has_metadata": meta["has_metadata"],
                "seasons": info.get("seasons") or [],
                "targets": info.get("targets") or [],
                "first": info.get("min_date"),
                "last": info.get("max_date"),
                "rounds": len(info.get("dates") or []),
                # the picker's filters: what kind of model and what data it is fitted to
                "kind": "ensemble" if info.get("is_synthetic") or meta["ensemble"] or fam.lower() == "ensemble"
                        else "baseline" if meta["baseline"] or fam.lower() == "baseline" else "individual",
                "inputs": meta["inputs"],
                "name": meta["name"],
            })

        locations = [
            {"id": l["id"], "abbr": l["abbreviation"], "name": "United States" if l["id"] == "US" else l["name"], "population": l.get("population")}
            for l in loader.get_locations().values()
        ]
        hubs = []
        if self.remote_mgr is not None:
            try:
                hubs = [{k: h.get(k) for k in ("id", "label", "short_label", "synced", "enabled")} for h in self.remote_mgr.list_hubs()]
            except Exception as exc:
                logger.debug("hub list: %s", exc)
        repo_ids = [m for m, v in models.items() if v.get("source") != "hub"]
        return {
            "hub": loader.base_dir.name,
            "targets": target_meta,
            "default_target": config.get_default_target(),
            "baseline": config.get_default_baseline(repo_ids or list(models.keys())),
            "recommended": config.get_recommended_models(repo_ids),
            "locations": locations,
            "seasons": seasons,
            "models": model_list,
            "hubs": hubs,
            "latest": {"date": loader.get_latest_reference_date(), "season": loader.get_latest_season()},
            "truth": loader.get_truth_info(),
            # changes whenever forecasts or truth change on disk (the page compares it after a refresh)
            "stamp": "|".join(str(x) for x in self._stamp()),
        }

    # ------------------------------------------------------------------ observed data
    def _observed(self, target: str) -> Dict[str, Tuple[List[str], List[float]]]:
        """Weekly observed values per location (newest vintage, admissions filling gaps), as old viz draws them."""
        stamp = self._stamp()[1:]
        hit = self._truth_cache.get(target)
        if hit is not None and hit[0] == stamp:
            return hit[1]
        weekly = self.loader._weekly_truth(target).sort(["location", "target_end_date"])
        out: Dict[str, Tuple[List[str], List[float]]] = {}
        for (loc,), g in weekly.group_by(["location"], maintain_order=True):
            out[str(loc)] = (g.get_column("target_end_date").to_list(), g.get_column("value").to_list())
        self._truth_cache[target] = (stamp, out)
        return out

    # ------------------------------------------------------------------ fan
    def asof(self, target: str, season: str, location: str) -> Dict[str, Any]:
        """The target as it was published at every round of a season, for one place: per round, the
        latest snapshot on or before it, the weeks of this season before the round. One scan of the
        as-of archive, so the chart can move between rounds without a request each."""
        loader = self.loader
        rounds = sorted(loader.get_dates_for_season(season))
        out: Dict[str, Any] = {"target": target, "season": season, "location": location, "rounds": {}, "snapshots": {}}
        lf = loader.cache_mgr.scan_as_of_admissions()
        if lf is None or not rounds:
            return out
        start, end = loader.get_season_calendar_bounds(int(season[:4]))
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
        except Exception as exc:  # an archive without these columns: no as-of line
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

    def fan(self, target: str, season: str, location: str) -> Optional[bytes]:
        """
        Everything the fan chart draws for one (target, season, location):

            "VZF1" | uint32 header length | header JSON (space-padded to 4 bytes) | float32 body

        Body: the observed values, then one dense block per model of rounds x horizons x quantiles
        (NaN where a model has no value). The header says where each block starts.
        """
        key = (target, season, str(location))
        stamp = self._stamp()
        with self._lock:
            hit = self._fan_cache.get(key)
            if hit is not None and hit[0] == stamp:
                self._fan_cache.move_to_end(key)
                return hit[1]

        loader = self.loader
        rounds = sorted(loader.get_dates_for_season(season))
        if not rounds:
            return None
        round_index = {r: i for i, r in enumerate(rounds)}
        start, end = loader.get_season_calendar_bounds(int(season[:4]))
        models = loader.scan_models()
        round_set = set(rounds)

        # one lazy query per model with files in this season, collected together
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
            ids.append(mid)
            frames.append(
                lazy.filter(
                    pl.col("reference_date").is_in(rounds)
                    & (pl.col("target") == target)
                    & (pl.col("location") == str(location))
                    & (pl.col("horizon") >= 0)
                    & (pl.col("output_type") == "quantile")
                ).select([
                    pl.col("reference_date"),
                    pl.col("horizon").cast(pl.Int32),
                    pl.col("output_type_id").cast(pl.Float64).round(4).alias("q"),
                    pl.col("value").cast(pl.Float64),
                ])
            )

        collected = pl.collect_all(frames) if frames else []
        present = [(mid, df) for mid, df in zip(ids, collected) if not df.is_empty()]

        quantiles = sorted({float(q) for _, df in present for q in df.get_column("q").unique().to_list() if q is not None})
        max_h = max((int(df.get_column("horizon").max()) for _, df in present), default=3)
        horizons = list(range(0, max(max_h, 3) + 1))
        R, H, Q = len(rounds), len(horizons), len(quantiles)
        q_index = {q: i for i, q in enumerate(quantiles)}

        d_all, v_all = self._observed(target).get(str(location), ([], []))
        obs = [(d, v) for d, v in zip(d_all, v_all) if start <= d <= end]
        # the scale of the season before, for a season that has hardly begun
        prev_start, prev_end = loader.get_season_calendar_bounds(int(season[:4]) - 1)
        prior = [v for d, v in zip(d_all, v_all) if prev_start <= d <= prev_end]

        body = [np.asarray([v for _, v in obs], dtype="<f4")]
        offset = len(obs)
        header_models = []
        for mid, df in present:
            block = np.full((R, H, Q), np.nan, dtype="<f4")
            ri = df.get_column("reference_date").replace_strict(round_index, default=-1, return_dtype=pl.Int32).to_numpy()
            hi = df.get_column("horizon").to_numpy()
            qi = df.get_column("q").replace_strict(q_index, default=-1, return_dtype=pl.Int32).to_numpy()
            ok = (ri >= 0) & (qi >= 0) & (hi >= 0) & (hi < H)
            block[ri[ok], hi[ok], qi[ok]] = df.get_column("value").to_numpy()[ok]
            has = ~np.isnan(block).all(axis=(1, 2))
            header_models.append({"id": mid, "offset": offset, "rounds": np.flatnonzero(has).tolist()})
            body.append(block.reshape(-1))
            offset += block.size

        header = {
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
        head = json.dumps(header, separators=(",", ":")).encode("utf-8")
        head += b" " * (-len(head) % 4)
        payload = FAN_MAGIC + struct.pack("<I", len(head)) + head + np.concatenate(body).tobytes()

        with self._lock:
            self._fan_cache[key] = (stamp, payload)
            self._fan_cache.move_to_end(key)
            while len(self._fan_cache) > self._fan_cache_size:
                self._fan_cache.popitem(last=False)
        return payload
