/* Deterministic showcase fixtures and scoring math for /next/lab/.
 * Pure ES module (no DOM dependency) so Node tests and browser tabs share exact values. */
import { EU_META, METROCAST_CITIES, US_STATE_META, lookupPlaceMeta } from "../geo/eu_tiles.js";

/** Deterministic 32-bit PRNG (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededFromKey(key, salt = 0) {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return mulberry32(h);
}

const WEEK_MS = 7 * 86400 * 1000;

export function addWeeksIso(isoDate, weeks) {
  const t = Date.parse(`${isoDate}T00:00:00Z`) + weeks * WEEK_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/* ================================================================ Spatial Burden Snapshots */

/** Regional epidemiologic wave intensity scalar (0.08..1.0) anchored to realistic geography. */
function waveSeverity(id, lat, lon, h) {
  const rng = seededFromKey(String(id), 101 + h * 17);
  // Subtle coastal / mountain / continental wave gradient + deterministic perturbation
  const waveLon = 0.5 + 0.35 * Math.sin((lon + 100) * 0.065 + h * 0.35);
  const waveLat = 0.5 + 0.25 * Math.cos((lat - 38) * 0.11 - h * 0.22);
  const raw = 0.15 + 0.52 * (waveLon * 0.6 + waveLat * 0.4) + (rng() - 0.5) * 0.32;
  return Math.max(0.06, Math.min(0.98, raw));
}

function makePlaceMetrics(meta, scaleFactor, h) {
  const rng = seededFromKey(meta.id, 911 + h * 31);
  const sev = waveSeverity(meta.id, meta.lat ?? 42, meta.lon ?? -90, h);
  const pop = Math.max(50000, meta.population || 3500000);
  const nowRate = Math.max(0.4, (waveSeverity(meta.id, meta.lat ?? 42, meta.lon ?? -90, 0) * scaleFactor * 0.92));
  const rate = Math.max(0.4, sev * scaleFactor * (0.9 + 0.14 * h));
  const median = (rate * pop) / 1e5;
  const obsRatio = 0.84 + rng() * 0.34;
  const observed = h <= 2 ? Math.max(1, median * obsRatio) : NaN;
  const obsRate = Number.isFinite(observed) ? (observed / pop) * 1e5 : NaN;
  const error = Number.isFinite(observed) ? median - observed : NaN;
  const trendPct = h === 0 ? 0 : Math.round(((rate - nowRate) / Math.max(0.2, nowRate)) * 100);
  const wis = Number.isFinite(observed) ? Math.max(0.18, Math.abs(error) / (pop / 1e5) * 0.55 + 0.22 + rng() * 0.45) : NaN;
  const growth = h === 0 ? trendPct : Math.round((sev - 0.45) * 44);
  return {
    id: meta.id,
    abbr: meta.abbr,
    name: meta.name,
    level: meta.level,
    region: meta.region,
    population: pop,
    lat: meta.lat,
    lon: meta.lon,
    hub: meta.hub || (EU_META[meta.id] ? "RespiCast" : "FluSight"),
    intensity: Math.max(0.05, Math.min(1, sev)),
    rate_per_100k: +rate.toFixed(2),
    o_rate: Number.isFinite(obsRate) ? +obsRate.toFixed(2) : NaN,
    median: Math.round(median),
    observed: Number.isFinite(observed) ? Math.round(observed) : NaN,
    error: Number.isFinite(error) ? Math.round(error) : NaN,
    trend_pct: trendPct,
    wis: Number.isFinite(wis) ? +wis.toFixed(2) : NaN,
    activityTier: rate > scaleFactor * 0.72 ? "Very High" : rate > scaleFactor * 0.48 ? "High" : rate > scaleFactor * 0.26 ? "Moderate" : "Low",
    growthPct: growth,
  };
}

let cachedSpatial = null;
/**
 * Build deterministic spatial metrics for all US states, European jurisdictions, and MetroCast/EU cities.
 */
