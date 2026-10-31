/**
 * FluSight Sandbox Lab — Live hub data: brand data-source menu, Live Hub Data modal, and sync progress.
 *
 * Nothing here downloads forecasts on its own. The only network-touching calls (list a hub, sync, connect a
 * bucket) run when the user presses a button in the brand menu or the modal; everything else reads local state.
 */

import { escapeHtml, showToast, formatBytes, formatAgo } from "../constants.js";
import { state, formatSeasonShort } from "../state.js";
import {
  fetchRemoteHubs,
  fetchRemoteJob,
  fetchRemoteWarnings,
  checkRemoteHub,
  startRemoteSync,
  cancelRemoteSync,
  removeRemoteHub,
  toggleRemoteHub,
  addRemoteHub,
} from "../api.js";

const ICON = {
  check: `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
  refresh: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`,
  compare: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>`,
  plus: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  cloud: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>`,
  download: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
};

const ui = {
  hubs: [],
  currentSeason: null,
  activeHubId: null,
  checks: {}, // hubId -> /api/remote/check result
  checking: {}, // hubId -> bool
  checkError: {},
  selectedSeasons: {}, // hubId -> Set
  jobs: {}, // hubId -> job dict
  lastResult: {}, // hubId -> {kind, text}
  warnings: {}, // hubId -> list
  addState: null, // {kind, text}
  removeArmed: null,
  qualityOpen: false,
  connectOpen: false,
  connectValue: "",
  pollTimer: null,
  lastError: false,
};

let callbacks = {};

// ----------------------------------------------------------------------------
// Init & shared state
// ----------------------------------------------------------------------------

export function initRemoteHubs(cbs = {}) {
  callbacks = cbs;
  const btn = document.getElementById("btn-brand-menu");
  const menu = document.getElementById("brand-menu");
  if (!btn || !menu) return;

  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const open = !menu.classList.contains("open");
    setMenuOpen(open);
    if (open) {
      ui.lastError = false;
      renderBrandMenu();
      await refreshHubs();
      renderBrandMenu();
      focusFirstMenuItem();
    }
  });

  document.addEventListener("click", (e) => {
    // Items re-render on click, so ignore clicks on nodes that are no longer attached
    if (!e.target.isConnected) return;
    if (!menu.contains(e.target) && !btn.contains(e.target)) setMenuOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.classList.contains("open")) setMenuOpen(false);
  });

  menu.addEventListener("keydown", (e) => {
    const items = Array.from(menu.querySelectorAll("button:not(:disabled)"));
    const idx = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setMenuOpen(false);
      btn.focus();
    }
  });

  const modal = document.getElementById("remote-hub-modal");
  document.getElementById("btn-close-remote-hub")?.addEventListener("click", closeRemoteHubModal);
  document.getElementById("btn-remote-done")?.addEventListener("click", closeRemoteHubModal);
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeRemoteHubModal();
  });

  // Local-only status read: resumes the progress display if a sync was running before a page reload
  refreshHubs().then(() => {
    updateBrandDot();
    Object.values(ui.jobs).forEach((j) => {
      if (j && j.status === "running") ensurePolling();
    });
  });
}

function setMenuOpen(open) {
  const btn = document.getElementById("btn-brand-menu");
  const menu = document.getElementById("brand-menu");
  if (!btn || !menu) return;
  menu.classList.toggle("open", open);
  btn.setAttribute("aria-expanded", String(open));
}

function focusFirstMenuItem() {
  const menu = document.getElementById("brand-menu");
  const first = menu && menu.querySelector("button:not(:disabled)");
  if (first) first.focus({ preventScroll: true });
}

async function refreshHubs() {
  try {
    const data = await fetchRemoteHubs();
    ui.hubs = data.hubs || [];
    ui.currentSeason = data.current_season || ui.currentSeason;
    ui.hubs.forEach((h) => {
      if (h.job) ui.jobs[h.id] = h.job;
    });
    state.remoteHubs = ui.hubs;
    if (!ui.activeHubId || !ui.hubs.some((h) => h.id === ui.activeHubId)) {
      ui.activeHubId = ui.hubs[0]?.id || null;
    }
  } catch (err) {
    console.warn("Could not load hub status:", err);
  }
}

