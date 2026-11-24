/* Unified multi-hub monochrome luminance Globe for /next/.
 * - Flat paper backdrop (zero vignette in light or dark mode)
 * - Simultaneous US states, European countries, and MetroCast HSAs from GET /api/next/globe
 * - Clear Signal + Display selector (`All · Relative activity` or any single pathogen/target stream)
 * - Dissolved MetroCast HSA borders on zoom strictly for connected MetroCast regions
 * - Detached overseas territories stay unshaded and unselectable
 * - Frosted multi-signal Place Drawer opening any stream directly in-place */
import { h, on, cssColor, storage, onThemeChange } from "../lib/dom.js";
import { fmtDay, valueFormat } from "../lib/format.js";
import { parseIso } from "../lib/scale.js";
import { loadGlobe } from "../lib/api.js";
import { glass } from "../ui/glass.js";
import { pill, icon } from "../ui/controls.js";
import { openMenu } from "../ui/floating.js";
import { linkStyle, fitCanvas, onDprChange } from "../sections/shared.js";
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
import { classifyHubGeo, loadUsGeoCache, loadRegionGeo } from "../geo/picker_geo.js";

/** Camera and layer-transition zoom thresholds for the unified Globe view. */
export const GLOBE_ZOOM = Object.freeze({
  MIN: 1.0,
  MAX: 48,
  US_DEFAULT: 2.0,
  EU_DEFAULT: 2.55,
  STATE_INITIAL: 2.8,
  STATE_FADE_START: 1.18,
  STATE_FADE_END: 1.75,
  METRO_FADE_START: 4.8,
  METRO_FADE_END: 6.8,
  METRO_PICK: 5.4,
  METRO_LABEL: 7.2,
  METRO_FIT_MIN: 8.5,
  METRO_INITIAL: 9.0,
});

const EU_MAINLAND_BOUNDS = Object.freeze({ minLon: -26, maxLon: 45, minLat: 33, maxLat: 73 });
const DETACH_ISOS = new Set([...Object.keys(EU_META), "FR", "NO", "NL", "PT", "ES", "DK", "GB"]);
const DETACH_BOUNDS_BY_ISO = Object.fromEntries([...DETACH_ISOS].map((iso) => [iso, EU_MAINLAND_BOUNDS]));

const DISPLAY_MODES = [
  { id: "observed", label: "Observed" },
  { id: "forecast", label: "Forecast" },
  { id: "trend", label: "Wk Δ" },
  { id: "none", label: "Outlines only" },
];

const RECENTS_KEY = "viz.globe_recents";
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

const LEVEL_LABELS = Object.freeze({
  hsa: "MetroCast HSA",
  state: "State",
  province: "Province",
  territory: "Territory",
  region: "Health Region",
  health_zone: "Health Zone",
  country: "Country",
  borough: "Borough",
  metro: "Metro",
});

/**
 * Format an observed or forecast value for a single Globe stream row or hover readout.
 * @param {number | null | undefined} val
 * @param {{ use_rate?: boolean, scale?: string, unit?: string } | null | undefined} stream
 * @returns {string}
 */
export function formatStreamValue(val, stream) {
  if (typeof val !== "number" || !Number.isFinite(val)) return "–";
  if (stream?.use_rate) return `${Math.abs(val) >= 10 ? val.toFixed(1) : val.toFixed(2)} /100k`;
  const scale = stream?.scale || "count";
  if (scale === "percentage") return `${Math.abs(val) >= 10 ? val.toFixed(1) : val.toFixed(2)}%`;
  if (scale === "proportion") return valueFormat({ scale: "proportion" }).value(val);
  if (scale === "rate") {
    const abs = Math.abs(val);
    const num = abs >= 100
      ? Math.round(val).toLocaleString("en-US")
      : abs >= 10
        ? val.toFixed(1)
        : val.toFixed(2);
    return `${num}${String(stream?.unit || "").includes("100k") ? " /100k" : ""}`;
  }
  return valueFormat({ scale: "count" }).value(val);
}

