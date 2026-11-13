# Evaluation: goals and design

What the evaluation part of the page is for, what has to be true for it to be good, and the design that
follows. Same approach as `intervals-goals.md` and `models-goals.md`. Nothing here is built yet.

## The premise: paper and bubbles

The page is paper. The fan chart is printed on it, and the scores continue on the same paper below it,
in the same line language: hairlines, thin lines, small dots, tabular numbers, no boxes, no cards, no
fills larger than a cell. Glass bubbles float on top of the paper and hold the controls. A bubble
appears only while the thing it controls is on screen or applies.

1. **Evaluation is not a menu.** You scroll down to it. It's never a modal or tab, and it never covers
   the chart. The settings that change the numbers are the numbers' own label (the scope line).
2. **Chart colors stay on the chart.** Evaluation doesn't repeat the fan chart's color identity. A charted
   model is marked only by the same small color dot beside its name, so you can find it; every line and
   mark in the scores is ink.
3. **Color in the scores is for scores, used sparingly.** A few columns where better/worse is the point
   (relative WIS, change vs baseline, coverage) and the heatmap cells get a diverging color. Everything
   else is ink. The numbers themselves stay in text ink; the color sits on a mark beside or behind them.

## Who reads scores, and what they ask

The same three people as the picker (modelers, evaluators, analysts), with different questions:

1. **"Which models beat the baseline, and by how much?"** One number per model (relative WIS), ranked,
   with the baseline as a visible reference.
2. **"Is that consistent, or driven by a few weeks or places?"** Breakdowns by week, location, horizon.
3. **"Are its intervals honest?"** Coverage and calibration.
4. **"Why does it lose: spread, or bias?"** WIS split into dispersion, over- and under-prediction.
5. **"Why was it bad there?"** Jump from a bad week or place straight to that forecast on the chart.
6. **"Over what, exactly?"** Seasons, weeks, locations, horizons, how many forecasts. Scores mean nothing
   without their scope, so the scope is always on screen beside them.
7. **"Can I take this with me?"** Export, copy the command that reproduces it, link to it.

## Many seasons

Prototypes so far use one season; production has several, in the fan chart and in evaluation.

