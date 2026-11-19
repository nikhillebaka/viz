/* Tab 1: Ultra-Minimal B&W 3D Sphere Globe Prototype.
 * Features:
 * - HiDPI Canvas 2D orthographic globe on 3D unit-sphere coordinates (zero antimeridian seams)
 * - Smooth drag rotation + momentum inertia + wheel zoom + great-circle SLERP camera presets
 * - Progressive LOD: world coastlines (110m) -> US states -> real 3,231 U.S. counties sharpening
 *   above zoom 2.0× via shared-arc mesh + 3D bounding-cone culling -> MetroCast & EU city dots
 * - 4 toggleable burden encodings: Luminance (B&W), Halftone, Pulse, Thermal (--score-5..9)
 * - Hover solid .c-readout, click-to-fly frosted Place Drawer -> "Open Place Briefing",
 *   and "Preview First-Visit Mode" new-user landing overlay. */
import { h, on, cssColor } from "../lib/dom.js";
import { glass } from "../ui/glass.js";
import { Segmented, pill, icon } from "../ui/controls.js";
import { fitCanvas, sequential, perFrame, resetColors } from "../sections/shared.js";
import {
  arcsToUnitSphere,
  clipPolygonToHemisphere,
  clipPolylineToHemisphere,
  coneVisibleInViewport,
  decodeArcs,
  extractMesh,
  extractPolygons,
  lonLatToXYZ,
  makeRotationMatrix,
  pointInFlatRing,
  slerpLonLat,
} from "../geo/topo.js";
import { EU_META, ISO_NUM_TO_ALPHA2, METROCAST_CITIES, US_STATE_META, lookupPlaceMeta } from "../geo/eu_tiles.js";
import { buildBriefingForPlace, buildSpatialSnapshot } from "./fixtures.js";
import { fetchLiveSpatial, probeLiveBackend } from "./liveBridge.js";

const PRESETS = [
  { id: "world", label: "World", lon: -42, lat: 34, zoom: 1.05 },
  { id: "us", label: "United States", lon: -96, lat: 38.5, zoom: 2.15 },
  { id: "ne", label: "New England", lon: -71.5, lat: 42.3, zoom: 4.9 },
  { id: "ut", label: "Utah / Mountain", lon: -111.7, lat: 40.3, zoom: 4.8 },
  { id: "tx", label: "Texas", lon: -98.5, lat: 31.2, zoom: 3.9 },
  { id: "eu", label: "Europe", lon: 10, lat: 50, zoom: 2.55 },
];

const ENCODINGS = [
  { value: "luminance", label: "Luminance" },
  { value: "halftone", label: "Halftone" },
  { value: "pulse", label: "Pulse" },
  { value: "thermal", label: "Thermal" },
];

let geoPromise = null;
async function loadGlobeGeometry() {
  if (geoPromise) return geoPromise;
  geoPromise = (async () => {
    const worldUrl = new URL("../geo/world-countries-110m.json", import.meta.url).href;
    const usUrl = new URL("../geo/us-counties-10m.json", import.meta.url).href;
    const [worldTopo, usTopo] = await Promise.all([
      fetch(worldUrl).then((r) => r.json()),
      fetch(usUrl).then((r) => r.json()),
    ]);

    const worldArcs = arcsToUnitSphere(decodeArcs(worldTopo));
    const usArcs = arcsToUnitSphere(decodeArcs(usTopo));

    const countries = extractPolygons(worldTopo, "countries", worldArcs).map((f) => ({
      ...f,
      iso2: ISO_NUM_TO_ALPHA2[String(f.id).padStart(3, "0")] || ISO_NUM_TO_ALPHA2[String(f.id)] || null,
    }));
    const states = extractPolygons(usTopo, "states", usArcs).map((f) => ({
      ...f,
      fips: String(f.id).padStart(2, "0"),
    }));
    const stateMesh = extractMesh(usTopo, "states", usArcs);
    const countyMesh = extractMesh(usTopo, "counties", usArcs, (a, b) => a && b); // interior county edges first; coasts covered by stateMesh

    // Precompute unit sphere coordinates for graticule and cities
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

    const cities = METROCAST_CITIES.map((c) => {
      const [x, y, z] = lonLatToXYZ(c.lon, c.lat);
      return { ...c, x, y, z };
    });

    return { countries, states, stateMesh, countyMesh, gratLat, gratLon, cities };
  })();
  return geoPromise;
}

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
  const all = [...wave.obs.map((p) => p.val), ...wave.forecast.map((p) => p.hi95)];
  const max = Math.max(1, ...all) * 1.05;
  const W = 288, H = 48;
  const nTotal = 18;
  const x = (w) => (w / (nTotal - 1)) * W;
  const y = (v) => H - 4 - (v / max) * (H - 8);

  const fanPtsTop = wave.forecast.map((p) => `${x(p.w).toFixed(1)},${y(p.hi95).toFixed(1)}`).join(" ");
  const fanPtsBot = [...wave.forecast].reverse().map((p) => `${x(p.w).toFixed(1)},${y(p.lo95).toFixed(1)}`).join(" ");
  const obsD = wave.obs.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.w).toFixed(1)},${y(p.val).toFixed(1)}`).join(" ");
  const medD = wave.forecast.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.w).toFixed(1)},${y(p.med).toFixed(1)}`).join(" ");

  return `<svg class="gb-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <polygon points="${fanPtsTop} ${fanPtsBot}" fill="var(--accent)" fill-opacity="0.18"/>
    <path d="${obsD}" fill="none" stroke="var(--ink-primary)" stroke-width="1.6" stroke-linecap="round"/>
    <path d="${medD}" fill="none" stroke="var(--accent)" stroke-width="1.75" stroke-dasharray="3 2.5" stroke-linecap="round"/>
  </svg>`;
}