/** Called after /api/metadata loads so the menu reflects the same inventory as the model bar. */
export function setRemoteHubsFromMetadata(list) {
  if (!Array.isArray(list)) return;
  list.forEach((h) => {
    const cur = ui.hubs.find((x) => x.id === h.id);
    if (cur) Object.assign(cur, h);
    else ui.hubs.push({ ...h });
  });
  state.remoteHubs = ui.hubs;
  updateBrandDot();
}

function hubById(id) {
  return ui.hubs.find((h) => h.id === id);
}

function isRunning(hubId) {
  return ui.jobs[hubId]?.status === "running";
}

function anyRunning() {
  return ui.hubs.some((h) => isRunning(h.id));
}

function pendingCount(hub) {
  const p = hub && hub.pending;
  return p ? (p.new || 0) + (p.changed || 0) : 0;
}

function updateBrandDot() {
  const dot = document.getElementById("brand-status-dot");
  const btn = document.getElementById("btn-brand-menu");
  if (!dot) return;
  let st = "";
  let title = "Data sources: this repository and live forecast hubs";
  if (anyRunning()) {
    st = "syncing";
    title = "Syncing live hub data…";
  } else if (ui.lastError) {
    st = "error";
    title = "The last hub sync failed — open the menu for details";
  } else if (ui.hubs.some((h) => h.synced && h.enabled && pendingCount(h) > 0)) {
    st = "new";
    title = "New forecasts are available from a live hub";
  }
  if (st) dot.setAttribute("data-state", st);
  else dot.removeAttribute("data-state");
  if (btn) btn.title = title;
}

// ----------------------------------------------------------------------------
// Brand menu
// ----------------------------------------------------------------------------

function repoModelCount() {
  return Object.values(state.models || {}).filter((m) => m && m.source !== "hub").length;
}

function hubMetaLine(hub) {
  const job = ui.jobs[hub.id];
  if (job && job.status === "running") {
    if (job.files_total > 0) return `${job.phase} · ${job.files_done} / ${job.files_total} files`;
    return `${job.phase}…`;
  }
  if (!hub.synced) return "Not synced · choose seasons to bring in";
  const parts = [`synced ${formatAgo(hub.last_sync)}`];
  if (hub.latest_round) parts.push(`latest ${hub.latest_round} (${hub.latest_round_models})`);
  const pend = pendingCount(hub);
  const outdated = hub.pending?.outdated || 0;
  if (pend > outdated) parts.push(`${pend - outdated} new upstream`);
  if (outdated > 0) parts.push("sync to add season peak data");
  if (!hub.enabled) parts.push("hidden");
  return parts.join(" · ");
}

