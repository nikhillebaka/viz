/* The manifest and fan data from the server (core/next_api.py): loading, decoding, caching, and the
 * display names of models.
 *
 * decodeFan() and indexManifest() are pure, so node tests run them on real or synthetic payloads;
 * loadManifest() and loadFan() add the fetching and caching. */
import { DAY, WEEK, parseIso } from "./scale.js";

const MAGIC_V1 = "VZF1";
const MAGIC_V2 = "VZF2";
const TRAJ_MAGIC = "VZT1";
const FAN_CACHE = 24;
const TOL = 1e-6; // quantile levels are matched within this
// interval level → its lower and upper quantile
const LEVEL_Q = (level) => [(1 - level) / 2, 1 - (1 - level) / 2];

/**
 * Add signed calendar months in UTC, preserving day-of-month clamped to the target month length.
 * @param {number} ms UTC epoch ms
 * @param {number} months signed month offset
 * @returns {number} UTC epoch ms
 */
export function addMonthsUtc(ms, months) {
  if (!Number.isFinite(ms)) return NaN;
  const d = new Date(ms);
  const targetM = d.getUTCMonth() + Math.trunc(months);
  const y = d.getUTCFullYear() + Math.floor(targetM / 12);
  const m = ((targetM % 12) + 12) % 12;
  const maxDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), maxDay));
}

let activeHubId = typeof location !== "undefined" ? (new URLSearchParams(location.search).get("hub") || null) : null;

/** Current workspace hub id (from `?hub=` or the loaded manifest). */
export function getActiveHub() {
  return activeHubId;
}

/** Set the active workspace hub id and clear cached fans (loaded manifests stay cached for fast switching). */
export function setActiveHub(id) {
  activeHubId = id ? String(id) : null;
  fans.clear();
  sampleScoreCache.clear();
}

const briefingCache = new Map();
const sampleScoreCache = new Map();
const SAMPLE_SCORE_CACHE = 32;
const cacheClearers = new Set();

/** Register a module-level cache reset callback invoked by `clearAllCaches()`. */
export function registerCacheClear(fn) {
  if (typeof fn === "function") cacheClearers.add(fn);
  return () => cacheClearers.delete(fn);
}

/** Drop every cached manifest, catalog, globe, briefing, and fan response (e.g. after data sync or refresh). */
export function clearAllCaches() {
  manifestCache.clear();
  catalogP = null;
  globeP = null;
  briefingCache.clear();
  sampleScoreCache.clear();
  fans.clear();
  for (const fn of cacheClearers) {
    try { fn(); } catch { /* ignore listener errors during teardown */ }
  }
}

/**
 * Append `workspace=<activeHubId>` to `/api/...` URLs (excluding `/api/workspace*`,
 * `/api/next/catalog`, `/api/next/globe`, `/api/next/briefing*`, and `/api/briefing/*`) without
 * altering existing params such as `/api/remote/*`'s `hub=`.
 * @param {string} url
 * @returns {string}
 */
export function apiUrl(url) {
  if (!activeHubId || typeof url !== "string" || !url.startsWith("/api/")) return url;
  const basePath = url.split("?")[0];
  if (
    basePath === "/api/workspace"
    || basePath.startsWith("/api/workspace/")
    || basePath === "/api/next/catalog"
    || basePath === "/api/next/globe"
    || basePath === "/api/next/briefing"
    || basePath === "/api/next/briefing/status"
    || basePath.startsWith("/api/briefing/")
    || basePath.startsWith("/api/web/")
  ) {
    return url;
  }
  const qIdx = url.indexOf("?");
  if (qIdx !== -1) {
    const params = new URLSearchParams(url.slice(qIdx + 1));
    if (params.has("workspace")) return url;
    return `${url}&workspace=${encodeURIComponent(activeHubId)}`;
  }
  return `${url}?workspace=${encodeURIComponent(activeHubId)}`;
}

/* ================================================================ manifest */

/**
 * @typedef {object} Manifest  the JSON of GET /api/next/manifest, plus:
 * @property {Map<string, object>} modelById
 * @property {Map<string, object>} locationById
 * @property {Map<string, object>} seasonById
 * @property {Map<string, object>} targetById
 * @property {Map<string, object>} hubById
 * @property {{ season: string, iso: string, t: number }[]} allRounds  every round of every season, ascending
 * @property {(iso: string) => string | null} seasonOf
 * @property {(id: string, among?: Iterable<string>) => string} label
 * @property {(model: object | string) => string} sourceLabel
 */

