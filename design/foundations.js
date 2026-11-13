import { LiquidGlass } from "./lib/glass.js";
import { loadData, fanChart, seriesVar, short } from "./lib/chart.js";

const root = document.documentElement;
const cssVar = (n) => getComputedStyle(root).getPropertyValue(n).trim();
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

const [tokens, data] = await Promise.all([fetch("tokens/tokens.json").then((r) => r.json()), loadData("data/")]);

/* ---------- theme ---------- */
const saved = store.get("viz-ds-theme");
if (saved) root.dataset.theme = saved;
const themeLabel = () => (document.getElementById("theme-label").textContent = `Showing the ${root.dataset.theme} theme`);
themeLabel();
document.getElementById("theme").addEventListener("click", () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  store.set("viz-ds-theme", root.dataset.theme);
  themeLabel(); renderThemed();
});

/* ---------- chrome: backdrop glass over page content (frosted outside Chromium) ---------- */
for (const id of ["brand", "nav", "theme"]) new LiquidGlass(document.getElementById(id), { highlight: false });
const navLinks = [...document.querySelectorAll("#nav a")];
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) navLinks.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#${e.target.id}`)); }), { rootMargin: "-40% 0px -55% 0px" });
document.querySelectorAll("main section").forEach((s) => io.observe(s));

/* ---------- color ---------- */
const GROUPS = [
  ["Surfaces", ["surface-page", "surface-chart", "surface-raised"]],
  ["Text", ["ink-primary", "ink-secondary", "ink-tertiary", "ink-faint"]],
  ["Lines", ["line-hairline", "line-axis"]],
  ["Interaction", ["accent", "fill-hover", "fill-selected", "fill-field"]],
  ["Glass", ["glass-tint", "glass-frost", "glass-stroke", "glass-highlight"]],
  ["Models", [...tokens.color.seriesNames.map((n, i) => [`series-${i + 1}`, `${i + 1} · ${n}`]), ["series-baseline", "baseline"]]],
  ["Heatmap", ["heat-better", "heat-neutral", "heat-worse"]],
];
const sw = d3.select("#swatches");
for (const [g, list] of GROUPS) {
  sw.append("h3").attr("class", "t-title-3").style("margin-top", g === "Surfaces" ? "0" : null).text(g);
  const grid = sw.append("div").attr("class", "swatches" + (g === "Models" ? " series" : ""));
  for (const item of list) {
    const [v, label] = Array.isArray(item) ? item : [item, item];
    const d = grid.append("div").attr("class", "sw");
    d.append("div").attr("class", "chip" + (v.startsWith("glass") || v.startsWith("fill") ? " checker" : "")).append("i").style("background", `var(--${v})`);
    d.append("span").attr("class", "name t-label-control").text(label);
    d.append("span").attr("class", "val t-numeric-axis").attr("data-var", v);
  }
}
const swatchValues = () => d3.selectAll(".sw .val").text(function () { return cssVar(`--${this.dataset.var}`).replace(/\s+/g, " "); });

const top8 = data.ranked.filter((m) => m !== data.D.baseline && data.fcPts(m, data.DI0)).slice(0, 8);
const seriesModels = [...top8.map((m, i) => ({ m, slot: i })), { m: data.D.baseline, slot: "baseline" }];
const ref0 = data.DATES[data.DI0], WK = 7 * 864e5;
const drawSeries = () => fanChart(d3.select("#series-chart"), data, { models: seriesModels, pad: { r: 190 }, domain: [new Date(+ref0 - 7 * WK), new Date(+ref0 + 4 * WK)] });

