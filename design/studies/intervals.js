/* Interval study: six renderings of the 95% interval for 2–3 models on identical data.
 * Shared across every variant: fixed y-axis, observed data in ink, medians on top, the same hover
 * readout (exact numbers), optional width rulers, optional miss marks. Only the band drawing differs. */
import { LiquidGlass } from "../lib/glass.js";
import { loadData, seriesVar, short, WEEK } from "../lib/chart.js";
import { Segmented, Stepper, timeKeys } from "../lib/controls.js";

const root = document.documentElement;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
if (store.get("viz-ds-theme")) root.dataset.theme = store.get("viz-ds-theme");
const $ = (id) => document.getElementById(id);

const data = await loadData("../data/");
const { D, DATES, Q, MED, truth, fcPts, DI0, YMAX, ranked } = data;
const qi = (q) => d3.minIndex(Q, (v) => Math.abs(v - q));
const LO = qi(0.025), HI = qi(0.975);
const fmtN = d3.format(",.0f"), fmtTick = d3.format("~s");
const fmtLong = d3.utcFormat("%b %-d, %Y"), fmtShort = d3.utcFormat("%b %-d"), fmtWeek = d3.utcFormat("%b %-d");
const truthAt = new Map(truth.map((t) => [+t.date, t.v]));

/* ---------------- state ---------------- */
const SETS = {
  close: ["UMass-flusion", "UMass-AR6_pooled", "UMass-gbqr_4src"],
  apart: ["UMass-flusion", "UMass-WISAR6_fourthroot_adaptive_t", "UMass-AR2"],
  skewed: ["UMass-flusion", "axial-tfm_L4v5", "UMass-timesfm3_nhsn"],
  baseline: ["UMass-flusion", "UMass-AR6_pooled", D.baseline],
};
const S = { set: "close", count: 3, di: DI0, anchor: "observed", rulers: false, calib: true, phone: false, focus: null };

function models() {
  let list = S.count === 8 ? [...new Set([...SETS[S.set], ...ranked.filter((m) => m !== D.baseline)])].slice(0, 8) : SETS[S.set].slice(0, S.count);
  let slot = 0;
  return list.filter((m) => D.models.includes(m)).map((m) => ({ m, slot: m === D.baseline ? "baseline" : slot++ }));
}

