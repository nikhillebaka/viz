# Seasons and locations: goals and design

The fan chart so far shows one location (US) and one season. Production has 53 locations and several
seasons, and both change what's drawn, how the camera works, and what the scores cover. This settles the
structure before handoff (see `evaluation-goals.md`, `time-navigation.md`). Nothing here is built yet.

## Facts from the hub data (Nov 13, 2026)

| | 2023–24 | 2024–25 | 2025–26 |
|---|---|---|---|
| Forecast rounds | Oct 21 – May 4 (29) | Nov 30 – May 17 (23) | Nov 22 – May 30 (28) |
| Models | 40 | 41 | 57 |
| US peak (weekly admissions) | 21,720 | 55,718 | 42,626 |
| Wyoming peak | 82 | 116 | 58 |

- Observed data runs nearly all year (late summer to mid summer); forecasts only in season.
- Between seasons there are about six months with no forecasts at all.
- 37 models appear in all three seasons; 20 exist only in 2025–26.
- Peak sizes differ 2.5× between seasons and about 700× between the US and the smallest states.

## Decisions to make, and the proposal

### 1. What a season is on the chart

- **The chart shows one season at a time.** A season is the forecast rounds of one hub season plus the
  observed data around them.
- **The full-season view** spans the season's observed data, from its first week in late summer to its
  last (or the last round's forecasts, if later): the rule the chart already used. (A shorter window, 6
  weeks before the first round, was tried in the prototype and dropped: it took away the room to pan
  back through the quiet early weeks, which the agreed panning behaviour relies on.) This is the zoom-out
  limit.
- **Panning stops at the season's edges** (the existing rubber band). The previous season's data isn't
  drawn as context; seasons are compared in the scores, not by panning across six empty months.

### 2. Moving between seasons

The date is one continuous list of rounds across all seasons, but the gestures differ in whether they
cross a season boundary:

| Input | Within a season | At a season's edge |
|---|---|---|
| ← → keys, stepper arrows | glide, as now | **cross**: cut to the other season's first or last round |
| Drag, side scroll | scrub, as now | rubber band, never cross (a scrub that crossed six months would be a lurch) |
| The date picker | — | pick any round in any season |

- **Crossing is a cut, not a glide**: a 150 ms crossfade of the plot, the camera reset to the same zoom
  and pan relative to the new date, the stepper's year rolling. Gliding through six months of nothing is
  slow and says nothing.
- **Holding → at the last round of the current season** does nothing more (there's no next season yet);
  the stepper's arrow greys out, as at any end.

### 3. The date picker

The stepper's label is a button: it opens a popover with a chip per season (newest first, the chart's
selected) and that season's forecast rounds as a calendar, one row per month (Dec · 6 13 20 27), the
chart's round marked. Nothing else per date. Arrow keys move through the days, a letter jumps to a month,
Enter goes, Escape closes; ← → don't move the chart while it's open.

Tried and dropped (Nov 13): a list with model counts, per-model dots, observed-level bars and search.
Counts are near-constant and not useful on their own, anything tied to the selected models repeats the
chart, and where-in-the-season is better read on the fan itself. Other ideas pitched and set aside: quick
jumps ("same week last season"), data-status tags, off-season weeks, typed dates.

### Popover placement (all popovers)

A popover's size and side are settled when it opens (or its content changes), against the screen. When
the page scrolls, it keeps its size and moves with its button; when its button leaves the screen, it
closes. Before, every scroll re-fitted it to the room left inside the chart, so it shrank and grew, and
the date picker's "scroll the current date into view" also scrolled the page. Lists now scroll only
themselves (`revealInList` in `lib/controls.js`).

### 4. Models across seasons

Most selections are made in one season; switching to another means some charted models have nothing.

- **The selection doesn't change** when the season does (it's yours; colors keep their slots).
- **A charted model with no forecasts anywhere in this season** isn't given a ghost label per week.
  Those collapse into one quiet line where the labels sit: "2 not in 2023–24" (hover lists them).
  Models missing only *this week* keep today's ghost label ("no forecast Dec 27").
- **The picker** shows availability for the chart's season: models with none this season sink to a
  last section, "Not in 2023–24", collapsed, instead of being mixed in with no explanation.
- **Show all** grey lines: only models with forecasts in this season are drawn; the note counts the
  rest ("and 12 not this season").
- **The scores** already follow the chart's season, and list such models after the hairline, unranked
  ("2025–26 only").

### 5. The y-axis across seasons and locations

A fixed y-axis is a principle (intervals never rescale it). With 700× between locations it can't be one
number for everything.

- **The axis is fixed per location and season**: the rounded maximum of the observed data and the
  charted medians over the whole season. It never moves while scrubbing, panning or zooming.
- **Changing season or location animates the axis** to the new maximum (the soft spring, 300 ms), with
  the lines crossfading, so the eye follows the scale change rather than seeing a jump.
- **Height zoom** (shift + scroll) stays relative to that axis, and resets to normal on a location or
  season change (a zoom tuned for the US means nothing for Wyoming).

### 6. Choosing a location

A **Location** bubble next to Models, top left: "US", or "Massachusetts" (full names; they're short
enough and the abbreviation alone is ambiguous to some readers). It's global, so it stays fixed when
scrolled, like Models.

Its popover:

