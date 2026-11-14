/* The peaks section: when the season peaks and how high, as forecast on the chart's round at the
 * chart's location, against what was observed and against past seasons. Below the outlook: a table
 * (this round's calls, or season skill), one model's calls round by round, and its peak map.
 * Only for targets with peak forecasts; otherwise one quiet line. */
import { onThemeChange, cssColor, token } from "../../lib/dom.js";
import { scopeOf, setScope } from "../scope.js";
import { valueFormat, fmtDay, fmtLong, fmtMonth } from "../../lib/format.js";
import { parseIso, linear, niceStep, ticks, monthStarts, DAY, WEEK } from "../../lib/scale.js";
import { chartFonts } from "../../chart/render.js";
import { slotOf, COLORS } from "../../features/selection.js";
import { TILES, COLUMNS } from "../../features/LocationPicker.js";
import {
  h, on, linkStyle, frame, fragment, setLine, getJson, query, isAbort, sequential, inkOn, resetColors, places,
  fitCanvas, perFrame, pointerReadout, readoutContent, onScreen, onDprChange, viewState,
} from "../shared.js";

const KEY = "viz.peaks";
const PAD = { l: 148, r: 24, t: 16 };
const MAIN_H = 280, LANE_MAX = 26, LANE_MIN = 12, EVO_ROW = 18;
const fin = (x) => typeof x === "number" && Number.isFinite(x);
const T = (iso) => parseIso(iso);

