# design/: reference components for the viz redesign

A design reference, not the product. It holds the new design language (tokens, glass, controls), a
production-quality fan chart and time navigation, model selection, scoring, and prototype pages that show
how they fit together. The rebuild that ports old viz into this design is briefed in `HANDOFF.md`.

## Run it

```bash
# 1. data (gitignored; about a minute each, from the hub root: the folder that contains model-output/ and viz/)
viz/.venv/bin/python viz/design/data/extract_scores.py . viz/design/data
viz/.venv/bin/python viz/design/data/extract_fc.py . viz/design/data
# 2. serve with caching off
python3 viz/design/tools/serve.py viz/design
```

Pages: `index.html` (foundations), `components.html`, `studies/intervals-refine.html` (the fan chart with
scores, seasons and places: the main reference), `studies/scores.html` (scores on their own),
`studies/intervals.html` (the interval study).

## Map

| Path | What |
|---|---|
| `tokens/` | design tokens: `source.mjs` → `node tokens/build.mjs` → `tokens.css` / `tokens.json` |
| `lib/glass.*` | liquid glass: WebGL compositor over the chart canvas, SVG backdrop refraction over the page |
| `lib/controls.*`, `lib/position.js` | pills, segmented, stepper, popovers and menus (morph, placement), search, toasts |
| `lib/chart.js` | fan chart layout and canvas renderer (`layoutFan`, `fanCanvas`); SVG renderer for static pages |
| `lib/time.js` | `TimeNav`: date, zoom, pan, height zoom; gestures, keys, springs; season timeline swap |
| `lib/selection.js` | model selection: selected vs the five charted, color slots, families/teams |
| `lib/scores.js` | per-forecast scores → leaderboard rows (pairwise relative WIS) and heatmap slices |
| `lib/evaluation.*` | the scores section: scope line, leaderboard, heatmap, figures |
| `lib/fandata.js` | fan chart data per season and place |
| `data/` | extract scripts (outputs are gitignored); `core.json` / `fc-US.json` feed the older study pages |
| `studies/*.md` | the decisions: read these before changing behaviour |
| `tests/` | regression checks (browser console scripts + one node script) |

## Checks

Open `studies/intervals-refine.html` at about 1440×900 and run in the console, in any order:

```js
(await import("/tests/time-nav-check.js")).run()   // 48
(await import("/tests/scores-check.js")).run()     // 33
(await import("/tests/seasons-check.js")).run()    // 32
```

and `node design/tests/selection-check.mjs` (14). `tests/perf-check.js` is a frame-time benchmark.
