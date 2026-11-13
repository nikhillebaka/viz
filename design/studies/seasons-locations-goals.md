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
- **The full-season view** spans the first round minus 6 weeks to the last round plus 4 weeks (for the
  current season, to whichever is later: the last round, or May 31). That keeps the previous summer's
  quiet tail and a little lead-in, without months of empty axis. This is the zoom-out limit (it already
  is a hard stop at "season size").
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

The stepper's label is a button (as old viz's date was): it opens a popover.

- **Seasons** as chips across the top, newest first; the current one selected.
- **The rounds** of that season as a compact month grid (Dec · 6 13 20 27), the chart's round marked. A
  round where none of the charted models forecast is drawn faint, not hidden (you can still go there).
- **Latest** as one chip: the most recent round with forecasts.
- Keys: ← → move through rounds (crossing seasons), Enter goes, Escape closes. Typing a month ("feb")
  jumps to it.
- Copy: none beyond month names, day numbers, season labels and "Latest".

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