/** @returns {{ destroy(): void }} */
export function mount(el, ctx) {
  linkStyle("peaks"); linkStyle("map");
  const { manifest, store } = ctx;
  const P = places(manifest);
  const f = frame(el, "Peaks");
  const vs = viewState(store, "peaks", KEY);
  const saved = vs.initial;
  const opt = { table: saved.table === "skill" ? "skill" : "round", scope: saved.scope === "states" ? "states" : "location", layer: saved.layer === "size" ? "size" : "week", model: null };
  let resp = null, curves = null, curvesKey = "", pmap = null, reqKey = "", shown = [], legacy = false;
  const slots = { peaks: {}, curves: {}, map: {} };
  const save = () => vs.write({ table: opt.table, scope: opt.scope, layer: opt.layer }, opt.table === "round" && opt.scope === "location" && opt.layer === "week");
  // skill on shared rounds only: the scope's fair setting, as the scores (and old viz) use it
  const fair = () => scopeOf(store.get(), manifest).fair;
  const target = () => manifest.targetById.get(store.get().target);
  const vf = () => valueFormat(target());

  // ---------------------------------------------------------------- the control line
  const withRounds = () => shown.filter((id) => resp?.rounds?.[id]?.length);
  const F = {
    model: fragment({ label: "Model", title: "Model for calls by round and the map", items: () => withRounds().map((id) => ({ value: id, label: manifest.label(id, shown) })),
      value: () => opt.model, onSelect: (v) => { opt.model = v; syncLine(); loadMap(); renderEvo(); } }),
    table: fragment({ label: "Table", title: "Table", items: () => [{ value: "round", label: "This round" }, { value: "skill", label: "Season skill" }],
      value: () => opt.table, isDefault: () => opt.table === "round", onSelect: (v) => { opt.table = v; save(); syncLine(); renderTable(); } }),
    scope: fragment({ label: "Scope", title: "Skill over", items: () => [{ value: "location", label: "This place" }, { value: "states", label: "All states" }],
      value: () => opt.scope, isDefault: () => opt.scope === "location", onSelect: (v) => { opt.scope = v; save(); load(); } }),
    common: fragment({ label: "Rounds", title: "Skill on", items: () => [{ value: false, label: "Each model's rounds" }, { value: true, label: "Shared rounds only" }],
      value: fair, isDefault: () => !fair(), onSelect: (v) => setScope(store, { fair: v }) }),
    layer: fragment({ label: "Map", title: "Peak map", items: () => [{ value: "week", label: "Peak week" }, { value: "size", label: "Peak size / 100k" }],
      value: () => opt.layer, isDefault: () => opt.layer === "week", onSelect: (v) => { opt.layer = v; save(); renderMap(); } }),
  };
  function syncLine() {
    Object.values(F).forEach((b) => b.sync());
    setLine(f.line, [withRounds().length && F.model, F.table, opt.table === "skill" && F.scope, opt.table === "skill" && F.common, F.layer]);
  }

  // ---------------------------------------------------------------- the page
  const note = h("p", { class: "v-note pk-note" });
  const fig = h("div", { class: "pk-fig" });
  const canvas = h("canvas", { class: "pk-canvas", role: "img" });
  fig.append(canvas);
  const readout = pointerReadout(fig);
  const tableWrap = h("div", { class: "pk-table" });
  const evoFig = h("div", { class: "pk-fig" });
  const evo = h("canvas", { class: "pk-evo", role: "img" });
  evoFig.append(evo);
  const evoReadout = pointerReadout(evoFig);
  const mapGrid = h("div", { class: "mp-grid pk-map", style: { "--cols": COLUMNS, "--rows": 8 } });
  const mapNote = h("p", { class: "v-note" });
  const evoHead = h("p", { class: "v-sub" }), mapHead = h("p", { class: "v-sub" });
  f.body.append(note, fig, tableWrap,
    h("div", { class: "pk-lower" },
      h("div", { class: "pk-evo-col" }, evoHead, evoFig),
      h("div", { class: "pk-map-col" }, mapHead, mapGrid, mapNote)));
  const tiles = new Map();
  for (const [abbr, [c, r]] of Object.entries(TILES)) {
    const loc = P.byAbbr.get(abbr);
    if (!loc) continue;
    const b = h("button", { type: "button", class: "mp-tile", style: { gridColumn: c + 1, gridRow: r + 1 }, "aria-label": loc.name, onclick: () => store.set({ location: loc.id }) },
      h("span", { class: "mp-abbr" }, abbr), h("span", { class: "mp-val" }));
    tiles.set(abbr, b); mapGrid.append(b);
  }

  // ---------------------------------------------------------------- loading
  /* The selected models (and the baseline) first; when none of them forecast peaks this round, every
   * model (models=all). The second ask only happens on such rounds, and never sends 200 ids. */
  const mine = () => [...new Set([...store.get().sel.selected, manifest.baseline].filter(Boolean))];
  const forecasts = (j) => (j?.models || []).some((m) => m.has_round && (m.timing || m.size));
  function load(force) {
    force = force === true;
    const s = store.get();
    const base = { target: s.target, location: s.location, date: s.date, skill_scope: opt.scope, common: fair() ? "1" : null };
    const ids = mine();
    const urlFor = (models) => `/api/peaks?${query({ ...base, models })}`;
    const allIds = () => manifest.models.map((m) => m.id).join(",");
    const key = query({ ...base, models: ids.join(",") });
    const ck = query({ target: s.target, location: s.location });
    if (ck !== curvesKey) {
      curvesKey = ck; curves = null;
      getJson(`/api/season-curves?${ck}`, { slot: slots.curves })
        .then((j) => { if (ck === curvesKey) { curves = j; draw(); } }, (e) => { if (!isAbort(e) && ck === curvesKey) curves = null; });
    }
    if (key === reqKey && resp && !force) { render(); return; }
    reqKey = key;
    f.loading(true);
    const fail = (e) => {
      if (isAbort(e) || key !== reqKey) return;
      f.loading(false); resp = null;
      f.empty("Can't load peak forecasts", () => load(true));
    };
    const done = (j) => {
      if (key !== reqKey) return;
      resp = j; f.loading(false);
      choose(); render(); loadMap();
    };
    getJson(urlFor(ids.join(",")), { slot: slots.peaks }).then((j) => {
      if (key !== reqKey) return;
      if (!ids.length || forecasts(j) || !j.available) { done(j); return; }
      getJson(urlFor(legacy ? allIds() : "all"), { slot: slots.peaks }).then((k) => {
        // a server from before models=all reads "all" as an unknown model
        if (!legacy && (k.missing || []).includes("all")) { legacy = true; return getJson(urlFor(allIds()), { slot: slots.peaks }).then(done); }
        done(k);
      }).catch(fail);
    }, fail);
  }
  function loadMap() {
    const s = store.get();
    if (!opt.model || !resp?.available) { pmap = null; renderMap(); return; }
    getJson(`/api/peak-map?${query({ target: s.target, date: s.date, model: opt.model })}`, { slot: slots.map })
      .then((j) => { pmap = j; renderMap(); }, (e) => { if (!isAbort(e)) { pmap = null; renderMap(); } });
  }

  /* Which models: the selected ones that forecast peaks this round; when none do, every model that does. */
  function choose() {
    const s = store.get();
    const here = (resp?.models || []).filter((m) => m.has_round && (m.timing || m.size)).map((m) => m.model_id);
    const sel = new Set([...s.sel.selected, manifest.baseline]);
    const mine = here.filter((id) => sel.has(id));
    shown = mine.length ? mine : here;
    shown.fallback = !mine.length && here.length > 0;
    const ok = withRounds();
    if (!ok.includes(opt.model)) opt.model = ok.find((id) => /ensemble/i.test(id)) ?? ok[0] ?? null;
  }

  // ---------------------------------------------------------------- colors
  function colorOf(id) {
    const s = store.get(), sl = slotOf(s.sel, id);
    if (id === manifest.baseline) return cssColor("var(--series-baseline)");
    return cssColor(sl == null ? "var(--ink-secondary)" : `var(--series-${(sl % COLORS) + 1})`);
  }
  const alpha = (rgb, a) => rgb.replace(/^rgb\(([^)]+)\)$/, `rgba($1, ${a})`);
  const modelById = () => new Map((resp?.models || []).map((m) => [m.model_id, m]));

  // ---------------------------------------------------------------- render
  function render() {
    syncLine();
    if (!resp) return;
    const t = target();
    if (!resp.available) { f.empty(`No peak forecasts · ${t?.short ?? resp.base_target}`); return; }
    if (!shown.length) {
      const s = store.get(), near = nearest(resp.peak_rounds, s.date) || resp.latest_peak_round;
      f.empty(`No peak forecasts · ${fmtLong(T(s.date))}`);
      if (near) {
        const msg = el.querySelector(".v-empty");
        msg.append(" · ", h("button", { type: "button", class: "c-link", onclick: () => store.set({ date: near }) }, `Go to ${fmtDay(T(near))}`));
      }
      return;
    }
    f.empty(null);
    renderNote();
    draw();
    renderTable();
    renderEvo();
    renderMap();
  }
  const nearest = (isos, iso) => (isos?.length ? isos.reduce((a, b) => (Math.abs(T(b) - T(iso)) < Math.abs(T(a) - T(iso)) ? b : a)) : null);

  function renderNote() {
    const o = resp.observed, V = vf();
    const parts = [resp.location_name, manifest.seasonById.get(resp.season)?.label ?? resp.season];
    let obs = "No observations yet";
    if (o?.value != null) obs = o.final ? ["Observed peak ", h("b", null, V.value(o.value)), ` · ${fmtLong(T(o.date))}`]
      : ["Peak so far ", h("b", null, V.value(o.value)), ` · ${fmtDay(T(o.date))} · provisional until ${fmtDay(T(o.window[1]))}`];
    note.replaceChildren(parts.join(" · "), " · ", ...[obs].flat(), shown.fallback ? " · none selected · all models" : "");
  }

  // ---------------------------------------------------------------- the outlook
  let lay = null;
  function draw() {
    if (!resp?.available || !shown.length || f.body.hidden) return;
    const width = f.body.clientWidth || el.clientWidth, M = modelById(), V = vf(), Fo = chartFonts();
    const lanes = shown.filter((id) => M.get(id)?.timing);
    const lane = Math.max(LANE_MIN, Math.min(LANE_MAX, Math.floor(260 / Math.max(1, lanes.length))));
    const ridgeTop = PAD.t + MAIN_H + 28, ridgeH = lanes.length * lane;
    const height = ridgeTop + ridgeH + 28;
    const g = fitCanvas(canvas, width, height);
    const [w0, w1] = resp.window.map(T);
    const x = linear([w0 - 21 * DAY, w1 + 10 * DAY], [PAD.l, width - PAD.r]);
    const truth = (resp.truth || []).map((p) => ({ t: T(p.date), v: p.value })).filter((p) => p.t >= x.domain()[0] && p.t <= x.domain()[1]);
    let top = Math.max(1, ...truth.map((p) => p.v), resp.observed?.value || 0);
    for (const id of shown) { const sz = M.get(id)?.size; if (sz?.i50) top = Math.max(top, sz.i50[1]); }
    const past = pastCurves(x);
    for (const c of past) for (const p of c.pts) top = Math.max(top, p.v);
    const step = niceStep(top * 1.1, 4), yMax = Math.ceil((top * 1.1) / step) * step;
    const y = linear([0, yMax], [PAD.t + MAIN_H, PAD.t]);
    const ink1 = cssColor("var(--ink-primary)"), ink2 = cssColor("var(--ink-secondary)"), ink3 = cssColor("var(--ink-tertiary)"), faint = cssColor("var(--ink-faint)");
    const hair = cssColor("var(--line-hairline)"), axis = cssColor("var(--line-axis)");
    const mono = `${Fo.axis}px ${Fo.mono}`, sans = `${Fo.chart}px ${Fo.sans}`;
    g.lineJoin = "round"; g.lineCap = "round";

    // grid and y labels
    g.font = mono; g.textBaseline = "middle"; g.textAlign = "right";
    for (const v of ticks(0, yMax, step)) {
      g.strokeStyle = v ? hair : axis; g.lineWidth = 1;
      g.beginPath(); g.moveTo(PAD.l, Math.round(y(v)) + 0.5); g.lineTo(width - PAD.r, Math.round(y(v)) + 0.5); g.stroke();
      g.fillStyle = ink3; g.fillText(V.axis(v), PAD.l - 10, y(v));
    }
    // month labels under the ridges
    g.textAlign = "left";
    for (const m of monthStarts(...x.domain())) {
      g.fillStyle = ink3; g.fillText(fmtMonth(m), x(m) + 3, height - 10);
      g.strokeStyle = hair; g.beginPath(); g.moveTo(Math.round(x(m)) + 0.5, ridgeTop - 8); g.lineTo(Math.round(x(m)) + 0.5, height - 20); g.stroke();
    }
    // the data cutoff → round, as on the chart
    const ref = T(resp.reference_date), cut = T(resp.data_cutoff);
    g.fillStyle = token("--shade-forecast") || "transparent";
    g.fillRect(x(cut), PAD.t, width - PAD.r - x(cut), MAIN_H);
    g.strokeStyle = ink3; g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(Math.round(x(ref)) + 0.5, PAD.t); g.lineTo(Math.round(x(ref)) + 0.5, height - 20); g.stroke();
    g.setLineDash([]);
    const rl = `Round ${fmtDay(ref)}`, rw = g.measureText(rl).width;
    g.fillStyle = ink3; g.textAlign = x(ref) + 5 + rw > width ? "right" : "left"; g.fillText(rl, g.textAlign === "right" ? x(ref) - 5 : x(ref) + 5, PAD.t + 6); g.textAlign = "left";

    // past seasons: faint, labelled at their peak
    g.lineWidth = 1;
    for (const c of past) {
      g.strokeStyle = faint; g.beginPath();
      c.pts.forEach((p, i) => (i ? g.lineTo(x(p.t), y(p.v)) : g.moveTo(x(p.t), y(p.v))));
      g.stroke();
      const pk = c.pts.reduce((a, b) => (b.v > a.v ? b : a));
      g.fillStyle = ink3; g.font = mono; g.textAlign = "center"; g.fillText(c.label, x(pk.t), y(pk.v) - 8);
    }
    // observed: solid through the cutoff, dashed after
    const lineOf = (pts) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(x(p.t), y(p.v)) : g.moveTo(x(p.t), y(p.v)))); g.stroke(); };
    g.lineWidth = 1.5; g.strokeStyle = ink1; lineOf(truth.filter((p) => p.t <= cut));
    g.setLineDash([3, 3]); g.strokeStyle = ink3; lineOf(truth.filter((p) => p.t >= cut - WEEK)); g.setLineDash([]);

    // each model's call: a box (50% timing × 50% size), 90% whiskers, ▲ at the medians
    const marks = [];
    for (const id of shown) {
      const m = M.get(id), c = colorOf(id), tm = m?.timing, sz = m?.size;
      if (!sz || !fin(sz.median)) continue;
      if (!tm) {
        g.strokeStyle = alpha(c, 0.7); g.setLineDash([4, 3]); g.lineWidth = 1;
        g.beginPath(); g.moveTo(x(w0), y(sz.median)); g.lineTo(x(w1), y(sz.median)); g.stroke(); g.setLineDash([]);
        continue;
      }
      const mx = x(T(tm.median)), my = y(sz.median);
      if (tm.i50 && sz.i50) {
        const bx0 = x(T(tm.i50[0]) - 3.5 * DAY), bx1 = x(T(tm.i50[1]) + 3.5 * DAY), by0 = y(sz.i50[1]), by1 = y(sz.i50[0]);
        g.fillStyle = alpha(c, 0.1); g.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
        g.strokeStyle = alpha(c, 0.5); g.lineWidth = 1; g.strokeRect(bx0 + 0.5, by0 + 0.5, bx1 - bx0 - 1, by1 - by0 - 1);
      }
      g.strokeStyle = alpha(c, 0.75); g.lineWidth = 1;
      if (tm.i90) { g.beginPath(); g.moveTo(x(T(tm.i90[0])), my); g.lineTo(x(T(tm.i90[1])), my); g.stroke(); }
      if (sz.i90) { g.beginPath(); g.moveTo(mx, Math.max(PAD.t, y(sz.i90[1]))); g.lineTo(mx, y(sz.i90[0])); g.stroke(); }
      g.fillStyle = c; g.beginPath(); g.moveTo(mx, my - 6); g.lineTo(mx + 5.5, my + 4); g.lineTo(mx - 5.5, my + 4); g.closePath(); g.fill();
      marks.push({ id, x: mx, y: my });
    }
    // the observed peak: ★ when final, ◇ while provisional
    const o = resp.observed;
    if (o?.value != null) {
      const ox = x(T(o.date)), oy = y(o.value);
      g.fillStyle = ink1; g.strokeStyle = ink1; g.lineWidth = 1.25;
      if (o.final) star(g, ox, oy, 6.5); else { g.beginPath(); g.moveTo(ox, oy - 6); g.lineTo(ox + 6, oy); g.lineTo(ox, oy + 6); g.lineTo(ox - 6, oy); g.closePath(); g.stroke(); }
      g.strokeStyle = alpha(ink1, 0.5); g.setLineDash(o.final ? [] : [2, 3]);
      g.beginPath(); g.moveTo(Math.round(ox) + 0.5, ridgeTop - 6); g.lineTo(Math.round(ox) + 0.5, height - 20); g.stroke(); g.setLineDash([]);
    }

    // ridges: each model's peak-week probabilities, stepped, sharing the date axis
    let pmax = 0.05;
    for (const id of lanes) pmax = Math.max(pmax, ...M.get(id).timing.probs);
    g.font = sans; g.textAlign = "right"; g.textBaseline = "middle";
    g.fillStyle = ink3; g.font = `${Fo.micro}px ${Fo.sans}`; g.textAlign = "left";
    g.fillText("Peak week", 0, ridgeTop - 14);
    lanes.forEach((id, i) => {
      const tm = M.get(id).timing, c = colorOf(id), base = ridgeTop + (i + 1) * lane;
      const k = (lane * 1.6) / pmax;
      g.beginPath(); g.moveTo(x(T(tm.dates[0]) - 3.5 * DAY), base);
      tm.dates.forEach((d, j) => { const t0 = T(d) - 3.5 * DAY, yy = base - tm.probs[j] * k; g.lineTo(x(t0), yy); g.lineTo(x(t0 + WEEK), yy); });
      g.lineTo(x(T(tm.dates.at(-1)) + 3.5 * DAY), base); g.closePath();
      g.fillStyle = alpha(c, 0.28); g.fill(); g.strokeStyle = alpha(c, 0.85); g.lineWidth = 1; g.stroke();
      g.strokeStyle = c; g.lineWidth = 2; g.beginPath(); g.moveTo(x(T(tm.median)), base); g.lineTo(x(T(tm.median)), base - lane * 0.85); g.stroke();
      g.fillStyle = ink2; g.font = sans; g.textAlign = "right";
      g.fillText(clip(g, manifest.label(id, shown), PAD.l - 16), PAD.l - 10, base - lane / 2);
    });
    lay = { x, y, marks, lanes, lane, ridgeTop, M };
    canvas.setAttribute("aria-label", `Season peak forecasts · ${shown.length} models · ${resp.location_name}`);
  }
  function star(g, cx, cy, r) {
    g.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r; g.lineTo(cx + rr * Math.cos(a), cy + rr * Math.sin(a)); }
    g.closePath(); g.fill();
  }
  function clip(g, text, w) {
    if (g.measureText(text).width <= w) return text;
    let s = text;
    while (s.length > 1 && g.measureText(`${s}…`).width > w) s = s.slice(0, -1);
    return `${s}…`;
  }
  /* Past seasons on this season's calendar: week n of that season drawn at week n of this one. */
  function pastCurves(x) {
    if (!curves?.curves?.length) return [];
    const cur = curves.curves.find((c) => c.season === resp.season);
    const start = cur?.points?.[0] ? T(cur.points[0].date) - (cur.points[0].week - 1) * WEEK : null;
    if (start == null) return [];
    const [d0, d1] = x.domain();
    return curves.curves.filter((c) => c.season !== resp.season && c.points?.length).slice(0, 3).map((c) => ({
      label: manifest.seasonById.get(c.season)?.label ?? c.season,
      pts: c.points.map((p) => ({ t: start + (p.week - 1) * WEEK, v: p.value })).filter((p) => fin(p.v) && p.t >= d0 && p.t <= d1),
    })).filter((c) => c.pts.length > 1);
  }

  // hover: a ▲ (its call) or a ridge (that week's probability)
  function outlookHover(e) {
    if (!lay) return;
    const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, V = vf();
    const mark = lay.marks.find((m) => Math.hypot(m.x - px, m.y - py) < 9);
    if (mark) {
      const m = lay.M.get(mark.id), tm = m.timing, sz = m.size;
      readout.show(px, py, readoutContent(manifest.label(mark.id, shown), [
        ["Peak week", fmtDay(T(tm.median))],
        tm.i50 && ["50%", `${fmtDay(T(tm.i50[0]))}–${fmtDay(T(tm.i50[1]))}`, true],
        ["Peak size", V.value(sz.median)],
        sz.i90 && ["90%", `${V.value(sz.i90[0])}–${V.value(sz.i90[1])}`, true],
        fin(tm.p_passed) && ["Already past", `${Math.round(tm.p_passed * 100)}%`, true],
      ]));
      return;
    }
    const i = Math.floor((py - lay.ridgeTop) / lay.lane);
    if (py > lay.ridgeTop && i >= 0 && i < lay.lanes.length && px > PAD.l) {
      const id = lay.lanes[i], tm = lay.M.get(id).timing, t = lay.x.invert(px);
      const j = tm.dates.findIndex((d) => Math.abs(T(d) - t) <= 3.5 * DAY);
      if (j >= 0) { readout.show(px, py, readoutContent(manifest.label(id, shown), [[`Peak in week of ${fmtDay(T(tm.dates[j]))}`, `${(tm.probs[j] * 100).toFixed(1)}%`]])); return; }
    }
    readout.hide();
  }

  // ---------------------------------------------------------------- the table
  function renderTable() {
    if (!resp?.available || !shown.length) return;
    const V = vf(), M = modelById(), final = !!resp.observed?.final;
    const name = (id) => h("span", { class: "v-name", style: store.get().sel.charted.some((c) => c.id === id) || id === manifest.baseline ? { "--c": colorOf(id) } : null, title: manifest.label(id) }, h("i"), manifest.label(id, shown));
    const num = (v, cls) => h("td", { class: ["num", cls] }, v);
    if (opt.table === "round") {
      const rows = shown.map((id) => M.get(id)).filter(Boolean)
        .sort((a, b) => (a.timing ? T(a.timing.median) : Infinity) - (b.timing ? T(b.timing.median) : Infinity));
      const head = ["Model", "Peak week", "50%", "Past", "Peak size", "90%", ...(final ? ["Δ wks", "RPS", "Size err"] : [])];
      tableWrap.replaceChildren(h("table", { class: "v-table" },
        h("thead", null, h("tr", null, head.map((x) => h("th", null, x)))),
        h("tbody", null, rows.map((m) => {
          const tm = m.timing, sz = m.size, sc = m.scores;
          return h("tr", null, h("td", null, name(m.model_id)),
            num(tm ? fmtDay(T(tm.median)) : "–"),
            num(tm?.i50 ? `${fmtDay(T(tm.i50[0]))}–${fmtDay(T(tm.i50[1]))}` : "–", "quiet"),
            num(fin(tm?.p_passed) ? `${Math.round(tm.p_passed * 100)}%` : "–", "quiet"),
            num(sz ? V.value(sz.median) : "–"),
            num(sz?.i90 ? `${V.compact(sz.i90[0])}–${V.compact(sz.i90[1])}` : "–", "quiet"),
            ...(final ? [
              num(fin(sc?.timing?.week_error) ? signed(sc.timing.week_error, 0) : "–", sc?.timing?.week_error === 0 ? "lead" : null),
              num(fin(sc?.timing?.rps) ? sc.timing.rps.toFixed(2) : "–"),
              num(fin(sc?.size?.pct_error) ? `${signed(sc.size.pct_error, 0)}%` : "–"),
            ] : []));
        }))));
      return;
    }
    const sk = resp.skill;
    if (!sk?.final) {
      tableWrap.replaceChildren(h("p", { class: "v-note" }, `Not final yet · scored after ${fmtLong(T(sk?.window_end || resp.window[1]))}`));
      return;
    }
    const ids = new Set(shown);
    const rows = (sk.models || []).filter((m) => ids.has(m.model_id));
    if (!rows.length) { tableWrap.replaceChildren(h("p", { class: "v-note" }, sk.common ? "No rounds shared by these models" : "No season skill for these models")); return; }
    const best = (k) => Math.min(...rows.map((m) => m[k]).filter(fin));
    const B = { rps: best("rps"), log_score: best("log_score"), abs_week_error: best("abs_week_error"), size_wis_pct: best("size_wis_pct") };
    const pct = (v) => (fin(v) ? `${Math.round(v * 100)}%` : "–");
    const cell = (m, k, d) => num(fin(m[k]) ? m[k].toFixed(d) : "–", m[k] === B[k] ? "lead" : null);
    tableWrap.replaceChildren(h("table", { class: "v-table" },
      h("thead", null, h("tr", null, ["Model", "N", "RPS", "Log", "|Δ| wks", "Hit 50/90", "WIS %", "|Err|", "Cov 50/90"].map((x) => h("th", null, x)))),
      h("tbody", null, rows.map((m) => h("tr", null, h("td", null, name(m.model_id)),
        num(String(m.n_timing || m.n_size || 0), "quiet"), cell(m, "rps", 2), cell(m, "log_score", 2), cell(m, "abs_week_error", 1),
        num(`${pct(m.timing_in50)} / ${pct(m.timing_in90)}`, "quiet"), cell(m, "size_wis_pct", 1),
        num(fin(m.size_abs_pct_error) ? `${Math.round(m.size_abs_pct_error)}%` : "–"),
        num(`${pct(m.size_in50)} / ${pct(m.size_in90)}`, "quiet"))))),
    h("p", { class: "v-note" }, [
      sk.scope === "states" ? `${sk.locations} states with a final peak` : "Every round",
      sk.pending_locations ? `${sk.pending_locations} still provisional` : null,
    ].filter(Boolean).join(" · ")));
  }
  const signed = (v, d) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;

  // ---------------------------------------------------------------- calls by round
  let evoLay = null;
  function renderEvo() {
    const id = opt.model, rounds = resp?.rounds?.[id] || [];
    evoHead.textContent = id ? `By round · ${manifest.label(id, shown)}` : "";
    if (!id || !rounds.length || !resp?.available) { evo.hidden = true; evoLay = null; return; }
    evo.hidden = false;
    const width = Math.max(320, evoFig.parentElement.clientWidth || 600), Fo = chartFonts();
    const hgt = 22 + rounds.length * EVO_ROW + 8;
    const g = fitCanvas(evo, width, hgt);
    const split = Math.round(width * 0.64), [w0, w1] = resp.window.map(T);
    const x = linear([w0, w1], [64, split - 16]);
    let smax = resp.observed?.value || 0;
    for (const r of rounds) if (r.size?.i90) smax = Math.max(smax, r.size.i90[1]);
    const xs = linear([0, smax * 1.05 || 1], [split + 8, width - 8]);
    const c = colorOf(id), ink3 = cssColor("var(--ink-tertiary)"), ink1 = cssColor("var(--ink-primary)"), hair = cssColor("var(--line-hairline)");
    g.font = `${Fo.axis}px ${Fo.mono}`; g.textBaseline = "middle";
    g.fillStyle = ink3; g.textAlign = "left";
    g.fillText("Timing", 64, 8); g.fillText("Size", split + 8, 8);
    const cur = store.get().date;
    rounds.forEach((r, i) => {
      const yy = 22 + i * EVO_ROW + EVO_ROW / 2;
      if (r.reference_date === cur) { g.fillStyle = cssColor("var(--fill-hover)"); g.fillRect(0, yy - EVO_ROW / 2, width, EVO_ROW); }
      g.fillStyle = r.reference_date === cur ? ink1 : ink3; g.textAlign = "left";
      g.fillText(fmtDay(T(r.reference_date)), 0, yy);
      const tm = r.timing, sz = r.size;
      g.strokeStyle = hair; g.lineWidth = 1; g.beginPath(); g.moveTo(64, yy + EVO_ROW / 2 - 0.5); g.lineTo(width, yy + EVO_ROW / 2 - 0.5); g.stroke();
      if (tm?.i90) bar(g, x, T(tm.i90[0]), T(tm.i90[1]), tm.i50 ? T(tm.i50[0]) : NaN, tm.i50 ? T(tm.i50[1]) : NaN, T(tm.median), yy, c);
      if (sz?.i90) bar(g, xs, sz.i90[0], sz.i90[1], sz.i50?.[0], sz.i50?.[1], sz.median, yy, c);
    });
    const o = resp.observed;
    if (o?.value != null) {
      g.strokeStyle = ink1; g.setLineDash(o.final ? [] : [2, 3]); g.lineWidth = 1;
      [[x, T(o.date)], [xs, o.value]].forEach(([s, v]) => { g.beginPath(); g.moveTo(Math.round(s(v)) + 0.5, 16); g.lineTo(Math.round(s(v)) + 0.5, hgt - 4); g.stroke(); });
      g.setLineDash([]);
    }
    evoLay = { rounds, top: 22 };
    evo.setAttribute("aria-label", `${manifest.label(id)} · peak calls over ${rounds.length} rounds`);
  }
  function bar(g, s, lo90, hi90, lo50, hi50, med, yy, c) {
    g.strokeStyle = alpha(c, 0.55); g.lineWidth = 2; g.beginPath(); g.moveTo(s(lo90), yy); g.lineTo(s(hi90), yy); g.stroke();
    if (fin(lo50) && fin(hi50)) { g.lineWidth = 6; g.beginPath(); g.moveTo(s(lo50), yy); g.lineTo(s(hi50), yy); g.stroke(); }
    g.fillStyle = cssColor("var(--surface-paper)"); g.strokeStyle = c; g.lineWidth = 1.5;
    g.beginPath(); g.arc(s(med), yy, 3, 0, Math.PI * 2); g.fill(); g.stroke();
  }
  const evoRow = (e) => {
    if (!evoLay) return null;
    const r = evo.getBoundingClientRect(), i = Math.floor((e.clientY - r.top - evoLay.top) / EVO_ROW);
    return i >= 0 && i < evoLay.rounds.length ? { round: evoLay.rounds[i], x: e.clientX - r.left, y: e.clientY - r.top } : null;
  };

  // ---------------------------------------------------------------- peak map
  function renderMap() {
    const id = opt.model;
    mapHead.textContent = id ? `Peak map · ${opt.layer === "week" ? "peak week" : "peak size / 100k"}` : "";
    const locs = pmap?.locations || {}, here = P.abbrOf(store.get().location);
    const vals = new Map();
    for (const [fips, d] of Object.entries(locs)) {
      const abbr = P.abbrOf(fips);
      const v = opt.layer === "week" ? (d.timing?.median ? T(d.timing.median) : NaN) : d.size_per_100k;
      if (tiles.has(abbr) && fin(v)) vals.set(abbr, v);
    }
    const vs = [...vals.values()];
    mapGrid.hidden = !vs.length;
    const lo = Math.min(...vs), hi = Math.max(...vs);
    for (const [abbr, b] of tiles) {
      const v = vals.get(abbr), has = fin(v);
      const fill = has ? sequential(hi > lo ? (v - lo) / (hi - lo) : 0.5) : "";
      b.classList.toggle("has-value", has);
      b.classList.toggle("is-here", abbr === here);
      b.style.background = fill; b.style.color = has ? inkOn(fill) : "";
      b.lastChild.textContent = has ? (opt.layer === "week" ? fmtDay(v) : v.toFixed(1)) : "";
    }
    mapNote.textContent = vs.length ? (opt.layer === "week" ? `Earliest ${fmtDay(lo)} · latest ${fmtDay(hi)}` : `${lo.toFixed(1)}–${hi.toFixed(1)} per 100k`) : id ? "No peak map for this round" : "";
  }

  // ---------------------------------------------------------------- reacting
  const redraw = perFrame(() => { draw(); renderEvo(); });
  const ro = new ResizeObserver(redraw);
  ro.observe(f.body);
  const screen = onScreen(el);
  const offs = [
    () => ro.disconnect(),
    () => screen.off(),
    onDprChange(redraw),
    on(canvas, "pointermove", outlookHover),
    on(canvas, "pointerleave", () => readout.hide()),
    on(evo, "pointermove", (e) => {
      const hit = evoRow(e);
      evo.style.cursor = hit ? "pointer" : "";
      if (!hit) { evoReadout.hide(); return; }
      const r = hit.round, V = vf();
      evoReadout.show(hit.x, hit.y, readoutContent(`Round ${fmtDay(T(r.reference_date))}`, [
        r.timing && ["Peak week", fmtDay(T(r.timing.median))],
        r.timing?.i50 && ["50%", `${fmtDay(T(r.timing.i50[0]))}–${fmtDay(T(r.timing.i50[1]))}`, true],
        r.size && ["Peak size", V.value(r.size.median)],
        r.size?.i90 && ["90%", `${V.value(r.size.i90[0])}–${V.value(r.size.i90[1])}`, true],
      ]));
    }),
    on(evo, "pointerleave", () => evoReadout.hide()),
    on(evo, "click", (e) => { const hit = evoRow(e); if (hit) store.set({ date: hit.round.reference_date }); }),
    onThemeChange(() => { resetColors(); screen.run(load); }),
    // load() re-renders when its request is unchanged (a new selection's colors, say)
    store.on((s, prev, changed) => {
      const fairChanged = changed.has("scope") && !!prev.scope?.fair !== !!s.scope?.fair;
      if (["target", "location", "date", "sel"].some((k) => changed.has(k)) || fairChanged) screen.run(load);
    }),
  ];
  syncLine();
  load();
  return { destroy() { Object.values(slots).forEach((x) => x._ctl?.abort()); offs.forEach((off) => off()); } };
}
