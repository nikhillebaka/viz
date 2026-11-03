# Development

## Automated Tests

Install the dev dependencies, then run the suite from the hub root (several tests read the hub's own `model-output/` and `target-data/`):
```bash
viz/.venv/bin/pip install -r viz/requirements-dev.txt
PYTHONPATH=. viz/.venv/bin/python -m pytest viz/tests -v
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

## File Layout

```text
viz/
├── setup.sh / setup.bat     # One-time setup: venv, dependencies, surveillance data
├── run.sh / run.bat         # Launch the dashboard
├── server.py                # HTTP server and REST API request handler
├── score_cli.py             # Headless command-line evaluation tool
├── rebuild_surveillance.py  # Surveillance data download / rebuild
├── config.example.json      # Copy to config.json to override defaults
├── core/                    # Engine shared by the server and the CLI
│   ├── config.py            #   Configuration loader with Hubverse auto-discovery
│   ├── data_loader.py       #   Forecast and surveillance data ingestion
│   ├── cache_manager.py     #   Columnar Parquet cache with mtime invalidation
│   ├── evaluation.py        #   Evaluation engine, aggregations, tournament scaling
│   ├── metrics.py           #   Vectorized scoring (WIS, MAE, coverage, decomposition)
│   ├── peaks.py             #   Season peak targets: extraction, summaries, scoring
│   ├── peak_data.py         #   Peak query layer used by the data loader
│   └── synthetic_ensemble.py#   Quantile Vincentization and ensemble synthesis
├── remote/                  # Live hub data: S3 client, flu-hub checks, normalization, sync
├── static/                  # Frontend (no build step)
│   ├── index.html           #   Dashboard layout and methodology modal
│   ├── style.css            #   Dark and light themes
│   ├── js/                  #   ES modules (main.js, api.js, state.js, components/)
│   └── vendor/              #   Bundled Plotly and SheetJS
├── data/seed/               # Bundled 2010–2023 ILINet / FluSurv-NET history (read-only)
├── data/surveillance/       # (Generated) Working surveillance data, rebuilt by setup
├── tests/                   # pytest / unittest suite
├── docs/                    # Reference documentation
└── .cache/                  # (Generated) Parquet cache, safe to delete
```

Python modules import each other as `viz.core.*` and `viz.remote.*`, which is why the folder must be named `viz` and why tests run with the hub root on `PYTHONPATH`.
