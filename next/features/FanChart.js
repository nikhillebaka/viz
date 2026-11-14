/* The fan chart view (design/fan-chart.md): the canvas, time navigation, the per-frame draw, data for one
 * (target, season, place) at a time and the transitions between them. Hover, focus and the hidden label
 * buttons are in chart/interact.js, the readout in chart/readout.js, the chart's bubbles in chart/bubbles.js,
 * the optional context layers (and their pill) in chart/layers.js.
 *
 * It reads and writes the store: `date` (the round the chart is on), `focus`, `sel` (a grey line clicked
 * is charted); and reacts to target, location, date, sel, levels, rulers, outcome, focus and layers. Zoom, pan and
 * height are view state, kept here (TimeNav), not in the store.
 *
 * Frames: at most one draw per animation frame (TimeNav's loop and every request share it):
 * layoutFan → drawFan → Glass.frame() → readout, label buttons, bubbles, then whatever is under a still
 * pointer is re-checked. No DOM reads on that path: sizes and insets are measured on resize. */
import { loadFan, prefetchFan } from "../lib/api.js";
import { niceMax, toIso, parseIso } from "../lib/scale.js";
import { valueFormat, fmtLong } from "../lib/format.js";
import { h, on, onThemeChange, reducedMotion, tokenNum } from "../lib/dom.js";
import { layoutFan, hoverInfo } from "../chart/layout.js";
import { drawFan, canvasMeasure, chartFonts } from "../chart/render.js";
import { TimeNav } from "../chart/timenav.js";
import { Glass } from "../ui/glass.js";
import { activeLayer } from "../ui/floating.js";
import { chart as chartModel, context as contextOf, isCharted } from "./selection.js";
import { Interaction } from "./chart/interact.js";
import { Readout } from "./chart/readout.js";
import { ChartBubbles } from "./chart/bubbles.js";
import { Layers } from "./chart/layers.js";

const PREVIEW_WEEKS = 14;   // the model picker's preview: the four forecast weeks stay distinct
const RULER_MS = 180;       // width rulers fade and slide in or out
const DIM_AFTER = 80;       // the old plot dims if new data takes longer than this

/* A value eased toward a target (ease-out cubic: no overshoot), advanced by the chart's frames. */
class Tween {
  constructor(v) { this.v = this.from = this.to = v; this.t0 = 0; this.dur = 0; this.active = false; }
  jump(v) { this.v = this.from = this.to = v; this.active = false; }
  set(to, dur) {
    if (to === this.to) return;
    if (!(dur > 0) || reducedMotion() || !Number.isFinite(this.v)) { this.jump(to); return; }
    this.from = this.v; this.to = to; this.t0 = performance.now(); this.dur = dur; this.active = true;
  }
  /** @returns {boolean} still moving */
  tick(now) {
    if (!this.active) return false;
    const u = Math.max(0, Math.min(1, (now - this.t0) / this.dur));
    this.v = this.from + (this.to - this.from) * (1 - (1 - u) ** 3);
    if (u >= 1) { this.v = this.to; this.active = false; }
    return this.active;
  }
}

/** The timeline index of an ISO date in a fan, else of the round nearest it. */
function indexFor(fan, iso) {
  const i = fan.indexOf(iso);
  if (i >= 0) return i;
  const t = parseIso(iso);
  let best = fan.dates.length - 1, bd = Infinity;
  fan.roundAt.forEach((r, j) => { if (r >= 0 && Math.abs(fan.dates[j] - t) < bd) { bd = Math.abs(fan.dates[j] - t); best = j; } });
  return Math.max(0, best);
}

/** The next timeline week with a round from i in direction d, or -1. */
function nextRound(fan, i, d) {
  for (let j = i + d; j >= 0 && j < fan.dates.length; j += d) if (fan.roundAt[j] >= 0) return j;
  return -1;
}