function renderBrandMenu() {
  const menu = document.getElementById("brand-menu");
  if (!menu) return;
  const synced = ui.hubs.filter((h) => h.synced);
  const enabledSynced = synced.filter((h) => h.enabled);

  let html = `<div class="brand-menu-header">DATA SOURCES</div>`;
  html += `
    <button type="button" class="brand-source-row" role="menuitemcheckbox" aria-checked="true" disabled>
      <span class="brand-source-check on locked">${ICON.check}</span>
      <span class="brand-source-name">This repository</span>
      <span class="brand-source-count">${repoModelCount()} models</span>
      <span class="brand-source-meta">model-output/ · local-output/ · synthetic</span>
    </button>`;

  ui.hubs.forEach((hub) => {
    const running = isRunning(hub.id);
    const job = ui.jobs[hub.id];
    const checkCls = hub.synced ? (hub.enabled ? "on" : "") : "empty";
    const live = running
      ? `<span class="brand-live-pill syncing">SYNCING</span>`
      : (hub.synced && hub.enabled ? `<span class="brand-live-pill">LIVE</span>` : "");
    const count = hub.synced ? `${hub.models || 0} models` : "";
    const pct = running && job.files_total ? Math.round((job.files_done / job.files_total) * 100) : 0;
    html += `
      <button type="button" class="brand-source-row" data-hub="${escapeHtml(hub.id)}"
        role="menuitemcheckbox" aria-checked="${hub.synced && hub.enabled ? "true" : "false"}"
        title="${hub.synced ? (hub.enabled ? "Hide" : "Show") + " this hub's models in the dashboard" : "Set up this hub"}">
        <span class="brand-source-check ${checkCls}">${hub.synced && hub.enabled ? ICON.check : ""}</span>
        <span class="brand-source-name">${escapeHtml(hub.label)}${live}</span>
        <span class="brand-source-count">${count}</span>
        <span class="brand-source-meta">${escapeHtml(hubMetaLine(hub))}</span>
        ${running ? `<span class="brand-menu-progress"><span style="width:${pct}%"></span></span>` : ""}
      </button>`;
  });

  const compareHub = enabledSynced[0];
  const ensembleKey = compareHub ? findHubEnsemble(compareHub.id) : null;
  html += `<div class="brand-menu-divider"></div>`;
  html += `
    <button type="button" class="brand-menu-action" data-action="check" ${synced.length && !anyRunning() ? "" : "disabled"}>
      ${ICON.refresh}<span>Check for new forecasts</span>
    </button>
    <button type="button" class="brand-menu-action" data-action="compare" ${ensembleKey ? "" : "disabled"}
      title="${ensembleKey ? `Select ${escapeHtml(ensembleKey)} and jump to its latest round` : "Sync a hub first"}">
      ${ICON.compare}<span>Compare latest round with ${escapeHtml(compareHub ? compareHub.short_label : "hub")} ensemble</span>
    </button>
    <button type="button" class="brand-menu-action" data-action="connect">
      ${ICON.plus}<span>Connect another hub…</span>
    </button>
    <button type="button" class="brand-menu-action" data-action="manage">
      ${ICON.cloud}<span>Manage live hub data…</span>
    </button>`;
  menu.innerHTML = html;

  menu.querySelectorAll(".brand-source-row[data-hub]").forEach((row) => {
    row.addEventListener("click", () => onHubRowClick(row.getAttribute("data-hub")));
  });
  menu.querySelectorAll(".brand-menu-action").forEach((b) => {
    b.addEventListener("click", () => onMenuAction(b.getAttribute("data-action"), compareHub));
  });
}

async function onHubRowClick(hubId) {
  const hub = hubById(hubId);
  if (!hub) return;
  if (!hub.synced) {
    setMenuOpen(false);
    openRemoteHubModal(hubId);
    return;
  }
  if (isRunning(hubId)) return;
  try {
    await toggleRemoteHub(hubId, !hub.enabled);
    hub.enabled = !hub.enabled;
    renderBrandMenu();
    updateBrandDot();
    if (callbacks.onInventoryChanged) await callbacks.onInventoryChanged();
  } catch (err) {
    showToast(`Could not update ${hub.label}: ${err.message}`, { kind: "error" });
  }
}

async function onMenuAction(action, compareHub) {
  if (action === "manage") {
    setMenuOpen(false);
    openRemoteHubModal(ui.activeHubId);
  } else if (action === "connect") {
    setMenuOpen(false);
    openRemoteHubModal(ui.activeHubId, { focusConnect: true });
  } else if (action === "compare" && compareHub) {
    setMenuOpen(false);
    compareWithHubEnsemble(compareHub.id);
  } else if (action === "check") {
    await checkAllSynced();
  }
}

async function checkAllSynced() {
  const synced = ui.hubs.filter((h) => h.synced);
  for (const hub of synced) {
    try {
      ui.checking[hub.id] = true;
      renderBrandMenu();
      const res = await checkRemoteHub(hub.id);
      ui.checks[hub.id] = res;
      hub.pending = res.pending;
      const n = pendingCount(hub) + (res.pending?.removed || 0);
      if (n > 0) {
        const p = res.pending;
        const bits = [];
        if (p.new) bits.push(`${p.new} new`);
        const outdated = p.outdated || 0;
        if (p.changed > outdated) bits.push(`${p.changed - outdated} updated`);
        if (p.removed) bits.push(`${p.removed} removed`);
        const what = bits.length ? `${bits.join(", ")} forecast files upstream` : "";
        const peakNote = outdated ? `${outdated} synced files need re-reading to add season peak forecasts` : "";
        showToast(`${hub.label}: ${[what, peakNote].filter(Boolean).join("; ")} (latest round ${p.latest_round}).`, {
          kind: "info",
          duration: 9000,
          action: { label: "Sync now", onClick: () => runSync(hub.id, hub.seasons) },
        });
      } else {
        showToast(`${hub.label} is up to date (latest round ${res.pending?.latest_round || "—"}).`, { kind: "success" });
      }
    } catch (err) {
      showToast(`Could not reach ${hub.label}: ${err.message}`, { kind: "error", duration: 9000 });
    } finally {
      ui.checking[hub.id] = false;
    }
  }
  renderBrandMenu();
  updateBrandDot();
}

