/* Data sources: this repository and the live Hubverse hubs copied into the local cache (sync, check,
 * show or hide, remove, add), and the Warnings panel (dataset validation and each hub's quality notes).
 *
 * Nothing reaches the network until a button is pressed (Check, Sync, Add). A finished sync, a toggle or a
 * removal changes the model inventory, so the page reloads (after a toast) to read the new manifest.
 * Sync state lives in this module, so a sync keeps being followed when the panel closes. */
import { h } from "../lib/dom.js";
import { openPopover } from "../ui/floating.js";
import { icon, toast } from "../ui/controls.js";
import { fmtDay } from "../lib/format.js";
import { parseIso } from "../lib/scale.js";
import { getJSON, postJSON, fmtBytes, fmtAgo, reloadSoon, loadWarningSummary } from "./More.js";

const POLL_MS = 700;
const ARM_MS = 3500;

let hubs = [];                 // /api/remote/hubs rows
let currentSeason = "";
const checks = new Map();      // hub id → /api/remote/check answer
const picked = new Map();      // hub id → Set of seasons for the next sync
const notes = new Map();       // hub id → a one-line outcome ("Up to date · latest Nov 14")
const armed = new Map();       // hub id → timer while Remove waits for its second click
let pollTimer = 0;
let render = null;             // the open panel's redraw, if any
let failed = false;            // a sync failed since the panel was last opened
const watchers = new Set();    // syncStatus listeners (the ⋯ bubble's dot)

const running = (x) => x.job?.status === "running";
const seasonLabel = (s) => { const [a, b] = s.split("-"); return `${a}–${b.slice(2)}`; };
const day = (iso) => (iso ? fmtDay(parseIso(iso)) : "–");
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

/** "running" while a sync runs, "failed" after one failed (until the panel is opened), else "". */
export const syncStatus = () => (hubs.some(running) ? "running" : failed ? "failed" : "");

/**
 * Follow the sync status (called now, then on each change).
 * @param {(status: "running" | "failed" | "") => void} fn
 * @returns {() => void} stops
 */
export function watchSync(fn) {
  watchers.add(fn);
  fn(syncStatus());
  return () => watchers.delete(fn);
}
let lastStatus = "";
function emit() {
  const s = syncStatus();
  if (s === lastStatus) return;
  lastStatus = s;
  watchers.forEach((fn) => fn(s));
}

async function loadHubs() {
  const r = await getJSON("/api/remote/hubs");
  hubs = r.hubs || [];
  currentSeason = r.current_season || "";
  for (const x of hubs) if (!picked.has(x.id)) picked.set(x.id, defaultSeasons(x));
  emit();
}

function defaultSeasons(x) {
  const s = new Set(x.seasons || []);
  if (currentSeason) s.add(currentSeason);
  return s;
}

/**
 * Follow a sync that was already running when the page loaded (polls until it ends, then reloads).
 * @param {object} _ctx
 */
export async function resumeSync(_ctx) {
  await loadHubs();
  if (hubs.some(running)) startPoll();
}

function startPoll() {
  if (pollTimer) return;
  const tick = async () => {
    const live = hubs.filter(running);
    if (!live.length) { pollTimer = 0; emit(); return; }
    await Promise.all(live.map(async (x) => {
      try {
        const r = await getJSON(`/api/remote/job?hub=${encodeURIComponent(x.id)}`);
        const next = { ...(r.hub || x), job: r.job };
        hubs = hubs.map((y) => (y.id === x.id ? next : y));
        if (!running(next)) finished(next);
      } catch { /* a missed poll is retried on the next tick */ }
    }));
    render?.();
    emit();
    pollTimer = setTimeout(tick, POLL_MS);
  };
  pollTimer = setTimeout(tick, POLL_MS);
}

function finished(x) {
  const j = x.job || {}, s = j.summary || {};
  checks.delete(x.id);
  if (j.status === "done") {
    const changes = [s.added && `${s.added} new`, s.updated && `${s.updated} updated`, s.removed && `${s.removed} removed`].filter(Boolean).join(" · ") || "no changes";
    notes.set(x.id, `Synced · ${changes}${s.failed ? ` · ${s.failed} unreadable` : ""}`);
    toast(`${x.label} synced · ${changes}`);
    reloadSoon(1600);
  } else if (j.status === "cancelled") {
    notes.set(x.id, "Sync cancelled · finished files kept");
  } else {
    notes.set(x.id, `Sync failed · ${j.error || "unknown error"}`);
    failed = true;
    toast(`${x.label} sync failed`, { tone: "error" });
  }
}