- **Search** at the top, focused on open: matches names and abbreviations ("ma", "mass").
- **A US tile map** (one rounded square per state, two-letter labels, the current one filled, DC and PR
  in their usual tile positions, US as a wide tile above): a click goes there. Spatial, fast, and
  everyone knows where their state is.
- **Recent** locations as a row of chips under the search (the last 4).
- Keys: arrows move across the tile map *inside the popover* (it opts out of time keys, unlike the
  picker), Enter goes, Escape closes.
- A location with no data for the season is a faint tile, still clickable (the chart says why).

### 7. Changing location

- The chart keeps the date, zoom, pan and focus, and crossfades the plot while the y-axis animates.
- Data loads per location (one file per season and location, a few hundred KB); while it loads (rarely
  more than 100 ms) the old plot stays, dimmed slightly; no spinner. Hovering a tile prefetches it.
- **The scores don't change** unless their Locations scope is set to follow the chart (as decided).
  When it is, the scope fragment reads "Massachusetts" in primary ink.
- **Heatmap → chart**: clicking a cell in Locations mode now sets the chart's location (with the cut),
  charts and focuses the model, and scrolls up, like a week cell.
- Models that don't forecast a location (US-only models) get the same "not here" treatment as missing
  seasons: one collapsed line, "1 not in Massachusetts".

### 8. Counts or rates

Comparing a state with its neighbours is easier per 100,000 people. Old viz offered rate layers.

- An axis toggle at the axis's top label, "per 100k", off by default, kept per person. Reading the chart
  in rates changes nothing else (the scores have their own WIS / 100k column).
- Low priority: the chart works without it.

### 9. State, URL and keys

- The URL holds the location and the date (the season follows from the date), with the rest already
  planned (selection, scope, sort).
- ← → step the date and cross seasons; no new global keys. The location popover could open on `L` later;
  not now.

## Edge cases

- **The current season has rounds still to come**: the axis end is May 31 + 4 weeks; the future part is
  empty, as today.
- **A season with fewer rounds or a later start** (2024–25 starts Nov 30): the full view is shorter;
  zoom limits are per season.
- **Crossing seasons while zoomed or panned**: zoom and pan carry over relative to the new date; height
  zoom resets.
- **Crossing while a model is focused that isn't in the new season**: focus clears (as when a model is
  uncharted).
- **The picker open while the season changes**: its availability sections re-sort live.
- **The scores following the chart's season**: crossing seasons re-scores (this needs the worker; today
  three seasons take ~440 ms on the main thread).
- **A location and season with no observed data yet** (the first week of a new season): the axis falls
  back to last season's maximum for that location.

## What "good" means (testable)

- ← → walk through every round of every season; crossing a boundary is a cut, under 200 ms.
- Drag and side scroll never leave the season.
- The y-axis never moves while you move through time, and always animates when the place or season
  changes.
- Switching to a season where three charted models didn't exist shows one quiet line, not three ghosts.
- Any of 53 locations is two keystrokes or one click from the chart.
- Changing location keeps the date, zoom and focus.
- A shared link reproduces the location and date.

## Data this needs (input to the server-data decision)

- Forecasts per (season, location): the 23 quantiles × 4 horizons per model per round, as the chart reads
  now (`fc-US.json` today, one season).
- Observed data per location, all seasons.
- Per season: its rounds and models; per model: metadata (team, family, provenance, license).
- Scores per season (as `scores-<season>.bin`, see `evaluation-goals.md`).

## Prototype status (Nov 13, 2026)

Built on the fan chart page (`studies/intervals-refine.html`):

- **Data**: `data/extract_fc.py` writes forecasts per season and location (`data/fc/<season>/<loc>.json`,
  159 files, 99 MB, not committed; regenerate from the hub root with
  `viz/.venv/bin/python design/data/extract_fc.py . design/data` after `extract_scores.py`). It matches
  the old `fc-US.json` exactly. `lib/fandata.js` loads one (season, place) at a time, cached, in the shape
  `lib/chart.js` has always drawn; a season's timeline is every week from its first round to its last.
- **Seasons**: ← → and the stepper arrows cross at either end (a 150 ms crossfade, zoom kept, height
  reset, axis easing to the season's maximum); drag and side scroll rubber-band. `TimeNav.setTimeline()`
  swaps the dates and window; `TimeNav.step()` hands a step past either end to `onEdge`. The stepper's
  arrows stay enabled while another season exists.
- **Date picker**: the stepper's label opens season chips, the season's rounds by month (faint where no
  charted model forecast), Latest; arrow keys move through the grid, a letter jumps to a month.
- **Missing models**: one quiet line ("2 not in 2024–25", "1 not in Wyoming") instead of a ghost per
  model; the picker's "Not in 2024–25" section (collapsed) holds models absent from the chart's season.
- **Places**: the Location bubble (search with Enter, recent places, US button, a 52-tile map with arrow
  keys, hover prefetch); the date, zoom and focus stay; the axis eases to the place's scale; height resets.
- **Scores** follow the chart's season (unless seasons were picked by hand), and gain a third Locations
  option, the chart's location, which follows the bubble. A Locations heatmap cell sets the place; a
  Weeks cell in another season crosses to it.
- **Checks**: `tests/seasons-check.js` (26 cases), with time-nav (48), scores (33) and selection (14). The
  browser checks can run back to back on one page: each restores what it changed.

Not built: per-100k rates; the URL; prefetching the neighbouring season; the picker's availability by
place (it's by season only).
