/* Client-side whole-Hubverse folder scanner, strict path filter, VZB1 + gzip packer,
 * and on-theme uploader UI for hosted web mode.
 *
 * Pure helpers (`isAllowedHubversePath`, `normalizeSelectedFiles`, `validateFolderSelection`,
 * `buildVzb1Bytes`) have zero DOM/network dependencies so Node unit tests verify them directly. */
import { h } from "../lib/dom.js";

export const VZB1_MAGIC = "VZB1";
const SAFE_SEG_RE = /^[A-Za-z0-9._-]+$/;
const RESERVED_MODEL_NAMES = new Set(["synthetic", "remote"]);
const MAX_PATH_LEN = 240;

const DEFAULT_LIMITS = {
  max_compressed_bytes: 100 * 1024 * 1024,
  max_uncompressed_bytes: 400 * 1024 * 1024,
  max_files: 2500,
  ephem_ttl_seconds: 1800,
  user_quota_bytes: 250 * 1024 * 1024,
};

const extOf = (name) => {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
};

const fmtBytesShort = (n) => {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const val = n / 1024 ** i;
  return `${i === 0 ? Math.round(val) : Number(val.toFixed(1))} ${u[i]}`;
};

const fmtTtl = (sec) => {
  if (!Number.isFinite(sec)) return "";
  if (sec <= 60) return "< 1 min left";
  const m = Math.ceil(sec / 60);
  if (m < 60) return `${m} min left`;
  const h = Math.round(m / 60);
  return `${h} h left`;
};

