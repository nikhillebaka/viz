/* Scores: the scope line, the leaderboard (with expandable rows) and the figures, on the paper under the
 * fan chart.
 *
 * Reads the store (scope, sel, date, location, target, focus) and owns `scores` ({ sort, rev, cols, open }).
 * Scores come from /api/next/metrics; by default relative WIS is ranked among every model in scope and the
 * rows shown are the selected models plus the baseline. That full-pool request is slow the first time, so
 * a quick selected-only one fills the table first (relative WIS waits for the pool) and is also the pool
 * "Wins" counts in. */
import { h } from "../../lib/dom.js";
import { apiUrl } from "../../lib/api.js";
import { openMenu, openPopover, tooltip } from "../../ui/floating.js";
import { icon, toast, slideText } from "../../ui/controls.js";
import { seriesColor } from "../../chart/layout.js";
import { isCharted, slotOf, chart as chartModel, unchart, setBaseline } from "../../features/selection.js";
import { classifyHubGeo } from "../../geo/picker_geo.js";
import { scopeOf, setScope, targetHorizons } from "../scope.js";
import { guideLink } from "../shared.js";
import {
  metricsRequest, rowsFrom, sortRows, SORTS, DEFAULT_SORT, relLevel, coverageLevel, SMALL, DASH,
  fmtScore, fmtRel, fmtPct, fmtCount, fmtDelta, datesLabel, horizonsLabel, exportRows, delimited, exportName, cliCommand,
} from "./model.js";
import { loadMetrics, loadQuick, hasMetrics } from "./data.js";
import { openDates } from "./dates.js";
import { calibrationFigure, horizonFigure, anatomyFigure, emphasize, s } from "./figures.js";

let cssLinked = false;
function linkCss() {
  if (cssLinked) return;
  cssLinked = true;
  document.head.append(h("link", { rel: "stylesheet", href: new URL("../../styles/scores.css", import.meta.url).href }));
}

/* columns: always-on first, then the optional ones from the + menu */
const COLUMNS = {
  rel: { label: "Rel. WIS", tip: "Relative WIS · pairwise vs the baseline · lower is better" },
  wis: { label: "WIS", tip: "Mean weighted interval score" },
  mae: { label: "MAE", tip: "Mean absolute error of the median" },
  cov50: { label: "50%", tip: "50% interval coverage · target 50" },
  cov95: { label: "95%", tip: "95% interval coverage · target 95" },
  rps: { label: "RPS", tip: "Ranked probability score · ordinal PMF · lower is better" },
  logScore: { label: "Log loss", tip: "Mean negative log-likelihood (-ln p of realized bin) · lower is better" },
  brier: { label: "Brier", tip: "Multi-class Brier score · lower is better" },
  hitMode: { label: "Mode hit", tip: "Share of forecasts where most likely category matched observed" },
  n: { label: "N", tip: "Forecasts scored" },
  delta: { label: "vs base", tip: "Score change vs the baseline, on shared forecasts" },
  wins: { label: "Wins", tip: "Rounds with the lowest WIS · among the selected models and baseline" },
  per100k: { label: "/100k", tip: "WIS per 100k population" },
  sharp: { label: "Width", tip: "Mean 95% interval width" },
  cov80: { label: "80%", tip: "80% interval coverage · target 80" },
  h0: { label: "0 wk", tip: "Relative score at horizon 0 · vs baseline, ratio of means" },
  h1: { label: "1 wk", tip: "Relative score at horizon 1 · vs baseline, ratio of means" },
  h2: { label: "2 wk", tip: "Relative score at horizon 2 · vs baseline, ratio of means" },
  h3: { label: "3 wk", tip: "Relative score at horizon 3 · vs baseline, ratio of means" },
  h4: { label: "4 wk", tip: "Relative score at horizon 4 · vs baseline, ratio of means" },
};
const BASE_COLS = ["rel", "wis", "mae", "cov50", "cov95", "n"];
const PMF_BASE_COLS = ["rel", "rps", "logScore", "brier", "hitMode", "n"];
const PMF_OPTIONAL_COLS = ["delta", "h0", "h1", "h2", "h3", "h4"];
export const OPTIONAL_COLS = ["delta", "wins", "per100k", "sharp", "cov80", "h0", "h1", "h2", "h3", "h4"];
const DEFAULT_UI = Object.freeze({ sort: DEFAULT_SORT, rev: false, cols: [], open: [] });
const uiOf = (st) => ({ ...DEFAULT_UI, ...(st.scores || {}) });

/**
 * @param {HTMLElement} el the section
 * @param {{ manifest, store, chart }} ctx
 * @returns {{ destroy(): void }}
 */
