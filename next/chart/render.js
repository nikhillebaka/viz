/* Paints a fan chart scene (chart/layout.js) on a canvas. Same marks, order, widths and alphas as the
 * prototype's fanCanvas (design/lib/chart.js). Colors and strokes are the design tokens, resolved
 * through lib/dom.js (cached per theme). One difference by nature from layered SVG: a dimmed median's
 * line and dots each get the alpha, rather than the group as one layer. */
import { cssColor, token, tokenNum } from "../lib/dom.js";

const TAU = Math.PI * 2;

/* ---------------- text: measuring and the chart's fonts ---------------- */
let mctx = null;
const widths = new Map();
let fonts = null;
// widths measured before web fonts load are those of the fallback fonts
globalThis.document?.fonts?.addEventListener?.("loadingdone", () => { widths.clear(); fonts = null; });
globalThis.document?.fonts?.ready.then(() => { widths.clear(); fonts = null; });

/**
 * Canvas text measurement, cached per (font, text); the cache clears when web fonts finish loading.
 * Pass it to layoutFan as opts.measure.
 * @returns {(text: string, font: string) => number} width in CSS px
 */
export function canvasMeasure() { return measure; }
function measure(text, font) {
  let byFont = widths.get(font);
  if (!byFont) widths.set(font, (byFont = new Map()));
  let v = byFont.get(text);
  if (v === undefined) {
    mctx ||= document.createElement("canvas").getContext("2d");
    mctx.font = font;
    v = mctx.measureText(text).width;
    byFont.set(text, v);
  }
  return v;
}

/**
 * The chart's fonts from the tokens (--font-sans, --font-mono, --text-chart, --text-axis, --text-micro),
 * read once and again after web fonts load. Pass to layoutFan as opts.fonts.
 * @returns {{ sans: string, mono: string, chart: number, axis: number, micro: number }}
 */
export function chartFonts() {
  return (fonts ||= {
    sans: token("--font-sans") || "Inter, system-ui, sans-serif",
    mono: token("--font-mono") || "ui-monospace, monospace",
    chart: tokenNum("--text-chart", 11.5),
    axis: tokenNum("--text-axis", 10.5),
    micro: tokenNum("--text-micro", 11),
  });
}

/* ---------------- painting ---------------- */

/**
 * Paints the scene: sizes the canvas's backing store to the scene at `dpr`, then draws every mark.
 * @param {HTMLCanvasElement} canvas
 * @param {object} scene from layoutFan
 * @param {{ dpr?: number }} [o] device pixel ratio (default window.devicePixelRatio)
 */
