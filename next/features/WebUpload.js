/* Client-side whole-Hubverse folder scanner, strict path filter, VZB1 + gzip packer,
 * and on-theme uploader UI for hosted web mode.
 *
 * Pure helpers (`isAllowedHubversePath`, `normalizeSelectedFiles`, `validateFolderSelection`,
 * `buildVzb1Bytes`) have zero DOM/network dependencies so Node unit tests verify them directly. */
import { h, safeHref } from "../lib/dom.js";

export const VZB1_MAGIC = "VZB1";
export const MAX_METADATA_FILE_BYTES = 64 * 1024;
const SAFE_SEG_RE = /^[A-Za-z0-9._-]+$/;
const RESERVED_MODEL_NAMES = new Set(["synthetic", "remote"]);
const MAX_PATH_LEN = 240;

const DEFAULT_LIMITS = {
  max_compressed_bytes: 100 * 1024 * 1024,
  max_uncompressed_bytes: 400 * 1024 * 1024,
  max_files: 2500,
  max_metadata_file_bytes: MAX_METADATA_FILE_BYTES,
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
    error = "No forecast tables (.parquet or .csv) found inside model-output/.";
  } else if (!hasModelOutput) {
    valid = false;
    error = "Upload requires at least one forecast table in model-output/ (target-data alone is not supported).";
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
 * Bytes the VZB1 framing adds around the files' own bytes: magic + terminator, and per file a path
 * length, the UTF-8 path and a body length. The server's uncompressed cap counts the whole stream.
 * @param {{ relPath?: string }[]} included
 * @returns {number}
 */
export function vzb1FramingBytes(included) {
  const enc = new TextEncoder();
  let n = VZB1_MAGIC.length + 4;
  for (const item of included || []) n += 4 + enc.encode(String(item?.relPath || "")).length + 8;
  return n;
}

/**
 * Validate folder scan summary against server-enforced upload limits.
 * `usage` (from /api/web/status `workspaces`) adds the account checks the server would refuse with:
 * saved-hub count (`user_max_hubs`) and remaining quota (`user_quota_bytes - user_used_bytes`) for the
 * persistent tier. For the temporary tier the server replaces the oldest hub past
 * `ephem_max_hubs_per_session`, so that is a warning, not an error. Missing fields skip their check.
 * @param {ReturnType<typeof normalizeSelectedFiles>} summary
 * @param {Partial<typeof DEFAULT_LIMITS> & { user_max_hubs?: number, ephem_max_hubs_per_session?: number }} [limits]
 * @param {{ tier?: "ephem" | "persistent", ownedCount?: number, usedBytes?: number, quotaBytes?: number }} [usage]
 * @returns {{ ok: boolean, error?: string, warning?: string }}
 */
export function validateFolderSelection(summary, limits = DEFAULT_LIMITS, usage = {}) {
  const lim = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const use = usage || {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  if (!summary?.valid) {
    return { ok: false, error: summary?.error || "Not a compatible Hubverse hub folder." };
  }
  if (summary.included.length > lim.max_files) {
    return {
      ok: false,
      error: `Too many files (${summary.included.length.toLocaleString()} Hubverse files; limit is ${lim.max_files.toLocaleString()}).`,
    };
  }
  const streamBytes = (Number(summary.totalBytes) || 0) + vzb1FramingBytes(summary.included);
  if (streamBytes > lim.max_uncompressed_bytes) {
    return {
      ok: false,
      error: `Folder data size (${fmtBytesShort(streamBytes)}) exceeds the ${fmtBytesShort(lim.max_uncompressed_bytes)} limit.`,
    };
  }
  const maxMetaBytes = lim.max_metadata_file_bytes ?? MAX_METADATA_FILE_BYTES;
  for (const item of summary.included) {
    if (typeof item?.relPath === "string" && item.relPath.startsWith("model-metadata/") && Number(item.size || 0) > maxMetaBytes) {
      return {
        ok: false,
        error: `Metadata file ${item.relPath} (${fmtBytesShort(item.size)}) exceeds the ${fmtBytesShort(maxMetaBytes)} limit.`,
      };
    }
  }
  const owned = num(use.ownedCount);
  if (use.tier === "persistent") {
    const maxHubs = num(lim.user_max_hubs);
    if (maxHubs != null && owned != null && owned >= maxHubs) {
      return { ok: false, error: `Account limit reached (${maxHubs} saved hub${maxHubs === 1 ? "" : "s"}). Delete a saved hub first.` };
    }
    const quota = num(use.quotaBytes), used = num(use.usedBytes);
    if (quota != null && quota > 0 && used != null) {
      const left = Math.max(0, quota - used);
      if ((Number(summary.totalBytes) || 0) > left) {
        return {
          ok: false,
          error: `Folder data size (${fmtBytesShort(summary.totalBytes)}) exceeds your remaining account storage (${fmtBytesShort(left)} of ${fmtBytesShort(quota)}). Delete a saved hub to free space.`,
        };
      }
    }
  } else if (use.tier === "ephem") {
    const maxEphem = num(lim.ephem_max_hubs_per_session);
    if (maxEphem != null && owned != null && owned >= maxEphem) {
      return {
        ok: true,
        warning: `You already have ${owned} temporary hub${owned === 1 ? "" : "s"} (limit ${maxEphem}); the oldest will be replaced.`,
      };
    }
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

const STREAM_SLICE_BYTES = 256 * 1024;
const ALLOWED_DROP_TOP_DIRS = new Set([
  "hub-config",
  "model-metadata",
  "model-output",
  "local-output",
  "target-data",
  "auxiliary-data",
]);
const SKIP_DROP_DIRS = new Set([".git", ".venv", "__pycache__", "node_modules", ".cache", ".pytest_cache"]);

function makeAbortError(msg = "Upload cancelled.") {
  const err = new Error(msg);
  err.name = "AbortError";
  return err;
}

async function writeVzb1Records(included, writeChunk, onProgress, checkAborted) {
  const enc = new TextEncoder();
  await writeChunk(enc.encode(VZB1_MAGIC));
  const n = included.length;
  for (let i = 0; i < n; i++) {
    checkAborted();
    const item = included[i];
    const pathBytes = enc.encode(item.relPath);
    const body = new Uint8Array(await item.file.arrayBuffer());
    const hdr = new Uint8Array(4 + pathBytes.length + 8);
    const dv = new DataView(hdr.buffer);
    dv.setUint32(0, pathBytes.length, true);
    hdr.set(pathBytes, 4);
    dv.setBigUint64(4 + pathBytes.length, BigInt(body.byteLength), true);
    await writeChunk(hdr);
    for (let off = 0; off < body.byteLength; off += STREAM_SLICE_BYTES) {
      await writeChunk(body.subarray(off, off + STREAM_SLICE_BYTES));
    }
    if (onProgress && (i === n - 1 || i % 10 === 0)) onProgress((i + 1) / Math.max(1, n));
  }
  await writeChunk(new Uint8Array(4));
}

const tooLargeError = (size, max) => new Error(
  `Compressed upload (over ${fmtBytesShort(size)}) exceeds the ${fmtBytesShort(max)} upload limit. Remove some model-output files or upload a smaller hub.`,
);

/**
 * VZB1-frame and gzip the selected files. With `maxBytes`, stops as soon as the output passes it.
 * @param {ReturnType<typeof normalizeSelectedFiles>} summary
 * @param {{ onProgress?: (p: number) => void, signal?: AbortSignal, maxBytes?: number }} [opts]
 * @returns {Promise<{ payload: Blob, size: number, gzip: boolean }>}
 */
export async function packSummaryForUpload(summary, { onProgress, signal, maxBytes = Infinity } = {}) {
  let overLimit = null;
  const checkAborted = () => {
    if (overLimit) throw overLimit;
    if (signal?.aborted) throw makeAbortError();
  };
  checkAborted();
  if (typeof CompressionStream === "function") {
    const cs = new CompressionStream("gzip");
    const compressedChunks = [];
    let compressedBytes = 0;
    const reader = cs.readable.getReader();
    const drainPromise = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
          compressedChunks.push(value);
          compressedBytes += value.byteLength;
          if (compressedBytes > maxBytes) {
            overLimit = tooLargeError(compressedBytes, maxBytes);
            compressedChunks.length = 0;
            await reader.cancel(overLimit).catch(() => {}); // errors the writable side, so a pending write rejects
            return;
          }
        }
      }
    })();
    drainPromise.catch(() => {});
    const writer = cs.writable.getWriter();
    const writeChunk = async (chunk) => {
      checkAborted();
      await writer.write(chunk);
    };
    try {
      await writeVzb1Records(summary.included, writeChunk, onProgress, checkAborted);
      await writer.close();
      await drainPromise;
      checkAborted();
    } catch (err) {
      await writer.abort(err).catch(() => {});
      await drainPromise.catch(() => {});
      throw overLimit || err;
    }
    return {
      payload: new Blob(compressedChunks, { type: "application/octet-stream" }),
      size: compressedBytes,
      gzip: true,
    };
  }
  const rawChunks = [];
  let rawBytes = 0;
  await writeVzb1Records(summary.included, async (chunk) => {
    checkAborted();
    rawChunks.push(chunk);
    rawBytes += chunk.byteLength;
    if (rawBytes > maxBytes) throw (overLimit = tooLargeError(rawBytes, maxBytes));
  }, onProgress, checkAborted);
  return {
    payload: new Blob(rawChunks, { type: "application/octet-stream" }),
    size: rawBytes,
    gzip: false,
  };
}

