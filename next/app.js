/* Boot: the manifest → the starting state (defaults ← storage ← URL; the URL wins) → the store → the page.
 * Then the URL and browser storage follow the store. `window.__viz` is the one global, for the e2e checks. */
import { loadManifest, getActiveHub, setActiveHub } from "./lib/api.js";
import { createStore } from "./lib/store.js";
import { h, storage } from "./lib/dom.js";
import { fromLists, chartedBySlot, setShowAll, setBaseline, isCharted } from "./features/selection.js";
import { defaults, defaultDate, defaultDims, readUrl, syncUrl, parseLevels } from "./features/url.js";
import { mountShell, storedTheme } from "./features/Shell.js";
import { parseLayers } from "./features/chart/layers.js";

const root = document.getElementById("app");
const hubKey = (id, name) => (id ? `viz.h.${id}.${name}` : `viz.${name}`);

/* What this browser remembers, validated against the manifest (anything unknown is ignored). */
function fromStorage(manifest) {
  const out = {};
  const hid = manifest.hub_id;
  const loc = storage.get(hubKey(hid, "location")) ?? storage.get("viz.location");
  if (typeof loc === "string" && manifest.locationById.has(loc)) out.location = loc;
  const s = storage.get(hubKey(hid, "selection")) ?? storage.get("viz.selection");
  if (s && Array.isArray(s.selected)) {
    const ok = (id) => typeof id === "string" && id !== manifest.baseline && manifest.modelById.has(id);
    out.sel = fromLists({
      selected: s.selected.filter(ok),
      charted: Array.isArray(s.charted) ? s.charted.map((id) => (ok(id) ? id : null)) : [],
      showAll: !!s.showAll, baseline: s.baseline !== false,
    });
  }
  const levels = storage.get("viz.levels");
  if (Array.isArray(levels)) out.levels = parseLevels(levels);
  else { // an older browser's single level, once (0: none)
    const level = storage.get("viz.level");
    if (typeof level === "number") storage.set("viz.levels", (out.levels = parseLevels([level])));
  }
  const rulers = storage.get("viz.rulers");
  if (typeof rulers === "boolean") out.rulers = rulers;
  const layers = storage.get("viz.layers");
  if (Array.isArray(layers)) out.layers = parseLayers(layers);
  return out;
}

/* Remember what should survive a reload in this browser (ARCHITECTURE.md, "Browser storage"). */
function persist(store, hubId) {
  return store.on((s, prev, changed) => {
    if (changed.has("location")) {
      storage.set(hubKey(hubId, "location"), s.location);
      // recent places, however the place changed (picker, map, a row's link): it first, then the one
      // left, then the rest; distinct; four (the same rule as LocationPicker's nextRecent)
      const pKey = hubKey(hubId, "places");
      const places = storage.get(pKey) ?? (hubId ? [] : storage.get("viz.places", []));
      storage.set(pKey, [...new Set([s.location, prev.location, ...(Array.isArray(places) ? places : [])].filter((x) => typeof x === "string" && x))].slice(0, 4));
    }
    if (changed.has("sel")) storage.set(hubKey(hubId, "selection"), { selected: s.sel.selected, charted: chartedBySlot(s.sel), showAll: s.sel.showAll, baseline: s.sel.baseline });
    if (changed.has("levels")) storage.set("viz.levels", s.levels);
    if (changed.has("rulers")) storage.set("viz.rulers", s.rulers);
    if (changed.has("layers")) storage.set("viz.layers", s.layers);
    if (changed.has("theme")) storage.set("viz.theme", s.theme);
  });
}

/* The manifest couldn't be loaded: one quiet line, and a way to try again. */
function unreachable() {
  document.querySelector(".app-progress")?.classList.add("is-done");
  const line = h("div", { class: "app-error", role: "alert" },
    h("span", null, "Can't reach viz · "),
    h("button", { type: "button", class: "c-link", onclick: () => { line.remove(); document.querySelector(".app-progress")?.classList.remove("is-done"); boot(); } }, "Retry"));
  root.append(line);
}

