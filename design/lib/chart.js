/* Data loading and the reference fan chart, drawn with d3 (global d3 v7).
 * Chart rules: straight segments between points (no smoothing), a fixed y-axis that never
 * rescales with date or model selection (bands may run off the top), observed data in ink,
 * model i in var(--series-((i % 8) + 1)), the baseline model in var(--series-baseline).
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
const fmtTick = d3.format("~s");

/* opts: models [{m, slot}], di, domain, pad, id (for glass sources), bg (opaque background rect),
   band: null | level (e.g. 0.8) for one soft interval band per model, labels: true */
export function fanChart(svgSel, data, opts = {}) {
  const { DATES, Q, MED, truth, fcPts, DI0, YMAX } = data;
  const node = svgSel.node();
  const w = opts.w ?? node.clientWidth, h = opts.h ?? node.clientHeight;
  const pad = { l: 56, r: 150, t: 72, b: 64, ...(opts.pad || {}) };
  const di = opts.di ?? DI0, ref = DATES[di];
  const x = d3.scaleUtc(opts.domain || [new Date(+ref - 14 * WEEK), new Date(+ref + 5 * WEEK)], [pad.l, w - pad.r]);
  const y = d3.scaleLinear([0, opts.ymax ?? YMAX], [h - pad.b, pad.t]).nice(5);
  svgSel.selectAll("*").remove();
  const g = svgSel.append("g").attr("id", opts.id || null);
  if (opts.bg !== false) g.append("rect").attr("width", w).attr("height", h).attr("fill", "var(--surface-chart)");
  const ticks = y.ticks(5).slice(1);
  g.append("g").selectAll("line").data(ticks).join("line").attr("x1", 0).attr("x2", w).attr("y1", y).attr("y2", y)
    .attr("stroke", "var(--line-hairline)").style("stroke-width", "var(--stroke-hairline)");
  g.append("g").selectAll("text").data(ticks).join("text").attr("class", "t-numeric-axis").attr("fill", "var(--ink-tertiary)")
    .attr("x", 20).attr("y", (d) => y(d) - 6).text(fmtTick);
  g.append("line").attr("x1", 0).attr("x2", w).attr("y1", h - pad.b).attr("y2", h - pad.b).attr("stroke", "var(--line-axis)");
  const months = d3.utcMonth.range(d3.utcMonth.ceil(x.domain()[0]), x.domain()[1]);
  g.append("g").selectAll("text").data(months).join("text").attr("class", "t-label-chart").attr("fill", "var(--ink-tertiary)")
    .attr("x", (d) => x(d) + 4).attr("y", h - pad.b + 20).text((d) => d3.utcFormat(d.getUTCMonth() === 0 ? "%B %Y" : "%B")(d));
  g.append("line").attr("x1", x(ref)).attr("x2", x(ref)).attr("y1", pad.t - 24).attr("y2", h - pad.b)
    .attr("stroke", "var(--line-axis)").style("stroke-width", "var(--stroke-hairline)");

  const qi = (q) => d3.minIndex(Q, (v) => Math.abs(v - q));
  const series = (opts.models || []).map(({ m, slot }) => ({ m, slot, pts: fcPts(m, di), c: seriesVar(slot) })).filter((s) => s.pts);
  if (opts.band) {
    const lo = qi((1 - opts.band) / 2), hi = qi(1 - (1 - opts.band) / 2);
    g.append("g").selectAll("path").data(series).join("path").attr("fill", (s) => s.c).attr("fill-opacity", 0.13)
      .attr("d", (s) => d3.area().x((p) => x(p.date)).y0((p) => y(p.a[lo])).y1((p) => y(p.a[hi]))(s.pts));
  }
  const line = d3.line().x((d) => x(d.date)).y((d) => y(d.v));
  g.append("path").attr("d", line(truth)).attr("fill", "none").attr("stroke", "var(--ink-secondary)").style("stroke-width", "var(--stroke-observed)").attr("stroke-linejoin", "round");
  const cutoff = new Date(+ref - WEEK);
  g.append("g").selectAll("circle").data(truth).join("circle").attr("r", 2.4).attr("cx", (d) => x(d.date)).attr("cy", (d) => y(d.v))
    .attr("fill", (d) => (d.date > cutoff ? "var(--surface-chart)" : "var(--ink-primary)"))
    .attr("stroke", (d) => (d.date > cutoff ? "var(--ink-secondary)" : "var(--surface-chart)")).attr("stroke-width", 1.25);
  const sg = g.append("g").selectAll("g").data(series).join("g");
  sg.append("path").attr("fill", "none").attr("stroke", (s) => s.c).style("stroke-width", "var(--stroke-series)").attr("stroke-linejoin", "round")
    .attr("d", (s) => d3.line().x((p) => x(p.date)).y((p) => y(p.a[MED]))(s.pts));
  sg.selectAll("circle").data((s) => s.pts.map((p) => ({ ...p, c: s.c }))).join("circle").attr("r", 2.9)
    .attr("cx", (p) => x(p.date)).attr("cy", (p) => y(p.a[MED])).attr("fill", (p) => p.c).attr("stroke", "var(--surface-chart)").attr("stroke-width", 1.75);
  if (opts.labels !== false) {
    const labs = series.map((s) => { const p = s.pts[s.pts.length - 1]; return { s, x: x(p.date) + 12, y: y(p.a[MED]) }; }).sort((a, b) => a.y - b.y);
    for (let i = 1; i < labs.length; i++) labs[i].y = Math.max(labs[i].y, labs[i - 1].y + 16);
    const lg = g.append("g").selectAll("g").data(labs).join("g").attr("transform", (d) => `translate(${d.x},${d.y})`);
    lg.append("circle").attr("r", 3.5).attr("fill", (d) => d.s.c);
    lg.append("text").attr("class", "t-label-chart").attr("fill", "var(--ink-secondary)").attr("x", 9).attr("dy", "0.34em").text((d) => short(d.s.m))
      // never let a label run off the chart: shorten it with an ellipsis to the room it has, full name in a <title>
      .each(function (d) {
        const room = w - d.x - 9 - 6;
        const full = this.textContent;
        if (this.getComputedTextLength() > room) {
          let s = full;
          while (s.length > 2 && this.getComputedTextLength() > room) { s = s.slice(0, -1); this.textContent = s.trimEnd() + "…"; }
          d3.select(this).append("title").text(full);
        }
      });
  }
  return { x, y, g, w, h, pad, ref, di, series };
}
