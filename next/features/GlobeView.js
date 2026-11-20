/* Live interactive monochrome luminance Globe for /next/.
 * - Flat paper backdrop (zero vignette in light or dark mode)
 * - Monochrome luminance ramp driven live from /api/next/spatial
 * - Strictly hub-scoped MetroCast HSAs: county/HSA borders appear ONLY when the connected hub
 *   has MetroCast HSAs (`classifyHubGeo(manifest).kind === "us-metrocast"`), never on US-state or EU hubs
 * - Detached overseas territories (French Guiana, Svalbard, etc.) stay unshaded and unselectable
 * - Cursor-anchored zoom up to 48x, frosted Place Drawer with Open chart -> */
import { h, on, cssColor, storage, onThemeChange } from "../lib/dom.js";
import { valueFormat } from "../lib/format.js";
import { glass } from "../ui/glass.js";
import { pill, icon } from "../ui/controls.js";
import { openMenu } from "../ui/floating.js";
import { getJson, query, linkStyle, fitCanvas, perFrame, onDprChange } from "../sections/shared.js";
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
import { EU_META, ISO_NUM_TO_ALPHA2, US_STATE_META } from "../geo/eu_tiles.js";
import { classifyHubGeo, loadUsGeoCache } from "../geo/picker_geo.js";
import { isCategoricalTarget } from "./url.js";

const MAX_ZOOM = 48;
const MIN_ZOOM = 1.0;

const EU_MAINLAND_BOUNDS = Object.freeze({ minLon: -26, maxLon: 45, minLat: 33, maxLat: 73 });
const DETACH_ISOS = new Set([...Object.keys(EU_META), "FR", "NO", "NL", "PT", "ES", "DK", "GB"]);
const DETACH_BOUNDS_BY_ISO = Object.fromEntries([...DETACH_ISOS].map((iso) => [iso, EU_MAINLAND_BOUNDS]));

