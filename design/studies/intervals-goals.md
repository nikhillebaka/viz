# Prediction intervals: goals

Before designing anything, this pins down what the interval display is for, what has to be true
for it to be good, and what we've already learned. Every candidate design gets judged against it.

## Who looks at intervals, and why

- **Modelers** (hub participants) checking their own forecast against others and against what happened.
- **Hub organizers and evaluators** comparing models and spotting outliers or miscalibration.
- **Public health analysts** reading what the ensemble or a trusted model expects, and how sure it is.

All of them are experts. They know what a quantile is. They are not looking for a simplified picture;
they want an accurate one that doesn't take effort to read.

## The questions, in rough order of importance

1. **"Where does this model think it's going, and how sure is it?"**
   Read one model's median and its interval at each horizon, including exact values on demand.
2. **"Do the models agree?"**
   See whether intervals overlap (consensus) or don't (genuine disagreement), across 2–8 models.
3. **"Which model is more certain, and how does that change with horizon?"**
   Compare interval widths between models, and see how each widens from this week to three weeks out.
4. **"Did it work?"**
   Once later data exist: did the observed value land inside the interval, and where in it?
5. **"Is the risk lopsided?"**
   See when a distribution leans one way, typically a long upper tail before a peak.
6. **"How has this forecast moved?"** Compare with the same model's earlier rounds (secondary; trails).

## The data we're drawing

- Each model gives 23 quantiles at each of 4 horizons (this week to 3 weeks ahead), weekly.
- Standard central intervals: 50%, 80%, 95% (98% is available from the 0.01/0.99 quantiles).
- Forecasts are discrete weekly values. Drawing them as a continuous band between weeks is an
  interpolation the data don't contain.
- There are 100+ models, but people compare a handful on the chart; up to 8 get distinct colors.

## Constraints from the design system

- **Hierarchy:** observed data and medians come first. Intervals are context and must not dominate.
- **Fixed y-axis:** intervals can run off the top; we never rescale to fit them.
- **Color:** pastel model colors on black, vivid on light. Translucent fills of different colors
  blend into new colors where they overlap, which reads as mud and can look like another model.
- **Readable by everyone:** model identity can't depend on fill color alone.
- **Sizes:** has to work at phone width, where the four horizons sit only a few dozen pixels apart.
- **Glass:** controls float over the chart; intervals near the edges sit under glass.

## What we've tried, and what it taught us

| Approach | Where | What went wrong |
|---|---|---|
| Gradient fan (all 23 quantiles, layered) | prototypes v3, glass | Beautiful for one model; bold and tangled from two models up. |
| One translucent band per model | current viz (95% at 10% opacity), study 9 "one band" | Usable because it's quiet and shows one level. Overlaps still blend, and widths are hard to compare. |
| Side by side (dodged) | study 9 | Never overlaps, but shifting models off the true date reads as different dates. |
| Focus on hover | study 9 | Clean, but hides information until you go looking for it; nothing to compare at a glance. |
| Small multiples | study 9 | Each model is clear, but direct comparison, the main point, is lost. |
| Width rulers beside the fan | current viz (optional) | Makes width comparison easy, but only at the last horizon and away from the data. |

The current viz stays the most usable because it is restrained: one level, very low opacity,
medians on top. Any new design has to beat it on comparison and clarity without losing that restraint.

## What "good" means (testable)

- With three models on screen, someone can say **within a few seconds** which model is most
  uncertain three weeks out.
- **Agreement is visible** (overlap versus a clear gap) without inventing colors where fills mix.
- Any model's interval at any horizon can be **read exactly** with one hover or tap.
- Works at **1, 3 and 8 models**, and degrades gracefully if more are shown.
- **Medians and observed data remain the most prominent** marks at every model count.
- Works at **390px wide** and in both themes.
- **Identity survives colorblindness**: label, position or shape carries it as well as color.
- **Honest**: nothing implies continuity, precision or certainty the forecast doesn't have.

## Decisions (Nov 12, 2026)

1. **Optimize for comparing 2–3 models.** That is the real use. The biggest goal is removing clutter.
   While comparing, reading each interval **precisely** is essential, not a nice-to-have.
2. **95% interval by default**, one level.
3. **Continuous bands** between forecast weeks.
4. **Keep the width rulers** (each model's interval drawn as a bar beside the fan, from the current
   viz) as a toggle. They are one of the best tools for precise comparison.
5. **Calibration, quietly:** only when it helps and stays out of the way. Proposed: when you look at a
   past forecast date and the observed values for those weeks exist, observed points that fall outside
   a model's 95% interval get a small mark, shown for the model you're focused on. Nothing by default
   for live forecasts, since the future hasn't happened.

Still open, to settle while prototyping:
- Anchored to the last observed point, or starting at the first horizon.
- How much lopsided distributions show (the median sitting off-centre in its band already shows some).

## What this means for the design

- With only 2–3 models, overlap is real but limited. The problem to solve is **clarity of each band
  where they overlap**, not scaling to many models.
- Precision means **edges matter more than fills**: a reader has to see exactly where each band starts
  and stops, even through another band. Fill alone (the current viz) makes edges vague where bands stack.
- Clutter comes from fills stacking, too many marks per model, and labels competing. The design should
  use as little ink as possible per band while keeping its edges exact.

## Study 1: six renderings (studies/intervals.html)

Same data, same chart, only the band drawing changes. Shared by all six: hover or tap snaps to a
forecast week, draws exact caps at that week for every model, and shows a solid readout with each
95% range, its half-width and the observed value. Width rulers (toggle) show each model's interval
beside the fan at the hovered week, defaulting to 3 weeks ahead. Misses (toggle) ring observed points
outside the focused model's interval. Bands that leave the fixed y-axis get a small chevron at the top.

