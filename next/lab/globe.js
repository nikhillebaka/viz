/* Tab 1: Ultra-Minimal Monochrome Luminance Globe (/next/ design grammar).
 * - Flat paper backdrop (zero vignette in light or dark mode)
 * - Pure monochrome luminance ramp with Layer menu (Seasonal intensity | None | signals | MetroCast metros | First-visit landing)
 * - Exact 95-HSA MetroCast geometry: non-MetroCast US counties NEVER appear; toggling MetroCast metros off removes all county splits
 * - Unopinionated Recents bar (hidden until populated) + liquid-glass + / - zoom buttons + frosted Sheet-style Place Drawer */
import { h, on, cssColor } from "../lib/dom.js";
import { glass } from "../ui/glass.js";
import { pill, icon } from "../ui/controls.js";
import { openMenu } from "../ui/floating.js";
import { fitCanvas, perFrame } from "../sections/shared.js";
import {
  arcsToUnitSphere,
  clipPolygonToHemisphere,
  clipPolylineToHemisphere,
  coneVisibleInViewport,
  decodeArcs,
  extractPolygons,
  lonLatToXYZ,
  makeRotationMatrix,
  pointInRingsEvenOdd,
  screenToLonLat,
  slerpLonLat,
  solveCameraForAnchor,
  splitDetachedTerritories,
} from "../geo/topo.js";
import { EU_META, ISO_NUM_TO_ALPHA2, US_STATE_META, lookupPlaceMeta } from "../geo/eu_tiles.js";
import { buildBriefingForPlace, metricForPlace, HUB_SCOPES, REGION_SCOPES } from "./fixtures.js";

const MAX_ZOOM = 48;
const MIN_ZOOM = 1.0;

const EU_MAINLAND_BOUNDS = Object.freeze({ minLon: -26, maxLon: 45, minLat: 33, maxLat: 73 });
const DETACH_BOUNDS_BY_ISO = Object.fromEntries(
  Object.keys(EU_META).map((iso) => [iso, EU_MAINLAND_BOUNDS]),
);

