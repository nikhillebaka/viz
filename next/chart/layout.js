/* The fan chart's layout: a Fan (lib/api.js) and options → a scene in pixels. Pure: no DOM; text is
 * measured by the injected opts.measure. chart/render.js paints the scene; interaction (hover, clicks,
 * the readout) reads it through lineUnder(), labelAt() and hoverInfo().
 *
 * Chart rules:
 *  - straight segments between points, no smoothing; a fixed y-axis that never rescales to fit bands.
 *  - no ceiling or walls: grid, bands and observed data run under the chrome to the edges of the view.
 *    Only the x-axis clips.
 *  - observed data is the strongest mark: the whole season, solid through the data cutoff (the last
 *    observed week before the reference date, where forecasts are anchored), dotted after, broken where a
 *    week is missing. The scored weeks keep hollow points. With opts.outcome false nothing observed after
 *    the cutoff is drawn.
 *  - everything after the cutoff is faintly shaded; the cutoff and reference date are ticks under the
 *    axis, labelled outward on two lines (name, then date).
 *  - interval levels (any of 95 · 80 · 50): nested fills, each layer at the whisper alpha so the centre
 *    reads darker, and fine edges at half strength on the widest level only, anchored at the cutoff.
 *    Medians are the only solid lines with week dots.
 *  - focus: the focused model gets a stronger fill and edge; the others keep only their edges, and their
 *    medians and labels dim.
 *  - slot n is var(--series-(n % 8 + 1)); the baseline is var(--series-baseline).
 *
 * opts:
 *   models   [{ id, slot: 0–7 | "baseline", label }]  charted, in drawing order; labels are display names
 *   t        fractional timeline index (default: the last week); between weeks everything interpolates
 *   settle   the timeline index t is heading to (default: the nearest week): the date ticks and ghost
 *            labels name it, so they agree with the stepper while the chart glides
 *   domain   [ms, ms] the x view (default: 14 weeks before the reference date to the last horizon)
 *   ymax     the continuous y-axis maximum (already divided by the height zoom)
 *   pad      { l, r, t, b } plot insets; topClear: y above which y tick labels hide (default pad.t − 32)
 *   levels   [0.95, 0.8, 0.5] any of them, widest first ([]: no bands; medians always)
 *            (or level: one of them, 0 for none)                     focus: a charted id, or null
 *   anchorAt { t, v } | null: start every forecast at v instead of the observed value at t (As reported)
 *   hover    { t: ms week } | null: a hairline at that week          rulers: 0–1 (animates in and out)
 *   context  [{ id, label }] grey medians (Show all)                 hot: a context id lifted and named
 *   absent   one quiet line under the labels ("2 not in 2023–24"), or null
 *   outcome  false: nothing observed after the cutoff (default true)
 *   format   lib/format.js valueFormat(target): axis(v) for tick labels
 *   measure  (text, font) → px width                                fonts: { sans, mono, chart, axis, micro }
 *
 * The scene (plain numbers, strings and arrays, plus the two scales):
 *   w, h, pad, ay (axis y), topClear, x, y (lib/scale.js linear scales: ms → px, value → px)
 *   t, di (the nearest timeline index), settle (the index the labels name), whole (t is on a week), ref (ms), cutoff (ms), level (the widest, or 0), levels, lastH,
 *   ymax, outcome, focus (the focused id when it is charted, else null), fonts { label, axis }
 *   ticks    [{ v, y, text | null }]  gridlines from the round step, up to the top edge; tickX
 *   months   [{ x, text }]            shade: x where the forecast shade starts
 *   dates    { cut: { x, date }, ref: { x, date } }   the two date ticks
 *   series   [{ id, slot, label, c, pts }]  charted models with a forecast (pts: { t, h, lo, hi, med, anchor? } at
 *            the widest level; lv: pts per level, null where the model has none)
 *   bands    [{ id, c, fill: "whisper" | "focus" | null, edgeAlpha, lo, hi, inner: [{ lo, hi }] }]  lo/hi:
 *            the widest level the model has (with edges); inner: the narrower ones (fill only)
 *   medians  [{ id, c, alpha, line, dots }]                                   drawing order
 *   context  [{ id, label, pts, line }]  contextAlpha;  hot: { id, line } | null (drawn over the rest)
 *   observed { all: [path], known: [path], points: [{ x, y, alpha, fill }] }  (paths split at gaps)
 *   misses   { alpha, c, list: [{ x, y }] } | null
 *   rulers   { k, shift, labelX, label, h, rows: [{ id, c, x, lo, hi, med, alpha }] } | null
 *   labels   [{ id, x, y, text, full, font, size, weight, len, fill, dotR, dotC, dotAlpha, ctx, hot,
 *               ghost, summary, hit: { x0, x1, y0, y1 } | null }]
 *   hoverX   x of the hover hairline, or null;  missing: charted ids with no forecast this week
 * Every path (line, lo, hi, dots, observed parts) is a flat array [x0, y0, x1, y1, …]. */