export function mount(root, ctx) {
  const spatial = buildSpatialSnapshot();
  const offs = [];
  let destroyed = false;
  let geo = null;
  let liveSpatial = null;

  // Camera state
  let camLon = -76;
  let camLat = 39;
  let camZoom = 2.05;
  let velLon = 0;
  let velLat = 0;
  let flight = null; // { fromLonLat, fromZoom, toLonLat, toZoom, t0, dur }
  let activePreset = "us";
  let encoding = "luminance";
  let hoverItem = null; // { kind: "city"|"state"|"country", id, name, data, sx, sy }
  let selectedPlaceId = ctx.state.primaryLocation || "25";
  let drawerOpen = true;
  let onboardOpen = false;
  let pulsePhase = 0;

  // Geometry projected caches from last draw for fast hit-testing
  let hitCountries = [];
  let hitStates = [];
  let hitCities = [];
  let lastGeoSpec = { cx: 0, cy: 0, radiusPx: 1, R: null };

  // ---------------- DOM skeleton ----------------
  const wrap = h("div", { class: "gb-wrap" });
  const canvas = h("canvas", { class: "gb-canvas", "aria-label": "Interactive 3D disease burden globe" });
  const hudTL = h("div", { class: "gb-hud-tl" });
  const hudTR = h("div", { class: "gb-hud-tr" });
  const hudBL = h("div", { class: "gb-hud-bl" });
  const readout = h("div", { class: "c-readout v-readout", role: "status", hidden: true });

  const encWrap = h("div");
  const presetRow = h("div", { style: { display: "flex", gap: "var(--space-6)", flexWrap: "wrap" } });
  const presetBtns = new Map();
  for (const p of PRESETS) {
    const b = pill({
      label: p.label,
      size: "sm",
      pressed: p.id === activePreset,
      onClick: () => flyTo(p.lon, p.lat, p.zoom, p.id),
    });
    presetBtns.set(p.id, b);
    presetRow.append(b);
  }
  hudTL.append(encWrap, presetRow);

  const lodPill = h("span", { class: "c-pill sm gb-lod-pill" }, "Loading globe geometry…");
  const onboardBtn = pill({
    label: "First-visit landing",
    size: "sm",
    pressed: onboardOpen,
    onClick: () => toggleOnboard(!onboardOpen),
  });
  const zoomOutBtn = pill({ label: "−", size: "sm", ariaLabel: "Zoom out", onClick: () => nudgeZoom(-0.7) });
  const zoomInBtn = pill({ label: "+", size: "sm", ariaLabel: "Zoom in", onClick: () => nudgeZoom(+0.85) });
  hudTR.append(lodPill, onboardBtn, zoomOutBtn, zoomInBtn);

  const legendPill = h("div", { class: "c-note gb-lod-pill" });
  hudBL.append(legendPill);

  const drawer = h("aside", { class: "gb-drawer", "aria-label": "Selected location summary" });
  const onboardModal = h("div", { class: "gb-onboard", hidden: true, role: "dialog", "aria-label": "First-visit location setup" });

  wrap.append(canvas, hudTL, hudTR, hudBL, drawer, onboardModal, readout);
  root.replaceChildren(wrap);

  // Attach glass AFTER nodes are connected in document
  new Segmented(encWrap, {
    items: ENCODINGS,
    value: encoding,
    label: "Burden visual encoding",
    onChange: (v) => {
      encoding = v;
      updateLegend();
      scheduleDraw();
    },
  });
  glass(encWrap);
  for (const b of presetBtns.values()) glass(b);
  glass(lodPill);
  glass(onboardBtn);
  glass(zoomOutBtn);
  glass(zoomInBtn);
  glass(legendPill);
  glass(drawer, { panel: true });
  glass(onboardModal, { panel: true });

  function updateLegend() {
    const map = {
      luminance: "Luminance (B&W) · brighter ink = higher weekly incidence · US county mesh sharpens at z ≥ 2.0×",
      halftone: "Halftone Dots · monochrome sphere with dot radius scaled to √(rate / 100k)",
      pulse: "Signal Pulse · concentric velocity halos mark rapid WoW acceleration (+10% or higher)",
      thermal: "Thermal Score Ramp · /next/ --score-5..9 scale; scroll or double-click to sharpen counties",
    };
    legendPill.querySelector(":scope > span:last-child, span")?.remove?.();
    // glass() wraps text nodes, update label cleanly inside inner span
    let span = legendPill.querySelector(".gb-legend-txt");
    if (!span) {
      span = h("span", { class: "gb-legend-txt" });
      legendPill.append(span);
    }
    span.textContent = map[encoding] || "";
  }
  updateLegend();

  function dataLookup(kind, id) {
    if (liveSpatial?.states?.[id]) {
      const meta = lookupPlaceMeta(id);
      const base = kind === "country" ? spatial.eu.eu_ili[1][id] || spatial.us[1].US : spatial.us[1][id];
      const liveRec = liveSpatial.states[id];
      const rate = liveRec.rate_per_100k ?? base?.rate_per_100k ?? 4.2;
      return {
        ...(base || { id, name: meta?.name || id, abbr: meta?.abbr || id }),
        rate_per_100k: rate,
        median: liveRec.median ?? base?.median ?? 0,
        growthPct: liveRec.trend_pct ?? base?.growthPct ?? 0,
        intensity: clamp(Math.sqrt(rate / 18), 0.08, 0.98),
        hub: `${liveSpatial.target} (Live)`,
      };
    }
    if (kind === "city") return spatial.cities[1][id] || null;
    if (kind === "state") return spatial.us[1][id] || null;
    if (kind === "country") {
      if (id === "US") return spatial.us[1].US;
      if (EU_META[id]) return spatial.eu.eu_ili[1][id];
    }
    return null;
  }

  function renderDrawer() {
    drawer.hidden = !drawerOpen || !selectedPlaceId;
    if (drawer.hidden) return;
    const briefing = buildBriefingForPlace(selectedPlaceId);
    const sig = briefing.signals[0];
    const isPrimary = ctx.state.primaryLocation === briefing.placeId;
    const layerNodes = [...drawer.querySelectorAll(":scope > .c-glass-layer")];
    const content = h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--space-12)" } },
      h("div", { class: "gb-drawer-head" },
        h("div", null,
          h("div", { class: "lab-tag is-accent" }, briefing.weekLabel, " · ", briefing.phase),
          h("h3", { class: "gb-drawer-title", style: { marginTop: "var(--space-6)" } }, briefing.name),
          h("p", { class: "gb-drawer-sub" }, briefing.breadcrumbs.slice(0, -1).join(" › ") || briefing.region),
        ),
        h("button", {
          type: "button", class: "c-btn sm icon", "aria-label": "Close drawer", html: icon.close,
          onclick: () => { drawerOpen = false; renderDrawer(); },
        }),
      ),
      h("dl", { class: "gb-drawer-stats" },
        h("div", { class: "gb-stat" },
          h("dt", null, sig.label),
          h("dd", null, sig.value, " ", h("small", { style: { fontSize: "var(--text-micro)", color: "var(--ink-tertiary)", fontWeight: 400 } }, sig.unit)),
        ),
        h("div", { class: "gb-stat" },
          h("dt", null, "WoW trend"),
          h("dd", { style: { color: sig.deltaPct > 8 ? "var(--status-warning)" : "var(--ink-primary)" } }, `${sig.deltaPct >= 0 ? "+" : ""}${sig.deltaPct}%`),
        ),
        h("div", { class: "gb-stat" },
          h("dt", null, "Peak outlook"),
          h("dd", null, briefing.peakOutlook.peakWeek),
        ),
        h("div", { class: "gb-stat" },
          h("dt", null, "Lead model"),
          h("dd", { style: { fontSize: "var(--text-small)" } }, briefing.leaderboard[0].model),
        ),
      ),
      h("div", { html: buildSparklineSvg(briefing.primaryWave) }),
      h("div", { class: "gb-drawer-actions" },
        h("button", {
          type: "button", class: "gb-btn-primary",
          onclick: () => ctx.openBriefing(briefing.placeId),
        }, "Open Place Briefing →"),
        h("button", {
          type: "button", class: "c-btn filled",
          onclick: () => {
            ctx.setPrimaryLocation(briefing.placeId);
            renderDrawer();
          },
        }, isPrimary ? "Primary ★" : "Pin Primary"),
      ),
    );
    drawer.replaceChildren(...layerNodes, content);
  }

  function renderOnboard() {
    onboardModal.hidden = !onboardOpen;
    if (!onboardOpen) return;
    const layerNodes = [...onboardModal.querySelectorAll(":scope > .c-glass-layer")];
    const searchInput = h("input", { type: "search", placeholder: "Search US state, EU country, or MetroCast city…", autocomplete: "off" });
    const resultsBox = h("div", { class: "gb-onboard-results" });
    const allPlaces = [
      US_STATE_META.US,
      ...Object.values(US_STATE_META).filter((x) => x.id !== "US"),
      ...Object.values(EU_META).filter((x) => !x.parent_id),
      ...METROCAST_CITIES,
    ];

    const pickPlace = (meta) => {
      selectedPlaceId = meta.id;
      ctx.setPrimaryLocation(meta.id);
      toggleOnboard(false);
      flyTo(meta.lon ?? -96, meta.lat ?? 39, meta.level === "hsa" ? 5.1 : meta.id === "US" ? 2.1 : 3.6, null);
      drawerOpen = true;
      renderDrawer();
    };

    const drawResults = () => {
      const q = searchInput.value.trim().toLowerCase();
      const hits = q
        ? allPlaces.filter((p) => (p.name || "").toLowerCase().includes(q) || (p.abbr || "").toLowerCase() === q).slice(0, 6)
        : ["US", "25", "provo", "DE", "GB", "CA"].map((id) => lookupPlaceMeta(id)).filter(Boolean);
      resultsBox.replaceChildren(...hits.map((m) =>
        h("button", { type: "button", class: "c-row", onclick: () => pickPlace(m) },
          h("span", { class: "c-row-text" },
            h("span", { class: "c-row-label" }, m.name),
            h("span", { class: "c-row-sub" }, m.hub || m.region || m.level),
          ),
          h("span", { class: "lab-tag mono" }, m.abbr),
        ),
      ));
    };
    searchInput.addEventListener("input", drawResults);
    drawResults();

    const body = h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--space-12)" } },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
        h("span", { class: "lab-tag is-accent" }, "New-user Globe Landing Concept"),
        h("button", { type: "button", class: "c-btn sm icon", "aria-label": "Dismiss landing preview", html: icon.close, onclick: () => toggleOnboard(false) }),
      ),
      h("h3", null, "Select your primary surveillance region"),
      h("p", null, "New visitors start on the globe, choose a hub or place once (saved in profile/cookies), and jump straight into live briefings & forecasts."),
      h("label", { class: "c-search", html: icon.search }, searchInput),
      resultsBox,
    );
    onboardModal.replaceChildren(...layerNodes, body);
  }

  function toggleOnboard(onVal) {
    onboardOpen = onVal;
    onboardBtn.setAttribute("aria-pressed", String(onVal));
    renderOnboard();
  }

  function flyTo(lon, lat, zoom, presetId = null) {
    activePreset = presetId;
    for (const [id, b] of presetBtns) b.setAttribute("aria-pressed", String(id === presetId));
    velLon = 0;
    velLat = 0;
    flight = {
      fromLonLat: [camLon, camLat],
      fromZoom: camZoom,
      toLonLat: [lon, lat],
      toZoom: clamp(zoom, 1.0, 7.5),
      t0: performance.now(),
      dur: 620,
    };
    startLoop();
  }

  function nudgeZoom(delta) {
    flight = null;
    camZoom = clamp(camZoom + delta, 1.0, 7.5);
    scheduleDraw();
  }

  // Called externally when the header Location Pill clicks "Explore on Globe"
  function focusPlace(placeId) {
    const meta = lookupPlaceMeta(placeId);
    if (!meta) return;
    selectedPlaceId = meta.id;
    drawerOpen = true;
    renderDrawer();
    const targetZoom = meta.id === "US" ? 2.15 : meta.level === "country" ? 2.8 : meta.level === "state" ? 3.8 : 5.1;
    flyTo(meta.lon ?? -96, meta.lat ?? 39, targetZoom, null);
  }

  // ---------------- Pointer & Wheel Interaction ----------------
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
      const degPerPx = 68 / (Math.max(120, lastGeoSpec.radiusPx));
      camLon -= dx * degPerPx;
      camLat = clamp(camLat + dy * degPerPx, -82, 82);
      velLon = -dx * degPerPx * 0.65;
      velLat = dy * degPerPx * 0.65;
      lastPt = { x: e.clientX, y: e.clientY };
      if (movedPx > 4 && activePreset) {
        activePreset = null;
        for (const b of presetBtns.values()) b.setAttribute("aria-pressed", "false");
      }
      hoverItem = null;
      readout.hidden = true;
      scheduleDraw();
      return;
    }

    // Hover picking
    const picked = pickAtScreen(sx, sy);
    if (picked) {
      hoverItem = picked;
      const d = dataLookup(picked.kind, picked.id);
      const rateStr = d?.rate_per_100k != null ? `${d.rate_per_100k.toFixed(1)} / 100k` : "No signal";
      const trStr = d?.growthPct != null ? `${d.growthPct >= 0 ? "+" : ""}${d.growthPct}% WoW` : "";
      readout.replaceChildren(
        h("div", { class: "c-readout-head" },
          h("span", { style: { fontWeight: "600", color: "var(--ink-primary)" } }, picked.name),
          h("span", { class: "quiet" }, picked.kind === "city" ? "HSA / City" : picked.kind === "state" ? "State" : "Country"),
        ),
        d ? h("table", null,
          h("tbody", null,
            h("tr", null, h("td", { class: "c-readout-name" }, d.hub || "Surveillance"), h("td", { class: "num" }, rateStr)),
            h("tr", null, h("td", { class: "c-readout-name" }, d.activityTier || "Activity"), h("td", { class: "num" }, trStr)),
          ),
        ) : h("div", { class: "quiet" }, "Geographic border context"),
        h("div", { class: "c-readout-foot" },
          h("span", null, "Click to focus & open briefing"),
        ),
      );
      readout.hidden = false;
      const rw = 240;
      const rh = 110;
      readout.style.transform = `translate(${clamp(sx + 16, 12, rect.width - rw - 12)}px, ${clamp(sy - 20, 64, rect.height - rh - 12)}px)`;
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
      if (hit && (dataLookup(hit.kind, hit.id) || US_STATE_META[hit.id] || EU_META[hit.id])) {
        focusPlace(hit.id);
      }
    } else if (Math.hypot(velLon, velLat) > 0.04) {
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
    flight = null;
    const factor = Math.exp(-e.deltaY * 0.0018);
    camZoom = clamp(camZoom * factor, 1.0, 7.5);
    scheduleDraw();
  }, { passive: false }));

  offs.push(on(canvas, "dblclick", (e) => {
    const rect = canvas.getBoundingClientRect();
    const hit = pickAtScreen(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) focusPlace(hit.id);
    else nudgeZoom(+1.0);
  }));

  function pickAtScreen(sx, sy) {
    if (!geo) return null;
    const { cx, cy, radiusPx } = lastGeoSpec;
    if (Math.hypot(sx - cx, sy - cy) > radiusPx) return null;

    // 1. Cities first (prioritize dot hit within 14px)
    for (const c of hitCities) {
      if (Math.hypot(sx - c.sx, sy - c.sy) <= 13) {
        return { kind: "city", id: c.id, name: c.name };
      }
    }
    // 2. US States
    for (const st of hitStates) {
      for (const ring of st.screenRings) {
        if (pointInFlatRing(sx, sy, ring)) {
          const meta = US_STATE_META[st.fips];
          return { kind: "state", id: st.fips, name: meta?.name || st.name || st.fips };
        }
      }
    }
    // 3. World countries
    for (const co of hitCountries) {
      for (const ring of co.screenRings) {
        if (pointInFlatRing(sx, sy, ring)) {
          const id = co.iso2 || co.id;
          const meta = EU_META[id] || (id === "US" ? US_STATE_META.US : null);
          return { kind: "country", id, name: meta?.name || co.name || id };
        }
      }
    }
    return null;
  }

  // ---------------- Canvas Renderer ----------------
  let loopRaf = 0;
  function startLoop() {
    if (loopRaf || destroyed) return;
    loopRaf = requestAnimationFrame(tick);
  }
  function tick(now) {
    loopRaf = 0;
    if (destroyed) return;
    let keepGoing = false;
    if (flight) {
      const t = clamp((now - flight.t0) / flight.dur, 0, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      const [lon, lat] = slerpLonLat(flight.fromLonLat, flight.toLonLat, ease);
      camLon = lon;
      camLat = lat;
      camZoom = flight.fromZoom + (flight.toZoom - flight.fromZoom) * ease;
      if (t >= 1) flight = null;
      else keepGoing = true;
    } else if (!dragging && (Math.abs(velLon) > 0.02 || Math.abs(velLat) > 0.02)) {
      camLon += velLon;
      camLat = clamp(camLat + velLat, -82, 82);
      velLon *= 0.90;
      velLat *= 0.90;
      keepGoing = true;
    } else if (encoding === "pulse") {
      pulsePhase = (now * 0.0012) % 1;
      keepGoing = true;
    } else if (!dragging && !hoverItem && camZoom < 1.2 && onboardOpen) {
      camLon += 0.14;
      keepGoing = true;
    }
    draw();
    if (keepGoing) loopRaf = requestAnimationFrame(tick);
  }

  const scheduleDraw = perFrame(() => {
    if (!destroyed) {
      draw();
      if (encoding === "pulse" || flight) startLoop();
    }
  });

  function draw() {
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    if (W < 40 || H < 40) return;
    const g = fitCanvas(canvas, W, H);
    const isLight = document.documentElement.dataset.theme === "light";

    // Resolve palette strictly from tokens
    const inkPrimary = parseRgbCss(cssColor("var(--ink-primary)"));
    const inkSecondary = cssColor("var(--ink-secondary)");
    const inkTertiary = cssColor("var(--ink-tertiary)");
    const inkFaint = cssColor("var(--ink-faint)");
    const lineAxis = cssColor("var(--line-axis)");
    const accent = cssColor("var(--accent)");
    const surfRaised = cssColor("var(--surface-raised)");
    const surfPaper = cssColor("var(--surface-paper)");

    // Sphere center shifts slightly left when drawer is open on desktop
    const drawerShift = drawerOpen && W > 880 ? -120 : 0;
    const cx = W * 0.5 + drawerShift;
    const cy = H * 0.52;
    const baseRadius = Math.min(W, H) * 0.42;
    const radiusPx = baseRadius * camZoom;
    const R = makeRotationMatrix(camLon, camLat);
    lastGeoSpec = { cx, cy, radiusPx, R };

    // Viewport angular cutoff for 3D bounding-cone culling
    const halfDiag = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
    const viewR = halfDiag / radiusPx;
    const thetaMaxRad = viewR < 0.99 ? Math.asin(viewR) : null;

    // 1. Sphere face + subtle monochrome rim gradient
    g.save();
    g.beginPath();
    g.arc(cx, cy, radiusPx, 0, Math.PI * 2);
    const sphereMid = cssColor("var(--fill-field)");
    const sphereCenter = isLight
      ? surfRaised
      : cssColor("color-mix(in srgb, var(--surface-raised) 82%, var(--ink-faint))");
    const sphereGrad = g.createRadialGradient(cx - radiusPx * 0.28, cy - radiusPx * 0.28, radiusPx * 0.08, cx, cy, radiusPx);
    sphereGrad.addColorStop(0, sphereCenter);
    sphereGrad.addColorStop(0.7, surfRaised);
    sphereGrad.addColorStop(1, isLight ? sphereMid : surfPaper);
    g.fillStyle = sphereGrad;
    g.fill();
    g.clip();

    // Update LOD pill
    const countyAlpha = smoothstep(1.9, 3.3, camZoom);
    const stateAlpha = smoothstep(1.18, 1.75, camZoom);
    const lodLabel = countyAlpha > 0.7 ? "Counties sharp" : countyAlpha > 0.05 ? "Counties sharpening" : camZoom > 1.7 ? "States + MetroCast dots" : "Global view";
    let lodTextNode = lodPill.querySelector(".gb-lod-txt");
    if (!lodTextNode) { lodTextNode = h("span", { class: "gb-lod-txt mono" }); lodPill.replaceChildren(...lodPill.querySelectorAll(":scope > .c-glass-layer"), lodTextNode); }
    lodTextNode.textContent = `z ${camZoom.toFixed(1)}× · ${lodLabel}`;

    if (!geo) {
      g.restore();
      drawRim(g, cx, cy, radiusPx, lineAxis, inkFaint);
      return;
    }

    // 2. Minimal graticule
    g.beginPath();
    for (const arc of [...geo.gratLat, ...geo.gratLon]) {
      for (const seg of clipPolylineToHemisphere(arc, R)) {
        g.moveTo(cx + seg[0] * radiusPx, cy - seg[1] * radiusPx);
        for (let i = 2; i < seg.length; i += 2) {
          g.lineTo(cx + seg[i] * radiusPx, cy - seg[i + 1] * radiusPx);
        }
      }
    }
    g.strokeStyle = lineAxis;
    g.globalAlpha = clamp(0.45 - (camZoom - 1) * 0.06, 0.15, 0.45);
    g.lineWidth = 0.65;
    g.stroke();
    g.globalAlpha = 1;

    // Helper for luminance / thermal fill styles
    const fillForMetric = (m, isHovered, isSelected) => {
      if (encoding === "halftone" || encoding === "pulse") {
        if (isSelected) return `rgba(${inkPrimary.join(",")}, 0.12)`;
        if (isHovered) return `rgba(${inkPrimary.join(",")}, 0.08)`;
        return isLight ? "rgba(0,0,0,0.03)" : "rgba(255,255,255,0.03)";
      }
      if (!m) {
        return isLight ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.04)";
      }
      if (encoding === "thermal") {
        return sequential(Math.sqrt(clamp(m.intensity, 0, 1)));
      }
      // Ultra-minimal B&W Luminance: higher burden = stronger contrast ink/luminance
      const t = clamp(0.06 + Math.pow(m.intensity, 1.15) * (isLight ? 0.58 : 0.46), 0.05, 0.68);
      return `rgba(${inkPrimary[0]}, ${inkPrimary[1]}, ${inkPrimary[2]}, ${t.toFixed(3)})`;
    };

    // 3. World Countries (110m)
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
      const cid = co.iso2 || co.id;
      hitCountries.push({ ...co, iso2: co.iso2, screenRings });
      const metric = cid === "US" && stateAlpha > 0.4 ? null : dataLookup("country", cid);
      const isHover = hoverItem?.kind === "country" && hoverItem.id === cid;
      const isSel = selectedPlaceId === cid;

      g.beginPath();
      for (const sr of screenRings) {
        g.moveTo(sr[0], sr[1]);
        for (let i = 2; i < sr.length; i += 2) g.lineTo(sr[i], sr[i + 1]);
        g.closePath();
      }
      g.fillStyle = fillForMetric(metric, isHover, isSel);
      g.fill();
      g.lineWidth = isSel ? 1.6 : isHover ? 1.25 : 0.7;
      g.strokeStyle = isSel ? accent : isHover ? cssColor("var(--ink-primary)") : inkFaint;
      g.stroke();
    }

    // 4. US States (sharpen when zooming into North America)
    hitStates = [];
    if (stateAlpha > 0.04) {
      g.save();
      g.globalAlpha = stateAlpha;
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
        const metric = dataLookup("state", st.fips);
        const isHover = hoverItem?.kind === "state" && hoverItem.id === st.fips;
        const isSel = selectedPlaceId === st.fips;

        g.beginPath();
        for (const sr of screenRings) {
          g.moveTo(sr[0], sr[1]);
          for (let i = 2; i < sr.length; i += 2) g.lineTo(sr[i], sr[i + 1]);
          g.closePath();
        }
        g.fillStyle = fillForMetric(metric, isHover, isSel);
        g.fill();
      }

      // 5. Real U.S. County Borders (deduplicated shared-arc mesh batched in 1 draw call!)
      if (countyAlpha > 0.03) {
        g.beginPath();
        for (const seg3 of geo.countyMesh) {
          if (!coneVisibleInViewport(seg3, R, thetaMaxRad)) continue;
          for (const run of clipPolylineToHemisphere(seg3.xyz, R)) {
            g.moveTo(cx + run[0] * radiusPx, cy - run[1] * radiusPx);
            for (let i = 2; i < run.length; i += 2) {
              g.lineTo(cx + run[i] * radiusPx, cy - run[i + 1] * radiusPx);
            }
          }
        }
        g.strokeStyle = inkFaint;
        g.globalAlpha = countyAlpha * (isLight ? 0.58 : 0.72);
        g.lineWidth = clamp(0.45 + countyAlpha * 0.35, 0.4, 0.85);
        g.stroke();
      }

      // Crisp state borders on top of counties
      g.beginPath();
      for (const seg3 of geo.stateMesh) {
        if (!coneVisibleInViewport(seg3, R, thetaMaxRad)) continue;
        for (const run of clipPolylineToHemisphere(seg3.xyz, R)) {
          g.moveTo(cx + run[0] * radiusPx, cy - run[1] * radiusPx);
          for (let i = 2; i < run.length; i += 2) {
            g.lineTo(cx + run[i] * radiusPx, cy - run[i + 1] * radiusPx);
          }
        }
      }
      g.globalAlpha = stateAlpha;
      g.strokeStyle = inkSecondary;
      g.lineWidth = clamp(0.75 + stateAlpha * 0.4, 0.7, 1.25);
      g.stroke();

      // Highlight hovered/selected state ring cleanly
      for (const st of hitStates) {
        if (hoverItem?.id === st.fips || selectedPlaceId === st.fips) {
          const isSel = selectedPlaceId === st.fips;
          g.beginPath();
          for (const sr of st.screenRings) {
            g.moveTo(sr[0], sr[1]);
            for (let i = 2; i < sr.length; i += 2) g.lineTo(sr[i], sr[i + 1]);
            g.closePath();
          }
          g.strokeStyle = isSel ? accent : cssColor("var(--ink-primary)");
          g.lineWidth = isSel ? 2.0 : 1.3;
          g.stroke();
        }
      }
      g.restore();
    }

    // 6. Halftone / Pulse State/Country Symbols when those encodings are active
    if (encoding === "halftone" || encoding === "pulse") {
      drawRegionalMarkers(g, cx, cy, radiusPx, R, stateAlpha, inkPrimary, accent, pulsePhase, isLight);
    }

    // 7. Cities & MetroCast HSA Dots + Zoom-Gated Non-Overlapping Labels
    hitCities = [];
    const cityAlpha = smoothstep(1.05, 1.85, camZoom);
    if (cityAlpha > 0.05) {
      const placedBoxes = [];
      const showLabels = camZoom >= 2.25;
      g.save();
      g.font = `500 11px ${getComputedStyle(document.documentElement).getPropertyValue("--font-sans")}`;
      g.textBaseline = "middle";

      for (const c of geo.cities) {
        const pz = R[6] * c.x + R[7] * c.y + R[8] * c.z;
        if (pz <= 0.02) continue;
        const px = R[0] * c.x + R[1] * c.y + R[2] * c.z;
        const py = R[3] * c.x + R[4] * c.y + R[5] * c.z;
        const sx = cx + px * radiusPx;
        const sy = cy - py * radiusPx;
        if (sx < -40 || sx > W + 40 || sy < -40 || sy > H + 40) continue;

        const m = dataLookup("city", c.id);
        hitCities.push({ ...c, sx, sy });
        const isSel = selectedPlaceId === c.id;
        const isHov = hoverItem?.kind === "city" && hoverItem.id === c.id;
        const dotR = encoding === "halftone" && m ? clamp(3.5 + Math.sqrt(m.intensity) * 7.5, 3, 12) : isSel ? 5.2 : 3.4;

        g.globalAlpha = cityAlpha;
        // Pulse rings around accelerating cities in Pulse mode
        if (encoding === "pulse" && m && m.growthPct > 6) {
          const rRing = dotR + 3 + pulsePhase * 15;
          g.beginPath();
          g.arc(sx, sy, rRing, 0, Math.PI * 2);
          g.strokeStyle = isSel ? accent : `rgba(${inkPrimary[0]}, ${inkPrimary[1]}, ${inkPrimary[2]}, ${(1 - pulsePhase) * 0.65})`;
          g.lineWidth = 1.1;
          g.stroke();
        }

        // Crisp monochrome / accent city dot with subtle outline ring
        g.beginPath();
        g.arc(sx, sy, dotR + 2, 0, Math.PI * 2);
        g.fillStyle = surfPaper;
        g.fill();

        g.beginPath();
        g.arc(sx, sy, dotR, 0, Math.PI * 2);
        g.fillStyle = isSel ? accent : isHov ? cssColor("var(--ink-primary)") : encoding === "thermal" && m ? sequential(Math.sqrt(m.intensity)) : cssColor("var(--ink-primary)");
        g.fill();

        if (showLabels || isSel || isHov) {
          const label = c.abbr;
          const tw = g.measureText(label).width;
          const bx = sx + dotR + 6;
          const by = sy - 7;
          const box = { x: bx - 2, y: by, w: tw + 8, h: 15 };
          const overlaps = !isSel && !isHov && placedBoxes.some((b) =>
            !(box.x + box.w < b.x || box.x > b.x + b.w || box.y + box.h < b.y || box.y > b.y + b.h));
          if (!overlaps) {
            placedBoxes.push(box);
            g.fillStyle = isSel ? accent : cssColor("var(--ink-primary)");
            g.fillText(label, bx, sy);
          }
        }
      }
      g.restore();
    }

    g.restore(); // End sphere clip
    drawRim(g, cx, cy, radiusPx, lineAxis, inkFaint);
  }

  function drawRim(g, cx, cy, r, lineAxis, inkFaint) {
    g.save();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.strokeStyle = lineAxis;
    g.lineWidth = 1.25;
    g.stroke();

    g.beginPath();
    g.arc(cx, cy, r + 1.5, 0, Math.PI * 2);
    g.strokeStyle = inkFaint;
    g.globalAlpha = 0.28;
    g.lineWidth = 1;
    g.stroke();
    g.restore();
  }

  function drawRegionalMarkers(g, cx, cy, radiusPx, R, stateAlpha, inkPrimary, accent, phase, isLight) {
    const entries = stateAlpha > 0.35
      ? Object.values(US_STATE_META).filter((x) => x.id !== "US")
      : Object.values(EU_META).filter((x) => !x.parent_id).concat([US_STATE_META.US]);

    for (const loc of entries) {
      if (loc.lat == null || loc.lon == null) continue;
      const [wx, wy, wz] = lonLatToXYZ(loc.lon, loc.lat);
      const pz = R[6] * wx + R[7] * wy + R[8] * wz;
      if (pz <= 0.1) continue;
      const px = R[0] * wx + R[1] * wy + R[2] * wz;
      const py = R[3] * wx + R[4] * wy + R[5] * wz;
      const sx = cx + px * radiusPx;
      const sy = cy - py * radiusPx;
      const m = dataLookup(loc.level === "state" ? "state" : "country", loc.id);
      if (!m) continue;

      if (encoding === "halftone") {
        const rad = clamp(2.5 + Math.sqrt(m.intensity) * (stateAlpha > 0.35 ? 11 : 14), 2, 16);
        g.beginPath();
        g.arc(sx, sy, rad, 0, Math.PI * 2);
        g.fillStyle = `rgba(${inkPrimary[0]}, ${inkPrimary[1]}, ${inkPrimary[2]}, ${isLight ? 0.22 : 0.26})`;
        g.fill();
        g.strokeStyle = `rgba(${inkPrimary[0]}, ${inkPrimary[1]}, ${inkPrimary[2]}, 0.55)`;
        g.lineWidth = 0.9;
        g.stroke();
      } else if (encoding === "pulse") {
        const base = 4 + m.intensity * 8;
        const grow = m.growthPct > 0 ? phase * 12 : 0;
        g.beginPath();
        g.arc(sx, sy, base + grow, 0, Math.PI * 2);
        g.strokeStyle = m.growthPct > 10 ? accent : `rgba(${inkPrimary[0]}, ${inkPrimary[1]}, ${inkPrimary[2]}, ${(1 - phase) * 0.55})`;
        g.lineWidth = 1.25;
        g.stroke();
        g.beginPath();
        g.arc(sx, sy, 2.5, 0, Math.PI * 2);
        g.fillStyle = m.growthPct > 10 ? accent : `rgb(${inkPrimary.join(",")})`;
        g.fill();
      }
    }
  }

  // ---------------- Lifecycle & Theme / Data Wiring ----------------
  const ro = new ResizeObserver(() => scheduleDraw());
  ro.observe(wrap);

  offs.push(ctx.onThemeChange(() => {
    resetColors();
    renderDrawer();
    scheduleDraw();
  }));

  async function refreshDataMode() {
    if (ctx.state.dataMode === "live") {
      const info = await probeLiveBackend();
      liveSpatial = await fetchLiveSpatial(info, 1);
    } else {
      liveSpatial = null;
    }
    renderDrawer();
    scheduleDraw();
  }
  offs.push(ctx.onModeChange(refreshDataMode));
  offs.push(ctx.onPrimaryChange(() => renderDrawer()));

  loadGlobeGeometry().then((loaded) => {
    if (destroyed) return;
    geo = loaded;
    renderDrawer();
    scheduleDraw();
    if (ctx.state.dataMode === "live") refreshDataMode();
  }).catch((err) => {
    if (!destroyed) {
      let t = lodPill.querySelector(".gb-lod-txt");
      if (!t) { t = h("span", { class: "gb-lod-txt" }); lodPill.append(t); }
      t.textContent = `Geometry error: ${err?.message || err}`;
    }
  });

  renderDrawer();
  scheduleDraw();

  return {
    focusPlace,
    resize: scheduleDraw,
    destroy() {
      destroyed = true;
      if (loopRaf) cancelAnimationFrame(loopRaf);
      ro.disconnect();
      offs.forEach((off) => off());
    },
  };
}
