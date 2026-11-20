/* Design Lab shell: floating liquid-glass chrome matching /next/ Shell.js,
 * hidden location pill on Globe, context-aware US / Europe / MetroCast Location Picker,
 * unopinionated recents, any-scope default, and shared cached U.S. + 95-HSA geometry loader. */
import { h, storage, clearTokens, onThemeChange } from "../lib/dom.js";
import { Segmented, pill, icon } from "../ui/controls.js";
import { glass } from "../ui/glass.js";
import { openPopover } from "../ui/floating.js";
import { resetColors } from "../sections/shared.js";
import { TILES, matchLocations } from "../features/LocationPicker.js";
import {
  EU_META,
  EU_TILES_PROPORTIONED,
  US_STATE_META,
  lookupPlaceMeta,
} from "../geo/eu_tiles.js";
import {
  arcsToUnitSphere,
  buildMetroOverlays,
  decodeArcs,
  extractLonLatFeatures,
  extractMesh,
  extractPolygons,
} from "../geo/topo.js";
import { HUB_SCOPES, REGION_SCOPES } from "./fixtures.js";

import * as GlobeView from "./globe.js";
import * as EuMapView from "./eu_map.js";
import * as PmfView from "./pmf.js";
import * as TrajView from "./trajectories.js";
import * as BriefingView from "./briefing.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const TABS = [
  { value: "globe", label: "Globe", mod: GlobeView },
  { value: "eu-map", label: "EU Map", mod: EuMapView },
  { value: "pmf", label: "PMF", mod: PmfView },
  { value: "trajectories", label: "Trajectories", mod: TrajView },
  { value: "briefing", label: "Briefing", mod: BriefingView },
];

const storedDefault = storage.get("viz.lab.defaultScope", null);
const storedRecents = storage.get("viz.lab.recents", []);
const initDefault = storedDefault && storedDefault.id
  ? storedDefault
  : { kind: "country", id: "US", label: "United States" };

const state = {
  tab: "globe",
  defaultScope: initDefault,
  activeScope: { ...initDefault },
  recents: Array.isArray(storedRecents) ? storedRecents.slice(0, 6) : [],
  briefingPlace: (initDefault.focusPlace || (initDefault.kind !== "hub" && initDefault.kind !== "region" ? initDefault.id : null)) || "US",
  hsas: null,
  usGeo: null,
};

let hsasPromise = null;
function loadHsas() {
  if (state.hsas) return Promise.resolve(state.hsas);
  if (!hsasPromise) {
    const url = new URL("../geo/metrocast_hsas.json", import.meta.url).href;
    hsasPromise = fetch(url)
      .then((r) => r.json())
      .then((data) => {
        state.hsas = data;
        return data;
      });
  }
  return hsasPromise;
}

let usGeoPromise = null;
function loadUsGeo() {
  if (state.usGeo) return Promise.resolve(state.usGeo);
  if (!usGeoPromise) {
    const usUrl = new URL("../geo/us-counties-10m.json", import.meta.url).href;
    usGeoPromise = Promise.all([
      fetch(usUrl).then((r) => r.json()),
      loadHsas(),
    ]).then(([usTopo, hsasData]) => {
      const decodedUsArcs = decodeArcs(usTopo);
      const usArcs = arcsToUnitSphere(decodedUsArcs);
      const states = extractPolygons(usTopo, "states", usArcs).map((f) => ({
        ...f,
        fips: String(f.id).padStart(2, "0"),
      }));
      const stateMesh = extractMesh(usTopo, "states", usArcs);
      const rawState2d = extractLonLatFeatures(usTopo, "states", decodedUsArcs);
      const stateLonLatByFips = new Map();
      for (const [k, v] of rawState2d.entries()) stateLonLatByFips.set(String(k).padStart(2, "0"), v);
      const { metroMesh, metroFeatures, coveredStates } = buildMetroOverlays(usTopo, usArcs, hsasData, decodedUsArcs);
      state.usGeo = { states, stateMesh, stateLonLatByFips, metroMesh, metroFeatures, coveredStates, hsasData };
      return state.usGeo;
    });
  }
  return usGeoPromise;
}

const listeners = {
  theme: new Set(),
  recents: new Set(),
  defaultScope: new Set(),
};

let activeInstance = null;
let segControl = null;

