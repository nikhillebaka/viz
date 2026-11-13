# Evaluation: goals and design

What the evaluation part of the page is for, what has to be true for it to be good, and the design that
follows. Same approach as `intervals-goals.md` and `models-goals.md`. Nothing here is built yet.

## The premise: paper and bubbles

The page is paper. The fan chart is printed on it, and the scores continue on the same paper below it,
in the same line language: hairlines, thin medians, small dots, tabular numbers, no boxes, no cards,
no fills larger than a cell. Glass bubbles float on top of the paper and hold the controls. A bubble
appears only while the thing it controls is on screen or applies.

Two consequences shape everything else:

1. **Evaluation is not a menu.** You scroll down to it. It's never a popover, sheet, modal or tab, and it
   never covers the chart. Settings that change the numbers are the numbers' own labels (the scope line),
   not a separate panel.
2. **One identity rule for the whole page.** On the fan chart, the five charted models are in color and
   every other selected model is grey context. Every evaluation figure follows the same rule: charted
   models in their series color, everything else neutral ink, identified by name. Color never encodes
   rank, category or score, and scores never use green/red.

## Who reads scores, and what they ask

The same three people as the picker (modelers, evaluators, analysts), with different questions:

1. **"Which models beat the baseline, and by how much?"** The headline: one number per model
   (relative WIS), ranked, with the baseline as a visible reference.
2. **"Is that consistent, or driven by a few weeks or places?"** Breakdown by week, location, horizon.
3. **"Are its intervals honest?"** Coverage and calibration: too narrow or too wide.
4. **"Why does it lose: spread, or bias?"** WIS split into dispersion, over- and under-prediction.
5. **"Why was it bad there?"** Jump from a bad week or place straight to that forecast on the chart.
6. **"Over what, exactly?"** Weeks, locations, horizons, how many forecasts. Scores mean nothing without
   their scope, so the scope is always on screen beside them.
7. **"Can I take this with me?"** Export the table, copy the command that reproduces it, link to it.

## What old viz does, and where each piece goes

Old viz (inventoried Nov 13, 2026) has, under the chart, a four-cell "telemetry" strip and a tabbed panel
(Leaderboard, Error Anatomy, Calibration, Horizon Decay) with a scope toolbar; heatmap, map and season
peak are alternate modes of the chart panel. Its useful logic is kept; its structure is not.