function sendXhrUpload(url, headers, body, { onUploadProgress, onBodySent, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    const onAbort = () => xhr.abort();
    if (signal) {
      if (signal.aborted) { reject(makeAbortError()); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onUploadProgress?.(e.loaded / e.total);
    };
    // the whole body is on the server: from here it may save the hub even if the request is dropped
    xhr.upload.onload = () => onBodySent?.();
    xhr.onload = () => {
      cleanup();
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch { data = {}; }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };
    xhr.onerror = () => { cleanup(); reject(new Error("Network error during upload.")); };
    xhr.onabort = () => { cleanup(); reject(makeAbortError()); };
    xhr.send(body);
  });
}

/**
 * Pack, gzip-compress in-browser, and POST a scanned Hubverse folder to `/api/web/upload`.
 * @param {ReturnType<typeof normalizeSelectedFiles>} summary
 * @param {{
 *   tier?: "ephem" | "persistent", limits?: object, usage?: Parameters<typeof validateFolderSelection>[2],
 *   onPhase?: (phase: string, pct?: number) => void, onBodySent?: () => void, signal?: AbortSignal,
 * }} [opts] `usage` adds the account checks (see validateFolderSelection); `onBodySent` fires once the
 *   request body is fully sent (cancelling after that may not stop the server from saving the hub)
 */