function drawHeatmap() {
  const card = document.querySelector(".heat-card");
  heatmapInto(d3.select("#heatmap"), Math.max(560, card.clientWidth - 48), 12);
  const s2 = document.getElementById("stage2");
  heatmapInto(d3.select("#heat-glass"), s2.clientWidth, (s2.clientHeight - 40) / 36, { id: "heat-src", bg: true, pad: 20, rows: 36 });
}
function heatmapInto(svg0, W, rh, { id = null, bg = false, pad = 0, rows: nRows = null } = {}) {
  const { D, DATES, STATES } = data;
  const M = "UMass-flusion";
  let rows = STATES.slice().sort((a, b) => D.locations[a].abbr.localeCompare(D.locations[b].abbr));
  if (nRows) rows = rows.slice(0, nRows);
  const lw = 34 + pad, top = 18 + pad, cw = (W - lw - pad) / DATES.length;
  svg0.attr("width", W).attr("height", top + rows.length * rh + pad);
  svg0.selectAll("*").remove();
  const svg = svg0.append("g").attr("id", id);
  if (bg) svg.append("rect").attr("width", W).attr("height", top + rows.length * rh + pad).attr("fill", "var(--surface-chart)");
  const better = cssVar("--heat-better"), mid = cssVar("--heat-neutral"), worse = cssVar("--heat-worse");
  const col = (t) => (t < 0 ? d3.interpolateRgb(mid, better)(Math.min(1, -t / 1.2)) : d3.interpolateRgb(mid, worse)(Math.min(1, t / 1.2)));
  svg.append("g").selectAll("text").data(DATES.filter((_, i) => i % 4 === 0)).join("text").attr("class", "t-numeric-axis").attr("fill", "var(--ink-tertiary)")
    .attr("x", (d) => lw + DATES.indexOf(d) * cw).attr("y", pad + 10).text(d3.utcFormat("%b %-d"));
  rows.forEach((li, r) => {
    const g = svg.append("g").attr("transform", `translate(0,${top + r * rh})`);
    g.append("text").attr("class", "t-numeric-axis").attr("fill", "var(--ink-tertiary)").attr("x", pad).attr("y", rh - 3).text(D.locations[li].abbr);
    DATES.forEach((_, di) => {
      const w = D.wis[M][di][li], b = D.wis[D.baseline][di][li];
      g.append("rect").attr("x", lw + di * cw).attr("width", cw - 2).attr("height", rh - 2).attr("rx", 2)
        .attr("fill", w > 0 && b > 0 ? col(Math.log2(w / b)) : "var(--fill-hover)");
    });
  });
  document.getElementById("ramp").style.background = `linear-gradient(to right, ${better}, ${mid}, ${worse})`;
}
/* A glass control you can move by pointer or keyboard. Positioned with transforms (no layout),
   and moves are coalesced to one per frame. Position is kept as a fraction of the stage, so it
   stays put proportionally when the stage resizes. */
function movable(el, stageEl, glassOpts, fx, fy) {
  const g = new LiquidGlass(el, glassOpts);
  let fxv = fx, fyv = fy, x = 0, y = 0, raf = 0, drag = null;
  const maxX = () => stageEl.clientWidth - el.offsetWidth, maxY = () => stageEl.clientHeight - el.offsetHeight;
  const apply = () => { raf = 0; el.style.transform = `translate(${x}px, ${y}px)`; g.update(); };
  const set = (nx, ny) => {
    x = Math.max(0, Math.min(maxX(), nx)); y = Math.max(0, Math.min(maxY(), ny));
    fxv = maxX() > 0 ? x / maxX() : 0; fyv = maxY() > 0 ? y / maxY() : 0;
    if (!raf) raf = requestAnimationFrame(apply);
  };
  el.tabIndex = 0;
  el.addEventListener("pointerdown", (e) => { drag = { dx: e.clientX - x, dy: e.clientY - y }; el.setPointerCapture(e.pointerId); el.classList.add("dragging"); });
  el.addEventListener("pointermove", (e) => { if (drag) set(e.clientX - drag.dx, e.clientY - drag.dy); });
  el.addEventListener("pointerup", () => { drag = null; el.classList.remove("dragging"); });
  el.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 40 : 10, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) { e.preventDefault(); set(x + d[0], y + d[1]); }
  });
  const relayout = () => { x = fxv * maxX(); y = fyv * maxY(); apply(); };
  relayout();
  return { glass: g, relayout };
}

