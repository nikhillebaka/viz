/* The map section: one model's forecast against what was observed across the hub's native geography:
 *   - us-states: 11x8 US state tile map
 *   - eu-countries: proportioned (or uniform 1x1) Europe squircle tile map
 *   - us-metrocast: 15-state overview + interactive SVG state HSA polygon choropleth
 * Clicking a jurisdiction or HSA updates the chart's location.
 *
 * Data: /api/next/spatial (/api/spatial unrounded with `locations` keyed by unique loc_id). */
import { onThemeChange } from "../../lib/dom.js";
import { valueFormat, fmtDay, fmtLong } from "../../lib/format.js";
import { parseIso } from "../../lib/scale.js";
import { slotOf, COLORS } from "../../features/selection.js";
import {
  EU_GRID_PROPORTIONED,
  EU_GRID_UNIFORM,
  EU_TILES_PROPORTIONED,
  EU_TILES_PROPORTIONED_UK_SPLIT,
  EU_TILES_UNIFORM,
  EU_TILES_UNIFORM_UK_SPLIT,
  US_STATE_META,
} from "../../geo/eu_tiles.js";
import { TILES, COLUMNS, classifyHubGeo, loadUsGeoCache, renderHsaStateSvg } from "../../geo/picker_geo.js";
import { targetHorizons } from "../scope.js";
import {
  h, linkStyle, frame, fragment, action, setLine, getJson, query, isAbort, sequential, diverging, inkOn,
  resetColors, onScreen, viewState,
} from "../shared.js";

const KEY = "viz.map";
const PLAY_MS = 1200;
const US_ROWS = 8;
const fin = (x) => typeof x === "number" && Number.isFinite(x);

const LAYERS = [
  { id: "f_rate", label: "Forecast / 100k", counts: true, kind: "seq" },
  { id: "f_count", label: "Forecast", kind: "seq" },
  { id: "o_rate", label: "Observed / 100k", counts: true, kind: "seq" },
  { id: "observed", label: "Observed", kind: "seq" },
  { id: "error", label: "Error", kind: "div" },
  { id: "trend", label: "Change vs. nowcast", kind: "div", minHorizon: 1 },
  { id: "wis", label: "WIS", kind: "seq" },
];

