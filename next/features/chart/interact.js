/* Pointer and keyboard interaction with what is drawn on the chart:
 *  - the hovered week: the timeline week nearest the pointer, but only while the pointer is near
 *    something drawn there (the observed line, a band, a median, a grey line, a layer line, a label):
 *    empty paper shows nothing;
 *  - hovering a charted model's label or median line previews focus; a grey (context) line is lifted and
 *    named; clicking focuses (a grey model is charted first); a press that moved more than 4 px is never a
 *    click; the cursor is a pointer only over a target;
 *  - everything under a still pointer is re-checked after every frame (track()), so a highlight never
 *    sticks while the chart moves under the pointer and nothing waits for an enter or leave event;
 *  - a visually hidden list of buttons mirrors the charted labels for the keyboard and screen readers. */
import { h, on } from "../../lib/dom.js";
import { WEEK } from "../../lib/scale.js";
import { labelAt, lineUnder } from "../../chart/layout.js";
import { activeLayer } from "../../ui/floating.js";

const CLICK_SLOP = 4;
const NEAR = 22; // px: how close (vertically, at the pointer's x) the pointer must be to a mark to read it

/* y of a flat [x0, y0, x1, y1, …] path (x ascending) at px, or NaN outside it; n = points (for buffers) */
function yAt(p, px, n = p.length / 2) {
  if (n < 2 || px < p[0] || px > p[2 * n - 2]) return NaN;
  for (let i = 1; i < n; i++) {
    const x1 = p[2 * i];
    if (x1 >= px) { const x0 = p[2 * i - 2], u = x1 === x0 ? 0 : (px - x0) / (x1 - x0); return p[2 * i - 1] + (p[2 * i + 1] - p[2 * i - 1]) * u; }
  }
  return NaN;
}
const close = (y, py) => Math.abs(y - py) <= NEAR; // NaN is never close

/* Is the pointer near anything drawn at its x? Bands count from edge to edge (plus the margin). */
export function nearMark(s, px, py) {
  for (const p of s.observed.all) if (close(yAt(p, px), py)) return true;
  for (const b of s.bands) {
    const hi = yAt(b.hi, px), lo = yAt(b.lo, px);
    if (py >= hi - NEAR && py <= lo + NEAR) return true;
  }
  for (const m of s.medians) if (close(yAt(m.line, px), py)) return true;
  for (const c of s.context) if (close(yAt(c.line, px), py)) return true;
  if (s.layers) for (const l of s.layers.lines) if ((l.clipX == null || px <= l.clipX) && close(yAt(l.xy, px, l.n), py)) return true;
  return false;
}