/* ---------- type ---------- */
const SAMPLE = {
  "display-lg": "United States", "display-sm": "UMass-flusion", "display-italic": "Nothing to compare yet.",
  "title-1": "Evaluate", "title-2": "Models", "title-3": "Leaderboard",
  body: "Relative WIS compares each model with the baseline across every state and week in the window. Lower is better.",
  "body-strong": "axial-tfm_L4v5", small: "Updated Nov 8 · 57 models · 28 forecast dates",
  "label-control": "Dec 27, 2025", "label-section": "Season so far", "label-chart": "flusion",
  "numeric-hero": "42.6k", "numeric-value": "30.6k  19.4k–36.5k", "numeric-axis": "10k   20k   30k   40k",
  "numeric-code": "python score_cli.py --window 2025-11-22:2026-03-28",
};
const tl = d3.select("#type-list");
for (const [k, t] of Object.entries(tokens.type)) {
  const r = tl.append("div").attr("class", "type-row");
  const m = r.append("div").attr("class", "meta");
  m.append("span").attr("class", "t-label-control").text(k);
  m.append("span").attr("class", "mono").text(`${t.family} ${t.weight}${t.style === "italic" ? " italic" : ""} · ${t.size}/${t.lineHeight}${t.letterSpacing ? ` · ${t.letterSpacing > 0 ? "+" : ""}${t.letterSpacing}em` : ""}`);
  m.append("span").attr("class", "use").text(t.use);
  r.append("div").attr("class", `t-${k}`).style("color", k.includes("axis") || k === "small" || k === "label-section" ? "var(--ink-tertiary)" : k === "body" || k === "label-chart" || k === "numeric-code" ? "var(--ink-secondary)" : null).text(SAMPLE[k]);
}

/* ---------- dimensions ---------- */
const sp = d3.select("#spacing");
for (const s of tokens.space) { const r = sp.append("div").attr("class", "space-row"); r.append("span").attr("class", "t-numeric-value").text(s); r.append("i").style("width", `var(--space-${s})`); }
const rd = d3.select("#radii");
for (const [k, v] of Object.entries(tokens.radius)) { const c = rd.append("div"); c.append("div").attr("class", "r" + (k === "pill" ? " wide" : "")).style("border-radius", `var(--radius-${k})`); c.append("div").attr("class", "t-label-control").text(k); c.append("div").attr("class", "t-numeric-axis").style("color", "var(--ink-tertiary)").text(v); }
const hs = d3.select("#heights");
for (const k of ["control-sm", "control", "control-lg"]) hs.append("span").style("height", `var(--size-${k})`).text(`${k} · ${tokens.size[k]}`);
const stv = d3.select("#strokes");
for (const [k, v] of Object.entries(tokens.stroke)) {
  const c = stv.append("div");
  c.append("svg").append("line").attr("x1", 0).attr("x2", 96).attr("y1", 6).attr("y2", 6).attr("stroke", k === "series" ? "var(--series-1)" : "var(--ink-secondary)").style("stroke-width", `var(--stroke-${k})`);
  c.append("div").attr("class", "t-label-control").text(k); c.append("div").attr("class", "t-numeric-axis").style("color", "var(--ink-tertiary)").text(`${v}px`);
}

