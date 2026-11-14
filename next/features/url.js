/* App state ⇄ URL (next/ARCHITECTURE.md, "App state (the store) and the URL").
 *
 *   target  loc  date  models (comma list, "none" = explicitly empty)  chart (ids by color slot, "" for a
 *   free slot)  all=1  base=0  pi (95 · 80 · 50 · none)  rulers=1  focus  lay (layer ids, comma list)
 *   scores' scope: ss (seasons) wk (a-b) ph (pre|peak|post) hz (horizons) pl (US|current) fair=1 bl (baseline)
 *   rk=sel sc=log; the leaderboard: sort ("-" prefix reverses) cols (optional columns) open (expanded rows)
 *   the view sections (state.views; each section validates its own): hm (heatmap: rows,cols,metric,sort,
 *   scale,horizon,model) mp (map: layer,horizon) pk (peaks: table,scope,layer)
 *
 * Values that equal the defaults are left out, so a default view has a clean URL. Parameters this page
 * doesn't know (old viz's view, scale, indicators…) are kept as they are. Invalid values are dropped:
 * unknown targets, places and models; a date that isn't a forecast round snaps to the nearest round.
 *
 * parseUrl() and writeUrl() are pure (node tests run them); readUrl() and syncUrl() add the browser. */
import { parseIso } from "../lib/scale.js";
import { create, fromLists, chartedBySlot } from "./selection.js";
import { parseLayers } from "./chart/layers.js";

/** The parameters this module owns, in the order they are written. */
export const KEYS = Object.freeze(["target", "loc", "date", "models", "chart", "all", "base", "pi", "rulers", "focus", "lay",
  "ss", "wk", "ph", "hz", "pl", "fair", "bl", "rk", "sc", "sort", "cols", "open", "hm", "mp", "pk"]);
const LEVELS = [0.95, 0.8, 0.5];
const DEFAULT_LEVEL = 0.95;

/**
 * The state a view has when nothing says otherwise (no URL, no storage): the manifest's default target,
 * the US, the first three recommended models (never the baseline), defaultDate() for `sel` (else for
 * that default selection), 95%, no rulers.
 * @param {import("../lib/api.js").Manifest} manifest
 * @param {{ selected: string[] }} [sel] the selection the view starts with, which picks the date
 * @returns {{ target: string, location: string, date: string, sel: object, level: number, rulers: boolean, focus: null }}
 */
export function defaults(manifest, sel) {
  const target = manifest.targetById.has(manifest.default_target) ? manifest.default_target : manifest.targets?.[0]?.id ?? "";
  const location = manifest.locationById.has("US") ? "US" : manifest.locations?.[0]?.id ?? "US";
  const picks = (manifest.recommended || []).filter((id) => id !== manifest.baseline && manifest.modelById.has(id)).slice(0, 3);
  const def = create({ selected: picks });
  return { target, location, date: defaultDate(manifest, sel ?? def), sel: def, level: DEFAULT_LEVEL, rulers: false, focus: null };
}

/**
 * The date a view opens on when nothing names one: the latest round on which a selected model has a
 * forecast (the newest `last` among them, snapped to a round at or before it); with nothing selected, or
 * nothing selected that ever forecast, the latest round any model forecast; else the latest round.
 * (The newest round of a hub often has only a few forecasts yet; opening there would show no models.)
 * @param {import("../lib/api.js").Manifest} manifest
 * @param {{ selected: string[] }} sel
 * @returns {string} a round's ISO date ("" when there are no rounds)
 */
export function defaultDate(manifest, sel) {
  const R = manifest.allRounds;
  if (!R.length) return "";
  const lastOf = (ids) => { let m = ""; for (const id of ids) { const l = manifest.modelById.get(id)?.last; if (typeof l === "string" && l > m) m = l; } return m; };
  const last = lastOf(sel?.selected ?? []) || lastOf(manifest.modelById.keys());
  if (!last) return R.at(-1).iso;
  let best = null;
  for (const r of R) if (r.iso <= last) best = r;
  return (best ?? R[0]).iso;
}

