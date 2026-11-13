/* Data loading and the reference fan chart, drawn with d3 (global d3 v7).
 *
 * Chart rules (settled in studies/intervals-goals.md):
 *  - straight segments between points, no smoothing; a fixed y-axis that never rescales
 *  - the chart has no ceiling or walls: grid, bands and observed data run under the chrome to the
 *    edges of the view. Only the x-axis clips.
 *  - observed data is the strongest mark: the whole season, solid through the data cutoff (the last
 *    week before the reference date, where forecasts are anchored), dotted after. The four scored
 *    weeks keep hollow points.
 *  - everything after the cutoff (unknown when the forecast was made) is faintly shaded. The cutoff and
 *    reference date are ticks under the axis, labelled outward on two lines (name, then date).
 *  - one interval, 95% by default: a whisper fill plus fine 0.75px edges at half strength, anchored at
 *    the cutoff. Medians are the only solid lines with week dots, so edges never read as medians.
 *  - focus (optional): the focused model gets a stronger fill and edge; others keep only their edges
 *    and their medians and labels dim.
 *  - model i is var(--series-((i % 8) + 1)); the baseline is var(--series-baseline).
 */
export const WEEK = 7 * 864e5;
const parse = d3.utcParse("%Y-%m-%d");

export async function loadData(base = "data/") {
  const [D, FC] = await Promise.all([fetch(`${base}core.json`).then((r) => r.json()), fetch(`${base}fc-US.json`).then((r) => r.json())]);
  const DATES = D.dates.map(parse);
  const Q = D.quantiles, MED = Q.indexOf(0.5);
  const truth = D.truth.US.map(([d, v]) => ({ date: parse(d), v }));
  const STATES = D.locations.map((_, i) => i).filter((i) => D.locations[i].id !== "US");
  const geo = (a) => { const v = a.filter((x) => x > 0); return v.length ? Math.exp(d3.mean(v, Math.log)) : null; };
  const rel = (m, di) => geo(STATES.map((li) => { const w = D.wis[m][di][li], b = D.wis[D.baseline][di][li]; return w > 0 && b > 0 ? w / b : null; }));
  const seasonRel = new Map(D.models.map((m) => [m, geo(DATES.map((_, di) => rel(m, di)))]));
  const ranked = D.models.filter((m) => seasonRel.get(m)).sort((a, b) => seasonRel.get(a) - seasonRel.get(b));
  const fcPts = (m, di) => {
    const arr = FC[m]?.[D.dates[di]];
    return arr ? arr.map((a, h) => (a ? { date: new Date(+DATES[di] + h * WEEK), h, a } : null)).filter(Boolean) : null;
  };
  const DI0 = d3.minIndex(DATES, (d) => Math.abs(d - parse("2025-12-27")));
  return { D, FC, DATES, Q, MED, truth, STATES, rel, seasonRel, ranked, fcPts, DI0, YMAX: d3.max(truth, (d) => d.v) * 1.08 };
}

export const seriesVar = (slot) => (slot === "baseline" ? "var(--series-baseline)" : `var(--series-${(slot % 8) + 1})`);
export const short = (m) => m.replace(/^UMass-/, "");
const fmtTick = d3.format("~s"), fmtDay = d3.utcFormat("%b %-d");

/* The data cutoff for a reference date: the last observed week before it. */
export const cutoffFor = (truth, ref) => truth.filter((t) => t.date < ref).at(-1)?.date ?? new Date(+ref - WEEK);

/* Per-model interval geometry for a forecast date, anchored at the cutoff. */
/* Interval points for one model on one forecast date: the anchor (the last observed week) and each forecast
 * week, as { date (ms), h, lo, hi, med }. Computed once per model, date and level, then reused: a frame
 * on a whole week allocates nothing, and the arrays are never mutated (treat them as read-only). */
function pointsFor(data, m, di, level) {
  const cache = (data._pts ||= new Map()), key = `${m}|${di}|${level}`;
  let pts = cache.get(key);
  if (pts !== undefined) return pts;
  const { DATES, Q, MED, truth, FC, D } = data;
  const qs = (data._qi ||= new Map());
  if (!qs.has(level)) { const qi = (q) => d3.minIndex(Q, (v) => Math.abs(v - q)); qs.set(level, [qi((1 - level) / 2), qi(1 - (1 - level) / 2)]); }
  const [LO, HI] = qs.get(level);
  const arr = FC[m]?.[D.dates[di]];
  if (!arr) { cache.set(key, null); return null; }
  const anchors = (data._anchor ||= DATES.map((ref) => { const c = cutoffFor(truth, ref); return truth.find((t) => +t.date === +c) || null; }));
  const ref = +DATES[di], anchor = anchors[di];
  pts = [];
  if (anchor) pts.push({ date: +anchor.date, h: -1, lo: anchor.v, hi: anchor.v, med: anchor.v, anchor: true });
  arr.forEach((a, h) => { if (a) pts.push({ date: ref + h * WEEK, h, lo: a[LO], hi: a[HI], med: a[MED] }); });
  cache.set(key, pts);
  return pts;
}

