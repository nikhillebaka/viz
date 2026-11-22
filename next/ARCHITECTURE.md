# next/: architecture

`/next/` is the sole frontend of viz (`/` redirects to `/next/`). Design decisions are in
[DECISIONS.md](DECISIONS.md). This document describes module boundaries, state contracts, and binary formats.

## Ground rules

- **No build step, no runtime npm dependencies.** Plain ES modules loaded directly by the browser, plain CSS tokens. Node (`>=20`) is used solely to run unit and CDP E2E tests.
- **One token system.** Every color, size, radius, weight, and duration comes from `styles/tokens.css`. Canvas modules read tokens dynamically through `lib/dom.js`.
- **Motion** is quick and respects `prefers-reduced-motion`.
- **Keyboard and accessibility.** Full keyboard navigation (`:focus-visible` only), accessible labels, and aria-live announcements.
- **Performance.** One chart redraw per animation frame, no layout thrash in hot draw paths, and binary compact payloads (`VZF2`, `VZT1`) for multi-model time series.
- **Style of code.** Small single-purpose modules, JSDoc on exported functions, no dead globals (only `window.__viz` for E2E checks).

## Layout

```text
next/
  index.html                  the page: loads stylesheets and boots app.js
  app.js                      bootstraps catalog/manifest, store, URL/storage sync, and switchContext()
  styles/                     tokens.css · base.css · glass.css · controls.css · app.css ·
                              views.css · globe.css · briefing.css · pmf.css · trajectories.css · ...
  lib/
    dom.js                    h(), on(), token(), cssColor(), reducedMotion(), storage wrapper
    store.js                  reactive frozen-state container
    scale.js                  linear scale, nice ticks, UTC calendar helpers
    format.js                 date and target-aware value formatters
    api.js                    catalog, globe, manifest, VZF2 fan, VZT1 trajectories, PMF, briefings, sample-scores
    position.js               anchored floating popover positioning
  ui/
    glass.js                  refraction / frosted-glass helper
    floating.js               popovers, menus, tooltips
    controls.js               icons, pills, Stepper, Segmented, toast, timeKeys
  chart/
    layout.js                 pure scene geometry for fan charts (incl. RespiCast horizon_offset_days)
    render.js                 HiDPI Canvas 2D fan chart painter
    timenav.js                date, zoom, pan, height gesture & keyboard physics
  geo/                        offline TopoJSON atlases (1:50m world countries, US states/counties, 95 MetroCast HSAs) + EU tile layouts
  features/
    selection.js              pure model selection & color-slot queue
    FanChart.js               fan chart view, time navigation, hover, focus, readout
    Shell.js                  top pills, briefing/globe overlays, keyboard shortcuts, lazy section rail
    GlobeView.js              orthographic 3D WebGL/Canvas globe with zoom-tiered drilldown & place drawer
    BriefingView.js           place-first multi-hub editorial briefing + surveillance + Print/PDF view
    PmfView.js                categorical PMF Matrix / Flow / Bars view + local/seasonal scoring tables
    ModelPicker.js            faceted model browser
    LocationPicker.js         contextual place switcher (US states, MetroCast HSAs, Europe)
    DatePicker.js             round calendar & shortcut menu
    TargetMenu.js             cross-hub target switcher grouped by pathogen
    ModelSheet.js             model detail sheet with minimap & per-location score parity
    Guide.js                  searchable in-app manual (#guide/<topic>)
    More.js                   data sources, warnings, refresh, shortcuts, Guide (#more)
    briefing/model.js         pure SVG geometries for briefing outlooks, sparks, clades, and flu subtypes
    chart/trajectories.js     VZT1 binary sample decoder
    url.js                    state ⇄ URL & multi-hub hash handling
  sections/
    index.js                  lazy section tab rail (Scores · Heatmap · Map · Peaks · Trajectories · Rate change)
    scope.js                  shared evaluation scope helpers
    scores/                   pairwise relative WIS / RPS / Log loss leaderboard + SVG figures + CSV/CLI export
    heatmap/                  cross-sectional value/score heatmap
    map/                      US state & EU tile choropleth map
    peaks/                    season peak week & peak size view
    trajectories/             HiDPI sample path cloud, conditioning gate, CRPS/Energy KPIs & Sample Leaderboard
    rate_change/              companion categorical PMF section below quantile charts
  dev/
    serve.py                  development server launcher
  tests/
    unit/*.test.mjs           Node unit tests (`node --test "next/tests/unit/**/*.test.mjs"`)
    e2e/*.check.mjs           Headless Chromium CDP checks (`node next/tests/e2e/run.mjs`)
```