function findHubEnsemble(hubId) {
  const keys = Object.keys(state.models || {}).filter((k) => state.models[k]?.hub === hubId);
  const preferred = [`${hubId}:FluSight-ensemble`, `${hubId}:FluSight-trained_mean`];
  for (const p of preferred) if (keys.includes(p)) return p;
  return keys.find((k) => /ensemble/i.test(k)) || null;
}

function compareWithHubEnsemble(hubId) {
  const key = findHubEnsemble(hubId);
  if (!key) return;
  const meta = state.models[key] || {};
  state.selectedModels.add(key);
  const latest = meta.max_date;
  if (callbacks.onCompare) callbacks.onCompare(key, latest && state.dates.includes(latest) ? latest : null);
  showToast(`Comparing with ${meta.display_name || key}${latest ? ` for ${latest}` : ""}.`, { kind: "success" });
}

// ----------------------------------------------------------------------------
// Modal
// ----------------------------------------------------------------------------

export function isRemoteHubModalOpen() {
  const modal = document.getElementById("remote-hub-modal");
  return !!modal && !modal.classList.contains("hidden");
}

export async function openRemoteHubModal(hubId, opts = {}) {
  const modal = document.getElementById("remote-hub-modal");
  if (!modal) return;
  if (hubId) ui.activeHubId = hubId;
  ui.addState = null;
  ui.removeArmed = null;
  modal.classList.remove("hidden");
  await refreshHubs();
  renderModal({ focusConnect: !!opts.focusConnect });
  // Opening the modal is the user's request to see what the hub offers: list it (one cheap call)
  if (!opts.focusConnect && ui.activeHubId && !ui.checks[ui.activeHubId]) {
    runCheck(ui.activeHubId);
  }
}

export function closeRemoteHubModal() {
  const modal = document.getElementById("remote-hub-modal");
  if (modal) modal.classList.add("hidden");
  ui.removeArmed = null;
}

async function runCheck(hubId) {
  ui.checking[hubId] = true;
  ui.checkError[hubId] = null;
  renderModal();
  try {
    const res = await checkRemoteHub(hubId);
    ui.checks[hubId] = res;
    const hub = hubById(hubId);
    if (hub && res.synced) hub.pending = res.pending;
    if (!ui.selectedSeasons[hubId]) {
      const defaults = new Set(hub && hub.seasons && hub.seasons.length ? hub.seasons : []);
      if (res.current_season && res.seasons.some((s) => s.season === res.current_season)) defaults.add(res.current_season);
      if (defaults.size === 0 && res.seasons[0]) defaults.add(res.seasons[0].season);
      ui.selectedSeasons[hubId] = defaults;
    }
  } catch (err) {
    ui.checkError[hubId] = err.message;
  } finally {
    ui.checking[hubId] = false;
    renderModal();
    updateBrandDot();
  }
}

function seasonLabel(season) {
  return `${formatSeasonShort(season)} season`;
}

function renderModal({ focusConnect = false } = {}) {
  const body = document.getElementById("remote-hub-body");
  if (!body || !isRemoteHubModalOpen()) return;
  const hub = hubById(ui.activeHubId);

  let html = "";
  if (ui.hubs.length > 1) {
    html += `<div class="remote-hub-tabs">${ui.hubs.map((h) => `
      <button type="button" class="modal-nav-pill ${h.id === ui.activeHubId ? "active" : ""}" data-hub-tab="${escapeHtml(h.id)}">
        <span>${escapeHtml(h.label)}</span>
      </button>`).join("")}</div>`;
  }

  if (hub) {
    html += renderStatusCard(hub);
    html += renderSeasonsSection(hub);
    if (hub.synced) html += renderQualitySection(hub);
  }
  html += renderConnectSection(focusConnect);
  body.innerHTML = html;
  wireModal(body, hub);

  if (focusConnect) {
    const input = body.querySelector("#remote-connect-input");
    if (input) setTimeout(() => input.focus(), 30);
  }
}

