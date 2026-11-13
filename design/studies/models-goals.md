# Choosing models: goals

Before designing anything, what model selection is for, what has to be true for it to be good, and
the decisions so far. Same approach as `intervals-goals.md`.

## What selection does: two jobs

One selection drives two different things, with different limits:

| Job | Where | How many work well |
|---|---|---|
| **Look closely** | Fan chart (and later the map's detail view) | 2–3; precise interval reading falls apart beyond that |
| **Compare performance** | Leaderboard, heatmap, any evaluation | Any number; 10–30 is normal, "all hub models" is valid |

Most of the design follows from not forcing one limit onto the other. You select freely for
evaluation; the chart shows a small, stable subset of that selection, and says so.

## Who picks, and what they're after

- **Modelers** pick their own model(s), often local experiments, plus a few references. They know
  exact names and often type them.
- **Evaluators** pick groups: all hub models, one team's variants, one family (all AR models).
- **Analysts** pick a few trusted models and the ensemble they rely on.

All of them come back repeatedly, often to the same sets.

## Decisions (Nov 13, 2026)

1. **Keep the picker's look and opening animation** (the morphing popover from the components page).
2. **One selection, two uses.** Everything selected is evaluated. The fan chart shows **the first three
   selected** (selection order). Beyond three, the chart shows a small note (see below).
3. **The baseline is a toggle, not a model in the list.** It never counts toward the three, and it's
   always grey.
4. **No special treatment for ensembles.** They're models like any other; ensembles vary too much to
   group meaningfully.
5. **No context-free numbers in the list.** Scores like WIS only mean something for a chosen set of
   dates and locations, would be arbitrary in a picker, and wouldn't cover every model, so the list
   can't be sorted or labelled by them.
6. **Categories, yes.** How they look is open (see color, below).
7. **Two click targets per row** (Nov 13). Every row has an empty circle beside the name. Clicking the
   **name** selects the model (for evaluation). Clicking the **circle** puts it on the chart: the circle
   fills with the model's series color, and another charted model comes off. A charted model is always
   selected too.
8. **A charted model with no forecast keeps its slot** (dimmed label "no forecast Dec 27"), so colors
   never shuffle while scrubbing.

## Proposals, refinements and push-back

### Color means "on the chart"

The hard part of color is that 8 series colors have to cover the chart, the evaluation views and the
picker, with 100+ models. Proposal: **only charted models get a series color.**

- The three charted models get the first three free colors and keep them while they stay on the chart.
  With at most three (plus grey baseline), colors never repeat and are always maximally distinct.
- In the picker, **the colored dot is the "on the chart" marker** you asked for. Selected-but-not-
  charted models show a plain check, no color. One mark carries both meanings, instead of a checkbox
  plus a separate chart icon plus a color.
- In evaluation views, charted models are highlighted in their color, so you can find them in a long
  leaderboard; everything else is neutral ink, identified by name. A leaderboard of 25 doesn't need
  25 colors; it has names.
- **Categories get no color at all.** They're carried by grouping (section headers) and a short text
  tag. Color stays reserved for one job: which line on the chart is which.

### Which three are charted

- Default: **the first three selected**, as you said. It's stable: adding a fourth model never moves
  what's on screen.
- **Swapping:** clicking an empty circle charts that model and takes off the one that has been on the
  chart longest. Repeated clicks keep your latest choices, like a queue of three. The new model takes the
  color that was freed, so the other two never change color.
- Clicking a **filled** circle takes that model off the chart and leaves the slot empty. That was an
  explicit choice, so nothing refills it automatically; the chart shows two.
- Free slots are filled automatically only when the selection changes: adding a model fills a free
  slot, and deselecting a charted model frees its slot for the next selected model not yet charted.
- A charted model with no forecast on the current date keeps its slot (colors don't shuffle as you
  scrub through dates). Its label shows in place, dimmed: "flusion · no forecast Dec 27".

### The "more than three" note, and Show all at any count

- Wording: **"Showing 3 of 7 · Show all"**, with *Show all* as the blue link. It appears only when more
  than three are selected; the baseline doesn't count. Placement: a small glass note under the top
  chrome, near the model labels.
- **Show all has to work at 100+.** Colors can't, and labels can't. So Show all adds every other
  selected model as **context**: a thin median line in neutral ink at low strength, no band, no label,
  no dots. The three charted models stay exactly as they were, in color, with bands and labels, drawn
  on top. Seven models or 140 look the same in kind; 140 just makes a denser grey sheaf, which is itself
  informative (it shows the spread of all selected models around the three you're reading).
- Context lines are **identifiable on demand**: hovering one brightens it and shows its name next to
  the pointer; clicking it charts it (it takes a colored slot, like clicking its circle in the picker).
- The readout lists the charted three as usual, then one line "and 137 more selected", with the range
  their medians span that week (the lowest and highest median among them), which is a fact about the
  selection, not a score.
- The note then reads **"Showing all 140 · Show 3"**.
- In the picker, Show all is visible too: every selected-but-not-charted row's circle shows a small
  grey dot ("drawn as context"), so the picker always matches what's on the chart. Charted rows keep
  their filled color.
- Show all is a view toggle, not part of the selection. It's kept with the selection (and in the URL),
  so it survives scrubbing and reloads.
- Performance: 140 models × 5 points is a few hundred line segments, cheap; context lines are drawn in
  one path per model with no dots and no labels to measure.

### What a row in the picker shows

Only facts, nothing computed over an arbitrary window:

- **Name** (short form), with the team in muted text beside it.
- **Category tag**: the model's family (`family` in metadata, otherwise inferred from the name the way
  viz does now: AR, GBQR, flusion…). When neither works, the model is never labelled "Unknown": it goes
  in a last section, **"By team"**, grouped under its team (the part of the id before the first dash,
  or the team name from metadata), and its tag is the team. Every model then has a meaningful group,
  and a team's unparseable variants still sit together.
- **This week's availability**, tied to what you're looking at: if the model has no forecast for the
  current date and location, the row says so ("no forecast Dec 27"). It's contextual, but it's the
  context already on screen, not an arbitrary one.
- **A submission strip**: a tiny row of cells, one per forecast date this season, filled where the
  model submitted. It shows at a glance when a model started, whether it's still running, and how
  complete it is, which is exactly what you need to know before evaluating it. It's the same for
  every viewer and every view.
- **Provenance tag**, from the same classification viz uses today: **Hub** (submitted to the hub),
  **Staged** (experimental iteration in the sandbox), **Local** (from `local-output/`). A modeler's own
  experiments matter most to them and should be easy to find. (The baseline isn't in the list; it's
  the toggle.)
- Hover or expand: methods, data inputs, license, the designated-model flag, from metadata.

### Organizing 100+ models

- **Sections by category**, collapsible, with a count. Within a section, alphabetical.
- **Pinned on top:** "Selected" (in selection order, so you can see the chart three), then "Local
  experiments" if there are any.
- **Search** across name, team and category. Typing a category name ("ar") matches the whole family.
- **Bulk select**, for evaluation: a checkbox on each section header selects the whole category (all
  AR models, all of one team's variants), and shift-click selects a range. Without this, "compare all
  GBQR variants" takes 20 clicks.
- **Recent selections**: the last few sets, one click to restore. People return to the same sets.
- Sort options: by category (default), by name, by most recent submission. No metric sorting, per
  decision 5.

### The baseline toggle

- A switch in the picker's header row, "Baseline", plus the same toggle near the chart's labels.
- It only controls whether the baseline is **drawn**. In evaluation it's always the reference
  (relative WIS is computed against it), so there's nothing to toggle there; the evaluation views
  should say "relative to baseline" rather than list it as a competitor.

### Keyboard and state

- Arrow keys move through rows, Space toggles selection, Enter toggles "on the chart", typing
  searches. Section headers are reachable and collapsible from the keyboard.
- The selection, its order, and the chart three go in the URL, so a shared link reproduces the view.

## Open questions

1. **Local experiments:** pin them on top always, or only for the person who made them (if the app
   ever knows who that is)? Leaning: always, since in a sandbox they are usually yours.
2. **Show all and the leaderboard:** should hovering a context line also highlight that model's row in
   an evaluation view on the same screen? Decide when the evaluation views are designed.

## What "good" means (testable)

- Selecting a fourth model never changes what's on the chart, and the chart says that it didn't.
- From the picker alone, you can tell which models are on the chart, which are only evaluated, and
  which have no forecast this week, without opening anything.
- "All AR models" takes one click; "my local model plus two references" takes three.
- No number in the picker depends on a date range or location set the user didn't choose.
- Colors on the chart are never repeated and never change while scrubbing dates.
- Show all with 140 selected stays readable: the three charted models are as clear as with nothing
  else selected, and any context line can be named with one hover.
- Everything works from the keyboard, and a shared URL restores the selection and the chart three.
