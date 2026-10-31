/**
 * FluSight Sandbox Lab — Backend API Client
 * Clean, robust wrapper for all REST endpoints with unified error handling.
 */

/**
 * Per-view request guard: start() aborts the previous in-flight request and returns its
 * AbortSignal plus isCurrent(), so responses from superseded requests are never rendered.
 * cancel() invalidates any in-flight request (e.g. when a cached result is shown instead).
 */
export function createRequestGuard() {
  let controller = null;
  return {
    start() {
      if (controller) controller.abort();
      const mine = new AbortController();
      controller = mine;
      return { signal: mine.signal, isCurrent: () => controller === mine };
    },
    cancel() {
      if (controller) controller.abort();
      controller = null;
    },
  };
}

export async function fetchMetadata() {
  const res = await fetch("/api/metadata");
  if (!res.ok) {
    throw new Error(`Failed to load metadata: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function fetchForecast({ date, location, target, models, signal }) {
  const modelsParam = Array.isArray(models) ? models.join(",") : (models || "");
  const url = `/api/forecast?date=${encodeURIComponent(date)}&location=${encodeURIComponent(location)}&target=${encodeURIComponent(target)}&models=${encodeURIComponent(modelsParam)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Failed to load forecast: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function fetchMetrics({ target, location, date, season, models, fair, weeks, phase, signal }) {
  const modelsParam = Array.isArray(models) ? models.join(",") : (models || "");
  const fairFlag = fair ? 1 : 0;
  let url = `/api/metrics?target=${encodeURIComponent(target)}&location=${encodeURIComponent(location)}&date=${encodeURIComponent(date || "all")}&season=${encodeURIComponent(season || "")}&models=${encodeURIComponent(modelsParam)}&fair=${fairFlag}`;
  if (weeks) url += `&weeks=${encodeURIComponent(weeks)}`;
  if (phase) url += `&phase=${encodeURIComponent(phase)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Failed to load metrics: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function fetchSpatial({ target, date, models, signal }) {
  const modelsParam = Array.isArray(models) ? models.join(",") : (models || "");
  const url = `/api/spatial?target=${encodeURIComponent(target)}&date=${encodeURIComponent(date)}&models=${encodeURIComponent(modelsParam)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Failed to load spatial data: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function fetchHeatmap({ mode, rows, cols, location, target, metric, date, season, horizon, model, models, sortBy, normalize, includeInactive, signal } = {}) {
  const params = new URLSearchParams();
  if (mode) params.set("mode", mode);
  if (rows) params.set("rows", rows);
  if (cols) params.set("cols", cols);
  if (location) params.set("location", location);
  if (target) params.set("target", target);
  if (metric) params.set("metric", metric);
  if (date) params.set("date", date);
  if (season) params.set("season", season);
  if (horizon !== undefined && horizon !== null) params.set("horizon", String(horizon));
  if (model) params.set("model", model);
  if (models) {
    const modelsParam = Array.isArray(models) ? models.join(",") : models;
    if (modelsParam) params.set("models", modelsParam);
  }
  if (sortBy) params.set("sort_by", sortBy);
  if (normalize) params.set("normalize", normalize);
  if (includeInactive) params.set("include_inactive", "1");

  const res = await fetch(`/api/heatmap?${params.toString()}`, { signal });
  if (!res.ok) {
    throw new Error(`Failed to load heatmap data: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function fetchModelDetails(modelId) {
  const url = `/api/model-details?model=${encodeURIComponent(modelId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load model details for ${modelId}: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function fetchStatus() {
  const res = await fetch("/api/status");
  if (!res.ok) {
    throw new Error(`Failed to load server status: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function fetchEnsembles() {
  const res = await fetch("/api/ensemble/list");
  if (!res.ok) {
    throw new Error(`Failed to fetch ensembles: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function previewEnsemble(config, signal) {
  const res = await fetch("/api/ensemble/preview", {
    signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to preview ensemble: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function createEnsemble(config) {
  const res = await fetch("/api/ensemble/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to create ensemble: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function saveEnsemble(ensembleId) {
  const res = await fetch("/api/ensemble/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ensemble_id: ensembleId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to save ensemble: HTTP ${res.status}`);
  }
  return await res.json();
}

export async function deleteEnsemble(ensembleId) {
  const res = await fetch("/api/ensemble/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ensemble_id: ensembleId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to delete ensemble: HTTP ${res.status}`);
  }
  return await res.json();
}


// ----------------------------------------------------------------------------
// Live hub data (S3). Only check/sync/add reach the network, and only when the user asks.
// ----------------------------------------------------------------------------

async function remotePost(path, body) {
  const res = await fetch(`/api/remote/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !(path === "add" && res.status === 422)) {
    throw new Error(data.error || `Request failed: HTTP ${res.status}`);
  }
  return data;
}

export async function fetchRemoteHubs() {
  const res = await fetch("/api/remote/hubs");
  if (!res.ok) throw new Error(`Failed to load hubs: HTTP ${res.status}`);
  return await res.json();
}

export async function fetchRemoteJob(hubId) {
  const res = await fetch(`/api/remote/job?hub=${encodeURIComponent(hubId)}`);
  if (!res.ok) throw new Error(`Failed to load sync status: HTTP ${res.status}`);
  return await res.json();
}

export async function fetchRemoteWarnings(hubId) {
  const res = await fetch(`/api/remote/warnings?hub=${encodeURIComponent(hubId)}`);
  if (!res.ok) throw new Error(`Failed to load data-quality notes: HTTP ${res.status}`);
  return await res.json();
}

export const checkRemoteHub = (hubId) => remotePost("check", { hub: hubId });
export const startRemoteSync = (hubId, seasons) => remotePost("sync", { hub: hubId, seasons });
export const cancelRemoteSync = (hubId) => remotePost("cancel", { hub: hubId });
export const removeRemoteHub = (hubId) => remotePost("remove", { hub: hubId });
export const toggleRemoteHub = (hubId, enabled) => remotePost("toggle", { hub: hubId, enabled });
export const addRemoteHub = (bucket) => remotePost("add", { bucket });

export async function fetchPeaks({ target, location, date, models, skillScope, common, signal }) {
  const params = new URLSearchParams({
    target: target || "",
    location: location || "US",
    date: date || "",
    models: (models || []).join(","),
    skill_scope: skillScope || "location",
    common: common ? "1" : "0",
  });
  const res = await fetch(`/api/peaks?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`Failed to load peak forecasts: HTTP ${res.status}`);
  return await res.json();
}

export async function fetchPeakMap({ target, date, model, signal }) {
  const params = new URLSearchParams({ target: target || "", date: date || "", model: model || "" });
  const res = await fetch(`/api/peak-map?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`Failed to load peak map: HTTP ${res.status}`);
  return await res.json();
}

export async function fetchSeasonCurves({ target, location, seasons }) {
  const url = `/api/season-curves?target=${encodeURIComponent(target || "")}&location=${encodeURIComponent(location || "US")}&seasons=${encodeURIComponent((seasons || []).join(","))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load season curves: HTTP ${res.status}`);
  return await res.json();
}
