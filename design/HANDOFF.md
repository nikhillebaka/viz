# Rebuild viz in the new design: agent brief

You are rebuilding the frontend of **viz**, the forecast evaluation dashboard in this repository, in a new
design. Work autonomously from this brief to the end. The person who owns this work is not available for
step-by-step questions; where a real design decision is open, choose the option most consistent with the
principles below, record it in `next/DECISIONS.md` with the alternatives, and keep going.

## 1. What exists

- **Old viz** (the product today): `server.py` + `core/` + `remote/` (Python backend, scoring, hub sync)
  and `static/` (Plotly frontend: `static/index.html`, `static/js/main.js`, `state.js`, `constants.js`,
  `static/js/components/*.js`, `static/style.css`). Documentation in `docs/` (`methodology.md`, `api.md`,
  `cli.md`, `configuration.md`, `live-hubs.md`). Tests in `tests/`.
- **`design/`**: a design reference built over many iterations with the owner. Read `design/README.md`
  first. It contains a new design language and several production-quality pieces, plus prototype pages
  that wire them together quickly. It is **reference components**, not the app: it covers a fraction of
  old viz, some of its pieces are temporary, and many small details are inconsistent.

## 2. The goal

Build a new frontend that **ports every single feature of old viz, faithfully**, into the new design, and
serve it **beside** old viz until it reaches parity:

- New code lives in `next/` (frontend) and new endpoints are added to `server.py` beside the existing ones.
  Serve the new frontend at `/next/`. **Do not change or remove anything old viz depends on** (`static/`,
  existing endpoints, `core/` behaviour). Old viz must keep working exactly as now.
- "Every single feature" means every view, control, option, metric, column, export, URL parameter, modal,
  keyboard behaviour, empty state, warning and edge case old viz handles. Nothing is dropped silently. A few
  things were deliberately redesigned or dropped during the design work; those are listed in §6 and must
  be honoured, with the reason written into the parity checklist.
- Use `design/` as the reference for **look, feel, interaction and the parts marked polished** (§4). Rebuild
  robustly what's marked prototype (§5). Design the many pieces old viz has that `design/` doesn't (§7) in
  the same language, following the principles (§3).
- Desktop only. Mobile comes later, separately.

## 3. Principles (from the owner; these override your defaults)

- **Function wins every tie, but design matters.** It should look exceptional, not merely tidy.
- **Paper and bubbles.** The page is paper: charts and scores are printed on it in a thin-line, hairline,
  tabular-number language with no cards, boxes or heavy fills. Controls float on top as **liquid glass
  bubbles**, and a bubble appears **only while what it controls is on screen or applies**. Prefer page
  sections and popovers to modals; prefer controls that are the labels of what they control (the scope
  line in `design/lib/evaluation.js` is the pattern: a sentence of fragments, each a button).
- **Glass must stay consistent** everywhere (same refraction over the chart and over the page; see
  `design/lib/glass.js` and its comments).
- **Concise copy.** Short fragments joined with " · ", no instructional sentences on screen; explanations
  live in popovers, tooltips and aria labels.
- **No bouncy springs.** Motion is quick and critically damped (no overshoot).
- **Performance is not traded for form.** Frames stay well under budget with 100+ models and several
  seasons (see `design/studies/performance.md` for how the chart got from 17–44 ms to ~0.3 ms of style and
  layout per frame).
- **Color has jobs.** Series colors identify the (up to five) charted models and nothing else; elsewhere a
  charted model shows only its small color dot. Score colors (`--score-1…9`, blue · orange) mark
  better/worse, sparingly. Everything else is ink. Never green/red for scores.
- **Old behaviour keeps working.** After every change, re-run the checks, update the ones whose
  assumptions changed, and add a case for each behaviour you build.

## 4. Polished: reuse, keep the behaviour, refactor only the packaging

Read the matching doc before touching each; its decisions were made deliberately with the owner.