export function bands(data, models, di, level = 0.95) {
  const out = [];
  for (const { m, slot } of models) { const pts = pointsFor(data, m, di, level); if (pts) out.push({ m, slot, c: seriesVar(slot), pts }); }
  return out;
}
export function bandsAt(data, models, t, level = 0.95) {
  const n = data.DATES.length, i0 = Math.max(0, Math.min(n - 1, Math.floor(t))), i1 = Math.min(n - 1, i0 + 1), u = Math.max(0, Math.min(1, t - i0));
  if (u < 1e-4 || i0 === i1) return bands(data, models, i0, level);
  if (u > 1 - 1e-4) return bands(data, models, i1, level);
  const out = [];
  for (const { m, slot } of models) {
    const a = pointsFor(data, m, i0, level), z = pointsFor(data, m, i1, level);
    const one = a || z;
    if (!one) continue;
    if (!a || !z || a.length !== z.length) { out.push({ m, slot, c: seriesVar(slot), pts: one }); continue; }
    const pts = new Array(a.length);
    for (let k = 0; k < a.length; k++) {
      const p = a[k], q = z[k];
      pts[k] = { date: p.date + (q.date - p.date) * u, h: p.h, lo: p.lo + (q.lo - p.lo) * u, hi: p.hi + (q.hi - p.hi) * u, med: p.med + (q.med - p.med) * u, anchor: p.anchor };
    }
    out.push({ m, slot, c: seriesVar(slot), pts });
  }
  return out;
}

/* ================================================================ the fan chart
 * One layout, two renderers. layoutFan() decides everything (scales, which marks, where every label goes
 * and how it's shortened) and returns a plain "scene" in pixels; drawFanSVG() and drawFanCanvas() only
 * paint it. Text is measured with canvas measureText (cached), never by reading the DOM.
 *  - fanChart(svgSel, data, opts): SVG, for static pages (Foundations, Components). Labels are elements.
 *  - fanCanvas(canvas, data, opts): canvas, for the interactive chart: no DOM per mark, so a frame costs a
 *    few hundred canvas strokes whatever the model count. Returns label hit boxes for hover and clicks.
 *
 * opts:
 *  models [{m, slot}], di, t (fractional date index; overrides di while scrubbing or animating), domain,
 *  pad, id (glass source id, SVG only), bg (opaque background, default true)
 *  band: interval level (default 0.95; 0 or null for none)
 *  focus: model id or null; onLabel(m) (SVG only): called when a label is clicked
 *  hover: horizon 0–3 or null; draws a hairline at that week (pages draw their own readout)
 *  rulers: 0–1 (or true) to draw each interval as a bar beside the fan, at `hover` or 3 weeks ahead
 *  misses: true to ring observed weeks outside the focused (or only) model's interval
 *  marks: false to skip the cutoff shade and date labels
 *  topClear: y above which y-axis labels are hidden (the bottom of the top chrome); default pad.t - 32
 *  labels: false to skip direct labels
 *  context: model ids drawn as grey context medians (Show all); hot: a context id to highlight and name
 */
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let FAM = null;
const fam = () => (FAM ||= { sans: css("--font-sans") || "Inter, system-ui, sans-serif", mono: css("--font-mono") || "ui-monospace, monospace" });
const font = (weight, size, f = "sans") => `${weight} ${size}px ${fam()[f]}`;
const F_LABEL = () => font(500, 11.5), F_AXIS = () => font(400, 10.5, "mono");
let mctx = null;
const widthCache = new Map();
function textWidth(str, f) {
  const key = `${f}|${str}`;
  let v = widthCache.get(key);
  if (v === undefined) { mctx ||= document.createElement("canvas").getContext("2d"); mctx.font = f; v = mctx.measureText(str).width; widthCache.set(key, v); }
  return v;
}
// after web fonts load, widths measured with fallback fonts are stale
document.fonts?.ready.then(() => { widthCache.clear(); FAM = null; });
function fitText(str, f, room) {
  if (textWidth(str, f) <= room) return str;
  let s = str;
  while (s.length > 2 && textWidth(s.trimEnd() + "…", f) > room) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}

