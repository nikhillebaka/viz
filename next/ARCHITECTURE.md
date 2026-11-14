# next/: architecture

The new frontend of viz. Served by the same server at `/next/`, beside old viz (`/`), until parity
(`PARITY.md`). The brief is `design/HANDOFF.md`; design decisions are in `next/design/` and
`DECISIONS.md`. This file is the contract between modules: change it first, then the code.

## Ground rules

- **No build step, no dependencies.** Plain ES modules loaded by the browser, plain CSS. No d3, no
  framework, no npm packages at runtime. Node is used only to run tests.
- **Desktop only.** No phone layouts, bottom sheets, touch-first gestures or compact size classes.
- **One system.** Every color, size, radius, weight and duration comes from `styles/tokens.css`.
  No literal colors or one-off sizes in components (canvas code reads tokens through `lib/dom.js`).
  Two things that do the same job look and behave the same.
- **Concise copy.** Short fragments joined with " · ". No instructional sentences on screen.
- **Motion** is quick and never overshoots: `--dur-fast` / `--dur` / `--dur-move` with `--ease-out` or
  `--ease-spring` in CSS; critically damped springs in JS. `prefers-reduced-motion` switches instantly.
- **Keyboard and screen readers.** Everything works from the keyboard with a visible focus ring
  (`:focus-visible` only). Canvas content gets an equivalent hidden DOM (labels as buttons, a summary).
- **Performance.** At most one chart redraw per animation frame; no DOM reads in a frame's hot path;
  nothing allocates per frame that can be cached. 200+ models must not slow a scrub.
- **Style of code.** Small modules with one job, named exports, JSDoc on every exported function
  (params, return, what it guarantees). Comments say why, not what. No dead code, no `window.__x`
  debugging globals except the single `window.__viz` handle described under Tests.

## Layout

```
next/
  index.html            the page: loads styles, then app.js
  app.js                boot: manifest → state (URL, storage) → shell
  styles/               tokens.css (the system) · base.css · glass.css · controls.css · app.css
  lib/                  no DOM knowledge of the app; reusable
    dom.js              h(), on(), token(), cssColor(), reducedMotion(), store for localStorage
    store.js            the app state container
    scale.js            linear scale, nice ticks, UTC calendar helpers        (replaces d3)
    format.js           dates and values, per target
    api.js              manifest and fan loading, decoding, caching; display names
    position.js         anchored placement for floating layers
  ui/                   the control kit; knows tokens, not the app
    glass.js            liquid glass
    floating.js         popover, menu, tooltip
    controls.js         icons, pill helpers, Stepper, rollText, Segmented, toast
  chart/                the fan chart, no app state
    layout.js           fan + options → scene (pixels)
    render.js           scene → canvas
    timenav.js          date, zoom, pan, height: gestures, keys, springs
  features/             app pieces; each owns its DOM and reads/writes the store
    selection.js        model selection rules (pure)
    FanChart.js         the chart view: canvas, time navigation, hover, focus, readout, chart bubbles
    Shell.js            fixed bubbles, zones, theme, loading and error states
    DatePicker.js  ModelPicker.js  LocationPicker.js  TargetMenu.js
    url.js              state ⇄ URL
  dev/                  serve.py (run from a worktree) · kit.html (every control, every state)
  tests/                unit/*.test.mjs (node --test) · e2e (headless browser), see Tests
  parity/               the old-viz inventory, by area
  design/               goals and decisions per area
```

## Data (server: `core/next_api.py`, routes in `server.py`)

`GET /api/next/manifest` → JSON

```
{ hub, default_target, baseline, recommended: [modelId],
  targets:   [{ id, label, unit, is_rate, non_negative, scale: "count" | "proportion" }],
  locations: [{ id, abbr, name, population }],                // "US" first is not guaranteed
  seasons:   [{ id: "2025-2026", label: "2025–26", rounds: [iso asc], hub_rounds: [iso], start, end }],  // asc
  models:    [{ id, abbr, team, team_name, family, source: "repo"|"local"|"hub"|"synthetic", hub,
                designated, has_metadata, seasons: [id], targets: [id], first, last, rounds: n }],
  hubs:      [{ id, label, short_label, synced, enabled }],
  latest:    { date, season },  truth: { as_of, latest_observation, sources } }
```

`GET /api/next/fan?target=&season=&location=` → binary, everything the chart draws for one season
and place:

```
"VZF1" | uint32 LE header length n | header JSON (n bytes, space padded to 4) | float32 LE body
header = { target, season, location, start, end, rounds: [iso], horizons: [0,1,2,3], quantiles: [..],
           observed: { dates: [iso], offset: 0, length }, prior_max,
           models: [{ id, offset, rounds: [round indexes with a forecast] }] }
body   = observed values, then per model a dense block rounds × horizons × quantiles (NaN = no value),
         starting at float index `offset`
```

All dates are ISO `YYYY-MM-DD`, week-ending Saturdays, UTC. Old viz's endpoints stay available for
everything not yet ported (`docs/api.md`).

## Module contracts

Times in JS are **UTC milliseconds** (numbers) everywhere; ISO strings only at the edges (server,
URL, store).

### lib/dom.js
`h(tag, attrs?, ...children)` element builder (`class`, `style` object, `on*` listeners, `data-*`,
`aria-*`; children: nodes, strings, arrays, null). `on(target, type, fn, opts) → off()`.
`token(name) → string`, `tokenNum(name, fallback) → number`, `cssColor(value) → string` resolves
`var(--x)` to a color for canvas, cached per theme; `onThemeChange(fn)`. `reducedMotion() → bool`.
`storage.get(key, fallback)`, `storage.set(key, value)` (JSON, never throws).

### lib/store.js
```js
createStore(initial) → {
  get() → state,                     // frozen plain object; never mutate
  set(patch | (state) => patch),     // shallow merge; no-op if nothing changed; notifies once, synchronously
  on(fn(state, prev, changed: Set<key>)) → off(),
  select(keys: string[], fn(state, prev)) → off(),   // only when one of keys changed
}
```

### lib/scale.js
`linear([d0, d1], [r0, r1]) → s(v)` with `s.invert(px)`, `s.domain`, `s.range`.
`niceStep(span, count)`, `niceMax(max, count = 5)`, `ticks(lo, hi, step) → number[]`.
`WEEK`, `DAY`; `parseIso(iso) → ms`, `toIso(ms)`, `monthStarts(t0, t1) → ms[]`, `addWeeks(ms, n)`.

### lib/format.js
`fmtDay(ms)` "Dec 27" · `fmtLong(ms)` "Dec 27, 2025" · `fmtMonth(ms)` "Dec", "Jan 2026" for January ·
`valueFormat(target) → { value(v) "12,345" | "1.2%", axis(v) "10k" | "0.5%", compact(v) }`.

### lib/api.js
```js
loadManifest() → Manifest          // the JSON above plus indexes:
  .modelById, .locationById, .seasonById, .targetById (Maps), .seasonOf(iso) → seasonId | null,
  .allRounds → [{ season, iso, t }] asc,
  .label(id, among?) → display name: abbr, made unique among `among` (ids) with team, then hub label
loadFan(target, season, location) → Promise<Fan>     // cached (LRU 24), in-flight requests shared
prefetchFan(target, season, location)                // fire and forget
Fan = {
  target, season, location, rounds: [iso], horizons, quantiles, priorMax,
  dates: ms[],               // the timeline: every week from the first round to the last
  roundAt: Int16Array,       // per timeline index: round index, or -1 for a week without a round
  indexOf(iso) → timeline index | -1,
  observed: [{ t, v }] asc,  observedAt(t) → v | undefined,
  window: [ms, ms],          // the full-season view: first observed week … max(last observed, last round + last horizon)
  present: Set<modelId>,     // models with any forecast here
  has(id, di) → bool,        // a forecast on timeline index di
  points(id, di, level) → [{ t, h, lo, hi, med, anchor? }] | null
        // the anchor (last observed week before the round, if any) then each horizon; lo/hi NaN when the
        // model lacks that level's quantiles; null when it has no median there. Cached, never mutated.
  yMax(ids) → number,        // max of the observed data and of these models' medians over the whole season;
                             // falls back to priorMax when the season has (almost) nothing yet
}
```

### lib/position.js
`computePosition(anchorRect, size, { placement, offset, padding, boundary, flip }) → { x, y, side, maxHeight, maxWidth, origin }`,
`autoUpdate(anchor, floating, fn(why: "scroll" | "layout")) → stop()`.

### ui/glass.js
```js
glass(el, { panel = false, canvas = null }) → { update(), destroy() }
Glass.frame()      // call after redrawing a canvas that glass sits over
Glass.refresh()    // after a theme change
```
One material, three ways to make it, chosen by where the element lives:
- **over a chart canvas, moving with it** (`canvas` given, element not fixed): one WebGL pass refracts the
  canvas's pixels for every such element;
- **fixed to the screen, or over the page**: the same refraction as an SVG `backdrop-filter` (Chromium);
  elsewhere a blur + saturate fallback;