export async function uploadHubBundle(summary, { tier = "ephem", limits = DEFAULT_LIMITS, usage = null, onPhase, onBodySent, signal } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const check = validateFolderSelection(summary, lim, usage ? { ...usage, tier } : {});
  if (!check.ok) throw new Error(check.error);

  onPhase?.("Compressing Hubverse files…", 0.1);
  const { payload, size, gzip } = await packSummaryForUpload(summary, {
    signal,
    maxBytes: lim.max_compressed_bytes,
    onProgress: (p) => onPhase?.("Compressing Hubverse files…", 0.1 + p * 0.45),
  });

  if (size > lim.max_compressed_bytes) {
    throw new Error(
      `Compressed upload (${fmtBytesShort(size)}) exceeds the ${fmtBytesShort(lim.max_compressed_bytes)} upload limit.`,
    );
  }

  onPhase?.(`Uploading ${fmtBytesShort(size)}…`, 0.55);
  const headers = {
    "Content-Type": "application/octet-stream",
    "X-Viz-Upload": "1",
    "X-Viz-Hub-Name": encodeURIComponent(summary.hubName || "Uploaded Hub"),
    "X-Viz-Storage-Tier": tier,
  };
  if (gzip) headers["Content-Encoding"] = "gzip";

  let resStatus = 0;
  let ok = false;
  let data = {};
  if (typeof XMLHttpRequest !== "undefined") {
    const r = await sendXhrUpload("/api/web/upload", headers, payload, {
      signal,
      onBodySent: () => {
        onBodySent?.();
        onPhase?.("Validating Hubverse schema…", 0.94);
      },
      onUploadProgress: (p) => onPhase?.(`Uploading ${fmtBytesShort(size)}…`, 0.55 + p * 0.35),
    });
    ok = r.ok;
    resStatus = r.status;
    data = r.data;
  } else {
    const res = await fetch("/api/web/upload", { method: "POST", headers, body: payload, signal });
    onBodySent?.();
    onPhase?.("Validating Hubverse schema…", 0.94);
    ok = res.ok;
    resStatus = res.status;
    data = await res.json().catch(() => ({}));
  }
  if (!ok) {
    throw new Error(data.error || `Upload failed (HTTP ${resStatus})`);
  }
  return data;
}

/* ---------- Drag-and-drop directory traversal ---------- */

