/* The map section: one model's forecast against what was observed, state by state, for the chart's
 * round and one horizon. A US tile grid (the location picker's) on the paper; the inspected state
 * (hovered, else the chart's location, else the highest) is read out beside it. Clicking a state makes
 * it the chart's location.
 *
 * Data: /api/next/spatial (/api/spatial unrounded, so proportion targets keep their values). Per-100k
 * layers are offered for count targets only. */
import { storage, onThemeChange } from "../../lib/dom.js";
import { valueFormat, fmtDay, fmtLong } from "../../lib/format.js";
import { parseIso } from "../../lib/scale.js";
import { TILES, COLUMNS } from "../../features/LocationPicker.js";
import { slotOf } from "../../features/selection.js";
import {
  h, linkStyle, frame, fragment, action, setLine, getJson, query, isAbort, sequential, diverging, inkOn,
  resetColors, places,
} from "../heatmap/shared.js";

const KEY = "viz.map";
const PLAY_MS = 1200;
const ROWS = 8;
const fin = (x) => typeof x === "number" && Number.isFinite(x);

/** The layers, in menu order. `counts`: only for count targets (per 100k means nothing for a share). */
const LAYERS = [
  { id: "f_rate", label: "Forecast / 100k", counts: true, kind: "seq" },
  { id: "f_count", label: "Forecast", kind: "seq" },
  { id: "o_rate", label: "Observed / 100k", counts: true, kind: "seq" },
  { id: "observed", label: "Observed", kind: "seq" },
  { id: "error", label: "Error", kind: "div" },
  { id: "trend", label: "Change vs. nowcast", kind: "div" },
  { id: "wis", label: "WIS", kind: "seq" },
];

