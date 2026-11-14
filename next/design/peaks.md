# Peaks: one row per model — when · how high · how right

A peak forecast answers two questions: when the season peaks, and how high. The joint box (week ×
size) is never drawn for every model; each model gets one row with the two marginals side by side,
read against the observed peak drawn as a line through each column. Rows scale to 50+ models and sort.

## Top to bottom

1. **Headline** (one quiet line): place · season · round · `Peak so far 86 · Oct 17 · provisional`
   (or `Observed peak …` when final), then, with ≥2 models, the consensus in primary ink:
   `Most likely Dec 20 – Jan 10 · 110–210` — the 25–75% span of the averaged week distribution and
   the median of the models' 25% / 75% size quantiles.
2. **Season strip** (160px): this season's observed curve to the data cutoff (nothing after), up to
   three past seasons faint with end labels, the round as a hairline, the observed peak as a diamond
   (hollow while provisional, filled when final). Its x-axis is the When column's, pixel for pixel
   (the strip spans the name and When columns; its plot starts where When starts). No model marks by
   default; hovering or focusing a row draws that one row's box: 50% week × 50% size as a soft fill,
   90% as whiskers, the medians as a dot. That is the only place the 2D box exists.
3. **Rows** (24px, DOM rows with two small canvases each; repainted on resize, DPR and theme):
   - Name: dot only when charted on the fan chart (`seriesColor(slot)`); chevron when it has rounds.
   - When: the peak-week distribution as a one-row density strip, one cell per week, opacity ∝
     probability normalised to the row's own max (series color if charted, else ink), with a short
     median tick. Density, not an interval, because these are often bimodal. No distribution → a
     50%/90% interval bar; nothing → blank.
   - How high: its own 0…nice-max axis (labels in the header): 90% hairline, 50% thick bar, median dot.
     The max ignores the widest fifth of 90% upper ends so one wild model can't flatten the rest;
     whiskers past it end in a caret.
   - Observed truth: a vertical line at the observed week and size through both columns, labelled
     once in the header. Dashed and tertiary while provisional; solid when final.
   - How right (final peak only; the columns are absent otherwise): Δ week, Δ size %, and which of
     when / high the 50% and 90% intervals covered, from the response's `scores`.
   - First row **All models** with ≥2 models: averaged week distribution, median size quantiles.
   - Headers sort: Model, When (median week, default), How high (median); again reverses.
   - Hover / focus: the row is emphasised, others dim, its box shows on the strip, the fan chart
     previews it. Click a strip: focus (only when charted). A readout gives week + probability or the
     size quantiles.
4. **Expand** (click the name): one sub-row per round, newest first, same grammar, observed lines
   running through. The round's date moves the chart there.
5. Below: **Season skill** (its scope and shared-rounds fragments in its sub-heading) beside the
   **Peak map** (model and layer fragments in its sub-heading).

States: no peak target → one quiet line; no forecasts this round → headline and strip, then
`No peak forecasts · Nov 14 · Go to Nov 7`; loading hairline from the frame.