| Piece | Code | Decisions |
|---|---|---|
| Design tokens (color, type, space, glass, score colors) | `design/tokens/` | `design/index.html` (foundations page) |
| Liquid glass, incl. the WebGL compositor over canvases and the backdrop refraction over the page, fixed bubbles switching on scroll so nothing trails | `design/lib/glass.*` | comments in the file; `evaluation-goals.md` (glass sections) |
| Controls: pills, segmented, stepper (rolling digits), popovers and menus (morph from the button, placement fixed at open, follow the button on scroll, close when it leaves, toggle on second click, morphing panels open in the button's place, lists scroll without scrolling the page) | `design/lib/controls.*`, `position.js` | `seasons-locations-goals.md` (popover placement) |
| The fan chart: intervals, observed data, cutoff and reference marks, labels, rulers, misses, context lines, focus, the canvas renderer | `design/lib/chart.js` | `intervals-goals.md` |
| Time navigation: fractional date, spring glides, scrub, side scroll with momentum-tail snap, continuous zoom with season cap, pan with smart return, height zoom, keys, double-click, season timeline swap | `design/lib/time.js` | `time-navigation.md` (every behaviour has a check) |
| Model selection: one selection, five charted with stable color slots, queue-of-five, Show all, baseline as a toggle, families/teams | `design/lib/selection.js`, the picker in `studies/intervals-refine.js` | `models-goals.md` |
| Scoring math: WIS and components, coverage, pairwise relative WIS (rank among every model in scope by default), slices | `design/lib/scores.js` | `evaluation-goals.md` |
| The scores section design: peek, scope line that lifts into a bubble, leaderboard (lollipops, coverage marks, footer header that rides the screen bottom), heatmap, figures (Calibration as coverage − nominal, Horizon, Anatomy), hover linking both ways, cell → chart | `design/lib/evaluation.*` | `evaluation-goals.md` |
| Seasons and places: crossing seasons with keys (a cut), drag never crosses, axis fixed per season and place and eased between, the location bubble (search, recent, US tile map), the date picker (season chips + a calendar of rounds, nothing else per date), one line for models absent from a season or place | `studies/intervals-refine.js`, `lib/fandata.js` | `seasons-locations-goals.md` |

## 5. Prototype: rebuild properly

- **Page wiring.** `studies/intervals-refine.js` is one long file wiring everything by hand. Build real
  components with clear boundaries (at least `FanChart`, `TimeNav`, `ModelPicker`, `LocationPicker`,
  `DatePicker`, `Scores` and its parts, the app shell/chrome) and one app state with URL sync.
- **Data.** The prototype reads files made by `design/data/extract_*.py`. Replace them with `server.py`
  endpoints backed by the existing loaders and `core/` scoring (manifest of seasons, rounds, models,
  metadata, locations; forecasts per season and location; observed data; per-forecast scores per season,
  in a compact binary or columnar form). Numbers must match old viz: add parity tests comparing the new
  leaderboard against old viz's `/api/metrics` and `score_cli.py` for the same scope (watch the log scale,
  common tasks, pooling rules and baseline fallback in `core/evaluation.py` and `core/metrics.py`).
- **Scoring speed.** Scoring runs on the main thread (≈440 ms for three seasons × 61 models). Move it to a
  worker with per-pair prefix sums over rounds so dragging an evaluation window re-scores within a frame
  (`evaluation-goals.md`, "Computing it fast").
- **Metadata** is sample data in places (`SAMPLE_LOCAL`, provenance by regex). Use real metadata and old
  viz's provenance rules (repo / local / hub / synthetic).
- **Tests** are console scripts with workarounds for a hidden browser pane. Make every check runnable
  headless from one command (e.g. Playwright, fixed 1440×900 window, pass/fail exit code), port the existing
  cases (time-nav 48, scores 33, seasons 32, selection 14), and add cases for everything you build.
- **Not finished in the reference** (finish them): the expanded leaderboard row, the + column chooser,
  export, the Dates popover with week range and phase, per-100k rates, URL state, prefetching neighbouring
  seasons, ⌘Z for scope changes, Back after a cell jump, the components page (it still demos the old SVG
  chart), an accessibility pass (keyboard paths and labels exist in places, not audited).
- **Small details are inconsistent**: spacing, type sizes, hover states, focus rings, empty states and
  popover styles vary between pieces. Make one consistent system and apply it everywhere.

## 6. Deliberate changes from old viz (honour these, note them in the parity list)

- No telemetry strip under the chart (the leaderboard's first row is the top performer; the old cells mixed
  cohort and single-model numbers).
