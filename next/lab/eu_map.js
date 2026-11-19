/* Tab 2: Proportioned European Squircle Tile Grid Prototype (RespiCast counterpart to US Map).
 * Built strictly with /next/styles/map.css and views.css visual grammar. */
import { h } from "../lib/dom.js";
import { Segmented, pill } from "../ui/controls.js";
import { glass } from "../ui/glass.js";
import { sequential, diverging, inkOn, resetColors, action, setLine } from "../sections/shared.js";
import {
  EU_GRID_PROPORTIONED,
  EU_GRID_UNIFORM,
  EU_META,
  EU_TILES_PROPORTIONED,
  EU_TILES_PROPORTIONED_UK_SPLIT,
  EU_TILES_UNIFORM,
  EU_TILES_UNIFORM_UK_SPLIT,
} from "../geo/eu_tiles.js";
import { buildSpatialSnapshot } from "./fixtures.js";

const LAYERS = [
  { id: "rate_per_100k", label: "Forecast / 100k", kind: "seq" },
  { id: "o_rate", label: "Observed / 100k", kind: "seq" },
  { id: "error", label: "Error", kind: "div" },
  { id: "trend_pct", label: "Change vs. nowcast", kind: "div", minH: 1 },
  { id: "wis", label: "WIS", kind: "seq" },
];

const fin = (x) => typeof x === "number" && Number.isFinite(x);