const LAYERS = [
  { id: "seasonal_intensity", label: "Seasonal intensity", low: "0%", high: "100%" },
  { id: "none", label: "None", low: "", high: "" },
  "-",
  { id: "flu_hosp", label: "Flu admissions", low: "0", high: "18 / 100k" },
  { id: "metro_ed", label: "Flu ED (MetroCast)", low: "0%", high: "9%" },
  { id: "eu_ili", label: "ILI incidence (EU)", low: "0", high: "290" },
  { id: "covid", label: "COVID-19", low: "0", high: "16 / 100k" },
  { id: "rsv", label: "RSV", low: "0", high: "12 / 100k" },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

function parseRgbCss(str) {
  const m = str.match(/[\d.]+/g);
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [245, 245, 245];
}

function buildSparklineSvg(wave) {
  if (!wave?.obs?.length) return "";
  const all = [...wave.obs.map((p) => p.val), ...(wave.forecast || []).map((p) => p.hi95)];
  const max = Math.max(1, ...all) * 1.05;
  const W = 280, H = 46;
  const nTotal = 18;
  const x = (w) => (w / (nTotal - 1)) * W;
  const y = (v) => H - 4 - (v / max) * (H - 8);
  const fPtsTop = (wave.forecast || []).map((p) => `${x(p.w).toFixed(1)},${y(p.hi95).toFixed(1)}`).join(" ");
  const fPtsBot = [...(wave.forecast || [])].reverse().map((p) => `${x(p.w).toFixed(1)},${y(p.lo95).toFixed(1)}`).join(" ");
  const obsD = wave.obs.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.w).toFixed(1)},${y(p.val).toFixed(1)}`).join(" ");
  const medD = (wave.forecast || []).map((p, i) => `${i === 0 ? "M" : "L"}${x(p.w).toFixed(1)},${y(p.med).toFixed(1)}`).join(" ");
  return `<svg class="gb-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    ${fPtsTop ? `<polygon points="${fPtsTop} ${fPtsBot}" fill="var(--accent)" fill-opacity="0.16"/>` : ""}
    <path d="${obsD}" fill="none" stroke="var(--ink-primary)" stroke-width="1.5" stroke-linecap="round"/>
    ${medD ? `<path d="${medD}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="3 2.5" stroke-linecap="round"/>` : ""}
  </svg>`;
}

let worldGeoPromise = null;
function loadWorldCountries() {
  if (!worldGeoPromise) {
    const worldUrl = new URL("../geo/world-countries-50m.json", import.meta.url).href;
    worldGeoPromise = fetch(worldUrl).then((r) => r.json()).then((worldTopo) => {
      const worldArcs = arcsToUnitSphere(decodeArcs(worldTopo));
      const raw = extractPolygons(worldTopo, "countries", worldArcs).map((f) => ({
        ...f,
        iso2: ISO_NUM_TO_ALPHA2[String(f.id).padStart(3, "0")] || ISO_NUM_TO_ALPHA2[String(f.id)] || null,
      }));
      return splitDetachedTerritories(raw, DETACH_BOUNDS_BY_ISO);
    });
  }
  return worldGeoPromise;
}

let geoCachePromise = null;
async function loadGlobeGeometry(ctx) {
  if (geoCachePromise) return geoCachePromise;
  geoCachePromise = (async () => {
    const [countries, usGeo] = await Promise.all([
      loadWorldCountries(),
      ctx.loadUsGeo(),
    ]);

    const gratLat = [];
    for (let lat = -60; lat <= 60; lat += 30) {
      const pts = [];
      for (let lon = -180; lon <= 180; lon += 6) pts.push(...lonLatToXYZ(lon, lat));
      gratLat.push(new Float32Array(pts));
    }
    const gratLon = [];
    for (let lon = -180; lon < 180; lon += 30) {
      const pts = [];
      for (let lat = -84; lat <= 84; lat += 6) pts.push(...lonLatToXYZ(lon, lat));
      gratLon.push(new Float32Array(pts));
    }

    return {
      countries,
      states: usGeo.states,
      stateMesh: usGeo.stateMesh,
      metroMesh: usGeo.metroMesh,
      metroFeatures: usGeo.metroFeatures,
      coveredStates: usGeo.coveredStates,
      hsasData: usGeo.hsasData,
      gratLat,
      gratLon,
    };
  })();
  return geoCachePromise;
}

export function mount(root, ctx) {
  const offs = [];
  let destroyed = false;
  let geo = null;

  let camLon = -94;
  let camLat = 38.5;
  let camZoom = 2.0;
  let velLon = 0;
  let velLat = 0;
  let flight = null;

  let layerId = "seasonal_intensity";
  let metroCastOn = true;
  let hoverItem = null; // { kind: "metro"|"state"|"country", id, name, meta }
  let selectedId = null;
  let onboardOpen = false;

  let hitCountries = [];
  let hitStates = [];
  let hitMetros = [];
  let hitDots = [];
  let lastGeoSpec = { cx: 0, cy: 0, radiusPx: 1, R: null };

  /* ---------------- DOM ---------------- */
  const wrap = h("div", { class: "gb-wrap" });
  const canvas = h("canvas", { class: "gb-canvas", "aria-label": "Interactive monochrome globe" });
  const recentsEl = h("div", { class: "gb-recents", hidden: true, role: "group", "aria-label": "Recent places" });
  const hudBL = h("div", { class: "gb-hud-bl" });
  const hudBR = h("div", { class: "gb-hud-br" });
  const readout = h("div", { class: "c-readout v-readout", role: "status", hidden: true });

  const layerBtn = pill({
    label: "Layer: Seasonal intensity",
    size: "sm",
    chevron: true,
    ariaLabel: "Globe layer menu",
    onClick: () => openLayerMenu(),
  });
  const keyWrap = h("div", { class: "gb-key" });
  hudBL.append(layerBtn, keyWrap);

  const zoomInBtn = pill({ label: "+", size: "sm", className: "icon", ariaLabel: "Zoom in", onClick: () => zoomByFactor(1.48) });
  const zoomOutBtn = pill({ label: "−", size: "sm", className: "icon", ariaLabel: "Zoom out", onClick: () => zoomByFactor(1 / 1.48) });
  hudBR.append(zoomInBtn, zoomOutBtn);

  const drawer = h("aside", { class: "c-panel gb-drawer", hidden: true, "aria-label": "Place summary" });
  const onboardModal = h("div", { class: "c-panel gb-onboard", hidden: true, role: "dialog", "aria-label": "Set default scope" });

  wrap.append(canvas, recentsEl, hudBL, hudBR, drawer, onboardModal, readout);
  root.replaceChildren(wrap);

  const gLayer = glass(layerBtn);
  glass(keyWrap);
  glass(zoomInBtn);
  glass(zoomOutBtn);
  glass(drawer, { panel: true });
  glass(onboardModal, { panel: true });
  document.fonts?.ready?.then(() => gLayer.update());

  function updateLegendAndLabel() {
    const def = LAYERS.find((x) => typeof x === "object" && x.id === layerId) || LAYERS[0];
    const lbl = layerBtn.querySelector(".c-pill-label");
    if (lbl) lbl.textContent = `Layer: ${def.label}`;
    gLayer.update();

    if (layerId === "none") {
      keyWrap.hidden = true;
      return;
    }
    keyWrap.hidden = false;
    const isLight = document.documentElement.dataset.theme === "light";
    const ink = parseRgbCss(cssColor("var(--ink-primary)"));
    const lowCol = `rgba(${ink[0]}, ${ink[1]}, ${ink[2]}, ${isLight ? 0.06 : 0.06})`;
    const hiCol = `rgba(${ink[0]}, ${ink[1]}, ${ink[2]}, ${isLight ? 0.62 : 0.56})`;
    const layerNodes = [...keyWrap.querySelectorAll(":scope > .c-glass-layer")];
    keyWrap.replaceChildren(
      ...layerNodes,
      h("span", { class: "mono" }, def.low),
      h("span", { class: "gb-key-ramp", style: { background: `linear-gradient(90deg, ${lowCol}, ${hiCol})` } }),
      h("span", { class: "mono" }, def.high),
    );
  }
  updateLegendAndLabel();

  function renderRecents() {
    const items = ctx.state.recents || [];
    recentsEl.hidden = items.length === 0;
    if (!items.length) {
      recentsEl.replaceChildren();
      return;
    }
    const btns = items.map((r) => {
      const b = pill({
        label: r.abbr || r.name,
        size: "sm",
        pressed: r.id === selectedId,
        onClick: () => focusScope(r.id),
      });
      return b;
    });
    const clr = pill({
      icon: icon.close,
      size: "sm",
      ariaLabel: "Clear recents",
      onClick: () => ctx.clearRecents(),
    });
    recentsEl.replaceChildren(...btns, clr);
    for (const b of btns) glass(b);
    glass(clr);
  }
  renderRecents();

  function openLayerMenu() {
    const menuItems = [
      ...LAYERS.map((it) => it === "-" ? "-" : {
        label: it.label,
        checked: layerId === it.id,
        onSelect: () => {
          layerId = it.id;
          updateLegendAndLabel();
          renderDrawer();
          scheduleDraw();
        },
      }),
      "-",
      {
        label: "MetroCast metros",
        checked: metroCastOn,
        onSelect: () => {
          metroCastOn = !metroCastOn;
          renderDrawer();
          scheduleDraw();
        },
      },
      "-",
      {
        label: "First-visit landing",
        checked: onboardOpen,
        onSelect: () => toggleOnboard(!onboardOpen),
      },
    ];
    openMenu(layerBtn, { label: "Globe layers", items: menuItems });
  }

  function lookupAnyPlace(id) {
    return geo?.hsasData?.hsas?.find((m) => m.id === id) || lookupPlaceMeta(id) || null;
  }

  function renderDrawer() {
    if (!selectedId) {
      drawer.hidden = true;
      return;
    }
    const meta = lookupAnyPlace(selectedId);
    if (!meta) {
      drawer.hidden = true;
      return;
    }
    drawer.hidden = false;
    const hsas = geo?.hsasData?.hsas || [];
    const briefing = buildBriefingForPlace(meta.id, meta, hsas);
    const sig = metricForPlace(meta, layerId === "none" ? "seasonal_intensity" : layerId);
    const isDef = ctx.state.defaultScope?.id === meta.id;
    const stateMetros = metroCastOn && meta.level === "state"
      ? hsas.filter((m) => m.stateFips === meta.id)
      : [];

    const layerNodes = [...drawer.querySelectorAll(":scope > .c-glass-layer")];
    const body = h("div", null,
      h("header", { class: "ms-head" },
        h("div", { class: "ms-title-row" },
          h("h3", { class: "ms-title", style: { fontSize: "var(--text-title)" } }, meta.name),
          h("button", {
            type: "button", class: "c-btn sm icon", "aria-label": "Close summary", html: icon.close,
            onclick: () => { selectedId = null; renderDrawer(); scheduleDraw(); },
          }),
        ),
        h("p", { class: "ms-line" },
          [meta.stateAbb || meta.region, briefing.weekLabel, meta.population ? `Pop ${(meta.population / 1e6 >= 1 ? `${(meta.population / 1e6).toFixed(1)}M` : `${Math.round(meta.population / 1e3)}k`)}` : null].filter(Boolean).join(" · "),
        ),
      ),
      sig ? h("div", { class: "ms-nums" },
        h("div", { class: "ms-num-row" },
          h("div", { class: "ms-num" },
            h("span", { class: "ms-num-k" }, sig.layerLabel),
            h("span", { class: "ms-num-v mono" }, sig.value != null ? `${sig.value}` : `${sig.seasonal_intensity}`),
            h("span", { class: "ms-num-s" }, sig.unit || "% peak"),
          ),
          h("div", { class: "ms-num" },
            h("span", { class: "ms-num-k" }, "Wk Δ"),
            h("span", { class: "ms-num-v mono" }, `${sig.growthPct >= 0 ? "+" : ""}${sig.growthPct}%`),
            h("span", { class: "ms-num-s" }, `Rt ${sig.rt.toFixed(2)}`),
          ),
        ),
        h("div", { html: buildSparklineSvg(briefing.streams[0].wave) }),
      ) : null,
      h("div", { class: "gb-drawer-acts" },
        h("button", {
          type: "button", class: "lab-plain-btn",
          onclick: () => ctx.openBriefing(meta.id),
        }, "Briefing →"),
        h("span", { class: "v-sep" }, "·"),
        h("button", {
          type: "button", class: "c-link",
          onclick: () => {
            ctx.setDefaultScope({
              kind: meta.stateFips ? "metro" : meta.level || "place",
              id: meta.id,
              label: meta.name,
              lon: meta.lon,
              lat: meta.lat,
            });
            renderDrawer();
          },
        }, isDef ? "Default scope" : "Set default"),
      ),
      stateMetros.length ? h("div", { class: "gb-metros", style: { marginTop: "var(--space-12)" } },
        h("h4", { class: "gb-metros-title" }, `MetroCast HSAs (${stateMetros.length})`),
        ...stateMetros.map((m) => {
          const ms = metricForPlace(m, layerId === "none" ? "seasonal_intensity" : layerId);
          return h("button", {
            type: "button",
            class: "c-row",
            onclick: () => focusScope(m),
          },
          h("span", { class: "c-row-text" }, h("span", { class: "c-row-label" }, m.name)),
          h("span", { class: "c-row-sub mono" }, ms?.value != null ? `${ms.value}` : `${ms?.seasonal_intensity ?? ""} %`));
        }),
      ) : null,
    );

    drawer.replaceChildren(...layerNodes, body);
  }

  function renderOnboard() {
    onboardModal.hidden = !onboardOpen;
    if (!onboardOpen) return;

    const layerNodes = [...onboardModal.querySelectorAll(":scope > .c-glass-layer")];
    const searchInput = h("input", {
      type: "search",
      placeholder: "Search hub, region, country, state, or metro",
      autocomplete: "off",
      spellcheck: "false",
    });
    const listBox = h("div", { class: "gb-onboard-list" });
    const hsas = geo?.hsasData?.hsas || [];
    const searchable = [
      ...HUB_SCOPES,
      ...REGION_SCOPES,
      { kind: "country", id: "US", abbr: "US", name: "United States", region: "North America", lat: 39.83, lon: -98.58, zoom: 2.15 },
      ...Object.values(US_STATE_META).filter((x) => x.id !== "US").map((x) => ({ ...x, kind: "state" })),
      ...Object.values(EU_META).filter((x) => !x.parent_id).map((x) => ({ ...x, kind: "country" })),
      ...hsas.map((x) => ({ ...x, kind: "metro", region: `${x.stateAbb} · MetroCast` })),
    ];

    const pick = (item) => {
      ctx.setDefaultScope({
        kind: item.kind || "place",
        id: item.id,
        label: item.name,
        focusPlace: item.focusPlace || null,
        lon: item.lon,
        lat: item.lat,
        zoom: item.zoom,
      });
      toggleOnboard(false);
      focusScope(item);
    };

    const drawList = () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) {
        // Strictly unopinionated before searching: Hubs only, zero pre-suggested locations!
        listBox.replaceChildren(
          h("div", { class: "c-section" }, h("span", { class: "c-section-title" }, "Hubs")),
          ...HUB_SCOPES.map((hub) =>
            h("button", { type: "button", class: "c-row", onclick: () => pick(hub) },
              h("span", { class: "c-row-text" },
                h("span", { class: "c-row-label" }, hub.name),
                h("span", { class: "c-row-sub" }, hub.region),
              ),
              h("span", { class: "c-row-sub" }, hub.abbr),
            )),
        );
        return;
      }
      const hits = searchable
        .filter((x) => (x.name || "").toLowerCase().includes(q) || (x.abbr || "").toLowerCase() === q || (x.id || "").toLowerCase() === q)
        .slice(0, 12);
      listBox.replaceChildren(...hits.map((item) =>
        h("button", { type: "button", class: "c-row", onclick: () => pick(item) },
          h("span", { class: "c-row-text" },
            h("span", { class: "c-row-label" }, item.name),
            h("span", { class: "c-row-sub" }, item.region || item.kind),
          ),
          h("span", { class: "c-row-sub mono" }, item.abbr || item.id),
        )));
    };
    searchInput.addEventListener("input", drawList);
    drawList();

    const body = h("div", null,
      h("div", { class: "gb-onboard-head" },
        h("h3", { class: "gb-onboard-title" }, "Choose default scope"),
        h("button", {
          type: "button", class: "c-btn sm icon", "aria-label": "Close", html: icon.close,
          onclick: () => toggleOnboard(false),
        }),
      ),
      h("label", { class: "c-search", html: icon.search }, searchInput),
      listBox,
    );
    onboardModal.replaceChildren(...layerNodes, body);
  }

  function toggleOnboard(onVal) {
    onboardOpen = !!onVal;
    renderOnboard();
  }

  function flyTo(lon, lat, zoom) {
    velLon = 0;
    velLat = 0;
    flight = {
      fromLonLat: [camLon, camLat],
      fromZoom: camZoom,
      toLonLat: [lon, lat],
      toZoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM),
      t0: performance.now(),
      dur: 580,
    };
    startLoop();
  }

  function zoomByFactor(factor, anchorSx = null, anchorSy = null) {
    flight = null;
    velLon = 0;
    velLat = 0;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    const baseRadius = Math.min(W, H) * 0.42;
    const { cx, cy, radiusPx, R } = lastGeoSpec;
    const nextZoom = clamp(camZoom * factor, MIN_ZOOM, MAX_ZOOM);

    if (anchorSx != null && anchorSy != null && R && baseRadius > 10) {
      const hit = screenToLonLat(anchorSx, anchorSy, cx, cy, radiusPx, R);
      if (hit) {
        const anchored = solveCameraForAnchor(hit[0], hit[1], anchorSx, anchorSy, cx, cy, baseRadius * nextZoom, camLon, camLat);
        if (anchored) {
          camLon = anchored[0];
          camLat = anchored[1];
        }
      }
    }
    camZoom = nextZoom;
    scheduleDraw();
  }

  function computeFitZoom(obj) {
    if (!obj) return 2.5;
    if (obj.id === "US") return 2.15;
    let feat = null;
    if (geo) {
      if (obj.stateFips || obj.level === "hsa" || obj.kind === "metro") {
        feat = geo.metroFeatures.find((m) => m.id === obj.id);
      } else if (obj.level === "state" || obj.kind === "state") {
        feat = geo.states.find((s) => s.fips === obj.id);
      } else {
        feat = geo.countries.find((c) => !c.detached && (c.iso2 === obj.id || c.id === obj.id));
      }
    }
    if (feat?.alpha > 0.004) {
      const fit = 0.56 / Math.max(0.012, Math.sin(feat.alpha));
      return clamp(fit, 2.2, 34);
    }
    if (obj.zoom) return clamp(obj.zoom, MIN_ZOOM, MAX_ZOOM);
    if (obj.stateFips || obj.level === "hsa") return 18;
    if (obj.level === "state") return 10;
    return 3.4;
  }

  function focusScope(itemOrId) {
    const obj = typeof itemOrId === "string"
      ? (HUB_SCOPES.find((h) => h.id === itemOrId) || REGION_SCOPES.find((r) => r.id === itemOrId) || lookupAnyPlace(itemOrId))
      : itemOrId;
    if (!obj) return;
    ctx.setActiveScope(obj);

    if (obj.kind === "hub" || obj.kind === "region") {
      selectedId = null;
      renderDrawer();
      flyTo(obj.lon ?? -94, obj.lat ?? 38.5, obj.zoom ?? 2.15);
      return;
    }

    selectedId = obj.id;
    ctx.recordRecent({ id: obj.id, abbr: obj.abbr || obj.name, name: obj.name, kind: obj.stateFips ? "metro" : (obj.level || obj.kind) });
    renderRecents();
    renderDrawer();
    flyTo(obj.lon ?? -94, obj.lat ?? 38.5, computeFitZoom(obj));
  }

  /* ---------------- Pointer & Wheel Interaction ---------------- */
  let dragging = false;
  let downPt = null;
  let lastPt = null;
  let movedPx = 0;

  offs.push(on(canvas, "pointerdown", (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    dragging = true;
    flight = null;
    velLon = 0;
    velLat = 0;
    movedPx = 0;
    downPt = { x: e.clientX, y: e.clientY };
    lastPt = { x: e.clientX, y: e.clientY };
  }));

  offs.push(on(canvas, "pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (dragging && lastPt) {
      const dx = e.clientX - lastPt.x;
      const dy = e.clientY - lastPt.y;
      movedPx += Math.hypot(dx, dy);
      const radToDeg = 180 / Math.PI;
      const rPx = Math.max(120, lastGeoSpec.radiusPx);
      const cosLat = Math.max(0.25, Math.cos((camLat * Math.PI) / 180));
      const dLon = -(dx * radToDeg) / (rPx * cosLat);
      const dLat = (dy * radToDeg) / rPx;
      camLon += dLon;
      camLat = clamp(camLat + dLat, -82, 82);
      velLon = dLon * 0.65;
      velLat = dLat * 0.65;
      lastPt = { x: e.clientX, y: e.clientY };
      hoverItem = null;
      readout.hidden = true;
      scheduleDraw();
      return;
    }

    const picked = pickAtScreen(sx, sy);
    if (picked) {
      hoverItem = picked;
      const metric = layerId === "none" ? null : metricForPlace(picked.meta, layerId);
      readout.replaceChildren(
        h("div", { class: "c-readout-head" },
          h("span", { style: { fontWeight: "600", color: "var(--ink-primary)" } }, picked.name),
          h("span", { class: "quiet" }, picked.kind === "metro" ? "MetroCast" : picked.kind === "state" ? "State" : "Country"),
        ),
        metric ? h("table", null,
          h("tbody", null,
            h("tr", null, h("td", { class: "c-readout-name" }, metric.layerLabel), h("td", { class: "num" }, `${metric.value} ${metric.unit}`)),
            h("tr", null, h("td", { class: "c-readout-name" }, "Wk Δ"), h("td", { class: "num" }, `${metric.growthPct >= 0 ? "+" : ""}${metric.growthPct}%`)),
          ),
        ) : null,
      );
      readout.hidden = false;
      readout.style.transform = `translate(${clamp(sx + 16, 12, rect.width - 230)}px, ${clamp(sy - 18, 60, rect.height - 96)}px)`;
    } else if (hoverItem) {
      hoverItem = null;
      readout.hidden = true;
    }
    scheduleDraw();
  }));

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    if (movedPx < 5 && downPt) {
      const rect = canvas.getBoundingClientRect();
      const hit = pickAtScreen(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) focusScope(hit.meta || hit.id);
    } else if (Math.hypot(velLon, velLat) * lastGeoSpec.radiusPx > 0.35) {
      startLoop();
    }
    downPt = null;
    lastPt = null;
  };
  offs.push(on(canvas, "pointerup", endDrag));
  offs.push(on(canvas, "pointercancel", endDrag));
  offs.push(on(canvas, "pointerleave", () => {
    hoverItem = null;
    readout.hidden = true;
    scheduleDraw();
  }));

  offs.push(on(canvas, "wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0022);
    zoomByFactor(factor, sx, sy);
  }, { passive: false }));

  offs.push(on(canvas, "dblclick", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hit = pickAtScreen(sx, sy);
    if (hit) focusScope(hit.meta || hit.id);
    else zoomByFactor(1.85, sx, sy);
  }));

  function pickAtScreen(sx, sy) {
    if (!geo) return null;
    const { cx, cy, radiusPx } = lastGeoSpec;
    if (Math.hypot(sx - cx, sy - cy) > radiusPx) return null;

    if (metroCastOn && camZoom >= 2.2) {
      for (const dot of hitDots) {
        if (Math.hypot(sx - dot.sx, sy - dot.sy) <= 10) {
          return { kind: "metro", id: dot.id, name: dot.name, meta: dot.meta };
        }
      }
      for (const mh of hitMetros) {
        if (pointInRingsEvenOdd(sx, sy, mh.screenRings)) {
          return { kind: "metro", id: mh.id, name: mh.name, meta: mh.meta };
        }
      }
    }

    for (const st of hitStates) {
      if (pointInRingsEvenOdd(sx, sy, st.screenRings)) {
        const meta = US_STATE_META[st.fips] || { id: st.fips, abbr: st.fips, name: st.name || st.fips, level: "state" };
        return { kind: "state", id: st.fips, name: meta.name, meta };
      }
    }

    for (const co of hitCountries) {
      if (pointInRingsEvenOdd(sx, sy, co.screenRings)) {
        const id = co.iso2 || co.id;
        const meta = EU_META[id] || (id === "US" ? US_STATE_META.US : { id, abbr: id, name: co.name || id, level: "country", centroidLonLat: co.centroidLonLat });
        if (meta.lat == null && co.centroidLonLat) {
          meta.lon = co.centroidLonLat[0];
          meta.lat = co.centroidLonLat[1];
        }
        return { kind: "country", id, name: meta.name, meta };
      }
    }
    return null;
  }

  /* ---------------- Canvas Renderer ---------------- */
  let loopRaf = 0;
  function startLoop() {
    if (loopRaf || destroyed) return;
    loopRaf = requestAnimationFrame(tick);
  }
  function tick(now) {
    loopRaf = 0;
    if (destroyed) return;
    let keep = false;
    if (flight) {
      const t = clamp((now - flight.t0) / flight.dur, 0, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      const [lon, lat] = slerpLonLat(flight.fromLonLat, flight.toLonLat, ease);
      camLon = lon;
      camLat = lat;
      camZoom = flight.fromZoom + (flight.toZoom - flight.fromZoom) * ease;
      if (t >= 1) flight = null;
      else keep = true;
    } else if (!dragging && (Math.abs(velLon) > 0.02 || Math.abs(velLat) > 0.02)) {
      camLon += velLon;
      camLat = clamp(camLat + velLat, -82, 82);
      velLon *= 0.9;
      velLat *= 0.9;
      keep = true;
    }
    draw();
    if (keep) loopRaf = requestAnimationFrame(tick);
  }

  const scheduleDraw = perFrame(draw);
  function draw() {
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    if (W < 40 || H < 40) return;
    const g = fitCanvas(canvas, W, H);
    const isLight = document.documentElement.dataset.theme === "light";

    const inkRgb = parseRgbCss(cssColor("var(--ink-primary)"));
    const inkSecondary = cssColor("var(--ink-secondary)");
    const inkFaint = cssColor("var(--ink-faint)");
    const lineAxis = cssColor("var(--line-axis)");
    const lineHairline = cssColor("var(--line-hairline)");
    const accent = cssColor("var(--accent)");
    const surfPaper = cssColor("var(--surface-paper)");
    const surfRaised = cssColor("var(--surface-raised)");
    const fontSans = getComputedStyle(document.documentElement).getPropertyValue("--font-sans");

    const drawerShift = selectedId && W > 900 ? -120 : 0;
    const cx = W * 0.5 + drawerShift;
    const cy = H * 0.5;
    const radiusPx = Math.min(W, H) * 0.42 * camZoom;
    const R = makeRotationMatrix(camLon, camLat);
    lastGeoSpec = { cx, cy, radiusPx, R };

    const halfDiag = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
    const viewR = halfDiag / radiusPx;
    const thetaMaxRad = viewR < 0.99 ? Math.asin(viewR) : null;
    const clipToLimb = radiusPx <= halfDiag + 4;

    // 1. Matte monochrome sphere (flat paper behind; full fill at deep zoom)
    g.save();
    g.fillStyle = isLight ? surfRaised : colorMixDarkSphere(surfPaper, surfRaised);
    if (clipToLimb) {
      g.beginPath();
      g.arc(cx, cy, radiusPx, 0, Math.PI * 2);
      g.fill();
      g.clip();
    } else {
      g.fillRect(0, 0, W, H);
    }

    if (!geo) {
      g.restore();
      if (clipToLimb) drawLimb(g, cx, cy, radiusPx, lineAxis);
      return;
    }

    // 2. Subtle graticule
    g.beginPath();
    for (const arc of [...geo.gratLat, ...geo.gratLon]) {
      for (const seg of clipPolylineToHemisphere(arc, R)) {
        g.moveTo(cx + seg[0] * radiusPx, cy - seg[1] * radiusPx);
        for (let i = 2; i < seg.length; i += 2) g.lineTo(cx + seg[i] * radiusPx, cy - seg[i + 1] * radiusPx);
      }
    }
    g.strokeStyle = lineHairline;
    g.lineWidth = 0.7;
    g.stroke();

    const luminanceFill = (norm, isSel, isHov) => {
      if (layerId === "none") {
        if (isSel) return `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0.09)`;
        if (isHov) return `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0.06)`;
        return isLight ? "rgba(0,0,0,0.015)" : "rgba(255,255,255,0.02)";
      }
      if (norm == null) return isLight ? "rgba(0,0,0,0.025)" : "rgba(255,255,255,0.025)";
      const alpha = clamp(0.05 + Math.pow(clamp(norm, 0, 1), 1.1) * (isLight ? 0.52 : 0.44), 0.05, 0.62);
      return `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, ${alpha.toFixed(3)})`;
    };

    const stateAlpha = smoothstep(1.18, 1.75, camZoom);
    const metroAlpha = metroCastOn ? smoothstep(2.1, 3.2, camZoom) : 0;

    // 3. World Countries (50m) — detached territories (French Guiana, Svalbard) stay neutral
    hitCountries = [];
    for (const co of geo.countries) {
      if (!coneVisibleInViewport(co, R, thetaMaxRad)) continue;
      const screenRings = [];
      for (const ring3 of co.rings) {
        const clipped = clipPolygonToHemisphere(ring3, R);
        if (!clipped) continue;
        const sr = new Float64Array(clipped.length);
        for (let i = 0; i < clipped.length; i += 2) {
          sr[i] = cx + clipped[i] * radiusPx;
          sr[i + 1] = cy - clipped[i + 1] * radiusPx;
        }
        screenRings.push(sr);
      }
      if (!screenRings.length) continue;

      g.beginPath();
      for (const sr of screenRings) {
        g.moveTo(sr[0], sr[1]);
        for (let i = 2; i < sr.length; i += 2) g.lineTo(sr[i], sr[i + 1]);
        g.closePath();
      }

      if (co.detached) {
        g.fillStyle = luminanceFill(null, false, false);
        g.fill("evenodd");
        g.lineWidth = 0.65;
        g.strokeStyle = inkFaint;
        g.stroke();
        continue;
      }

      const cid = co.iso2 || co.id;
      hitCountries.push({ ...co, iso2: co.iso2, screenRings });
      const meta = EU_META[cid] || (cid === "US" ? US_STATE_META.US : { id: cid, name: co.name || cid });
      const m = cid === "US" && stateAlpha > 0.35 ? null : (EU_META[cid] || cid === "US" ? metricForPlace(meta, layerId) : null);
      const isHov = hoverItem?.kind === "country" && hoverItem.id === cid;
      const isSel = selectedId === cid;

      g.fillStyle = luminanceFill(m?.norm ?? null, isSel, isHov);
      g.fill("evenodd");
      g.lineWidth = isSel ? 1.5 : isHov ? 1.15 : 0.65;
      g.strokeStyle = isSel ? accent : isHov ? cssColor("var(--ink-primary)") : inkFaint;
      g.stroke();
    }

    // 4. U.S. States
    hitStates = [];
    if (stateAlpha > 0.04) {
      g.save();
      for (const st of geo.states) {
        if (!coneVisibleInViewport(st, R, thetaMaxRad)) continue;
        const screenRings = [];
        for (const ring3 of st.rings) {
          const clipped = clipPolygonToHemisphere(ring3, R);
          if (!clipped) continue;
          const sr = new Float64Array(clipped.length);
          for (let i = 0; i < clipped.length; i += 2) {
            sr[i] = cx + clipped[i] * radiusPx;
            sr[i + 1] = cy - clipped[i + 1] * radiusPx;
          }
          screenRings.push(sr);
        }
        if (!screenRings.length) continue;
        hitStates.push({ ...st, screenRings });
        const meta = US_STATE_META[st.fips];
        const m = meta ? metricForPlace(meta, layerId) : null;
        const isHov = hoverItem?.kind === "state" && hoverItem.id === st.fips;
        const isSel = selectedId === st.fips;
        const isCovered = metroCastOn && geo.coveredStates.has(st.fips);
        const stFade = isCovered && metroAlpha > 0 ? Math.max(0.16, 1 - metroAlpha * 0.84) : 1;

        g.beginPath();
        for (const sr of screenRings) {
          g.moveTo(sr[0], sr[1]);
          for (let i = 2; i < sr.length; i += 2) g.lineTo(sr[i], sr[i + 1]);
          g.closePath();
        }
        g.globalAlpha = stateAlpha * stFade;
        g.fillStyle = luminanceFill(m?.norm ?? null, isSel, isHov);
        g.fill("evenodd");
      }

      // 5. MetroCast-only Exterior HSA Footprints & Boundaries (zero internal county seams!)
      hitMetros = [];
      if (metroAlpha > 0.04) {
        g.globalAlpha = stateAlpha * metroAlpha;
        for (const mh of geo.metroFeatures) {
          if (!coneVisibleInViewport(mh, R, thetaMaxRad)) continue;
          const screenRings = [];
          for (const ring3 of mh.rings) {
            const clipped = clipPolygonToHemisphere(ring3, R);
            if (!clipped) continue;
            const sr = new Float64Array(clipped.length);
            for (let i = 0; i < clipped.length; i += 2) {
              sr[i] = cx + clipped[i] * radiusPx;
              sr[i + 1] = cy - clipped[i + 1] * radiusPx;
            }
            screenRings.push(sr);
          }
          if (!screenRings.length) continue;
          hitMetros.push({ id: mh.id, name: mh.name, meta: mh, screenRings });
          const m = metricForPlace(mh, layerId);
          const isSel = selectedId === mh.id;
          const isHov = hoverItem?.kind === "metro" && hoverItem.id === mh.id;

          g.beginPath();
          for (const sr of screenRings) {
            g.moveTo(sr[0], sr[1]);
            for (let i = 2; i < sr.length; i += 2) g.lineTo(sr[i], sr[i + 1]);
            g.closePath();
          }
          g.fillStyle = luminanceFill(m?.norm ?? null, isSel, isHov);
          g.fill("evenodd");
        }

        // Exterior-only HSA border mesh
        g.beginPath();
        for (const seg3 of geo.metroMesh) {
          if (!coneVisibleInViewport(seg3, R, thetaMaxRad)) continue;
          for (const run of clipPolylineToHemisphere(seg3.xyz, R)) {
            g.moveTo(cx + run[0] * radiusPx, cy - run[1] * radiusPx);
            for (let i = 2; i < run.length; i += 2) g.lineTo(cx + run[i] * radiusPx, cy - run[i + 1] * radiusPx);
          }
        }
        g.globalAlpha = stateAlpha * metroAlpha * (isLight ? 0.72 : 0.82);
        g.strokeStyle = isLight ? inkSecondary : inkFaint;
        g.lineWidth = camZoom >= 12 ? 1.0 : 0.8;
        g.stroke();
      }

      // Crisp state borders on top
      g.beginPath();
      for (const seg3 of geo.stateMesh) {
        if (!coneVisibleInViewport(seg3, R, thetaMaxRad)) continue;
        for (const run of clipPolylineToHemisphere(seg3.xyz, R)) {
          g.moveTo(cx + run[0] * radiusPx, cy - run[1] * radiusPx);
          for (let i = 2; i < run.length; i += 2) g.lineTo(cx + run[i] * radiusPx, cy - run[i + 1] * radiusPx);
        }
      }
      g.globalAlpha = stateAlpha;
      g.strokeStyle = inkSecondary;
      g.lineWidth = clamp(0.75 + stateAlpha * 0.4, 0.75, 1.35);
      g.stroke();

      // Highlight hovered or selected state/metro perimeter cleanly
      const drawHighlight = (rings, isSel) => {
        g.beginPath();
        for (const sr of rings) {
          g.moveTo(sr[0], sr[1]);
          for (let i = 2; i < sr.length; i += 2) g.lineTo(sr[i], sr[i + 1]);
          g.closePath();
        }
        g.strokeStyle = isSel ? accent : cssColor("var(--ink-primary)");
        g.lineWidth = isSel ? 2.0 : 1.35;
        g.stroke();
      };
      for (const st of hitStates) {
        if (selectedId === st.fips || (hoverItem?.kind === "state" && hoverItem.id === st.fips)) {
          drawHighlight(st.screenRings, selectedId === st.fips);
        }
      }
      for (const mh of hitMetros) {
        if (selectedId === mh.id || (hoverItem?.kind === "metro" && hoverItem.id === mh.id)) {
          drawHighlight(mh.screenRings, selectedId === mh.id);
        }
      }
      g.restore();
    }

    // 6. Clean monochrome dots & labels for MetroCast metros when zoomed into covered states
    hitDots = [];
    if (metroAlpha > 0.2) {
      const placed = [];
      g.save();
      g.font = `500 11px ${fontSans}`;
      g.textBaseline = "middle";
      for (const mh of geo.metroFeatures) {
        const pz = R[6] * mh.x + R[7] * mh.y + R[8] * mh.z;
        if (pz <= 0.1) continue;
        const px = R[0] * mh.x + R[1] * mh.y + R[2] * mh.z;
        const py = R[3] * mh.x + R[4] * mh.y + R[5] * mh.z;
        const sx = cx + px * radiusPx;
        const sy = cy - py * radiusPx;
        if (sx < -24 || sx > W + 24 || sy < -24 || sy > H + 24) continue;

        hitDots.push({ id: mh.id, name: mh.name, meta: mh, sx, sy });
        const isSel = selectedId === mh.id;
        const isHov = hoverItem?.kind === "metro" && hoverItem.id === mh.id;

        g.globalAlpha = metroAlpha;
        g.beginPath();
        g.arc(sx, sy, isSel ? 4.4 : 2.8, 0, Math.PI * 2);
        g.fillStyle = isSel ? accent : cssColor("var(--ink-primary)");
        g.fill();

        if (camZoom >= 3.4 || isSel || isHov) {
          const lbl = mh.abbr;
          const tw = g.measureText(lbl).width;
          const box = { x: sx + 6, y: sy - 7, w: tw + 8, h: 14 };
          const clash = !isSel && !isHov && placed.some((b) => !(box.x + box.w < b.x || box.x > b.x + b.w || box.y + box.h < b.y || box.y > b.y + b.h));
          if (!clash) {
            placed.push(box);
            g.fillStyle = isSel ? accent : cssColor("var(--ink-primary)");
            g.fillText(lbl, sx + 7, sy);
          }
        }
      }
      g.restore();
    }

    g.restore();
    if (clipToLimb) drawLimb(g, cx, cy, radiusPx, lineAxis);
  }

  function colorMixDarkSphere(surfPaper, surfRaised) {
    // Slightly lifted dark neutral without glow/vignette
    void surfPaper;
    return surfRaised;
  }

  function drawLimb(g, cx, cy, r, lineAxis) {
    g.save();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.strokeStyle = lineAxis;
    g.lineWidth = 1;
    g.stroke();
    g.restore();
  }

  /* ---------------- Lifecycle & Listeners ---------------- */
  const ro = new ResizeObserver(() => scheduleDraw());
  ro.observe(wrap);

  offs.push(ctx.onThemeChange(() => {
    updateLegendAndLabel();
    scheduleDraw();
  }));
  offs.push(ctx.onRecentsChange(renderRecents));
  offs.push(ctx.onDefaultChange(() => renderDrawer()));

  loadGlobeGeometry(ctx).then((loaded) => {
    if (destroyed) return;
    geo = loaded;
    if (onboardOpen) renderOnboard();
    renderDrawer();
    scheduleDraw();
  }).catch(() => {});

  scheduleDraw();

  return {
    focusScope,
    resize: scheduleDraw,
    destroy() {
      destroyed = true;
      if (loopRaf) cancelAnimationFrame(loopRaf);
      ro.disconnect();
      offs.forEach((off) => off());
    },
  };
}
