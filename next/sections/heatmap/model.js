/* The heatmap's pure logic: which axes, metrics and sorts exist, the /api/heatmap request for a view,
 * and the grid drawn from a response (cells in display orientation, sorted, normalized, toned).
 * No DOM; node tests run it.
 *
 * Fixed from old viz: cell details are found whichever way the
 * axes are swapped; sorting, per-row scaling and region gaps act on the displayed rows and columns;
 * "score" sorts by how good the metric is (coverage: nearest 95%), not by its raw value. */

/** Columns each row axis can take, in menu order (as old viz). */
export const AXES = Object.freeze({
  location: ["date", "model"],
  model: ["location", "date", "horizon"],
  date: ["location", "model"],
  horizon: ["model"],
});
export const AXIS_LABEL = Object.freeze({ location: "Locations", model: "Models", date: "Weeks", horizon: "Horizons" });

/**
 * A metric: how it is labelled, requested, toned and formatted.
 * kind: "lower" (lower is better), "rel" (ratio to the baseline), "cov" (nearest 95 is best),
 * "signed" (diverging around 0), "magnitude" (no better or worse).
 */
const M = {
  relwis: { label: "Rel. WIS", api: "wis", kind: "rel" },
  wis: { label: "WIS", api: "wis", kind: "lower" },
  wis_rate: { label: "WIS / 100k", api: "wis_rate", kind: "lower", countOnly: true },
  mae: { label: "MAE", api: "mae", kind: "lower" },
  cov95: { label: "95% coverage", api: "cov95", kind: "cov" },
  sharpness: { label: "Sharpness", api: "sharpness", kind: "lower" },
  rate: { label: "Per 100k", api: "rate", kind: "magnitude", countOnly: true },
  count: { label: "Observed", api: "count", kind: "magnitude" },
  trend: { label: "Weekly change", api: "trend", kind: "signed" },
  f_rate: { label: "Forecast / 100k", api: "rate", kind: "magnitude", countOnly: true },
  f_count: { label: "Forecast", api: "count", kind: "magnitude" },
  error: { label: "Error", api: "error", kind: "signed" },
  f_wis: { label: "WIS", api: "wis", kind: "lower" },
};
export const METRICS = Object.freeze(M);

/**
 * Named views: the questions people bring, each a ready combination of axes and metric (old viz had
 * presets too). Scores come first: this is an evaluation tool. Anything else is "Custom" (the axes and
 * the swap stay available).
 * @param {{ model?: string, counts: boolean }} o model: the model "One model" shows
 */
export function presets({ model = null, counts = true } = {}) {
  return [
    { id: "place", label: "Scores by place", v: { rows: "location", cols: "model", metric: "relwis" } },
    { id: "week", label: "Scores by week", v: { rows: "model", cols: "date", metric: "relwis" } },
    { id: "horizon", label: "Scores by horizon", v: { rows: "model", cols: "horizon", metric: "relwis" } },
    { id: "observed", label: "Observed by place", v: { rows: "location", cols: "date", model: "truth", metric: counts ? "rate" : "count" } },
    model ? { id: "model", label: "One model by place", v: { rows: "location", cols: "date", model, metric: "error" } } : null,
  ].filter(Boolean);
}
/** The named view a view is (rows, columns, metric family and model), else "custom". */
export function presetOf(v) {
  if (v.rows === "location" && v.cols === "model") return "place";
  if (v.rows === "model" && v.cols === "date") return "week";
  if (v.rows === "model" && v.cols === "horizon") return "horizon";
  if (v.rows === "location" && v.cols === "date") return v.model === "truth" ? "observed" : "model";
  return "custom";
}
/** The view a fresh page opens on. */
export const DEFAULT_VIEW = Object.freeze({ rows: "location", cols: "model", metric: "relwis" });

/** @returns {boolean} models are one of the axes */
export const modelAxis = (v) => v.rows === "model" || v.cols === "model";
/** @returns {boolean} location × weeks (either way), where one model or the observed data is shown */
export const waveView = (v) => (v.rows === "location" && v.cols === "date") || (v.rows === "date" && v.cols === "location");

