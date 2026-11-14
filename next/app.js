/* Boot: the manifest → the starting state (defaults ← storage ← URL; the URL wins) → the store → the page.
 * Then the URL and browser storage follow the store. `window.__viz` is the one global, for the e2e checks. */
import { loadManifest } from "./lib/api.js";
import { createStore } from "./lib/store.js";
import { h, storage } from "./lib/dom.js";
import { fromLists, chartedBySlot, setShowAll, setBaseline, isCharted } from "./features/selection.js";
import { defaults, defaultDate, readUrl, syncUrl, parseLevels } from "./features/url.js";
import { mountShell, storedTheme } from "./features/Shell.js";
import { parseLayers } from "./features/chart/layers.js";

const root = document.getElementById("app");

/* What this browser remembers, validated against the manifest (anything unknown is ignored). */
function fromStorage(manifest) {
  const out = {};
  const loc = storage.get("viz.location");
  if (typeof loc === "string" && manifest.locationById.has(loc)) out.location = loc;
  const s = storage.get("viz.selection");
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
function persist(store) {
  return store.on((s, prev, changed) => {
    if (changed.has("location")) {
      storage.set("viz.location", s.location);
      // recent places, however the place changed (picker, map, a row's link): it first, then the one
      // left, then the rest; distinct; four (the same rule as LocationPicker's nextRecent)
      const places = storage.get("viz.places", []);
      storage.set("viz.places", [...new Set([s.location, prev.location, ...(Array.isArray(places) ? places : [])].filter((x) => typeof x === "string" && x))].slice(0, 4));
    }
    if (changed.has("sel")) storage.set("viz.selection", { selected: s.sel.selected, charted: chartedBySlot(s.sel), showAll: s.sel.showAll, baseline: s.sel.baseline });
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

async function boot() {
  let manifest;
  try {
    manifest = await loadManifest();
    if (!manifest.allRounds.length) throw new Error("no forecast rounds");
  } catch {
    unreachable();
    return;
  }
  const { selFlags, ...url } = readUrl(manifest);
  const state = { ...defaults(manifest), outcome: true, layers: [], theme: storedTheme(), ...fromStorage(manifest), ...url };
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
  persist(store);
  window.__viz = { store, manifest, chart: ctx.chart, get nav() { return ctx.chart.nav; }, idle: () => ctx.chart.idle() };
}

boot();