- **panels that hold text** (`panel: true`: popovers, menus): frosted (blur), never refracting.
Honors `prefers-reduced-transparency` (frost everywhere). No light/dark text adaptation: the tint
keeps text readable (see DECISIONS).

### ui/floating.js
```js
openPopover(anchor, { content(body, layer), title?, placement = "bottom-start", width?, morph = false,
                      className?, timeKeys = false, onClose? }) → layer | null   // null: it was open, now closed
openMenu(anchor, { items: [{ label, value?, checked?, icon?, shortcut?, disabled?, danger?, onSelect } | "-" | { header }],
                   placement?, label? }) → layer | null
tooltip(el, text, { placement = "top" })
layer = { panel, body, close(restoreFocus = true), place() }
```
One layer open at a time. Placement and size are settled at open (and when content changes); on page
scroll the layer follows its anchor and closes when the anchor leaves the screen; Escape and outside
click close; the anchor's own click toggles; focus returns to the anchor. `morph` layers grow out of
the anchor and take its place. Lists inside scroll only themselves (`revealInList(el)`).

### ui/controls.js
`icon.{chevronDown,left,right,search,check,close,alert,theme,more}` (SVG strings).
`Stepper(el, { values, index, format: { long, short }, onChange, label, edge?, canEdge?, onLabel? })` with
`.show(i)`, `.setValues(values, i)`; `rollText(el, text, dir, animate)`; `Segmented(el, { items, value, onChange, label })`;
`toast(message, { action? })`; `timeKeys(step, { active? })` (← → step time from anywhere except text
fields and layers that keep their arrows).

### chart/layout.js, chart/render.js
```js
layoutFan(fan, opts, w, h) → scene          // pure: pixels, strings, alphas; no DOM
drawFan(canvas, scene)                      // paints; resolves tokens through lib/dom.js
opts = { models: [{ id, slot | "baseline", label }], t, domain: [ms, ms], ymax, pad: { l, r, t, b },
         topClear, level (0.95 | 0.8 | 0.5 | 0), focus, hover: { t } | null, rulers (0–1),
         context: [{ id, label }], hot, absent: string | null, format }
scene exposes what interaction needs: x, y scales, ref, di, cutoff, labels (with hit boxes),
series, bands, context, rulers.
```

### chart/timenav.js
`TimeNav` as in `design/lib/time.js` (every behaviour in `design/studies/time-navigation.md`), with a
scale object from `lib/scale.js` instead of d3.

### features/selection.js
Pure functions over `{ selected: [id], charted: [{ id, slot, seq }], showAll, baseline, taken: [id] }`:
`select, deselect, toggle, setMany, chart, unchart, toggleChart, setShowAll, setBaseline, context(sel)`,
each returning a new value. Rules: `design/studies/models-goals.md` ("Which five are charted").

## App state (the store) and the URL

| Key | Meaning | URL | Default |
|---|---|---|---|
| `target` | target id | `target` | manifest default |
| `location` | location id | `location` (also reads `loc`) | last used, else `US` |
| `date` | forecast round, ISO | `date` | latest round |
| `sel.selected` | selected models, in order | `models` (comma list; `none` = explicitly empty) | last used, else the first 3 recommended |
| `sel.charted` | up to five, with color slots | `chart` (ids by slot, empty for a free slot) | first five selected |
| `sel.showAll` | grey context lines | `all=1` | off |
| `sel.baseline` | baseline drawn | `base=0` when off | on |
| `level` | interval level | `pi` = 95 · 80 · 50 · 0 | 95 |
| `rulers` | width rulers | `rulers=1` | off |
| `focus` | focused model | `focus` | none |
| `theme` | light / dark | not in the URL (storage) | dark |

`features/url.js`: `readUrl(manifest) → partial state` (invalid values dropped, unknown parameters
kept), `syncUrl(store)` writes with `history.replaceState`, debounced. The season is never stored: it
follows from the date. Zoom, pan and height are view state inside the chart, not in the store.

## Tests

- `node --test next/tests/unit/` for pure modules (scale, format, selection, fan decoding, layout rules).
- End-to-end checks run headless at 1440×900 against the dev server from one command, pass/fail exit
  code (set up after the first milestone; cases start from the prototype's four check scripts).
- `window.__viz = { store, chart, nav, manifest }` is the only global, for the e2e checks.

## Running

```bash
python next/dev/serve.py --port 8610        # from a worktree; finds the hub upward, or pass --hub
./run.sh                                    # in a normal install: old viz at /, new at /next/
```
