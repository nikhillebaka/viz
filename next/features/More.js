/* The ⋯ bubble at the top right, beside the theme bubble: data sources (live hubs), warnings, refresh,
 * copy link and the Guide (which ends with the shortcuts). Each panel is its own module, loaded on first use.
 * Also the small helpers those panels share (JSON requests, sizes, relative times). */
import { h, on } from "../lib/dom.js";
import { apiUrl } from "../lib/api.js";
import { glass } from "../ui/glass.js";
import { activeLayer, openMenu, tooltip } from "../ui/floating.js";
import { pill, icon, toast } from "../ui/controls.js";

const TEXT_FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/* ---------- shared helpers ---------- */

/**
 * GET JSON.
 * @param {string} url
 * @returns {Promise<any>} the body; rejects with the server's `error` text, else "HTTP n"
 */
export async function getJSON(url) {
  const r = await fetch(apiUrl(url));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/**
 * POST JSON (the server requires the JSON content type on /api/remote/*, /api/ensemble/*, /api/workspace/*).
 * @param {string} url
 * @param {object} body
 * @param {{ okStatuses?: number[] }} [opts] statuses that carry a normal answer (e.g. 422 from /api/remote/add)
 * @returns {Promise<any>}
 */
export async function postJSON(url, body = {}, { okStatuses = [] } = {}) {
  const r = await fetch(apiUrl(url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !okStatuses.includes(r.status)) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/** "94.6 MB" */
export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"], i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1000)));
  return `${(n / 1000 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" from an ISO timestamp */
export function fmtAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Reload the page (and so the manifest) after a short pause, so a toast can be read first. */
export function reloadSoon(ms = 1200) { setTimeout(() => location.reload(), ms); }

/* ---------- warnings count (shown in the menu) ---------- */

/**
 * Dataset warnings from /api/status plus each enabled synced hub's quality notes.
 * @returns {Promise<{ status: string[], hubs: object[], count: number }>}
 */
export async function loadWarningSummary() {
  const [st, rh] = await Promise.all([getJSON("/api/status").catch(() => ({})), getJSON("/api/remote/hubs").catch(() => ({ hubs: [] }))]);
  const status = (st.validation_warnings || []).map(String);
  const hubs = (rh.hubs || []).filter((x) => x.synced && x.warnings_count);
  return { status, hubs, count: status.length + hubs.reduce((n, x) => n + x.warnings_count, 0) };
}

/* ---------- the bubble ---------- */

const panels = {
  hubs: () => import("./Hubs.js").then((m) => m.openHubs),
  warnings: () => import("./Hubs.js").then((m) => m.openWarnings),
};

/** Open the Guide (at a topic) from the ⋯ bubble. */
const guide = (topic, anchor) => import("./Guide.js").then((m) => m.openGuide(topic, anchor)).catch((err) => console.error("viz: the Guide could not open", err));
const guideHash = () => (/^#guide(\/|$)/.test(location.hash) ? decodeURIComponent(location.hash.slice(7)) || "start" : null);

/**
 * Put the ⋯ bubble in a zone (after what is there) and wire its menu and keys (G the Guide, ? its
 * shortcuts). A `#guide/<topic>` hash opens the Guide there, on load and when the hash changes.
 * @param {HTMLElement} zone the fixed top-right zone
 * @param {{ manifest: object, store: object, chart: object | null }} ctx
 * @returns {{ destroy(): void }}
 */
export function mountMore(zone, ctx) {
  const hubless = Boolean(ctx.hubless || ctx.manifest?.empty);
  const btn = pill({ icon: icon.more, ariaLabel: "More", className: "app-more" });
  btn.setAttribute("aria-haspopup", "menu");
  zone.append(btn);
  const g = glass(btn);
  const tip = tooltip(btn, "More", { placement: "bottom" });
  let warnings = { count: 0 };
  const refreshWarnings = () => (hubless ? Promise.resolve() : loadWarningSummary().then((w) => { warnings = w; }).catch(() => {}));
  // a quiet dot while a hub sync runs, or after one failed (until Data sources is opened)
  const dot = h("span", { class: "mo-dot", hidden: true, "aria-hidden": "true" });
  btn.append(dot);
  let offSync = () => {}, gone = false;
  const showSync = (st) => {
    dot.hidden = !st;
    dot.classList.toggle("is-failed", st === "failed");
    dot.classList.toggle("is-new", st === "new");
    const say = { running: "hub syncing", failed: "hub sync failed", new: "new forecasts on a live hub" }[st];
    btn.setAttribute("aria-label", say ? `More · ${say}` : "More");
    tip.set(say ? `More · ${say}` : "More");
  };
  if (!hubless) {
    (window.requestIdleCallback ?? setTimeout)(() => {
      if (gone) return;
      refreshWarnings();
      import("./Hubs.js").then((m) => { if (gone) return; offSync = m.watchSync(showSync); return m.resumeSync(ctx); }).catch(() => {});
    });
  }

  const open = (name) => panels[name]().then((fn) => fn(btn, ctx)).catch((err) => console.error(`viz: ${name} could not open`, err));

  btn.addEventListener("click", () => {
    const wsCount = ctx.manifest?.workspace_hubs?.length || 0;
    const dataShortcut = hubless ? "Add" : wsCount > 1 ? `${wsCount} hubs` : undefined;
    const items = hubless
      ? [
        { label: "Data sources", shortcut: dataShortcut, onSelect: () => open("hubs") },
        "-",
        { label: "Guide", shortcut: "G", onSelect: () => guide(null, btn) },
        { label: "Shortcuts", shortcut: "?", onSelect: () => guide("shortcuts", btn) },
      ]
      : [
        { label: "Briefing", shortcut: "B", onSelect: () => ctx.openBriefing?.() },
        { label: "Data sources", shortcut: dataShortcut, onSelect: () => open("hubs") },
        warnings.count ? { label: "Warnings", shortcut: warnings.count.toLocaleString(), onSelect: () => open("warnings") } : null,
        "-",
        { label: "Refresh data", onSelect: () => refresh(ctx) },
        { label: "Copy link", onSelect: copyLink },
        "-",
        { label: "Guide", shortcut: "G", onSelect: () => guide(null, btn) },
        { label: "Shortcuts", shortcut: "?", onSelect: () => guide("shortcuts", btn) },
        "-",
        { label: "Classic viz", onSelect: () => location.assign("/classic/") },
      ].filter(Boolean);
    openMenu(btn, { items, placement: "bottom-end", label: "More" });
    if (!hubless) refreshWarnings();
  });

  const offKeys = on(document, "keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    if (activeLayer() || e.target.closest?.(TEXT_FIELD)) return;
    if (e.key === "g" || e.key === "G") { e.preventDefault(); guide(null, btn); }
    else if (e.key === "?") { e.preventDefault(); guide("shortcuts", btn); }
  });
  const fromHash = () => { const t = guideHash(); if (t) guide(t, btn); };
  const offHash = on(window, "hashchange", fromHash);
  fromHash();

  return { destroy() { gone = true; offSync(); offKeys(); offHash(); tip.destroy(); g.destroy(); btn.remove(); } };
}

/* The server re-reads the hub's files. If nothing on disk changed (the manifest's stamp is the same) the
 * page stays as it is; otherwise it reloads once, so every part picks up the new data together, and the
 * fresh page says so (app.js reads viz.refreshed). One message either way. */
async function refresh(ctx) {
  const t = toast("Refreshing data…", { duration: 60000, tone: "info" });
  try {
    const r = await postJSON("/api/cache/refresh");
    const fresh = await fetch(apiUrl("/api/next/manifest"), { cache: "no-store" }).then((x) => x.json());
    if (fresh.stamp && fresh.stamp === ctx.manifest.stamp) { t.dismiss(); toast("Up to date"); return; }
    try { sessionStorage.setItem("viz.refreshed", String(r.models_cached ?? "")); } catch {}
    location.reload();
  } catch (err) {
    t.dismiss();
    toast(`Refresh failed · ${err.message}`, { tone: "error" });
  }
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Link copied");
  } catch {
    toast("Couldn't copy the link", { tone: "error" });
  }
}
