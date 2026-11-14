# Rebuild viz in the new design: brief

You are building the new frontend of **viz**, the forecast evaluation dashboard in this repository. The
aim is not to tidy up a prototype. It is to make something great: every feature of old viz, in one
cohesive design, working on real hub data.

## 1. What exists, and how much to trust it

| | What it is | How to treat it |
|---|---|---|
| **Old viz**: `server.py`, `core/`, `remote/`, `static/`, `docs/`, `tests/` | The product today. Python backend and scoring, Plotly frontend. | The source of truth for **features and numbers**. Not for look or structure. |
| **The fan chart page**: `design/studies/intervals-refine.html` with `design/lib/chart.js`, `time.js` | A prototype the owner iterated on and likes the look of. | The source of truth for **how the product should look and feel**. Its appearance is the anchor for everything else. Its behaviour was not fully thought out: rethink it, finish it, and make it work everywhere. |
| **The decision docs**: `design/studies/*.md` | What was tried, what was chosen, and why. | Intent and reasoning. Keep what holds up on real data and in a complete product; change what doesn't, and record the change (§7). |
| **The rest of `design/`**: tokens, glass, controls, the scores section, components pages, tests | Built quickly. Uneven polish, inconsistent details. | A **rough guide**. Read it for ideas and for hard-won solutions (the canvas renderer, the glass compositor, the time-navigation math, pairwise scoring). Do not copy it wholesale or inherit its inconsistencies. |

Nothing in `design/` is "final". Code from it may be reused where it is good, but everything that ships
in the new frontend meets one standard and belongs to one system.

## 2. The goal

- A new frontend in `next/`, served at `/next/` by the same server, **beside** old viz. Old viz keeps
  working exactly as now: do not change `static/`, existing endpoints, or `core/` behaviour. New
  endpoints go in beside the old ones.
- **Every feature of old viz is ported**: every view, control, option, metric, column, export, URL
  parameter, modal, keyboard behaviour, empty state, warning and edge case. Nothing is dropped silently.
  What was deliberately changed is listed in §5.
- **Real data from the start.** The server reads the hub this repository sits inside (the parent folder
  of the main checkout: `model-output/`, `target-data/`, `model-metadata/`, …). No extracted prototype
  files (`design/data/`), no sample metadata. Every number matches old viz for the same scope.
- **Desktop only.** Mobile comes later, separately.
- **No build step** (assumption, in keeping with the product: Python only, nothing to compile). Plain ES
  modules and vendored libraries. Node is allowed for development tooling only (headless tests).

## 3. What "great" means here

1. **Cohesion.** One system, defined once and used everywhere: color, type scale, spacing, radii,
   line weights, motion, focus rings, hover and pressed states, popovers and menus, empty and loading
   states, number formatting, copy style. If two pieces solve the same problem, they solve it the same
   way. A new view should be recognisable as this product from any 200 px crop.
2. **Attention to detail.** Alignment to the pixel, tabular numbers that don't jitter, nothing that pops,
   flashes, trails or shifts layout, no half-finished states. Look at everything you build, in both
   themes, at 1440×900, with real data, including the awkward cases (140 models, a tiny state, a season
   boundary, a model with no forecast).
3. **Function wins every tie**, but it should look exceptional, not merely tidy.
4. **Fully thought out.** Every control has a defined behaviour in every state the data can produce.
   If the prototype left a question open, answer it rather than carrying the gap forward.

### The design language (from the owner; kept)

- **Paper and bubbles.** The page is paper: charts and scores are printed on it in thin lines, hairlines
  and tabular numbers, with no cards, boxes or heavy fills. Controls float on top as liquid glass
  bubbles, and a bubble appears only while what it controls is on screen or applies. Prefer page
  sections and popovers to modals; prefer controls that are the labels of what they control.
- **Glass is one material**, identical over the chart and over the page.
- **Color has jobs.** Series colors identify the (up to five) charted models and nothing else; elsewhere
  a charted model shows only its small color dot. Score colors (blue · orange) mark better/worse,
  sparingly. Everything else is ink. Never green/red for scores.
- **Concise copy.** Short fragments joined with " · ". No instructional sentences on screen;
  explanations live in popovers, tooltips and aria labels.
- **Motion** is quick and critically damped. No bouncy springs.
- **Performance is not traded for form.** Frames stay well under budget with 100+ models and several
  seasons.
- **Old behaviour keeps working.** After every change, re-run the checks and add a case for what you
  built.

## 4. What the prototype leaves to do

- **Structure.** The prototype page is one long hand-wired file. Build real components with clear
  boundaries, one app state, and URL sync.
