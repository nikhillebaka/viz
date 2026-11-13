/* Time navigation for charts over weekly forecast dates: which date is shown, and how much time is on
 * screen. Decisions: studies/time-navigation.md.
 *
 * Two continuous quantities, both animated on critically damped springs:
 *  - T: the forecast date as a fractional index into `dates`. The chart is drawn at T and interpolates
 *    between weeks (fanChart({ t })).
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
 *  - pinch (trackpad, Safari gestures), ⌘ + vertical wheel, = / - / 0 keys: zoom. Zoom pivots on the
 *    forecast, never the cursor (when panned, on the middle of the view).
 *  - ⌘ + side scroll, or ⌘ + drag: pan the view without moving the forecast (P, weeks of camera offset), within the
 *    season, rubber-banding at its ends.
 *  - The pan is kept: while the reference date is on screen, scrubbing and stepping change the date
 *    around it, and its line stays exactly where it was left. While it is off-screen, plain side scroll
 *    and drag pan too (as if ⌘ were held) until the view is back at its home position (where the
 *    recenter pill would put it), the same point from either side; from there the same gesture scrubs. Keys and the stepper with the forecast off-screen bring it back to its home
 *    position; so do zooming fully out, double-click and 0.
 *  - shift + scroll (up to stretch, down to shrink) or shift + vertical drag: height zoom H, independent
 *    of everything above. Zero stays on the axis; 1/3× to ~6.7×, rubber-banding at both ends; 0 resets it.
 *    (Shift no longer turns a vertical wheel into side scroll: macOS already sends shift + trackpad swipes
 *    sideways, so the two can't be told apart.)
 *  - double-click: zoom fully out to the season; when fully out, zoom back in on the date you clicked.
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
   *  ignore(event): true for targets that handle their own pointer entirely (e.g. labels)
   *  tapTarget(event): true when a tap (no movement) lands on something the page handles (e.g. a line);
   *    drags starting there still scrub and pan
   *  onFrame(): redraw; onWeek(i): the week T is heading to changed; onZoom(mode): "close" | "season" */
  constructor(o) {
    Object.assign(this, { forecastWeeks: 3, minSpan: 6, maxSpan: 20, ignore: () => false, onWeek() {}, onZoom() {} }, o);
    this.N = this.dates.length;
    this.seasonSpan = (this.season[1] - this.season[0]) / WEEK;
    this.home = o.span ?? 11;
    this.T = this.tT = this.index; this.vT = 0; this.wT = 38;
    this.Z = this.tZ = Math.log(this.home); this.vZ = 0; this.wZ = 30;
    this.P = this.tP = 0; this.vP = 0; this.wP = 30;          // camera offset from the forecast, in weeks
    this.H = this.tH = 0; this.vH = 0; this.wH = 30;          // height zoom, log scale (0 = normal)
    this.busy = false; this.raf = 0; this.queued = 0; this.mode = "close";
    this.#bind();
  }

  /* ---- what the chart needs ---- */
  get week() { return this.tT; }
  get ref() { return new Date(+this.dates[0] + this.T * WEEK); }
  get span() { return Math.exp(this.Z); }
  /* how far toward the full season the zoom is: 0 up to maxSpan, 1 at the full season (log space) */
  get mix() { return this.#mixAt(this.span); }
  /* how much the camera follows the date: 1 up to maxSpan, easing to 0 at the full season */
  get follow() { return this.#followAt(this.span); }
  #mixAt(E) {
    const a = Math.log(this.maxSpan), b = Math.log(this.seasonSpan);
    return Math.max(0, Math.min(1, (Math.log(E) - a) / (b - a)));
  }
  #followAt(E) { const u = this.#mixAt(E); return 1 - u * u * (3 - 2 * u); }

  /* The camera, one model for date, zoom and pan. The window is exactly `span` weeks wide. Its centre
   * follows the date, keeping the reference date where it sits at that span (from maxSpan on, where it
   * sits at maxSpan), and fades toward the season's centre as `follow` goes to 0. That centre is kept
   * inside the season. The pan P (weeks) is added on top and is not clamped, so a pan past the season's
   * ends can rubber-band; panRange() says where those ends are. */
  #c0(E = this.span, ref = +this.ref) {
    const W = WEEK, fw = this.forecastWeeks, s0 = +this.season[0], s1 = +this.season[1];
    const lead = Math.min(E, this.maxSpan), frac = (lead - fw) / lead; // the reference date's place across the view
    const cF = ref + (0.5 - frac) * E * W, cS = (s0 + s1) / 2;
    const c = cF + (cS - cF) * (1 - this.#followAt(E)), half = (E * W) / 2;
    return E * W >= s1 - s0 ? cS : Math.max(s0 + half, Math.min(s1 - half, c));
  }
  domain() {
    const c = this.#c0() + this.P * WEEK, half = (this.span * WEEK) / 2;
    return [new Date(c - half), new Date(c + half)];
  }

  /* ---- commands ---- */
  goTo(i, { w = 38, v = null, recenter = "auto" } = {}) {
    i = Math.max(0, Math.min(this.N - 1, Math.round(i)));
    if (recenter === true || (recenter === "auto" && !this.refVisible())) { this.tP = 0; this.returning = false; }
    if (i !== this.tT) { this.tT = i; this.onWeek(i); }
    this.wT = w; if (v != null) this.vT = v;
    this.#run();
  }
  step(d) { this.goTo(this.tT + d); }
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
  zoomIn() { this.zoomTo(Math.exp(this.tZ) / 1.25); }
  zoomOut() { this.zoomTo(Math.exp(this.tZ) * 1.25); }
  /* the view (zoom and pan) as a value, to save and later restore exactly (e.g. around a model picker) */
  view() { return { Z: this.tZ, P: this.tP, H: this.tH, returning: this.returning }; }
  setView(v, { w = 26 } = {}) { this.tZ = v.Z; this.tP = v.P; if (v.H != null) { this.tH = v.H; this.wH = w; } this.returning = !!v.returning; this.wZ = this.wP = w; this.#mode(this.tZ >= Math.log(this.seasonSpan) - 1e-6 ? "season" : "close"); this.#run(); }
  recenter() { this.tP = 0; this.wP = 30; this.returning = false; this.#run(); }
  setSeason(on) { this.zoomTo(on ? this.seasonSpan : this.home, { recenter: true }); }
  /* how far the view can pan at span E (weeks) before its edges leave the season */
  panRange(E = this.span) {
    const c0 = this.#c0(E), half = (E * WEEK) / 2;
    const lo = (+this.season[0] + half - c0) / WEEK, hi = (+this.season[1] - half - c0) / WEEK;
    return [Math.min(lo, 0), Math.max(hi, 0)];
  }
  /* any gesture in progress (the page hides hover while this is true) */
  get moving() { return !!(this.busy || this.panning || this.pinching || this.heightZooming); }
  /* how much taller the data is drawn than normal (1 = normal); divide the y-axis maximum by it */
  get heightZoom() { return Math.exp(this.H); }
  setHeight(z = 1) { this.tH = Math.log(z); this.wH = 30; this.#run(); }
  /* the reference date's x on screen, from the live camera (not the last drawn frame) */
  refX() {
    const [r0, r1] = this.scale().range(), [d0, d1] = this.domain();
    return r0 + ((+this.ref - d0) / (d1 - d0)) * (r1 - r0);
  }
  /* "the forecast is on screen": the reference line and its whole fan (forecastWeeks to its right) */
  refVisible(margin = 24) {
    const x = this.refX(), fan = this.forecastWeeks * this.#pxPerWeek();
    return x >= margin && x + fan <= this.surface.clientWidth - margin;
  }
  request() { if (!this.queued) this.queued = requestAnimationFrame(() => { this.queued = 0; this.onFrame(); }); }

  /* ---- motion ---- */
  #mode(m) { if (m !== this.mode) { this.mode = m; this.onZoom(m); } }
  #run() {
    if (reduced.matches) { this.T = this.tT; this.Z = this.tZ; this.P = this.tP; this.H = this.tH; this.vT = this.vZ = this.vP = this.vH = 0; this.request(); return; }
    if (this.raf) return;                                        // the running loop picks up new targets
    let last = performance.now();
    const tick = () => {
      const now = performance.now(), dt = Math.min(0.033, Math.max(0.001, (now - last) / 1000)); last = now;
      if (!this.busy) [this.T, this.vT] = spring(this.T, this.vT, this.tT, this.wT, dt);
      if (!this.pinching) [this.Z, this.vZ] = spring(this.Z, this.vZ, this.tZ, this.wZ, dt);
      if (!this.panning) [this.P, this.vP] = spring(this.P, this.vP, this.tP, this.wP, dt);
      if (!this.heightZooming) [this.H, this.vH] = spring(this.H, this.vH, this.tH, this.wH, dt);
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
  #setT(T) { this.T = T; const i = Math.max(0, Math.min(this.N - 1, Math.round(T))); if (i !== this.tT) { this.tT = i; this.onWeek(i); } this.request(); }
  #settleT(v = 0, w = 26) { this.busy = false; this.goTo(Math.round(this.T + v * 0.12), { w, v, recenter: false }); }
  #settleZ() {
    this.pinching = false;
    const z = this.Z, a = Math.log(this.maxSpan), b = Math.log(this.seasonSpan), lo = Math.log(this.minSpan);
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
    const el = this.surface;
    let drag = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this.ignore(e) || this.pinching) return;
      const fan = this.follow < 0.5;                            // zoomed far out: the drag moves the forecast
      this.#stop(); this.vT = 0;
      // ⌘ + drag pans, exactly like ⌘ + side scroll: the view moves, the forecast stays on its date
      // shift + drag zooms height (up to stretch), independent of the date and the time view
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastY: e.clientY, fan, pan: e.metaKey, height: e.shiftKey && !e.metaKey, moved: false, scrubbed: false, hist: [{ t: e.timeStamp, T: this.T }] };
      if (drag.pan) this.returning = false;
    });
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
    });
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
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);

    let wheelIdle = 0;
    el.addEventListener("wheel", (e) => {
      if (e.target.closest?.(".c-float")) return;
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
      const did = this.#advance((dx * unit) / this.#pxPerWeek());
      if (did === "scrub") { clearTimeout(wheelIdle); wheelIdle = setTimeout(() => this.#settleT(0), 140); }
    }, { passive: false });

    // Safari sends pinches as gesture events
    let g0 = 0;
    el.addEventListener("gesturestart", (e) => { e.preventDefault(); g0 = 1; });
    el.addEventListener("gesturechange", (e) => { e.preventDefault(); this.#zoomBy(g0 / e.scale); g0 = e.scale; });
    el.addEventListener("gestureend", (e) => { e.preventDefault(); });

    el.addEventListener("dblclick", (e) => {
      if (this.ignore(e)) return;
      const full = this.tZ >= Math.log(this.seasonSpan) - 1e-3;
      this.zoomTo(full ? this.home : this.seasonSpan, { recenter: true });
    });

    timeKeys((d) => this.step(d));
    document.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input, textarea, select, [contenteditable], .c-float")) return;
      if (e.key === "=" || e.key === "+") { e.preventDefault(); this.zoomIn(); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); this.zoomOut(); }
      else if (e.key === "0") { e.preventDefault(); this.zoomTo(this.home, { recenter: true }); this.setHeight(1); }
    });
  }
}
