# Choosing models: goals

Before designing anything, what model selection is for, what has to be true for it to be good, and
the decisions so far. Same approach as `intervals-goals.md`.

## What selection does: two jobs

One selection drives two different things, with different limits:

| Job | Where | How many work well |
|---|---|---|
| **Look closely** | Fan chart (and later the map's detail view) | Up to 5 in color; reading intervals precisely is easiest at 2–3 |
| **Compare performance** | Leaderboard, heatmap, any evaluation | Any number; 10–30 is normal, "all hub models" is valid |

Most of the design follows from not forcing one limit onto the other. You select freely for
evaluation; the chart shows a small, stable subset of that selection in color, and says so.

## Who picks, and what they're after

- **Modelers** pick their own model(s), often local experiments, plus a few references. They know
  exact names and often type them.
- **Evaluators** pick groups: all hub models, one team's variants, one family (all AR models).
- **Analysts** pick a few trusted models and the ensemble they rely on.

All of them come back repeatedly, often to the same sets.

## Decisions (Nov 13, 2026)

1. **Keep the picker's look and opening animation** (the morphing popover from the components page).
2. **One selection, two uses.** Everything selected is evaluated. The fan chart shows up to **five**
   selected models in color, by default the first five selected. Beyond five, the chart shows a small
   note (see below).
3. **The baseline is a toggle, not a model in the list.** It never counts toward the five, and it's
   always grey.
4. **No special treatment for ensembles.** They're models like any other; ensembles vary too much to
   group meaningfully.
5. **No context-free numbers in the list.** Scores like WIS only mean something for a chosen set of
   dates and locations, would be arbitrary in a picker, and wouldn't cover every model, so the list
   can't be sorted or labelled by them.
6. **Categories, yes**, carried by grouping and text, not color (below).
7. **Two click targets per row.** Every row has an empty circle beside the name. Clicking the **name**
   selects the model (for evaluation). Clicking the **circle** puts it on the chart: the circle fills
   with the model's series color, and if five are already charted, another comes off. A charted model
   is always selected too.
8. **A charted model with no forecast keeps its slot** (dimmed label "no forecast Dec 27"), so colors
   never shuffle while scrubbing.
9. **Local experiments are pinned** at the top of the picker.
10. **Show all** draws every other selected model as grey context, and has to work at 100+.

## Color means "on the chart"

8 series colors can't identify 100+ models, so **only charted models get a series color**.

- The five charted models take the first free colors (1–5 of the 8) and keep them while they stay on
  the chart. Colors never repeat on the chart and are always the most distinct ones.
- In the picker, **the filled circle is the "on the chart" marker**, in the model's color. Selected-
  but-not-charted rows show the selected highlight and an empty circle. One mark, two meanings.
- In evaluation views, charted models are highlighted in their color, so you can find them in a long
  leaderboard; everything else is neutral ink, identified by name. A leaderboard of 25 doesn't need 25
  colors; it has names.
- **Categories get no color.** Color stays reserved for one job: which line on the chart is which.

### Five, not three: what changes on the chart

- At 4–5 charted models the whisper fills overlap more. They stay readable because each band has its
  own fine edge, and focus (click a label) is one click away. The intervals study's guidance still holds:
  precise reading is easiest at 2–3, which focus gives you at any count.
- Labels: five labels at the fan's end can collide more often. The existing stacking (18 px apart) still
  works; with rulers on, five bars fit beside the fan (about 90 px).
- The readout lists all five, focused first.

## Which five are charted

- Default: **the first five selected**. Stable: adding a sixth model never changes what's on screen.
- **Swapping:** clicking an empty circle (or a grey line on the chart, below) charts that model. If five
  are charted, the one that has been on the chart longest comes off, so repeated clicks keep your
  latest choices, like a queue of five. The new model takes the color that was freed, so the others
  never change color.
- Clicking a **filled** circle takes that model off the chart and leaves the slot empty. That was an
  explicit choice, so nothing refills it automatically.
- Free slots fill automatically only when the selection changes: adding a model fills a free slot, and
  deselecting a charted model frees its slot for the next selected model not yet charted.
- A charted model with no forecast on the current date keeps its slot (decision 8).

## Show all, at any count

- Note, shown only when more than five are selected (the baseline doesn't count): **"Showing 5 of 12 ·
  Show all"**, *Show all* as the blue link, in a small glass note under the top chrome near the labels.
  After clicking: **"Showing all 12 · Show 5"**.
- Show all adds every other selected model as **context**: a median line in neutral ink, as wide as
  the colored medians (lighter while a model is focused), no band, no dots. The five charted models stay exactly as they were (color, bands, labels)
  and are drawn on top. Twelve models or 140 look the same in kind; 140 is a denser grey sheaf, which
  itself shows the spread of the selection around the five you're reading.
- It's a view toggle, kept with the selection (and in the URL), so it survives scrubbing and reloads.
- Performance: 140 models × 5 points is a few hundred segments, one path per model, no dots or labels
  to measure. Hover hit-testing interpolates each context median at the pointer's x: 140 lookups per
  pointer move, trivial.

### Labels for context lines

Labels can't scale to 140, and a mix of labelled and unlabelled grey lines would suggest the labelled
ones matter more. So: **all or nothing.**

- If every context line's label fits at the fan's end without colliding with each other or the colored
  labels (in practice up to about 6), they're all shown, in tertiary ink, slightly smaller than the
  colored labels, below them in the stacking order.
- Otherwise none are shown, and context lines are named on hover. The note then adds "hover a grey line
  to name it" the first time.
- The rule is re-evaluated as you zoom or scrub; the switch fades rather than pops.

## One interaction model for every line on the chart

The chart already has: hover a label to preview focus, click a label to focus (click again or Escape to
clear), hover the plot for the week readout, drag to scrub, ⌘-drag to pan. Context lines must fit into
this, not add a parallel system. One rule:

**Hover a model (its label or its line) to preview it; click it to focus it. If it's grey, clicking also
puts it on the chart first.**

- **Lines become targets, not just labels.** Hovering within 6 px of any median line (charted or
  context) previews that model. A charted model previews exactly as its label does (bold label, others
  dim). A context line brightens, and its name appears at its end, where a label would sit, with the
  same halo, marked "click to chart".
- **Click on a line** acts like a click on its label: focus. For a context line it first charts the
  model (taking the longest-charted slot if five are charted) and then focuses it, so you see where it
  went and in which color.
- **Priority** when lines are close: the focused model, then other charted models (they're drawn on
  top), then context lines; among context lines, the nearest. The cursor becomes a pointer only over a
  target.
- **Hover readout and line hover together:** the week readout still follows the pointer's week. When a
  model is hovered, its row is highlighted in the readout; a hovered context model gets its own row
  added at the top (grey dot), so the readout always explains the highlighted line.
- **Drag vs click:** a press that moves more than 4 px is a scrub or pan, never a click on a line, even
  if it started on one. A click without movement on empty plot sets the hover week, as now.
- **While moving** (scrubbing, panning, pinching, gliding), line hover is suspended like label hover,
  and re-evaluated against the still pointer when motion stops (the same after-each-frame check that
  fixed sticky label highlights).
- **Keyboard:** context lines aren't individual tab stops (140 would be hostile). The keyboard path to a
  context model is the picker (Enter on a row charts it); charted models' labels stay focusable.

### Edge cases

- **Promoting removes the focused model:** focus moves to the newly charted model anyway, so nothing
  is left focused on a model that's gone.
- **Clicking a context line while five are charted and one has no forecast:** it still replaces the
  longest-charted, not the empty one; slot rules don't depend on data availability (decision 8).
- **Context model with no forecast this week:** not drawn, but counted: "and 128 more selected
  (12 with no forecast Dec 27)".
- **Context line overlapping a charted line:** the charted one wins the hover (priority above).
- **Show all with six selected:** one grey line, labelled (it fits). Same rule, no special case.
- **Rulers:** only for charted models; context models never get bars.
- **Misses rings:** only for the focused model, as now; a context model can't be focused without being
  charted, so there's no grey focus state.
- **Zoomed far out** (fan mid-screen, labels riding with it): context names on hover appear at the
  fan's end like labels; near the right edge they flip to the left of the line's end.

## The readout with Show all

The five charted models as usual (focused first), then one line: "and 128 more selected", with the
range their medians span that week (lowest to highest), which is a fact about the selection, not a
score. A hovered context model is added as its own row at the top.

## What a row in the picker shows

Only facts, nothing computed over an arbitrary window:

- **Circle** (empty, filled in the model's color when charted, a small grey dot inside when shown as
  context under Show all), then the **name** (short form), with the team in muted text.
- **Category tag**: the model's family (`family` in metadata, otherwise inferred from the name as viz
  does now: AR, GBQR, flusion…). When neither works, it's never "Unknown": it goes in a last section,
  **"By team"**, grouped under its team (from metadata, or the id before the first dash), tagged with
  the team. A team's unparseable variants still sit together.
- **Provenance tag**, from the classification viz already uses: **Hub**, **Staged** (experimental
  iteration in the sandbox), **Local** (from `local-output/`).
- **This week's availability**: if the model has no forecast for the date and location on screen, the
  row says "no forecast Dec 27". Contextual, but the context already on screen, not an arbitrary one.
- (A submission strip was tried and removed: nearly every model has all weeks or none, so it said
  nothing. The space stays empty; nothing replaces it.)
- Hover or expand: methods, data inputs, license, the designated-model flag, from metadata.

## Organizing 100+ models

- **Pinned on top:** "Selected" (in selection order; charted ones show their color), then "Local".
- **Sections by category**, collapsible, with counts; alphabetical within. "By team" last.
- **Search** across name, team and category. Typing a category ("ar") matches the whole family.
- **Bulk select** for evaluation: a checkbox on each section header selects the whole section, and
  shift-click selects a range. Bulk selection never charts anything beyond filling free slots.
- **Recent selections**: the last few sets, one click to restore.
- Sort: by category (default), by name, or by most recent submission. No metric sorting (decision 5).

## The baseline toggle

- A switch in the picker's header, "Baseline", and the same toggle beside the chart's labels.
- It only controls whether the baseline is **drawn**. In evaluation it's always the reference
  (relative WIS is computed against it), so evaluation views say "relative to baseline" rather than
  list it as a competitor.

## Keyboard and state

- Arrow keys move through rows, Space toggles selection, Enter toggles "on the chart", typing searches.
  Section headers are reachable and collapsible.
- Selection, its order, the charted five and Show all go in the URL, so a shared link reproduces the
  view.

## Open question

- **Show all and evaluation views:** should hovering a context line also highlight that model's row
  in a leaderboard on the same screen? Decide when the evaluation views are designed.

## What "good" means (testable)

- Selecting a sixth model never changes what's on the chart, and the chart says that it didn't.
- From the picker alone you can tell which models are charted, which are only evaluated, which are
  drawn as context, and which have no forecast this week.
- "All AR models" takes one click; "my local model plus two references" takes three.
- No number in the picker depends on a date range or location set the user didn't choose.
- Chart colors never repeat and never change while scrubbing.
- Show all with 140 selected: the five charted models read as clearly as with nothing else selected,
  any grey line can be named with one hover and charted with one click, and nothing about hover,
  focus, scrub or pan behaves differently from before.
- Everything works from the keyboard; a shared URL restores selection, the charted five and Show all.

## Prototype status (Nov 13, 2026)

Built on the fan chart page (`studies/intervals-refine.html`), with the logic in `lib/selection.js` and
the drawing in `lib/chart.js`:

- Selection with five charted and color slots, queue-of-five swapping, explicit take-off, auto-fill
  rules, bulk select. Checked by `tests/selection-check.mjs` (14 rules, run with node).
- The picker: search (name, team, family, provenance), Baseline switch, sections (Selected, Local,
  families, By team) with select-all checkboxes and collapse, circle vs name clicks, shift-click ranges,
  ↑/↓ and Enter, submission strips, "no forecast" notes, family and provenance tags.
- The Models pill (charted colors and count) and a Baseline toggle in the chrome.
- "Showing 5 of 13 · Show all" note; Show all draws grey context medians, labels all or nothing.
- One hover/click rule for labels and lines: charted lines preview focus, grey lines lift and join the
  readout, clicking a grey line charts and focuses it; taps on lines don't move the date.
- Dimmed "no forecast" labels for charted models that have none this week.
- The time-navigation check still passes (34/34), also with Show all and rulers on.

Not built yet: recent selections, sort options, the metadata hover (methods, inputs, license), the
selection in the URL, Escape-to-clear for hover state inside the picker. Provenance in the prototype is
sample data (two "Local" stand-ins), since the prototype's data files carry no metadata.

### Picker look, revised (Nov 13)

The first version mixed old-viz boxes with this design. Now: no background on selected rows (selection is
a blue checkmark at the right and full-strength text; unselected names are quieter); two-line rows
(name, then team · family · provenance in small muted text, replacing boxed tags); plain section
headers with no background and a quiet "Select all / Deselect all" at the right; the Selected section
can't be collapsed. Grey context lines are now as wide as the colored medians.

### The picker as a left-half panel (Nov 13)

- The picker takes the actual left half of the screen at full height (two columns), or the left quarter
  (one column) when the list is short (24 or fewer showing, e.g. after a search). The chrome on the left
  fades away while it's open, and the date control slides to the middle of the chart half.
- The chart moves its plot into the right half and previews at **14 weeks** (recentered), close enough
  that the four forecast weeks stay distinct, at normal height (any height zoom is set aside). Left and right keep stepping the date (the panel opts in
  to time keys; only search typing keeps its arrows). Closing restores the zoom and pan exactly.
- No "Selected" section: the checkmarks already show selection, and Select all no longer duplicates
  rows into it.
- One Baseline control, in the picker header, using the site's checkmark style with no background.
  Search has no field background: icon and text, with a hairline under the header.
- Regression check: 38 cases including picker size, arrow keys while open, one-column shrink and exact
  restore.
