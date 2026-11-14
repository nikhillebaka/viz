/* The scores' data: /api/metrics, /api/model-details, /api/season-curves and the per-location WIS from
 * /api/heatmap. Responses are cached (FIFO); a metrics request supersedes the one in flight. */

const LIMIT = 50;
const caches = { metrics: new Map(), details: new Map(), curves: new Map(), places: new Map() };

function remember(map, key, value) {
  map.set(key, value);
  while (map.size > LIMIT) map.delete(map.keys().next().value);
  return value;
}

async function getJson(url, signal) {
  const r = await fetch(url, { signal });
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
 * The metrics for a request query (model.metricsRequest). A newer call aborts the older one, which then
 * rejects with an AbortError.
 * @param {string} query
 * @returns {Promise<object>}
 */
export function loadMetrics(query) {
  const hit = caches.metrics.get(query);
  if (hit) return Promise.resolve(hit);
  inflight?.abort();
  const ctl = (inflight = new AbortController());
  return getJson(`/api/metrics?${query}`, ctl.signal).then((j) => {
    if (inflight === ctl) inflight = null;
    return remember(caches.metrics, query, j);
  });
}

/** True when the metrics for this query are already here (no loading state needed). */
export const hasMetrics = (query) => caches.metrics.has(query);

/** @returns {Promise<object>} /api/model-details for one model */
export const loadDetails = (id) => cached(caches.details, id, `/api/model-details?model=${encodeURIComponent(id)}`);

/**
 * Observed season curves on a season-week axis, for the Dates popover.
 * @returns {Promise<{ curves: { season, points: { week, date, value, phase }[], peak_weeks, peaked }[], month_ticks }>}
 */
export function loadCurves(target, location, seasons) {
  const q = new URLSearchParams({ target, location, seasons: seasons.join(",") }).toString();
  return cached(caches.curves, q, `/api/season-curves?${q}`);
}

/**
 * Mean WIS per state for a model and the baseline in one season (heatmap models × locations).
 * @returns {Promise<{ model: Map<abbr, number>, base: Map<abbr, number> }>}
 */
export function loadPlaces(target, season, id, baseline) {
  const models = [...new Set([id, baseline].filter(Boolean))];
  const q = new URLSearchParams({ rows: "model", cols: "location", target, metric: "wis", location: "states", season, horizon: "all", models: models.join(",") }).toString();
  if (caches.places.has(q)) return caches.places.get(q);
  const p = getJson(`/api/heatmap?${q}`).then((d) => {
    const row = (mid) => {
      const i = (d.y_keys || []).indexOf(mid), m = new Map();
      if (i < 0) return m;
      (d.x_keys || []).forEach((abbr, j) => { const v = d.matrix?.[i]?.[j]; if (typeof v === "number") m.set(abbr, v); });
      return m;
    };
    return { model: row(id), base: row(baseline) };
  }).catch((e) => { caches.places.delete(q); throw e; });
  return remember(caches.places, q, p);
}