/* ---------- glass stage ---------- */
const stage = document.getElementById("stage");
const glassModels = [...top8.slice(0, 3).map((m, i) => ({ m, slot: i })), { m: data.D.baseline, slot: "baseline" }];
const drawGlassChart = () => fanChart(d3.select("#glass-chart"), data, { models: glassModels, id: "glass-src", band: 0.8, pad: { r: 180, t: 96, b: 72 } });
drawGlassChart();
const reduce = matchMedia("(prefers-reduced-transparency: reduce)").matches;
const panel = document.getElementById("g-panel");
panel.innerHTML = `<div class="hd t-label-section">Models</div>` + seriesModels.slice(0, 6).map((s) => `<div class="row"><i style="background:${seriesVar(s.slot)}"></i><span>${short(s.m)}</span><span class="v t-numeric-value">${data.seasonRel.get(s.m).toFixed(2)}</span></div>`).join("");
panel.style.right = "16px"; panel.style.top = "70px";
const glasses = [
  new LiquidGlass(document.getElementById("g-loc"), { source: "#glass-src", container: stage, frosted: reduce }),
  new LiquidGlass(document.getElementById("g-seg"), { source: "#glass-src", container: stage, frosted: reduce }),
  new LiquidGlass(panel, { container: stage, frosted: true, highlight: false }),
];
const stage2 = document.getElementById("stage2");
const lenses = [
  movable(document.getElementById("lens"), stage, { source: "#glass-src", container: stage, frosted: reduce }, 0.22, 0.62),
  movable(document.getElementById("lens2"), stage2, { source: "#heat-src", container: stage2, frosted: reduce }, 0.5, 0.45),
];
const seg = document.getElementById("g-seg");
const syncSeg = () => { const on = seg.querySelector("button.on"), th = seg.querySelector(".thumb"); th.style.left = `${on.offsetLeft}px`; th.style.width = `${on.offsetWidth}px`; };
seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); syncSeg(); }));
syncSeg();

/* ---------- motion ---------- */
const SPRINGS = [
  ["spring", "Default for controls, morphs and panels."],
  ["spring-soft", "Larger movements: toolbars, page-level changes."],
];
const sg = d3.select("#springs");
for (const [k, use] of SPRINGS) {
  const { easing, duration } = tokens.motion[k];
  const pts = easing.replace(/^linear\(|\)$/g, "").split(",").map(Number);
  const c = sg.append("div").attr("class", "card spring");
  const row = c.append("div").attr("class", "row");
  row.append("span").attr("class", "t-title-3").text(k);
  row.append("span").attr("class", "mono t-numeric-axis").text(`${duration} ms`);
  c.append("div").attr("class", "t-small").style("color", "var(--ink-secondary)").text(use);
  const svg = c.append("svg").attr("class", "curve").attr("viewBox", "0 0 300 120").attr("preserveAspectRatio", "none");
  const x = d3.scaleLinear([0, pts.length - 1], [0, 300]), y = d3.scaleLinear([0, 1.25], [116, 4]);
  svg.append("line").attr("x1", 0).attr("x2", 300).attr("y1", y(1)).attr("y2", y(1)).attr("stroke", "var(--line-axis)").attr("stroke-dasharray", "2 3");
  svg.append("path").attr("d", d3.line().x((_, i) => x(i)).y(y)(pts)).attr("fill", "none").attr("stroke", "var(--accent)").attr("stroke-width", 1.75).attr("vector-effect", "non-scaling-stroke");
  const track = c.append("div").attr("class", "track"), ball = track.append("div").attr("class", "ball").node();
  let out = false;
  c.append("div").style("margin-top", "var(--space-12)").append("button").attr("class", "btn t-label-control").text("Play").on("click", () => {
    const dist = track.node().clientWidth - 34;
    out = !out;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { ball.style.transform = `translateX(${out ? dist : 0}px)`; return; }
    ball.animate([{ transform: `translateX(${out ? 0 : dist}px)` }, { transform: `translateX(${out ? dist : 0}px)` }], { duration, easing, fill: "forwards" });
  });
}

/* ---------- render + resize ---------- */
function renderThemed() { swatchValues(); drawHeatmap(); requestAnimationFrame(() => LiquidGlass.updateAll()); }
function renderAll() {
  drawSeries(); drawGlassChart(); renderThemed();
  lenses.forEach((l) => l.relayout());
  glasses.forEach((g) => g.update());
}
renderAll();
let rz = 0;
addEventListener("resize", () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(renderAll); });
