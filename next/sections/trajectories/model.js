/* Pure computations for the Sample Trajectories workbench: empirical quantiles,
 * per-horizon CRPS & multivariate Energy Score, peak cloud statistics, and conditioning gates.
 * Zero DOM dependencies. */
import { DAY } from "../../lib/scale.js";

/** Build query string for `/api/next/sample-scores`. */
export function sampleScoresQuery({ target, season, location, scopePlace = "current", horizons = null, dims = null } = {}) {
  const q = new URLSearchParams();
  if (target) q.set("target", String(target));
  q.set("location", scopePlace === "all" || !location ? "all" : String(location));
  if (season) q.set("season", String(season));
  q.set("date", "all");
  q.set("models", "all");
  if (Array.isArray(horizons) && horizons.length) q.set("horizons", horizons.join(","));
  if (dims && typeof dims === "object") {
    for (const [k, v] of Object.entries(dims)) {
      if (v != null && v !== "") q.set(k, String(v));
    }
  }
  return q.toString();
}

/** Return all manifest models that carry sample trajectories for `targetId` (and optionally `season`). */
export function sampleModelsForTarget(manifest, targetId, season = null) {
  if (!manifest?.models?.length) return [];
  const base = manifest.models.filter((m) => (
    !!m.has_samples && (!targetId || !m.targets?.length || m.targets.includes(targetId))
  ));
  if (!season) return base;
  const inSeason = base.filter((m) => !m.seasons?.length || m.seasons.includes(season));
  return inSeason.length ? inSeason : base;
}

/** True when a target/hub has at least one model with sample trajectories (or sample output type). */
export function hasSampleModels(manifest, targetId) {
  if (sampleModelsForTarget(manifest, targetId).length > 0) return true;
  const ot = manifest?.targetById?.get(targetId)?.output_types;
  return Array.isArray(ot) && ot.includes("sample");
}

/** Choose the initial sample model: first currently charted/baseline sample model, else best default. */
export function pickDefaultSampleModel(sampleModels, sel, manifest, targetId = null) {
  if (!sampleModels?.length) return null;
  const ids = new Set(sampleModels.map((m) => m.id));
  for (const c of sel?.charted || []) {
    if (ids.has(c.id)) return c.id;
  }
  const base = manifest?.baselineFor?.(targetId) ?? manifest?.baseline;
  if (sel?.baseline && base && ids.has(base)) {
    return base;
  }
  const preferred = sampleModels.find((m) => /ensemble_long/i.test(m.id))
    || sampleModels.find((m) => /ensemble/i.test(m.id))
    || sampleModels.find((m) => m.designated);
  return (preferred || sampleModels[0]).id;
}

/** Linear-interpolated empirical quantile over an ascending numeric array. */
export function empiricalQuantile(sortedAsc, p) {
  if (!sortedAsc?.length) return NaN;
  const n = sortedAsc.length;
  if (n === 1) return sortedAsc[0];
  const clamped = Math.max(0, Math.min(1, p));
  const pos = clamped * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  const w = pos - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

/** Exact empirical 1D Continuous Ranked Probability Score over raw ensemble draws. */
export function crpsEnsemble1D(values, y) {
  if (!Number.isFinite(y) || !values?.length) return null;
  const xs = [];
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) xs.push(values[i]);
  }
  const M = xs.length;
  if (!M) return null;
  xs.sort((a, b) => a - b);
  let absErr = 0;
  let spread = 0;
  for (let i = 0; i < M; i++) {
    absErr += Math.abs(xs[i] - y);
    spread += (2 * i - M + 1) * xs[i];
  }
  return Math.max(0, absErr / M - spread / (M * M));
}

/** Exact multivariate Euclidean Energy Score over jointly realized sample vectors. */
export function energyScore(rows, yVec) {
  const K = yVec?.length ?? 0;
  if (K < 2 || !rows?.length || !yVec.every(Number.isFinite)) return null;
  const clean = [];
  for (const r of rows) {
    if (r?.length === K && r.every(Number.isFinite)) clean.push(r);
  }
  const M = clean.length;
  if (M < 2) return null;

  let errSum = 0;
  for (let i = 0; i < M; i++) {
    let d2 = 0;
    const ri = clean[i];
    for (let k = 0; k < K; k++) { const d = ri[k] - yVec[k]; d2 += d * d; }
    errSum += Math.sqrt(d2);
  }
  let pairSum = 0;
  for (let i = 0; i < M; i++) {
    const ri = clean[i];
    for (let j = i + 1; j < M; j++) {
      let d2 = 0;
      const rj = clean[j];
      for (let k = 0; k < K; k++) { const d = ri[k] - rj[k]; d2 += d * d; }
      pairSum += Math.sqrt(d2);
    }
  }
  return Math.max(0, errSum / M - pairSum / (M * M));
}