export function mount(el, ctx) {
  linkCss();
  const { manifest, store } = ctx;
  const allSeasons = manifest.seasons.map((x) => x.id);
  const seasonLabel = (id) => manifest.seasonById.get(id)?.label || id;
  const geoCls = classifyHubGeo(manifest);
  const allPlaceLabel = geoCls.kind === "eu-countries"
    ? "All countries"
    : geoCls.kind === "us-states"
      ? "All states"
      : "All locations";
  const offs = [];

  /* ---------------- DOM ---------------- */
  const frag = (name, onClick) => {
    const b = h("button", { type: "button", class: "sc-frag", "data-frag": name, onclick: (e) => onClick(e.currentTarget) });
    return b;
  };
  const fMetric = frag("metric", (a) => metricMenu(a));
  const fPlace = frag("place", (a) => placeMenu(a));
  const fDates = frag("dates", (a) => openDates(a, ctx));
  const fHz = frag("horizons", (a) => horizonsPopover(a));
  const fBase = frag("baseline", (a) => baselineMenu(a));
  const fExport = h("button", { type: "button", class: "sc-frag sc-export", "aria-label": "Export", onclick: (e) => exportMenu(e.currentTarget) }, "↓");
  const sep = () => h("span", { class: "sc-sep", "aria-hidden": "true" }, "·");
  const wisGuide = guideLink("relative-wis", "Relative WIS in the Guide");
  const pmfGuide = guideLink("pmf", "Categorical PMF scoring in the Guide");
  pmfGuide.hidden = true;
  const scopeLine = h("div", { class: "sc-scope", role: "toolbar", "aria-label": "Evaluation scope" },
    h("h2", { class: "sc-title" }, "Scores"),
    h("div", { class: "sc-frags" }, fMetric, wisGuide, pmfGuide, sep(), fPlace, sep(), fDates, sep(), fHz, sep(), fBase), fExport);
  const progress = h("div", { class: "sc-progress", "aria-hidden": "true" });
  const notice = h("div", { class: "sc-notice", hidden: true });
  const board = h("div", { class: "sc-board", role: "table", "aria-label": "Leaderboard" });
  const figSvgs = { cal: s("svg", { class: "sc-fig-svg" }), hz: s("svg", { class: "sc-fig-svg" }), anat: s("svg", { class: "sc-fig-svg sc-fig-anat" }) };
  const shareBtn = h("button", { type: "button", class: "sc-fig-toggle", onclick: () => { share = !share; drawFigures(); } });
  const plusBtn = h("button", { type: "button", class: "sc-plus", "aria-label": "Columns", html: icon.more, onclick: (e) => columnsMenu(e.currentTarget) });
  const figs = h("div", { class: "sc-figs" },
    h("figure", { class: "sc-fig" }, h("figcaption", { class: "sc-fig-title" }, "Calibration", h("span", { class: "sc-fig-sub" }, "coverage − nominal, pts")), figSvgs.cal),
    h("figure", { class: "sc-fig" }, h("figcaption", { class: "sc-fig-title" }, "Horizon", h("span", { class: "sc-fig-sub" }, "Rel. WIS by weeks ahead")), figSvgs.hz),
    h("figure", { class: "sc-fig" }, h("figcaption", { class: "sc-fig-title" }, "Anatomy", h("span", { class: "sc-sep" }, "·"), shareBtn), h("div", { class: "sc-fig-scroll" }, figSvgs.anat)));
  const root = h("div", { class: "sc" }, scopeLine, progress, notice, board, figs);
  el.append(root);

  /* ---------------- state ---------------- */
  // resp: the newest full response (may be for an older scope while the current one loads); quick: the
  // selected-only response for `quickQ`; cur: the request the store asks for now
  let resp = null, respFull = null, respKey = null, wantKey = null, failed = false;
  let quick = null, quickQ = null, quickWant = null, cur = null, shown = null;
  let rows = [], order = { ranked: [], unranked: [], ranks: new Map() };
  let hover = null, share = false, previewed = null, dead = false;

  const dataHorizons = (st = store.get()) => {
    const hasSubset = Array.isArray(st.scope?.horizons) && st.scope.horizons.length > 0;
    const src = respFull || (!hasSubset ? shown : null);
    if (!src?.rankings?.length || (src.target && src.target !== st.target)) return null;
    const hSet = new Set();
    for (const r of src.rankings) {
      if (!r?.has_data_in_scope || !r.by_horizon) continue;
      for (const k of Object.keys(r.by_horizon)) {
        const n = Number(k);
        if (Number.isInteger(n)) hSet.add(n);
      }
    }
    if (!hSet.size) return null;
    const all = [...hSet].sort((a, b) => a - b);
    const nonNeg = all.filter((n) => n >= 0);
    return nonNeg.length ? nonNeg : all;
  };
  const availH = (st = store.get()) => dataHorizons(st) || targetHorizons(manifest, st.target);
  const scope = () => { const st = store.get(); return scopeOf(st, manifest, availH(st)); };
  const colAvailable = (c, hs = availH()) => {
    const m = /^h(-?\d+)$/.exec(c);
    return !m || hs.includes(Number(m[1]));
  };
  const setUi = (patch) => store.set((st) => ({ scores: { ...uiOf(st), ...patch } }));

  function request() {
    const st = store.get(), sc = scope();
    if (!sc.seasons.length) { cur = null; resp = null; respFull = null; respKey = null; render(); return; }
    const req = (cur = metricsRequest(sc, { target: st.target, selected: st.sel.selected, allSeasons, availableHorizons: availH() }));
    // the quick request follows the selection even when the full-pool query (models=all) does not change
    if (req.quick && req.quick !== quickQ && req.quick !== quickWant) {
      quickWant = req.quick;
      loadQuick(req.quick).then((j) => {
        if (dead || quickWant !== req.quick) return;
        quick = j; quickQ = req.quick; quickWant = null;
        render();
      }, (err) => {
        if (err?.name !== "AbortError" && quickWant === req.quick) quickWant = null;
      });
    }
    if (req.key === respKey || req.key === wantKey) { render(); return; }
    wantKey = req.key;
    failed = false;
    root.classList.toggle("is-loading", !hasMetrics(req.query, req.full));
    loadMetrics(req.query, req.full).then((j) => {
      if (dead || wantKey !== req.key) return;
      resp = j.resp; respFull = j.full; respKey = req.key; wantKey = null;
      root.classList.remove("is-loading");
      render();
    }, (err) => {
      if (dead || err?.name === "AbortError" || wantKey !== req.key) return;
      wantKey = null; failed = true;
      root.classList.remove("is-loading");
      console.warn("viz: scores could not load", err);
      render();
    });
    render();
  }

  /* ---------------- helpers ---------------- */
  const defaultBase = (st, sc) => (
    typeof manifest.baselineFor === "function"
      ? manifest.baselineFor(st.target, sc.seasons.length === 1 ? sc.seasons[0] : null)
      : manifest.baseline
  );
  const chartBase = (st) => (
    typeof manifest.baselineFor === "function"
      ? manifest.baselineFor(st.target, manifest.seasonOf?.(st.date) ?? null)
      : manifest.baseline
  );
  const isDrawn = (st, id) => (id === chartBase(st) ? st.sel.baseline : isCharted(st.sel, id));
  const dotOf = (st, id) => (!isDrawn(st, id) ? null : id === chartBase(st) ? seriesColor("baseline") : seriesColor(slotOf(st.sel, id)));
  const sourceOf = (id) => { const m = manifest.modelById.get(id); return !m ? "repo" : m.source === "hub" ? `hub:${m.hub}` : m.source; };

  /* light a hovered row's model on the chart: FanChart's hoverModel when it has one, else its keyed label */
  function previewChart(id) {
    const c = ctx.chart;
    const st = store.get(), v = id && isDrawn(st, id) ? id : null;
    if (v === previewed) return;
    if (typeof c?.hoverModel === "function") { previewed = v; c.hoverModel(v); return; }
    const ia = c?.interact;
    if (!ia || !("keyed" in ia)) return;
    if (ia.keyed === previewed) ia.keyed = v; // never undo a label the keyboard focused
    previewed = v;
    c.request();
  }
  function setHover(id) {
    if (id === hover) return;
    hover = id;
    board.querySelectorAll(".sc-row.is-hover").forEach((r) => r.classList.remove("is-hover"));
    if (id) board.querySelector(`.sc-row[data-id="${CSS.escape(id)}"]`)?.classList.add("is-hover");
    previewChart(id);
    drawFigures(true);
  }
  function focusModel(id) {
    const st = store.get();
    if (id === chartBase(st)) {
      store.set({ sel: setBaseline(st.sel, true), focus: st.focus === id && st.sel.baseline ? null : id });
    } else if (!isCharted(st.sel, id)) store.set({ sel: chartModel(st.sel, id), focus: id });
    else store.set({ focus: st.focus === id ? null : id });
  }
  function toggleDot(id) {
    const st = store.get();
    if (id === chartBase(st)) store.set({ sel: setBaseline(st.sel, !st.sel.baseline) });
    else store.set({ sel: isCharted(st.sel, id) ? unchart(st.sel, id) : chartModel(st.sel, id) });
  }
  /* a model's page: the model sheet (features/ModelSheet.js, loaded on first use) */
  function openSheet(id) { import("../../features/ModelSheet.js").then((m) => m.openModel(id, ctx)); }
  function goTo({ date, location }) {
    if (location) store.set({ location });
    if (date) { if (ctx.chart?.goTo) ctx.chart.goTo(date); else store.set({ date }); }
    document.getElementById("view")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  /* ---------------- render ---------------- */
  function render() {
    if (dead) return;
    const st = store.get(), sc = scope(), ui = uiOf(st);
    const ids = st.sel.selected;
    const label = (id) => manifest.label(id, [...ids, sc.baseline]);
    const team = (id) => { const m = manifest.modelById.get(id); return m ? (m.team && m.team !== label(id) ? m.team : "") : ""; };
    // while the full pool loads, the quick response for this scope stands in (relative WIS pending)
    const fresh = !!cur && respKey === cur.key;
    const stand = !fresh && !!cur?.quick && quickQ === cur.quick;
    shown = !cur ? null : stand ? quick : resp;
    const wins = !cur?.quick ? shown : quickQ === cur.quick ? quick : null;
    rows = shown ? rowsFrom(shown, { ids, baseline: sc.baseline, full: stand ? null : respFull, wins, pending: stand, scale: sc.scale, label, team }) : [];
    for (const r of rows) r.dot = dotOf(st, r.id);
    order = sortRows(rows, ui.sort, ui.rev);
    renderScope(st, sc);
    renderNotice(sc);
    renderBoard(st, sc, ui);
    drawFigures();
  }

  const isCatMode = (st, s = shown) => !!s?.is_categorical || !!manifest.targetById.get(st?.target)?.is_categorical;
  const activeColsFor = (st, ui) => {
    const hs = availH();
    if (isCatMode(st)) {
      const base = shown?.ordinal === false ? PMF_BASE_COLS.filter((c) => c !== "rps") : PMF_BASE_COLS;
      return [...base, ...PMF_OPTIONAL_COLS.filter((c) => ui.cols.includes(c) && colAvailable(c, hs))];
    }
    return [...BASE_COLS, ...OPTIONAL_COLS.filter((c) => ui.cols.includes(c) && colAvailable(c, hs))];
  };

  function renderScope(st, sc) {
    const def = (on) => (on ? "is-set" : "");
    const cat = isCatMode(st);
    const baseMetricLabel = cat ? (shown?.ordinal === false ? "Relative Log loss" : "Relative RPS") : "Relative WIS";
    const metric = [baseMetricLabel, !cat && sc.scale === "log" && "log", sc.fair && "shared only", sc.rank === "selected" && "among selected"].filter(Boolean).join(" · ");
    fMetric.textContent = metric;
    fMetric.className = ["sc-frag", def((!cat && sc.scale === "log") || sc.fair || sc.rank === "selected"), shown?.common_task_status === "empty_disjoint" && "is-warn"].filter(Boolean).join(" ");
    wisGuide.hidden = cat;
    pmfGuide.hidden = !cat;
    const loc = manifest.locationById.get(st.location);
    fPlace.textContent = (sc.place === "US" && geoCls.aggregateId === "US")
      ? "US"
      : sc.place === "current"
        ? (loc?.name || st.location)
        : allPlaceLabel;
    fPlace.className = ["sc-frag", def(sc.place !== "all")].filter(Boolean).join(" ");
    fDates.textContent = datesLabel(sc, seasonLabel, allSeasons.length);
    const noneScored = shown && rows.length && rows.every((r) => !r.active);
    fDates.className = ["sc-frag", def(!sc.following || sc.weeks || sc.phase), noneScored && "is-warn"].filter(Boolean).join(" ");
    fHz.textContent = horizonsLabel(sc.horizons, availH());
    fHz.className = ["sc-frag", def(!!sc.horizons)].filter(Boolean).join(" ");
    const defBase = defaultBase(st, sc);
    const eff = shown?.baseline_model;
    const fellBack = eff && eff !== sc.baseline;
    const baseId = fellBack ? eff : sc.baseline;
    const baseName = manifest.label(baseId, manifest.baselines?.candidates || [defBase, sc.baseline, eff].filter(Boolean));
    fBase.textContent = `vs ${baseName || "baseline"}`;
    fBase.className = ["sc-frag", def(sc.baseline !== defBase || fellBack), fellBack && "is-warn"].filter(Boolean).join(" ");
  }

  function renderNotice(sc) {
    notice.replaceChildren();
    notice.hidden = true;
    if (failed) {
      notice.hidden = false;
      notice.append(h("span", null, "Can't score this scope · "), h("button", { type: "button", class: "c-link", onclick: () => { respKey = null; request(); } }, "Retry"));
    } else if (shown?.common_task_status === "empty_disjoint" && sc.fair) {
      notice.hidden = false;
      notice.append(h("span", null, "No shared forecasts · "), h("button", { type: "button", class: "c-link", onclick: () => setScope(store, { fair: false }) }, "Score each on its own"));
    }
  }

  function gridTemplate(cols) {
    const w = (c) => (c === "rel" ? "var(--sc-rel)" : c === "n" ? "var(--sc-num-wide)" : "var(--sc-num)");
    return ["var(--sc-rank)", "minmax(var(--sc-name-min), var(--sc-name-max))", ...cols.map(w), "var(--sc-plus)"].join(" ");
  }

  function renderBoard(st, sc, ui) {
    const cols = activeColsFor(st, ui);
    board.style.setProperty("--sc-grid", gridTemplate(cols));
    const keepFocus = document.activeElement?.closest?.(".sc-row")?.dataset.id;
    const kids = [];
    if (!shown && !failed) {
      for (let i = 0; i < Math.max(2, st.sel.selected.length + 1); i++) kids.push(h("div", { class: "sc-row is-ghost", "aria-hidden": "true" }));
    } else {
      for (const r of order.ranked) kids.push(...rowEls(r, cols, st, sc, ui));
      if (!st.sel.selected.length) kids.push(addModelsRow());
      if (order.unranked.length) {
        kids.push(h("div", { class: "sc-divider", role: "presentation" }));
        for (const r of order.unranked) kids.push(...rowEls(r, cols, st, sc, ui));
      }
    }
    kids.push(headerRow(cols, ui, sc));
    board.replaceChildren(...kids);
    if (keepFocus) board.querySelector(`.sc-row[data-id="${CSS.escape(keepFocus)}"]`)?.focus({ preventScroll: true });
  }

  function addModelsRow() {
    const b = h("button", { type: "button", class: "c-link", onclick: async (e) => {
      const { openModelPicker } = await import("../../features/ModelPicker.js");
      openModelPicker(e.currentTarget, ctx);
    } }, "Add models");
    return h("div", { class: "sc-row is-add" }, h("span"), h("span", { class: "sc-name" }, b));
  }

  function rowEls(r, cols, st, sc, ui) {
    const rank = order.ranks.get(r.id);
    const small = r.active && r.n < SMALL;
    const row = h("div", {
      class: ["sc-row c-slide-host", r.baseline && "is-base", !r.active && "is-off", small && "is-small", st.focus === r.id && "is-focus", hover === r.id && "is-hover"],
      role: "row", tabindex: "0", "data-id": r.id,
    });
    row.append(h("span", { class: "sc-rank mono", role: "cell" }, rank != null ? String(rank) : ""));
    // the name: the chart's color dot (charted only; a faint ring on hover charts it), name, team
    const dot = h("button", {
      type: "button", class: ["sc-dot", r.dot && "is-on"], style: { "--dot": r.dot }, tabindex: "-1",
      "aria-label": r.dot ? `Take ${r.label} off the chart` : `Chart ${r.label}`,
      onclick: (e) => { e.stopPropagation(); toggleDot(r.id); },
    });
    const name = h("button", {
      type: "button", class: "sc-label", tabindex: "-1", "aria-label": `${r.label} · open its page`,
      onclick: (e) => { e.stopPropagation(); openSheet(r.id); },
    }, slideText(r.label, "sc-label-text"), r.team ? h("span", { class: "sc-team" }, r.team) : null,
    h("span", { class: "sc-chev", html: icon.right }));
    const glyphs = h("span", { class: "sc-glyphs" });
    if (!r.active) glyphs.append(glyph("sc-g-off", offReason(r)));
    else {
      const [a, t] = r.rounds;
      if (t && a < 0.9 * t) glyphs.append(glyph("sc-g-part", `${a} of ${t} rounds`, { "--p": `${Math.round((a / t) * 100)}%` }));
      if (!r.q23) glyphs.append(glyph("sc-g-q", `${r.q ?? 7} quantiles`, null, `${r.q ?? 7}Q`));
      if (warnsFor(r.id).length) glyphs.append(glyph("sc-g-warn", warnsFor(r.id).join(" · "), null, "!"));
    }
    row.append(h("span", { class: "sc-name", role: "cell" }, dot, name, glyphs));
    for (const c of cols) row.append(cell(c, r, sc));
    row.append(h("span", { role: "cell" }));
    tooltip(name, r.id === r.label ? r.id : `${r.id}`);
    row.addEventListener("pointerenter", () => setHover(r.id));
    row.addEventListener("pointerleave", () => setHover(null));
    row.addEventListener("click", () => focusModel(r.id));
    row.addEventListener("keydown", (e) => rowKey(e, r));
    return [row];
  }

  function glyph(cls, tip, style, text = "") {
    const g = h("span", { class: ["sc-glyph", cls], style, tabindex: "-1" }, text);
    tooltip(g, tip);
    return g;
  }
  function offReason(r) {
    if (r.pending) return "Awaiting truth";
    const sc = scope();
    const inScope = r.seasons.filter((x) => sc.seasons.includes(x));
    if (r.seasons.length && !inScope.length) return `${r.seasons.map(seasonLabel).sort().join(", ")} only`;
    if (/location/.test(r.note)) return "No forecasts here";
    return r.note || "No forecasts in scope";
  }
  function warnsFor(id) {
    return (shown?.validation_warnings || []).filter((w) => w.includes(`'${id}'`));
  }

  function cell(c, r, sc) {
    const v = (text, cls = "") => h("span", { class: ["sc-num mono", cls], role: "cell" }, text);
    if (!r.active) return c === "rel" ? h("span", { class: "sc-rel", role: "cell" }, h("span", { class: "sc-relnum mono" }, DASH)) : v(DASH);
    switch (c) {
      case "rel": {
        const lvl = relLevel(r.rel);
        const pos = (x) => `${((Math.max(-1, Math.min(1, Math.log2(x))) + 1) / 2) * 100}%`;
        return h("span", { class: "sc-rel", role: "cell" },
          h("span", { class: "sc-relnum mono" }, fmtRel(r.rel)),
          r.rel != null ? h("span", { class: "sc-lolli", style: { "--x": pos(r.rel), "--c": lvl ? `var(--score-${lvl})` : null }, "aria-hidden": "true" }, h("i"), h("b")) : h("span", { class: "sc-lolli" }));
      }
      case "wis": return v(fmtScore(r.wis));
      case "mae": return v(fmtScore(r.mae));
      case "cov50": case "cov80": case "cov95": {
        const target = +c.slice(3), val = r[c], lvl = coverageLevel(val, target);
        return h("span", { class: "sc-num sc-cov-cell mono", role: "cell" }, fmtPct(val), h("i", { class: "sc-mark", style: { "--c": lvl ? `var(--score-${lvl})` : null } }));
      }
      case "n": return v(fmtCount(r.n), r.n < SMALL ? "is-small-n" : "");
      case "delta": {
        const lvl = r.delta == null ? null : relLevel(1 + r.delta / 100);
        return h("span", { class: "sc-num sc-cov-cell mono", role: "cell" }, fmtDelta(r.delta), h("i", { class: "sc-mark", style: { "--c": lvl ? `var(--score-${lvl})` : null } }));
      }
      case "wins": return v(r.wins == null ? DASH : `${r.wins}/${r.competed ?? DASH}`);
      case "per100k": return v(fmtScore(r.per100k));
      case "sharp": return v(fmtScore(r.sharp));
      case "rps": return v(r.rps == null ? DASH : r.rps.toFixed(3));
      case "logScore": return v(r.logScore == null ? DASH : r.logScore.toFixed(2));
      case "brier": return v(r.brier == null ? DASH : r.brier.toFixed(3));
      case "hitMode": return v(r.hitMode == null ? DASH : `${fmtPct(r.hitMode)}%`);
      default: {
        const k = +c.slice(1), rel = r.baseline ? 1 : r.byH[k]?.rel ?? null, lvl = relLevel(rel);
        return h("span", { class: "sc-num sc-cov-cell mono", role: "cell" }, fmtRel(rel), h("i", { class: "sc-mark", style: { "--c": lvl ? `var(--score-${lvl})` : null } }));
      }
    }
  }

  /* the column titles: a footer that rides the bottom of the screen and rests under the last row */
  function headerRow(cols, ui, sc) {
    const cat = isCatMode(store.get());
    const colLabel = (key) => {
      if (key === "rel" && cat) return shown?.ordinal === false ? "Rel. Log" : "Rel. RPS";
      return COLUMNS[key].label;
    };
    const colTip = (key) => {
      if (key === "rel" && cat) return shown?.ordinal === false ? "Relative Log loss · pairwise vs the baseline · lower is better" : "Relative RPS · pairwise vs the baseline · lower is better";
      return COLUMNS[key]?.tip;
    };
    const head = (key, text, cls = "") => {
      const active = ui.sort === key;
      const asc = (SORTS[key]?.asc ?? true) !== ui.rev;
      const b = h("button", {
        type: "button", class: ["sc-head", cls, active && "is-active"], role: "columnheader",
        "aria-sort": active ? (asc ? "ascending" : "descending") : "none",
        onclick: () => setUi(active ? { rev: !ui.rev } : { sort: key, rev: false }),
      }, text, active ? h("span", { class: "sc-arrow", "aria-hidden": "true" }, asc ? "↑" : "↓") : null);
      const tip = colTip(key);
      if (tip) tooltip(b, tip);
      return b;
    };
    const relHead = h("span", { class: "sc-head-rel" }, head("rel", colLabel("rel")),
      h("span", { class: "sc-axis-ticks mono", "aria-hidden": "true" }, h("i", { style: { "--x": "0%" } }, "0.5"), h("i", { style: { "--x": "50%" } }, "1"), h("i", { style: { "--x": "100%" } }, "2")));
    return h("div", { class: "sc-row sc-headrow", role: "row" },
      h("span"), head("name", "Model", "is-left"),
      ...cols.map((c) => (c === "rel" ? relHead : head(c, colLabel(c)))), plusBtn);
  }

  function rowKey(e, r) {
    const rowsEls = [...board.querySelectorAll(".sc-row[data-id]")];
    const i = rowsEls.indexOf(e.currentTarget);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      rowsEls[Math.max(0, Math.min(rowsEls.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
    } else if (e.key === "Enter") { e.preventDefault(); openSheet(r.id); }
    else if (e.key === " ") { e.preventDefault(); toggleDot(r.id); }
  }

  /* ---------------- figures ---------------- */
  /* emphasisOnly (a hover): restyle the drawn figures in place, redrawing only one that must name a line */
  function drawFigures(emphasisOnly = false) {
    const st = store.get();
    const list = [...order.ranked];
    const cat = isCatMode(st);
    const hasHz = list.some((r) => Object.values(r.byH || {}).some((b) => b?.rel != null));
    const calFig = figSvgs.cal.closest("figure");
    const hzFig = figSvgs.hz.closest("figure");
    const anatFig = figSvgs.anat.closest("figure");
    if (calFig) calFig.hidden = cat;
    if (anatFig) anatFig.hidden = cat;
    if (hzFig) hzFig.hidden = !list.length || (cat && !hasHz);
    figs.hidden = !list.length || (cat && !hasHz);
    if (figs.hidden) return;
    const emph = new Set([st.focus].filter(Boolean));
    const o = { emph, hover, onHover: (id) => setHover(id), onPick: (id) => openSheet(id) };
    const one = (svg, draw) => { if (!emphasisOnly || !emphasize(svg, emph, hover)) draw(); };
    if (!cat) one(figSvgs.cal, () => calibrationFigure(figSvgs.cal, list, o));
    one(figSvgs.hz, () => horizonFigure(figSvgs.hz, list, o));
    if (!cat) {
      shareBtn.textContent = share ? "Share" : "WIS";
      one(figSvgs.anat, () => anatomyFigure(figSvgs.anat, list, { ...o, share }));
    }
  }

  /* ---------------- scope popovers and menus ---------------- */
  function metricMenu(a) {
    const st = store.get(), sc = scope(), cat = isCatMode(st);
    openMenu(a, {
      label: "Metric",
      items: [
        ...(cat ? [] : [
          { header: "Scale" },
          { label: "Natural", checked: sc.scale === "natural", onSelect: () => setScope(store, { scale: "natural" }) },
          { label: "Log", checked: sc.scale === "log", onSelect: () => setScope(store, { scale: "log" }) },
        ]),
        { header: "Forecasts" },
        { label: "All forecasts", checked: !sc.fair, onSelect: () => setScope(store, { fair: false }) },
        { label: "Shared only", checked: sc.fair, onSelect: () => setScope(store, { fair: true }) },
        { header: "Rank among" },
        { label: "Every model in scope", checked: sc.rank === "all", onSelect: () => setScope(store, { rank: "all" }) },
        { label: "Selected models", checked: sc.rank === "selected", onSelect: () => setScope(store, { rank: "selected" }) },
      ],
    });
  }
  function placeMenu(a) {
    const st = store.get(), sc = scope();
    const loc = manifest.locationById.get(st.location);
    const items = [
      { label: allPlaceLabel, checked: sc.place === "all", onSelect: () => setScope(store, { place: "all" }) },
    ];
    if (geoCls.aggregateId === "US") {
      items.push({ label: "US", checked: sc.place === "US", onSelect: () => setScope(store, { place: "US" }) });
    }
    if (st.location && st.location !== geoCls.aggregateId) {
      items.push({ label: loc?.name || st.location, shortcut: "chart", checked: sc.place === "current", onSelect: () => setScope(store, { place: "current" }) });
    }
    openMenu(a, { label: "Locations", items });
  }
  function horizonsPopover(a) {
    const avail = availH();
    openPopover(a, {
      title: "Horizons", width: 280,
      content(body, layer) {
        const wrap = h("div", { class: "sc-chips" });
        const draw = () => {
          const on = scope().horizons || avail;
          wrap.replaceChildren(...avail.map((k) => h("button", {
            type: "button", class: "c-chip", "aria-pressed": String(on.includes(k)),
            onclick: () => {
              const next = on.includes(k) ? on.filter((x) => x !== k) : [...on, k].sort((x, y) => x - y);
              if (!next.length) return; // one always stays on
              setScope(store, { horizons: next.length === avail.length ? null : next });
              draw();
            },
          }, `${k} wk`)));
          layer.place();
        };
        body.append(wrap);
        draw();
      },
    });
  }
  function baselineMenu(a) {
    const st = store.get(), sc = scope(), defBase = defaultBase(st, sc);
    const cands = [...new Set([
      defBase,
      ...(manifest.baselines?.candidates || []),
      ...manifest.models.filter((m) => m.kind === "baseline" || /baseline/i.test(m.id)).map((m) => m.id),
    ].filter(Boolean))];
    const sel = st.sel.selected.filter((id) => !cands.includes(id));
    const among = [...cands, ...sel];
    const item = (id) => ({
      label: manifest.label(id, among),
      checked: sc.baseline === id,
      onSelect: () => setScope(store, { baseline: id === defBase ? null : id }),
    });
    openMenu(a, { label: "Baseline", items: [{ header: "Baseline" }, ...cands.map(item), ...(sel.length ? [{ header: "Selected" }, ...sel.map(item)] : [])] });
  }
  function columnsMenu(a) {
    const st = store.get(), ui = uiOf(st), hs = availH(), cat = isCatMode(st);
    const opts = cat ? PMF_OPTIONAL_COLS : OPTIONAL_COLS;
    const relPrefix = cat ? (shown?.ordinal === false ? "Rel. Log · " : "Rel. RPS · ") : "Rel. WIS · ";
    openMenu(a, {
      label: "Columns",
      items: opts.filter((c) => colAvailable(c, hs)).map((c) => ({
        label: /^h\d+$/.test(c) ? `${relPrefix}${c.slice(1)} wk` : COLUMNS[c].tip.split(" · ")[0],
        toggle: true,
        checked: ui.cols.includes(c),
        onSelect: () => { const cur = uiOf(store.get()).cols; setUi({ cols: cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c] }); },
      })),
    });
  }
  function exportMenu(a) {
    openMenu(a, {
      label: "Export",
      items: [
        { label: "Scores CSV", onSelect: () => download("csv") },
        { label: "Scores TSV", onSelect: () => download("tsv") },
        { label: "Scores JSON", onSelect: () => download("json") },
        "-",
        { label: "Copy command", onSelect: () => copy(cli(), "Command copied") },
        { label: "Copy link", onSelect: () => setTimeout(() => copy(location.href, "Link copied"), 200) },
      ],
    });
  }

  function cli() {
    const st = store.get();
    return cliCommand({
      ids: st.sel.selected, scope: scope(), target: st.target, defaultTarget: manifest.default_target,
      isHub: (id) => manifest.modelById.get(id)?.source === "hub", hubBaseline: manifest.baseline, allSeasons: allSeasons.length,
    });
  }
  function download(kind) {
    if (!cur || respKey !== cur.key) { toast(cur && !failed ? "Still scoring" : "Nothing scored"); return; }
    const st = store.get(), sc = scope();
    const ids = [...order.ranked, ...order.unranked].map((r) => r.id);
    const data = exportRows(resp, {
      order: ids, ranks: order.ranks, scope: sc, target: st.target, sourceOf, full: respFull,
      wins: !cur.quick ? resp : quickQ === cur.quick ? quick : null,
      scopeLabel: [fPlace.textContent, fDates.textContent, fHz.textContent].join(" · "),
    });
    const text = kind === "json" ? JSON.stringify({ scope: sc, target: st.target, baseline_model: resp.baseline_model, rows: data }, null, 2) : delimited(data, kind);
    const mime = kind === "json" ? "application/json" : kind === "tsv" ? "text/tab-separated-values" : "text/csv;charset=utf-8";
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const link = h("a", { href: url, download: exportName(st.sel.selected, sc, st.target, kind) });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function copy(text, done) {
    try { await navigator.clipboard.writeText(text); toast(done); } catch { toast("Can't copy", { tone: "error" }); }
  }

  /* ---------------- wiring ---------------- */
  offs.push(store.on((st, prev, changed) => {
    if (!["scope", "sel", "date", "location", "target"].some((k) => changed.has(k))) return;
    if (changed.size === 1 && changed.has("date") && manifest.seasonOf(st.date) === manifest.seasonOf(prev.date)) return;
    request();
  }));
  offs.push(store.select(["scores", "focus"], render));
  const ro = new ResizeObserver(() => drawFigures());
  ro.observe(figs);
  offs.push(() => ro.disconnect());
  request();

  /* What the model sheet reads: the leaderboard's order, a model's row in this scope (from the response
   * shown when it has the model, else one request of the sheet's own), and the scope line's words. */
  const sheetCache = new Map();
  const getJ = (q) => {
    const reqUrl = apiUrl(`/api/next/metrics?${q}`);
    if (!sheetCache.has(reqUrl)) sheetCache.set(reqUrl, fetch(reqUrl).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }));
    return sheetCache.get(reqUrl);
  };
  ctx.scores = {
    order: () => [...order.ranked, ...order.unranked].map((r) => r.id),
    async rowFor(id) {
      const st = store.get(), sc = scope();
      const label = (x) => manifest.label(x, [...st.sel.selected, sc.baseline, id]);
      const team = (x) => { const m = manifest.modelById.get(x); return m && m.team && m.team !== label(x) ? m.team : ""; };
      const scopeText = [...root.querySelectorAll(".sc-frags .sc-frag")].map((b) => b.textContent.trim()).filter((t) => t && t !== "↓").join(" · ");
      const ranked = order.ranked.map((r) => r.id);
      const make = (resp, full) => {
        const rs = rowsFrom(resp, { ids: [id], baseline: sc.baseline, full, wins: null, pending: false, scale: sc.scale, label, team });
        const rank = order.ranks.get(id) ?? null;
        return { row: rs.find((r) => r.id === id), base: rs.find((r) => r.baseline), scope: sc, baseline: resp?.baseline_model || sc.baseline, scopeText, rank, of: rank != null ? ranked.length : null };
      };
      const fresh = cur && respKey === cur.key && resp;
      if (fresh && resp.rankings?.some((r) => r.model_id === id)) return make(resp, respFull);
      const req = metricsRequest(sc, { target: st.target, selected: [...new Set([...st.sel.selected, id])], allSeasons, availableHorizons: availH() });
      const [j, f] = await Promise.all([getJ(req.query), req.full ? getJ(req.full) : null]);
      return make(j, f);
    },
  };
  // an old link's open=<ids> (expanded rows): the first opens as the model sheet
  { const was = uiOf(store.get()).open; if (was?.length) { setUi({ open: [] }); openSheet(was[0]); } }

  return {
    destroy() {
      if (ctx.scores?.rowFor) ctx.scores = null;
      dead = true;
      offs.forEach((f) => f());
      previewChart(null);
      root.remove();
    },
  };
}