function renderStatusCard(hub) {
  const repo = hub.repo_url
    ? `<a href="${escapeHtml(hub.repo_url)}" target="_blank" rel="noopener noreferrer" title="Hub repository">${escapeHtml(hub.bucket)} ↗</a>`
    : `<a title="S3 bucket">${escapeHtml(hub.bucket)}</a>`;
  const sub = hub.synced
    ? `Synced ${formatAgo(hub.last_sync)} · ${hub.files || 0} files · ${formatBytes(hub.bytes)} on disk`
    : "Not synced yet. Pick seasons below, then press Sync.";
  const truth = hub.truth && hub.truth.oracle ? hub.truth.oracle.as_of : null;
  const stats = hub.synced ? `
    <div class="remote-stats">
      <div class="remote-stat"><span class="remote-stat-label">MODELS</span><span class="remote-stat-val">${hub.models || 0}</span></div>
      <div class="remote-stat"><span class="remote-stat-label">LATEST ROUND</span><span class="remote-stat-val" title="${hub.latest_round_models || 0} models">${escapeHtml(hub.latest_round || "—")}</span></div>
      <div class="remote-stat"><span class="remote-stat-label">TRUTH AS OF</span><span class="remote-stat-val" title="Newest truth vintage wins per observation; the repository fills any gaps">${escapeHtml(truth || "—")}</span></div>
      <div class="remote-stat"><span class="remote-stat-label">QUALITY NOTES</span><span class="remote-stat-val">${hub.warnings_count || 0}</span></div>
    </div>` : "";
  return `
    <div class="remote-status-card">
      <div>
        <div class="remote-status-name">${escapeHtml(hub.label)} ${repo}</div>
        <div class="remote-status-sub">${escapeHtml(sub)}</div>
      </div>
      ${hub.synced ? `<label class="remote-toggle" title="Show or hide this hub's models without deleting the local copy">
        <input type="checkbox" id="remote-toggle-enabled" ${hub.enabled ? "checked" : ""} ${isRunning(hub.id) ? "disabled" : ""}> Show in dashboard
      </label>` : "<span></span>"}
      ${stats}
    </div>`;
}

