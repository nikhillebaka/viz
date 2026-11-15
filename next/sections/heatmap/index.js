/* The heatmap section: rows × columns × metric over the shared scope, drawn on one canvas in the score
 * colors. Hover a cell for its numbers; click it to show that forecast on the chart (location, date and
 * model), then the page scrolls up to the chart. Pure logic is in model.js. */
import { scopeOf, seasonWeekOf, startYearOf } from "../scope.js";
import { onThemeChange, cssColor, reducedMotion } from "../../lib/dom.js";
import { valueFormat, fmtDay, fmtLong, fmtMonth } from "../../lib/format.js";
import { parseIso } from "../../lib/scale.js";
import { chartFonts, canvasMeasure } from "../../chart/render.js";
import { chart as chartModel, setBaseline, slotOf, COLORS } from "../../features/selection.js";
import { nearestRound } from "../../features/url.js";
import {
  h, on, linkStyle, frame, fragment, action, setLine, getJson, query, isAbort, sequential, diverging, inkOn,
  resetColors, HHS, places, fitCanvas, perFrame, pointerReadout, readoutContent, onScreen, onDprChange, viewState,
} from "../shared.js";
import { AXES, AXIS_LABEL, METRICS, modelAxis, waveView, metricsFor, sortsFor, normalizeView, swapView, requestFor, buildGrid } from "./model.js";

const KEY = "viz.heatmap";
const ROW_H = 20, GAP = 2, GROUP_GAP = 6, TOP = 22, LABEL_PAD = 16;
const fin = (x) => typeof x === "number" && Number.isFinite(x);