const fmtIdleDuration = (sec, unit) => {
  if (unit === "min") {
    const m = Math.max(1, Math.round((sec || 1800) / 60));
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const h = Math.max(1, Math.round((sec || 86400) / 3600));
  return `${h} h`;
};

/**
 * Exact client-side mirror of `web/bundle.py:validate_hubverse_relpath`.
 * Only Hubverse config, metadata, forecasts, truth, and auxiliary CSV/JSON/Parquet files pass.
 * @param {string} rawPath
 * @returns {string | null}
 */
export function isAllowedHubversePath(rawPath) {
  if (typeof rawPath !== "string") return null;
  if (rawPath.includes("\0") || rawPath.includes("\\") || rawPath.includes(":")) return null;
  const clean = rawPath.trim();
  if (!clean || clean.startsWith("/") || clean.endsWith("/") || clean.length > MAX_PATH_LEN) return null;
  for (let i = 0; i < clean.length; i++) {
    if (clean.charCodeAt(i) < 32) return null;
  }
  const parts = clean.split("/");
  if (!parts.length || parts.length > 5) return null;
  for (const seg of parts) {
    if (!seg || seg === "." || seg === ".." || seg.startsWith(".") || !SAFE_SEG_RE.test(seg)) return null;
  }
  const norm = parts.join("/");
  if (norm === "viz.config.json") return norm;

  const top = parts[0];
  const ext = extOf(parts.at(-1));
  if (top === "hub-config") return parts.length === 2 && ext === ".json" ? norm : null;
  if (top === "model-metadata") return parts.length === 2 && (ext === ".yml" || ext === ".yaml" || ext === ".json") ? norm : null;
  if (top === "model-output" || top === "local-output") {
    if (parts.length !== 3 || RESERVED_MODEL_NAMES.has(parts[1].toLowerCase())) return null;
    return ext === ".parquet" || ext === ".csv" ? norm : null;
  }
  if (top === "target-data") return (parts.length === 2 || parts.length === 3) && (ext === ".parquet" || ext === ".csv") ? norm : null;
  if (top === "auxiliary-data") return parts.length >= 2 && parts.length <= 4 && (ext === ".csv" || ext === ".json" || ext === ".parquet") ? norm : null;
  return null;
}

/**
 * Inspect selected/dropped folder entries, strip common root folder name, filter to Hubverse
 * allowlisted paths, and collect structural compatibility summary.
 * @param {Iterable<File | { file?: File, relPath?: string, webkitRelativePath?: string, name?: string, size?: number }>} rawEntries
 */
export function normalizeSelectedFiles(rawEntries) {
  const arr = [...(rawEntries || [])];
  if (!arr.length) {
    return {
      hubName: "",
      included: [],
      skippedCount: 0,
      totalBytes: 0,
      modelCount: 0,
      hasTasks: false,
      hasModelOutput: false,
      hasTargetData: false,
      dataFilesCount: 0,
      valid: false,
      error: "No files found in selection.",
    };
  }

  const withRawPath = arr.map((item) => {
    const file = item?.file || item;
    const raw = String(item?.relPath || item?.webkitRelativePath || file?.webkitRelativePath || file?.name || "").replace(/^\/+/, "");
    return { file, size: Number(item?.size ?? file?.size ?? 0), parts: raw.split("/").filter(Boolean) };
  }).filter((x) => x.parts.length > 0);

  // Strip common top-level directory name (e.g. "FluSight-forecast-hub/hub-config/tasks.json")
  const firstSegs = new Set(withRawPath.map((x) => x.parts[0]));
  const hasSharedRoot = firstSegs.size === 1 && withRawPath.some((x) => x.parts.length > 1);
  const hubName = hasSharedRoot ? [...firstSegs][0] : "Uploaded Hub";

  const included = [];
  const models = new Set();
  let skippedCount = 0;
  let totalBytes = 0;
  let hasTasks = false;
  let hasModelOutput = false;
  let hasTargetData = false;
  let dataFilesCount = 0;
  let rootLooksLikeSubfolder = false;

  for (const item of withRawPath) {
    const relParts = hasSharedRoot ? item.parts.slice(1) : item.parts;
    if (!relParts.length) continue;
    const rawRel = relParts.join("/");
    if (rawRel === "tasks.json" || rawRel === "admin.json" || rawRel === "oracle-output.csv" || rawRel === "oracle-output.parquet") {
      rootLooksLikeSubfolder = true;
    }
    const cleanRel = isAllowedHubversePath(rawRel);
    if (!cleanRel) {
      skippedCount++;
      continue;
    }
    included.push({ relPath: cleanRel, file: item.file, size: item.size });
    totalBytes += item.size;
    if (cleanRel === "hub-config/tasks.json") hasTasks = true;
    if (cleanRel.startsWith("model-output/") || cleanRel.startsWith("local-output/")) {
      hasModelOutput = true;
      dataFilesCount++;
      const m = cleanRel.split("/")[1];
      if (m) models.add(m);
    }
    if (cleanRel.startsWith("target-data/")) {
      hasTargetData = true;
      dataFilesCount++;
    }
  }

  included.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  let valid = true;
  let error = "";
  if (!hasTasks && !hasModelOutput && !hasTargetData) {
    valid = false;
    error = rootLooksLikeSubfolder
      ? "Select the top-level hub folder containing hub-config/, model-output/, or target-data/ — not a subfolder inside it."
      : "This folder does not match Hubverse structure (expected hub-config/tasks.json, model-output/, or target-data/).";
  } else if (dataFilesCount === 0) {
    valid = false;
    error = "No forecast or target-data tables (.parquet or .csv) found inside model-output/ or target-data/.";
  }

  return {
    hubName,
    included,
    skippedCount,
    totalBytes,
    modelCount: models.size,
    hasTasks,
    hasModelOutput,
    hasTargetData,
    dataFilesCount,
    valid,
    error,
  };
}

/**
 * Validate folder scan summary against server-enforced upload limits.
 * @param {ReturnType<typeof normalizeSelectedFiles>} summary
 * @param {Partial<typeof DEFAULT_LIMITS>} [limits]
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateFolderSelection(summary, limits = DEFAULT_LIMITS) {
  const lim = { ...DEFAULT_LIMITS, ...(limits || {}) };
  if (!summary?.valid) {
    return { ok: false, error: summary?.error || "Not a compatible Hubverse hub folder." };
  }
  if (summary.included.length > lim.max_files) {
    return {
      ok: false,
      error: `Too many files (${summary.included.length.toLocaleString()} Hubverse files; limit is ${lim.max_files.toLocaleString()}).`,
    };
  }
  if (summary.totalBytes > lim.max_uncompressed_bytes) {
    return {
      ok: false,
      error: `Folder data size (${fmtBytesShort(summary.totalBytes)}) exceeds the ${fmtBytesShort(lim.max_uncompressed_bytes)} limit.`,
    };
  }
  return { ok: true };
}

/**
 * Assemble a `VZB1` binary stream from `{ relPath, bytes: Uint8Array }[]`. Pure and synchronous for unit tests.
 * @param {{ relPath: string, bytes: Uint8Array }[]} records
 * @returns {Uint8Array}
 */
export function buildVzb1Bytes(records) {
  const enc = new TextEncoder();
  const magic = enc.encode(VZB1_MAGIC);
  const parts = [magic];
  let total = magic.length + 4;
  const encoded = records.map((r) => {
    const pathBytes = enc.encode(r.relPath);
    const body = r.bytes instanceof Uint8Array ? r.bytes : new Uint8Array(r.bytes);
    total += 4 + pathBytes.length + 8 + body.length;
    return { pathBytes, body };
  });

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(magic, 0);
  let pos = magic.length;
  for (const { pathBytes, body } of encoded) {
    dv.setUint32(pos, pathBytes.length, true);
    pos += 4;
    out.set(pathBytes, pos);
    pos += pathBytes.length;
    dv.setBigUint64(pos, BigInt(body.length), true);
    pos += 8;
    out.set(body, pos);
    pos += body.length;
  }
  dv.setUint32(pos, 0, true);
  return out;
}

async function packSummaryForUpload(summary, { onProgress } = {}) {
  const records = [];
  const n = summary.included.length;
  for (let i = 0; i < n; i++) {
    const item = summary.included[i];
    const buf = await item.file.arrayBuffer();
    records.push({ relPath: item.relPath, bytes: new Uint8Array(buf) });
    if (onProgress && (i === n - 1 || i % 10 === 0)) onProgress((i + 1) / Math.max(1, n));
  }
  const raw = buildVzb1Bytes(records);
  if (typeof CompressionStream === "function") {
    const cs = new CompressionStream("gzip");
    const readerP = new Response(cs.readable).arrayBuffer();
    const writer = cs.writable.getWriter();
    await writer.write(raw);
    await writer.close();
    const compressedBuf = await readerP;
    return { payload: new Uint8Array(compressedBuf), gzip: true };
  }
  return { payload: raw, gzip: false };
}

/**
 * Pack, gzip-compress in-browser, and POST a scanned Hubverse folder to `/api/web/upload`.
 * @param {ReturnType<typeof normalizeSelectedFiles>} summary
 * @param {{ tier?: "ephem" | "persistent", limits?: object, onPhase?: (phase: string, pct?: number) => void, signal?: AbortSignal }} [opts]
 */
export async function uploadHubBundle(summary, { tier = "ephem", limits = DEFAULT_LIMITS, onPhase, signal } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const check = validateFolderSelection(summary, lim);
  if (!check.ok) throw new Error(check.error);

  onPhase?.("Compressing Hubverse files…", 0.1);
  const { payload, gzip } = await packSummaryForUpload(summary, {
    onProgress: (p) => onPhase?.("Compressing Hubverse files…", 0.1 + p * 0.45),
  });

  if (payload.byteLength > lim.max_compressed_bytes) {
    throw new Error(
      `Compressed upload (${fmtBytesShort(payload.byteLength)}) exceeds the ${fmtBytesShort(lim.max_compressed_bytes)} upload limit.`,
    );
  }

  onPhase?.(`Uploading ${fmtBytesShort(payload.byteLength)}…`, 0.7);
  const headers = {
    "Content-Type": "application/octet-stream",
    "X-Viz-Upload": "1",
    "X-Viz-Hub-Name": encodeURIComponent(summary.hubName || "Uploaded Hub"),
    "X-Viz-Storage-Tier": tier,
  };
  if (gzip) headers["Content-Encoding"] = "gzip";

  const res = await fetch("/api/web/upload", {
    method: "POST",
    headers,
    body: payload,
    signal,
  });
  onPhase?.("Validating Hubverse schema…", 0.92);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
  }
  return data;
}

