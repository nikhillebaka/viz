/* Design Lab shell coordinator: navigation tabs, Location Pill w/ Globe entry button,
 * Showcase / Live API switch, Dark/Light theme toggle, and cross-tab workflows. */
import { h, storage, clearTokens, onThemeChange } from "../lib/dom.js";
import { Segmented, pill, icon } from "../ui/controls.js";
import { glass } from "../ui/glass.js";
import { openPopover } from "../ui/floating.js";
import { resetColors } from "../sections/shared.js";
import { TILES } from "../features/LocationPicker.js";
import { EU_META, METROCAST_CITIES, US_STATE_META, lookupPlaceMeta } from "../geo/eu_tiles.js";
import { probeLiveBackend } from "./liveBridge.js";

import * as GlobeView from "./globe.js";
import * as EuMapView from "./eu_map.js";
import * as PmfView from "./pmf.js";
import * as TrajView from "./trajectories.js";
import * as BriefingView from "./briefing.js";

const TABS = [
  { value: "globe", label: "Globe", mod: GlobeView },
  { value: "eu-map", label: "EU Map", mod: EuMapView },
  { value: "pmf", label: "PMF", mod: PmfView },
  { value: "trajectories", label: "Trajectories", mod: TrajView },
  { value: "briefing", label: "Briefing", mod: BriefingView },
];

const state = {
  tab: "globe",
  dataMode: "showcase", // "showcase" | "live"
  primaryLocation: storage.get("viz.lab.primary", "25") || "25",
  briefingPlace: "US",
  recentPlaces: storage.get("viz.lab.recent", ["US", "provo", "DE"]) || ["US", "provo", "DE"],
};

