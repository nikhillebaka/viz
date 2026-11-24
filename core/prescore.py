"""
Incremental materialized per-task score cache (`<cache_dir>/scores/<target_slug>.parquet`).

Scores each persistent model against reconciled oracle truth once per `(oracle_sig, model_sig)` so
leaderboard requests across varying date windows, location pools, horizons, and subsets evaluate in
milliseconds by filtering pre-scored task rows instead of re-loading and pivoting 23 quantiles each time.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import re
import threading
from typing import Any, Dict, List, Optional, Sequence, Tuple

import polars as pl

from viz.core.metrics import score_forecasts
from viz.core.parallel import ordered_map

logger = logging.getLogger("viz.prescore")


class _KeyLocks:
    """Per-key reentrancy-free lock pool for target score files."""

    def __init__(self):
        self._guard = threading.Lock()
        self._locks: Dict[str, threading.Lock] = {}

    def get(self, key: str) -> threading.Lock:
        with self._guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock

PRESCORE_VERSION = 1


def _target_slug(target: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(target or "").strip()).strip("_") or "target"


def _file_sig(path: Optional[Path]) -> Optional[List[Any]]:
    if path is None:
        return None
    try:
        st = path.stat()
        return [str(path), round(st.st_mtime, 4), int(st.st_size)]
    except OSError:
        return None


class PreScoreStore:
    """Materializes and incrementally maintains per-task quantile scores per target."""

    def __init__(self, cache_dir: Path, loader):
        self.scores_dir = Path(cache_dir) / "scores"
        self.loader = loader
        self._locks = _KeyLocks()
        self._mem_lock = threading.Lock()
        self._mem_cache: Dict[str, Tuple[Any, Dict[str, Tuple[pl.DataFrame, Dict[str, Any]]]]] = {}

    def invalidate(self, target: Optional[str] = None):
        """Drop in-memory and on-disk materialized score tables."""
        with self._mem_lock:
            if target is None:
                self._mem_cache.clear()
            else:
                self._mem_cache.pop(target, None)
        if self.scores_dir.exists():
            if target is None:
                for f in self.scores_dir.iterdir():
                    if f.is_file():
                        f.unlink(missing_ok=True)
            else:
                slug = _target_slug(target)
                (self.scores_dir / f"{slug}.parquet").unlink(missing_ok=True)
                (self.scores_dir / f"{slug}.meta.json").unlink(missing_ok=True)

    def _oracle_signature(self) -> Optional[List[Any]]:
        cm = self.loader.cache_mgr
        ora = cm.get_oracle_parquet()
        if ora is None:
            return None
        adm = cm.get_admissions_parquet()
        return [_file_sig(ora), _file_sig(adm)]

    def _model_parquet_and_sig(
        self, model_id: str, model_info: Dict[str, Any]
    ) -> Tuple[Optional[Path], Optional[List[Any]]]:
        if model_info.get("is_synthetic"):
            # Only cache persistent/on-disk models; synthetic ensembles are cheap or dynamically edited
            return None, None
        if "raw_name" in model_info:
            raw_id = str(model_info["raw_name"])
            is_local = bool(model_info.get("is_local", False))
        else:
            raw_id, is_local = self.loader._resolve_model_id_and_local(model_id)
        pq = self.loader.cache_mgr.get_model_parquet(raw_id, is_local=is_local)
        if pq is None:
            return None, None
        sig = _file_sig(pq)
        return (pq, sig) if sig is not None else (None, None)

    def _load_disk_state(
        self, target: str, oracle_sig: List[Any], non_negative: bool, extra_task_ids: Sequence[str]
    ) -> Tuple[pl.DataFrame, Dict[str, Any]]:
        slug = _target_slug(target)
        pq_path = self.scores_dir / f"{slug}.parquet"
        meta_path = self.scores_dir / f"{slug}.meta.json"
        if not pq_path.exists() or not meta_path.exists():
            return pl.DataFrame(), {"version": PRESCORE_VERSION, "oracle_sig": oracle_sig, "non_negative": non_negative, "extra_task_ids": list(extra_task_ids), "models": {}}
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            meta = {}
        if (
            meta.get("version") != PRESCORE_VERSION
            or meta.get("oracle_sig") != oracle_sig
            or bool(meta.get("non_negative")) != bool(non_negative)
            or list(meta.get("extra_task_ids") or []) != list(extra_task_ids)
        ):
            return pl.DataFrame(), {
                "version": PRESCORE_VERSION,
                "oracle_sig": oracle_sig,
                "non_negative": bool(non_negative),
                "extra_task_ids": list(extra_task_ids),
                "models": {},
            }
        try:
            df = pl.read_parquet(pq_path)
            return df, meta
        except Exception:
            return pl.DataFrame(), {
                "version": PRESCORE_VERSION,
                "oracle_sig": oracle_sig,
                "non_negative": bool(non_negative),
                "extra_task_ids": list(extra_task_ids),
                "models": {},
            }

    def _write_disk_state(self, target: str, df: pl.DataFrame, meta: Dict[str, Any]):
        self.scores_dir.mkdir(parents=True, exist_ok=True)
        slug = _target_slug(target)
        pq_path = self.scores_dir / f"{slug}.parquet"
        meta_path = self.scores_dir / f"{slug}.meta.json"
        tid = f"{os.getpid()}.{threading.get_ident()}"
        tmp_pq = pq_path.with_suffix(f".tmp.{tid}.parquet")
        tmp_meta = meta_path.with_suffix(f".tmp.{tid}.json")
        try:
            df.write_parquet(tmp_pq, compression="zstd")
            os.replace(tmp_pq, pq_path)
            tmp_meta.write_text(json.dumps(meta), encoding="utf-8")
            os.replace(tmp_meta, meta_path)
        finally:
            tmp_pq.unlink(missing_ok=True)
            tmp_meta.unlink(missing_ok=True)

    def get_model_task_scores(
        self,
        target: str,
        model_ids: Sequence[str],
        all_models: Dict[str, Dict[str, Any]],
        oracle: pl.DataFrame,
        *,
        non_negative: bool,
        extra_task_ids: Sequence[str] = (),
    ) -> Dict[str, Tuple[pl.DataFrame, Dict[str, Any]]]:
        """
        Return `{model_id: (task_df, meta)}` for every persistent model in `model_ids` that has
        scored quantile tasks for `target`. Uncached or stale models are scored incrementally in parallel.
        Synthetic/ephemeral models are omitted so callers evaluate them in memory.
        """
        oracle_sig = self._oracle_signature()
        if oracle_sig is None:
            return {}

        extra_cols = list(extra_task_ids)
        cache_meta_key = (oracle_sig, bool(non_negative), tuple(extra_cols))
        models_mtime = getattr(self.loader, "_models_cache_mtime", None)
        empty_df = pl.DataFrame()

        def _needs_prescore_check(mid: str) -> bool:
            info = all_models.get(mid)
            if not info or info.get("is_synthetic"):
                return False
            ots = info.get("output_types") or []
            if ots and "quantile" not in ots and "sample" not in ots and not info.get("from_samples"):
                return False
            tgts = info.get("targets") or []
            if tgts and target not in tgts:
                return False
            return True

        with self._locks.get(f"prescore::{_target_slug(target)}"):
            with self._mem_lock:
                mem = self._mem_cache.get(target)
            if (
                mem is not None
                and mem[0] == cache_meta_key
                and models_mtime is not None
                and models_mtime > 0
                and mem[1] == models_mtime
            ):
                _, _, mem_by_mid, mem_models = mem
                if all(mem_models.get(mid) is not None for mid in model_ids if _needs_prescore_check(mid)):
                    return {
                        mid: (mem_by_mid.get(mid, empty_df), mem_models[mid])
                        for mid in model_ids
                        if mid in mem_models
                    }

            target_pqs: Dict[str, Tuple[Path, List[Any]]] = {}
            for mid in model_ids:
                info = all_models.get(mid)
                if not info:
                    continue
                pq, sig = self._model_parquet_and_sig(mid, info)
                if pq is not None and sig is not None:
                    target_pqs[mid] = (pq, sig)

            if not target_pqs:
                return {}

            if mem is not None and mem[0] == cache_meta_key:
                _, _, mem_by_mid, mem_models = mem
                if all(mem_models.get(mid, {}).get("sig") == sig for mid, (_, sig) in target_pqs.items()):
                    return {mid: (mem_by_mid.get(mid, empty_df), mem_models[mid]) for mid in target_pqs}

            disk_df, disk_meta = self._load_disk_state(target, oracle_sig, non_negative, extra_cols)
            cached_models = disk_meta.get("models") or {}

            stale_or_new: List[Tuple[str, Path, List[Any]]] = []
            for mid, (pq, sig) in target_pqs.items():
                entry = cached_models.get(mid)
                if entry is None or entry.get("sig") != sig:
                    stale_or_new.append((mid, pq, sig))

            # Also prune deleted models if the score table already needs rewriting
            existing_disk_mids = set(cached_models.keys())
            dirty = bool(stale_or_new)

            if stale_or_new:
                def _score_one(item: Tuple[str, Path, List[Any]]) -> Tuple[str, List[Any], Optional[pl.DataFrame], Optional[Dict[str, Any]]]:
                    mid, pq_path, sig = item
                    try:
                        m_df = pl.scan_parquet(pq_path).filter(pl.col("target") == target).collect()
                    except Exception as exc:
                        logger.debug("PreScore scan failed for %s: %s", mid, exc)
                        return mid, sig, None, None
                    if m_df.is_empty():
                        return mid, sig, pl.DataFrame(), {
                            "sig": sig,
                            "quantile_count": 0,
                            "present_quantiles": [],
                            "has_23_quantiles": False,
                            "has_7_quantiles": False,
                            "negative_values_clipped": 0,
                        }
                    sc = score_forecasts(
                        m_df,
                        oracle,
                        target=target,
                        non_negative=non_negative,
                        extra_task_ids=extra_cols,
                        return_task_df=True,
                    )
                    tdf = sc.get("task_df") if sc else None
                    if tdf is None or tdf.is_empty():
                        return mid, sig, pl.DataFrame(), {
                            "sig": sig,
                            "quantile_count": 0,
                            "present_quantiles": [],
                            "has_23_quantiles": False,
                            "has_7_quantiles": False,
                            "negative_values_clipped": 0,
                        }
                    tdf = tdf.with_columns(pl.lit(mid).alias("model_id"))
                    mmeta = sc["metadata"]
                    entry_meta = {
                        "sig": sig,
                        "quantile_count": int(mmeta.get("quantile_count", 0)),
                        "present_quantiles": list(mmeta.get("present_quantiles") or []),
                        "has_23_quantiles": bool(sc["overall"].get("has_23_quantiles", False)),
                        "has_7_quantiles": bool(sc["overall"].get("has_7_quantiles", False)),
                        "negative_values_clipped": int(mmeta.get("negative_values_clipped", 0)),
                    }
                    return mid, sig, tdf, entry_meta

                computed = ordered_map(_score_one, stale_or_new)
                rebuilt_ids = {mid for mid, _, _, em in computed if em is not None}
                kept_frames: List[pl.DataFrame] = []
                if not disk_df.is_empty() and "model_id" in disk_df.columns:
                    keep_ids = existing_disk_mids - rebuilt_ids
                    if keep_ids:
                        kept_df = disk_df.filter(pl.col("model_id").is_in(sorted(keep_ids)))
                        if not kept_df.is_empty():
                            kept_frames.append(kept_df)

                for mid, sig, tdf, em in computed:
                    if em is None:
                        cached_models.pop(mid, None)
                        continue
                    cached_models[mid] = em
                    if tdf is not None and not tdf.is_empty():
                        kept_frames.append(tdf)

                disk_df = pl.concat(kept_frames, how="diagonal_relaxed") if kept_frames else pl.DataFrame(schema={"model_id": pl.String})
                disk_meta["models"] = cached_models
                if dirty:
                    try:
                        self._write_disk_state(target, disk_df, disk_meta)
                    except OSError as exc:
                        logger.warning("Could not write prescore cache for %s: %s", target, exc)

            all_by_mid: Dict[str, pl.DataFrame] = {}
            if not disk_df.is_empty() and "model_id" in disk_df.columns:
                all_by_mid = {
                    str(k[0]): g.drop("model_id")
                    for k, g in disk_df.group_by(["model_id"], maintain_order=True)
                }
            with self._mem_lock:
                self._mem_cache[target] = (cache_meta_key, models_mtime, all_by_mid, dict(cached_models))
            return {
                mid: (all_by_mid.get(mid, empty_df), cached_models[mid])
                for mid in target_pqs
                if mid in cached_models
            }
