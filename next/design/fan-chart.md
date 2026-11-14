# The fan chart: design

What the chart is for, what is on screen, and how every part behaves. The look is the prototype's
(`design/studies/intervals-refine.html`); the reasoning behind its marks, time navigation, model
selection and seasons is in `design/studies/*.md` and still holds unless this page says otherwise.
This page is what gets built.

## What it answers

1. What do these models expect here, and how sure are they? (medians, one interval level, exact values on hover)
2. Do they agree? (bands with exact edges, at most five in color)
3. Did it work? (the observed data continues past the forecast date; misses are marked for the model in focus)
4. How did the forecast move over the season? (drag, scroll or step through rounds; everything moves continuously)

## What is on screen

```
(Models ▾) (United States ▾) (Flu admissions ▾)                                  (◐) (⋯)
                                                                      (Showing 5 of 9 · Show all)
  50k ─────────────────────────────────────────────────────────────────────────────────
                                                         ░░░░░░░░░░░░░░░░░░░░░░ ● flusion
  25k ───────────────────────●─────────────────────────░░░░░░░░░░░░░░░░░░░░░░░ ● gbqr_4src
        Nov                 Dec          Data cutoff │ Reference date
                                              Dec 20 │ Dec 27
(95% interval ▾)                    (‹  Dec 27, 2025  ›)
```

- **The paper.** The canvas fills the view edge to edge. Grid hairlines, the x-axis line, month labels,
  the observed line (primary ink, the strongest mark), the shade after the data cutoff, the two date
  ticks labelled outward, then bands, medians with week dots, labels at the fan's end.
- **Fixed bubbles** (stay on screen when the page scrolls): Models, Location, Target (only when the hub
  has more than one target), theme, ⋯ (later: data sources, warnings).
- **Chart bubbles** (belong to the chart, scroll away with it): the interval pill bottom left, the date
  stepper bottom centre, the "Showing 5 of 9" note under the top bubbles at the right, the recenter pill.
- Nothing else. No title (the bubbles are the title: what, where, which models), no legend (labels sit
  on the lines), no hint text.

## Changes from the prototype (decided here)