import { WEEK, linear, niceStep, ticks as steps, monthStarts } from "../lib/scale.js";
import { fmtDay, fmtMonth } from "../lib/format.js";
import { fitLabels } from "../lib/labels.js";

const GAP = 1.5 * WEEK;          // observed weeks further apart than this are not joined
const LABEL_GAP = 18;            // label spacing
const CTX_GAP = 16;              // the least distance at which a grey label may sit near another
const INK1 = "var(--ink-primary)", INK2 = "var(--ink-secondary)", INK3 = "var(--ink-tertiary)";
const DEFAULT_FONTS = { sans: "Inter, system-ui, sans-serif", mono: "ui-monospace, monospace", chart: 11.5, axis: 10.5, micro: 11 };

/**
 * @param {number | "baseline"} slot
 * @returns {string} the CSS color of a color slot
 */
export const seriesColor = (slot) => (slot === "baseline" ? "var(--series-baseline)" : `var(--series-${(slot % 8) + 1})`);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const font = (weight, size, family) => `${weight} ${size}px ${family}`;
const approxMeasure = (text, f) => text.length * 0.56 * (parseFloat(/(\d+(?:\.\d+)?)px/.exec(f)?.[1]) || 11);

// formatted dates repeat every frame; Intl formatting is not free
const dayText = new Map(), monthText = new Map();
const memo = (cache, fn) => (ms) => { let s = cache.get(ms); if (s === undefined) { s = fn(ms); cache.set(ms, s); } return s; };
const day = memo(dayText, fmtDay), month = memo(monthText, fmtMonth);

function fitText(str, f, room, measure) {
  if (measure(str, f) <= room) return str;
  let s = str;
  while (s.length > 2 && measure(s.trimEnd() + "…", f) > room) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}

const bandable = (pts) => pts.every((p) => Number.isFinite(p.lo) && Number.isFinite(p.hi));

/**
 * A model's points at a fractional timeline index: on a week, the Fan's cached points; between two
 * weeks, every point moves from its place in one forecast to its place in the next. When only one side
 * has a forecast (or the two differ in shape), that side's points are shown.
 * @param {import("../lib/api.js").Fan} fan
 * @param {string} id
 * @param {number} t fractional timeline index
 * @param {number} level
 * @returns {readonly object[] | null}
 */
export function pointsAt(fan, id, t, level) {
  const n = fan.dates.length;
  if (!n) return null;
  const i0 = clamp(Math.floor(t), 0, n - 1), i1 = Math.min(n - 1, i0 + 1), u = clamp(t - i0, 0, 1);
  if (u < 1e-4 || i0 === i1) return fan.points(id, i0, level);
  if (u > 1 - 1e-4) return fan.points(id, i1, level);
  const a = fan.points(id, i0, level), z = fan.points(id, i1, level);
  const one = a || z;
  if (!one) return null;
  // only one side has a forecast: it folds into (or unfolds from) its first point, so a model never
  // pops on or off between weeks. k is how open it is: 1 on its own week, 0 on the week without it.
  if (!a || !z) return folded(one, a ? 1 - u : u);
  if (a.length !== z.length) return one;
  const pts = new Array(a.length);
  for (let k = 0; k < a.length; k++) {
    const p = a[k], q = z[k];
    pts[k] = { t: p.t + (q.t - p.t) * u, h: p.h, lo: p.lo + (q.lo - p.lo) * u, hi: p.hi + (q.hi - p.hi) * u, med: p.med + (q.med - p.med) * u, anchor: p.anchor };
  }
  return pts;
}

