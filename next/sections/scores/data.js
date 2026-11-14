/* The scores' data: /api/next/metrics, /api/model-details, /api/season-curves and the per-location WIS from
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
 * The metrics for a request (model.metricsRequest): its query and, with a horizon subset, the same scope
 * on every horizon (`full`). A newer call aborts the older one, which then rejects with an AbortError.
 * @param {string} query
 * @param {string | null} [full]
 * @returns {Promise<{ resp: object, full: object | null }>}
 */
export function loadMetrics(query, full = null) {
  const wanted = [query, full].filter(Boolean);
  if (wanted.every((q) => caches.metrics.has(q))) {
    return Promise.resolve({ resp: caches.metrics.get(query), full: full ? caches.metrics.get(full) : null });
  }
  inflight?.abort();
  const ctl = (inflight = new AbortController());
  const one = (q) => (caches.metrics.has(q) ? Promise.resolve(caches.metrics.get(q))
    : getJson(`/api/next/metrics?${q}`, ctl.signal).then((j) => remember(caches.metrics, q, j)));
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
  if (caches.metrics.has(query)) return Promise.resolve(caches.metrics.get(query));
  quickInflight?.abort();
  const ctl = (quickInflight = new AbortController());
  return getJson(`/api/next/metrics?${query}`, ctl.signal).then((j) => {
    if (quickInflight === ctl) quickInflight = null;
    return remember(caches.metrics, query, j);
  });
}

/** True when the metrics for this request are already here (no loading state needed). */
export const hasMetrics = (query, full = null) => [query, full].filter(Boolean).every((q) => caches.metrics.has(q));

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
 * @param {number | "all"} [horizon="all"]
 * @returns {Promise<{ model: Map<abbr, number>, base: Map<abbr, number> }>}
 */
export function loadPlaces(target, season, id, baseline, horizon = "all") {
  const models = [...new Set([id, baseline].filter(Boolean))];
  const q = new URLSearchParams({ rows: "model", cols: "location", target, metric: "wis", location: "states", season, horizon: String(horizon), models: models.join(",") }).toString();
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
