/* The model picker: which models are selected (evaluated) and which five are charted, laid out for a
 * catalog of hundreds:
 *
 *   search (suggests filters as you type)                      This season | This round | Any time  Baseline
 *   ┌ rail ────────┐ ┌ results ─────────────────────────┐ ┌ preview ─────────┐
 *   │ Sets         │ │ This repo                         │ │ the hovered model │
 *   │ Source       │ │ ▸ GBQR · UMass · 46 variants      │ │ or line: what it  │
 *   │ Kind · Data  │ │   AR(2) … rows say what a model is│ │ is, its data,     │
 *   │ Family, Team │ │ FluSight …                        │ │ seasons, method   │
 *   └──────────────┘ └───────────────────────────────────┘ └───────────────────┘
 *   tray: the selection, charted first in their colours                      Combine… Reset Clear
 *
 * Variant lines: three or more models of one team and family from one source collapse into a line; opened,
 * the parts of their names (4src, spatial, fourierP…) filter its variants. Rail: a click picks one value of
 * a filter, ⌘ / Ctrl / Shift-click adds or removes one. catalog(), browse() and the helpers are pure, for node tests. */
import { h, on, tokenNum } from "../lib/dom.js";
import { openPopover, revealInList } from "../ui/floating.js";
import { icon, slideText } from "../ui/controls.js";
import { registerCacheClear } from "../lib/api.js";
import { toIso } from "../lib/scale.js";
import { fmtDay } from "../lib/format.js";
import * as S from "./selection.js";

/** Three or more of one team and family (from one source) make a line. */
export const LINE_MIN = 3;
/** The rail's filters, in order (Sets come first and are not a filter of values). */
export const RAIL = Object.freeze([
  { key: "source", label: "Source" },
  { key: "kind", label: "Kind" },
  { key: "input", label: "Data" },
  { key: "family", label: "Family" },
  { key: "team", label: "Team" },
]);
export const SETS = Object.freeze({ all: "All models", designated: "Designated", recommended: "Recommended", selected: "Selected" });
const INPUT_SHORT = { "NHSN admissions": "NHSN", "NSSP ED visits": "NSSP", "COVID / RSV": "COVID/RSV", "Hub forecasts": "hub forecasts" };

const collate = new Intl.Collator("en", { numeric: true, sensitivity: "base" }).compare;
const lower = (s) => String(s ?? "").toLowerCase();

const KIND = { individual: "Individual", ensemble: "Ensemble", baseline: "Baseline" };
// typed search: "team:umass", "data:nssp"; keys and their spellings
const TOKEN = { team: "team", family: "family", fam: "family", source: "source", src: "source", hub: "source", kind: "kind", type: "kind", data: "input", input: "input", inputs: "input" };
export const WHEN = Object.freeze({ season: "This season", round: "This round", any: "Any time" });
const isLocal = (m) => m.source === "local" || m.source === "synthetic";

/* ================================================================ pure: the catalog */

const catalogs = new WeakMap(); // manifest → Map<target, catalog>

/**
 * Everything about the listed models that depends only on the manifest and the target: who is listed
 * (the baseline never; models whose targets lack this one neither), display names unique among them,
 * search text, and each model's value for every filter (with every value, most models first).
 * @param {object} manifest an indexed manifest (lib/api.js)
 * @param {string} target
 * @returns {{ ids: string[], labels: Map<string, string>, hay: Map<string, string>,
 *             facets: Map<string, Record<string, string[]>>, values: Record<string, string[]> }} cached per target
 */
export function catalog(manifest, target) {
  let byTarget = catalogs.get(manifest);
  if (!byTarget) catalogs.set(manifest, (byTarget = new Map()));
  let c = byTarget.get(target);
  if (c) return c;

  const targetBaseline = manifest.baselineFor?.(target) ?? manifest.baseline;
  const listed = (manifest.models || []).filter((m) => m.id !== targetBaseline && (!m.targets?.length || m.targets.includes(target)));
  const ids = listed.map((m) => m.id);
  const labels = new Map(ids.map((id) => [id, manifest.label(id, ids)]));
  const facets = new Map(listed.map((m) => [m.id, facetsOf(manifest, m)]));
  // a "family" of one model is only its name: those go under Other
  const famN = new Map();
  for (const f of facets.values()) famN.set(f.family[0], (famN.get(f.family[0]) || 0) + 1);
  for (const f of facets.values()) if (famN.get(f.family[0]) < 2 && f.family[0] !== LAST) f.family = [OTHER];
  const hay = new Map(listed.map((m) => [m.id, lower([labels.get(m.id), m.id, m.team, m.team_name, m.family, manifest.sourceLabel(m), KIND[m.kind], ...(m.inputs || [])].filter(Boolean).join("\n"))]));
  // every value of every filter, most models first ("Not stated" and the like last)
  const values = {};
  for (const { key } of RAIL) {
    const n = new Map();
    for (const id of ids) for (const v of facets.get(id)[key]) n.set(v, (n.get(v) || 0) + 1);
    const tail = (v) => (v === LAST) * 2 + (v === OTHER);
    values[key] = [...n].sort((a, b) => tail(a[0]) - tail(b[0]) || b[1] - a[1] || collate(a[0], b[0])).map(([v]) => v);
  }
  c = Object.freeze({ ids, labels, hay, facets, values });
  byTarget.set(target, c);
  return c;
}