export function buildSpatialSnapshot() {
  if (cachedSpatial) return cachedSpatial;
  const targets = {
    eu_ili: { id: "eu_ili", label: "ILI incidence", unit: "per 100k", scale: 280, hub: "RespiCast Syndromic" },
    eu_ari: { id: "eu_ari", label: "ARI incidence", unit: "per 100k", scale: 980, hub: "RespiCast Syndromic" },
    eu_covid: { id: "eu_covid", label: "COVID-19 hosp", unit: "per 100k", scale: 28, hub: "RespiCast COVID-19" },
  };
  const us = {};
  const eu = {};
  const cities = {};

  for (let h = 0; h < 4; h++) {
    us[h] = {};
    for (const [id, meta] of Object.entries(US_STATE_META)) {
      us[h][id] = makePlaceMetrics(meta, 16.5, h);
    }
    cities[h] = {};
    for (const c of METROCAST_CITIES) {
      const scale = c.hub === "RespiCast" ? 260 : 54; // ED visits %*10 / per-100k equivalent
      cities[h][c.id] = makePlaceMetrics(c, scale, h);
    }
  }

  for (const [tKey, tCfg] of Object.entries(targets)) {
    eu[tKey] = {};
    for (let h = 0; h < 4; h++) {
      eu[tKey][h] = {};
      for (const [id, meta] of Object.entries(EU_META)) {
        eu[tKey][h][id] = makePlaceMetrics(meta, tCfg.scale, h);
      }
    }
  }

  cachedSpatial = { targets, us, eu, cities };
  return cachedSpatial;
}

/* ================================================================ Categorical / Ordinal PMF */

export const PMF_CATEGORIES = Object.freeze([
  { id: "large_decrease", label: "Large decrease", short: "Large dec" },
  { id: "decrease", label: "Decrease", short: "Decrease" },
  { id: "stable", label: "Stable", short: "Stable" },
  { id: "increase", label: "Increase", short: "Increase" },
  { id: "large_increase", label: "Large increase", short: "Large inc" },
]);

/** Compute RPS, Log score, and Brier score for one PMF distribution against an observed category index. */
export function scorePmfEntry(probs, obsIndex) {
  if (!Array.isArray(probs) || probs.length !== 5 || obsIndex == null || obsIndex < 0 || obsIndex >= 5) {
    return { rps: NaN, logScore: NaN, brier: NaN };
  }
  let cdfP = 0;
  let cdfO = 0;
  let rpsSum = 0;
  let brier = 0;
  for (let k = 0; k < 5; k++) {
    const p = probs[k];
    const o = k === obsIndex ? 1 : 0;
    brier += (p - o) * (p - o);
    if (k < 4) {
      cdfP += p;
      cdfO += o;
      rpsSum += (cdfP - cdfO) * (cdfP - cdfO);
    }
  }
  const pObs = Math.max(1e-6, probs[obsIndex]);
  return {
    rps: +(rpsSum / 4).toFixed(3),
    logScore: +(-Math.log(pObs)).toFixed(2),
    brier: +brier.toFixed(3),
  };
}

function normalizeProbs(weights) {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => w / sum);
  // Ensure exact floating sum to 1.0 within 1e-9 while keeping 4-decimal cleanliness
  const rounded = raw.map((x) => Math.round(x * 10000) / 10000);
  const diff = +(1 - rounded.reduce((a, b) => a + b, 0)).toFixed(4);
  let maxIdx = 0;
  for (let i = 1; i < rounded.length; i++) if (rounded[i] > rounded[maxIdx]) maxIdx = i;
  rounded[maxIdx] = +(rounded[maxIdx] + diff).toFixed(4);
  return rounded;
}

