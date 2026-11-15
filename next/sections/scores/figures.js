/* The figures under the leaderboard (design/studies/evaluation-goals.md, "Figures"): Calibration,
 * Horizon and Anatomy, and the small per-model plots of the expanded row. SVG on the paper; every color
 * and size comes from classes in styles/scores.css (tokens), so a theme change needs no redraw.
 * Lines are ink; a model on the fan chart keeps its chart colour. Emphasized models (hovered, focused, expanded) are full ink and named at the line end;
 * the rest recede. */
import { linear, niceStep, ticks } from "../../lib/scale.js";
import { LEVELS, fmtScore } from "./model.js";

const NS = "http://www.w3.org/2000/svg";
/** An SVG element: s("line", { x1, … }, ...children). `class` may be an array. */
export function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.setAttribute("class", Array.isArray(v) ? v.filter(Boolean).join(" ") : v);
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c) el.append(c);
  return el;
}

/* A label in at most `max` px. One that fits is plain text. A longer one shows its start, fading at
 * the cut, inside a clipped box; hovering that label (or its bar row) glides it to its end
 * (the same rule as slideText for HTML names). anchor "end": the box ends at x. */
let slideN = 0;
export function slideLabel(svg, parent, { x, y, text, max, anchor = "start", cls, style = null }) {
  const t = s("text", { x, y, "text-anchor": anchor, "dominant-baseline": "middle", class: cls, text, style });
  parent.append(t);
  // measured at the emphasized weight too (a hovered label is set heavier, so wider): slide far enough
  const plain = t.getComputedTextLength();
  t.style.fontWeight = "var(--weight-strong)";
  const len = Math.max(plain, t.getComputedTextLength());
  t.style.fontWeight = "";
  if (!(plain > max) || max < 24) return t;
  t.remove();
  const H = 16, x0 = anchor === "end" ? x - max : x, id = `scs${++slideN}`;
  const defs = svg.querySelector(":scope > defs") || svg.insertBefore(s("defs"), svg.firstChild);
  for (const [k, a, b] of [["r", max - 12, max], ["l", 12, 0]]) {
    const g = s("linearGradient", { id: `${id}${k}g`, gradientUnits: "userSpaceOnUse", x1: a, x2: b, y1: 0, y2: 0 });
    g.append(s("stop", { offset: 0, "stop-color": "#fff" }), s("stop", { offset: 1, "stop-color": "#fff", "stop-opacity": 0 }));
    const m = s("mask", { id: `${id}${k}`, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: max, height: H });
    m.append(s("rect", { x: 0, y: 0, width: max, height: H, fill: `url(#${id}${k}g)` }));
    defs.append(g, m);
  }
  const box = s("svg", { x: x0, y: y - H / 2, width: max, height: H, overflow: "hidden", class: "sc-slide", style: `--slide:${(max - len).toFixed(1)}px;--ml:url(#${id}l)` });
  const inner = s("g", { mask: `url(#${id}r)`, class: "sc-slide-mask" });
  inner.append(s("text", { x: 0, y: H / 2, "dominant-baseline": "middle", class: cls, text, style }));
  box.append(inner);
  parent.append(box);
  return box;
}

const LABEL_GAP = 13;      // px between stacked line-end labels (one --text-chart line)
const path = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");

/* spread labels vertically so none overlap, keeping each as near its line end as it can */
function spread(items, lo, hi) {
  items.sort((a, b) => a.y - b.y);
  for (let i = 1; i < items.length; i++) items[i].y = Math.max(items[i].y, items[i - 1].y + LABEL_GAP);
  const over = items.length ? items.at(-1).y - hi : 0;
  if (over > 0) for (let i = items.length - 1; i >= 0; i--) items[i].y = Math.max(lo, Math.min(items[i].y, (i === items.length - 1 ? hi : items[i + 1].y - LABEL_GAP)));
  return items;
}

/**
 * A line figure: one ink line per model, an x axis of categories or numbers, a reference line.
 * @param {SVGSVGElement} svg sized by CSS; redrawn in place
 * @param {{ series: { id, label, dot?: string, base?: boolean, pts: [number, number][] }[],
 *           x: { domain: [number, number], ticks: number[], fmt(v): string },
 *           y: { domain: [number, number], ticks: number[], fmt(v): string, log?: boolean },
 *           ref?: number, emph: Set<string>, hover: string | null, labels?: "auto" | "emph",
 *           onHover?(id: string | null): void, onPick?(id: string): void }} o
 */