const LAST = "Not stated", OTHER = "Other";

/**
 * A model's values for each filter: where it comes from, its family, team, kind and the data it lists.
 * @param {object} manifest
 * @param {object} m a manifest model
 * @returns {{ source: string[], family: string[], team: string[], kind: string[], input: string[] }}
 */
export function facetsOf(manifest, m) {
  const source = m.source === "hub" ? manifest.sourceLabel(m) || "Hub" : m.source === "local" ? "Local" : m.source === "synthetic" ? "Combined here" : "This repo";
  return {
    source: [source],
    family: [m.family || LAST],
    team: [m.team || LAST],
    kind: [KIND[m.kind] || KIND.individual],
    input: m.inputs?.length ? [...m.inputs] : [LAST],
  };
}

/**
 * A search split into plain words and typed filters ("team:umass", "data:nssp"); an unknown key stays a word.
 * @param {string} query
 * @returns {{ words: string[], tokens: { key: string, value: string }[] }}
 */
export function parseQuery(query) {
  const words = [], tokens = [];
  for (const w of lower(query).split(/\s+/).filter(Boolean)) {
    const i = w.indexOf(":"), key = i > 0 ? TOKEN[w.slice(0, i)] : null;
    if (key && w.length > i + 1) tokens.push({ key, value: w.slice(i + 1) });
    else if (!key) words.push(w);
  }
  return { words, tokens };
}

/**
 * A predicate for a search query: case-insensitive; every word must match the model's display name,
 * id, team, team name, family or source label; the words "designated", "local", "selected" and
 * "charted" also match those sets.
 * @param {object} manifest
 * @param {ReturnType<typeof catalog>} cat
 * @param {string} query
 * @param {object | null} sel a selection (features/selection.js), for "selected" and "charted"
 * @returns {((id: string) => boolean) | null} null when the query is empty
 */
export function matcher(manifest, cat, query, sel) {
  const words = lower(query).split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const selected = new Set(sel?.selected || []), charted = new Set((sel?.charted || []).map((c) => c.id));
  const sets = {
    designated: (id) => !!manifest.modelById.get(id)?.designated,
    local: (id) => isLocal(manifest.modelById.get(id) || {}),
    selected: (id) => selected.has(id),
    charted: (id) => charted.has(id),
  };
  return (id) => {
    const text = cat.hay.get(id) || "";
    return words.every((w) => text.includes(w) || !!sets[w]?.(id));
  };
}


/* ================================================================ pure: what is shown */

const lineCache = new WeakMap(); // catalog → Map<id, line key> and Map<line key, line>

/** The variant lines of a catalog: { key, title, team, source, ids } for each team × family × source of LINE_MIN or more. */
export function linesOf(manifest, cat) {
  let c = lineCache.get(cat);
  if (c) return c;
  const by = new Map();
  for (const id of cat.ids) {
    const m = manifest.modelById.get(id) || {};
    if (!m.family) continue;
    const key = `${m.source === "hub" ? `hub:${m.hub}` : m.source}|${m.team || ""}|${m.family}`;
    if (!by.has(key)) by.set(key, { key, title: m.family, team: m.team || "", ids: [] });
    by.get(key).ids.push(id);
  }
  const lines = new Map(), of = new Map();
  for (const [k, l] of by) if (l.ids.length >= LINE_MIN) { lines.set(k, l); for (const id of l.ids) of.set(id, k); }
  c = { lines, of };
  lineCache.set(cat, c);
  return c;
}

/**
 * The parts of a model's name that tell variants apart: its abbreviation split at "_", without a leading
 * part that is just the family ("gbqr_4src_spatial" in GBQR → 4src, spatial).
 * @param {object} m a manifest model
 * @returns {string[]}
 */
export function nameParts(m) {
  const parts = String(m.abbr || m.id).split("_").filter(Boolean);
  if (parts.length > 1 && lower(parts[0]) === lower(m.family)) parts.shift();
  return parts;
}

/**
 * What the browser shows for a target, season, search, set, filters and "when".
 * @param {object} manifest
 * @param {{ target: string, season: string | null, query?: string, sel?: object | null, set?: string,
 *           filters?: Record<string, Set<string>> | null, parts?: Map<string, Set<string>> | null,
 *           when?: string, round?: { has(id: string): boolean, label: string } | null }} o
 * @returns {{ total: number, shown: number, ids: string[], labels: Map<string, string>,
 *             values: Record<string, string[]>, counts: Record<string, Map<string, number>>, sets: Record<string, number>,
 *             groups: { key: string, title: string, items: ({ type: "model", id: string } | { type: "line", key: string, title: string,
 *               team: string, all: number, ids: string[], parts: { part: string, n: number }[] })[] }[],
 *             away: { title: string, ids: string[] } | null }}
 */
