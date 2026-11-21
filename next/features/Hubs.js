/* Data sources: this repository and the live Hubverse hubs copied into the local cache (sync, check,
 * show or hide, remove, add), and the Warnings panel (dataset validation and each hub's quality notes).
 *
 * Nothing reaches the network until a button is pressed (Check, Sync, Add). A finished sync, a toggle or a
 * removal changes the model inventory, so the page reloads (after a toast) to read the new manifest.
 * Sync state lives in this module, so a sync keeps being followed when the panel closes. */
import { h } from "../lib/dom.js";
import { openPopover } from "../ui/floating.js";
import { icon, toast } from "../ui/controls.js";
import { clearAllCaches, loadCatalog } from "../lib/api.js";
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

/* forecast files added, changed or removed upstream since a shown hub's last sync */
const upstreamOf = (x) => { const p = x.pending || {}; return (p.new || 0) + Math.max(0, (p.changed || 0) - (p.outdated || 0)) + (p.removed || 0); };
const hasTruthUpdate = (x) => !!x.pending?.truth_changed;
const needsUpdateOf = (x) => upstreamOf(x) > 0 || hasTruthUpdate(x);

/** "running" while a sync runs, "failed" after one failed (until the panel is opened), "new" when a shown
 * hub has new forecasts or truth upstream, else "". */
export const syncStatus = () => (hubs.some(running) ? "running" : failed ? "failed" : hubs.some((x) => x.synced && x.enabled !== false && needsUpdateOf(x)) ? "new" : "");

/**
 * Follow the sync status (called now, then on each change).
 * @param {(status: "running" | "failed" | "new" | "") => void} fn
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

let activeRemoteHubId = null;
let activeCtx = null;

function openRemoteHub(remoteId) {
  const wsId = `remote_${remoteId}`;
  if (activeCtx?.switchContext && activeCtx?.manifest?.hub_id) {
    activeCtx.switchContext({ hub: wsId });
    return;
  }
  location.assign(`/next/?hub=${encodeURIComponent(wsId)}`);
}

async function applyWorkspaceUpdate() {
  clearAllCaches();
  if (activeCtx?.reloadCatalog) await activeCtx.reloadCatalog().catch(() => {});
  if (activeCtx?.switchContext && activeCtx?.manifest?.hub_id) {
    await activeCtx.switchContext({ hub: activeCtx.manifest.hub_id, forceReload: true });
    return;
  }
  reloadSoon(1200);
}

function finished(x) {
  const j = x.job || {}, s = j.summary || {};
  checks.delete(x.id);
  if (j.status === "done") {
    const changes = [s.added && `${s.added} new`, s.updated && `${s.updated} updated`, s.removed && `${s.removed} removed`, s.truth_updated && "truth updated"].filter(Boolean).join(" · ") || "no changes";
    notes.set(x.id, `Synced · ${changes}${s.failed ? ` · ${s.failed} unreadable` : ""}`);
    clearAllCaches();
    activeCtx?.reloadCatalog?.().catch(() => {});
    if (x.compatible !== false || x.id === activeRemoteHubId) {
      toast(`${x.label} synced · ${changes}`);
      if (activeCtx?.switchContext && activeCtx?.manifest?.hub_id) {
        setTimeout(() => applyWorkspaceUpdate(), 900);
      } else {
        reloadSoon(1600);
      }
    } else {
      toast(`${x.label} synced · ${changes}`, {
        duration: 10000,
        action: { label: "Open", onClick: () => openRemoteHub(x.id) },
      });
    }
  } else if (j.status === "cancelled") {
    notes.set(x.id, "Sync cancelled · finished files kept");
  } else {
    notes.set(x.id, `Sync failed · ${j.error || "unknown error"}`);
    failed = true;
    toast(`${x.label} sync failed`, { tone: "error" });
  }
}

let workspace = null;            // /api/workspace state
let browse = null;               // /api/workspace/browse snapshot
let browserOpen = false;
const wsArmed = new Map();       // local hub id → timer while Remove waits for its second click

async function loadWorkspace() {
  workspace = await getJSON("/api/workspace");
}

async function loadBrowse(path = "") {
  browse = await getJSON(path ? `/api/workspace/browse?path=${encodeURIComponent(path)}` : "/api/workspace/browse");
}

async function openLocalHub(id) {
  try { await postJSON("/api/workspace/activate", { id }); } catch { /* same-tab ?hub= works directly */ }
  if (activeCtx?.switchContext && activeCtx?.manifest?.hub_id) {
    activeCtx.switchContext({ hub: id });
    return;
  }
  location.assign(`/next/?hub=${encodeURIComponent(id)}`);
}