- **Evaluation can span seasons**: one, several, or all, with the same week range and phase applied to
  each (old viz's rule).
- **By default the scope follows the chart's season**: step the chart into 2024–25 and the scores move to
  2024–25. Picking seasons in the Dates popover pins them; Reset returns to following.
- **Models active only in some seasons** are listed but unranked when the scope has none of their
  forecasts ("2024–25 only").
- **Data loads per season.** Adding a season shows a thin progress hairline under the scope line and
  dims the numbers until it's in; nothing else moves.
- **The fan chart across seasons** (stepping past a season's last week, the full-season zoom when
  seasons differ in length, the date picker) is its own time-navigation topic, next after this one.

## What old viz does, and where each piece goes

Old viz (inventoried Nov 13, 2026) has, under the chart, a four-cell "telemetry" strip and a tabbed panel
(Leaderboard, Error Anatomy, Calibration, Horizon Decay) with a scope toolbar; heatmap, map and season
peak are alternate modes of the chart panel. Its useful logic is kept; its structure is not.

| Old viz | Here |
|---|---|
| Telemetry strip (top performer, cohort mean WIS, the *top model's* coverage and MAE) | **Dropped.** The leaderboard's first row is the top performer; the other cells mixed cohort and single-model numbers under similar labels. |
| Leaderboard tab, 17 columns | **Leaderboard**: 5 default columns, the rest optional |
| Heatmap view (rows × columns × metric) | **Heatmap**, its own section under the leaderboard, same permutations, sharing the scope |
| Error Anatomy tab (bars, cards with advice text, bias badges) | **Anatomy** figure + a component bar in each expanded row. No generated advice text. |
| Calibration tab (reliability diagram, scorecard, status words) | **Calibration** figure; coverage columns. Status words dropped (the curve shows it). |
| Horizon Decay tab (grouped bars) | **Horizon** figure (lines); h0–h3 as optional columns |
| Season peak scorecard | **Peaks**, only for targets with peak forecasts |
| LOC: Current / All States (leaderboard and heatmap each had their own) | scope line: **Locations**, one for everything |
| TIME: Date / Season ▾ (seasons, phase, brush) (heatmap had its own) | scope line: **Dates**, the same popover, one for everything |
| SCALE: Natural / Log | Metric popover |
| Common Tasks ON/OFF | Metric popover: **Shared forecasts only** |
| Export ▾ + nav "Copy CLI" + "Share" | scope line: **↓**, one menu |
| ⓘ definition popovers, Guide modal | definitions inside the popover of the setting they explain; a "Methods" link in the Metric popover |
| Validation warnings pill and modal | the ⋯ bubble shows a count; affected rows carry a glyph |
| Model Detail modal | the expanded leaderboard row |
| Ensemble Studio modal | the picker ("Combine" on the selection); out of scope here |
| Brand menu, live hubs modal | the ⋯ bubble |
| Target switch (Flu Hosp / ED Visits) | a **Target** bubble, only when more than one target exists |

Fixed on the way: one scope for every section (old heatmap and leaderboard disagreed on location and
time); default sort by relative WIS (old table sorted by raw WIS while the server ranked by relative
WIS); exported rank equals the table's rank; diagnostics follow the table's scope, scale and sort; the
baseline is visible and choosable; the whole scope is in the URL.

## Page anatomy, top to bottom

```
┌──────────────────────────────────────────────────────────────┐
│ (Models) (US)                                       (◐) (⋯) │  ← fixed glass bubbles
│                        fan chart                             │  ← 100svh − peek
│ (Rulers) (Misses)        (‹ Dec 27 ›)                        │  ← chart bubbles, scroll away
├──────────────────────────────────────────────────────────────┤
│ Relative WIS · All states · 2025–26 · 0–3 wk              ↓  │  ← scope line (the peek)
│                                                              │
│      Rel. WIS              WIS    50%   95%            +     │
│  1 ● flusion       0.71 ──●|        212    48    93          │  ← leaderboard
│  2   gbqr_4src     0.78  ─●|        231    52    95          │
│  …   Baseline      1.00    ●        297    41    88          │
│                                                              │
│ Models × Weeks · Rel. WIS                              ⇄     │  ← heatmap, its own line
│ flusion     ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪                         │
│ gbqr_4src   ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪                         │
│                                                              │
│  Calibration       Horizon        Anatomy                    │  ← figures
└──────────────────────────────────────────────────────────────┘
```

### 1. The fan chart, with a peek

- The chart takes the viewport height minus a **peek** (about 44 px) that shows the scope line: the only
  hint that more is below, and useful on its own. No "scroll for more", no arrow.
- On short windows (chart under 480 px) the chart keeps 480 px and the peek goes.
- The chart's own bubbles (Rulers, Misses, date stepper, Recenter, Show-all note) are anchored to the
  chart: they scroll away with it.

### 2. The scope line

One line of fragments, each a button opening a popover (the same morph as every control):

**Relative WIS · All states · 2025–26 · 0–3 wk** &nbsp; ↓

| Fragment | Popover | Default |
|---|---|---|
| **Metric** | Relative WIS / WIS / MAE · Natural / Log · Shared forecasts only · Baseline (which model) · Rank among (selected / every model in scope) · Methods → | Relative WIS, natural, off, the hub baseline, every model |
| **Locations** | All states · US · the chart's location (follows it) · a custom set: tile map + search | All states |
| **Dates** | the evaluation window, below | the chart's season, every observed week |
| **Horizons** | 0 · 1 · 2 · 3, four toggles (one always stays on) | all four |
| **↓** | Scores CSV · TSV · XLSX · Chart PNG · Copy link · Copy command | — |

- It's the title of everything below it and its settings at once. There's no other heading.
- Scrolling past it, it **lifts into a glass bubble** at the top centre, so the scope stays beside every
  number. Scrolling back up, it settles onto the paper. Same text, same buttons; only the material
  changes (a 200 ms crossfade of the glass, the text doesn't move).
- A fragment that differs from its default is primary ink; defaults are secondary. You can tell at a
  glance whether this is the standard view.
- Changes apply live; ⌘Z undoes the last scope change. When a narrowing leaves nothing scored, the
  fragment responsible gets a warning underline.

**Locations pool the way old viz pools:** if any state is in scope, headline numbers use states only (the
national forecast isn't counted twice). "All states" means the 52 non-US jurisdictions; "US" scores the
national forecast alone.

**Rank among.** Old viz ran the pairwise tournament among only the selected models (plus a hidden
baseline), so adding a model changed everyone else's relative WIS. The default here is **every model with
forecasts in scope**, so a model's number doesn't depend on what else you picked. "Selected only" stays
as an option, for reproducing old numbers.

### 3. The Dates popover (the evaluation window)

Old viz's window popover was right to be a popover; this keeps its structure and redraws it:

- **Seasons**: one chip per season, multi-select, plus All. While following the chart, the chart's season
  is selected and marked as following; picking chips pins them. Reset returns to following.
- **Phase**: Full · Pre-peak · Peak · Post-peak (peak computed per location, as before).
- **The season chart**: each selected season's observed curve on a shared week-of-season axis (newest
  strongest, older lighter), months labelled, in the chart's observed ink. The window is a range on it:
  drag to draw, drag edges to resize, drag inside to move, double-click for every week. Weeks not yet
  observed are dotted. The chart's current date is the same ref mark as on the chart. Under Peak, the peak
  weeks show as a hairline bracket.
- **Readout**: "Nov 22 – Mar 7 · wk 17–31", or "All weeks".
- No Apply or Cancel: the scores update live behind the popover while you drag (rows reorder once, on
  release). Escape or clicking outside closes it, keeping the change; Reset undoes it.
- The fragment reads what was chosen, as briefly as possible: "2025–26", "2025–26 · Nov 22 – Mar 7",
  "3 seasons · Peak", "All seasons".
- Keyboard: Tab to the range; ← → move it, shift ← → resize it (arrow keys here don't step the chart).

### 4. The leaderboard

| Column | Shows | Notes |
|---|---|---|
| Rank | position | faint mono; only when sorted by a score; ties share a number |
| Name | color dot (charted only), short name, team muted | ellipsis, full name on hover; click to expand |
| Rel. WIS | 0.71 + lollipop | a stem from a hairline at 1.00 to a dot on a shared log axis, left is better. **Colored**: the stem and dot take the diverging score color. |
| WIS | 212 | absolute, so a ratio is never read without its size |
| 50% · 95% | coverage, percent | the header carries the target. **Colored**: a small mark beside the number, by distance from target (close neutral, under warm, over cool). |

Optional columns, from a quiet **+** at the end of the header row (a checklist): **Forecasts** (scored, of
possible), **Wins**, **vs baseline** (% change, direct; colored like Rel. WIS), **WIS / 100k**, **MAE**,
**Sharpness**, **80%**, **MCE**, **h0–h3** (relative WIS per horizon; colored). Remembered per person and
in the URL.

- **The color dot** is the only trace of the chart's colors: it's there if the model is on the chart, so
  you can find your five. Clicking it takes the model off the chart; there's no empty circle on other
  rows (charting from here is a hover action: a faint circle appears in the dot's place on row hover).
- **The baseline is a row**, in tertiary ink, at exactly 1.00, sorted with everyone else. Always present;
  the picker's Baseline toggle only controls the fan chart.
- **Sort** by clicking a header. Default: Rel. WIS, best first. Coverage sorts by distance from target.
  Name A–Z. Clicking the active header reverses. Unranked rows always come last, after a hairline.
- **Row height** 28 px; the header row sticks under the scope bubble.

#### Expanding a row

Click a name: the row opens in place on the soft spring, showing:

- **Anatomy**: dispersion, over- and under-prediction as one thin stacked bar per horizon.
- **Coverage curve**: empirical vs nominal at every level, against the diagonal; the baseline in grey.
- **Locations**: a US tile grid in the score colors; click a tile to see it on the chart.
- **Submissions**: one tick per round across the scoped seasons (full / partial / missing); click to go.
- **Facts**: provenance, team, family, quantiles (7 or 23), license, methods (from metadata).

More than one row can be open; Escape closes the most recent. Open rows survive scope changes.

### 5. The heatmap

Its own section, because its permutations don't fit inside a table row. It has its own line on the
paper, in the scope line's style, every fragment a button:

**Models × Weeks · Rel. WIS** &nbsp; ⇄

| Fragment | Choices |
|---|---|
| Rows | Models · Locations · Weeks · Horizons |
| Columns | what's valid for the rows (as old viz: models → horizons, locations, weeks; locations → weeks, models; weeks → locations, models; horizons → models) |
| Metric | depends on the axes: with models on an axis, Rel. WIS · WIS · WIS / 100k · MAE · 95% coverage · Sharpness; with one model chosen, also its forecast and error; with no model, observed rate, admissions, trend |
| Model | only when models aren't an axis: one selected model, or Observed |
| Horizon | only when horizons aren't an axis |
| ⇄ | swap rows and columns |
| Display (in the Metric popover) | Sort (rows: score, A–Z, region, population, peak timing) · Scale (none, per-row) · Palette |

- **It follows the scope line**: same locations, seasons, window and horizons. No second LOC/TIME.
  Weeks across several seasons are columns with a wider gap at each season break.
- Cells: 2 px gaps (paper shows through), no outlines. Diverging scores (relative WIS, coverage error)
  use the diverging pair; magnitudes (WIS, admissions) use one sequential hue. No rainbow palettes; the
  palette choice is between validated ramps.
- Row labels on the left in ink, with the charted color dot; column labels on top, every one shown when
  they fit, otherwise every Nth and the rest on hover. The chart's current week is outlined, so ← → walk
  across it too.
- Empty cells (no forecast): blank. Not yet observed: dotted outline. Inactive models: after a hairline at
  the bottom, as in the leaderboard.
- Hover a cell: a readout like the chart's (slice, value, the baseline's, observed). **Click a cell: show
  it on the chart**: sets the chart's date and location, charts the model if needed, focuses it, scrolls
  up. Back returns to the cell.
- Rows: 20 px, virtualized past a screenful; cells drawn on one canvas.

### 6. Figures

Small figures in the chart's line language, each titled with one word:

- **Calibration**: coverage at every nominal level (10–98%) per model, the diagonal as a hairline.
- **Horizon**: relative WIS at each horizon (0–3) per model, a hairline at 1.00.
- **Anatomy**: each model's WIS as one thin stacked bar (spread, over, under), sorted like the
  leaderboard; "Anatomy · share" toggles absolute / share.
- **Peaks** (only when the target has season-peak forecasts and the season has peaked or is
  provisional): its own study; old viz's peak view is the content reference.

Lines are ink. With many models the lines are faint; **hovering a leaderboard row or a line** brings that
model to full ink and names it at the line's end. **Expanded rows stay emphasized** in every figure, with
their names at the line ends (and their color dot, if charted). So the figures compare the rows you
opened against the field, without needing a color per model.

## Floating bubbles: what's there, and when

| Bubble | Where | Shown |
|---|---|---|
| Models | top left | always |
| Location | top left | always: the chart's location (the scope line has its own) |
| Target | top left | only when the data has more than one target |
| Scope | top centre | once the scope line scrolls under the top |
| Theme | top right | always |
| ⋯ | top right | always: data sources and hubs, sync, truth date, validation warnings (a count on the bubble only when there are any) |
| Date stepper | chart, bottom centre | with the chart; scrolls away |
| Rulers, Misses | chart, bottom left | with the chart; scrolls away |
| Recenter, Showing 5 of 12 | chart | as now |

Nothing else floats over the scores. Sorting, columns, the heatmap's axes and row expansion are on the
paper. There's no Guide button.

### Which buttons open menus

A control opens a popover only when it has more than two choices or needs explaining.

| Control | Acts in place | Opens |
|---|---|---|
| Column header | sort / reverse | — |
| Color dot / hover circle | chart / unchart | — |
| Model name | expand / collapse | — |
| Heatmap cell | go to the chart | — |
| ⇄ | swap axes | — |
| Horizons | — | four toggles |
| Metric, Locations, Dates | — | popover |
| Heatmap rows, columns, metric, model | — | small list |
| + | — | column checklist |
| ↓, ⋯ | — | menu |

## Linking the chart and the scores

- **Hover** a leaderboard row, heatmap row or figure line: if the model is charted and the chart is on
  screen, it previews there as hovering its label does. Hovering a model on the chart highlights its
  leaderboard row. (Settles the open question in `models-goals.md`.)
- **← →** step the chart's date from anywhere on the page except text fields and the Dates range. The
  heatmap's current-week outline moves with it. If the scope follows the chart's season, crossing into
  another season changes the scope too.
- **↑ ↓** scroll the page, unless a leaderboard row has focus; then they move between rows (Enter
  expands, Space charts).
- **Vertical scroll scrolls the page everywhere, including over the chart.** The chart ignores
  mostly-vertical scrolls already; side scroll, pinch, ⌘ and shift keep their chart meanings. Shift +
  vertical scroll is height zoom only over the chart.
- **The picker** still opens while scrolled to the scores; the scores narrow to the right half (a
  container query, so it's free).

## Resizing

Container queries on the section's own width, never the window's.

| Width | Leaderboard | Heatmap | Figures |
|---|---|---|---|
| ≥ 1280 | all chosen columns | cells as wide as fit, min 6 px | three across |
| 960–1280 | lollipop narrows (min 96 px) | labels thin out | two across |
| 720–960 | lollipop hidden (number stays, colored mark stays) | row labels truncate at 120 px | one across |
| < 720 | optional columns hidden | scrolls sideways inside its own block, row labels pinned | one across |

- Names: 140–280 px, ellipsis, never wrap. Numbers never truncate, sized to their widest value in tabular
  figures so they don't jitter while values change.
- Resizing never reorders, re-sorts or collapses anything.

## Score colors

- **One diverging pair: blue · orange** (chosen Nov 13, 2026, from the study below), as tokens
  `--score-1` (better) … `--score-5` (same as baseline / on target) … `--score-9` (worse), with their own
  light and dark steps. Cool for better (or intervals too wide), warm for worse (or too narrow). Not green/red,
  and not equal to any series color, so a scored mark is never mistaken for a charted model.
- **One sequential hue** for magnitudes in the heatmap.
- Both validated with the dataviz validator against both surfaces, light and dark chosen separately.
- Clamped at ½× and 2× (log scale), so one disaster doesn't wash out the rest; the readout shows the real
  value.
- Where: Rel. WIS lollipop, vs baseline, h0–h3, coverage marks, heatmap cells, the expanded row's tile
  map. Nowhere else.

## Edge cases

- **Partial submitters.** Relative WIS is pairwise on shared forecasts (Cramer et al.), so missing weeks
  don't bias it. A small partial-circle glyph by the name, filled to the fraction submitted; hover:
  "18 of 28 weeks".
- **Shared forecasts only, with disjoint models** (different seasons): nothing in common. Numbers show
  "–", the Metric fragment gets the warning underline, and the only words are "No shared forecasts ·
  Score each on its own", the second part a link that turns the option off.
- **Small samples** (fewer than 10 forecasts): numbers in tertiary ink with the count beside them. No
  banner.
- **No forecasts in scope** (other season, a location it doesn't cover, awaiting truth): after the
  hairline, unranked, "–", a glyph whose hover says why ("2024–25 only", "no Alaska", "awaiting truth").
- **Window over unobserved weeks only.** Numbers "–"; the Dates fragment gets the warning underline.
- **Partly observed recent rounds.** Scored on the horizons observed so far; those heatmap cells at reduced
  strength until complete.
- **Baseline has no forecasts in scope.** Relative WIS rescales to the fallback (old viz's rule); the
  Metric fragment reads "Relative WIS · vs ensemble" in primary ink; the ⋯ warning count goes up.
- **Near-zero baseline WIS** (a small state off-season): color clamps; the readout shows both numbers.
- **7-quantile models**: a "7Q" glyph; coverage other than 50/80/95 shows "–".
- **No models selected.** The baseline row and a ghost row, "Add models", that opens the picker.
- **140 models, several seasons.** Leaderboard and heatmap virtualized; scores computed in a worker;
  figures draw 140 faint lines.
- **Ties.** Same rank, then by name.
- **Rate targets.** No WIS / 100k; 3 significant figures under 1.
- **Truth revisions.** Scores use the truth as of the date in the ⋯ bubble.

## Computing it fast

- Per-forecast WIS, components and coverage flags in typed arrays (model × round × location × horizon),
  loaded per season, scored in a worker.
- For each scope (locations, horizons, shared-only, scale), per-model and per-pair prefix sums over rounds
  are built once; any window is then a lookup, so dragging the range re-ranks 140 models within a frame.
- Rows are DOM (selectable, accessible); lollipops and heatmap cells are canvas.

## Text on screen

Every word on the scores section labels something visible: the scope line, the heatmap's line, column
headers, model names, figure titles, and two edge-case phrases ("Add models", "No shared forecasts ·
Score each on its own"). Definitions live in popovers and tooltips.

## Studies before building

1. **Score colors**: two or three diverging pairs plus a sequential hue, through the validator, on the
   leaderboard and heatmap in both themes.
2. **Scope lift**: the paper-to-glass transition and the sticky header under it.
3. **Dates popover** with three seasons of real data.

## What "good" means (testable)

- From any score on screen, you can tell its seasons, weeks, locations and horizons without scrolling.
- Your charted models can be found in a 140-row leaderboard at a glance (the dot).
- Any bad heatmap cell gets you to the forecast behind it in one click.
- Leaderboard and heatmap never disagree about scope.
- Adding a model to the selection doesn't change anyone else's relative WIS (default ranking).
- Dragging the window re-scores within a frame; rows reorder once, on release.
- Nothing floats over the scores except the global bubbles and the scope.
- Resizing from 1600 to 700 px never truncates a number or reorders a row.
- A shared link reproduces scope, window, seasons, columns, sort, heatmap axes and expanded rows.
- Every old viz evaluation feature has a home (the table above) or a stated reason it's gone.

## Prototype status (Nov 13, 2026)

**Data.** `data/extract_scores.py` scores every forecast in the hub (three seasons: 2023–24, 2024–25,
2025–26; 40–57 models each) into `data/scores.json` + one binary per season (WIS, its three components,
coverage at 11 levels, state). Not committed (15 MB); regenerate with
`viz/.venv/bin/python design/data/extract_scores.py . design/data` from the hub root (about a minute).
Its WIS matches the earlier `core.json` exactly; components sum to WIS.

**Scoring.** `lib/scores.js`: scope → rows (forecasts scored, WIS, components, coverage, pairwise relative
WIS, relative WIS per horizon, status), and heatmap slices (weeks, locations, horizons). Shared-only,
rank among all / selected, baseline fallback and states-only pooling as specified. Speed on the main
thread: one season 40 ms, three seasons × 61 models 65 ms in node and about 440 ms in the browser pane.
That's fine for the study, not for live window dragging: the worker and per-pair prefix sums (Computing it
fast) are still to do.

**Score color study** (`studies/scores.html`; decided: blue · orange, now the `--score-*` tokens, and the
study page uses them): the leaderboard (rank, name with the charted dot, Rel. WIS
with a colored lollipop, WIS, 50% and 95% with colored marks, sort by header) and the heatmap (models ×
weeks / locations / horizons, season breaks, hover readout) on real data, with a working scope line
(metric options, locations, seasons, horizons). Three diverging candidates, switchable, both themes:

| Candidate | Poles (light / dark) | Validator |
|---|---|---|
| Blue · orange | `#0267c7` `#b13f00` / `#4b92ea` `#d7712e` | poles pass all checks both modes; CVD ΔE ≥ 24 |
| Blue · red | `#006ac5` `#b63039` / `#3c95e8` `#dd6666` | poles pass all checks both modes |
| Violet · amber | `#6b50c2` `#a44f00` / `#917ee5` `#c97d00` | poles pass all checks both modes |

Each ramp is 9 steps made in OKLCH (4 per arm, grey middle); the inner steps fail the categorical chroma and
contrast checks by design (they recede toward "same as baseline"), which the validator docs say is expected
for diverging ramps. Not built yet: the expanded row, the + column chooser, export, the Dates popover with
the week range, the page under the fan chart, the scope lift.

### The scores under the chart (Nov 13, 2026)

Built on the fan chart page (`studies/intervals-refine.html`), with the section in `lib/evaluation.js` and
`lib/evaluation.css` (the score study page now mounts the same module):

- **The page scrolls.** The chart is the first screen minus a 52 px peek that shows the scope line
  (minimum 480 px tall). Vertical scrolling over the chart scrolls the page; side scroll, pinch, ⌘ and
  shift keep their chart meanings (the chart already ignored mostly-vertical scrolls).
- **Bubbles.** Back, Models and Theme are fixed to the screen. The chart's own bubbles (Rulers, Misses,
  the date) scroll with it and fade out as they reach the top bubbles, rather than sliding under them.
- **Glass over paper is frosted.** A fixed bubble refracts the chart (the WebGL pass) while it's over the
  chart; once it's over the page below, the compositor skips it and CSS frosts it (`lg--paper`). The
  scope bubble is frosted from the start: it's only ever over the page.
- **The lift.** When the scope line passes under the top bubbles, it fades out and the same fragments fade
  in as a frosted bubble at the top centre (both are live buttons). The leaderboard's header sticks just
  below the bubbles.
- **Links.** Hovering a leaderboard or heatmap row previews a charted model on the chart (while some of
  the chart is on screen); hovering a model on the chart lights its row. The dot on a row charts the
  model (the same queue of five). A heatmap cell: moves the chart to that week (when it's one of the
  chart's weeks), charts and focuses the model, and scrolls up to it. The chart's current week is outlined
  in the heatmap and follows ← →.
- **Seasons follow the chart**: the scores start on the chart's season (2025–26 here).
- **The picker** still opens while you're down in the scores, and the scores slide right to make room.

Checks: `tests/scores-check.js` (page behaviour: scrolling, lift, frosted glass, links), alongside
`tests/time-nav-check.js` and `tests/selection-check.mjs`.

Not built yet: the expanded row, the + column chooser, export, the Dates popover with a week range,
Locations as a heatmap → chart link (the prototype chart only has US forecasts), Back returning to the
cell after a jump, the worker for live scoring, ⌘Z for scope changes, the URL.