/* ---------------- variants ---------------- */
// Each variant draws only the band layer, into `g`, given the per-model band geometry.
const VARIANTS = [
  {
    key: "fill", letter: "A", title: "Current viz",
    desc: "One translucent fill per model at 10%, no edges. The reference to beat.",
    look: "Where bands stack, can you tell which edge belongs to which model?",
    draw(g, B, ctx) { g.selectAll("path").data(B).join("path").attr("fill", (b) => b.c).attr("fill-opacity", 0.1).attr("d", (b) => ctx.area(b.pts)); },
  },
  {
    key: "edges", letter: "B", title: "Edges only",
    desc: "No fill at all. Each band is just its two edges, a hairline in the model's color.",
    look: "Least ink and nothing blends. Does the band still read as a region, or as extra lines?",
    draw(g, B, ctx) { edges(g, B, ctx, { width: 1, opacity: 0.85 }); },
  },
  {
    key: "whisper", letter: "C", title: "Edge and whisper",
    desc: "A very faint fill to say \"region\", a hairline edge to say exactly where it stops.",
    look: "The fill is so faint that overlaps barely mix; the edges carry precision.",
    draw(g, B, ctx) {
      g.append("g").selectAll("path").data(B).join("path").attr("fill", (b) => b.c).attr("fill-opacity", 0.055).attr("d", (b) => ctx.area(b.pts));
      edges(g.append("g"), B, ctx, { width: 1, opacity: 0.7 });
    },
  },
  {
    key: "focus", letter: "D", title: "One focused, others as edges",
    desc: "The focused model gets fill and edges; the rest are dashed edges only. Click a label to switch.",
    look: "Always one clear band to read, with the others still visible for comparison.",
    draw(g, B, ctx) {
      const f = B.find((b) => b.m === ctx.focus) || B[0];
      edges(g.append("g"), B.filter((b) => b !== f), ctx, { width: 1, opacity: 0.6, dash: "3 3" });
      if (!f) return;
      g.append("path").attr("fill", f.c).attr("fill-opacity", 0.12).attr("d", ctx.area(f.pts));
      edges(g.append("g"), [f], ctx, { width: 1.25, opacity: 0.9 });
    },
  },
  {
    key: "caps", letter: "E", title: "Precision at the data",
    desc: "The continuous band stays faint; crisp caps mark the interval at each forecast week, where the numbers actually are.",
    look: "Honest about interpolation: exact marks only where the model gave values.",
    draw(g, B, ctx) {
      g.append("g").selectAll("path").data(B).join("path").attr("fill", (b) => b.c).attr("fill-opacity", 0.06).attr("d", (b) => ctx.area(b.pts));
      const pts = B.flatMap((b) => b.pts.filter((p) => !p.anchor).map((p) => ({ ...p, c: b.c })));
      const k = g.append("g").selectAll("g").data(pts).join("g").attr("stroke", (p) => p.c).attr("stroke-linecap", "round");
      k.append("line").attr("x1", (p) => ctx.x(p.date)).attr("x2", (p) => ctx.x(p.date)).attr("y1", (p) => ctx.y(p.lo)).attr("y2", (p) => ctx.y(p.hi)).attr("stroke-opacity", 0.3).attr("stroke-width", 1);
      for (const e of ["lo", "hi"]) k.append("line").attr("x1", (p) => ctx.x(p.date) - 5).attr("x2", (p) => ctx.x(p.date) + 5).attr("y1", (p) => ctx.y(p[e])).attr("y2", (p) => ctx.y(p[e])).attr("stroke-width", 1.75);
    },
  },
  {
    key: "consensus", letter: "F", title: "Agreement zone",
    desc: "Edges in each model's color; the only fill is the range every model shares, in neutral grey.",
    look: "Answers \"do they agree?\" directly. A gap in the grey means real disagreement.",
    draw(g, B, ctx) {
      if (B.length === 1) g.append("path").attr("fill", B[0].c).attr("fill-opacity", 0.08).attr("d", ctx.area(B[0].pts));
      else {
        const zone = intersect(B);
        g.append("path").attr("fill", "var(--ink-primary)").attr("fill-opacity", 0.09)
          .attr("d", d3.area().defined((p) => p.hi > p.lo).x((p) => ctx.x(p.date)).y0((p) => ctx.y(p.lo)).y1((p) => ctx.y(p.hi))(zone));
      }
      edges(g.append("g"), B, ctx, { width: 1, opacity: 0.85 });
    },
  },
];

function edges(g, B, ctx, { width, opacity, dash = null }) {
  for (const e of ["lo", "hi"]) {
    g.append("g").selectAll("path").data(B).join("path").attr("fill", "none").attr("stroke", (b) => b.c)
      .attr("stroke-width", width).attr("stroke-opacity", opacity).attr("stroke-dasharray", dash).attr("stroke-linejoin", "round")
      .attr("d", (b) => d3.line().x((p) => ctx.x(p.date)).y((p) => ctx.y(p[e]))(b.pts));
  }
}

// Pointwise intersection of all bands. Edges are piecewise linear, so sample each segment densely
// to get the max-of-lows / min-of-highs shape right where edges cross.
function intersect(B) {
  const t0 = d3.max(B, (b) => +b.pts[0].date), t1 = d3.min(B, (b) => +b.pts.at(-1).date);
  const at = (b, t, k) => { const ps = b.pts; let i = ps.findIndex((p) => +p.date >= t); if (i <= 0) return ps[Math.max(0, i)][k]; const a = ps[i - 1], c = ps[i]; return a[k] + (c[k] - a[k]) * (t - a.date) / (c.date - a.date); };
  const out = [];
  for (let t = t0; t <= t1 + 1; t += WEEK / 24) out.push({ date: new Date(t), lo: d3.max(B, (b) => at(b, t, "lo")), hi: d3.min(B, (b) => at(b, t, "hi")) });
  return out;
}