/**
 * The Data sources panel.
 * @param {HTMLElement} anchor the ⋯ bubble
 * @param {{ manifest: object }} ctx
 * @returns {Promise<object | null>} the layer
 */
export async function openHubs(anchor, { manifest }) {
  const repoCount = manifest.models.filter((m) => m.source !== "hub").length;
  const list = h("div", { class: "mo-hubs" });
  const input = h("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "S3 bucket · S3 hubs only", "aria-label": "Hub S3 bucket" });
  const addBtn = h("button", { type: "button", class: "c-btn filled sm" }, "Add hub");
  const addNote = h("div", { class: "mo-note", "aria-live": "polite" });
  const add = async () => {
    const bucket = input.value.trim();
    if (!bucket) { input.focus(); return; }
    addBtn.disabled = true; addNote.textContent = `Checking ${bucket}…`;
    try {
      const r = await postJSON("/api/remote/add", { bucket }, { okStatuses: [422] });
      if (!r.ok) addNote.textContent = `Not supported · ${r.reason || "not a flu hub"}`;
      else {
        input.value = "";
        addNote.textContent = r.already_registered ? `${r.hub.label} · already connected` : `${r.hub.label} · added`;
        await loadHubs();
        render?.();
        if (!r.already_registered) check(r.hub);
      }
    } catch (err) { addNote.textContent = `Couldn't add · ${err.message}`; }
    addBtn.disabled = false;
  };
  addBtn.addEventListener("click", add);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });

  const layer = openPopover(anchor, {
    title: "Data sources", placement: "bottom-end", width: 440, className: "mo-panel",
    onClose() { render = null; },
    content(body) {
      body.append(
        h("div", { class: "mo-src" },
          h("div", { class: "mo-src-head" }, h("span", { class: "mo-src-name" }, "This repository"), h("span", { class: "mo-src-state" }, plural(repoCount, "model"))),
          h("div", { class: "mo-src-meta" }, "model-output · local-output · synthetic")),
        list,
        h("div", { class: "mo-add" }, h("label", { class: "c-search mo-field" }, input), addBtn),
        addNote);
      list.append(h("div", { class: "mo-note" }, "Loading…"));
    },
  });
  if (!layer) return null;
  failed = false; // seen
  emit();
  render = () => { list.replaceChildren(...hubs.map(hubBlock)); layer.place(); };
  try { await loadHubs(); render?.(); if (hubs.some(running)) startPoll(); }
  catch (err) { list.replaceChildren(h("div", { class: "mo-note" }, `Couldn't load hubs · ${err.message}`)); }
  return layer;
}

