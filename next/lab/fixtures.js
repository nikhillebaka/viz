/* Deterministic epidemiologic showcase fixtures and scoring math for /next/lab/.
 * Pure ES module (no DOM dependency) supporting US states, 33+ European countries,
 * and all 95 MetroCast HSAs across multi-source seasonal, virologic, PMF, and trajectory views. */
import { EU_META, METROCAST_CITIES, US_STATE_META, lookupPlaceMeta } from "../geo/eu_tiles.js";

export const HUB_SCOPES = Object.freeze([
  { kind: "hub", id: "flusight", abbr: "FluSight", name: "CDC FluSight", region: "United States", lon: -96, lat: 39, zoom: 2.15, focusPlace: "US" },
  { kind: "hub", id: "flu_metrocast", abbr: "MetroCast", name: "Flu MetroCast", region: "United States · 95 HSAs", lon: -89, lat: 38.5, zoom: 2.45, focusPlace: "US" },
  { kind: "hub", id: "respicast", abbr: "RespiCast", name: "RespiCast Europe", region: "Europe · EEA / UK", lon: 10, lat: 50, zoom: 2.55, focusPlace: "DE" },
  { kind: "hub", id: "covid19", abbr: "COVID-19", name: "COVID-19 Forecast Hub", region: "United States", lon: -96, lat: 39, zoom: 2.15, focusPlace: "US" },
  { kind: "hub", id: "rsv", abbr: "RSV", name: "RSV Forecast Hub", region: "United States", lon: -96, lat: 39, zoom: 2.15, focusPlace: "US" },
]);

export const REGION_SCOPES = Object.freeze([
  { kind: "region", id: "region:na", abbr: "NA", name: "North America", region: "Continent", lon: -96, lat: 41, zoom: 1.85, focusPlace: "US" },
  { kind: "region", id: "region:eu", abbr: "EU", name: "Europe", region: "Continent", lon: 12, lat: 51, zoom: 2.45, focusPlace: "DE" },
]);

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
  const s = String(key);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return mulberry32(h);
}

const WEEK_MS = 7 * 86400 * 1000;