export function browse(manifest, { target, season, query = "", sel = null, set = "all", filters = null, parts = null, when = "season", round = null }) {
  const cat = catalog(manifest, target);
  const { lines, of } = linesOf(manifest, cat);
  const m = (id) => manifest.modelById.get(id) || {};
  const { words, tokens } = parseQuery(query);
  const match = matcher(manifest, cat, words.join(" "), sel);
  const starts = (v, value) => lower(v).split(/[\s\-_/·]+/).some((w) => w.startsWith(value)) || lower(v).startsWith(value);
  const typed = (id) => tokens.every(({ key, value }) => cat.facets.get(id)[key]?.some((v) => starts(v, value)));
  const found = (id) => (!match || match(id)) && typed(id);
  const recommended = new Set(manifest.recommended || []), selected = new Set(sel?.selected || []);
  const inSet = {
    all: () => true,
    designated: (id) => !!m(id).designated,
    recommended: (id) => recommended.has(id),
    selected: (id) => selected.has(id),
  };
  const setOk = inSet[set] || inSet.all;
  const active = RAIL.filter((f) => filters?.[f.key]?.size);
  const kept = (id, skip) => active.every((f) => f.key === skip || cat.facets.get(id)[f.key].some((v) => filters[f.key].has(v)));
  const out = when === "any" ? () => false
    : when === "round" && round ? (id) => !round.has(id)
    : (id) => { const s = m(id).seasons; return !!season && Array.isArray(s) && !s.includes(season); };

  const counts = {};
  for (const { key } of RAIL) {
    const n = new Map();
    for (const id of cat.ids) if (!out(id) && found(id) && setOk(id) && kept(id, key)) for (const v of cat.facets.get(id)[key]) n.set(v, (n.get(v) || 0) + 1);
    counts[key] = n;
  }
  const sets = {};
  for (const k of Object.keys(SETS)) { let n = 0; for (const id of cat.ids) if (!out(id) && found(id) && kept(id) && inSet[k](id)) n++; sets[k] = n; }

  const pass = (id) => found(id) && setOk(id) && kept(id);
  const byName = (a, b) => collate(cat.labels.get(a), cat.labels.get(b));
  const ids = cat.ids.filter((id) => !out(id) && pass(id));
  const shownSet = new Set(ids);

  // sections by source: this repo, local, combined here, then each hub in the manifest's order
  const srcRank = (id) => { const s = m(id).source; return s === "repo" ? 0 : s === "local" ? 1 : s === "synthetic" ? 2 : 3 + Math.max(0, (manifest.hubs || []).findIndex((x) => x.id === m(id).hub)); };
  const bySrc = new Map();
  for (const id of ids) {
    const k = `${srcRank(id)}|${cat.facets.get(id).source[0]}`;
    if (!bySrc.has(k)) bySrc.set(k, []);
    bySrc.get(k).push(id);
  }
  const groups = [...bySrc].sort((a, b) => parseInt(a[0]) - parseInt(b[0])).map(([k, list]) => {
    const items = [], seen = new Set();
    for (const id of list.sort(byName)) {
      const lk = of.get(id);
      if (!lk) { items.push({ type: "model", id, sort: cat.labels.get(id) }); continue; }
      if (seen.has(lk)) continue;
      seen.add(lk);
      const line = lines.get(lk), members = line.ids.filter((x) => shownSet.has(x));
      if (members.length < 2) { items.push({ type: "model", id, sort: cat.labels.get(id) }); continue; }
      // the parts that tell these variants apart (not ones every variant has), most common first
      const n = new Map();
      for (const x of members) for (const p of new Set(nameParts(m(x)))) n.set(p, (n.get(p) || 0) + 1);
      const ps = [...n].filter(([, c]) => c < members.length).sort((a, b) => b[1] - a[1] || collate(a[0], b[0])).slice(0, 24).map(([part, c]) => ({ part, n: c }));
      const want = parts?.get(lk);
      const vis = want?.size ? members.filter((x) => { const own = new Set(nameParts(m(x))); return [...want].every((p) => own.has(p)); }) : members;
      items.push({ type: "line", key: lk, title: line.title, team: line.team, all: members.length, ids: vis.sort(byName), parts: ps, sort: line.title });
    }
    items.sort((a, b) => (b.type === "line") - (a.type === "line") || collate(a.sort, b.sort));
    return { key: k, title: k.split("|")[1], items };
  });

  const gone = cat.ids.filter((id) => out(id) && pass(id)).sort(byName);
  const away = gone.length ? { title: when === "round" && round ? `No forecast ${round.label}` : `Not in ${manifest.seasonById?.get(season)?.label || season}`, ids: gone } : null;
  return { total: cat.ids.length, shown: ids.length, ids, labels: cat.labels, values: cat.values, counts, sets, groups, away };
}

/**
 * A model row's second line: its readable name when the metadata has one, else team · family; kind when
 * not individual; the data it uses, short.
 * @param {object} m a manifest model
 * @returns {string}
 */
export function rowLine(m) {
  const bits = [];
  bits.push(m.name || [m.team, m.family].filter(Boolean).join(" · ") || m.id);
  if (m.kind === "ensemble" && !/ensemble/i.test(bits[0])) bits.push("ensemble");
  return bits.join(" · ");
}

const marks = new WeakMap(); // manifest → Set of ids whose "designated" tells them apart within their team
/** Designated models of teams that also have models that aren't (where the mark says something). */
export function designatedMarks(manifest) {
  let s = marks.get(manifest);
  if (s) return s;
  const teams = new Map();
  for (const m of manifest.models || []) {
    const k = `${m.source}|${m.hub}|${m.team}`;
    if (!teams.has(k)) teams.set(k, { yes: [], no: 0 });
    if (m.designated) teams.get(k).yes.push(m.id); else teams.get(k).no++;
  }
  s = new Set([...teams.values()].filter((t) => t.no > 0).flatMap((t) => t.yes));
  marks.set(manifest, s);
  return s;
}

