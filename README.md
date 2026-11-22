# viz — Multi-Hub Forecast Dashboard, Briefings & Scoring Engine

A local/web dashboard and command-line scorer for [Hubverse](https://hubverse.io) infectious-disease forecasting hubs across North America and Europe. Run it standalone against remote public hubs or inside any local Hubverse repository:

- **Forecast fan charts (`VZF2`)** with truth overlays, as-of surveillance vintages, aligned RespiCast reference + origin date ticks, and NSSP / ILINet / FluSurv-NET signals
- **3D Interactive Globe & Multi-Hub Switching**: orthographic sphere with country (`1:50m`), US state, dissolved Flu MetroCast HSA (`95` areas), and NYC borough zoom tiers, plus seamless semantic switching across connected hubs
- **Place-First Live Briefings**: multi-hub ensemble outlooks paired with live CDC NWSS wastewater, CFA $R_t$, NSSP ED visits, NREVSS lab positivity, Delphi FluView, ECDC ERVISS (sentinel positivity, ILI/ARI, SARI), WHO FluNet subtyping, UKHSA PCR positivity, and Nextstrain genomic clades, with deep links back into the workbench and Print/PDF export
- **Quantile, PMF & Trajectory Scoring**:
  - **Quantiles**: WIS decomposition, pairwise relative WIS, natural or log scale, interval coverage, weekly wins, Heatmaps, Choropleth/EU tile Maps, and Season Peaks
  - **Categorical PMFs**: Matrix / Flow / Bars visualizations plus Ranked Probability Score (RPS), Log loss, Brier score, Mode hit, and pairwise relative RPS
  - **Sample Trajectories (`VZT1`)**: interactive sample path clouds with peak clouds, drag conditioning gates, empirical CRPS, multivariate Energy Score, and a full-season Sample Leaderboard
- **Ensemble Studio & `score_cli.py`**: Vincentized quantile ensembles and headless CLI evaluation (`csv`, `json`, `parquet`)

Everything runs on Python (`polars`, `pyarrow`, `numpy`, `pyyaml`). There is no Node build step and no database.

---

## Quick start

**Requirements:** Python 3.10+ and git. Works both **standalone** (syncing public hubs via S3/GitHub) or **inside a Hubverse hub** (`model-output/`, `target-data/`).

### macOS / Linux

```bash
git clone https://github.com/nikhillebaka/viz.git viz
./viz/setup.sh
./viz/run.sh
```

### Windows (Command Prompt or PowerShell)

```bat
git clone https://github.com/nikhillebaka/viz.git viz
viz\setup.bat
viz\run.bat
```

Then open **http://127.0.0.1:8501** (`/` redirects to `/next/`).

`setup` is safe to re-run:
1. Creates `viz/.venv` (or uses your active virtual environment).
2. Installs dependencies (`polars`, `pyarrow`, `numpy`, `pyyaml`).
3. Builds/updates local surveillance data from `target-data/` when present inside a hub.
4. When run inside a hub, creates `local-output/` and adds `viz/` and `local-output/` to `.git/info/exclude`.

---

## Connected Hubs & Workspaces

Built-in syncable hubs configured in [remote/hubs.py](remote/hubs.py):
- **CDC FluSight** (`cdcepi-flusight-forecast-hub` via S3)
- **Flu MetroCast** (`reichlab/flu-metrocast` via GitHub)
- **US COVID-19 Forecast Hub** (`covid19-forecast-hub` via S3)
- **US RSV Forecast Hub** (`rsv-forecast-hub` via S3)
- **RespiCast Syndromic (ILI/ARI)** (`european-modelling-hubs/RespiCast-SyndromicIndicators` via GitHub)
- **RespiCast COVID-19** (`european-modelling-hubs/RespiCast-Covid19` via GitHub)

When placed inside a local Hubverse checkout (or pointed via `--hub <path>` / `VIZ_HUB_DIR`), viz also discovers:

```text
your-hub/
├── model-output/      Forecasts: <model_id>/<YYYY-MM-DD>-<model_id>.csv or .parquet
├── target-data/       Truth: oracle-output.csv or .parquet
├── local-output/      Uncommitted model runs, same layout as model-output/
├── auxiliary-data/    locations.csv (optional)
├── hub-config/        tasks.json (optional)
└── model-metadata/    <model_id>.yml (optional)
```

For web deployment in read-only mode, run `server.py --mode web` (`VIZ_MODE=web`).

---

## Everyday use

**Score models from the terminal**

```bash
PYTHONPATH=. viz/.venv/bin/python viz/score_cli.py --models all --season 2024-2025 --location states
PYTHONPATH=. viz/.venv/bin/python viz/score_cli.py --models all --season current --format csv --out scores.csv
```

**Run on a custom port or standalone data directory**

```bash
./viz/run.sh 8600
./viz/.venv/bin/python server.py --port 8600 --data-dir /path/to/data
```

---

## Documentation

| Page | Contents |
| :--- | :--- |
| [docs/cli.md](docs/cli.md) | `score_cli.py` flags and surveillance rebuild options |
| [docs/methodology.md](docs/methodology.md) | WIS, pairwise relative WIS, CRPS, Energy Score, RPS, Log loss, coverage, phases, and ensembles |
| [docs/configuration.md](docs/configuration.md) | `config.json` options and staging local experiments |
| [docs/live-hubs.md](docs/live-hubs.md) | Syncing FluSight, MetroCast, COVID-19, RSV, and RespiCast hubs via S3/GitHub |
| [docs/api.md](docs/api.md) | REST and binary endpoints served by the dashboard (`/api/next/*` and `/api/*`) |
| [docs/development.md](docs/development.md) | Python unit tests, JS unit tests, CDP E2E tests, and project layout |
| [next/ARCHITECTURE.md](next/ARCHITECTURE.md) | Frontend architecture, modules, and state/URL contract |

---

## License

[MIT](LICENSE) © 2026 Nikhil Lebaka. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