/* A forecast folded toward its first point (the anchor at the data cutoff) by k (1 open, 0 closed). */
function folded(pts, k) {
  if (k > 1 - 1e-4) return pts;
  const o = pts[0], out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    out[i] = { t: o.t + (p.t - o.t) * k, h: p.h, lo: o.med + (p.lo - o.med) * k, hi: o.med + (p.hi - o.med) * k, med: o.med + (p.med - o.med) * k, anchor: p.anchor };
  }
  out.open = k; // how open it is (its label fades with it)
  return out;
}

// the data cutoff for a reference date: the last observed week before it (else the week before)
function cutoffFor(fan, ref) {
  const o = fan.observed;
  let lo = 0, hi = o.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (o[mid].t < ref) lo = mid + 1; else hi = mid; }
  return lo > 0 ? o[lo - 1].t : ref - WEEK;
}

// interpolate the cutoff across neighbouring rounds so scrolling beyond truth never jumps mid-animation
function cutoffAt(fan, t, ref, whole) {
  const D = fan.dates;
  if (!D.length) return ref - WEEK;
  if (whole) return cutoffFor(fan, ref);
  const i0 = clamp(Math.floor(t), 0, D.length - 1);
  const i1 = clamp(Math.ceil(t), 0, D.length - 1);
  if (i0 === i1) return cutoffFor(fan, D[i0]);
  const frac = clamp(t - i0, 0, 1);
  const c0 = cutoffFor(fan, D[i0]), c1 = cutoffFor(fan, D[i1]);
  return c0 + (c1 - c0) * frac;
}

// the horizon a week falls on, relative to timeline week di, or null outside the forecast window
function horizonOf(fan, di, t) {
  if (!Number.isFinite(t) || !fan.dates.length) return null;
  const h = Math.round((t - fan.dates[di]) / WEEK);
  return fan.horizons.includes(h) ? h : null;
}

/* Labels in a column: keep `gap` apart and inside [top, bottom]. Pushed down from the top first; then,
 * if the last one overflows the bottom, the overflowing run is pushed back up. NaN means "right after
 * the previous one" (or the middle of [top, bottom] for the first). If they can't all fit at `gap`,
 * they share the room evenly. */
function stack(labs, top, bottom, gap) {
  const n = labs.length;
  if (!n) return;
  for (let i = 0; i < n; i++) {
    const want = Number.isFinite(labs[i].y) ? labs[i].y : i ? labs[i - 1].y + gap : (top + bottom) / 2;
    labs[i].y = Math.max(want, top, i ? labs[i - 1].y + gap : -Infinity);
  }
  if (labs[n - 1].y > bottom) {
    labs[n - 1].y = bottom;
    for (let i = n - 2; i >= 0; i--) labs[i].y = Math.min(labs[i].y, labs[i + 1].y - gap);
  }
  if (labs[0].y < top) { const g = n > 1 ? (bottom - top) / (n - 1) : 0; labs.forEach((d, i) => { d.y = top + i * g; }); }
}

/**
 * Lays out the fan chart. Pure; see the header for opts and the scene.
 * @param {import("../lib/api.js").Fan} fan
 * @param {object} opts
 * @param {number} w CSS px
 * @param {number} h CSS px
 * @returns {object} the scene
 */