/* ---------- Drag-and-drop directory traversal ---------- */

async function collectDroppedFiles(dataTransfer) {
  const out = [];
  const walkEntry = async (entry, prefix) => {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, relPath: prefix ? `${prefix}/${entry.name}` : entry.name, size: file.size });
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const readAll = async () => {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) return [];
        const rest = await readAll();
        return [...batch, ...rest];
      };
      const entries = await readAll();
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (const child of entries) await walkEntry(child, nextPrefix);
    }
  };

  const items = [...(dataTransfer?.items || [])];
  if (items.some((it) => typeof it.webkitGetAsEntry === "function")) {
    for (const it of items) {
      const ent = it.webkitGetAsEntry?.();
      if (ent) await walkEntry(ent, "");
    }
    return out;
  }
  return [...(dataTransfer?.files || [])];
}

/* ---------- On-theme UI Section ---------- */

/**
 * Render the web-mode SSO account bar (when enabled), private uploaded hubs list, and
 * whole-Hubverse folder uploader matching the existing Data sources visual language.
 * @param {{
 *   webStatus: any,
 *   currentHubId?: string | null,
 *   compact?: boolean,
 *   onOpenHub: (hubId: string) => void,
 *   onUploaded: (result: any) => Promise<void> | void,
 *   onDeleteHub: (hubId: string) => Promise<void> | void,
 * }} ctx
 */