async function collectDroppedFiles(dataTransfer) {
  const out = [];
  // Synchronously snapshot all webkitGetAsEntry() handles before any await
  // (browsers invalidate DataTransfer.items after the first microtask).
  const items = [...(dataTransfer?.items || [])];
  const rootEntries = [];
  const hasEntryApi = items.some((it) => typeof it.webkitGetAsEntry === "function");
  if (hasEntryApi) {
    for (const it of items) {
      const ent = it.webkitGetAsEntry?.();
      if (ent) rootEntries.push(ent);
    }
  }
  const hasSingleRootDir = rootEntries.length === 1 && rootEntries[0]?.isDirectory;

  const walkEntry = async (entry, prefix, depth) => {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, relPath: prefix ? `${prefix}/${entry.name}` : entry.name, size: file.size });
      return;
    }
    if (entry.isDirectory) {
      if (depth > 0) {
        if (!entry.name || entry.name.startsWith(".") || SKIP_DROP_DIRS.has(entry.name)) return;
        if (hasSingleRootDir && depth === 1 && !ALLOWED_DROP_TOP_DIRS.has(entry.name)) return;
      }
      const reader = entry.createReader();
      const entries = [];
      while (true) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        entries.push(...batch);
      }
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (const child of entries) await walkEntry(child, nextPrefix, depth + 1);
    }
  };

  if (rootEntries.length) {
    for (const ent of rootEntries) await walkEntry(ent, "", 0);
    return out;
  }
  return [...(dataTransfer?.files || [])];
}

/* ---------- On-theme UI Section ---------- */

/* One upload at a time, shared by every uploader on the page (the welcome card, the Data sources panel).
 * It lives here, not in a section, so a re-render or a reopened panel shows the same progress and Cancel
 * (the same AbortController) instead of detaching them, and a second upload can't start. */
const upload = { phase: "", pct: 0, ctrl: null, sent: false, note: "", noteIsError: false };
const views = new Set(); // { root, draw, ctx } for each rendered section, newest last

/** @returns {boolean} an upload is being scanned, packed or sent */
export const isUploadBusy = () => Boolean(upload.phase);

/* the sections still on the page (the newest is kept even before it is attached) */
function liveViews() {
  const all = [...views], newest = all.at(-1);
  for (const v of all) if (v !== newest && !v.root.isConnected) views.delete(v);
  return [...views];
}

function setNote(text, isError = false) {
  upload.note = text;
  upload.noteIsError = isError;
}

function redrawAll() {
  for (const v of liveViews()) v.draw();
}

/* progress ticks update the bar in place (a full redraw would steal focus from Cancel) */
function showProgress() {
  for (const v of liveViews()) {
    const textEl = v.root.querySelector(".mo-progress-text");
    const barEl = v.root.querySelector(".mo-bar > i");
    if (!textEl || !barEl) { v.draw(); continue; }
    textEl.textContent = upload.phase;
    barEl.style.width = `${Math.round(Math.min(100, Math.max(0, upload.pct * 100)))}%`;
  }
}

/* the section that should hear about the outcome: the newest one on the page, else the one that started */
function outcomeView(starter) {
  const live = liveViews().filter((v) => v.root.isConnected);
  return live.at(-1) || starter;
}

function resetUpload() {
  upload.phase = "";
  upload.pct = 0;
  upload.ctrl = null;
  upload.sent = false;
}

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
 *   onCancelled?: () => Promise<void> | void,
 * }} ctx  onUploaded/onCancelled go to the newest section on the page (the upload outlives re-renders);
 *   onCancelled should refresh web status, since a cancel after the body was sent may still create the hub
 */
