# viz — Forecast Dashboard & Scoring for Hubverse Flu Hubs

A local web dashboard and command-line scorer for any forecasting hub that follows the [Hubverse](https://hubverse.io) / CDC FluSight layout. Drop it into your hub and you get:

- **Forecast fan charts** with truth, as-of surveillance reports, and NSSP / ILINet / FluSurv-NET signals
- **Leaderboard**: WIS, pairwise relative WIS, coverage, and weekly wins, on natural or log scale, by date, season, week range, or epidemic phase
- **Heatmaps & maps**: cross-sections across states, models, dates, and horizons
- **Season peak** forecasts (size and timing)
- **Ensemble studio**: build and score quantile ensembles of any models
- **Live CDC FluSight data**: pull the public hub's forecasts from S3 and compare them with your own
- **`score_cli.py`**: the same scores from the terminal, exported to CSV, JSON, or Parquet

Everything runs locally on Python. There is no Node build step and no database.

---

## Quick start

**Requirements:** Python 3.10+ and git, plus a local checkout of a Hubverse hub (a folder with `model-output/` and `target-data/`).

### macOS / Linux

```bash
cd path/to/your-hub
git clone https://github.com/nikhillebaka/viz.git viz
./viz/setup.sh
./viz/run.sh
```

### Windows (Command Prompt or PowerShell)

```bat
cd path\to\your-hub
git clone https://github.com/nikhillebaka/viz.git viz
viz\setup.bat
viz\run.bat
```

Then open **http://127.0.0.1:8501**.

`setup` is safe to re-run. It does five things:
1. Creates `viz/.venv`, or uses your active virtual environment if one is on.
2. Installs the dependencies (`polars`, `pyarrow`, `numpy`, `pyyaml`).
3. Downloads the latest hospital-admissions surveillance data. If you're offline, it builds this from your hub's `target-data/`.
4. Creates `local-output/` in your hub, for model runs you want to compare before committing.
5. Adds `viz/` and `local-output/` to your hub's `.git/info/exclude`, so neither appears in `git status` or gets committed to the hub.

> **The folder must be named `viz` and sit directly inside the hub.** viz reads hub data from its parent folder, and its Python modules import each other as `viz.*`.

---

## What viz reads from your hub

```text
your-hub/
├── viz/               ← this repo
├── model-output/      Forecasts: <model_id>/<YYYY-MM-DD>-<model_id>.csv or .parquet   (required)
├── target-data/       Truth: oracle-output.csv or .parquet                           (required for scoring)
├── local-output/      Uncommitted model runs, same layout as model-output/            (created by setup)
├── auxiliary-data/    locations.csv: FIPS codes, names, populations                    (optional)
├── hub-config/        tasks.json: targets, horizons, rounds                            (optional)
└── model-metadata/    <model_id>.yml                                                   (optional)
```

Targets, baseline model, locations, and horizons are discovered from these files automatically, so no config is needed. To override the defaults, see [docs/configuration.md](docs/configuration.md).

**Try a model without committing it:** put its files in `local-output/<model_id>/<YYYY-MM-DD>-<model_id>.csv`. They show up tagged `[LOCAL]` next to the hub's `[REPO]` models, and the scoring is identical. Setup creates the folder; ensembles you save in the Ensemble Studio also land there, under `local-output/synthetic/`.

---

## Everyday use

Activate the environment first so `python` has the dependencies. `run.sh` and `run.bat` find it on their own.

```bash
source viz/.venv/bin/activate          # Windows: viz\.venv\Scripts\activate
```

**Score models from the terminal**

```bash
python viz/score_cli.py --models all --season 2024-2025 --location states
python viz/score_cli.py --models all --season current --format csv --out scores.csv
```

**Refresh surveillance data** (NHSN admissions and as-of snapshots)

```bash
python viz/rebuild_surveillance.py --force
```

**Use a different port**

```bash
./viz/run.sh 8600                      # Windows: viz\run.bat 8600
```

**Update viz**

```bash
git -C viz pull
```

Your `config.json`, `.venv/`, cache, and downloaded data are all git-ignored, so pulling never conflicts with them.

**Compare against live CDC FluSight forecasts:** click **FluSight Sandbox** in the top-left of the dashboard and open *Live Hub Data*. Nothing downloads until you press *Sync*. See [docs/live-hubs.md](docs/live-hubs.md).

---

## Troubleshooting

| Symptom | Fix |
| :--- | :--- |
| `viz dependencies are not installed` | Run `./viz/setup.sh` (or `viz\setup.bat`). |
| `viz must be inside a Hubverse hub` | Setup stopped because `viz/` was cloned outside a hub. Run the `mv` command it prints, or re-clone from inside the hub. |
| `ModuleNotFoundError: No module named 'viz'` | The folder isn't named `viz`. Rename it, or re-clone with `git clone … viz`. |
| No models in the dashboard | viz must sit directly inside the hub, next to `model-output/`. |
| Surveillance panels are empty | Run `python viz/rebuild_surveillance.py --force`. |
| Scores look stale after editing forecasts | Restart `run.sh`; changed files are re-cached automatically. As a last resort, delete `viz/.cache/`. |
| `port 8501 … is already in use` | Another viz server (often for a different hub) is running there. Use the free port the error suggests, e.g. `./viz/run.sh 8600`. `/api/status` reports which hub a running server belongs to. |

---

## Documentation

| Page | Contents |
| :--- | :--- |
| [docs/cli.md](docs/cli.md) | `score_cli.py` flags and examples, and surveillance rebuild options |
| [docs/methodology.md](docs/methodology.md) | How WIS, relative WIS, coverage, phases, wins, and ensembles are computed |
| [docs/configuration.md](docs/configuration.md) | `config.json` options and staging local experiments |
| [docs/live-hubs.md](docs/live-hubs.md) | Syncing CDC FluSight (or another public flu hub) from S3 |
| [docs/api.md](docs/api.md) | REST endpoints served by the dashboard |
| [docs/development.md](docs/development.md) | Running tests and the project's file layout |

The dashboard's **Guide & Methods** button has the full metric definitions too.

---

## License

[MIT](LICENSE) © 2026 Nikhil Lebaka. Bundled Plotly (MIT) and SheetJS (Apache-2.0) keep their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
