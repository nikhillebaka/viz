# Deploying `hub.viz` in Web Mode

`viz` runs locally with `./run.sh`, or as a multi-tenant read-only public web server with `--mode web` (`VIZ_MODE=web`). Only two Python runtime dependencies are required (`polars` and `numpy`); the container installs the pinned versions in `requirements.lock`.

---

## Quick Start (Docker Compose)

```bash
cd deploy
docker compose up --build
```

Open `http://localhost:8501`. By default, `web` mode auto-syncs all built-in public Hubverse hubs in the background and exposes `/healthz`, `/readyz`, and browser whole-hub folder upload (30-minute private sessions).

To test a signed-in identity locally without a reverse proxy (`VIZ_ALLOW_DEV_USER=1` is required and is ignored whenever `VIZ_TRUST_PROXY_AUTH=1`; compose binds to `127.0.0.1` only):

```bash
VIZ_ALLOW_DEV_USER=1 VIZ_DEV_USER=researcher@umass.edu docker compose up
```

---

## UMass Unity Harmony / Kubernetes Deployment

Reference manifests live under [deploy/k8s/](../deploy/k8s/):

- [pvc.yaml](../deploy/k8s/pvc.yaml): persistent storage (`/data`) for synced public hubs, Parquet caches, briefing feeds, surveillance data, and saved user hubs.
- [deployment.yaml](../deploy/k8s/deployment.yaml): non-root (`10001:10001`), `readOnlyRootFilesystem: true`, a `4Gi` `emptyDir` scratch volume at `/tmp/viz-ephem` (above the 2 GiB temporary-upload budget, which also counts in-flight uploads), liveness (`/healthz`) and readiness (`/readyz`) probes. GHCR packages are private by default: make the package public or add the commented `imagePullSecrets`.
- [service.yaml](../deploy/k8s/service.yaml) and [ingress.yaml](../deploy/k8s/ingress.yaml): TLS, `proxy-body-size: 105m` (request buffering left on, so nginx absorbs slow uploads), the public oauth2-proxy routes, and the separate auth-gated `/auth/login` Ingress described below.
- [networkpolicy.yaml](../deploy/k8s/networkpolicy.yaml): only the ingress controller may connect to port `8501`. **Check how your controller runs before applying it** (namespace, and whether it uses `hostNetwork`); the file lists the variants, and the wrong selector blocks all traffic.
- [oauth2-proxy.example.yaml](../deploy/k8s/oauth2-proxy.example.yaml): optional sign-in (OIDC such as UMass/CILogon, or GitHub).

Multi-architecture images (`linux/amd64` + `linux/arm64`) are built by [container.yml](../.github/workflows/container.yml) after the Python and JS test suites pass. Pull requests build without pushing; only `main` and `v*` tags publish.

The scheduler (`VIZ_AUTO_SYNC=1`) also builds US surveillance data into `/data/surveillance` on first start and refreshes admissions daily and the as-of archive weekly. Set `GITHUB_TOKEN` (a read-only token) to avoid GitHub's 60 requests/hour anonymous limit on shared egress IPs.

---

## Optional Sign-in (anonymous browsing + saved hubs)

ingress-nginx `auth-url` cannot make sign-in optional: it either blocks anonymous visitors or authenticates nobody. The reference setup therefore gates exactly one path:

