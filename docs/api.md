# REST API

The internal HTTP server provides the following endpoints:

| Endpoint | Method | Parameters | Description |
| :--- | :---: | :--- | :--- |
| `/api/status` | `GET` | None | Server status, the hub folder being served (`hub`), and loaded model inventory |
| `/api/metadata` | `GET` | None | Models, locations, targets, and available reference dates |
| `/api/forecast` | `GET` | `models`, `target`, `location`, `date` | Quantile fan predictions and ground truth observations |
| `/api/surveillance` | `GET` | `target`, `location`, `date` | Surveillance signals (NHSN, NSSP, ILINet, FluSurv-NET) |
| `/api/season-curves` | `GET` | `target`, `location`, `seasons` | Per-season truth curves aligned by season week, with pre-peak / peak / post-peak phases |
| `/api/metrics` | `GET` | `models`, `target`, `location`, `date`, `season`, `weeks`, `phase`, `baseline`, `fair` | Leaderboard scores, weekly wins, WIS decomposition, coverage, and warnings |
| `/api/model-details`| `GET` | `model_id` | Model YAML metadata, team information, and submission history |
| `/api/spatial` | `GET` | `models`, `target`, `date`, `horizon` | State-level values for choropleth mapping |
| `/api/heatmap` | `GET` | `rows`, `cols`, `location`, `target`, `metric`, `date`, `season`, `horizon`, `model`, `models`, `sort_by`, `normalize` | Cross-sectional matrix visualization across jurisdictions, models, dates, and horizons |
| `/api/ensemble/list`| `GET` | None | List registered session and persisted synthetic ensembles |
| `/api/ensemble/preview`| `POST`| Ensemble configuration JSON | Pre-flight constituent model alignment and task overlap |
| `/api/ensemble/create` | `POST`| Ensemble configuration JSON | Register new on-the-fly or persisted synthetic ensemble |
| `/api/ensemble/save`   | `POST`| `ensemble_id` | Persist synthetic ensemble recipe to `local-output/synthetic/` |
| `/api/ensemble/delete` | `POST`| `ensemble_id` | Remove synthetic ensemble from session and disk |
| `/api/cache/refresh`| `POST` | None | Rebuilds stale Parquet cache tables and drops in-memory evaluation results |
| `/api/cache/clear`  | `POST` | None | Deletes all cached Parquet tables, then rebuilds them |
| `/api/remote/hubs` | `GET` | None | Registered live hubs with sync status (no network access) |
| `/api/remote/job` | `GET` | `hub` | Progress of the running or last sync |
| `/api/remote/warnings` | `GET` | `hub` | Data-quality notes recorded during syncs |
| `/api/remote/check` | `POST` | `hub` | List the hub on S3 and summarize available seasons and upstream changes |
| `/api/remote/sync` | `POST` | `hub`, `seasons` | Start a background sync |
| `/api/remote/cancel` / `remove` / `toggle` | `POST` | `hub` (`enabled`) | Cancel a sync, delete the local copy, or show/hide a hub |
| `/api/remote/add` | `POST` | `bucket` | Validate and register another public flu hub |

Ensemble and remote `POST` endpoints require `Content-Type: application/json`; this forces a CORS preflight, so other websites open in the browser cannot trigger them. Ensemble IDs are restricted to letters, digits, `_` and `-`.
