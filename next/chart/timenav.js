/* Time navigation for charts over weekly forecast dates: which date is shown, and how much time is on
 * screen. Every behaviour is agreed in design/studies/time-navigation.md; this is design/lib/time.js
 * with UTC ms instead of Dates, a lib/scale.js scale instead of d3, and no key handling of its own (the
 * app binds ← → = - 0 to step(), zoomIn(), zoomOut(), reset()).
 *
 * Two continuous quantities, both animated on critically damped springs:
 *  - T: the forecast date as a fractional index into `dates`. The chart is drawn at T and interpolates
 *    between weeks.
 *  - E: the span on screen, in weeks, one continuous zoom from minSpan to the whole season (a hard stop).
 *    Up to maxSpan the camera follows the date: the reference date stays at the same place, with
 *    forecastWeeks to its right. From maxSpan to the full season the camera gradually stops following
 *    (`follow` goes 1 → 0, log space, smoothstep) until, at the full season, it stands still and the
 *    forecast moves across it like a playhead. Any span can be left at rest; there are no modes.
 *
 * Inputs (all 1:1 while the gesture is held; springs only for settling and for discrete steps):
 *  - drag: moves whatever the camera moves more. While it mostly follows the date, the content: drag right
 *    for earlier, exactly 1:1 close up. Once it mostly stands still (zoomed far out), the forecast: drag
 *    right for later, with the fan under the pointer. A tap there jumps to the week tapped.
 *  - side scroll (trackpad, shift + wheel): scrubs T, same as drag.
 *  - pinch (trackpad, Safari gestures), ⌘ + vertical wheel, zoomIn() / zoomOut() / reset(): zoom. Zoom
 *    pivots on the forecast, never the cursor (when panned, on the middle of the view).
 *  - ⌘ + side scroll, or ⌘ + drag: pan the view without moving the forecast (P, weeks of camera offset),
 *    within the season, rubber-banding at its ends.
 *  - The pan is kept: while the reference date is on screen, scrubbing and stepping change the date
 *    around it, and its line stays exactly where it was left. While it is off-screen, plain side scroll
 *    and drag pan too (as if ⌘ were held) until the view is back at its home position (where the
 *    recenter pill would put it), the same point from either side; from there the same gesture scrubs.
 *    step() with the forecast off-screen brings it back to its home position; so do zooming fully out,
 *    double-click and reset().
 *  - shift + scroll (up to stretch, down to shrink) or shift + vertical drag: height zoom H, independent
 *    of everything above. Zero stays on the axis; 1/3× to ~6.7×, rubber-banding at both ends; reset()
 *    resets it.
 *  - double-click: zoom fully out to the season; when fully out, zoom back in on the date you clicked.
 *    Either way, height returns to normal.
 * Past the first and last date, and below minSpan, the gesture rubber-bands and springs back.
 *  - Crossing seasons by scroll or drag: a pull, not a flick. A gesture that reaches the season's end
 *    stops there (rubber band). A new gesture that starts at the end and stretches the rubber band past
 *    CROSS weeks of pull crosses into the neighbouring season when it is released (onCross); `pull`
 *    (−1…1+, signed) is how far along that pull is, for the page's hint. Pans, zooms, height zooms and
 *    double-click never cross; nor does a gesture that started away from the edge, so a flick to the
 *    latest week can't overshoot into the next season. */
export const CROSS = 1.6;
import { WEEK } from "../lib/scale.js";

/**
 * Resistance that tops out at 1/k: how far a rubber band moves for an overshoot d.
 * @param {number} d ≥ 0 @param {number} [k=0.6] @returns {number}
 */
export const rubber = (d, k = 0.6) => (1 - 1 / (d * k + 1)) / k;
/**
 * The inverse of rubber(): the overshoot that a rubber-banded distance r stands for.
 * @param {number} r ≥ 0 @param {number} [k=0.6] @returns {number}
 */
export const unrubber = (r, k = 0.6) => (1 / (1 - Math.min(r * k, 0.999)) - 1) / k;

/**
 * One exact step of a critically damped spring (no overshoot from rest).
 * @param {number} x position @param {number} v velocity @param {number} target
 * @param {number} w natural frequency (1/s) @param {number} dt seconds
 * @returns {[number, number]} the new [x, v]
 */