1. The main Ingress serves the app with no auth, plus only oauth2-proxy's `/oauth2/start`, `/oauth2/callback` and `/oauth2/sign_out`. Anyone can browse public hubs and make temporary uploads. **Never expose `/oauth2/auth` publicly:** its response carries `X-Viz-Proxy-Secret`, so a signed-in user could read the secret and forge any identity. nginx reaches it over the cluster-internal Service only.
2. A second Ingress routes only `GET /auth/login` through oauth2-proxy (`auth-url`). On success, oauth2-proxy's auth response carries the user's identity **and** `X-Viz-Proxy-Secret` (injected from the shared Secret via `injectResponseHeaders`); nginx copies them onto the request, overwriting anything the client sent.
3. The app checks the secret in constant time, then sets a signed `viz_user` cookie (HMAC-SHA256 keyed from `VIZ_PROXY_SECRET`, `HttpOnly; SameSite=Lax; Secure` over HTTPS, `VIZ_USER_SESSION_HOURS` lifetime) and redirects back. Every other path identifies the user by that cookie.
4. `/auth/logout` clears the cookie and redirects to `VIZ_SSO_LOGOUT_URL` (oauth2-proxy's `/oauth2/sign_out`).

Identity headers on any other path are ignored unless they carry the secret, which only oauth2-proxy's authenticated responses contain. No nginx `configuration-snippet` is needed (snippets are disabled by default on ingress-nginx ≥ 1.9).

Setup:

1. Create the Secrets listed at the top of `oauth2-proxy.example.yaml`. The same `hub-viz-proxy-auth/proxy-secret` value feeds both oauth2-proxy and `VIZ_PROXY_SECRET`.
2. Fill in the provider, redirect URL and `--email-domain` (with GitHub, `*` would admit every GitHub account), then apply it.
3. On the app, set `VIZ_TRUST_PROXY_AUTH=1`, `VIZ_PROXY_SECRET`, `VIZ_SSO_LOGIN_URL=/auth/login` and `VIZ_SSO_LOGOUT_URL=/oauth2/sign_out`.
4. Rotating `VIZ_PROXY_SECRET` signs everyone out (their cookies stop verifying). A removed IdP account keeps working until its `viz_user` cookie expires.

Signed-in users can save hubs under `/data/users/<sha256(id)>/`; idle hubs are packed to `archive.tar.gz` after `VIZ_USER_COLD_AFTER_HOURS` and unpacked on demand.

---

## Environment Variables (`web/config.py`)

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `VIZ_MODE` | `local` | Set `web` to lock down local filesystem routes and enable hosted features |
| `VIZ_DATA_DIR` | `.cache` | Persistent directory for synced public hubs, briefings, surveillance, and saved user hubs |
| `VIZ_SCRATCH_DIR` | `<tmp>/viz-ephem` | Scratch directory for temporary uploaded hubs |
| `VIZ_AUTO_SYNC` | `1` | Background scheduler for public hubs, briefing feeds, and surveillance data |
| `VIZ_SYNC_INTERVAL_HOURS` | `6` | Hub check/sync interval. A hub whose sync keeps failing retries with exponential backoff (15 min, doubling, capped at this interval) |
| `VIZ_BRIEFING_REFRESH_HOURS` | `6` | Briefing feed refresh interval (surveillance data refreshes on its own daily/weekly schedule) |
| `VIZ_PUBLIC_HUBS` | *(all built-in)* | Optional comma-separated subset of hub IDs to auto-sync |
| `VIZ_SYNC_SEASONS` | *(latest)* | Optional comma-separated seasons to sync on cold startup |
| `GITHUB_TOKEN` | `""` | Optional token for higher GitHub API rate limits during sync and surveillance builds |
| `VIZ_EPHEM_TTL_SECONDS` | `1800` | Sliding idle TTL for temporary uploads; the browser cookie is refreshed on use |
| `VIZ_EPHEM_MAX_TOTAL_MB` | `2048` | Temporary-upload budget, including in-flight uploads. When full, only hubs idle for 10+ minutes are reclaimed (oldest first); otherwise `507` |
| `VIZ_EPHEM_MAX_BYTES_PER_IP_MB` | `512` | Temporary-upload storage per client IP (`429` above limit) |
| `VIZ_EPHEM_MAX_HUBS` | `2` | Temporary hubs per browser session; a new upload replaces that session's oldest one, but only if the upload is accepted |
| `VIZ_UPLOAD_MAX_COMPRESSED_MB` | `100` | Maximum compressed upload size (`413` above limit) |
| `VIZ_UPLOAD_MAX_UNCOMPRESSED_MB` | `400` | Streaming decompression cap (`413` above limit) |
| `VIZ_UPLOAD_MAX_FILES` | `2500` | Maximum files per uploaded hub |
| `VIZ_UPLOAD_RATE_PER_MIN` | `6` | Per-client-IP upload rate (`429` above limit) |
| `VIZ_UPLOAD_MAX_CONCURRENT` | `3` | Simultaneous uploads being extracted |
| `VIZ_UPLOAD_MIN_KBPS` | `128` | Minimum average upload speed; the body must arrive within `max(2 min, size ÷ this rate)` or the upload fails with `408` |
| `VIZ_TRUSTED_PROXY_HOPS` | `0` | Reverse proxies that append to `X-Forwarded-For`; the client IP is taken that many hops from the right. Use `1` behind ingress-nginx (oauth2-proxy is not in the request path in the reference setup) |
| `VIZ_MAX_WORKERS` | `32` | Concurrent API requests (probes and static files are exempt) |
| `VIZ_MAX_CONCURRENT_PER_CLIENT` | `12` | Concurrent API requests per client IP (`503` + `Retry-After` above it; `0` disables) |
| `VIZ_TRUST_PROXY_AUTH` | `0` | Set `1` for optional sign-in (see above); requires `VIZ_PROXY_SECRET`, otherwise sign-in fails closed |
| `VIZ_PROXY_SECRET` | `""` | Shared secret oauth2-proxy adds to authenticated `/auth/login` requests; also keys the `viz_user` cookie signature |
| `VIZ_PROXY_SECRET_HEADER` | `X-Viz-Proxy-Secret` | Header carrying `VIZ_PROXY_SECRET` |
| `VIZ_USER_SESSION_HOURS` | `12` | Lifetime of the signed `viz_user` sign-in cookie |
| `VIZ_AUTH_USER_HEADER` | `X-Auth-Request-Email,X-Auth-Request-User` | Ordered headers read for the user id at `/auth/login` |
| `VIZ_AUTH_EMAIL_HEADER` | `X-Auth-Request-Email` | Ordered headers read for the email |
| `VIZ_AUTH_NAME_HEADER` | `X-Auth-Request-Preferred-Username,X-Auth-Request-User` | Ordered headers read for the display name |
| `VIZ_SSO_LOGIN_URL` | `""` | Sign-in link shown in the UI (`/auth/login` in the reference setup) |
| `VIZ_SSO_LOGOUT_URL` | `""` | Where `/auth/logout` sends the browser after clearing the app cookie (`/oauth2/sign_out`) |
| `VIZ_SSO_LABEL` | `Sign in` | Sign-in button label |
| `VIZ_ALLOW_DEV_USER` | `0` | Must be `1` to enable `VIZ_DEV_USER` (never honored when `VIZ_TRUST_PROXY_AUTH=1`) |
| `VIZ_DEV_USER` | `""` | Local development identity |
| `VIZ_USER_QUOTA_MB` | `250` | Saved-hub storage per user |
| `VIZ_USER_MAX_HUBS` | `5` | Saved hubs per user |
| `VIZ_USERS_MAX_TOTAL_MB` | `15360` | Saved-hub storage across all users (`507` above limit); the reference deployment sets `10240` |
| `VIZ_USER_COLD_AFTER_HOURS` | `24` | Idle time before saved hubs are compressed |
| `VIZ_MAX_PRIVATE_HUBS_LOADED` | `4` | Uploaded hubs kept loaded in memory (LRU; eviction frees memory but keeps on-disk caches). The reference deployment sets `6` for a 6Gi pod |
| `VIZ_READYZ_REQUIRE_HUB` | `0` | Set `1` to fail `/readyz` (`503`) until at least one public hub is synced |
| `VIZ_ALLOWED_ORIGINS` | `""` | Comma-separated CORS origins (empty = same-origin only) |
| `VIZ_COOKIE_SECURE` | `auto` | `auto` sets `Secure` when `X-Forwarded-Proto: https`; or force with a boolean (`1`/`0`, `true`/`false`, `yes`/`no`, `on`/`off`) |
| `VIZ_VERBOSE` | `0` | Enable HTTP access/diagnostic logs |

Boolean and integer variables are validated at startup; a malformed value stops the server with a one-line error.

---

## Upload Security Guarantees

- **Strict Hubverse allowlist:** clients filter files in-browser (`next/features/WebUpload.js`) and the server re-enforces the same allowlist (`web/bundle.py:validate_hubverse_relpath`) before touching disk. Model metadata YAML is capped at 64 KB per file.
- **No symlinks or path traversal:** absolute paths, `..`, backslashes, NUL bytes, duplicate entries, and symlinks abort extraction (`400`).
- **Streaming resource bounds:** compressed and decompressed byte counts are enforced per chunk during streaming gzip decompression, and the whole body must arrive within the `VIZ_UPLOAD_MIN_KBPS` deadline.
- **Tenant isolation:** temporary and saved hubs are bound to an `HttpOnly; SameSite=Lax` session cookie or the signed sign-in cookie, excluded from global catalogs, globes, and peer truth, and served with `Cache-Control: private, no-store`.
