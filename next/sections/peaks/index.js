/* The peaks section: when the season peaks and how high, as forecast on the chart's round at the
 * chart's location. One row per model — the peak-week distribution and the peak-size interval side by
 * side, the observed peak a line through both — under a season strip that shares the week axis and
 * shows the hovered row's box. Below: season skill and the peak map.
 * Only for targets with peak forecasts; otherwise one quiet line. */
import { onThemeChange, cssColor, tokenNum } from "../../lib/dom.js";
import { apiUrl } from "../../lib/api.js";
import { scopeOf, setScope } from "../scope.js";
import { valueFormat, fmtDay, fmtLong, fmtMonth } from "../../lib/format.js";
import { parseIso, linear, niceStep, niceMax, ticks, monthStarts, DAY, WEEK } from "../../lib/scale.js";
import { chartFonts } from "../../chart/render.js";
import { seriesColor } from "../../chart/layout.js";
import { slotOf, isCharted } from "../../features/selection.js";
import { TILES, COLUMNS, classifyHubGeo } from "../../geo/picker_geo.js";
import { EU_GRID_PROPORTIONED, EU_TILES_PROPORTIONED, EU_TILES_PROPORTIONED_UK_SPLIT } from "../../geo/eu_tiles.js";
import { poolWeeks, poolSize } from "./pool.js";
import { slideText } from "../../ui/controls.js";
import {
  h, on, linkStyle, frame, fragment, setLine, getJson, query, isAbort, sequential, diverging, inkOn, resetColors, places, fitLabels,
  fitCanvas, perFrame, pointerReadout, readoutContent, onScreen, onDprChange, viewState,
} from "../shared.js";

const KEY = "viz.peaks";
const NAME = 200, HIGH = 280, RIGHT = 248, ROW = 24, STRIP = 160, AXIS = 20, HEAD_AXIS = 16, PADX = 6, PADH = [4, 14];
const SORTS = ["when", "high", "name"];
const fin = (x) => typeof x === "number" && Number.isFinite(x);
const T = (iso) => parseIso(iso);
const HALF = 3.5 * DAY;