export function mount(root, ctx) {
  const spatial = buildSpatialSnapshot();
  const offs = [];
  let layoutMode = "proportioned"; // "proportioned" | "uniform"
  let ukSplit = false;
  let targetKey = "eu_ili";
  let layerId = "rate_per_100k";
  let horizon = 1;
  let hoverId = null;
  let selectedId = "DE";
  let playTimer = 0;

  const paper = h("div", { class: "lab-paper" });
  const sec = h("section", { class: "v-section" });
  const line = h("div", { class: "v-line" });
  const head = h("header", { class: "v-head" },
    h("h2", { class: "v-title" }, "Europe Map"),
    line,
  );
  const body = h("div", { class: "v-body" });
  sec.append(head, body);
  paper.append(sec);
  root.replaceChildren(paper);

  // ---------------- Workshop Controls ----------------
  const sizeSeg = h("div");
  const ukBtn = pill({
    label: "UK Split (ENG / SCT / WLS / NIR)",
    size: "sm",
    pressed: ukSplit,
    onClick: () => {
      ukSplit = !ukSplit;
      ukBtn.setAttribute("aria-pressed", String(ukSplit));
      if (ukSplit && selectedId === "GB") selectedId = "GB-ENG";
      if (!ukSplit && selectedId.startsWith("GB-")) selectedId = "GB";
      buildGrid();
    },
  });
  const countTag = h("span", { class: "lab-tag" }, "RespiCast-ensemble · 33 EEA/EU/UK jurisdictions");
  const noteBar = h("div", { class: "eu-note-bar" },
    sizeSeg,
    ukBtn,
    countTag,
  );

  new Segmented(sizeSeg, {
    items: [
      { value: "proportioned", label: "Proportioned squircles" },
      { value: "uniform", label: "Uniform 1×1" },
    ],
    value: layoutMode,
    label: "European tile proportions",
    onChange: (v) => { layoutMode = v; buildGrid(); },
  });

  // Clean inline dropdown/pill controls on .v-line matching /next/ views
  const makeCycleFrag = (prefix, items, getVal, setVal) => {
    const b = h("button", { type: "button", class: "v-frag is-set" });
    b.sync = () => {
      const it = items.find((x) => x.id === getVal()) || items[0];
      b.textContent = `${prefix ? `${prefix}: ` : ""}${it.label}`;
    };
    b.addEventListener("click", () => {
      const idx = items.findIndex((x) => x.id === getVal());
      const next = items[(idx + 1) % items.length];
      setVal(next.id);
      syncAll();
    });
    b.sync();
    return b;
  };

  const targetList = Object.entries(spatial.targets).map(([id, cfg]) => ({ id, label: cfg.label }));
  const horizonList = [0, 1, 2, 3].map((x) => ({ id: x, label: `${x} wk ahead` }));

  const targetFrag = makeCycleFrag("", targetList, () => targetKey, (v) => { targetKey = v; renderValues(); });
  const layerFrag = makeCycleFrag("", LAYERS, () => layerId, (v) => {
    layerId = v;
    const L = LAYERS.find((x) => x.id === v);
    if (L?.minH && horizon < L.minH) horizon = L.minH;
    renderValues();
  });
  const horizonFrag = makeCycleFrag("", horizonList, () => horizon, (v) => {
    stopPlay();
    horizon = v;
    renderValues();
  });

  const playBtn = action("▶", "Play horizons", () => (playTimer ? stopPlay() : startPlay()));
  function startPlay() {
    playBtn.textContent = "❚❚";
    playBtn.classList.add("is-on");
    playTimer = setInterval(() => {
      const lo = LAYERS.find((x) => x.id === layerId)?.minH || 0;
      horizon = horizon >= 3 ? lo : Math.max(lo, horizon + 1);
      syncAll();
      renderValues();
    }, 1150);
  }
  function stopPlay() {
    if (!playTimer) return;
    clearInterval(playTimer);
    playTimer = 0;
    playBtn.textContent = "▶";
    playBtn.classList.remove("is-on");
  }

  function syncAll() {
    targetFrag.sync();
    layerFrag.sync();
    horizonFrag.sync();
  }
  setLine(line, [targetFrag, layerFrag, horizonFrag]);
  horizonFrag.after(playBtn);
  playBtn.classList.add("v-tight");

  // ---------------- Map & Aside ----------------
  const grid = h("div", { class: "eu-grid", role: "group", "aria-label": "European countries" });
  const legend = h("div", { class: "mp-legend" });
  const summary = h("p", { class: "v-note mp-summary" });
  const aside = h("aside", { class: "mp-aside", "aria-label": "Country inspection" });
  const wrap = h("div", { class: "mp-wrap" }, h("div", { class: "mp-map" }, grid, legend, summary), aside);
  body.append(noteBar, wrap);

  glass(sizeSeg);
  glass(ukBtn);

  const tiles = new Map();

  function activeLayoutSpec() {
    if (layoutMode === "uniform") {
      return {
        grid: EU_GRID_UNIFORM,
        tiles: ukSplit ? EU_TILES_UNIFORM_UK_SPLIT : EU_TILES_UNIFORM,
        tilePx: 50,
      };
    }
    return {
      grid: EU_GRID_PROPORTIONED,
      tiles: ukSplit ? EU_TILES_PROPORTIONED_UK_SPLIT : EU_TILES_PROPORTIONED,
      tilePx: 44,
    };
  }

  function buildGrid() {
    const spec = activeLayoutSpec();
    tiles.clear();
    grid.style.setProperty("--cols", String(spec.grid.cols));
    grid.style.setProperty("--rows", String(spec.grid.rows));
    grid.style.setProperty("--tile-base", `${spec.tilePx}px`);
    countTag.textContent = `RespiCast-ensemble · ${Object.keys(spec.tiles).length} EEA/EU/UK jurisdictions`;

    const nodes = [];
    for (const [id, [c, r, w = 1, hs = 1]] of Object.entries(spec.tiles)) {
      const meta = EU_META[id];
      if (!meta) continue;
      const area = w * hs;
      const compactCls = area === 1 ? "is-compact" : area >= 4 ? "is-wide" : "";
      const btn = h("button", {
        type: "button",
        class: ["mp-tile", compactCls],
        "aria-label": meta.name,
        style: {
          gridColumn: `${c} / span ${w}`,
          gridRow: `${r} / span ${hs}`,
        },
      },
      h("span", { class: "mp-abbr" }, meta.abbr),
      h("span", { class: "mp-val" }));

      btn.addEventListener("pointerenter", () => { hoverId = id; renderAside(); });
      btn.addEventListener("focus", () => { hoverId = id; renderAside(); });
      btn.addEventListener("click", () => {
        selectedId = id;
        renderValues();
      });
      tiles.set(id, btn);
      nodes.push(btn);
    }
    grid.replaceChildren(...nodes);
    renderValues();
  }

  grid.addEventListener("pointerleave", () => { hoverId = null; renderAside(); });
  grid.addEventListener("focusout", (e) => { if (!grid.contains(e.relatedTarget)) { hoverId = null; renderAside(); } });

  function valueOf(id, lId = layerId, hz = horizon) {
    const rec = spatial.eu[targetKey]?.[hz]?.[id];
    return rec ? rec[lId] : NaN;
  }

  function domainOf(lId) {
    if (lId === "trend_pct") return 45;
    let m = 0;
    for (const id of tiles.keys()) {
      for (let hz = 0; hz < 4; hz++) {
        const v = valueOf(id, lId, hz);
        if (fin(v)) m = Math.max(m, Math.abs(v));
      }
    }
    return m || 1;
  }

  function fmtVal(lId, v) {
    if (!fin(v)) return "–";
    if (lId === "trend_pct") return `${v > 0 ? "+" : ""}${Math.round(v)}%`;
    if (lId === "error") return `${v > 0 ? "+" : "−"}${Math.abs(Math.round(v))}`;
    if (lId === "wis") return v.toFixed(2);
    return v >= 100 ? String(Math.round(v)) : v.toFixed(1);
  }

  function colorFor(L, v, max) {
    return L.kind === "div" ? diverging(max ? v / max : 0) : sequential(max ? Math.sqrt(Math.max(0, v) / max) : 0);
  }

  function renderValues() {
    const L = LAYERS.find((x) => x.id === layerId) || LAYERS[0];
    const max = domainOf(L.id);
    const vals = [];
    for (const [id, btn] of tiles.entries()) {
      const v = valueOf(id, L.id, horizon);
      const has = fin(v);
      btn.classList.toggle("is-here", id === selectedId);
      btn.setAttribute("aria-pressed", String(id === selectedId));
      const fill = has ? colorFor(L, v, max) : "";
      btn.style.background = fill;
      btn.style.color = has ? inkOn(fill) : "";
      btn.lastChild.textContent = has ? fmtVal(L.id, v) : "–";
      if (has) vals.push({ id, v });
    }

    // Legend bar
    const stops = Array.from({ length: 9 }, (_, i) => (L.kind === "div" ? diverging(i / 4 - 1) : sequential(i / 8)));
    legend.replaceChildren(
      h("span", { class: "mp-legend-label" }, L.kind === "div" ? fmtVal(L.id, -max) : "0"),
      h("div", { class: "mp-ramp", style: { background: `linear-gradient(90deg, ${stops.join(", ")})` } }),
      h("span", { class: "mp-legend-label" }, fmtVal(L.id, max)),
      h("span", { class: "mp-legend-label mp-legend-num" }, `${tiles.size} jurisdictions · ${layoutMode === "proportioned" ? "1×1..2×3 squircles" : "uniform 1×1"}`),
    );

    if (vals.length) {
      vals.sort((a, b) => b.v - a.v);
      const top = EU_META[vals[0].id];
      const bot = EU_META[vals[vals.length - 1].id];
      summary.innerHTML = `Highest: <b>${top.name} (${fmtVal(L.id, vals[0].v)})</b> · Lowest: <b>${bot.name} (${fmtVal(L.id, vals[vals.length - 1].v)})</b> · Horizon <b>${horizon} wk ahead</b>`;
    }
    renderAside();
  }

  function renderAside() {
    const id = hoverId || selectedId || "DE";
    const meta = EU_META[id] || EU_META.DE;
    const rec = spatial.eu[targetKey]?.[horizon]?.[id];
    const tCfg = spatial.targets[targetKey];
    const popM = meta.population >= 1e6 ? `${(meta.population / 1e6).toFixed(1)}M` : `${Math.round(meta.population / 1e3)}k`;

    aside.replaceChildren(
      h("h3", { class: "mp-place" }, meta.name),
      h("p", { class: "mp-meta" }, `${meta.abbr} · ${meta.region} · Pop ${popM}`),
      h("div", { class: "mp-model" }, h("span", { class: "lab-tag is-accent" }, tCfg.hub, " · ", tCfg.label)),
      rec ? h("dl", { class: "mp-rows" },
        h("div", { class: "mp-row" }, h("dt", null, `Forecast (${horizon} wk)`), h("dd", null, `${rec.rate_per_100k} / 100k`, h("small", null, `${rec.median.toLocaleString()} cases`))),
        h("div", { class: "mp-row" }, h("dt", null, "Observed rate"), h("dd", null, fin(rec.o_rate) ? `${rec.o_rate} / 100k` : "Pending", h("small", null, fin(rec.observed) ? `${rec.observed.toLocaleString()} cases` : "Not realized"))),
        h("div", { class: "mp-row" }, h("dt", null, "Change vs nowcast"), h("dd", null, `${rec.growthPct >= 0 ? "+" : ""}${rec.growthPct}%`)),
        h("div", { class: "mp-row" }, h("dt", null, "Window WIS"), h("dd", null, fin(rec.wis) ? String(rec.wis) : "–")),
      ) : null,
      h("div", { style: { marginTop: "var(--space-16)", display: "flex", gap: "var(--space-8)" } },
        h("button", {
          type: "button", class: "gb-btn-primary",
          onclick: () => ctx.openBriefing(meta.id),
        }, "Open Place Briefing →"),
        h("button", {
          type: "button", class: "c-btn filled",
          onclick: () => ctx.focusOnGlobe(meta.id),
        }, "View on Globe"),
      ),
    );
  }

  offs.push(ctx.onThemeChange(() => {
    resetColors();
    renderValues();
  }));

  buildGrid();

  return {
    resize() {},
    destroy() {
      stopPlay();
      offs.forEach((off) => off());
    },
  };
}