export function layoutFan(data, opts, w, h) {
  const { DATES, truth, DI0, YMAX } = data;
  const pad = { l: 56, r: 150, t: 72, b: 64, ...(opts.pad || {}) };
  // t: fractional date index. Integer t is an ordinary forecast date; in between, everything is
  // interpolated (forecast dates are consecutive weeks).
  const t = opts.t ?? opts.di ?? DI0, di = Math.round(t), whole = Math.abs(t - di) < 1e-4;
  const ref = whole ? DATES[di] : new Date(+DATES[0] + t * WEEK);
  const models = opts.models || [];
  const rulerStep = w < 600 ? 11 : 14;
  // rulers: 0–1 (a number animates them in and out; true = 1). They sit in the margin beside the fan and
  // push the labels aside; they never narrow the plot, so toggling them doesn't rescale the chart.
  const rk = typeof opts.rulers === "number" ? Math.max(0, Math.min(1, opts.rulers)) : opts.rulers ? 1 : 0;
  const rulerW = 18 + models.length * rulerStep;
  const x = d3.scaleUtc(opts.domain || [new Date(+ref - 14 * WEEK), new Date(+ref + 3 * WEEK)], [pad.l, w - pad.r]);
  const y = d3.scaleLinear([0, opts.ymax ?? YMAX], [h - pad.b, pad.t]).nice(5);
  const ay = h - pad.b;
  const cutoff = whole ? cutoffFor(truth, ref) : new Date(+ref - WEEK);
  const level = opts.band === null || opts.band === 0 ? 0 : opts.band ?? 0.95;
  const B = level ? bandsAt(data, models, t, level) : [];
  const S = level === 0.95 ? B : bandsAt(data, models, t, 0.95); // medians are drawn even with no band
  // charted models with no forecast this week keep their slot; they get a dimmed label (below)
  const missing = models.filter((o) => !S.some((b) => b.m === o.m));
  // context (Show all): every other selected model, as a grey median as wide as the colored ones
  const C = (opts.context || []).length ? bandsAt(data, opts.context.map((m) => ({ m, slot: 0 })), t, 0.95) : [];
  const f = opts.focus, hasFocus = S.some((b) => b.m === f);
  const dim = (m) => hasFocus && m !== f;
  const order = (arr) => (hasFocus ? [...arr.filter((b) => b.m !== f), ...arr.filter((b) => b.m === f)] : arr);
  const X = (d) => x(d), Y = (v) => y(v);
  const xy = (pts, k) => pts.map((p) => [X(p.date), Y(p[k])]);

  // grid: continues above the axis maximum to the top edge (the scale stays fixed)
  const base = y.ticks(5), stepV = base[1] - base[0];
  const topClear = opts.topClear ?? pad.t - 32;
  const ticks = d3.range(stepV, y.invert(0), stepV).map((v) => ({ y: Y(v), text: Y(v) - 6 > topClear + 10 ? fmtTick(v) : null }));

  // the cutoff shade and the two date ticks
  const xc = X(cutoff), xr = X(ref), marks = opts.marks !== false;
  const markL = xc - 84, markR = xr + 104;
  const months = d3.utcMonth.range(d3.utcMonth.ceil(x.invert(0)), x.invert(w))
    .filter((d) => X(d) + 40 < w && (!marks || X(d) + 44 < markL || X(d) + 4 > markR))
    .map((d) => ({ x: X(d) + 4, text: d3.utcFormat(d.getUTCMonth() === 0 ? "%b %Y" : "%b")(d) }));
  // while between dates, the labels name the week the chart will settle on
  const dates = marks ? { cut: { x: xc, date: fmtDay(whole ? cutoff : new Date(+DATES[di] - WEEK)) }, ref: { x: xr, date: fmtDay(DATES[di]) } } : null;

  // bands: unfocused first so the focused one sits on top
  const bandMarks = order(B).map((b) => ({
    m: b.m, c: b.c, fill: dim(b.m) ? null : hasFocus ? "focus" : "whisper",
    edgeAlpha: Math.min(1, 0.55 * (hasFocus ? (b.m === f ? 1.5 : 0.7) : 1)),
    lo: xy(b.pts, "lo"), hi: xy(b.pts, "hi"),
  }));
  const hoverX = opts.hover != null ? X(new Date(+ref + opts.hover * WEEK)) : null;
  const context = C.filter((c) => c.m !== opts.hot).map((c) => ({ m: c.m, line: xy(c.pts, "med") }));
  const contextAlpha = hasFocus ? 0.45 : 0.75;

  // observed: whole season, solid through the cutoff, dotted after (split exactly at the cutoff while
  // scrubbing). The dotted line always starts at the first observed week and is clipped to after the
  // cutoff, so its dots are pinned to the data instead of crawling as the cutoff moves.
  let known = truth.filter((d) => d.date <= cutoff);
  if (!whole) {
    const a = known.at(-1), z = truth.find((d) => d.date >= cutoff);
    if (a && z) known = [...known, { date: cutoff, v: a.v + (z.v - a.v) * ((cutoff - a.date) / (z.date - a.date)) }];
  }
  // observed points change continuously with the cutoff, so nothing pops in when an animation lands.
  // k = weeks after the cutoff: k <= 0 known (filled); over the week before the cutoff reaches a point it
  // fills in gradually; 0 < k <= 4 are the scored weeks (hollow); past that, points fade out over a week.
  const points = [];
  for (const d of truth) {
    const k = (d.date - cutoff) / WEEK, px = X(d.date);
    if (k >= 5 || px <= -10) continue;
    points.push({ x: px, y: Y(d.v), alpha: Math.max(0, Math.min(1, 5 - k)), fill: k < 1 ? Math.max(0, Math.min(1, 1 - k)) : 0 });
  }
  const observed = { all: truth.map((d) => [X(d.date), Y(d.v)]), known: known.map((d) => [X(d.date), Y(d.v)]), points };

  // misses: observed weeks outside the focused (or only) model's interval. They belong to whole weeks;
  // between weeks they fade out and back in around the nearest one, so they never pop in.
  let misses = null;
  const mm = hasFocus ? B.find((b) => b.m === f) : B.length === 1 ? B[0] : null;
  const missAlpha = Math.max(0, 1 - 2.5 * Math.abs(t - di));
  if (opts.misses && mm && missAlpha > 0) {
    const tv = (data._truthAt ||= new Map(truth.map((d) => [+d.date, d.v])));
    const mw = bands(data, models.filter((o) => o.m === mm.m), di, level || 0.95)[0] || mm;
    misses = { alpha: missAlpha, c: mm.c, list: mw.pts.filter((p) => !p.anchor && tv.has(+p.date)).map((p) => ({ p, v: tv.get(+p.date) })).filter((d) => d.v < d.p.lo || d.v > d.p.hi).map((d) => ({ x: X(d.p.date), y: Y(d.v) })) };
  }

  // medians on top: solid, with week dots
  const medians = order(S).map((b) => ({ m: b.m, c: b.c, alpha: dim(b.m) ? 0.55 : 1, line: xy(b.pts, "med"), dots: b.pts.filter((p) => !p.anchor).map((p) => [X(p.date), Y(p.med)]) }));
  const hotC = C.find((c) => c.m === opts.hot);
  const hot = hotC ? { m: hotC.m, line: xy(hotC.pts, "med") } : null;

  // width rulers beside the fan, at the hovered week (default 3 weeks ahead)
  const fanEnd = X(new Date(+ref + 3 * WEEK)); // the last forecast week; equals the plot's right edge close up
  const rx0 = fanEnd + 18;
  let rulers = null;
  if (rk > 0.001 && B.length) {
    const rh = opts.hover ?? 3;
    rulers = { k: rk, shift: (1 - rk) * -10, labelX: rx0 - 4, label: rh === 0 ? "This wk" : `+${rh} wk`,
      rows: B.map((b, i) => ({ b, i, p: b.pts.find((p) => p.h === rh) })).filter((d) => d.p)
        .map((d) => ({ m: d.b.m, c: d.b.c, x: rx0 + d.i * rulerStep, lo: Y(d.p.lo), hi: Y(d.p.hi), med: Y(d.p.med), alpha: dim(d.b.m) ? 0.45 : 1 })) };
  }

  // direct labels at the end of each median; a halo lets the dotted observed line pass behind them
  let labels = [];
  if (opts.labels !== false) {
    const top = y.domain()[1];
    const lx = fanEnd + 14 + rk * (rulerW - 6); // labels ride with the fan, and step aside for rulers
    const labs = S.map((s) => ({ s, x: lx, y: Y(Math.min(s.pts.at(-1).med, top)) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < labs.length; i++) labs[i].y = Math.max(labs[i].y, labs[i - 1].y + 18);
    // charted models with no forecast this week: dimmed, at the bottom of the stack
    const dayLabel = fmtDay(DATES[di]);
    let gy = labs.length ? labs.at(-1).y + 18 : (pad.t + ay) / 2;
    for (const o of missing) { labs.push({ s: { m: o.m, c: seriesVar(o.slot) }, x: lx, y: gy, ghost: `no forecast ${dayLabel}` }); gy += 18; }
    // context labels, all or nothing: shown only if every one fits at its own height without touching
    // another label; a mix of labelled and unlabelled grey lines would suggest some matter more
    const ctxLabs = C.map((c) => ({ s: { m: c.m, c: "var(--ink-tertiary)" }, x: lx, y: Y(Math.min(c.pts.at(-1).med, top)), ctx: true }));
    const taken = labs.map((d) => d.y);
    const fits = ctxLabs.length > 0 && ctxLabs.every((d, i) => taken.every((ty) => Math.abs(ty - d.y) >= 16) && ctxLabs.every((e, j) => i === j || Math.abs(e.y - d.y) >= 16));
    if (fits) labs.push(...ctxLabs);
    else if (hotC) { // only the hovered one, nudged clear of the labels already there
      const d = ctxLabs.find((c) => c.s.m === hotC.m);
      while (taken.some((ty) => Math.abs(ty - d.y) < 16)) d.y += 8;
      d.hot = true; labs.push(d);
    }
    // labels pushed off-screen (panned into the past) are skipped entirely
    labels = labs.filter((d) => d.x < w - 24).map((d) => {
      const focused = hasFocus && d.s.m === f, weight = focused ? 600 : 500, size = d.ctx && !d.hot ? 11 : 11.5;
      const fnt = font(weight, size), full = short(d.s.m) + (d.ghost ? ` · ${d.ghost}` : "");
      const text = fitText(full, fnt, Math.round(w - d.x - 10 - 8)); // never run off the chart; full name kept
      const len = textWidth(text, fnt);
      return {
        ...d, m: d.s.m, full, text, font: fnt, weight, size, len,
        dotR: d.ctx ? 2.5 : 3.5, dotC: d.s.c, dotAlpha: d.ghost ? 0.4 : dim(d.s.m) ? 0.55 : 1,
        fill: d.hot ? "var(--ink-primary)" : d.ctx || d.ghost ? "var(--ink-tertiary)" : !hasFocus ? "var(--ink-secondary)" : focused ? "var(--ink-primary)" : "var(--ink-tertiary)",
        // the click / hover target is just a little larger than the dot and the name (5px around)
        hit: { x0: d.x - 9, x1: d.x + 10 + len + 5, y0: d.y - 11, y1: d.y + 11 },
      };
    });
  }
  return {
    w, h, pad, ay, x, y, ref, di, cutoff, whole, ticks, tickX: Math.min(20, pad.l), months, shade: marks ? xc : null, dates,
    bands: bandMarks, hoverX, context, contextAlpha, observed, misses, medians, hot, rulers, labels,
    series: S, bandsData: B, contextData: C, missing, focus: hasFocus ? f : null,
  };
}

/* ---------------- SVG renderer (static pages) ---------------- */
export function fanChart(svgSel, data, opts = {}) {
  const node = svgSel.node();
  const L = layoutFan(data, opts, opts.w ?? node.clientWidth, opts.h ?? node.clientHeight);
  const { w, h, ay } = L;
  const line = d3.line(), pathOf = (pts) => line(pts);
  const areaOf = (lo, hi) => `M${lo.map((p) => p.join(",")).join("L")}L${[...hi].reverse().map((p) => p.join(",")).join("L")}Z`;
  svgSel.selectAll("*").remove();
  const uid = opts.id || `fc${(fanChart.n = (fanChart.n || 0) + 1)}`;
  const defs = svgSel.append("defs");
  defs.append("clipPath").attr("id", `${uid}-plot`).append("rect").attr("width", w).attr("height", ay);
  const clip = `url(#${uid}-plot)`;
  const g = svgSel.append("g").attr("id", opts.id || null);
  if (opts.bg !== false) g.append("rect").attr("width", w).attr("height", h).attr("fill", "var(--surface-chart)");
  g.append("g").selectAll("line").data(L.ticks).join("line").attr("x1", 0).attr("x2", w).attr("y1", (d) => d.y).attr("y2", (d) => d.y)
    .attr("stroke", "var(--line-hairline)").style("stroke-width", "var(--stroke-hairline)");
  g.append("g").selectAll("text").data(L.ticks.filter((d) => d.text)).join("text").attr("class", "t-numeric-axis").attr("fill", "var(--ink-tertiary)")
    .attr("x", L.tickX).attr("y", (d) => d.y - 6).text((d) => d.text);
  if (L.shade != null) g.append("rect").attr("x", L.shade).attr("width", Math.max(0, w - L.shade)).attr("height", ay).attr("fill", "var(--shade-forecast, var(--fill-hover))");
  g.append("line").attr("x1", 0).attr("x2", w).attr("y1", ay).attr("y2", ay).attr("stroke", "var(--line-axis)");
  g.append("g").selectAll("text").data(L.months).join("text").attr("class", "t-label-chart").attr("fill", "var(--ink-tertiary)").attr("x", (d) => d.x).attr("y", ay + 20).text((d) => d.text);
  if (L.dates) {
    const tick = (xx, name, date, anchor, dx) => {
      g.append("line").attr("x1", xx).attr("x2", xx).attr("y1", ay).attr("y2", ay + 6).attr("stroke", "var(--ink-tertiary)").attr("stroke-width", 1.25);
      const t = g.append("text").attr("class", "t-label-chart").attr("text-anchor", anchor);
      t.append("tspan").attr("x", xx + dx).attr("y", ay + 20).attr("fill", "var(--ink-tertiary)").text(name);
      t.append("tspan").attr("x", xx + dx).attr("y", ay + 34).attr("fill", "var(--ink-secondary)").attr("font-weight", 500).text(date);
    };
    tick(L.dates.cut.x, "Data cutoff", L.dates.cut.date, "end", 2);
    tick(L.dates.ref.x, "Reference date", L.dates.ref.date, "start", -2);
  }
  const plot = g.append("g").attr("clip-path", clip);
  for (const b of L.bands) {
    const bg = plot.append("g");
    if (b.fill) bg.append("path").attr("d", areaOf(b.lo, b.hi)).attr("fill", b.c).style("fill-opacity", b.fill === "focus" ? "var(--band-focus, 0.15)" : "var(--band-whisper, 0.075)");
    for (const k of ["lo", "hi"]) bg.append("path").attr("d", pathOf(b[k])).attr("fill", "none").attr("stroke", b.c).attr("stroke-width", 0.75).attr("stroke-opacity", b.edgeAlpha).attr("stroke-linejoin", "round");
  }
  if (L.hoverX != null) g.append("line").attr("x1", L.hoverX).attr("x2", L.hoverX).attr("y1", 0).attr("y2", ay).attr("stroke", "var(--ink-faint)");
  if (L.context.length) g.append("g").attr("clip-path", clip).selectAll("path").data(L.context).join("path").attr("d", (c) => pathOf(c.line)).attr("fill", "none")
    .attr("stroke", "var(--ink-tertiary)").attr("stroke-opacity", L.contextAlpha).style("stroke-width", "var(--stroke-series)").attr("stroke-linejoin", "round");
  const og = g.append("g").attr("clip-path", clip);
  const dotClip = `${uid}-after`, xc = L.x(L.cutoff);
  defs.append("clipPath").attr("id", dotClip).append("rect").attr("x", xc).attr("width", Math.max(0, w - xc)).attr("height", ay);
  og.append("path").attr("d", pathOf(L.observed.all)).attr("clip-path", `url(#${dotClip})`).attr("fill", "none").attr("stroke", "var(--ink-primary)").attr("stroke-width", 1.75).attr("stroke-linecap", "round").attr("stroke-dasharray", "0 4.5");
  og.append("path").attr("d", pathOf(L.observed.known)).attr("fill", "none").attr("stroke", "var(--ink-primary)").attr("stroke-width", 1.5).attr("stroke-linejoin", "round");
  const pg = og.append("g").selectAll("g").data(L.observed.points).join("g").attr("transform", (d) => `translate(${d.x},${d.y})`).attr("opacity", (d) => d.alpha);
  pg.append("circle").attr("r", 2.9).attr("fill", "var(--surface-chart)").attr("stroke", "var(--ink-primary)").attr("stroke-width", 1.5);
  pg.filter((d) => d.fill > 0).append("circle").attr("r", 3.65).attr("fill", "var(--ink-primary)").attr("fill-opacity", (d) => d.fill);
  if (L.misses) g.append("g").attr("opacity", L.misses.alpha).selectAll("circle").data(L.misses.list).join("circle").attr("r", 6).attr("cx", (d) => d.x).attr("cy", (d) => d.y).attr("fill", "none").attr("stroke", L.misses.c).attr("stroke-width", 1.25);
  const mg = g.append("g").selectAll("g").data(L.medians).join("g").attr("opacity", (b) => b.alpha);
  mg.append("path").attr("fill", "none").attr("stroke", (b) => b.c).style("stroke-width", "var(--stroke-series)").attr("stroke-linejoin", "round").attr("d", (b) => pathOf(b.line));
  mg.selectAll("circle").data((b) => b.dots.map((p) => ({ p, c: b.c }))).join("circle").attr("r", 2.9).attr("cx", (d) => d.p[0]).attr("cy", (d) => d.p[1]).attr("fill", (d) => d.c).attr("stroke", "var(--surface-chart)").attr("stroke-width", 1.75);
  if (L.hot) g.append("path").attr("clip-path", clip).attr("d", pathOf(L.hot.line)).attr("fill", "none").attr("stroke", "var(--ink-primary)").attr("stroke-width", 2).attr("stroke-linejoin", "round");
  if (L.rulers) {
    const R = L.rulers, rg = g.append("g").attr("opacity", R.k).attr("transform", `translate(${R.shift},0)`);
    rg.append("text").attr("class", "t-label-chart").attr("fill", "var(--ink-tertiary)").attr("x", R.labelX).attr("y", ay + 20).text(R.label);
    const r = rg.append("g").attr("clip-path", clip).selectAll("g").data(R.rows).join("g").attr("transform", (d) => `translate(${d.x},0)`).attr("stroke", (d) => d.c).attr("stroke-linecap", "round").attr("opacity", (d) => d.alpha);
    r.append("line").attr("y1", (d) => d.lo).attr("y2", (d) => d.hi).attr("stroke-width", 2).attr("stroke-opacity", 0.75);
    for (const k of ["lo", "hi"]) r.append("line").attr("x1", -3.5).attr("x2", 3.5).attr("y1", (d) => d[k]).attr("y2", (d) => d[k]).attr("stroke-width", 1.75);
    r.append("circle").attr("r", 2.6).attr("cy", (d) => d.med).attr("fill", "var(--surface-chart)").attr("stroke-width", 1.5);
  }
  const f = L.focus;
  const lg = g.append("g").selectAll("g").data(L.labels).join("g").attr("class", "fc-label").attr("transform", (d) => `translate(${d.x},${d.y})`);
  if (opts.onLabel) {
    lg.style("cursor", "pointer").attr("role", "button").attr("tabindex", 0).attr("aria-pressed", (d) => d.m === f)
      .attr("aria-label", (d) => `${d.m}. ${d.m === f ? "Focused. Activate to clear focus" : "Activate to focus"}`)
      .on("click", (e, d) => { e.stopPropagation(); opts.onLabel(d.m); })
      .on("keydown", (e, d) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opts.onLabel(d.m); } });
    lg.append("rect").attr("x", -9).attr("y", -11).attr("height", 22).attr("rx", 6).attr("width", (d) => 10 + d.len + 14).attr("fill", "transparent");
  }
  lg.append("circle").attr("r", (d) => d.dotR).attr("fill", (d) => d.dotC).attr("opacity", (d) => d.dotAlpha);
  lg.append("text").attr("class", "t-label-chart").attr("x", 10).attr("dy", "0.34em")
    .attr("stroke", "var(--surface-chart)").attr("stroke-width", 4).attr("stroke-linejoin", "round").attr("paint-order", "stroke")
    .attr("fill", (d) => d.fill).attr("font-weight", (d) => (d.weight === 600 ? 600 : null)).attr("font-size", (d) => (d.size !== 11.5 ? `${d.size}px` : null))
    .text((d) => d.text).append("title").text((d) => d.full);
  return { x: L.x, y: L.y, g, w, h, pad: L.pad, ref: L.ref, di: L.di, cutoff: L.cutoff, series: L.series, bands: L.bandsData, context: L.contextData, missing: L.missing, focus: L.focus, labels: L.labels };
}