/* No local hub connected yet, or connected hub has no forecast rounds yet. */
async function renderWelcome(manifest) {
  const hubless = Boolean(manifest.empty);
  const localMode = (manifest.mode || "local") === "local";
  document.documentElement.dataset.theme = storedTheme();
  document.querySelector(".app-progress")?.classList.add("is-done");
  root.className = "app is-ready";

  const [{ glass }, { pill, icon }, { mountMore }, { openHubs }] = await Promise.all([
    import("./ui/glass.js"),
    import("./ui/controls.js"),
    import("./features/More.js"),
    import("./features/Hubs.js"),
  ]);

  const tr = h("div", { class: "c-zone", "data-zone": "tr" });
  const fixed = h("div", { class: "c-chrome app-fixed" }, h("div", { class: "c-zone", "data-zone": "tl" }), tr);
  const themeBtn = pill({ icon: icon.theme, ariaLabel: "Light or dark", className: "app-theme" });
  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    storage.set("viz.theme", next);
  });
  tr.append(themeBtn);
  glass(themeBtn);
  const moreCtx = { manifest, hubless };
  mountMore(tr, moreCtx);

  const actionBtn = localMode
    ? h("button", {
      type: "button", class: "c-btn mo-primary",
      onclick: () => openHubs(actionBtn, moreCtx),
    }, hubless ? "Add local hub" : "Data sources")
    : null;

  const welcome = h("main", { class: "app-welcome" },
    h("div", { class: "app-welcome-card" },
      h("h1", { class: "app-welcome-title" }, hubless ? "No local hub connected" : (manifest.hub || "Connected hub")),
      h("p", { class: "app-welcome-sub" }, hubless
        ? (localMode
          ? "Point viz at a local Hubverse folder to inspect forecasts and scores."
          : "No hub is currently available on this server.")
        : "No forecast rounds found in this hub yet."),
      actionBtn ? h("div", { class: "app-welcome-actions" }, actionBtn) : null,
      hubless && localMode ? h("code", { class: "app-welcome-cmd" }, "./run.sh --hub /path/to/hub") : null));

  root.replaceChildren(welcome, fixed);
}

async function boot() {
  let manifest;
  try {
    manifest = await loadManifest();
  } catch (err) {
    if (err?.status === 404 && getActiveHub()) {
      setActiveHub(null);
      const q = new URLSearchParams(location.search);
      q.delete("hub");
      const next = q.toString();
      history.replaceState(history.state, "", `${location.pathname}${next ? `?${next}` : ""}${location.hash}`);
      try {
        manifest = await loadManifest();
      } catch {
        unreachable();
        return;
      }
    } else {
      unreachable();
      return;
    }
  }

  if (manifest.empty || !manifest.allRounds.length) {
    await renderWelcome(manifest);
    return;
  }

  const { selFlags, ...url } = readUrl(manifest);
  const def = defaults(manifest);
  const resolvedTarget = url.target ?? def.target;
  const initDims = defaultDims(manifest, resolvedTarget);
  const state = {
    ...(manifest.hub_id ? { hub: manifest.hub_id } : {}),
    ...def,
    outcome: true,
    layers: [],
    trajectories: false,
    theme: storedTheme(),
    ...fromStorage(manifest),
    ...url,
    dims: { ...initDims, ...(url.dims || {}) },
  };
  if (selFlags) {
    if (selFlags.showAll !== undefined) state.sel = setShowAll(state.sel, selFlags.showAll);
    if (selFlags.baseline !== undefined) state.sel = setBaseline(state.sel, selFlags.baseline);
  }
  // no date in the URL: the latest round the starting selection has forecasts for
  if (!url.date) state.date = defaultDate(manifest, state.sel);
  // focus only on a model that is drawn: charted, or the baseline while it is on
  if (state.focus && !isCharted(state.sel, state.focus) && !(state.focus === manifest.baseline && state.sel.baseline)) state.focus = null;

  const store = createStore(state);
  const ctx = { manifest, store, chart: null };
  mountShell(root, ctx);
  syncUrl(store, manifest);
  persist(store, manifest.hub_id);
  // a link that names models from a live hub that isn't synced here: say so, with a way to sync it
  {
    const named = (new URLSearchParams(location.search).get("models") || "").split(",").map((x) => x.trim()).filter(Boolean);
    const missing = named.filter((id) => /^[a-z][a-z0-9_]*:/.test(id) && !id.startsWith("local:") && !manifest.modelById.has(id));
    if (missing.length) {
      const hubId = missing[0].split(":")[0], hub = (manifest.hubs || []).find((x) => x.id === hubId);
      const label = hub?.label || hubId, n = missing.length;
      import("./ui/controls.js").then(({ toast }) => toast(`This link includes ${n} ${label} model${n === 1 ? "" : "s"} not synced here`, {
        tone: "info", duration: 12000,
        action: hub ? { label: "Sync…", onClick: () => import("./features/Hubs.js").then((m) => m.openHubs(document.querySelector(".app-more") || document.body, { manifest })) } : null,
      }));
    }
  }
  // after Refresh data found new files and reloaded: say so once, on the fresh page
  try {
    const n = sessionStorage.getItem("viz.refreshed");
    if (n !== null) {
      sessionStorage.removeItem("viz.refreshed");
      import("./ui/controls.js").then(({ toast }) => toast(n ? `Data refreshed · ${n} models` : "Data refreshed"));
    }
  } catch {}
  window.__viz = { store, manifest, chart: ctx.chart, get nav() { return ctx.chart.nav; }, idle: () => ctx.chart.idle() };
}

boot();