export class Interaction {
  /** @param {import("../FanChart.js").FanChart} chart */
  constructor(chart) {
    this.chart = chart;
    this.mouse = null;     // the pointer over the canvas, client px
    this.down = null;      // where the last press started
    this.hoverT = null;    // the hovered week, ms
    this.preview = null;   // a charted model previewed by hovering its label or line
    this.hot = null;       // a grey model lifted by hovering its line
    this.keyed = null;     // a charted model whose hidden label button has keyboard focus
    this.external = null;  // a charted model previewed from outside the chart (FanChart.hoverModel)
    this.cursor = "";
    this.labelKey = "";
    this.list = h("div", { class: "sr-only", role: "group", "aria-label": "Models on the chart" });
    chart.view.append(this.list);

    const c = chart.canvas;
    this.offs = [
      on(c, "pointermove", (e) => { if (e.pointerType !== "touch") { this.mouse = { x: e.clientX, y: e.clientY }; this.track(); } }),
      on(c, "pointerdown", (e) => { this.down = { x: e.clientX, y: e.clientY }; }),
      on(c, "pointerleave", () => { this.mouse = null; this.track(); }),
      on(c, "click", (e) => this.#click(e)),
      on(this.list, "click", (e) => { const b = e.target.closest("button"); if (b) chart.activate(b.dataset.id, false); }),
      on(this.list, "focusin", (e) => this.#key(e.target.closest("button")?.dataset.id ?? null)),
      on(this.list, "focusout", () => this.#key(null)),
    ];
  }

  /** canvas CSS px for a client point */
  local(cx, cy) { const r = this.chart.rect(); return [cx - r.left, cy - r.top]; }

  /** for TimeNav: a press on a label is a click, never a drag */
  onLabel(e) {
    const s = this.chart.scene;
    if (!s) return false;
    const [px, py] = this.local(e.clientX, e.clientY);
    return !!labelAt(s, px, py);
  }

  /** for TimeNav: a tap on a median line is a click on that model, not a jump in time */
  onLine(e) {
    const s = this.chart.scene;
    if (!s) return false;
    const [px, py] = this.local(e.clientX, e.clientY);
    return !!lineUnder(s, px, py, this.chart.ctx.store.get().focus);
  }

  /* what a still pointer is over: the model (label first, then line) and the week */
  #hit(px, py) {
    const s = this.chart.scene, l = labelAt(s, px, py);
    if (l) return l.id ? { id: l.id, ctx: l.ctx } : null;
    return lineUnder(s, px, py, this.chart.ctx.store.get().focus);
  }

  #snapTime(fan, nav, rawT) {
    if (fan.timeUnit !== "month") {
      const g0 = Number.isFinite(fan.gridOrigin) ? fan.gridOrigin : fan.dates[0];
      return g0 + Math.round((rawT - g0) / WEEK) * WEEK;
    }
    let bestT = NaN, bestDist = 18 * 864e5;
    for (const o of fan.observed) {
      const d = Math.abs(o.t - rawT);
      if (d < bestDist) { bestDist = d; bestT = o.t; }
    }
    for (const m of fan.present) {
      const pts = fan.points(m, nav.week, 0);
      if (!pts) continue;
      for (const p of pts) {
        const d = Math.abs(p.t - rawT);
        if (d < bestDist) { bestDist = d; bestT = p.t; }
      }
    }
    return bestT;
  }

  /**
   * Re-reads everything under the pointer against the last frame; requests a frame when the hovered
   * week, the preview or the lifted grey line changed. Runs on pointer moves and after every frame.
   */
  track() {
    const chart = this.chart, s = chart.scene, nav = chart.nav;
    let t = null, preview = null, hot = null, cursor = "";
    if (this.mouse && s && nav && !nav.moving && !activeLayer()) {
      const [px, py] = this.local(this.mouse.x, this.mouse.y);
      const snapped = this.#snapTime(chart.fan, nav, s.x.invert(px));
      const xw = Number.isFinite(snapped) ? s.x(snapped) : NaN;
      const hit = this.#hit(px, py);
      if (hit) { cursor = "pointer"; if (hit.ctx) hot = hit.id; else preview = hit.id; }
      if (Number.isFinite(xw) && xw >= 0 && xw <= s.w && py <= s.ay && (hit || nearMark(s, px, py))) t = snapped;
    }
    if (cursor !== this.cursor) { this.cursor = cursor; chart.canvas.style.cursor = cursor; }
    if (t !== this.hoverT || preview !== this.preview || hot !== this.hot) {
      this.hoverT = t; this.preview = preview; this.hot = hot;
      chart.request();
    }
  }

  /** forget the preview and the lifted line (after a click acted on them) */
  clear() { this.preview = null; this.hot = null; }

  #click(e) {
    const d = this.down;
    this.down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP || !this.chart.scene) return;
    const [px, py] = this.local(e.clientX, e.clientY);
    const hit = this.#hit(px, py);
    if (hit) this.chart.activate(hit.id, hit.ctx);
  }

  #key(id) {
    if (id === this.keyed) return;
    this.keyed = id;
    this.chart.request();
  }

  /**
   * Rebuilds the hidden label buttons when the charted labels or the focus changed (not per frame).
   * @param {object} scene
   */
  syncLabels(scene) {
    const focus = this.chart.ctx.store.get().focus;
    const ls = scene.labels.filter((d) => d.id && !d.summary && !d.ctx && d.alpha >= 0.5);
    const key = ls.map((d) => `${d.id}|${d.full}|${d.id === focus}`).join("\n");
    if (key === this.labelKey) return;
    this.labelKey = key;
    const had = this.list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    this.list.replaceChildren(...ls.map((d) => h("button", { type: "button", "data-id": d.id, "aria-pressed": String(d.id === focus) }, d.full)));
    if (had) [...this.list.children].find((b) => b.dataset.id === had)?.focus({ preventScroll: true });
  }

  destroy() { this.offs.forEach((off) => off()); this.list.remove(); }
}