let cachedPmf = null;
export function buildPmfFixture() {
  if (cachedPmf) return cachedPmf;
  const rounds = [
    "2025-11-15", "2025-11-29", "2025-12-13", "2025-12-27",
    "2026-01-10", "2026-01-24", "2026-02-07", "2026-02-21",
  ];
  const roundCenters = [2.65, 3.2, 3.75, 3.35, 2.25, 1.45, 0.95, 1.4]; // 0=large_dec .. 4=large_inc
  const observedByRound = [3, 3, 4, 3, 2, 1, 0, 1];
  const models = [
    { id: "FluSight-ensemble", name: "FluSight Ensemble", spread: 0.72, bias: 0.0 },
    { id: "UMass-flusion", name: "UMass Flusion", spread: 0.64, bias: 0.08 },
    { id: "CMU-TimeSeries", name: "CMU TimeSeries", spread: 0.85, bias: -0.14 },
    { id: "FluSight-baseline", name: "FluSight Baseline", spread: 1.35, bias: 0.0 },
  ];
  const places = ["US", "25", "06", "48"];
  const byPlace = {};

  for (const loc of places) {
    const locShift = loc === "06" ? -0.12 : loc === "48" ? 0.14 : loc === "25" ? 0.06 : 0;
    byPlace[loc] = { rounds: {}, horizons: [1, 2, 3] };
    rounds.forEach((date, rIdx) => {
      const obsIdx = Math.max(0, Math.min(4, Math.round(observedByRound[rIdx] + locShift)));
      // Future cutoff simulation: last round has unrealized truth in 1 case? Actually mark all except latest unrealized? Let's keep 7 realized + round 7 pending or all realized with toggleable last round! Let's realize first 7 and mark latest "Pending" so both states are showcased!
      const realized = rIdx < rounds.length - 1;
      const muBase = roundCenters[rIdx] + locShift;
      const modelMap = {};
      for (const m of models) {
        const rng = seededFromKey(`${loc}:${date}:${m.id}`, 404);
        const byHorizon = {};
        for (const h of [0, 1, 2, 3]) {
          const weights = [0, 1, 2, 3, 4].map((k) => {
            if (m.id === "FluSight-baseline") {
              const centerDist = Math.abs(k - 2) / 1.4;
              return Math.exp(-0.5 * centerDist * centerDist) + rng() * 0.05;
            }
            const mu = muBase + m.bias + (h - 1) * -0.06;
            const sig = m.spread + h * 0.14;
            const z = (k - mu) / sig;
            return Math.exp(-0.5 * z * z) + 0.02 + rng() * 0.035;
          });
          const probs = normalizeProbs(weights);
          const scores = realized ? scorePmfEntry(probs, obsIdx) : { rps: NaN, logScore: NaN, brier: NaN };
          byHorizon[h] = { probs, ...scores };
        }
        modelMap[m.id] = byHorizon;
      }
      byPlace[loc].rounds[date] = {
        date,
        targetEndDate: addWeeksIso(date, 1),
        observedCategory: realized ? obsIdx : null,
        models: modelMap,
      };
    });
  }

  cachedPmf = {
    target: "wk flu hosp rate change",
    categories: PMF_CATEGORIES,
    rounds,
    models,
    places: places.map((id) => lookupPlaceMeta(id)),
    byPlace,
  };
  return cachedPmf;
}

/* ================================================================ Sample Trajectories */

function linearQuantile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(sorted.length - 1, lo + 1);
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** Derive exact quantiles [q05, q10, q25, q50, q75, q90, q95] across samples per horizon step. */
export function deriveQuantilesFromTrajectories(samples) {
  if (!samples?.length) return [];
  const H = samples[0].values.length;
  const out = [];
  for (let h = 0; h < H; h++) {
    const col = samples.map((s) => s.values[h]).filter(Number.isFinite).sort((a, b) => a - b);
    out.push({
      h,
      q05: +linearQuantile(col, 0.05).toFixed(2),
      q10: +linearQuantile(col, 0.10).toFixed(2),
      q25: +linearQuantile(col, 0.25).toFixed(2),
      q50: +linearQuantile(col, 0.50).toFixed(2),
      q75: +linearQuantile(col, 0.75).toFixed(2),
      q90: +linearQuantile(col, 0.90).toFixed(2),
      q95: +linearQuantile(col, 0.95).toFixed(2),
    });
  }
  return out;
}