function parseRgbCss(str, fallback = [245, 245, 245]) {
  const m = String(str || "").match(/[\d.]+/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : fallback;
}

let worldGeoPromise = null;
function loadWorldCountries() {
  if (!worldGeoPromise) {
    const worldUrl = new URL("../geo/world-countries-50m.json", import.meta.url).href;
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

function buildGraticule() {
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
  return { gratLat, gratLon };
}
const GRAT = buildGraticule();

/**
 * Mounts the unified interactive monochrome Globe overlay into `host`.
 * @param {HTMLElement} host
 * @param {{ manifest: import("../lib/api.js").Manifest, store: object, catalog?: object, switchContext?: (o: object) => Promise<void>, onClose?: () => void }} ctx
 */
export function mountGlobeView(host, ctx) {
  const { manifest, store, onClose } = ctx;
  linkStyle("globe");
  const geoCls = classifyHubGeo(manifest);

  // Start facing whichever continent the user came from, while the whole sphere stays live
  let camLon = geoCls.kind === "eu-countries"
    ? 10
    : geoCls.kind === "cd-provinces"
      ? 23.6
      : geoCls.kind === "cn-national"
        ? 104
        : geoCls.kind === "ca-ontario"
          ? -84
          : geoCls.kind === "ca-provinces"
            ? -96
            : -94;
  let camLat = geoCls.kind === "eu-countries"
    ? 50
    : geoCls.kind === "cd-provinces"
      ? -2.9
      : geoCls.kind === "cn-national"
        ? 36
        : geoCls.kind === "ca-ontario"
          ? 48
          : geoCls.kind === "ca-provinces"
            ? 58
            : 38.5;
  let camZoom = geoCls.kind === "eu-countries"
    ? GLOBE_ZOOM.EU_DEFAULT
    : geoCls.kind === "cd-provinces" || geoCls.kind === "ca-ontario"
      ? GLOBE_ZOOM.STATE_INITIAL
      : GLOBE_ZOOM.US_DEFAULT;
  let velLon = 0;
  let velLat = 0;
  let flight = null;

  let globeData = null;
  let regions = {};
  let signals = [];
  let signalId = "all";
  let layerId = "observed";
  let metroCastOn = true;
  let hasUsStates = geoCls.kind === "us-states" || geoCls.kind === "us-metrocast" || manifest.locationById.has("US");
  let hasMetroCast = geoCls.kind === "us-metrocast";
  let hasCaProvinces = geoCls.kind === "ca-provinces";
  let hasCaOntario = geoCls.kind === "ca-ontario";
  let hasCdProvinces = geoCls.kind === "cd-provinces";
  let metroIdSet = new Set();

  let selectedKey = null;
  let hoverItem = null;
  let activeMetros = [];
  let activeMetroStates = new Set();
  let useFullMetroMesh = false;
  let countries = null;
  let usGeo = null;
  let caGeo = null;
  let onGeo = null;
  let cdGeo = null;
  let destroyed = false;

  let hitCountries = [];
  let hitStates = [];
  let hitMetros = [];
  let hitSubRegions = [];
  let hitDots = [];
  let lastGeoSpec = { cx: 0, cy: 0, radiusPx: 1, R: null };

  const loadRecents = () => {
    const raw = storage.get(RECENTS_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((id) => typeof id === "string" && id && (!Object.keys(regions).length || regions[id])).slice(0, 6);
  };
  let recents = loadRecents();
  const recordRecent = (key) => {
    if (!key) return;
    recents = [key, ...recents.filter((x) => x !== key)].slice(0, 6);
    storage.set(RECENTS_KEY, recents);
    renderRecents();
  };

  /* ---------------- Unified Region & Signal Helpers ---------------- */
  const activeSignalMeta = () => signals.find((s) => s.id === signalId) || signals[0] || null;

  function regionByCountryIso(cid) {
    if (!cid) return null;
    if (regions[cid]) return regions[cid];
    if (cid === "GB" && regions.UK) return regions.UK;
    if (cid === "UK" && regions.GB) return regions.GB;
    return null;
  }

  function regionByStateFips(fips) {
    return (fips && regions[fips]) || null;
  }

  function streamForRegion(reg, sigId = signalId) {
    if (!reg || !Array.isArray(reg.streams) || !reg.streams.length) return null;
    if (sigId && sigId !== "all") {
      return reg.streams.find((s) => s.signal_id === sigId) || null;
    }
    // Composite: pick the stream driving peak activity for this place
    let best = null;
    let bestAct = -1;
    for (const s of reg.streams) {
      const a = Number.isFinite(s.activity) ? s.activity : -0.5;
      if (a > bestAct) { bestAct = a; best = s; }
    }
    return best || reg.streams[0];
  }

  function metricForKey(key, mode = layerId) {
    if (!key || mode === "none") return null;
    const reg = regions[key];
    if (!reg) return null;

    if (signalId === "all") {
      const top = streamForRegion(reg, "all");
      if (!top) return null;
      const act = mode === "forecast" ? (reg.composite_forecast_activity ?? reg.composite_activity) : reg.composite_activity;
      const trend = reg.composite_trend_pct;
      return {
        isComposite: true,
        norm: mode === "trend"
          ? (Number.isFinite(trend) ? clamp((trend + 50) / 100, 0, 1) : null)
          : (Number.isFinite(act) ? clamp(act, 0, 1) : null),
        topStream: top,
        trendPct: trend,
      };
    }

    const st = streamForRegion(reg, signalId);
    if (!st) return null;
    const sig = activeSignalMeta();
    let norm = null;
    if (mode === "trend") {
      norm = Number.isFinite(st.trend_pct) ? clamp((st.trend_pct + 50) / 100, 0, 1) : null;
    } else if (mode === "forecast") {
      norm = Number.isFinite(st.forecast_activity) ? clamp(st.forecast_activity, 0, 1) : st.activity;
    } else {
      norm = Number.isFinite(st.activity) ? clamp(st.activity, 0, 1) : st.forecast_activity;
    }
    return {
      isComposite: false,
      norm: Number.isFinite(norm) ? clamp(norm, 0, 1) : null,
      stream: st,
      sig,
      observed: st.observed,
      forecast: st.forecast,
      trendPct: st.trend_pct,
    };
  }

  function normForRegionKey(key) {
    if (layerId === "none") return null;
    const m = metricForKey(key, layerId);
    return m?.norm ?? null;
  }

  function currentKeyFromManifest() {
    const locId = store.get().location;
    if (!locId) return null;
    if (regions[locId]) return locId;
    if (locId === "UK" && regions.GB) return "GB";
    const places = ctx.catalog?.places || {};
    for (const p of Object.values(places)) {
      if (p.hubs?.some((ent) => ent.hub_id === manifest.hub_id && ent.location_id === locId)) {
        return p.key;
      }
    }
    return null;
  }

  /* ---------------- DOM & Liquid Glass HUD ---------------- */
  const wrap = h("div", { class: "gb-wrap" });
  const canvas = h("canvas", { class: "gb-canvas", "aria-label": "Interactive monochrome globe" });
  const recentsEl = h("div", { class: "gb-recents", hidden: true, role: "group", "aria-label": "Recent places" });
  const hudBL = h("div", { class: "gb-hud-bl" });
  const hudBR = h("div", { class: "gb-hud-br" });
  const drawer = h("aside", { class: "c-panel gb-drawer", hidden: true, "aria-label": "Place summary" });

  const layerBtn = pill({
    label: "All · Relative activity",
    size: "sm",
    chevron: true,
    ariaLabel: "Globe signal and display layer",
    onClick: () => openLayerMenu(),
  });
  const keyWrap = h("div", { class: "gb-key" });
  hudBL.append(layerBtn, keyWrap);

  const zoomInBtn = pill({ label: "+", size: "sm", className: "icon", ariaLabel: "Zoom in", onClick: () => zoomByFactor(1.48) });
  const zoomOutBtn = pill({ label: "−", size: "sm", className: "icon", ariaLabel: "Zoom out", onClick: () => zoomByFactor(1 / 1.48) });
  hudBR.append(zoomInBtn, zoomOutBtn);

  wrap.append(canvas, recentsEl, hudBL, hudBR, drawer);
  host.replaceChildren(wrap);

  const layerGlass = glass(layerBtn);
  const keyGlass = glass(keyWrap);
  const hudGlasses = [layerGlass, keyGlass, glass(zoomInBtn), glass(zoomOutBtn), glass(drawer, { panel: true })];
  const recentGlasses = [];
  document.fonts?.ready?.then(() => { layerGlass.update(); keyGlass.update(); });

  function updateLegendAndLabel() {
    const modeDef = DISPLAY_MODES.find((x) => x.id === layerId) || DISPLAY_MODES[0];
    const sig = activeSignalMeta();
    let btnText = modeDef.label;
    if (layerId === "none") {
      btnText = "Outlines only";
    } else if (signalId === "all") {
      btnText = layerId === "trend" ? "All · Wk Δ" : layerId === "forecast" ? "All · Forecast" : "All · Relative activity";
    } else if (sig) {
      btnText = `${sig.short} · ${modeDef.label}`;
    }
    const lbl = layerBtn.querySelector(".c-pill-label");
    if (lbl) lbl.textContent = btnText;
    layerGlass.update();

    if (layerId === "none" || !signals.length) {
      keyWrap.hidden = true;
      return;
    }
    keyWrap.hidden = false;
    const isLight = document.documentElement.dataset.theme === "light";
    const ink = parseRgbCss(cssColor("var(--ink-primary)"), isLight ? [17, 18, 22] : [235, 237, 240]);
    const lowCol = `rgba(${ink[0]}, ${ink[1]}, ${ink[2]}, 0.06)`;
    const hiCol = `rgba(${ink[0]}, ${ink[1]}, ${ink[2]}, ${isLight ? 0.62 : 0.56})`;
    const layerNodes = [...keyWrap.querySelectorAll(":scope > .c-glass-layer")];

    if (layerId === "trend") {
      keyWrap.replaceChildren(
        ...layerNodes,
        h("span", { class: "mono" }, "−50%"),
        h("span", { class: "gb-key-ramp", style: { background: `linear-gradient(90deg, ${lowCol}, ${hiCol})` } }),
        h("span", { class: "mono" }, "+50%"),
        h("span", { class: "gb-key-tag" }, signalId === "all" ? "Wk Δ" : (sig?.short || "Wk Δ")),
      );
      keyGlass.update();
      return;
    }

    if (signalId === "all") {
      keyWrap.replaceChildren(
        ...layerNodes,
        h("span", { class: "mono" }, "Low"),
        h("span", { class: "gb-key-ramp", style: { background: `linear-gradient(90deg, ${lowCol}, ${hiCol})` } }),
        h("span", { class: "mono" }, "High"),
        h("span", { class: "gb-key-tag" }, layerId === "forecast" ? "forecast" : "activity"),
      );
      keyGlass.update();
      return;
    }

    const loVal = layerId === "forecast" ? (sig?.fc_lo ?? sig?.lo ?? 0) : (sig?.lo ?? 0);
    const hiVal = layerId === "forecast" ? (sig?.fc_hi ?? sig?.hi ?? 1) : (sig?.hi ?? 1);
    const tLike = { scale: sig?.scale || "count" };
    const fmtBound = (v) => {
      if (typeof v !== "number" || !Number.isFinite(v)) return "–";
      if (sig?.scale === "percentage") return `${Math.abs(v) < 10 && Math.abs(v) >= 1e-6 ? v.toFixed(1) : Math.round(v)}%`;
      if (sig?.scale === "proportion") return valueFormat({ scale: "proportion" }).value(v);
      if (Math.abs(v) >= 1e3) return valueFormat(tLike).axis(Math.round(v));
      return Math.abs(v) >= 10 || Math.abs(v) < 1e-6 ? String(Math.round(v)) : v.toFixed(1);
    };
    keyWrap.replaceChildren(
      ...layerNodes,
      h("span", { class: "mono" }, fmtBound(loVal)),
      h("span", { class: "gb-key-ramp", style: { background: `linear-gradient(90deg, ${lowCol}, ${hiCol})` } }),
      h("span", { class: "mono" }, sig?.per_100k ? `${fmtBound(hiVal)} /100k` : fmtBound(hiVal)),
    );
    keyGlass.update();
  }

  function renderRecents() {
    recentGlasses.splice(0).forEach((g) => g.destroy());
    const valid = recents.filter((key) => regions[key]);
    recentsEl.hidden = valid.length === 0;
    if (!valid.length) {
      recentsEl.replaceChildren();
      return;
    }
    const btns = valid.map((key) => {
      const reg = regions[key];
      return pill({
        label: reg?.abbr || reg?.name || key,
        size: "sm",
        pressed: key === selectedKey,
        onClick: () => focusRegion(key),
      });
    });
    const clr = pill({
      icon: icon.close,
      size: "sm",
      ariaLabel: "Clear recent places",
      onClick: () => { recents = []; storage.set(RECENTS_KEY, []); renderRecents(); },
    });
    recentsEl.replaceChildren(...btns, clr);
    for (const b of btns) recentGlasses.push(glass(b));
    recentGlasses.push(glass(clr));
  }

  function openLayerMenu() {
    const items = [];
    if (signals.length) {
      items.push({ header: "Signal" });
      for (const sig of signals) {
        const tag = sig.geo_kind === "eu-countries"
          ? "EU"
          : sig.geo_kind === "us-metrocast"
            ? "MetroCast"
            : sig.geo_kind === "ca-provinces"
              ? "CA"
              : sig.geo_kind === "ca-ontario"
                ? "ON"
                : sig.geo_kind === "cd-provinces"
                  ? "CD"
                  : sig.geo_kind === "cn-national"
                    ? "CN"
                    : undefined;
        items.push({
          label: sig.id === "all" ? "All connected · Relative activity" : sig.label,
          shortcut: sig.id === "all" ? undefined : tag,
          checked: signalId === sig.id,
          onSelect: () => {
            signalId = sig.id;
            if (layerId === "none") layerId = "observed";
            updateLegendAndLabel();
            renderDrawer();
            scheduleDraw();
          },
        });
      }
      items.push("-");
    }
    items.push({ header: "Display" });
    for (const md of DISPLAY_MODES) {
      items.push({
        label: md.label,
        checked: layerId === md.id,
        onSelect: () => {
          layerId = md.id;
          updateLegendAndLabel();
          renderDrawer();
          scheduleDraw();
        },
      });
    }
    if (hasMetroCast) {
      items.push("-", {
        label: "MetroCast HSAs",
        toggle: true,
        checked: metroCastOn,
        onSelect: () => {
          metroCastOn = !metroCastOn;
          renderDrawer();
          scheduleDraw();
        },
      });
    }
    openMenu(layerBtn, { label: "Globe signal & layer", placement: "top-start", items });
  }

  function findSubFeature(key) {
    if (!key) return null;
    if (key.startsWith("CA-ON:") && onGeo) return onGeo.byId.get(key.slice(6)) || null;
    if (key.startsWith("CA-") && caGeo) return caGeo.byId.get(key.slice(3).toLowerCase()) || null;
    if (key.startsWith("CD-") && cdGeo) return cdGeo.byId.get(key) || null;
    return null;
  }

  function coordsForRegion(key) {
    if (!key) return null;
    const reg = regions[key];
    const mh = activeMetros.find((m) => m.id === key);
    if (mh && mh.lon != null && mh.lat != null) return { lon: mh.lon, lat: mh.lat, zoom: 14 };
    const subF = findSubFeature(key);
    if (subF?.centroidLonLat) {
      return { lon: subF.centroidLonLat[0], lat: subF.centroidLonLat[1], zoom: key.startsWith("CA-ON:") ? 6.5 : 5.5 };
    }
    const fips = reg?.state_fips || (US_STATE_META[key] ? key : null);
    if (fips && US_STATE_META[fips]?.lon != null) {
      return { lon: US_STATE_META[fips].lon, lat: US_STATE_META[fips].lat, zoom: 8.5 };
    }
    const euCode = key === "UK" ? "GB" : key;
    if (EU_META[euCode]?.lon != null) return { lon: EU_META[euCode].lon, lat: EU_META[euCode].lat, zoom: 7.5 };
    if (reg?.lon != null && reg?.lat != null) {
      return { lon: reg.lon, lat: reg.lat, zoom: key === "CA" || key === "CN" ? 3.0 : 6.0 };
    }
    const country = countries?.find((c) => !c.detached && (c.iso2 === key || (key === "GB" && c.iso2 === "UK")));
    if (country?.centroidLonLat) return { lon: country.centroidLonLat[0], lat: country.centroidLonLat[1], zoom: 5.5 };
    if (key === "US") return { lon: -94, lat: 38.5, zoom: GLOBE_ZOOM.US_DEFAULT };
    return null;
  }

  function computeFitZoom(key) {
    if (key === "US") return 2.15;
    const reg = regions[key];
    const mh = activeMetros.find((m) => m.id === key);
    if (mh?.alpha > 0.004) return clamp(0.56 / Math.max(0.012, Math.sin(mh.alpha)), GLOBE_ZOOM.METRO_FIT_MIN, 34);
    const subF = findSubFeature(key);
    if (subF?.alpha > 0.004) return clamp(0.56 / Math.max(0.012, Math.sin(subF.alpha)), 3.2, 22);
    const fips = reg?.state_fips || (US_STATE_META[key] ? key : null);
    const st = fips && usGeo?.states?.find((s) => s.fips === fips);
    if (st?.alpha > 0.004) return clamp(0.56 / Math.max(0.012, Math.sin(st.alpha)), 3.2, 22);
    const co = countries?.find((c) => !c.detached && (c.iso2 === key || (key === "GB" && c.iso2 === "UK")));
    if (co?.alpha > 0.004) return clamp(0.56 / Math.max(0.012, Math.sin(co.alpha)), 2.4, 22);
    return coordsForRegion(key)?.zoom ?? 6;
  }

  function focusRegion(key, fly = true) {
    if (!regions[key]) return;
    selectedKey = key;
    recordRecent(key);
    renderDrawer();
    if (fly) {
      const pt = coordsForRegion(key);
      if (pt) flyTo(pt.lon, pt.lat, computeFitZoom(key));
    }
    scheduleDraw();
  }

  function openStreamInChart(hubId, targetId, locationId) {
    onClose?.();
    if (ctx.switchContext) {
      ctx.switchContext({ hub: hubId, target: targetId, location: locationId });
    } else {
      store.set({ location: locationId });
    }
  }

  function renderDrawer() {
    const reg = selectedKey ? regions[selectedKey] : null;
    if (!reg) {
      drawer.hidden = true;
      return;
    }
    drawer.hidden = false;
    const pop = reg.population;
    const allStreams = reg.streams || [];
    const lvlLabel = LEVEL_LABELS[reg.level] || reg.level || null;
    const subParts = [
      lvlLabel,
      Number.isFinite(pop) && pop > 1 ? `Pop ${pop >= 1e6 ? `${(pop / 1e6).toFixed(1)}M` : `${Math.round(pop / 1e3)}k`}` : null,
    ].filter(Boolean);

    // Order selected signal first, otherwise keep provider order
    const orderedStreams = signalId && signalId !== "all"
      ? [...allStreams].sort((a, b) => (a.signal_id === signalId ? -1 : b.signal_id === signalId ? 1 : 0))
      : allStreams;

    const rawChildren = reg.level !== "hsa" && reg.level !== "health_zone"
      ? (reg.children || [])
          .map((ck) => regions[ck])
          .filter((r) => r && (r.level !== "hsa" || (hasMetroCast && metroCastOn)))
      : [];
    const withData = rawChildren.filter((r) => r.streams?.length);
    const childHsas = (withData.length ? withData : rawChildren)
      .slice()
      .sort((a, b) => (a.name || a.key).localeCompare(b.name || b.key));
    const childLevels = new Set(childHsas.map((c) => c.level).filter(Boolean));
    const childGroupTitle = childLevels.size === 1
      ? (childLevels.has("state") ? `States (${childHsas.length})`
        : childLevels.has("province") ? `Provinces (${childHsas.length})`
        : childLevels.has("territory") ? `Territories (${childHsas.length})`
        : childLevels.has("health_zone") ? `Health Zones (${childHsas.length})`
        : childLevels.has("region") ? `Health Regions (${childHsas.length})`
        : (childLevels.has("country") || childLevels.has("nation")) ? `Countries (${childHsas.length})`
        : (childLevels.has("hsa") || childLevels.has("metro") || childLevels.has("borough")) ? `MetroCast HSAs (${childHsas.length})`
        : `Sub-regions (${childHsas.length})`)
      : (childLevels.has("province") && (childLevels.has("territory") || childLevels.has("region"))
        ? `Provinces & Regions (${childHsas.length})`
        : `Sub-regions (${childHsas.length})`);

    const streamTitle = (st) => {
      const tShort = st.target_short || st.target_id || "";
      const pathLabel = st.pathogen_label || "";
      if (!pathLabel) return tShort;
      if (!tShort) return pathLabel;
      const tLower = tShort.toLowerCase();
      const tokens = pathLabel.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
      const overlaps = tokens.some((tok) => tLower.includes(tok))
        || (st.pathogen === "influenza" && /\bflu\b/i.test(tShort));
      return overlaps ? tShort : `${pathLabel} · ${tShort}`;
    };

    const primaryMode = layerId === "forecast" ? "forecast" : "observed";
    const valColLabel = primaryMode === "forecast" ? "Forecast" : "Latest";
    const hasNonMetroStream = orderedStreams.some((s) => s.geo_kind !== "us-metrocast");
    const newestIso = orderedStreams.map((s) => s.obs_date || s.ref_date).filter(Boolean).sort().at(-1) || null;
    const asOfText = newestIso ? fmtDay(parseIso(newestIso)) : null;
    const footerText = asOfText && asOfText !== "–" ? `As of ${asOfText}` : null;

    const layerNodes = [...drawer.querySelectorAll(":scope > .c-glass-layer")];
    const content = h("div", { class: "gb-drawer-body" },
      h("header", { class: "gb-drawer-head" },
        h("div", { class: "gb-title-row" },
          h("h3", { class: "gb-title" }, reg.name || reg.key || selectedKey),
          h("button", {
            type: "button", class: "c-btn sm icon", "aria-label": "Close summary", html: icon.close,
            onclick: () => { selectedKey = null; renderDrawer(); scheduleDraw(); },
          }),
        ),
        subParts.length ? h("p", { class: "gb-sub" }, subParts.join(" · ")) : null,
        ctx.openBriefing ? h("div", { class: "gb-drawer-briefing-row", style: { marginTop: "8px" } },
          h("button", {
            type: "button",
            class: "c-btn sm",
            onclick: () => ctx.openBriefing(reg.key || selectedKey),
          }, "Open Briefing →"),
        ) : null,
      ),
      orderedStreams.length ? h("div", { class: "gb-streams" },
        h("div", { class: "gb-streams-head", "aria-hidden": "true" },
          h("span", null, "Signal"),
          h("span", { class: "gb-streams-col" }, valColLabel),
          h("span", { class: "gb-streams-col" }, "Trend"),
          h("span", { class: "gb-stream-go-spacer" })),
        ...orderedStreams.map((st) => {
          const isFocusSig = st.signal_id === signalId;
          const title = streamTitle(st) || st.hub_short || "Signal";
          const showMetroTag = st.geo_kind === "us-metrocast" && hasNonMetroStream;
          const primaryVal = primaryMode === "forecast" ? (st.forecast ?? st.observed) : (st.observed ?? st.forecast);
          const valText = formatStreamValue(primaryVal, st);
          const trendText = Number.isFinite(st.trend_pct)
            ? `${st.trend_pct >= 0 ? "+" : "−"}${Math.round(Math.abs(st.trend_pct))}%`
            : "–";
          return h("button", {
            type: "button",
            class: ["c-row gb-stream-row", isFocusSig && "on"],
            onclick: () => openStreamInChart(st.hub_id, st.target_id, st.location_id),
          },
          h("span", { class: "gb-stream-name" },
            title,
            showMetroTag ? h("span", { class: "gb-stream-tag" }, st.hub_short || "MetroCast") : null),
          h("span", { class: "gb-stream-val mono" }, valText),
          h("span", { class: "gb-stream-trend mono" }, trendText),
          h("span", { class: "gb-stream-go", "aria-hidden": "true" }, "→"));
        }),
      ) : h("p", { class: "pk-empty", style: { padding: "var(--space-8) 0" } }, "No weekly observations for current round"),
      orderedStreams.length && footerText ? h("p", { class: "gb-drawer-foot" }, footerText) : null,
      childHsas.length ? h("div", { class: "gb-metros" },
        h("h4", { class: "gb-metros-title" }, childGroupTitle),
        ...childHsas.map((hsa) => {
          const hs = streamForRegion(hsa, signalId);
          const hsVal = hs ? (primaryMode === "forecast" ? (hs.forecast ?? hs.observed) : (hs.observed ?? hs.forecast)) : null;
          return h("button", {
            type: "button", class: "c-row",
            onclick: () => focusRegion(hsa.key),
          },
          h("span", { class: "c-row-text" }, h("span", { class: "c-row-label" }, hsa.name || hsa.key)),
          h("span", { class: "c-row-sub mono" }, hs ? formatStreamValue(hsVal, hs) : "–"));
        }),
      ) : null,
    );

    drawer.replaceChildren(...layerNodes, content);
  }

  /* ---------------- Camera & Pointer ---------------- */
  function flyTo(lon, lat, zoom) {
    velLon = 0; velLat = 0;
    flight = { fromLonLat: [camLon, camLat], fromZoom: camZoom, toLonLat: [lon, lat], toZoom: clamp(zoom, GLOBE_ZOOM.MIN, GLOBE_ZOOM.MAX), t0: performance.now(), dur: 540 };
    startLoop();
  }

  function zoomByFactor(factor, anchorSx = null, anchorSy = null) {
    flight = null; velLon = 0; velLat = 0;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const baseRadius = Math.min(W, H) * 0.42;
    const { cx, cy, radiusPx, R } = lastGeoSpec;
    const nextZoom = clamp(camZoom * factor, GLOBE_ZOOM.MIN, GLOBE_ZOOM.MAX);
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
    if (!lastGeoSpec.R) return null;
    const { cx, cy, radiusPx } = lastGeoSpec;
    if (Math.hypot(sx - cx, sy - cy) > radiusPx) return null;

    if (hasMetroCast && metroCastOn && camZoom >= GLOBE_ZOOM.METRO_PICK) {
      for (const dot of hitDots) {
        if (Math.hypot(sx - dot.sx, sy - dot.sy) <= 10 && regions[dot.id]) {
          return { kind: "metro", id: dot.id, name: dot.name, key: dot.id };
        }
      }
      for (const mh of hitMetros) {
        if (pointInRingsEvenOdd(sx, sy, mh.screenRings) && regions[mh.id]) {
          return { kind: "metro", id: mh.id, name: mh.name, key: mh.id };
        }
      }
    }

    for (let i = hitSubRegions.length - 1; i >= 0; i--) {
      const sr = hitSubRegions[i];
      if (pointInRingsEvenOdd(sx, sy, sr.screenRings)) {
        return { kind: sr.kind, id: sr.id, name: sr.name, key: sr.key };
      }
    }

    for (const st of hitStates) {
      if (pointInRingsEvenOdd(sx, sy, st.screenRings)) {
        const reg = regionByStateFips(st.fips);
        if (!reg) continue;
        return { kind: "state", id: st.fips, name: reg.name || st.name || st.fips, key: reg.key };
      }
    }

    for (const co of hitCountries) {
      if (pointInRingsEvenOdd(sx, sy, co.screenRings)) {
        const cid = co.iso2 || co.id;
        const reg = regionByCountryIso(cid);
        if (!reg) continue;
        return { kind: "country", id: cid, name: reg.name || cid, key: reg.key };
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
      canvas.style.cursor = "grabbing";
      if (hoverItem) hoverItem = null;
      scheduleDraw();
      return;
    }

    const picked = pickAtScreen(sx, sy);
    const prevKey = hoverItem ? `${hoverItem.kind}:${hoverItem.id}` : "";
    const nextKey = picked ? `${picked.kind}:${picked.id}` : "";
    canvas.style.cursor = picked ? "pointer" : "";
    if (prevKey !== nextKey) {
      hoverItem = picked;
      scheduleDraw();
    }
  }));

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = "";
    if (movedPx < 5 && downPt) {
      const rect = canvas.getBoundingClientRect();
      const hit = pickAtScreen(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) focusRegion(hit.key);
    } else if (Math.hypot(velLon, velLat) * lastGeoSpec.radiusPx > 0.35) {
      startLoop();
    }
    downPt = null; lastPt = null;
  };
  offs.push(on(canvas, "pointerup", endDrag));
  offs.push(on(canvas, "pointercancel", endDrag));
  offs.push(on(canvas, "pointerleave", () => { canvas.style.cursor = ""; if (hoverItem) { hoverItem = null; scheduleDraw(); } }));
  offs.push(on(canvas, "wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomByFactor(Math.exp(-e.deltaY * 0.0022), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false }));
  offs.push(on(canvas, "dblclick", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const hit = pickAtScreen(sx, sy);
    if (hit) focusRegion(hit.key);
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
  function scheduleDraw() { if (!loopRaf && !destroyed) loopRaf = requestAnimationFrame(tick); }

  function draw() {
    const rect = wrap.getBoundingClientRect();
    const W = Math.round(rect.width), H = Math.round(rect.height);
    if (W < 2 || H < 2) return;
    const g = fitCanvas(canvas, W, H);
    if (!g) return;
    const isLight = document.documentElement.dataset.theme === "light";
    const paper = cssColor("var(--surface-paper)");
    const accent = cssColor("var(--accent)");
    const inkFaint = cssColor("var(--ink-faint)");
    const inkSecondary = cssColor("var(--ink-secondary)");
    const lineAxis = cssColor("var(--line-axis)");
    const inkRgb = parseRgbCss(cssColor("var(--ink-primary)"), isLight ? [17, 18, 22] : [235, 237, 240]);
    const fontSans = cssColor("var(--font-sans)") || "system-ui, sans-serif";

    g.fillStyle = paper;
    g.fillRect(0, 0, W, H);

    const cx = W * 0.5, cy = H * 0.52;
    const baseRadius = Math.min(W, H) * 0.42;
    const radiusPx = baseRadius * camZoom;
    const R = makeRotationMatrix(camLon, camLat);
    lastGeoSpec = { cx, cy, radiusPx, R };

    const viewCornerR = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
    const ratio = radiusPx > 1 ? viewCornerR / radiusPx : 2;
    const thetaMaxRad = ratio < 0.999 ? Math.asin(ratio) : Math.PI;
    const clipToLimb = radiusPx < Math.min(W, H) * 0.72;

    g.save();
    g.lineJoin = "round";
    g.lineCap = "round";
    if (clipToLimb) {
      g.beginPath(); g.arc(cx, cy, radiusPx, 0, Math.PI * 2); g.clip();
    }

    // Graticule
    g.save();
    g.strokeStyle = isLight ? "rgba(17,18,22,0.045)" : "rgba(255,255,255,0.045)";
    g.lineWidth = 0.6;
    g.beginPath();
    for (const grp of [GRAT.gratLat, GRAT.gratLon]) {
      for (const pts of grp) {
        for (const run of clipPolylineToHemisphere(pts, R)) {
          g.moveTo(cx + run[0] * radiusPx, cy - run[1] * radiusPx);
          for (let i = 2; i < run.length; i += 2) g.lineTo(cx + run[i] * radiusPx, cy - run[i + 1] * radiusPx);
        }
      }
    }
    g.stroke();
    g.restore();

    const luminanceFill = (norm, isSel, isHov, isConnected) => {
      if (layerId === "none") {
        if (isSel) return `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0.09)`;
        if (isHov) return `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, 0.06)`;
        if (isConnected) return isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.045)";
        return isLight ? "rgba(0,0,0,0.012)" : "rgba(255,255,255,0.018)";
      }
      if (norm == null) {
        if (isConnected) return isLight ? "rgba(0,0,0,0.045)" : "rgba(255,255,255,0.045)";
        return isLight ? "rgba(0,0,0,0.018)" : "rgba(255,255,255,0.02)";
      }
      const alpha = clamp(0.05 + Math.pow(clamp(norm, 0, 1), 1.05) * (isLight ? 0.52 : 0.44), 0.05, 0.62);
      return `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, ${alpha.toFixed(3)})`;
    };

    const drawHighlight = (rings, isSel, selWidth = 2.0, hovWidth = 1.35) => {
      g.beginPath();
      for (const sr of rings) {
        g.moveTo(sr[0], sr[1]);
        for (let i = 2; i < sr.length; i += 2) g.lineTo(sr[i], sr[i + 1]);
        g.closePath();
      }
      g.strokeStyle = isSel ? accent : cssColor("var(--ink-primary)");
      g.lineWidth = isSel ? selWidth : hovWidth;
      g.stroke();
    };

    const drawStatesLayer = hasUsStates;
    const stateAlpha = drawStatesLayer ? smoothstep(GLOBE_ZOOM.STATE_FADE_START, GLOBE_ZOOM.STATE_FADE_END, camZoom) : 0;
    const metroAlpha = hasMetroCast && metroCastOn ? smoothstep(GLOBE_ZOOM.METRO_FADE_START, GLOBE_ZOOM.METRO_FADE_END, camZoom) : 0;
    const caAlpha = hasCaProvinces && caGeo ? smoothstep(GLOBE_ZOOM.STATE_FADE_START, GLOBE_ZOOM.STATE_FADE_END, camZoom) : 0;
    const onFadeStart = hasCaProvinces ? 2.4 : GLOBE_ZOOM.STATE_FADE_START;
    const onFadeEnd = hasCaProvinces ? 3.8 : GLOBE_ZOOM.STATE_FADE_END;
    const onAlpha = hasCaOntario && onGeo ? smoothstep(onFadeStart, onFadeEnd, camZoom) : 0;
    const cdAlpha = hasCdProvinces && cdGeo ? smoothstep(GLOBE_ZOOM.STATE_FADE_START, GLOBE_ZOOM.STATE_FADE_END, camZoom) : 0;

    // 1. World countries (US, Canada, DRC, China, and Europe connected simultaneously!)
    hitCountries = [];
    if (countries) {
      const countryHighlights = [];
      for (const co of countries) {
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
          g.fillStyle = luminanceFill(null, false, false, false);
          g.fill("evenodd");
          g.lineWidth = 0.65;
          g.strokeStyle = inkFaint;
          g.stroke();
          continue;
        }

        const cid = co.iso2 || co.id;
        const reg = regionByCountryIso(cid);
        if (reg) hitCountries.push({ ...co, iso2: co.iso2, screenRings });
        const skipCountryShade = (cid === "US" && stateAlpha > 0.35)
          || (cid === "CA" && (caAlpha > 0.35 || onAlpha > 0.35))
          || (cid === "CD" && cdAlpha > 0.35);
        const norm = reg && !skipCountryShade ? normForRegionKey(reg.key) : null;
        const isHov = hoverItem?.kind === "country" && hoverItem.id === cid;
        const isSel = !!(reg && selectedKey === reg.key);

        g.fillStyle = luminanceFill(norm, isSel, isHov, !!reg);
        g.fill("evenodd");
        g.lineWidth = reg ? 0.85 : 0.55;
        g.strokeStyle = reg ? inkSecondary : inkFaint;
        g.stroke();
        if (isSel || isHov) countryHighlights.push({ screenRings, isSel });
      }
      for (const hl of countryHighlights) {
        drawHighlight(hl.screenRings, hl.isSel, 1.8, 1.25);
      }
    }

    // 2. U.S. States & dissolved MetroCast HSAs (whenever any US or MetroCast hub is connected)
    hitStates = [];
    hitMetros = [];
    hitDots = [];
    if (stateAlpha > 0.04 && usGeo) {
      g.save();
      for (const st of usGeo.states) {
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
        const reg = regionByStateFips(st.fips);
        if (reg) hitStates.push({ ...st, screenRings });
        const norm = reg ? normForRegionKey(reg.key) : null;
        const isHov = hoverItem?.kind === "state" && hoverItem.id === st.fips;
        const isSel = !!(reg && selectedKey === reg.key);
        const isCovered = hasMetroCast && metroCastOn && activeMetroStates.has(st.fips);
        const stFade = isCovered && metroAlpha > 0 ? Math.max(0.16, 1 - metroAlpha * 0.84) : 1;

        g.beginPath();
        for (const sr of screenRings) {
          g.moveTo(sr[0], sr[1]);
          for (let i = 2; i < sr.length; i += 2) g.lineTo(sr[i], sr[i + 1]);
          g.closePath();
        }
        g.globalAlpha = stateAlpha * stFade;
        g.fillStyle = luminanceFill(norm, isSel, isHov, !!reg);
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
          const reg = regions[mh.id];
          hitMetros.push({ id: mh.id, name: reg?.name || mh.name, screenRings });
          const norm = reg ? normForRegionKey(reg.key) : null;
          const isSel = selectedKey === mh.id;
          const isHov = hoverItem?.kind === "metro" && hoverItem.id === mh.id;

          g.beginPath();
          for (const sr of screenRings) {
            g.moveTo(sr[0], sr[1]);
            for (let i = 2; i < sr.length; i += 2) g.lineTo(sr[i], sr[i + 1]);
            g.closePath();
          }
          g.fillStyle = luminanceFill(norm, isSel, isHov, !!reg);
          g.fill("evenodd");
        }

        // Exterior HSA borders (strictly across connected MetroCast HSAs)
        g.beginPath();
        if (useFullMetroMesh) {
          for (const seg3 of usGeo.metroMesh) {
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
      for (const seg3 of usGeo.stateMesh) {
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

      for (const st of hitStates) {
        const reg = regionByStateFips(st.fips);
        if (!reg) continue;
        if (selectedKey === reg.key || (hoverItem?.kind === "state" && hoverItem.id === st.fips)) {
          drawHighlight(st.screenRings, selectedKey === reg.key);
        }
      }
      for (const mh of hitMetros) {
        if (selectedKey === mh.id || (hoverItem?.kind === "metro" && hoverItem.id === mh.id)) {
          drawHighlight(mh.screenRings, selectedKey === mh.id);
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
          const reg = regions[mh.id];
          const displayName = reg?.name || mh.name;
          hitDots.push({ id: mh.id, name: displayName, sx, sy });
          const isSel = selectedKey === mh.id;
          const isHov = hoverItem?.kind === "metro" && hoverItem.id === mh.id;

          g.globalAlpha = metroAlpha;
          g.beginPath(); g.arc(sx, sy, isSel ? 4.4 : 2.8, 0, Math.PI * 2);
          g.fillStyle = isSel ? accent : cssColor("var(--ink-primary)"); g.fill();
          if (camZoom >= GLOBE_ZOOM.METRO_LABEL || isSel || isHov) {
            const lbl = reg?.abbr || mh.abbr || displayName;
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

    // 3. International subnational layers (Canada provinces, Ontario Health Regions, DRC provinces)
    hitSubRegions = [];
    const drawSubnationalOverlay = ({ geo, alpha, kindTag, keyForFeature, fadeFor = null }) => {
      if (alpha <= 0.04 || !geo) return;
      g.save();
      const pendingHighlights = [];
      for (const feat of geo.features) {
        if (!coneVisibleInViewport(feat, R, thetaMaxRad)) continue;
        const screenRings = [];
        for (const ring3 of feat.rings) {
          const clipped = clipPolygonToHemisphere(ring3, R);
          if (!clipped) continue;
          const sr = new Float64Array(clipped.length);
          for (let i = 0; i < clipped.length; i += 2) { sr[i] = cx + clipped[i] * radiusPx; sr[i + 1] = cy - clipped[i + 1] * radiusPx; }
          screenRings.push(sr);
        }
        if (!screenRings.length) continue;

        const key = keyForFeature(feat);
        const reg = regions[key];
        const isSel = selectedKey === key;
        const isHov = hoverItem?.kind === kindTag && hoverItem.id === feat.id;
        if (reg) {
          hitSubRegions.push({ kind: kindTag, id: feat.id, name: reg.name || feat.name, key, screenRings });
        }
        const norm = reg ? normForRegionKey(reg.key) : null;
        const fFade = fadeFor ? fadeFor(key, feat) : 1;

        g.beginPath();
        for (const sr of screenRings) {
          g.moveTo(sr[0], sr[1]);
          for (let i = 2; i < sr.length; i += 2) g.lineTo(sr[i], sr[i + 1]);
          g.closePath();
        }
        g.globalAlpha = alpha * fFade;
        g.fillStyle = luminanceFill(norm, isSel, isHov, !!reg);
        g.fill("evenodd");
        if (isSel || isHov) pendingHighlights.push({ screenRings, isSel });
      }

      if (geo.mesh?.length) {
        g.beginPath();
        for (const seg3 of geo.mesh) {
          if (!coneVisibleInViewport(seg3, R, thetaMaxRad)) continue;
          for (const run of clipPolylineToHemisphere(seg3.xyz, R)) {
            g.moveTo(cx + run[0] * radiusPx, cy - run[1] * radiusPx);
            for (let i = 2; i < run.length; i += 2) g.lineTo(cx + run[i] * radiusPx, cy - run[i + 1] * radiusPx);
          }
        }
        g.globalAlpha = alpha;
        g.strokeStyle = inkSecondary;
        g.lineWidth = clamp(0.75 + alpha * 0.4, 0.75, 1.35);
        g.stroke();
      }

      for (const hl of pendingHighlights) {
        g.globalAlpha = alpha;
        drawHighlight(hl.screenRings, hl.isSel);
      }
      g.restore();
    };

    drawSubnationalOverlay({
      geo: caGeo,
      alpha: caAlpha,
      kindTag: "ca-prov",
      keyForFeature: (f) => `CA-${String(f.id).toUpperCase()}`,
      fadeFor: (k) => (k === "CA-ON" && onAlpha > 0 ? Math.max(0.18, 1 - onAlpha * 0.82) : 1),
    });
    drawSubnationalOverlay({
      geo: onGeo,
      alpha: onAlpha,
      kindTag: "ca-oh",
      keyForFeature: (f) => `CA-ON:${f.id}`,
    });
    drawSubnationalOverlay({
      geo: cdGeo,
      alpha: cdAlpha,
      kindTag: "cd-prov",
      keyForFeature: (f) => f.id,
    });

    g.restore();
    if (clipToLimb) {
      g.save();
      g.beginPath(); g.arc(cx, cy, radiusPx, 0, Math.PI * 2);
      g.strokeStyle = lineAxis; g.lineWidth = 1; g.stroke();
      g.restore();
    }
  }

  function applyMetroGeometry() {
    if (!usGeo || !hasMetroCast || !metroIdSet.size) return;
    activeMetros = usGeo.metroFeatures.filter((m) => metroIdSet.has(m.id));
    activeMetroStates = new Set(activeMetros.map((m) => m.stateFips));
    useFullMetroMesh = activeMetros.length === usGeo.metroFeatures.length;
  }

  function ensureRegionGeos() {
    if (hasCaProvinces && !caGeo) {
      loadRegionGeo("ca-provinces").then((g) => { if (!destroyed) { caGeo = g; scheduleDraw(); } }).catch(() => {});
    }
    if (hasCaOntario && !onGeo) {
      loadRegionGeo("ca-ontario").then((g) => { if (!destroyed) { onGeo = g; scheduleDraw(); } }).catch(() => {});
    }
    if (hasCdProvinces && !cdGeo) {
      loadRegionGeo("cd-provinces").then((g) => { if (!destroyed) { cdGeo = g; scheduleDraw(); } }).catch(() => {});
    }
  }

  const ro = new ResizeObserver(() => scheduleDraw());
  ro.observe(wrap);
  offs.push(
    () => ro.disconnect(),
    onThemeChange(() => { updateLegendAndLabel(); scheduleDraw(); }),
    onDprChange(() => scheduleDraw()),
  );

  renderRecents();
  updateLegendAndLabel();
  ensureRegionGeos();
  scheduleDraw();

  loadWorldCountries()
    .then((c) => {
      if (destroyed) return;
      countries = c;
      scheduleDraw();
    })
    .catch(() => {});

  loadUsGeoCache()
    .then((ug) => {
      if (destroyed) return;
      usGeo = ug;
      applyMetroGeometry();
      scheduleDraw();
    })
    .catch(() => {});

  loadGlobe()
    .then((glData) => {
      if (destroyed || !glData?.regions) return;
      globeData = glData;
      regions = glData.regions;
      signals = glData.signals || [];
      signalId = signals[0]?.id || "all";
      const cov = glData.coverage || {};
      hasUsStates = Boolean(cov.has_us_states || cov.has_metrocast);
      hasMetroCast = Boolean(cov.has_metrocast);
      hasCaProvinces = Boolean(cov.has_ca_provinces);
      hasCaOntario = Boolean(cov.has_ca_ontario);
      hasCdProvinces = Boolean(cov.has_cd_provinces);
      metroIdSet = new Set(cov.metro_ids || []);
      applyMetroGeometry();
      ensureRegionGeos();

      const curKey = currentKeyFromManifest();
      if (curKey && !["US", "CA", "CD", "CN"].includes(curKey)) {
        const pt = coordsForRegion(curKey);
        if (pt) {
          camLon = pt.lon;
          camLat = pt.lat;
          camZoom = hasMetroCast && metroIdSet.has(curKey) ? GLOBE_ZOOM.METRO_INITIAL : GLOBE_ZOOM.STATE_INITIAL;
        }
      }
      renderRecents();
      updateLegendAndLabel();
      renderDrawer();
      scheduleDraw();
    })
    .catch(() => {});

  return {
    destroy() {
      destroyed = true;
      if (loopRaf) cancelAnimationFrame(loopRaf);
      offs.forEach((off) => off());
      hudGlasses.forEach((g) => g.destroy());
      recentGlasses.forEach((g) => g.destroy());
      host.replaceChildren();
    },
  };
}
