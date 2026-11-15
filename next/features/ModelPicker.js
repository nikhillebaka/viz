/* The model picker: which models are selected (evaluated) and which five are charted.
 *
 * A panel that morphs out of the Models bubble and takes the left of the screen at full height: two
 * columns and half the viewport when more than ONE_COLUMN_MAX rows show, else one column and a quarter.
 * The list is built from the manifest and rebuilt only when the search, a collapse, the target or the
 * season changes; selection changes update rows in place (scroll and focus stay, 200 rows stay fast);
 * the chart's round only touches the "no forecast" notes.
 *
 * groupModels(), subLine(), matcher() and panelWidth() are pure, for node tests. */
import { h, on, tokenNum } from "../lib/dom.js";
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
  const hay = new Map(listed.map((m) => [m.id, lower([labels.get(m.id), m.id, m.team, m.team_name, m.family, manifest.sourceLabel(m)].filter(Boolean).join("\n"))]));
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

  c = Object.freeze({ ids, labels, hay, groups });
  byTarget.set(target, c);
  return c;
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
 * The picker's sections for a target, season and search.
 * In season: Local, a section per big family, Other, a section per hub (each without models absent from
 * the season); then "Not in <season>" with those, in the same order. Empty sections are dropped.
 * A hub section is collapsed by default unless it is all there is to see in season; Not in is collapsed.
 * @param {object} manifest
 * @param {{ target: string, season: string | null, query?: string, sel?: object | null }} o
 * @returns {{ total: number, labels: Map<string, string>,
 *             sections: { key: string, title: string, kind: string, ids: string[], defaultCollapsed: boolean }[] }}
 */
export function groupModels(manifest, { target, season, query = "", sel = null }) {
  const cat = catalog(manifest, target);
  const match = matcher(manifest, cat, query, sel);
  const away = (id) => {
    const s = manifest.modelById.get(id)?.seasons;
    return !!season && Array.isArray(s) && !s.includes(season);
  };
  const here = cat.groups.map((g) => ({ ...g, ids: g.ids.filter((id) => !away(id)) }));
  const ownToSee = here.some((g) => g.kind !== "hub" && g.ids.length);
  const sections = [];
  for (const g of here) {
    const ids = match ? g.ids.filter(match) : g.ids;
    if (ids.length) sections.push({ ...g, ids, defaultCollapsed: g.kind === "hub" && ownToSee });
  }
  const gone = cat.groups.flatMap((g) => g.ids.filter(away)).filter((id) => !match || match(id));
  if (gone.length) {
    const label = manifest.seasonById?.get(season)?.label || season;
    sections.push({ key: "away", title: `Not in ${label}`, kind: "away", ids: gone, defaultCollapsed: true });
  }
  return { total: cat.ids.length, labels: cat.labels, sections };
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
  let els = null;
  const seen = { fan: undefined, week: undefined, target: undefined };

  const first = groupModels(manifest, { target: store.get().target, season, sel: store.get().sel });
  const rowsOf = (g) => g.sections.reduce((n, s) => n + (isOpen(s) ? s.ids.length : 0), 0);

  function isOpen(s) {
    if (query) return !searchClosed.has(s.key);
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
      const footText = h("span");
      const combine = h("button", { type: "button", class: "c-link pk-combine", hidden: true, onclick: () => {
        lay.close(false);
        import("./Ensemble.js").then((m) => m.openCombine(anchor, { manifest, store })).catch((err) => console.error("viz: Combine could not open", err));
      } }, "Combine…");
      const foot = h("div", { class: "pk-foot" }, footText, combine);
      body.append(h("div", { class: "pk-head" }, h("label", { class: "c-search", html: icon.search }, input), base), list, foot);
      els = { panel: lay.panel, input, base, cols, list, foot, footText, combine };
      wire();
      rebuild(first);
    },
  });
  if (!layer) return null;
  chart?.preview(true);
  if (chart) raf = requestAnimationFrame(function watch() { updateNotes(); raf = requestAnimationFrame(watch); });
  return layer;

  /* ---------------- building ---------------- */

  function rebuild(g = groupModels(manifest, { target: store.get().target, season, query, sel: store.get().sel }), { resetScroll = false } = {}) {
    const { list, cols, input } = els;
    const keep = focusKey();
    const top = resetScroll ? 0 : list.scrollTop;
    input.placeholder = `Search ${g.total} models`;
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
    if (!g.sections.length) frag.append(h("div", { class: "pk-empty" }, query ? "No models match" : "No models"));
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
    els.footText.textContent = [`${n} selected`, `${c} charted`, grey ? `${grey} grey` : null].filter(Boolean).join(" · ");
  }

  // "no forecast Dec 27" on rows without a forecast on the chart's round (only once the chart's fan is this
  // target and season, so a loading fan never puts up wrong notes)
  function updateNotes() {
    const st = store.get(), fan = chart?.fan, week = chart?.week();
    // called every frame while open: nothing to do (and nothing allocated) until the fan or round moves
    if (notesKey !== null && fan === seen.fan && week === seen.week && st.target === seen.target) return;
    Object.assign(seen, { fan, week, target: st.target });
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
      on(panel, "keydown", (e) => {
        if (e.key !== "Tab" || e.defaultPrevented) return;
        const stops = [input, base, els.list.querySelector("[tabindex='0']")].filter(Boolean);
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