function renderSeasonsSection(hub) {
  const check = ui.checks[hub.id];
  const checking = ui.checking[hub.id];
  const err = ui.checkError[hub.id];
  const job = ui.jobs[hub.id];
  const running = isRunning(hub.id);
  const selected = ui.selectedSeasons[hub.id] || new Set();

  let right = "";
  if (checking) right = `<span class="remote-spinner" aria-label="Listing hub"></span>`;
  else if (check && check.pending) right = `<span>listed ${formatAgo(check.pending.checked_at)}</span>`;

  let list = "";
  if (err) {
    list = `<div class="remote-alert error"><strong>Could not reach the hub.</strong> ${escapeHtml(err)}</div>`;
  } else if (!check) {
    list = `<div class="remote-muted">${checking ? "Listing what the hub has available…" : "List the hub to see which seasons are available."}</div>`;
  } else {
    list = `<div class="remote-season-list">${check.seasons.map((s) => {
      const isCur = s.season === check.current_season;
      const rounds = s.rounds.length;
      return `
        <label class="remote-season-row">
          <input type="checkbox" data-season="${escapeHtml(s.season)}" ${selected.has(s.season) ? "checked" : ""} ${running ? "disabled" : ""}>
          <span class="rs-name">${escapeHtml(seasonLabel(s.season))}
            ${isCur ? `<span class="remote-badge current">CURRENT</span>` : ""}
            ${s.synced ? `<span class="remote-badge">SYNCED</span>` : ""}</span>
          <span class="rs-meta">${rounds} round${rounds === 1 ? "" : "s"}</span>
          <span class="rs-meta">${s.models} models</span>
          <span class="rs-meta">${s.files} files · ${formatBytes(s.bytes)}</span>
        </label>`;
    }).join("")}</div>`;
  }

  // Sync button label reflects what will actually download
  let syncLabel = "Sync";
  let syncDisabled = running || !check || selected.size === 0;
  if (check) {
    const newSeasons = check.seasons.filter((s) => selected.has(s.season) && !s.synced);
    const bytes = newSeasons.reduce((a, s) => a + s.bytes, 0);
    const pend = check.pending ? (check.pending.new || 0) + (check.pending.changed || 0) + (check.pending.removed || 0) : 0;
    if (newSeasons.length > 0) syncLabel = `Sync ${newSeasons.length} season${newSeasons.length === 1 ? "" : "s"} · ${formatBytes(bytes)}`;
    else if (hub.synced) syncLabel = pend > 0 ? `Update · ${pend} changed file${pend === 1 ? "" : "s"}` : "Re-check & update";
  }

  let progress = "";
  if (running) {
    const pct = job.files_total ? Math.round((job.files_done / job.files_total) * 100) : 0;
    const bytes = job.bytes_total ? ` · ${formatBytes(job.bytes_done)} / ${formatBytes(job.bytes_total)}` : "";
    progress = `
      <div class="remote-progress" role="status" aria-live="polite">
        <div class="remote-progress-top">
          <span>${escapeHtml(job.phase)}${job.files_total ? ` · ${job.files_done} / ${job.files_total} files` : ""}${bytes}</span>
          <span>${pct}%</span>
        </div>
        <div class="remote-progress-bar"><span style="width:${pct}%"></span></div>
      </div>`;
  }
  const result = ui.lastResult[hub.id];
  const resultHtml = !running && result ? `<div class="remote-alert ${result.kind}">${result.html}</div>` : "";

  const removeArmed = ui.removeArmed === hub.id;
  return `
    <div class="remote-section">
      <div class="remote-section-title"><span>SEASONS TO SYNC</span>${right}</div>
      ${list}
      ${progress}
      ${resultHtml}
      <div class="remote-actions-row">
        ${running
          ? `<button type="button" class="remote-btn" id="remote-btn-cancel">Cancel sync</button>`
          : `<button type="button" class="remote-btn primary" id="remote-btn-sync" ${syncDisabled ? "disabled" : ""}>${ICON.download}<span>${escapeHtml(syncLabel)}</span></button>`}
        <button type="button" class="remote-btn" id="remote-btn-check" ${checking || running ? "disabled" : ""}>${ICON.refresh}<span>Check hub</span></button>
        ${hub.synced ? `<button type="button" class="remote-btn danger" id="remote-btn-remove" style="margin-left:auto" ${running ? "disabled" : ""}>
          ${removeArmed ? "Click again to delete local copy" : "Remove local copy"}</button>` : ""}
      </div>
    </div>`;
}

function renderQualitySection(hub) {
  const notes = ui.warnings[hub.id];
  const n = hub.warnings_count || 0;
  let inner;
  if (!notes) inner = `<div class="remote-muted">Loading…</div>`;
  else if (notes.length === 0) inner = `<div class="remote-muted">No problems found. Every file passed schema, quantile-crossing, location, and duplicate checks.</div>`;
  else inner = `<ul class="remote-warning-list">${notes.slice(0, 200).map((w) => `<li>${escapeHtml(w.message)}</li>`).join("")}</ul>`;
  return `
    <details class="remote-details" id="remote-quality-details" ${ui.qualityOpen ? "open" : ""}>
      <summary><span>DATA QUALITY · ${n} NOTE${n === 1 ? "" : "S"}</span></summary>
      <div class="remote-details-body">
        <div class="remote-muted">Each downloaded file is checked for schema drift, crossing quantiles, negative counts, unknown locations, duplicate rows, and upstream resubmissions. Files that cannot be read are skipped, never partially loaded.</div>
        ${inner}
      </div>
    </details>`;
}

function renderConnectSection(open) {
  const st = ui.addState;
  return `
    <details class="remote-details" id="remote-connect-details" ${open || st || ui.connectOpen ? "open" : ""}>
      <summary><span>CONNECT ANOTHER HUB</span></summary>
      <div class="remote-details-body">
        <div class="remote-muted">Enter the public S3 bucket of a Hubverse hub (its <code>hub-config/admin.json</code> lists it). Viz only supports flu hubs that forecast US states and the national total for now.</div>
        <div class="remote-input-row">
          <input type="text" class="remote-input" id="remote-connect-input" placeholder="e.g. cdcepi-flusight-forecast-hub" spellcheck="false" autocomplete="off" aria-label="S3 bucket name" value="${escapeHtml(ui.connectValue)}">
          <button type="button" class="remote-btn" id="remote-btn-connect">Connect</button>
        </div>
        ${st ? `<div class="remote-alert ${st.kind}">${st.html}</div>` : ""}
      </div>
    </details>`;
}