export function layoutFan(fan, opts, w, h) {
  const F = { ...DEFAULT_FONTS, ...opts.fonts };
  const measure = opts.measure || approxMeasure;
  const axisFmt = opts.format?.axis || String;
  const pad = { l: 56, r: 150, t: 72, b: 64, ...opts.pad };
  const D = fan.dates, n = D.length;
  const lastH = fan.horizons.length ? Math.max(...fan.horizons) : 3;
  const levels = Array.isArray(opts.levels) ? opts.levels : opts.level === 0 ? [] : [opts.level ?? 0.95];
  const level = levels[0] ?? 0, outcome = opts.outcome !== false;
  // t: fractional timeline index. Integer t is an ordinary week; in between, everything interpolates.
  const t = opts.t ?? n - 1, di = clamp(Math.round(t), 0, Math.max(0, n - 1)), whole = Math.abs(t - di) < 1e-4;
  const tc = clamp(t, 0, Math.max(0, n - 1));
  const ref = whole ? D[di] : D[0] + tc * WEEK;
  const si = Number.isInteger(opts.settle) ? clamp(opts.settle, 0, Math.max(0, n - 1)) : di;
  const models = opts.models || [];
  const rulerStep = w < 600 ? 11 : 14;
  // rulers sit in the margin beside the fan and push the labels aside; they never narrow the plot
  const rk = clamp(+opts.rulers || 0, 0, 1);
  const rulerW = 18 + models.length * rulerStep;
  const x = linear(opts.domain || [ref - 14 * WEEK, ref + lastH * WEEK], [pad.l, w - pad.r]);
  const ay = h - pad.b;
  const ymax = opts.ymax > 0 ? opts.ymax : fan.yMax(models.map((m) => m.id));
  const y = linear([0, ymax], [ay, pad.t]);
  const cutoff = cutoffAt(fan, t, ref, whole);

  // charted models: those with points here are the series; the rest keep their slot as a dimmed label
  const S = [], missing = [];
  // As reported on: each forecast starts from the value as it was published at the cutoff (what the
  // model saw), not today's revised value
  const av = opts.anchorAt;
  const reanchor = (pts) => (pts && av && pts[0]?.anchor && Math.abs(pts[0].t - av.t) < WEEK / 2
    ? [{ ...pts[0], lo: av.v, hi: av.v, med: av.v }, ...pts.slice(1)] : pts);
  for (const m of models) {
    const pts = reanchor(pointsAt(fan, m.id, t, level));
    if (!pts) { missing.push(m); continue; }
    const lv = [pts];
    for (let k = 1; k < levels.length; k++) lv.push(reanchor(pointsAt(fan, m.id, t, levels[k])));
    S.push({ id: m.id, slot: m.slot, label: m.label, c: seriesColor(m.slot), pts, lv, open: pts.open ?? 1 });
  }
  const B = level ? S.filter((s) => bandable(s.pts)) : [];
  const C = [];
  for (const c of opts.context || []) { const pts = reanchor(pointsAt(fan, c.id, t, level)); if (pts) C.push({ id: c.id, label: c.label, pts }); }
  const f = opts.focus, hasFocus = f != null && S.some((s) => s.id === f);
  const dim = (id) => hasFocus && id !== f;
  const order = (arr) => (hasFocus ? [...arr.filter((b) => b.id !== f), ...arr.filter((b) => b.id === f)] : arr);
  const path = (pts, k) => { const out = new Array(pts.length * 2); for (let i = 0; i < pts.length; i++) { out[2 * i] = x(pts[i].t); out[2 * i + 1] = y(pts[i][k]); } return out; };

  // grid: round values from the step, continuing above the axis maximum to the top edge
  const stepV = niceStep(ymax, 5), vTop = y.invert(0);
  const topClear = opts.topClear ?? pad.t - 32;
  const ticks = [];
  for (const v of steps(stepV, vTop, stepV)) {
    if (v >= vTop) break;
    const ty = y(v);
    ticks.push({ v, y: ty, text: ty - 6 > topClear + 10 ? axisFmt(v) : null });
  }

  // the cutoff shade, the two date ticks, and the month labels that don't crowd them
  const xc = x(cutoff), xr = x(ref);
  const markL = xc - 84, markR = xr + 104;
  const monthFont = font(500, F.chart, F.sans), cand = [];
  for (const m of monthStarts(x.invert(0), x.invert(w))) {
    const px = x(m);
    if (px + 40 < w && (px + 44 < markL || px + 4 > markR)) cand.push({ x: px + 4, text: month(m), pri: /\d/.test(month(m)) ? 1 : 0 });
  }
  const months = fitLabels(cand, (t) => measure(t, monthFont), 10);
  // while between weeks, the labels name the week the chart will settle on (what the stepper shows)
  const dates = { cut: { x: xc, date: day(whole && si === di ? cutoff : cutoffFor(fan, D[si])) }, ref: { x: xr, date: day(D[si]) } };

  // bands: unfocused first so the focused one sits on top; per model, the levels it has quantiles for
  const BL = [];
  for (const s of S) {
    const ls = s.lv.filter((pts) => pts && bandable(pts));
    if (ls.length) BL.push({ id: s.id, c: s.c, ls });
  }
  const bands = order(BL).map((b) => ({
    id: b.id, c: b.c, fill: dim(b.id) ? null : hasFocus ? "focus" : "whisper",
    edgeAlpha: Math.min(1, 0.55 * (hasFocus ? (b.id === f ? 1.5 : 0.7) : 1)),
    lo: path(b.ls[0], "lo"), hi: path(b.ls[0], "hi"),
    inner: b.ls.slice(1).map((pts) => ({ lo: path(pts, "lo"), hi: path(pts, "hi") })),
  }));
  const hoverX = opts.hover && Number.isFinite(opts.hover.t) ? x(opts.hover.t) : null;
  const context = C.map((c) => ({ id: c.id, label: c.label, pts: c.pts, line: path(c.pts, "med") }));
  const contextAlpha = hasFocus ? 0.45 : 0.75;

  // observed: the whole season (drawn dotted, clipped to after the cutoff) and the known part (solid,
  // split exactly at the cutoff while scrubbing). Both break where a week is missing. The dotted line
  // always starts at the first observed week, so its dots are pinned to the data.
  const O = fan.observed, all = [], known = [];
  let seg = null, kseg = null, prev = -Infinity, last = null, next = null;
  for (const o of O) {
    const px = x(o.t), py = y(o.v), broken = o.t - prev > GAP;
    if (outcome) { if (broken) all.push((seg = [])); seg.push(px, py); }
    if (o.t <= cutoff) { if (broken) known.push((kseg = [])); kseg.push(px, py); last = o; }
    else if (!next) next = o;
    prev = o.t;
  }
  if (!whole && last && next && last.t < cutoff && next.t - last.t <= GAP) {
    const v = last.v + (next.v - last.v) * ((cutoff - last.t) / (next.t - last.t));
    kseg.push(x(cutoff), y(v));
  }
  // points change continuously with the cutoff, so nothing pops in when an animation lands.
  // k = weeks after the cutoff: k <= 0 known (filled); over the week before the cutoff reaches a point it
  // fills in gradually; 0 < k <= 4 are the scored weeks (hollow); past that, points fade out over a week.
  // Without the outcome only the filling-in shows, as the point fading in.
  const points = [];
  for (const o of O) {
    const k = (o.t - cutoff) / WEEK, px = x(o.t);
    if (k >= 5 || px <= -10) continue;
    if (outcome) points.push({ x: px, y: y(o.v), alpha: clamp(5 - k, 0, 1), fill: k < 1 ? clamp(1 - k, 0, 1) : 0 });
    else if (k < 1) points.push({ x: px, y: y(o.v), alpha: clamp(1 - k, 0, 1), fill: 1 });
  }
  const observed = { all, known, points };

  // misses: observed weeks outside the focused (or only) model's interval. They belong to whole weeks;
  // between weeks they fade out and back in around the nearest one, so they never pop in.
  let misses = null;
  const mm = hasFocus ? B.find((b) => b.id === f) : B.length === 1 ? B[0] : null;
  const missAlpha = Math.max(0, 1 - 2.5 * Math.abs(t - di));
  if (mm && missAlpha > 0) {
    const list = [];
    for (const p of fan.points(mm.id, di, level) || mm.pts) {
      if (p.anchor || (!outcome && p.t > cutoff)) continue;
      const v = fan.observedAt(p.t);
      if (v !== undefined && (v < p.lo || v > p.hi)) list.push({ x: x(p.t), y: y(v) });
    }
    if (list.length) misses = { alpha: missAlpha, c: mm.c, list };
  }

  // medians on top: solid, with week dots
  const medians = order(S).map((b) => {
    const dots = [];
    for (const p of b.pts) if (!p.anchor) dots.push(x(p.t), y(p.med));
    return { id: b.id, c: b.c, alpha: dim(b.id) ? 0.55 : 1, line: path(b.pts, "med"), dots };
  });
  const hotC = opts.hot != null ? context.find((c) => c.id === opts.hot) : null;
  const hot = hotC ? { id: hotC.id, line: hotC.line } : null;

  // width rulers beside the fan, at the hovered forecast week (else the last horizon)
  const fanEnd = x(ref + lastH * WEEK);
  const rx0 = fanEnd + 18;
  let rulers = null;
  if (rk > 0.001 && B.length) {
    const rh = horizonOf(fan, di, opts.hover?.t) ?? lastH;
    const rows = [];
    B.forEach((b, i) => {
      const p = b.pts.find((q) => !q.anchor && q.h === rh);
      if (p) rows.push({ id: b.id, c: b.c, x: rx0 + i * rulerStep, lo: y(p.lo), hi: y(p.hi), med: y(p.med), alpha: dim(b.id) ? 0.45 : 1 });
    });
    rulers = { k: rk, shift: (1 - rk) * -10, labelX: rx0 - 4, label: rh === 0 ? "This wk" : `+${rh} wk`, h: rh, rows };
  }

  // direct labels at the end of each median, kept apart and inside the plot; a halo lets the dotted
  // observed line pass behind them
  const lx = fanEnd + 14 + rk * (rulerW - 6); // labels ride with the fan, and step aside for rulers
  const topB = topClear + 12, botB = ay - 10;
  const labs = S.map((s) => ({ id: s.id, c: s.c, name: s.label, y: y(Math.min(s.pts[s.pts.length - 1].med, ymax)), alpha: s.open })).sort((a, b) => a.y - b.y);
  // charted models with no forecast this week: dimmed, at the bottom of the stack. A model folding into
  // (or out of) a week without a forecast cross-fades: its label fades with the fan, the ghost fades in
  const i0 = clamp(Math.floor(t), 0, Math.max(0, n - 1)), i1 = Math.min(n - 1, i0 + 1);
  for (const s of S) {
    if (s.open > 0.999) continue;
    const gone = fan.points(s.id, i0, level) ? i1 : i0;
    labs.push({ id: s.id, c: s.c, name: s.label, y: NaN, ghost: `no forecast ${day(D[gone])}`, alpha: 1 - s.open });
  }
  for (const o of missing) labs.push({ id: o.id, c: seriesColor(o.slot), name: o.label, y: NaN, ghost: `no forecast ${day(D[si])}` });
  // charted models with nothing at all this season or place: one quiet line, not a ghost each
  if (opts.absent) labs.push({ id: null, c: "transparent", name: "", y: NaN, ghost: opts.absent, summary: true });
  stack(labs, topB, botB, LABEL_GAP);
  // context labels, all or nothing: shown only if every one fits at its own height without touching
  // another label; a mix of labelled and unlabelled grey lines would suggest some matter more
  if (C.length) {
    const ctx = C.map((c) => ({ id: c.id, c: INK3, name: c.label, y: clamp(y(Math.min(c.pts[c.pts.length - 1].med, ymax)), topB, botB), ctx: true }));
    const taken = labs.map((d) => d.y);
    const clear = (yy) => taken.every((ty) => Math.abs(ty - yy) >= CTX_GAP);
    const ys = ctx.map((d) => d.y).sort((a, b) => a - b);
    const fits = ys.every((yy, i) => (i === 0 || yy - ys[i - 1] >= CTX_GAP) && clear(yy));
    if (fits) labs.push(...ctx);
    else if (hotC) { // only the hovered one, nudged clear of the labels already there
      const d = ctx.find((c) => c.id === hotC.id);
      let yy = d.y;
      while (!clear(yy) && yy + 8 <= botB) yy += 8;
      if (!clear(yy)) { yy = d.y; while (!clear(yy) && yy - 8 >= topB) yy -= 8; }
      d.y = yy; d.hot = true; labs.push(d);
    }
  }
  const labels = [];
  for (const d of labs) {
    if (lx >= w - 24) break; // pushed off-screen (panned into the past): skipped entirely
    const focused = hasFocus && d.id === f, weight = focused ? 600 : 500, size = d.ctx && !d.hot ? F.micro : F.chart;
    const fnt = font(weight, size, F.sans), full = d.summary ? d.ghost : d.name + (d.ghost ? ` · ${d.ghost}` : "");
    // a ghost or summary line has no line of its own to sit beside: rather than cut it, it slides left
    // into the empty room (never past the forecast shade); a series label stays in the column
    const x = d.ghost || d.summary ? Math.max(Math.min(lx, w - 18 - 10 - measure(full, fnt)), Math.min(lx, xc + 12)) : lx;
    const text = fitText(full, fnt, Math.round(w - x - 10 - 8), measure); // never run off the chart; full name kept
    const len = measure(text, fnt);
    labels.push({
      id: d.id, x, y: d.y, text, full, font: fnt, size, weight, len, alpha: d.alpha ?? 1,
      ctx: !!d.ctx, hot: !!d.hot, ghost: !!d.ghost, summary: !!d.summary,
      dotR: d.summary ? 0 : d.ctx ? 2.5 : 3.5, dotC: d.c, dotAlpha: d.ghost ? 0.4 : dim(d.id) ? 0.55 : 1,
      fill: d.summary ? INK3 : d.hot ? INK1 : d.ctx || d.ghost ? INK3 : !hasFocus ? INK2 : focused ? INK1 : INK3,
      // the click / hover target is just a little larger than the dot and the name (5px around)
      hit: d.summary || (d.alpha ?? 1) < 0.5 ? null : { x0: x - 9, x1: x + 10 + len + 5, y0: d.y - 11, y1: d.y + 11 },
    });
  }

  return {
    w, h, pad, ay, topClear, x, y, t, di, settle: si, whole, ref, cutoff, level, levels, lastH, ymax, outcome,
    focus: hasFocus ? f : null,
    fonts: { label: font(500, F.chart, F.sans), axis: font(400, F.axis, F.mono) },
    ticks, tickX: Math.min(20, pad.l), months, shade: xc, dates,
    series: S, bands, medians, context, contextAlpha, hot, observed, misses, rulers, labels, hoverX,
    missing: missing.map((m) => m.id),
  };
}

