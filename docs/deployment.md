# Deploying `hub.viz` in Web Mode

`viz` runs locally with `./run.sh`, or as a multi-tenant read-only public web server with `--mode web` (`VIZ_MODE=web`). Only two Python runtime dependencies are required (`polars` and `numpy`).

---

## Quick Start (Docker Compose)

```bash
cd deploy
docker compose up --build
```

Open `http://localhost:8501`. By default, `web` mode auto-syncs all built-in public Hubverse hubs in the background and exposes `/healthz`, `/readyz`, and browser whole-hub folder upload (30-minute private sessions).

To test SSO locally without an external proxy:

```bash
VIZ_TRUST_PROXY_AUTH=1 VIZ_DEV_USER=researcher@umass.edu docker compose up
```

---

## UMass Unity Harmony / Kubernetes Deployment

Reference manifests live under [deploy/k8s/](../deploy/k8s/):

- [pvc.yaml](../deploy/k8s/pvc.yaml): Persistent storage (`/data`) for synced public hubs, Parquet caches, briefing feeds, and compressed SSO user workspaces.
- [deployment.yaml](../deploy/k8s/deployment.yaml): Non-root (`10001:10001`), `readOnlyRootFilesystem: true`, bounded `emptyDir` scratch volume at `/tmp/viz-ephem`, liveness (`/healthz`) and readiness (`/readyz`) probes.
- [service.yaml](../deploy/k8s/service.yaml) & [ingress.yaml](../deploy/k8s/ingress.yaml): `proxy-body-size: 105m` for compressed `VZB1` folder uploads and optional `oauth2-proxy` auth-request annotations.

Multi-architecture container images (`linux/amd64` + `linux/arm64` for Harmony's ARM64 nodes) are built via [container.yml](../.github/workflows/container.yml).

---

## Environment Variables (`web/config.py`)

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `VIZ_MODE` | `local` | Set `web` to lock down local filesystem routes and enable hosted features |
| `VIZ_DATA_DIR` | `.cache` | Persistent directory for synced public hubs, briefings, and SSO user archives |
| `VIZ_SCRATCH_DIR` | `<tmp>/viz-ephem` | Scratch directory for anonymous 30-minute uploaded hubs |
| `VIZ_AUTO_SYNC` | `1` | Background scheduler syncing all built-in public hubs + briefing feeds |
| `VIZ_SYNC_INTERVAL_HOURS` | `6` | Auto-sync interval in hours |
| `VIZ_PUBLIC_HUBS` | *(all built-in)* | Optional comma-separated subset of hub IDs to auto-sync |
| `VIZ_SYNC_SEASONS` | *(latest)* | Optional comma-separated seasons to sync on cold startup |
| `VIZ_EPHEM_TTL_SECONDS` | `1800` | Sliding idle TTL (seconds) for anonymous uploads (default 30 min) |
| `VIZ_EPHEM_MAX_TOTAL_MB` | `2048` | Global scratch cap with LRU eviction of oldest ephemeral sessions |
| `VIZ_EPHEM_MAX_HUBS` | `2` | Maximum concurrent ephemeral hubs per anonymous cookie |
| `VIZ_UPLOAD_MAX_COMPRESSED_MB` | `100` | Maximum compressed HTTP upload size (`413` above limit) |
| `VIZ_UPLOAD_MAX_UNCOMPRESSED_MB` | `400` | Streaming decompression zip-bomb cap (`413` above limit) |
| `VIZ_UPLOAD_MAX_FILES` | `2500` | Maximum files per uploaded hub bundle |
| `VIZ_UPLOAD_RATE_PER_MIN` | `6` | Per-IP sliding-window upload limit (`429` above limit) |
| `VIZ_UPLOAD_MAX_CONCURRENT` | `3` | Global simultaneous upload extraction cap |
| `VIZ_TRUST_PROXY_AUTH` | `0` | **Must be `1` only behind a trusted SSO proxy (`oauth2-proxy`)** so forged proxy headers are rejected |
| `VIZ_AUTH_USER_HEADER` | `X-Auth-Request-Email,X-Auth-Request-User,X-Forwarded-User` | Ordered header lookup for authenticated identity |
| `VIZ_AUTH_EMAIL_HEADER` | `X-Auth-Request-Email,X-Forwarded-Email` | Ordered header lookup for display email |
| `VIZ_SSO_LOGIN_URL` | `""` | Sign-in link shown in UI when SSO is optional (e.g. `/oauth2/start?rd=/`) |
| `VIZ_SSO_LOGOUT_URL` | `""` | Sign-out link shown when authenticated |
| `VIZ_USER_QUOTA_MB` | `250` | Per-user persistent storage quota |
| `VIZ_USER_MAX_HUBS` | `5` | Maximum saved persistent hubs per user |
| `VIZ_USER_COLD_AFTER_HOURS` | `24` | Idle time before persistent hubs are compressed to `archive.tar.gz` |
| `VIZ_MAX_WORKERS` | `32` | Bounded HTTP worker thread pool size |
| `VIZ_ALLOWED_ORIGINS` | `""` | Comma-separated CORS origins in web mode (empty = same-origin only) |
| `VIZ_COOKIE_SECURE` | `auto` | Set `Secure` cookie flag automatically when `X-Forwarded-Proto: https` |
| `VIZ_VERBOSE` | `0` | Enable HTTP access/diagnostic logs when set to `1` |

---

## Provider-Agnostic SSO (UMass + GitHub)

Deploy an [`oauth2-proxy`](https://oauth2-proxy.github.io/oauth2-proxy/) sidecar or ingress auth provider configured for OIDC (UMass / CILogon) or GitHub OAuth (with `--provider=oidc` or `--provider=github`). When `oauth2-proxy` passes `X-Auth-Request-Email` / `X-Auth-Request-User` through ingress and `VIZ_TRUST_PROXY_AUTH=1` is set:

- Anonymous visitors can inspect public hubs and upload temporary 30-minute private hubs without signing in.
- Signed-in users can also save compressed hubs persistently under `/data/users/<sha256(id)>/`, automatically packed to `archive.tar.gz` after 24 hours idle and unpacked on demand when they return.

---

## Upload Security Guarantees

- **Strict Hubverse allowlist:** Clients filter files in-browser (`next/features/WebUpload.js`) and the server re-enforces the exact same allowlist (`web/bundle.py:validate_hubverse_relpath`) before touching disk—only Hubverse config JSON, YAML/JSON metadata, forecast CSV/Parquet, truth CSV/Parquet, and auxiliary CSV/JSON/Parquet paths are accepted.
- **No symlinks or path traversal:** Absolute paths, `..`, backslashes, NUL bytes, duplicate entries, and symlinks abort extraction (`400`).
- **Streaming resource bounds:** Compressed and decompressed byte counts are enforced per 64 KiB chunk during streaming gzip decompression so compression bombs never buffer in RAM.
- **Tenant isolation:** Ephemeral (`ephem_*`) and saved (`user_*`) hubs are bound to cryptographic `HttpOnly; SameSite=Lax` session cookies or trusted SSO user hashes, checked in constant time, excluded from global catalogs/globes/peer-truth, and served with `Cache-Control: private, no-store`.