const listeners = {
  theme: new Set(),
  mode: new Set(),
  primary: new Set(),
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

const ctx = {
  state,
  onThemeChange(fn) {
    listeners.theme.add(fn);
    return () => listeners.theme.delete(fn);
  },
  onModeChange(fn) {
    listeners.mode.add(fn);
    return () => listeners.mode.delete(fn);
  },
  onPrimaryChange(fn) {
    listeners.primary.add(fn);
    return () => listeners.primary.delete(fn);
  },
  setPrimaryLocation(id) {
    if (!id) return;
    state.recentPlaces = [...new Set([id, state.primaryLocation, ...state.recentPlaces].filter(Boolean))].slice(0, 5);
    state.primaryLocation = id;
    storage.set("viz.lab.primary", id);
    storage.set("viz.lab.recent", state.recentPlaces);
    updateLocPill();
    listeners.primary.forEach((fn) => fn(id));
  },
  openBriefing(placeId) {
    state.briefingPlace = placeId || state.primaryLocation || "US";
    switchTab("briefing");
    activeInstance?.setPlace?.(state.briefingPlace);
  },
  focusOnGlobe(placeId) {
    if (state.tab !== "globe") switchTab("globe");
    activeInstance?.focusPlace?.(placeId);
  },
};

const tabsHost = document.getElementById("lab-tabs");
const actionsHost = document.getElementById("lab-actions");
const liveBar = document.getElementById("lab-live-bar");
const stage = document.getElementById("lab-stage");

const locPill = pill({
  label: lookupPlaceMeta(state.primaryLocation)?.name || "Massachusetts",
  size: "sm",
  chevron: true,
  ariaLabel: "Open Location Pill with Globe button",
  onClick: () => openLabLocationPopover(),
});

const modePill = pill({
  label: "Showcase data",
  size: "sm",
  pressed: false,
  ariaLabel: "Toggle Showcase vs Live API data",
  onClick: () => toggleDataMode(),
});

const themeBtn = pill({
  icon: icon.theme,
  size: "sm",
  ariaLabel: "Toggle light or dark theme",
  onClick: () => toggleTheme(),
});

actionsHost.append(locPill, modePill, themeBtn);

segControl = new Segmented(tabsHost, {
  items: TABS.map(({ value, label }) => ({ value, label })),
  value: tabFromHash(),
  label: "Prototype screen selector",
  onChange: (v) => switchTab(v),
});

glass(tabsHost);
glass(locPill);
glass(modePill);
glass(themeBtn);

function updateLocPill() {
  const lbl = locPill.querySelector(".c-pill-label");
  if (lbl) lbl.textContent = lookupPlaceMeta(state.primaryLocation)?.name || state.primaryLocation;
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

async function toggleDataMode() {
  state.dataMode = state.dataMode === "showcase" ? "live" : "showcase";
  const isLive = state.dataMode === "live";
  modePill.setAttribute("aria-pressed", String(isLive));
  const lbl = modePill.querySelector(".c-pill-label");
  if (lbl) lbl.textContent = isLive ? "Live API" : "Showcase data";

  if (isLive) {
    liveBar.hidden = false;
    liveBar.replaceChildren(h("span", { class: "lab-live-dot is-warn" }), h("span", null, "Probing /api/next/manifest…"));
    const info = await probeLiveBackend();
    if (info.ok) {
      const caps = [
        `${info.models.length} models`,
        `${info.locations.length} locations`,
        info.pmfTarget ? `PMF: ${info.pmfTarget.short}` : "no PMF target (showcase fallback)",
        info.sampleModels.length ? `${info.sampleModels.length} sample models` : "0 raw sample models (showcase fallback)",
      ].join(" · ");
      liveBar.replaceChildren(
        h("span", { class: "lab-live-dot" }),
        h("strong", null, `Connected to ${info.hubName}`),
        h("span", null, `(${caps})`),
      );
    } else {
      liveBar.replaceChildren(
        h("span", { class: "lab-live-dot is-err" }),
        h("span", null, `Server unreachable (${info.error}) — showing Showcase data`),
      );
    }
  } else {
    liveBar.hidden = true;
  }
  listeners.mode.forEach((fn) => fn(state.dataMode));
}

function openLabLocationPopover() {
  const allLocs = [
    US_STATE_META.US,
    ...Object.values(US_STATE_META).filter((x) => x.id !== "US"),
    ...Object.values(EU_META).filter((x) => !x.parent_id),
    ...METROCAST_CITIES,
  ];
  const byAbbr = new Map(Object.values(US_STATE_META).filter((x) => x.id !== "US").map((x) => [x.abbr, x]));

  openPopover(locPill, {
    width: 420,
    className: "lp-panel",
    content(body, layer) {
      const pick = (id) => {
        ctx.setPrimaryLocation(id);
        state.briefingPlace = id;
        layer.close(true);
        if (state.tab === "globe") activeInstance?.focusPlace?.(id);
        else if (state.tab === "briefing") activeInstance?.setPlace?.(id);
      };

      const globeCta = h("button", {
        type: "button",
        class: "lp-globe-cta",
        onclick: () => {
          layer.close(true);
          ctx.focusOnGlobe(state.primaryLocation);
        },
      },
      h("div", null,
        h("strong", null, "Explore on 3D Globe"),
        h("div", null, h("small", null, "Zoom into counties, MetroCast cities & hotspots")),
      ),
      h("span", { class: "lab-tag is-accent" }, "Globe →"));

      const search = h("input", { type: "search", placeholder: `Search ${allLocs.length} places (US, EU, MetroCast)`, autocomplete: "off" });
      const resultsBox = h("div", { class: "lp-chips", style: { paddingBlock: "var(--space-6)" } });
      const drawSearch = () => {
        const q = search.value.trim().toLowerCase();
        const hits = q
          ? allLocs.filter((l) => (l.name || "").toLowerCase().includes(q) || (l.abbr || "").toLowerCase() === q).slice(0, 8)
          : state.recentPlaces.map((id) => lookupPlaceMeta(id)).filter(Boolean);
        resultsBox.replaceChildren(...hits.map((l) =>
          h("button", {
            type: "button",
            class: ["c-chip", l.id === state.primaryLocation && "on"],
            onclick: () => pick(l.id),
          }, l.name)));
      };
      search.addEventListener("input", drawSearch);
      drawSearch();

      // US squircle tiles inside the picker (just like /next/!)
      const usTiles = Object.entries(TILES).map(([abbr, [x, y]]) => {
        const meta = byAbbr.get(abbr);
        if (!meta) return null;
        return h("button", {
          type: "button",
          class: ["c-tile", meta.id === state.primaryLocation && "on"],
          title: meta.name,
          style: { gridColumn: String(x + 1), gridRow: String(y + 1) },
          onclick: () => pick(meta.id),
        }, abbr);
      }).filter(Boolean);

      const euSample = ["DE", "FR", "GB", "ES", "IT", "NL", "SE", "PL"].map((id) => EU_META[id]);

      body.append(
        globeCta,
        h("label", { class: "c-search", html: icon.search }, search),
        resultsBox,
        h("div", { class: "lp-map" },
          h("button", {
            type: "button",
            class: ["c-tile lp-us", state.primaryLocation === "US" && "on"],
            onclick: () => pick("US"),
          }, "United States"),
          h("div", { class: "c-tile-grid lp-tiles" }, ...usTiles),
          h("div", { class: "c-section" }, h("span", { class: "c-section-title" }, "Europe (RespiCast)")),
          h("div", { class: "lp-chips" },
            ...euSample.map((c) =>
              h("button", {
                type: "button",
                class: ["c-chip", c.id === state.primaryLocation && "on"],
                onclick: () => pick(c.id),
              }, `${c.abbr} · ${c.name}`))),
        ),
      );
    },
  });
}

function switchTab(tabVal) {
  const spec = TABS.find((t) => t.value === tabVal) || TABS[0];
  if (state.tab === spec.value && activeInstance) return;
  activeInstance?.destroy?.();
  activeInstance = null;
  state.tab = spec.value;
  setHash(spec.value);
  if (segControl.value !== spec.value) segControl.set(spec.value, false);
  activeInstance = spec.mod.mount(stage, ctx);
}

window.addEventListener("hashchange", () => {
  const next = tabFromHash();
  if (next !== state.tab) switchTab(next);
});

// Initial mount honoring URL hash
const initTab = tabFromHash();
state.tab = initTab;
segControl.set(initTab, false, true);
activeInstance = (TABS.find((t) => t.value === initTab) || TABS[0]).mod.mount(stage, ctx);