| Old viz | Here |
|---|---|
| Telemetry strip (top performer, cohort mean WIS, the *top model's* coverage and MAE) | **Dropped.** The ledger's first row is the top performer; the other cells mixed cohort and single-model numbers under similar labels. |
| Leaderboard tab, 17 columns | **The ledger**: 4 default columns, the rest optional (below) |
| Error Anatomy tab (bars, 12 cards with advice text, bias badges) | **Anatomy** figure + a component bar in each expanded row. No generated advice text. |
| Calibration tab (reliability diagram, scorecard, status words) | **Calibration** figure; coverage columns; status words dropped (the curve shows it) |
| Horizon Decay tab (grouped bars) | **Horizon** figure (lines) + the lane's Horizons mode |
| Heatmap (model × date / location / horizon) | **The lane** in the ledger. Location × date heatmaps of *truth or forecasts* are not evaluation; they belong to the chart's future alternate views (map, etc.), not this doc. |
| Season peak scorecard | **Peaks** section, only for targets with peak forecasts |
| LOC: Current / All States | scope line: **Locations** |
| TIME: Date / Season ▾ (seasons, phase, week brush, Apply) | scope line: **Dates** + the season strip. Live, no Apply. |
| SCALE: Natural / Log | scope line: **Metric** popover |
| Common Tasks ON/OFF | Metric popover: **Shared forecasts only** |
| Export ▾ (CSV/TSV/XLSX) + nav "Copy CLI" + "Share" | scope line: **↓** (one menu) |
| ⓘ definition popovers, Guide modal, Methodology modal | definitions inside the popovers that set them; a "Methods" link at the bottom of the Metric popover |
| Validation warnings pill and modal | the ⋯ bubble shows a count; affected rows carry a glyph |
| Model Detail modal | the expanded row |
| Ensemble Studio modal | the picker (a "Combine" action on the current selection); out of scope here |
| Brand menu, live hubs modal | the ⋯ bubble |
| Target switch (Flu Hosp / ED Visits) | a **Target** bubble, shown only when more than one target exists |

Fixed on the way (old bugs and inconsistencies): the table now sorts by relative WIS by default (it
sorted by raw WIS while the server ranked by relative WIS); exported rank equals the table's rank;
diagnostics follow the same scope, scale and sort as the table; the baseline is visible and choosable;
the whole scope is in the URL.

## Page anatomy, top to bottom

```
┌──────────────────────────────────────────────────────────────┐
│ (Models) (US)                                       (◐) (⋯) │  ← fixed glass bubbles
│                                                              │
│                        fan chart                             │  ← 100svh − peek
│ (Rulers) (Misses)        (‹ Dec 27 ›)                        │  ← chart bubbles, scroll away
├──────────────────────────────────────────────────────────────┤
│ Relative WIS · All states · Nov 22 – Mar 7 · 0–3 wk      ↓   │  ← scope line (the peek)
│                ─────────╱╲──────────[▓▓▓▓▓▓▓▓]┄┄┄┄┄          │  ← season strip = window
│        Rel. WIS            WIS   50%  95%   Weeks Locations… │
│ ○ 1  flusion    0.71 ──●|        212   48   93   ▪▪▪▪▪▪▪▪▪▪▪ │
│ ● 2  gbqr_4src  0.78  ─●|        231   52   95   ▪▪▪▪▪▪▪▪▪▪▪ │  ← the ledger
│   …  Baseline   1.00    ●        297   41   88   ▪▪▪▪▪▪▪▪▪▪▪ │
├──────────────────────────────────────────────────────────────┤
│  Calibration       Horizon        Anatomy                    │  ← figures
│  Peaks (only when the target has them)                       │
└──────────────────────────────────────────────────────────────┘
```

### 1. The fan chart, with a peek

- The chart takes the viewport height minus a **peek** (about 44 px) that shows the scope line. That
  sliver is the only hint that more is below, and it's useful on its own: it says what the scores cover.
  No "scroll for more", no arrow.
- On short windows (chart under 480 px) the chart keeps 480 px and the peek goes; the page just scrolls.
- The chart's own bubbles (Rulers, Misses, date stepper, Recenter, the Show-all note) are anchored to the
  chart, not the viewport: they scroll away with it.

### 2. The scope line

One line of fragments, each a button opening a small popover (the same morph as every control):

**Relative WIS · All states · Nov 22 – Mar 7 · 0–3 wk** &nbsp; ↓

| Fragment | Popover | Default |
|---|---|---|
| **Metric** | Relative WIS / WIS / MAE · Natural / Log · Shared forecasts only · Baseline (which model) · Rank among (selected / every model in scope) · Methods → | Relative WIS, natural, off, the hub baseline, every model |
| **Locations** | All states · US · the chart's location (follows it) · a custom set: tile map + search | All states |
| **Dates** | Seasons (multi) · Phase: Full / Pre-peak / Peak / Post-peak · the strip, for when it's out of view · "Follow the chart's date" (a one-week window that moves with ← →) | the current season, every observed week |
| **Horizons** | 0 · 1 · 2 · 3, four toggles (at least one stays on) | all four |
| **↓** | Scores CSV · TSV · XLSX · Chart PNG · Copy link · Copy command | — |

- It's the section's title and its settings at once. There's no other heading.
- When you scroll past it, it **lifts into a glass bubble** at the top centre, between the left bubbles
  and the theme button, so the scope stays beside every number below. Scrolling back up, it settles onto
  the paper. Same text, same buttons; only the material changes (a 200 ms crossfade of the glass in,
  no movement of the text).
- A fragment that differs from its default is primary ink; defaults are secondary. You can tell at a
  glance whether this is the standard view, and a shared link shows what was changed.
- Changes apply live. No Apply, no Cancel: every change is one click to undo, and ⌘Z undoes the last
  scope change.
- When a narrowing leaves nothing scored (see edge cases), the fragment responsible gets a warning
  underline.

**Locations, pooled the way old viz pools:** if any state is in scope, the headline uses states only
(the US national forecast isn't counted twice). "All states" means the 52 non-US jurisdictions. "US"
scores the national forecast alone.

**Rank among.** Old viz computed the pairwise tournament among only the selected models (plus a hidden
baseline), so adding a model changed everyone else's relative WIS. The default here is **every model
with forecasts in scope**: a model's number doesn't depend on what else you picked. "Selected only"
remains as the option, for reproducing old numbers.

### 3. The season strip (the evaluation window)

A thin, full-season time axis directly under the scope line. It shows:

- the observed curve for the scoped locations (summed), in the chart's observed ink and weight;
- weeks as ticks, months labelled like the chart's axis;
- **the window**: selected weeks at full strength, the rest dimmed;
- weeks whose targets aren't observed yet, dotted, the chart's post-cutoff convention;
- the chart's current date as the same "ref" mark used on the chart;
- the peak phase as a faint hairline bracket under the axis, when Phase isn't Full (it's computed per
  location, so with many locations the bracket is the national one, and the popover says so).

With several seasons, each season's curve is drawn over the same week-of-season axis (lightest for the
oldest); the window applies to every season, as in old viz.

