/* Layers: quiet context on the fan chart, off by default (old viz's "Signals & Indicators" drawer).
 *   asof     As reported: the target as it was published at the round (dashed, up to the data cutoff)
 *   seasons  Past seasons: earlier seasons' observed data, aligned by week of season, end-labelled
 *   peaks    each charted model's peak forecast for the round (▲ at median week × size, 50% whiskers) and
 *            the observed peak (◇)
 *   nssp · ili · flusurv  surveillance signals, in their own units (design/fan-chart.md, "Layers"): one on,
 *            it gets a right-hand axis whose round ticks sit on the left axis's gridlines, its end label
 *            naming the unit; two or more, each is scaled so its season peak meets the observed peak and
 *            labelled "· scaled". Raw values in the readout either way
 *
 * The Layers pill sits beside the interval pill. Store key `layers` (ids, canonical order). Data comes from
 * /api/next/surveillance (old viz's /api/surveillance, as-reported values unrounded) and old viz's
 * /api/season-curves and /api/peaks, fetched per (target, place,
 * season) — the as-reported line per round — only for layers that are on (and when the menu opens, to
 * list what exists here); responses are cached. Everything that doesn't depend on the view is prepared
 * once per response; a frame only maps prepared points through the scene's scales into reused buffers. */
import { h, on, tokenNum } from "../../lib/dom.js";
import { WEEK, DAY, parseIso, niceStep } from "../../lib/scale.js";
import { glass } from "../../ui/glass.js";
import { openMenu, activeLayer } from "../../ui/floating.js";
import { pill } from "../../ui/controls.js";
import { guide } from "./bubbles.js";

/** Every layer, in menu (and canonical) order. Signals name their key in /api/surveillance. */
export const LAYERS = Object.freeze([
  { id: "asof", label: "As reported" },
  { id: "seasons", label: "Past seasons" },
  { id: "peaks", label: "Peaks" },
  { id: "nssp", label: "NSSP ED visits", name: "NSSP ED", end: "ED visits %", key: "nssp", field: "pct", unit: "%" },
  { id: "ili", label: "ILINet", name: "ILINet", end: "ILI+ %", key: "ilinet", field: "pct", unit: "%" },
  { id: "flusurv", label: "FluSurv-NET", name: "FluSurv-NET", end: "FluSurv per 100k", key: "flusurvnet", field: "rate", unit: " per 100k" },
]);
const IDS = LAYERS.map((l) => l.id);
const SIGNALS = LAYERS.filter((l) => l.key);
const GAP = 1.5 * WEEK;          // points further apart are not joined
const PAST = 4;                  // past seasons drawn, newest first
const SEASON_ALPHA = [0.6, 0.45, 0.34, 0.26];
const LABEL_GAP = 12;
const ASOF_DASH = [4, 3];
const AXIS_CHAR = 6.3;           // ≈ px per character of the mono axis font (the right ticks' room)

// the smallest round step (1, 2, 2.5, 5 × 10ⁿ) at or above v
function stepAtLeast(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v * (1 - 1e-9)) return m * p;
  return 10 * p;
}

/**
 * Valid layer ids from a list or a comma string, in canonical order, without duplicates.
 * @param {string | string[] | unknown} v
 * @returns {string[]}
 */
export function parseLayers(v) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const set = new Set(list.map((s) => (typeof s === "string" ? s.trim() : "")));
  return IDS.filter((id) => set.has(id));
}

/**
 * Week 1 of the flu season that starts in `year`: the Saturday ending MMWR week 31 (UTC ms).
 * @param {number} year
 * @returns {number}
 */
export function seasonWeek1(year) {
  const jan4 = Date.UTC(year, 0, 4), dow = new Date(jan4).getUTCDay();
  return jan4 + (6 - dow) * DAY + 30 * WEEK;
}

const seasonLabel = (id) => { const y = +String(id).slice(0, 4); return Number.isFinite(y) ? `${y}–${String(y + 1).slice(2)}` : String(id); };

/* ---------------- data: cached JSON, in-flight requests shared ---------------- */
const cache = new Map();
function getJson(path, params) {
  const url = `${path}?${new URLSearchParams(params)}`;
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
    if (cache.size > 96) cache.delete(cache.keys().next().value);
  }
  return p;
}