export class FanChart {
  /**
   * @param {HTMLElement} view the chart view (in the document; positioned)
   * @param {{ manifest: import("../lib/api.js").Manifest, store: object }} ctx
   * @param {{ onReady?: () => void, onError?: (retry: (() => void) | null) => void, onInset?: (px: number) => void }} [hooks]
   *   onReady: the first frame is drawn. onError: data couldn't be loaded (retry tries again), or null once
   *   it could. onInset: an open panel takes px at the left (the bubbles make room).
   */
  constructor(view, ctx, hooks = {}) {
    this.view = view;
    this.ctx = ctx;
    this.hooks = hooks;
    /** @type {import("../lib/api.js").Fan | null} the Fan on screen */
    this.fan = null;
    /** @type {TimeNav | null} */
    this.nav = null;
    /** the last scene drawn (tests and interaction read it) */
    this.scene = null;
    this.bubbles = null;
    /** @type {Layers | null} */
    this.layers = null;
    this.loading = false;

    this.canvas = h("canvas", { class: "fc-canvas", role: "img", "aria-label": "Forecast chart" });
    this.empty = h("div", { class: "fc-empty", role: "status" });
    this.empty.hidden = true;
    view.append(this.canvas, this.empty);
    this.readout = new Readout(view);
    this.interact = new Interaction(this);

    const s = ctx.store.get();
    this.y = new Tween(NaN);                     // the axis maximum at normal height
    this.rk = new Tween(s.rulers ? 1 : 0);       // the rulers, 0–1
    this.inset = new Tween(0);                   // room taken at the left by an open panel
    this.size = { w: 0, h: 0 };
    const chrome = tokenNum("--inset", 16) + tokenNum("--size-control", 38);
    this.top = chrome;                           // bottom of the fixed top bubbles
    this.bottom = chrome;                        // room the bottom bubbles take
    this.opts = { models: [], context: [], absent: null, pad: { l: 64, r: 168, t: 0, b: 0 }, measure: canvasMeasure(), hover: null, format: null };
    this.hoverAt = { t: 0 };
    this.more = 0;
    this.ariaKey = "";
    this.emptyKey = "";

    this._token = 0;
    this._pending = null;
    this._crossing = false;
    this._dim = 0;
    this._cutting = 0;
    this._rect = null;
    this._saved = null;
    this._ft = -1;

    const ro = new ResizeObserver(() => this.#resize());
    ro.observe(view);
    this.offs = [
      ctx.store.on((st, prev, changed) => this.#onStore(st, prev, changed)),
      onThemeChange(() => this.request()),
      // a layer opening or closing moves focus: hover hides or comes back on the next frame
      on(document, "focusin", () => this.request()),
      on(document, "focusout", () => this.request()),
      // the canvas moved under a still pointer: forget its rect and re-check what is hovered
      on(window, "scroll", () => { this._rect = null; if (this.interact.mouse) this.request(); }, { passive: true, capture: true }),
      on(document.fonts, "loadingdone", () => { this.#measure(); this.request(); }),
      () => ro.disconnect(),
      () => this._dprOff?.(),
    ];
    this.#watchDpr();
    document.fonts?.ready.then(() => { this.#measure(); this.request(); });
    this.#show(this.#want(s.date));
  }

  /* ================================================================ public */

  /** @returns {number} the round the chart is on or heading to, ms */
  week() { return this.fan && this.nav ? this.fan.dates[this.nav.week] : parseIso(this.ctx.store.get().date); }

  /**
   * Any round in any season. Within the season on screen the date glides; another season is a cut.
   * @param {string} iso
   */
  goTo(iso) {
    const season = this.#seasonOf(iso);
    const p = this._pending;
    if (this.fan && this.nav && season === this.fan.season && (!p || p.season === season)) {
      if (p && p.date) this.#cancel();
      this.nav.goTo(indexFor(this.fan, iso));
      return;
    }
    this.#show(this.#want(iso));
  }

  /**
   * ← → and the stepper: the next or previous round (weeks without a round are skipped), crossing into
   * the neighbouring season at either end; a nudge when there is nowhere further.
   * @param {-1 | 1} d
   */
  step(d) {
    const nav = this.nav, fan = this.fan;
    if (!nav || this._crossing) return;
    const i = nextRound(fan, nav.week, d);
    if (i >= 0) { nav.goTo(i); return; }
    const nb = this.neighbour(d);
    if (nb) this.goTo(d > 0 ? nb.rounds[0] : nb.rounds.at(-1));
    else this.bubbles?.nudge(d);
  }

  /**
   * The season before (d = -1) or after (d = 1) the one on screen, if it has rounds.
   * @returns {object | null} a manifest season
   */
  neighbour(d) {
    if (!this.fan) return null;
    const ss = this.ctx.manifest.seasons.filter((x) => x.rounds?.length);
    const i = ss.findIndex((x) => x.id === this.fan.season);
    return i < 0 ? null : ss[i + d] ?? null;
  }

  /** `=` (dir > 0), `-` (dir < 0), `0` (dir 0: the home span, recentred, normal height). */
  zoom(dir) {
    if (!this.nav) return;
    if (dir > 0) this.nav.zoomIn(); else if (dir < 0) this.nav.zoomOut(); else this.nav.reset();
  }

  /**
   * Previews focus on a model from outside the chart (e.g. hovering its row in the scores), exactly as
   * hovering its label does; null clears it. Only a model drawn in color (or the baseline) shows; a
   * pointer over the chart or a keyboard-focused label takes precedence.
   * @param {string | null} id
   */
  hoverModel(id) {
    id = id ?? null;
    if (id === this.interact.external) return;
    this.interact.external = id;
    this.request();
  }

  /** Clears the focus (Escape). */
  clearFocus() { if (this.ctx.store.get().focus) this.ctx.store.set({ focus: null }); }

  /**
   * One rule for every model on the chart: click focuses it (again clears); a grey model is charted first
   * (taking the longest-charted slot if five are charted) and then focused.
   * @param {string} id
   * @param {boolean} ctx it is a grey (context) model
   */
  activate(id, ctx) {
    const { store, manifest } = this.ctx, s = store.get();
    if (ctx || (id !== manifest.baseline && !isCharted(s.sel, id))) store.set({ sel: chartModel(s.sel, id), focus: id });
    else store.set({ focus: s.focus === id ? null : id });
    this.interact.clear();
    this.request();
  }

  /**
   * Room taken at the left by an open panel: the plot moves aside (eased over --dur-move, no overshoot).
   * @param {number} px
   */
  setInset(px) {
    px = Math.max(0, Math.round(+px || 0));
    if (px === this.inset.to) return;
    this.inset.set(px, tokenNum("--dur-move", 300));
    this.view.style.setProperty("--inset-goal", `${px}px`);
    this.hooks.onInset?.(px);
    this.request();
  }

  /**
   * The bottom of the fixed top bubbles, page px (the shell measures them).
   * @param {number} px
   */
  setTop(px) {
    if (!(px > 0) || Math.abs(px - this.top) < 0.5) return;
    this.top = px;
    this.view.style.setProperty("--top-clear", `${px}px`);
    this.request();
  }

  /**
   * true: zoom to 14 weeks (recentred) at normal height, for judging models; false: restore the zoom, pan
   * and height exactly as they were.
   * @param {boolean} on
   */
  preview(on) {
    const nav = this.nav;
    if (!nav) return;
    if (on) {
      if (this._saved) return;
      this._saved = nav.view();
      nav.zoomTo(PREVIEW_WEEKS, { recenter: true });
      nav.setHeight(1);
    } else if (this._saved) {
      const v = this._saved;
      this._saved = null;
      // the season may have changed meanwhile: keep the restored view inside it
      const Z = Math.min(v.Z, Math.log(nav.seasonSpan)), [p0, p1] = nav.panRange(Math.exp(Z));
      nav.setView({ ...v, Z, P: Math.max(p0, Math.min(p1, v.P)) });
    }
  }

  /** @returns {boolean} nothing is animating, loading or queued (for tests) */
  idle() {
    const n = this.nav;
    return !!(this.fan && n && !this.loading && !this._cutting && !n.raf && !n.queued && !n.moving
      && !this.y.active && !this.rk.active && !this.inset.active && !this.layers?.busy);
  }

  /** One draw on the next animation frame. */
  request() { this.nav?.request(); }

  /** @returns {DOMRect} the canvas's rect, cached until a resize or scroll */
  rect() { return (this._rect ||= this.canvas.getBoundingClientRect()); }

  destroy() {
    this._token++;
    this.offs.forEach((off) => off());
    this.nav?.destroy();
    this.interact.destroy();
    this.layers?.destroy();
    this.bubbles?.destroy();
    this.canvas.remove(); this.empty.remove(); this.readout.el.remove();
    this.fan = this.nav = null; // late callbacks (fonts loading, the idle prefetch) find nothing to do
  }

  /* ================================================================ data */

  #seasonOf(iso) {
    const M = this.ctx.manifest;
    return M.seasonOf(iso) ?? M.latest?.season ?? M.seasons.at(-1)?.id;
  }

  // what to load: the store's target and place, the season of `date` (null: keep the live date on apply)
  #want(date) {
    const s = this.ctx.store.get();
    return { target: s.target, location: s.location, season: this.#seasonOf(date ?? s.date), date };
  }

  #cancel() { this._token++; this.#endLoad(); }

  #endLoad() {
    this.loading = false; this._crossing = false; this._pending = null;
    clearTimeout(this._dim);
    this.view.classList.remove("is-loading");
  }

  async #show(want) {
    const token = ++this._token;
    this.loading = true;
    this._pending = want;
    this._crossing = !!(want.date && this.fan && want.season !== this.fan.season);
    clearTimeout(this._dim);
    if (this.fan) this._dim = setTimeout(() => this.view.classList.add("is-loading"), DIM_AFTER);
    let fan;
    try {
      fan = await loadFan(want.target, want.season, want.location);
    } catch {
      if (token !== this._token) return;
      this.#endLoad();
      this.hooks.onError?.(() => this.#show(want));
      return;
    }
    if (token !== this._token) return;
    this.#endLoad();
    this.#apply(fan, want.date ?? this.ctx.store.get().date);
  }

  #apply(fan, iso) {
    const index = indexFor(fan, iso);
    if (!this.fan) {
      this.fan = fan;
      this.#prepare(false);
      this.nav = new TimeNav({
        surface: this.canvas, dates: fan.dates, index, season: fan.window,
        scale: () => this.scene.x,
        ignore: (e) => this.interact.onLabel(e),
        tapTarget: (e) => this.interact.onLine(e),
        onFrame: () => this.draw(),
        onWeek: (i) => this.#onWeek(i),
      });
      this.bubbles = new ChartBubbles(this, index);
      this.layers = new Layers(this);
      this.#resize();
      this.#onWeek(index);
      this.view.classList.add("is-ready");
      this.hooks.onReady?.();
    } else {
      const old = this.fan.dates;
      const same = old.length === fan.dates.length && old[0] === fan.dates[0];
      this.#cut(() => {
        this.fan = fan;
        this.#prepare(true);
        // another season, or a target or place whose rounds differ: the stepper takes the new weeks first,
        // so the week setTimeline announces is read against them
        if (!same) this.bubbles.setDates(fan.dates, index);
        this.nav.setTimeline({ dates: fan.dates, season: fan.window, index });
        this.nav.setHeight(1);
        this.layers.sync();
        this.draw(true);
      });
    }
    this.hooks.onError?.(null);
    this.#prefetch();
  }

  // once idle, the neighbouring seasons for this place, so crossing is instant
  #prefetch() {
    const fan = this.fan, idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 400));
    idle(() => {
      if (this.fan !== fan) return;
      for (const d of [1, -1]) { const nb = this.neighbour(d); if (nb) prefetchFan(fan.target, nb.id, fan.location); }
    }, { timeout: 2000 });
  }

  /* The old frame fades out over the new one (a cut, not a glide), --dur-fast × 1.25 ≈ 150 ms. */
  #cut(apply) {
    let ghost = null;
    if (!reducedMotion() && this.canvas.width && this.scene) {
      ghost = document.createElement("canvas");
      ghost.width = this.canvas.width; ghost.height = this.canvas.height;
      ghost.className = "fc-snapshot";
      ghost.setAttribute("aria-hidden", "true");
      ghost.getContext("2d").drawImage(this.canvas, 0, 0);
      this.canvas.after(ghost);
    }
    apply();
    if (!ghost) return;
    this._cutting++;
    const done = () => { if (ghost.isConnected) { ghost.remove(); this._cutting--; } };
    const a = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: tokenNum("--dur-fast", 120) * 1.25, easing: "ease-out", fill: "forwards" });
    a.onfinish = done;
    setTimeout(done, 400); // a hidden tab may pause animations; never leave a copy behind
  }

  /* Everything that depends on the fan and the selection, not on time: the models drawn, their labels,
   * the grey lines, the "not in" line, the value format and the axis maximum. */
  #prepare(ease) {
    const { manifest: M, store } = this.ctx, s = store.get(), sel = s.sel, fan = this.fan, base = M.baseline;
    const among = [...sel.selected, base];
    const charted = [...sel.charted].sort((a, b) => a.slot - b.slot);
    const models = charted.filter((c) => fan.present.has(c.id)).map((c) => ({ id: c.id, slot: c.slot, label: M.label(c.id, among) }));
    if (sel.baseline && base && fan.present.has(base)) models.push({ id: base, slot: "baseline", label: M.label(base, among) });
    const o = this.opts;
    o.models = models;
    const ctxIds = contextOf(sel);
    this.more = ctxIds.length;
    o.context = ctxIds.filter((id) => fan.present.has(id)).map((id) => ({ id, label: M.label(id, among) }));
    o.absent = this.#absent(charted.filter((c) => !fan.present.has(c.id)).map((c) => c.id));
    o.format = valueFormat(M.targetById.get(fan.target));
    this.#axis(ease);
    // focus clears when the focused model leaves the chart (or isn't in this season, place or target)
    if (s.focus && !models.some((m) => m.id === s.focus)) store.set({ focus: null });
  }

  /* The axis maximum: observed data and the charted medians (rounded up), and past seasons while that
   * layer is on, so their lines never run off the top. Eases to a new goal; never per frame. */
  #axis(ease) {
    const fan = this.fan;
    if (!fan) return;
    const goal = niceMax(Math.max(fan.yMax(this.opts.models.map((m) => m.id)), this.layers?.yMax() ?? 0));
    if (ease) this.y.set(goal, tokenNum("--dur-move", 300)); else this.y.jump(goal);
    this.layers?.axis(goal);
  }

  /** Something drawn on the chart changed what the axis must hold (a layer's data arrived). */
  rescale() { this.#axis(true); this.request(); }

  // charted models with nothing here: one quiet line, "2 not in 2023–24 · 1 not in Wyoming"
  #absent(ids) {
    if (!ids.length) return null;
    const M = this.ctx.manifest, fan = this.fan;
    let season = 0, target = 0, place = 0;
    for (const id of ids) {
      const m = M.modelById.get(id);
      if (!m?.seasons?.includes(fan.season)) season++;
      else if (m.targets?.length && !m.targets.includes(fan.target)) target++;
      else place++;
    }
    return [
      season && `${season} not in ${M.seasonById.get(fan.season)?.label ?? fan.season}`,
      target && `${target} not for ${M.targetById.get(fan.target)?.short ?? fan.target}`,
      place && `${place} not in ${M.locationById.get(fan.location)?.name ?? fan.location}`,
    ].filter(Boolean).join(" · ");
  }

  /* ================================================================ state */

  #isoAt(i) {
    const fan = this.fan, r = fan.roundAt[i];
    return r >= 0 ? fan.rounds[r] : toIso(fan.dates[i]);
  }

  // the chart heads to week i: the stepper follows and the store learns the date
  #onWeek(i) {
    this.bubbles?.show(i);
    const iso = this.#isoAt(i);
    if (iso !== this.ctx.store.get().date) this.ctx.store.set({ date: iso });
  }

  #onStore(s, prev, changed) {
    if (changed.has("target") || changed.has("location")) this.#show(this.#want(null));
    else if (changed.has("date") && this.nav && s.date !== this.#isoAt(this.nav.week)) this.goTo(s.date);
    if (changed.has("sel") && this.fan) this.#prepare(true);
    if (changed.has("rulers")) this.rk.set(s.rulers ? 1 : 0, RULER_MS);
    if (changed.has("sel") || changed.has("levels")) this.bubbles?.sync(s);
    if (["layers", "date", "sel"].some((k) => changed.has(k))) this.layers?.sync();
    if (changed.has("layers") && !changed.has("sel") && this.fan) this.#axis(true);
    this.request();
  }

  /* ================================================================ frame */

  #resize() {
    const w = this.view.clientWidth, h = this.view.clientHeight;
    this.size = { w, h };
    this._rect = null;
    this.#measure();
    if (this.nav) this.draw(true);
  }

  // a devicePixelRatio change (another display, browser zoom without a resize) redraws at the new density
  #watchDpr() {
    const mq = globalThis.matchMedia?.(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`);
    if (!mq) return;
    const fn = () => { this._dprOff?.(); this.#watchDpr(); if (this.nav) this.draw(true); };
    mq.addEventListener("change", fn, { once: true });
    this._dprOff = () => mq.removeEventListener("change", fn);
  }

  // the room the bottom bubbles take, from the view's bottom edge
  #measure() {
    const z = this.bubbles?.zones;
    if (!z) return;
    const vb = this.view.getBoundingClientRect().bottom;
    const b = Math.max(...[z.bl, z.bc, z.br].map((el) => vb - el.getBoundingClientRect().top));
    if (b > 0) this.bottom = b;
  }

  /**
   * Draws one frame (at most one per animation frame unless forced).
   * @param {boolean} [force] draw now even if this frame already drew (a cut, a resize)
   */
  draw(force = false) {
    const fan = this.fan, nav = this.nav;
    if (!fan || !nav) return;
    const ft = document.timeline?.currentTime ?? performance.now();
    if (!force && ft === this._ft) return;
    this._ft = ft;
    const now = performance.now();
    const anim = this.y.tick(now) | this.rk.tick(now) | this.inset.tick(now);
    const { w, h } = this.size;
    if (w < 2 || h < 2) return;
    const s = this.ctx.store.get(), o = this.opts, ia = this.interact;
    const hoverT = ia.hoverT != null && !nav.moving && !activeLayer() ? ia.hoverT : null;
    o.t = nav.T;
    o.settle = nav.week;
    o.domain = nav.domain();
    o.ymax = this.y.v / nav.heightZoom;
    o.pad.l = 64 + this.inset.v;
    o.pad.r = 168 + (56 - 168) * nav.mix;
    o.pad.t = this.top + 24;
    o.pad.b = this.bottom + 48;
    o.topClear = this.top;
    o.levels = s.levels;
    o.outcome = s.outcome;
    o.rulers = this.rk.v;
    o.focus = ia.preview ?? ia.keyed ?? ia.external ?? s.focus;
    o.hot = ia.hot;
    if (hoverT != null) { this.hoverAt.t = hoverT; o.hover = this.hoverAt; } else o.hover = null;
    o.fonts = chartFonts();
    const scene = (this.scene = layoutFan(fan, o, w, h));
    scene.layers = this.layers?.layout(scene) ?? null;
    drawFan(this.canvas, scene);
    Glass.frame();

    if (hoverT != null) {
      this.readout.show(hoverInfo(fan, scene, hoverT), scene, {
        value: o.format.value, levels: s.levels, rulers: s.rulers, showAll: s.sel.showAll, more: this.more,
        focus: scene.focus, minX: this.inset.v + tokenNum("--inset", 16),
        layers: this.layers?.rows(hoverT, scene, o.format.value),
      });
    } else this.readout.hide();
    ia.syncLabels(scene);
    this.bubbles.frame(scene);
    this.#describe(scene);
    ia.track();
    if (anim) this.request();
  }

  // the canvas's label (target, place, date) and the empty state, rewritten only when they change
  #describe(scene) {
    const M = this.ctx.manifest, fan = this.fan;
    const place = M.locationById.get(fan.location)?.name ?? fan.location;
    const target = M.targetById.get(fan.target)?.label ?? fan.target;
    const aria = `${target} · ${place} · forecast ${fmtLong(fan.dates[scene.settle])}`;
    if (aria !== this.ariaKey) { this.ariaKey = aria; this.canvas.setAttribute("aria-label", aria); }
    const none = !fan.observed.length && !fan.present.size;
    const key = none ? `${place}|${fan.season}|${Math.round((scene.pad.l + scene.w - scene.pad.r) / 2)}|${Math.round((scene.pad.t + scene.ay) / 2)}` : "";
    if (key === this.emptyKey) return;
    this.emptyKey = key;
    this.empty.hidden = !none;
    if (none) {
      this.empty.textContent = `No data · ${place} · ${M.seasonById.get(fan.season)?.label ?? fan.season}`;
      this.empty.style.left = `${(scene.pad.l + scene.w - scene.pad.r) / 2}px`;
      this.empty.style.top = `${(scene.pad.t + scene.ay) / 2}px`;
    }
  }
}