export function springStep(x, v, target, w, dt) {
  const y0 = x - target, e = Math.exp(-w * dt), c = v + w * y0;
  return [target + (y0 + c * dt) * e, (v - w * c * dt) * e];
}

/**
 * How far toward the full season a span is: 0 up to maxSpan, 1 at the full season (log space).
 * @param {number} E span, weeks @param {number} maxSpan @param {number} seasonSpan @returns {number} 0–1
 */
export function mixAt(E, maxSpan, seasonSpan) {
  // a season shorter than maxSpan (one that has barely begun) fades over its last third instead, so the
  // camera still follows the date at the home span
  const a = Math.log(Math.min(maxSpan, seasonSpan / 1.5)), b = Math.log(seasonSpan);
  return Math.max(0, Math.min(1, (Math.log(E) - a) / (b - a)));
}
/**
 * How much the camera follows the date at span E: 1 up to maxSpan, easing (smoothstep) to 0 at the
 * full season.
 * @param {number} E @param {number} maxSpan @param {number} seasonSpan @returns {number} 0–1
 */
export function followAt(E, maxSpan, seasonSpan) { const u = mixAt(E, maxSpan, seasonSpan); return 1 - u * u * (3 - 2 * u); }

/**
 * The camera's centre without pan: it follows the date, keeping the reference date where it sits at
 * that span (from maxSpan on, where it sits at maxSpan), fading toward the season's centre as `follow`
 * goes to 0, and kept inside the season.
 * @param {{ span: number, ref: number, season: [number, number], maxSpan: number, forecastWeeks: number }} o
 * @returns {number} ms
 */
export function cameraCentre({ span: E, ref, season, maxSpan, forecastWeeks: fw }) {
  const W = WEEK, s0 = season[0], s1 = season[1];
  const lead = Math.min(E, maxSpan), frac = (lead - fw) / lead; // the reference date's place across the view
  const cF = ref + (0.5 - frac) * E * W, cS = (s0 + s1) / 2;
  const c = cF + (cS - cF) * (1 - followAt(E, maxSpan, (s1 - s0) / W)), half = (E * W) / 2;
  return E * W >= s1 - s0 ? cS : Math.max(s0 + half, Math.min(s1 - half, c));
}

/**
 * The view: exactly `span` weeks wide around the camera centre, plus the pan (weeks, unclamped so a pan
 * past the season's ends can rubber-band).
 * @param {{ span: number, ref: number, season: [number, number], maxSpan: number, forecastWeeks: number, pan?: number }} o
 * @returns {[number, number]} the domain, ms
 */
export function camera(o) {
  const c = cameraCentre(o) + (o.pan || 0) * WEEK, half = (o.span * WEEK) / 2;
  return [c - half, c + half];
}

let reducedMq = null;
const reduced = () => (reducedMq ||= globalThis.matchMedia?.("(prefers-reduced-motion: reduce)"))?.matches ?? false;

