"""
Query layer for season peak forecasts: per-model peak tables, observed peaks, and peak scoring.

Everything here reads the separate peak tables built by ParquetCacheManager.get_model_peak_parquet and the
same merged weekly truth the season-phase picker uses, so weekly forecasts and their scores are unaffected.
"""

from datetime import datetime, timedelta
import logging
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

import numpy as np
import polars as pl

from viz.peaks import (
    default_window, observed_peak, peak_targets_for, score_size, score_timing, summarize_size, summarize_timing,
)

logger = logging.getLogger("viz.peaks")


def _shift(d: str, days: int) -> str:
    return (datetime.strptime(d, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")


def _mean(xs: Sequence[Optional[float]]) -> Optional[float]:
    vals = [float(x) for x in xs if x is not None]
    return float(np.mean(vals)) if vals else None


class PeakService:
    def __init__(self, loader):
        self.loader = loader
        self._truth_cache: Optional[Tuple[Any, Dict[str, List[Tuple[str, float]]]]] = None

    # ---- availability -----------------------------------------------------------------------------------

    def targets(self, base_target: str) -> Dict[str, str]:
        return peak_targets_for(base_target)

    def is_available(self, base_target: str) -> bool:
        """A weekly target has peak companions when the hub config or any synced hub declares them."""
        pt = peak_targets_for(base_target)
        if not pt:
            return False
        return bool(self._declared_peak_targets() & set(pt.values()))

    def _declared_peak_targets(self) -> Set[str]:
        store = self.loader.remote_store
        stamp = store.state_mtime() if self.loader.include_remote else 0.0
        cached = getattr(self, "_declared_cache", None)
        if cached is not None and cached[0] == stamp:
            return cached[1]
        declared = set(self.loader.config.get_targets())
        if self.loader.include_remote:
            for h in store.active_hub_ids():
                for f in store.load_manifest(h).get("files", {}).values():
                    declared.update(f.get("peak_targets", []))
        self._declared_cache = (stamp, declared)
        return declared

    # ---- forecasts --------------------------------------------------------------------------------------

    def _scan(self, model_id: str) -> Optional[pl.LazyFrame]:
        loader = self.loader
        if loader.ensemble_mgr.get_config(model_id):
            return None
        models = loader.scan_models()
        info = models.get(model_id)
        if info is None and not model_id.startswith("local:"):
            return None
        if info and info.get("source") == "hub":
            return loader.cache_mgr.scan_model_peaks(model_id)
        raw_id, is_local = loader._resolve_model_id_and_local(model_id)
        return loader.cache_mgr.scan_model_peaks(raw_id, is_local=is_local)

    def _rows(self, model_id: str, base_target: str, location: Optional[str] = None,
              ref_dates: Optional[Sequence[str]] = None, locations: Optional[Sequence[str]] = None) -> pl.DataFrame:
        lf = self._scan(model_id)
        pt = peak_targets_for(base_target)
        if lf is None or not pt:
            return pl.DataFrame()
        flt = pl.col("target").is_in(list(pt.values()))
        if location is not None:
            flt &= pl.col("location") == str(location)
        if locations is not None:
            flt &= pl.col("location").is_in([str(x) for x in locations])
        if ref_dates is not None:
            flt &= pl.col("reference_date").is_in(list(ref_dates))
        try:
            return lf.filter(flt).collect()
        except Exception as exc:
            logger.warning("Could not read peak forecasts of %s: %s", model_id, exc)
            return pl.DataFrame()

    @staticmethod
    def _summaries(df: pl.DataFrame, pt: Dict[str, str], data_cutoff: Optional[str]) -> Dict[Tuple[str, str], Dict[str, Any]]:
        """{(reference_date, location): {timing, size}} for one model's peak rows."""
        out: Dict[Tuple[str, str], Dict[str, Any]] = {}
        if df.is_empty():
            return out
        timing = df.filter((pl.col("target") == pt["timing"]) & (pl.col("output_type") == "pmf"))
        for (ref, loc), g in timing.group_by(["reference_date", "location"]):
            cutoff = data_cutoff or _shift(ref, -7)
            s = summarize_timing(g.get_column("output_type_id").to_list(), g.get_column("value").to_list(), cutoff)
            if s:
                out.setdefault((ref, loc), {})["timing"] = s
        size = df.filter((pl.col("target") == pt["size"]) & (pl.col("output_type") == "quantile"))
        for (ref, loc), g in size.group_by(["reference_date", "location"]):
            levels = g.get_column("output_type_id").cast(pl.Float64, strict=False).to_list()
            s = summarize_size(levels, g.get_column("value").to_list())
            if s:
                out.setdefault((ref, loc), {})["size"] = s
        return out

    def peak_dates(self, model_id: str, base_target: str) -> List[str]:
        lf = self._scan(model_id)
        pt = peak_targets_for(base_target)
        if lf is None or not pt:
            return []
        try:
            return sorted(lf.filter(pl.col("target").is_in(list(pt.values()))).select("reference_date")
                          .unique().collect().get_column("reference_date").to_list())
        except Exception:
            return []

    # ---- truth ------------------------------------------------------------------------------------------

    def _truth(self, base_target: str) -> Dict[str, List[Tuple[str, float]]]:
        cm = self.loader.cache_mgr
        sources = [cm.get_oracle_parquet(), cm.get_admissions_parquet()]
        stamp = (base_target,) + tuple((str(p), p.stat().st_mtime) if p and p.exists() else None for p in sources)
        if self._truth_cache is not None and self._truth_cache[0] == stamp:
            return self._truth_cache[1]
        weekly = self.loader._weekly_truth(base_target).sort(["location", "target_end_date"])
        by_loc: Dict[str, List[Tuple[str, float]]] = {}
        for loc, d, v in weekly.select(["location", "target_end_date", "value"]).iter_rows():
            by_loc.setdefault(str(loc), []).append((str(d), float(v)))
        self._truth_cache = (stamp, by_loc)
        return by_loc

    def truth_series(self, base_target: str, location: str, start: str, end: str) -> List[Tuple[str, float]]:
        return [(d, v) for d, v in self._truth(base_target).get(str(location), []) if start <= d <= end]

    @staticmethod
    def season_window(season: str, candidate_dates: Set[str]) -> Tuple[str, str]:
        """The forecast window of a season: the candidate weeks submissions used, else October through May."""
        start, end = default_window(season)
        if candidate_dates:
            start = min(start, min(candidate_dates))
            end = max(candidate_dates)
        return start, end

    def observed(self, base_target: str, location: str, season: str, window: Tuple[str, str]) -> Optional[Dict[str, Any]]:
        return observed_peak(self._truth(base_target).get(str(location), []), window)

    # ---- the Season Peak view ---------------------------------------------------------------------------

    def season_view(self, base_target: str, location: str, reference_date: str, model_ids: List[str],
                    skill_scope: str = "location", common: bool = False) -> Dict[str, Any]:
        loader = self.loader
        pt = peak_targets_for(base_target)
        season = loader.get_flu_season_for_date(reference_date)
        cal_start, cal_end = loader.get_season_calendar_bounds(int(season[:4]))
        locations = loader.get_locations()
        state_locs = [l for l in locations if l != "US"]

        out: Dict[str, Any] = {
            "base_target": base_target,
            "targets": pt,
            "available": self.is_available(base_target),
            "location": location,
            "location_name": locations.get(location, {}).get("name", location),
            "reference_date": reference_date,
            "data_cutoff": _shift(reference_date, -7),
            "season": season,
            "models": [],
            "rounds": {},
            "missing": [],
            "peak_rounds": [],
            "latest_peak_round": None,
        }
        if not pt:
            return out

        # Peak rows of every model for this season (all locations needed only for the all-states skill)
        need_states = skill_scope == "states"
        per_model: Dict[str, Dict[Tuple[str, str], Dict[str, Any]]] = {}
        candidates: Set[str] = set()
        latest_any: Optional[str] = None
        for mid in model_ids:
            dates = self.peak_dates(mid, base_target)
            if not dates:
                out["missing"].append(mid)
                continue
            latest_any = max(latest_any or "", dates[-1])
            in_season = [d for d in dates if loader.get_flu_season_for_date(d) == season]
            if not in_season:
                per_model[mid] = {}
                continue
            df = self._rows(mid, base_target, ref_dates=in_season,
                            locations=(state_locs + ["US"]) if need_states else [location])
            summ = self._summaries(df, pt, None)
            per_model[mid] = summ
            for s in summ.values():
                if "timing" in s:
                    candidates.update(s["timing"]["dates"])
        out["latest_peak_round"] = latest_any

        window = self.season_window(season, candidates)
        out["window"] = list(window)
        out["observed"] = self.observed(base_target, location, season, window)
        out["truth"] = [{"date": d, "value": v} for d, v in self.truth_series(base_target, location, cal_start, cal_end)]
        out["peak_rounds"] = sorted({ref for summ in per_model.values() for (ref, loc) in summ if loc == location})

        # Current round and round-by-round evolution for the shown location
        for mid in model_ids:
            if mid not in per_model:
                continue
            summ = per_model[mid]
            cur = summ.get((reference_date, location), {})
            entry = {"model_id": mid, "has_round": bool(cur), "timing": cur.get("timing"), "size": cur.get("size")}
            if out["observed"] and out["observed"]["final"]:
                entry["scores"] = {
                    "timing": score_timing(cur.get("timing"), out["observed"]["dates"]) if cur.get("timing") else None,
                    "size": score_size(cur.get("size"), out["observed"]["value"]) if cur.get("size") else None,
                }
            out["models"].append(entry)
            rounds = []
            for (ref, loc), s in sorted(summ.items()):
                if loc != location:
                    continue
                t, z = s.get("timing"), s.get("size")
                rounds.append({
                    "reference_date": ref,
                    "timing": {k: t[k] for k in ("dates", "probs", "median", "mode", "mode_prob", "i50", "i90")} if t else None,
                    "size": {k: z[k] for k in ("median", "i50", "i90", "i95")} if z else None,
                })
            out["rounds"][mid] = rounds

        out["skill"] = self._skill(base_target, season, window, per_model, [location] if not need_states else state_locs,
                                   common, scope=skill_scope)
        return out

    def _skill(self, base_target: str, season: str, window: Tuple[str, str],
               per_model: Dict[str, Dict[Tuple[str, str], Dict[str, Any]]], locations: List[str],
               common: bool, scope: str) -> Dict[str, Any]:
        """Season-level peak skill per model over every round (and location in scope) with a final observed peak."""
        observed = {loc: self.observed(base_target, loc, season, window) for loc in locations}
        final = {loc: o for loc, o in observed.items() if o and o["final"]}
        res: Dict[str, Any] = {"scope": scope, "final": bool(final), "locations": len(final),
                               "pending_locations": len([o for o in observed.values() if o and not o["final"]]),
                               "window_end": window[1], "common": common, "models": []}
        if not final:
            return res

        def tasks(mid: str, kind: str) -> Set[Tuple[str, str]]:
            return {k for k, s in per_model.get(mid, {}).items() if k[1] in final and s.get(kind)}

        shared = {}
        if common:
            for kind in ("timing", "size"):
                sets = [tasks(m, kind) for m in per_model if tasks(m, kind)]
                shared[kind] = set.intersection(*sets) if sets else set()

        for mid, summ in per_model.items():
            t_scores, s_scores = [], []
            for (ref, loc), s in summ.items():
                obs = final.get(loc)
                if obs is None:
                    continue
                if s.get("timing") and (not common or (ref, loc) in shared["timing"]):
                    sc = score_timing(s["timing"], obs["dates"])
                    if sc:
                        t_scores.append(sc)
                if s.get("size") and (not common or (ref, loc) in shared["size"]):
                    sc = score_size(s["size"], obs["value"])
                    if sc:
                        sc["wis_pct"] = sc["wis"] / obs["value"] * 100.0 if obs["value"] > 0 else None
                        s_scores.append(sc)
            if not t_scores and not s_scores:
                continue
            res["models"].append({
                "model_id": mid,
                "n_timing": len(t_scores),
                "n_size": len(s_scores),
                "rps": _mean([s["rps"] for s in t_scores]),
                "log_score": _mean([s["log_score"] for s in t_scores]),
                "abs_week_error": _mean([abs(s["week_error"]) for s in t_scores]),
                "timing_in50": _mean([float(s["in50"]) for s in t_scores]),
                "timing_in90": _mean([float(s["in90"]) for s in t_scores]),
                "size_wis": _mean([s["wis"] for s in s_scores]),
                "size_wis_pct": _mean([s["wis_pct"] for s in s_scores]),
                "size_abs_pct_error": _mean([abs(s["pct_error"]) if s["pct_error"] is not None else None for s in s_scores]),
                "size_in50": _mean([float(s["in50"]) if s["in50"] is not None else None for s in s_scores]),
                "size_in90": _mean([float(s["in90"]) if s["in90"] is not None else None for s in s_scores]),
            })
        res["models"].sort(key=lambda r: (r["rps"] is None, r["rps"] if r["rps"] is not None else 0))
        return res

    # ---- fan chart overlay ------------------------------------------------------------------------------

    def round_overlay(self, base_target: str, location: str, reference_date: str, model_ids: List[str]) -> Optional[Dict[str, Any]]:
        """Peak timing and size of one round, for the markers drawn on the fan chart."""
        pt = peak_targets_for(base_target)
        if not pt or not self.is_available(base_target):
            return None
        cutoff = _shift(reference_date, -7)
        models, candidates = [], set()
        for mid in model_ids:
            df = self._rows(mid, base_target, location=location, ref_dates=[reference_date])
            if df.is_empty():
                continue
            s = self._summaries(df, pt, cutoff).get((reference_date, str(location)), {})
            if not s:
                continue
            if s.get("timing"):
                candidates.update(s["timing"]["dates"])
                s["timing"] = {k: s["timing"][k] for k in ("median", "mode", "mode_prob", "i50", "i90", "p_passed")}
            if s.get("size"):
                s["size"] = {k: s["size"][k] for k in ("median", "i50", "i90", "i95")}
            models.append({"model_id": mid, **s})
        season = self.loader.get_flu_season_for_date(reference_date)
        window = self.season_window(season, candidates)
        return {"targets": pt, "models": models, "observed": self.observed(base_target, location, season, window),
                "window": list(window)}

    # ---- spatial map ------------------------------------------------------------------------------------

    def map_layer(self, base_target: str, reference_date: str, model_id: str) -> Dict[str, Any]:
        """Per-location peak timing and size of one model and round, for the choropleth layers."""
        pt = peak_targets_for(base_target)
        locations = self.loader.get_locations()
        out: Dict[str, Any] = {"model_id": model_id, "reference_date": reference_date, "targets": pt, "locations": {}}
        if not pt:
            return out
        df = self._rows(model_id, base_target, ref_dates=[reference_date])
        summ = self._summaries(df, pt, _shift(reference_date, -7))
        season = self.loader.get_flu_season_for_date(reference_date)
        candidates = {d for s in summ.values() if s.get("timing") for d in s["timing"]["dates"]}
        window = self.season_window(season, candidates)
        out["window"] = list(window)
        for (ref, loc), s in summ.items():
            pop = (locations.get(loc) or {}).get("population")
            t, z = s.get("timing"), s.get("size")
            obs = self.observed(base_target, loc, season, window)
            out["locations"][loc] = {
                "timing": {k: t[k] for k in ("median", "mode", "mode_prob", "i50", "i90", "p_passed")} if t else None,
                "size": {k: z[k] for k in ("median", "i50", "i90")} if z else None,
                "size_per_100k": (z["median"] / pop * 1e5) if z and pop else None,
                "observed": obs,
            }
        return out
