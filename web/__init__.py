"""Web-mode hosting support for hub.viz (config, SSO proxy auth, VZB1 uploads, sessions, auto-sync)."""

from viz.web.auth import AuthUser, RequestIdentity, parse_session_cookie, resolve_request_user
from viz.web.bundle import (
    UploadIncompatibleError,
    UploadRateLimiter,
    UploadTooLargeError,
    UploadValidationError,
    extract_vzb1_stream,
    validate_extracted_hub,
    validate_hubverse_relpath,
)
from viz.web.config import WebConfig
from viz.web.scheduler import WebSyncScheduler
from viz.web.sessions import WebWorkspaceStore

__all__ = [
    "AuthUser",
    "RequestIdentity",
    "UploadIncompatibleError",
    "UploadRateLimiter",
    "UploadTooLargeError",
    "UploadValidationError",
    "WebConfig",
    "WebSyncScheduler",
    "WebWorkspaceStore",
    "extract_vzb1_stream",
    "parse_session_cookie",
    "resolve_request_user",
    "validate_extracted_hub",
    "validate_hubverse_relpath",
]