/** @returns {{ destroy(): void }} */
export function mount(el, ctx) {
  linkStyle("map");
  const { manifest, store } = ctx;
  const geoCls = classifyHubGeo(manifest);
  const f = frame(el, "Map", "map");
  const vs = viewState(store, "map", KEY);
  const saved = vs.initial;
  let layer = saved.layer || "f_rate";
  let horizon = Number.isInteger(saved.horizon) && saved.horizon >= 0 ? saved.horizon : 1;
  let euShape = "proportioned";
  let mcFips = geoCls.kind === "us-metrocast"
    ? (geoCls.stateFipsOf(store.get().location) || (geoCls.coveredStateFips.size === 1 ? [...geoCls.coveredStateFips][0] : [...geoCls.coveredStateFips][0] || null))
    : null;
  let mcView = geoCls.kind === "us-metrocast" && mcFips ? "state" : "states";
  let model = null;
  let data = null, usGeo = null, reqKey = "", hoverId = null, timer = 0;
  const slot = {};

  const target = () => manifest.targetById.get(store.get().target);
  const isCategorical = () => {
    const t = target();
    return Boolean(t?.is_categorical || (t?.output_types?.length && !t.output_types.includes("quantile")));
  };
  const counts = () => {
    const t = target();
    return !t?.is_rate && t?.scale !== "proportion" && t?.per_100k_capable !== false;
  };
  const vf = () => valueFormat(target());
  const baseId = () => { const s = store.get(); return manifest.baselineFor?.(s.target, s.date) ?? manifest.baseline; };
  const layers = () => LAYERS.filter((l) => counts() || !l.counts);
  const layerOf = () => layers().find((l) => l.id === layer) || layers()[0];
  const minH = () => layerOf().minHorizon || 0;
  const availHorizons = () => (
    data?.available_horizons?.length
      ? data.available_horizons
      : targetHorizons(manifest, store.get().target)
  );
  const save = () => vs.write({ layer, horizon }, layer === LAYERS[0].id && horizon === 1);

  const candidates = () => {
    const s = store.get(), ids = [...s.sel.selected], base = baseId();
    if (base && !ids.includes(base)) ids.push(base);
    return ids;
  };
  const locRecord = (id) => {
    if (!id || !data) return null;
    if (data.locations?.[id]) return data.locations[id];
    const abbr = manifest.locationById.get(id)?.abbr;
    return abbr ? data.states?.[abbr] ?? null : null;
  };
  const withData = () => candidates().filter((id) => {
    const recs = Object.values(data?.locations || data?.states || {});
    return recs.some((st) => st.models?.[id]);
  });

  const mcStateItems = () => [
    { value: "states", label: `All states (${geoCls.coveredStateFips.size})` },
    "-",
    ...[...geoCls.coveredStateFips]
      .sort((a, b) => (US_STATE_META[a]?.name || a).localeCompare(US_STATE_META[b]?.name || b))
      .map((fips) => ({ value: fips, label: geoCls.stateByFips.get(fips)?.name || US_STATE_META[fips]?.name || fips })),
  ];

  const F = {
    mcState: fragment({
      label: "State", title: "MetroCast state",
      items: mcStateItems,
      value: () => (mcView === "states" ? "states" : mcFips),
      isDefault: () => false,
      onSelect: (v) => {
        if (v === "states") { mcView = "states"; hoverId = null; buildView(); render(); }
        else { mcView = "state"; mcFips = v; hoverId = null; buildView(); render(); }
      },
    }),
    shape: fragment({
      label: "Tiles", title: "Tile shape",
      items: () => [{ value: "proportioned", label: "Proportioned" }, { value: "uniform", label: "Uniform 1×1" }],
      value: () => euShape, isDefault: () => euShape === "proportioned",
      onSelect: (v) => { euShape = v; hoverId = null; buildView(); render(); },
    }),
    model: fragment({
      label: "Model", title: "Model",
      items: () => withData().map((id) => ({ value: id, label: manifest.label(id, candidates()) })),
      value: () => model, onSelect: (v) => { model = v; render(); },
    }),
    layer: fragment({
      label: "Layer", title: "Layer",
      items: () => layers().map((l) => ({ value: l.id, label: l.label, disabled: horizon < (l.minHorizon || 0) })),
      value: () => layerOf().id, isDefault: () => layerOf().id === layers()[0].id,
      onSelect: (v) => { layer = v; save(); render(); },
    }),
    horizon: fragment({
      label: "Horizon", title: "Horizon",
      items: () => availHorizons().map((x) => ({ value: x, label: `${x} wk ahead`, short: `${x} wk ahead`, disabled: x < minH() })),
      value: () => horizon, isDefault: () => horizon === 1,
      onSelect: (v) => { stop(); horizon = v; save(); render(); },
    }),
  };

  const play = action("▶", "Play horizons", () => (timer ? stop() : start()));
  function start() {
    play.textContent = "❚❚"; play.classList.add("is-on"); play.setAttribute("aria-label", "Pause");
    const hs = availHorizons().filter((x) => x >= minH());
    timer = setInterval(() => {
      if (!hs.length) return;
      const idx = hs.indexOf(horizon);
      horizon = idx >= 0 && idx + 1 < hs.length ? hs[idx + 1] : hs[0];
      render();
    }, PLAY_MS);
  }
  function stop() {
    if (!timer) return;
    clearInterval(timer); timer = 0;
    play.textContent = "▶"; play.classList.remove("is-on"); play.setAttribute("aria-label", "Play horizons");
  }
  function syncLine() {
    Object.values(F).forEach((b) => b.sync());
    const parts = [
      geoCls.kind === "us-metrocast" && F.mcState,
      geoCls.kind === "eu-countries" && F.shape,
      F.model,
      F.layer,
      F.horizon,
    ].filter(Boolean);
    setLine(f.line, parts);
    F.horizon.after(play);
    play.classList.add("v-tight");
  }

  // ---------------------------------------------------------------- DOM skeleton
  const mapHost = h("div", { class: "mp-host" });
  const legend = h("div", { class: "mp-legend" });
  const summary = h("p", { class: "v-note mp-summary" });
  const aside = h("div", { class: "mp-aside" });
  f.body.append(h("div", { class: "mp-wrap" }, h("div", { class: "mp-map" }, mapHost, legend, summary), aside));

  const tileButtons = new Map(); // id -> HTMLButtonElement (either locId or stateFips wrapper)
  let activeLocIds = [];         // ids contributing to scale/summary in the visible view

  function buildView() {
    tileButtons.clear();
    activeLocIds = [];
    hoverId = null;

    if (geoCls.kind === "eu-countries") {
      const tilesSpec = euShape === "uniform"
        ? (geoCls.ukSplitAvailable ? EU_TILES_UNIFORM_UK_SPLIT : EU_TILES_UNIFORM)
        : (geoCls.ukSplitAvailable ? EU_TILES_PROPORTIONED_UK_SPLIT : EU_TILES_PROPORTIONED);
      const gridDims = euShape === "uniform" ? EU_GRID_UNIFORM : EU_GRID_PROPORTIONED;
      const tilePx = euShape === "uniform" ? 50 : 42;
      const grid = h("div", {
        class: "mp-grid", role: "group", "aria-label": "Countries",
        style: { "--cols": gridDims.cols, "--rows": gridDims.rows, "--tile": `${tilePx}px` },
      });
      for (const [id, [c, r, w = 1, hs = 1]] of Object.entries(tilesSpec)) {
        const loc = manifest.locationById.get(id);
        if (!loc) continue;
        const btn = h("button", {
          type: "button",
          class: ["mp-tile", w * hs === 1 && "is-compact"],
          style: { gridColumn: `${c} / span ${w}`, gridRow: `${r} / span ${hs}` },
          "aria-label": loc.name || id,
        }, h("span", { class: "mp-abbr" }, loc.abbr || id), h("span", { class: "mp-val" }));
        btn.addEventListener("pointerenter", () => { hoverId = id; inspect(); });
        btn.addEventListener("focus", () => { hoverId = id; inspect(); });
        btn.addEventListener("click", () => { store.set({ location: id }); });
        tileButtons.set(id, btn);
        activeLocIds.push(id);
        grid.append(btn);
      }
      grid.addEventListener("pointerleave", () => { hoverId = null; inspect(); });
      grid.addEventListener("focusout", (e) => { if (!grid.contains(e.relatedTarget)) { hoverId = null; inspect(); } });
      mapHost.replaceChildren(grid);
      return;
    }

    if (geoCls.kind === "us-metrocast") {
      if (mcView === "state" && mcFips) {
        const hsas = geoCls.hsasByStateFips.get(mcFips) || [];
        activeLocIds = hsas.map((x) => x.id);
        const box = h("div", { class: "mp-hsa-box" });
        mapHost.replaceChildren(box);
        if (!usGeo) {
          box.replaceChildren(h("p", { class: "v-empty" }, "Loading boundaries…"));
          loadUsGeoCache().then((g) => {
            usGeo = g;
            if (box.isConnected) render();
          }).catch(() => {});
        }
        return;
      }

      // 15-state MetroCast US overview grid
      const grid = h("div", { class: "mp-grid", role: "group", "aria-label": "Covered states", style: { "--cols": COLUMNS, "--rows": US_ROWS } });
      for (const [abbr, [c, r]] of Object.entries(TILES)) {
        const fips = Object.entries(US_STATE_META).find(([, v]) => v.abbr === abbr)?.[0];
        const isCovered = fips && geoCls.coveredStateFips.has(fips);
        const loc = isCovered ? geoCls.stateByFips.get(fips) : null;
        const btn = h("button", {
          type: "button",
          class: ["mp-tile", !isCovered && "is-muted"],
          disabled: !isCovered,
          style: { gridColumn: c + 1, gridRow: r + 1 },
          "aria-label": loc?.name || US_STATE_META[fips]?.name || abbr,
        }, h("span", { class: "mp-abbr" }, abbr), h("span", { class: "mp-val" }));
        if (loc) {
          tileButtons.set(loc.id, btn);
          activeLocIds.push(loc.id);
          btn.addEventListener("pointerenter", () => { hoverId = loc.id; inspect(); });
          btn.addEventListener("focus", () => { hoverId = loc.id; inspect(); });
          btn.addEventListener("click", () => {
            mcFips = fips;
            mcView = "state";
            store.set({ location: loc.id });
            buildView();
            render();
          });
        } else if (isCovered && fips) {
          btn.addEventListener("click", () => { mcFips = fips; mcView = "state"; buildView(); render(); });
        }
        grid.append(btn);
      }
      grid.addEventListener("pointerleave", () => { hoverId = null; inspect(); });
      grid.addEventListener("focusout", (e) => { if (!grid.contains(e.relatedTarget)) { hoverId = null; inspect(); } });
      mapHost.replaceChildren(grid);
      return;
    }

    // Standard US states 11x8 tile grid
    const grid = h("div", { class: "mp-grid", role: "group", "aria-label": "States", style: { "--cols": COLUMNS, "--rows": US_ROWS } });
    for (const [abbr, [c, r]] of Object.entries(TILES)) {
      const loc = geoCls.stateByAbbr.get(abbr);
      if (!loc) continue;
      const b = h("button", {
        type: "button", class: "mp-tile", style: { gridColumn: c + 1, gridRow: r + 1 },
        "aria-label": loc.name || abbr,
      }, h("span", { class: "mp-abbr" }, abbr), h("span", { class: "mp-val" }));
      b.addEventListener("pointerenter", () => { hoverId = loc.id; inspect(); });
      b.addEventListener("focus", () => { hoverId = loc.id; inspect(); });
      b.addEventListener("click", () => {
        const back = store.get().location === loc.id && geoCls.aggregateId;
        store.set({ location: back ? geoCls.aggregateId : loc.id });
        if (back) { hoverId = null; inspect(); }
      });
      tileButtons.set(loc.id, b);
      activeLocIds.push(loc.id);
      grid.append(b);
    }
    grid.addEventListener("pointerleave", () => { hoverId = null; inspect(); });
    grid.addEventListener("focusout", (e) => { if (!grid.contains(e.relatedTarget)) { hoverId = null; inspect(); } });
    mapHost.replaceChildren(grid);
  }

  // ---------------------------------------------------------------- values
  const stateOf = (id) => locRecord(id);
  const entry = (id, hz = horizon) => stateOf(id)?.models?.[model]?.[hz] ?? null;
  const tedOf = (hz = horizon) => data?.dates_by_horizon?.[hz];
  function valueAt(id, lId, hz = horizon) {
    const st = stateOf(id), e = entry(id, hz);
    const truth = st?.truth?.[tedOf(hz)];
    switch (lId) {
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
  function domain(lId) {
    if (lId === "trend") return 50;
    let m = 0;
    const hs = availHorizons();
    for (const id of activeLocIds) for (const hz of hs) { const v = valueAt(id, lId, hz); if (fin(v)) m = Math.max(m, Math.abs(v)); }
    return m;
  }
  function fmt(lId, v) {
    if (!fin(v)) return "–";
    if (lId === "f_rate" || lId === "o_rate") return v.toFixed(v < 10 ? 2 : 1);
    if (lId === "trend") return `${v > 0 ? "+" : ""}${Math.round(v)}%`;
    if (lId === "error") return `${v > 0 ? "+" : v < 0 ? "−" : ""}${vf().compact(Math.abs(v))}`;
    return vf().compact(v);
  }
  const colorFor = (L, v, max) => (L.kind === "div" ? diverging(max ? v / max : 0) : sequential(max ? Math.sqrt(Math.max(0, v) / max) : 0));

  // ---------------------------------------------------------------- loading
  function load(force) {
    force = force === true;
    const s = store.get();
    if (isCategorical()) {
      slot._ctl?.abort();
      reqKey = ""; data = null;
      f.loading(false);
      syncLine();
      f.empty("Categorical target — inspect rate-change probabilities above");
      return;
    }
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
    if (isCategorical()) return;
    const hs = availHorizons();
    if (!hs.includes(horizon)) horizon = hs.find((x) => x >= minH()) ?? hs[0] ?? 0;
    if (horizon < minH()) horizon = hs.find((x) => x >= minH()) ?? minH();
    syncLine();
    const s = store.get();
    if (!data) return;
    if (!model) { f.empty(`No forecasts · ${fmtLong(parseIso(s.date))}`); return; }
    f.empty(null);

    const L = layerOf(), max = domain(L.id);
    const hereId = s.location;

    if (geoCls.kind === "us-metrocast" && mcView === "state" && mcFips) {
      const box = mapHost.querySelector(".mp-hsa-box");
      if (box && usGeo) {
        const hsas = geoCls.hsasByStateFips.get(mcFips) || [];
        const svg = renderHsaStateSvg(usGeo, mcFips, hsas, {
          width: 580,
          height: 340,
          className: "mp-hsa-svg",
          bgClass: "mp-hsa-bg",
          polyClass: "mp-hsa-poly",
          activeId: hereId,
          fillFor: (id) => {
            const v = valueAt(id, L.id);
            return fin(v) ? colorFor(L, v, max) : "";
          },
          onHover: (id) => { hoverId = id; inspect(); },
          onPick: (id) => { if (manifest.locationById.has(id)) store.set({ location: id }); },
        });
        if (svg) {
          svg.addEventListener("pointerleave", () => { hoverId = null; inspect(); });
          box.replaceChildren(svg);
        }
      }
    } else {
      for (const [id, b] of tileButtons) {
        const v = valueAt(id, L.id);
        const has = fin(v);
        b.classList.toggle("has-value", has);
        b.classList.toggle("is-here", id === hereId);
        const fill = has ? colorFor(L, v, max) : "";
        b.style.background = fill;
        b.style.color = has ? inkOn(fill) : "";
        b.lastChild.textContent = has ? fmt(L.id, v) : "";
        b.setAttribute("aria-pressed", String(id === hereId));
      }
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
      h("span", { class: "mp-legend-label" }, [tedOf() ? fmtDay(parseIso(tedOf())) : null, `${horizon} wk ahead`].filter(Boolean).join(" · ")),
    );
  }

  let glance = [];
  function overview() {
    const s = store.get(), sl = slotOf(s.sel, model);
    const dot = model === baseId() ? "var(--series-baseline)" : sl == null ? null : `var(--series-${(sl % COLORS) + 1})`;
    const scopeTitle = geoCls.kind === "eu-countries"
      ? "All countries"
      : geoCls.kind === "us-metrocast"
        ? (mcView === "state" && mcFips ? `${US_STATE_META[mcFips]?.name || mcFips} HSAs` : `Covered states (${geoCls.coveredStateFips.size})`)
        : "All states";
    aside.replaceChildren(
      h("p", { class: "mp-place" }, scopeTitle),
      h("p", { class: "mp-meta" }, [tedOf() ? fmtDay(parseIso(tedOf())) : null, `${horizon} wk ahead`].filter(Boolean).join(" · ")),
      h("p", { class: "mp-model" }, h("span", { class: "v-name", style: dot ? { "--c": dot } : null, "data-model-sheet": model, title: "Details" }, h("i"), manifest.label(model, candidates()))),
      h("dl", { class: "mp-rows" }, glance.map(([k, v, sub]) => h("div", { class: "mp-row" }, h("dt", null, k), h("dd", null, v, sub ? h("small", null, sub) : null)))),
    );
  }

  function drawSummary() {
    let top = null, rising = 0, falling = 0, steady = 0, total = 0, n = 0;
    const rateId = counts() ? "f_rate" : "f_count";
    const unitPlural = geoCls.kind === "eu-countries" ? "countries" : geoCls.kind === "us-metrocast" && mcView === "state" ? "HSAs" : "states";
    for (const id of activeLocIds) {
      const e = entry(id);
      if (!e) continue;
      { const r = valueAt(id, rateId); if (fin(r) && (!top || r > top.v)) top = { id, v: r }; }
      if (horizon > 0 && fin(e.trend_pct)) { if (e.trend_pct > 5) rising++; else if (e.trend_pct < -5) falling++; else steady++; }
      if (fin(e.median)) { total += e.median; n++; }
    }
    glance = [];
    if (counts() && n) glance.push(["Total forecast", vf().value(total), `sum of ${n} ${unitPlural}`]);
    if (top) glance.push(["Highest", `${manifest.locationById.get(top.id)?.name ?? top.id}`, `${fmt(rateId, top.v)}${counts() ? " per 100k" : ""}`]);
    if (horizon > 0 && rising + falling + steady) {
      glance.push(["Rising", String(rising), "more than 5% above now"], ["Falling", String(falling), "more than 5% below now"], ["Steady", String(steady)]);
    }
    summary.replaceChildren();
  }

  function inspect() {
    if (!data || !model) { aside.replaceChildren(); return; }
    const s = store.get();
    const inspectId = hoverId || (activeLocIds.includes(s.location) ? s.location : null);
    if (!inspectId) { overview(); return; }
    const st = stateOf(inspectId), loc = manifest.locationById.get(inspectId), e = entry(inspectId), V = vf();
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
    const dot = model === manifest.baseline ? "var(--series-baseline)" : sl == null ? null : `var(--series-${(sl % COLORS) + 1})`;
    aside.replaceChildren(
      h("p", { class: "mp-place" }, loc?.name ?? inspectId),
      h("p", { class: "mp-meta" }, [
        loc?.population ? `${valueFormat(null).value(loc.population)} residents` : null,
        tedOf() ? fmtDay(parseIso(tedOf())) : null,
        `${horizon} wk ahead`,
      ].filter(Boolean).join(" · ")),
      h("p", { class: "mp-model" }, h("span", { class: "v-name", style: dot ? { "--c": dot } : null, "data-model-sheet": model, title: "Details" }, h("i"), manifest.label(model, candidates()))),
      h("dl", { class: "mp-rows" }, rows),
    );
  }

  // ---------------------------------------------------------------- reacting
  const screen = onScreen(el, (visible) => { if (!visible) stop(); });
  const offs = [
    () => screen.off(),
    onThemeChange(() => { resetColors(); screen.run(load); }),
    store.on((s, prev, changed) => {
      if (changed.has("location") && geoCls.kind === "us-metrocast") {
        const nextFips = geoCls.stateFipsOf(s.location);
        if (nextFips && nextFips !== mcFips) {
          mcFips = nextFips;
          mcView = "state";
          buildView();
        }
      }
      if (["target", "date", "sel", "location"].some((k) => changed.has(k))) screen.run(load);
    }),
  ];
  buildView();
  syncLine();
  load();
  return { destroy() { stop(); slot._ctl?.abort(); offs.forEach((off) => off()); } };
}
