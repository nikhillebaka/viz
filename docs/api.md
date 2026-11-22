# REST & Binary API Reference

All endpoints are served by `server.py`. Unless noted otherwise, hub-scoped routes accept an optional `workspace=<hub_id>` query parameter or `X-Viz-Hub` header.

## `/next/` & Multi-Hub Endpoints (`/api/next/*`)

| Endpoint | Method | Parameters | Description |
| :--- | :---: | :--- | :--- |
| `/api/next/catalog` | `GET` | None | Unified cross-hub index of hubs, semantic targets (`concept_id`), canonical places, and place hierarchies |
| `/api/next/globe` | `GET` | None | Global/US/MetroCast/EU spatial snapshot with composite activity and ensemble forecasts for the 3D Globe |
| `/api/next/briefing` | `GET` | `place` | Place-First Briefing payload (ensemble outlooks, sub-regions, CDC/Delphi/ECDC ERVISS/WHO FluNet/UKHSA/Nextstrain surveillance) |
| `/api/next/briefing/status` | `GET` | None | Cache status, row counts, latest weeks, and background refresh state for external briefing feeds |
| `/api/next/manifest` | `GET` | `workspace` | Hub manifest: targets (`is_categorical`, `horizon_offset_days`), locations, seasons, models (`has_samples`, `has_pmf`), baselines |
| `/api/next/fan` | `GET` | `target`, `season`, `location`, `v`, dim filters | Binary `VZF2` (or `VZF1`) forecast fans and observed series |
| `/api/next/trajectories` | `GET` | `target`, `season`, `location`, `date`, `models`, dim filters | Binary `VZT1` joint sample trajectories (`n_samples x n_horizons` `float32`) |
| `/api/next/pmf` | `GET` | `target`, `season`, `location`, `date`, `models`, dim filters | Categorical probability mass functions across rounds and realized categories |
| `/api/next/metrics` | `GET` | `models`, `target`, `location`, `date`, `season`, `horizons`, `weeks`, `phase`, `baseline`, `fair`, dim filters | Leaderboard rankings (`is_categorical` flag switches automatically between WIS and PMF metrics RPS/Log/Brier/Mode hit) |
| `/api/next/sample-scores` | `GET` | `models`, `target`, `location`, `date`, `season`, `horizons`, `weeks`, `phase`, `baseline`, dim filters | Sample trajectory leaderboard returning empirical CRPS, Rel. CRPS, multivariate Energy Score, and Rel. Energy Score |
| `/api/next/model-locations` | `GET` | `model`, `target`, `models`, `season`, `horizons`, `weeks`, `phase`, `baseline`, `fair`, dim filters | Per-location pairwise relative WIS & coverage matching the leaderboard scope |
| `/api/next/asof` | `GET` | `target`, `season`, `location` | As-reported point-in-time target vintages |
| `/api/next/heatmap` | `GET` | Same as `/api/heatmap` | Full-precision heatmap matrix with evaluation window support |
| `/api/next/spatial` | `GET` | Same as `/api/spatial` | Unrounded spatial layer values for choropleth / EU tile maps |
| `/api/next/surveillance` | `GET` | Same as `/api/surveillance` | Unrounded NSSP, ILINet, and FluSurv-NET context overlays |

## Core Hub, Workspace & Mutation Endpoints

| Endpoint | Method | Parameters / Body | Description |
| :--- | :---: | :--- | :--- |
| `/api/workspace` | `GET` | `hub` | Active workspace mode (`local` \| `web`), data directory, and registered hubs |
| `/api/workspace/browse` | `GET` | `path` | Browse filesystem for local hubs (`local` mode only) |
| `/api/briefing/refresh` | `POST` | JSON `{ feeds?, force? }` | Start non-blocking refresh of external surveillance/virology feeds |
| `/api/status` | `GET` | None | Active hub summary and loaded model inventory |
| `/api/metadata` | `GET` | None | Hub models, locations, targets, and available reference dates |
| `/api/forecast` | `GET` | `models`, `target`, `location`, `date` | JSON quantile predictions and ground truth observations |
| `/api/metrics` | `GET` | Same as `/api/next/metrics` | Core leaderboard scores and WIS decomposition |
| `/api/model-details` | `GET` | `model_id` | Model YAML metadata, team info, and submission history |
| `/api/spatial` | `GET` | `models`, `target`, `date`, `horizon` | Location-level values for maps |
| `/api/heatmap` | `GET` | `rows`, `cols`, `location`, `target`, `metric`, `date`, `season`, `horizon`, `model`, `models`, `sort_by`, `normalize` | Cross-sectional matrix across jurisdictions, models, dates, and horizons |
| `/api/peaks` / `/api/peak-map` | `GET` | `target`, `season`, `location`, `date`, `models` | Season peak week PMFs, peak size quantiles, and accuracy scores |
| `/api/season-curves` | `GET` | `target`, `location`, `seasons` | Season-week aligned truth curves and phases |
| `/api/ensemble/*` | `GET` / `POST` | JSON recipe / `ensemble_id` | List, preview, create, save, and delete synthetic quantile ensembles (`local` mode only for mutations) |
| `/api/cache/refresh` / `clear` | `POST` | None | Rebuild or clear Parquet evaluation caches |
| `/api/remote/hubs` / `job` / `warnings` | `GET` | `hub` | Synced remote hub status, running sync job progress, and validation warnings |
| `/api/remote/check` / `sync` / `cancel` / `remove` / `toggle` / `add` | `POST` | JSON `{ source \| hub, ... }` | Inspect, sync, cancel, toggle, add, or remove public S3/GitHub hubs |

Mutation `POST` endpoints require `Content-Type: application/json` and are restricted to `local` workspace mode (`--mode web` enforces read-only isolation).
