# Build plan

The fan chart (phase 1) is done. Everything else is built in four lanes that do not share files.
Design reference for the page below the chart: `design/studies/evaluation-goals.md` (a rough guide;
the fan chart's look and `styles/tokens.css` are the anchor). Feature inventory: `parity/*.md`.

## The page

```
fixed bubbles: Models · Location · Target                      theme · ⋯
[ fan chart view, full height minus a peek ]        ← features/FanChart.js (+ layers)
[ Scores: scope line, leaderboard, figures ]        ← sections/scores/
[ Heatmap ]                                         ← sections/heatmap/
[ Map ]                                             ← sections/map/
[ Peaks ]                                           ← sections/peaks/
```

## Contracts

- **A section** is `sections/<name>/index.js` exporting `mount(el, ctx) → { destroy() }`, where
  `ctx = { manifest, store, chart }`. It owns `sections/<name>/*` and `styles/<name>.css` (linked by
  the section itself: `import.meta.url`-relative `<link>` added once). `sections/index.js` mounts each
  section lazily when it nears the viewport; a section that fails to load leaves one quiet line.
- **Scope** (what is being evaluated) lives in the store as `scope` and is read only through
  `sections/scope.js`: `scopeOf(state, manifest) → { seasons: [id], from, to, phase, horizons, place }`.
  By default it follows the chart's season. Scores owns the scope line UI; every other section reads it.
- **Data** comes from the existing endpoints (`/api/metrics`, `/api/heatmap`, `/api/spatial`,
  `/api/peaks`, `/api/peak-map`, `/api/season-curves`, `/api/surveillance`, `/api/model-details`,
  `/api/ensemble/*`, `/api/remote/*`, `/api/status`). `server.py`/`core/` change only by adding
  `/api/next/*` routes, never by altering what old viz gets.
- **Kit**: `ui/controls.js`, `ui/floating.js`, `ui/glass.js`, `lib/dom.js`, `lib/scale.js`,
  `lib/format.js`. Tokens only; no one-off values. Copy is short fragments joined with " · ".
- **Sections are paper**, not bubbles: tables and figures are drawn on the page; only controls float.

## Lanes

| Lane | Owns | Old viz source |
|---|---|---|
| Scores | `sections/scores/`, `sections/scope.js`, `styles/scores.css`: scope line, Dates popover, leaderboard, expanded row (model detail), figures (calibration, horizon, anatomy), ↓ menu (exports, Copy CLI, Copy link) | `leaderboard.js`, `diagnostics.js`, `eval_window.js`, `modals.js` |
| Views | `sections/heatmap/`, `sections/map/`, `sections/peaks/` and their CSS | `heatmap_view.js`, `spatial_map.js`, `peak_view.js` |
| Layers | `features/chart/layers.js` and the Layers pill on the fan chart (as-of, NSSP, ILINet, FluSurv-NET, past seasons, peaks) | `forecast_chart.js` (signals drawer) |
| More | `features/More.js` (⋯ bubble: hubs, warnings, refresh, shortcuts, Methods), `features/Hubs.js`, `features/Ensemble.js`, `features/Methods.js` | `remote_hubs.js`, `ensemble_studio.js`, `modals.js` |

## Checking

Reasonable, not exhaustive: `node --check` on what you wrote, unit tests only for pure logic that is
easy to get wrong, and one headless smoke check per lane (`tests/e2e/<lane>.check.mjs`: it mounts,
shows real data, no console errors). One visual pass over the whole page at the end.