Interaction:

- Drag on the strip: a new window, snapping to weeks. Drag an edge: resize. Drag inside: move.
  Double-click: back to every observed week. A plain click does nothing (old viz cleared the range on a
  stray click).
- The numbers update live while dragging; rows **don't reorder until you let go**, then move to their new
  places in 250 ms on the soft spring. Reordering under the pointer is unreadable.
- Keyboard: the strip is one tab stop; ← → move the window, shift ← → resize it.

The strip's plot area is exactly as wide as the ledger's lane column and sits right above it, so in
Weeks mode it doubles as the lane's header: each cell sits under its week.

### 4. The ledger (leaderboard and heatmap, merged)

Old viz's leaderboard and heatmap answer questions 1 and 2 about the same rows, so here they're one
table: a ranking on the left, the breakdown on the right.

Default columns, left to right:

| Column | Shows | Notes |
|---|---|---|
| Circle | on the chart or not | the picker's control: empty, filled in series color, grey dot when context. Click to chart. |
| Rank | position | faint mono; only when sorted by a score; ties share a number |
| Name | short name, team muted | ellipsis, full name on hover; click to expand |
| Rel. WIS | 0.71, with its lollipop | the number, then a stem from a hairline at 1.00 to a dot on a shared log axis; left is better |
| WIS | 212 | absolute, so a ratio is never read without its size |
| 50% · 95% | coverage, percent | plain numbers; the header carries the target |
| Lane | the breakdown | Weeks · Locations · Horizons |

Optional columns, from a quiet **+** at the end of the header row (a checklist popover): **Forecasts**
(scored, of possible), **Wins** (weeks with the lowest WIS, of weeks competed), **vs baseline** (% change,
direct, on shared forecasts), **WIS / 100k**, **MAE**, **Sharpness** (mean 95% width), **80%** coverage,
**MCE** (mean calibration error). Choices are remembered per person and go in the URL.

- **Charted models** have their circle and dot in their series color, so your five can be found in a
  long list. Everything else is ink. Rows never get colored backgrounds.
- **The baseline is a row**, in tertiary ink, at exactly 1.00, sorted with everyone else. Where it lands
  is information. It's always there; the picker's Baseline toggle only controls the fan chart.
- **Sort** by clicking a header. Default: Rel. WIS, best first. Coverage sorts by distance from its
  target, closest first (sorting coverage by raw value is never what anyone wants). Name sorts A–Z.
  Clicking the active header reverses it. Rows that can't be ranked always come last.
- **Log scale** relabels nothing: the metric fragment already reads "Relative WIS (log)". Coverage,
  sharpness and per-100k stay natural, as before.
- **Row height** 28 px. The header row sticks under the scope bubble.

#### The lane

A row of cells, one per week, location or horizon, each showing that model's relative WIS for that
slice: its mean WIS over the slice divided by the baseline's on the same forecasts.

- Switch: **Weeks · Locations · Horizons**, three words in the lane header, the active one in primary ink.
- **Encoding:** diverging on log₂(ratio), clamped at ½× and 2×: two hues and a neutral grey midpoint,
  validated with the dataviz validator on both surfaces. Better than baseline cool, worse warm, never
  green/red. The hues must not read as series colors; if no pair passes, the lane uses ink lightness with
  "worse" cells outlined. (Prototype both; see Studies.)
- Weeks: the whole season, cells outside the window faint, so you see what you're leaving out. The
  chart's current week has a hairline outline in every row, so ← → visibly walks down the page too.
- Locations: US first, then states A–Z (sort by region or population in the lane header's own small
  menu, as old viz offered). Abbreviations in the header at 14 px per cell or wider; otherwise on hover.
- Horizons: four wide cells, with the value printed inside when it fits (40 px or wider).
- No forecast: empty. Targets not observed yet: dotted outline.
- Hover a cell: a readout like the chart's: the slice, the model's WIS, the baseline's, the ratio.
- **Click a cell: show it on the chart.** Sets the chart's date (Weeks) or location (Locations), charts
  the model if needed, focuses it, and scrolls the chart into view. The ledger is an index into the fan
  chart (question 5). Back (or scrolling down) returns you to the same row.

#### Expanding a row