function hubBlock(x) {
  const busy = running(x), anyBusy = hubs.some(running);
  const state = busy ? "Syncing" : !x.synced ? "Not synced" : x.enabled ? "Live" : "Hidden";
  const shown = h("button", {
    type: "button", class: "mo-toggle", role: "checkbox", "aria-checked": String(!!x.enabled), disabled: !x.synced || busy,
    "aria-label": `Show ${x.label} models`, onclick: () => toggle(x),
  }, h("span", { class: "c-check" }), "Shown");

  const meta = x.synced
    ? [plural(x.models || 0, "model"), plural(x.files || 0, "file"), fmtBytes(x.bytes), `synced ${fmtAgo(x.last_sync)}`].join(" · ")
    : "Nothing downloaded";
  const p = x.pending || {}, upstream = (p.new || 0) + Math.max(0, (p.changed || 0) - (p.outdated || 0)) + (p.removed || 0);
  const meta2 = x.synced ? [`latest ${day(x.latest_round)}`, x.latest_round_models ? plural(x.latest_round_models, "model") : null, x.truth?.oracle?.as_of ? `truth ${day(x.truth.oracle.as_of)}` : null, upstream ? `${upstream} changed upstream` : null].filter(Boolean).join(" · ") : null;

  // seasons: those stored, the current one, and whatever a check listed
  const listed = checks.get(x.id)?.seasons || [];
  const all = [...new Set([...(x.seasons || []), ...(currentSeason ? [currentSeason] : []), ...listed.map((s) => s.season)])].sort().reverse();
  const sel = picked.get(x.id) || new Set();
  const chips = all.map((s) => {
    const info = listed.find((y) => y.season === s);
    const have = (x.seasons || []).includes(s);
    return h("button", {
      type: "button", class: ["c-chip mo-season", have && "have"], "aria-pressed": String(sel.has(s)), disabled: busy,
      title: info ? `${plural(info.rounds?.length || 0, "round")} · ${plural(info.models || 0, "model")} · ${fmtBytes(info.bytes)}` : have ? "Synced" : null,
      onclick: () => { sel.has(s) ? sel.delete(s) : sel.add(s); picked.set(x.id, sel); render?.(); },
    }, seasonLabel(s));
  });

  const j = x.job || {};
  const progress = busy ? h("div", { class: "mo-progress", role: "status" },
    h("div", { class: "mo-progress-text" }, [j.phase || "Starting", j.files_total ? `${j.files_done || 0} / ${j.files_total} files` : null, j.bytes_total ? `${fmtBytes(j.bytes_done)} / ${fmtBytes(j.bytes_total)}` : null].filter(Boolean).join(" · ")),
    h("div", { class: "mo-bar" }, h("i", { style: { width: `${j.files_total ? Math.min(100, (100 * (j.files_done || 0)) / j.files_total) : 0}%` } }))) : null;

  const fresh = [...sel].filter((s) => !(x.seasons || []).includes(s));
  const syncLabel = fresh.length ? `Sync ${plural(fresh.length, "season")}` : x.synced ? "Update" : "Sync";
  const isArmed = armed.has(x.id);
  const actions = busy
    ? [h("button", { type: "button", class: "c-btn filled sm", onclick: () => cancel(x) }, "Cancel")]
    : [
      h("button", { type: "button", class: "c-btn sm mo-primary", disabled: anyBusy || !sel.size, onclick: () => sync(x) }, syncLabel),
      h("button", { type: "button", class: "c-btn filled sm", disabled: anyBusy, onclick: () => check(x) }, "Check"),
      x.synced || !x.builtin ? h("button", { type: "button", class: ["c-btn sm mo-remove", isArmed && "armed"], disabled: anyBusy, onclick: () => remove(x) }, isArmed ? "Remove local copy?" : "Remove") : null,
    ];

  return h("div", { class: "mo-src", "data-hub": x.id },
    h("div", { class: "mo-src-head" },
      h("span", { class: "mo-src-name" }, x.repo_url ? h("a", { href: x.repo_url, target: "_blank", rel: "noopener" }, x.label) : x.label),
      h("span", { class: ["mo-src-state", `is-${state.toLowerCase().replace(" ", "-")}`] }, state),
      x.synced ? shown : null),
    h("div", { class: "mo-src-meta" }, meta),
    meta2 ? h("div", { class: "mo-src-meta" }, meta2) : null,
    chips.length ? h("div", { class: "mo-chips", role: "group", "aria-label": "Seasons to sync" }, chips) : null,
    progress,
    h("div", { class: "mo-actions" }, actions),
    notes.has(x.id) ? h("div", { class: "mo-note" }, notes.get(x.id)) : null);
}

/* ---------- actions ---------- */

async function toggle(x) {
  try {
    await postJSON("/api/remote/toggle", { hub: x.id, enabled: !x.enabled });
    toast(`${x.label} ${x.enabled ? "hidden" : "shown"}`);
    reloadSoon();
  } catch (err) { notes.set(x.id, `Couldn't update · ${err.message}`); render?.(); }
}

async function check(x) {
  notes.set(x.id, "Checking…"); render?.();
  try {
    const r = await postJSON("/api/remote/check", { hub: x.id });
    checks.set(x.id, r);
    const p = r.pending || {};
    const changes = [p.new && `${p.new} new`, p.changed && `${p.changed} updated`, p.removed && `${p.removed} removed`].filter(Boolean).join(" · ");
    notes.set(x.id, `${changes ? `${changes} upstream` : "Up to date"} · latest ${day(p.latest_round)}`);
    if (!x.synced && !(x.seasons || []).length) {
      const newest = (r.seasons || []).map((s) => s.season).sort().at(-1);
      if (!picked.get(x.id)?.size && newest) picked.set(x.id, new Set([newest]));
    }
  } catch (err) { notes.set(x.id, `Couldn't reach the hub · ${err.message}`); }
  render?.();
}

async function sync(x) {
  notes.delete(x.id);
  try {
    const r = await postJSON("/api/remote/sync", { hub: x.id, seasons: [...(picked.get(x.id) || [])] });
    hubs = hubs.map((y) => (y.id === x.id ? { ...y, job: r.job } : y));
    failed = false;
    emit();
    startPoll();
  } catch (err) { notes.set(x.id, `Couldn't start · ${err.message}`); }
  render?.();
}