/** "2023–24 – 2025–26", or one season. */
function span(manifest, seasons) {
  if (!seasons?.length) return "";
  const lab = (s) => manifest.seasonById?.get(s)?.label || s;
  const ss = [...seasons].sort();
  return ss.length === 1 ? lab(ss[0]) : `${lab(ss[0])} – ${lab(ss.at(-1))}`;
}

/* ================================================================ the panel */

const ITEMS = ".pk-name, .mb-lhead";
const details = new Map(); // id → methods text (or "" when none), fetched on first preview
const parts0 = new Map(); // a line's chosen name parts, for the session
const open0 = new Set(); // lines opened, for the session
const rail0 = Object.fromEntries(RAIL.map((f) => [f.key, new Set()]));
const state0 = { set: "all", when: "season", awayOpen: false };
let lastPickerHub = null;

function resetPickerSession() {
  details.clear();
  parts0.clear();
  open0.clear();
  for (const s of Object.values(rail0)) s.clear();
  state0.set = "all"; state0.when = "season"; state0.awayOpen = false;
}
registerCacheClear(() => { lastPickerHub = null; resetPickerSession(); });

/**
 * Open the model picker from the Models bubble (or close it, if it is open from there).
 * @param {HTMLElement} anchor the Models bubble
 * @param {{ manifest: object, store: object, chart?: object | null }} ctx
 * @returns {object | null} the layer, or null when this call closed it
 */
