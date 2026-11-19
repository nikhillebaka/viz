"""
Minimal anonymous client for public Hubverse S3 buckets.
Re-exports unified transport types from `viz.remote.transports` while preserving the S3Client API.
"""

from viz.remote.transports import (
    SSL_HINT,
    RemoteObject as S3Object,
    S3Transport as S3Client,
    SyncCancelled,
    TransportError as S3Error,
    TransportNotFound as S3NotFound,
    USER_AGENT,
    validate_bucket_name,
)

__all__ = [
    "SSL_HINT",
    "S3Client",
    "S3Error",
    "S3NotFound",
    "S3Object",
    "SyncCancelled",
    "USER_AGENT",
    "validate_bucket_name",
]