export function drawFan(canvas, scene, { dpr = globalThis.devicePixelRatio || 1 } = {}) {
  const S = scene, { w, h, ay } = S;
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.lineJoin = "round"; ctx.lineCap = "butt";
  const surface = cssColor("var(--surface-paper)");
  const ink1 = cssColor("var(--ink-primary)"), ink3 = cssColor("var(--ink-tertiary)");
  ctx.fillStyle = surface; ctx.fillRect(0, 0, w, h);

  const path = (p) => { ctx.beginPath(); if (p.length < 2) return; ctx.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]); };
  const stroke = (c, width, alpha = 1) => { ctx.strokeStyle = c; ctx.lineWidth = width; ctx.globalAlpha = alpha; ctx.stroke(); ctx.globalAlpha = 1; };
  const circle = (cx, cy, r) => { ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); };
  const text = (str, tx, ty, fnt, fill, align = "left") => { ctx.font = fnt; ctx.textAlign = align; ctx.fillStyle = fill; ctx.fillText(str, tx, ty); };
  const hline = (yy, x0, x1) => { ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); };
  const vline = (xx, y0, y1) => { ctx.beginPath(); ctx.moveTo(xx, y0); ctx.lineTo(xx, y1); };
  const F_LABEL = S.fonts.label, F_AXIS = S.fonts.axis;
  const series = tokenNum("--stroke-series", 1.75), edge = tokenNum("--stroke-edge", 0.75), observedW = tokenNum("--stroke-observed", 1.5);

  // grid and its labels
  const hair = cssColor("var(--line-hairline)"), hairW = tokenNum("--stroke-hairline", 1);
  for (const d of S.ticks) { hline(d.y, 0, w); stroke(hair, hairW); }
  ctx.textBaseline = "alphabetic";
  for (const d of S.ticks) if (d.text) text(d.text, S.tickX, d.y - 6, F_AXIS, ink3);
  if (S.shade != null) { ctx.fillStyle = cssColor("var(--shade-forecast, var(--fill-hover))"); ctx.fillRect(S.shade, 0, Math.max(0, w - S.shade), ay); }
  hline(ay, 0, w); stroke(cssColor("var(--line-axis)"), 1);
  for (const d of S.months) text(d.text, d.x, ay + 20, F_LABEL, ink3);
  if (S.dates) {
    const ink2 = cssColor("var(--ink-secondary)");
    const tick = (xx, name, date, align, dx) => {
      vline(xx, ay, ay + 6); stroke(ink3, 1.25);
      text(name, xx + dx, ay + 20, F_LABEL, ink3, align);
      text(date, xx + dx, ay + 34, F_LABEL, ink2, align);
    };
    tick(S.dates.cut.x, "Data cutoff", S.dates.cut.date, "right", 2);
    tick(S.dates.ref.x, "Reference date", S.dates.ref.date, "left", -2);
  }

  // everything inside the plot is clipped at the x-axis
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, ay); ctx.clip();
  const whisper = tokenNum("--band-whisper", 0.075), focusA = tokenNum("--band-focus", 0.15);
  for (const b of S.bands) {
    const c = cssColor(b.c);
    if (b.fill) {
      path(b.lo);
      for (let i = b.hi.length - 2; i >= 0; i -= 2) ctx.lineTo(b.hi[i], b.hi[i + 1]);
      ctx.closePath(); ctx.fillStyle = c; ctx.globalAlpha = b.fill === "focus" ? focusA : whisper; ctx.fill(); ctx.globalAlpha = 1;
    }
    path(b.lo); stroke(c, edge, b.edgeAlpha); path(b.hi); stroke(c, edge, b.edgeAlpha);
  }
  if (S.hoverX != null) { vline(S.hoverX, 0, ay); stroke(cssColor("var(--ink-faint)"), 1); }
  const hotId = S.hot?.id;
  for (const c of S.context) if (c.id !== hotId) { path(c.line); stroke(ink3, series, S.contextAlpha); }
  // observed: the dotted line clipped to after the cutoff, then the solid part, then the points
  const xc = S.x(S.cutoff);
  if (S.observed.all.length) {
    ctx.save(); ctx.beginPath(); ctx.rect(xc, 0, Math.max(0, w - xc), ay); ctx.clip();
    ctx.setLineDash([0, 4.5]); ctx.lineCap = "round";
    for (const p of S.observed.all) { path(p); stroke(ink1, 1.75); }
    ctx.setLineDash([]); ctx.lineCap = "butt"; ctx.restore();
  }
  for (const p of S.observed.known) { path(p); stroke(ink1, observedW); }
  for (const p of S.observed.points) {
    ctx.globalAlpha = p.alpha;
    circle(p.x, p.y, 2.9); ctx.fillStyle = surface; ctx.fill(); ctx.strokeStyle = ink1; ctx.lineWidth = 1.5; ctx.stroke();
    if (p.fill > 0) { circle(p.x, p.y, 3.65); ctx.fillStyle = ink1; ctx.globalAlpha = p.alpha * p.fill; ctx.fill(); }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  if (S.misses) { const c = cssColor(S.misses.c); for (const d of S.misses.list) { circle(d.x, d.y, 6); stroke(c, 1.25, S.misses.alpha); } }
  for (const b of S.medians) {
    const c = cssColor(b.c);
    path(b.line); stroke(c, series, b.alpha);
    ctx.globalAlpha = b.alpha;
    for (let i = 0; i < b.dots.length; i += 2) { circle(b.dots[i], b.dots[i + 1], 2.9); ctx.fillStyle = c; ctx.fill(); ctx.strokeStyle = surface; ctx.lineWidth = 1.75; ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  if (S.hot) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, ay); ctx.clip(); path(S.hot.line); stroke(ink1, 2); ctx.restore(); }
  if (S.rulers) {
    const R = S.rulers;
    ctx.save(); ctx.translate(R.shift, 0); ctx.globalAlpha = R.k;
    text(R.label, R.labelX, ay + 20, F_LABEL, ink3);
    ctx.beginPath(); ctx.rect(-R.shift, 0, w, ay); ctx.clip();
    ctx.lineCap = "round";
    for (const r of R.rows) {
      const a = R.k * r.alpha;
      ctx.strokeStyle = cssColor(r.c);
      vline(r.x, r.lo, r.hi); ctx.lineWidth = 2; ctx.globalAlpha = a * 0.75; ctx.stroke();
      ctx.globalAlpha = a; ctx.lineWidth = 1.75;
      hline(r.lo, r.x - 3.5, r.x + 3.5); ctx.stroke();
      hline(r.hi, r.x - 3.5, r.x + 3.5); ctx.stroke();
      circle(r.x, r.med, 2.6); ctx.fillStyle = surface; ctx.fill(); ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.lineCap = "butt"; ctx.restore();
  }
  // labels: dot, then the name with a surface-colored halo
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left"; ctx.lineJoin = "round";
  for (const d of S.labels) {
    if (d.dotR > 0) { circle(d.x, d.y, d.dotR); ctx.fillStyle = cssColor(d.dotC); ctx.globalAlpha = d.dotAlpha; ctx.fill(); ctx.globalAlpha = 1; }
    ctx.font = d.font; const by = d.y + 0.34 * d.size;
    ctx.strokeStyle = surface; ctx.lineWidth = 4; ctx.strokeText(d.text, d.x + 10, by);
    ctx.fillStyle = cssColor(d.fill); ctx.fillText(d.text, d.x + 10, by);
  }
}
