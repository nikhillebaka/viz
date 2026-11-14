/* Pooling peak forecasts across models (the "All models" row and the headline's consensus), and the
 * quantile of a peak-week distribution. Pure; dates are ISO strings, which sort as dates. */

const fin = (x) => typeof x === "number" && Number.isFinite(x);

/**
 * The first week whose cumulative probability reaches p (of the total).
 * @param {string[]} dates @param {number[]} probs @param {number} p in [0, 1]
 * @returns {string | null}
 */
export function weekQuantile(dates, probs, p) {
  const tot = probs.reduce((a, b) => a + (fin(b) ? b : 0), 0);
  if (!(tot > 0)) return null;
  let c = 0;
  for (let i = 0; i < dates.length; i++) {
    c += fin(probs[i]) ? probs[i] : 0;
    if (c >= p * tot - 1e-9) return dates[i];
  }
  return dates.at(-1) ?? null;
}

/**
 * The average of the models' peak-week distributions (each normalised to sum to 1 first).
 * @param {({ dates: string[], probs: number[] } | null | undefined)[]} timings
 * @returns {{ dates: string[], probs: number[], median: string, i50: string[], i90: string[] } | null}
 */
export function poolWeeks(timings) {
  const list = timings.filter((t) => t?.dates?.length && t.probs?.length === t.dates.length);
  if (!list.length) return null;
  const acc = new Map();
  for (const t of list) {
    const s = t.probs.reduce((a, b) => a + (fin(b) ? b : 0), 0);
    if (!(s > 0)) continue;
    t.dates.forEach((d, i) => acc.set(d, (acc.get(d) || 0) + (fin(t.probs[i]) ? t.probs[i] / s : 0)));
  }
  if (!acc.size) return null;
  const dates = [...acc.keys()].sort();
  const probs = dates.map((d) => acc.get(d) / list.length);
  const q = (p) => weekQuantile(dates, probs, p);
  return { dates, probs, median: q(0.5), i50: [q(0.25), q(0.75)], i90: [q(0.05), q(0.95)] };
}

const median = (xs) => {
  const v = xs.filter(fin).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * The median of the models' size quantiles (median, 50% and 90% ends), each over the models that give it.
 * @param {({ median?: number, i50?: number[], i90?: number[] } | null | undefined)[]} sizes
 * @returns {{ median: number, i50: number[] | null, i90: number[] | null } | null}
 */
export function poolSize(sizes) {
  const list = sizes.filter((s) => s && fin(s.median));
  if (!list.length) return null;
  const pair = (k) => {
    const lo = median(list.map((s) => s[k]?.[0])), hi = median(list.map((s) => s[k]?.[1]));
    return fin(lo) && fin(hi) ? [lo, hi] : null;
  };
  return { median: median(list.map((s) => s.median)), i50: pair("i50"), i90: pair("i90") };
}
