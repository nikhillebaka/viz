# Development

## Automated Tests

### Python Unit & Integration Tests
Run the Python suite with `unittest` (or `pytest`):

```bash
./.venv/bin/python -m unittest discover -s tests
```

### Frontend Unit Tests (Node >= 20, zero external packages)

```bash
node --test "next/tests/unit/**/*.test.mjs"
```

### End-to-End CDP Browser Tests (Headless Chromium)

```bash
# Auto-starts next/dev/serve.py on a free port:
node next/tests/e2e/run.mjs

# Or run against an already running server:
node next/tests/e2e/run.mjs --base http://127.0.0.1:8501
```

### Test Highlights
- `tests/test_metrics.py`, `tests/test_fast_paths.py`, `tests/test_prescore_and_vzf2.py`: WIS, CRPS, Energy Score, PMF scoring (RPS, Log loss, Brier, Mode hit), `EvaluationEngine.evaluate_samples`, `VZF2`/`VZT1` binary encoding, gzip/ETag static serving.
- `tests/test_briefings.py`: Multi-hub place resolution, official hub ensemble ranking (`rank_ensemble_candidates`), CDC/WHO/UKHSA/ECDC ERVISS/Nextstrain feed parsing & Parquet caching.
- `tests/test_evaluation.py`, `tests/test_cli_parity.py`, `tests/test_eval_window.py`: Leaderboard aggregations, shared-task fair intersection, evaluation windows, CLI parity.
- `tests/test_remote_hubs.py`, `tests/test_server.py`: S3/GitHub transport syncing, web-mode read-only hardening, CORS/routing.
- `next/tests/unit/`: `scores.test.mjs`, `briefing.test.mjs`, `trajectories.test.mjs`, `geo.test.mjs`, `multi-hub.test.mjs`, plus chart/scale/selection/fan tests.
- `next/tests/e2e/`: `smoke`, `views`, `scores`, `sheet`, `picker`, `layers`, `time`, `more`, `briefing`, `globe`, `nonquantile`.

---

## File Layout

```text
viz/
├── setup.sh / setup.bat       # Environment setup
├── run.sh / run.bat           # Launch the server on 127.0.0.1:8501
├── server.py                  # Multi-hub HTTP server & /api/* + /api/next/* routing
├── score_cli.py               # Headless CLI scorer
├── rebuild_surveillance.py    # Surveillance data download / rebuild
├── core/                      # Python engine
│   ├── workspace.py           #   Multi-hub WorkspaceManager & read-only web-mode guard
│   ├── catalog.py             #   Cross-hub catalog, globe builder, official ensemble ranking
│   ├── briefings.py           #   Place-first editorial briefing composer
│   ├── briefing_feeds.py      #   External surveillance/virology fetchers (CDC, ECDC ERVISS, WHO, UKHSA, Nextstrain)
│   ├── next_api.py            #   VZF2 fans, VZT1 trajectories, PMF, manifest, as-of APIs
│   ├── evaluation.py          #   Evaluation engine (Quantiles, PMFs, Sample CRPS & Energy Score)
│   ├── metrics.py             #   Vectorized scoring functions
│   ├── geo.py                 #   US FIPS, HHS regions, MetroCast HSAs, Europe ISO-2 mapping
│   ├── calendar.py            #   US Saturday / RespiCast Sunday + horizon offset alignment
│   ├── prescore.py            #   Persistent quantile pre-score cache
│   ├── cache_manager.py       #   Columnar Parquet cache with mtime invalidation
│   ├── config.py / data_loader.py / peaks.py / peak_data.py / synthetic_ensemble.py / truth.py
├── remote/                    # Remote hub specs, S3 & GitHub transports, incremental sync
├── next/                      # Sole frontend (no build step; see next/ARCHITECTURE.md)
│   ├── features/              #   FanChart, GlobeView, BriefingView, PmfView, Shell, Pickers, Guide
│   ├── sections/              #   Scores, Heatmap, Map, Peaks, Trajectories, Rate change
│   ├── geo/                   #   Offline TopoJSON atlases (world 1:50m, US counties, MetroCast HSAs)
│   └── tests/                 #   Node unit tests & Chromium CDP E2E tests
├── tests/                     # Python unittest suite
├── docs/                      # Reference documentation & config.example.json
├── LICENSE / README.md / THIRD_PARTY_NOTICES.md
└── .cache/                    # (Generated) Parquet & remote hub caches
```