/**
 * The metrics a view offers, in menu order.
 * @param {{ rows: string, cols: string, model: string }} v
 * @param {boolean} counts the target is a count (per-100k metrics exist)
 * @returns {string[]}
 */
export function metricsFor(v, counts) {
  let ids;
  if (modelAxis(v)) ids = ["relwis", "wis", "wis_rate", "mae", "cov95", "sharpness"];
  else if (v.model === "truth") ids = ["rate", "count", "trend"];
  else ids = ["f_rate", "f_count", "error", "f_wis"];
  return ids.filter((id) => counts || !M[id].countOnly);
}

/**
 * The sorts for the rows on display.
 * @param {string} rows @returns {{ value: string, label: string }[]} empty when rows have a natural order only
 */
export function sortsFor(rows) {
  if (rows === "location") return [
    { value: "region", label: "By region" }, { value: "peak", label: "By peak week" }, { value: "magnitude", label: "Highest first" },
    { value: "population", label: "By population" }, { value: "alpha", label: "A–Z" },
  ];
  if (rows === "model") return [{ value: "score", label: "Best first" }, { value: "alpha", label: "A–Z" }];
  return [];
}

/**
 * Brings a view to a valid one: columns valid for the rows, a metric the view offers, a sort the rows have.
 * @param {object} v a partial view @param {boolean} counts
 * @returns {{ rows, cols, metric, model, horizon, sort, scale }}
 */
export function normalizeView(v, counts) {
  const rows = AXES[v.rows] ? v.rows : "location";
  const cols = AXES[rows].includes(v.cols) ? v.cols : AXES[rows][0];
  const out = { rows, cols, model: v.model || "truth", horizon: Number.isInteger(v.horizon) ? v.horizon : 1, scale: v.scale === "row" ? "row" : "none" };
  const ms = metricsFor(out, counts);
  out.metric = ms.includes(v.metric) ? v.metric : ms[0];
  const ss = sortsFor(rows);
  out.sort = ss.some((s) => s.value === v.sort) ? v.sort : ss[0]?.value ?? "";
  return out;
}

/**
 * Swaps rows and columns (the new columns must suit the new rows, else the first that does).
 * @returns {object} a new view
 */
export function swapView(v, counts) {
  const rows = v.cols, cols = AXES[rows]?.includes(v.rows) ? v.rows : AXES[rows]?.[0];
  return normalizeView({ ...v, rows, cols, sort: null }, counts);
}

/**
 * The /api/heatmap parameters for a view in a scope.
 * @param {object} v a normalized view
 * @param {{ target: string, seasons: string[], place: string, locationAbbr: string, models: string[] }} o
 *   place as scopeOf's ("all" every state · "US" · "current" the chart's location); models: the
 *   candidates when models are an axis
 * @returns {Record<string, string>}
 */
export function requestFor(v, { target, seasons, place, locationAbbr, models }) {
  const p = {
    rows: v.rows, cols: v.cols, target, metric: M[v.metric].api,
    location: place === "current" ? locationAbbr || "US" : place === "US" ? "US" : "states",
    sort_by: "hhs_region", normalize: "none", horizon: String(v.horizon),
  };
  if (seasons?.length) p.season = seasons.join(",");
  if (modelAxis(v)) { if (models?.length) p.models = models.join(","); }
  else p.model = v.model || "truth";
  return p;
}

const fin = (x) => typeof x === "number" && Number.isFinite(x);

/**
 * The grid to draw, from a response.
 * @param {object} resp /api/heatmap JSON (x_keys, y_keys, raw_matrix, cell_meta, inactive_models)
 * @param {object} v the view it was requested for
 * @param {{ baseline?: string, from?: string|null, to?: string|null, weeks?: [number, number]|null,
 *           weekOf?: (iso: string) => number, horizons?: number[]|null,
 *           region?: (abbr: string) => number, population?: (abbr: string) => number,
 *           season?: (iso: string) => string|null }} o
 * @returns {{ rows: object[], cols: object[], values: Float64Array, meta(r: number, c: number): object|null,
 *   base: Float64Array|null, inactive: object[], tone(r: number, c: number): { kind: "seq"|"div", t: number }|null,
 *   count: number }}
 *   rows/cols: [{ key, group }] in display order (group changes where a wider gap goes). values: row-major,
 *   NaN = no value. base: the baseline's WIS per cell (Rel. WIS only).
 */
