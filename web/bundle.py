"""Streaming VZB1 bundle extraction, strict Hubverse path allowlist, validation, and rate limiting."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import struct
import threading
import time
from typing import Any, BinaryIO, Deque, Dict, Optional, Set
import zlib

import polars as pl

from viz.core.paths import inspect_local_hub, is_hub_dir
from viz.remote.hubs import assess_compatibility
from viz.web.config import WebConfig

VZB1_MAGIC = b"VZB1"
_MAX_PATH_LEN = 240
_CHUNK_SIZE = 65536
_SAFE_SEG_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_RESERVED_MODEL_NAMES = frozenset({"synthetic", "remote"})


class UploadTooLargeError(Exception):
    """Raised with HTTP 413 when an upload exceeds compressed, uncompressed, count, or quota limits."""


class UploadValidationError(Exception):
    """Raised with HTTP 400 when a bundle payload is malformed or attempts disallowed/unsafe paths."""


class UploadIncompatibleError(Exception):
    """Raised with HTTP 422 when an uploaded directory is not a compatible Hubverse hub."""


class RateLimitExceededError(Exception):
    """Raised with HTTP 429 when an IP exceeds upload frequency limits or server concurrency is saturated."""


@dataclass(frozen=True)
class BundleStats:
    compressed_bytes: int
    uncompressed_bytes: int
    extracted_bytes: int
    file_count: int


def validate_hubverse_relpath(raw_path: Any) -> Optional[str]:
    """
    Validate and normalize a candidate relative path inside a Hubverse hub folder.

    Returns a normalized POSIX relative path (e.g. `model-output/Team-Mod/2025-11-01-Team-Mod.parquet`)
    or `None` if the path contains traversal, unsafe characters, hidden files, symlinks/drives, or lies
    outside the strict Hubverse file allowlist.
    """
    if not isinstance(raw_path, str):
        return None
    if "\x00" in raw_path or "\\" in raw_path or ":" in raw_path:
        return None
    clean = raw_path.strip()
    if not clean or clean.startswith("/") or clean.endswith("/") or len(clean) > _MAX_PATH_LEN:
        return None
    if any(ord(c) < 32 for c in clean):
        return None

    parts = [p for p in clean.split("/")]
    if not parts or len(parts) > 5:
        return None
    for seg in parts:
        if not seg or seg in (".", "..") or seg.startswith(".") or not _SAFE_SEG_RE.match(seg):
            return None

    norm = "/".join(parts)
    if norm == "viz.config.json":
        return norm

    top = parts[0]
    ext = Path(parts[-1]).suffix.lower()

    if top == "hub-config":
        return norm if len(parts) == 2 and ext == ".json" else None
    if top == "model-metadata":
        return norm if len(parts) == 2 and ext in (".yml", ".yaml", ".json") else None
    if top in ("model-output", "local-output"):
        if len(parts) != 3 or parts[1].lower() in _RESERVED_MODEL_NAMES:
            return None
        return norm if ext in (".parquet", ".csv") else None
    if top == "target-data":
        return norm if len(parts) in (2, 3) and ext in (".parquet", ".csv") else None
    if top == "auxiliary-data":
        return norm if len(parts) in (2, 3, 4) and ext in (".csv", ".json", ".parquet") else None

    return None


class _BoundedDecompressStream:
    """Buffered streaming reader enforcing compressed and uncompressed byte limits chunk-by-chunk."""

    def __init__(
        self,
        rfile: BinaryIO,
        content_length: int,
        *,
        is_gzip: bool,
        max_compressed: int,
        max_uncompressed: int,
    ):
        self._rfile = rfile
        self._remaining = content_length
        self._is_gzip = is_gzip
        self._max_compressed = max_compressed
        self._max_uncompressed = max_uncompressed
        self._decomp = zlib.decompressobj(16 + zlib.MAX_WBITS) if is_gzip else None
        self._buf = bytearray()
        self._pos = 0
        self.compressed_bytes = 0
        self.uncompressed_bytes = 0
        self._eof = False

    def _fill(self) -> bool:
        if self._pos >= len(self._buf):
            self._buf.clear()
            self._pos = 0
        elif self._pos > _CHUNK_SIZE:
            del self._buf[:self._pos]
            self._pos = 0

        if self._eof:
            return False

        while True:
            if self._decomp is not None and self._decomp.unconsumed_tail:
                cap = min(262144, max(1, (self._max_uncompressed - self.uncompressed_bytes) + 1))
                try:
                    out = self._decomp.decompress(self._decomp.unconsumed_tail, max_length=cap)
                except zlib.error as exc:
                    raise UploadValidationError(f"Invalid gzip upload stream: {exc}") from exc
                if out:
                    self._account_uncompressed(len(out))
                    self._buf.extend(out)
                    return True

            if self._remaining <= 0:
                if self._decomp is not None:
                    cap = min(262144, max(1, (self._max_uncompressed - self.uncompressed_bytes) + 1))
                    try:
                        tail = self._decomp.flush(cap)
                    except zlib.error as exc:
                        raise UploadValidationError(f"Corrupt gzip upload stream: {exc}") from exc
                    if tail:
                        self._account_uncompressed(len(tail))
                        self._buf.extend(tail)
                self._eof = True
                return len(self._buf) > self._pos

            chunk = self._rfile.read(min(_CHUNK_SIZE, self._remaining))
            if not chunk:
                raise UploadValidationError("Unexpected end of upload stream")
            self._remaining -= len(chunk)
            self.compressed_bytes += len(chunk)
            if self.compressed_bytes > self._max_compressed:
                raise UploadTooLargeError(
                    f"Compressed upload exceeds {self._max_compressed // (1024 * 1024)} MB limit"
                )

            if self._decomp is not None:
                cap = min(262144, max(1, (self._max_uncompressed - self.uncompressed_bytes) + 1))
                try:
                    out = self._decomp.decompress(chunk, max_length=cap)
                except zlib.error as exc:
                    raise UploadValidationError(f"Invalid gzip upload stream: {exc}") from exc
                if out:
                    self._account_uncompressed(len(out))
                    self._buf.extend(out)
                    return True
                continue

            self._account_uncompressed(len(chunk))
            self._buf.extend(chunk)
            return True

    def _account_uncompressed(self, n: int) -> None:
        self.uncompressed_bytes += n
        if self.uncompressed_bytes > self._max_uncompressed:
            raise UploadTooLargeError(
                f"Uncompressed upload exceeds {self._max_uncompressed // (1024 * 1024)} MB limit"
            )

    def read_exact(self, n: int) -> bytes:
        """Read exactly `n` decompressed bytes or raise UploadValidationError."""
        out = bytearray()
        while len(out) < n:
            avail = len(self._buf) - self._pos
            if avail <= 0:
                if not self._fill():
                    raise UploadValidationError("Truncated VZB1 bundle stream")
                avail = len(self._buf) - self._pos
            take = min(n - len(out), avail)
            out.extend(self._buf[self._pos:self._pos + take])
            self._pos += take
        return bytes(out)

    def copy_exact_to(self, n: int, fd: int) -> None:
        """Stream `n` decompressed bytes directly into an open file descriptor without full buffering."""
        left = n
        while left > 0:
            avail = len(self._buf) - self._pos
            if avail <= 0:
                if not self._fill():
                    raise UploadValidationError("Truncated VZB1 file payload")
                avail = len(self._buf) - self._pos
            take = min(left, avail)
            chunk = self._buf[self._pos:self._pos + take]
            written = 0
            while written < len(chunk):
                written += os.write(fd, chunk[written:] if written else chunk)
            self._pos += take
            left -= take

    def drain_eof_check(self) -> None:
        """Consume any remaining gzip trailer bytes and verify no unexpected trailing VZB1 data exists."""
        while not self._eof:
            self._fill()
        if len(self._buf) > self._pos:
            raise UploadValidationError("Unexpected trailing data after VZB1 terminator")


def _safe_write_dest(dest_root: Path, rel_posix: str) -> Path:
    parts = rel_posix.split("/")
    cur = dest_root
    for folder in parts[:-1]:
        cur = cur / folder
        if cur.is_symlink():
            raise UploadValidationError("Symlinks are not permitted")
        cur.mkdir(mode=0o700, exist_ok=True)
    target = (dest_root / rel_posix).resolve()
    if dest_root not in target.parents:
        raise UploadValidationError("Resolved path escaped staging root")
    return target


def extract_vzb1_stream(
    rfile: BinaryIO,
    content_length: int,
    dest_dir: Path,
    cfg: WebConfig,
    *,
    is_gzip: bool = True,
) -> BundleStats:
    """
    Stream-parse a VZB1 archive (optionally gzipped) directly to `dest_dir` with strict security caps.

    Wire format (little-endian):
      `b"VZB1"` + N × (`uint32 path_len`, `UTF-8 path`, `uint64 file_len`, `file_len bytes`) + `uint32(0)`
    """
    if content_length <= 0:
        raise UploadValidationError("Empty upload body")
    if content_length > cfg.max_compressed_bytes:
        raise UploadTooLargeError(
            f"Upload size ({content_length // (1024 * 1024)} MB) exceeds {cfg.max_compressed_bytes // (1024 * 1024)} MB limit"
        )

    dest_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    dest_root = dest_dir.resolve()
    stream = _BoundedDecompressStream(
        rfile,
        content_length,
        is_gzip=is_gzip,
        max_compressed=cfg.max_compressed_bytes,
        max_uncompressed=cfg.max_uncompressed_bytes,
    )

    magic = stream.read_exact(4)
    if magic != VZB1_MAGIC:
        raise UploadValidationError("Invalid upload bundle format (expected VZB1 stream)")

    seen_paths: Set[str] = set()
    extracted_bytes = 0
    file_count = 0
    o_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        o_flags |= os.O_NOFOLLOW

    while True:
        path_len = struct.unpack("<I", stream.read_exact(4))[0]
        if path_len == 0:
            break
        if path_len > _MAX_PATH_LEN:
            raise UploadValidationError("Archive member path too long")

        file_count += 1
        if file_count > cfg.max_files:
            raise UploadTooLargeError(f"Upload exceeds {cfg.max_files} file limit")

        raw_path_bytes = stream.read_exact(path_len)
        try:
            raw_path = raw_path_bytes.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise UploadValidationError("Archive member path is not valid UTF-8") from exc

        rel = validate_hubverse_relpath(raw_path)
        if rel is None:
            raise UploadValidationError(f"Disallowed file path in hub bundle: '{raw_path}'")
        if rel in seen_paths:
            raise UploadValidationError(f"Duplicate file path in hub bundle: '{rel}'")
        seen_paths.add(rel)

        file_len = struct.unpack("<Q", stream.read_exact(8))[0]
        if file_len > cfg.max_uncompressed_bytes or (extracted_bytes + file_len) > cfg.max_uncompressed_bytes:
            raise UploadTooLargeError(
                f"Extracted upload size exceeds {cfg.max_uncompressed_bytes // (1024 * 1024)} MB limit"
            )

        target = _safe_write_dest(dest_root, rel)
        fd = os.open(target, o_flags, 0o600)
        try:
            stream.copy_exact_to(file_len, fd)
        finally:
            os.close(fd)
        extracted_bytes += file_len

    stream.drain_eof_check()
    return BundleStats(
        compressed_bytes=stream.compressed_bytes,
        uncompressed_bytes=stream.uncompressed_bytes,
        extracted_bytes=extracted_bytes,
        file_count=file_count,
    )


def _probe_readable_table(path: Path) -> None:
    ext = path.suffix.lower()
    if ext == ".parquet":
        pl.scan_parquet(path).limit(1).collect()
    elif ext == ".csv":
        pl.read_csv(path, n_rows=2, infer_schema_length=0)


def validate_extracted_hub(staging_dir: Path) -> Dict[str, Any]:
    """Verify the uploaded directory is a readable, compatible Hubverse hub."""
    if not is_hub_dir(staging_dir):
        raise UploadIncompatibleError(
            "Selected folder is not a Hubverse hub (expected hub-config/tasks.json, model-output/, or target-data/)."
        )

    forecast_files = []
    for sub in ("model-output", "local-output"):
        d = staging_dir / sub
        if d.is_dir():
            forecast_files.extend(
                p for p in d.rglob("*")
                if p.is_file() and p.suffix.lower() in (".parquet", ".csv")
            )
    truth_dir = staging_dir / "target-data"
    truth_files = (
        [p for p in truth_dir.rglob("*") if p.is_file() and p.suffix.lower() in (".parquet", ".csv")]
        if truth_dir.is_dir() else []
    )
    if not forecast_files and not truth_files:
        raise UploadIncompatibleError(
            "Hub folder contains no forecast or target-data tables (.parquet or .csv)."
        )

    tasks_file = staging_dir / "hub-config" / "tasks.json"
    if tasks_file.is_file():
        admin_file = staging_dir / "hub-config" / "admin.json"
        try:
            tasks = json.loads(tasks_file.read_text(encoding="utf-8"))
        except Exception as exc:
            raise UploadIncompatibleError(f"Unreadable hub-config/tasks.json: {exc}") from exc
        admin: Dict[str, Any] = {}
        if admin_file.is_file():
            try:
                loaded_admin = json.loads(admin_file.read_text(encoding="utf-8"))
                if isinstance(loaded_admin, dict):
                    admin = loaded_admin
            except Exception as exc:
                raise UploadIncompatibleError(f"Unreadable hub-config/admin.json: {exc}") from exc
        compat = assess_compatibility(admin, tasks)
        if not compat.get("supported"):
            raise UploadIncompatibleError(str(compat.get("reason") or "Hub schema is not compatible with viz."))

    # Spot-check up to 3 data files so corrupt payloads fail cleanly on upload
    for sample_file in (forecast_files[:2] + truth_files[:1]):
        try:
            _probe_readable_table(sample_file)
        except Exception as exc:
            raise UploadIncompatibleError(
                f"Could not read Hubverse table '{sample_file.relative_to(staging_dir)}': {exc}"
            ) from exc

    info = inspect_local_hub(staging_dir)
    if not info.get("valid"):
        raise UploadIncompatibleError("Uploaded directory could not be indexed as a Hubverse hub.")
    return info


class UploadRateLimiter:
    """Thread-safe per-IP sliding window rate limiter + global concurrency cap for uploads."""

    def __init__(self, rate_per_min: int, max_concurrent: int):
        self._rate = max(1, int(rate_per_min))
        self._lock = threading.Lock()
        self._hits: Dict[str, Deque[float]] = {}
        self._sem = threading.Semaphore(max(1, int(max_concurrent)))

    def acquire(self, client_ip: str, *, now: Optional[float] = None) -> None:
        """Reserve an upload slot or raise RateLimitExceededError."""
        ts = time.time() if now is None else now
        cutoff = ts - 60.0
        key = (client_ip or "unknown").strip() or "unknown"
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= self._rate:
                raise RateLimitExceededError("Too many uploads from your address; please wait a minute and try again.")
            if not self._sem.acquire(blocking=False):
                raise RateLimitExceededError("Server is busy processing other hub uploads; please retry shortly.")
            q.append(ts)

    def release(self) -> None:
        """Release the global upload concurrency slot."""
        self._sem.release()
