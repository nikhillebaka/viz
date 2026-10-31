# FluSight Sandbox — Visualization & Evaluation Suite

A local visualization dashboard and evaluation tool for infectious disease forecasting hubs adhering to Hubverse and CDC FluSight standards.

---

## 1. Quick Start

### Installation
Install the required Python dependencies:
```bash
pip install -r viz/requirements.txt
```
*(Dependencies: `polars`, `numpy`, `pyarrow`, `pyyaml`)*

### Starting the Web Dashboard
From the repository root:

**macOS / Linux:**
```bash
./viz/run.sh
```

**Windows (Command Prompt or PowerShell):**
```cmd
.\viz\run.bat
```

To specify a custom port or host:
```bash
# macOS / Linux
./viz/run.sh 8501 127.0.0.1

# Windows
.\viz\run.bat 8501 127.0.0.1
```

Open **[http://127.0.0.1:8501](http://127.0.0.1:8501)** in your browser.

*Note: `run.sh` and `run.bat` automatically check for active Python virtual environments (`VIRTUAL_ENV`, `.venv`, `venv`, `env`) before falling back to system `python`.*

### Scoring Models from the Terminal
```bash
python3 viz/score_cli.py --models all --season 2024-2025 --location states
```

---

## 2. Repository Layout & Integration

When placed in a forecasting repository, the suite reads from standard Hubverse directories:

```text
your-repo/
├── viz/                          # The visualization suite
├── model-output/                 # Forecast files: <model_id>/<date>-<model_id>.csv (or .parquet)
├── local-output/                 # (Optional) Local uncommitted model runs
├── target-data/                  # Ground truth: oracle-output.parquet (or .csv)
├── auxiliary-data/               # (Optional) locations.csv (FIPS, names, populations)
├── hub-config/                   # (Optional) tasks.json (rounds, targets, horizons)
└── model-metadata/               # (Optional) <model_id>.yml metadata schemas
```

### Staging Local Experiments (`local-output/`)
Uncommitted model runs can be placed in `local-output/<model_id>/<date>-<model_id>.csv`. The suite tags them as `[LOCAL]` and scores them side-by-side with Git-tracked `[REPO]` models in `model-output/`.

Recommended `.gitignore` additions:
```gitignore
local-output/
viz/.cache/
```

### Live Hub Data (CDC FluSight on S3)

Click **FluSight Sandbox** in the top-left corner to open the data-sources menu. From there you can copy live forecasts from the public [CDC FluSight hub](https://github.com/cdcepi/FluSight-forecast-hub) S3 mirror (`cdcepi-flusight-forecast-hub`) and compare them with your own models.

- **Nothing is downloaded until you press Sync.** Opening the Live Hub Data dialog only lists the hub, so you can see what is available per season. The default selection is the current season, which is a few MB.
- **Syncs are incremental.** Only files whose S3 ETag or size changed are fetched. Upstream deletions are mirrored, and resubmissions are recorded as revisions. Use *Check for new forecasts* in the menu to see what changed upstream.
- **Each file is validated before it is stored.** Schema drift (e.g. `int64` vs `int32` horizons, `date32` dates) is normalized and only quantile rows are kept. Crossing quantiles, negative counts, unknown locations, duplicate rows, and mismatched `model_id`s are reported under *Data quality*. Unreadable files are skipped, never partially loaded.
- **Hub models are namespaced** (e.g. `flusight:UMass-flusion`), so they never collide with repository models of the same name. In the model bar they live in their own collapsible row with *This round* and *Designated only* filters.
- **Truth uses the newest available source (Auto).** The hub's `oracle-output`, admissions series, and newer as-of snapshots are merged with the repository's truth. For every observation the newest vintage wins and older sources only fill gaps. Each week appears exactly once, so charts, indicators, and scores stay continuous across seasons. Rounds whose target weeks have not been observed yet are marked *Pending truth* on the leaderboard.
- **Viz only supports flu hubs for now.** *Connect another hub…* accepts any public Hubverse bucket. Hubs with non-flu targets (e.g. COVID-19, RSV) or non-state locations (e.g. city-level hubs) are rejected with a warning.
- **Copies live in `viz/.cache/remote/`.** Hide a hub from the menu (its data stays on disk), or use *Remove local copy* to delete it. **The CLI (`score_cli.py`) ignores hub data and scores repository models only.**

---

## 3. Headless CLI (`score_cli.py`)

`score_cli.py` computes evaluation metrics directly from the terminal and can export results to tables, CSV, JSON, or Parquet.

### Common Examples

```bash
# Evaluate specific models for a reference date across all states
python3 viz/score_cli.py --models UMass-flusion_spatial2_prod,UMass-AR6_pooled --date 2024-01-13 --location states

# Evaluate models strictly on common shared tasks (fair comparison)
python3 viz/score_cli.py --models UMass-gbqr_4src,UMass-gbqr_1src --season 2024-2025 --location states --fair

# Export rankings to JSON or CSV
python3 viz/score_cli.py --models all --season 2024-2025 --location US --format json --out scores.json
python3 viz/score_cli.py --models all --season 2024-2025 --location US --format csv --out scores.csv

# Score only each state's peak weeks across three seasons, within mid-November to early February
python3 viz/score_cli.py --models all --season 2023-2024,2024-2025,2025-2026 --location states --phase peak --weeks 16-28

# Export full disaggregated task-level scores (location × date × horizon)
python3 viz/score_cli.py --models UMass-flusion_spatial2_prod,FluSight-baseline --season 2024-2025 --export-tasks tasks.parquet
```

### CLI Arguments

| Flag | Default | Description |
| :--- | :---: | :--- |
| `--models` | *Required* | Comma-separated model IDs, or `'all'` |
| `--target` | Hub default | Target variable name (defaults to hub config or incidence target) |
| `--location` | `'all'` | `'all'`, `'states'`, `'US'`, or a specific two-digit FIPS code |
| `--date` | `'all'` | Reference date (`YYYY-MM-DD`) or `'all'` |
| `--season` | `''` | Specific season (`'2024-2025'`), comma-separated list, `'current'`, or `'all'` |
| `--baseline` | Hub default | Baseline model ID for relative comparisons |
| `--weeks` | `''` | Only score forecasts of season weeks in this range, e.g. `16-28` (season week 1 = MMWR week 31, early August) |
| `--phase` | `''` | Only score forecasts of `pre`-peak, `peak`, or `post`-peak weeks, judged per location from its own truth curve |
| `--fair` | `False` | Restrict evaluation strictly to common shared tasks |
| `--format` | `'table'` | Output format: `table`, `csv`, or `json` |
| `--out` | `None` | Output file path for summary results |
| `--export-tasks` | `None` | File path to export disaggregated task-level scores (`.csv` or `.parquet`), using the same locations, dates, and common tasks as the summary |

### Example Output

```text
==============================================================================================================
  FORECAST EVALUATION REPORT
  Target: wk inc flu hosp | Location Filter: states | Date Filter: 2024-01-13 | Common Tasks: False
  Reference Baseline: FluSight-baseline (Pairwise Tournament Rel WIS: 1.0 = baseline, <1.0 = better)
==============================================================================================================
Model Name                     Type     WIS       Rel WIS   Δ% Base    WIS/100k   MAE      Cov95%   Sharp   
--------------------------------------------------------------------------------------------------------------
UMass-flusion_spatial2_prod    [REPO]   31.70     0.359     -64.1%     0.58       44.23    98.6%    423.1   
UMass-AR6_pooled               [REPO]   59.76     0.677     -32.3%     1.14       96.95    91.3%    429.6   
FluSight-baseline              [REPO]   88.26     1.000     0.0%       1.50       119.46   67.8%    299.8   
==============================================================================================================
Lower WIS/MAE = Better. Rel WIS: Hubverse tournament standard (<1.0 is better than baseline).
Cov95 target = 95.0%. Lower Sharpness = Tighter intervals. Rate WIS = per 100,000 population.
```

---

## 4. Surveillance Data Management (`rebuild_surveillance.py`)

The visualizer supports four surveillance data streams:
1. **Hospital Admissions (NHSN)**: Weekly laboratory-confirmed influenza admissions (`wk inc flu hosp`).
2. **Emergency Department Visits (NSSP)**: Weekly percentage of emergency department visits with diagnosed influenza.
3. **Outpatient ILI (ILINet)**: Historical scaled ILI+ signal ($w\text{ILI} \times \%\text{ positive}$, 2010–2023).
4. **Hospitalization Rates (FluSurv-NET)**: Population-based laboratory-confirmed admission rates per 100,000 (2010–2023).

### Commands

```bash
# Check surveillance data freshness and record counts
python3 viz/rebuild_surveillance.py --check-freshness

# Update from upstream or re-synthesize from local target-data/oracle-output
python3 viz/rebuild_surveillance.py --force
```

If upstream network access is unavailable, the script automatically synthesizes admissions from local `target-data/oracle-output.csv`.

**After a fresh clone, run `python3 viz/rebuild_surveillance.py --force` once.** Only `data/surveillance/ilinet.csv` and `flusurvnet.csv` are committed, because they hold the 2010–2023 history the script cannot recreate. The admissions files and `as-of-hospital-admissions.parquet` are git-ignored and rebuilt by the script.

### Where this repo lives

`viz/` assumes its parent folder is a Hubverse hub checkout (it reads `model-output/`, `target-data/`, etc. from `Path(__file__).resolve().parent.parent`). Clone it into the hub as `<hub>/viz/`, and add `viz/` to that hub's `.git/info/exclude`.

The dashboard never downloads surveillance data while serving requests: if a bundled file is missing, the affected stream is simply unavailable and the server log points to this script.

---

## 5. Evaluation Metrics Summary

The scoring engine implements standard Hubverse evaluation rules:

- **Weighted Interval Score (WIS)**: Evaluates probabilistic forecasts across standard quantiles. Decomposes into Sharpness (interval width), Overprediction penalty, and Underprediction penalty (Bracher et al., 2021).
- **Log-Scale Scoring (`ln(y + 1)`)**: In addition to natural count scale scoring, the Leaderboard and Evaluation Engine provide log-scale scoring using $y_{\log} = \ln(\max(y, 0) + 1)$ and $\hat{y}_{\log} = \ln(\max(q, 0) + 1)$. This harmonizes evaluation across high- and low-incidence jurisdictions, computing log WIS, log MAE, and pairwise tournament Relative WIS on the transformed scale (Bosse et al., 2023). Users can seamlessly toggle between Natural and Log scales via the Leaderboard toolbar.
- **Pairwise Tournament Relative WIS**: Geometric mean of pairwise mean WIS ratios across models, normalized to 1.0 for the baseline (Cramer et al., 2022). Values $< 1.0$ indicate performance better than baseline. Evaluated independently on both natural and log scales. Rankings are ordered by relative WIS, which stays comparable when models cover different task sets. If the configured baseline has no forecasts in scope, scores are scaled to a fallback model, which is reported as the baseline and flagged in the validation warnings.
- **State vs. National Pooling**: National counts are orders of magnitude larger than state counts, so whenever a scope contains states (e.g. `--location all`), every leaderboard score (WIS, relative WIS, Δ%, coverage) is computed on the state pool only. The national score is reported separately (`us_wis`).
- **Mean Absolute Error (MAE)**: Absolute error of the predictive median ($q_{0.50}$) against observed truth (computed on both natural and log scales).
- **Prediction Interval Coverage**: Percentage of observations falling inside nominal intervals (95% interval $[q_{0.025}, q_{0.975}]$ and 50% interval $[q_{0.25}, q_{0.75}]$).
- **Population-Standardized Rate WIS**: Standardizes WIS per 100,000 population ($(\text{WIS} / \text{Population}) \times 100{,}000$) to enable balanced geographic comparisons. Not reported for targets that are already rates or proportions (`is_rate`, e.g. `wk inc flu prop ed visits`).
- **Evaluation Window (Leaderboard TIME → Season ▾)**: Toggle between a single **Date** and a **Season** window. The window menu combines any set of seasons, a week range dragged across a mini chart of the season curves (for the selected location, or the national curve when *All States* is selected), and a phase preset. The window applies to the forecast (target) week. **Phases** come from each location's own truth curve: *peak* is the contiguous run of weeks around the season maximum at ≥ 60% of it, and *pre-peak* / *post-peak* are the weeks before and after. Seasons that have not peaked yet count as pre-peak. With *All States*, every state is scored on its own phases rather than the national peak.
- **Wins (weeks ranked #1)**: For each round in scope, the model with the lowest mean WIS on the tasks every selected model forecast that week wins it (ties count for each tied model). Shown as `won/competed`. It complements relative WIS: a model can lead on total WIS through a few large weeks while rarely being the best week to week. Wins depend on which models are selected.
- **Common Tasks (`--fair`)**: Restricts evaluation strictly to the intersection of tasks ($reference\_date \times location \times horizon$) where all evaluated models submitted forecasts.
- **Nowcast Horizon ($h=0$)**: Due to weekly reporting schedules, the week ending on the reference date is evaluated as an operational nowcast.
- **As-of Surveillance Reports (Point-in-Time Data Cutoff)**: Real-time surveillance data streams display as-of reports capped at the forecast submission data cutoff date (`target_end_date < reference_date`), reflecting the exact state of knowledge available to modelers when forecasts were submitted.
- **HHS Region Visual Grouping**: In the Heatmap cross-sectional view, sorting jurisdictions by HHS Region delineates jurisdictions into distinct regional clusters (Regions 1 through 10) bounded by clean divider lines and labeled on the margin with their geographic names (e.g., "Region 1 (New England)") rather than appending repetitive codes to jurisdiction names.
- **Synthetic Ensemble Studio & Vincentization**: Interactive quantile ensemble builder supporting median and mean Vincentization across selected constituent models. Includes strict quantile monotonicity enforcement (rearrangement) to eliminate crossing quantiles, and operational spatial routing (separate constituent pools for states vs. US national) matching Hubverse production standards. Each task pools one consistent member set: under the *flexible* policy a task uses the members that forecast it (restricted to quantile levels all of them submitted); under the *strict* policy tasks missing any member are dropped. Ensembles can be audited via pre-flight checks, evaluated in the Leaderboard, and persisted to `local-output/synthetic/`.

*For full mathematical definitions, derivations, and wave tracking principles, refer to the in-app **Methodology** modal.*

---

## 6. Configuration (`viz/config.json`)

Settings can be customized via `viz/config.json` (or `viz/config.toml`):

```json
{
  "default_target": "wk inc flu hosp",
  "targets": [
    "wk inc flu hosp",
    "wk flu hosp rate change"
  ],
  "default_baseline": "FluSight-baseline",
  "recommended_models": [
    "UMass-flusion_spatial2_prod",
    "FluSight-baseline"
  ],
  "port": 8501,
  "host": "127.0.0.1",
  "allowed_origins": [
    "http://127.0.0.1:8501",
    "http://localhost:8501"
  ],
  "target_metadata": {
    "wk inc flu hosp": {
      "display_name": "Incident Flu Admissions",
      "unit": "Patients / Wk",
      "is_rate": false,
      "is_categorical": false,
      "non_negative": true
    }
  }
}
```

`target_metadata.<target>.non_negative` also controls scoring: negative forecast values are clipped to 0 before scoring non-negative targets.

*Note: For security on shared multi-user environments, keep `host` bound to `127.0.0.1`.*

---

## 7. REST API Endpoints

The internal HTTP server provides the following endpoints:

| Endpoint | Method | Parameters | Description |
| :--- | :---: | :--- | :--- |
| `/api/status` | `GET` | None | Server status and loaded model inventory |
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

---

## 8. Automated Tests

Run the test suite with `pytest`:
```bash
PYTHONPATH=. pytest viz/tests -v
```

Or using the standard library `unittest`:
```bash
PYTHONPATH=. python3 -m unittest discover viz/tests
```

### Test Files
- `test_metrics.py`: WIS calculation, exact 3-part decomposition, tournament relative WIS, and quantile deduplication.
- `test_evaluation.py`: Multi-model evaluation pipeline, date/season aggregations, and caching.
- `test_cli_parity.py`: Verifies numerical parity between `score_cli.py` and `/api/metrics`.
- `test_server.py`: HTTP endpoint routing, CORS handling, and cache refresh controls.
- `test_cache_manager.py`: Columnar Parquet cache generation, mtime freshness, and concurrency locks.
- `test_heatmap.py`: Heatmap matrix generation, direct ROWS/COLS cross-sections, LOC/TIME scopes, sorting, normalizations, and `/api/heatmap` API parity.
- `test_synthetic_ensemble.py`: Quantile Vincentization (median and mean), monotonicity enforcement (rearrangement), spatial split routing, preview auditing, and recipe persistence.
- `test_surveillance_rebuild.py`: Surveillance schema validation and fallback synthesis.
- `test_validation_warnings.py`: Checks for empty files, missing columns, and data anomalies.
- `test_regressions.py`: Small, self-contained fixture tests (no repository data) for scoring edge cases, ensemble safety and caching, heatmap metrics, and export scope.
- `test_eval_window.py`: Per-location season phases (including seasons that have not peaked yet), week-range and phase scoping of scores and task exports, and weekly wins.
- `test_remote_hubs.py`: Live hub sync against a local fake S3 server. Covers the flu-only compatibility check, schema-drift normalization, truth merging, incremental sync (revisions and deletions), skipping corrupt files, and keeping hub data out of the CLI.

---

## 9. File Layout

```text
viz/
├── server.py              # HTTP server and REST API request handler
├── evaluation.py          # Evaluation engine, scoring aggregations, and tournament scaling
├── metrics.py             # Vectorized scoring functions (WIS, MAE, coverage, decomposition)
├── synthetic_ensemble.py  # Quantile Vincentization and custom ensemble synthesis
├── data_loader.py         # Forecast and surveillance data ingestion
├── cache_manager.py       # Columnar Parquet cache manager with mtime invalidation
├── config.py              # Configuration loader with Hubverse auto-discovery
├── score_cli.py           # Headless command-line evaluation tool
├── rebuild_surveillance.py# Surveillance data management and oracle synchronization
├── remote/                # Live hub data: S3 client, flu-hub checks, normalization, sync engine
├── run.bat                # Windows launcher batch script
├── run.sh                 # macOS / Linux launcher shell script
├── requirements.txt       # Dependencies (polars, pyarrow, pyyaml)
├── .cache/                # (Auto-generated) Columnar Parquet cache
├── data/surveillance/     # Bundled surveillance datasets
├── tests/                 # Automated test suite
└── static/                # Frontend application
    ├── index.html         # Web dashboard layout and methodology reference modal
    ├── style.css          # UI styles (Dark and Light themes)
    ├── js/                # Client application modules (ES Modules)
    └── vendor/            # Bundled dependencies (Plotly, XLSX)
```

---

## 10. Data Considerations

- **Finalized vs. Real-Time Observations**: The visualizer evaluates forecasts against the latest available ground-truth oracle. Retrospective revisions in hospital reporting may cause aggregate scores here to differ slightly from real-time evaluation reports that scored against unrevised data.
- **Continuous vs. Categorical Targets**: The interval scoring engine (WIS) is designed for continuous quantile forecasts. Categorical targets (such as rate change categories) display probability distributions rather than interval scores.
- **Historical Surveillance Coverage**: Bundled ILINet and FluSurv-NET datasets cover seasons 2010–2023. For 2023–present, NHSN admissions and NSSP emergency department visits serve as the primary active signals.

---

## 11. References

- **Weighted Interval Score**: Bracher, J., Ray, E. L., Gneiting, T., & Reich, N. G. (2021). Evaluating epidemic forecasts in an interval format. *PLOS Computational Biology*, 17(2), e1008618.
- **Hubverse Evaluation Standards**: Cramer, E. Y., et al. (2022). Evaluation of individual and ensemble probabilistic forecasts of COVID-19 mortality in the US. *Proceedings of the National Academy of Sciences*, 119(15), e2113561119.
- **Scale Transformations**: Bosse, N. I., et al. (2023). Scoring epidemiological forecasts on transformed scales. *PLOS Computational Biology*, 19(8), e1011393.