function wireModal(body, hub) {
  body.querySelectorAll("[data-hub-tab]").forEach((b) => {
    b.addEventListener("click", () => {
      ui.activeHubId = b.getAttribute("data-hub-tab");
      ui.removeArmed = null;
      renderModal();
      if (!ui.checks[ui.activeHubId]) runCheck(ui.activeHubId);
    });
  });

  if (hub) {
    body.querySelectorAll("input[data-season]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const set = ui.selectedSeasons[hub.id] || new Set();
        if (cb.checked) set.add(cb.getAttribute("data-season"));
        else set.delete(cb.getAttribute("data-season"));
        ui.selectedSeasons[hub.id] = set;
        renderModal();
      });
    });
    body.querySelector("#remote-btn-sync")?.addEventListener("click", () => {
      runSync(hub.id, Array.from(ui.selectedSeasons[hub.id] || []));
    });
    body.querySelector("#remote-btn-cancel")?.addEventListener("click", async () => {
      try {
        await cancelRemoteSync(hub.id);
      } catch (err) {
        showToast(err.message, { kind: "error" });
      }
    });
    body.querySelector("#remote-btn-check")?.addEventListener("click", () => runCheck(hub.id));
    body.querySelector("#remote-btn-remove")?.addEventListener("click", () => onRemove(hub));
    body.querySelector("#remote-toggle-enabled")?.addEventListener("change", async (e) => {
      await onHubRowClick(hub.id);
      e.target.checked = !!hubById(hub.id)?.enabled;
    });
    const qd = body.querySelector("#remote-quality-details");
    qd?.addEventListener("toggle", async () => {
      ui.qualityOpen = qd.open;
      if (qd.open && !ui.warnings[hub.id]) {
        try {
          const res = await fetchRemoteWarnings(hub.id);
          ui.warnings[hub.id] = res.warnings || [];
        } catch {
          ui.warnings[hub.id] = [];
        }
        renderModal();
      }
    });
  }

  const cd = body.querySelector("#remote-connect-details");
  cd?.addEventListener("toggle", () => {
    ui.connectOpen = cd.open;
  });
  const input = body.querySelector("#remote-connect-input");
  input?.addEventListener("input", () => {
    ui.connectValue = input.value;
  });
  const connect = body.querySelector("#remote-btn-connect");
  const doConnect = () => onConnect(input ? input.value : "");
  connect?.addEventListener("click", doConnect);
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doConnect();
  });
}

async function onRemove(hub) {
  if (ui.removeArmed !== hub.id) {
    ui.removeArmed = hub.id;
    renderModal();
    setTimeout(() => {
      if (ui.removeArmed === hub.id) {
        ui.removeArmed = null;
        renderModal();
      }
    }, 3500);
    return;
  }
  ui.removeArmed = null;
  try {
    await removeRemoteHub(hub.id);
    delete ui.checks[hub.id];
    delete ui.warnings[hub.id];
    delete ui.lastResult[hub.id];
    delete ui.selectedSeasons[hub.id];
    await refreshHubs();
    renderModal();
    renderBrandMenu();
    updateBrandDot();
    showToast(`Removed the local copy of ${hub.label}.`, { kind: "success" });
    if (callbacks.onInventoryChanged) await callbacks.onInventoryChanged();
  } catch (err) {
    showToast(`Could not remove ${hub.label}: ${err.message}`, { kind: "error" });
  }
}

