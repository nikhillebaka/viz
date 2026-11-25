"""
Pluggable read-only transports for syncing remote Hubverse hubs (S3 buckets and GitHub repos).
Standard library only (`urllib` + `xml.etree.ElementTree` + `json`).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import http.client
import json
import logging
import os
import re
import socket
import ssl
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Protocol
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

logger = logging.getLogger("viz.remote.transport")

USER_AGENT = "Viz-Hub-Sync/2.0"
_S3_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"
_BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
_GH_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

SSL_HINT = (
    "SSL certificate verification failed. On macOS with a python.org Python install, run "
    "'Install Certificates.command' from the Python application folder, then retry."
)


class TransportError(Exception):
    """Raised for any network, permission, rate-limit, or protocol failure talking to a hub remote."""


class TransportNotFound(TransportError):
    """Raised when a remote object or repository resource does not exist (HTTP 404)."""


class SyncCancelled(Exception):
    """Raised inside a sync when the user cancels it."""


@dataclass(frozen=True)
class RemoteObject:
    key: str
    size: int
    etag: str
    last_modified: str  # ISO 8601 UTC when available, else ""


class HubTransport(Protocol):
    source_name: str

    def list(self, prefix: str, on_page: Optional[Callable[[int], None]] = None) -> List[RemoteObject]:
        ...

    def get(self, key: str) -> bytes:
        ...


def validate_bucket_name(name: str) -> str:
    """Normalize and validate an S3 bucket name. Only bare bucket names are accepted, never URLs."""
    clean = (name or "").strip()
    if clean.lower().startswith("s3://"):
        clean = clean[5:]
    clean = clean.strip("/")
    if not _BUCKET_RE.match(clean) or ".." in clean or "/" in clean:
        raise ValueError(f"'{name}' is not a valid S3 bucket name")
    return clean


def validate_github_repo(spec: str) -> str:
    """
    Normalize and validate a GitHub `owner/repo` specifier or HTTPS GitHub URL.
    Rejects non-GitHub hosts, traversal tokens, query strings, or sub-paths.
    """
    raw = (spec or "").strip()
    if not raw:
        raise ValueError("GitHub repository cannot be empty")
    if ".." in raw or "\\" in raw:
        raise ValueError(f"'{spec}' is not a valid GitHub repository")

    clean = raw
    lower = clean.lower()
    if lower.startswith(("http://", "https://")):
        parsed = urllib.parse.urlparse(clean)
        if parsed.netloc.lower() not in ("github.com", "www.github.com"):
            raise ValueError(f"'{spec}' must point to github.com")
        if parsed.query or parsed.fragment:
            raise ValueError(f"'{spec}' must not contain query parameters or fragments")
        clean = parsed.path.strip("/")
    elif lower.startswith("github.com/"):
        clean = clean[len("github.com/"):].strip("/")

    if clean.endswith(".git"):
        clean = clean[:-4]
    clean = clean.strip("/")

    if not _GH_REPO_RE.match(clean):
        raise ValueError(f"'{spec}' is not a valid GitHub repository (expected 'owner/repo')")
    return clean


class _BaseHTTPTransport:
    """Shared resilient HTTP fetcher with cancellation, retries, and clean error reporting."""

    def __init__(self, timeout: float = 30.0, retries: int = 4, cancel_event: Optional[threading.Event] = None):
        self.timeout = timeout
        self.retries = retries
        self.cancel_event = cancel_event

    def _check_cancel(self):
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise SyncCancelled()

    def _sleep_retry(self, seconds: float) -> None:
        if self.cancel_event is not None:
            if self.cancel_event.wait(timeout=max(0.0, seconds)):
                raise SyncCancelled("Sync cancelled by user")
        else:
            time.sleep(max(0.0, seconds))

    @staticmethod
    def _parse_retry_after(headers: Any) -> Optional[float]:
        if not headers:
            return None
        raw = headers.get("Retry-After")
        if not raw:
            return None
        try:
            return max(0.5, min(float(str(raw).strip()), 30.0))
        except ValueError:
            return None

    def _http_get(
        self,
        url: str,
        *,
        headers: Optional[Dict[str, str]] = None,
        service_label: str = "remote",
        denied_msg: Optional[str] = None,
        rate_limit_msg: Optional[str] = None,
    ) -> bytes:
        delay = 0.5
        req_headers = {"User-Agent": USER_AGENT}
        if headers:
            req_headers.update(headers)
        for attempt in range(self.retries + 1):
            self._check_cancel()
            req = urllib.request.Request(url, headers=req_headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return resp.read()
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    raise TransportNotFound(f"Not found: {url}") from exc
                if exc.code in (401, 403, 429):
                    retry_after = self._parse_retry_after(exc.headers)
                    remaining = str(exc.headers.get("X-RateLimit-Remaining", "") if exc.headers else "").strip()
                    reset_raw = str(exc.headers.get("X-RateLimit-Reset", "") if exc.headers else "").strip()
                    body_low = ""
                    try:
                        body_low = exc.read(4096).decode("utf-8", errors="ignore").lower()
                    except Exception:
                        pass

                    is_secondary = exc.code == 403 and (
                        retry_after is not None or "secondary rate limit" in body_low or "abuse" in body_low
                    )
                    is_primary_rl = exc.code == 403 and (
                        remaining == "0" or ("rate limit" in body_low and "secondary" not in body_low)
                    )
                    if (exc.code == 429 or is_secondary) and attempt < self.retries:
                        wait_s = retry_after if retry_after is not None else min(delay * 2, 8.0)
                        self._sleep_retry(wait_s)
                        delay *= 2
                        continue

                    if exc.code == 429 or is_secondary or is_primary_rl:
                        reset_note = ""
                        if reset_raw.isdigit():
                            try:
                                dt = datetime.fromtimestamp(int(reset_raw), tz=timezone.utc).strftime("%H:%M:%S UTC")
                                reset_note = f" (resets at {dt})"
                            except (OverflowError, OSError, ValueError):
                                pass
                        msg = rate_limit_msg or f"Rate limited by {service_label} (HTTP {exc.code}) for {url}"
                        raise TransportError(f"{msg}{reset_note}") from exc

                    msg = denied_msg or f"Access denied from {service_label} (HTTP {exc.code}) for {url}"
                    raise TransportError(msg) from exc
                if exc.code in (500, 502, 503, 504) and attempt < self.retries:
                    self._sleep_retry(delay)
                    delay *= 2
                    continue
                raise TransportError(f"HTTP {exc.code} from {service_label} for {url}") from exc
            except urllib.error.URLError as exc:
                reason = exc.reason
                if isinstance(reason, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(reason):
                    raise TransportError(SSL_HINT) from exc
                if attempt < self.retries:
                    self._sleep_retry(delay)
                    delay *= 2
                    continue
                raise TransportError(f"Network error reaching {service_label}: {reason}") from exc
            except ssl.SSLCertVerificationError as exc:
                raise TransportError(SSL_HINT) from exc
            except (
                TimeoutError,
                socket.timeout,
                http.client.IncompleteRead,
                http.client.RemoteDisconnected,
                ConnectionResetError,
                ConnectionAbortedError,
                BrokenPipeError,
                ssl.SSLError,
            ) as exc:
                if attempt < self.retries:
                    self._sleep_retry(delay)
                    delay *= 2
                    continue
                raise TransportError(f"Connection interrupted reaching {service_label} ({url}): {exc}") from exc
        raise TransportError(f"Failed to fetch {url}")


class S3Transport(_BaseHTTPTransport):
    """Anonymous, read-only access to one public S3 bucket using ListObjectsV2."""

    def __init__(
        self,
        bucket: str,
        timeout: float = 30.0,
        retries: int = 4,
        cancel_event: Optional[threading.Event] = None,
    ):
        super().__init__(timeout=timeout, retries=retries, cancel_event=cancel_event)
        self.bucket = validate_bucket_name(bucket)
        # Dotted bucket names break virtual-host TLS certificates, so fall back to path-style URLs
        if "." in self.bucket:
            self.base_url = f"https://s3.amazonaws.com/{self.bucket}"
        else:
            self.base_url = f"https://{self.bucket}.s3.amazonaws.com"
        self.source_name = self.bucket

    def _fetch(self, url: str) -> bytes:
        return self._http_get(
            url,
            service_label="S3",
            denied_msg=f"Access denied for bucket '{self.bucket}' (it may not exist or is not public)",
        )

    def get(self, key: str) -> bytes:
        """Download one object from the S3 bucket."""
        return self._fetch(f"{self.base_url}/{urllib.parse.quote(key)}")

    def list(self, prefix: str, on_page: Optional[Callable[[int], None]] = None) -> List[RemoteObject]:
        """List every object under a prefix (ListObjectsV2, paginated). Directory markers are skipped."""
        objects: List[RemoteObject] = []
        token: Optional[str] = None
        while True:
            params = {"list-type": "2", "prefix": prefix}
            if token:
                params["continuation-token"] = token
            body = self._fetch(f"{self.base_url}/?{urllib.parse.urlencode(params)}")
            try:
                root = ET.fromstring(body)
            except ET.ParseError as exc:
                raise TransportError(f"Unexpected S3 listing response for '{prefix}'") from exc
            for c in root.findall(f"{_S3_NS}Contents"):
                key = c.findtext(f"{_S3_NS}Key") or ""
                if not key or key.endswith("/"):
                    continue
                objects.append(
                    RemoteObject(
                        key=key,
                        size=int(c.findtext(f"{_S3_NS}Size") or 0),
                        etag=(c.findtext(f"{_S3_NS}ETag") or "").strip('"'),
                        last_modified=c.findtext(f"{_S3_NS}LastModified") or "",
                    )
                )
            if on_page:
                on_page(len(objects))
            if (root.findtext(f"{_S3_NS}IsTruncated") or "false").lower() == "true":
                token = root.findtext(f"{_S3_NS}NextContinuationToken")
                if not token:
                    raise TransportError(
                        f"S3 listing truncated without continuation token for '{self.bucket}/{prefix}'"
                    )
            else:
                break
        return objects


class GitHubTransport(_BaseHTTPTransport):
    """
    Read-only access to a public (or token-authenticated) Hubverse GitHub repository.

    - `list(prefix)` uses ONE cached recursive Git Trees API request for the whole repository,
      keeping GitHub API usage to 1 call per sync.
    - `get(key)` downloads files directly via `raw.githubusercontent.com` (zero API rate-limit cost).
    """

    def __init__(
        self,
        repo: str,
        branch: str = "main",
        token: Optional[str] = None,
        timeout: float = 30.0,
        retries: int = 4,
        cancel_event: Optional[threading.Event] = None,
        api_base: str = "https://api.github.com",
        raw_base: str = "https://raw.githubusercontent.com",
    ):
        super().__init__(timeout=timeout, retries=retries, cancel_event=cancel_event)
        self.repo = validate_github_repo(repo)
        self.branch = (branch or "main").strip() or "main"
        resolved_tok = token if token is not None else (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or None)
        self.token = resolved_tok.strip() if resolved_tok else None
        self.api_base = api_base.rstrip("/")
        self.raw_base = raw_base.rstrip("/")
        self.source_name = f"github:{self.repo}"
        self._tree_lock = threading.Lock()
        self._tree: Optional[List[RemoteObject]] = None
        self.last_listing_truncated = False

    def _api_headers(self) -> Dict[str, str]:
        hdrs = {"Accept": "application/vnd.github+json"}
        if self.token:
            hdrs["Authorization"] = f"Bearer {self.token}"
        return hdrs

    def _load_tree(self) -> List[RemoteObject]:
        with self._tree_lock:
            if self._tree is not None:
                return self._tree
            self.last_listing_truncated = False
            url = f"{self.api_base}/repos/{self.repo}/git/trees/{urllib.parse.quote(self.branch)}?recursive=1"
            rate_msg = (
                f"GitHub API rate limit exceeded for '{self.repo}'."
                if self.token
                else f"GitHub API rate limit exceeded for '{self.repo}'. Set GITHUB_TOKEN to raise the limit from 60 to 5,000 requests/hour."
            )
            denied_msg = (
                f"Access denied from GitHub API for '{self.repo}' (check GITHUB_TOKEN permissions or repo visibility)."
                if self.token
                else f"Access denied from GitHub API for '{self.repo}' (repository may be private)."
            )
            body = self._http_get(
                url,
                headers=self._api_headers(),
                service_label="GitHub API",
                denied_msg=denied_msg,
                rate_limit_msg=rate_msg,
            )
            try:
                payload = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as exc:
                raise TransportError(f"Unexpected GitHub tree response for '{self.repo}'") from exc

            if payload.get("truncated"):
                self.last_listing_truncated = True
                logger.warning("GitHub tree listing for %s (%s) was truncated; some files may not appear", self.repo, self.branch)

            objs: List[RemoteObject] = []
            for entry in payload.get("tree") or []:
                if not isinstance(entry, dict) or entry.get("type") != "blob":
                    continue
                path = str(entry.get("path") or "")
                if not path:
                    continue
                objs.append(
                    RemoteObject(
                        key=path,
                        size=int(entry.get("size") or 0),
                        etag=str(entry.get("sha") or ""),
                        last_modified="",
                    )
                )
            self._tree = objs
            return objs

    def list(self, prefix: str, on_page: Optional[Callable[[int], None]] = None) -> List[RemoteObject]:
        clean_prefix = (prefix or "").lstrip("/")
        tree = self._load_tree()
        matched = [obj for obj in tree if obj.key.startswith(clean_prefix)] if clean_prefix else list(tree)
        if on_page:
            on_page(len(matched))
        return matched

    def get(self, key: str) -> bytes:
        clean_key = (key or "").lstrip("/")
        encoded = urllib.parse.quote(clean_key, safe="/")
        url = f"{self.raw_base}/{self.repo}/{urllib.parse.quote(self.branch)}/{encoded}"
        hdrs = {"Authorization": f"Bearer {self.token}"} if self.token else None
        return self._http_get(
            url,
            headers=hdrs,
            service_label="GitHub Raw",
            denied_msg=f"Access denied fetching '{clean_key}' from GitHub repo '{self.repo}'",
            rate_limit_msg=f"Rate limited fetching '{clean_key}' from GitHub Raw for '{self.repo}'",
        )


def build_transport(spec: Any, cancel_event: Optional[threading.Event] = None, **kwargs: Any) -> HubTransport:
    """Construct the appropriate HubTransport (S3Transport or GitHubTransport) from a HubSpec/dict."""
    transport_kind = (getattr(spec, "transport", None) or (spec.get("transport") if isinstance(spec, dict) else "s3") or "s3").lower()
    if transport_kind == "github":
        repo = getattr(spec, "github_repo", None) if not isinstance(spec, dict) else spec.get("github_repo")
        branch = (getattr(spec, "branch", None) if not isinstance(spec, dict) else spec.get("branch")) or "main"
        return GitHubTransport(repo=str(repo or ""), branch=str(branch), cancel_event=cancel_event, **kwargs)
    bucket = getattr(spec, "bucket", None) if not isinstance(spec, dict) else spec.get("bucket")
    return S3Transport(bucket=str(bucket or ""), cancel_event=cancel_event, **kwargs)