/** @returns {{ destroy(): void }} */
export function mount(el, ctx) {
  linkStyle("map");
  const { manifest, store } = ctx;
  const P = places(manifest);
  const f = frame(el, "Map");
  const saved = storage.get(KEY, {}) || {};
  let layer = saved.layer || "f_rate", horizon = [0, 1, 2, 3].includes(saved.horizon) ? saved.horizon : 1, model = null;
  let data = null, reqKey = "", hoverAbbr = null, timer = 0;
  const slot = {};

  const target = () => manifest.targetById.get(store.get().target);
  const counts = () => target()?.scale !== "proportion";
  const vf = () => valueFormat(target());
  const layers = () => LAYERS.filter((l) => counts() || !l.counts);
  const layerOf = () => layers().find((l) => l.id === layer) || layers()[0];
  const save = () => storage.set(KEY, { layer, horizon });

  // ---------------------------------------------------------------- the control line
  const candidates = () => {
    const s = store.get(), ids = [...s.sel.selected];
    if (manifest.baseline && !ids.includes(manifest.baseline)) ids.push(manifest.baseline);
    return ids;
  };
  const withData = () => candidates().filter((id) => data && Object.values(data.states).some((st) => st.models?.[id]));
  const F = {
    model: fragment({ label: "Model", title: "Model", items: () => withData().map((id) => ({ value: id, label: manifest.label(id, candidates()) })),
      value: () => model, onSelect: (v) => { model = v; render(); } }),
    layer: fragment({ label: "Layer", title: "Layer", items: () => layers().map((l) => ({ value: l.id, label: l.label })),
      value: () => layerOf().id, isDefault: () => layerOf().id === layers()[0].id, onSelect: (v) => { layer = v; save(); render(); } }),
    horizon: fragment({ label: "Horizon", title: "Horizon", items: () => [0, 1, 2, 3].map((x) => ({ value: x, label: `${x} wk ahead`, short: `${x} wk ahead` })),
      value: () => horizon, isDefault: () => horizon === 1, onSelect: (v) => { stop(); horizon = v; save(); render(); } }),
  };
  const play = action("▶", "Play horizons", () => (timer ? stop() : start()));
  function start() {
    play.textContent = "❚❚"; play.classList.add("is-on"); play.setAttribute("aria-label", "Pause");
    timer = setInterval(() => { horizon = (horizon + 1) % 4; render(); }, PLAY_MS);
  }
  function stop() {
    if (!timer) return;
    clearInterval(timer); timer = 0;
    play.textContent = "▶"; play.classList.remove("is-on"); play.setAttribute("aria-label", "Play horizons");
  }
  function syncLine() {
    Object.values(F).forEach((b) => b.sync());
    setLine(f.line, [F.model, F.layer, F.horizon]);
    F.horizon.after(play);
    play.classList.add("v-tight");
  }

  // ---------------------------------------------------------------- the figure
  const grid = h("div", { class: "mp-grid", role: "group", "aria-label": "States", style: { "--cols": COLUMNS, "--rows": ROWS } });
  const tiles = new Map();
  for (const [abbr, [c, r]] of Object.entries(TILES)) {
    const loc = P.byAbbr.get(abbr);
    if (!loc) continue;
    const b = h("button", { type: "button", class: "mp-tile", style: { gridColumn: c + 1, gridRow: r + 1 }, "aria-label": loc.name },
      h("span", { class: "mp-abbr" }, abbr), h("span", { class: "mp-val" }));
    b.addEventListener("pointerenter", () => { hoverAbbr = abbr; inspect(); });
    b.addEventListener("focus", () => { hoverAbbr = abbr; inspect(); });
    b.addEventListener("click", () => store.set({ location: loc.id }));
    tiles.set(abbr, b);
    grid.append(b);
  }
  grid.addEventListener("pointerleave", () => { hoverAbbr = null; inspect(); });
  grid.addEventListener("focusout", (e) => { if (!grid.contains(e.relatedTarget)) { hoverAbbr = null; inspect(); } });
  const legend = h("div", { class: "mp-legend" });
  const summary = h("p", { class: "v-note mp-summary" });
  const aside = h("div", { class: "mp-aside" });
  f.body.append(h("div", { class: "mp-wrap" }, h("div", { class: "mp-map" }, grid, legend, summary), aside));

  // ---------------------------------------------------------------- values
  const stateOf = (abbr) => data?.states?.[abbr];
  const entry = (abbr, hz = horizon) => stateOf(abbr)?.models?.[model]?.[hz] ?? null;
  const tedOf = (hz = horizon) => data?.dates_by_horizon?.[hz];
  function valueAt(abbr, id, hz = horizon) {
    const st = stateOf(abbr), e = entry(abbr, hz);
    const truth = st?.truth?.[tedOf(hz)];
    switch (id) {
      case "f_rate": return e?.rate_per_100k;
      case "f_count": return e?.median;
      case "o_rate": return fin(truth) && st.population > 1 ? (truth / st.population) * 1e5 : NaN;
      case "observed": return truth;
      case "error": return fin(e?.median) && fin(truth) ? e.median - truth : NaN;
      case "trend": return hz === 0 ? NaN : e?.trend_pct;
      case "wis": return e?.wis;
      default: return NaN;
    }
  }
  // one scale for all four horizons, so playing through them never rescales
  function domain(id) {
    let m = 0;
    for (const abbr of tiles.keys()) for (let hz = 0; hz < 4; hz++) { const v = valueAt(abbr, id, hz); if (fin(v)) m = Math.max(m, Math.abs(v)); }
    return id === "trend" ? 50 : m;
  }
  function fmt(id, v) {
    if (!fin(v)) return "–";
    if (id === "f_rate" || id === "o_rate") return v.toFixed(v < 10 ? 2 : 1);
    if (id === "trend") return `${v > 0 ? "+" : ""}${Math.round(v)}%`;
    if (id === "error") return `${v > 0 ? "+" : v < 0 ? "−" : ""}${vf().compact(Math.abs(v))}`;
    return vf().compact(v);
  }
  const colorFor = (L, v, max) => (L.kind === "div" ? diverging(max ? v / max : 0) : sequential(max ? Math.sqrt(Math.max(0, v) / max) : 0));

  // ---------------------------------------------------------------- loading
  function load(force = false) {
    const s = store.get();
    const p = { target: s.target, date: s.date, models: candidates().join(",") };
    const key = query(p);
    if (key === reqKey && data && !force) { render(); return; }
    reqKey = key;
    f.loading(true);
    getJson(`/api/next/spatial?${key}`, { slot }).then((j) => {
      if (key !== reqKey) return;
      data = j; f.loading(false);
      pickModel();
      render();
    }, (e) => {
      if (isAbort(e)) return;
      f.loading(false); data = null;
      f.empty("Can't load the map", () => load(true));
    });
  }
  function pickModel() {
    const ok = withData();
    if (ok.includes(model)) return;
    const s = store.get();
    const charted = [...s.sel.charted].sort((a, b) => a.slot - b.slot).map((c) => c.id);
    model = charted.find((id) => ok.includes(id)) ?? ok[0] ?? null;
  }

  // ---------------------------------------------------------------- drawing
  function render() {
    syncLine();
    const s = store.get();
    if (!data) return;
    if (!model) { f.empty(`No forecasts · ${fmtLong(parseIso(s.date))}`); return; }
    f.empty(null);
    const L = layerOf(), max = domain(L.id);
    const here = P.abbrOf(s.location);
    for (const [abbr, b] of tiles) {
      const v = valueAt(abbr, L.id);
      const has = fin(v);
      b.classList.toggle("has-value", has);
      b.classList.toggle("is-here", abbr === here);
      const fill = has ? colorFor(L, v, max) : "";
      b.style.background = fill;
      b.style.color = has ? inkOn(fill) : "";
      b.lastChild.textContent = has ? fmt(L.id, v) : "";
      b.setAttribute("aria-pressed", String(abbr === here));
    }
    drawLegend(L, max);
    drawSummary();
    inspect();
  }

  function drawLegend(L, max) {
    const stops = Array.from({ length: 9 }, (_, i) => (L.kind === "div" ? diverging(i / 4 - 1) : sequential(i / 8)));
    const lo = L.kind === "div" ? fmt(L.id, -max) : fmt(L.id, 0), hi = fmt(L.id, max);
    legend.replaceChildren(
      h("span", { class: "mp-legend-label" }, L.label),
      h("span", { class: "mp-legend-num" }, lo),
      h("span", { class: "mp-ramp", style: { background: `linear-gradient(90deg, ${stops.join(", ")})` } }),
      h("span", { class: "mp-legend-num" }, hi),
      h("span", { class: "mp-legend-label" }, `${fmtDay(parseIso(tedOf()))} · ${horizon} wk ahead`),
    );
  }

  function drawSummary() {
    let top = null, rising = 0, falling = 0, steady = 0, total = 0, n = 0;
    const rateId = counts() ? "f_rate" : "f_count";
    for (const abbr of tiles.keys()) {
      const e = entry(abbr);
      if (!e) continue;
      { const r = valueAt(abbr, rateId); if (fin(r) && (!top || r > top.v)) top = { abbr, v: r }; }
      if (horizon > 0 && fin(e.trend_pct)) { if (e.trend_pct > 5) rising++; else if (e.trend_pct < -5) falling++; else steady++; }
      if (counts() && fin(e.median)) { total += e.median; n++; }
    }
    const parts = [];
    if (top) parts.push(["Highest", `${top.abbr} ${fmt(rateId, top.v)}${counts() ? " / 100k" : ""}`]);
    if (horizon > 0 && rising + falling + steady) parts.push(["Rising", rising], ["Falling", falling], ["Steady", steady]);
    if (n) parts.push([`Sum of ${n}`, vf().value(total)]);
    summary.replaceChildren(...parts.flatMap(([k, v], i) => [i ? " · " : "", `${k} `, h("b", null, String(v))]));
  }

  /* The readout beside the map: the hovered state, else the chart's location, else the highest. */
  function inspect() {
    if (!data || !model) { aside.replaceChildren(); return; }
    const s = store.get(), here = P.abbrOf(s.location);
    let abbr = hoverAbbr || (tiles.has(here) ? here : null);
    if (!abbr) {
      const id = layerOf().id;
      abbr = [...tiles.keys()].reduce((a, b) => ((valueAt(b, id) || -Infinity) > (valueAt(a, id) || -Infinity) ? b : a), [...tiles.keys()][0]);
    }
    const st = stateOf(abbr), loc = P.byAbbr.get(abbr), e = entry(abbr), V = vf();
    const truth = st?.truth?.[tedOf()];
    const rows = [];
    const row = (k, v, sub, cls) => rows.push(h("div", { class: ["mp-row", cls] }, h("dt", null, k), h("dd", null, v, sub ? h("small", null, sub) : null)));
    if (!e) row("Forecast", "–", "none from this model");
    else {
      row("Forecast", V.value(e.median), fin(e.q025) && fin(e.q975) ? `95% ${V.value(e.q025)}–${V.value(e.q975)}` : null);
      row("Observed", fin(truth) ? V.value(truth) : "Pending", null, fin(truth) ? null : "is-quiet");
      if (fin(truth) && fin(e.median)) {
        const where = fin(e.q025) && fin(e.q975) ? (truth < e.q025 ? "below 95%" : truth > e.q975 ? "above 95%" : "inside 95%") : null;
        row("Error", fmt("error", e.median - truth), where);
      }
      if (counts() && fin(e.rate_per_100k)) row("Per 100k", e.rate_per_100k.toFixed(2));
      if (horizon > 0 && fin(e.trend_pct)) row("vs. nowcast", fmt("trend", e.trend_pct));
      if (fin(e.wis)) row("WIS", V.value(e.wis));
    }
    const sl = slotOf(s.sel, model);
    const dot = model === manifest.baseline ? "var(--series-baseline)" : sl == null ? null : `var(--series-${(sl % 8) + 1})`;
    aside.replaceChildren(
      h("p", { class: "mp-place" }, loc?.name ?? abbr),
      h("p", { class: "mp-meta" }, [
        loc?.population ? `${valueFormat(null).value(loc.population)} residents` : null,
        `${fmtDay(parseIso(tedOf()))} · ${horizon} wk ahead`,
      ].filter(Boolean).join(" · ")),
      h("p", { class: "mp-model" }, h("span", { class: "v-name", style: dot ? { "--c": dot } : null }, h("i"), manifest.label(model, candidates()))),
      h("dl", { class: "mp-rows" }, rows),
    );
  }

  // ---------------------------------------------------------------- reacting
  const offs = [
    onThemeChange(() => { resetColors(); render(); }),
    store.on((s, prev, changed) => {
      if (["target", "date", "sel"].some((k) => changed.has(k))) load();
      else if (changed.has("location")) render();
    }),
  ];
  syncLine();
  load();
  return { destroy() { stop(); slot._ctl?.abort(); offs.forEach((off) => off()); } };
}