export function renderWebUploadSection(ctx) {
  const {
    webStatus,
    currentHubId = null,
    compact = false,
    onOpenHub,
    onDeleteHub,
  } = ctx;

  const auth = webStatus?.auth || {};
  const limits = { user_cold_after_seconds: 86400, ...DEFAULT_LIMITS, ...(webStatus?.limits || {}) };
  const workspaces = webStatus?.workspaces || { all: [], user_used_bytes: 0, user_quota_bytes: 0 };
  const owned = workspaces.all || [];
  const ephemMin = Math.max(1, Math.round((limits.ephem_ttl_seconds || 1800) / 60));
  const coldHours = Math.max(1, Math.round((limits.user_cold_after_seconds || 86400) / 3600));
  const maxCompText = fmtBytesShort(limits.max_compressed_bytes);

  let tier = auth.authenticated ? "persistent" : "ephem";
  const armed = new Set();

  const root = h("div", { class: "mo-upload-wrap" });
  const view = { root, draw: () => {}, ctx };

  const usageFor = (t) => {
    const all = workspaces.all || [];
    const ofTier = (key, name) => (Array.isArray(workspaces[key]) ? workspaces[key] : all.filter((w) => w.tier === name));
    return {
      ownedCount: (t === "persistent" ? ofTier("persistent", "persistent") : ofTier("ephemeral", "ephem")).length,
      usedBytes: workspaces.user_used_bytes,
      quotaBytes: workspaces.user_quota_bytes ?? webStatus?.limits?.user_quota_bytes,
    };
  };

  const draw = () => {
    const busyPhase = upload.phase;
    const pieces = [];

    // 1. Optional SSO account row (flat hairline separator; hidden when SSO is unconfigured)
    if (auth.enabled) {
      const accountText = auth.authenticated
        ? `Signed in as ${auth.email || auth.display_name}`
        : "Sign in to keep uploads across sessions";
      const logoutHref = safeHref(auth.logout_url, { allowRelative: true });
      const loginHref = safeHref(auth.login_url, { allowRelative: true });
      const accountAct = auth.authenticated
        ? (logoutHref
          ? h("a", { class: "c-link mo-web-act", href: logoutHref }, "Sign out")
          : null)
        : (loginHref
          ? h("a", { class: "c-link mo-web-act", href: loginHref }, auth.login_label || "Sign in")
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
                setNote(err?.message || "Could not delete workspace.", true);
                redrawAll();
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

    /* claims the one upload slot; false when another upload is already running */
    const beginUpload = (pct) => {
      if (upload.phase) return false;
      setNote("");
      upload.ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      upload.sent = false;
      upload.phase = "Scanning folder…";
      upload.pct = pct;
      redrawAll();
      return true;
    };

    const endCancelled = (text = "Upload cancelled.", isError = false) => {
      resetUpload();
      setNote(text, isError);
      redrawAll();
    };

    const finishUploadEntries = async (entries) => {
      const uploadTier = auth.authenticated ? tier : "ephem";
      try {
        const summary = normalizeSelectedFiles(entries);
        const usage = usageFor(uploadTier);
        const pre = validateFolderSelection(summary, limits, { ...usage, tier: uploadTier });
        if (pre.ok && pre.warning) {
          setNote(pre.warning);
          redrawAll();
        }
        const res = await uploadHubBundle(summary, {
          tier: uploadTier,
          limits,
          usage,
          signal: upload.ctrl?.signal,
          onBodySent: () => { upload.sent = true; redrawAll(); },
          onPhase: (phase, pct) => {
            upload.phase = phase;
            upload.pct = pct ?? 0.5;
            showProgress();
          },
        });
        resetUpload();
        setNote("");
        const target = outcomeView(view);
        await target.ctx.onUploaded?.(res, { detached: !target.root.isConnected });
      } catch (err) {
        const aborted = err?.name === "AbortError";
        endCancelled(aborted ? "Upload cancelled." : (err?.message || "Could not upload Hubverse folder."), !aborted);
        // a cancel can land after the server already has the whole body: refresh so a saved hub shows up
        if (aborted) await outcomeView(view).ctx.onCancelled?.();
      }
    };

    const handleEntries = async (entries) => {
      if (!beginUpload(0.05)) return;
      await finishUploadEntries(entries);
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
          h("div", { class: "mo-progress-head", style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" } },
            h("div", { class: "mo-progress-text" }, busyPhase),
            upload.ctrl
              ? h("button", {
                type: "button",
                class: "mo-text-act",
                // once the body is sent the server may still save the hub, so there is nothing left to cancel
                disabled: upload.sent,
                onclick: () => upload.ctrl?.abort(),
              }, upload.sent ? "Finishing…" : "Cancel")
              : null),
          h("div", { class: "mo-bar" }, h("i", { style: { width: `${Math.round(upload.pct * 100)}%` } })))
        : null,
      upload.note ? h("div", { class: ["mo-note", upload.noteIsError && "is-error"], "aria-live": "polite" }, upload.note) : null,
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
      if (upload.phase) return;
      // snapshot the entries synchronously (DataTransfer empties after this event), then claim the slot
      const entriesP = collectDroppedFiles(e.dataTransfer).catch(() => []);
      if (!beginUpload(0.03)) return;
      const ctrl = upload.ctrl;
      const entries = await entriesP;
      if (ctrl?.signal?.aborted) { endCancelled(); return; }
      if (!entries.length) { endCancelled("No files found in dropped selection.", true); return; }
      await finishUploadEntries(entries);
    });

    pieces.push(drop);
    root.replaceChildren(...pieces);
  };

  view.draw = draw;
  views.add(view);
  liveViews();
  draw();
  return root;
}
