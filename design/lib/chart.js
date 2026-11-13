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
const fitCache = new Map();

/* The data cutoff for a reference date: the last observed week before it. */
export const cutoffFor = (truth, ref) => truth.filter((t) => t.date < ref).at(-1)?.date ?? new Date(+ref - WEEK);

/* Per-model interval geometry for a forecast date, anchored at the cutoff. */
export function bands(data, models, di, level = 0.95) {
  const { DATES, Q, MED, truth, fcPts } = data;
  const qi = (q) => d3.minIndex(Q, (v) => Math.abs(v - q));
  const LO = qi((1 - level) / 2), HI = qi(1 - (1 - level) / 2);
  const ref = DATES[di], cutoff = cutoffFor(truth, ref);
  const anchor = truth.find((t) => +t.date === +cutoff);
  return models.map(({ m, slot }) => {
    const raw = fcPts(m, di);
    if (!raw) return null;
    const pts = raw.map((p) => ({ date: p.date, h: p.h, lo: p.a[LO], hi: p.a[HI], med: p.a[MED] }));
    if (anchor) pts.unshift({ date: anchor.date, h: -1, lo: anchor.v, hi: anchor.v, med: anchor.v, anchor: true });
    return { m, slot, c: seriesVar(slot), pts };
  }).filter(Boolean);
}

/* Bands at a fractional forecast-date index t (for scrubbing and date transitions). Each model's five
 * points (anchor + 4 weeks) move point by point from date floor(t) to ceil(t), so the fan slides and
 * reshapes continuously and its root travels along the observed line. A model with a forecast on only
 * one side of t is shown as that forecast. */
export function bandsAt(data, models, t, level = 0.95) {
  const n = data.DATES.length, i0 = Math.max(0, Math.min(n - 1, Math.floor(t))), i1 = Math.min(n - 1, i0 + 1), u = Math.max(0, Math.min(1, t - i0));
  if (u < 1e-4 || i0 === i1) return bands(data, models, i0, level);
  if (u > 1 - 1e-4) return bands(data, models, i1, level);
  const A = new Map(bands(data, models, i0, level).map((b) => [b.m, b])), Z = new Map(bands(data, models, i1, level).map((b) => [b.m, b]));
  const L = (a, z) => a + (z - a) * u;
  return models.map(({ m }) => {
    const a = A.get(m), z = Z.get(m);
    if (!a || !z || a.pts.length !== z.pts.length) return a || z || null;
    return { ...a, pts: a.pts.map((p, k) => { const q = z.pts[k]; return { ...p, date: new Date(L(+p.date, +q.date)), lo: L(p.lo, q.lo), hi: L(p.hi, q.hi), med: L(p.med, q.med) }; }) };
  }).filter(Boolean);
}

/* opts:
 *  models [{m, slot}], di, t (fractional date index; overrides di while scrubbing or animating), domain, pad, id (glass source id), bg (opaque background, default true)
 *  band: interval level (default 0.95; 0 or null for none)
 *  focus: model id or null; onLabel(m): called when a label is clicked (focus is the page's state)
 *  onLabelHover(m | null): mouse preview of focus
 *  hover: horizon 0–3 or null; draws a hairline at that week (pages draw their own readout)
 *  rulers: true to draw each interval as a bar beside the fan, at `hover` or 3 weeks ahead
 *  misses: true to ring observed weeks outside the focused (or only) model's interval
 *  marks: false to skip the cutoff shade and date labels
 *  topClear: y above which y-axis labels are hidden (the bottom of the top chrome); default pad.t - 32
 *  labels: false to skip direct labels
 */
