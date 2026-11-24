"""Environment-driven configuration for hosted `--mode web` deployments."""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import tempfile
from typing import Optional, Tuple


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int, *, minimum: int = 0) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        val = int(raw.strip())
    except ValueError:
        return default
    return max(minimum, val)


def _env_float(name: str, default: float, *, minimum: float = 0.0) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        val = float(raw.strip())
    except ValueError:
        return default
    return max(minimum, val)


def _env_csv(name: str, default: Tuple[str, ...] = ()) -> Tuple[str, ...]:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    items = tuple(p.strip() for p in raw.split(",") if p.strip())
    return items or default


def _sanitize_redirect_url(raw: str) -> str:
    """Allow only safe relative paths or http(s) URLs for SSO login/logout links."""
    val = (raw or "").strip()
    if not val:
        return ""
    if val.startswith("/") and not val.startswith("//"):
        return val
    lower = val.lower()
    if lower.startswith(("https://", "http://localhost", "http://127.0.0.1")):
        return val
    return ""


@dataclass(frozen=True)
class WebConfig:
    """Validated runtime settings for hosted web mode."""

    scratch_dir: Path
    ephem_ttl_seconds: int
    ephem_max_total_bytes: int
    ephem_max_hubs_per_session: int
    max_compressed_bytes: int
    max_uncompressed_bytes: int
    max_files: int
    upload_rate_per_min: int
    max_concurrent_uploads: int
    trust_proxy_auth: bool
    auth_user_headers: Tuple[str, ...]
    auth_email_headers: Tuple[str, ...]
    auth_name_headers: Tuple[str, ...]
    sso_login_url: str
    sso_logout_url: str
    sso_label: str
    dev_user: str
    user_quota_bytes: int
    user_max_hubs: int
    user_cold_after_seconds: int
    auto_sync: bool
    sync_interval_hours: float
    briefing_refresh_hours: float
    public_hubs: Optional[Tuple[str, ...]]
    sync_seasons: Optional[Tuple[str, ...]]
    cookie_secure: str
    max_workers: int
    allowed_origins: Tuple[str, ...]

    @classmethod
    def from_env(cls, data_dir: Path) -> "WebConfig":
        """Build WebConfig from environment variables with safe production defaults."""
        scratch_raw = os.environ.get("VIZ_SCRATCH_DIR", "").strip()
        if scratch_raw:
            scratch_dir = Path(scratch_raw).expanduser().resolve()
        else:
            scratch_dir = (Path(tempfile.gettempdir()) / "viz-ephem").resolve()

        public_raw = _env_csv("VIZ_PUBLIC_HUBS")
        seasons_raw = _env_csv("VIZ_SYNC_SEASONS")
        cookie_secure_raw = os.environ.get("VIZ_COOKIE_SECURE", "auto").strip().lower()
        if cookie_secure_raw not in ("auto", "1", "0", "true", "false"):
            cookie_secure_raw = "auto"

        _ = data_dir  # reserved for future data_dir-derived defaults
        return cls(
            scratch_dir=scratch_dir,
            ephem_ttl_seconds=_env_int("VIZ_EPHEM_TTL_SECONDS", 1800, minimum=60),
            ephem_max_total_bytes=_env_int("VIZ_EPHEM_MAX_TOTAL_MB", 2048, minimum=16) * 1024 * 1024,
            ephem_max_hubs_per_session=_env_int("VIZ_EPHEM_MAX_HUBS", 2, minimum=1),
            max_compressed_bytes=_env_int("VIZ_UPLOAD_MAX_COMPRESSED_MB", 100, minimum=1) * 1024 * 1024,
            max_uncompressed_bytes=_env_int("VIZ_UPLOAD_MAX_UNCOMPRESSED_MB", 400, minimum=1) * 1024 * 1024,
            max_files=_env_int("VIZ_UPLOAD_MAX_FILES", 2500, minimum=10),
            upload_rate_per_min=_env_int("VIZ_UPLOAD_RATE_PER_MIN", 6, minimum=1),
            max_concurrent_uploads=_env_int("VIZ_UPLOAD_MAX_CONCURRENT", 3, minimum=1),
            trust_proxy_auth=_env_bool("VIZ_TRUST_PROXY_AUTH", False),
            auth_user_headers=_env_csv(
                "VIZ_AUTH_USER_HEADER",
                ("X-Auth-Request-Email", "X-Auth-Request-User", "X-Forwarded-User"),
            ),
            auth_email_headers=_env_csv(
                "VIZ_AUTH_EMAIL_HEADER",
                ("X-Auth-Request-Email", "X-Forwarded-Email"),
            ),
            auth_name_headers=_env_csv(
                "VIZ_AUTH_NAME_HEADER",
                ("X-Auth-Request-Preferred-Username", "X-Auth-Request-User"),
            ),
            sso_login_url=_sanitize_redirect_url(os.environ.get("VIZ_SSO_LOGIN_URL", "")),
            sso_logout_url=_sanitize_redirect_url(os.environ.get("VIZ_SSO_LOGOUT_URL", "")),
            sso_label=(os.environ.get("VIZ_SSO_LABEL", "Sign in").strip() or "Sign in")[:40],
            dev_user=os.environ.get("VIZ_DEV_USER", "").strip(),
            user_quota_bytes=_env_int("VIZ_USER_QUOTA_MB", 250, minimum=10) * 1024 * 1024,
            user_max_hubs=_env_int("VIZ_USER_MAX_HUBS", 5, minimum=1),
            user_cold_after_seconds=_env_int("VIZ_USER_COLD_AFTER_HOURS", 24, minimum=1) * 3600,
            auto_sync=_env_bool("VIZ_AUTO_SYNC", True),
            sync_interval_hours=_env_float("VIZ_SYNC_INTERVAL_HOURS", 6.0, minimum=0.25),
            briefing_refresh_hours=_env_float("VIZ_BRIEFING_REFRESH_HOURS", 6.0, minimum=0.25),
            public_hubs=public_raw or None,
            sync_seasons=seasons_raw or None,
            cookie_secure=cookie_secure_raw,
            max_workers=_env_int("VIZ_MAX_WORKERS", 32, minimum=4),
            allowed_origins=_env_csv("VIZ_ALLOWED_ORIGINS"),
        )