/* A prepared line: times, plot values (signals scaled), raw values (readout), path breaks, and the
 * buffer a frame writes pixels into. */
function makeLine(pts, o) {
  pts = pts.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const n = pts.length, k = o.k ?? 1;
  const ts = new Float64Array(n), vs = new Float64Array(n), raw = new Float64Array(n), brk = new Uint8Array(n);
  pts.forEach((p, i) => { ts[i] = p.t; raw[i] = p.v; vs[i] = p.v * k; brk[i] = i === 0 || p.t - pts[i - 1].t > GAP ? 1 : 0; });
  return {
    ...o, n, ts, vs, raw, brk, xy: new Float32Array(2 * n), clipX: null,
    lab: o.end ? { x: 0, y: 0, text: o.end, c: "var(--ink-tertiary)", alpha: 1 } : null,
  };
}

/** The raw value of a line on week t (within half a week), or undefined. */
function valueAt(line, t) {
  const ts = line.ts;
  let lo = 0, hi = ts.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; }
  for (const i of [lo - 1, lo]) if (i >= 0 && Math.abs(ts[i] - t) < WEEK / 2) return line.raw[i];
  return undefined;
}

export class Layers {
  /** @param {import("../FanChart.js").FanChart} chart (its bubbles exist) */
  constructor(chart) {
    this.chart = chart;
    this.on = new Set();
    this.sk = "";           // target|location|season the season data belongs to
    this.sig = null;        // { lines: Map id → line, asof: boolean } | null
    this.cur = null;        // past-season lines | null
    this.asof = null;       // { round, line } | null (kept while the next round's loads)
    this.peaks = null;      // { key, available, byModel: Map id → Map round → peak, observed } | null
    this.wanted = { asof: "", peaks: "" };
    this.pending = 0;
    this._asofTimer = 0;
    this.marks = { lines: [], marks: [], labels: [], font: "", axis: null };
    this.axisTicks = [];
    this.goal = 0;          // the chart's resting axis maximum (FanChart #axis)
    this.right = null;      // the one signal on, which owns the right-hand axis, or null

    this.pill = pill({ label: "Layers", chevron: true, className: "fc-layers", onClick: () => this.#open() });
    this.pill.setAttribute("aria-haspopup", "menu");
    chart.bubbles.zones.bl.append(this.pill);
    this.glass = glass(this.pill, { canvas: chart.canvas });
    const warm = () => { if (this.chart.fan) this.#meta(); };
    this.offs = [on(this.pill, "pointerenter", warm), on(this.pill, "focus", warm)];
    this.sync();
  }

  /** @returns {number} the highest value a visible layer must keep on the axis (past seasons), else 0 */
  yMax() {
    if (!this.on.has("seasons") || !this.cur) return 0;
    let m = 0;
    for (const l of this.cur) for (let i = 0; i < l.n; i++) if (l.vs[i] > m) m = l.vs[i];
    return m;
  }

  /** @returns {boolean} a layer's data is loading (for tests) */
  get busy() { return this.pending > 0; }

  /** The store or the fan changed: the pill's label, and data for the layers that are on. Cheap. */
  sync() {
    const fan = this.chart.fan, s = this.chart.ctx.store.get();
    this.on = new Set(s.layers || []);
    if (!fan) return;
    const sk = `${fan.target}|${fan.location}|${fan.season}`;
    if (sk !== this.sk) { this.sk = sk; this.sig = this.cur = this.asof = this.peaks = null; this.wanted = { asof: "", peaks: "" }; }
    if (SIGNALS.some((l) => this.on.has(l.id)) || this.on.has("asof")) this.#loadSignals();
    if (this.on.has("seasons")) this.#loadCurves();
    if (this.on.has("asof")) this.#loadAsof(s.date);
    if (this.on.has("peaks")) this.#loadPeaks();
    this.#fit();
    this.#label();
  }

  /** The chart's axis maximum settled on a new goal: the right-hand axis follows (never per frame). */
  axis(goal) { if (goal !== this.goal) { this.goal = goal; this.#fit(); } }

  /* Signal scales, when the signals on, their data or the axis change. One signal: a round step of its
   * own on each left gridline (its peak at or under the observed peak's height); several: each to the
   * observed peak, labelled as scaled. */
  #fit() {
    const sig = this.sig;
    if (!sig) { this.right = null; return; }
    const vis = SIGNALS.filter((L) => this.on.has(L.id) && sig.lines.has(L.id)).map((L) => sig.lines.get(L.id));
    const one = vis.length === 1 ? vis[0] : null;
    for (const l of sig.lines.values()) {
      let k = l.k0;
      if (l === one) { const step = niceStep(this.goal > 0 ? this.goal : l.ref, 5); k = step / stepAtLeast(step / l.k0); }
      if (k !== l.k) { l.k = k; for (let i = 0; i < l.n; i++) l.vs[i] = l.raw[i] * k; }
      l.lab.text = vis.length > 1 ? `${l.end} · scaled` : l.end;
    }
    this.right = one;
  }

  /* ---------------- loading ---------------- */

  #track(p, sk, fn) {
    this.pending++;
    return p.then((v) => { if (sk === this.sk) { fn(v); this.#label(); this.chart.request(); } }, () => {})
      .finally(() => { this.pending--; });
  }

  // nssp, ilinet, flusurvnet for the whole season: the endpoint's window is the round −30 to +12 weeks,
  // so the season's first and last rounds together cover it
  #loadSignals() {
    if (this.sig || this._sigP?.sk === this.sk) return this._sigP?.p;
    const fan = this.chart.fan, sk = this.sk;
    const dates = [...new Set([fan.rounds[0], fan.rounds.at(-1)])].filter(Boolean);
    const p = this.#track(Promise.all(dates.map((date) => getJson("/api/next/surveillance", { target: fan.target, location: fan.location, date }))), sk, (rs) => {
      const w1 = seasonWeek1(+fan.season.slice(0, 4)), w2 = w1 + 52 * WEEK;
      let ref = 0;
      for (const o of fan.observed) if (o.v > ref) ref = o.v;
      if (!(ref > 0)) ref = fan.yMax([]);
      const lines = new Map();
      // NSSP is the ED-visits target's own source: drawn there it would only repeat the observed line
      const edTarget = /ed visits/i.test(fan.target);
      for (const L of SIGNALS) {
        if (L.id === "nssp" && edTarget) continue;
        const by = new Map();
        for (const r of rs) for (const d of r?.[L.key]?.data || []) { const t = parseIso(d.date), v = d[L.field]; if (t >= w1 && t < w2 && Number.isFinite(v)) by.set(t, v); }
        let max = 0;
        for (const v of by.values()) if (v > max) max = v;
        if (!(max > 0)) continue;
        const line = makeLine([...by].map(([t, v]) => ({ t, v })), { id: L.id, kind: "signal", name: L.name, end: L.end, unit: L.unit, k: ref / max, k0: ref / max, ref, c: "var(--ink-tertiary)", alpha: 0.9 });
        if (line) lines.set(L.id, line);
      }
      this.sig = { lines, asof: !!rs.at(-1)?.as_of?.available };
      this.#fit();
    });
    this._sigP = { sk, p };
    return p;
  }

  // earlier seasons' observed data for this target and place, moved onto this season's calendar
  #loadCurves() {
    if (this.cur || this._curP?.sk === this.sk) return this._curP?.p;
    const fan = this.chart.fan, sk = this.sk, y = +fan.season.slice(0, 4);
    const seasons = Array.from({ length: PAST }, (_, i) => `${y - 1 - i}-${y - i}`).join(",");
    const p = this.#track(getJson("/api/season-curves", { target: fan.target, location: fan.location, seasons }), sk, (r) => {
      const w1 = seasonWeek1(y);
      const curves = (r?.curves || []).filter((c) => +String(c.season).slice(0, 4) < y)
        .sort((a, b) => String(b.season).localeCompare(String(a.season))).slice(0, PAST);
      this.cur = curves.map((c, i) => makeLine((c.points || []).map((p) => ({ t: w1 + (p.week - 1) * WEEK, v: p.value })),
        { id: `season-${c.season}`, kind: "season", name: seasonLabel(c.season), end: seasonLabel(c.season), c: "var(--ink-tertiary)", alpha: SEASON_ALPHA[i] ?? 0.2 })).filter(Boolean);
      if (this.on.has("seasons")) this.chart.rescale();
    });
    this._curP = { sk, p };
    return p;
  }