async function onConnect(bucket) {
  const value = (bucket || "").trim();
  if (!value) return;
  ui.addState = { kind: "", html: `<span class="remote-spinner"></span> Checking <strong>${escapeHtml(value)}</strong>…` };
  renderModal({ focusConnect: false });
  try {
    const res = await addRemoteHub(value);
    if (res.ok) {
      await refreshHubs();
      ui.activeHubId = res.hub.id;
      ui.addState = {
        kind: "success",
        html: res.already_registered
          ? `<strong>${escapeHtml(res.hub.label)}</strong> is already connected.`
          : `Connected <strong>${escapeHtml(res.hub.label)}</strong>. Choose seasons above, then press Sync.`,
      };
      renderModal();
      renderBrandMenu();
      runCheck(res.hub.id);
    } else {
      const reason = res.reason || "This hub is not supported.";
      ui.addState = { kind: "", html: `<strong>Not supported.</strong> ${escapeHtml(reason)}` };
      renderModal({ focusConnect: false });
      showToast(reason, { kind: "warning", duration: 9000 });
    }
  } catch (err) {
    ui.addState = { kind: "error", html: `<strong>Could not connect.</strong> ${escapeHtml(err.message)}` };
    renderModal({ focusConnect: false });
  }
}

// ----------------------------------------------------------------------------
// Sync & polling
// ----------------------------------------------------------------------------

async function runSync(hubId, seasons) {
  const hub = hubById(hubId);
  delete ui.lastResult[hubId];
  try {
    const res = await startRemoteSync(hubId, seasons && seasons.length ? seasons : undefined);
    ui.jobs[hubId] = res.job;
    renderModal();
    renderBrandMenu();
    updateBrandDot();
    ensurePolling();
  } catch (err) {
    showToast(`Could not start sync${hub ? ` for ${hub.label}` : ""}: ${err.message}`, { kind: "error", duration: 9000 });
  }
}

function ensurePolling() {
  if (ui.pollTimer) return;
  ui.pollTimer = setInterval(pollJobs, 700);
}

async function pollJobs() {
  const running = ui.hubs.filter((h) => isRunning(h.id));
  if (running.length === 0) {
    clearInterval(ui.pollTimer);
    ui.pollTimer = null;
    return;
  }
  for (const hub of running) {
    try {
      const res = await fetchRemoteJob(hub.id);
      const job = res.job;
      if (!job) continue;
      ui.jobs[hub.id] = job;
      if (res.hub) Object.assign(hub, res.hub);
      if (job.status !== "running") await onJobFinished(hub, job);
    } catch (err) {
      console.warn("Sync status poll failed:", err);
    }
  }
  // Don't rebuild the modal under the user's cursor while they type a bucket name
  if (document.activeElement?.id !== "remote-connect-input") renderModal();
  if (document.getElementById("brand-menu")?.classList.contains("open")) renderBrandMenu();
  updateBrandDot();
}

async function onJobFinished(hub, job) {
  const s = job.summary || {};
  if (job.status === "done") {
    const bits = [];
    if (s.added) bits.push(`${s.added} new`);
    if (s.updated) bits.push(`${s.updated} updated`);
    if (s.removed) bits.push(`${s.removed} removed`);
    const changes = bits.length ? bits.join(", ") : "no changes";
    const failed = s.failed ? ` ${s.failed} file${s.failed === 1 ? "" : "s"} could not be read and were skipped (see Data quality).` : "";
    ui.lastResult[hub.id] = {
      kind: s.failed ? "" : "success",
      html: `<strong>Sync complete.</strong> ${escapeHtml(changes)} forecast files.${escapeHtml(failed)}`,
    };
    ui.lastError = false;
    delete ui.warnings[hub.id];
    showToast(`${hub.label} synced: ${changes}.`, { kind: "success" });
  } else if (job.status === "cancelled") {
    ui.lastResult[hub.id] = { kind: "", html: `<strong>Sync cancelled.</strong> Files that finished downloading were kept; the next sync resumes from there.` };
  } else {
    ui.lastError = true;
    ui.lastResult[hub.id] = { kind: "error", html: `<strong>Sync failed.</strong> ${escapeHtml(job.error || "Unknown error")}` };
    showToast(`${hub.label} sync failed: ${job.error || "unknown error"}`, { kind: "error", duration: 10000 });
  }
  await refreshHubs();
  delete ui.checks[hub.id];
  if (isRemoteHubModalOpen() && ui.activeHubId === hub.id) runCheck(hub.id);
  if (callbacks.onInventoryChanged) await callbacks.onInventoryChanged();
}