Click a model's name: the row opens in place on the soft spring, and shows:

- **Anatomy**: dispersion, over- and under-prediction as one thin stacked bar per horizon, ink tones plus
  a texture for the middle segment (three identities, no series colors).
- **Coverage curve**: empirical vs nominal at every level, against the diagonal; the baseline in grey.
- **Locations** as a US tile grid in the lane's colors; click a tile to see it on the chart.
- **Submissions**: one tick per round across the season (full / partial / missing), click to go there.
- **Facts**: provenance, team, family, quantiles (7 or 23), license, methods (from metadata).

More than one row can be open; Escape closes the most recent. Open rows survive scope and window changes.

### 5. Figures

Below the ledger, small figures in the chart's line language, each titled with one word:

- **Calibration**: coverage at every nominal level (10–98%) per model, the diagonal as a hairline.
  Above: intervals too wide. Below: too narrow. No zone labels, no corridor; the diagonal is enough.
- **Horizon**: relative WIS at each horizon (0–3), one line per model, a hairline at 1.00.
- **Anatomy**: for each model, the share of its WIS from spread, over- and under-prediction, as one
  thin horizontal bar, sorted like the ledger. Absolute / share toggle in the title ("Anatomy · share").
- **Peaks** (own row, only when the target has season-peak forecasts and the window's season has peaked
  or is provisional): timing and size error per model in the same lollipop form, plus RPS and coverage
  as columns. Its full design is its own study; old viz's peak view is the reference for content.

Each figure follows the identity rule: charted models in color and drawn on top, every other selected
model a grey line. Hover a line: it's named and its ledger row lights. Click: it's charted, exactly like a
grey line on the fan chart. Up to 140 lines; with that many, figures show the charted five over a grey
sheaf, like Show all.

## Floating bubbles: what's there, and when

| Bubble | Where | Shown |
|---|---|---|
| Models | top left | always: the selection drives the chart and the scores |
| Location | top left | always: the chart's location (the scope line has its own) |
| Target | top left | only when the data has more than one target |
| Scope | top centre | once the scope line scrolls under the top |
| Theme | top right | always |
| ⋯ | top right | always: data sources and hubs, sync, truth date, validation warnings (count shown on the bubble only when there are any) |
| Date stepper | chart, bottom centre | with the chart; scrolls away |
| Rulers, Misses | chart, bottom left | with the chart; scrolls away |
| Recenter | chart | the forecast is off screen (as now) |
| Showing 5 of 12 | chart | more than five selected (as now) |

Nothing floats over the scores except the global bubbles and the scope. Sorting, columns, lane mode and
expansion are on the paper. There's no Guide button: definitions live where the setting lives.

### Which buttons open menus

A button opens a popover only when it has more than two choices or needs explaining. Otherwise it acts in
place.

| Control | Acts in place | Opens |
|---|---|---|
| Header click | sort / reverse | — |
| Lane mode words | switch | — |
| Circle | chart / unchart | — |
| Model name | expand / collapse | — |
| Lane cell | go to the chart | — |
| Horizons | — | four toggles (small) |
| Metric, Locations, Dates | — | popover |
| **+** (columns) | — | checklist |
| ↓ | — | export menu |
| ⋯ | — | data menu |

## Linking the chart and the scores

- **Hover** a ledger row or a figure line: the model previews on the fan chart (if any of it is on screen)
  exactly as hovering its label does. Hover a model on the chart: its ledger row highlights. (This settles
  the open question in `models-goals.md`.)
- **Click** a circle anywhere: charts the model, same queue-of-five rule as the picker.
- **← →** step the chart's date from anywhere on the page except text fields. The strip's ref mark and the
  outlined lane column move with it. With Dates following the chart, the scores follow too.
- **↑ ↓** scroll the page, unless a ledger row has keyboard focus; then they move between rows (Enter
  expands, Space charts).
- **Vertical scroll scrolls the page everywhere, including over the chart.** The chart already ignores
  mostly-vertical scrolls; side scroll, pinch, ⌘ and shift keep their chart meanings. Shift + vertical
  scroll is height zoom only over the chart; elsewhere it's the browser's.
