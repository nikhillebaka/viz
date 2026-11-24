"""Provider-agnostic SSO proxy authentication and anonymous session cookies."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import http.cookies
import re
import secrets
from typing import Any, Dict, Mapping, Optional, Sequence

from viz.web.config import WebConfig

SESSION_COOKIE_NAME = "viz_sid"
_VALID_SID_RE = re.compile(r"^[A-Za-z0-9_-]{24,64}$")


@dataclass(frozen=True)
class AuthUser:
    """Authenticated user resolved from a trusted SSO proxy or explicit dev override."""

    user_id: str
    email: Optional[str]
    display_name: str
    user_hash: str


@dataclass(frozen=True)
class RequestIdentity:
    """Authorization identity for one HTTP request (ephemeral session cookie + optional SSO user)."""

    sid: Optional[str]
    sid_hash: str
    user: Optional[AuthUser]


def hash_identity(raw: str) -> str:
    """Derive a fixed-length, filesystem-safe identifier hash."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _header_lookup(headers: Any, names: Sequence[str]) -> Optional[str]:
    if headers is None:
        return None
    for name in names:
        val = None
        if hasattr(headers, "get"):
            val = headers.get(name)
        if val is None and isinstance(headers, Mapping):
            low = name.lower()
            for k, v in headers.items():
                if str(k).lower() == low:
                    val = v
                    break
        if isinstance(val, str):
            clean = val.strip()
            if clean:
                return clean[:200]
    return None


def resolve_request_user(headers: Any, cfg: WebConfig) -> Optional[AuthUser]:
    """
    Resolve the authenticated SSO user.

    Reverse-proxy headers are ignored unless `cfg.trust_proxy_auth` is True so unproxied
    instances cannot be spoofed with forged `X-Auth-Request-*` headers.
    """
    user_id: Optional[str] = None
    email: Optional[str] = None
    display_name: Optional[str] = None

    if cfg.trust_proxy_auth:
        user_id = _header_lookup(headers, cfg.auth_user_headers)
        email = _header_lookup(headers, cfg.auth_email_headers)
        display_name = _header_lookup(headers, cfg.auth_name_headers)

    if not user_id and cfg.dev_user:
        user_id = cfg.dev_user
        email = cfg.dev_user if "@" in cfg.dev_user else None

    if not user_id:
        return None

    clean_id = user_id.strip()
    if email and not clean_id:
        clean_id = email.strip()
    canonical = clean_id.lower()
    if not display_name:
        display_name = email.split("@", 1)[0] if email and "@" in email else clean_id

    return AuthUser(
        user_id=clean_id,
        email=email,
        display_name=display_name,
        user_hash=hash_identity(canonical),
    )


def parse_session_cookie(headers: Any) -> Optional[str]:
    """Extract and validate the anonymous upload session cookie from request headers."""
    raw_cookie = _header_lookup(headers, ("Cookie", "cookie"))
    if not raw_cookie:
        return None
    jar = http.cookies.SimpleCookie()
    try:
        jar.load(raw_cookie)
    except http.cookies.CookieError:
        return None
    morsel = jar.get(SESSION_COOKIE_NAME)
    if morsel is None:
        return None
    val = str(morsel.value or "").strip()
    return val if _VALID_SID_RE.match(val) else None


def generate_session_id() -> str:
    """Generate a high-entropy URL-safe anonymous session token (144 bits)."""
    return secrets.token_urlsafe(18)


def resolve_request_identity(headers: Any, cfg: WebConfig) -> RequestIdentity:
    """Combine ephemeral session cookie and optional SSO identity for the request."""
    sid = parse_session_cookie(headers)
    sid_hash = hash_identity(f"sid:{sid}") if sid else ""
    user = resolve_request_user(headers, cfg)
    return RequestIdentity(sid=sid, sid_hash=sid_hash, user=user)


def is_https_request(headers: Any, cfg: WebConfig) -> bool:
    """Return True if the session cookie should carry the Secure attribute."""
    if cfg.cookie_secure in ("1", "true"):
        return True
    if cfg.cookie_secure in ("0", "false"):
        return False
    proto = _header_lookup(headers, ("X-Forwarded-Proto", "X-Forwarded-Scheme"))
    return bool(proto and proto.lower().split(",", 1)[0].strip() == "https")


def make_session_cookie_header(sid: str, *, secure: bool, max_age: int) -> str:
    """Format a hardened Set-Cookie header value for `viz_sid`."""
    parts = [
        f"{SESSION_COOKIE_NAME}={sid}",
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        f"Max-Age={max(0, int(max_age))}",
    ]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def auth_public_info(user: Optional[AuthUser], cfg: WebConfig) -> Dict[str, Any]:
    """Public auth status exposed via `/api/web/status` (no internal hashes or header names)."""
    enabled = bool(
        (cfg.trust_proxy_auth and (bool(cfg.sso_login_url) or user is not None))
        or bool(cfg.dev_user)
    )
    return {
        "enabled": enabled,
        "authenticated": user is not None,
        "display_name": user.display_name if user else None,
        "email": user.email if user else None,
        "login_url": cfg.sso_login_url or None,
        "logout_url": cfg.sso_logout_url or None,
        "login_label": cfg.sso_label,
    }