/**
 * The forecast round nearest a date (ties go to the later round).
 * @param {string} iso
 * @param {import("../lib/api.js").Manifest} manifest
 * @returns {string | null} a round's ISO date, or null when `iso` isn't a date or there are no rounds
 */
export function nearestRound(iso, manifest) {
  const t = parseIso(iso), R = manifest.allRounds;
  if (!Number.isFinite(t) || !R.length) return null;
  let best = R[0];
  for (const r of R) if (Math.abs(r.t - t) <= Math.abs(best.t - t)) best = r;
  return best.iso;
}

const isModel = (manifest, id) => !!id && id !== manifest.baseline && manifest.modelById.has(id);

/**
 * Reads the parameters this module owns. Pure.
 * @param {string | URLSearchParams} search a query string ("?a=b" or "a=b") or params
 * @param {import("../lib/api.js").Manifest} manifest
 * @returns {object} a partial state: any of target, location, date, sel, level, rulers, focus, layers; plus
 *   `selFlags` ({ showAll?, baseline? }) when the URL sets all / base without a model list, to apply to
 *   whatever selection the page starts with. Invalid values are simply absent.
 */
export function parseUrl(search, manifest) {
  const q = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  const out = {};
  const target = q.get("target");
  if (target && manifest.targetById.has(target)) out.target = target;
  const loc = q.get("loc");
  if (loc && manifest.locationById.has(loc)) out.location = loc;
  const date = q.has("date") ? nearestRound(q.get("date"), manifest) : null;
  if (date) out.date = date;

  const showAll = q.has("all") ? q.get("all") === "1" : undefined;
  const baseline = q.has("base") ? q.get("base") !== "0" : undefined;
  if (q.has("models") || q.has("chart")) {
    const raw = q.get("models");
    const selected = raw == null || raw.trim() === "none" ? [] : raw.split(",").map((s) => s.trim()).filter((id) => isModel(manifest, id));
    const flags = { showAll: !!showAll, baseline: baseline !== false };
    if (q.has("chart")) {
      const charted = q.get("chart").split(",").map((s) => (isModel(manifest, s.trim()) ? s.trim() : null));
      out.sel = fromLists({ selected, charted, ...flags });
    } else out.sel = create({ selected, ...flags });
  } else if (showAll !== undefined || baseline !== undefined) {
    out.selFlags = {};
    if (showAll !== undefined) out.selFlags.showAll = showAll;
    if (baseline !== undefined) out.selFlags.baseline = baseline;
  }

  if (q.has("pi")) {
    const v = q.get("pi").trim().toLowerCase();
    if (v === "none" || v === "0") out.level = 0;
    else {
      const ls = v.split(",").map((s) => +s.trim() / 100).filter((l) => LEVELS.includes(l));
      if (ls.length) out.level = Math.max(...ls); // an old link's list reads as its widest
    }
  }
  if (q.has("rulers")) out.rulers = q.get("rulers") === "1";
  const focus = q.get("focus");
  if (focus && manifest.modelById.has(focus)) out.focus = focus;
  if (q.has("lay")) out.layers = parseLayers(q.get("lay"));
  else if (q.has("indicators")) { // an old viz link's signals, where they have a layer
    const OLD = { nssp: "nssp", ilinet: "ili", flusurvnet: "flusurv", unrevised: "asof", peak_forecasts: "peaks", prior_season: "seasons" };
    const ids = q.get("indicators").split(",").map((k) => OLD[k.trim()] ?? (k.trim().startsWith("season_") ? "seasons" : ""));
    if (ids.some(Boolean)) out.layers = parseLayers(ids);
  }
  const scope = parseScope(q, manifest);
  if (scope) out.scope = scope;
  const scores = parseScores(q, manifest);
  if (scores) out.scores = scores;
  const views = parseViews(q, manifest);
  if (views) out.views = views;
  return out;
}