/* ---------------- chart ---------------- */
const charts = [];
function build() {
  const host = $("studies");
  for (const v of VARIANTS) {
    const sec = document.createElement("section");
    sec.className = "study"; sec.id = v.key;
    sec.innerHTML = `<header><span class="letter">${v.letter}</span><h2 class="t-title-2">${v.title}</h2><p>${v.desc}</p><p class="look t-small">${v.look}</p></header>
      <div class="stage" data-view><svg role="img" aria-label="${v.title}: forecast chart with 95% intervals"></svg><div class="readout" hidden></div></div>`;
    host.appendChild(sec);
    const c = { v, stage: sec.querySelector(".stage"), svg: d3.select(sec.querySelector("svg")), readout: sec.querySelector(".readout"), hover: null };
    c.stage.addEventListener("pointermove", (e) => hover(c, e));
    c.stage.addEventListener("pointerdown", (e) => hover(c, e));
    c.stage.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { c.hover = null; draw(c); } });
    charts.push(c);
  }
}

function geometry(c) {
  const node = c.svg.node(), w = node.clientWidth, h = node.clientHeight;
  const phone = w < 600;
  const ms = models();
  const pad = { l: phone ? 12 : 20, r: (phone ? 84 : 136) + (S.rulers ? 12 + ms.length * (phone ? 10 : 13) : 0), t: 28, b: 40 };
  const ref = DATES[S.di];
  const x = d3.scaleUtc([new Date(+ref - (phone ? 4 : 7) * WEEK), new Date(+ref + 3 * WEEK)], [pad.l + (phone ? 26 : 34), w - pad.r]);
  const y = d3.scaleLinear([0, YMAX], [h - pad.b, pad.t]).nice(5);
  const last = truth.filter((t) => t.date <= new Date(+ref - WEEK)).at(-1);
  const B = ms.map(({ m, slot }) => {
    const raw = fcPts(m, S.di);
    if (!raw) return null;
    const pts = raw.map((p) => ({ date: p.date, h: p.h, lo: p.a[LO], hi: p.a[HI], med: p.a[MED] }));
    if (S.anchor === "observed" && last) pts.unshift({ date: last.date, h: -1, lo: last.v, hi: last.v, med: last.v, anchor: true });
    return { m, slot, c: seriesVar(slot), pts };
  }).filter(Boolean);
  return { w, h, phone, pad, ref, x, y, B, last, area: d3.area().x((p) => x(p.date)).y0((p) => y(p.lo)).y1((p) => y(p.hi)) };
}

