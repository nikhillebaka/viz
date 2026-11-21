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

let activeHubId = typeof location !== "undefined" ? (new URLSearchParams(location.search).get("hub") || null) : null;

/** Current workspace hub id (from `?hub=` or the loaded manifest). */
export function getActiveHub() {
  return activeHubId;
}

/** Set the active workspace hub id and clear cached fans (loaded manifests stay cached for fast switching). */
export function setActiveHub(id) {
  activeHubId = id ? String(id) : null;
  fans.clear();
}

/** Drop every cached manifest, catalog, globe, and fan response (e.g. after data sync or refresh). */
export function clearAllCaches() {
  manifestCache.clear();
  catalogP = null;
  globeP = null;
  fans.clear();
}

/**
 * Append `workspace=<activeHubId>` to `/api/...` URLs (excluding `/api/workspace*`,
 * `/api/next/catalog`, and `/api/next/globe`) without altering existing params such as `/api/remote/*`'s `hub=`.
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
  const r = await fetch(targetUrl);
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
    this.horizonOffsetDays = Number.isFinite(head.horizon_offset_days) ? head.horizon_offset_days : 0;
    this.dims = head.dims ? Object.freeze({ ...head.dims }) : null;
    this.rounds = Object.freeze([...head.rounds]);
    this.horizons = Object.freeze([...head.horizons]);
    this.quantiles = Object.freeze([...head.quantiles]);
    this.priorMax = head.prior_max ?? null;
    this.start = parseIso(head.start);
    this.end = parseIso(head.end);

    // the timeline: every week from the first round to the last; rounds off the grid snap to it
    const rt = this.rounds.map(parseIso);
    const t0 = rt[0], N = rt.length ? Math.round((rt.at(-1) - t0) / WEEK) + 1 : 0;
    this.dates = Object.freeze(Array.from({ length: N }, (_, i) => t0 + i * WEEK));
    this.roundAt = new Int16Array(N).fill(-1);
    rt.forEach((t, r) => { const di = Math.round((t - t0) / WEEK); if (this.roundAt[di] < 0) this.roundAt[di] = r; });

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

    const offsetMs = this.horizonOffsetDays * DAY;
    const lastH = this.horizons.length ? Math.max(...this.horizons) : 0;
    const lastRound = rt.length ? this.dates.at(-1) : NaN;
    const first = obs.length ? obs[0].t : t0 - WEEK;
    const last = Math.max(obs.length ? obs.at(-1).t : -Infinity, lastRound + lastH * WEEK + offsetMs);
    this.window = Object.freeze([first, last]);
  }

  #body; #Q; #med; #models; #obsAt;
  #pts = new Map();   // id → level → (FanPoint[] | null | undefined)[] by timeline index
  #anchor = [];       // timeline index → observed anchor (or null)
  #ymax = new Map();
  #qi = new Map();

  #qIndex(q) {
    let hit = this.#qi.get(q);
    if (hit === undefined) { hit = this.quantiles.findIndex((x) => Math.abs(x - q) <= TOL); this.#qi.set(q, hit); }
    return hit;
  }

  /**
   * @param {string} iso
   * @returns {number} the timeline index of that week (within half a week), or -1
   */
  indexOf(iso) {
    const t = parseIso(iso);
    if (!Number.isFinite(t) || !this.dates.length) return -1;
    const i = Math.round((t - this.dates[0]) / WEEK);
    return i >= 0 && i < this.dates.length && Math.abs(t - this.dates[i]) < WEEK / 2 ? i : -1;
  }

  /** @param {number} t ms @returns {number | undefined} the observed value for that week */
  observedAt(t) { return this.#obsAt.get(t); }

  /** @param {string} id @param {number} di timeline index @returns {boolean} a forecast from that model on that week */
  has(id, di) {
    const r = this.roundAt[di];
    return r >= 0 && r !== undefined && !!this.#models.get(id)?.rounds.has(r);
  }

  // the last observed week strictly before the timeline week di
  #anchorAt(di) {
    let a = this.#anchor[di];
    if (a !== undefined) return a;
    const ref = this.dates[di], o = this.observed;
    let lo = 0, hi = o.length;               // first index with t >= ref
    while (lo < hi) { const mid = (lo + hi) >> 1; if (o[mid].t < ref) lo = mid + 1; else hi = mid; }
    a = lo > 0 ? o[lo - 1] : null;
    this.#anchor[di] = a;
    return a;
  }

  /**
   * A model's forecast on one timeline week at one interval level: the anchor (the last observed week
   * before the round, if any), then one point per horizon with a median. lo/hi are NaN when the model
   * lacks that level's quantiles (and always for level 0).
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
    const B = this.#body, mH = m.horizons.length, Q = this.#Q, ref = this.dates[di];
    const offsetMs = this.horizonOffsetDays * DAY;
    const out = [];
    for (let k = 0; k < mH; k++) {
      const base = m.offset + (localR * mH + k) * Q, med = B[base + this.#med];
      if (!Number.isFinite(med)) continue;
      const h = m.horizons[k];
      out.push(Object.freeze({ t: ref + h * WEEK + offsetMs, h, lo: li < 0 ? NaN : B[base + li], hi: hi < 0 ? NaN : B[base + hi], med }));
    }
    if (!out.length) return null;
    const a = this.#anchorAt(di);
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
  const p = fetch(apiUrl(`/api/next/fan?${q}`))
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
  return fetch(apiUrl(`/api/next/trajectories?${q}`))
    .then((r) => { if (!r.ok) throw new Error(`trajectories ${date} ${location}: ${r.status}`); return r.arrayBuffer(); })
    .then(decodeTrajectories);
}

export function loadPmf(target, season, location, opts = {}) {
  const q = new URLSearchParams({ target, season, location });
  if (opts.date) q.set("date", opts.date);
  if (opts.models?.length) q.set("models", opts.models.join(","));
  if (opts.dims) for (const [k, v] of Object.entries(opts.dims)) if (v != null && v !== "") q.set(k, String(v));
  return getJson(`/api/next/pmf?${q}`);
}

/**
 * Starts loading a fan (e.g. on hover) without waiting; errors are swallowed.
 * @param {string} target @param {string} season @param {string} location
 */
export function prefetchFan(target, season, location) {
  loadFan(target, season, location).catch(() => {});
}