/**
 * The Data sources panel: local Hubverse folders plus synced S3 live hubs.
 * @param {HTMLElement} anchor the ⋯ bubble
 * @param {{ manifest?: object, hubless?: boolean }} [ctx]
 * @returns {Promise<object | null>} the layer
 */
export async function openHubs(anchor, ctx = {}) {
  activeCtx = ctx;
  const manifest = ctx.manifest || {};
  const currentHubId = manifest.hub_id || null;
  activeRemoteHubId = currentHubId?.startsWith("remote_") ? currentHubId.slice(7) : null;

  const localBox = h("div", { class: "mo-local-wrap" }, h("div", { class: "mo-note" }, "Loading local hubs…"));
  const remoteBox = h("div", { class: "mo-remote-wrap" });

  let localPathVal = "";
  let localNoteText = "";
  let remoteNoteText = "";
  let localBusy = true;
  let remoteBusy = false;
  let catalog = ctx.catalog || null;
  const aliasOpen = new Set();
  let autoExpandedAmbiguous = false;
  browserOpen = false;

  const list = h("div", { class: "mo-hubs" });
  const input = h("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "S3 bucket or GitHub owner/repo", "aria-label": "Hub S3 bucket or GitHub repository" });
  const addBtn = h("button", { type: "button", class: "c-btn filled sm" }, "Add hub");
  const addNote = h("div", { class: "mo-note", "aria-live": "polite" });
  const add = async () => {
    const source = input.value.trim();
    if (!source) { input.focus(); return; }
    addBtn.disabled = true; remoteNoteText = `Checking ${source}…`; addNote.textContent = remoteNoteText;
    try {
      const r = await postJSON("/api/remote/add", { source }, { okStatuses: [422] });
      if (!r.ok) remoteNoteText = `Not supported · ${r.reason || "not a supported Hubverse hub"}`;
      else {
        input.value = "";
        remoteNoteText = r.already_registered ? `${r.hub.label} · already connected` : `${r.hub.label} · added`;
        await loadHubs();
        render?.();
        if (!r.already_registered) check(r.hub);
      }
    } catch (err) { remoteNoteText = `Couldn't add · ${err.message}`; }
    addNote.textContent = remoteNoteText;
    addBtn.disabled = false;
  };
  addBtn.addEventListener("click", add);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });

  const layer = openPopover(anchor, {
    title: "Data sources", placement: "bottom-end", width: 480, className: "mo-panel mo-sources",
    onClose() { render = null; },
    content(body) {
      body.append(localBox, remoteBox);
    },
  });
  if (!layer) return null;
  failed = false; // seen
  emit();

  const connectLocalPath = async (rawPath, noteEl) => {
    const clean = (rawPath || "").trim();
    if (!clean) return;
    if (noteEl) noteEl.textContent = "Connecting hub…";
    try {
      const r = await postJSON("/api/workspace/add", { path: clean, activate: true });
      const hub = r.hub;
      localPathVal = "";
      if (hub?.id && hub.id === currentHubId && r.already_registered) {
        localNoteText = `${hub.label} · already active`;
        await loadWorkspace();
        render?.();
        return;
      }
      toast(`${hub?.label || "Hub"} · connected`);
      clearAllCaches();
      await activeCtx?.reloadCatalog?.().catch(() => {});
      if (activeCtx?.switchContext && activeCtx?.manifest?.hub_id && hub?.id) {
        activeCtx.switchContext({ hub: hub.id });
        return;
      }
      location.assign(`/next/?hub=${encodeURIComponent(hub.id)}`);
    } catch (err) {
      localNoteText = err.message || "Could not add local hub";
      if (noteEl) noteEl.textContent = localNoteText;
    }
  };

  const forgetLocalHub = async (lh, noteEl) => {
    if (!wsArmed.has(lh.id)) {
      wsArmed.set(lh.id, setTimeout(() => { wsArmed.delete(lh.id); render?.(); }, ARM_MS));
      render?.();
      return;
    }
    clearTimeout(wsArmed.get(lh.id));
    wsArmed.delete(lh.id);
    try {
      await postJSON("/api/workspace/remove", { id: lh.id });
      toast(`Removed ${lh.label}`);
      if (lh.id === currentHubId) {
        location.assign("/next/");
        return;
      }
      await loadWorkspace();
      clearAllCaches();
      await activeCtx?.reloadCatalog?.().catch(() => {});
      if (workspace?.mode === "local" && browserOpen) await loadBrowse(browse?.path || "").catch(() => {});
      render?.();
    } catch (err) {
      localNoteText = `Couldn't remove · ${err.message}`;
      if (noteEl) noteEl.textContent = localNoteText;
    }
  };

  const renderLocal = () => {
    if (!workspace) {
      localBox.replaceChildren(h("div", { class: "mo-note" }, localBusy ? "Loading local hubs…" : (localNoteText || "Could not inspect workspace")));
      return;
    }
    const localHubs = workspace.hubs || [];
    const isLocalMode = workspace.mode === "local";
    const sectionHead = h("div", { class: "c-section" },
      h("span", { class: "c-section-title" },
        h("span", null, "Local hubs"),
        h("span", { class: "c-section-count" }, plural(localHubs.length, "hub"))));

    const concepts = catalog?.concepts || [];
    const cards = localHubs.map((lh) => {
      const isActive = currentHubId ? lh.id === currentHubId : Boolean(lh.active);
      const badgeText = !lh.exists ? "Missing" : isActive ? "Active" : "Saved";
      const badgeCls = !lh.exists ? "is-missing" : isActive ? "is-live" : "";
      const meta = [plural(lh.model_count || 0, "model"), plural(lh.targets_count || 0, "target")].join(" · ");
      const armedRemove = wsArmed.has(lh.id);
      const hubTargets = (catalog?.targets || []).filter((t) => t.hub_id === lh.id);
      const ambigCount = hubTargets.filter((t) => t.ambiguous).length;
      const canUnify = isLocalMode && lh.exists && hubTargets.length > 0 && concepts.length > 0;
      const showAliases = canUnify && aliasOpen.has(lh.id);
      const actions = [];
      if (!isActive && lh.exists) {
        actions.push(h("button", { type: "button", class: "c-btn sm mo-primary", onclick: () => openLocalHub(lh.id) }, "Open"));
      }
      if (canUnify) {
        actions.push(h("button", {
          type: "button",
          class: "c-btn sm",
          "aria-expanded": String(showAliases),
          onclick: () => {
            if (aliasOpen.has(lh.id)) aliasOpen.delete(lh.id);
            else aliasOpen.add(lh.id);
            render?.();
          },
        }, ambigCount ? `Unify targets (${ambigCount})` : "Unify targets"));
      }
      if (isLocalMode) {
        actions.push(h("button", {
          type: "button",
          class: ["c-btn sm mo-remove", armedRemove && "armed"],
          onclick: () => forgetLocalHub(lh, localNoteEl),
        }, armedRemove ? "Forget?" : "Remove"));
      }
      const aliasList = showAliases
        ? h("div", { class: "mo-alias-list" }, ...hubTargets.map((t) => {
          const status = t.ambiguous
            ? "Unmatched — map to unify"
            : t.user_aliased
              ? `Mapped · ${t.concept_label}`
              : `Matched · ${t.concept_label}`;
          const sel = h("select", {
            class: "mo-alias-select",
            "aria-label": `Canonical concept for ${t.label || t.target_id}`,
            onchange: async () => {
              const val = sel.value || null;
              sel.disabled = true;
              try {
                const res = await postJSON("/api/workspace/target-aliases", {
                  hub_id: lh.id,
                  target_id: t.target_id,
                  concept_id: val,
                });
                if (res?.catalog) {
                  catalog = res.catalog;
                  if (activeCtx) activeCtx.catalog = res.catalog;
                }
                clearAllCaches();
                toast(val ? `${t.short || t.target_id} unified` : `${t.short || t.target_id} reset to auto`);
                render?.();
              } catch (err) {
                localNoteText = `Couldn't unify · ${err.message}`;
                render?.();
              } finally {
                sel.disabled = false;
              }
            },
          },
          h("option", { value: "", selected: !t.user_aliased }, t.ambiguous ? "Keep separate" : "Automatic"),
          ...concepts.map((c) => h("option", {
            value: c.id,
            selected: Boolean(t.user_aliased && t.concept_id === c.id),
          }, c.label)));
          return h("div", { class: "mo-alias-row" },
            h("div", { class: "mo-alias-info" },
              h("span", { class: "mo-alias-name", title: t.target_id }, t.label || t.target_id),
              h("span", { class: ["mo-alias-status", t.ambiguous && "is-ambig"] }, status)),
            sel);
        }))
        : null;
      return h("div", { class: "mo-src", "data-local-hub": lh.id },
        h("div", { class: "mo-src-head" },
          h("span", { class: "mo-src-name", title: lh.description || undefined }, lh.repo_url ? h("a", { href: lh.repo_url, target: "_blank", rel: "noopener" }, lh.label) : lh.label),
          h("span", { class: ["mo-src-state", badgeCls] }, badgeText)),
        h("div", { class: "mo-src-meta" }, meta),
        lh.path ? h("div", { class: "mo-src-path", title: lh.path }, lh.path) : null,
        actions.length ? h("div", { class: "mo-actions" }, actions) : null,
        aliasList);
    });

    const localNoteEl = h("div", { class: "mo-note", "aria-live": "polite" }, localNoteText);
    const pieces = [sectionHead];
    if (cards.length) pieces.push(...cards);
    else pieces.push(h("div", { class: "mo-note" }, "No local Hubverse repositories connected yet."));

    if (isLocalMode) {
      const pathInput = h("input", {
        type: "text", autocomplete: "off", spellcheck: "false",
        value: localPathVal, placeholder: "/path/to/hub", "aria-label": "Local hub folder path",
      });
      pathInput.addEventListener("input", () => { localPathVal = pathInput.value; });
      const addPathBtn = h("button", {
        type: "button", class: "c-btn filled sm",
        onclick: async () => {
          const val = pathInput.value.trim();
          if (!val) { pathInput.focus(); return; }
          addPathBtn.disabled = true;
          await connectLocalPath(val, localNoteEl);
          addPathBtn.disabled = false;
        },
      }, "Add");
      pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addPathBtn.click(); } });

      const browseBtn = h("button", {
        type: "button", class: "c-btn filled sm",
        "aria-expanded": String(browserOpen),
        onclick: async () => {
          browserOpen = !browserOpen;
          if (browserOpen && !browse) {
            await loadBrowse("").catch((err) => { localNoteText = `Couldn't browse · ${err.message}`; });
          }
          render?.();
        },
      }, "Browse");

      const pickBtn = workspace.native_picker_available
        ? h("button", {
          type: "button", class: "c-btn filled sm",
          onclick: async () => {
            pickBtn.disabled = true;
            localNoteText = "Opening folder picker…";
            localNoteEl.textContent = localNoteText;
            try {
              const r = await postJSON("/api/workspace/pick-dir", { initial_dir: browse?.path || undefined });
              if (r.cancelled) {
                localNoteText = "";
              } else if (r.error) {
                localNoteText = r.error;
              } else if (r.path) {
                localPathVal = r.path;
                if (r.inspection?.valid) {
                  await connectLocalPath(r.path, localNoteEl);
                  return;
                }
                browserOpen = true;
                await loadBrowse(r.path).catch(() => {});
                localNoteText = "Folder is not a Hubverse hub (expected hub-config/tasks.json, model-output/, or target-data/)";
              }
            } catch (err) {
              localNoteText = `Couldn't pick folder · ${err.message}`;
            }
            pickBtn.disabled = false;
            render?.();
          },
        }, "Choose…")
        : null;

      pieces.push(h("div", { class: "mo-add" }, h("label", { class: "c-search mo-field" }, pathInput), addPathBtn, browseBtn, pickBtn));
      pieces.push(localNoteEl);

      if (browserOpen) {
        pieces.push(renderBrowser(browse, {
          onNavigate: async (targetPath) => {
            try { await loadBrowse(targetPath); localNoteText = ""; }
            catch (err) { localNoteText = `Couldn't browse · ${err.message}`; }
            render?.();
          },
          onConnect: (targetPath) => connectLocalPath(targetPath, localNoteEl),
          currentHubId,
        }));
      }
    }

    localBox.replaceChildren(...pieces);
  };

  const renderRemote = () => {
    const isWeb = (workspace?.mode || manifest.mode) === "web";
    const orderRank = (x) => {
      if (x.id === activeRemoteHubId) return 0;
      if (x.synced && x.enabled !== false && x.compatible !== false) return 1;
      if (x.compatible !== false) return 2;
      if (x.synced) return 3;
      if (!x.builtin) return 4;
      return 5;
    };
    const visible = hubs
      .map((x, idx) => ({ x, idx, rank: orderRank(x) }))
      .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
      .map((r) => r.x);

    const remoteHead = h("div", { class: "c-section mo-section-gap" },
      h("span", { class: "c-section-title" },
        h("span", null, "Live hubs"),
        h("span", { class: "c-section-count" }, plural(visible.length, "hub"))));
    if (!hubs.length && remoteBusy) {
      list.replaceChildren(h("div", { class: "mo-note" }, "Loading…"));
    } else if (!visible.length) {
      list.replaceChildren(h("div", { class: "mo-note" }, remoteNoteText || "No remote hubs registered."));
    } else {
      list.replaceChildren(...visible.map((x) => hubBlock(x, { isWeb })));
    }
    remoteBox.replaceChildren(
      remoteHead,
      list,
      isWeb ? null : h("div", { class: "mo-add" }, h("label", { class: "c-search mo-field" }, input), addBtn),
      isWeb ? null : addNote,
    );
  };

  render = () => {
    renderLocal();
    renderRemote();
    layer.place();
  };

  localBusy = true;
  remoteBusy = true;
  render();

  await Promise.all([
    loadWorkspace()
      .catch((err) => { localNoteText = `Couldn't load workspace · ${err.message}`; })
      .finally(() => { localBusy = false; render?.(); }),
    loadHubs()
      .catch((err) => { remoteNoteText = `Couldn't load hubs · ${err.message}`; })
      .finally(() => { remoteBusy = false; render?.(); }),
    (catalog ? Promise.resolve(catalog) : loadCatalog())
      .then((c) => { if (c) catalog = c; })
      .catch(() => {}),
  ]);

  if (!autoExpandedAmbiguous && catalog?.targets && workspace?.hubs) {
    autoExpandedAmbiguous = true;
    const localIds = new Set(workspace.hubs.map((h) => h.id));
    for (const t of catalog.targets) {
      if (t.ambiguous && localIds.has(t.hub_id)) aliasOpen.add(t.hub_id);
    }
  }

  if (workspace?.mode === "local" && (workspace.hubs || []).length === 0) {
    browserOpen = true;
    await loadBrowse("").catch(() => {});
  }

  render?.();
  if (hubs.some(running)) startPoll();
  return layer;
}

