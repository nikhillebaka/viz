"""
Minimal anonymous client for public Hubverse S3 buckets.
Standard library only (urllib + ElementTree): no boto3 or AWS credentials required.
"""

from dataclasses import dataclass
import re
import socket
import ssl
import threading
import time
from typing import Callable, List, Optional
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

USER_AGENT = "FluSight-Sandbox-Viz/2.0"
_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"
_BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")

SSL_HINT = (
    "SSL certificate verification failed. On macOS with a python.org Python install, run "
    "'Install Certificates.command' from the Python application folder, then retry."
)


class S3Error(Exception):
    """Raised for any network, permission, or protocol failure talking to S3."""


class S3NotFound(S3Error):
    """Raised when an object does not exist (HTTP 404)."""


class SyncCancelled(Exception):
    """Raised inside a sync when the user cancels it."""


@dataclass(frozen=True)
class S3Object:
    key: str
    size: int
    etag: str
    last_modified: str  # ISO 8601 UTC, e.g. 2026-10-15T00:49:39.000Z


def validate_bucket_name(name: str) -> str:
    """Normalize and validate an S3 bucket name. Only bare bucket names are accepted, never URLs."""
    clean = (name or "").strip()
    if clean.lower().startswith("s3://"):
        clean = clean[5:]
    clean = clean.strip("/")
    if not _BUCKET_RE.match(clean) or ".." in clean or "/" in clean:
        raise ValueError(f"'{name}' is not a valid S3 bucket name")
    return clean


class S3Client:
    """Anonymous, read-only access to one public bucket with retries and exponential backoff."""

    def __init__(self, bucket: str, timeout: float = 30.0, retries: int = 4,
                 cancel_event: Optional[threading.Event] = None):
        self.bucket = validate_bucket_name(bucket)
        # Dotted bucket names break virtual-host TLS certificates, so fall back to path-style URLs
        if "." in self.bucket:
            self.base_url = f"https://s3.amazonaws.com/{self.bucket}"
        else:
            self.base_url = f"https://{self.bucket}.s3.amazonaws.com"
        self.timeout = timeout
        self.retries = retries
        self.cancel_event = cancel_event

    def _check_cancel(self):
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise SyncCancelled()

    def _fetch(self, url: str) -> bytes:
        delay = 0.5
        for attempt in range(self.retries + 1):
            self._check_cancel()
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return resp.read()
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    raise S3NotFound(f"Not found: {url}") from exc
                if exc.code == 403:
                    raise S3Error(f"Access denied for bucket '{self.bucket}' (it may not exist or is not public)") from exc
                if exc.code in (500, 502, 503, 504) and attempt < self.retries:
                    time.sleep(delay)
                    delay *= 2
                    continue
                raise S3Error(f"HTTP {exc.code} from S3 for {url}") from exc
            except urllib.error.URLError as exc:
                reason = exc.reason
                if isinstance(reason, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(reason):
                    raise S3Error(SSL_HINT) from exc
                if attempt < self.retries:
                    time.sleep(delay)
                    delay *= 2
                    continue
                raise S3Error(f"Network error reaching S3: {reason}") from exc
            except (TimeoutError, socket.timeout) as exc:
                if attempt < self.retries:
                    time.sleep(delay)
                    delay *= 2
                    continue
                raise S3Error(f"Timed out reaching S3 ({url})") from exc
        raise S3Error(f"Failed to fetch {url}")

    def get(self, key: str) -> bytes:
        """Download one object."""
        return self._fetch(f"{self.base_url}/{urllib.parse.quote(key)}")

    def list(self, prefix: str, on_page: Optional[Callable[[int], None]] = None) -> List[S3Object]:
        """List every object under a prefix (ListObjectsV2, paginated). Directory markers are skipped."""
        objects: List[S3Object] = []
        token: Optional[str] = None
        while True:
            params = {"list-type": "2", "prefix": prefix}
            if token:
                params["continuation-token"] = token
            body = self._fetch(f"{self.base_url}/?{urllib.parse.urlencode(params)}")
            try:
                root = ET.fromstring(body)
            except ET.ParseError as exc:
                raise S3Error(f"Unexpected S3 listing response for '{prefix}'") from exc
            for c in root.findall(f"{_NS}Contents"):
                key = c.findtext(f"{_NS}Key") or ""
                if not key or key.endswith("/"):
                    continue
                objects.append(S3Object(
                    key=key,
                    size=int(c.findtext(f"{_NS}Size") or 0),
                    etag=(c.findtext(f"{_NS}ETag") or "").strip('"'),
                    last_modified=c.findtext(f"{_NS}LastModified") or "",
                ))
            if on_page:
                on_page(len(objects))
            if (root.findtext(f"{_NS}IsTruncated") or "false").lower() == "true":
                token = root.findtext(f"{_NS}NextContinuationToken")
                if not token:
                    break
            else:
                break
        return objects
