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

## Steps 3–5 (Nov 13, 2026)

- **One layout, two renderers** (`lib/chart.js`). `layoutFan()` decides everything (scales, marks, label
  positions and shortening, measured with canvas `measureText`, cached) and returns a scene in pixels.
  `fanChart()` paints it as SVG for the static pages; `fanCanvas()` paints it on a canvas for the
  interactive chart and returns label hit boxes, so hover and clicks need no DOM reads. Labels on the
  canvas get a visually hidden list of buttons for keyboard and screen-reader users.
- **WebGL glass** (`lib/glass.js`, mode "canvas"). One pass refracts the chart canvas's pixels for every
  glass control, using the SVG filter's own math (the displacement map's formula, quantised as the map
  image is; feDisplacementMap's offset with per-channel dispersion; σ 0.6 blur; saturate; brightness).
  It draws only inside each control's rounded rectangle, with the control's own opacity, and follows
  controls through CSS transitions and animations. The light/dark adaptation now reads the chart's
  pixels from a small copy of the canvas, refreshed at most once per frame and only when asked.
- **Look:** side-by-side screenshots against the previous SVG version at 1:1 (default, Show all,
  focused, light theme) match. One difference by nature: a dimmed median's line and dots fade
  separately rather than as one layer, so where a dot overlaps its line the line shows faintly through.

| Per frame (throttled test browser) | 20 models, before | 20 models, after | 56 models, before | 56 models, after |
|---|---|---|---|---|
| Script (chart, readout, hover, and now the glass pass) | 6–10 ms | 1.5–2.7 ms | 8–10 ms | 1.8–3.1 ms |
| Style + layout | 17–44 ms | 0.3–0.4 ms | 33–42 ms | 0.3–0.4 ms |

Paint is also far smaller (no filtered copies of the chart), but can't be timed from script.

## Plan

1. Benchmark. Done.
2. Precompute interval data. Done.
3. Canvas renderer for the interactive chart. Done (text drawn on the canvas too, so the glass refracts
   it as before).
4. Layer splitting (grid and observed sliding by transform). Not needed for now: a full canvas frame is
   ~1–2 ms; revisit only if a profile says so.
5. WebGL glass. Done.
6. Hover without DOM reads: done (hit boxes from the layout). Still to do: virtualize the picker's rows
   and update them in place instead of rebuilding the list.