export function addWeeksIso(isoDate, weeks) {
  const t = Date.parse(`${isoDate}T00:00:00Z`) + weeks * WEEK_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/* ================================================================ Unified & Signal Metrics */

function waveSeverity(id, lat, lon, h = 1) {
  const rng = seededFromKey(String(id), 101 + h * 17);
  const waveLon = 0.5 + 0.35 * Math.sin((lon + 100) * 0.065 + h * 0.35);
  const waveLat = 0.5 + 0.25 * Math.cos((lat - 38) * 0.11 - h * 0.22);
  const raw = 0.15 + 0.52 * (waveLon * 0.6 + waveLat * 0.4) + (rng() - 0.5) * 0.32;
  return Math.max(0.06, Math.min(0.98, raw));
}

function computeSignalsForPlace(meta, h = 1) {
  const lat = meta.lat ?? 40;
  const lon = meta.lon ?? -92;
  const rng = seededFromKey(meta.id, 911 + h * 31);
  const sev = waveSeverity(meta.id, lat, lon, h);
  const nowSev = waveSeverity(meta.id, lat, lon, 0);
  const isEU = !!EU_META[meta.id] || meta.hub === "RespiCast";
  const pop = Math.max(50000, meta.population || 2500000);

  // Dimensionless normalized seasonal intensity (0..100% of 4-yr peak)
  const seasonalPct = Math.round(sev * 96);
  const growthPct = h === 0 ? Math.round((sev - 0.44) * 38) : Math.round(((sev - nowSev * 0.88) / Math.max(0.12, nowSev)) * 28 + (rng() - 0.5) * 14);
  const rt = +(Math.max(0.76, Math.min(1.42, 0.96 + growthPct * 0.008 + (rng() - 0.5) * 0.06))).toFixed(2);

  // Distinct pathogen / surveillance layer values
  const fluHosp = +(0.6 + sev * 15.8 * (0.92 + rng() * 0.16)).toFixed(2);
  const metroEd = +(0.4 + sev * 7.6 * (0.9 + rng() * 0.2)).toFixed(2);
  const euIli = +(22 + sev * 265 * (0.9 + rng() * 0.2)).toFixed(1);
  const covidHosp = +(1.2 + (0.25 + 0.6 * seededFromKey(meta.id, 303)()) * 14.5).toFixed(2);
  const rsvHosp = +(0.5 + (0.2 + 0.7 * seededFromKey(meta.id, 505)()) * 10.2).toFixed(2);

  const primaryRate = isEU ? euIli : fluHosp;
  const median = Math.round((primaryRate * pop) / 1e5);
  const obsRatio = 0.85 + rng() * 0.32;
  const observed = h <= 2 ? Math.max(1, Math.round(median * obsRatio)) : NaN;
  const oRate = Number.isFinite(observed) ? +((observed / pop) * 1e5).toFixed(2) : NaN;
  const error = Number.isFinite(observed) ? median - observed : NaN;
  const wis = Number.isFinite(observed) ? +(Math.max(0.18, Math.abs(error) / (pop / 1e5) * 0.55 + 0.22 + rng() * 0.4)).toFixed(2) : NaN;

  return {
    id: meta.id,
    abbr: meta.abbr || meta.id,
    name: meta.name || meta.id,
    level: meta.level || (meta.stateFips ? "hsa" : "custom"),
    region: meta.region || meta.stateAbb || "Global",
    population: pop,
    lat,
    lon,
    isEU,
    intensity: sev,
    seasonal_intensity: seasonalPct,
    flu_hosp: fluHosp,
    metro_ed: metroEd,
    eu_ili: euIli,
    covid: covidHosp,
    rsv: rsvHosp,
    rate_per_100k: primaryRate,
    o_rate: oRate,
    median,
    observed,
    error,
    trend_pct: growthPct,
    growthPct,
    wis,
    rt,
  };
}

const layerMetricsCache = new Map();
/** Lookup normalized [0..1] value & formatted display strings for any layer on Globe. */
export function metricForPlace(placeMeta, layerId = "seasonal_intensity") {
  if (!placeMeta?.id) return null;
  const key = `${placeMeta.id}:${placeMeta.stateFips || ""}`;
  let base = layerMetricsCache.get(key);
  if (!base) {
    base = computeSignalsForPlace(placeMeta, 1);
    layerMetricsCache.set(key, base);
  }
  const layer = layerId || "seasonal_intensity";
  const configs = {
    seasonal_intensity: { v: base.seasonal_intensity, norm: base.seasonal_intensity / 100, unit: "% peak", label: "Seasonal intensity" },
    flu_hosp: { v: base.flu_hosp, norm: Math.min(1, base.flu_hosp / 18), unit: "/ 100k", label: "Flu admits" },
    metro_ed: { v: base.metro_ed, norm: Math.min(1, base.metro_ed / 9), unit: "% ED", label: "Flu ED visits" },
    eu_ili: { v: base.eu_ili, norm: Math.min(1, base.eu_ili / 290), unit: "/ 100k", label: "ILI incidence" },
    covid: { v: base.covid, norm: Math.min(1, base.covid / 16), unit: "/ 100k", label: "COVID-19 admits" },
    rsv: { v: base.rsv, norm: Math.min(1, base.rsv / 12), unit: "/ 100k", label: "RSV admits" },
    none: { v: null, norm: 0, unit: "", label: "Borders" },
  };
  const cfg = configs[layer] || configs.seasonal_intensity;
  return { ...base, value: cfg.v, norm: cfg.norm, unit: cfg.unit, layerLabel: cfg.label };
}

let cachedSpatial = null;
export function buildSpatialSnapshot() {
  if (cachedSpatial) return cachedSpatial;
  const targets = {
    eu_ili: { id: "eu_ili", label: "ILI incidence", unit: "/ 100k", scale: 280, hub: "RespiCast" },
    eu_ari: { id: "eu_ari", label: "ARI incidence", unit: "/ 100k", scale: 960, hub: "RespiCast" },
    eu_covid: { id: "eu_covid", label: "COVID-19 hosp", unit: "/ 100k", scale: 26, hub: "RespiCast" },
  };
  const us = {};
  const eu = {};
  const cities = {};

  for (let h = 0; h < 4; h++) {
    us[h] = {};
    for (const [id, meta] of Object.entries(US_STATE_META)) {
      us[h][id] = computeSignalsForPlace(meta, h);
    }
    cities[h] = {};
    for (const c of METROCAST_CITIES) {
      cities[h][c.id] = computeSignalsForPlace(c, h);
    }
  }

  for (const [tKey, tCfg] of Object.entries(targets)) {
    eu[tKey] = {};
    for (let h = 0; h < 4; h++) {
      eu[tKey][h] = {};
      for (const [id, meta] of Object.entries(EU_META)) {
        const base = computeSignalsForPlace(meta, h);
        const factor = tCfg.id === "eu_ari" ? 3.4 : tCfg.id === "eu_covid" ? 0.095 : 1.0;
        const rate = +(base.eu_ili * factor * (0.92 + h * 0.06)).toFixed(1);
        const median = Math.round((rate * base.population) / 1e5);
        const observed = h <= 2 ? Math.round(median * (0.86 + seededFromKey(`${id}:${tKey}:${h}`, 88)() * 0.28)) : NaN;
        const oRate = Number.isFinite(observed) ? +((observed / base.population) * 1e5).toFixed(1) : NaN;
        const error = Number.isFinite(observed) ? median - observed : NaN;
        eu[tKey][h][id] = {
          ...base,
          rate_per_100k: rate,
          o_rate: oRate,
          median,
          observed,
          error,
        };
      }
    }
  }

  cachedSpatial = { targets, us, eu, cities };
  return cachedSpatial;
}

/* ================================================================ Categorical / Ordinal PMF (20 Rounds) */

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
  const rounded = raw.map((x) => Math.round(x * 10000) / 10000);
  const diff = +(1 - rounded.reduce((a, b) => a + b, 0)).toFixed(4);
  let maxIdx = 0;
  for (let i = 1; i < rounded.length; i++) if (rounded[i] > rounded[maxIdx]) maxIdx = i;
  rounded[maxIdx] = +(rounded[maxIdx] + diff).toFixed(4);
  return rounded;
}

