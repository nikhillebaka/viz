# viz

A local/web dashboard and CLI scorer for [Hubverse](https://hubverse.io) infectious-disease forecasting hubs. Runs standalone against public hubs or directly inside a local Hubverse repository.

Uses Python (`polars`, `pyarrow`, `numpy`, `pyyaml`) with no Node build step and no database.

---

## Setup

**Requirements:** Python 3.10+ and git.

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

Open **http://127.0.0.1:8501**.

`setup` creates `viz/.venv` (or uses an active virtualenv), installs Python dependencies, and builds local surveillance files when run inside a Hubverse checkout (adding `viz/` and `local-output/` to `.git/info/exclude`).

---

## Running

When placed inside a Hubverse repository (or pointed via `--hub <path>` / `VIZ_HUB_DIR`), viz reads the standard hub layout:

```text
your-hub/
├── model-output/      Forecasts: <model_id>/<YYYY-MM-DD>-<model_id>.csv or .parquet
├── target-data/       Truth: oracle-output.csv or .parquet
├── local-output/      Local/uncommitted runs (same layout as model-output/)
├── auxiliary-data/    locations.csv (optional)
├── hub-config/        tasks.json (optional)
└── model-metadata/    <model_id>.yml (optional)
```

Custom port, data directory, or read-only web mode:

```bash
./viz/run.sh 8600
./viz/.venv/bin/python server.py --port 8600 --data-dir /path/to/data
./viz/.venv/bin/python server.py --mode web   # or VIZ_MODE=web
```

Headless CLI scoring:

```bash
PYTHONPATH=. viz/.venv/bin/python viz/score_cli.py --models all --season 2024-2025 --location states
PYTHONPATH=. viz/.venv/bin/python viz/score_cli.py --models all --season current --format csv --out scores.csv
```

---

## Documentation

| Page | Contents |
| :--- | :--- |
| [docs/cli.md](docs/cli.md) | `score_cli.py` flags and surveillance rebuild options |
| [docs/methodology.md](docs/methodology.md) | WIS, relative WIS, CRPS, Energy Score, RPS, Log loss, coverage, and ensembles |
| [docs/configuration.md](docs/configuration.md) | `config.json` options and staging local experiments |
| [docs/live-hubs.md](docs/live-hubs.md) | Syncing FluSight, MetroCast, COVID-19, RSV, and RespiCast hubs |
| [docs/api.md](docs/api.md) | Endpoints served by the backend (`/api/next/*` and `/api/*`) |
| [docs/development.md](docs/development.md) | Unit tests, E2E tests, and project layout |
| [next/ARCHITECTURE.md](next/ARCHITECTURE.md) | Frontend architecture and state/URL contract |

---

## License

[MIT](LICENSE) © 2026 Nikhil Lebaka. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