| | Variant | First read |
|---|---|---|
| A | Current viz: 10% fill, no edges | Overlaps stack into a haze; in "Close" the middle model's edges are lost. |
| B | Edges only | Least ink, nothing blends. Six coloured lines compete with the medians; spaghetti at 8. |
| C | Edge and whisper: 5.5% fill + hairline edges | Best all-round at 2–3: the fill says "region", the edge says exactly where it stops. |
| D | Focused model filled, others dashed edges | Most precise for one model while keeping the others comparable. Needs a focus, which misses already use. |
| E | Faint band + caps at each forecast week | The most honest about interpolation, but four caps per model is busy at 3 models. |
| F | Edges + neutral agreement zone | The only one that answers "do they agree?" directly. Near-identical models make the zone almost the whole band. |

Leaning (to confirm by looking): **C as the default, with D's focus on top.** Clicking a model's label
promotes it to fill and a slightly stronger edge; the others stay as hairline edges. Keep hover caps,
the readout, rulers and misses as shared behaviour. F's agreement zone is worth keeping as an idea for
an "agreement" view rather than the default. Anchoring: start from the last observed point, as today;
it reads as continuous with the data and the observed value really is known.

## Study 2: full-screen refinement (studies/intervals-refine.html)

Chosen direction: **C as the default, D's focus on top.** Feedback on study 1: whisper edges could be
mistaken for medians at first glance, and the overflow arrows were confusing.

- **Edges no longer look like lines.** The default edge ("Rim") is a soft 3px tint just inside each
  band's boundary, along the lower and upper edges only. The boundary is still exact (it is where
  the fill stops), but it reads as the edge of a region. Medians stay the only solid lines with week
  dots. For comparison, a study-only knob at top centre also offers "Fine" (0.75px at half strength)
  and "Dotted".
- **Overflow arrows removed** (here and in study 1). Bands just run off the top of the fixed axis;
  the readout gives the exact values.
- **Focus:** hover a label to preview, click to lock, click again or press Escape to clear. The focused
  model gets a 13% fill and a stronger rim; the others keep only a quieter rim, and their medians,
  labels, rulers and readout rows dim. Misses show only for the focused model (or a lone model).
- **Readout** sits over the history, left of the forecast date line, so it never covers a band. On
  phones it docks bottom-left. Left and right arrow keys step through forecast weeks when the chart
  has focus.
- **Full screen with the real chrome:** model set top left, edge knob top centre, rulers and misses
  bottom left, date bottom centre, model count bottom right. On phones, the set collapses into a menu
  and rulers become an icon.

### Decided after study 2 (Nov 12, 2026)

- **Edges: Fine** (0.75px at half strength). The rim and dotted options and the study knob are gone.
- **Fill strength by theme:** whisper 7.5% in dark, 6% in light; focused 15% in dark, 13% in light.
  Dark needs slightly more to read as clearly.
- **Observed data more prominent:** primary ink, a 1.5px line and 2.9px points (they were secondary
  ink, 1.25px and 2.4px). It is now clearly the strongest mark on the chart.

### Study 2, round 3: observed data, reference date and data cutoff

- **All observed data is drawn**, the whole season, from the left edge to the right edge, not just
  up to 3 weeks ahead.
- **Solid to dotted, copied from viz:** history is every week before the reference date, and its last
  point is the data cutoff (where the forecasts are anchored). The line is solid through the cutoff
  and dotted after it. The four scored weeks keep hollow points; the rest of the season is only the
  dotted line. Model labels get a surface-coloured halo so the line can pass behind them.
- **Three ways to mark the reference date and data cutoff** (study knob, top centre):
  - *Lines*: as in viz. A faint tint between cutoff and reference date, a dotted cutoff line, a
    hairline at the reference date, small labels by the axis.
  - *Shade*: no vertical lines. Everything after the cutoff (unknown when the forecast was made) is
    faintly tinted to the right edge, and the reference date is a tick and label on the axis.
  - *Axis*: nothing in the plot. The forecast window is a heavier stretch of the x-axis with a dot
    per forecast week, and the reference date is labelled under it.
- **Decided: Shade.** Both dates are ticks below the axis, labelled outward on two lines: the name
  quiet on top ("Data cutoff", "Reference date"), the date stronger beneath ("Dec 20", "Dec 27").
  The cutoff label reads leftward over the history; the reference date reads rightward into the
  forecast, so they never collide, even on phones. Month labels that would crowd them are hidden.
  Earlier tries: one label above the axis and one below looked unbalanced; name and date on one line
  ran together into one word. The study knob, Lines and Axis are removed.

## Folded into the design system (Nov 12, 2026)

- `lib/chart.js` `fanChart` now draws the settled design (see the header comment there): full-bleed,
  observed solid then dotted, shaded cutoff with two-line date labels, 95% whisper bands with fine
  edges, optional focus, rulers, misses and a hover hairline. `bands()` gives the geometry for readouts.
  `--band-whisper` and `--band-focus` are tokens. The refinement page now uses `fanChart` directly.
- Hover no longer draws width caps at the hovered week; the hairline and the readout are enough.
- Time keys (`timeKeys` in `lib/controls.js`): left and right always step the forecast date while a
  fan chart is on screen, wherever focus is (text fields and open menus keep their arrows). Pressing
  an arrow after clicking a control drops that control's focus, so no ring appears. Focus moved by
  script (menus opening and closing) only shows a ring when the user is on the keyboard.
