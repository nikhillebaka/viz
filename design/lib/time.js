/* Time navigation for charts over weekly forecast dates: which date is shown, and how much time is on
 * screen. Decisions: studies/time-navigation.md.
 *
 * Two continuous quantities, both animated on critically damped springs:
 *  - T: the forecast date as a fractional index into `dates`. The chart is drawn at T and interpolates
 *    between weeks (fanChart({ t })).
 *  - E: the span on screen, in weeks. Close up, E runs from minSpan to maxSpan and the camera follows the
 *    date: the reference date stays at the same place, with forecastWeeks to its right. Past maxSpan the
 *    camera blends (in log space) to the whole season, where it stands still and the forecast moves
 *    across it like a playhead. Between maxSpan and the season span is only ever passed through: on
 *    release it settles on whichever end is closer.
 *
 * Inputs (all 1:1 while the gesture is held; springs only for settling and for discrete steps):
 *  - drag: close up, scrubs T (one week per week-width; drag right for earlier). In Season, places the date
 *    where the pointer is. A tap in Season jumps there.
 *  - side scroll (trackpad, shift + wheel): scrubs T, same as drag.
 *  - pinch (ctrl/⌘ + wheel, Safari gestures), = / - / 0 keys: zoom. Zoom pivots on the forecast, never the
 *    cursor, so the forecast never leaves the screen.
 *  - double-click: close up → Season; in Season → zoom back in on the date you clicked.
 *  - left / right: step a week (timeKeys).
 * Past the first and last date, and below minSpan, the gesture rubber-bands and springs back. */
import { timeKeys } from "./controls.js";

export const WEEK = 7 * 864e5;
const rubber = (d, k = 0.6) => (1 - 1 / (d * k + 1)) / k;           // resistance that tops out at 1/k
const unrubber = (r, k = 0.6) => (1 / (1 - Math.min(r * k, 0.999)) - 1) / k;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

// one exact step of a critically damped spring; returns [x, v]
function spring(x, v, target, w, dt) {
  const y0 = x - target, e = Math.exp(-w * dt), c = v + w * y0;
  return [target + (y0 + c * dt) * e, (v - w * c * dt) * e];
}

export class TimeNav {
  /* opts:
   *  surface: element for drag, wheel and double-click; dates: Date[] (weekly, ascending); index: start
   *  season: [Date, Date] extent of the Season view; forecastWeeks (3), span (11), minSpan (6), maxSpan (20)
   *  scale(): the chart's current x scale (d3), used to turn pixels into weeks
   *  ignore(event): true for targets that handle their own pointer (e.g. labels)
   *  onFrame(): redraw; onWeek(i): the week T is heading to changed; onZoom(mode): "close" | "season" */
  constructor(o) {
    Object.assign(this, { forecastWeeks: 3, minSpan: 6, maxSpan: 20, ignore: () => false, onWeek() {}, onZoom() {} }, o);
    this.N = this.dates.length;
    this.seasonSpan = (this.season[1] - this.season[0]) / WEEK;
    this.home = o.span ?? 11;
    this.T = this.tT = this.index; this.vT = 0; this.wT = 38;
    this.Z = this.tZ = Math.log(this.home); this.vZ = 0; this.wZ = 30;
    this.busy = false; this.raf = 0; this.queued = 0; this.mode = "close";
    this.#bind();
  }

  /* ---- what the chart needs ---- */
  get week() { return this.tT; }
  get ref() { return new Date(+this.dates[0] + this.T * WEEK); }
  get span() { return Math.exp(this.Z); }
  /* 0 = close up, 1 = Season, in between only while zooming across */
  get mix() {
    const a = Math.log(this.maxSpan), b = Math.log(this.seasonSpan);
    return Math.max(0, Math.min(1, (this.Z - a) / (b - a)));
  }
  domain() {
    const ref = +this.ref, fw = this.forecastWeeks * WEEK;
    const E = Math.min(this.span, this.maxSpan) * WEEK;
    const close = [ref - (E - fw), ref + fw];
    const u = this.mix, s = u * u * (3 - 2 * u);                  // smoothstep: eases in and out of the blend
    return [new Date(close[0] + (this.season[0] - close[0]) * s), new Date(close[1] + (this.season[1] - close[1]) * s)];
  }