function lookupObserved(observedByTime, t) {
  if (!observedByTime || !Number.isFinite(t)) return NaN;
  if (observedByTime instanceof Map) {
    if (observedByTime.has(t)) return observedByTime.get(t);
    let best = NaN;
    let bestDiff = Infinity;
    for (const [kt, kv] of observedByTime) {
      const diff = Math.abs(kt - t);
      if (diff <= DAY && diff < bestDiff) { bestDiff = diff; best = kv; }
    }
    return best;
  }
  return NaN;
}

/** Summarize one model's decoded VZT1 sample entry into peaks, quantiles, realized values, and scores. */
export function summarizeTrajectories(entry, { refT, horizonOffsetDays = 0, observedByTime = null } = {}) {
  if (!entry?.horizons?.length || !entry?.samples?.length || !Number.isFinite(refT)) return null;

  const order = entry.horizons.map((h, i) => ({ h, i })).sort((a, b) => a.h - b.h);
  const horizons = order.map((o) => o.h);
  const times = horizons.map((h) => refT + (h * 7 + horizonOffsetDays) * DAY);
  const K = horizons.length;

  const samples = entry.samples.map((s) => {
    const values = order.map((o) => s.values[o.i]);
    let peakIdx = 0;
    let peakValue = -Infinity;
    let hasPeak = false;
    for (let k = 0; k < K; k++) {
      const v = values[k];
      if (Number.isFinite(v) && (!hasPeak || v > peakValue)) {
        peakValue = v;
        peakIdx = k;
        hasPeak = true;
      }
    }
    return {
      id: s.id,
      values,
      peakIdx,
      peakH: horizons[peakIdx],
      peakT: times[peakIdx],
      peakValue: hasPeak ? peakValue : NaN,
    };
  });

  const quantiles = horizons.map((h, k) => {
    const col = [];
    for (const s of samples) {
      if (Number.isFinite(s.values[k])) col.push(s.values[k]);
    }
    col.sort((a, b) => a - b);
    return {
      h,
      t: times[k],
      q05: empiricalQuantile(col, 0.05),
      q25: empiricalQuantile(col, 0.25),
      q50: empiricalQuantile(col, 0.5),
      q75: empiricalQuantile(col, 0.75),
      q95: empiricalQuantile(col, 0.95),
    };
  });

  const realized = times.map((t) => lookupObserved(observedByTime, t));
  const realIdx = [];
  const crpsList = [];
  for (let k = 0; k < K; k++) {
    if (!Number.isFinite(realized[k])) continue;
    const valsAtK = samples.map((s) => s.values[k]);
    const c = crpsEnsemble1D(valsAtK, realized[k]);
    if (c != null) {
      realIdx.push(k);
      crpsList.push(c);
    }
  }
  const crps = crpsList.length ? crpsList.reduce((a, b) => a + b, 0) / crpsList.length : null;
  let es = null;
  if (realIdx.length >= 2) {
    const subRows = samples.map((s) => realIdx.map((k) => s.values[k]));
    const yVec = realIdx.map((k) => realized[k]);
    es = energyScore(subRows, yVec);
  }

  return {
    horizons,
    times,
    samples,
    quantiles,
    realized,
    scores: { crps, energyScore: es, evaluatedWeeks: realIdx.length },
  };
}

/** True when a sample passes the active conditioning interval gate `{ hIdx, lo, hi }`. */
export function passesGate(sample, gate) {
  if (!gate) return true;
  const v = sample?.values?.[gate.hIdx];
  return Number.isFinite(v) && v >= gate.lo && v <= gate.hi;
}

/** Compute conditional peak timing and peak height statistics across trajectories passing `gate`. */
export function gateStats(samples, gate) {
  const list = samples || [];
  const active = list.filter((s) => passesGate(s, gate));
  const peakHs = [];
  const peakTs = [];
  const peakVals = [];
  for (const s of active) {
    if (Number.isFinite(s.peakH)) peakHs.push(s.peakH);
    if (Number.isFinite(s.peakT)) peakTs.push(s.peakT);
    if (Number.isFinite(s.peakValue)) peakVals.push(s.peakValue);
  }
  peakHs.sort((a, b) => a - b);
  peakTs.sort((a, b) => a - b);
  peakVals.sort((a, b) => a - b);
  return {
    active: active.length,
    total: list.length,
    pct: list.length ? Math.round((active.length / list.length) * 100) : 0,
    medPeakH: empiricalQuantile(peakHs, 0.5),
    iqrLoH: empiricalQuantile(peakHs, 0.25),
    iqrHiH: empiricalQuantile(peakHs, 0.75),
    medPeakT: empiricalQuantile(peakTs, 0.5),
    medPeakVal: empiricalQuantile(peakVals, 0.5),
    p90PeakVal: empiricalQuantile(peakVals, 0.9),
  };
}