/** @returns {{ destroy(): void }} */
export function mount(el, ctx) {
  linkStyle("peaks"); linkStyle("map");
  const { manifest, store } = ctx;
  const P = places(manifest);
  const f = frame(el, "Peaks", "peaks");
  const vs = viewState(store, "peaks", KEY);
  const saved = vs.initial;
  const opt = {
    sort: SORTS.includes(saved.sort) ? saved.sort : "when", rev: !!saved.rev,
    scope: saved.scope === "states" ? "states" : "location", layer: saved.layer === "size" ? "size" : "week", model: null,
  };
  let resp = null, curves = null, curvesKey = "", pmap = null, reqKey = "", shown = [], legacy = false;
  const open = new Set();
  const slots = { peaks: {}, curves: {}, map: {} };
  const save = () => vs.write({ sort: opt.sort, rev: opt.rev, scope: opt.scope, layer: opt.layer },
    opt.sort === "when" && !opt.rev && opt.scope === "location" && opt.layer === "week");
  // skill on shared rounds only: the scope's fair setting, as the scores (and old viz) use it
  const fair = () => scopeOf(store.get(), manifest).fair;
  const target = () => manifest.targetById.get(store.get().target);
  const vf = () => valueFormat(target());

  // ---------------------------------------------------------------- fragments (in the sub-headings)
  const withRounds = () => shown.filter((id) => resp?.rounds?.[id]?.length);
  const F = {
    model: fragment({ label: "Model", title: "Model for the peak map", items: () => withRounds().map((id) => ({ value: id, label: manifest.label(id, shown) })),
      value: () => opt.model, onSelect: (v) => { opt.model = v; syncLines(); loadMap(); } }),
    layer: fragment({ label: "Map", title: "Peak map", items: () => [{ value: "week", label: "Peak week" }, { value: "size", label: "Peak size / 100k" }],
      value: () => opt.layer, isDefault: () => opt.layer === "week", onSelect: (v) => { opt.layer = v; save(); syncLines(); renderMap(); } }),
    scope: fragment({ label: "Scope", title: "Skill over", items: () => [{ value: "location", label: "This place" }, { value: "states", label: "All states" }],
      value: () => opt.scope, isDefault: () => opt.scope === "location", onSelect: (v) => { opt.scope = v; save(); load(); } }),
    common: fragment({ label: "Rounds", title: "Skill on", items: () => [{ value: false, label: "Each model's rounds" }, { value: true, label: "Shared rounds only" }],
      value: fair, isDefault: () => !fair(), onSelect: (v) => setScope(store, { fair: v }) }),
  };
  const subhead = (title) => { const line = h("span", { class: "v-line pe-subline" }); return { el: h("div", { class: "pe-subhead" }, h("span", { class: "pe-subtitle" }, title), line), line }; };
  const skillHead = subhead("Season skill"), mapHead = subhead("Peak map");
  function syncLines() {
    Object.values(F).forEach((b) => b.sync());
    setLine(skillHead.line, [F.scope, F.common]);
    setLine(mapHead.line, [withRounds().length && F.model, F.layer]);
  }

  // ---------------------------------------------------------------- the page
  const note = h("p", { class: "v-note pe-head" });
  const fig = h("div", { class: "pe-fig" });
  const strip = h("canvas", { class: "pe-strip", role: "img" });
  const stripRow = h("div", { class: "pe-grid pe-strip-row" }, strip);
  const headRow = h("div", { class: "pe-grid pe-cols" });
  const rowsEl = h("div", { class: "pe-rows", role: "list" });
  const none = h("p", { class: "v-note pe-none", hidden: true });
  fig.append(stripRow, headRow, rowsEl, none);
  const readout = pointerReadout(fig);
  const skillWrap = h("div", { class: "pe-skill pe-skill-scroll" });
  const geoCls = classifyHubGeo(manifest);
  const hasPeakGrid = geoCls.kind === "us-states" || geoCls.kind === "eu-countries";
  const gridCols = geoCls.kind === "eu-countries" ? EU_GRID_PROPORTIONED.cols : COLUMNS;
  const gridRows = geoCls.kind === "eu-countries" ? EU_GRID_PROPORTIONED.rows : 8;
  const mapGrid = h("div", { class: "mp-grid pe-map", style: { "--cols": gridCols, "--rows": gridRows } });
  const mapNote = h("p", { class: "v-note pe-key" });
  const mapCol = hasPeakGrid ? h("div", { class: "pe-map-col" }, mapHead.el, mapGrid, mapNote) : null;
  f.body.append(note, fig,
    h("div", { class: "pe-lower" },
      ...[h("div", { class: "pe-skill-col" }, skillHead.el, skillWrap), mapCol].filter(Boolean)));
  const tiles = new Map();
  if (geoCls.kind === "eu-countries") {
    const spec = geoCls.ukSplitAvailable ? EU_TILES_PROPORTIONED_UK_SPLIT : EU_TILES_PROPORTIONED;
    for (const [id, [c, r, w = 1, hs = 1]] of Object.entries(spec)) {
      const loc = manifest.locationById.get(id);
      if (!loc) continue;
      const b = h("button", {
        type: "button", class: ["mp-tile", w * hs === 1 && "is-compact"],
        style: { gridColumn: `${c} / span ${w}`, gridRow: `${r} / span ${hs}` },
        "aria-label": loc.name || id, onclick: () => store.set({ location: loc.id }),
      }, h("span", { class: "mp-abbr" }, loc.abbr || id), h("span", { class: "mp-val" }));
      tiles.set(loc.abbr || id, b); mapGrid.append(b);
    }
  } else if (geoCls.kind === "us-states") {
    for (const [abbr, [c, r]] of Object.entries(TILES)) {
      const loc = P.byAbbr.get(abbr);
      if (!loc) continue;
      const b = h("button", { type: "button", class: "mp-tile", style: { gridColumn: c + 1, gridRow: r + 1 }, "aria-label": loc.name, onclick: () => store.set({ location: loc.id }) },
        h("span", { class: "mp-abbr" }, abbr), h("span", { class: "mp-val" }));
      tiles.set(abbr, b); mapGrid.append(b);
    }
  }

  // ---------------------------------------------------------------- loading
  /* The selected models (and the baseline); when none of them forecast peaks this round, the server
   * answers for every model in the same request (fallback=all). A server from before that ignores it,
   * so then a second ask follows (models=all, or the ids for one older still). */
  const baseId = () => { const s = store.get(); return manifest.baselineFor?.(s.target, s.date) ?? manifest.baseline; };
  const mine = () => [...new Set([...store.get().sel.selected, baseId()].filter(Boolean))];
  const forecasts = (j) => (j?.models || []).some((m) => m.has_round && (m.timing || m.size));
  function load(force) {
    force = force === true;
    const s = store.get();
    const t = target();
    if (t?.is_categorical || (t?.output_types?.length && !t.output_types.includes("quantile") && !t.output_types.includes("sample"))) {
      Object.values(slots).forEach((x) => x._ctl?.abort());
      reqKey = ""; resp = null;
      f.loading(false);
      f.empty(`No peak forecasts · ${t?.short ?? s.target}`);
      return;
    }
    const base = { target: s.target, location: s.location, date: s.date, skill_scope: opt.scope, common: fair() ? "1" : null };
    const ids = mine();
    const urlFor = (models, fallback) => `/api/peaks?${query({ ...base, models, fallback })}`;
    const allIds = () => manifest.models.map((m) => m.id).join(",");
    const key = query({ ...base, models: ids.join(",") });
    const ck = query({ target: s.target, location: s.location });
    if (ck !== curvesKey) {
      curvesKey = ck; curves = null;
      getJson(`/api/season-curves?${ck}`, { slot: slots.curves })
        .then((j) => { if (ck === curvesKey) { curves = j; paintStrip(); } }, (e) => { if (!isAbort(e) && ck === curvesKey) curves = null; });
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
    getJson(urlFor(ids.join(","), "all"), { slot: slots.peaks }).then((j) => {
      if (key !== reqKey) return;
      if (!ids.length || j.fallback || forecasts(j) || !j.available) { done(j); return; }
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

  /* Live hubs that hold files synced before peak forecasts were kept (fetched once, quietly). */
  let hubsInfo = null;
  const outdatedHubs = () => {
    if (hubsInfo === null) {
      hubsInfo = [];
      fetch(apiUrl("/api/remote/hubs")).then((r) => (r.ok ? r.json() : null)).then((j) => {
        hubsInfo = (j?.hubs || []).filter((x) => x.synced && x.enabled !== false && x.peak_outdated > 0);
        if (hubsInfo.length && resp) renderNote();
      }).catch(() => {});
    }
    return hubsInfo;
  };

  // a model's name that opens its page (the shared data-model-sheet handler)
  const modelLink = (el, mid) => { el.dataset.modelSheet = mid; el.title = `${manifest.label(mid)} · details`; return el; };

  /* Which models: the selected ones that forecast peaks this round; when none do, every model that does. */
  function choose() {
    const s = store.get(), base = baseId();
    const here = (resp?.models || []).filter((m) => m.has_round && (m.timing || m.size)).map((m) => m.model_id);
    const sel = new Set([...s.sel.selected, base]);
    const mineHere = here.filter((id) => sel.has(id));
    shown = mineHere.length ? mineHere : here;
    shown.fallback = !mineHere.length && here.length > 0;
    for (const id of [...open]) if (!shown.includes(id)) open.delete(id);
    const ok = withRounds();
    if (!ok.includes(opt.model)) opt.model = ok.find((id) => /ensemble/i.test(id)) ?? ok[0] ?? null;
  }

  // ---------------------------------------------------------------- colors
  const isDrawn = (id) => { const s = store.get(); return id === baseId() ? !!s.sel.baseline : isCharted(s.sel, id); };
  /** the series color when the model is on the fan chart, else null */
  function seriesOf(id) {
    if (!id || !isDrawn(id)) return null;
    return cssColor(id === baseId() ? seriesColor("baseline") : seriesColor(slotOf(store.get().sel, id)));
  }
  const alpha = (rgb, a) => rgb.replace(/^rgba?\(([^,]+),([^,]+),([^,)]+)(?:,[^)]*)?\)$/, `rgba($1,$2,$3, ${a})`);
  const ink = (n) => cssColor(`var(--ink-${n})`);
  const modelById = () => new Map((resp?.models || []).map((m) => [m.model_id, m]));

  // ---------------------------------------------------------------- render
  function render() {
    syncLines();
    if (!resp) return;
    const t = target();
    if (!resp.available) { f.empty(`No peak forecasts · ${t?.short ?? resp.base_target}`); return; }
    f.empty(null);
    renderNote();
    buildRows();
    renderSkill();
    renderMap();
  }
  const nearest = (isos, iso) => (isos?.length ? isos.reduce((a, b) => (Math.abs(T(b) - T(iso)) < Math.abs(T(a) - T(iso)) ? b : a)) : null);

  /** the pooled row, with ≥2 models */
  function pooled() {
    if (shown.length < 2) return null;
    const M = modelById();
    const timing = poolWeeks(shown.map((id) => M.get(id)?.timing));
    const size = poolSize(shown.map((id) => M.get(id)?.size));
    return timing || size ? { timing, size } : null;
  }

  function renderNote() {
    const o = resp.observed, V = vf();
    const parts = [resp.location_name, manifest.seasonById.get(resp.season)?.label ?? resp.season, `Round ${fmtDay(T(resp.reference_date))}`];
    let obs = ["No observations yet"];
    if (o?.value != null) obs = o.final ? ["Observed peak ", h("b", null, V.value(o.value)), ` · ${fmtDay(T(o.date))}`]
      : ["Peak so far ", h("b", null, V.value(o.value)), ` · ${fmtDay(T(o.date))} · provisional`];
    const pool = pooled(), out = [parts.join(" · "), " · ", ...obs];
    // when the selection forecasts no peaks here, say so plainly: these are other models
    if (shown.fallback) out.push(store.get().sel.selected.length ? ` · yours don't forecast peaks · the ${shown.length} that do` : ` · the ${shown.length} that forecast peaks`);
    const tm = pool?.timing, sz = pool?.size;
    const when = tm?.i50?.[0] && tm.i50[1] ? (tm.i50[0] === tm.i50[1] ? fmtDay(T(tm.i50[0])) : `${fmtDay(T(tm.i50[0]))} – ${fmtDay(T(tm.i50[1]))}`) : null;
    const high = sz?.i50 ? (V.value(sz.i50[0]) === V.value(sz.i50[1]) ? V.value(sz.i50[0]) : `${V.value(sz.i50[0])}–${V.value(sz.i50[1])}`) : null;
    if (when || high) out.push(" · ", h("span", { class: "pe-consensus" }, `Most likely ${[when, high].filter(Boolean).join(" · ")}`));
    // a live hub synced before peak forecasts were kept is missing them until it is updated
    const old = outdatedHubs();
    if (old.length) out.push(" · ", `${old.map((x) => x.short_label || x.label).join(", ")} synced before peak forecasts were kept · `,
      h("button", { type: "button", class: "c-link", onclick: () => import("../../features/Hubs.js").then((m) => m.openHubs(document.querySelector(".app-more") || document.body, { manifest })) }, "Update"));
    note.replaceChildren(...out);
  }

  // ---------------------------------------------------------------- geometry
  let G = null;
  function geom() {
    const width = f.body.clientWidth || el.clientWidth || 1200;
    const gap = tokenNum("--space-24", 24);
    const final = !!resp?.observed?.final && shown.length > 0;
    const when = Math.max(240, width - NAME - HIGH - (final ? RIGHT + gap : 0) - 2 * gap);
    const [w0, w1] = resp.window.map(T);
    const xw = linear([w0 - HALF, w1 + HALF], [PADX, when - PADX]);
    // size axis: observed, every 50% top, and the 90% tops but the widest fifth (those end in a caret)
    const M = modelById(), pool = pooled();
    const sizes = [...shown.map((id) => M.get(id)?.size), pool?.size].filter(Boolean);
    const his = sizes.map((s) => s.i90?.[1]).filter(fin).sort((a, b) => a - b);
    const top = Math.max(1, resp.observed?.value || 0, ...sizes.map((s) => s.i50?.[1] ?? s.median).filter(fin), his.length ? his[Math.floor((his.length - 1) * 0.8)] : 0);
    const vmax = niceMax(top * 1.04, 4);
    const xh = linear([0, vmax], [PADH[0], HIGH - PADH[1]]);
    fig.style.setProperty("--pe-cols", `${NAME}px ${when}px ${HIGH}px${final ? ` ${RIGHT}px` : ""}`);
    return (G = { width, gap, final, when, xw, xh, vmax, ox: NAME + gap });
  }

  // ---------------------------------------------------------------- the season strip
  let hov = null;  // the hovered/focused row record
  function paintStrip() {
    if (!resp?.available || f.body.hidden || !G) return;
    const W = G.ox + G.when, H = STRIP + AXIS, Fo = chartFonts(), V = vf();
    const g = fitCanvas(strip, W, H);
    const X = (t) => G.ox + G.xw(t);
    const [d0, d1] = G.xw.domain();
    const cut = T(resp.data_cutoff), ref = T(resp.reference_date), o = resp.observed;
    const truth = (resp.truth || []).map((p) => ({ t: T(p.date), v: p.value })).filter((p) => fin(p.v) && p.t >= d0 && p.t <= d1 && p.t <= cut);
    const past = pastCurves(d0, d1);
    let top = Math.max(1, o?.value || 0, ...truth.map((p) => p.v));
    for (const c of past) for (const p of c.pts) top = Math.max(top, p.v);
    const M = modelById();
    for (const id of shown) { const s = M.get(id)?.size; if (fin(s?.i50?.[1])) top = Math.max(top, s.i50[1]); }
    const yMax = niceMax(top * 1.05, 3), step = niceStep(yMax, 3);
    const y = linear([0, yMax], [STRIP, 8]);
    const hair = cssColor("var(--line-hairline)"), axis = cssColor("var(--line-axis)");
    const mono = `${Fo.axis}px ${Fo.mono}`;
    g.lineJoin = "round"; g.lineCap = "round";
    // grid, labels in the name column's margin
    g.font = mono; g.textBaseline = "middle"; g.textAlign = "right"; g.lineWidth = 1;
    for (const v of ticks(0, yMax, step)) {
      const yy = Math.round(y(v)) + 0.5;
      g.strokeStyle = v ? hair : axis; g.beginPath(); g.moveTo(G.ox, yy); g.lineTo(W, yy); g.stroke();
      g.fillStyle = ink("tertiary"); g.fillText(V.axis(v), G.ox - 8, y(v));
    }
    // months under the strip: the When column's axis
    g.textAlign = "left"; g.textBaseline = "alphabetic";
    const ms = monthStarts(d0, d1).map((m) => ({ x: Math.round(X(m)) + 0.5, text: fmtMonth(m) }));
    for (const l of ms) { g.strokeStyle = axis; g.beginPath(); g.moveTo(l.x, STRIP); g.lineTo(l.x, STRIP + 4); g.stroke(); }
    g.fillStyle = ink("tertiary");
    for (const l of fitLabels(ms.map((l) => ({ ...l, x: l.x + 3, pri: /\d/.test(l.text) ? 1 : 0 })), (s) => g.measureText(s).width, 6, W - 2)) g.fillText(l.text, l.x, STRIP + 14);
    // the round
    g.strokeStyle = ink("faint"); g.beginPath(); g.moveTo(Math.round(X(ref)) + 0.5, 4); g.lineTo(Math.round(X(ref)) + 0.5, STRIP); g.stroke();
    // past seasons: faint, labelled at their ends
    const labels = [];
    for (const c of past) {
      g.strokeStyle = ink("faint"); g.lineWidth = 1; line(g, c.pts.map((p) => [X(p.t), y(p.v)]));
      const e = c.pts.at(-1);
      labels.push({ text: c.label, x: X(e.t) - 2, y: y(e.v) - 6 });
    }
    labels.sort((a, b) => b.y - a.y);
    for (let i = 1; i < labels.length; i++) labels[i].y = Math.min(labels[i].y, labels[i - 1].y - 11);
    g.font = `${Fo.micro - 1}px ${Fo.mono}`; g.textAlign = "right"; g.fillStyle = ink("tertiary");
    for (const l of labels) g.fillText(l.text, l.x, l.y);
    // this season, to the data cutoff
    g.strokeStyle = ink("primary"); g.lineWidth = 1.5; line(g, truth.map((p) => [X(p.t), y(p.v)]));
    // the observed peak: a line down into the rows, and a diamond
    if (o?.value != null) {
      const ox = X(T(o.date)), oy = y(o.value);
      g.strokeStyle = o.final ? ink("secondary") : ink("tertiary"); g.lineWidth = 1; g.setLineDash(o.final ? [] : [3, 3]);
      g.beginPath(); g.moveTo(Math.round(ox) + 0.5, oy + 7); g.lineTo(Math.round(ox) + 0.5, H); g.stroke(); g.setLineDash([]);
      g.beginPath(); g.moveTo(ox, oy - 5.5); g.lineTo(ox + 5.5, oy); g.lineTo(ox, oy + 5.5); g.lineTo(ox - 5.5, oy); g.closePath();
      g.fillStyle = o.final ? ink("primary") : cssColor("var(--surface-paper)"); g.fill();
      g.strokeStyle = ink("primary"); g.lineWidth = 1.25; g.stroke();
    }
    // a box is 50% × 50% soft fill, 90% whiskers, medians as a dot. At rest: the models on the fan
    // chart, in their colors. While a row is hovered: that model alone.
    if (hov) box(g, hov, X, y, W);
    else {
      const sel = store.get().sel;
      for (const r of rows) { const rec = recs.get(r); if (rec?.kind === "model" && isCharted(sel, rec.id)) box(g, rec, X, y, W); }
    }
    strip.setAttribute("aria-label", `${resp.location_name} · observed this season${past.length ? ` and ${past.length} past seasons` : ""}`);
  }
  function box(g, rec, X, y, W) {
    const { timing: tm, size: sz } = rec.data, c = rec.color || ink("primary");
    if (!sz || !fin(sz.median)) {
      if (tm?.median) { g.strokeStyle = c; g.lineWidth = 1.5; const xx = X(T(tm.median)); g.beginPath(); g.moveTo(xx, 8); g.lineTo(xx, STRIP); g.stroke(); }
      return;
    }
    const my = y(sz.median), top = y.range()[1];
    const clampY = (v) => Math.max(top, y(v));
    if (!tm?.median) {
      if (sz.i50) { g.fillStyle = alpha(c, 0.12); g.fillRect(G.ox, clampY(sz.i50[1]), W - G.ox, y(sz.i50[0]) - clampY(sz.i50[1])); }
      g.strokeStyle = c; g.setLineDash([4, 3]); g.lineWidth = 1; g.beginPath(); g.moveTo(G.ox, my); g.lineTo(W, my); g.stroke(); g.setLineDash([]);
      return;
    }
    const mx = X(T(tm.median));
    if (tm.i50 && sz.i50) {
      const x0 = X(T(tm.i50[0]) - HALF), x1 = X(T(tm.i50[1]) + HALF), y0 = clampY(sz.i50[1]), y1 = y(sz.i50[0]);
      g.fillStyle = alpha(c, 0.16); g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.strokeStyle = alpha(c, 0.6); g.lineWidth = 1; g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
    }
    g.strokeStyle = c; g.lineWidth = 1;
    if (tm.i90) { g.beginPath(); g.moveTo(X(T(tm.i90[0])), my); g.lineTo(X(T(tm.i90[1])), my); g.stroke(); }
    if (sz.i90) {
      g.beginPath(); g.moveTo(mx, clampY(sz.i90[1])); g.lineTo(mx, y(sz.i90[0])); g.stroke();
      if (y(sz.i90[1]) < top) caret(g, mx, top, "up");
    }
    g.fillStyle = c; g.beginPath(); g.arc(mx, my, 3.5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = cssColor("var(--surface-paper)"); g.lineWidth = 1.25; g.stroke();
  }
  function line(g, pts) {
    if (pts.length < 2) return;
    g.beginPath(); pts.forEach(([a, b], i) => (i ? g.lineTo(a, b) : g.moveTo(a, b))); g.stroke();
  }
  function caret(g, x, y0, dir) {
    g.beginPath();
    if (dir === "up") { g.moveTo(x - 3, y0 + 4); g.lineTo(x, y0); g.lineTo(x + 3, y0 + 4); }
    else { g.moveTo(x - 4, y0 - 3); g.lineTo(x, y0); g.lineTo(x - 4, y0 + 3); }
    g.stroke();
  }
  /* Past seasons on this season's calendar: week n of that season drawn at week n of this one. */
  function pastCurves(d0, d1) {
    if (!curves?.curves?.length) return [];
    const cur = curves.curves.find((c) => c.season === resp.season);
    const start = cur?.points?.[0] ? T(cur.points[0].date) - (cur.points[0].week - 1) * WEEK : null;
    if (start == null) return [];
    return curves.curves.filter((c) => String(c.season) < String(resp.season) && c.points?.length)
      .sort((a, b) => String(b.season).localeCompare(String(a.season))).slice(0, 3).map((c) => ({
      label: manifest.seasonById.get(c.season)?.label ?? c.season,
      pts: c.points.map((p) => ({ t: start + (p.week - 1) * WEEK, v: p.value })).filter((p) => fin(p.v) && p.t >= d0 && p.t <= d1),
    })).filter((c) => c.pts.length > 1);
  }

  // ---------------------------------------------------------------- the rows
  const recs = new WeakMap();  // row element → { kind, id, round, data, color, when, high }
  let rows = [];
  const sortKey = {
    when: (m) => (m.timing?.median ? T(m.timing.median) : Infinity),
    high: (m) => (fin(m.size?.median) ? m.size.median : Infinity),
    name: (m) => manifest.label(m.model_id, shown).toLowerCase(),
  };
  function sorted() {
    const M = modelById(), k = sortKey[opt.sort];
    const list = shown.map((id) => M.get(id)).filter(Boolean);
    list.sort((a, b) => {
      const ka = k(a), kb = k(b);
      if (ka === Infinity || kb === Infinity) return ka === kb ? 0 : ka === Infinity ? 1 : -1;  // blanks last either way
      const d = typeof ka === "string" ? ka.localeCompare(kb) : ka - kb;
      return opt.rev ? -d : d;
    });
    return list;
  }

  function buildRows() {
    hov = null; setHoverClass();
    geom();
    stripRow.hidden = false;
    if (!shown.length) {
      headRow.replaceChildren(); rowsEl.replaceChildren(); rows = [];
      const s = store.get(), near = nearest(resp.peak_rounds, s.date) || resp.latest_peak_round;
      none.hidden = false;
      none.replaceChildren(`No peak forecasts · ${fmtDay(T(s.date))}`,
        near && near !== s.date ? h("span", null, " · ", h("button", { type: "button", class: "c-link", onclick: () => store.set({ date: near }) }, `Go to ${fmtDay(T(near))}`)) : "");
      paintAll();
      return;
    }
    none.hidden = true;
    // header: sortable names, then the axes (observed labels, size ticks)
    const sortBtn = (key, text) => h("button", {
      type: "button", class: ["pe-sort", opt.sort === key && "is-on"], "aria-sort": opt.sort === key ? (opt.rev ? "descending" : "ascending") : null,
      onclick: () => { if (opt.sort === key) opt.rev = !opt.rev; else { opt.sort = key; opt.rev = false; } save(); buildRows(); },
    }, text, opt.sort === key ? h("span", { class: "pe-arrow", "aria-hidden": "true" }, opt.rev ? " ↑" : " ↓") : "");
    const whenAxis = h("canvas", { class: "pe-axis", "aria-hidden": "true" }), highAxis = h("canvas", { class: "pe-axis", "aria-hidden": "true" });
    headRow.replaceChildren(
      h("div", { class: "pe-hcell" }, sortBtn("name", "Model")),
      h("div", { class: "pe-hcell" }, sortBtn("when", "When"), whenAxis),
      h("div", { class: "pe-hcell" }, sortBtn("high", "How high"), highAxis),
      G.final ? h("div", { class: "pe-hcell pe-right pe-right-head" }, ...["Δ week", "Δ size", "In 50%", "In 90%"].map((t) => h("span", null, t))) : "",
    );
    headRow._axes = { whenAxis, highAxis };

    const out = [];
    const pool = pooled();
    if (pool) out.push(row({ kind: "pool", id: null, data: pool, color: null }));
    for (const m of sorted()) {
      out.push(row({ kind: "model", id: m.model_id, data: m, color: seriesOf(m.model_id) }));
      if (open.has(m.model_id)) {
        const rs = [...(resp.rounds?.[m.model_id] || [])].sort((a, b) => (a.reference_date < b.reference_date ? 1 : -1));
        for (const r of rs) out.push(row({ kind: "round", id: m.model_id, round: r.reference_date, data: r, color: seriesOf(m.model_id) }));
      }
    }
    rows = out;
    rowsEl.replaceChildren(...out);
    setFocusClass();
    paintAll();
  }

  function row(rec) {
    const { kind, id } = rec;
    let name;
    if (kind === "pool") name = h("span", { class: "pe-name" }, h("span", { class: "pe-chev" }), h("span", { class: "pe-label" }, "All models"));
    else if (kind === "round") {
      const cur = rec.round === store.get().date;
      name = h("button", { type: "button", class: ["pe-name pe-round", cur && "is-current"], title: `Chart round ${fmtLong(T(rec.round))}`, onclick: () => store.set({ date: rec.round }) },
        h("span", { class: "pe-label" }, fmtDay(T(rec.round))));
    } else {
      const has = resp.rounds?.[id]?.length > 0, label = manifest.label(id, shown);
      name = h(has ? "button" : "span", {
        type: has ? "button" : null, class: "pe-name", title: manifest.label(id), "aria-expanded": has ? String(open.has(id)) : null,
        onclick: has ? () => { if (open.has(id)) open.delete(id); else open.add(id); buildRows(); } : null,
      }, h("span", { class: "pe-chev", "aria-hidden": "true" }, has ? "›" : ""), h("i", { class: "pe-dot", style: rec.color ? { background: rec.color } : null, hidden: !rec.color }), modelLink(slideText(label, "pe-label"), id));
    }
    rec.when = h("canvas", { class: "pe-when" });
    rec.high = h("canvas", { class: "pe-high" });
    const el2 = h("div", { class: ["pe-grid pe-row c-slide-host", `is-${kind}`], role: "listitem", "data-id": id || "" }, name, rec.when, rec.high, G.final ? rightCell(rec) : "");
    recs.set(el2, rec); rec.el = el2;
    return el2;
  }

  function rightCell(rec) {
    const sc = rec.kind === "pool" ? null : rec.data.scores;
    // the sign of what is shown: −0.3% reads "0%", not "−0%"
    const signed = (v, d) => { const r = Math.abs(v).toFixed(d); return `${+r === 0 ? "±" : v > 0 ? "+" : "−"}${r}`; };
    const cov = (k) => {
      const a = sc?.timing?.[k], b = sc?.size?.[k];
      if (a == null && b == null) return h("span", { class: "is-none" }, "–");
      // which parts of the observed peak the interval caught: its week, its size, both, or neither
      const t = a && b ? "both" : a ? "week" : b ? "size" : "neither";
      return h("span", { class: a && b ? "is-hit" : !a && !b ? "is-miss" : null }, t);
    };
    const we = sc?.timing?.week_error, pe = sc?.size?.pct_error;
    return h("div", { class: "pe-right" },
      h("span", { class: fin(we) && Math.abs(we) <= 1 ? "is-hit" : null }, fin(we) ? `${signed(we, 0)} wk` : "–"),
      h("span", null, fin(pe) ? `${signed(pe, 0)}%` : "–"),
      cov("in50"), cov("in90"));
  }

  function paintAll() {
    if (!resp?.available || f.body.hidden) return;
    geom();
    paintStrip();
    const ax = headRow._axes;
    if (ax && rows.length) { paintWhenAxis(ax.whenAxis); paintHighAxis(ax.highAxis); }
    for (const r of rows) { const rec = recs.get(r); paintWhen(rec); paintHigh(rec); }
  }

  const obsStyle = (g) => {
    const o = resp.observed;
    g.strokeStyle = o.final ? ink("secondary") : ink("tertiary"); g.lineWidth = 1; g.setLineDash(o.final ? [] : [3, 3]);
  };
  function paintWhenAxis(c) {
    const g = fitCanvas(c, G.when, HEAD_AXIS), Fo = chartFonts(), o = resp.observed;
    if (o?.value == null) return;
    const x = G.xw(T(o.date)), text = fmtDay(T(o.date));
    g.font = `${Fo.axis}px ${Fo.mono}`; g.textBaseline = "middle";
    const w = g.measureText(text).width;
    g.textAlign = x + w / 2 > G.when ? "right" : x - w / 2 < 0 ? "left" : "center";
    g.fillStyle = o.final ? ink("primary") : ink("secondary"); g.fillText(text, x, HEAD_AXIS / 2);
  }
  function paintHighAxis(c) {
    const g = fitCanvas(c, HIGH, HEAD_AXIS), Fo = chartFonts(), V = vf(), o = resp.observed;
    g.font = `${Fo.axis}px ${Fo.mono}`; g.textBaseline = "middle";
    let ob = null;
    if (o?.value != null) {
      const t = V.value(o.value), w = g.measureText(t).width, x = G.xh(o.value);
      ob = { t, x0: x - w / 2 - 6, x1: x + w / 2 + 6, x };
    }
    const step = niceStep(G.vmax, 3);
    for (const v of ticks(0, G.vmax, step)) {
      const t = V.axis(v), w = g.measureText(t).width, x = G.xh(v);
      const al = v === 0 ? "left" : x + w / 2 > HIGH ? "right" : "center";
      const lx = al === "left" ? x : al === "right" ? x + w / 2 : x - w / 2;
      if (ob && lx + w > ob.x0 && lx < ob.x1) continue;
      g.textAlign = al; g.fillStyle = ink("faint"); g.fillText(t, x, HEAD_AXIS / 2);
    }
    if (ob) {
      g.textAlign = ob.x1 - 6 > HIGH ? "right" : "center";
      g.fillStyle = o.final ? ink("primary") : ink("secondary"); g.fillText(ob.t, ob.x, HEAD_AXIS / 2);
    }
  }
  function paintWhen(rec) {
    const g = fitCanvas(rec.when, G.when, ROW), tm = rec.data.timing, xw = G.xw;
    const c = rec.color || (rec.kind === "pool" ? ink("secondary") : ink("primary"));
    const amax = rec.color ? 0.9 : 0.7;
    if (tm?.probs?.length && tm.dates?.length === tm.probs.length) {
      const pm = Math.max(...tm.probs) || 1;
      tm.dates.forEach((d, i) => {
        const a = (tm.probs[i] / pm) * amax;
        if (!(a >= 0.02)) return;
        const x0 = Math.round(xw(T(d) - HALF)), x1 = Math.round(xw(T(d) + HALF));
        g.fillStyle = alpha(c, a); g.fillRect(x0, 6, Math.max(1, x1 - x0 - 1), ROW - 12);
      });
      if (tm.median) {
        const xm = Math.round(xw(T(tm.median))) + 0.5;
        g.strokeStyle = ink("primary"); g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(xm, 2); g.lineTo(xm, 6); g.moveTo(xm, ROW - 6); g.lineTo(xm, ROW - 2); g.stroke();
      }
    } else if (tm?.i90 || tm?.i50) {
      intervalBar(g, (iso) => xw(T(iso)), tm.i90, tm.i50, tm.median, c, Infinity);
    }
    if (resp.observed?.value != null) {
      const x = Math.round(xw(T(resp.observed.date))) + 0.5;
      obsStyle(g); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ROW); g.stroke(); g.setLineDash([]);
    }
  }
  function paintHigh(rec) {
    const g = fitCanvas(rec.high, HIGH, ROW), sz = rec.data.size;
    const c = rec.color || (rec.kind === "pool" ? ink("secondary") : ink("primary"));
    if (resp.observed?.value != null) {
      const x = Math.round(G.xh(resp.observed.value)) + 0.5;
      obsStyle(g); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ROW); g.stroke(); g.setLineDash([]);
    }
    if (sz && fin(sz.median)) intervalBar(g, (v) => G.xh(v), sz.i90, sz.i50, sz.median, c, G.xh(G.vmax));
  }
  /* 90% hairline, 50% thick bar, median dot; ends past the axis stop at its edge with a caret */
  function intervalBar(g, s, i90, i50, med, c, xmax) {
    const y = ROW / 2;
    const at = (v) => Math.min(xmax, s(v));
    g.lineCap = "butt";
    if (i90) {
      g.strokeStyle = alpha(c, 0.7); g.lineWidth = 1;
      g.beginPath(); g.moveTo(at(i90[0]), y + 0.5); g.lineTo(at(i90[1]), y + 0.5); g.stroke();
      if (s(i90[1]) > xmax + 0.5) caret(g, xmax + 4, y + 0.5, "right");
    }
    if (i50) {
      g.strokeStyle = alpha(c, 0.55); g.lineWidth = 6;
      const a = at(i50[0]), b = at(i50[1]);
      g.beginPath(); g.moveTo(a, y); g.lineTo(Math.max(b, a + 2), y); g.stroke();
    }
    if (med != null) {
      const xm = at(med);
      if (fin(xm)) {
        g.fillStyle = c; g.beginPath(); g.arc(xm, y, 3.5, 0, Math.PI * 2); g.fill();
        g.strokeStyle = cssColor("var(--surface-paper)"); g.lineWidth = 1.25; g.stroke();
      }
    }
  }

  // ---------------------------------------------------------------- hover, focus, readouts
  let previewed = null;
  function previewChart(id) {
    const v = id && isDrawn(id) ? id : null;
    if (v === previewed) return;
    previewed = v;
    ctx.chart?.hoverModel?.(v);
  }
  function setHoverClass() {
    rowsEl.classList.toggle("is-hovering", !!hov);
    for (const r of rows) r.classList.toggle("is-hover", recs.get(r) === hov);
  }
  function setHover(rec) {
    if (rec === hov) return;
    hov = rec;
    setHoverClass();
    paintStrip();
    previewChart(rec?.id ?? null);
  }
  function setFocusClass() {
    const fid = store.get().focus;
    for (const r of rows) { const rec = recs.get(r); r.classList.toggle("is-focus", rec.kind === "model" && rec.id === fid); }
  }
  const recOf = (t) => { const r = t?.closest?.(".pe-row"); return r ? recs.get(r) : null; };
  // readoutContent ends in null without a foot, which replaceChildren would print
  const show = (x, y, head, rowsList) => readout.show(x, y, readoutContent(head, rowsList).filter(Boolean));
  function readoutFor(e, rec) {
    const fr = fig.getBoundingClientRect(), px = e.clientX - fr.left, py = e.clientY - fr.top;
    const head = rec.kind === "pool" ? "All models" : rec.kind === "round" ? `${manifest.label(rec.id, shown)} · round ${fmtDay(T(rec.round))}` : manifest.label(rec.id, shown);
    const V = vf();
    if (e.target === rec.when) {
      const tm = rec.data.timing;
      if (!tm) { readout.hide(); return; }
      const t = G.xw.invert(e.clientX - rec.when.getBoundingClientRect().left);
      const j = tm.dates?.findIndex((d) => Math.abs(T(d) - t) <= HALF) ?? -1;
      show(px, py, head, [
        j >= 0 && tm.probs && [`Peak week ${fmtDay(T(tm.dates[j]))}`, `${(tm.probs[j] * 100).toFixed(1)}%`],
        tm.median && ["Median", fmtDay(T(tm.median)), true],
        tm.i50 && ["50%", `${fmtDay(T(tm.i50[0]))}–${fmtDay(T(tm.i50[1]))}`, true],
        tm.i90 && ["90%", `${fmtDay(T(tm.i90[0]))}–${fmtDay(T(tm.i90[1]))}`, true],
        fin(tm.p_passed) && ["Already past", `${Math.round(tm.p_passed * 100)}%`, true],
      ]);
    } else if (e.target === rec.high) {
      const sz = rec.data.size;
      if (!sz || !fin(sz.median)) { readout.hide(); return; }
      show(px, py, head, [
        ["Median", V.value(sz.median)],
        sz.i50 && ["50%", `${V.value(sz.i50[0])}–${V.value(sz.i50[1])}`, true],
        sz.i90 && ["90%", `${V.value(sz.i90[0])}–${V.value(sz.i90[1])}`, true],
      ]);
    } else readout.hide();
  }

  // ---------------------------------------------------------------- season skill
  function renderSkill() {
    if (!resp?.available || !shown.length) { skillWrap.replaceChildren(); return; }
    const pct = (v) => (fin(v) ? `${Math.round(v * 100)}%` : "–");
    const num = (v, cls) => h("td", { class: ["num", cls] }, v);
    const name = (id) => { const c = seriesOf(id); return h("span", { class: "v-name", style: c ? { "--c": c } : null, title: manifest.label(id) }, h("i"), manifest.label(id, shown)); };
    const sk = resp.skill;
    if (!sk?.final) { skillWrap.replaceChildren(h("p", { class: "v-note" }, `Not final yet · scored after ${fmtLong(T(sk?.window_end || resp.window[1]))}`)); return; }
    const ids = new Set(shown);
    const list = (sk.models || []).filter((m) => ids.has(m.model_id));
    if (!list.length) { skillWrap.replaceChildren(h("p", { class: "v-note" }, sk.common ? "No rounds shared by these models" : "No season skill for these models")); return; }
    const best = (k) => Math.min(...list.map((m) => m[k]).filter(fin));
    const B = { rps: best("rps"), log_score: best("log_score"), abs_week_error: best("abs_week_error"), size_wis_pct: best("size_wis_pct") };
    const cell = (m, k, d) => num(fin(m[k]) ? m[k].toFixed(d) : "–", m[k] === B[k] ? "lead" : null);
    skillWrap.replaceChildren(h("table", { class: "v-table" },
      h("thead", null, h("tr", null, ["Model", "N", "RPS", "Log", "|Δ| wks", "Hit 50/90", "WIS %", "|Err|", "Cov 50/90"].map((x) => h("th", null, x)))),
      h("tbody", null, list.map((m) => h("tr", null, h("td", null, name(m.model_id)),
        num(String(m.n_timing || m.n_size || 0), "quiet"), cell(m, "rps", 2), cell(m, "log_score", 2), cell(m, "abs_week_error", 1),
        num(`${pct(m.timing_in50)} / ${pct(m.timing_in90)}`, "quiet"), cell(m, "size_wis_pct", 1),
        num(fin(m.size_abs_pct_error) ? `${Math.round(m.size_abs_pct_error)}%` : "–"),
        num(`${pct(m.size_in50)} / ${pct(m.size_in90)}`, "quiet"))))),
    h("p", { class: "v-note" }, [
      sk.scope === "states" ? `${sk.locations} states with a final peak` : "Every round",
      sk.pending_locations ? `${sk.pending_locations} still provisional` : null,
    ].filter(Boolean).join(" · ")));
  }

  // ---------------------------------------------------------------- peak map
  function renderMap() {
    if (!hasPeakGrid) { mapHead.el.hidden = true; return; }
    const id = opt.model;
    mapHead.el.hidden = !id;
    const locs = pmap?.locations || {}, here = P.abbrOf(store.get().location);
    const vals = new Map();
    for (const [fips, d] of Object.entries(locs)) {
      const abbr = P.abbrOf(fips);
      const v = opt.layer === "week" ? (d.timing?.median ? T(d.timing.median) : NaN) : d.size_per_100k;
      if (tiles.has(abbr) && fin(v)) vals.set(abbr, v);
    }
    const vals2 = [...vals.values()];
    mapGrid.hidden = !vals2.length;
    const lo = Math.min(...vals2), hi = Math.max(...vals2);
    // peak week: earlier or later than the typical (median) state, blue to orange; size: low to high
    const sorted = [...vals2].sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)];
    const span = Math.max(med - lo, hi - med) || 1;
    for (const [abbr, b] of tiles) {
      const v = vals.get(abbr), has = fin(v);
      const fill = !has ? "" : opt.layer === "week" ? diverging((v - med) / span) : sequential(hi > lo ? (v - lo) / (hi - lo) : 0.5);
      b.classList.toggle("has-value", has);
      b.classList.toggle("is-here", abbr === here);
      b.style.background = fill; b.style.color = has ? inkOn(fill) : "";
      b.lastChild.textContent = has ? (opt.layer === "week" ? fmtDay(v) : v.toFixed(1)) : "";
    }
    // the legend: a ramp with its ends named (earlier · median · later, or low · high)
    if (!vals2.length) mapNote.replaceChildren(id ? "No peak map for this round" : "");
    else {
      const week = opt.layer === "week";
      const stops = Array.from({ length: 9 }, (_, i) => (week ? diverging(i / 4 - 1) : sequential(i / 8)));
      mapNote.replaceChildren(
        h("span", { class: "pe-key-end" }, week ? "Earlier" : `${lo.toFixed(1)}`),
        h("span", { class: "pe-key-ramp", style: { background: `linear-gradient(90deg, ${stops.join(", ")})` } }, week ? h("i", { "data-mid": `median ${fmtDay(med)}` }) : null),
        h("span", { class: "pe-key-end" }, week ? "Later" : `${hi.toFixed(1)} per 100k`),
      );
    }
  }

  // ---------------------------------------------------------------- reacting
  const redraw = perFrame(paintAll);
  const ro = new ResizeObserver(redraw);
  ro.observe(f.body);
  const screen = onScreen(el);
  const offs = [
    () => ro.disconnect(),
    () => screen.off(),
    () => previewChart(null),
    onDprChange(redraw),
    on(rowsEl, "pointermove", (e) => {
      const rec = recOf(e.target);
      setHover(rec);
      if (rec) readoutFor(e, rec); else readout.hide();
    }),
    on(rowsEl, "pointerleave", () => { setHover(null); readout.hide(); }),
    on(rowsEl, "focusin", (e) => setHover(recOf(e.target))),
    on(rowsEl, "focusout", (e) => { if (!rowsEl.contains(e.relatedTarget)) setHover(null); }),
    on(rowsEl, "click", (e) => {
      const rec = recOf(e.target);
      if (!rec || rec.kind !== "model" || e.target.closest(".pe-name") || !isDrawn(rec.id)) return;
      store.set({ focus: store.get().focus === rec.id ? null : rec.id });
    }),
    onThemeChange(() => { resetColors(); screen.run(load); }),
    // load() re-renders when its request is unchanged (a new selection's colors, say)
    store.on((s, prev, changed) => {
      const fairChanged = changed.has("scope") && !!prev.scope?.fair !== !!s.scope?.fair;
      if (["target", "location", "date", "sel"].some((k) => changed.has(k)) || fairChanged) screen.run(load);
      else if (changed.has("focus")) setFocusClass();
    }),
  ];
  syncLines();
  load();
  return { destroy() { Object.values(slots).forEach((x) => x._ctl?.abort()); offs.forEach((off) => off()); } };
}