/* ---------------- canvas renderer (the interactive chart) ----------------
 * Colors are the design tokens, resolved once per theme. Same marks, same order, same widths as the SVG
 * renderer. One difference by nature: a group's opacity applies to each mark in it (a dimmed median's
 * dots and line each get the alpha) rather than to the group as one layer. */
const colorCache = new Map();
let colorKey = "";
function color(v) {
  const key = (document.documentElement.dataset.theme || "") + matchMedia("(prefers-color-scheme: dark)").matches;
  if (key !== colorKey) { colorCache.clear(); colorKey = key; }
  let c = colorCache.get(v);
  if (c === undefined) {
    const m = /^var\((--[\w-]+)(?:,\s*(.+))?\)$/.exec(v);
    c = m ? css(m[1]) || (m[2] ? color(m[2]) : "#000") : v;
    colorCache.set(v, c);
  }
  return c;
}
const num = (v, fb) => { const n = parseFloat(color(v)); return Number.isFinite(n) ? n : fb; };

export function fanCanvas(canvas, data, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = opts.w ?? canvas.clientWidth, h = opts.h ?? canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const L = layoutFan(data, opts, w, h);
  const ctx = canvas.getContext("2d");
  const { ay } = L;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineJoin = "round"; ctx.lineCap = "butt";
  const surface = color("var(--surface-chart)");
  ctx.fillStyle = surface; ctx.fillRect(0, 0, w, h);
  const path = (pts) => { ctx.beginPath(); pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); };
  const stroke = (c, width, alpha = 1) => { ctx.strokeStyle = color(c); ctx.lineWidth = width; ctx.globalAlpha = alpha; ctx.stroke(); ctx.globalAlpha = 1; };
  const circle = (cx, cy, r) => { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); };
  const text = (str, tx, ty, fnt, fill, align = "left") => { ctx.font = fnt; ctx.textAlign = align; ctx.fillStyle = color(fill); ctx.fillText(str, tx, ty); };

  // grid and its labels
  for (const d of L.ticks) { ctx.beginPath(); ctx.moveTo(0, d.y); ctx.lineTo(w, d.y); stroke("var(--line-hairline)", num("var(--stroke-hairline)", 1)); }
  ctx.textBaseline = "alphabetic";
  for (const d of L.ticks) if (d.text) text(d.text, L.tickX, d.y - 6, F_AXIS(), "var(--ink-tertiary)");
  if (L.shade != null) { ctx.fillStyle = color("var(--shade-forecast, var(--fill-hover))"); ctx.fillRect(L.shade, 0, Math.max(0, w - L.shade), ay); }
  ctx.beginPath(); ctx.moveTo(0, ay); ctx.lineTo(w, ay); stroke("var(--line-axis)", 1);
  for (const d of L.months) text(d.text, d.x, ay + 20, F_LABEL(), "var(--ink-tertiary)");
  if (L.dates) {
    const tick = (xx, name, date, align, dx) => {
      ctx.beginPath(); ctx.moveTo(xx, ay); ctx.lineTo(xx, ay + 6); stroke("var(--ink-tertiary)", 1.25);
      text(name, xx + dx, ay + 20, F_LABEL(), "var(--ink-tertiary)", align);
      text(date, xx + dx, ay + 34, F_LABEL(), "var(--ink-secondary)", align);
    };
    tick(L.dates.cut.x, "Data cutoff", L.dates.cut.date, "right", 2);
    tick(L.dates.ref.x, "Reference date", L.dates.ref.date, "left", -2);
  }

  // everything inside the plot is clipped at the x-axis
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, ay); ctx.clip();
  const whisper = num("var(--band-whisper, 0.075)", 0.075), focusA = num("var(--band-focus, 0.15)", 0.15);
  for (const b of L.bands) {
    if (b.fill) {
      ctx.beginPath(); b.lo.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      for (let i = b.hi.length - 1; i >= 0; i--) ctx.lineTo(b.hi[i][0], b.hi[i][1]);
      ctx.closePath(); ctx.fillStyle = color(b.c); ctx.globalAlpha = b.fill === "focus" ? focusA : whisper; ctx.fill(); ctx.globalAlpha = 1;
    }
    path(b.lo); stroke(b.c, 0.75, b.edgeAlpha); path(b.hi); stroke(b.c, 0.75, b.edgeAlpha);
  }
  if (L.hoverX != null) { ctx.beginPath(); ctx.moveTo(L.hoverX, 0); ctx.lineTo(L.hoverX, ay); stroke("var(--ink-faint)", 1); }
  const series = num("var(--stroke-series)", 1.75);
  for (const c of L.context) { path(c.line); stroke("var(--ink-tertiary)", series, L.contextAlpha); }
  // observed: the dotted line clipped to after the cutoff, then the solid part, then the points
  const xc = L.x(L.cutoff);
  ctx.save(); ctx.beginPath(); ctx.rect(xc, 0, Math.max(0, w - xc), ay); ctx.clip();
  ctx.setLineDash([0, 4.5]); ctx.lineCap = "round"; path(L.observed.all); stroke("var(--ink-primary)", 1.75);
  ctx.setLineDash([]); ctx.lineCap = "butt"; ctx.restore();
  path(L.observed.known); stroke("var(--ink-primary)", 1.5);
  for (const p of L.observed.points) {
    ctx.globalAlpha = p.alpha;
    circle(p.x, p.y, 2.9); ctx.fillStyle = surface; ctx.fill(); ctx.strokeStyle = color("var(--ink-primary)"); ctx.lineWidth = 1.5; ctx.stroke();
    if (p.fill > 0) { circle(p.x, p.y, 3.65); ctx.fillStyle = color("var(--ink-primary)"); ctx.globalAlpha = p.alpha * p.fill; ctx.fill(); }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  if (L.misses) for (const d of L.misses.list) { circle(d.x, d.y, 6); stroke(L.misses.c, 1.25, L.misses.alpha); }
  for (const b of L.medians) {
    path(b.line); stroke(b.c, series, b.alpha);
    ctx.globalAlpha = b.alpha;
    for (const [px, py] of b.dots) { circle(px, py, 2.9); ctx.fillStyle = color(b.c); ctx.fill(); ctx.strokeStyle = surface; ctx.lineWidth = 1.75; ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  if (L.hot) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, ay); ctx.clip(); path(L.hot.line); stroke("var(--ink-primary)", 2); ctx.restore(); }
  if (L.rulers) {
    const R = L.rulers;
    ctx.save(); ctx.translate(R.shift, 0); ctx.globalAlpha = R.k;
    text(R.label, R.labelX, ay + 20, F_LABEL(), "var(--ink-tertiary)");
    ctx.beginPath(); ctx.rect(-R.shift, 0, w, ay); ctx.clip();
    ctx.lineCap = "round";
    for (const r of R.rows) {
      const a = R.k * r.alpha, c = color(r.c);
      ctx.strokeStyle = c;
      ctx.beginPath(); ctx.moveTo(r.x, r.lo); ctx.lineTo(r.x, r.hi); ctx.lineWidth = 2; ctx.globalAlpha = a * 0.75; ctx.stroke();
      ctx.globalAlpha = a; ctx.lineWidth = 1.75;
      for (const yy of [r.lo, r.hi]) { ctx.beginPath(); ctx.moveTo(r.x - 3.5, yy); ctx.lineTo(r.x + 3.5, yy); ctx.stroke(); }
      circle(r.x, r.med, 2.6); ctx.fillStyle = surface; ctx.fill(); ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.lineCap = "butt"; ctx.restore();
  }
  // labels: dot, then the name with a surface-colored halo
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left"; ctx.lineJoin = "round";
  for (const d of L.labels) {
    circle(d.x, d.y, d.dotR); ctx.fillStyle = color(d.dotC); ctx.globalAlpha = d.dotAlpha; ctx.fill(); ctx.globalAlpha = 1;
    ctx.font = d.font; const by = d.y + 0.34 * d.size;
    ctx.strokeStyle = surface; ctx.lineWidth = 4; ctx.strokeText(d.text, d.x + 10, by);
    ctx.fillStyle = color(d.fill); ctx.fillText(d.text, d.x + 10, by);
  }
  return { x: L.x, y: L.y, w, h, pad: L.pad, ref: L.ref, di: L.di, cutoff: L.cutoff, series: L.series, bands: L.bandsData, context: L.contextData, missing: L.missing, focus: L.focus, labels: L.labels, rulers: L.rulers, dates: L.dates, canvas };
}