export class TimeNav {
  /**
   * @param {object} o
   * @param {HTMLElement} o.surface element for drag, wheel and double-click
   * @param {number[]} o.dates weekly, ascending, ms
   * @param {number} o.index the starting week
   * @param {[number, number]} o.season extent of the full-season view, ms
   * @param {() => ReturnType<import("../lib/scale.js").linear>} o.scale the chart's current x scale (ms → px)
   * @param {number} [o.forecastWeeks=3] @param {number} [o.span=11] home span @param {number} [o.minSpan=6] @param {number} [o.maxSpan=20]
   * @param {(e: PointerEvent) => boolean} [o.ignore] targets that handle their own pointer entirely (labels)
   * @param {(e: PointerEvent) => boolean} [o.tapTarget] a tap (no movement) the page handles (a line); drags there still scrub and pan
   * @param {(e: WheelEvent) => boolean} [o.passWheel] wheel events left alone (floating layers over the chart)
   * @param {() => void} [o.onFrame] redraw
   * @param {(i: number) => void} [o.onWeek] the week T is heading to changed
   * @param {(mode: "close" | "season") => void} [o.onZoom]
   * @param {(d: number) => boolean} [o.onEdge] step() past either end: return true if it took over (crossed seasons)
   * @param {(d: -1 | 1) => boolean} [o.canCross] there is a season to cross into that way
   * @param {(d: -1 | 1) => void} [o.onCross] a pull past either end was released past CROSS
   */
  constructor(o) {
    Object.assign(this, {
      forecastWeeks: 3, minSpan: 6, maxSpan: 20, ignore: () => false, onWeek() {}, onZoom() {}, onFrame() {},
      passWheel: (e) => !!e.target.closest?.(".c-float"),
    }, o);
    this.N = this.dates.length;
    this.seasonSpan = (this.season[1] - this.season[0]) / WEEK;
    this.home = o.span ?? 11;
    this.T = this.tT = this.index; this.vT = 0; this.wT = 38;
    this.Z = this.tZ = Math.log(this.home); this.vZ = 0; this.wZ = 30;
    this.P = this.tP = 0; this.vP = 0; this.wP = 30;          // camera offset from the forecast, in weeks
    this.H = this.tH = 0; this.vH = 0; this.wH = 30;          // height zoom, log scale (0 = normal)
    this.busy = false; this.raf = 0; this.queued = 0; this.mode = "close";
    this.pull = 0; this.edgeStart = 0;                          // a pull across the season's end (see CROSS)
    this.#abort = new AbortController();
    this.#bind();
  }

  #abort;

  /* ---- what the chart needs ---- */
  /** the week T is heading to (an index into dates) */
  get week() { return this.tT; }
  /** the reference date at T, ms (fractional between weeks) */
  get ref() { return this.dates[0] + this.T * WEEK; }
  /** the span on screen, weeks */
  get span() { return Math.exp(this.Z); }
  /** how far toward the full season the zoom is: 0 up to maxSpan, 1 at the full season (log space) */
  get mix() { return mixAt(this.span, this.maxSpan, this.seasonSpan); }
  /** how much the camera follows the date: 1 up to maxSpan, easing to 0 at the full season */
  get follow() { return followAt(this.span, this.maxSpan, this.seasonSpan); }