/* the view sections' settings, read loosely (each section normalizes its own) */
function parseViews(q, manifest) {
  const v = {}, parts = (k) => (q.get(k) || "").split(",").map((s) => s.trim());
  if (q.get("hm")) {
    const [rows, cols, metric, sort, scale, hz, ...m] = parts("hm"), model = m.join(",");
    v.heatmap = { rows, cols, metric, sort, scale, horizon: +hz, model: model === "truth" || manifest.modelById.has(model) ? model : "truth" };
  }
  if (q.get("mp")) { const [layer, hz] = parts("mp"); v.map = { layer, horizon: +hz }; }
  if (q.get("pk")) { const [table, scope, layer] = parts("pk"); v.peaks = { table, scope, layer }; }
  return Object.keys(v).length ? v : null;
}

function writeViews(p, v) {
  if (!v) return;
  const hm = v.heatmap, mp = v.map, pk = v.peaks;
  if (hm) p.push(["hm", [hm.rows, hm.cols, hm.metric, hm.sort, hm.scale, hm.horizon, hm.model].join(",")]);
  if (mp) p.push(["mp", [mp.layer, mp.horizon].join(",")]);
  if (pk) p.push(["pk", [pk.table, pk.scope, pk.layer].join(",")]);
}

const list = (q, k) => (q.get(k) || "").split(",").map((s) => s.trim()).filter(Boolean);
const SORT_KEYS = ["rel", "wis", "mae", "cov50", "cov80", "cov95", "delta", "per100k", "sharp", "wins", "n", "name", "h0", "h1", "h2", "h3"];
const COL_KEYS = ["delta", "wins", "per100k", "sharp", "cov80", "h0", "h1", "h2", "h3"];

/* the evaluation scope (sections/scope.js), only what differs from its defaults */
function parseScope(q, manifest) {
  const sc = {};
  const ss = list(q, "ss").filter((s) => manifest.seasonById?.has(s));
  if (ss.length) sc.seasons = ss;
  const wk = /^(\d{1,2})[-:](\d{1,2})$/.exec(q.get("wk") || "");
  if (wk) { const a = Math.max(1, Math.min(53, +wk[1])), b = Math.max(1, Math.min(53, +wk[2])); sc.weeks = [Math.min(a, b), Math.max(a, b)]; }
  if (["pre", "peak", "post"].includes(q.get("ph"))) sc.phase = q.get("ph");
  const hz = [...new Set(list(q, "hz").map(Number))].filter((h) => [0, 1, 2, 3].includes(h)).sort();
  if (hz.length && hz.length < 4) sc.horizons = hz;
  if (["US", "current"].includes(q.get("pl"))) sc.place = q.get("pl");
  if (q.get("fair") === "1") sc.fair = true;
  if (q.get("bl") && manifest.modelById.has(q.get("bl"))) sc.baseline = q.get("bl");
  if (q.get("rk") === "sel") sc.rank = "selected";
  if (q.get("sc") === "log") sc.scale = "log";
  return Object.keys(sc).length ? sc : null;
}

/* the leaderboard's view: sort, optional columns, expanded rows */
function parseScores(q, manifest) {
  const o = {};
  const sort = q.get("sort") || "";
  if (SORT_KEYS.includes(sort.replace(/^-/, ""))) { o.sort = sort.replace(/^-/, ""); o.rev = sort.startsWith("-"); }
  const cols = list(q, "cols").filter((c) => COL_KEYS.includes(c));
  if (cols.length) o.cols = cols;
  const open = list(q, "open").filter((id) => manifest.modelById.has(id));
  if (open.length) o.open = open;
  return Object.keys(o).length ? o : null;
}

function writeScope(p, sc, manifest) {
  if (!sc) return;
  if (Array.isArray(sc.seasons) && sc.seasons.length) p.push(["ss", sc.seasons.join(",")]);
  if (Array.isArray(sc.weeks) && sc.weeks.length === 2) p.push(["wk", `${sc.weeks[0]}-${sc.weeks[1]}`]);
  if (sc.phase) p.push(["ph", sc.phase]);
  if (Array.isArray(sc.horizons) && sc.horizons.length && sc.horizons.length < 4) p.push(["hz", sc.horizons.join(",")]);
  if (sc.place === "US" || sc.place === "current") p.push(["pl", sc.place]);
  if (sc.fair) p.push(["fair", "1"]);
  if (sc.baseline && sc.baseline !== manifest.baseline) p.push(["bl", sc.baseline]); // the hub's own is the default
  if (sc.rank === "selected") p.push(["rk", "sel"]);
  if (sc.scale === "log") p.push(["sc", "log"]);
}