/**
 * What the readout shows for a hovered week, from the scene just drawn (no chart internals needed).
 * @param {import("../lib/api.js").Fan} fan
 * @param {object} scene from layoutFan
 * @param {number} t the hovered week, ms
 * @returns {{ t: number, h: number | null, observed: number | undefined,
 *   rows: { id: string, label: string, slot: number | "baseline", med: number, lo: number, hi: number,
 *     ranges: [lo, hi][], missed: boolean }[],
 *   hot: { id: string, label: string, med: number, lo: number, hi: number } | null,
 *   context: { n: number, min: number | null, max: number | null } }}
 *   h is the horizon when t is in the forecast window, else null (then rows are empty). rows are the
 *   charted models with a value there, the focused one first. lo/hi are the widest level's, ranges one
 *   [lo, hi] per scene level (widest first); NaN without that level's quantiles. observed is undefined for an unobserved week, and for weeks after the cutoff when the
 *   outcome is hidden; missed is true when the observed value is outside the row's interval.
 */
export function hoverInfo(fan, scene, t) {
  const h = horizonOf(fan, scene.di, t);
  const observed = !scene.outcome && t > scene.cutoff ? undefined : fan.observedAt(t);
  const at = (pts) => (h == null ? null : pts.find((p) => !p.anchor && p.h === h) || null);
  const rows = [];
  for (const s of scene.series) {
    const p = at(s.pts);
    if (!p) continue;
    const missed = observed !== undefined && Number.isFinite(p.lo) && Number.isFinite(p.hi) && (observed < p.lo || observed > p.hi);
    const ranges = s.lv.map((pts, k) => { const q = k ? pts && at(pts) : p; return q ? [q.lo, q.hi] : [NaN, NaN]; });
    rows.push({ id: s.id, label: s.label, slot: s.slot, med: p.med, lo: p.lo, hi: p.hi, ranges, missed });
  }
  if (scene.focus != null) rows.sort((a, b) => (b.id === scene.focus) - (a.id === scene.focus));
  let n = 0, min = Infinity, max = -Infinity, hot = null;
  for (const c of scene.context) {
    const p = at(c.pts);
    if (!p) continue;
    n++; if (p.med < min) min = p.med; if (p.med > max) max = p.med;
    if (scene.hot && c.id === scene.hot.id) hot = { id: c.id, label: c.label, med: p.med, lo: p.lo, hi: p.hi };
  }
  return { t, h, observed, rows, hot, context: { n, min: n ? min : null, max: n ? max : null } };
}