export function renderWebUploadSection(ctx) {
  const {
    webStatus,
    currentHubId = null,
    compact = false,
    onOpenHub,
    onUploaded,
    onDeleteHub,
  } = ctx;

  const auth = webStatus?.auth || {};
  const limits = { user_cold_after_seconds: 86400, ...DEFAULT_LIMITS, ...(webStatus?.limits || {}) };
  const workspaces = webStatus?.workspaces || { all: [], user_used_bytes: 0, user_quota_bytes: 0 };
  const owned = workspaces.all || [];
  const ephemMin = Math.max(1, Math.round((limits.ephem_ttl_seconds || 1800) / 60));
  const coldHours = Math.max(1, Math.round((limits.user_cold_after_seconds || 86400) / 3600));
  const maxCompText = fmtBytesShort(limits.max_compressed_bytes);

  let busyPhase = "";
  let busyPct = 0;
  let noteText = "";
  let noteIsError = false;
  let tier = auth.authenticated ? "persistent" : "ephem";
  const armed = new Set();

  const root = h("div", { class: "mo-upload-wrap" });

  const draw = () => {
    const pieces = [];

    // 1. Optional SSO account row (flat hairline separator; hidden when SSO is unconfigured)
    if (auth.enabled) {
      const accountText = auth.authenticated
        ? `Signed in as ${auth.email || auth.display_name}`
        : "Sign in to keep uploads across sessions";
      const accountAct = auth.authenticated
        ? (auth.logout_url
          ? h("a", { class: "c-link mo-web-act", href: auth.logout_url }, "Sign out")
          : null)
        : (auth.login_url
          ? h("a", { class: "c-link mo-web-act", href: auth.login_url }, auth.login_label || "Sign in")
          : null);
      pieces.push(h("div", { class: "mo-auth" },
        h("div", { class: "mo-auth-text" },
          h("span", { class: "mo-auth-main" }, accountText),
          auth.authenticated && limits.user_quota_bytes
            ? h("span", { class: "mo-auth-sub" }, `${fmtBytesShort(workspaces.user_used_bytes || 0)} of ${fmtBytesShort(limits.user_quota_bytes)} used · archived after ${fmtIdleDuration(limits.user_cold_after_seconds, "hr")} idle`)
            : null),
        accountAct));
    }

    // 2. Section header + owned uploaded hubs
    if (!compact) {
      pieces.push(h("div", { class: "c-section" },
        h("span", { class: "c-section-title" },
          h("span", null, "Your local hub"),
          owned.length ? h("span", { class: "c-section-count" }, `${owned.length}`) : null)));
    }

    for (const w of owned) {
      const isActive = currentHubId && w.id === currentHubId;
      const isArmed = armed.has(w.id);
      const isCold = w.state === "cold";
      const stateText = isActive ? "Active" : isCold ? "Archived" : w.tier === "persistent" ? "Saved" : "Private";
      const stateCls = isActive ? "is-live" : "";
      const meta = [
        `${(w.model_count || 0).toLocaleString()} model${w.model_count === 1 ? "" : "s"}`,
        `${(w.targets_count || 0).toLocaleString()} target${w.targets_count === 1 ? "" : "s"}`,
        fmtBytesShort(w.bytes || 0),
        w.tier === "ephem" && w.ttl_seconds_remaining != null ? fmtTtl(w.ttl_seconds_remaining) : (isCold ? "wakes on open" : "saved"),
      ].filter(Boolean).join(" · ");

      pieces.push(h("div", { class: "mo-src mo-web-row", "data-uploaded-hub": w.id },
        h("div", { class: "mo-web-main" },
          h("div", { class: "mo-src-head" },
            h("span", { class: "mo-src-name" }, w.label),
            h("span", { class: ["mo-src-state", stateCls] }, stateText)),
          h("div", { class: "mo-src-meta" }, meta)),
        h("div", { class: "mo-web-acts" },
          !isActive
            ? h("button", {
              type: "button", class: "c-link mo-web-act",
              disabled: Boolean(busyPhase),
              onclick: () => onOpenHub?.(w.id),
            }, isCold ? "Wake" : "Open")
            : null,
          h("button", {
            type: "button",
            class: ["mo-text-remove", isArmed && "armed"],
            disabled: Boolean(busyPhase),
            onclick: async () => {
              if (!armed.has(w.id)) {
                armed.add(w.id);
                draw();
                setTimeout(() => { if (armed.delete(w.id)) draw(); }, 3500);
                return;
              }
              armed.delete(w.id);
              try {
                await onDeleteHub?.(w.id);
              } catch (err) {
                noteText = err?.message || "Could not delete workspace.";
                noteIsError = true;
                draw();
              }
            },
          }, isArmed ? "Delete?" : "Remove"))));
    }

    // 3. Whole-Hubverse folder dropzone + picker
    const fileInput = h("input", {
      type: "file",
      webkitdirectory: "",
      multiple: true,
      hidden: true,
    });

    const handleEntries = async (entries) => {
      if (busyPhase) return;
      noteText = "";
      noteIsError = false;
      busyPhase = "Scanning folder…";
      busyPct = 0.05;
      draw();
      try {
        const summary = normalizeSelectedFiles(entries);
        const res = await uploadHubBundle(summary, {
          tier: auth.authenticated ? tier : "ephem",
          limits,
          onPhase: (phase, pct) => {
            busyPhase = phase;
            busyPct = pct ?? 0.5;
            const textEl = root.querySelector(".mo-progress-text");
            const barEl = root.querySelector(".mo-bar > i");
            if (textEl) textEl.textContent = phase;
            else draw();
            if (barEl) barEl.style.width = `${Math.round(Math.min(100, Math.max(0, busyPct * 100)))}%`;
          },
        });
        busyPhase = "";
        busyPct = 0;
        await onUploaded?.(res);
      } catch (err) {
        busyPhase = "";
        busyPct = 0;
        noteText = err?.message || "Could not upload Hubverse folder.";
        noteIsError = true;
        draw();
      }
    };

    fileInput.addEventListener("change", () => {
      const files = [...(fileInput.files || [])];
      fileInput.value = "";
      if (files.length) handleEntries(files);
    });

    const tierToggle = auth.authenticated
      ? h("div", { class: "mo-tier-tabs", role: "group", "aria-label": "Storage option" },
        h("button", {
          type: "button",
          class: "mo-tier-tab",
          "aria-pressed": String(tier === "persistent"),
          disabled: Boolean(busyPhase),
          onclick: () => { tier = "persistent"; draw(); },
        }, "Save to account"),
        h("button", {
          type: "button",
          class: "mo-tier-tab",
          "aria-pressed": String(tier === "ephem"),
          disabled: Boolean(busyPhase),
          onclick: () => { tier = "ephem"; draw(); },
        }, `${ephemMin}-min private`))
      : null;

    const drop = h("div", { class: "mo-upload-zone" },
      fileInput,
      h("div", { class: "mo-upload-head" },
        h("span", { class: "mo-upload-title" }, "Open a local Hubverse folder"),
        h("button", {
          type: "button",
          class: "c-link mo-web-act",
          disabled: Boolean(busyPhase),
          onclick: () => fileInput.click(),
        }, "Choose folder…")),
      h("span", { class: "mo-upload-sub" }, auth.authenticated
        ? `Or drop a folder here. Reads Hubverse files in-browser and uploads them compressed (max ${maxCompText}); saved workspaces archive after ${coldHours} h idle.`
        : `Or drop a folder here. Reads Hubverse files in-browser, uploads compressed (max ${maxCompText}), and expires after ${ephemMin} min idle.`),
      tierToggle,
      busyPhase
        ? h("div", { class: "mo-progress", role: "status" },
          h("div", { class: "mo-progress-text" }, busyPhase),
          h("div", { class: "mo-bar" }, h("i", { style: { width: `${Math.round(busyPct * 100)}%` } })))
        : null,
      noteText ? h("div", { class: ["mo-note", noteIsError && "is-error"], "aria-live": "polite" }, noteText) : null,
      h("details", { class: "mo-upload-help" },
        h("summary", null, "What folder structure is expected?"),
        h("div", { class: "mo-upload-help-body" },
          h("p", null, "Select the root folder of your Hubverse hub containing ", h("code", null, "hub-config/"), ", ", h("code", null, "model-output/"), ", ", h("code", null, "model-metadata/"), ", ", h("code", null, "target-data/"), ", and optional ", h("code", null, "auxiliary-data/"), "."),
          h("p", null, "Unrelated files (READMEs, scripts, .git, docs) stay on your computer and are skipped before upload."))));

    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!busyPhase) drop.classList.add("is-drag");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-drag"));
    drop.addEventListener("drop", async (e) => {
      e.preventDefault();
      drop.classList.remove("is-drag");
      if (busyPhase) return;
      const entries = await collectDroppedFiles(e.dataTransfer).catch(() => []);
      if (entries.length) handleEntries(entries);
    });

    pieces.push(drop);
    root.replaceChildren(...pieces);
  };

  draw();
  return root;
}
