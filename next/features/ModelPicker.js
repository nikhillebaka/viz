/* The model picker: which models are selected (evaluated) and which five are charted.
 *
 * A panel that morphs out of the Models bubble and takes the left of the screen at full height: two
 * columns and half the viewport when more than ONE_COLUMN_MAX rows show, else one column and a quarter.
 * The list is built from the manifest and rebuilt only when the search, a collapse, the target or the
 * season changes; selection changes update rows in place (scroll and focus stay, 200 rows stay fast);
 * the chart's round only touches the "no forecast" notes.
 *
 * groupModels(), subLine(), matcher() and panelWidth() are pure, for node tests. */
import { h, on, tokenNum, storage } from "../lib/dom.js";
import { openPopover, revealInList } from "../ui/floating.js";
import { icon, slideText } from "../ui/controls.js";
import { toIso } from "../lib/scale.js";
import { fmtDay } from "../lib/format.js";
import * as S from "./selection.js";

/** More rows than this showing → two columns, half the viewport. */
export const ONE_COLUMN_MAX = 24;
/** A family of this hub's own models gets its own section from this many members. */
export const FAMILY_MIN = 3;

const collate = new Intl.Collator("en", { numeric: true, sensitivity: "base" }).compare;
const isLocal = (m) => m.source === "local" || m.source === "synthetic";
const lower = (s) => String(s ?? "").toLowerCase();

/* Sections the user opened or closed, by key, for the session (true = collapsed). */
const collapsed = new Map();

/** The filters, in chip order. Each model has one or more values per filter (Data: every input it lists). */
export const FACETS = Object.freeze([
  { key: "source", label: "Source" },
  { key: "family", label: "Family" },
  { key: "team", label: "Team" },
  { key: "kind", label: "Kind" },
  { key: "input", label: "Data" },
]);
const KIND = { individual: "Individual", ensemble: "Ensemble", baseline: "Baseline" };
// typed search: "team:umass", "data:nssp"; keys and their spellings
const TOKEN = { team: "team", family: "family", fam: "family", source: "source", src: "source", hub: "source", kind: "kind", type: "kind", data: "input", input: "input", inputs: "input" };
export const GROUPS = Object.freeze({ source: "Source", family: "Family", team: "Team", none: "None" });
export const SORTS = Object.freeze({ name: "A–Z", recent: "Latest forecast", rounds: "Most rounds" });
export const WHEN = Object.freeze({ season: "This season", round: "This round", any: "Any time" });

/* ================================================================ pure: the catalog */

const catalogs = new WeakMap(); // manifest → Map<target, catalog>

/**
 * Everything about the listed models that depends only on the manifest and the target: who is listed
 * (the baseline never; models whose targets lack this one neither), display names unique among them,
 * search text, and the section structure before season and search.
 * @param {object} manifest an indexed manifest (lib/api.js)
 * @param {string} target
 * @returns {{ ids: string[], labels: Map<string, string>, hay: Map<string, string>,
 *             groups: { key: string, title: string, kind: string, ids: string[] }[] }} cached per target
 */