/** @returns {{ destroy(): void }} */
export function mount(el, ctx) {
  linkStyle("heatmap");
  const { manifest, store } = ctx;
  const P = places(manifest);
  const f = frame(el, "Heatmap", "heatmap");
  const counts = () => manifest.targetById.get(store.get().target)?.scale !== "proportion";
  const vs = viewState(store, "heatmap", KEY);
  let view = normalizeView(vs.initial, counts());
  let resp = null, grid = null, lay = null, reqKey = "", hover = null;
  const slot = {};

  // ---------------------------------------------------------------- the control line
  const save = () => vs.write(view, JSON.stringify(view) === JSON.stringify(normalizeView({}, counts())));
  const setView = (patch) => { view = normalizeView({ ...view, ...patch }, counts()); save(); syncLine(); load(); };
  const modelChoices = () => {
    const s = store.get(), ids = [...s.sel.selected];
    if (manifest.baseline && !ids.includes(manifest.baseline)) ids.push(manifest.baseline);
    return [{ value: "truth", label: "Observed" }, ...ids.map((id) => ({ value: id, label: manifest.label(id, ids) }))];
  };
  const axisItems = (axes) => axes.map((a) => ({ value: a, label: AXIS_LABEL[a] }));
  const F = {
    rows: fragment({ label: "Rows", title: "Rows", items: () => axisItems(Object.keys(AXES)), value: () => view.rows,
      isDefault: () => view.rows === "location", onSelect: (rows) => setView({ rows, sort: null }) }),
    cols: fragment({ label: "Columns", title: "Columns", items: () => axisItems(AXES[view.rows]), value: () => view.cols,
      isDefault: () => view.cols === AXES[view.rows][0], onSelect: (cols) => setView({ cols }) }),
    model: fragment({ label: "Model", title: "Model", items: modelChoices, value: () => view.model,
      isDefault: () => view.model === "truth", onSelect: (model) => setView({ model }) }),
    horizon: fragment({ label: "Horizon", title: "Horizon", items: () => [0, 1, 2, 3].map((x) => ({ value: x, label: `${x} wk ahead`, short: `${x} wk` })),
      value: () => view.horizon, isDefault: () => view.horizon === 1, onSelect: (horizon) => setView({ horizon }) }),
    metric: fragment({ label: "Metric", title: "Metric", items: () => metricsFor(view, counts()).map((m) => ({ value: m, label: METRICS[m].label })),
      value: () => view.metric, isDefault: () => view.metric === metricsFor(view, counts())[0], onSelect: (metric) => setView({ metric }) }),
    sort: fragment({ label: "Sort", title: "Sort rows", items: () => sortsFor(view.rows), value: () => view.sort,
      isDefault: () => view.sort === sortsFor(view.rows)[0]?.value, onSelect: (sort) => setView({ sort }) }),
    scale: fragment({ label: "Scale", title: "Scale", items: () => [{ value: "none", label: "One scale" }, { value: "row", label: "Per row" }],
      value: () => view.scale, isDefault: () => view.scale === "none", onSelect: (scale) => setView({ scale }) }),
  };
  F.cols.dataset.sep = "×";
  const swap = action("⇄", "Swap rows and columns", () => { view = swapView(view, counts()); save(); syncLine(); load(); });
  swap.classList.add("v-push");

  function syncLine() {
    if (view.model !== "truth" && !modelChoices().some((c) => c.value === view.model)) view = normalizeView({ ...view, model: "truth" }, counts());
    Object.values(F).forEach((b) => b.sync());
    setLine(f.line, [
      F.rows, F.cols,
      !modelAxis(view) && F.model,
      waveView(view) && view.model !== "truth" && F.horizon,
      F.metric,
      sortsFor(view.rows).length > 1 && F.sort,
      F.scale,
    ]);
    f.line.append(swap);
  }

  // ---------------------------------------------------------------- the figure
  const fig = h("div", { class: "hm-fig" });
  const canvas = h("canvas", { class: "hm-canvas", role: "img" });
  const cursor = h("div", { class: "hm-cursor", hidden: true });
  const foot = h("p", { class: "hm-foot" });
  fig.append(canvas, cursor);
  f.body.append(fig, foot);
  const readout = pointerReadout(fig);

  // ---------------------------------------------------------------- loading
  // soft: only the chart's date or place changed, so an unchanged request needs a redraw, not a rebuild
  function load(force = false, soft = false) {
    const s = store.get(), sc = scopeOf(s, manifest);
    const none = (text) => { slot._ctl?.abort(); reqKey = ""; resp = grid = null; lay = null; f.loading(false); f.empty(text); };
    if (!sc.seasons.length) { none("No season in scope"); return; }
    const models = modelAxis(view) ? withBaseline(s.sel.selected) : null;
    // the server scores every model when given none: never ask for that
    if (modelAxis(view) && !models) { none("No models selected"); return; }
    const p = requestFor(view, { target: s.target, seasons: sc.seasons, place: sc.place, locationAbbr: P.abbrOf(s.location), models });
    const key = query(p);
    if (key === reqKey && resp && !force) { if (soft && grid) redraw(); else rebuild(); return; }
    reqKey = key;
    f.loading(true);
    getJson(`/api/heatmap?${key}`, { slot }).then((j) => {
      if (key !== reqKey) return;
      resp = j; f.loading(false); rebuild();
    }, (e) => {
      if (isAbort(e)) return;
      f.loading(false); resp = grid = null;
      f.empty("Can't load the heatmap", () => load(true));
    });
  }
  // a date's week of its own season, so a week window applies to every scoped season
  const weekOf = (iso) => { const id = manifest.seasonOf(iso); return id ? seasonWeekOf(startYearOf(id), parseIso(iso)) : NaN; };
  const withBaseline = (ids) => (ids.length ? [...new Set([...ids, manifest.baseline].filter(Boolean))] : null);

  function rebuild() {
    if (!resp) return;
    const s = store.get(), sc = scopeOf(s, manifest);
    const ids = [...(resp.y_keys || []), ...(resp.x_keys || [])];
    hover = null; cursor.hidden = true; readout.hide();
    grid = buildGrid(resp, view, {
      baseline: manifest.baseline, weeks: sc.weeks, weekOf, horizons: sc.horizons,
      region: (a) => HHS[a], population: (a) => P.byAbbr.get(a)?.population, season: (iso) => manifest.seasonOf(iso),
      label: (k) => labelOf(view.rows, k, ids),
    });
    grid.ids = ids;
    if (!grid.count) {
      const n = grid.inactive.length;
      const label = sc.seasons.map((id) => manifest.seasonById.get(id)?.label ?? id).join(", ");
      f.empty(n ? `No forecasts in scope · ${label}` : "Nothing in scope");
      return;
    }
    f.empty(null);
    footer();
    draw();
  }

  function footer() {
    const off = grid.inactive;
    if (!off.length) { foot.replaceChildren(); foot.title = ""; return; }
    const names = off.slice(0, 4).map((m) => manifest.label(m.id, off.map((x) => x.id)));
    foot.replaceChildren(`No forecasts in scope · ${names.join(", ")}${off.length > 4 ? ` +${off.length - 4}` : ""}`);
    foot.title = off.map((m) => `${manifest.label(m.id)}: ${m.reason}`).join("\n");
  }

  // ---------------------------------------------------------------- labels and numbers
  function labelOf(axis, k, among) {
    if (axis === "model") return manifest.label(k, among);
    if (axis === "location") return P.byAbbr.get(k)?.name ?? k;
    if (axis === "date") return fmtDay(parseIso(k));
    if (axis === "horizon") return `${k} wk`;
    return String(k);
  }
  const shortCol = (axis, k, among) => (axis === "location" ? k : labelOf(axis, k, among));
  const longOf = (axis, k) => (axis === "date" ? fmtLong(parseIso(k)) : axis === "horizon" ? `${k} wk ahead` : labelOf(axis, k, grid.ids));

  function fmtMetric(id, x) {
    if (!fin(x)) return "–";
    const vf = valueFormat(manifest.targetById.get(store.get().target));
    switch (id) {
      case "relwis": return x.toFixed(2);
      case "wis_rate": case "rate": case "f_rate": return x.toFixed(2);
      case "cov95": return `${Math.round(x)}%`;
      case "trend": return `${x > 0 ? "+" : ""}${x.toFixed(1)}%`;
      case "error": return `${x > 0 ? "+" : x < 0 ? "−" : ""}${vf.value(Math.abs(x))}`;
      default: return vf.value(x);
    }
  }

  // ---------------------------------------------------------------- layout and drawing
  function layout() {
    const Fo = chartFonts(), measure = canvasMeasure();
    const rowFont = `${Fo.chart}px ${Fo.sans}`, colFont = `${Fo.axis}px ${Fo.mono}`;
    const width = f.body.clientWidth || el.clientWidth;
    const nR = grid.rows.length, nC = grid.cols.length;
    const rowText = grid.rows.map((r) => labelOf(view.rows, r.key, grid.ids));
    const dots = view.rows === "model";
    const labelW = Math.min(220, Math.max(40, ...rowText.map((t) => measure(t, rowFont)))) + (dots ? 14 : 0) + LABEL_PAD;
    const breaks = (arr) => arr.reduce((n, x, i) => n + (i && x.group !== arr[i - 1].group ? 1 : 0), 0);
    const cellW = Math.max(3, Math.min(nC <= 8 ? 88 : 44, Math.floor((width - labelW - breaks(grid.cols) * GROUP_GAP) / nC)));
    const colText = grid.cols.map((c) => shortCol(view.cols, c.key, grid.ids));
    const top = view.cols === "model" ? Math.min(150, Math.max(...colText.map((t) => measure(t, colFont)))) + 12 : TOP;
    const xs = [], ys = [];
    let x = labelW;
    grid.cols.forEach((c, i) => { if (i && c.group !== grid.cols[i - 1].group) x += GROUP_GAP; xs.push(x); x += cellW; });
    let y = top;
    grid.rows.forEach((r, i) => { if (i && r.group !== grid.rows[i - 1].group) y += GROUP_GAP; ys.push(y); y += ROW_H; });
    return { width, height: y + GAP, labelW, cellW, top, xs, ys, rowText, colText, rowFont, colFont, nR, nC, right: x };
  }

  function draw() {
    if (!grid || f.body.hidden) return;
    lay = layout();
    const L = lay, g = fitCanvas(canvas, L.width, L.height), Fo = chartFonts(), measure = canvasMeasure();
    const s = store.get();
    const ink = cssColor("var(--ink-secondary)"), ink1 = cssColor("var(--ink-primary)"), ink3 = cssColor("var(--ink-tertiary)");
    const cw = L.cellW - GAP, ch = ROW_H - GAP;
    const showNums = cw >= 40;
    g.textBaseline = "middle";
    for (let r = 0; r < L.nR; r++) for (let c = 0; c < L.nC; c++) {
      const t = grid.tone(r, c);
      if (!t) continue;
      const fill = t.kind === "div" ? diverging(t.t) : sequential(t.t);
      g.fillStyle = fill;
      g.fillRect(L.xs[c], L.ys[r], cw, ch);
      if (showNums) {
        g.font = `${Fo.axis}px ${Fo.mono}`; g.fillStyle = inkOn(fill); g.textAlign = "center";
        g.fillText(fmtMetric(view.metric, grid.values[r * L.nC + c]), L.xs[c] + cw / 2, L.ys[r] + ch / 2 + 0.5);
      }
    }
    // row labels: the chart's place and week in primary ink; charted models with their color dot
    const here = P.abbrOf(s.location);
    g.font = L.rowFont; g.textAlign = "left";
    grid.rows.forEach((row, r) => {
      const y = L.ys[r] + ch / 2 + 0.5;
      let x = 0;
      if (view.rows === "model") {
        const sl = slotOf(s.sel, row.key);
        const color = row.key === manifest.baseline ? "var(--series-baseline)" : sl == null ? null : `var(--series-${(sl % COLORS) + 1})`;
        if (color) { g.fillStyle = cssColor(color); g.beginPath(); g.arc(4, y, 3.5, 0, Math.PI * 2); g.fill(); }
        x = 14;
      }
      const cur = (view.rows === "location" && row.key === here) || (view.rows === "date" && row.key === s.date);
      g.fillStyle = cur ? ink1 : ink;
      g.fillText(clip(L.rowText[r], L.labelW - x - LABEL_PAD, L.rowFont, measure), x, y);
    });
    // column labels
    g.font = L.colFont; g.fillStyle = ink3;
    if (view.cols === "date") {
      let lastMonth = -1;
      grid.cols.forEach((c, i) => {
        const t = parseIso(c.key), m = new Date(t).getUTCMonth();
        if (m !== lastMonth) { g.textAlign = "left"; g.fillText(fmtMonth(t), L.xs[i], L.top / 2); lastMonth = m; }
      });
    } else if (view.cols === "model") {
      g.save(); g.textAlign = "left";
      grid.cols.forEach((c, i) => {
        g.save(); g.translate(L.xs[i] + cw / 2 + 3, L.top - 6); g.rotate(-Math.PI / 2);
        g.fillText(clip(L.colText[i], L.top - 10, L.colFont, measure), 0, 0); g.restore();
      });
      g.restore();
    } else {
      const every = Math.max(1, Math.ceil((measure("MMM", L.colFont) + 4) / L.cellW));
      g.textAlign = "center";
      grid.cols.forEach((c, i) => {
        if (i % every) return;
        g.fillStyle = view.cols === "location" && c.key === here ? ink1 : ink3;
        g.fillText(L.colText[i], L.xs[i] + cw / 2, L.top / 2);
      });
    }
    // the chart's week: an outline around its column (or row)
    g.strokeStyle = ink1; g.lineWidth = 1;
    const ci = view.cols === "date" ? grid.cols.findIndex((c) => c.key === s.date) : -1;
    if (ci >= 0) g.strokeRect(L.xs[ci] - 1.5, L.top - 1.5, cw + 3, L.ys[L.nR - 1] + ch - L.top + 3);
    const ri = view.rows === "date" ? grid.rows.findIndex((r) => r.key === s.date) : -1;
    if (ri >= 0) g.strokeRect(L.labelW - 1.5, L.ys[ri] - 1.5, L.right - L.labelW - GAP + 3, ch + 3);
    canvas.setAttribute("aria-label", `${AXIS_LABEL[view.rows]} × ${AXIS_LABEL[view.cols]} · ${METRICS[view.metric].label} · ${grid.count} cells`);
    if (hover) placeCursor(hover.r, hover.c);
  }

  function clip(text, w, font, measure) {
    if (measure(text, font) <= w) return text;
    let t = text;
    while (t.length > 1 && measure(`${t}…`, font) > w) t = t.slice(0, -1);
    return `${t}…`;
  }

  // ---------------------------------------------------------------- hover and click
  function cellAt(e) {
    if (!lay) return null;
    const rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
    const find = (arr, v, size) => { let lo = 0, hi = arr.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) { ans = m; lo = m + 1; } else hi = m - 1; } return ans >= 0 && v < arr[ans] + size ? ans : -1; };
    // the gap after a cell counts as the cell, so the pointer never falls through between cells
    const c = find(lay.xs, x, lay.cellW), r = find(lay.ys, y, ROW_H);
    if (r < 0 || c < 0 || !fin(grid.values[r * lay.nC + c])) return null;
    return { r, c, x, y };
  }
  function placeCursor(r, c) {
    cursor.hidden = false;
    cursor.style.transform = `translate(${lay.xs[c] - 1.5}px, ${lay.ys[r] - 1.5}px)`;
    cursor.style.width = `${lay.cellW - GAP + 3}px`; cursor.style.height = `${ROW_H - GAP + 3}px`;
  }
  function readoutFor(r, c) {
    const rk = grid.rows[r].key, ck = grid.cols[c].key, m = grid.meta(r, c) || {};
    const x = grid.values[r * lay.nC + c];
    const vf = valueFormat(manifest.targetById.get(store.get().target));
    const rows = [[METRICS[view.metric].label, fmtMetric(view.metric, x)]];
    if (grid.base) rows.push(["WIS", fmtMetric("wis", x * grid.base[r * lay.nC + c])], ["Baseline WIS", fmtMetric("wis", grid.base[r * lay.nC + c]), true]);
    if (fin(m.median)) rows.push(["Forecast", vf.value(m.median)]);
    if (fin(m.q025) && fin(m.q975)) rows.push(["95%", `${vf.value(m.q025)}–${vf.value(m.q975)}`, true]);
    if (fin(m.truth) && view.metric !== "count") rows.push(["Observed", vf.value(m.truth)]);
    if (fin(m.trend) && view.metric !== "trend") rows.push(["Weekly change", fmtMetric("trend", m.trend)]);
    if (fin(m.wis) && !/wis/.test(view.metric) && !modelAxis(view)) rows.push(["WIS", vf.value(m.wis)]);
    if (modelAxis(view) && view.metric !== "cov95" && fin(m.cov95)) rows.push(["95% coverage", fmtMetric("cov95", m.cov95), true]);
    const foot = fin(m.task_count) ? `${m.task_count} forecasts` : "";
    return readoutContent(`${longOf(view.rows, rk)} · ${longOf(view.cols, ck)}`, rows, foot);
  }
  const offs = [
    on(canvas, "pointermove", (e) => {
      const hit = cellAt(e);
      if (!hit) { hover = null; cursor.hidden = true; readout.hide(); canvas.style.cursor = ""; return; }
      hover = hit; canvas.style.cursor = "pointer";
      placeCursor(hit.r, hit.c);
      readout.show(lay.xs[hit.c] + lay.cellW / 2, lay.ys[hit.r], readoutFor(hit.r, hit.c));
    }),
    on(canvas, "pointerleave", () => { hover = null; cursor.hidden = true; readout.hide(); }),
    on(canvas, "click", (e) => { const hit = cellAt(e); if (hit) showOnChart(hit.r, hit.c); }),
  ];

  /* A cell's forecast on the chart: its place, its week (snapped to a round) and its model, charted and
   * focused; then up to the chart. */
  function showOnChart(r, c) {
    const keys = { [view.rows]: grid.rows[r].key, [view.cols]: grid.cols[c].key };
    const s = store.get(), patch = {};
    if (keys.location) { const l = P.byAbbr.get(keys.location); if (l) patch.location = l.id; }
    if (keys.date) { const iso = nearestRound(keys.date, manifest); if (iso) patch.date = iso; }
    const model = keys.model ?? (view.model !== "truth" ? view.model : null);
    if (model) {
      if (model === manifest.baseline) patch.sel = setBaseline(s.sel, true);
      else if (manifest.modelById.has(model)) patch.sel = chartModel(s.sel, model);
      patch.focus = model;
    }
    store.set(patch);
    document.getElementById("view")?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" });
  }

  // ---------------------------------------------------------------- reacting
  const redraw = perFrame(draw);
  const ro = new ResizeObserver(redraw);
  ro.observe(f.body);
  const screen = onScreen(el);
  // off screen, the latest ask waits as a full load (a soft one could hide a rebuild)
  const later = (soft = false) => (screen.visible() ? load(false, soft) : screen.run(() => load()));
  offs.push(
    () => ro.disconnect(),
    () => screen.off(),
    onDprChange(redraw),
    onThemeChange(() => { resetColors(); redraw(); }),
    store.on((s, prev, changed) => {
      if (changed.has("target")) { view = normalizeView(view, counts()); syncLine(); }
      if (changed.has("sel")) syncLine();
      if (["target", "scope", "sel"].some((k) => changed.has(k))) later();
      else if (changed.has("location") || changed.has("date")) later(true);
    }),
  );
  syncLine();
  load();

  return { destroy() { slot._ctl?.abort(); offs.forEach((off) => off()); readout.el.remove(); } };
}