function tabFromHash() {
  const hash = location.hash.replace(/^#/, "").trim();
  return TABS.some((t) => t.value === hash) ? hash : "globe";
}

function setHash(tab) {
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
}

function resolvePlace(id) {
  if (!id) return null;
  const hsa = state.hsas?.hsas?.find((x) => x.id === id);
  if (hsa) return hsa;
  return lookupPlaceMeta(id);
}

function scopeFromIdOrMeta(itemOrId) {
  if (!itemOrId) return null;
  if (typeof itemOrId === "object" && itemOrId.id) {
    return {
      kind: itemOrId.stateFips ? "metro" : (itemOrId.kind || itemOrId.level || "place"),
      id: itemOrId.id,
      label: itemOrId.label || itemOrId.name || itemOrId.id,
      stateFips: itemOrId.stateFips || itemOrId.parentId || null,
      focusPlace: itemOrId.focusPlace || null,
      lon: itemOrId.lon,
      lat: itemOrId.lat,
      zoom: itemOrId.zoom,
    };
  }
  const hubOrReg = HUB_SCOPES.find((x) => x.id === itemOrId) || REGION_SCOPES.find((x) => x.id === itemOrId);
  if (hubOrReg) return { kind: hubOrReg.kind, id: hubOrReg.id, label: hubOrReg.name, focusPlace: hubOrReg.focusPlace || null, lon: hubOrReg.lon, lat: hubOrReg.lat, zoom: hubOrReg.zoom };
  const m = resolvePlace(itemOrId);
  if (!m) return { kind: "place", id: String(itemOrId), label: String(itemOrId) };
  return {
    kind: m.stateFips ? "metro" : (m.level || "place"),
    id: m.id,
    label: m.name || m.id,
    stateFips: m.stateFips || m.parentId || null,
    lon: m.lon,
    lat: m.lat,
  };
}

function inferPickerContext(scope) {
  const s = scope || state.activeScope || state.defaultScope;
  const id = s?.id || "US";
  if (id === "hub-respicast" || id === "reg-eu" || EU_META[id]) {
    return { region: "eu", stateFips: null };
  }
  if (id === "hub-metrocast") {
    return { region: "metrocast", stateFips: null };
  }
  const meta = resolvePlace(id);
  const fips = s?.stateFips || meta?.stateFips || (meta?.level === "hsa" ? meta?.parentId : null);
  if (s?.kind === "metro" || fips) {
    return { region: "metrocast", stateFips: fips || null };
  }
  return { region: "us", stateFips: null };
}

const ctx = {
  state,
  loadHsas,
  loadUsGeo,
  resolvePlace,
  onThemeChange(fn) {
    listeners.theme.add(fn);
    return () => listeners.theme.delete(fn);
  },
  onRecentsChange(fn) {
    listeners.recents.add(fn);
    return () => listeners.recents.delete(fn);
  },
  onDefaultChange(fn) {
    listeners.defaultScope.add(fn);
    return () => listeners.defaultScope.delete(fn);
  },
  recordRecent(item) {
    if (!item?.id) return;
    const entry = {
      id: item.id,
      abbr: item.abbr || item.name || item.id,
      name: item.name || item.id,
      kind: item.kind || "place",
    };
    state.recents = [entry, ...state.recents.filter((r) => r.id !== entry.id)].slice(0, 6);
    storage.set("viz.lab.recents", state.recents);
    listeners.recents.forEach((fn) => fn(state.recents));
  },
  clearRecents() {
    state.recents = [];
    storage.set("viz.lab.recents", []);
    listeners.recents.forEach((fn) => fn(state.recents));
  },
  setActiveScope(scopeOrId) {
    const s = scopeFromIdOrMeta(scopeOrId);
    if (!s?.id) return;
    state.activeScope = s;
    if (s.kind !== "hub" && s.kind !== "region") state.briefingPlace = s.id;
    else if (s.focusPlace) state.briefingPlace = s.focusPlace;
    updateLocPill();
  },
  setDefaultScope(scope) {
    const s = scopeFromIdOrMeta(scope);
    if (!s?.id) return;
    state.defaultScope = s;
    state.activeScope = { ...s };
    if (s.kind !== "hub" && s.kind !== "region") state.briefingPlace = s.id;
    else if (s.focusPlace) state.briefingPlace = s.focusPlace;
    storage.set("viz.lab.defaultScope", state.defaultScope);
    updateLocPill();
    listeners.defaultScope.forEach((fn) => fn(state.defaultScope));
  },
  openBriefing(placeId) {
    const meta = resolvePlace(placeId);
    if (meta) {
      ctx.recordRecent({ id: meta.id, abbr: meta.abbr, name: meta.name, kind: meta.stateFips ? "metro" : (meta.level || "place") });
      ctx.setActiveScope(meta);
    } else {
      ctx.setActiveScope(placeId || "US");
    }
    state.briefingPlace = placeId || "US";
    switchTab("briefing");
    activeInstance?.setPlace?.(state.briefingPlace);
  },
  focusOnGlobe(placeId) {
    if (state.tab !== "globe") switchTab("globe");
    activeInstance?.focusScope?.(placeId);
  },
};

/* ---------- Fixed liquid glass bubbles matching /next/ Shell.js ---------- */
const stage = document.getElementById("lab-stage");
const zone = (z) => h("div", { class: "c-zone", "data-zone": z });
const tl = zone("tl");
const tc = zone("tc");
const tr = zone("tr");
const fixedChrome = h("div", { class: "c-chrome app-fixed lab-chrome" }, tl, tc, tr);
document.body.append(fixedChrome);

const backPill = h("a", { class: "c-pill sm lab-link-pill", href: "/next/", title: "Return to /next/" },
  h("span", null, "← /next/"));

const locPill = pill({
  label: state.activeScope.label || "United States",
  size: "sm",
  chevron: true,
  ariaLabel: "Location or scope",
  onClick: () => openLabLocationPopover(),
});

const tabsSegWrap = h("div");
const themeBtn = pill({
  icon: icon.theme,
  size: "sm",
  ariaLabel: "Light or dark",
  onClick: () => toggleTheme(),
});

tl.append(backPill, locPill);
tc.append(tabsSegWrap);
tr.append(themeBtn);

segControl = new Segmented(tabsSegWrap, {
  items: TABS.map(({ value, label }) => ({ value, label })),
  value: tabFromHash(),
  label: "Views",
  onChange: (v) => switchTab(v),
});

const gBack = glass(backPill);
const gLoc = glass(locPill);
const gSeg = glass(tabsSegWrap);
const gTheme = glass(themeBtn);
document.fonts?.ready?.then(() => {
  gBack.update();
  gLoc.update();
  gSeg.update();
  gTheme.update();
});

function updateLocPill() {
  const lbl = locPill.querySelector(".c-pill-label");
  if (lbl) lbl.textContent = state.activeScope.label || state.activeScope.id;
  if (!locPill.hidden) gLoc.update();
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  storage.set("viz.theme", next);
  clearTokens();
  resetColors();
  listeners.theme.forEach((fn) => fn(next));
}

onThemeChange((next) => {
  clearTokens();
  resetColors();
  listeners.theme.forEach((fn) => fn(next));
});

function buildSearchCatalog() {
  const hsas = state.hsas?.hsas || [];
  return [
    ...HUB_SCOPES.map((x) => ({ ...x, region: x.region || "Hub" })),
    ...REGION_SCOPES.map((x) => ({ ...x, region: "Region" })),
    { kind: "country", id: "US", abbr: "US", name: "United States", region: "North America", lat: 39.83, lon: -98.58, zoom: 2.15 },
    ...Object.values(US_STATE_META).filter((x) => x.id !== "US").map((x) => ({ ...x, kind: "state", region: "United States" })),
    ...Object.values(EU_META).filter((x) => !x.parent_id).map((x) => ({ ...x, kind: "country", region: "Europe" })),
    ...hsas.map((m) => ({ ...m, kind: "metro", region: `${m.stateAbb} · Flu MetroCast` })),
  ];
}

function renderHsaStateSvg(usGeo, stateFips, activeId, onPick, onHover) {
  const hsas = usGeo.metroFeatures.filter((m) => m.stateFips === stateFips);
  const bgRings = usGeo.stateLonLatByFips.get(stateFips) || [];
  const allRings = [...bgRings, ...hsas.flatMap((m) => m.lonLatRings || [])];
  if (!allRings.length) return null;

  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const r of allRings) {
    for (let i = 0; i < r.length; i += 2) {
      if (r[i] < minLon) minLon = r[i];
      if (r[i] > maxLon) maxLon = r[i];
      if (r[i + 1] < minLat) minLat = r[i + 1];
      if (r[i + 1] > maxLat) maxLat = r[i + 1];
    }
  }

  const cosLat = Math.max(0.25, Math.cos(((minLat + maxLat) * 0.5) * (Math.PI / 180)));
  const spanX = Math.max(0.05, (maxLon - minLon) * cosLat);
  const spanY = Math.max(0.05, maxLat - minLat);
  const W = 360, H = 196, pad = 12;
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const ox = (W - spanX * scale) * 0.5;
  const oy = (H - spanY * scale) * 0.5;
  const ringsToPath = (rings) => rings.map((r) => {
    let d = "";
    for (let i = 0; i < r.length; i += 2) {
      const px = ox + (r[i] - minLon) * cosLat * scale;
      const py = oy + (maxLat - r[i + 1]) * scale;
      d += `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`;
    }
    return `${d}Z`;
  }).join(" ");

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "lp-hsa-svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${US_STATE_META[stateFips]?.name || stateFips} MetroCast HSAs`);

  if (bgRings.length) {
    const bg = document.createElementNS(SVG_NS, "path");
    bg.setAttribute("class", "lp-hsa-state-bg");
    bg.setAttribute("fill-rule", "evenodd");
    bg.setAttribute("d", ringsToPath(bgRings));
    svg.append(bg);
  }

  for (const m of hsas) {
    if (!m.lonLatRings?.length) continue;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", m.id === activeId ? "lp-hsa-poly is-on" : "lp-hsa-poly");
    path.setAttribute("fill-rule", "evenodd");
    path.setAttribute("d", ringsToPath(m.lonLatRings));
    path.setAttribute("aria-label", m.name);
    const tip = document.createElementNS(SVG_NS, "title");
    tip.textContent = m.name;
    path.append(tip);
    path.addEventListener("pointerenter", () => onHover?.(m.name));
    path.addEventListener("click", () => onPick(m));
    svg.append(path);
  }
  return svg;
}

