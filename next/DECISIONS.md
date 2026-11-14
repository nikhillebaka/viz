# Decisions

Design and engineering choices made while building `next/`, with what else was considered. Newest
last. Product-shaping ones are marked **owner** until the owner has seen them.

| # | Decision | Alternatives | Why |
|---|---|---|---|
| 1 | No runtime dependencies: no d3. Scales, ticks and date helpers are ~150 lines in `lib/scale.js`. | Vendor d3 v7 (the prototype loaded it from a CDN). | The product promises "no build step" and works offline; the canvas chart used d3 only for scales and formatting. |
| 2 | Fonts load from Google Fonts with system fallbacks, as old viz does. | Vendor Inter and Geist Mono into the repo. | Same policy as the product today. **owner**: vendoring would make the look identical offline. |
| 3 | Fan data is one binary block per (target, season, location), every model included, cached on both sides. | Per-date requests like old viz; JSON. | Scrubbing, the picker's "no forecast" notes and Show all need every round and model at hand; ~1 MB, 0.1–0.5 s cold, instant after. |
| 4 | `server.py` reads the hub from `VIZ_HUB_DIR` when set. | A shadow hub of symlinks. | Lets a worktree copy of viz run against the real hub; default behaviour is unchanged. |
| 5 | Glass: fixed bubbles use the backdrop refraction, chart bubbles the WebGL pass, panels are frosted. No renderer switching on scroll. | The prototype's switch-on-scroll. | The trailing image came from mixing a fixed element with a pass that redraws a frame late. Choosing by where the element lives removes the case. |
| 6 | Glass no longer flips text between light and dark by sampling what's under it. | Keep the sampler (a MutationObserver on the whole document, `elementsFromPoint` per sample). | Costly and fragile for a case the tint already covers. Revisit if a bubble becomes unreadable over the heatmap. **owner** |
| 7 | One motion curve, critically damped. The prototype's default spring overshot by 1.6%. | — | "No bouncy springs." |
| 8 | Rulers and Misses pills become one "95% interval" pill; misses have no toggle. | Keep two toggles; add a third for the level. | See `design/fan-chart.md`. **owner** |
| 9 | The readout leads with the median and works over the observed history. | — | See `design/fan-chart.md`. |
| 10 | Model names are the metadata abbreviation, disambiguated by team, then hub, only when needed. | Full ids everywhere; regex stripping. | 134 synced hub models share abbreviations with local ones. |
| 11 | Family names are merged case-insensitively in the manifest ("Ar" + "AR" → "AR"). | Fix `infer_model_family` in `core/`. | `core/` behaviour must not change for old viz. |
| 12 | Theme defaults to dark, remembered per browser. | Follow the OS. | Old viz's default, and the look the design was judged in. |