export function fanChart(svgSel, data, opts = {}) {
  const { DATES, truth, DI0, YMAX } = data;
  const node = svgSel.node();
  const w = opts.w ?? node.clientWidth, h = opts.h ?? node.clientHeight;
  const pad = { l: 56, r: 150, t: 72, b: 64, ...(opts.pad || {}) };
  // t: fractional date index. Integer t is an ordinary forecast date; in between, everything is
  // interpolated (forecast dates are consecutive weeks).
  const t = opts.t ?? opts.di ?? DI0, di = Math.round(t), whole = Math.abs(t - di) < 1e-4;
  const ref = whole ? DATES[di] : new Date(+DATES[0] + t * WEEK);
  const models = opts.models || [];
  const rulerStep = w < 600 ? 11 : 14;
  const rulerW = opts.rulers ? 18 + models.length * rulerStep : 0;
  const x = d3.scaleUtc(opts.domain || [new Date(+ref - 14 * WEEK), new Date(+ref + 3 * WEEK)], [pad.l, w - pad.r - rulerW]);
  const y = d3.scaleLinear([0, opts.ymax ?? YMAX], [h - pad.b, pad.t]).nice(5);
  const ay = h - pad.b;
  const cutoff = whole ? cutoffFor(truth, ref) : new Date(+ref - WEEK);
  const level = opts.band === null || opts.band === 0 ? 0 : opts.band ?? 0.95;
  const B = level ? bandsAt(data, models, t, level) : [];
  const S = level === 0.95 ? B : bandsAt(data, models, t, 0.95); // medians are drawn even with no band
  const f = opts.focus, hasFocus = S.some((b) => b.m === f);
  const dim = (m) => hasFocus && m !== f;

  svgSel.selectAll("*").remove();
  const uid = opts.id || `fc${(fanChart.n = (fanChart.n || 0) + 1)}`;
  const defs = svgSel.append("defs");
  defs.append("clipPath").attr("id", `${uid}-plot`).append("rect").attr("width", w).attr("height", ay);
  const clip = `url(#${uid}-plot)`;
  const g = svgSel.append("g").attr("id", opts.id || null);
  if (opts.bg !== false) g.append("rect").attr("width", w).attr("height", h).attr("fill", "var(--surface-chart)");

  // grid: continues above the axis maximum to the top edge (the scale stays fixed)
  const base = y.ticks(5), stepV = base[1] - base[0];
  const ticks = d3.range(stepV, y.invert(0), stepV);
  const topClear = opts.topClear ?? pad.t - 32;
  g.append("g").selectAll("line").data(ticks).join("line").attr("x1", 0).attr("x2", w).attr("y1", y).attr("y2", y)
    .attr("stroke", "var(--line-hairline)").style("stroke-width", "var(--stroke-hairline)");
  g.append("g").selectAll("text").data(ticks.filter((d) => y(d) - 6 > topClear + 10)).join("text").attr("class", "t-numeric-axis").attr("fill", "var(--ink-tertiary)")
    .attr("x", Math.min(20, pad.l)).attr("y", (d) => y(d) - 6).text(fmtTick);

  // cutoff shade, then the axis on top of it
  const xc = x(cutoff), xr = x(ref);
  if (opts.marks !== false) g.append("rect").attr("x", xc).attr("width", Math.max(0, w - xc)).attr("height", ay).attr("fill", "var(--fill-hover)");
  g.append("line").attr("x1", 0).attr("x2", w).attr("y1", ay).attr("y2", ay).attr("stroke", "var(--line-axis)");
  const markL = xc - 84, markR = xr + 104;
  const months = d3.utcMonth.range(d3.utcMonth.ceil(x.invert(0)), x.invert(w))
    .filter((d) => x(d) + 40 < w && (opts.marks === false || x(d) + 44 < markL || x(d) + 4 > markR));
  g.append("g").selectAll("text").data(months).join("text").attr("class", "t-label-chart").attr("fill", "var(--ink-tertiary)")
    .attr("x", (d) => x(d) + 4).attr("y", ay + 20).text((d) => d3.utcFormat(d.getUTCMonth() === 0 ? "%b %Y" : "%b")(d));
  if (opts.marks !== false) {
    // two lines each, pointing away from each other so they never collide: name (quiet), date (stronger)
    const tick = (xx, name, date, anchor, dx) => {
      g.append("line").attr("x1", xx).attr("x2", xx).attr("y1", ay).attr("y2", ay + 6).attr("stroke", "var(--ink-tertiary)").attr("stroke-width", 1.25);
      const t = g.append("text").attr("class", "t-label-chart").attr("text-anchor", anchor);
      t.append("tspan").attr("x", xx + dx).attr("y", ay + 20).attr("fill", "var(--ink-tertiary)").text(name);
      t.append("tspan").attr("x", xx + dx).attr("y", ay + 34).attr("fill", "var(--ink-secondary)").attr("font-weight", 500).text(date);
    };
    // while between dates, the labels name the week the chart will settle on
    tick(xc, "Data cutoff", fmtDay(whole ? cutoff : new Date(+DATES[di] - WEEK)), "end", 2);
    tick(xr, "Reference date", fmtDay(DATES[di]), "start", -2);
  }

  // bands: unfocused first so the focused one sits on top
  const order = (arr) => (hasFocus ? [...arr.filter((b) => b.m !== f), ...arr.filter((b) => b.m === f)] : arr);
  const plot = g.append("g").attr("clip-path", clip);
  const area = d3.area().x((p) => x(p.date)).y0((p) => y(p.lo)).y1((p) => y(p.hi));
  for (const b of order(B)) {
    const bg = plot.append("g");
    if (!dim(b.m)) bg.append("path").attr("d", area(b.pts)).attr("fill", b.c).style("fill-opacity", hasFocus ? "var(--band-focus, 0.15)" : "var(--band-whisper, 0.075)");
    const strength = hasFocus ? (b.m === f ? 1.5 : 0.7) : 1;
    for (const k of ["lo", "hi"]) bg.append("path").attr("d", d3.line().x((p) => x(p.date)).y((p) => y(p[k]))(b.pts)).attr("fill", "none").attr("stroke", b.c)
      .attr("stroke-width", 0.75).attr("stroke-opacity", Math.min(1, 0.55 * strength)).attr("stroke-linejoin", "round");
  }

  // hover hairline
  if (opts.hover != null) {
    const hx = x(new Date(+ref + opts.hover * WEEK));
    g.append("line").attr("x1", hx).attr("x2", hx).attr("y1", 0).attr("y2", ay).attr("stroke", "var(--ink-faint)");
  }

  // observed: whole season, solid through the cutoff, dotted after
  // split the observed line exactly at the cutoff (between weeks while scrubbing)
  let known = truth.filter((d) => d.date <= cutoff), after = truth.filter((d) => d.date >= cutoff);
  if (!whole) {
    const a = known.at(-1), z = after[0];
    if (a && z) { const cut = { date: cutoff, v: a.v + (z.v - a.v) * ((cutoff - a.date) / (z.date - a.date)), cut: true }; known = [...known, cut]; after = [cut, ...after]; }
  }
  const tl = d3.line().x((d) => x(d.date)).y((d) => y(d.v));
  const og = g.append("g").attr("clip-path", clip);
  // the dotted line always starts at the first observed week and is clipped to after the cutoff, so its
  // dots are pinned to the data and travel with it; starting it at the moving cutoff made them crawl
  const dotClip = `${uid}-after`;
  defs.append("clipPath").attr("id", dotClip).append("rect").attr("x", xc).attr("width", Math.max(0, w - xc)).attr("height", ay);
  og.append("path").attr("d", tl(truth)).attr("clip-path", `url(#${dotClip})`).attr("fill", "none").attr("stroke", "var(--ink-primary)").attr("stroke-width", 1.75).attr("stroke-linecap", "round").attr("stroke-dasharray", "0 4.5");
  og.append("path").attr("d", tl(known)).attr("fill", "none").attr("stroke", "var(--ink-primary)").attr("stroke-width", 1.5).attr("stroke-linejoin", "round");
  // observed points change continuously with the cutoff, so nothing pops in when an animation lands.
  // k = weeks after the cutoff: k <= 0 known (filled); over the week before the cutoff reaches a point
  // it fills in gradually; 0 < k <= 4 are the scored weeks (hollow); past that, points fade out over a
  // week, so the rest of the season is just the dotted line.
  const pts = truth.map((d) => ({ ...d, k: (d.date - cutoff) / WEEK })).filter((d) => d.k < 5 && x(d.date) > -10);
  const pg = og.append("g").selectAll("g").data(pts).join("g").attr("transform", (d) => `translate(${x(d.date)},${y(d.v)})`)
    .attr("opacity", (d) => Math.max(0, Math.min(1, 5 - d.k)));
  pg.append("circle").attr("r", 2.9).attr("fill", "var(--surface-chart)").attr("stroke", "var(--ink-primary)").attr("stroke-width", 1.5);
  pg.filter((d) => d.k < 1).append("circle").attr("r", 2.9 + 0.75).attr("fill", "var(--ink-primary)").attr("fill-opacity", (d) => Math.max(0, Math.min(1, 1 - d.k)));

  // misses: observed weeks outside the focused (or only) model's interval
  const mm = hasFocus ? B.find((b) => b.m === f) : B.length === 1 ? B[0] : null;
  // misses belong to whole weeks; while moving between weeks they fade out and back in around the
  // nearest week, so they never pop in at the end of an animation
  const missAlpha = Math.max(0, 1 - 2.5 * Math.abs(t - di));
  if (opts.misses && mm && missAlpha > 0) {
    const tv = new Map(truth.map((t) => [+t.date, t.v]));
    const mw = bands(data, models.filter((o) => o.m === mm.m), di, level || 0.95)[0] || mm; // the nearest whole week's interval
    const miss = mw.pts.filter((p) => !p.anchor && tv.has(+p.date)).map((p) => ({ p, v: tv.get(+p.date) })).filter((d) => d.v < d.p.lo || d.v > d.p.hi);
    g.append("g").attr("opacity", missAlpha).selectAll("circle").data(miss).join("circle").attr("r", 6).attr("cx", (d) => x(d.p.date)).attr("cy", (d) => y(d.v)).attr("fill", "none").attr("stroke", mm.c).attr("stroke-width", 1.25);
  }

  // medians on top: solid, with week dots
  const mg = g.append("g").selectAll("g").data(order(S)).join("g").attr("opacity", (b) => (dim(b.m) ? 0.55 : 1));
  mg.append("path").attr("fill", "none").attr("stroke", (b) => b.c).style("stroke-width", "var(--stroke-series)").attr("stroke-linejoin", "round")
    .attr("d", (b) => d3.line().x((p) => x(p.date)).y((p) => y(p.med))(b.pts));
  mg.selectAll("circle").data((b) => b.pts.filter((p) => !p.anchor).map((p) => ({ ...p, c: b.c }))).join("circle").attr("r", 2.9)
    .attr("cx", (p) => x(p.date)).attr("cy", (p) => y(p.med)).attr("fill", (p) => p.c).attr("stroke", "var(--surface-chart)").attr("stroke-width", 1.75);

  // width rulers beside the fan, at the hovered week (default 3 weeks ahead)
  const fanEnd = x(new Date(+ref + 3 * WEEK)); // the last forecast week; equals the plot's right edge close up
  const rx0 = fanEnd + 18;
  if (opts.rulers && B.length) {
    const rh = opts.hover ?? 3;
    g.append("text").attr("class", "t-label-chart").attr("fill", "var(--ink-tertiary)").attr("x", rx0 - 4).attr("y", ay + 20).text(rh === 0 ? "This wk" : `+${rh} wk`);
    const rows = B.map((b, i) => ({ b, i, p: b.pts.find((p) => p.h === rh) })).filter((d) => d.p);
    const r = g.append("g").attr("clip-path", clip).selectAll("g").data(rows).join("g").attr("transform", (d) => `translate(${rx0 + d.i * rulerStep},0)`)
      .attr("stroke", (d) => d.b.c).attr("stroke-linecap", "round").attr("opacity", (d) => (dim(d.b.m) ? 0.45 : 1));
    r.append("line").attr("y1", (d) => y(d.p.lo)).attr("y2", (d) => y(d.p.hi)).attr("stroke-width", 2).attr("stroke-opacity", 0.75);
    for (const k of ["lo", "hi"]) r.append("line").attr("x1", -3.5).attr("x2", 3.5).attr("y1", (d) => y(d.p[k])).attr("y2", (d) => y(d.p[k])).attr("stroke-width", 1.75);
    r.append("circle").attr("r", 2.6).attr("cy", (d) => y(d.p.med)).attr("fill", "var(--surface-chart)").attr("stroke-width", 1.5);
  }

  // direct labels at the end of each median; a halo lets the dotted observed line pass behind them
  if (opts.labels !== false) {
    const top = y.domain()[1];
    const lx = opts.rulers ? rx0 + models.length * rulerStep + 8 : fanEnd + 14; // labels ride with the fan (zoomed out it sits mid-chart)
    const labs = S.map((s) => ({ s, x: lx, y: y(Math.min(s.pts.at(-1).med, top)) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < labs.length; i++) labs[i].y = Math.max(labs[i].y, labs[i - 1].y + 18);
    const lg = g.append("g").selectAll("g").data(labs).join("g").attr("class", "fc-label").attr("transform", (d) => `translate(${d.x},${d.y})`);
    if (opts.onLabel) {
      lg.style("cursor", "pointer").attr("role", "button").attr("tabindex", 0).attr("aria-pressed", (d) => d.s.m === f)
        .attr("aria-label", (d) => `${d.s.m}. ${d.s.m === f ? "Focused. Activate to clear focus" : "Activate to focus"}`)
        .on("click", (e, d) => { e.stopPropagation(); opts.onLabel(d.s.m); })
        .on("keydown", (e, d) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opts.onLabel(d.s.m); } })
        .on("pointerenter", (e, d) => { if (e.pointerType === "mouse") opts.onLabelHover?.(d.s.m); })
        .on("pointerleave", (e) => { if (e.pointerType === "mouse") opts.onLabelHover?.(null); });
      lg.append("rect").attr("x", -6).attr("y", -11).attr("height", 22).attr("width", Math.max(0, w - lx)).attr("fill", "transparent");
    }
    lg.append("circle").attr("r", 3.5).attr("fill", (d) => d.s.c).attr("opacity", (d) => (dim(d.s.m) ? 0.55 : 1));
    lg.append("text").attr("class", "t-label-chart").attr("x", 10).attr("dy", "0.34em")
      .attr("stroke", "var(--surface-chart)").attr("stroke-width", 4).attr("stroke-linejoin", "round").attr("paint-order", "stroke")
      .attr("fill", (d) => (!hasFocus ? "var(--ink-secondary)" : d.s.m === f ? "var(--ink-primary)" : "var(--ink-tertiary)"))
      .attr("font-weight", (d) => (hasFocus && d.s.m === f ? 600 : null))
      .text((d) => short(d.s.m))
      // never let a label run off the chart: shorten it with an ellipsis, full name in a <title>
      .each(function (d) {
        // measuring text forces layout, so remember the result per name and width: scrubbing redraws
        // every frame and labels rarely change
        const room = Math.round(w - d.x - 10 - 8), full = this.textContent, key = `${full}|${room}|${this.getAttribute("font-weight") || ""}`;
        let fit = fitCache.get(key);
        if (fit === undefined) {
          fit = full;
          if (this.getComputedTextLength() > room) {
            let s = full;
            while (s.length > 2 && this.getComputedTextLength() > room) { s = s.slice(0, -1); this.textContent = fit = s.trimEnd() + "…"; }
          }
          fitCache.set(key, fit);
        }
        this.textContent = fit;
        d3.select(this).append("title").text(full);
      });
  }
  return { x, y, g, w, h, pad, ref, di, cutoff, series: S, bands: B, focus: hasFocus ? f : null };
}
