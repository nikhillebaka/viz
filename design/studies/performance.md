# Performance

Goal: the fan chart stays smooth with 100+ selected models, without changing how anything looks or
feels. Measure first, then change one thing at a time; behaviour is guarded by `tests/time-nav-check.js`
and `tests/selection-check.mjs`, speed by `tests/perf-check.js`.

## Benchmark

`tests/perf-check.js`, on the fan chart page: `(await import("/tests/perf-check.js")).run()`.
For 5, 20 and all selected models (5 charted, the rest as Show all context) it times synthetic frames of
a scrub, a pan and a pinch: **script** (building the chart, readout, hover) and **layout** (the style and
layout that forces). Paint and the glass's re-rendering can't be timed from script; in a visible tab,
`run({ real: true })` also runs a live 2 s scrub with glass on and off and reports real frame intervals.

Numbers below are from a throttled background browser (several times slower than a normal tab), so
compare them with each other, not with the 16 ms frame budget.

## Findings (Nov 13, 2026)

| Measurement | Before | After step 2 |
|---|---|---|
| Interval data per frame, 20 models | 0.86 ms | 0.16 ms |
| Interval data per frame, all 56 models | ~2.4 ms | 0.43 ms |
| Script per frame, 20 models (median) | 10–12 ms | 6–10 ms |
| Style + layout per frame, 20 models, glass on | 33–37 ms | similar (untouched) |
| Style + layout per frame, 20 models, glass refraction off | 12 ms | similar |

- **The glass is the biggest cost.** Each refracting control holds a live `<use>` copy of the whole
  chart, so every rebuilt chart is restyled and laid out once per control (8 here): refraction alone
  triples layout time, before the extra paint of 8 filtered copies. It grows with model count because
  there are more paths to copy.
- **Rebuilding the SVG every frame** is the second cost (hundreds of elements removed and recreated).
- **Data work was a smaller, easy win** (step 2, done): each model's interval points per forecast date
  are computed once and reused (no per-frame allocation on whole weeks; in-between frames interpolate
  from two cached arrays with plain-number dates).

## Plan

1. Benchmark. Done.
2. Precompute interval data. Done.
3. Draw the plot (bands, edges, medians, context lines, observed, grid) on a canvas at device pixel
   ratio; keep text as HTML/SVG so it renders identically.
4. Split layers: grid and observed only slide during a scrub or pan (GPU transform, no redraw);
   only the forecasts redraw each frame.
5. Glass: refract the chart's pixels instead of re-rendering its vector scene, ideally one WebGL pass
   for all controls (same displacement, blur, saturation, brightness), verified against today's look
   with side-by-side screenshots. Fallback: refract a cached image of the chart.
6. Hover and readout without DOM reads; picker rows virtualized and updated in place.