/**
 * Convert 5 ordered PMF probabilities [large_dec, dec, stable, inc, large_inc] into
 * centered vertical segment intervals `[y0, y1]` where positive y rises upward (increasing)
 * and negative y falls downward (decreasing), splitting `stable` symmetrically across 0.
 */
export function verticalPmfSegments(probs) {
  const [p0, p1, p2, p3, p4] = probs;
  const halfS = p2 * 0.5;
  return [
    { cat: 0, y0: -(halfS + p1 + p0), y1: -(halfS + p1), p: p0 },
    { cat: 1, y0: -(halfS + p1), y1: -halfS, p: p1 },
    { cat: 2, y0: -halfS, y1: halfS, p: p2 },
    { cat: 3, y0: halfS, y1: halfS + p3, p: p3 },
    { cat: 4, y0: halfS + p3, y1: halfS + p3 + p4, p: p4 },
  ];
}

let cachedPmf = null;
export function buildPmfFixture() {
  if (cachedPmf) return cachedPmf;
  const rounds = Array.from({ length: 20 }, (_, i) => addWeeksIso("2025-10-18", i));
  // Realistic seasonal trajectory of categorical centers: quiet Oct -> surge Dec -> peak early Jan -> decline Feb
  const roundCenters = [
    2.1, 2.25, 2.45, 2.75, 3.05, 3.35, 3.65, 3.85,
    3.6, 3.1, 2.4, 1.8, 1.25, 0.9, 0.75, 1.0,
    1.35, 1.65, 1.85, 2.0,
  ];
  const models = [
    { id: "FluSight-ensemble", name: "FluSight Ensemble", spread: 0.7, bias: 0.0 },
    { id: "UMass-flusion", name: "UMass Flusion", spread: 0.62, bias: 0.08 },
    { id: "CMU-TimeSeries", name: "CMU TimeSeries", spread: 0.84, bias: -0.14 },
    { id: "FluSight-baseline", name: "FluSight Baseline", spread: 1.32, bias: 0.0 },
  ];
  const places = ["US", "25", "06", "48"];
  const byPlace = {};

  for (const loc of places) {
    const locShift = loc === "06" ? -0.12 : loc === "48" ? 0.14 : loc === "25" ? 0.06 : 0;
    byPlace[loc] = { rounds: {}, horizons: [0, 1, 2, 3] };
    rounds.forEach((date, rIdx) => {
      const realized = rIdx < rounds.length - 2; // 18 realized + 2 recent pending rounds
      const jitter = Math.round((seededFromKey(`${loc}:${date}`, 612)() - 0.5) * 0.6);
      const obsIdx = Math.max(0, Math.min(4, Math.round(roundCenters[rIdx] + locShift + jitter)));
      const muBase = roundCenters[rIdx] + locShift;
      const modelMap = {};
      for (const m of models) {
        const rng = seededFromKey(`${loc}:${date}:${m.id}`, 404);
        const byHorizon = {};
        for (const h of [0, 1, 2, 3]) {
          const weights = [0, 1, 2, 3, 4].map((k) => {
            if (m.id === "FluSight-baseline") {
              const centerDist = Math.abs(k - 2) / 1.4;
              return Math.exp(-0.5 * centerDist * centerDist) + rng() * 0.045;
            }
            const mu = muBase + m.bias + (h - 1) * -0.07;
            const sig = m.spread + h * 0.14;
            const z = (k - mu) / sig;
            return Math.exp(-0.5 * z * z) + 0.015 + rng() * 0.03;
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
    crpsSum += t1 / M - wSum / (M * M);
  }

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
  const horizonsCount = 28;

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
    locationId: "boston",
    locationName: "Boston Metro, MA (Flu MetroCast)",
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

/* ================================================================ Multi-Source Place Briefing */

function buildStreamSeries(seedKey, baseLevel, peakHeight, peakIdx = 14, hasForecast = true) {
  const rng = seededFromKey(seedKey, 707);
  const seasonNames = ["2024–25", "2023–24", "2022–23"];
  const priors = seasonNames.map((label, sIdx) => {
    const shift = (sIdx - 1) * 1.4;
    const scale = [0.92, 0.78, 1.08][sIdx];
    const pts = [];
    for (let w = 0; w < 22; w++) {
      const val = +(Math.max(0.1, baseLevel * 0.8 + peakHeight * scale * Math.exp(-Math.pow((w - (peakIdx + shift)) / 3.9, 2)))).toFixed(2);
      pts.push({ w, val });
    }
    return { season: label, pts };
  });

  const obs = [];
  for (let w = 0; w < 14; w++) {
    const seasonal = baseLevel + peakHeight * Math.exp(-Math.pow((w - peakIdx) / 4.1, 2));
    const val = +(Math.max(0.1, seasonal + (rng() - 0.5) * (peakHeight * 0.065))).toFixed(2);
    obs.push({ w, val });
  }

  const forecast = [];
  if (hasForecast) {
    const lastObs = obs[obs.length - 1].val;
    for (let h = 0; h <= 4; h++) {
      const w = 13 + h;
      const center = baseLevel + peakHeight * Math.exp(-Math.pow((w - peakIdx) / 4.1, 2));
      const med = h === 0 ? lastObs : +(0.3 * lastObs + 0.7 * center).toFixed(2);
      const spread = h * peakHeight * (0.09 + rng() * 0.03);
      forecast.push({
        h, w, med,
        lo50: +(Math.max(0.05, med - spread * 0.45)).toFixed(2),
        hi50: +(med + spread * 0.48).toFixed(2),
        lo95: +(Math.max(0.05, med - spread * 1.15)).toFixed(2),
        hi95: +(med + spread * 1.28).toFixed(2),
      });
    }
  }
  return { obs, priors, forecast };
}

/** Generate a complete multi-source weekly briefing for any place (US, State, 95 MetroCast HSAs, or EU country). */
export function buildBriefingForPlace(placeId = "US", metaHint = null, hsasList = null) {
  const meta = metaHint || lookupPlaceMeta(placeId) || US_STATE_META.US;
  const sig = computeSignalsForPlace(meta, 1);
  const rng = seededFromKey(meta.id, 303);
  const isEU = sig.isEU;
  const isMetro = !!(meta.stateFips || meta.level === "hsa" || meta.level === "metro");
  const weekNum = 46;
  const roundDate = "2025-11-15";

  const breadcrumbs = isEU
    ? ["RespiCast Europe", meta.region || "Europe", meta.name]
    : meta.id === "US"
      ? ["United States", "National FluSight · COVID-19 · RSV"]
      : isMetro
        ? ["United States", meta.stateAbb || meta.region, meta.name]
        : ["United States", meta.region || "HHS Region", meta.name];

  const kpis = isEU
    ? [
        { k: "ILI / 100k", v: `${sig.eu_ili}`, s: "ERVISS primary" },
        { k: "ARI / 100k", v: `${(sig.eu_ili * 3.4).toFixed(0)}`, s: `${sig.growthPct >= 0 ? "+" : ""}${sig.growthPct}% WoW` },
        { k: "Lab positivity", v: `${(4 + sig.intensity * 18).toFixed(1)}%`, s: "E.C.D.C. virology" },
        { k: "Growth Rt", v: `${sig.rt.toFixed(2)}`, s: sig.rt > 1.03 ? "Growing" : sig.rt < 0.97 ? "Declining" : "Flat" },
        { k: "Dominant subtype", v: "A(H1N1)pdm09", s: "68% typed A" },
      ]
    : [
        { k: isMetro ? "Metro ED %" : "Admits / 100k", v: isMetro ? `${sig.metro_ed}%` : `${sig.flu_hosp}`, s: `${sig.growthPct >= 0 ? "+" : ""}${sig.growthPct}% WoW` },
        { k: "ED visits %", v: `${sig.metro_ed}%`, s: "NSSP syndrome" },
        { k: "Wastewater flu A", v: `${(0.8 + sig.intensity * 3.4).toFixed(1)}`, s: "NWSS mean WVAL" },
        { k: "Growth Rt", v: `${sig.rt.toFixed(2)}`, s: sig.rt > 1.03 ? "Growing" : sig.rt < 0.97 ? "Declining" : "Flat" },
        { k: "Dominant subtype", v: "A(H1N1)pdm09", s: "83% typed A" },
      ];

  const streams = isEU
    ? [
        { id: "ili", label: "ILI incidence · ERVISS", unit: "/ 100k", wave: buildStreamSeries(`${meta.id}:ili`, sig.eu_ili * 0.25, sig.eu_ili * 1.35, 14, true) },
        { id: "ari", label: "ARI syndrome · ERVISS", unit: "/ 100k", wave: buildStreamSeries(`${meta.id}:ari`, sig.eu_ili * 0.9, sig.eu_ili * 4.1, 14, true) },
        { id: "sari", label: "SARI admissions", unit: "/ 100k", wave: buildStreamSeries(`${meta.id}:sari`, 0.4, 8.2, 15, true) },
        { id: "lab", label: "Lab positivity", unit: "%", wave: buildStreamSeries(`${meta.id}:lab`, 2.5, 22, 14, false) },
      ]
    : [
        { id: "nhsn", label: isMetro ? "Metro ED % · MetroCast" : "Admissions · NHSN", unit: isMetro ? "%" : "/ 100k", wave: buildStreamSeries(`${meta.id}:nhsn`, (isMetro ? sig.metro_ed : sig.flu_hosp) * 0.24, (isMetro ? sig.metro_ed : sig.flu_hosp) * 1.45, 14, true) },
        { id: "nssp", label: "ED visits · NSSP", unit: "%", wave: buildStreamSeries(`${meta.id}:nssp`, sig.metro_ed * 0.22, sig.metro_ed * 1.35, 13, true) },
        { id: "ilinet", label: "Outpatient ILI · ILINet", unit: "%", wave: buildStreamSeries(`${meta.id}:ilinet`, 1.4, 5.2, 14, false) },
        { id: "nwss", label: "Wastewater · NWSS", unit: "WVAL", wave: buildStreamSeries(`${meta.id}:nwss`, 0.5, 4.1, 12, false) },
        { id: "nrevss", label: "Lab positivity · NREVSS", unit: "%", wave: buildStreamSeries(`${meta.id}:nrevss`, 2.1, 21.5, 14, false) },
      ];

  const pmfProbs = normalizeProbs([
    sig.growthPct < -12 ? 0.34 : 0.04,
    sig.growthPct < 0 ? 0.36 : 0.10,
    Math.abs(sig.growthPct) <= 8 ? 0.44 : 0.22,
    sig.growthPct > 2 ? 0.42 : 0.16,
    sig.growthPct > 18 ? 0.38 : 0.08,
  ]);

  // Spread table rows: state metros if present, else peer jurisdictions
  const spread = [];
  const pushSpread = (mMeta) => {
    const s = computeSignalsForPlace(mMeta, 1);
    const r = seededFromKey(`${mMeta.id}:sp`, 19);
    const spark10w = Array.from({ length: 10 }, (_, k) =>
      +(Math.max(0.2, s.rate_per_100k * (0.28 + 0.72 * (k / 9)) + (r() - 0.5) * s.rate_per_100k * 0.14)).toFixed(2));
    spread.push({
      id: mMeta.id,
      abbr: mMeta.abbr || mMeta.id,
      name: mMeta.name,
      rate: isEU ? s.eu_ili : s.flu_hosp,
      edPct: isEU ? +(s.eu_ili * 3.2).toFixed(0) : s.metro_ed,
      wkChangePct: s.growthPct,
      rt: s.rt,
      spark10w,
    });
  };

  if (isEU) {
    const allEu = Object.values(EU_META).filter((x) => !x.parent_id && x.id !== meta.id);
    const sameReg = allEu.filter((x) => x.region === meta.region);
    for (const c of [...sameReg, ...allEu].slice(0, 8)) pushSpread(c);
  } else {
    const stateHsas = (hsasList || []).filter((h) => h.stateFips === meta.id || (isMetro && h.stateFips === meta.stateFips && h.id !== meta.id));
    if (stateHsas.length) {
      if (isMetro && US_STATE_META[meta.stateFips]) pushSpread(US_STATE_META[meta.stateFips]);
      for (const h of stateHsas.slice(0, 9)) pushSpread(h);
    } else if (meta.id === "US") {
      for (const fid of ["06", "48", "36", "25", "13", "17", "53", "08", "49", "12"]) {
        if (US_STATE_META[fid]) pushSpread(US_STATE_META[fid]);
      }
    } else {
      pushSpread(US_STATE_META.US);
      const sameReg = Object.values(US_STATE_META).filter((x) => x.id !== meta.id && x.id !== "US" && x.region === meta.region);
      for (const s of sameReg.slice(0, 8)) pushSpread(s);
    }
  }

  // Virology 18-week subtype shares summing cleanly to 100% + overall positivity %
  const virology = Array.from({ length: 18 }, (_, w) => {
    const rr = seededFromKey(`${meta.id}:v:${w}`, 22);
    const h1 = 0.56 + 0.14 * Math.sin(w * 0.22) + rr() * 0.04;
    const h3 = 0.16 + 0.05 * Math.cos(w * 0.18);
    const aUn = 0.14 - w * 0.004;
    const bVic = Math.max(0.04, 1 - h1 - h3 - aUn);
    const tot = h1 + h3 + aUn + bVic;
    const posPct = +(2.5 + 19.5 * Math.exp(-Math.pow((w - 14) / 4.4, 2)) + rr() * 1.4).toFixed(1);
    return {
      w,
      h1n1: +(h1 / tot).toFixed(3),
      h3n2: +(h3 / tot).toFixed(3),
      aUnsub: +(aUn / tot).toFixed(3),
      bVic: +(bVic / tot).toFixed(3),
      posPct,
    };
  });

  // Nextstrain clades (12 observed + 6 projected weeks)
  const cladeNames = isEU ? ["D.3.1.1 (H1N1)", "J.2.4 (H3N2)", "C.1.1 (H1N1)", "V1A.3a.2 (B/Vic)"] : ["D.3.1.1 (H1N1)", "C.1.1.1 (H1N1)", "J.2.4 (H3N2)", "V1A.3a.2 (B/Vic)"];
  const clades = Array.from({ length: 18 }, (_, w) => {
    const f0 = Math.max(0.15, Math.min(0.68, 0.34 + 0.018 * w));
    const f1 = Math.max(0.10, 0.32 - 0.011 * w);
    const f2 = Math.max(0.08, 0.24 - 0.004 * w);
    const f3 = Math.max(0.05, 1 - f0 - f1 - f2);
    const tot = f0 + f1 + f2 + f3;
    return {
      w,
      forecast: w >= 12,
      shares: [f0 / tot, f1 / tot, f2 / tot, f3 / tot],
    };
  });

  const vaccineMatch = [
    { component: "A(H1N1)pdm09", strain: "A/Wisconsin/67/2022", match: "95%", subclades: "D.3.1.1 (54%), C.1.1.1 (38%)", leading: cladeNames[0], growth: "+1.8%/wk" },
    { component: "A(H3N2)", strain: "A/Massachusetts/18/2022", match: "100%", subclades: "J.2.4 (69%), J.2 (31%)", leading: cladeNames[2], growth: "−0.4%/wk" },
    { component: "B/Victoria", strain: "B/Austria/1359417/2021", match: "97%", subclades: "V1A.3a.2 (100%)", leading: cladeNames[3], growth: "+0.2%/wk" },
  ];

  const context = isEU
    ? [
        { k: "Severity", v: "Low excess all-age mortality (EuroMOMO); pediatric SARI hospitalizations in typical range." },
        { k: "Antivirals", v: "99.4% of tested influenza viruses susceptible to neuraminidase & cap-dependent endonuclease inhibitors." },
        { k: "Zoonotic / Novel", v: "0 human A(H5) cases reported in EEA this week; routine poultry/avian monitoring ongoing." },
      ]
    : [
        { k: "Severity (FluSurv-NET)", v: "Cumulative rate slightly above recent 4-yr median; 2 pediatric deaths reported this season." },
        { k: "Antivirals", v: ">99% susceptible to oseltamivir, zanamivir, peramivir, and baloxavir." },
        { k: "Avian / H5 (NWSS)", v: "0 new human infections; H5 detected at 23 / 552 wastewater sites in past 14 days." },
      ];

  const sources = isEU
    ? [
        { stream: "ILI / ARI syndromes", source: "ECDC / WHO Europe ERVISS", latest: roundDate },
        { stream: "Forecasts", source: "RespiCast Hub", latest: roundDate },
        { stream: "Virology / Subtypes", source: "ERVISS Sentinel Labs", latest: roundDate },
        { stream: "Viral variants", source: "Nextstrain / GISAID", latest: roundDate },
      ]
    : [
        { stream: "Hospital admissions", source: "CDC NHSN Respiratory Data", latest: roundDate },
        { stream: "ED visits", source: "CDC NSSP", latest: roundDate },
        { stream: "MetroCast HSAs", source: "Flu MetroCast Hub", latest: roundDate },
        { stream: "Wastewater (Flu A, H5)", source: "CDC NWSS", latest: roundDate },
        { stream: "Epidemic trends (Rt)", source: "CDC CFA", latest: roundDate },
        { stream: "Virology & Subtypes", source: "FluView / NREVSS", latest: roundDate },
        { stream: "Variants", source: "Nextstrain / GISAID", latest: roundDate },
      ];

  const leaderboard = [
    { model: isEU ? "RespiCast-ensemble" : isMetro ? "ACCIDDA-Chromantis" : "FluSight-ensemble", slot: 1, wis: +(0.82 + rng() * 0.25).toFixed(2), relWis: +(0.58 + rng() * 0.1).toFixed(2), cov95: 94, bias: "+2%" },
    { model: isEU ? "ECDC-soca_simplex" : "UMass-flusion", slot: 2, wis: +(0.91 + rng() * 0.28).toFixed(2), relWis: +(0.64 + rng() * 0.12).toFixed(2), cov95: 92, bias: "-4%" },
    { model: isEU ? "Chronos-Chronos2" : "CU-NeuralWalkODE", slot: 3, wis: +(1.04 + rng() * 0.34).toFixed(2), relWis: +(0.73 + rng() * 0.14).toFixed(2), cov95: 88, bias: "+8%" },
    { model: isEU ? "ECDC-SARIMA" : "FluSight-baseline", slot: 0, wis: +(1.42 + rng() * 0.2).toFixed(2), relWis: 1.0, cov95: 83, bias: "0%" },
  ];

  return {
    placeId: meta.id,
    name: meta.name,
    abbr: meta.abbr || meta.id,
    region: meta.region || meta.stateAbb || "Global",
    population: meta.population || 0,
    isEU,
    isMetro,
    weekLabel: isEU ? `ISO 2025-W${weekNum}` : `MMWR 2025 Wk ${weekNum}`,
    roundDate,
    breadcrumbs,
    kpis,
    streams,
    pmfProbs,
    peakOutlook: {
      peakWeek: "Wk 02 (Jan 10)",
      peakWindow: "Wk 52 – Wk 04",
      peakMedian: `${+(streams[0].wave.obs.at(-1).val * 1.62).toFixed(1)} ${streams[0].unit}`,
      alreadyPassedProb: sig.growthPct < -8 ? 82 : 14,
    },
    spread,
    virology,
    cladeNames,
    clades,
    vaccineMatch,
    context,
    sources,
    leaderboard,
  };
}