/**
 * Adds indexes and naming helpers to a manifest. Pure; does not modify `json`.
 * @param {object} json the manifest as served
 * @returns {Manifest} a new object (shallow copy of json plus the members above)
 */
export function indexManifest(json) {
  const byId = (arr) => new Map((arr || []).map((x) => [x.id, x]));
  const modelById = byId(json.models), hubById = byId(json.hubs);
  const seasons = json.seasons || [];
  const seasonById = byId(seasons);
  const allRounds = Object.freeze(
    seasons.flatMap((s) => (s.rounds || []).map((iso) => Object.freeze({ season: s.id, iso, t: parseIso(iso) }))).sort((a, b) => a.t - b.t),
  );
  const spans = seasons.map((s) => {
    const rs = s.rounds || [];
    return { id: s.id, r0: parseIso(rs[0]), r1: parseIso(rs.at(-1)), s0: parseIso(s.start), s1: parseIso(s.end) };
  });

  /** The season whose rounds span `iso`, else the one whose calendar [start, end] holds it, else null. */
  function seasonOf(iso) {
    const t = parseIso(iso);
    if (!Number.isFinite(t)) return null;
    return (spans.find((s) => t >= s.r0 && t <= s.r1) || spans.find((s) => t >= s.s0 && t <= s.s1))?.id ?? null;
  }

  /** "" for this hub's own models, "Local", a synced hub's short label, or "Ensemble" (built here). */
  function sourceLabel(model) {
    const m = typeof model === "string" ? modelById.get(model) : model;
    if (!m) return "";
    if (m.source === "local") return "Local";
    if (m.source === "synthetic") return "Ensemble";
    if (m.source === "hub") { const h = hubById.get(m.hub); return h?.short_label || h?.label || m.hub || ""; }
    return "";
  }

  /** The display name: the abbreviation; "team-abbr" when another id in `among` has the same
   * abbreviation (case-insensitive); and, for a hub model still equal to another (the same model
   * synced from a hub), " · " and the hub's short label. */
  function label(id, among) {
    const m = modelById.get(id);
    if (!m) return id;
    const abbr = m.abbr || id;
    if (!among) return abbr;
    const lower = abbr.toLowerCase(), clash = [];
    for (const o of among) {
      if (o === id) continue;
      const om = modelById.get(o);
      if (om && (om.abbr || o).toLowerCase() === lower) clash.push(om);
    }
    if (!clash.length) return abbr;
    const long = (x) => (x.team ? `${x.team}-${x.abbr || x.id}` : x.abbr || x.id);
    const name = long(m), nl = name.toLowerCase();
    if (m.source === "hub" && clash.some((o) => long(o).toLowerCase() === nl)) {
      const hub = sourceLabel(m);
      return hub ? `${name} · ${hub}` : name;
    }
    return name;
  }

  /** Default baseline model ID for a given (target, season), falling back to hub default. */
  function baselineFor(target, season) {
    const byTS = target && season ? json.baselines?.by_target_season?.[target]?.[season] : null;
    const byT = target ? json.baselines?.by_target?.[target] : null;
    return byTS || byT || json.baselines?.default || json.baseline || null;
  }

  return {
    ...json,
    modelById, hubById, seasonById,
    locationById: byId(json.locations),
    targetById: byId(json.targets),
    allRounds, seasonOf, label, sourceLabel, baselineFor,
  };
}

const manifestCache = new Map();
let catalogP = null;
let globeP = null;

/* ================================================================ private (uploaded) hubs
 * Web mode serves per-session (`ephem_…`) and per-account (`user_…`) uploaded hubs (web/sessions.py
 * `is_private_hub_id`). When one expires or the session cookie is lost, every request for it answers
 * 404 (or 403). The shared fetch path reports that once, drops its cached manifest, and tells the app. */

const PRIVATE_HUB_RE = /^(ephem|user)_[a-f0-9]{12}_[a-z][a-z0-9_-]{0,23}$/;
export const HUB_GONE_MESSAGE = "This uploaded hub expired or is no longer available";