async function cancel(x) {
  try { await postJSON("/api/remote/cancel", { hub: x.id }); }
  catch (err) { notes.set(x.id, `Couldn't cancel · ${err.message}`); render?.(); }
}

async function remove(x) {
  if (!armed.has(x.id)) {
    armed.set(x.id, setTimeout(() => { armed.delete(x.id); render?.(); }, ARM_MS));
    render?.();
    return;
  }
  clearTimeout(armed.get(x.id)); armed.delete(x.id);
  try {
    await postJSON("/api/remote/remove", { hub: x.id });
    toast(`Removed ${x.label}`);
    reloadSoon();
  } catch (err) { notes.set(x.id, `Couldn't remove · ${err.message}`); render?.(); }
}

/* ---------------------------------------------------------------- warnings */

/**
 * The Warnings panel: dataset validation warnings, then each synced hub's quality notes, grouped by
 * model and message (a note repeated over many rounds is one row with a count).
 * @param {HTMLElement} anchor
 * @returns {Promise<object | null>}
 */
export async function openWarnings(anchor) {
  const input = h("input", { type: "search", autocomplete: "off", spellcheck: "false", placeholder: "Filter", "aria-label": "Filter warnings" });
  const list = h("div", { class: "mo-list" }, h("div", { class: "mo-note" }, "Loading…"));
  let groups = [];
  const layer = openPopover(anchor, {
    title: "Warnings", placement: "bottom-end", width: 520, className: "mo-panel mo-warnings",
    content(body) { body.append(h("label", { class: "c-search", html: icon.search }, input), list); },
  });
  if (!layer) return null;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const out = [];
    for (const g of groups) {
      const rows = q ? g.rows.filter((r) => `${r.model} ${r.text}`.toLowerCase().includes(q)) : g.rows;
      if (!rows.length) continue;
      out.push(h("div", { class: "c-section" }, h("span", { class: "c-section-title" }, h("span", null, g.title), h("span", { class: "c-section-count" }, rows.reduce((n, r) => n + r.n, 0).toLocaleString()))));
      for (const r of rows) {
        out.push(h("div", { class: "mo-warn" },
          h("div", { class: "mo-warn-text" }, r.model ? h("span", { class: "mo-warn-model" }, r.model) : null, h("span", null, r.text)),
          r.n > 1 ? h("span", { class: "mo-warn-n", title: `${day(r.first)} – ${day(r.last)}` }, `× ${r.n}`) : r.first ? h("span", { class: "mo-warn-n" }, day(r.first)) : null));
      }
    }
    list.replaceChildren(...(out.length ? out : [h("div", { class: "mo-note" }, q ? "Nothing matches" : "No warnings")]));
  };
  input.addEventListener("input", draw);
  try {
    const w = await loadWarningSummary();
    groups = [];
    if (w.status.length) groups.push({ title: "Dataset", rows: w.status.map((t) => ({ model: "", text: t, n: 1 })) });
    const notesBy = await Promise.all(w.hubs.map((x) => getJSON(`/api/remote/warnings?hub=${encodeURIComponent(x.id)}`).catch(() => ({ warnings: [] }))));
    w.hubs.forEach((x, i) => groups.push({ title: x.label, rows: groupNotes(notesBy[i].warnings || []) }));
    draw();
    layer.place();
  } catch (err) { list.replaceChildren(h("div", { class: "mo-note" }, `Couldn't load · ${err.message}`)); }
  return layer;
}

// "2023-10-14-FluSight-baseline_cat: not shown, …" over 30 rounds → one row "FluSight-baseline_cat · not shown, … × 30"
function groupNotes(warnings) {
  const by = new Map();
  for (const w of warnings) {
    const msg = typeof w === "string" ? w : w.message || "";
    const model = (typeof w === "object" && w.model) || "";
    const text = model ? msg.replace(/^\d{4}-\d{2}-\d{2}-[^:]+:\s*/, "") : msg;
    const key = `${model}|${text}`;
    const g = by.get(key) || { model, text, n: 0, first: null, last: null };
    g.n++;
    const d = typeof w === "object" ? w.reference_date : null;
    if (d) { if (!g.first || d < g.first) g.first = d; if (!g.last || d > g.last) g.last = d; }
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => a.model.localeCompare(b.model) || b.n - a.n);
}