- Leaderboard and heatmap are separate sections that **share one scope** (old viz gave the heatmap its own
  location and time controls). Calibration and anatomy are figures comparing every selected model.
- Relative WIS ranks among every model in scope by default; "selected only" (old behaviour) is an option.
  Default sort is relative WIS. Exported rank equals the table's rank.
- The baseline is a visible row and choosable; it never counts toward the five charted.
- The evaluation window is the Dates popover (seasons, phase, week range) with live updates, no
  Apply/Cancel; a stray click never clears the range.
- Definitions live where their setting lives; no Guide/Methodology modal buttons on the page (the
  methodology content still needs a home: e.g. a Methods link in the Metric popover opening a page).
- Generated advice text and calibration status words are dropped (the figures show it).
- The date picker is season chips + a calendar of forecast rounds (old viz's per-date badges and
  surveillance-only weeks were tried and set aside; revisit only with the owner).

## 7. Old viz features with no design yet (design them in this language, then build)

Start by writing `next/PARITY.md`: an exhaustive checklist of old viz, built by reading every file in
`static/` and the relevant backend. Group by area; one line per feature, with its new home and status.
Nothing is done until its line is checked and tested. Expect at least:

- **Global**: target switch (Flu Hosp inc / ED Visits prop, and what changes with rate targets), location
  quick picks, reference date, theme, presentation mode, share link, copy CLI, toasts, Escape order.
- **Fan chart panel**: PI levels (95/80/50) menu, width rulers, indicators and their modes/palettes (URL
  `indicators`, `ind_mode`, `ind_palette`), the view-mode switch between chart, spatial map, heatmap and
  season peak.
- **Spatial map**: model, layer (rate, admissions, trend, WIS error, peak week, peak size), horizon, play
  animation, state inspector with badges, the insight strip, h=0 notice.
- **Heatmap**: all row/column permutations, metrics by context (including observed and single-model
  forecast metrics), model and horizon pickers, Display (sort, scale, palette, invert), region dividers,
  non-reporting tray, data inspector, empty/error states.
- **Season peak**: peak outlook, peak call by round, this-round and season-skill scorecards, provisional vs
  final, all notices.
- **Leaderboard**: every column (tasks, wins, Δ% vs baseline, WIS/100k, MAE, coverage 50/80/95, sharpness,
  h0–h3, model type badges, 7-quantile badge), log scale, common tasks, small-sample guards, inactive and
  pending rows with their reasons, validation warnings.
- **Diagnostics**: error anatomy, calibration (reliability, MCE), horizon decay.
- **Evaluation window**: seasons (multi, follow vs pinned), phase, week brush.
- **Models**: model bar features (search, family filter, season filter, select all/clear, hub shelves,
  designated only, "this round"), model detail (coverage & schedule tiles, methods, data specs).
- **Ensemble studio**: builder (method, routing, missing policy, constituents, preflight audit), active
  ensembles, save to local-output, delete.
- **Data sources**: brand menu, live hubs (check, sync, cancel, seasons to sync, quality notes, connect
  another hub, remove), unsynced-models toast on shared links.
- **Exports**: CSV, TSV, XLSX with the same columns and filename scheme; plus chart images (old viz lacked
  them).
- **State**: every URL parameter old viz reads, plus everything the new design adds (selection, charted
  five, scope, window, sort, heatmap axes, expanded rows, location, date).

## 8. How to work

1. Read `design/README.md`, then the docs in `design/studies/` (intervals, time-navigation, models,
   evaluation, seasons-locations, performance), then old viz end to end.
2. Write `next/PARITY.md` and `next/ARCHITECTURE.md` (components, state, data contracts, endpoints, test
   plan) before building.
3. Build in phases, committing as you go, each phase leaving `/next/` working and every check green:
   shell, state and data layer → fan chart, time, seasons, places, model picker → scores (leaderboard,
   heatmap, figures, window) → the undesigned views in §7 → exports, URL, polish → consistency pass.
4. For each undesigned piece, write a short goals section (like the docs in `design/studies/`) in
   `next/design/`, then build it.
5. Run every check after every change. Keep `PARITY.md` current.

Done means: every `PARITY.md` line is checked and tested, numbers match old viz, `/next/` works with the
real hub data across all seasons and locations, old viz is unchanged, and the docs say how to run and test
everything.