/** @returns {boolean} `id` is an uploaded (session or account) web-mode hub */
export function isPrivateHubId(id) {
  return typeof id === "string" && PRIVATE_HUB_RE.test(id.trim());
}

/** @returns {string | null} the `workspace=` hub id a request URL names, if any */
export function workspaceOfUrl(url) {
  if (typeof url !== "string") return null;
  const qi = url.indexOf("?");
  if (qi < 0) return null;
  return new URLSearchParams(url.slice(qi + 1).split("#")[0]).get("workspace") || null;
}

/**
 * Which private hub (if any) a failed response says is gone. Pure.
 * @param {number} status HTTP status
 * @param {string} url the request URL
 * @returns {string | null} the hub id when `status` is 404/403 for a private hub, else null
 */
export function goneHubOf(status, url) {
  if (status !== 404 && status !== 403) return null;
  const id = workspaceOfUrl(url);
  return isPrivateHubId(id) ? id : null;
}

const goneHubs = new Set();          // reported once each, until the hub loads again
const hubGoneListeners = new Set();

/** Follow private hubs going away (called once per hub). @returns {() => void} stops */
export function onHubGone(fn) {
  if (typeof fn === "function") hubGoneListeners.add(fn);
  return () => hubGoneListeners.delete(fn);
}

/** Drop a hub's cached manifest (and any alias, e.g. the default one, that resolved to it). */
export function forgetManifest(hubId) {
  if (!hubId) return;
  const p = manifestCache.get(hubId);
  for (const [k, v] of [...manifestCache]) if (k === hubId || (p && v === p)) manifestCache.delete(k);
}

function reportHubGone(hubId) {
  forgetManifest(hubId);
  if (goneHubs.has(hubId)) return;
  goneHubs.add(hubId);
  for (const fn of hubGoneListeners) {
    try { fn(hubId); } catch { /* a listener's failure must not break the caller */ }
  }
}

function hubGoneError(hubId, status) {
  const e = new Error(HUB_GONE_MESSAGE);
  e.status = status;
  e.hubGone = hubId;
  return e;
}

const BUSY_RETRIES = 3;
const BUSY_WAIT_CAP_MS = 4000;

/**
 * How long to wait before retrying a 503 ("Server busy"): `Retry-After` seconds (default 1 s; an HTTP
 * date or junk counts as the default) plus up to 250 ms of jitter, capped at 4 s. Pure.
 * @param {string | null | undefined} retryAfter the header value
 * @param {() => number} [rand]
 * @returns {number} ms
 */
export function busyRetryDelayMs(retryAfter, rand = Math.random) {
  const s = retryAfter == null || String(retryAfter).trim() === "" ? NaN : Number(retryAfter);
  const base = Number.isFinite(s) && s >= 0 ? s * 1000 : 1000;
  return Math.min(BUSY_WAIT_CAP_MS, base + rand() * 250);
}