function renderBrowser(snap, { onNavigate, onConnect, currentHubId }) {
  if (!snap) {
    return h("div", { class: "mo-browser" }, h("div", { class: "mo-note" }, "Loading folders…"));
  }
  const roots = (snap.roots || []).map((r) => h("button", {
    type: "button", class: "c-chip",
    "aria-pressed": String(r.path === snap.path),
    onclick: () => onNavigate(r.path),
  }, r.label));

  const head = h("div", { class: "mo-browse-head" },
    h("button", {
      type: "button", class: "c-btn filled sm mo-up",
      disabled: !snap.parent, title: "Parent folder",
      onclick: () => snap.parent && onNavigate(snap.parent),
    }, "↑"),
    h("span", { class: "mo-browse-path", title: snap.path }, snap.path));

  const cur = snap.current_hub;
  const curRegistered = cur?.registered_id;
  const curBanner = cur?.valid
    ? h("div", { class: "mo-current-hub" },
      h("div", { class: "mo-current-hub-info" },
        h("span", { class: "mo-dir-name" }, cur.name || snap.name),
        h("span", { class: "mo-dir-meta" }, [plural(cur.model_count || 0, "model"), plural((cur.targets || []).length, "target")].join(" · "))),
      curRegistered === currentHubId && currentHubId
        ? h("span", { class: "mo-src-state is-live" }, "Active")
        : h("button", {
          type: "button", class: "c-btn sm mo-primary",
          onclick: () => (curRegistered ? openLocalHub(curRegistered) : onConnect(snap.path)),
        }, curRegistered ? "Open" : "Connect"))
    : null;

  const entries = (snap.entries || []).map((ent) => {
    const meta = ent.is_hub
      ? [ent.hub_name && ent.hub_name !== ent.name ? ent.hub_name : null, plural(ent.model_count || 0, "model"), plural(ent.targets_count || 0, "target")].filter(Boolean).join(" · ")
      : null;
    return h("div", { class: ["mo-dir-row", ent.is_hub && "is-hub"] },
      h("button", {
        type: "button", class: "mo-dir-main",
        onclick: () => onNavigate(ent.path),
      },
      h("span", { class: "mo-dir-name" }, ent.name),
      meta ? h("span", { class: "mo-dir-meta" }, meta) : null),
      ent.is_hub
        ? (ent.registered_id === currentHubId && currentHubId
          ? h("span", { class: "mo-src-state is-live" }, "Active")
          : h("button", {
            type: "button", class: "c-btn filled sm",
            onclick: () => (ent.registered_id ? openLocalHub(ent.registered_id) : onConnect(ent.path)),
          }, ent.registered_id ? "Open" : "Connect"))
        : null);
  });

  const dirList = h("div", { class: "mo-dir-list" },
    ...(entries.length ? entries : [h("div", { class: "mo-note" }, "No subfolders")]));

  return h("div", { class: "mo-browser" },
    roots.length ? h("div", { class: "mo-roots" }, roots) : null,
    head,
    curBanner,
    dirList,
    snap.truncated ? h("div", { class: "mo-note" }, "Showing first entries · type a full path above to jump directly") : null);
}