export function buildGrid(resp, v, o = {}) {
  const metric = M[v.metric] || M.wis;
  let rowKeys = [...(resp.y_keys || [])], colKeys = [...(resp.x_keys || [])];
  const raw = resp.raw_matrix || [];
  const metaMap = resp.cell_meta || {};
  // the value at (row key, col key) in the response's own orientation
  const ri = new Map(rowKeys.map((k, i) => [k, i])), ci = new Map(colKeys.map((k, i) => [k, i]));
  const at = (rk, ck) => { const x = raw[ri.get(rk)]?.[ci.get(ck)]; return fin(x) ? x : NaN; };

  // the scope's window and horizons, on whichever axis holds dates or horizons. A week window applies to
  // each season (weekOf: a date's week of its own season); from / to bound one date range.
  const keep = (axis) => (k) => {
    if (axis === "date" && o.weeks && o.weekOf) { const w = o.weekOf(k); return w >= o.weeks[0] && w <= o.weeks[1]; }
    if (axis === "date") return (!o.from || k >= o.from) && (!o.to || k <= o.to);
    if (axis === "horizon") return !o.horizons?.length || o.horizons.includes(Number(k));
    return true;
  };
  rowKeys = rowKeys.filter(keep(v.rows));
  colKeys = colKeys.filter(keep(v.cols));

  // relative WIS: each cell over the baseline's cell in the same slice
  let relBase = null;
  let get = at;
  if (metric.kind === "rel") {
    const b = o.baseline;
    const onRows = v.rows === "model";
    const has = onRows ? ri.has(b) : ci.has(b);
    if (has) {
      get = (rk, ck) => {
        const base = onRows ? at(b, ck) : at(rk, b);
        const x = at(rk, ck);
        return base > 0 && fin(x) ? x / base : NaN;
      };
    } else get = () => NaN;
    relBase = { onRows, b, has };
  }

  const cmpReg = (a, b) => {
    const ra = o.region(a), rb = o.region(b);
    if (typeof ra === "number" || typeof rb === "number") return (Number(ra) || 99) - (Number(rb) || 99);
    return String(ra ?? "zzz").localeCompare(String(rb ?? "zzz"));
  };

  // columns: locations by region, then abbreviation; others as the server orders them
  if (v.cols === "location" && o.region) colKeys.sort((a, b) => cmpReg(a, b) || a.localeCompare(b));
  if (v.cols === "date") colKeys.sort();
  if (v.cols === "horizon") colKeys.sort((a, b) => a - b);

  // rows: the chosen sort, computed on what is displayed
  const nC = colKeys.length;
  const rowVals = (rk) => colKeys.map((ck) => get(rk, ck));
  const mean = (xs) => { let s = 0, n = 0; for (const x of xs) if (fin(x)) { s += x; n++; } return n ? s / n : NaN; };
  const badness = (rk) => {
    const xs = rowVals(rk);
    if (metric.kind === "cov") return mean(xs.map((x) => (fin(x) ? Math.abs(x - 95) : NaN)));
    if (metric.kind === "rel") return mean(xs.map((x) => (x > 0 ? Math.log(x) : NaN)));
    return mean(xs);
  };
  const last = (x) => (fin(x) ? x : Infinity);
  const byKey = (a, b) => String(a).localeCompare(String(b));
  if (v.rows === "date") rowKeys.sort();
  else if (v.rows === "horizon") rowKeys.sort((a, b) => a - b);
  else if (v.sort === "alpha") rowKeys.sort(o.label ? (a, b) => o.label(a).localeCompare(o.label(b)) : byKey);
  else if (v.sort === "score") rowKeys.sort((a, b) => last(badness(a)) - last(badness(b)) || byKey(a, b));
  else if (v.sort === "magnitude") rowKeys.sort((a, b) => last(-mean(rowVals(a))) - last(-mean(rowVals(b))) || byKey(a, b));
  else if (v.sort === "population" && o.population) rowKeys.sort((a, b) => (o.population(b) || 0) - (o.population(a) || 0));
  else if (v.sort === "peak") {
    const peak = (rk) => { let best = -Infinity, j = Infinity; rowVals(rk).forEach((x, i) => { if (fin(x) && x > best) { best = x; j = i; } }); return j; };
    rowKeys.sort((a, b) => peak(a) - peak(b) || byKey(a, b));
  } else if (v.sort === "region" && o.region) rowKeys.sort((a, b) => cmpReg(a, b) || byKey(a, b));

  const nR = rowKeys.length;
  const values = new Float64Array(nR * nC);
  for (let r = 0; r < nR; r++) for (let c = 0; c < nC; c++) values[r * nC + c] = get(rowKeys[r], colKeys[c]);

  // groups: HHS regions for locations (when sorted by region, or as columns), seasons for weeks
  const groupOf = (axis, sorted) => (k) => {
    if (axis === "location" && sorted && o.region) return o.region(k) || 0;
    if (axis === "date" && o.season) return o.season(k) || "";
    return 0;
  };
  const rg = groupOf(v.rows, v.sort === "region"), cg = groupOf(v.cols, true);
  const rows = rowKeys.map((key) => ({ key, group: rg(key) }));
  const cols = colKeys.map((key) => ({ key, group: cg(key) }));

  // the base WIS per cell, for the readout
  let base = null;
  if (relBase?.has) {
    base = new Float64Array(nR * nC);
    for (let r = 0; r < nR; r++) for (let c = 0; c < nC; c++) base[r * nC + c] = relBase.onRows ? at(relBase.b, colKeys[c]) : at(rowKeys[r], relBase.b);
  }

  // tones: magnitudes over [0, max] (or the row's [min, max] when scaled per row); scores diverge
  const absMax = (xs) => { let m = 0; for (const x of xs) if (fin(x)) m = Math.max(m, Math.abs(x)); return m; };
  const gMax = absMax(values);
  const rowRange = [];
  if (v.scale === "row") for (let r = 0; r < nR; r++) {
    let lo = Infinity, hi = -Infinity;
    for (let c = 0; c < nC; c++) { const x = values[r * nC + c]; if (fin(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); } }
    rowRange.push([lo, hi]);
  }
  function tone(r, c) {
    const x = values[r * nC + c];
    if (!fin(x)) return null;
    if (v.scale === "row") {
      const [lo, hi] = rowRange[r];
      return { kind: "seq", t: hi > lo ? (x - lo) / (hi - lo) : 0 };
    }
    switch (metric.kind) {
      case "rel": return { kind: "div", t: Math.log2(x) };                // 0.5 → −1 (better) … 2 → +1
      case "cov": return { kind: "div", t: (95 - x) / 20 };                // under-covering is warm; 20 points off saturates, as the scores' steps
      case "signed": return { kind: "div", t: v.metric === "trend" ? x / 50 : gMax ? x / gMax : 0 };
      default: return { kind: "seq", t: gMax ? Math.sqrt(Math.max(0, x) / gMax) : 0 };  // sqrt: long tails still show
    }
  }

  // details for a cell, whichever orientation the server keyed them in
  function meta(r, c) {
    const rk = rowKeys[r], ck = colKeys[c];
    return metaMap[`${rk}:${ck}`] || metaMap[`${ck}:${rk}`] || null;
  }

  let count = 0;
  for (const x of values) if (fin(x)) count++;
  // what the colours mean, for the legend: the ramp's kind and the values at its ends (and middle)
  const legend = v.scale === "row" ? { kind: "seq", lo: "Low", hi: "High", note: "each row its own scale" }
    : metric.kind === "rel" ? { kind: "div", lo: "½× · better", mid: "1.00", hi: "2× · worse", note: "vs baseline" }
    : metric.kind === "cov" ? { kind: "div", lo: "over 95%", mid: "95%", hi: "75% or less" }
    : metric.kind === "signed" ? { kind: "div", lo: v.metric === "trend" ? -50 : -gMax, mid: 0, hi: v.metric === "trend" ? 50 : gMax }
    : { kind: "seq", lo: 0, hi: gMax };
  return { rows, cols, values, meta, base, inactive: resp.inactive_models || [], tone, count, legend };
}
