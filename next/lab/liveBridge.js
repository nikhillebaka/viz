/* Non-blocking bridge to /api/next/* for the Design Lab "Live API" mode.
 * Probes the active server hub cleanly and provides adapters for Spatial, PMF, and Trajectories,
 * reporting clear fallback messages whenever the currently active hub lacks PMF or sample targets. */
import { apiUrl, loadManifest, loadPmf, loadTrajectories } from "../lib/api.js";
import { computeSampleScores, deriveQuantilesFromTrajectories } from "./fixtures.js";

let probePromise = null;

/** Probe the running /api/next/manifest and detect available hubs/targets/models. */
export async function probeLiveBackend(force = false) {
  if (!force && probePromise) return probePromise;
  probePromise = (async () => {
    try {
      const m = await loadManifest();
      const targets = m.targets || [];
      const seasons = m.seasons || [];
      const latestSeason = seasons[seasons.length - 1] || null;
      const quantileTarget = targets.find((t) => !t.is_categorical) || targets[0] || null;
      const pmfTarget = targets.find((t) => t.is_categorical || t.output_types?.includes("pmf")) || null;
      const sampleModels = (m.models || []).filter((x) => x.has_samples || x.output_types?.includes("sample"));
      const round = latestSeason?.hub_rounds?.at(-2) || latestSeason?.rounds?.at(-2) || latestSeason?.rounds?.at(-1) || null;
      return {
        ok: true,
        hubId: m.hub_id || "local",
        hubName: m.hub_name || m.hub_id || "Local hub",
        defaultLocation: m.geo?.default_location || "US",
        weekSystem: m.calendar?.week_system || "mmwr",
        season: latestSeason,
        round,
        quantileTarget,
        pmfTarget,
        sampleModels,
        models: m.models || [],
        locations: m.locations || [],
      };
    } catch (err) {
      return { ok: false, error: err?.message || "Server unavailable" };
    }
  })();
  return probePromise;
}

/** Try loading live /api/next/spatial for US/EU globe overlay. */
export async function fetchLiveSpatial(info, horizon = 1) {
  if (!info?.ok || !info.quantileTarget || !info.round) return null;
  try {
    const picked = info.models.find((m) => m.kind === "ensemble")?.id || info.models[0]?.id;
    const models = [picked, ...info.models.slice(0, 5).map((m) => m.id)].filter(Boolean);
    const unique = [...new Set(models)].join(",");
    const q = new URLSearchParams({ target: info.quantileTarget.id, date: info.round, models: unique });
    const res = await fetch(apiUrl(`/api/next/spatial?${q}`));
    if (!res.ok) return null;
    const j = await res.json();
    const states = {};
    for (const [k, st] of Object.entries(j.states || {})) {
      const mMap = st.models || {};
      const mKey = (picked && mMap[picked]) ? picked : Object.keys(mMap)[0];
      const byH = mKey ? mMap[mKey] : null;
      const modEntry = byH?.[horizon] || byH?.[String(horizon)];
      if (!modEntry) continue;
      const rec = {
        rate_per_100k: modEntry.rate_per_100k,
        median: modEntry.median,
        wis: modEntry.wis,
        trend_pct: modEntry.trend_pct,
      };
      states[k] = rec;
      if (st.fips) states[st.fips] = rec;
    }
    return { date: info.round, horizon, target: info.quantileTarget.id, states };
  } catch {
    return null;
  }
}

/** Try loading live /api/next/pmf from the active hub; returns null with reason if absent. */
export async function fetchLivePmf(info, location = "US") {
  if (!info?.ok) return { live: false, reason: "Server offline" };
  if (!info.pmfTarget || !info.season) {
    return { live: false, reason: `Active hub "${info.hubName}" has no PMF target — showing FluSight showcase` };
  }
  try {
    const loc = info.locations.some((l) => l.id === location) ? location : info.defaultLocation;
    const data = await loadPmf(info.pmfTarget.id, info.season.id, loc);
    return { live: true, data, target: info.pmfTarget, season: info.season.id, location: loc };
  } catch (err) {
    return { live: false, reason: err?.message || "No live PMF rows" };
  }
}

/** Try loading live VZT1 sample trajectories from the active hub; returns null with reason if absent. */
export async function fetchLiveTrajectories(info, location = "US") {
  if (!info?.ok) return { live: false, reason: "Server offline" };
  if (!info.sampleModels?.length || !info.quantileTarget || !info.round || !info.season) {
    return { live: false, reason: `Active hub "${info.hubName}" has 0 raw sample models cached — showing MetroCast showcase` };
  }
  try {
    const loc = info.locations.some((l) => l.id === location) ? location : info.defaultLocation;
    const modelIds = info.sampleModels.slice(0, 3).map((m) => m.id);
    const decoded = await loadTrajectories(info.quantileTarget.id, info.season.id, loc, info.round, { models: modelIds });
    if (!decoded?.modelTrajectories?.size) {
      return { live: false, reason: `No VZT1 sample trajectories found at ${loc} (${info.round})` };
    }
    const models = {};
    const modelOrder = [];
    for (const [id, mData] of decoded.modelTrajectories.entries()) {
      const samples = mData.samples.map((s) => {
        let peakWeek = 0;
        let peakVal = -Infinity;
        s.values.forEach((v, i) => {
          if (v > peakVal) { peakVal = v; peakWeek = mData.horizons[i] ?? i; }
        });
        return {
          id: s.id,
          values: s.values,
          peakWeek,
          peakDate: decoded.dates?.[mData.horizons.indexOf(peakWeek)] || decoded.round,
          peakValue: +peakVal.toFixed(1),
        };
      });
      modelOrder.push(id);
      models[id] = {
        id,
        name: id,
        samples,
        quantiles: deriveQuantilesFromTrajectories(samples),
        scores: computeSampleScores(samples, []),
        peakCloud: samples.map((s) => ({ id: s.id, week: s.peakWeek, value: s.peakValue })),
      };
    }
    return {
      live: true,
      dataset: {
        locationId: loc,
        locationName: info.locations.find((l) => l.id === loc)?.name || loc,
        target: info.quantileTarget.short || info.quantileTarget.id,
        unit: info.quantileTarget.unit || "",
        roundDate: info.round,
        horizonsCount: modelOrder[0] ? models[modelOrder[0]].quantiles.length : 0,
        dates: [],
        observedHistory: [],
        realizedFuture: [],
        modelOrder,
        models,
      },
    };
  } catch (err) {
    return { live: false, reason: err?.message || "No live sample rows" };
  }
}
