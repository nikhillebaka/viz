/* Boot: the manifest → the starting state (defaults ← storage ← URL; the URL wins) → the store → the page.
 * Then the URL and browser storage follow the store. `window.__viz` is the one global, for the e2e checks. */
import {
  loadManifest,
  loadCatalog,
  invalidateCatalog,
  clearAllCaches,
  getActiveHub,
  setActiveHub,
} from "./lib/api.js";
import { createStore } from "./lib/store.js";
import { h, storage } from "./lib/dom.js";
import { DAY, parseIso } from "./lib/scale.js";
import { activeLayer } from "./ui/floating.js";
import { setHubsContext } from "./features/Hubs.js";
import { fromLists, chartedBySlot, setShowAll, setBaseline, isCharted, chart } from "./features/selection.js";
import { KEYS, defaults, defaultDate, defaultDims, targetDimSpecs, readUrl, syncUrl, parseLevels, isCategoricalTarget } from "./features/url.js";
import { mountShell, storedTheme } from "./features/Shell.js";
import { parseLayers } from "./features/chart/layers.js";
import { classifyHubGeo } from "./geo/picker_geo.js";

const root = document.getElementById("app");
const hubKey = (id, name) => (id ? `viz.h.${id}.${name}` : `viz.${name}`);
const geoKey = (manifest) => `viz.geo.${classifyHubGeo(manifest).kind}.location`;
const VALID_SCORE_COLS = new Set(["delta", "wins", "per100k", "sharp", "cov80", "h0", "h1", "h2", "h3", "h4"]);
const QUANT_SORTS = new Set(["rel", "wis", "mae", "cov50", "cov80", "cov95", "delta", "per100k", "sharp", "wins", "n", "name", "h0", "h1", "h2", "h3", "h4"]);
const CAT_SORTS = new Set(["rel", "rps", "logScore", "brier", "hitMode", "n", "name", "h0", "h1", "h2", "h3", "h4"]);

function sanitizeScoresForTarget(scores, manifest, targetId) {
  if (!scores) return undefined;
  const cols = Array.isArray(scores.cols) ? scores.cols.filter((c) => VALID_SCORE_COLS.has(c)) : [];
  const tMeta = manifest.targetById.get(targetId);
  const allowedSorts = isCategoricalTarget(tMeta) ? CAT_SORTS : QUANT_SORTS;
  const keepSort = typeof scores.sort === "string" && allowedSorts.has(scores.sort);
  return {
    ...scores,
    sort: keepSort ? scores.sort : "rel",
    rev: keepSort ? !!scores.rev : false,
    cols,
    open: Array.isArray(scores.open) ? scores.open : [],
  };
}

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
  const scoreCols = storage.get("viz.scores.cols");
  if (Array.isArray(scoreCols)) {
    const cols = [...new Set(scoreCols.filter((c) => typeof c === "string" && VALID_SCORE_COLS.has(c)))];
    if (cols.length) out.scores = { sort: "rel", rev: false, cols, open: [] };
  }
  return out;
}