export function lineFigure(svg, o) {
  const w = svg.clientWidth || svg.parentElement.clientWidth, h = svg.clientHeight;
  svg.replaceChildren();
  svg.dataset.named = "";
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  if (!w || !h) return;
  const pad = { l: 36, r: 150, t: 8, b: 22 }; // the right margin holds the end labels, never past the figure
  const tf = o.y.log ? Math.log : (v) => v;
  const X = linear(o.x.domain, [pad.l, w - pad.r]);
  const Y = linear(o.y.domain.map(tf), [h - pad.b, pad.t]);
  const y = (v) => Y(tf(Math.max(o.y.log ? 1e-6 : -Infinity, v)));
  const grid = s("g", { class: "sc-axis" });
  for (const t of o.y.ticks) {
    grid.append(s("line", { x1: pad.l, x2: w - pad.r, y1: y(t), y2: y(t), class: t === o.ref ? "sc-ref" : "sc-grid" }));
    grid.append(s("text", { x: pad.l - 6, y: y(t), class: "sc-tick", "text-anchor": "end", "dominant-baseline": "middle", text: o.y.fmt(t) }));
  }
  for (const t of o.x.ticks) grid.append(s("text", { x: X(t), y: h - 6, class: "sc-tick", "text-anchor": "middle", text: o.x.fmt(t) }));
  svg.append(grid);

  const hovering = o.hover != null;
  const lines = s("g"), labels = s("g"), ends = [];
  const order = [...o.series].sort((a, b) => (o.emph.has(a.id) || a.id === o.hover) - (o.emph.has(b.id) || b.id === o.hover));
  for (const se of order) {
    const pts = se.pts.filter(([, v]) => v != null && Number.isFinite(v)).map(([xv, yv]) => [X(xv), y(yv)]);
    if (!pts.length) continue;
    const em = se.id === o.hover || (!hovering && o.emph.has(se.id));
    const g = s("g", { class: ["sc-series", em && "is-emph", se.base && "is-base", se.dot && "is-charted", pts.length === 1 && "is-single"], "data-id": se.id, style: se.dot ? `--c:${se.dot}` : null });
    g.append(s("path", { d: path(pts), class: "sc-line" }));
    for (const [px, py] of pts) g.append(s("circle", { cx: px, cy: py, r: 2, class: "sc-pt" })); // shown when emphasized (CSS)
    g.append(s("path", { d: path(pts), class: "sc-hit" }));
    lines.append(g);
    ends.push({ se, em, x: pts.at(-1)[0], y: pts.at(-1)[1] });
  }
  svg.append(lines);
  const room = Math.floor((h - pad.t - pad.b) / LABEL_GAP) + 1;
  const named = ends.filter((e) => e.em || (o.labels !== "emph" && ends.length <= room));
  svg.append(labels); // in the document first: slideLabel measures text
  for (const e of spread(named.map((e) => ({ ...e })), pad.t, h - pad.b)) {
    const g = s("g", { class: ["sc-end", e.em && "is-emph", e.se.base && "is-base"], "data-id": e.se.id });
    let tx = e.x + 8;
    if (e.se.dot) { g.append(s("circle", { cx: tx + 3, cy: e.y, r: 3, style: `fill:${e.se.dot}` })); tx += 10; }
    labels.append(g);
    slideLabel(svg, g, { x: tx, y: e.y, text: e.se.label, max: w - tx - 2, cls: "sc-end-label" });
  }
  svg.dataset.named = named.length === ends.length ? "all" : "";
  svg.classList.toggle("has-hover", hovering);
  wire(svg, o);
}

/**
 * Restyle a drawn figure for new emphasis without rebuilding it.
 * @returns {boolean} false when it can't (a line figure that names only emphasized lines): redraw it
 */
export function emphasize(svg, emph, hover) {
  if (svg.dataset.named !== "all") return false;
  const hovering = hover != null;
  for (const g of svg.querySelectorAll(".sc-series[data-id], .sc-end[data-id]")) {
    const id = g.dataset.id, em = id === hover || (!hovering && emph.has(id));
    g.classList.toggle("is-emph", em);
    if (em && !g.classList.contains("sc-bar")) g.parentNode.append(g); // emphasized lines on top
  }
  svg.classList.toggle("has-hover", hovering);
  return true;
}

/* hovering a line (or its label) names it and tells the table; clicking picks it */
function wire(svg, o) {
  svg.onpointerover = (e) => { const g = e.target.closest?.("[data-id]"); o.onHover?.(g ? g.dataset.id : null); };
  svg.onpointerleave = () => o.onHover?.(null);
  svg.onclick = (e) => { const g = e.target.closest?.("[data-id]"); if (g) o.onPick?.(g.dataset.id); };
}

/** y-axis ticks and domain for values around a reference, with at least `min` either side. */
export function symmetricAxis(values, min, count = 4) {
  const m = Math.max(min, ...values.filter(Number.isFinite).map(Math.abs));
  const step = niceStep(2 * m, count), top = Math.ceil(m / step) * step;
  return { domain: [-top, top], ticks: ticks(-top, top, step) };
}

/** A log axis for ratios: domain covering the values (and 1), ticks at 0.5, 0.7, 1, 1.4, 2 … */
export function ratioAxis(values) {
  const v = values.filter((x) => x > 0);
  const lo = Math.min(0.9, ...v) * 0.94, hi = Math.max(1.1, ...v) * 1.06;
  const fine = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.2, 1.4, 1.7, 2, 2.5, 3, 4];
  const coarse = [0.25, 0.35, 0.5, 0.7, 1, 1.4, 2, 2.8, 4];
  const pick = (c) => c.filter((t) => t >= lo && t <= hi);
  return { domain: [lo, hi], ticks: pick(fine).length <= 6 ? pick(fine) : pick(coarse) };
}