function abortReason(signal) {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function waitUnlessAborted(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortReason(signal)); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortReason(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * fetch() for API calls. A GET answered 503 (the server's admission limit) is retried up to 3 times,
 * honouring `Retry-After` and the request's AbortSignal; after that the 503 is returned as usual.
 * A 404/403 for a private hub is reported (see onHubGone) and rejects with a readable error instead
 * of the server's "Unknown workspace hub '…'".
 * @param {string} url @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function isHubGoneResponse(r) {
  if (r.headers?.get?.("X-Viz-Hub-Gone") === "1") return true;
  if (typeof r.clone !== "function") return false;
  try {
    const body = await r.clone().json();
    return typeof body?.error === "string"
      && /^(Unknown workspace hub\b|Uploaded hub\b.*not found)/i.test(body.error);
  } catch {
    return false;
  }
}

export async function hubFetch(url, init) {
  const isGet = String(init?.method || "GET").toUpperCase() === "GET";
  let r;
  for (let attempt = 0; ; attempt++) {
    r = await fetch(url, init);
    if (r.status !== 503 || !isGet || attempt >= BUSY_RETRIES) break;
    try { r.body?.cancel?.()?.catch?.(() => {}); } catch { /* nothing to release */ }
    await waitUnlessAborted(busyRetryDelayMs(r.headers?.get?.("Retry-After")), init?.signal);
  }
  if (!r.ok) {
    const gone = goneHubOf(r.status, url);
    if (gone && await isHubGoneResponse(r)) {
      reportHubGone(gone);
      throw hubGoneError(gone, r.status);
    }
  }
  return r;
}

/**
 * GET /api/next/manifest, indexed and cached per hub id for instant cross-hub switching.
 * @param {string | null} [hubId=activeHubId]
 * @returns {Promise<Manifest>}
 */
export function loadManifest(hubId = activeHubId) {
  const key = hubId || "__default__";
  const hit = manifestCache.get(key);
  if (hit) return hit;
  const url = hubId ? `/api/next/manifest?workspace=${encodeURIComponent(hubId)}` : "/api/next/manifest";
  const p = getJsonRaw(url).then((json) => {
    if (!activeHubId && json?.hub_id) activeHubId = json.hub_id;
    if (hubId) goneHubs.delete(hubId);
    if (json?.hub_id) goneHubs.delete(json.hub_id);
    const indexed = indexManifest(json);
    if (json?.hub_id && !manifestCache.has(json.hub_id)) manifestCache.set(json.hub_id, p);
    return indexed;
  }, (e) => { manifestCache.delete(key); throw e; });
  manifestCache.set(key, p);
  return p;
}

/** Force-drop cached catalog and globe snapshots so the next load fetches fresh state. */
export function invalidateCatalog() {
  catalogP = null;
  globeP = null;
}

/** GET /api/next/catalog — unified cross-hub index of providers, targets, and canonical places. */
export function loadCatalog(force = false) {
  if (force) catalogP = null;
  return (catalogP ||= getJson("/api/next/catalog").catch((e) => { catalogP = null; throw e; }));
}

/** GET /api/next/globe — unified multi-hub spatial summary across all active providers. */
export function loadGlobe(force = false) {
  if (force) globeP = null;
  return (globeP ||= getJson("/api/next/globe").catch((e) => { globeP = null; throw e; }));
}

async function getJsonRaw(targetUrl) {
  const r = await hubFetch(targetUrl);
  if (!r.ok) {
    const e = new Error(`${targetUrl}: ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

async function getJson(url) {
  return getJsonRaw(apiUrl(url));
}

/* ================================================================ fan */

/**
 * @typedef {object} FanPoint
 * @property {number} t      week, ms
 * @property {number} h      horizon (-1 for the anchor)
 * @property {number} lo
 * @property {number} hi
 * @property {number} med
 * @property {true} [anchor] the last observed week before the round
 */

/**
 * Decodes the binary fan format (`VZF1` or `VZF2` | uint32 LE header length | header JSON | float32 LE body).
 * @param {ArrayBuffer} buf
 * @returns {Fan} see the contract in next/ARCHITECTURE.md; everything returned is read-only
 * @throws when the payload is not a VZF1/VZF2 fan
 */
export function decodeFan(buf) {
  const bytes = new Uint8Array(buf);
  const magic = bytes.length >= 8 ? String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) : "";
  if (magic !== MAGIC_V1 && magic !== MAGIC_V2) throw new Error("not a VZF1/VZF2 fan");
  const dv = new DataView(buf);
  const n = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n)));
  const start = 8 + n, count = (buf.byteLength - start) >> 2;
  let body;
  if (start % 4 === 0 && new Uint8Array(new Uint16Array([1]).buffer)[0] === 1) body = new Float32Array(buf, start, count);
  else { body = new Float32Array(count); for (let i = 0; i < count; i++) body[i] = dv.getFloat32(start + 4 * i, true); }
  return new Fan(head, body, magic === MAGIC_V2 ? 2 : 1);
}

/** One (target, season, location): observed data and every model's quantiles for every round. */
export class Fan {
  /** @param {object} head the decoded header @param {Float32Array} body @param {number} [version=1] */
  constructor(head, body, version = 1) {
    this.version = head.version ?? version;
    this.target = head.target;
    this.season = head.season;
    this.location = head.location;
    this.timeUnit = head.time_unit === "month" ? "month" : "week";
    this.horizonOffsetDays = Number.isFinite(head.horizon_offset_days) ? head.horizon_offset_days : 0;
    this.dims = head.dims ? Object.freeze({ ...head.dims }) : null;
    this.rounds = Object.freeze([...head.rounds]);
    this.horizons = Object.freeze([...head.horizons]);
    this.quantiles = Object.freeze([...head.quantiles]);
    this.priorMax = head.prior_max ?? null;
    this.start = parseIso(head.start);
    this.end = parseIso(head.end);

    // the timeline: every week (or month when timeUnit === "month") from first round to last
    const rt = this.rounds.map(parseIso);
    this.#roundMs = rt;
    const t0 = rt[0];
    if (this.timeUnit === "month" && rt.length) {
      // one slot per actual round date (so two rounds in one month are both reachable and markers sit
      // on the real dates), plus a month step for each month without a round to keep the axis continuous
      const d0 = new Date(t0), dN = new Date(rt.at(-1));
      const monthOf = (t) => { const d = new Date(t); return (d.getUTCFullYear() - d0.getUTCFullYear()) * 12 + (d.getUTCMonth() - d0.getUTCMonth()); };
      const N = Math.max(1, monthOf(dN.getTime()) + 1);
      const byMonth = Array.from({ length: N }, () => new Map()); // month → round ms → first round index
      rt.forEach((t, r) => {
        if (!Number.isFinite(t)) return;
        const slot = byMonth[Math.max(0, Math.min(N - 1, monthOf(t)))];
        if (!slot.has(t)) slot.set(t, r);
      });
      const dates = [], at = [];
      byMonth.forEach((slot, i) => {
        if (!slot.size) { dates.push(addMonthsUtc(t0, i)); at.push(-1); return; }
        for (const [t, r] of [...slot].sort((a, b) => a[0] - b[0])) { dates.push(t); at.push(r); }
      });
      this.dates = Object.freeze(dates);
      this.roundAt = Int16Array.from(at);
    } else {
      const N = rt.length ? Math.round((rt.at(-1) - t0) / WEEK) + 1 : 0;
      this.dates = Object.freeze(Array.from({ length: N }, (_, i) => t0 + i * WEEK));
      this.roundAt = new Int16Array(N).fill(-1);
      rt.forEach((t, r) => { const di = Math.round((t - t0) / WEEK); if (this.roundAt[di] < 0) this.roundAt[di] = r; });
    }

    const od = head.observed?.dates || [], off = head.observed?.offset ?? 0, len = head.observed?.length ?? od.length;
    const obs = [];
    for (let i = 0; i < len; i++) { const v = body[off + i], t = parseIso(od[i]); if (Number.isFinite(v) && Number.isFinite(t)) obs.push(Object.freeze({ t, v })); }
    obs.sort((a, b) => a.t - b.t);
    this.observed = Object.freeze(obs);
    this.#obsAt = new Map(obs.map((o) => [o.t, o.v]));

    this.#body = body;
    this.#Q = this.quantiles.length;
    this.#models = new Map((head.models || []).map((m) => {
      const sparse = Array.isArray(m.horizons);
      const roundList = m.rounds || [];
      const roundMap = new Map();
      if (sparse) roundList.forEach((r, idx) => roundMap.set(r, idx));
      else roundList.forEach((r) => roundMap.set(r, r));
      return [
        m.id,
        {
          offset: m.offset,
          rounds: new Set(roundList),
          roundMap,
          horizons: sparse ? Object.freeze([...m.horizons]) : this.horizons,
        },
      ];
    }));
    this.present = new Set([...this.#models].filter(([, m]) => m.rounds.size).map(([id]) => id));
    this.#med = this.#qIndex(0.5);

    const offsetMs = this.timeUnit === "month" ? 0 : this.horizonOffsetDays * DAY;
    this.gridOrigin = obs.length ? obs[0].t : (Number.isFinite(t0) ? t0 + offsetMs : NaN);
    const lastH = this.horizons.length ? Math.max(...this.horizons) : 0;
    const lastRound = rt.length ? rt.at(-1) : NaN;
    const first = obs.length ? obs[0].t : (this.timeUnit === "month" ? addMonthsUtc(t0, -1) : t0 - WEEK);
    const tail = this.timeUnit === "month" ? addMonthsUtc(lastRound, lastH) : (lastRound + lastH * WEEK + offsetMs);
    const last = Math.max(obs.length ? obs.at(-1).t : -Infinity, tail);
    this.window = Object.freeze([first, last]);
  }

  #body; #Q; #med; #models; #obsAt; #roundMs;
  #pts = new Map();   // id → level → (FanPoint[] | null | undefined)[] by timeline index
  #ymax = new Map();
  #qi = new Map();

  #qIndex(q) {
    let hit = this.#qi.get(q);
    if (hit === undefined) { hit = this.quantiles.findIndex((x) => Math.abs(x - q) <= TOL); this.#qi.set(q, hit); }
    return hit;
  }

  /**
   * @param {string} iso
   * @returns {number} the timeline index of that round/week (or month when monthly), or -1
   */
  indexOf(iso) {
    const t = parseIso(iso);
    if (!Number.isFinite(t) || !this.dates.length) return -1;
    if (this.timeUnit === "month") {
      // the exact slot (a round's own date), else the nearest one within half a month
      let best = -1, bd = 16 * DAY;
      for (let i = 0; i < this.dates.length; i++) {
        const d = Math.abs(t - this.dates[i]);
        if (d === 0) return i;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }
    const i = Math.round((t - this.dates[0]) / WEEK);
    return i >= 0 && i < this.dates.length && Math.abs(t - this.dates[i]) < WEEK / 2 ? i : -1;
  }

  /** @param {number} t ms @returns {number | undefined} the observed value for that week/month */
  observedAt(t) { return this.#obsAt.get(t); }

  /** @param {string} id @param {number} di timeline index @returns {boolean} a forecast from that model on that week */
  has(id, di) {
    const r = this.roundAt[di];
    return r >= 0 && r !== undefined && !!this.#models.get(id)?.rounds.has(r);
  }

  // the last observed point strictly before firstT, provided the gap is at most 1 step (1 wk or 1 mo)
  #anchorBefore(firstT) {
    const o = this.observed;
    let lo = 0, hi = o.length;               // first index with t >= firstT
    while (lo < hi) { const mid = (lo + hi) >> 1; if (o[mid].t < firstT) lo = mid + 1; else hi = mid; }
    const a = lo > 0 ? o[lo - 1] : null;
    const maxGap = this.timeUnit === "month" ? 35 * DAY : WEEK;
    if (!a || firstT - a.t > maxGap) return null;
    return a;
  }

  /**
   * A model's forecast on one timeline week/month at one interval level.
   * @param {string} id
   * @param {number} di timeline index
   * @param {number} level 0.95 | 0.8 | 0.5 | 0
   * @returns {readonly FanPoint[] | null} cached and frozen; null when there is no median there
   */
  points(id, di, level) {
    let byLevel = this.#pts.get(id);
    if (!byLevel) this.#pts.set(id, (byLevel = new Map()));
    let arr = byLevel.get(level);
    if (!arr) byLevel.set(level, (arr = new Array(this.dates.length)));
    let pts = arr[di];
    if (pts !== undefined) return pts;
    pts = this.#build(id, di, level);
    arr[di] = pts;
    return pts;
  }

  #build(id, di, level) {
    const m = this.#models.get(id), r = this.roundAt[di];
    if (!m || r === undefined || r < 0) return null;
    const localR = m.roundMap.get(r);
    if (localR === undefined || this.#med < 0) return null;
    const [ql, qh] = level ? LEVEL_Q(level) : [NaN, NaN];
    const li = level ? this.#qIndex(ql) : -1, hi = level ? this.#qIndex(qh) : -1;
    const B = this.#body, mH = m.horizons.length, Q = this.#Q;
    const ref = this.timeUnit === "month" && Number.isFinite(this.#roundMs[r]) ? this.#roundMs[r] : this.dates[di];
    const offsetMs = this.timeUnit === "month" ? 0 : this.horizonOffsetDays * DAY;
    const out = [];
    for (let k = 0; k < mH; k++) {
      const base = m.offset + (localR * mH + k) * Q, med = B[base + this.#med];
      if (!Number.isFinite(med)) continue;
      const h = m.horizons[k];
      const t = this.timeUnit === "month" ? addMonthsUtc(ref, h) : (ref + h * WEEK + offsetMs);
      out.push(Object.freeze({ t, h, lo: li < 0 ? NaN : B[base + li], hi: hi < 0 ? NaN : B[base + hi], med }));
    }
    if (!out.length) return null;
    const a = this.#anchorBefore(out[0].t);
    if (a) out.unshift(Object.freeze({ t: a.t, h: -1, lo: a.v, hi: a.v, med: a.v, anchor: true }));
    return Object.freeze(out);
  }

  /**
   * The data maximum for a y-axis: observed values this season and these models' medians over every
   * round and horizon. With fewer than 4 observed weeks it is at least half of last season's maximum.
   * @param {Iterable<string>} ids
   * @returns {number} > 0 (1 when there is nothing at all); cached per set of ids
   */
  yMax(ids) {
    const list = [...ids].sort(), key = list.join("\n");
    let v = this.#ymax.get(key);
    if (v !== undefined) return v;
    let m = -Infinity;
    for (const o of this.observed) if (o.v > m) m = o.v;
    const B = this.#body, Q = this.#Q, med = this.#med;
    if (med >= 0) for (const id of list) {
      const mm = this.#models.get(id);
      if (!mm) continue;
      const mH = mm.horizons.length;
      for (const localR of mm.roundMap.values()) for (let k = 0; k < mH; k++) {
        const x = B[mm.offset + (localR * mH + k) * Q + med];
        if (x > m) m = x;
      }
    }
    if (this.observed.length < 4 && this.priorMax > 0) m = Math.max(m, 0.5 * this.priorMax);
    v = m > 0 ? m : 1;
    this.#ymax.set(key, v);
    return v;
  }
}

/**
 * Decodes binary trajectory payload (`VZT1` | uint32 LE header len | header JSON | float32 LE body).
 * @param {ArrayBuffer} buf
 */
export function decodeTrajectories(buf) {
  const bytes = new Uint8Array(buf);
  const magic = bytes.length >= 8 ? String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) : "";
  if (magic !== TRAJ_MAGIC) throw new Error("not a VZT1 trajectory payload");
  const dv = new DataView(buf);
  const n = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n)));
  const start = 8 + n, count = (buf.byteLength - start) >> 2;
  let body;
  if (start % 4 === 0 && new Uint8Array(new Uint16Array([1]).buffer)[0] === 1) body = new Float32Array(buf, start, count);
  else { body = new Float32Array(count); for (let i = 0; i < count; i++) body[i] = dv.getFloat32(start + 4 * i, true); }
  const models = new Map();
  for (const m of head.models || []) {
    const H = m.horizons.length;
    const samples = [];
    for (let s = 0; s < m.n_samples; s++) {
      const row = body.subarray(m.offset + s * H, m.offset + (s + 1) * H);
      samples.push({ id: m.sample_ids[s], values: Array.from(row) });
    }
    models.set(m.id, { horizons: m.horizons, samples });
  }
  return { ...head, modelTrajectories: models };
}

/* ================================================================ loading */

const fans = new Map(); // key → Promise<Fan>, least recently used first

/**
 * GET /api/next/fan for one target, season and location, decoded.
 * @param {string} target
 * @param {string} season
 * @param {string} location
 * @param {{ dims?: Record<string, string>, version?: number }} [opts]
 * @returns {Promise<Fan>}
 */
export function loadFan(target, season, location, opts = {}) {
  const dimsKey = opts.dims ? Object.entries(opts.dims).sort().map(([k, v]) => `${k}=${v}`).join("&") : "";
  const verKey = opts.version ? String(opts.version) : "";
  const key = `${target}\n${season}\n${location}\n${dimsKey}\n${verKey}`;
  const hit = fans.get(key);
  if (hit) { fans.delete(key); fans.set(key, hit); return hit; }
  const q = new URLSearchParams({ target, season, location });
  if (opts.dims) for (const [k, v] of Object.entries(opts.dims)) if (v != null && v !== "") q.set(k, String(v));
  if (opts.version) q.set("v", String(opts.version));
  const p = hubFetch(apiUrl(`/api/next/fan?${q}`))
    .then((r) => { if (!r.ok) throw new Error(`fan ${season} ${location}: ${r.status}`); return r.arrayBuffer(); })
    .then(decodeFan);
  p.catch(() => { if (fans.get(key) === p) fans.delete(key); });
  fans.set(key, p);
  while (fans.size > FAN_CACHE) fans.delete(fans.keys().next().value);
  return p;
}

export function loadTrajectories(target, season, location, date, opts = {}) {
  const q = new URLSearchParams({ target, season, location, date });
  if (opts.models?.length) q.set("models", opts.models.join(","));
  if (opts.dims) for (const [k, v] of Object.entries(opts.dims)) if (v != null && v !== "") q.set(k, String(v));
  return hubFetch(apiUrl(`/api/next/trajectories?${q}`))
    .then((r) => { if (!r.ok) throw new Error(`trajectories ${date} ${location}: ${r.status}`); return r.arrayBuffer(); })
    .then(decodeTrajectories);
}

export function loadPmf(target, season, location, opts = {}) {
  const q = new URLSearchParams({ target, season, location });
  if (opts.hub) q.set("workspace", String(opts.hub));
  if (opts.date) q.set("date", opts.date);
  if (opts.models?.length) q.set("models", opts.models.join(","));
  if (opts.dims) for (const [k, v] of Object.entries(opts.dims)) if (v != null && v !== "") q.set(k, String(v));
  return getJson(`/api/next/pmf?${q}`);
}

/**
 * GET /api/next/sample-scores — CRPS & multivariate Energy Score leaderboard across sample models.
 * @param {string} query
 * @param {{ signal?: AbortSignal }} [opts]
 */
export function loadSampleScores(query, { signal } = {}) {
  const key = `${activeHubId || ""}|${query}`;
  const hit = sampleScoreCache.get(key);
  if (hit) return hit;
  const p = hubFetch(apiUrl(`/api/next/sample-scores?${query}`), { signal })
    .then((r) => {
      if (!r.ok) {
        const e = new Error(`sample-scores ${r.status}`);
        e.status = r.status;
        throw e;
      }
      return r.json();
    })
    .catch((e) => {
      if (sampleScoreCache.get(key) === p) sampleScoreCache.delete(key);
      throw e;
    });
  sampleScoreCache.set(key, p);
  while (sampleScoreCache.size > SAMPLE_SCORE_CACHE) sampleScoreCache.delete(sampleScoreCache.keys().next().value);
  return p;
}

/**
 * Starts loading a fan (e.g. on hover) without waiting; errors are swallowed.
 * @param {string} target @param {string} season @param {string} location @param {object} [opts]
 */
export function prefetchFan(target, season, location, opts = {}) {
  loadFan(target, season, location, opts).catch(() => {});
}

export function invalidateBriefingCache() {
  briefingCache.clear();
}

/** GET /api/next/briefing — multi-hub Place-First editorial briefing payload. */
export function loadBriefing(placeKey = "", { bust = false } = {}) {
  const key = String(placeKey || "__default__");
  if (bust) briefingCache.delete(key);
  const hit = briefingCache.get(key);
  if (hit) return hit;
  const q = new URLSearchParams();
  if (placeKey) q.set("place", String(placeKey));
  if (bust) q.set("_t", String(Date.now()));
  const qs = q.toString();
  const url = qs ? `/api/next/briefing?${qs}` : "/api/next/briefing";
  const p = getJson(url).catch((e) => {
    if (briefingCache.get(key) === p) briefingCache.delete(key);
    throw e;
  });
  briefingCache.set(key, p);
  return p;
}

/** GET /api/next/briefing/status — external surveillance/virology feed freshness & refresh state. */
export function loadBriefingStatus() {
  return getJson("/api/next/briefing/status");
}

/** GET /api/web/status — read-only web-mode status, auth, uploaded workspaces, and auto-sync telemetry. */
export function loadWebStatus() {
  return getJsonRaw("/api/web/status");
}

/** POST /api/briefing/refresh — start non-blocking background refresh of external feeds. */
export async function refreshBriefingFeeds({ feeds = null, force = true } = {}) {
  const r = await fetch("/api/briefing/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(feeds ? { feeds } : {}), force }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data?.error || `refresh ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}