function openLabLocationPopover() {
  const byAbbr = new Map(Object.values(US_STATE_META).filter((x) => x.id !== "US").map((x) => [x.abbr, x]));

  openPopover(locPill, {
    morph: true,
    width: 420,
    className: "lp-panel",
    content(body, layer) {
      const catalog = buildSearchCatalog();
      const coveredStates = new Set(state.hsas?.states || state.usGeo?.coveredStates || []);
      let ctxState = inferPickerContext(state.activeScope);

      const pick = (item) => {
        ctx.setActiveScope(item);
        if (item.kind !== "hub" && item.kind !== "region") {
          ctx.recordRecent({ id: item.id, abbr: item.abbr || item.name, name: item.name, kind: item.kind });
        }
        const targetId = item.focusPlace || item.id;
        layer.close(true);
        if (state.tab === "globe") activeInstance?.focusScope?.(item);
        else if (state.tab === "eu-map") {
          if (EU_META[targetId] || targetId.startsWith("GB-")) activeInstance?.setPlace?.(targetId);
          else if (item.kind === "country" || item.kind === "state" || item.kind === "metro") ctx.openBriefing(targetId);
        } else {
          activeInstance?.setPlace?.(targetId);
        }
      };

      const search = h("input", {
        type: "search",
        placeholder: `Search ${catalog.length} hubs, regions & places`,
        "aria-label": "Search locations",
        autocomplete: "off",
        spellcheck: "false",
      });
      const resultsBox = h("div", { class: "lp-results", hidden: true });
      const mapBox = h("div", { class: "lp-map" });

      const globeJump = h("div", { class: "lp-globe-foot" },
        h("button", {
          type: "button",
          class: "c-row",
          onclick: () => {
            layer.close(true);
            ctx.focusOnGlobe(state.activeScope.focusPlace || state.activeScope.id);
          },
        },
        h("span", { class: "c-row-text" },
          h("span", { class: "c-row-label" }, "Globe"),
          h("span", { class: "c-row-sub" }, "Open interactive sphere"),
        ),
        h("span", { class: "c-row-sub" }, "→")));

      let topHit = null;
      const drawSearch = () => {
        const q = search.value.trim();
        if (!q) {
          topHit = null;
          resultsBox.hidden = true;
          mapBox.hidden = false;
          renderContextualMap();
          return;
        }
        const hits = matchLocations(catalog, q).slice(0, 10);
        topHit = hits[0] || null;
        mapBox.hidden = true;
        resultsBox.hidden = false;
        if (!hits.length) {
          resultsBox.replaceChildren(h("p", { class: "pk-empty" }, `No match for “${q}”`));
          return;
        }
        resultsBox.replaceChildren(...hits.map((item, idx) =>
          h("button", {
            type: "button",
            class: ["c-row two", idx === 0 && "on"],
            onclick: () => pick(item),
          },
          h("span", { class: "c-row-text" },
            h("span", { class: "c-row-label" }, item.name),
            h("span", { class: "c-row-sub" }, item.region || item.kind),
          ),
          h("span", { class: "c-row-sub mono" }, item.abbr || item.id))));
      };

      function renderContextualMap() {
        const curId = state.activeScope?.id;
        if (ctxState.region === "eu") {
          const euTiles = Object.entries(EU_TILES_PROPORTIONED).map(([iso, [col, row, cs = 1, rs = 1]]) => {
            const meta = EU_META[iso];
            if (!meta) return null;
            return h("button", {
              type: "button",
              class: ["c-tile", meta.id === curId && "on"],
              title: meta.name,
              style: {
                gridColumn: `${col} / span ${cs}`,
                gridRow: `${row} / span ${rs}`,
              },
              onclick: () => pick({ ...meta, kind: "country", zoom: 3.1 }),
            }, meta.abbr);
          }).filter(Boolean);

          mapBox.replaceChildren(
            h("button", {
              type: "button",
              class: ["c-tile lp-us", (curId === "hub-respicast" || curId === "reg-eu") && "on"],
              onclick: () => pick(HUB_SCOPES.find((x) => x.id === "hub-respicast")),
            }, "Europe · RespiCast"),
            h("div", { class: "lp-eu-tiles" }, ...euTiles),
          );
          return;
        }

        if (ctxState.region === "metrocast") {
          if (!ctxState.stateFips) {
            const mcTiles = Object.entries(TILES).map(([abbr, [x, y]]) => {
              const meta = byAbbr.get(abbr);
              if (!meta) return null;
              const isAvail = coveredStates.has(meta.id);
              return h("button", {
                type: "button",
                class: ["c-tile", isAvail ? "is-mc-avail" : "is-muted", meta.id === curId && "on"],
                disabled: !isAvail,
                title: isAvail ? `${meta.name} MetroCast HSAs` : `${meta.name} (no MetroCast HSAs)`,
                style: { gridColumn: String(x + 1), gridRow: String(y + 1) },
                onclick: () => {
                  if (!isAvail) return;
                  ctxState = { region: "metrocast", stateFips: meta.id };
                  renderContextualMap();
                },
              }, abbr);
            }).filter(Boolean);

            mapBox.replaceChildren(
              h("div", { class: "lp-ctx-bar" },
                h("span", { class: "lp-ctx-title" }, `Flu MetroCast · ${coveredStates.size} states`),
                h("button", {
                  type: "button",
                  class: "c-link",
                  onclick: () => { ctxState = { region: "us", stateFips: null }; renderContextualMap(); },
                }, "All states")),
              h("div", { class: "c-tile-grid lp-tiles" }, ...mcTiles),
            );
            return;
          }

          const stateMeta = US_STATE_META[ctxState.stateFips];
          const stateHsas = (state.hsas?.hsas || state.usGeo?.hsasData?.hsas || []).filter((m) => m.stateFips === ctxState.stateFips);
          const activeHsa = stateHsas.find((m) => m.id === curId);
          const caption = h("p", { class: "lp-hsa-cap" }, activeHsa ? activeHsa.name : `${stateHsas.length} MetroCast HSAs in ${stateMeta?.name || ctxState.stateFips}`);
          const svgWrap = h("div", { class: "lp-hsa-wrap" });

          mapBox.replaceChildren(
            h("div", { class: "lp-ctx-bar" },
              h("button", {
                type: "button",
                class: "c-link",
                onclick: () => { ctxState = { region: "metrocast", stateFips: null }; renderContextualMap(); },
              }, "← 15 states"),
              h("span", { class: "lp-ctx-title" }, stateMeta?.name || ctxState.stateFips),
              ...[stateMeta ? h("button", {
                type: "button",
                class: "c-link",
                onclick: () => pick({ ...stateMeta, kind: "state" }),
              }, "Whole state") : null].filter(Boolean)),
            svgWrap,
            caption,
            h("div", { class: "lp-chips", style: { padding: "0" } },
              ...stateHsas.map((m) =>
                h("button", {
                  type: "button",
                  class: ["c-chip", m.id === curId && "on"],
                  onclick: () => pick({ ...m, kind: "metro" }),
                }, m.abbr))),
          );

          const populateSvg = (usGeo) => {
            if (!svgWrap.isConnected) return;
            const svg = renderHsaStateSvg(usGeo, ctxState.stateFips, curId, (m) => pick({ ...m, kind: "metro" }), (name) => {
              caption.textContent = name;
            });
            svgWrap.replaceChildren(svg || h("p", { class: "pk-empty" }, "No polygon outline available"));
          };
          if (state.usGeo) populateSvg(state.usGeo);
          else {
            svgWrap.replaceChildren(h("p", { class: "pk-empty" }, "Loading HSA boundaries…"));
            loadUsGeo().then(populateSvg).catch(() => {});
          }
          return;
        }

        // Strict US map (ZERO European buttons!)
        const usTiles = Object.entries(TILES).map(([abbr, [x, y]]) => {
          const meta = byAbbr.get(abbr);
          if (!meta) return null;
          return h("button", {
            type: "button",
            class: ["c-tile", meta.id === curId && "on"],
            title: meta.name,
            style: { gridColumn: String(x + 1), gridRow: String(y + 1) },
            onclick: () => pick({ ...meta, kind: "state" }),
          }, abbr);
        }).filter(Boolean);

        const activeStateMeta = curId && US_STATE_META[curId] && curId !== "US" ? US_STATE_META[curId] : null;
        const canDrillMetro = activeStateMeta && coveredStates.has(activeStateMeta.id);

        mapBox.replaceChildren(...[
          h("button", {
            type: "button",
            class: ["c-tile lp-us", curId === "US" && "on"],
            onclick: () => pick({ ...US_STATE_META.US, kind: "country", zoom: 2.15 }),
          }, "United States"),
          h("div", { class: "c-tile-grid lp-tiles" }, ...usTiles),
          canDrillMetro ? h("button", {
            type: "button",
            class: "c-link lp-sub-link",
            onclick: () => { ctxState = { region: "metrocast", stateFips: activeStateMeta.id }; renderContextualMap(); },
          }, `${activeStateMeta.name} MetroCast HSAs →`) : null,
        ].filter(Boolean));
      }

      search.addEventListener("input", drawSearch);
      search.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && topHit) {
          e.preventDefault();
          pick(topHit);
        }
      });

      body.append(
        h("label", { class: "c-search", html: icon.search }, search),
        resultsBox,
        mapBox,
        globeJump,
      );
      drawSearch();
      queueMicrotask(() => search.focus({ preventScroll: true }));
    },
  });
}