  /* ---- commands ---- */
  goTo(i, { w = 38, v = null } = {}) {
    i = Math.max(0, Math.min(this.N - 1, Math.round(i)));
    if (i !== this.tT) { this.tT = i; this.onWeek(i); }
    this.wT = w; if (v != null) this.vT = v;
    this.#run();
  }
  step(d) { this.goTo(this.tT + d); }
  zoomTo(E, { w = 30 } = {}) {
    this.tZ = Math.log(Math.max(this.minSpan, Math.min(this.seasonSpan, E))); this.wZ = w;
    this.#mode(this.tZ >= Math.log(this.seasonSpan) - 1e-6 ? "season" : "close");
    this.#run();
  }
  zoomIn() { this.zoomTo(this.mode === "season" ? this.maxSpan : this.span / 1.25); }
  zoomOut() { this.zoomTo(this.span * 1.25 > this.maxSpan ? this.seasonSpan : this.span * 1.25); }
  setSeason(on) { this.zoomTo(on ? this.seasonSpan : this.home); }
  request() { if (!this.queued) this.queued = requestAnimationFrame(() => { this.queued = 0; this.onFrame(); }); }

  /* ---- motion ---- */
  #mode(m) { if (m !== this.mode) { this.mode = m; this.onZoom(m); } }
  #run() {
    if (reduced.matches) { this.T = this.tT; this.Z = this.tZ; this.vT = this.vZ = 0; this.request(); return; }
    if (this.raf) return;                                        // the running loop picks up new targets
    let last = performance.now();
    const tick = () => {
      const now = performance.now(), dt = Math.min(0.033, Math.max(0.001, (now - last) / 1000)); last = now;
      if (!this.busy) [this.T, this.vT] = spring(this.T, this.vT, this.tT, this.wT, dt);
      if (!this.pinching) [this.Z, this.vZ] = spring(this.Z, this.vZ, this.tZ, this.wZ, dt);
      const doneT = this.busy || (Math.abs(this.T - this.tT) < 5e-4 && Math.abs(this.vT) < 0.01);
      const doneZ = this.pinching || (Math.abs(this.Z - this.tZ) < 5e-4 && Math.abs(this.vZ) < 0.01);
      if (doneT && !this.busy) { this.T = this.tT; this.vT = 0; }
      if (doneZ && !this.pinching) { this.Z = this.tZ; this.vZ = 0; }
      this.onFrame();
      this.raf = doneT && doneZ ? 0 : requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  #stop() { cancelAnimationFrame(this.raf); this.raf = 0; }
  #clampT(T) { const n = this.N - 1; return T < 0 ? -rubber(-T) : T > n ? n + rubber(T - n) : T; }
  #rawT(T) { const n = this.N - 1; return T < 0 ? -unrubber(-T) : T > n ? n + unrubber(T - n) : T; }
  #pxPerWeek() { const x = this.scale(); return x(new Date(+this.ref + WEEK)) - x(this.ref); }
  #placeAt(clientX) { // Season: the date under the pointer
    const x = this.scale(), px = clientX - this.surface.getBoundingClientRect().left;
    return Math.max(0, Math.min(this.N - 1, (x.invert(px) - this.dates[0]) / WEEK));
  }
  #setT(T) { this.T = T; const i = Math.max(0, Math.min(this.N - 1, Math.round(T))); if (i !== this.tT) { this.tT = i; this.onWeek(i); } this.request(); }
  #settleT(v = 0, w = 26) { this.busy = false; this.goTo(Math.round(this.T + v * 0.12), { w, v }); }
  #settleZ() {
    this.pinching = false;
    const z = this.Z, a = Math.log(this.maxSpan), b = Math.log(this.seasonSpan), lo = Math.log(this.minSpan);
    const target = z < lo ? lo : z > a && z < b ? (z - a > (b - a) * 0.35 ? b : a) : Math.min(z, b);
    this.tZ = target; this.wZ = 26;
    this.#mode(target >= b - 1e-6 ? "season" : "close");
    this.#run();
  }
  #zoomBy(f) { // 1:1 zoom from a gesture, rubber-banding below minSpan
    this.#stop(); this.pinching = true; this.vZ = 0;
    const lo = Math.log(this.minSpan), b = Math.log(this.seasonSpan);
    const raw = (this.Z < lo ? lo - unrubber(lo - this.Z, 4) : this.Z) + Math.log(f);
    this.Z = raw < lo ? lo - rubber(lo - raw, 4) : Math.min(raw, b);
    this.request();
    clearTimeout(this.zoomIdle); this.zoomIdle = setTimeout(() => this.#settleZ(), 160);
  }

  /* ---- inputs ---- */
  #bind() {
    const el = this.surface;
    let drag = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this.ignore(e) || this.pinching) return;
      const season = this.mix > 0.999, close = this.mix < 0.001;
      if (!season && !close) return;                            // mid zoom: hands off
      this.#stop(); this.vT = 0;
      drag = { id: e.pointerId, x0: e.clientX, T0: this.T, pxw: this.#pxPerWeek(), season, moved: false, hist: [{ t: e.timeStamp, T: this.T }] };
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x0;
      if (!drag.moved && Math.abs(dx) < 4) return;
      if (!drag.moved) { drag.moved = true; this.busy = true; try { el.setPointerCapture(e.pointerId); } catch {} el.style.cursor = "grabbing"; }
      const T = drag.season ? this.#placeAt(e.clientX) : this.#clampT(drag.T0 - dx / drag.pxw);
      drag.hist.push({ t: e.timeStamp, T }); if (drag.hist.length > 6) drag.hist.shift();
      this.#setT(T);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null; el.style.cursor = "";
      if (!d.moved) {                                           // a tap
        if (d.season && e.type === "pointerup") { this.busy = false; this.goTo(this.#placeAt(e.clientX), { w: 30 }); }
        else this.#run();                                       // resume anything the press interrupted
        return;
      }
      const a = d.hist[0], z = d.hist.at(-1), dt = Math.max(1, z.t - a.t);
      const v = z.t - a.t < 120 ? ((z.T - a.T) / dt) * 1000 : 0; // weeks per second, only if still moving
      this.#settleT(d.season ? 0 : v);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);

    let wheelIdle = 0;
    el.addEventListener("wheel", (e) => {
      if (e.target.closest?.(".c-float")) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
      if (e.ctrlKey || e.metaKey) {                              // pinch, or ⌘/ctrl + wheel
        e.preventDefault();
        const d = Math.max(-25, Math.min(25, e.deltaY * unit)); // a mouse wheel notch is ~100; a pinch is ~1-10
        this.#zoomBy(Math.exp(d * 0.012));
        return;
      }
      let dx = e.deltaX;
      if (!dx && e.shiftKey) dx = e.deltaY;
      if (!dx || Math.abs(dx) < Math.abs(e.deltaY) || drag || this.pinching) return;
      if (this.mix > 0.001 && this.mix < 0.999) return;
      e.preventDefault();
      this.#stop(); this.vT = 0; this.busy = true;
      this.#setT(this.#clampT(this.#rawT(this.T) + (dx * unit) / this.#pxPerWeek()));
      clearTimeout(wheelIdle); wheelIdle = setTimeout(() => this.#settleT(0), 140);
    }, { passive: false });

    // Safari sends pinches as gesture events
    let g0 = 0;
    el.addEventListener("gesturestart", (e) => { e.preventDefault(); g0 = 1; });
    el.addEventListener("gesturechange", (e) => { e.preventDefault(); this.#zoomBy(g0 / e.scale); g0 = e.scale; });
    el.addEventListener("gestureend", (e) => { e.preventDefault(); });

    el.addEventListener("dblclick", (e) => {
      if (this.ignore(e)) return;
      this.zoomTo(this.mode === "season" ? this.home : this.seasonSpan);
    });

    timeKeys((d) => this.step(d));
    document.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input, textarea, select, [contenteditable], .c-float")) return;
      if (e.key === "=" || e.key === "+") { e.preventDefault(); this.zoomIn(); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); this.zoomOut(); }
      else if (e.key === "0") { e.preventDefault(); this.zoomTo(this.home); }
    });
  }
}