## Primary APIs (server: `core/next_api.py`, `core/catalog.py`, `core/briefings.py`, `server.py`)

- `GET /api/next/catalog` → unified cross-hub index of providers, semantic targets (`concept_id`), canonical places, and place chooser groups.
- `GET /api/next/globe` → multi-hub spatial snapshot (`activity`, normalized intensity, latest observation, 1-wk change) across global countries, US states, and MetroCast HSAs.
- `GET /api/next/briefing?place=<key>` → Place-First Briefing payload (ensemble signals, peer sub-regions, US/EU/UK external surveillance & virology feeds, KPIs).
- `GET /api/next/manifest[?workspace=<hub_id>]` → hub-indexed targets (including `horizon_offset_days`, `is_categorical`, `categories`), locations, seasons, models (`has_samples`, `has_pmf`), and baselines.
- `GET /api/next/fan?target=&season=&location=&v=2` → compact binary `VZF2` (`float32` + quantile index) observed series and model quantile fans.
- `GET /api/next/trajectories?target=&season=&location=&date=` → compact binary `VZT1` sample draws (`n_samples x n_horizons`).
- `GET /api/next/pmf?target=&season=&location=` → categorical PMF probabilities and realized bin history.
- `GET /api/next/metrics?...` → leaderboard & per-horizon scores (WIS / pairwise Rel. WIS for quantiles; RPS / Log loss / Brier / Mode hit / pairwise Rel. RPS for PMFs).
- `GET /api/next/sample-scores?...` → full-season sample trajectory leaderboard (empirical CRPS, Rel. CRPS, multivariate Energy Score, Rel. Energy Score).
- `GET /api/next/model-locations?...` → per-location pairwise relative WIS & coverage for `ModelSheet.js`.

## App state (the store) and the URL

| Key | Meaning | URL | Default |
|---|---|---|---|
| `hub` | active workspace hub id | `hub` | workspace default |
| `target` | target id | `target` | manifest default |
| `location` | location id | `loc` | last used / default location |
| `date` | forecast round, ISO | `date` | latest round |
| `sel` | selected/charted queue, baseline toggle, `showAll` | `models`, `chart`, `base=0`, `all=1` | first recommended models |
| `dims` | extra Hubverse task dims (e.g. `age_group`) | `dim_<col>` | target default |
| `level` | interval level (`0.95 \| 0.8 \| 0.5 \| 0`) | `pi` | `0.95` |
| `outcome` | observed data after cutoff toggle | — | on |
| `rulers` | width rulers | `rulers=1` | off |
| `focus` | focused model id | `focus` | none |
| `layers` | context layers (`asof`, `seasons`, `peaks`, `nssp`, `ili`, `flusurv`) | `lay` | none |
| `theme` | `light` / `dark` | storage | `dark` |

Hash routes: `#globe`, `#briefing[/<place_key>]`, `#model/<model_id>`, `#guide/<topic>`.

## Tests & Running

```bash
# JS unit tests
node --test "next/tests/unit/**/*.test.mjs"

# Headless CDP E2E tests (starts server automatically, or pass --base URL)
node next/tests/e2e/run.mjs

# Standalone or hub-attached server
./run.sh
python next/dev/serve.py --port 8610
```