/* Remember what should survive a reload in this browser (ARCHITECTURE.md, "Browser storage"). */
function persist(store, manifest) {
  const hubId = manifest.hub_id;
  return store.on((s, prev, changed) => {
    if (changed.has("location") && s.location) {
      storage.set(hubKey(hubId, "location"), s.location);
      storage.set(geoKey(manifest), s.location);
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
    if (changed.has("scores")) storage.set("viz.scores.cols", Array.isArray(s.scores?.cols) ? s.scores.cols : []);
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

function nearestWithin(iso, rounds, maxDays = 21) {
  const t = parseIso(iso);
  if (!Number.isFinite(t) || !rounds?.length) return null;
  let best = null, bd = Infinity;
  for (const r of rounds) {
    const d = Math.abs(r.t - t);
    if (d < bd) { bd = d; best = r.iso; }
  }
  return bd <= maxDays * DAY ? best : null;
}

function resolveMappedLocation(nextMan, catalog, prevHubId, prevLocId, explicitLoc, targetId = null, nextStored = null) {
  const tMeta = targetId ? nextMan.targetById.get(targetId) : null;
  const allowed = Array.isArray(tMeta?.locations) && tMeta.locations.length ? new Set(tMeta.locations) : null;
  const validLoc = (id) => !!id && nextMan.locationById.has(id) && (!allowed || allowed.has(id));

  if (validLoc(explicitLoc)) return explicitLoc;
  const places = catalog?.places || {};
  let prevPlace = null;
  if (prevLocId) {
    for (const p of Object.values(places)) {
      if (p.hubs?.some((ent) => ent.hub_id === prevHubId && ent.location_id === prevLocId)) {
        prevPlace = p;
        break;
      }
    }
    if (!prevPlace && places[prevLocId]) prevPlace = places[prevLocId];
  }
  if (prevPlace) {
    const direct = prevPlace.hubs?.find((ent) => ent.hub_id === nextMan.hub_id && validLoc(ent.location_id));
    if (direct) return direct.location_id;
    for (const childKey of prevPlace.children || []) {
      const child = places[childKey];
      const childEnt = child?.hubs?.find((ent) => ent.hub_id === nextMan.hub_id && validLoc(ent.location_id));
      if (childEnt) return childEnt.location_id;
    }
    // Walk up parent hierarchy (e.g. Boston -> MA -> US)
    const seen = new Set([prevPlace.key]);
    let cur = prevPlace;
    while (cur?.parent_key && places[cur.parent_key] && !seen.has(cur.parent_key)) {
      cur = places[cur.parent_key];
      seen.add(cur.key);
      const pEnt = cur.hubs?.find((ent) => ent.hub_id === nextMan.hub_id && validLoc(ent.location_id));
      if (pEnt) return pEnt.location_id;
    }
  }
  if (validLoc(prevLocId)) return prevLocId;
  if (validLoc(nextStored?.location)) return nextStored.location;
  const geoLoc = storage.get(geoKey(nextMan));
  if (validLoc(geoLoc)) return geoLoc;
  const def = defaults(nextMan);
  if (validLoc(tMeta?.default_location)) return tMeta.default_location;
  if (validLoc(def.location)) return def.location;
  if (allowed) {
    const firstAllowed = tMeta.locations.find((id) => nextMan.locationById.has(id));
    if (firstAllowed) return firstAllowed;
  }
  return nextMan.locations?.[0]?.id ?? null;
}

function stripAppQueryParams(oldMan) {
  const dimKeys = new Set();
  for (const t of oldMan?.targets || []) for (const s of targetDimSpecs(t)) dimKeys.add(`dim_${s.name}`);
  const cur = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  for (const [k, v] of cur) if (!KEYS.includes(k) && !dimKeys.has(k)) keep.append(k, v);
  const qs = keep.toString();
  history.replaceState(history.state, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
}

let activeUnmount = null;
let switchSeq = 0;

function mountContext(manifest, { catalog = null, stateOverride = null, initialUrl = null } = {}) {
  const fromUrl = initialUrl ? initialUrl : {};
  const { selFlags, ...url } = fromUrl;
  const stored = fromStorage(manifest);
  const def = defaults(manifest);
  const resolvedTarget = stateOverride?.target ?? url.target ?? def.target;
  const initDims = defaultDims(manifest, resolvedTarget);
  const mergedScores = (stored.scores || url.scores || stateOverride?.scores)
    ? { sort: "rel", rev: false, cols: [], open: [], ...(stored.scores || {}), ...(url.scores || {}), ...(stateOverride?.scores || {}) }
    : undefined;
  const state = {
    ...(manifest.hub_id ? { hub: manifest.hub_id } : {}),
    ...def,
    outcome: true,
    layers: [],
    trajectories: false,
    theme: storedTheme(),
    ...stored,
    ...url,
    ...(stateOverride || {}),
    ...(mergedScores ? { scores: mergedScores } : {}),
    dims: { ...initDims, ...(url.dims || {}), ...(stateOverride?.dims || {}) },
  };
  if (selFlags && !stateOverride?.sel) {
    if (selFlags.showAll !== undefined) state.sel = setShowAll(state.sel, selFlags.showAll);
    if (selFlags.baseline !== undefined) state.sel = setBaseline(state.sel, selFlags.baseline);
  }
  if (!url.date && !stateOverride?.date) state.date = defaultDate(manifest, state.sel);
  const initBase = manifest.baselineFor?.(state.target, state.date) ?? manifest.baseline;
  if (state.focus && !isCharted(state.sel, state.focus) && !(state.focus === initBase && state.sel.baseline)) state.focus = null;
  if (state.scores) state.scores = sanitizeScoresForTarget(state.scores, manifest, state.target);

  const store = createStore(state);
  const ctx = {
    manifest,
    store,
    chart: null,
    catalog,
    async reloadCatalog() {
      invalidateCatalog();
      const nextCat = await loadCatalog(true).catch(() => null);
      if (nextCat) ctx.catalog = nextCat;
      return nextCat;
    },
    async switchContext({ hub = null, target = null, location: nextLoc = null, date = null, model = null, dims = null, keepGlobe = false, forceReload = false } = {}) {
      const targetHub = hub || manifest.hub_id;
      if (!forceReload && targetHub === manifest.hub_id) {
        const cur = store.get();
        const patch = {};
        const nextT = (target && manifest.targetById.has(target) && target !== cur.target) ? target : null;
        if (nextT) {
          patch.target = nextT;
          patch.dims = { ...defaultDims(manifest, nextT), ...(dims || {}) };
          if (cur.scores) patch.scores = sanitizeScoresForTarget(cur.scores, manifest, nextT);
          const nextTMeta = manifest.targetById.get(nextT);
          const checkLoc = (nextLoc && manifest.locationById.has(nextLoc)) ? nextLoc : cur.location;
          if (Array.isArray(nextTMeta?.locations) && nextTMeta.locations.length && !nextTMeta.locations.includes(checkLoc)) {
            const mapped = resolveMappedLocation(manifest, ctx.catalog, manifest.hub_id, checkLoc, null, nextT, stored);
            if (mapped && mapped !== cur.location) patch.location = mapped;
          }
          if (cur.scope?.baseline) {
            const bModel = manifest.modelById.get(cur.scope.baseline);
            if (!bModel || (bModel.targets?.length && !bModel.targets.includes(nextT))) {
              patch.scope = { ...(cur.scope || {}), baseline: manifest.baselineFor?.(nextT, cur.date) ?? manifest.baseline ?? null };
            }
          }
        } else if (dims) {
          patch.dims = { ...(cur.dims || {}), ...dims };
        }
        if (nextLoc && manifest.locationById.has(nextLoc) && nextLoc !== cur.location && !patch.location) {
          const effT = nextT || cur.target;
          const effTMeta = manifest.targetById.get(effT);
          if (!effTMeta?.locations?.length || effTMeta.locations.includes(nextLoc)) {
            patch.location = nextLoc;
          } else {
            const mapped = resolveMappedLocation(manifest, ctx.catalog, manifest.hub_id, nextLoc, null, effT, stored);
            if (mapped && mapped !== cur.location) patch.location = mapped;
          }
        }
        if (date) {
          const snapped = nearestWithin(date, manifest.allRounds, 21);
          if (snapped) patch.date = snapped;
        }
        if (model && manifest.modelById.has(model)) {
          const effT = nextT || cur.target;
          const effBase = manifest.baselineFor?.(effT, patch.date || cur.date) ?? manifest.baseline;
          const nextSel = model === effBase ? setBaseline(cur.sel, true) : chart(cur.sel, model);
          if (nextSel !== cur.sel) patch.sel = nextSel;
        }
        if (Object.keys(patch).length) store.set(patch);
        return;
      }

      const seq = ++switchSeq;
      activeLayer()?.close(false);
      const prev = store.get();
      if (forceReload) clearAllCaches();

      const prog = document.querySelector(".app-progress") || document.body.appendChild(h("div", { class: "app-progress", role: "progressbar", "aria-label": "Loading" }));
      prog.classList.remove("is-done");
      let nextMan, nextCat;
      try {
        [nextMan, nextCat] = await Promise.all([
          loadManifest(targetHub),
          forceReload ? loadCatalog(true).catch(() => ctx.catalog) : Promise.resolve(ctx.catalog),
        ]);
      } catch (err) {
        prog.classList.add("is-done");
        throw err;
      }
      if (seq !== switchSeq) return;
      activeLayer()?.close(false);
      setActiveHub(targetHub);

      const nextDef = defaults(nextMan);
      let resolvedT = (target && nextMan.targetById.has(target)) ? target : null;
      if (!resolvedT) {
        const catTargets = (nextCat || ctx.catalog)?.targets || [];
        const curConcept = catTargets.find((t) => (t.hub_id === manifest.hub_id || !manifest.hub_id) && t.target_id === prev.target)?.concept_id;
        if (curConcept) {
          const match = catTargets.find((t) => (t.hub_id === targetHub || t.hub_id === nextMan.hub_id) && t.concept_id === curConcept && nextMan.targetById.has(t.target_id));
          if (match) resolvedT = match.target_id;
        }
      }
      if (!resolvedT) resolvedT = nextDef.target;
      if (prev.location && manifest.locationById.has(prev.location)) storage.set(geoKey(manifest), prev.location);
      const nextStored = fromStorage(nextMan);
      const resolvedLoc = resolveMappedLocation(nextMan, nextCat, manifest.hub_id, prev.location, nextLoc, resolvedT, nextStored);
      let nextSel = nextStored.sel || nextDef.sel;
      const resolvedDate = (date && nearestWithin(date, nextMan.allRounds, 21))
        || nearestWithin(prev.date, nextMan.allRounds, 21)
        || defaultDate(nextMan, nextSel);
      if (model && nextMan.modelById.has(model)) {
        const nextBase = nextMan.baselineFor?.(resolvedT, resolvedDate) ?? nextMan.baseline;
        nextSel = model === nextBase ? setBaseline(nextSel, true) : chart(nextSel, model);
      }

      if (keepGlobe && window.location.hash !== "#globe") {
        history.replaceState(history.state, "", `${window.location.pathname}${window.location.search}#globe`);
      } else if (!keepGlobe && window.location.hash === "#globe") {
        history.replaceState(history.state, "", `${window.location.pathname}${window.location.search}`);
      }
      activeUnmount?.({ flush: false });
      stripAppQueryParams(manifest);

      mountContext(nextMan, {
        catalog: nextCat,
        stateOverride: {
          hub: nextMan.hub_id || targetHub,
          target: resolvedT,
          location: resolvedLoc,
          date: resolvedDate,
          sel: nextSel,
          dims: { ...defaultDims(nextMan, resolvedT), ...(dims || {}) },
          levels: prev.levels,
          rulers: prev.rulers,
          layers: prev.layers,
          scores: sanitizeScoresForTarget(prev.scores, nextMan, resolvedT),
          theme: prev.theme,
          outcome: prev.outcome,
        },
      });
    },
  };

  setHubsContext(ctx);
  const shell = mountShell(root, ctx, { pickLocation: state.location == null });
  const stopUrl = syncUrl(store, manifest);
  const stopPersist = persist(store, manifest);
  activeUnmount = ({ flush = true } = {}) => {
    stopUrl({ flush });
    stopPersist();
    shell.destroy();
    activeUnmount = null;
  };
  window.__viz = { store, manifest, chart: ctx.chart, get nav() { return ctx.chart.nav; }, idle: () => ctx.chart.idle() };
}

async function boot() {
  const catalogP = loadCatalog().catch(() => null);
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

  const catalog = await catalogP;
  if ((manifest.empty || !manifest.allRounds.length) && catalog?.hubs?.length) {
    setActiveHub(catalog.hubs[0].id);
    try {
      manifest = await loadManifest(catalog.hubs[0].id);
    } catch { /* fallback to welcome below */ }
  }

  if (manifest.empty || !manifest.allRounds.length) {
    await renderWelcome(manifest);
    return;
  }

  const initialUrl = readUrl(manifest);
  mountContext(manifest, { catalog, initialUrl });

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
}

boot();