  #c0(E = this.span, ref = this.ref) {
    return cameraCentre({ span: E, ref, season: this.season, maxSpan: this.maxSpan, forecastWeeks: this.forecastWeeks });
  }
  /** @returns {[number, number]} the view's domain now, ms */
  domain() {
    const c = this.#c0() + this.P * WEEK, half = (this.span * WEEK) / 2;
    return [c - half, c + half];
  }

  /* ---- commands ---- */
  /** Glide to week i. recenter: true, false, or "auto" (when the forecast is off-screen). */
  goTo(i, { w = 38, v = null, recenter = "auto" } = {}) {
    i = Math.max(0, Math.min(this.N - 1, Math.round(i)));
    if (recenter === true || (recenter === "auto" && !this.refVisible())) { this.tP = 0; this.returning = false; }
    if (i !== this.tT) { this.tT = i; this.onWeek(i); }
    this.wT = w; if (v != null) this.vT = v;
    this.#run();
  }
  /** ← → and the stepper. Past the first or last date, onEdge(d) may take over (crossing into another
   * season); if it does, nothing else happens here. Drag and side scroll never call it: they rubber-band. */
  step(d) { const i = this.tT + d; if ((i < 0 || i >= this.N) && this.onEdge?.(d)) return; this.goTo(i); }

  /** Swap the whole timeline (another season): new dates and season window, the date set to index at once
   * (a cut, not a glide). Zoom carries over (clamped to the new season); pan carries over if it fits. */
  setTimeline({ dates, season, index }) {
    this.dates = dates; this.N = dates.length; this.season = season; this.pull = 0; this.edgeStart = 0;
    this.seasonSpan = (season[1] - season[0]) / WEEK;
    this.T = this.tT = Math.max(0, Math.min(this.N - 1, index)); this.vT = 0;
    const zmax = Math.log(this.seasonSpan);
    this.Z = Math.min(this.Z, zmax); this.tZ = Math.min(this.tZ, zmax); this.vZ = 0;
    const [lo, hi] = this.panRange(Math.exp(this.tZ));
    if (!(this.tP >= lo && this.tP <= hi)) { this.P = this.tP = 0; this.returning = false; }
    this.vP = 0;
    this.onWeek(this.tT);
    this.request();
  }
  /** Zoom to a span of E weeks (clamped to minSpan … the season). */
  zoomTo(E, { w = 30, recenter = false } = {}) {
    const mid = this.#c0() + this.tP * WEEK;                    // where the view's middle is heading
    this.tZ = Math.log(Math.max(this.minSpan, Math.min(this.seasonSpan, E))); this.wZ = w;
    if (recenter || this.tZ >= Math.log(this.seasonSpan) - 1e-6) { this.tP = 0; this.returning = false; }
    else if (Math.abs(this.tP) > 1e-3) {                         // panned: keep the middle still, within the season
      const [p0, p1] = this.panRange(Math.exp(this.tZ));
      this.tP = Math.max(p0, Math.min(p1, (mid - this.#c0(Math.exp(this.tZ))) / WEEK));
    }
    this.#mode(this.tZ >= Math.log(this.seasonSpan) - 1e-6 ? "season" : "close");
    this.#run();
  }
  /** what `=` did */
  zoomIn() { this.zoomTo(Math.exp(this.tZ) / 1.25); }
  /** what `-` did */
  zoomOut() { this.zoomTo(Math.exp(this.tZ) * 1.25); }
  /** what `0` did: the home span, recentred, normal height */
  reset() { this.zoomTo(this.home, { recenter: true }); this.setHeight(1); }
  /** the view (zoom, pan, height) as a value, to save and later restore exactly (e.g. around a model picker) */
  view() { return { Z: this.tZ, P: this.tP, H: this.tH, returning: this.returning }; }
  setView(v, { w = 26 } = {}) { this.tZ = v.Z; this.tP = v.P; if (v.H != null) { this.tH = v.H; this.wH = w; } this.returning = !!v.returning; this.wZ = this.wP = w; this.#mode(this.tZ >= Math.log(this.seasonSpan) - 1e-6 ? "season" : "close"); this.#run(); }
  /** bring the forecast back to its home position (the recenter pill) */
  recenter() { this.tP = 0; this.wP = 30; this.returning = false; this.#run(); }
  setSeason(on) { this.zoomTo(on ? this.seasonSpan : this.home, { recenter: true }); }
  /** how far the view can pan at span E (weeks) before its edges leave the season */
  panRange(E = this.span) {
    const c0 = this.#c0(E), half = (E * WEEK) / 2;
    const lo = (this.season[0] + half - c0) / WEEK, hi = (this.season[1] - half - c0) / WEEK;
    return [Math.min(lo, 0), Math.max(hi, 0)];
  }
  /** any gesture in progress (the page hides hover while this is true) */
  get moving() { return !!(this.busy || this.panning || this.pinching || this.heightZooming); }
  /** how much taller the data is drawn than normal (1 = normal); divide the y-axis maximum by it */
  get heightZoom() { return Math.exp(this.H); }
  setHeight(z = 1) { this.tH = Math.log(z); this.wH = 30; this.#run(); }
  /** the reference date's x on screen, from the live camera (not the last drawn frame) */
  refX() {
    const [r0, r1] = this.scale().range(), [d0, d1] = this.domain();
    return r0 + ((this.ref - d0) / (d1 - d0)) * (r1 - r0);
  }
  /** "the forecast is on screen": the reference line and its whole fan (forecastWeeks to its right) */
  refVisible(margin = 24) {
    const x = this.refX(), fan = this.forecastWeeks * this.#pxPerWeek();
    return x >= margin && x + fan <= this.surface.clientWidth - margin;
  }
  /** one onFrame() on the next animation frame */
  request() { if (!this.queued) this.queued = requestAnimationFrame(() => { this.queued = 0; this.onFrame(); }); }
  /** removes every listener and stops every animation and timer */
  destroy() {
    this.#abort.abort();
    cancelAnimationFrame(this.raf); cancelAnimationFrame(this.queued); this.raf = this.queued = 0;
    clearTimeout(this.panIdle); clearTimeout(this.zoomIdle); clearTimeout(this.heightIdle); clearTimeout(this.wheelIdle);
  }

  /* ---- motion ---- */
  #mode(m) { if (m !== this.mode) { this.mode = m; this.onZoom(m); } }
  #run() {
    if (reduced()) { this.T = this.tT; this.Z = this.tZ; this.P = this.tP; this.H = this.tH; this.vT = this.vZ = this.vP = this.vH = 0; this.request(); return; }
    if (this.raf) return;                                        // the running loop picks up new targets
    let last = performance.now();
    const tick = () => {
      const now = performance.now(), dt = Math.min(0.033, Math.max(0.001, (now - last) / 1000)); last = now;
      if (!this.busy) [this.T, this.vT] = springStep(this.T, this.vT, this.tT, this.wT, dt);
      if (!this.pinching) [this.Z, this.vZ] = springStep(this.Z, this.vZ, this.tZ, this.wZ, dt);
      if (!this.panning) [this.P, this.vP] = springStep(this.P, this.vP, this.tP, this.wP, dt);
      if (!this.heightZooming) [this.H, this.vH] = springStep(this.H, this.vH, this.tH, this.wH, dt);
      const doneT = this.busy || (Math.abs(this.T - this.tT) < 5e-4 && Math.abs(this.vT) < 0.01);
      const doneZ = this.pinching || (Math.abs(this.Z - this.tZ) < 5e-4 && Math.abs(this.vZ) < 0.01);
      if (doneT && !this.busy) { this.T = this.tT; this.vT = 0; }
      if (doneZ && !this.pinching) { this.Z = this.tZ; this.vZ = 0; }
      const doneP = this.panning || (Math.abs(this.P - this.tP) < 5e-4 && Math.abs(this.vP) < 0.01);
      if (doneP && !this.panning) { this.P = this.tP; this.vP = 0; }
      this.onFrame();
      const doneH = this.heightZooming || (Math.abs(this.H - this.tH) < 5e-4 && Math.abs(this.vH) < 0.01);
      if (doneH && !this.heightZooming) { this.H = this.tH; this.vH = 0; }
      this.raf = doneT && doneZ && doneP && doneH ? 0 : requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  #stop() { cancelAnimationFrame(this.raf); this.raf = 0; }
  #clampT(T) { const n = this.N - 1; return T < 0 ? -rubber(-T) : T > n ? n + rubber(T - n) : T; }
  #rawT(T) { const n = this.N - 1; return T < 0 ? -unrubber(-T) : T > n ? n + unrubber(T - n) : T; }
  #pxPerWeek() { const [r0, r1] = this.scale().range(), [d0, d1] = this.domain(); return (r1 - r0) / ((d1 - d0) / WEEK); }
  /* Pixels of side scroll per week of date change. Close up at the home span this is 1:1 with the content.
   * Zoomed out, weeks get narrow and 1:1 would fly through dates (in Season ~4 weeks per small flick), so
   * the rate never drops below 3/4 of the home span's: wide zooms scrub a little slower than the content
   * moves, and Season scrubs at close to the home pace. Panning stays 1:1. */
  #scrubPx() {
    const [r0, r1] = this.scale().range();
    return Math.max(this.#pxPerWeek(), (0.75 * (r1 - r0)) / this.home);
  }
  /* a scroll or drag moved the content by a weeks: scrub the date if the forecast is on screen, else pan */
  #advance(a, { grab = false } = {}) { // grab: a is already weeks of date (a pointer drag sets its own rate)
    const k = grab ? 1 : this.#pxPerWeek() / this.#scrubPx();
    const scrub = (d) => { this.#stop(); this.vT = 0; this.busy = true; this.#setT(this.#clampT(this.#rawT(this.T) + d * k)); return "scrub"; };
    // Forecast off-screen: plain scroll and drag pan instead, and keep panning ("returning") until the
    // view is back at its home position, exactly where the recenter pill would put it. Only then does
    // the rest of the gesture scrub. Measuring "home" (P = 0) rather than "visible" makes the hand-off
    // happen at the same place whether you come back from the left or the right.
    if (!this.returning && !this.refVisible()) this.returning = true;
    if (!this.returning) return scrub(a);
    const P = this.P, next = P + a;
    if (P === 0 || next === 0 || (P < 0) !== (next < 0)) {   // this step reaches home
      clearTimeout(this.panIdle); this.panning = false; this.P = this.tP = 0; this.vP = 0; this.returning = false;
      return next ? scrub(next) : "pan";                      // whatever is left over moves the date
    }
    this.#panBy(a); return "pan";
  }
  #placeAt(clientX) { // Season: the date under the pointer
    const x = this.scale(), px = clientX - this.surface.getBoundingClientRect().left;
    return Math.max(0, Math.min(this.N - 1, (x.invert(px) - this.dates[0]) / WEEK));
  }
  #setT(T) {
    this.T = T; const i = Math.max(0, Math.min(this.N - 1, Math.round(T))); if (i !== this.tT) { this.tT = i; this.onWeek(i); }
    // how far a pull that began at the season's end has stretched past it (signed, 1 = enough to cross)
    const r = this.#rawT(T), over = r < 0 ? r : r > this.N - 1 ? r - (this.N - 1) : 0;
    this.pull = this.edgeStart && Math.sign(over) === this.edgeStart && this.canCross?.(this.edgeStart) ? over / CROSS : 0;
    this.request();
  }
  /* -1 / 1 when the chart rests at (or is springing back to) the first / last week, else 0: where a
   * gesture must start to be able to cross. */
  #edgeAt() {
    if (this.tT === this.N - 1 && this.T >= this.N - 1.05) return 1;
    if (this.tT === 0 && this.T <= 0.05) return -1;
    return 0;
  }
  #settleT(v = 0, w = 26) {
    this.busy = false;
    const d = Math.abs(this.pull) >= 1 ? Math.sign(this.pull) : 0;
    this.pull = 0; this.edgeStart = 0;
    this.goTo(Math.round(this.T + v * 0.12), { w, v, recenter: false });
    if (d) this.onCross?.(d);
  }
  #settleZ() {
    this.pinching = false;
    const z = this.Z, b = Math.log(this.seasonSpan), lo = Math.log(this.minSpan);
    const target = Math.max(lo, Math.min(b, z)); // any span can rest; below the minimum it springs back
    this.tZ = target; this.wZ = 26;
    if (target >= b - 1e-6) this.tP = 0;
    else { const [p0, p1] = this.panRange(Math.exp(target)); this.tP = Math.max(p0, Math.min(p1, this.tP)); }
    this.#mode(target >= b - 1e-6 ? "season" : "close");
    this.#run();
  }
  #zoomBy(f) { // 1:1 zoom from a gesture, rubber-banding below minSpan
    this.#stop(); this.pinching = true; this.vZ = 0;
    const lo = Math.log(this.minSpan), b = Math.log(this.seasonSpan);
    const raw = (this.Z < lo ? lo - unrubber(lo - this.Z, 4) : this.Z) + Math.log(f);
    const mid = this.#c0() + this.P * WEEK;
    this.Z = raw < lo ? lo - rubber(lo - raw, 4) : Math.min(raw, b);
    if (Math.abs(this.P) > 1e-3) { this.P = this.tP = (mid - this.#c0()) / WEEK; } // panned: keep the middle still
    this.request();
    clearTimeout(this.zoomIdle); this.zoomIdle = setTimeout(() => this.#settleZ(), 160);
  }

  #panBy(weeks) { // 1:1 pan from ⌘ + side scroll, rubber-banding at the season's ends
    this.#stop(); this.panning = true; this.vP = 0;
    const [p0, p1] = this.panRange();
    const raw = (this.P < p0 ? p0 - unrubber(p0 - this.P) : this.P > p1 ? p1 + unrubber(this.P - p1) : this.P) + weeks;
    this.P = this.tP = raw < p0 ? p0 - rubber(p0 - raw) : raw > p1 ? p1 + rubber(raw - p1) : raw;
    this.request();
    clearTimeout(this.panIdle);
    this.panIdle = setTimeout(() => { this.panning = false; this.tP = Math.max(p0, Math.min(p1, this.P)); this.wP = 26; this.#run(); }, 140);
  }

  #zoomHeight(f) { // 1:1 height zoom from a gesture, rubber-banding at both ends
    this.#stop(); this.heightZooming = true; this.vH = 0;
    const lo = Math.log(1 / 3), hi = Math.log(1 / 0.15);
    const raw = (this.H < lo ? lo - unrubber(lo - this.H, 4) : this.H > hi ? hi + unrubber(this.H - hi, 4) : this.H) + Math.log(f);
    this.H = this.tH = raw < lo ? lo - rubber(lo - raw, 4) : raw > hi ? hi + rubber(raw - hi, 4) : raw;
    this.request();
    clearTimeout(this.heightIdle);
    this.heightIdle = setTimeout(() => { this.heightZooming = false; this.tH = Math.max(lo, Math.min(hi, this.H)); this.wH = 26; this.#run(); }, 160);
  }

  /* ---- inputs ---- */
  #bind() {
    const el = this.surface, opt = { signal: this.#abort.signal };
    let drag = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this.ignore(e) || this.pinching) return;
      const fan = this.follow < 0.5;                            // zoomed far out: the drag moves the forecast
      this.#stop(); this.vT = 0;
      // ⌘ + drag pans, exactly like ⌘ + side scroll: the view moves, the forecast stays on its date
      // shift + drag zooms height (up to stretch), independent of the date and the time view
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastY: e.clientY, fan, pan: e.metaKey, height: e.shiftKey && !e.metaKey, moved: false, scrubbed: false, hist: [{ t: e.timeStamp, T: this.T }] };
      if (drag.pan) this.returning = false;
      this.edgeStart = drag.pan || drag.height ? 0 : this.#edgeAt();
    }, opt);
    el.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
      if (!drag.moved) { drag.moved = true; try { el.setPointerCapture(e.pointerId); } catch {} el.style.cursor = "grabbing"; }
      if (drag.height) { this.#zoomHeight(Math.exp(-(e.clientY - drag.lastY) * 0.006)); drag.lastY = e.clientY; return; }
      const dx = e.clientX - drag.lastX, pxw = this.#pxPerWeek(), f = this.follow;
      if (drag.pan) this.#panBy(-dx / pxw);                    // the content follows the pointer, 1:1
      else if (drag.fan) {                                           // the fan follows the pointer: drag right = later
        this.busy = true; drag.scrubbed = true;
        this.#setT(this.#clampT(this.#rawT(this.T) + dx / Math.max(1, pxw * (1 - f))));
      } else {                                                  // the content follows the pointer: drag right = earlier
        const per = f > 0.999 ? pxw : Math.max(pxw * f, this.#scrubPx() * 0.5);
        if (this.#advance(-dx / per, { grab: true }) === "scrub") drag.scrubbed = true;
      }
      drag.lastX = e.clientX;
      drag.hist.push({ t: e.timeStamp, T: this.T }); if (drag.hist.length > 6) drag.hist.shift();
    }, opt);
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null; el.style.cursor = "";
      if (!d.moved) {                                           // a tap
        if (this.tapTarget?.(e)) { this.#run(); return; }        // the page handles taps on its own targets (lines)
        if (d.fan && e.type === "pointerup") { this.busy = false; this.goTo(this.#placeAt(e.clientX), { w: 30 }); }
        else this.#run();                                       // resume anything the press interrupted
        return;
      }
      if (!d.scrubbed) return;                                  // it only panned: the pan settles itself
      const a = d.hist[0], z = d.hist.at(-1), dt = Math.max(1, z.t - a.t);
      // a flick only if the pointer was still moving when released (no pause before letting go)
      const still = e.timeStamp - z.t > 60;
      const v = !still && z.t - a.t < 120 ? ((z.T - a.T) / dt) * 1000 : 0; // weeks per second
      this.#settleT(d.fan ? 0 : v);
    };
    el.addEventListener("pointerup", end, opt);
    el.addEventListener("pointercancel", end, opt);

    el.addEventListener("wheel", (e) => {
      if (this.passWheel(e)) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
      if (e.shiftKey && !e.metaKey && !e.ctrlKey) {               // shift + scroll: height zoom only
        e.preventDefault();
        const d = Math.max(-25, Math.min(25, (e.deltaY || e.deltaX) * unit));
        this.#zoomHeight(Math.exp(-d * 0.01));                   // scroll up (negative) stretches
        return;
      }
      if (e.metaKey && !e.ctrlKey && Math.abs(e.deltaX || (e.shiftKey ? e.deltaY : 0)) > Math.abs(e.shiftKey ? 0 : e.deltaY)) {
        e.preventDefault();                                      // ⌘ + side scroll: pan, the forecast stays put
        this.returning = false;                                  // a deliberate pan sets a new resting place
        const dx = (e.deltaX || e.deltaY) * unit;
        this.#panBy(dx / this.#pxPerWeek());
        return;
      }
      if (e.ctrlKey || e.metaKey) {                              // pinch (arrives as ctrl + wheel), or ⌘ + wheel
        e.preventDefault();
        const d = Math.max(-25, Math.min(25, e.deltaY * unit)); // a mouse wheel notch is ~100; a pinch is ~1-10
        this.#zoomBy(Math.exp(d * 0.012));
        return;
      }
      const dx = e.deltaX;
      if (!dx || Math.abs(dx) < Math.abs(e.deltaY) || drag || this.pinching) return;
      e.preventDefault();
      /* Snap without waiting out the trackpad's coast. After the fingers lift, macOS keeps sending a
       * decaying tail of tiny deltas for up to a second; waiting for it to end (plus an idle timeout)
       * read as a pause. When the deltas have shrunk for several events in a row and are now tiny, snap
       * right away with the remaining speed, and swallow the rest of the tail so it can't nudge the
       * chart after it lands. A delta that grows again, changes direction, or comes after a gap is a
       * new gesture. */
      const now = e.timeStamp, mag = Math.abs(dx * unit), sign = Math.sign(dx);
      const W = (this.wheelState ||= { hist: [], tail: null });
      if (W.tail) {
        const fresh = now - W.tail.t > 120 || sign !== W.tail.sign || mag > W.tail.mag * 1.3 + 0.5;
        if (!fresh) { W.tail.t = now; W.tail.mag = mag; return; }   // the coast after a snap: ignore
        W.tail = null; W.hist = [];
      }
      if (W.hist.length && (now - W.hist.at(-1).t > 120 || sign !== W.hist.at(-1).sign)) W.hist = [];
      if (!W.hist.length) this.edgeStart = this.#edgeAt();     // a new gesture: may it cross?
      W.hist.push({ t: now, mag, sign, T: this.T }); if (W.hist.length > 8) W.hist.shift();
      const did = this.#advance((dx * unit) / this.#pxPerWeek());
      if (did !== "scrub") return;
      clearTimeout(this.wheelIdle);
      const h = W.hist, n = h.length;
      const decaying = n >= 6 && h.slice(-6).every((p, i, a) => i === 0 || p.mag <= a[i - 1].mag) && mag < 3;
      if (decaying) {
        const a = h[n - 4], dt = Math.max(1, now - a.t), v = ((this.T - a.T) / dt) * 1000; // weeks per second
        W.tail = { t: now, mag, sign }; W.hist = [];
        this.#settleT(v);
      } else this.wheelIdle = setTimeout(() => { W.hist = []; this.#settleT(0); }, 80);
    }, { passive: false, signal: this.#abort.signal });

    // Safari sends pinches as gesture events
    let g0 = 0;
    el.addEventListener("gesturestart", (e) => { e.preventDefault(); g0 = 1; }, opt);
    el.addEventListener("gesturechange", (e) => { e.preventDefault(); this.#zoomBy(g0 / e.scale); g0 = e.scale; }, opt);
    el.addEventListener("gestureend", (e) => { e.preventDefault(); }, opt);

    el.addEventListener("dblclick", (e) => {
      if (this.ignore(e)) return;
      const full = this.tZ >= Math.log(this.seasonSpan) - 1e-3;
      this.zoomTo(full ? this.home : this.seasonSpan, { recenter: true });
      this.setHeight(1); // both directions land at normal height
    }, opt);
  }
}
