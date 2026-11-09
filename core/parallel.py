"""
Ordered thread-pool map for per-model work (loading, task extraction, scoring).

Polars releases the GIL while it computes, so per-model pipelines run truly in parallel on threads.
Results always come back in input order, so every caller builds its dicts and lists in exactly the
same order as a plain loop would. Set VIZ_THREADS=1 to run everything sequentially.
"""

import os
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Iterable, List, Tuple, TypeVar

T = TypeVar("T")
R = TypeVar("R")

# Each Polars operation already runs on every core, so model-level threads mostly overlap the
# Python-side gaps between operations. Measured on an 8-core M3 (4 performance cores): 4 threads was
# fastest; 8 added ~0.3 GB peak memory and was no faster.
_MAX_DEFAULT_THREADS = 4


def worker_count() -> int:
    """Threads to use: VIZ_THREADS if set, else the CPU count capped at 4."""
    env = os.environ.get("VIZ_THREADS", "").strip()
    if env:
        try:
            return max(1, int(env))
        except ValueError:
            pass
    return max(1, min(_MAX_DEFAULT_THREADS, os.cpu_count() or 1))


def ordered_map(fn: Callable[[T], R], items: Iterable[T]) -> List[R]:
    """[fn(x) for x in items], computed on a thread pool. Raises the first failing item's exception (in input order)."""
    items = list(items)
    n = min(worker_count(), len(items))
    if n <= 1:
        return [fn(x) for x in items]
    # A fresh pool per call: nested calls can never deadlock waiting on a shared, exhausted pool.
    with ThreadPoolExecutor(max_workers=n, thread_name_prefix="viz-worker") as pool:
        return list(pool.map(fn, items))


def ordered_map_outcomes(fn: Callable[[T], R], items: Iterable[T]) -> List[Tuple[bool, object]]:
    """Like ordered_map, but returns (True, result) or (False, exception) per item instead of raising.

    Lets a caller replay sequential early-exit semantics exactly: walk the outcomes in order and stop
    (or raise) at the same item a plain loop would have stopped at.
    """
    def wrapped(x: T) -> Tuple[bool, object]:
        try:
            return True, fn(x)
        except Exception as exc:  # re-raised by the caller only if a sequential loop would have reached it
            return False, exc

    return ordered_map(wrapped, items)