const LAYER_MODES = [
  { id: "observed", label: "Observed" },
  { id: "forecast", label: "Forecast" },
  { id: "trend", label: "Wk Δ trend" },
  { id: "none", label: "Outlines only" },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

function parseRgbCss(str, fallback = [245, 245, 245]) {
  const m = String(str || "").match(/[\d.]+/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : fallback;
}

const recentsKey = (hubId) => (hubId ? `viz.h.${hubId}.globe_recents` : "viz.globe_recents");

let worldGeoPromise = null;
function loadWorldCountries() {
  if (!worldGeoPromise) {
    const worldUrl = new URL("../geo/world-countries-110m.json", import.meta.url).href;
    worldGeoPromise = fetch(worldUrl)
      .then((r) => { if (!r.ok) throw new Error(`world-countries: ${r.status}`); return r.json(); })
      .then((worldTopo) => {
        const worldArcs = arcsToUnitSphere(decodeArcs(worldTopo));
        const raw = extractPolygons(worldTopo, "countries", worldArcs).map((f) => ({
          ...f,
          iso2: ISO_NUM_TO_ALPHA2[String(f.id).padStart(3, "0")] || ISO_NUM_TO_ALPHA2[String(f.id)] || null,
        }));
        return splitDetachedTerritories(raw, DETACH_BOUNDS_BY_ISO);
      })
      .catch((err) => {
        worldGeoPromise = null;
        throw err;
      });
  }
  return worldGeoPromise;
}

let sphereBundlePromise = null;
async function loadSphereBundle() {
  if (!sphereBundlePromise) {
    sphereBundlePromise = Promise.all([loadWorldCountries(), loadUsGeoCache()]).then(([countries, usGeo]) => {
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
      return { countries, usGeo, gratLat, gratLon };
    }).catch((err) => {
      sphereBundlePromise = null;
      throw err;
    });
  }
  return sphereBundlePromise;
}

/**
 * Mounts the interactive monochrome Globe overlay into `host`.
 * @param {HTMLElement} host
 * @param {{ manifest: import("../lib/api.js").Manifest, store: object, onClose?: () => void }} ctx
 */
export function mountGlobeView(host, ctx) {
  const { manifest, store, onClose } = ctx;
  linkStyle("globe");

  const geoCls = classifyHubGeo(manifest);
  const isMetroHub = geoCls.kind === "us-metrocast";
  const isEuHub = geoCls.kind === "eu-countries";
  const isUsStates = geoCls.kind === "us-states";

  let camLon = isEuHub ? 10 : -94;
  let camLat = isEuHub ? 50 : 38.5;
  let camZoom = isEuHub ? 2.55 : 2.0;
  let velLon = 0;
  let velLat = 0;
  let flight = null;

  let layerId = "observed";
  let metroCastOn = isMetroHub;
  let selectedLocId = null;
  let hoverItem = null;
  let spatialData = null;
  let scaleDomain = { lo: 0, hi: 1, isPct: false, per100k: false };
  let activeMetros = [];
  let activeMetroStates = new Set();
  let useFullMetroMesh = false;
  let geo = null;
  let destroyed = false;
  let spatialToken = 0;

  let hitCountries = [];
  let hitStates = [];
  let hitMetros = [];
  let hitDots = [];
  let lastGeoSpec = { cx: 0, cy: 0, radiusPx: 1, R: null };
  const spatialSlot = {};

  const loadRecents = () => {
    const raw = storage.get(recentsKey(manifest.hub_id), []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((id) => typeof id === "string" && manifest.locationById.has(id)).slice(0, 5);
  };
  let recents = loadRecents();
  const recordRecent = (locId) => {
    if (!locId || !manifest.locationById.has(locId)) return;
    recents = [locId, ...recents.filter((x) => x !== locId)].slice(0, 5);
    storage.set(recentsKey(manifest.hub_id), recents);
    renderRecents();
  };

  /* ---------------- Spatial Target & Value Helpers ---------------- */
  function spatialTargetMeta() {
    const s = store.get();
    const cur = manifest.targetById.get(s.target);
    if (cur && !isCategoricalTarget(cur)) return cur;
    return (manifest.targets || []).find((t) => !isCategoricalTarget(t)) || null;
  }

  function resolveCountryLocation(cid) {
    if (!cid) return null;
    if (manifest.locationById.has(cid)) return manifest.locationById.get(cid);
    if (cid === "GB") {
      if (manifest.locationById.has("UK")) return manifest.locationById.get("UK");
      if (manifest.locationById.has("GB-ENG")) return manifest.locationById.get("GB-ENG");
    }
    return null;
  }

  function resolveStateLocation(fips) {
    return geoCls.stateByFips.get(fips) || manifest.locationById.get(fips) || null;
  }

  function locRecord(locId) {
    if (!locId || !spatialData) return null;
    if (spatialData.locations?.[locId]) return spatialData.locations[locId];
    const abbr = manifest.locationById.get(locId)?.abbr;
    return abbr ? spatialData.states?.[abbr] ?? null : null;
  }

  function metricForLoc(locId, mode = layerId) {
    if (!locId || mode === "none") return null;
    const rec = locRecord(locId);
    if (!rec) return null;
    const tMeta = spatialTargetMeta();
    const useRate = !!tMeta?.per_100k_capable && rec.population > 1;
    const availH = spatialData?.available_horizons || [];
    const baseH = availH.includes(1) ? 1 : availH[0] ?? 0;
    const trendH = availH.find((x) => x > 0) ?? baseH;

    let obsVal = NaN;
    const obsKeys = Object.keys(rec.truth || {}).sort();
    const ted0 = spatialData?.dates_by_horizon?.[availH.includes(0) ? 0 : availH[0]];
    const rawObs = ted0 && rec.truth?.[ted0] != null ? rec.truth[ted0] : (obsKeys.length ? rec.truth[obsKeys.at(-1)] : NaN);
    if (Number.isFinite(rawObs)) obsVal = useRate ? (rawObs / rec.population) * 1e5 : rawObs;

    const s = store.get();
    const candIds = [
      ...s.sel.selected,
      ...(manifest.recommended || []),
      ...Object.keys(rec.models || {}),
    ];
    let entry = null;
    let modelId = null;
    for (const mid of candIds) {
      if (rec.models?.[mid]?.[baseH]) {
        entry = rec.models[mid][baseH];
        modelId = mid;
        break;
      }
    }

    let fcstVal = NaN;
    if (entry) {
      fcstVal = useRate && Number.isFinite(entry.rate_per_100k) ? entry.rate_per_100k : entry.median;
    }
    const tEntry = modelId ? rec.models?.[modelId]?.[trendH] : entry;
    const trendPct = tEntry && Number.isFinite(tEntry.trend_pct) ? tEntry.trend_pct : NaN;

    let primary = NaN;
    if (mode === "observed") primary = Number.isFinite(obsVal) ? obsVal : fcstVal;
    else if (mode === "forecast") primary = Number.isFinite(fcstVal) ? fcstVal : obsVal;
    else if (mode === "trend") primary = trendPct;

    return { value: primary, observed: obsVal, forecast: fcstVal, trendPct, useRate, population: rec.population };
  }

  function recomputeScale() {
    if (layerId === "none" || !spatialData) {
      scaleDomain = { lo: 0, hi: 1, isPct: false, per100k: false };
      return;
    }
    const vals = [];
    const tMeta = spatialTargetMeta();
    let anyRate = false;
    for (const loc of manifest.locations || []) {
      if (loc.id === "US") continue;
      const m = metricForLoc(loc.id, layerId);
      if (m && Number.isFinite(m.value)) {
        vals.push(m.value);
        if (m.useRate) anyRate = true;
      }
    }
    if (!vals.length) {
      scaleDomain = { lo: 0, hi: 1, isPct: layerId === "trend", per100k: anyRate };
      return;
    }
    vals.sort((a, b) => a - b);
    if (layerId === "trend") {
      const p95 = Math.max(15, Math.min(200, Math.abs(vals[Math.floor((vals.length - 1) * 0.95)] || 50)));
      scaleDomain = { lo: -p95, hi: p95, isPct: true, per100k: false, isProp: false };
      return;
    }
    const lo = vals.length >= 8 ? vals[Math.floor((vals.length - 1) * 0.05)] : 0;
    const p95 = vals[Math.floor((vals.length - 1) * 0.95)] ?? vals.at(-1);
    const hi = Math.max(lo + 1e-6, p95 > 0 ? p95 : vals.at(-1) || 1);
    const isProp = tMeta?.scale === "proportion" || tMeta?.scale === "percentage";
    scaleDomain = { lo: Math.max(0, lo), hi, isPct: false, per100k: anyRate, isProp };
  }

  function normForLoc(locId) {
    if (layerId === "none") return null;
    const m = metricForLoc(locId, layerId);
    if (!m || !Number.isFinite(m.value)) return null;
    const { lo, hi } = scaleDomain;
    return clamp((m.value - lo) / Math.max(1e-9, hi - lo), 0, 1);
  }

  function formatMetric(v, useRate = false) {
    if (!Number.isFinite(v)) return "–";
    const tMeta = spatialTargetMeta();
    if (useRate) return `${v >= 10 ? v.toFixed(1) : v.toFixed(2)} /100k`;
    if (tMeta) return valueFormat(tMeta).readout(v);
    return v >= 10 ? v.toFixed(1) : v.toFixed(2);
  }

  /* ---------------- DOM ---------------- */
  const wrap = h("div", { class: "gb-wrap" });
  const canvas = h("canvas", { class: "gb-canvas", "aria-label": "Interactive monochrome globe" });
  const recentsEl = h("div", { class: "gb-recents", hidden: true, role: "group", "aria-label": "Recent places" });
  const hudBL = h("div", { class: "gb-hud-bl" });
  const hudBR = h("div", { class: "gb-hud-br" });
  const readout = h("div", { class: "c-readout v-readout", role: "status", hidden: true });
  const drawer = h("aside", { class: "c-panel gb-drawer", hidden: true, "aria-label": "Place summary" });

  const layerBtn = pill({
    label: "Observed",
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

  wrap.append(canvas, recentsEl, hudBL, hudBR, drawer, readout);
  host.replaceChildren(wrap);

  const layerGlass = glass(layerBtn);
  const hudGlasses = [layerGlass, glass(keyWrap), glass(zoomInBtn), glass(zoomOutBtn), glass(drawer, { panel: true })];
  const recentGlasses = [];
  document.fonts?.ready?.then(() => layerGlass.update());

  function updateLegendAndLabel() {
    const def = LAYER_MODES.find((x) => x.id === layerId) || LAYER_MODES[0];
    const lbl = layerBtn.querySelector(".c-pill-label");
    if (lbl) lbl.textContent = def.label;
    layerGlass.update();

    if (layerId === "none" || !spatialData) {
      keyWrap.hidden = true;
      return;
    }
    keyWrap.hidden = false;
    const isLight = document.documentElement.dataset.theme === "light";
    const ink = parseRgbCss(cssColor("var(--ink-primary)"), isLight ? [17, 18, 22] : [235, 237, 240]);
    const lowCol = `rgba(${ink[0]}, ${ink[1]}, ${ink[2]}, 0.06)`;
    const hiCol = `rgba(${ink[0]}, ${ink[1]}, ${ink[2]}, ${isLight ? 0.62 : 0.56})`;
    const tMeta = spatialTargetMeta();
    const fmtBound = (v) => {
      if (scaleDomain.isPct) return `${v >= 0 ? "+" : ""}${Math.round(v)}%`;
      if (scaleDomain.isProp && tMeta) return valueFormat(tMeta).readout(v);
      if (Math.abs(v) >= 1e3) return valueFormat(tMeta || { scale: "count" }).axis(Math.round(v));
      return Math.abs(v) >= 10 || Math.abs(v) < 1e-6 ? String(Math.round(v)) : v.toFixed(1);
    };
    const layerNodes = [...keyWrap.querySelectorAll(":scope > .c-glass-layer")];
    keyWrap.replaceChildren(
      ...layerNodes,
      h("span", { class: "mono" }, fmtBound(scaleDomain.lo)),
      h("span", { class: "gb-key-ramp", style: { background: `linear-gradient(90deg, ${lowCol}, ${hiCol})` } }),
      h("span", { class: "mono" }, scaleDomain.per100k ? `${fmtBound(scaleDomain.hi)} /100k` : fmtBound(scaleDomain.hi)),
    );
  }

  function renderRecents() {
    recentGlasses.splice(0).forEach((g) => g.destroy());
    recentsEl.hidden = recents.length === 0;
    if (!recents.length) {
      recentsEl.replaceChildren();
      return;
    }
    const btns = recents.map((id) => {
      const loc = manifest.locationById.get(id);
      return pill({
        label: loc?.abbr || loc?.name || id,
        size: "sm",
        pressed: id === selectedLocId,
        onClick: () => focusLocation(id),
      });
    });
    const clr = pill({
      icon: icon.close,
      size: "sm",
      ariaLabel: "Clear recent places",
      onClick: () => { recents = []; storage.set(recentsKey(manifest.hub_id), []); renderRecents(); },
    });
    recentsEl.replaceChildren(...btns, clr);
    for (const b of btns) recentGlasses.push(glass(b));
    recentGlasses.push(glass(clr));
  }

  function openLayerMenu() {
    const items = LAYER_MODES.map((it) => ({
      label: it.label,
      checked: layerId === it.id,
      onSelect: () => {
        layerId = it.id;
        recomputeScale();
        updateLegendAndLabel();
        renderDrawer();
        scheduleDraw();
      },
    }));
    if (isMetroHub) {
      items.push("-", {
        label: "MetroCast HSAs",
        checked: metroCastOn,
        onSelect: () => {
          metroCastOn = !metroCastOn;
          renderDrawer();
          scheduleDraw();
        },
      });
    }
    openMenu(layerBtn, { label: "Globe layer", placement: "top-start", items });
  }

  function coordsForLoc(locId) {
    if (!locId) return null;
    if (geo) {
      const mh = activeMetros.find((m) => m.id === locId);
      if (mh && mh.lon != null && mh.lat != null) return { lon: mh.lon, lat: mh.lat, zoom: 14 };
      const fips = geoCls.stateFipsOf(locId);
      if (fips && US_STATE_META[fips]) {
        const u = US_STATE_META[fips];
        if (u.lon != null && u.lat != null) return { lon: u.lon, lat: u.lat, zoom: 8.5 };
      }
      if (EU_META[locId]) {
        const e = EU_META[locId];
        if (e.lon != null && e.lat != null) return { lon: e.lon, lat: e.lat, zoom: 7.5 };
      }
      const country = geo.countries.find((c) => !c.detached && (c.iso2 === locId || (locId === "UK" && c.iso2 === "GB")));
      if (country?.centroidLonLat) return { lon: country.centroidLonLat[0], lat: country.centroidLonLat[1], zoom: 5.5 };
    }
    const fips = geoCls.stateFipsOf(locId);
    if (fips && US_STATE_META[fips]) {
      const u = US_STATE_META[fips];
      return u.lon != null ? { lon: u.lon, lat: u.lat, zoom: 8 } : null;
    }
    if (locId === "US") return { lon: -94, lat: 38.5, zoom: 2.0 };
    if (EU_META[locId]?.lon != null) return { lon: EU_META[locId].lon, lat: EU_META[locId].lat, zoom: 7 };
    return null;
  }

  function computeFitZoom(locId) {
    if (locId === "US") return 2.15;
    if (geo) {
      const mh = activeMetros.find((m) => m.id === locId);
      if (mh?.alpha > 0.004) return clamp(0.56 / Math.max(0.012, Math.sin(mh.alpha)), 5, 34);
      const fips = geoCls.stateFipsOf(locId);
      const st = fips && geo.usGeo.states.find((s) => s.fips === fips);
      if (st?.alpha > 0.004) return clamp(0.56 / Math.max(0.012, Math.sin(st.alpha)), 3.2, 22);
      const co = geo.countries.find((c) => !c.detached && (c.iso2 === locId || (locId === "UK" && c.iso2 === "GB")));
      if (co?.alpha > 0.004) return clamp(0.56 / Math.max(0.012, Math.sin(co.alpha)), 2.8, 22);
    }
    return coordsForLoc(locId)?.zoom ?? 6;
  }

  function focusLocation(locId, fly = true) {
    const loc = manifest.locationById.get(locId);
    if (!loc) return;
    selectedLocId = locId;
    recordRecent(locId);
    renderDrawer();
    if (fly) {
      const pt = coordsForLoc(locId);
      if (pt) flyTo(pt.lon, pt.lat, computeFitZoom(locId));
    }
    scheduleDraw();
  }

  function renderDrawer() {
    const loc = selectedLocId ? manifest.locationById.get(selectedLocId) : null;
    if (!loc) {
      drawer.hidden = true;
      return;
    }
    drawer.hidden = false;
    const m = metricForLoc(loc.id, layerId === "none" ? "observed" : layerId);
    const pop = m?.population ?? loc.population;
    const subParts = [
      loc.region || loc.level || null,
      pop > 1 ? `Pop ${pop >= 1e6 ? `${(pop / 1e6).toFixed(1)}M` : `${Math.round(pop / 1e3)}k`}` : null,
      store.get().date,
    ].filter(Boolean);

    const fips = geoCls.stateFipsOf(loc.id);
    const stateHsas = isMetroHub && metroCastOn && loc.level !== "hsa" && fips
      ? (geoCls.hsasByStateFips.get(fips) || [])
      : [];

    const layerNodes = [...drawer.querySelectorAll(":scope > .c-glass-layer")];
    const content = h("div", null,
      h("header", { class: "gb-drawer-head" },
        h("div", { class: "gb-title-row" },
          h("h3", { class: "gb-title" }, loc.name || loc.id),
          h("button", {
            type: "button", class: "c-btn sm icon", "aria-label": "Close summary", html: icon.close,
            onclick: () => { selectedLocId = null; renderDrawer(); scheduleDraw(); },
          }),
        ),
        subParts.length ? h("p", { class: "gb-sub" }, subParts.join(" · ")) : null,
      ),
      m ? h("div", { class: "gb-nums" },
        h("div", { class: "gb-num-row" },
          h("div", { class: "gb-num" },
            h("span", { class: "gb-num-k" }, "Observed"),
            h("span", { class: "gb-num-v mono" }, formatMetric(m.observed, m.useRate)),
          ),
          h("div", { class: "gb-num" },
            h("span", { class: "gb-num-k" }, "Forecast"),
            h("span", { class: "gb-num-v mono" }, formatMetric(m.forecast, m.useRate)),
          ),
          Number.isFinite(m.trendPct) ? h("div", { class: "gb-num" },
            h("span", { class: "gb-num-k" }, "Wk Δ"),
            h("span", { class: "gb-num-v mono" }, `${m.trendPct >= 0 ? "+" : ""}${Math.round(m.trendPct)}%`),
          ) : null,
        ),
      ) : null,
      h("div", { class: "gb-drawer-acts" },
        h("button", {
          type: "button", class: "gb-open-btn",
          onclick: () => { store.set({ location: loc.id }); onClose?.(); },
        }, "Open chart →"),
      ),
      stateHsas.length ? h("div", { class: "gb-metros" },
        h("h4", { class: "gb-metros-title" }, `MetroCast HSAs (${stateHsas.length})`),
        ...stateHsas.map((hsa) => {
          const hm = metricForLoc(hsa.id, layerId === "none" ? "observed" : layerId);
          return h("button", {
            type: "button", class: "c-row",
            onclick: () => focusLocation(hsa.id),
          },
          h("span", { class: "c-row-text" }, h("span", { class: "c-row-label" }, hsa.name)),
          h("span", { class: "c-row-sub mono" }, hm ? formatMetric(hm.value, hm.useRate) : "–"));
        }),
      ) : null,
    );

    drawer.replaceChildren(...layerNodes, content);
  }

  /* ---------------- Camera & Pointer ---------------- */
  function flyTo(lon, lat, zoom) {
    velLon = 0; velLat = 0;
    flight = { fromLonLat: [camLon, camLat], fromZoom: camZoom, toLonLat: [lon, lat], toZoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM), t0: performance.now(), dur: 540 };
    startLoop();
  }

  function zoomByFactor(factor, anchorSx = null, anchorSy = null) {
    flight = null; velLon = 0; velLat = 0;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const baseRadius = Math.min(W, H) * 0.42;
    const { cx, cy, radiusPx, R } = lastGeoSpec;
    const nextZoom = clamp(camZoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (anchorSx != null && anchorSy != null && R && baseRadius > 10) {
      const hit = screenToLonLat(anchorSx, anchorSy, cx, cy, radiusPx, R);
      if (hit) {
        const anchored = solveCameraForAnchor(hit[0], hit[1], anchorSx, anchorSy, cx, cy, baseRadius * nextZoom, camLon, camLat);
        if (anchored) { camLon = anchored[0]; camLat = anchored[1]; }
      }
    }
    camZoom = nextZoom;
    scheduleDraw();
  }

  function pickAtScreen(sx, sy) {
    if (!geo) return null;
    const { cx, cy, radiusPx } = lastGeoSpec;
    if (Math.hypot(sx - cx, sy - cy) > radiusPx) return null;

    if (isMetroHub && metroCastOn && camZoom >= 2.1) {
      for (const dot of hitDots) {
        if (Math.hypot(sx - dot.sx, sy - dot.sy) <= 10) {
          return { kind: "metro", id: dot.id, name: dot.name, locId: dot.id };
        }
      }
      for (const mh of hitMetros) {
        if (pointInRingsEvenOdd(sx, sy, mh.screenRings)) {
          return { kind: "metro", id: mh.id, name: mh.name, locId: mh.id };
        }
      }
    }

    for (const st of hitStates) {
      if (pointInRingsEvenOdd(sx, sy, st.screenRings)) {
        const loc = resolveStateLocation(st.fips);
        if (!loc) continue;
        return { kind: "state", id: st.fips, name: loc.name || st.name || st.fips, locId: loc.id };
      }
    }

    for (const co of hitCountries) {
      if (pointInRingsEvenOdd(sx, sy, co.screenRings)) {
        const cid = co.iso2 || co.id;
        const loc = resolveCountryLocation(cid);
        if (!loc) continue;
        return { kind: "country", id: cid, name: loc.name || cid, locId: loc.id };
      }
    }
    return null;
  }

  let dragging = false, downPt = null, lastPt = null, movedPx = 0;

  const offs = [];
  offs.push(on(canvas, "pointerdown", (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    dragging = true; flight = null; velLon = 0; velLat = 0; movedPx = 0;
    downPt = { x: e.clientX, y: e.clientY };
    lastPt = { x: e.clientX, y: e.clientY };
  }));

  offs.push(on(canvas, "pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;

    if (dragging && lastPt) {
      const dx = e.clientX - lastPt.x, dy = e.clientY - lastPt.y;
      movedPx += Math.hypot(dx, dy);
      const radToDeg = 180 / Math.PI;
      const rPx = Math.max(120, lastGeoSpec.radiusPx);
      const cosLat = Math.max(0.25, Math.cos((camLat * Math.PI) / 180));
      const dLon = -(dx * radToDeg) / (rPx * cosLat);
      const dLat = (dy * radToDeg) / rPx;
      camLon += dLon;
      camLat = clamp(camLat + dLat, -82, 82);
      velLon = dLon * 0.65; velLat = dLat * 0.65;
      lastPt = { x: e.clientX, y: e.clientY };
      if (hoverItem) { hoverItem = null; readout.hidden = true; }
      scheduleDraw();
      return;
    }

    const picked = pickAtScreen(sx, sy);
    if (picked) {
      hoverItem = picked;
      const m = layerId === "none" ? null : metricForLoc(picked.locId, layerId);
      readout.replaceChildren(
        h("div", { class: "c-readout-head" },
          h("span", { style: { fontWeight: "600", color: "var(--ink-primary)" } }, picked.name),
          h("span", { class: "quiet" }, picked.kind === "metro" ? "MetroCast" : picked.kind === "state" ? "State" : "Country"),
        ),
        m ? h("table", null,
          h("tbody", null,
            h("tr", null, h("td", { class: "c-readout-name" }, "Observed"), h("td", { class: "num" }, formatMetric(m.observed, m.useRate))),
            h("tr", null, h("td", { class: "c-readout-name" }, "Forecast"), h("td", { class: "num" }, formatMetric(m.forecast, m.useRate))),
            Number.isFinite(m.trendPct) ? h("tr", null, h("td", { class: "c-readout-name" }, "Wk Δ"), h("td", { class: "num" }, `${m.trendPct >= 0 ? "+" : ""}${Math.round(m.trendPct)}%`)) : null,
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
      if (hit) focusLocation(hit.locId);
    } else if (Math.hypot(velLon, velLat) * lastGeoSpec.radiusPx > 0.35) {
      startLoop();
    }
    downPt = null; lastPt = null;
  };
  offs.push(on(canvas, "pointerup", endDrag));
  offs.push(on(canvas, "pointercancel", endDrag));
  offs.push(on(canvas, "pointerleave", () => { hoverItem = null; readout.hidden = true; scheduleDraw(); }));
  offs.push(on(canvas, "wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomByFactor(Math.exp(-e.deltaY * 0.0022), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false }));
  offs.push(on(canvas, "dblclick", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const hit = pickAtScreen(sx, sy);
    if (hit) focusLocation(hit.locId);
    else zoomByFactor(1.85, sx, sy);
  }));

  /* ---------------- Canvas Loop & Drawing ---------------- */
  let loopRaf = 0;
  function startLoop() { if (!loopRaf && !destroyed) loopRaf = requestAnimationFrame(tick); }
  function tick(now) {
    loopRaf = 0;
    if (destroyed) return;
    let keep = false;
    if (flight) {
      const t = clamp((now - flight.t0) / flight.dur, 0, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      const [lon, lat] = slerpLonLat(flight.fromLonLat, flight.toLonLat, ease);
      camLon = lon; camLat = lat;
      camZoom = flight.fromZoom + (flight.toZoom - flight.fromZoom) * ease;
      if (t >= 1) flight = null; else keep = true;
    } else if (!dragging && (Math.abs(velLon) > 0.02 || Math.abs(velLat) > 0.02)) {
      camLon += velLon; camLat = clamp(camLat + velLat, -82, 82);
      velLon *= 0.9; velLat *= 0.9; keep = true;
    }
    draw();
    if (keep) loopRaf = requestAnimationFrame(tick);
  }

  const scheduleDraw = perFrame(draw);
  function draw() {
    if (destroyed) return;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (W < 40 || H < 40) return;
    const g = fitCanvas(canvas, W, H);
    const isLight = document.documentElement.dataset.theme === "light";

    const inkRgb = parseRgbCss(cssColor("var(--ink-primary)"), isLight ? [17, 18, 22] : [235, 237, 240]);
    const inkSecondary = cssColor("var(--ink-secondary)");
    const inkFaint = cssColor("var(--ink-faint)");
    const lineAxis = cssColor("var(--line-axis)");
    const lineHairline = cssColor("var(--line-hairline)");
    const accent = cssColor("var(--accent)");
    const surfRaised = cssColor("var(--surface-raised)");
    const fontSans = getComputedStyle(document.documentElement).getPropertyValue("--font-sans");

    const drawerShift = selectedLocId && W > 900 ? -120 : 0;
    const cx = W * 0.5 + drawerShift, cy = H * 0.5;
    const radiusPx = Math.min(W, H) * 0.42 * camZoom;
    const R = makeRotationMatrix(camLon, camLat);
    lastGeoSpec = { cx, cy, radiusPx, R };

    const halfDiag = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
    const viewR = halfDiag / radiusPx;
    const thetaMaxRad = viewR < 0.99 ? Math.asin(viewR) : null;
    const clipToLimb = radiusPx <= halfDiag + 4;

    g.save();
    g.fillStyle = surfRaised;
    if (clipToLimb) {
      g.beginPath(); g.arc(cx, cy, radiusPx, 0, Math.PI * 2); g.fill(); g.clip();
    } else {
      g.fillRect(0, 0, W, H);
    }

    if (!geo) {
      g.restore();
      if (clipToLimb) drawLimb(g, cx, cy, radiusPx, lineAxis);
      return;
    }

    // Graticule
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
      const alpha = clamp(0.05 + Math.pow(clamp(norm, 0, 1), 1.05) * (isLight ? 0.52 : 0.44), 0.05, 0.62);
      return `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, ${alpha.toFixed(3)})`;
    };

    const drawStatesLayer = !isEuHub && (isUsStates || isMetroHub || manifest.locationById.has("US"));
    const stateAlpha = drawStatesLayer ? smoothstep(1.18, 1.75, camZoom) : 0;
    const metroAlpha = isMetroHub && metroCastOn ? smoothstep(2.05, 3.1, camZoom) : 0;

    // 1. World countries (detached territories stay unshaded & unselectable)
    hitCountries = [];
    for (const co of geo.countries) {
      if (!coneVisibleInViewport(co, R, thetaMaxRad)) continue;
      const screenRings = [];
      for (const ring3 of co.rings) {
        const clipped = clipPolygonToHemisphere(ring3, R);
        if (!clipped) continue;
        const sr = new Float64Array(clipped.length);
        for (let i = 0; i < clipped.length; i += 2) { sr[i] = cx + clipped[i] * radiusPx; sr[i + 1] = cy - clipped[i + 1] * radiusPx; }
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
      const loc = resolveCountryLocation(cid);
      if (loc) hitCountries.push({ ...co, iso2: co.iso2, screenRings });
      const skipUsShade = cid === "US" && stateAlpha > 0.35;
      const norm = loc && !skipUsShade ? normForLoc(loc.id) : null;
      const isHov = hoverItem?.kind === "country" && hoverItem.id === cid;
      const isSel = !!(loc && selectedLocId === loc.id);

      g.fillStyle = luminanceFill(norm, isSel, isHov);
      g.fill("evenodd");
      g.lineWidth = isSel ? 1.5 : isHov ? 1.15 : 0.65;
      g.strokeStyle = isSel ? accent : isHov ? cssColor("var(--ink-primary)") : inkFaint;
      g.stroke();
    }

    // 2. U.S. States & strictly hub-scoped MetroCast HSAs
    hitStates = [];
    hitMetros = [];
    hitDots = [];
    if (stateAlpha > 0.04) {
      g.save();
      for (const st of geo.usGeo.states) {
        if (!coneVisibleInViewport(st, R, thetaMaxRad)) continue;
        const screenRings = [];
        for (const ring3 of st.rings) {
          const clipped = clipPolygonToHemisphere(ring3, R);
          if (!clipped) continue;
          const sr = new Float64Array(clipped.length);
          for (let i = 0; i < clipped.length; i += 2) { sr[i] = cx + clipped[i] * radiusPx; sr[i + 1] = cy - clipped[i + 1] * radiusPx; }
          screenRings.push(sr);
        }
        if (!screenRings.length) continue;
        hitStates.push({ ...st, screenRings });
        const loc = resolveStateLocation(st.fips);
        const norm = loc ? normForLoc(loc.id) : null;
        const isHov = hoverItem?.kind === "state" && hoverItem.id === st.fips;
        const isSel = !!(loc && selectedLocId === loc.id);
        const isCovered = isMetroHub && metroCastOn && activeMetroStates.has(st.fips);
        const stFade = isCovered && metroAlpha > 0 ? Math.max(0.16, 1 - metroAlpha * 0.84) : 1;

        g.beginPath();
        for (const sr of screenRings) {
          g.moveTo(sr[0], sr[1]);
          for (let i = 2; i < sr.length; i += 2) g.lineTo(sr[i], sr[i + 1]);
          g.closePath();
        }
        g.globalAlpha = stateAlpha * stFade;
        g.fillStyle = luminanceFill(norm, isSel, isHov);
        g.fill("evenodd");
      }

      if (metroAlpha > 0.04 && activeMetros.length) {
        g.globalAlpha = stateAlpha * metroAlpha;
        for (const mh of activeMetros) {
          if (!coneVisibleInViewport(mh, R, thetaMaxRad)) continue;
          const screenRings = [];
          for (const ring3 of mh.rings) {
            const clipped = clipPolygonToHemisphere(ring3, R);
            if (!clipped) continue;
            const sr = new Float64Array(clipped.length);
            for (let i = 0; i < clipped.length; i += 2) { sr[i] = cx + clipped[i] * radiusPx; sr[i + 1] = cy - clipped[i + 1] * radiusPx; }
            screenRings.push(sr);
          }
          if (!screenRings.length) continue;
          hitMetros.push({ id: mh.id, name: mh.name, screenRings });
          const norm = normForLoc(mh.id);
          const isSel = selectedLocId === mh.id;
          const isHov = hoverItem?.kind === "metro" && hoverItem.id === mh.id;

          g.beginPath();
          for (const sr of screenRings) {
            g.moveTo(sr[0], sr[1]);
            for (let i = 2; i < sr.length; i += 2) g.lineTo(sr[i], sr[i + 1]);
            g.closePath();
          }
          g.fillStyle = luminanceFill(norm, isSel, isHov);
          g.fill("evenodd");
        }

        // Exterior HSA borders (only across connected MetroCast HSAs)
        g.beginPath();
        if (useFullMetroMesh) {
          for (const seg3 of geo.usGeo.metroMesh) {
            if (!coneVisibleInViewport(seg3, R, thetaMaxRad)) continue;
            for (const run of clipPolylineToHemisphere(seg3.xyz, R)) {
              g.moveTo(cx + run[0] * radiusPx, cy - run[1] * radiusPx);
              for (let i = 2; i < run.length; i += 2) g.lineTo(cx + run[i] * radiusPx, cy - run[i + 1] * radiusPx);
            }
          }
        } else {
          for (const mh of hitMetros) {
            for (const sr of mh.screenRings) {
              g.moveTo(sr[0], sr[1]);
              for (let i = 2; i < sr.length; i += 2) g.lineTo(sr[i], sr[i + 1]);
              g.closePath();
            }
          }
        }
        g.globalAlpha = stateAlpha * metroAlpha * (isLight ? 0.72 : 0.82);
        g.strokeStyle = isLight ? inkSecondary : inkFaint;
        g.lineWidth = camZoom >= 12 ? 1.0 : 0.8;
        g.stroke();
      }

      // State borders
      g.beginPath();
      for (const seg3 of geo.usGeo.stateMesh) {
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
        const loc = resolveStateLocation(st.fips);
        if (!loc) continue;
        if (selectedLocId === loc.id || (hoverItem?.kind === "state" && hoverItem.id === st.fips)) {
          drawHighlight(st.screenRings, selectedLocId === loc.id);
        }
      }
      for (const mh of hitMetros) {
        if (selectedLocId === mh.id || (hoverItem?.kind === "metro" && hoverItem.id === mh.id)) {
          drawHighlight(mh.screenRings, selectedLocId === mh.id);
        }
      }
      g.restore();

      if (metroAlpha > 0.2 && activeMetros.length) {
        const placed = [];
        g.save();
        g.font = `500 11px ${fontSans}`;
        g.textBaseline = "middle";
        for (const mh of activeMetros) {
          const pz = R[6] * mh.x + R[7] * mh.y + R[8] * mh.z;
          if (pz <= 0.1) continue;
          const px = R[0] * mh.x + R[1] * mh.y + R[2] * mh.z;
          const py = R[3] * mh.x + R[4] * mh.y + R[5] * mh.z;
          const sx = cx + px * radiusPx, sy = cy - py * radiusPx;
          if (sx < -24 || sx > W + 24 || sy < -24 || sy > H + 24) continue;
          const loc = manifest.locationById.get(mh.id);
          const displayName = loc?.name || mh.name;
          hitDots.push({ id: mh.id, name: displayName, sx, sy });
          const isSel = selectedLocId === mh.id;
          const isHov = hoverItem?.kind === "metro" && hoverItem.id === mh.id;

          g.globalAlpha = metroAlpha;
          g.beginPath(); g.arc(sx, sy, isSel ? 4.4 : 2.8, 0, Math.PI * 2);
          g.fillStyle = isSel ? accent : cssColor("var(--ink-primary)"); g.fill();
          if (camZoom >= 3.4 || isSel || isHov) {
            const lbl = loc?.abbr || mh.abbr || displayName;
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
    }

    g.restore();
    if (clipToLimb) drawLimb(g, cx, cy, radiusPx, lineAxis);
  }

  function drawLimb(g, cx, cy, r, lineAxis) {
    g.save();
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
    g.strokeStyle = lineAxis; g.lineWidth = 1; g.stroke();
    g.restore();
  }

  async function refreshSpatial() {
    const sToken = ++spatialToken;
    const tMeta = spatialTargetMeta();
    const s = store.get();
    if (!tMeta || !s.date) {
      spatialData = null;
      recomputeScale();
      updateLegendAndLabel();
      renderDrawer();
      scheduleDraw();
      return;
    }
    const mIds = (s.sel.selected.length ? s.sel.selected : (manifest.recommended || [])).filter((id) => manifest.modelById.has(id));
    const qs = query({ target: tMeta.id, date: s.date, horizon: "all", ...(mIds.length ? { models: mIds.join(",") } : {}) });
    try {
      const json = await getJson(`/api/next/spatial?${qs}`, { slot: spatialSlot });
      if (destroyed || sToken !== spatialToken) return;
      spatialData = json;
      recomputeScale();
      updateLegendAndLabel();
      renderDrawer();
      scheduleDraw();
    } catch {
      if (destroyed || sToken !== spatialToken) return;
      spatialData = null;
      recomputeScale();
      updateLegendAndLabel();
      scheduleDraw();
    }
  }

  const ro = new ResizeObserver(() => scheduleDraw());
  ro.observe(wrap);
  offs.push(
    () => ro.disconnect(),
    store.select(["target", "date", "sel"], () => refreshSpatial()),
    onThemeChange(() => { updateLegendAndLabel(); scheduleDraw(); }),
    onDprChange(() => scheduleDraw()),
  );

  renderRecents();
  updateLegendAndLabel();
  refreshSpatial();

  loadSphereBundle().then((loaded) => {
    if (destroyed) return;
    geo = loaded;
    if (isMetroHub) {
      activeMetros = geo.usGeo.metroFeatures.filter((m) => manifest.locationById.has(m.id));
      activeMetroStates = new Set(activeMetros.map((m) => m.stateFips));
      useFullMetroMesh = activeMetros.length === geo.usGeo.metroFeatures.length;
    }
    const curLoc = store.get().location;
    if (curLoc && curLoc !== "US" && manifest.locationById.has(curLoc)) {
      const pt = coordsForLoc(curLoc);
      if (pt) { camLon = pt.lon; camLat = pt.lat; camZoom = isMetroHub && activeMetros.some((m) => m.id === curLoc) ? 6.5 : 2.8; }
    }
    scheduleDraw();
  }).catch(() => {});

  return {
    destroy() {
      destroyed = true;
      spatialToken++;
      if (loopRaf) cancelAnimationFrame(loopRaf);
      offs.forEach((off) => off());
      hudGlasses.forEach((g) => g.destroy());
      recentGlasses.forEach((g) => g.destroy());
      host.replaceChildren();
    },
  };
}
