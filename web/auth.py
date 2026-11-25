"""Provider-agnostic SSO proxy authentication and anonymous session cookies."""

from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
import hmac
import json
import logging
import re
import secrets
import time
from typing import Any, Dict, List, Mapping, Optional, Sequence

from viz.web.config import WebConfig

logger = logging.getLogger("viz.web.auth")

SESSION_COOKIE_NAME = "viz_sid"
# Signed sign-in session, minted only by `/auth/login` (the one path placed behind oauth2-proxy).
USER_COOKIE_NAME = "viz_user"
_USER_COOKIE_MAX_LEN = 2048
_VALID_SID_RE = re.compile(r"^[A-Za-z0-9_-]{24,64}$")
_WARNED_FLAGS = set()


def _warn_once(key: str, msg: str) -> None:
    if key not in _WARNED_FLAGS:
        _WARNED_FLAGS.add(key)
        logger.warning(msg)


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

    Reverse-proxy headers are ignored unless BOTH `cfg.trust_proxy_auth` is True AND the
    shared `cfg.proxy_secret` header matches in constant time, preventing header spoofing.
    """
    header_user = resolve_proxy_header_user(headers, cfg)
    if header_user is not None:
        return header_user
    cookie_user = parse_user_cookie(headers, cfg)
    if cookie_user is not None:
        return cookie_user

    user_id: Optional[str] = None
    email: Optional[str] = None
    display_name: Optional[str] = None

    if cfg.dev_user:
        if cfg.allow_dev_user and not cfg.trust_proxy_auth:
            user_id = cfg.dev_user
            email = cfg.dev_user if "@" in cfg.dev_user else None
        else:
            _warn_once(
                "ignored_dev_user",
                "VIZ_DEV_USER is ignored in web mode unless VIZ_ALLOW_DEV_USER=1 and VIZ_TRUST_PROXY_AUTH=0.",
            )

    if not user_id:
        return None
    return _make_user(user_id, email, display_name)


def _make_user(user_id: str, email: Optional[str], display_name: Optional[str]) -> AuthUser:
    clean_id = (user_id or "").strip()
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


def resolve_proxy_header_user(headers: Any, cfg: WebConfig) -> Optional[AuthUser]:
    """
    Identity asserted by the trusted SSO proxy via request headers.

    Honoured only when `VIZ_TRUST_PROXY_AUTH=1` AND the shared proxy secret header matches in
    constant time. In the reference deployment oauth2-proxy adds that secret only to requests it has
    authenticated (`/auth/login`), so forged identity headers on any other path are ignored.
    """
    if not cfg.trust_proxy_auth:
        return None
    if not cfg.proxy_secret:
        _warn_once(
            "missing_proxy_secret",
            "VIZ_TRUST_PROXY_AUTH=1 is set without VIZ_PROXY_SECRET; failing closed and ignoring proxy auth headers.",
        )
        return None
    supplied_secret = _header_lookup(headers, (cfg.proxy_secret_header,))
    if not supplied_secret or not hmac.compare_digest(supplied_secret, cfg.proxy_secret):
        return None
    user_id = _header_lookup(headers, cfg.auth_user_headers)
    email = _header_lookup(headers, cfg.auth_email_headers)
    if not user_id and not email:
        return None
    return _make_user(user_id or email or "", email, _header_lookup(headers, cfg.auth_name_headers))


def _user_cookie_key(cfg: WebConfig) -> Optional[bytes]:
    if not (cfg.trust_proxy_auth and cfg.proxy_secret):
        return None
    return hmac.new(cfg.proxy_secret.encode("utf-8"), b"viz-user-cookie-v1", hashlib.sha256).digest()


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def make_user_cookie_value(user: AuthUser, cfg: WebConfig, *, now: Optional[float] = None) -> Optional[str]:
    """Signed, expiring `viz_user` value (HMAC-SHA256 keyed from VIZ_PROXY_SECRET)."""
    key = _user_cookie_key(cfg)
    if key is None:
        return None
    exp = int((time.time() if now is None else now) + cfg.user_session_seconds)

    def _encode(name: str) -> str:
        payload = json.dumps(
            {"u": user.user_id, "e": user.email, "n": name, "x": exp},
            separators=(",", ":"),
            sort_keys=True,
            ensure_ascii=False,
        ).encode("utf-8")
        body = _b64e(payload)
        sig = _b64e(hmac.new(key, body.encode("ascii"), hashlib.sha256).digest())
        return f"{body}.{sig}"

    tok = _encode(user.display_name)
    if len(tok) <= _USER_COOKIE_MAX_LEN:
        return tok
    trimmed = user.display_name
    while trimmed and len(tok) > _USER_COOKIE_MAX_LEN:
        trimmed = trimmed[: max(0, len(trimmed) - max(8, (len(tok) - _USER_COOKIE_MAX_LEN) // 2))]
        tok = _encode(trimmed)
    return tok if len(tok) <= _USER_COOKIE_MAX_LEN else None


def parse_user_cookie(headers: Any, cfg: WebConfig, *, now: Optional[float] = None) -> Optional[AuthUser]:
    """Verify the signed `viz_user` cookie; returns None if absent, tampered, or expired."""
    key = _user_cookie_key(cfg)
    if key is None:
        return None
    raw = _cookie_value(headers, USER_COOKIE_NAME)
    if not raw or len(raw) > _USER_COOKIE_MAX_LEN or raw.count(".") != 1:
        return None
    body, sig = raw.split(".", 1)
    if not body.isascii() or not sig.isascii():
        return None
    expected = _b64e(hmac.new(key, body.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        data = json.loads(_b64d(body))
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        exp = int(data.get("x") or 0)
    except (TypeError, ValueError):
        return None
    if exp <= (time.time() if now is None else now):
        return None
    user_id = str(data.get("u") or "").strip()
    email = data.get("e") if isinstance(data.get("e"), str) else None
    name = data.get("n") if isinstance(data.get("n"), str) else None
    if not user_id and not email:
        return None
    return _make_user(user_id or email or "", email, name)


def make_user_cookie_header(value: str, *, secure: bool, max_age: int) -> str:
    """Set-Cookie header for the signed sign-in session (empty value + Max-Age=0 clears it)."""
    parts = [f"{USER_COOKIE_NAME}={value}", "Path=/", "HttpOnly", "SameSite=Lax", f"Max-Age={max(0, int(max_age))}"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def safe_local_redirect(raw: Optional[str], default: str = "/next/") -> str:
    """Only same-origin absolute paths (no scheme, host, `//`, backslashes, or control characters)."""
    val = (raw or "").strip()
    if (
        not val.startswith("/")
        or val.startswith("//")
        or "\\" in val
        or any(ord(c) < 32 or ord(c) == 127 for c in val)
        or len(val) > 512
    ):
        return default
    return val


def _cookie_headers(headers: Any) -> List[str]:
    if headers is None:
        return []
    if hasattr(headers, "get_all"):
        vals = headers.get_all("Cookie")
        if vals:
            return [str(v) for v in vals if v]
    if hasattr(headers, "items"):
        vals = [str(v) for k, v in headers.items() if isinstance(k, str) and k.lower() == "cookie" and v]
        if vals:
            return vals
    if hasattr(headers, "get"):
        v = headers.get("Cookie") or headers.get("cookie")
        if v:
            return [str(v)]
    return []


def _cookie_value(headers: Any, name: str) -> Optional[str]:
    for raw_cookie in _cookie_headers(headers):
        for part in raw_cookie.split(";"):
            item = part.strip()
            if not item or "=" not in item:
                continue
            k, v = item.split("=", 1)
            if k.strip() != name:
                continue
            val = v.strip()
            if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
                val = val[1:-1]
            if val:
                return val
    return None


def parse_session_cookie(headers: Any) -> Optional[str]:
    """Extract and validate the anonymous upload session cookie from request headers."""
    val = _cookie_value(headers, SESSION_COOKIE_NAME)
    return val if val and _VALID_SID_RE.match(val) else None


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
    dev_enabled = bool(cfg.dev_user and cfg.allow_dev_user and not cfg.trust_proxy_auth)
    proxy_enabled = bool(cfg.trust_proxy_auth and cfg.proxy_secret and (bool(cfg.sso_login_url) or user is not None))
    enabled = proxy_enabled or dev_enabled
    return {
        "enabled": enabled,
        "authenticated": user is not None,
        "display_name": user.display_name if user else None,
        "email": user.email if user else None,
        "login_url": cfg.sso_login_url or None,
        "logout_url": ("/auth/logout" if (user is not None and _user_cookie_key(cfg) is not None) else (cfg.sso_logout_url or None)),
        "login_label": cfg.sso_label,
    }