export function openModelPicker(anchor, { manifest, store, chart = null }) {
  const hubKey = manifest?.hub_id || "";
  if (lastPickerHub !== null && lastPickerHub !== hubKey) resetPickerSession();
  lastPickerHub = hubKey;
  const inset = () => tokenNum("--inset", 16);
  const seasonNow = () => manifest.seasonOf(store.get().date);
  let season = seasonNow(), query = "", g = null, hover = null, roundKey = "", lastClicked = null, order = [];
  const offs = [];
  let els = null;
  const width = () => Math.round(Math.min(innerWidth * 0.64, 1060));

  function roundNow() {
    const st = store.get(), fan = chart?.fan, week = chart?.week?.();
    if (!fan || fan.target !== st.target || fan.season !== season) return { key: "", round: null };
    const di = fan.indexOf(toIso(week));
    if (di < 0) return { key: "", round: null };
    return { key: `${fan.location}|${fan.season}|${fan.target}|${di}`, round: { has: (id) => fan.has(id, di), label: fmtDay(fan.dates[di]) }, fan, di };
  }

  const layer = openPopover(anchor, {
    morph: true, timeKeys: true, className: "pk-panel mb-panel", width: width(),
    onClose() { offs.forEach((off) => off()); chart?.setInset(0); chart?.preview(false); },
    content(body, lay) {
      const input = h("input", { type: "search", autocomplete: "off", spellcheck: "false", "aria-label": "Search models" });
      const when = h("div", { class: "mb-when", role: "radiogroup", "aria-label": "When" },
        ...Object.entries(WHEN).map(([k, t]) => h("button", { type: "button", role: "radio", "data-when": k }, t)));
      const base = h("button", { type: "button", class: "pk-base", role: "checkbox" }, h("span", { class: "c-check" }), "Baseline");
      const suggest = h("div", { class: "mb-suggest", hidden: true });
      const rail = h("nav", { class: "mb-rail", "aria-label": "Filters" });
      const bar = h("div", { class: "mb-bar" });
      const list = h("div", { class: "mb-list", role: "group", "aria-label": "Models" });
      const results = h("div", { class: "mb-results" }, bar, list);
      const preview = h("aside", { class: "mb-preview", "aria-live": "polite" });
      const tray = h("div", { class: "pk-tray", role: "list", "aria-label": "Selected models" });
      const count = h("span", { class: "pk-count" });
      const combine = h("button", { type: "button", class: "c-link pk-combine", hidden: true, onclick: () => {
        lay.close(false);
        import("./Ensemble.js").then((x) => x.openCombine(anchor, { manifest, store })).catch((err) => console.error("viz: Combine could not open", err));
      } }, "Combine…");
      const reset = h("button", { type: "button", class: "c-link", onclick: () => {
        const st = store.get(), sel = st.sel;
        const baseId = manifest.baselineFor?.(st.target, season) ?? manifest.baseline;
        const picks = (manifest.recommended || []).filter((id) => id !== baseId && manifest.modelById.has(id)).slice(0, 3);
        setSel(S.create({ selected: picks, showAll: sel.showAll, baseline: sel.baseline }));
      } }, "Reset");
      const foot = h("div", { class: "pk-foot" }, tray, h("div", { class: "pk-foot-line" }, count, h("span", { class: "pk-acts" }, combine, reset)));
      body.append(
        h("div", { class: "pk-head mb-head" }, h("label", { class: "c-search", html: icon.search }, input), when, base),
        suggest,
        h("div", { class: "mb-body" }, rail, results, preview),
        foot);
      els = { panel: lay.panel, input, when, base, suggest, rail, bar, list, preview, tray, count, combine };
      wire();
      render(true);
    },
  });
  if (!layer) return null;
  chart?.preview(true);
  chart?.setInset(inset() + width() + tokenNum("--space-24", 24));
  return layer;

  /* ---------------- rendering ---------------- */

  function setSel(next) { store.set({ sel: next }); }

  function render(resetScroll = false) {
    const r = roundNow();
    roundKey = r.key;
    const sel = store.get().sel;
    g = browse(manifest, { target: store.get().target, season, query, sel, set: state0.set, filters: rail0, parts: parts0, when: state0.when, round: state0.when === "round" ? r.round : null });
    const keep = focusKey(), top = resetScroll ? 0 : els.list.scrollTop;
    els.input.placeholder = `Search ${g.total} models`;
    for (const b of els.when.children) b.setAttribute("aria-checked", String(b.dataset.when === state0.when));
    els.base.setAttribute("aria-checked", String(sel.baseline));
    renderRail();
    renderBar(sel);
    renderList(sel, r);
    renderTray(sel);
    renderPreview();
    els.list.scrollTop = top;
    restoreFocus(keep);
  }

  function opt(attrs, label, n, on, cls) {
    return h("button", { type: "button", class: ["mb-opt", cls, on && "on", !n && !on && "is-zero"], "aria-pressed": String(!!on), ...attrs },
      h("span", { class: "mb-opt-label" }, label), h("span", { class: "mb-opt-n" }, n ? String(n) : ""));
  }

  function renderRail() {
    if (state0.set === "recommended" && !g.sets.recommended) state0.set = "all";
    const any = RAIL.some((f) => rail0[f.key].size) || state0.set !== "all";
    const setEntries = Object.entries(SETS).filter(([k]) => k !== "recommended" || g.sets[k] > 0 || state0.set === k);
    const blocks = [h("div", { class: "mb-rail-block" },
      h("div", { class: "mb-rail-title" }, h("span", null, "Sets"), any ? h("button", { type: "button", class: "c-link", "data-clear": "" }, "Clear") : null),
      ...setEntries.map(([k, t]) => opt({ "data-set": k }, t, g.sets[k], state0.set === k)))];
    for (const f of RAIL) {
      const set = rail0[f.key], n = g.counts[f.key];
      const vals = g.values[f.key].filter((v) => n.get(v) || set.has(v));
      if (!vals.length) continue;
      blocks.push(h("div", { class: "mb-rail-block" }, h("div", { class: "mb-rail-title" }, h("span", null, f.label)),
        ...vals.map((v) => opt({ "data-facet": f.key, "data-v": v }, v, n.get(v) || 0, set.has(v)))));
    }
    els.rail.replaceChildren(...blocks);
  }

  function renderBar(sel) {
    els.shownIds = g.ids;
    els.bar.replaceChildren(
      h("span", { class: "mb-shown" }, g.shown === g.total ? `${g.total} models` : `${g.shown} of ${g.total}`),
      h("span", { class: "mb-bar-acts" },
        h("button", { type: "button", class: "c-link", "data-all": "", disabled: !g.shown || null }, g.shown === g.total ? "Select all" : `Select ${g.shown}`),
        h("button", { type: "button", class: "c-link", "data-none": "", disabled: !sel.selected.length || null }, "Clear all")));
  }

  function row(id, sel, r, child) {
    const m = manifest.modelById.get(id) || { id }, label = g.labels.get(id) || manifest.label(id);
    const picked = sel.selected.includes(id), slot = S.slotOf(sel, id), grey = sel.showAll && picked && slot == null;
    const note = r.fan && !r.fan.has(id, r.di) && (m.seasons || []).includes(season) ? `no forecast ${fmtDay(r.fan.dates[r.di])}` : "";
    const name = h("button", { type: "button", class: "c-row two pk-name", role: "checkbox", tabindex: "-1", "aria-checked": String(picked) },
      h("span", { class: "c-row-lead" }),
      h("span", { class: "c-row-text" },
        h("span", { class: "mb-name-line" }, slideText(child ? nameParts(m).join("_") || label : label, "c-row-name"), designatedMarks(manifest).has(id) ? h("span", { class: "mb-tag" }, "designated") : null),
        h("span", { class: "c-row-sub" }, rowLine(m), note ? h("span", { class: "pk-miss" }, ` · ${note}`) : null)),
      h("span", { class: "c-row-check", html: icon.check }));
    const dot = h("button", { type: "button", class: ["pk-dot", slot != null && "on", grey && "grey"], tabindex: "-1", style: slot == null ? null : { "--c": `var(--series-${(slot % S.COLORS) + 1})` },
      "aria-label": slot != null ? `Take off the chart: ${label}` : `Put on the chart: ${label}` }, h("i"));
    const info = h("button", { type: "button", class: "pk-info", tabindex: "-1", "data-model-sheet": id, "aria-label": `${label} · details`, title: "Details", html: icon.open });
    order.push(id);
    return h("div", { class: ["pk-row c-slide-host", child && "mb-child"], "data-id": id }, dot, name, info);
  }

  function renderList(sel, r) {
    order = [];
    const frag = document.createDocumentFragment();
    const on = new Set(sel.selected);
    for (const grp of g.groups) {
      frag.append(h("div", { class: "mb-group" }, h("span", null, grp.title), h("span", { class: "c-section-count" }, String(grp.items.reduce((n, it) => n + (it.type === "line" ? it.all : 1), 0)))));
      for (const it of grp.items) {
        if (it.type === "model") { frag.append(row(it.id, sel, r, false)); continue; }
        const open = open0.has(it.key) || !!query, n = it.ids.filter((x) => on.has(x)).length, all = it.ids.length && n === it.ids.length;
        const chosen = parts0.get(it.key) || new Set();
        frag.append(h("div", { class: ["mb-line", open && "is-open"], "data-line": it.key },
          h("button", { type: "button", class: "mb-lhead", tabindex: "-1", "aria-expanded": String(open), html: icon.chevronDown },
            h("span", { class: "mb-ltext" },
              h("span", { class: "mb-ltitle" }, it.title, h("span", { class: "mb-lcount" }, it.ids.length === it.all ? `${it.all} variants` : `${it.ids.length} of ${it.all} variants`)),
              h("span", { class: "c-row-sub" }, [it.team, n ? `${n} selected` : null].filter(Boolean).join(" · ")))),
          h("button", { type: "button", class: "c-link mb-lall", tabindex: "-1", "data-lall": it.key }, all ? "Deselect" : it.ids.length === it.all ? "Select all" : `Select ${it.ids.length}`)));
        if (!open) continue;
        if (it.parts.length) frag.append(h("div", { class: "mb-parts", "data-line": it.key },
          ...it.parts.map((p) => h("button", { type: "button", class: ["c-chip mb-part", chosen.has(p.part) && "on"], "aria-pressed": String(chosen.has(p.part)), "data-part": p.part }, p.part, h("span", { class: "mb-opt-n" }, String(p.n))))));
        for (const id of it.ids) frag.append(row(id, sel, r, true));
      }
    }
    if (g.away) {
      frag.append(h("button", { type: "button", class: "mb-group mb-away", "aria-expanded": String(state0.awayOpen), "data-away": "", html: icon.chevronDown }, h("span", null, g.away.title), h("span", { class: "c-section-count" }, String(g.away.ids.length))));
      if (state0.awayOpen) for (const id of g.away.ids) frag.append(row(id, sel, r, false));
    }
    if (!g.groups.length && !g.away) frag.append(h("div", { class: "pk-empty" }, "No models match"));
    els.list.replaceChildren(frag);
  }

  function renderTray(sel) {
    const slots = new Map(sel.charted.map((c) => [c.id, c.slot]));
    const ids = [...[...sel.charted].sort((a, b) => a.slot - b.slot).map((c) => c.id), ...sel.selected.filter((id) => !slots.has(id))];
    els.tray.replaceChildren(...ids.map((id) => {
      const label = g.labels.get(id) || manifest.label(id), slot = slots.get(id);
      return h("span", { class: "pk-tchip", role: "listitem", "data-id": id },
        h("button", { type: "button", class: "pk-tname", title: slot == null ? "Put on the chart" : "Take off the chart" },
          h("i", { class: slot == null ? null : "on", style: slot == null ? null : { "--c": `var(--series-${(slot % S.COLORS) + 1})` } }), h("span", null, label)),
        h("button", { type: "button", class: "pk-tx", "aria-label": `Deselect ${label}`, html: icon.close }));
    }));
    els.tray.hidden = !ids.length;
    const n = sel.selected.length, c = sel.charted.length;
    els.count.textContent = `${n} selected · ${c} charted`;
    els.combine.hidden = n < 2;
  }

  /* ---------------- the preview ---------------- */

  function renderPreview() {
    const p = els.preview, sel = store.get().sel;
    if (hover?.line) {
      const it = g.groups.flatMap((x) => x.items).find((x) => x.type === "line" && x.key === hover.line);
      if (it) {
        p.replaceChildren(
          h("div", { class: "mb-pv-kicker" }, `${it.team} · line`),
          h("div", { class: "mb-pv-title" }, it.title),
          h("div", { class: "mb-pv-sub" }, `${it.all} variants${it.ids.length !== it.all ? ` · ${it.ids.length} shown` : ""}`),
          it.parts.length ? h("div", { class: "mb-pv-block" }, h("div", { class: "mb-pv-label" }, "Told apart by"), h("div", { class: "mb-pv-tags" }, ...it.parts.slice(0, 14).map((x) => h("span", { class: "mb-pv-tag" }, x.part)))) : null,
          h("div", { class: "mb-pv-acts" }, h("button", { type: "button", class: "c-link", "data-lall": it.key }, it.ids.every((x) => sel.selected.includes(x)) ? "Deselect all" : `Select ${it.ids.length}`)));
        return;
      }
    }
    const id = hover?.id;
    const m = id && manifest.modelById.get(id);
    if (!m) {
      p.replaceChildren(h("div", { class: "mb-pv-empty" }, h("div", { class: "mb-pv-title" }, `${g.shown} models`)));
      return;
    }
    const label = g.labels.get(id) || manifest.label(id), picked = sel.selected.includes(id), charted = S.isCharted(sel, id);
    const meth = h("div", { class: "mb-pv-method" }, details.has(id) ? details.get(id) : "");
    if (!details.has(id) && m.has_metadata) {
      import("../sections/scores/data.js").then((x) => x.loadDetails(id)).then((d) => {
        const t = String(d?.metadata?.methods || "").trim();
        const same = m.name && lower(t).replace(/[^a-z0-9]/g, "").startsWith(lower(m.name).replace(/[^a-z0-9]/g, "").slice(0, 24)) && t.length < m.name.length + 24;
        details.set(id, t && t !== "None" && !same ? t : "");
        if (hover?.id === id) meth.textContent = details.get(id);
      }).catch(() => details.set(id, ""));
    }
    const facts = [
      ["Team", m.team_name && m.team_name !== m.id ? m.team_name : m.team],
      ["Kind", m.kind ? m.kind[0].toUpperCase() + m.kind.slice(1) : ""],
      ["Seasons", span(manifest, m.seasons)],
      ["Rounds", m.rounds ? String(m.rounds) : ""],
      ["Source", manifest.sourceLabel(m) || "This repo"],
    ].filter(([, v]) => v);
    p.replaceChildren(
      h("div", { class: "mb-pv-kicker" }, [m.team, designatedMarks(manifest).has(id) ? "designated" : null].filter(Boolean).join(" · ")),
      h("div", { class: "mb-pv-title" }, label),
      m.name ? h("div", { class: "mb-pv-sub" }, m.name) : null,
      m.inputs?.length ? h("div", { class: "mb-pv-tags" }, ...m.inputs.map((x) => h("span", { class: "mb-pv-tag" }, INPUT_SHORT[x] || x))) : null,
      meth,
      h("dl", { class: "mb-pv-facts" }, ...facts.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)])),
      h("div", { class: "mb-pv-acts" },
        h("button", { type: "button", class: "c-link", "data-pv-sel": id }, picked ? "Deselect" : "Select"),
        h("button", { type: "button", class: "c-link", "data-pv-chart": id }, charted ? "Take off chart" : "Chart"),
        h("button", { type: "button", class: "c-link", "data-model-sheet": id }, "Open page →")));
  }

  function setHover(next) {
    if ((next?.id || null) === (hover?.id || null) && (next?.line || null) === (hover?.line || null)) return;
    hover = next;
    renderPreview();
  }

  /* ---------------- suggestions ---------------- */

  function renderSuggest() {
    const w = lower(query.split(/\s+/).at(-1) || "");
    const out = [];
    if (w.length >= 2 && !w.includes(":")) {
      for (const f of RAIL) {
        const n = g.counts[f.key];
        for (const v of g.values[f.key]) {
          if (rail0[f.key].has(v) || !(n.get(v) > 0)) continue;
          if (lower(v).split(/[\s\-_/·]+/).some((x) => x.startsWith(w)) || lower(v).startsWith(w)) out.push({ key: f.key, label: f.label, v, n: n.get(v) });
        }
      }
    }
    out.sort((a, b) => b.n - a.n);
    els.suggest.hidden = !out.length;
    els.suggest.replaceChildren(...out.slice(0, 5).map((s) => h("button", { type: "button", class: "c-chip mb-sg", "data-facet": s.key, "data-v": s.v },
      h("span", { class: "mb-sg-k" }, s.label), h("span", null, s.v), h("span", { class: "mb-opt-n" }, String(s.n)))));
  }

  /* ---------------- focus ---------------- */

  function items() { return [...els.list.querySelectorAll(ITEMS)]; }
  function rove(el) { for (const x of els.list.querySelectorAll("[tabindex='0']")) if (x !== el) x.tabIndex = -1; if (el) el.tabIndex = 0; }
  function go(el) { if (!el) return; rove(el); el.focus({ preventScroll: true }); revealInList(el.closest(".pk-row, .mb-line") || el); }
  function keyOf(el) { const r = el?.closest?.(".pk-row"); return r ? { id: r.dataset.id } : el?.closest?.(".mb-line") ? { line: el.closest(".mb-line").dataset.line } : null; }
  function focusKey() {
    const a = document.activeElement;
    if (els.list.contains(a)) return { focus: keyOf(a) };
    const r = els.list.querySelector("[tabindex='0']");
    return r ? { rove: keyOf(r) } : null;
  }
  function find(k) {
    if (!k) return null;
    if (k.id) return els.list.querySelector(`.pk-row[data-id="${CSS.escape(k.id)}"] .pk-name`);
    return els.list.querySelector(`.mb-line[data-line="${CSS.escape(k.line)}"] .mb-lhead`);
  }
  function restoreFocus(keep) {
    const el = find(keep?.focus || keep?.rove) || items()[0] || null;
    rove(el);
    if (keep?.focus && el) el.focus({ preventScroll: true });
  }

  /* ---------------- input ---------------- */

  function toggleRow(id, shift) {
    const sel = store.get().sel;
    if (shift && lastClicked && lastClicked !== id) {
      const a = order.indexOf(lastClicked), b = order.indexOf(id);
      if (a >= 0 && b >= 0) { setSel(S.setMany(sel, order.slice(Math.min(a, b), Math.max(a, b) + 1), !S.isSelected(sel, id))); lastClicked = id; return; }
    }
    setSel(S.toggle(sel, id));
    lastClicked = id;
  }
  function lineIds(key) { return g.groups.flatMap((x) => x.items).find((x) => x.type === "line" && x.key === key)?.ids || []; }
  function toggleLine(key) {
    const sel = store.get().sel, ids = lineIds(key);
    setSel(S.setMany(sel, ids, !ids.every((x) => sel.selected.includes(x))));
  }
  function pickFacet(key, v, add) {
    const set = rail0[key];
    if (add) set.has(v) ? set.delete(v) : set.add(v);
    else if (set.size === 1 && set.has(v)) set.clear();
    else { set.clear(); set.add(v); }
    render(true);
  }

  function wire() {
    const { input, when, base, suggest, rail, bar, list, preview, tray, panel } = els;
    offs.push(
      store.select(["sel"], () => render()),
      store.select(["target"], () => render(true)),
      store.select(["date"], () => { const now = seasonNow(); if (now !== season) { season = now; render(); } else if (roundNow().key !== roundKey) render(); }),
      chart?.onWeekChange ? chart.onWeekChange(() => { const now = seasonNow(); if (now !== season) season = now; if (roundNow().key !== roundKey) render(); }) : () => {},
      on(window, "resize", () => { panel.style.width = `${width()}px`; chart?.setInset(inset() + width() + tokenNum("--space-24", 24)); }),
    );
    input.addEventListener("input", () => { query = input.value.trim(); render(true); renderSuggest(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); go(items()[0]); }
      else if (e.key === "Enter" && !suggest.hidden) { e.preventDefault(); suggest.querySelector("button")?.click(); }
    });
    suggest.addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      // the word becomes the filter
      query = query.split(/\s+/).slice(0, -1).join(" ");
      input.value = query;
      rail0[t.dataset.facet].add(t.dataset.v);
      render(true); renderSuggest();
      input.focus();
    });
    when.addEventListener("click", (e) => { const t = e.target.closest("[data-when]"); if (t) { state0.when = t.dataset.when; render(true); } });
    base.addEventListener("click", () => { const sel = store.get().sel; setSel(S.setBaseline(sel, !sel.baseline)); });
    rail.addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.clear != null) { for (const f of RAIL) rail0[f.key].clear(); state0.set = "all"; render(true); return; }
      if (t.dataset.set) { state0.set = state0.set === t.dataset.set ? "all" : t.dataset.set; render(true); return; }
      if (t.dataset.facet) pickFacet(t.dataset.facet, t.dataset.v, e.metaKey || e.ctrlKey || e.shiftKey);
    });
    bar.addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      const sel = store.get().sel;
      if (t.dataset.all != null) setSel(S.setMany(sel, g.ids, true));
      else if (t.dataset.none != null) setSel(S.setMany(sel, sel.selected, false));
    });
    list.addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      const id = t.closest(".pk-row")?.dataset.id, lk = t.closest("[data-line]")?.dataset.line;
      if (t.classList.contains("pk-dot")) setSel(S.toggleChart(store.get().sel, id));
      else if (t.classList.contains("pk-name")) toggleRow(id, e.shiftKey);
      else if (t.classList.contains("mb-lhead")) { open0.has(lk) ? open0.delete(lk) : open0.add(lk); render(); }
      else if (t.dataset.lall) toggleLine(t.dataset.lall);
      else if (t.dataset.part) {
        if (!parts0.has(lk)) parts0.set(lk, new Set());
        const s = parts0.get(lk);
        s.has(t.dataset.part) ? s.delete(t.dataset.part) : s.add(t.dataset.part);
        render();
      } else if (t.dataset.away != null) { state0.awayOpen = !state0.awayOpen; render(); }
    });
    // the preview follows the pointer and the keyboard
    list.addEventListener("pointerover", (e) => {
      const r = e.target.closest(".pk-row"), l = e.target.closest(".mb-line");
      if (r) setHover({ id: r.dataset.id }); else if (l) setHover({ line: l.dataset.line });
    });
    list.addEventListener("focusin", (e) => {
      if (e.target.matches(ITEMS)) rove(e.target);
      const k = keyOf(e.target);
      if (k) setHover(k.id ? { id: k.id } : { line: k.line });
    });
    preview.addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      const sel = store.get().sel;
      if (t.dataset.pvSel) setSel(S.toggle(sel, t.dataset.pvSel));
      else if (t.dataset.pvChart) setSel(S.toggleChart(sel, t.dataset.pvChart));
      else if (t.dataset.lall) toggleLine(t.dataset.lall);
    });
    tray.addEventListener("click", (e) => {
      const t = e.target.closest("button"), id = t?.closest(".pk-tchip")?.dataset.id;
      if (!id) return;
      const sel = store.get().sel;
      setSel(t.classList.contains("pk-tx") ? S.deselect(sel, id) : S.toggleChart(sel, id));
    });
    list.addEventListener("keydown", (e) => {
      const all = items(), i = all.indexOf(document.activeElement), a = document.activeElement;
      const id = a?.closest?.(".pk-row")?.dataset.id, lk = a?.classList?.contains("mb-lhead") ? a.closest(".mb-line").dataset.line : null;
      if (e.key === "ArrowDown") { e.preventDefault(); go(all[Math.min(all.length - 1, i + 1)]); }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (i <= 0) input.focus(); else go(all[i - 1]); }
      else if (e.key === "Home") { e.preventDefault(); go(all[0]); }
      else if (e.key === "End") { e.preventDefault(); go(all.at(-1)); }
      else if (lk && (e.key === "ArrowRight" || e.key === "ArrowLeft")) { e.preventDefault(); e.stopPropagation(); const open = e.key === "ArrowRight"; if (open !== open0.has(lk)) { open ? open0.add(lk) : open0.delete(lk); render(); } }
      else if (lk && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); if (e.key === " ") toggleLine(lk); else { open0.has(lk) ? open0.delete(lk) : open0.add(lk); render(); } }
      else if (id && e.key === "Enter") { e.preventDefault(); setSel(S.toggleChart(store.get().sel, id)); }
      else if (id && e.key === " ") { e.preventDefault(); if (!e.repeat) toggleRow(id, e.shiftKey); }
      else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) input.focus();
    });
    list.addEventListener("keyup", (e) => { if (e.key === " ") e.preventDefault(); });
  }
}