function writeScores(p, o) {
  if (!o) return;
  if (o.sort && (o.sort !== "rel" || o.rev)) p.push(["sort", `${o.rev ? "-" : ""}${o.sort}`]);
  if (o.cols?.length) p.push(["cols", o.cols.join(",")]);
  if (o.open?.length) p.push(["open", o.open.join(",")]);
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The query string for a state. Pure. Defaults are left out; parameters in `search` that this module
 * doesn't own are kept, after its own, in their original order.
 * @param {{ target: string, location: string, date: string, sel: object, level: number, rulers: boolean, focus: string | null }} state
 * @param {import("../lib/api.js").Manifest} manifest
 * @param {string | URLSearchParams} [search=""] the current query, for the parameters to keep
 * @returns {string} "" or "?a=b&…" (commas left readable)
 */
export function writeUrl(state, manifest, search = "") {
  const d = defaults(manifest, state.sel), p = [];
  if (state.target && state.target !== d.target) p.push(["target", state.target]);
  if (state.location && state.location !== d.location) p.push(["loc", state.location]);
  if (state.date && state.date !== d.date) p.push(["date", state.date]);
  const sel = state.sel;
  if (sel) {
    const bySlot = chartedBySlot(sel);
    if (!sameList(sel.selected, d.sel.selected) || !sameList(bySlot, chartedBySlot(d.sel))) {
      p.push(["models", sel.selected.length ? sel.selected.join(",") : "none"]);
      // the charted five only when they aren't what the model list alone would give
      if (!sameList(bySlot, chartedBySlot(create({ selected: sel.selected })))) p.push(["chart", bySlot.map((id) => id ?? "").join(",")]);
    }
    if (sel.showAll) p.push(["all", "1"]);
    if (!sel.baseline) p.push(["base", "0"]);
  }
  if (state.level != null && state.level !== DEFAULT_LEVEL) p.push(["pi", state.level ? String(Math.round(state.level * 100)) : "none"]);
  if (state.rulers) p.push(["rulers", "1"]);
  if (state.focus) p.push(["focus", state.focus]);
  if (state.layers?.length) p.push(["lay", state.layers.join(",")]);
  writeScope(p, state.scope, manifest);
  writeScores(p, state.scores);
  writeViews(p, state.views);
  const q = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  for (const [k, v] of q) if (!KEYS.includes(k)) p.push([k, v]);
  const enc = (s) => encodeURIComponent(s).replace(/%2C/gi, ",");
  return p.length ? `?${p.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&")}` : "";
}

/**
 * The page's URL, read once at startup.
 * @param {import("../lib/api.js").Manifest} manifest
 * @returns {object} see parseUrl
 */
export function readUrl(manifest) {
  return parseUrl(location.search, manifest);
}

const WATCHED = ["target", "location", "date", "sel", "level", "rulers", "focus", "layers", "scope", "scores", "views"];

/**
 * Keeps the URL in step with the store: written with history.replaceState (no history entries),
 * debounced ~150 ms, and flushed when the page is hidden.
 * @param {ReturnType<import("../lib/store.js").createStore>} store
 * @param {import("../lib/api.js").Manifest} manifest
 * @returns {() => void} stops (after a final write)
 */
export function syncUrl(store, manifest) {
  let timer = 0;
  const write = () => {
    clearTimeout(timer); timer = 0;
    const next = writeUrl(store.get(), manifest, location.search);
    if (next !== location.search) history.replaceState(history.state, "", `${location.pathname}${next}${location.hash}`);
  };
  const offStore = store.select(WATCHED, () => { clearTimeout(timer); timer = setTimeout(write, 150); });
  const onHide = () => { if (timer) write(); };
  addEventListener("pagehide", onHide);
  write();
  return () => { offStore(); removeEventListener("pagehide", onHide); if (timer) write(); };
}