- **The picker** (left half) still works while scrolled to the scores: the right half shows whatever was
  on screen, and the ledger narrows to the right half (it's a container query, so this is free).

## Resizing

The section uses container queries on its own width, never the window's.

| Width | Layout |
|---|---|
| ≥ 1280 | all columns; figures three across |
| 960–1280 | lollipop narrows (min 96 px); figures two across |
| 720–960 | lollipop hidden (the number stays); lane at least 160 px; figures one across |
| < 720 | lane hidden; optional columns hidden; a row's lane appears when it's expanded |

- Name column: 140–280 px, ellipsis, never wraps.
- Numbers never truncate; the lane absorbs the slack. Number columns size to their widest value in
  tabular figures, so they don't jitter as the window drags.
- The strip always matches the lane column; when the lane is hidden, it runs full width.
- Resizing never reorders, re-sorts or collapses anything.

## Edge cases

- **Partial submitters.** Relative WIS is pairwise on forecasts each pair shares (Cramer et al.), so a
  model that missed weeks is compared fairly. Its row has a small partial-circle glyph filled to the
  fraction submitted; hover: "18 of 28 weeks".
- **Shared forecasts only** with disjoint models (different seasons): nothing in common. Every number
  shows "–", the Metric fragment gets the warning underline, and the ledger's only words are
  "No shared forecasts · Score each on its own", the second part a link that turns the option off.
- **Small samples** (fewer than 10 forecasts scored): numbers render in tertiary ink with the count beside
  them in the Forecasts position. No banner; the faint numbers say "don't trust this much".
- **A model with no forecasts in scope** (another season, a location it doesn't cover, not yet scored):
  shown at the bottom after a hairline, unranked, "–", with a glyph whose hover says why ("2024–25 only",
  "no Alaska", "awaiting truth").
- **Window over unobserved weeks only.** Numbers "–"; the strip shows the window over the dotted region.
  The dotting says it.
- **Partly observed recent rounds.** Scored on the horizons already observed (as old viz does); in the
  lane, those cells are drawn at reduced strength until all horizons are in.
- **Baseline has no forecasts in scope.** Relative WIS rescales to the fallback (old viz's rule), the
  Metric fragment reads "Relative WIS · vs ensemble" in primary ink, and the ⋯ warning count goes up.
- **Near-zero baseline WIS** (a small state off-season): the cell's color clamps; the readout shows both
  absolute numbers.
- **7-quantile models**: the "7Q" glyph; coverage columns other than 50/80/95 show "–".
- **No models selected.** The ledger shows the baseline row and one ghost row, "Add models", that opens
  the picker.
- **One model.** Two rows. Nothing special.
- **140 models.** The ledger is virtualized at a fixed row height; the lane draws on one canvas for the
  visible rows; figures draw 140 grey lines, as Show all does.
- **Ties.** Same rank number, then by name.
- **Rate targets** (ED visits, proportion): WIS / 100k disappears from the column list; values use 3
  significant figures under 1, as old viz does.
- **Truth revisions.** Scores use the truth as of the date in the ⋯ bubble.
- **Changing the chart's location** doesn't change the scores, unless Locations follows the chart.

## Computing it fast

- Scores are computed in a worker from per-forecast WIS, components and coverage flags (typed arrays:
  model × date × location × horizon).
- For each scope (locations, horizons, shared-only, scale), per-model and per-pair prefix sums over dates
  are built once (140 models: about 20k pairs × 28 dates, a few hundred milliseconds in the worker).
  Any window is then a lookup: dragging the strip recomputes the tournament for 140 models in well under
  a frame.
- Rows are DOM (text must be selectable and accessible); lollipops and lanes are canvas, one per column
  for the visible rows.

## Text on screen

Every word on the scores section is a label of something you can see: the scope line, the column
headers, the lane switch, model names, figure titles, and the two edge-case phrases ("Add models",
"No shared forecasts · Score each on its own"). Methods and definitions live in popovers and tooltips.

## Studies before building

1. **Lane encoding**: diverging hues vs ink lightness with outlined "worse" cells vs short spikes off a
   midline. Same data, side by side, both themes, 10 and 100 rows.
2. **Scope lift**: the paper-to-glass transition of the scope line, and the sticky header under it.
3. **Lollipop vs number only** at 960–1280 widths.

## What "good" means (testable)

- From any score on screen, you can tell what weeks, locations and horizons it covers without scrolling.
- Your charted models can be found in a 140-row ledger at a glance.
- Any bad cell gets you to the forecast behind it in one click.
- Adding a model to the selection doesn't change anyone else's relative WIS (default ranking).
- Dragging the window updates numbers within a frame; rows reorder once, on release.
- Nothing floats over the scores except the global bubbles and the scope.
- Resizing from 1600 to 700 px wide never truncates a number or reorders a row.
- A shared link reproduces the scope, window, columns, sort, lane mode and expanded rows.
- Every old viz evaluation feature has a home (the table above) or a stated reason it's gone.