/** Compute exact O(M log M) 1D CRPS and Energy Score against an observed prefix vector. */
export function computeSampleScores(samples, obsFuture) {
  const M = samples.length;
  const validH = [];
  for (let h = 0; h < obsFuture.length; h++) {
    if (Number.isFinite(obsFuture[h])) validH.push(h);
  }
  if (!M || !validH.length) return { crps: NaN, energyScore: NaN, evaluatedWeeks: 0 };

  let crpsSum = 0;
  for (const h of validH) {
    const y = obsFuture[h];
    const x = samples.map((s) => s.values[h]).sort((a, b) => a - b);
    let t1 = 0;
    let wSum = 0;
    for (let i = 0; i < M; i++) {
      t1 += Math.abs(x[i] - y);
      wSum += (2 * i - M + 1) * x[i];
    }
    const crps = t1 / M - wSum / (M * M);
    crpsSum += crps;
  }

  // Exact Multivariate Energy Score over evaluated horizon vector (H_eval dims)
  const vecDist = (a, b) => {
    let s = 0;
    for (const h of validH) {
      const d = a[h] - b[h];
      s += d * d;
    }
    return Math.sqrt(s);
  };
  let termObs = 0;
  for (let i = 0; i < M; i++) termObs += vecDist(samples[i].values, obsFuture);
  termObs /= M;

  let termPair = 0;
  for (let i = 0; i < M; i++) {
    for (let j = i + 1; j < M; j++) {
      termPair += 2 * vecDist(samples[i].values, samples[j].values);
    }
  }
  termPair /= (M * M);
  return {
    crps: +(crpsSum / validH.length).toFixed(2),
    energyScore: +Math.max(0, termObs - 0.5 * termPair).toFixed(2),
    evaluatedWeeks: validH.length,
  };
}

let cachedTraj = null;
export function buildTrajectoriesFixture() {
  if (cachedTraj) return cachedTraj;
  const roundDate = "2025-11-29";
  const historyWeeks = 12;
  const horizonsCount = 28; // 28-week long-range scenario / MetroCast horizon

  // Past observed path (12 weeks leading up to roundDate)
  const observedHistory = [];
  for (let i = -historyWeeks; i < 0; i++) {
    const w = i + historyWeeks;
    const base = 6.2 + 0.52 * w + 2.8 * Math.exp(-Math.pow((w - 11) / 4.5, 2));
    const jitter = (seededFromKey(`hist:${w}`, 12)() - 0.5) * 1.1;
    observedHistory.push({
      weekOffset: i,
      date: addWeeksIso(roundDate, i),
      value: +(Math.max(2, base + jitter)).toFixed(1),
    });
  }
  const anchorVal = observedHistory[observedHistory.length - 1].value;

  // Realized truth for first 8 horizon weeks (so CRPS / Energy Score evaluates!)
  const realizedFuture = Array.from({ length: horizonsCount }, (_, h) => {
    if (h >= 8) return NaN;
    const wave = 13.5 + 46 * Math.exp(-Math.pow((h - 6.4) / 3.9, 2));
    const jit = (seededFromKey(`fut:${h}`, 77)() - 0.5) * 2.1;
    return +Math.max(4, wave + jit).toFixed(1);
  });

  const modelSpecs = [
    { id: "ACCIDDA-Chromantis", name: "ACCIDDA-Chromantis", peakMean: 6.5, peakAmp: 50, sharpness: 1.0, seed: 2025 },
    { id: "CU-NeuralWalkODE", name: "CU-NeuralWalkODE", peakMean: 7.4, peakAmp: 44, sharpness: 1.25, seed: 4099 },
  ];

  const models = {};
  for (const spec of modelSpecs) {
    const rng = mulberry32(spec.seed);
    const gaussian = () => {
      const u1 = Math.max(1e-7, rng());
      const u2 = rng();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };

    const samples = [];
    for (let s = 0; s < 100; s++) {
      // Sample coherent epidemic trajectory parameters (timing, amplitude, decay + AR(1) innovations)
      const peakWeek = Math.max(2.5, Math.min(20, spec.peakMean + gaussian() * (1.8 * spec.sharpness)));
      const amplitude = Math.max(18, spec.peakAmp * Math.exp(gaussian() * (0.28 * spec.sharpness)));
      const riseWidth = 3.0 + rng() * 1.4;
      const tailWidth = 4.6 + rng() * 2.2;
      const baseline = Math.max(4, anchorVal * (0.85 + rng() * 0.28));

      const values = [];
      let ar = 0;
      let peakVal = -Infinity;
      let peakIdx = 0;
      for (let h = 0; h < horizonsCount; h++) {
        const sig = h < peakWeek ? riseWidth : tailWidth;
        const curve = baseline + amplitude * Math.exp(-Math.pow((h - peakWeek) / sig, 2));
        ar = 0.72 * ar + gaussian() * (1.65 * spec.sharpness) * Math.min(1.4, 0.4 + h * 0.08);
        // Smooth blend from anchorVal at h=0
        const blend = Math.exp(-h * 0.45);
        const val = Math.max(1.5, blend * anchorVal + (1 - blend) * curve + (1 - blend * 0.7) * ar);
        const rounded = +val.toFixed(2);
        values.push(rounded);
        if (rounded > peakVal) { peakVal = rounded; peakIdx = h; }
      }
      samples.push({
        id: `s${String(s + 1).padStart(3, "0")}`,
        values,
        peakWeek: peakIdx,
        peakDate: addWeeksIso(roundDate, peakIdx),
        peakValue: +peakVal.toFixed(1),
      });
    }
    const quantiles = deriveQuantilesFromTrajectories(samples);
    const scores = computeSampleScores(samples, realizedFuture);
    models[spec.id] = {
      id: spec.id,
      name: spec.name,
      samples,
      quantiles,
      scores,
      peakCloud: samples.map((s) => ({ id: s.id, week: s.peakWeek, value: s.peakValue })),
    };
  }

  cachedTraj = {
    locationId: "provo",
    locationName: "Provo, UT (Flu MetroCast)",
    target: "ILI ED visits",
    unit: "visits / wk",
    roundDate,
    horizonsCount,
    dates: Array.from({ length: horizonsCount }, (_, h) => addWeeksIso(roundDate, h)),
    observedHistory,
    realizedFuture,
    modelOrder: modelSpecs.map((m) => m.id),
    models,
  };
  return cachedTraj;
}