/**
 * Calibration: coverage minus nominal at every level (10–98%) per model. 0 is calibrated; above,
 * intervals too wide; below, too narrow.
 */
export function calibrationFigure(svg, rows, o) {
  const series = rows.filter((r) => r.active).map((r) => ({
    id: r.id, label: r.label, dot: r.dot, base: r.baseline,
    pts: LEVELS.map((l, i) => [l * 100, r.cal[i] == null ? null : r.cal[i] - l * 100]),
  }));
  const ax = symmetricAxis(series.flatMap((se) => se.pts.map((p) => p[1])), 10);
  lineFigure(svg, {
    ...o, series, ref: 0,
    x: { domain: [5, 100], ticks: [10, 30, 50, 80, 95], fmt: (v) => `${v}` },
    y: { ...ax, fmt: (v) => (v > 0 ? `+${v}` : `${v}`) },
  });
}

/** Horizon: relative WIS at 0–3 weeks ahead, log scale, a line at 1 (the baseline). */
export function horizonFigure(svg, rows, o) {
  const series = rows.filter((r) => r.active).map((r) => ({
    id: r.id, label: r.label, dot: r.dot, base: r.baseline,
    pts: [0, 1, 2, 3].map((hh) => [hh, r.baseline ? 1 : r.byH[hh]?.rel ?? null]),
  }));
  const ax = ratioAxis(series.flatMap((se) => se.pts.map((p) => p[1])));
  lineFigure(svg, {
    ...o, series, ref: 1,
    x: { domain: [-0.2, 3.2], ticks: [0, 1, 2, 3], fmt: (v) => `${v} wk` },
    y: { ...ax, log: true, fmt: (v) => String(v) },
  });
}

/**
 * Anatomy: each model's WIS as spread, over- and under-prediction (three ink tones), in table order.
 * @param {{ share: boolean }} o share: each bar as parts of its own WIS
 */
export function anatomyFigure(svg, rows, o) {
  const w = svg.clientWidth || svg.parentElement.clientWidth;
  const list = rows.filter((r) => r.active && r.comp.spread != null);
  const bar = 6, gap = 8, pad = { l: 150, r: 48, t: 4, b: 22 };
  const h = Math.max(svg.clientHeight, pad.t + pad.b + list.length * (bar + gap));
  svg.replaceChildren();
  svg.dataset.named = "";
  svg.style.height = `${h}px`;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  if (!w) return;
  const tot = (r) => (r.comp.spread || 0) + (r.comp.over || 0) + (r.comp.under || 0);
  const max = o.share ? 1 : Math.max(1e-9, ...list.map(tot));
  const step = o.share ? 0.25 : niceStep(max, 4);
  const X = linear([0, o.share ? 1 : Math.ceil(max / step) * step], [pad.l, w - pad.r]);
  const axis = s("g", { class: "sc-axis" });
  for (const t of ticks(0, X.domain()[1], step)) {
    axis.append(s("line", { x1: X(t), x2: X(t), y1: pad.t, y2: h - pad.b, class: "sc-grid" }));
    axis.append(s("text", { x: X(t), y: h - 6, class: "sc-tick", "text-anchor": "middle", text: o.share ? `${Math.round(t * 100)}%` : Number.isInteger(step) ? String(t) : fmtScore(t) }));
  }
  svg.append(axis);
  const hovering = o.hover != null;
  list.forEach((r, i) => {
    const y0 = pad.t + i * (bar + gap) + gap / 2, T = tot(r) || 1;
    const em = r.id === o.hover || (!hovering && o.emph.has(r.id));
    const g = s("g", { class: ["sc-series", "sc-bar", em && "is-emph", r.baseline && "is-base"], "data-id": r.id });
    g.append(s("rect", { x: 0, y: y0 - gap / 2, width: w, height: bar + gap, class: "sc-hit-rect" }));
    svg.append(g);
    slideLabel(svg, g, { x: pad.l - 8, y: y0 + bar / 2, text: r.label, max: pad.l - 12, anchor: "end", cls: "sc-bar-label" });
    let x = 0;
    for (const [k, cls] of [["spread", "sc-c1"], ["over", "sc-c2"], ["under", "sc-c3"]]) {
      const v = (r.comp[k] || 0) / (o.share ? T : 1);
      g.append(s("rect", { x: X(x), y: y0, width: Math.max(0, X(x + v) - X(x)), height: bar, class: cls }));
      x += v;
    }
    if (!o.share) g.append(s("text", { x: X(x) + 6, y: y0 + bar / 2, "dominant-baseline": "middle", class: "sc-tick", text: fmtScore(T) }));
  });
  svg.dataset.named = "all";
  svg.classList.toggle("has-hover", hovering);
  wire(svg, o);
}
