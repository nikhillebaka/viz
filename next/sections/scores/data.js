/* The scores' data: /api/next/metrics, /api/next/model-locations, /api/model-details and /api/season-curves.
 * Responses are cached (FIFO); a metrics request supersedes the one in flight. */
import { apiUrl, getActiveHub, hubFetch, registerCacheClear } from "../../lib/api.js";

const LIMIT = 50;
const caches = { metrics: new Map(), details: new Map(), curves: new Map(), places: new Map() };
registerCacheClear(() => Object.values(caches).forEach((m) => m.clear()));
const sk = (key) => `${getActiveHub() || ""}\n${key}`;

function remember(map, key, value) {
  map.set(key, value);
  while (map.size > LIMIT) map.delete(map.keys().next().value);
  return value;
}

async function getJson(url, signal) {
  const r = await hubFetch(apiUrl(url), { signal });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error || `${r.status}`);
  return j;
}

/* a cached GET whose promise is shared while in flight; a failure is forgotten so it can be retried */
function cached(map, key, url) {
  if (map.has(key)) return map.get(key);
  const p = getJson(url).catch((e) => { map.delete(key); throw e; });
  return remember(map, key, p);
}

let inflight = null;
/**
 * The metrics for a request (model.metricsRequest): its query and, with a horizon subset, the same scope
 * on every horizon (`full`). A newer call aborts the older one, which then rejects with an AbortError.
 * @param {string} query
 * @param {string | null} [full]
 * @returns {Promise<{ resp: object, full: object | null }>}
 */
export function loadMetrics(query, full = null) {
  const wanted = [query, full].filter(Boolean);
  if (wanted.every((q) => caches.metrics.has(sk(q)))) {
    return Promise.resolve({ resp: caches.metrics.get(sk(query)), full: full ? caches.metrics.get(sk(full)) : null });
  }
  inflight?.abort();
  const ctl = (inflight = new AbortController());
  const one = (q) => (caches.metrics.has(sk(q)) ? Promise.resolve(caches.metrics.get(sk(q)))
    : getJson(`/api/next/metrics?${q}`, ctl.signal).then((j) => remember(caches.metrics, sk(q), j)));
  return Promise.all(wanted.map(one)).then(([resp, all]) => {
    if (inflight === ctl) inflight = null;
    return { resp, full: full ? all : null };
  });
}

let quickInflight = null;
/**
 * One metrics query on its own (the quick, selected-only request): cached, and a newer call aborts the
 * older one, but it never aborts loadMetrics' request or is aborted by it.
 * @param {string} query
 * @returns {Promise<object>}
 */
export function loadQuick(query) {
  const key = sk(query);
  if (caches.metrics.has(key)) return Promise.resolve(caches.metrics.get(key));
  quickInflight?.abort();
  const ctl = (quickInflight = new AbortController());
  return getJson(`/api/next/metrics?${query}`, ctl.signal).then((j) => {
    if (quickInflight === ctl) quickInflight = null;
    return remember(caches.metrics, key, j);
  });
}

/** True when the metrics for this request are already here (no loading state needed). */
export const hasMetrics = (query, full = null) => [query, full].filter(Boolean).every((q) => caches.metrics.has(sk(q)));

/** @returns {Promise<object>} /api/model-details for one model */
export const loadDetails = (id) => cached(caches.details, sk(id), `/api/model-details?model=${encodeURIComponent(id)}`);

/**
 * Observed season curves on a season-week axis, for the Dates popover.
 * @returns {Promise<{ curves: { season, points: { week, date, value, phase }[], peak_weeks, peaked }[], month_ticks }>}
 */
export function loadCurves(target, location, seasons) {
  const q = new URLSearchParams({ target, location, seasons: seasons.join(",") }).toString();
  return cached(caches.curves, sk(q), `/api/season-curves?${q}`);
}

/**
 * Per-location pairwise Relative WIS, WIS, and counts for a model in the active evaluation scope.
 * @param {string} query from `modelLocationsQuery`
 * @returns {Promise<{ locations: Map<string, object>, baseline: string | null }>}
 */
export function loadPlaces(query) {
  const key = sk(query);
  if (caches.places.has(key)) return caches.places.get(key);
  const pr = getJson(`/api/next/model-locations?${query}`).then((d) => ({
    locations: new Map(Object.entries(d?.locations || {})),
    baseline: d?.baseline || null,
  })).catch((e) => { caches.places.delete(key); throw e; });
  return remember(caches.places, key, pr);
}