function draw(c) {
  const G = geometry(c);
  const { w, h, pad, x, y, B, ref, phone } = G;
  c.G = G;
  const ctx = { ...G, focus: S.focus ?? B[0]?.m };
  const svg = c.svg; svg.selectAll("*").remove();
  const clipId = `clip-${c.v.key}`;
  svg.append("defs").append("clipPath").attr("id", clipId).append("rect").attr("x", 0).attr("y", pad.t - 8).attr("width", w).attr("height", h - pad.b - pad.t + 8);

  // grid, axis, months, forecast-date rule
  const ticks = y.ticks(5).slice(1);
  svg.append("g").selectAll("line").data(ticks).join("line").attr("x1", 0).attr("x2", w).attr("y1", y).attr("y2", y).attr("stroke", "var(--line-hairline)");
  svg.append("g").selectAll("text").data(ticks).join("text").attr("class", "t-numeric-axis").attr("fill", "var(--ink-tertiary)").attr("x", pad.l).attr("y", (d) => y(d) - 5).text(fmtTick);
  svg.append("line").attr("x1", 0).attr("x2", w).attr("y1", h - pad.b).attr("y2", h - pad.b).attr("stroke", "var(--line-axis)");
  const months = d3.utcMonth.range(d3.utcMonth.ceil(x.domain()[0]), x.domain()[1]);
  svg.append("g").selectAll("text").data(months).join("text").attr("class", "t-label-chart").attr("fill", "var(--ink-tertiary)").attr("x", (d) => x(d) + 4).attr("y", h - pad.b + 20).text((d) => d3.utcFormat(d.getUTCMonth() === 0 ? "%b %Y" : "%b")(d));
  svg.append("line").attr("x1", x(ref)).attr("x2", x(ref)).attr("y1", pad.t - 8).attr("y2", h - pad.b).attr("stroke", "var(--line-axis)");

  // bands (clipped to the plot: the y-axis is fixed, so tall bands run off the top)
  const plot = svg.append("g").attr("clip-path", `url(#${clipId})`);
  c.v.draw(plot.append("g"), B, ctx);
  const top = y.domain()[1];

  // hover: a hairline at the week (the readout has the numbers)
  const hp = c.hover;
  if (hp) svg.append("line").attr("x1", x(hp.date)).attr("x2", x(hp.date)).attr("y1", pad.t - 8).attr("y2", h - pad.b).attr("stroke", "var(--ink-faint)");

  // observed data: filled up to what was known at the forecast date, hollow after
  const cutoff = new Date(+ref - WEEK);
  const obs = truth.filter((t) => t.date >= x.domain()[0] && t.date <= x.domain()[1]);
  svg.append("path").attr("d", d3.line().x((d) => x(d.date)).y((d) => y(d.v))(obs)).attr("fill", "none").attr("stroke", "var(--ink-secondary)").attr("stroke-width", 1.25).attr("stroke-linejoin", "round");
  svg.append("g").selectAll("circle").data(obs).join("circle").attr("r", 2.4).attr("cx", (d) => x(d.date)).attr("cy", (d) => y(d.v))
    .attr("fill", (d) => (d.date > cutoff ? "var(--surface-chart)" : "var(--ink-primary)")).attr("stroke", (d) => (d.date > cutoff ? "var(--ink-secondary)" : "var(--surface-chart)")).attr("stroke-width", 1.25);

  // misses: observed weeks outside the focused model's 95% interval get a quiet ring
  if (S.calib) {
    const f = B.find((b) => b.m === ctx.focus);
    const miss = f ? f.pts.filter((p) => !p.anchor && truthAt.has(+p.date)).map((p) => ({ p, v: truthAt.get(+p.date) })).filter((d) => d.v < d.p.lo || d.v > d.p.hi) : [];
    svg.append("g").selectAll("circle").data(miss).join("circle").attr("r", 6).attr("cx", (d) => x(d.p.date)).attr("cy", (d) => y(d.v)).attr("fill", "none").attr("stroke", f?.c).attr("stroke-width", 1.25);
  }

  // medians on top
  const mg = svg.append("g").selectAll("g").data(B).join("g");
  mg.append("path").attr("fill", "none").attr("stroke", (b) => b.c).attr("stroke-width", 1.75).attr("stroke-linejoin", "round").attr("d", (b) => d3.line().x((p) => x(p.date)).y((p) => y(p.med))(b.pts));
  mg.selectAll("circle").data((b) => b.pts.filter((p) => !p.anchor).map((p) => ({ ...p, c: b.c }))).join("circle").attr("r", 2.9).attr("cx", (p) => x(p.date)).attr("cy", (p) => y(p.med)).attr("fill", (p) => p.c).attr("stroke", "var(--surface-chart)").attr("stroke-width", 1.75);

  // width rulers: each model's interval as a bar beside the fan, at the hovered week (default: 3 weeks ahead)
  const rx0 = x.range()[1] + 14;
  if (S.rulers && B.length) {
    const rh = hp ? hp.h : 3, step = phone ? 10 : 13;
    const rg = svg.append("g");
    rg.append("text").attr("class", "t-label-chart").attr("fill", "var(--ink-tertiary)").attr("x", rx0 - 4).attr("y", pad.t - 12).text(rh === 0 ? "now" : `+${rh} wk`);
    const rows = B.map((b, i) => ({ b, i, p: b.pts.find((p) => p.h === rh) })).filter((d) => d.p);
    const ruler = rg.append("g").attr("clip-path", `url(#${clipId})`).selectAll("g").data(rows).join("g").attr("transform", (d) => `translate(${rx0 + d.i * step},0)`).attr("stroke", (d) => d.b.c).attr("stroke-linecap", "round");
    ruler.append("line").attr("y1", (d) => y(d.p.lo)).attr("y2", (d) => y(d.p.hi)).attr("stroke-width", 2).attr("stroke-opacity", 0.75);
    for (const e of ["lo", "hi"]) ruler.append("line").attr("x1", -3.5).attr("x2", 3.5).attr("y1", (d) => y(d.p[e])).attr("y2", (d) => y(d.p[e])).attr("stroke-width", 1.75);
    ruler.append("circle").attr("r", 2.6).attr("cy", (d) => y(d.p.med)).attr("fill", "var(--surface-chart)").attr("stroke-width", 1.5);
  }

  // direct labels at the end of each median; click to focus
  const lx = (S.rulers ? rx0 + B.length * (phone ? 10 : 13) + 6 : x.range()[1] + 12);
  const labs = B.map((b) => ({ b, y: y(Math.min(b.pts.at(-1).med, top)) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labs.length; i++) labs[i].y = Math.max(labs[i].y, labs[i - 1].y + 16);
  const lg = svg.append("g").selectAll("g").data(labs).join("g").attr("class", "label-hit").attr("transform", (d) => `translate(${lx},${d.y})`)
    .on("click", (e, d) => { e.stopPropagation(); S.focus = d.b.m; drawAll(); });
  lg.append("rect").attr("x", -4).attr("y", -9).attr("height", 18).attr("width", w - lx).attr("fill", "transparent");
  lg.append("circle").attr("r", 3.5).attr("fill", (d) => d.b.c);
  lg.append("text").attr("class", "t-label-chart").attr("x", 9).attr("dy", "0.34em")
    .attr("fill", (d) => (B.length > 1 && d.b.m === ctx.focus ? "var(--ink-primary)" : "var(--ink-secondary)"))
    .attr("font-weight", (d) => (B.length > 1 && d.b.m === ctx.focus ? 600 : null))
    .text((d) => short(d.b.m))
    .each(function (d) {
      const room = w - lx - 9 - 8, full = this.textContent;
      if (this.getComputedTextLength() > room) { let s = full; while (s.length > 2 && this.getComputedTextLength() > room) { s = s.slice(0, -1); this.textContent = s.trimEnd() + "…"; } }
      d3.select(this).append("title").text(full);
    });

  readout(c);
}

/* ---------------- hover: snap to the nearest forecast week ---------------- */
function hover(c, e) {
  if (e.target.closest?.(".label-hit")) return;
  const G = c.G; if (!G) return;
  const r = c.stage.getBoundingClientRect(), px = e.clientX - r.left;
  const weeks = [0, 1, 2, 3].map((h) => ({ h, date: new Date(+G.ref + h * WEEK) }));
  const near = weeks.reduce((a, b) => (Math.abs(G.x(b.date) - px) < Math.abs(G.x(a.date) - px) ? b : a));
  const tooFar = Math.abs(G.x(near.date) - px) > 60 && px < G.x(G.ref) - 20;
  const next = tooFar ? null : near;
  if (next?.h === c.hover?.h) return;
  c.hover = next; draw(c);
}

function readout(c) {
  const el = c.readout, hp = c.hover, G = c.G;
  if (!hp) { el.hidden = true; return; }
  const rows = G.B.map((b) => ({ b, p: b.pts.find((p) => +p.date === +hp.date) })).filter((d) => d.p);
  const obs = truthAt.get(+hp.date);
  el.innerHTML = `<div class="when"><span>${fmtWeek(hp.date)}</span><span>${hp.h === 0 ? "this week" : `${hp.h} wk ahead`} · 95%</span></div>
    <table>${rows.map(({ b, p }) => {
      const out = obs != null && (obs < p.lo || obs > p.hi);
      return `<tr><td><span class="nm"><i style="background:${b.c}"></i><span class="t">${short(b.m)}</span></span></td><td class="rng${out ? " miss" : ""}">${fmtN(p.lo)} – ${fmtN(p.hi)}</td><td class="wd">±${d3.format(".2~s")((p.hi - p.lo) / 2)}</td></tr>`;
    }).join("")}</table>
    ${obs != null ? `<div class="obs"><span>Observed</span><span class="mono">${fmtN(obs)}</span></div>` : ""}`;
  el.hidden = false;
  if (!S.phone) {
    const px = G.x(hp.date), rw = el.offsetWidth;
    // prefer the history side (left), which is empty space at the top; the bands are to the right
    el.style.left = `${px - 16 - rw > 8 ? px - 16 - rw : px + 16}px`;
  }
}

function drawAll() { for (const c of charts) draw(c); }

/* ---------------- controls ---------------- */
for (const id of ["brand", "nav", "theme"]) new LiquidGlass($(id), {});
$("theme").addEventListener("click", () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  store.set("viz-ds-theme", root.dataset.theme);
  requestAnimationFrame(() => LiquidGlass.updateAll());
});

build();
// toolbar controls wrap instead of collapsing into menus, so opt them out of the zone fitting
const keep = (seg) => { seg.fit = () => {}; seg.el.classList.remove("collapsed"); return seg; };
keep(new Segmented($("t-set"), { label: "Models", value: S.set, items: [{ value: "close", label: "Close" }, { value: "apart", label: "Apart" }, { value: "skewed", label: "Skewed" }, { value: "baseline", label: "+ Baseline" }], onChange: (v) => { S.set = v; S.focus = null; drawAll(); } }));
keep(new Segmented($("t-count"), { label: "How many models", value: "3", items: [{ value: "1", label: "1" }, { value: "3", label: "3" }, { value: "8", label: "8" }], onChange: (v) => { S.count = +v; drawAll(); } }));
const stepper = new Stepper($("t-date"), { values: DATES, index: DI0, label: "Forecast date", format: { long: fmtLong, short: fmtShort }, onChange: (i) => { S.di = i; drawAll(); } });
keep(new Segmented($("t-anchor"), { label: "Band starts at", value: S.anchor, items: [{ value: "observed", label: "From observed" }, { value: "h0", label: "From week 0" }], onChange: (v) => { S.anchor = v; drawAll(); } }));
keep(new Segmented($("t-size"), { label: "Width", value: "full", items: [{ value: "full", label: "Full" }, { value: "phone", label: "Phone" }], onChange: (v) => { S.phone = v === "phone"; document.body.classList.toggle("phone", S.phone); drawAll(); } }));
for (const [id, key] of [["t-rulers", "rulers"], ["t-calib", "calib"]]) {
  const b = $(id);
  new LiquidGlass(b, { frosted: true });
  b.addEventListener("click", () => { S[key] = !S[key]; b.setAttribute("aria-pressed", S[key]); drawAll(); });
}

timeKeys((d) => stepper.step(d));
drawAll();
let rt = 0;
new ResizeObserver(() => { cancelAnimationFrame(rt); rt = requestAnimationFrame(drawAll); }).observe($("studies"));