/* ================================================================ Weekly Place Briefing Builder */

function buildWaveSeries(seedKey, baseLevel, peakHeight, peakIdx = 14) {
  const rng = seededFromKey(seedKey, 707);
  const obs = [];
  const prior = [];
  for (let w = 0; w < 22; w++) {
    const seasonal = baseLevel + peakHeight * Math.exp(-Math.pow((w - peakIdx) / 4.2, 2));
    const val = +(Math.max(0.2, seasonal + (rng() - 0.5) * (peakHeight * 0.07))).toFixed(2);
    if (w < 14) obs.push({ w, val });
    const pVal = +(Math.max(0.2, baseLevel * 0.9 + (peakHeight * 0.84) * Math.exp(-Math.pow((w - (peakIdx - 1.5)) / 4.0, 2)))).toFixed(2);
    prior.push({ w, val: pVal });
  }
  const forecast = [];
  const lastObs = obs[obs.length - 1].val;
  for (let h = 0; h <= 4; h++) {
    const w = 13 + h;
    const center = baseLevel + peakHeight * Math.exp(-Math.pow((w - peakIdx) / 4.2, 2));
    const med = h === 0 ? lastObs : +(0.35 * lastObs + 0.65 * center).toFixed(2);
    const spread = h * peakHeight * (0.095 + rng() * 0.03);
    forecast.push({
      h,
      w,
      med,
      lo50: +(Math.max(0.1, med - spread * 0.48)).toFixed(2),
      hi50: +(med + spread * 0.48).toFixed(2),
      lo95: +(Math.max(0.1, med - spread * 1.15)).toFixed(2),
      hi95: +(med + spread * 1.28).toFixed(2),
    });
  }
  return { obs, prior, forecast };
}