export function catalog(manifest, target) {
  let byTarget = catalogs.get(manifest);
  if (!byTarget) catalogs.set(manifest, (byTarget = new Map()));
  let c = byTarget.get(target);
  if (c) return c;

  const listed = (manifest.models || []).filter((m) => m.id !== manifest.baseline && (!m.targets?.length || m.targets.includes(target)));
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
  for (const { key } of FACETS) {
    const n = new Map();
    for (const id of ids) for (const v of facets.get(id)[key]) n.set(v, (n.get(v) || 0) + 1);
    const tail = (v) => (v === LAST) * 2 + (v === OTHER);
    values[key] = [...n].sort((a, b) => tail(a[0]) - tail(b[0]) || b[1] - a[1] || collate(a[0], b[0])).map(([v]) => v);
  }
  // by the model's own name, so "UMass-AR2" (made unique with its team) still sorts as AR2
  const byName = (a, b) => collate(a.abbr || a.id, b.abbr || b.id) || collate(labels.get(a.id), labels.get(b.id)) || collate(a.id, b.id);

  const groups = [];
  const local = listed.filter(isLocal).sort(byName);
  if (local.length) groups.push({ key: "local", title: "Local", kind: "local", ids: local.map((m) => m.id) });

  // this hub's own models: a section per family of FAMILY_MIN or more (largest first), the rest in Other
  const own = listed.filter((m) => !isLocal(m) && m.source !== "hub");
  const fams = new Map();
  for (const m of own) { const f = m.family || ""; if (!fams.has(f)) fams.set(f, []); fams.get(f).push(m); }
  const big = [...fams].filter(([f, ms]) => f && ms.length >= FAMILY_MIN).sort((a, b) => b[1].length - a[1].length || collate(a[0], b[0]));
  for (const [f, ms] of big) groups.push({ key: `family:${f}`, title: f, kind: "family", ids: ms.sort(byName).map((m) => m.id) });
  const bigSet = new Set(big.map(([f]) => f));
  const other = own.filter((m) => !bigSet.has(m.family || "")).sort(byName);
  if (other.length) groups.push({ key: "other", title: "Other", kind: "other", ids: other.map((m) => m.id) });

  // one section per synced hub: the hub's own models, then designated ones, then the rest
  const hubs = new Map();
  for (const m of listed) if (m.source === "hub") { const k = m.hub || ""; if (!hubs.has(k)) hubs.set(k, []); hubs.get(k).push(m); }
  const hubOrder = [...hubs.keys()].sort((a, b) => {
    const ia = (manifest.hubs || []).findIndex((x) => x.id === a), ib = (manifest.hubs || []).findIndex((x) => x.id === b);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || collate(a, b);
  });
  for (const k of hubOrder) {
    const hub = manifest.hubById?.get(k), title = hub?.short_label || hub?.label || k || "Hub", t = lower(title);
    const rank = (m) => (lower(m.team) === t ? 0 : m.designated ? 1 : 2);
    const ms = hubs.get(k).sort((a, b) => rank(a) - rank(b) || collate(a.team || "", b.team || "") || byName(a, b));
    groups.push({ key: `hub:${k}`, title, kind: "hub", ids: ms.map((m) => m.id) });
  }

  // the other ways to group: by family (largest first) or by team (A–Z), each sorted by name; or one list
  const by = (key, order) => {
    const m = new Map();
    for (const x of [...listed].sort(byName)) { const v = facets.get(x.id)[key][0]; if (!m.has(v)) m.set(v, []); m.get(v).push(x.id); }
    return [...m].sort(order).map(([v, list]) => ({ key: `${key}:${v}`, title: v, kind: key, ids: list }));
  };
  const lastly = (a, b) => (a[0] === LAST || a[0] === OTHER) - (b[0] === LAST || b[0] === OTHER);
  const layouts = {
    source: groups,
    family: by("family", (a, b) => lastly(a, b) || b[1].length - a[1].length || collate(a[0], b[0])),
    team: by("team", (a, b) => lastly(a, b) || collate(a[0], b[0])),
    none: [{ key: "all", title: "All models", kind: "all", ids: [...listed].sort(byName).map((m) => m.id) }],
  };

  c = Object.freeze({ ids, labels, hay, groups, facets, values, layouts });
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

const seasonSpans = new WeakMap(); // manifest → Map<season, [first index, count]> into every season's rounds in order

/**
 * Which of a season's rounds a model forecast, from the manifest's coverage mask (core/next_api.py _mask).
 * @param {object} manifest
 * @param {object} m a manifest model
 * @param {string | null} season
 * @returns {{ n: number, total: number, on: boolean[] }} on[i]: the season's round i
 */
export function coverageOf(manifest, m, season) {
  let spans = seasonSpans.get(manifest);
  if (!spans) {
    spans = new Map();
    let i0 = 0;
    for (const s of manifest.seasons || []) { spans.set(s.id, [i0, s.rounds.length]); i0 += s.rounds.length; }
    seasonSpans.set(manifest, spans);
  }
  const [i0, total] = spans.get(season) || [0, 0], hex = m?.cov || "", on = [];
  let n = 0;
  for (let i = 0; i < total; i++) {
    const k = i0 + i, d = parseInt(hex[k >> 2] || "0", 16), bit = (d >> (k & 3)) & 1;
    on.push(!!bit); n += bit;
  }
  return { n, total, on };
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

/**
 * The picker's sections for a target, season, search, filters, grouping and sort.
 * Defaults (group by source, A–Z, this season): Local, a section per big family, Other, a section per hub
 * (each without models absent from the season); then "Not in <season>" with those, in the same order.
 * `when`: "season" as above; "round" moves models without a forecast on `round` there instead ("No
 * forecast <day>"); "any" lists everyone in their sections. Empty sections are dropped. A hub section is
 * collapsed by default unless it is all there is to see in season; the bottom section is collapsed.
 * `counts`: per filter, how many listed models each value would show with the other filters as they are.
 * @param {object} manifest
 * @param {{ target: string, season: string | null, query?: string, sel?: object | null,
 *           filters?: Record<string, Set<string>> | null, when?: string, round?: { has(id: string): boolean, label: string } | null,
 *           group?: string, sort?: string }} o
 * @returns {{ total: number, shown: number, labels: Map<string, string>, values: Record<string, string[]>,
 *             counts: Record<string, Map<string, number>>,
 *             sections: { key: string, title: string, kind: string, ids: string[], defaultCollapsed: boolean }[] }}
 */
export function groupModels(manifest, { target, season, query = "", sel = null, filters = null, when = "season", round = null, group = "source", sort = "name" }) {
  const cat = catalog(manifest, target);
  const { words, tokens } = parseQuery(query);
  const match = matcher(manifest, cat, words.join(" "), sel);
  // a typed filter matches from the start of the value or of a word in it: team:cu is CU, not Metaculus
  const starts = (v, value) => lower(v).split(/[\s\-_/·]+/).some((w) => w.startsWith(value)) || lower(v).startsWith(value);
  const typed = (id) => tokens.every(({ key, value }) => cat.facets.get(id)[key].some((v) => starts(v, value)));
  const active = FACETS.filter((f) => filters?.[f.key]?.size);
  const kept = (id, skip) => active.every((f) => f.key === skip || cat.facets.get(id)[f.key].some((v) => filters[f.key].has(v)));
  const found = (id) => (!match || match(id)) && typed(id);
  const out = when === "any" ? () => false
    : when === "round" && round ? (id) => !round.has(id)
    : (id) => { const s = manifest.modelById.get(id)?.seasons; return !!season && Array.isArray(s) && !s.includes(season); };

  const counts = {};
  for (const { key } of FACETS) {
    const n = new Map();
    for (const id of cat.ids) if (!out(id) && found(id) && kept(id, key)) for (const v of cat.facets.get(id)[key]) n.set(v, (n.get(v) || 0) + 1);
    counts[key] = n;
  }

  const pass = (id) => found(id) && kept(id);
  const m = (id) => manifest.modelById.get(id) || {};
  const cov = new Map();
  const rounds = (id) => { if (!cov.has(id)) cov.set(id, season ? coverageOf(manifest, m(id), season).n : m(id).rounds || 0); return cov.get(id); };
  const order = sort === "recent" ? (list) => [...list].sort((a, b) => String(m(b).last || "").localeCompare(String(m(a).last || "")))
    : sort === "rounds" ? (list) => [...list].sort((a, b) => rounds(b) - rounds(a))
    : (list) => list; // stable sorts: ties keep the layout's own (name) order

  const layout = cat.layouts[group] || cat.layouts.source;
  const here = layout.map((g) => ({ ...g, ids: order(g.ids.filter((id) => !out(id) && pass(id))) }));
  const ownToSee = here.some((g) => g.kind !== "hub" && g.ids.length);
  const sections = [];
  let shown = 0;
  for (const g of here) if (g.ids.length) { sections.push({ ...g, defaultCollapsed: g.kind === "hub" && ownToSee }); shown += g.ids.length; }
  const gone = order(layout.flatMap((g) => g.ids.filter((id) => out(id) && pass(id))));
  if (gone.length) {
    const title = when === "round" && round ? `No forecast ${round.label}` : `Not in ${manifest.seasonById?.get(season)?.label || season}`;
    sections.push({ key: "away", title, kind: "away", ids: gone, defaultCollapsed: true });
  }
  return { total: cat.ids.length, shown, labels: cat.labels, values: cat.values, counts, sections };
}

/**
 * A row's second line: facts only, never repeating the section's title or what the name already says.
 * Repo and local models: team · family; hub models: team (most hub models are their team's designated
 * one, so that is searchable but not printed on every row); then the source when the
 * section doesn't say it (Local, Ensemble, the hub). Never empty.
 * @param {object} manifest
 * @param {object} m a manifest model
 * @param {string} label its display name
 * @param {string} sectionTitle
 * @returns {string}
 */
export function subLine(manifest, m, label, sectionTitle) {
  const name = lower(label), title = lower(sectionTitle), team = m.team || "", tl = lower(team);
  const parts = [];
  if (team && tl !== title && !name.startsWith(`${tl}-`)) parts.push(team);
  if (m.source !== "hub") {
    const f = m.family || "", fl = lower(f);
    if (f && fl !== title && fl !== tl && !name.startsWith(fl) && !name.includes(`-${fl}`)) parts.push(f);
  }
  const src = manifest.sourceLabel(m);
  if (src && lower(src) !== title && !parts.some((x) => lower(x) === lower(src))) parts.push(src);
  // nothing left to say: the team's full name when it is one (not just the model id), else the team
  const full = m.team_name || "", fl = lower(full);
  if (!parts.length) parts.push(full && fl !== name && !fl.startsWith(`${tl}-`) && fl !== lower(m.id) ? full : team || m.id);
  return parts.join(" · ");
}

/**
 * The panel's width: half the viewport (two columns) for a long list, else a quarter (one column),
 * never narrower than --popover-width; minus the outer margins.
 * @param {number} vw viewport width, px
 * @param {number} rows rows showing
 * @param {number} [inset=16] --inset
 * @param {number} [min=360] --popover-width
 * @returns {number} px
 */
export function panelWidth(vw, rows, inset = 16, min = 360) {
  return Math.round(rows > ONE_COLUMN_MAX ? vw / 2 - 1.5 * inset : Math.max(vw / 4 - 1.5 * inset, min));
}

/* ================================================================ the panel */

const ITEMS = ".c-section-title, .c-section-action, .pk-name";
const PREFS = "viz.next.picker";

/* The filters (for the session, like the collapsed sections) and the view (kept in the browser). */
const filters = Object.fromEntries(FACETS.map((f) => [f.key, new Set()]));
const filtering = () => FACETS.some((f) => filters[f.key].size);
const prefs = (() => {
  const p = storage.get(PREFS, {}) || {};
  return { group: GROUPS[p.group] ? p.group : "source", sort: SORTS[p.sort] ? p.sort : "name", when: WHEN[p.when] ? p.when : "season" };
})();

/**
 * Open the model picker from the Models bubble (or close it, if it is open from there).
 * Writes only store.set({ sel }). While open: the chart's inset follows the panel (chart.setInset) and
 * the chart previews (chart.preview); ← → keep stepping the chart's date.
 * @param {HTMLElement} anchor the Models bubble
 * @param {{ manifest: object, store: object, chart?: object | null }} ctx
 * @returns {object | null} the layer, or null when this call closed it
 */
export function openModelPicker(anchor, { manifest, store, chart = null }) {
  const inset = () => tokenNum("--inset", 16);
  const seasonNow = () => manifest.seasonOf(store.get().date);
  let season = seasonNow();
  let query = "";
  const searchClosed = new Set(); // sections closed during the current search
  const offs = [];
  let raf = 0, width = 0, shown = 0, lastClicked = null, notesKey = null;
  let rows = new Map(), sections = new Map(), order = [];
  let els = null, drawer = null, roundKey = "", shownIds = [];
  const seen = { fan: undefined, week: undefined, target: undefined };

  // the chart's round, for "This round": which models have a forecast on it (null until the fan is this
  // target and season)
  function roundNow() {
    const st = store.get(), fan = chart?.fan, week = chart?.week?.();
    if (!fan || fan.target !== st.target || fan.season !== season) return { key: "", round: null };
    const di = fan.indexOf(toIso(week));
    if (di < 0) return { key: "", round: null };
    return { key: `${fan.location}|${fan.season}|${fan.target}|${di}`, round: { has: (id) => fan.has(id, di), label: fmtDay(fan.dates[di]) } };
  }
  const args = () => {
    const r = prefs.when === "round" ? roundNow() : { key: "", round: null };
    roundKey = r.key;
    return { target: store.get().target, season, query, sel: store.get().sel, filters, when: prefs.when, round: r.round, group: prefs.group, sort: prefs.sort };
  };
  const first = groupModels(manifest, args());
  const rowsOf = (g) => g.sections.reduce((n, s) => n + (isOpen(s) ? s.ids.length : 0), 0);

  function isOpen(s) {
    if (query || filtering()) return !searchClosed.has(s.key);
    return collapsed.has(s.key) ? !collapsed.get(s.key) : !s.defaultCollapsed;
  }

  const layer = openPopover(anchor, {
    morph: true, timeKeys: true, className: "pk-panel",
    width: panelWidth(innerWidth, rowsOf(first), inset(), tokenNum("--popover-width", 360)),
    onClose() {
      offs.forEach((off) => off());
      cancelAnimationFrame(raf);
      chart?.setInset(0);
      chart?.preview(false);
    },
    content(body, lay) {
      const input = h("input", { type: "search", autocomplete: "off", spellcheck: "false", "aria-label": "Search models" });
      const base = h("button", { type: "button", class: "pk-base", role: "checkbox" }, h("span", { class: "c-check" }), "Baseline");
      const cols = h("div", { class: "pk-cols" });
      const list = h("div", { class: "pk-list", role: "group", "aria-label": "Models" }, cols);
      const footText = h("span", { class: "pk-count" });
      const combine = h("button", { type: "button", class: "c-link pk-combine", hidden: true, onclick: () => {
        lay.close(false);
        import("./Ensemble.js").then((m) => m.openCombine(anchor, { manifest, store })).catch((err) => console.error("viz: Combine could not open", err));
      } }, "Combine…");
      const reset = h("button", { type: "button", class: "c-link", title: "The recommended models", onclick: () => {
        const sel = store.get().sel;
        const picks = (manifest.recommended || []).filter((id) => id !== manifest.baseline && manifest.modelById.has(id)).slice(0, 3);
        setSel(S.create({ selected: picks, showAll: sel.showAll, baseline: sel.baseline }));
      } }, "Reset");
      const clear = h("button", { type: "button", class: "c-link", onclick: () => { const sel = store.get().sel; setSel(S.setMany(sel, sel.selected, false)); } }, "Clear");
      const fil = h("div", { class: "pk-filters", role: "toolbar", "aria-label": "Filters" });
      const drawerEl = h("div", { class: "pk-drawer", hidden: true });
      const tray = h("div", { class: "pk-tray", role: "list", "aria-label": "Selected models" });
      const foot = h("div", { class: "pk-foot" }, tray, h("div", { class: "pk-foot-line" }, footText, h("span", { class: "pk-acts" }, combine, reset, clear)));
      body.append(h("div", { class: "pk-head" }, h("label", { class: "c-search", html: icon.search }, input), base), fil, drawerEl, list, foot);
      els = { panel: lay.panel, input, base, cols, list, foot, footText, combine, clear, fil, drawer: drawerEl, tray };
      wire();
      rebuild(first);
    },
  });
  if (!layer) return null;
  chart?.preview(true);
  if (chart) raf = requestAnimationFrame(function watch() { updateNotes(); raf = requestAnimationFrame(watch); });
  return layer;

  /* ---------------- building ---------------- */

  function rebuild(g = groupModels(manifest, args()), { resetScroll = false } = {}) {
    const { list, cols, input } = els;
    const keep = focusKey();
    const top = resetScroll ? 0 : list.scrollTop;
    input.placeholder = `Search ${g.total} models`;
    renderFilters(g);
    renderDrawer(g);
    rows = new Map(); sections = new Map(); order = [];
    const frag = document.createDocumentFragment();
    shown = 0;
    for (const s of g.sections) {
      const open = isOpen(s);
      frag.append(header(s, open));
      if (!open) continue;
      for (const id of s.ids) { frag.append(row(id, s, g.labels.get(id) || id)); order.push(id); }
      shown += s.ids.length;
    }
    if (!g.sections.length) frag.append(h("div", { class: "pk-empty" }, query || filtering() ? "No models match" : "No models"));
    const two = shown > ONE_COLUMN_MAX;
    // Two columns are split here, not by CSS multi-column: the browser's column balancing could lay rows
    // over each other while the panel was resizing. Halfway by row count; a section header never ends
    // a column (it moves to the top of the next with its rows).
    if (two) {
      const items = [...frag.children], half = Math.ceil(items.length / 2);
      let cut = half;
      while (cut > 1 && items[cut - 1].classList.contains("c-section")) cut--;
      const a = h("div", { class: "pk-col" }), b = h("div", { class: "pk-col" });
      items.forEach((el, i) => (i < cut ? a : b).append(el));
      cols.replaceChildren(a, b);
    } else cols.replaceChildren(frag);
    list.classList.toggle("two", two);
    resize();
    list.scrollTop = top;
    notesKey = null;
    updateSel(store.get().sel, true);
    updateNotes();
    restoreFocus(keep);
  }

  function header(s, open) {
    const count = h("span", { class: "c-section-count" });
    const action = h("button", { type: "button", class: "c-section-action", tabindex: "-1" });
    const title = h("button", { type: "button", class: "c-section-title", tabindex: "-1", "aria-expanded": String(open), html: icon.chevronDown }, h("span", null, s.title), count);
    const el = h("div", { class: "c-section", "data-key": s.key }, title, action);
    sections.set(s.key, { s, el, count, action, title, k: "" });
    return el;
  }

  function row(id, s, label) {
    const m = manifest.modelById.get(id) || { id };
    const miss = h("span", { class: "pk-miss" });
    const name = h("button", { type: "button", class: "c-row two pk-name", role: "checkbox", tabindex: "-1" },
      h("span", { class: "c-row-lead" }),
      h("span", { class: "c-row-text" },
        slideText(label, "c-row-name"),
        h("span", { class: "c-row-sub" }, subLine(manifest, m, label, s.title), miss)),
      h("span", { class: "c-row-check", html: icon.check }));
    const dot = h("button", { type: "button", class: "pk-dot", tabindex: "-1" }, h("i"));
    // its page (the model sheet); opened by the shared data-model-sheet handler
    const info = h("button", { type: "button", class: "pk-info", tabindex: "-1", "data-model-sheet": id, "aria-label": `${label} · details`, title: "Details", html: icon.open });
    const el = h("div", { class: "pk-row c-slide-host", "data-id": id }, dot, name, info);
    rows.set(id, { el, name, dot, miss, label, away: s.kind === "away", k: "", note: "" });
    return el;
  }

  /* ---------------- filters, the drawer, the tray ---------------- */

  function renderFilters(g) {
    const chip = (key, text, pressed) => h("button", { type: "button", class: "c-chip pk-fchip", "data-drawer": key, "aria-pressed": String(pressed), "aria-expanded": String(drawer === key), html: icon.chevronDown }, h("span", null, text));
    const out = FACETS.map((f) => {
      const on = [...filters[f.key]];
      return chip(f.key, on.length === 1 ? `${f.label} · ${on[0]}` : on.length ? `${f.label} · ${on.length}` : f.label, on.length > 0);
    });
    out.push(chip("when", WHEN[prefs.when], prefs.when !== "season"));
    out.push(chip("view", `${prefs.group === "none" ? "No groups" : `By ${GROUPS[prefs.group].toLowerCase()}`} · ${SORTS[prefs.sort]}`, prefs.group !== "source" || prefs.sort !== "name"));
    if (filtering()) out.push(h("button", { type: "button", class: "c-link pk-fclear", "data-clear": "" }, "Clear filters"));
    // everything the list shows (above its bottom section), and none
    const n = store.get().sel.selected.length;
    out.push(h("span", { class: "pk-bulk" },
      h("span", { class: "pk-shown" }, g.shown === g.total ? `${g.total}` : `${g.shown} of ${g.total}`),
      h("button", { type: "button", class: "c-link", "data-all": "", disabled: !g.shown || null }, g.shown === g.total ? "Select all" : `Select ${g.shown}`),
      h("button", { type: "button", class: "c-link", "data-none": "", disabled: !n || null }, "Clear all")));
    shownIds = g.sections.filter((s) => s.kind !== "away").flatMap((s) => s.ids);
    els.fil.replaceChildren(...out);
  }

  function renderDrawer(g) {
    const d = els.drawer;
    d.hidden = !drawer;
    if (!drawer) { d.replaceChildren(); return; }
    const opt = (attrs, text, pressed, n) => h("button", { type: "button", class: ["c-chip pk-opt", n === 0 && !pressed && "is-zero"], "aria-pressed": String(pressed), ...attrs },
      h("span", null, text), n == null ? null : h("span", { class: "pk-n" }, String(n)));
    if (drawer === "when") {
      d.replaceChildren(h("div", { class: "pk-opts" }, ...Object.entries(WHEN).map(([k, t]) => opt({ "data-when": k }, t, prefs.when === k))));
    } else if (drawer === "view") {
      d.replaceChildren(
        h("div", { class: "pk-opts" }, h("span", { class: "pk-dlabel" }, "Group"), ...Object.entries(GROUPS).map(([k, t]) => opt({ "data-group": k }, t, prefs.group === k))),
        h("div", { class: "pk-opts" }, h("span", { class: "pk-dlabel" }, "Sort"), ...Object.entries(SORTS).map(([k, t]) => opt({ "data-sort": k }, t, prefs.sort === k))));
    } else {
      const set = filters[drawer], n = g.counts[drawer];
      const vs = g.values[drawer], live = vs.filter((v) => n.get(v) || set.has(v)), none = vs.filter((v) => !n.get(v) && !set.has(v));
      d.replaceChildren(h("div", { class: "pk-opts" }, ...[...live, ...none].map((v) => opt({ "data-v": v }, v, set.has(v), n.get(v) || 0))));
    }
  }

  function renderTray(sel) {
    const slots = new Map(sel.charted.map((c) => [c.id, c.slot]));
    const ids = [...[...sel.charted].sort((a, b) => a.slot - b.slot).map((c) => c.id), ...sel.selected.filter((id) => !slots.has(id))];
    const cat = catalog(manifest, store.get().target);
    els.tray.replaceChildren(...ids.map((id) => {
      const label = cat.labels.get(id) || manifest.label(id), slot = slots.get(id);
      return h("span", { class: "pk-tchip", role: "listitem", "data-id": id },
        h("button", { type: "button", class: "pk-tname", title: slot == null ? "Put on the chart" : "Take off the chart" },
          h("i", { class: slot == null ? null : "on", style: slot == null ? null : { "--c": `var(--series-${(slot % S.COLORS) + 1})` } }), h("span", null, label)),
        h("button", { type: "button", class: "pk-tx", "aria-label": `Deselect ${label}`, html: icon.close }));
    }));
    els.tray.hidden = !ids.length;
  }

  function setPrefs(p) {
    Object.assign(prefs, p);
    storage.set(PREFS, prefs);
    searchClosed.clear();
    rebuild(undefined, { resetScroll: true });
  }

  function onDrawer(e) {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.when) setPrefs({ when: t.dataset.when });
    else if (t.dataset.group) setPrefs({ group: t.dataset.group });
    else if (t.dataset.sort) setPrefs({ sort: t.dataset.sort });
    else if (t.dataset.v != null && filters[drawer]) {
      const set = filters[drawer];
      set.has(t.dataset.v) ? set.delete(t.dataset.v) : set.add(t.dataset.v);
      searchClosed.clear();
      rebuild(undefined, { resetScroll: true });
    }
    els.drawer.querySelector(`button[aria-pressed][data-${t.dataset.when ? "when" : t.dataset.group ? "group" : t.dataset.sort ? "sort" : "v"}="${CSS.escape(t.dataset.when || t.dataset.group || t.dataset.sort || t.dataset.v)}"]`)?.focus({ preventScroll: true });
  }

  function onFilters(e) {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.all != null) { setSel(S.setMany(store.get().sel, shownIds, true)); return; }
    if (t.dataset.none != null) { const sel = store.get().sel; setSel(S.setMany(sel, sel.selected, false)); return; }
    if (t.dataset.clear != null) { for (const f of FACETS) filters[f.key].clear(); searchClosed.clear(); rebuild(undefined, { resetScroll: true }); els.input.focus(); return; }
    const key = t.dataset.drawer;
    if (!key) return;
    drawer = drawer === key ? null : key;
    rebuild();
    els.fil.querySelector(`[data-drawer="${key}"]`)?.focus({ preventScroll: true });
  }

  /* ---------------- in-place updates ---------------- */

  function updateSel(sel, force = false) {
    const on = new Set(sel.selected), slots = new Map(sel.charted.map((c) => [c.id, c.slot]));
    for (const [id, r] of rows) {
      const picked = on.has(id), slot = slots.get(id) ?? null, grey = sel.showAll && picked && slot == null;
      const k = `${picked}|${slot}|${grey}`;
      if (!force && k === r.k) continue;
      r.k = k;
      r.name.setAttribute("aria-checked", String(picked));
      r.dot.classList.toggle("on", slot != null);
      r.dot.classList.toggle("grey", grey);
      r.dot.style.setProperty("--c", slot == null ? null : `var(--series-${(slot % S.COLORS) + 1})`);
      r.dot.setAttribute("aria-label", slot != null ? `On the chart. Take off: ${r.label}` : grey ? `Grey on the chart. Put on in color: ${r.label}` : `Put on the chart: ${r.label}`);
    }
    for (const x of sections.values()) {
      const n = x.s.ids.reduce((a, id) => a + on.has(id), 0), all = n === x.s.ids.length;
      const k = `${n}`;
      if (!force && k === x.k) continue;
      x.k = k;
      x.count.textContent = n ? `${n} of ${x.s.ids.length}` : `${x.s.ids.length}`;
      x.action.textContent = all ? "Deselect all" : "Select all";
      x.action.setAttribute("aria-label", `${all ? "Deselect" : "Select"} all ${x.s.title}`);
    }
    els.base.setAttribute("aria-checked", String(sel.baseline));
    const n = sel.selected.length, c = sel.charted.length, grey = S.context(sel).length;
    els.combine.hidden = n < 2;
    els.clear.hidden = !n;
    const none = els.fil.querySelector("[data-none]");
    if (none) none.disabled = !n;
    renderTray(sel);
    els.footText.textContent = [`${n} selected`, `${c} charted`, grey ? `${grey} grey` : null].filter(Boolean).join(" · ");
  }

  // "no forecast Dec 27" on rows without a forecast on the chart's round (only once the chart's fan is this
  // target and season, so a loading fan never puts up wrong notes)
  function updateNotes() {
    const st = store.get(), fan = chart?.fan, week = chart?.week();
    // called every frame while open: nothing to do (and nothing allocated) until the fan or round moves
    if (notesKey !== null && fan === seen.fan && week === seen.week && st.target === seen.target) return;
    Object.assign(seen, { fan, week, target: st.target });
    // "This round" lists by the round: a new round (or the fan arriving) re-sorts the list
    if (prefs.when === "round" && roundNow().key !== roundKey) { rebuild(); return; }
    let di = -1;
    if (fan && fan.target === st.target && fan.season === season) di = fan.indexOf(toIso(week));
    const key = di >= 0 ? `${fan.location}|${fan.season}|${fan.target}|${di}` : "";
    if (key === notesKey) return;
    notesKey = key;
    const day = di >= 0 ? fmtDay(fan.dates[di]) : "";
    for (const [id, r] of rows) {
      const note = di >= 0 && !r.away && !fan.has(id, di) ? ` · no forecast ${day}` : "";
      if (note !== r.note) { r.note = note; r.miss.textContent = note; }
    }
  }

  function resize() {
    const w = panelWidth(innerWidth, shown, inset(), tokenNum("--popover-width", 360));
    if (w === width) return;
    width = w;
    els.panel.style.width = `${w}px`;
    chart?.setInset(inset() + w + tokenNum("--space-24", 24));
  }

  /* ---------------- focus ---------------- */

  function items() { return [...els.list.querySelectorAll(ITEMS)]; }
  function rove(el) {
    for (const x of els.list.querySelectorAll("[tabindex='0']")) if (x !== el) x.tabIndex = -1;
    if (el) el.tabIndex = 0;
  }
  function go(el) { if (!el) return; rove(el); el.focus({ preventScroll: true }); revealInList(el.closest(".pk-row") || el); }
  function focusKey() {
    const a = document.activeElement;
    if (!els.list.contains(a)) return els.list.querySelector("[tabindex='0']") ? { rove: keyOf(els.list.querySelector("[tabindex='0']")) } : null;
    return { focus: keyOf(a) };
  }
  function keyOf(el) {
    const r = el.closest(".pk-row");
    if (r) return { id: r.dataset.id };
    return { sec: el.closest(".c-section")?.dataset.key, action: el.classList.contains("c-section-action") };
  }
  function find(k) {
    if (!k) return null;
    if (k.id) return rows.get(k.id)?.name || null;
    const x = sections.get(k.sec);
    return x ? (k.action ? x.action : x.title) : null;
  }
  function restoreFocus(keep) {
    const el = find(keep?.focus || keep?.rove) || items()[0] || null;
    rove(el);
    if (keep?.focus) { if (el) el.focus({ preventScroll: true }); else els.input.focus({ preventScroll: true }); }
  }

  /* ---------------- input ---------------- */

  function setSel(next) { store.set({ sel: next }); }

  function toggleRow(id, shift) {
    const sel = store.get().sel;
    if (shift && lastClicked && lastClicked !== id) {
      const a = order.indexOf(lastClicked), b = order.indexOf(id);
      if (a >= 0 && b >= 0) {
        setSel(S.setMany(sel, order.slice(Math.min(a, b), Math.max(a, b) + 1), !S.isSelected(sel, id)));
        lastClicked = id;
        return;
      }
    }
    setSel(S.toggle(sel, id));
    lastClicked = id;
  }

  function toggleSection(key) {
    const x = sections.get(key);
    if (!x) return;
    if (query) searchClosed.has(key) ? searchClosed.delete(key) : searchClosed.add(key);
    else collapsed.set(key, isOpen(x.s));
    rebuild();
  }

  function wire() {
    const { input, base, list, panel } = els;
    offs.push(
      store.select(["sel"], (s) => updateSel(s.sel)),
      store.select(["target"], () => rebuild()),
      store.select(["date"], () => { const now = seasonNow(); if (now !== season) { season = now; rebuild(); } }),
      on(window, "resize", resize),
      // Tab cycles through the panel's tab stops (the list is one stop: roving tabindex)
      // Escape closes an open drawer first, then (the layer's own handler) the picker
      on(panel, "keydown", (e) => {
        if (e.key === "Escape" && drawer) { e.preventDefault(); e.stopPropagation(); const k = drawer; drawer = null; rebuild(); els.fil.querySelector(`[data-drawer="${k}"]`)?.focus(); }
      }, true),
      on(panel, "keydown", (e) => {
        if (e.key !== "Tab" || e.defaultPrevented) return;
        const stops = [input, base, ...els.fil.querySelectorAll("button"), ...els.drawer.querySelectorAll("button"), els.list.querySelector("[tabindex='0']"),
          ...[...els.foot.querySelectorAll("button")].filter((b) => !b.hidden)].filter(Boolean);
        const i = stops.indexOf(document.activeElement);
        e.preventDefault();
        stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
      }),
    );

    input.addEventListener("input", () => {
      query = input.value.trim();
      searchClosed.clear();
      rebuild(undefined, { resetScroll: true });
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); go(items()[0]); }
    });
    base.addEventListener("click", () => { const sel = store.get().sel; setSel(S.setBaseline(sel, !sel.baseline)); });
    els.fil.addEventListener("click", onFilters);
    els.drawer.addEventListener("click", onDrawer);
    els.tray.addEventListener("click", (e) => {
      const t = e.target.closest("button"), id = t?.closest(".pk-tchip")?.dataset.id;
      if (!id) return;
      const sel = store.get().sel;
      if (t.classList.contains("pk-tx")) setSel(S.deselect(sel, id));
      else setSel(S.toggleChart(sel, id));
    });

    list.addEventListener("focusin", (e) => { if (e.target.matches(ITEMS)) rove(e.target); });
    list.addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      const id = t.closest(".pk-row")?.dataset.id, key = t.closest(".c-section")?.dataset.key;
      if (t.classList.contains("pk-dot")) setSel(S.toggleChart(store.get().sel, id));
      else if (t.classList.contains("pk-name")) toggleRow(id, e.shiftKey);
      else if (t.classList.contains("c-section-title")) toggleSection(key);
      else if (t.classList.contains("c-section-action")) {
        const sel = store.get().sel, ids = sections.get(key)?.s.ids || [];
        setSel(S.setMany(sel, ids, !ids.every((x) => S.isSelected(sel, x))));
      }
    });
    list.addEventListener("keydown", (e) => {
      const all = items(), i = all.indexOf(document.activeElement);
      const id = document.activeElement?.closest?.(".pk-row")?.dataset.id;
      if (e.key === "ArrowDown") { e.preventDefault(); go(all[Math.min(all.length - 1, i + 1)]); }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (i <= 0) input.focus(); else go(all[i - 1]); }
      else if (e.key === "Home") { e.preventDefault(); go(all[0]); }
      else if (e.key === "End") { e.preventDefault(); go(all.at(-1)); }
      else if (id && e.key === "Enter") { e.preventDefault(); setSel(S.toggleChart(store.get().sel, id)); }
      else if (id && e.key === " ") { e.preventDefault(); if (!e.repeat) toggleRow(id, e.shiftKey); }
      // typing anywhere in the list goes to the search
      else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) input.focus();
    });
    // Space activates a button on keyup; it was handled on keydown
    list.addEventListener("keyup", (e) => { if (e.key === " " && e.target.classList.contains("pk-name")) e.preventDefault(); });
  }
}