- **Data.** New endpoints backed by the existing loaders and `core/` scoring: a manifest (seasons,
  rounds, models, metadata, locations, targets), forecasts per season and location, observed data,
  per-forecast scores per season in a compact form. Parity tests compare the new leaderboard with
  `/api/metrics` and `score_cli.py` (log scale, common tasks, pooling rules, baseline fallback).
- **Scoring speed.** Off the main thread, fast enough that dragging an evaluation window re-scores
  within a frame.
- **Tests.** Every check runs headless from one command with a pass/fail exit code. The prototype's
  cases (time navigation, scores, seasons, selection) are the starting list of behaviours to cover.
- **Unfinished in the prototype**: the expanded leaderboard row, the column chooser, export, the Dates
  popover (seasons, phase, week range), per-100k rates, URL state, prefetching, undo for scope changes,
  Back after a cell jump, an accessibility pass.

## 5. Deliberate changes from old viz (keep, and note in the parity list)

- No telemetry strip under the chart; the leaderboard's first row is the top performer.
- Leaderboard and heatmap are separate sections that share **one scope**. Calibration, horizon and
  anatomy are figures comparing every selected model.
- Relative WIS ranks among every model in scope by default; "selected only" (old behaviour) is an
  option. Default sort is relative WIS. Exported rank equals the table's rank.
- The baseline is a visible, choosable row and never counts toward the five charted.
- The evaluation window updates live, with no Apply/Cancel.
- Definitions live where their setting lives; the methodology content still needs a home.
- Generated advice text and calibration status words are dropped.
- The date picker is season chips plus a calendar of forecast rounds.

## 6. Old viz features with no design yet

Design each in the same language, then build it. Expect at least:

- **Global**: target switch (and what changes with rate targets), location quick picks, reference date,
  theme, presentation mode, share link, copy CLI, toasts, Escape order.
- **Fan chart**: PI levels (95/80/50), width rulers, surveillance indicators with their modes and
  palettes, the switch between chart, spatial map, heatmap and season peak.
- **Spatial map**: model, layers (rate, admissions, trend, WIS error, peak week, peak size), horizon,
  play animation, state inspector, insight strip, notices.
- **Heatmap**: all row/column permutations, metrics by context, model and horizon pickers, display
  options, region dividers, non-reporting tray, data inspector, empty and error states.
- **Season peak**: peak outlook, peak call by round, scorecards, provisional vs final, notices.
- **Leaderboard**: every column, log scale, common tasks, small-sample guards, inactive and pending
  rows with reasons, validation warnings.
- **Diagnostics**: error anatomy, calibration (reliability, MCE), horizon decay.
- **Evaluation window**: seasons (multi, follow vs pinned), phase, week brush.
- **Models**: search, family and season filters, select all/clear, hub shelves, designated only, "this
  round"; model detail (coverage and schedule, methods, data specs).
- **Ensemble studio**: builder, preflight audit, active ensembles, save, delete.
- **Data sources**: live hubs (check, sync, cancel, seasons, quality notes, add, remove), unsynced-models
  notice on shared links.
- **Exports**: CSV, TSV, XLSX with the same columns and filenames, plus chart images.
- **State**: every URL parameter old viz reads, plus what the new design adds.

## 7. How to work

1. **Inventory and plan first.** Read old viz end to end and write `next/PARITY.md` (one line per
   feature, its new home, its status) and `next/ARCHITECTURE.md` (components, state, data contracts,
   endpoints, test plan).
2. **Foundations before features.** Define the system (§3.1) once, in `next/`, and build everything
   from it.
3. **The fan chart first, on real data**, in the real shell: all seasons, all locations, the model
   picker, time navigation. It must look at least as good as the prototype and be complete. **Show it to
   the owner before going broad**; it sets the bar for the rest.
4. Then scores (leaderboard, heatmap, figures, window), then the undesigned views (§6), then exports,
   URL state, and a final consistency pass across the whole product.
5. **Look at what you build.** Run the server against the real hub and check each piece in the browser.
   A feature is done when its `PARITY.md` line is checked, it has a test, and it has been looked at.
6. **Decisions.** The owner is available at milestones, not for every detail. Where a design question is
   open, choose what best fits §3, record it with the alternatives in `next/DECISIONS.md`, and keep
   going. Bring the ones that change the product's shape to the owner.
7. Commit in phases; each leaves `/next/` working and every check green.

Done means: every `PARITY.md` line is checked and tested, numbers match old viz, `/next/` works on the
real hub across all seasons and locations, old viz is unchanged, and the docs say how to run and test
everything.