  // the as-published series for the round the chart is on (debounced while scrubbing through rounds)
  #loadAsof(iso) {
    const fan = this.chart.fan;
    if (!iso || fan.indexOf(iso) < 0 || this.wanted.asof === iso) return;
    this.wanted.asof = iso;
    clearTimeout(this._asofTimer);
    const sk = this.sk;
    this._asofTimer = setTimeout(() => {
      if (sk !== this.sk || this.wanted.asof !== iso) return;
      const ref = parseIso(iso);
      this.#track(getJson("/api/next/surveillance", { target: fan.target, location: fan.location, date: iso }), sk, (r) => {
        if (this.wanted.asof !== iso) return;
        const a = r?.as_of;
        const pts = a?.available ? (a.data || []).map((d) => ({ t: parseIso(d.date), v: d.value })).filter((p) => p.t < ref) : [];
        this.asof = { round: iso, line: makeLine(pts, { id: "asof", kind: "asof", name: "As reported", c: "var(--ink-tertiary)", alpha: 1, dash: ASOF_DASH }) };
      });
    }, this.asof ? 120 : 0);
  }

  // every round's peak forecasts this season for the models on the chart, in one request
  #loadPeaks() {
    const fan = this.chart.fan, ids = this.chart.opts.models.map((m) => m.id).sort();
    const key = `${this.sk}|${ids.join(",")}`;
    if (this.wanted.peaks === key) return this._peakP;
    this.wanted.peaks = key;
    const sk = this.sk;
    this._peakP = this.#track(getJson("/api/peaks", { target: fan.target, location: fan.location, date: fan.rounds.at(-1) || "", models: ids.join(",") }), sk, (r) => {
      if (this.wanted.peaks !== key) return;
      const byModel = new Map();
      for (const [id, rounds] of Object.entries(r?.rounds || {})) {
        const m = new Map();
        for (const x of rounds) {
          const t = x.timing, z = x.size;
          if (!t?.median || !Number.isFinite(z?.median)) continue;
          m.set(x.reference_date, { t: parseIso(t.median), tl: parseIso(t.i50?.[0]), th: parseIso(t.i50?.[1]), v: z.median, vl: z.i50?.[0], vh: z.i50?.[1] });
        }
        if (m.size) byModel.set(id, m);
      }
      const o = r?.observed;
      this.peaks = { key, available: !!r?.available, byModel, observed: o && Number.isFinite(o.value) ? { t: parseIso(o.date), v: o.value, final: !!o.final } : null };
    });
    return this._peakP;
  }

  // what exists here, for the menu: loads everything once (cached)
  #meta() { return Promise.allSettled([this.#loadSignals(), this.#loadCurves(), this.#loadPeaks()]); }

  /** true / false once known, undefined while not loaded */
  #has(id) {
    if (id === "seasons") return this.cur ? this.cur.length > 0 : undefined;
    if (id === "peaks") return this.peaks ? this.peaks.available : undefined;
    if (!this.sig) return undefined;
    return id === "asof" ? this.sig.asof : this.sig.lines.has(id);
  }

  /* ---------------- the pill and its menu ---------------- */

  #label() {
    let n = 0;
    for (const id of this.on) if (this.#has(id) !== false) n++;
    const text = n ? `${n} layer${n > 1 ? "s" : ""}` : "Layers";
    const lab = this.pill.querySelector(".c-pill-label");
    if (lab.textContent !== text) lab.textContent = text;
  }

  async #open() {
    if (activeLayer()?.anchor !== this.pill && this.chart.fan) {
      await Promise.race([this.#meta(), new Promise((r) => setTimeout(r, 600))]);
    }
    const { store } = this.chart.ctx, cur = new Set(store.get().layers || []);
    const toggle = (id) => {
      const next = new Set(store.get().layers || []);
      if (next.has(id)) next.delete(id); else next.add(id);
      store.set({ layers: parseLayers([...next]) });
    };
    const item = (l) => ({ label: l.label, toggle: true, checked: cur.has(l.id), onSelect: () => toggle(l.id) });
    const base = LAYERS.slice(0, 3).filter((l) => this.#has(l.id) !== false).map(item);
    const sig = SIGNALS.filter((l) => this.#has(l.id)).map(item);
    const items = [...base, ...(base.length && sig.length ? ["-"] : []), ...sig];
    if (!items.length) items.push({ label: "None here", disabled: true });
    items.push("-", { label: "About layers", onSelect: () => guide(sig.length ? "surveillance" : "as-reported") });
    openMenu(this.pill, { placement: "top-start", label: "Layers", items });
  }

  /* ---------------- per frame ---------------- */

  /**
   * The layers' marks for a scene just laid out (reused objects and buffers; read by chart/render.js).
   * @param {object} scene from layoutFan
   * @returns {{ lines: object[], marks: object[], labels: object[], font: string } | null} null when nothing is drawn
   */
  layout(scene) {
    const M = this.marks, onL = this.on;
    M.lines.length = 0; M.marks.length = 0; M.labels.length = 0; M.axis = null;
    if (!onL.size || !this.chart.fan) return null;
    const { x, y } = scene, xc = x(scene.cutoff);
    const after = scene.outcome ? null : xc;   // without the outcome nothing observed after the cutoff
    const width = tokenNum("--stroke-layer", 1.25);
    const add = (line, clipX, w) => {
      if (!line) return;
      const { ts, vs, xy, n } = line;
      for (let i = 0; i < n; i++) { xy[2 * i] = x(ts[i]); xy[2 * i + 1] = y(vs[i]); }
      line.clipX = clipX; line.w = w;
      M.lines.push(line);
    };
    if (onL.has("seasons") && this.cur) for (const l of this.cur) add(l, null, tokenNum("--stroke-hairline", 1));
    if (this.sig) for (const L of SIGNALS) if (onL.has(L.id)) add(this.sig.lines.get(L.id), after, width);
    if (onL.has("asof") && this.sig?.asof && this.asof?.line) add(this.asof.line, xc, width);

    // end labels: where the line leaves the plot (left of the model labels), kept apart. With forecasts
    // drawn, no further than the data cutoff: the labels are right-aligned, so past it they would sit on
    // the bands and medians
    const fs = this.chart.opts.fonts;
    M.font = `500 ${fs?.micro ?? 11}px ${fs?.sans ?? "sans-serif"}`;
    let limit = scene.labels.length ? scene.labels[0].x - 14 : scene.w - 16;
    if (scene.series.length) limit = Math.min(limit, xc - 6);
    for (const l of M.lines) {
      if (!l.lab) continue;
      const lim = Math.min(limit, l.clipX ?? Infinity), xy = l.xy;
      let i = -1;
      for (let j = 0; j < l.n; j++) if (xy[2 * j] <= lim) i = j;
      if (i < 0) continue;
      let lx = xy[2 * i], ly = xy[2 * i + 1];
      if (i + 1 < l.n && !l.brk[i + 1]) {
        const x1 = xy[2 * i + 2], u = (lim - lx) / (x1 - lx);
        lx = lim; ly += (xy[2 * i + 3] - ly) * u;
      }
      if (lx < scene.pad.l + 48 || ly < scene.topClear + 12 || ly > scene.ay - 4) continue;
      l.lab.x = lx; l.lab.y = ly - 5; l.lab.alpha = Math.min(1, l.alpha + 0.3);
      M.labels.push(l.lab);
    }
    M.labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < M.labels.length; i++) {
      const a = M.labels[i - 1], b = M.labels[i];
      if (b.y - a.y < LABEL_GAP && Math.abs(b.x - a.x) < 120) b.y = a.y + LABEL_GAP;
    }

    if (onL.has("peaks") && this.peaks) this.#peakMarks(scene, xc);
    if (this.right && M.lines.includes(this.right)) this.#rightAxis(scene);
    return M.lines.length || M.marks.length ? M : null;
  }

  /* The one signal's axis: its values at the left axis's labelled gridlines, right-aligned at the right
   * edge, above their lines. Hidden under the "Showing 5 of 9" note and where a model label sits. */
  #rightAxis(scene) {
    const l = this.right, ticks = this.axisTicks, x = scene.w - scene.tickX;
    const note = this.chart.bubbles?.note;
    const clear = note?.classList.contains("is-shown") ? note.offsetTop + note.offsetHeight : -Infinity;
    ticks.length = 0;
    for (const d of scene.ticks) {
      if (d.text == null) continue;
      const ty = d.y - 6;
      if (ty - 12 < clear) continue;
      const text = String(+(d.v / l.k).toPrecision(4)), x0 = x - text.length * AXIS_CHAR - 6;
      if (scene.labels.some((b) => b.x + 10 + b.len > x0 && Math.abs(b.y - (ty - 4)) < 12)) continue;
      ticks.push({ y: ty, text });
    }
    // the topmost tick names the unit, so the axis reads on its own when the end label is hidden
    let top = null;
    for (const d of ticks) if (!top || d.y < top.y) top = d;
    if (top) top.text = `${l.end} · ${top.text}`;
    this.marks.axis = { x, ticks };
  }

  #peakMarks(scene, xc) {
    const fan = this.chart.fan, P = this.peaks, M = this.marks, { x, y } = scene;
    const r = fan.roundAt[scene.di], round = r >= 0 ? fan.rounds[r] : null;
    if (round) {
      for (const m of scene.medians) {
        const p = P.byModel.get(m.id)?.get(round);
        if (!p) continue;
        M.marks.push({
          kind: "peak", x: x(p.t), y: y(p.v), c: m.c, alpha: m.alpha,
          x0: x(p.tl), x1: x(p.th), y0: Number.isFinite(p.vl) ? y(p.vl) : NaN, y1: Number.isFinite(p.vh) ? y(p.vh) : NaN,
        });
      }
    }
    const o = P.observed;
    if (o && (scene.outcome || x(o.t) <= xc)) M.marks.push({ kind: "observed", x: x(o.t), y: y(o.v), c: "var(--ink-secondary)", alpha: 1 });
  }

  /**
   * Readout rows for the visible layers at a hovered week.
   * @param {number} t the hovered week, ms
   * @param {object} scene the scene just drawn
   * @param {(v: number) => string} value the target's value format
   * @returns {{ name: string, value: string, mark: "line" | "dash" | "dot" | "peak", c: string }[]}
   */
  rows(t, scene, value) {
    const out = [], onL = this.on;
    if (!onL.size || !this.chart.fan) return out;
    const seen = scene.outcome || t <= scene.cutoff;
    const line = (l, v, text) => { if (v !== undefined) out.push({ name: l.name, value: text(v), mark: l.dash ? "dash" : "line", c: l.c }); };
    if (onL.has("asof") && this.sig?.asof && this.asof?.line && t <= scene.cutoff) line(this.asof.line, valueAt(this.asof.line, t), value);
    if (this.sig) for (const L of SIGNALS) {
      const l = onL.has(L.id) && seen && this.sig.lines.get(L.id);
      if (l) line(l, valueAt(l, t), (v) => `${+v.toFixed(2)}${l.unit}`);
    }
    if (onL.has("peaks") && this.peaks) {
      const fan = this.chart.fan, r = fan.roundAt[scene.di], round = r >= 0 ? fan.rounds[r] : null;
      if (round) for (const s of scene.series) {
        const p = this.peaks.byModel.get(s.id)?.get(round);
        if (p && Math.abs(p.t - t) < WEEK / 2) out.push({ name: `${s.label} peak`, value: value(p.v), mark: "peak", c: s.c });
      }
      const o = this.peaks.observed;
      if (o && Math.abs(o.t - t) < WEEK / 2 && (scene.outcome || o.t <= scene.cutoff)) out.push({ name: o.final ? "Season peak" : "Peak so far", value: value(o.v), mark: "dot", c: "var(--ink-secondary)" });
    }
    if (onL.has("seasons") && this.cur) for (const l of this.cur) line(l, valueAt(l, t), value);
    return out;
  }

  destroy() {
    clearTimeout(this._asofTimer);
    this.offs.forEach((off) => off());
    this.glass.destroy();
    this.pill.remove();
  }
}