const LINE_HIT = 4; // px either side of a line that still counts as on it

/**
 * The median line under a point (within 6 px), by priority: the focused model, other charted models,
 * then grey context lines; nearest first within a priority. Medians are interpolated at the point's x;
 * the stretch from the anchor to the first forecast week is shared by every model and never counts.
 * @param {object} scene @param {number} px @param {number} py canvas CSS px
 * @param {string | null} [focusId=scene.focus]
 * @returns {{ id: string, ctx: boolean } | null}
 */
export function lineUnder(scene, px, py, focusId = scene.focus) {
  const t = scene.x.invert(px);
  const at = (pts) => {
    let s = 0;
    while (s < pts.length && pts[s].anchor) s++;
    if (s >= pts.length || t < pts[s].t - 2 * 864e5 || t > pts[pts.length - 1].t) return null;
    let i = s;
    while (i < pts.length && pts[i].t < t) i++;
    if (i <= s) return pts[s].med;
    const a = pts[i - 1], b = pts[i];
    return a.med + ((b.med - a.med) * (t - a.t)) / (b.t - a.t);
  };
  let best = null;
  const consider = (id, ctx, pri, v) => {
    if (v == null) return;
    const d = Math.abs(scene.y(v) - py);
    if (d <= LINE_HIT && (!best || pri < best.pri || (pri === best.pri && d < best.d))) best = { id, ctx, pri, d };
  };
  for (const s of scene.series) consider(s.id, false, s.id === focusId ? 0 : 1, at(s.pts));
  for (const c of scene.context) consider(c.id, true, 2, at(c.pts));
  return best && { id: best.id, ctx: best.ctx };
}

/**
 * The label under a point, from the hit boxes the layout computed.
 * @param {object} scene @param {number} px @param {number} py canvas CSS px
 * @returns {object | null} the label (see the scene), or null
 */
export function labelAt(scene, px, py) {
  for (const d of scene.labels) if (d.hit && px >= d.hit.x0 && px <= d.hit.x1 && py >= d.hit.y0 && py <= d.hit.y1) return d;
  return null;
}