| Prototype | Now | Why |
|---|---|---|
| Hint sentence under the top bubbles | Removed | Instructional copy. Gestures will be listed once, in the ⋯ bubble. |
| "Rulers" and "Misses" checkbox pills | One pill, **95% interval ▾**: a menu with 95% · 80% · 50% · None, then Width rulers | The pill names what the bands are (the prototype never said), old viz's PI levels get a home, and two controls become one. |
| Misses toggle | No toggle: misses ring the observed weeks outside the focused (or only) model's interval whenever those weeks are observed | It is quiet, and only appears when you have asked about one model. A setting nobody needs to find. |
| Readout: range and ± half-width | **Median**, then the range; the width only while rulers are on | The median is the first thing anyone reads. |
| Hover only over the four forecast weeks | Hover snaps to the nearest week anywhere: over history it reads the observed value for that week | The observed line is the most important mark and had no exact values. |
| Names: `UMass-` stripped by regex | The model's own abbreviation from its metadata; the team (then the hub) is added only when two names on screen would be the same | Works for every hub, never ambiguous. |
| Labels pushed down only | Labels keep 18 px apart and stay inside the plot: pushed down from the top, then up from the bottom if they overflow | Five labels plus ghosts could run off the chart. |
| Sample provenance, family by regex | Real metadata: source (this hub, Local, a synced hub, Ensemble), family, team, designated | — |
| Counts only | Values formatted per target (counts, or percent for proportion targets) on the axis, labels and readout | The hub has two targets. |
| Glass: fixed bubbles switch renderer when the page scrolls | Fixed bubbles always use the backdrop refraction; chart bubbles always use the canvas pass | Same look, no switching, nothing can trail. |
| Glass text flips light/dark by sampling the page | Removed | The tint keeps text readable; the sampling watched every DOM change on the page. Revisit only if a real case fails. |
| Springs that overshoot (`--ease-spring`) on controls | One critically damped curve | "No bouncy springs." |
| One hard-coded start date | Starts on the latest round (or the URL's date) | — |

## Behaviour

### Time (unchanged; `design/studies/time-navigation.md`, all 48 cases)
One fractional date. Drag and side scroll scrub 1:1 with rubber bands at the season's ends and a
momentum snap; ← → and the stepper glide on a critically damped spring; pinch / ⌘ scroll / `=` `-` `0`
zoom from 6 weeks to the whole season, the camera following the date less and less as it zooms out;
⌘ drag / ⌘ side scroll pan, the pan is kept, an off-screen forecast gets a "← Dec 27 forecast" pill;
shift scroll / shift drag zoom height; double-click toggles the whole season. Vertical scroll is the
page's.

### Seasons and places (unchanged; `design/studies/seasons-locations-goals.md`)
One season on the chart. Keys and the stepper cross seasons as a 150 ms cut; drag and scroll never
cross. The y-axis is fixed per season and place (observed data and the charted medians, rounded up)
and eases to the new maximum when either changes; height zoom resets. Changing place keeps the date,
zoom, pan and focus. Models absent from the season or place collapse into one quiet line
("2 not in 2023–24 · 1 not in Wyoming").

### The y-axis
- Gridlines and tick labels are always at round values (1 · 2 · 2.5 · 5 × 10ⁿ), about five of them,
  whatever the height zoom; the axis maximum itself moves continuously.
- A season with almost no data yet (fewer than 4 observed weeks) takes its scale from the larger of
  what it has and half of last season's maximum, so the first weeks aren't blown up to fill the chart.
- Tick labels sit above their line at the left edge, hidden where the top bubbles are.

### Models (unchanged rules; `design/studies/models-goals.md`)
Everything selected is evaluated; up to five are charted in color with stable slots (a queue of five);
the baseline is a grey line with its own switch and never takes a slot; Show all draws the rest of the
selection as grey medians. Hover a label or a line to preview focus, click to focus (a grey line is
charted first), click again or Escape to clear.

### Hover and the readout
- The pointer's week gets a hairline. The readout is a solid panel (never glass) left of the reference
  date, under the top bubbles; if there is no room there, right of the hovered week.
- In the forecast window: `Jan 3 · 1 wk ahead · 95%`, then a row per charted model (dot, name, median,
  range; the focused model first, others dimmed while one is focused), a hovered grey model as its own
  row on top, "and 12 more selected" with the span of their medians under Show all, then Observed with
  a dot for each model whose interval missed it.
- Outside it: the week and the observed value only.
- Hidden while moving, while a popover is open, and when the pointer leaves.

### The interval pill
`95% interval ▾` → menu: 95% · 80% · 50% · None (radio), a separator, Width rulers and Outcome (checks).
With None the pill reads "No interval". Outcome off hides everything observed after the data cutoff
(the dotted line, the hollow points, misses, the readout's Observed row), to show a forecast as it
stood when it was made; old viz called this Truth. Medians are always drawn. The readout and rulers use the chosen level.
A model without that level's quantiles (some submit 7) draws its median only, and its readout row
shows "–" for the range.

### Empty, loading and missing
- **First load:** the paper with a hairline progress bar under the top edge; bubbles appear with the data.
- **Changing season or place:** the old plot stays, dimmed after 80 ms, until the new data is in.
- **No models selected:** the observed data alone; the Models bubble reads "Choose models".
- **A charted model without a forecast this week:** its label stays, dimmed: "flusion · no forecast Dec 27".
- **No observed data and no forecasts for this place and season:** one quiet line in the middle of the
  plot, "No data · Wyoming · 2023–24".
- **The server can't be reached:** one quiet line, "Can't reach viz · Retry" (Retry is a link).
- **Gaps in the observed data:** the line breaks; it never bridges a missing week.

### Keys
← → step the round (crossing seasons) from anywhere except text fields and open pickers that use
their own arrows. `=` `-` `0` zoom. Escape closes the open layer, else clears focus. Tab reaches every
bubble and the charted models' labels (hidden buttons mirror the canvas labels).

## Testable
- Every case in the prototype's time, seasons and selection checks, on real data.
- The y-axis never shows a non-round tick, at any height zoom.
- No two labels overlap or leave the plot, with five charted models, ghosts and the summary line.
- With any target, every number on screen uses that target's format.
- A shared URL reproduces target, place, date, selection, charted five, Show all, baseline, level,
  rulers and focus.
- 200 selected models with Show all: a scrub stays under 4 ms of script per frame.