function hubBlock(x, { isWeb = false } = {}) {
  const busy = running(x), anyBusy = hubs.some(running);
  const compatible = x.compatible !== false;
  const isActiveRemote = activeRemoteHubId === x.id;
  const state = isActiveRemote ? "Active" : busy ? "Syncing" : !x.synced ? "Not synced" : !compatible ? "Synced" : x.enabled ? "Live" : "Hidden";
  const stateCls = (isActiveRemote || (x.synced && !compatible && !busy))
    ? "is-live"
    : `is-${state.toLowerCase().replace(" ", "-")}`;

  const shown = (x.synced && compatible && !isActiveRemote && !isWeb)
    ? h("button", {
      type: "button", class: "mo-toggle", role: "checkbox", "aria-checked": String(!!x.enabled), disabled: busy,
      "aria-label": `Show ${x.label} models`, onclick: () => toggle(x),
    }, h("span", { class: "c-check" }), "Shown")
    : null;

  const srcKind = x.transport === "github" ? "GitHub" : "S3";
  const meta = x.synced
    ? [plural(x.models || 0, "model"), plural(x.files || 0, "file"), fmtBytes(x.bytes), `synced ${fmtAgo(x.last_sync)}`].join(" · ")
    : [srcKind, x.geography, x.description].filter(Boolean).join(" · ") || "Nothing downloaded";
  const upstream = upstreamOf(x);
  const truthUp = hasTruthUpdate(x);
  const needsUp = needsUpdateOf(x);
  const meta2 = x.synced ? [
    `latest ${day(x.latest_round)}`,
    x.latest_round_models ? plural(x.latest_round_models, "model") : null,
    x.truth?.oracle?.as_of ? `truth ${day(x.truth.oracle.as_of)}` : null,
    upstream ? `${upstream} changed upstream` : null,
    truthUp ? "new truth upstream" : null,
  ].filter(Boolean).join(" · ") : null;

  // seasons: those stored, the current one, and whatever a check listed
  const listed = checks.get(x.id)?.seasons || [];
  const all = [...new Set([...(x.seasons || []), ...(currentSeason ? [currentSeason] : []), ...listed.map((s) => s.season)])].sort().reverse();
  const sel = picked.get(x.id) || new Set();
  const chips = isWeb ? [] : all.map((s) => {
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
  const removeBtn = (!isWeb && (x.synced || !x.builtin))
    ? h("button", { type: "button", class: ["c-btn sm mo-remove", isArmed && "armed"], disabled: anyBusy, onclick: () => remove(x) }, isArmed ? "Remove local copy?" : "Remove")
    : null;
  const openBtn = (x.synced && !isActiveRemote)
    ? h("button", {
      type: "button",
      class: ["c-btn sm", (fresh.length > 0 || needsUp) && !isWeb ? "filled" : "mo-primary"],
      onclick: () => openRemoteHub(x.id),
    }, "Open")
    : null;

  let actions = [];
  if (busy && !isWeb) {
    actions = [h("button", { type: "button", class: "c-btn filled sm", onclick: () => cancel(x) }, "Cancel")];
  } else if (isWeb) {
    actions = [openBtn].filter(Boolean);
  } else if (!x.synced) {
    actions = [
      h("button", { type: "button", class: "c-btn sm mo-primary", disabled: anyBusy || !sel.size, onclick: () => sync(x) }, syncLabel),
      h("button", { type: "button", class: "c-btn filled sm", disabled: anyBusy, onclick: () => check(x) }, "Check"),
      removeBtn,
    ];
  } else if (fresh.length > 0 || needsUp) {
    actions = [
      openBtn,
      h("button", { type: "button", class: "c-btn sm mo-primary", disabled: anyBusy || !sel.size, onclick: () => sync(x) }, syncLabel),
      h("button", { type: "button", class: "c-btn filled sm", disabled: anyBusy, onclick: () => check(x) }, "Check"),
      removeBtn,
    ];
  } else {
    actions = [
      openBtn,
      h("button", { type: "button", class: "c-btn filled sm", disabled: anyBusy, onclick: () => check(x) }, "Check for updates"),
      removeBtn,
    ];
  }

  return h("div", { class: "mo-src", "data-hub": x.id },
    h("div", { class: "mo-src-head" },
      h("span", { class: "mo-src-name", title: x.description || undefined }, x.repo_url ? h("a", { href: x.repo_url, target: "_blank", rel: "noopener" }, x.label) : x.label),
      h("span", { class: ["mo-src-state", stateCls] }, state),
      shown),
    h("div", { class: "mo-src-meta" }, meta),
    meta2 ? h("div", { class: "mo-src-meta" }, meta2) : null,
    chips.length ? h("div", { class: "mo-chips", role: "group", "aria-label": "Seasons to sync" }, chips) : null,
    progress,
    h("div", { class: "mo-actions" }, actions.filter(Boolean)),
    notes.has(x.id) ? h("div", { class: "mo-note" }, notes.get(x.id)) : null);
}

/* ---------- actions ---------- */

async function toggle(x) {
  try {
    await postJSON("/api/remote/toggle", { hub: x.id, enabled: !x.enabled });
    toast(`${x.label} ${x.enabled ? "hidden" : "shown"}`);
    await applyWorkspaceUpdate();
  } catch (err) { notes.set(x.id, `Couldn't update · ${err.message}`); render?.(); }
}

async function check(x) {
  notes.set(x.id, "Checking…"); render?.();
  try {
    const r = await postJSON("/api/remote/check", { hub: x.id });
    checks.set(x.id, r);
    const p = r.pending || {};
    hubs = hubs.map((y) => (y.id === x.id ? { ...y, pending: p } : y));
    emit();
    const changes = [
      p.new && `${p.new} new`,
      p.changed && `${p.changed} updated`,
      p.removed && `${p.removed} removed`,
      p.truth_changed && "new truth",
    ].filter(Boolean).join(" · ");
    const latestPart = p.latest_round ? ` · latest ${day(p.latest_round)}` : "";
    notes.set(x.id, `${changes ? `${changes} upstream` : "Up to date"}${latestPart}`);
    if (!x.synced && !(x.seasons || []).length) {
      const avail = (r.seasons || []).map((s) => s.season).sort();
      const newest = avail.at(-1);
      const curPicked = picked.get(x.id);
      const hasValidPick = curPicked && [...curPicked].some((s) => avail.includes(s));
      if (!hasValidPick && newest) picked.set(x.id, new Set([newest]));
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
    if (activeRemoteHubId === x.id) location.assign("/next/");
    else await applyWorkspaceUpdate();
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