function syncChromeForTab(tabVal) {
  const isGlobe = tabVal === "globe";
  locPill.hidden = isGlobe;
  if (tabVal === "eu-map") {
    const id = state.activeScope?.id;
    if (!EU_META[id] && id !== "hub-respicast" && id !== "reg-eu") {
      ctx.setActiveScope(EU_META.DE);
    }
  }
  updateLocPill();
}

function switchTab(tabVal) {
  const spec = TABS.find((t) => t.value === tabVal) || TABS[0];
  if (state.tab === spec.value && activeInstance) return;
  activeInstance?.destroy?.();
  activeInstance = null;
  state.tab = spec.value;
  setHash(spec.value);
  if (segControl.value !== spec.value) segControl.set(spec.value, false);
  syncChromeForTab(spec.value);
  activeInstance = spec.mod.mount(stage, ctx);
}

window.addEventListener("hashchange", () => {
  const next = tabFromHash();
  if (next !== state.tab) switchTab(next);
});

loadHsas().catch(() => {});
setTimeout(() => { loadUsGeo().catch(() => {}); }, 80);

const initTab = tabFromHash();
state.tab = initTab;
segControl.set(initTab, false, true);
syncChromeForTab(initTab);
activeInstance = (TABS.find((t) => t.value === initTab) || TABS[0]).mod.mount(stage, ctx);