/** Generate a complete, epidemiologically coherent weekly briefing for any location ID. */
export function buildBriefingForPlace(placeId = "US") {
  const meta = lookupPlaceMeta(placeId) || US_STATE_META.US;
  const spatial = buildSpatialSnapshot();
  const isEU = !!EU_META[meta.id] || meta.hub === "RespiCast";
  const isMetro = meta.level === "hsa" || meta.level === "metro" || meta.level === "region";
  const snap = US_STATE_META[meta.id]
    ? spatial.us[1][meta.id]
    : EU_META[meta.id]
      ? spatial.eu.eu_ili[1][meta.id]
      : spatial.cities[1][meta.id] || makePlaceMetrics(meta, 48, 1);

  const rng = seededFromKey(meta.id, 303);
  const weekNum = 49;
  const roundDate = "2025-12-06";
  const phase = snap.growthPct > 12 ? "Accelerating surge" : snap.growthPct > 2 ? "Approaching seasonal peak" : snap.growthPct < -10 ? "Post-peak decline" : "High plateau";
  const intensityWord = snap.activityTier === "Very High" ? "elevated and rapidly accelerating" : snap.activityTier === "High" ? "above the seasonal baseline and climbing" : "moderate with steady multi-model consensus";

  const breadcrumbs = isEU
    ? ["RespiCast Europe", meta.region || "Europe", meta.name]
    : meta.id === "US"
      ? ["United States", "National FluSight · COVID-19 · RSV"]
      : isMetro
        ? ["United States", meta.region || meta.parentId, meta.name]
        : ["United States", meta.region || "HHS Region", meta.name];

  const signals = isEU
    ? [
        { id: "ili", label: "ILI Incidence", value: snap.rate_per_100k, unit: "/ 100k", deltaPct: snap.growthPct, tier: snap.activityTier, scale: 280 },
        { id: "ari", label: "ARI Syndrome", value: +(snap.rate_per_100k * 3.4).toFixed(1), unit: "/ 100k", deltaPct: Math.round(snap.growthPct * 0.7), tier: snap.activityTier, scale: 980 },
        { id: "covid", label: "COVID-19 Hosp", value: +(12 + rng() * 14).toFixed(1), unit: "/ 100k", deltaPct: Math.round((rng() - 0.55) * 18), tier: "Moderate", scale: 35 },
      ]
    : [
        { id: "flu", label: isMetro ? "Metro ILI ED" : "Influenza Hosp", value: snap.rate_per_100k, unit: isMetro ? "ED / 100k" : "/ 100k", deltaPct: snap.growthPct, tier: snap.activityTier, scale: 20 },
        { id: "covid", label: "COVID-19 Hosp", value: +(5.4 + rng() * 8.2).toFixed(1), unit: "/ 100k", deltaPct: Math.round((rng() - 0.58) * 16), tier: "Moderate", scale: 18 },
        { id: "rsv", label: "RSV Hosp", value: +(3.1 + rng() * 5.6).toFixed(1), unit: "/ 100k", deltaPct: Math.round(6 + (rng() - 0.3) * 14), tier: "Elevated", scale: 12 },
      ];

  for (const sig of signals) {
    sig.wave = buildWaveSeries(`${meta.id}:${sig.id}`, sig.value * 0.28, sig.value * 1.45, 14 + Math.round((rng() - 0.5) * 2));
  }

  const primary = signals[0];
  const pmfProbs = normalizeProbs([
    snap.growthPct < -12 ? 0.34 : 0.04,
    snap.growthPct < 0 ? 0.36 : 0.10,
    Math.abs(snap.growthPct) <= 8 ? 0.44 : 0.22,
    snap.growthPct > 2 ? 0.42 : 0.16,
    snap.growthPct > 18 ? 0.38 : 0.08,
  ]);

  // Regional / peer neighbors for click-through exploration
  const peers = [];
  if (isEU) {
    const candidates = Object.values(EU_META).filter((x) => x.id !== meta.id && !x.parent_id && x.region === meta.region).slice(0, 4);
    for (const c of candidates) {
      const m = spatial.eu.eu_ili[1][c.id];
      peers.push({ id: c.id, name: c.name, abbr: c.abbr, rate: m.rate_per_100k, deltaPct: m.growthPct, tier: m.activityTier });
    }
  } else if (meta.id === "US") {
    for (const pid of ["25", "06", "48", "36"]) {
      const m = spatial.us[1][pid];
      if (m) peers.push({ id: m.id, name: m.name, abbr: m.abbr, rate: m.rate_per_100k, deltaPct: m.growthPct, tier: m.activityTier });
    }
    for (const cid of ["provo", "boston"]) {
      const m = spatial.cities[1][cid];
      if (m) peers.push({ id: m.id, name: m.name, abbr: m.abbr, rate: m.rate_per_100k, deltaPct: m.growthPct, tier: m.activityTier });
    }
  } else {
    peers.push({ id: "US", name: "United States", abbr: "US", rate: spatial.us[1].US.rate_per_100k, deltaPct: spatial.us[1].US.growthPct, tier: spatial.us[1].US.activityTier });
    if (isMetro && meta.parentId && spatial.us[1][meta.parentId]) {
      const pm = spatial.us[1][meta.parentId];
      peers.push({ id: pm.id, name: pm.name, abbr: pm.abbr, rate: pm.rate_per_100k, deltaPct: pm.growthPct, tier: pm.activityTier });
    }
    const hhs = isMetro && meta.parentId ? US_STATE_META[meta.parentId]?.region : meta.region;
    const sameReg = Object.values(US_STATE_META).filter((x) => x.id !== meta.id && x.id !== meta.parentId && x.id !== "US" && x.region === hhs).slice(0, 3);
    for (const c of sameReg) {
      const m = spatial.us[1][c.id];
      peers.push({ id: c.id, name: c.name, abbr: c.abbr, rate: m.rate_per_100k, deltaPct: m.growthPct, tier: m.activityTier });
    }
    const metroKids = METROCAST_CITIES.filter((c) => c.id !== meta.id && (c.parentId === meta.id || c.region === meta.abbr)).slice(0, 2);
    for (const k of metroKids) {
      const m = spatial.cities[1][k.id];
      peers.push({ id: k.id, name: k.name, abbr: k.abbr, rate: m.rate_per_100k, deltaPct: m.growthPct, tier: m.activityTier });
    }
  }

  const leaderboard = [
    { model: isEU ? "RespiCast-ensemble" : isMetro ? "ACCIDDA-Chromantis" : "FluSight-ensemble", slot: 1, wis: +(0.82 + rng() * 0.25).toFixed(2), relWis: +(0.58 + rng() * 0.1).toFixed(2), cov95: 94, bias: "+2%" },
    { model: isEU ? "ECDC-soca_simplex" : "UMass-flusion", slot: 2, wis: +(0.91 + rng() * 0.28).toFixed(2), relWis: +(0.64 + rng() * 0.12).toFixed(2), cov95: 92, bias: "-4%" },
    { model: isEU ? "Chronos-Chronos2" : "CU-NeuralWalkODE", slot: 3, wis: +(1.04 + rng() * 0.34).toFixed(2), relWis: +(0.73 + rng() * 0.14).toFixed(2), cov95: 88, bias: "+8%" },
    { model: isEU ? "ECDC-SARIMA" : "FluSight-baseline", slot: 0, wis: +(1.42 + rng() * 0.2).toFixed(2), relWis: 1.0, cov95: 83, bias: "0%" },
  ];

  const peakWeek = "Wk 02 (Jan 10)";
  const peakMedian = +(primary.value * 1.62).toFixed(1);
  const consensusPct = Math.round(74 + rng() * 18);

  return {
    placeId: meta.id,
    name: meta.name,
    abbr: meta.abbr,
    region: meta.region || "Global",
    population: meta.population || 0,
    isEU,
    isMetro,
    weekLabel: isEU ? `ISO 2025-W${weekNum}` : `MMWR 2025 Wk ${weekNum}`,
    roundDate,
    phase,
    headline: `${meta.name} respiratory activity is ${intensityWord}, led by ${primary.label} at ${primary.value} ${primary.unit} (${primary.deltaPct >= 0 ? "+" : ""}${primary.deltaPct}% WoW).`,
    signals,
    primaryWave: primary.wave,
    pmfProbs,
    peakOutlook: {
      peakWeek,
      peakWindow: "Wk 52 – Wk 04",
      peakMedian,
      unit: primary.unit,
      alreadyPassedProb: snap.growthPct < -8 ? 82 : 14,
    },
    consensusPct,
    whatChanged: [
      { title: "Signal momentum", delta: `${primary.deltaPct >= 0 ? "+" : ""}${primary.deltaPct}% vs last week`, detail: "Second consecutive week above the early-season onset threshold." },
      { title: "Median trajectory", delta: snap.growthPct >= 0 ? "+1.3 wks earlier peak" : "Tracking prior median", detail: "Ensemble peak distribution narrowed by 18% relative to Wk 47." },
      { title: "Forecast accuracy", delta: `${leaderboard[0].relWis.toFixed(2)}× Rel WIS`, detail: `${leaderboard[0].model} leads 4-week rolling local calibration at ${leaderboard[0].cov95}% coverage.` },
    ],
    leaderboard,
    peers: peers.slice(0, 6),
    breadcrumbs,
  };
}
