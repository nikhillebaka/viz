/**
 * FluSight Sandbox Lab — US Geographic / Spatial Map & Epidemic Wave Tracking
 * Choropleth view with multi-layer overlays (Rate, Admissions, Trend %, WIS) and Inspector Panel.
 */

import { ICONS, setFetchError } from "../constants.js";
import { state } from "../state.js";
import { fetchSpatial, fetchPeakMap, createRequestGuard } from "../api.js";
import { fmtWeek, fmtCount } from "./peak_view.js";
import { triggerPlotResizeSequence } from "./forecast_chart.js";
import { fetchAndRenderHeatmap } from "./heatmap_view.js";

export function switchViewMode(mode, callbacks = {}) {
  if (!["timeline", "spatial", "heatmap", "peak"].includes(mode)) mode = "timeline";
  state.currentView = mode;
  if (callbacks.onUrlUpdate) callbacks.onUrlUpdate();

  const btnIndicators = document.getElementById("btn-indicators-toggle");
  const indicatorsDrawer = document.getElementById("indicators-drawer");
  const forecastPlot = document.getElementById("forecast-plot");
  const panels = {
    spatial: document.getElementById("spatial-container"),
    heatmap: document.getElementById("heatmap-container"),
    peak: document.getElementById("peak-container"),
  };
  const plotLegendShortcut = document.querySelector(".plot-legend-shortcut");
  const plotHeading = document.getElementById("plot-heading");
  const plotSubheading = document.getElementById("plot-subheading");
  const isTimeline = mode === "timeline";

  document.body.classList.toggle("view-spatial", mode === "spatial");
  document.body.classList.toggle("view-heatmap", mode === "heatmap");
  document.body.classList.toggle("view-peak", mode === "peak");
  document.querySelectorAll("#view-mode-segmented .segment-btn").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-view") === mode);
  });

  // Signals & indicators belong to the fan chart only
  if (btnIndicators) {
    btnIndicators.style.display = isTimeline ? "" : "none";
    btnIndicators.classList.toggle("hidden", !isTimeline);
  }
  if (indicatorsDrawer) {
    indicatorsDrawer.style.display = isTimeline ? "" : "none";
    if (isTimeline) indicatorsDrawer.classList.toggle("collapsed", !state.indicators?.isOpen);
  }
  if (forecastPlot) {
    forecastPlot.style.display = isTimeline ? "" : "none";
    forecastPlot.classList.toggle("hidden", !isTimeline);
  }
  Object.entries(panels).forEach(([key, el]) => {
    if (el) el.classList.toggle("hidden", key !== mode);
  });
  if (plotLegendShortcut) plotLegendShortcut.style.display = isTimeline ? "" : "none";
  if (mode !== "spatial") stopSpatialPlayback();

  if (mode === "spatial") {
    if (plotHeading) plotHeading.textContent = "US Geographic Predictions & Epidemic Wave Tracking";
    if (plotSubheading) plotSubheading.textContent = "State-Level Choropleth · Population-Adjusted Rates & Trajectories";
    if (callbacks.onHeaderUpdate) callbacks.onHeaderUpdate();

    if (!state.spatialData || state.spatialData.reference_date !== state.selectedDate || state.spatialData.target !== state.selectedTarget) {
      fetchAndRenderSpatial();
    } else {
      populateSpatialModelSelect();
      renderSpatialMap();
      updateSpatialInspector();
      updateSpatialInsights();
    }
    triggerPlotResizeSequence("spatial-map-plot");
  } else if (mode === "heatmap") {
    if (plotHeading) plotHeading.textContent = "Spatio-Temporal Epidemic Heatmap & Cross-Sectional Matrix";
    if (plotSubheading) plotSubheading.textContent = "Multi-Jurisdiction Surveillance · Wave Cascades & Model Cross-Sections";
    if (callbacks.onHeaderUpdate) callbacks.onHeaderUpdate();

    fetchAndRenderHeatmap({
      ...callbacks,
      onSwitchView: (v) => switchViewMode(v, callbacks),
    });
    triggerPlotResizeSequence("heatmap-plot");
  } else if (mode === "peak") {
    if (callbacks.onHeaderUpdate) callbacks.onHeaderUpdate();
    if (callbacks.onRenderPeaks) callbacks.onRenderPeaks();
  } else {
    if (callbacks.onHeaderUpdate) callbacks.onHeaderUpdate();
    if (callbacks.onRenderForecast) {
      callbacks.onRenderForecast();
    }
    triggerPlotResizeSequence("forecast-plot");
  }
}

export function populateSpatialModelSelect() {
  const spatialModelSelect = document.getElementById("spatial-model-select");
  if (!spatialModelSelect) return;
  spatialModelSelect.innerHTML = "";

  const candidateModels = state.selectedModels.size > 0
    ? Array.from(state.selectedModels)
    : Object.keys(state.models);

  if (candidateModels.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No models available";
    spatialModelSelect.appendChild(opt);
    state.spatialActiveModel = null;
    return;
  }

  if (!state.spatialActiveModel || !candidateModels.includes(state.spatialActiveModel)) {
    state.spatialActiveModel = candidateModels[0];
  }

  candidateModels.forEach((mid) => {
    const opt = document.createElement("option");
    opt.value = mid;
    opt.textContent = mid;
    if (mid === state.spatialActiveModel) opt.selected = true;
    spatialModelSelect.appendChild(opt);
  });
}

const spatialGuard = createRequestGuard();

export async function fetchAndRenderSpatial() {
  if (!state.selectedDate) return;
  const request = spatialGuard.start();

  const candidateModels = state.selectedModels.size > 0
    ? Array.from(state.selectedModels)
    : Object.keys(state.models);

  try {
    const data = await fetchSpatial({
      target: state.selectedTarget,
      date: state.selectedDate,
      models: candidateModels,
      signal: request.signal,
    });
    if (!request.isCurrent()) return;
    setFetchError("spatial-map-plot", "");
    state.spatialData = data;

    populateSpatialModelSelect();
    renderSpatialMap();
    updateSpatialInspector();
    updateSpatialInsights();
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error("Error fetching spatial data:", err);
    setFetchError("spatial-map-plot", `Could not load map data for ${state.selectedDate}; the map below is out of date. (${err.message})`);
  }
}

export function renderSpatialMap() {
  const spatialMapPlot = document.getElementById("spatial-map-plot");
  const spatialLayerSelect = document.getElementById("spatial-layer-select");
  if (!spatialMapPlot) return;
  if (!state.spatialData || !state.spatialData.states) return;

  // Rate/proportion targets are already normalized: no per-100k layer, and "count" shows the target's own unit
  const targetMeta = state.targetsMeta?.[state.selectedTarget];
  const isRateTarget = Boolean(targetMeta?.is_rate);
  if (isRateTarget && state.spatialActiveLayer === "rate") state.spatialActiveLayer = "count";
  if (spatialLayerSelect) {
    const rateOpt = spatialLayerSelect.querySelector('option[value="rate"]');
    const countOpt = spatialLayerSelect.querySelector('option[value="count"]');
    if (rateOpt) rateOpt.hidden = rateOpt.disabled = isRateTarget;
    if (countOpt) countOpt.textContent = isRateTarget ? `Value (${targetMeta.unit || "Value"})` : "Admissions (Volume)";
  }

  const isLight = document.body.classList.contains("theme-light");

  // Season peak layers (no horizons): shown only when the target has peak companions
  const hasPeaks = Boolean(state.peakTargets?.[state.selectedTarget]);
  if (spatialLayerSelect) {
    const grp = spatialLayerSelect.querySelector("optgroup.spatial-peak-group");
    if (grp) {
      grp.hidden = !hasPeaks;
      grp.querySelectorAll("option").forEach((o) => { o.disabled = !hasPeaks; });
    }
  }
  if (PEAK_LAYERS.has(state.spatialActiveLayer) && !hasPeaks) state.spatialActiveLayer = isRateTarget ? "count" : "rate";
  const peakLayer = PEAK_LAYERS.has(state.spatialActiveLayer);
  document.querySelector(".spatial-player-group")?.classList.toggle("is-disabled", peakLayer);
  if (peakLayer) {
    stopSpatialPlayback();
    if (spatialLayerSelect && spatialLayerSelect.value !== state.spatialActiveLayer) spatialLayerSelect.value = state.spatialActiveLayer;
    document.getElementById("spatial-h0-notice")?.classList.add("hidden");
    renderPeakLayer(isLight);
    return;
  }

  const statesDict = state.spatialData.states;
  const h = state.spatialActiveHorizon;
  const mid = state.spatialActiveModel;
  const layer = state.spatialActiveLayer;
  const targetEndDate = state.spatialData.dates_by_horizon?.[h] || "";

  if (spatialLayerSelect && spatialLayerSelect.value !== layer) {
    spatialLayerSelect.value = layer;
  }

  const locations = [];
  const zValues = [];
  const customDataList = [];

  for (const [abbr, stObj] of Object.entries(statesDict)) {
    if (abbr === "US" || abbr === "PR") continue;
    const mData = stObj.models[mid]?.[h];
    locations.push(abbr);

    let z = null;
    if (mData) {
      if (layer === "rate") {
        z = mData.rate_per_100k;
      } else if (layer === "count") {
        z = mData.median;
      } else if (layer === "trend") {
        z = mData.trend_pct;
      } else if (layer === "wis") {
        z = mData.wis;
      }
    }
    // A state without a forecast stays unfilled rather than looking like a true zero
    zValues.push(z !== null && z !== undefined ? z : null);

    const popStr = stObj.population ? stObj.population.toLocaleString() : "N/A";
    const tooltip = [
      `<b>${stObj.name} (${abbr})</b>`,
      `<span style="color:${isLight ? "#586e75" : "#94a3b8"}">Pop:</span> ${popStr}`,
      `<span style="color:${isLight ? "#586e75" : "#94a3b8"};font-size:10px">Click for details</span>`
    ].join("<br>");

    customDataList.push(tooltip);
  }

  let colorscale = [];
  let colorbarTitle = "";
  let zmin = undefined;
  let zmax = undefined;
  let zmid = undefined;
  let ticksuffix = "";

  if (layer === "rate") {
    colorbarTitle = "Rate / 100k";
    let maxR = 0;
    for (const stObj of Object.values(statesDict)) {
      const mAll = stObj.models[mid];
      if (!mAll) continue;
      for (let hIdx = 0; hIdx <= 3; hIdx++) {
        const val = mAll[hIdx]?.rate_per_100k;
        if (val !== null && val !== undefined && val > maxR) maxR = val;
      }
    }
    zmin = 0;
    zmax = maxR > 0 ? Math.ceil(maxR * 1.05 * 10) / 10 : 5;
    colorscale = isLight
      ? [
        [0.0, "#fdf6e3"],
        [0.15, "#bae6fd"],
        [0.35, "#38bdf8"],
        [0.65, "#0284c7"],
        [0.85, "#e11d48"],
        [1.0, "#881337"]
      ]
      : [
        [0.0, "#131211"],
        [0.15, "#121e33"],
        [0.35, "#0369a1"],
        [0.65, "#38bdf8"],
        [0.85, "#fb7185"],
        [1.0, "#fda4af"]
      ];
  } else if (layer === "count") {
    colorbarTitle = isRateTarget ? (targetMeta.unit || "Value") : "Admissions";
    let maxC = 0;
    for (const stObj of Object.values(statesDict)) {
      const mAll = stObj.models[mid];
      if (!mAll) continue;
      for (let hIdx = 0; hIdx <= 3; hIdx++) {
        const val = mAll[hIdx]?.median;
        if (val !== null && val !== undefined && val > maxC) maxC = val;
      }
    }
    zmin = 0;
    zmax = maxC > 0 ? Math.ceil(maxC * 1.05) : 500;
    colorscale = isLight
      ? [
        [0.0, "#fdf6e3"],
        [0.2, "#bae6fd"],
        [0.5, "#0284c7"],
        [0.8, "#0369a1"],
        [1.0, "#082f49"]
      ]
      : [
        [0.0, "#131211"],
        [0.2, "#14213d"],
        [0.5, "#0284c7"],
        [0.8, "#38bdf8"],
        [1.0, "#e0f2fe"]
      ];
  } else if (layer === "trend") {
    colorbarTitle = "% Trend";
    ticksuffix = "%";
    zmin = -50;
    zmax = 50;
    zmid = 0;
    colorscale = isLight
      ? [
        [0.0, "#0d9488"],
        [0.35, "#99f6e4"],
        [0.5, "#eee8d5"],
        [0.65, "#fecdd3"],
        [1.0, "#e11d48"]
      ]
      : [
        [0.0, "#14b8a6"],
        [0.35, "#042f2e"],
        [0.5, "#1e293b"],
        [0.65, "#4c0519"],
        [1.0, "#fb7185"]
      ];
  } else if (layer === "wis") {
    colorbarTitle = "WIS Error";
    let maxW = 0;
    for (const stObj of Object.values(statesDict)) {
      const mAll = stObj.models[mid];
      if (!mAll) continue;
      for (let hIdx = 0; hIdx <= 3; hIdx++) {
        const val = mAll[hIdx]?.wis;
        if (val !== null && val !== undefined && val > maxW) maxW = val;
      }
    }
    zmin = 0;
    zmax = maxW > 0 ? Math.ceil(maxW * 1.05) : 500;
    colorscale = isLight
      ? [
        [0.0, "#059669"],
        [0.25, "#34d399"],
        [0.55, "#d97706"],
        [0.85, "#dc2626"],
        [1.0, "#991b1b"]
      ]
      : [
        [0.0, "#064e3b"],
        [0.25, "#047857"],
        [0.55, "#d97706"],
        [0.85, "#dc2626"],
        [1.0, "#f43f5e"]
      ];
  }

  const trace = {
    type: "choropleth",
    locationmode: "USA-states",
    locations: locations,
    z: zValues,
    customdata: customDataList,
    hovertemplate: "%{customdata}<extra></extra>",
    hoverlabel: {
      bgcolor: isLight ? "#eee8d5" : "#1e1d1a",
      bordercolor: isLight ? "rgba(101, 123, 131, 0.35)" : "rgba(255, 248, 240, 0.22)",
      font: {
        family: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
        color: isLight ? "#073642" : "#f6f4ee",
        size: 11,
      },
      align: "left",
    },
    colorscale: colorscale,
    zmin: zmin,
    zmax: zmax,
    zmid: zmid,
    marker: {
      line: {
        color: isLight ? "rgba(101, 123, 131, 0.35)" : "rgba(255, 248, 240, 0.2)",
        width: 1,
      },
    },
    colorbar: {
      title: {
        text: colorbarTitle,
        side: "top",
        font: { family: "Inter, sans-serif", size: 11, color: isLight ? "#073642" : "#a8a29e" },
      },
      tickfont: { family: "JetBrains Mono, monospace", size: 10, color: isLight ? "#586e75" : "#a8a29e" },
      ticksuffix: ticksuffix,
      bgcolor: isLight ? "rgba(238, 232, 213, 0.9)" : "rgba(24, 23, 21, 0.85)",
      bordercolor: isLight ? "rgba(101, 123, 131, 0.25)" : "rgba(255, 248, 240, 0.1)",
      thickness: 14,
      len: 0.72,
      x: 0.98,
      xanchor: "right",
      y: 0.5,
      yanchor: "middle",
    },
  };

  drawSpatialChoropleth(trace, isLight);

  const h0Notice = document.getElementById("spatial-h0-notice");
  if (h0Notice) {
    if (layer === "trend" && h === 0) {
      h0Notice.classList.remove("hidden");
    } else {
      h0Notice.classList.add("hidden");
    }
  }
}

// ----------------------------------------------------------------------------
// Season peak layers: when each state is forecast to peak, and how high (per 100k)
// ----------------------------------------------------------------------------

const PEAK_LAYERS = new Set(["peak_week", "peak_size"]);
const peakMapGuard = createRequestGuard();

function peakMapKey() {
  return `${state.selectedTarget}|${state.selectedDate}|${state.spatialActiveModel}`;
}

async function loadPeakMap() {
  const key = peakMapKey();
  const request = peakMapGuard.start();
  try {
    const data = await fetchPeakMap({
      target: state.selectedTarget, date: state.selectedDate, model: state.spatialActiveModel, signal: request.signal,
    });
    if (!request.isCurrent()) return;
    state.spatialPeakData = { key, data };
    if (PEAK_LAYERS.has(state.spatialActiveLayer)) renderSpatialMap();
  } catch (err) {
    if (err.name !== "AbortError") setFetchError("spatial-map-plot", `Could not load peak forecasts for the map (${err.message}).`);
  }
}

const PEAK_WEEK_SCALE = {
  dark: [[0, "#2dd4bf"], [0.3, "#38bdf8"], [0.55, "#818cf8"], [0.78, "#c084fc"], [1, "#fb7185"]],
  light: [[0, "#0d9488"], [0.3, "#0284c7"], [0.55, "#4f46e5"], [0.78, "#9333ea"], [1, "#e11d48"]],
};

function renderPeakLayer(isLight) {
  const layer = state.spatialActiveLayer;
  const mid = state.spatialActiveModel;
  const cached = state.spatialPeakData;
  if (mid && (!cached || cached.key !== peakMapKey())) {
    loadPeakMap();
    if (!cached) return;
  }
  const data = cached && cached.key === peakMapKey() ? cached.data : null;
  const byLoc = data?.locations || {};
  const win = data?.window || [state.selectedDate, state.selectedDate];
  const w0 = Date.parse(`${win[0]}T00:00:00Z`);
  const daysFrom = (d) => (Date.parse(`${d}T00:00:00Z`) - w0) / 86400000;
  const muted = isLight ? "#586e75" : "#94a3b8";

  const locations = [];
  const z = [];
  const tips = [];
  (state.locations || []).forEach((loc) => {
    const abbr = loc.abbreviation;
    if (!abbr || loc.id === "US" || abbr === "PR" || abbr.length !== 2) return;
    const p = byLoc[loc.id];
    locations.push(abbr);
    let val = null;
    if (p && layer === "peak_week" && p.timing) val = daysFrom(p.timing.median);
    if (p && layer === "peak_size" && p.size_per_100k !== null && p.size_per_100k !== undefined) val = p.size_per_100k;
    z.push(val);
    const lines = [`<b>${loc.name} (${abbr})</b>`];
    if (!p) {
      lines.push(`<span style="color:${muted}">No peak forecast from this model</span>`);
    } else {
      if (p.timing) {
        lines.push(`Peak week ${fmtWeek(p.timing.median)} <span style="color:${muted}">· 50% ${fmtWeek(p.timing.i50[0])} – ${fmtWeek(p.timing.i50[1])}</span>`);
        lines.push(`<span style="color:${muted}">Most likely ${fmtWeek(p.timing.mode)} (${Math.round(p.timing.mode_prob * 100)}%) · already past ${Math.round((p.timing.p_passed || 0) * 100)}%</span>`);
      }
      if (p.size) {
        const rate = p.size_per_100k !== null && p.size_per_100k !== undefined ? ` (${p.size_per_100k.toFixed(1)} / 100k)` : "";
        lines.push(`Peak size ${fmtCount(p.size.median)}${rate} <span style="color:${muted}">· 90% ${fmtCount(p.size.i90[0])} – ${fmtCount(p.size.i90[1])}</span>`);
      }
      if (p.observed) {
        lines.push(`<span style="color:${muted}">${p.observed.final ? "Observed peak" : "Peak so far"}: ${fmtCount(p.observed.value)} · ${fmtWeek(p.observed.date)}</span>`);
      }
    }
    tips.push(lines.join("<br>"));
  });

  const vals = z.filter((v) => v !== null);
  const span = Math.max(7, daysFrom(win[1]));
  let colorbar;
  let colorscale;
  let zmin = 0;
  let zmax;
  if (layer === "peak_week") {
    colorscale = isLight ? PEAK_WEEK_SCALE.light : PEAK_WEEK_SCALE.dark;
    // Fit the scale to the states' medians (±2 weeks) so early vs late states separate clearly
    zmin = vals.length ? Math.max(0, Math.min(...vals) - 14) : 0;
    zmax = vals.length ? Math.min(span, Math.max(...vals) + 14) : span;
    if (zmax - zmin < 28) zmax = zmin + 28;
    const tickvals = [];
    const ticktext = [];
    const days = [1, 15];
    const d = new Date(w0 + zmin * 86400000);
    d.setUTCDate(1);
    while (d.getTime() <= w0 + zmax * 86400000) {
      days.forEach((day) => {
        const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day);
        const v = (t - w0) / 86400000;
        if (v >= zmin && v <= zmax && (zmax - zmin <= 120 || day === 1)) {
          tickvals.push(v);
          ticktext.push(new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }));
        }
      });
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    colorbar = { title: { text: "Peak week (median)" }, tickvals, ticktext };
  } else {
    colorscale = isLight
      ? [[0, "#fdf6e3"], [0.15, "#bae6fd"], [0.35, "#38bdf8"], [0.65, "#0284c7"], [0.85, "#e11d48"], [1, "#881337"]]
      : [[0, "#131211"], [0.15, "#121e33"], [0.35, "#0369a1"], [0.65, "#38bdf8"], [0.85, "#fb7185"], [1, "#fda4af"]];
    zmax = vals.length ? Math.ceil(Math.max(...vals) * 1.05 * 10) / 10 : 10;
    colorbar = { title: { text: "Peak size / 100k" } };
  }

  const trace = {
    type: "choropleth",
    locationmode: "USA-states",
    locations,
    z,
    customdata: tips,
    hovertemplate: "%{customdata}<extra></extra>",
    hoverlabel: {
      bgcolor: isLight ? "#eee8d5" : "#1e1d1a",
      bordercolor: isLight ? "rgba(101, 123, 131, 0.35)" : "rgba(255, 248, 240, 0.22)",
      font: { family: "Inter, -apple-system, BlinkMacSystemFont, sans-serif", color: isLight ? "#073642" : "#f6f4ee", size: 11 },
      align: "left",
    },
    colorscale,
    zmin,
    zmax,
    marker: { line: { color: isLight ? "rgba(101, 123, 131, 0.35)" : "rgba(255, 248, 240, 0.2)", width: 1 } },
    colorbar: {
      ...colorbar,
      title: { ...colorbar.title, side: "top", font: { family: "Inter, sans-serif", size: 11, color: isLight ? "#073642" : "#a8a29e" } },
      tickfont: { family: "JetBrains Mono, monospace", size: 10, color: isLight ? "#586e75" : "#a8a29e" },
      bgcolor: isLight ? "rgba(238, 232, 213, 0.9)" : "rgba(24, 23, 21, 0.85)",
      bordercolor: isLight ? "rgba(101, 123, 131, 0.25)" : "rgba(255, 248, 240, 0.1)",
      thickness: 14, len: 0.72, x: 0.98, xanchor: "right", y: 0.5, yanchor: "middle",
    },
  };
  const note = data && vals.length === 0
    ? `${mid} has no ${layer === "peak_week" ? "peak-week" : "peak-size"} forecasts for the round of ${state.selectedDate}`
    : null;
  drawSpatialChoropleth(trace, isLight, note);
}

function drawSpatialChoropleth(trace, isLight, note = null) {
  const isPres = document.body.classList.contains("presentation-mode");
  const layout = {
    geo: {
      scope: "usa",
      projection: { type: "albers usa" },
      showlakes: true,
      lakecolor: isLight ? "#fdf6e3" : "#131211",
      bgcolor: isLight ? "#fdf6e3" : "#131211",
      subunitcolor: isLight ? "rgba(101, 123, 131, 0.3)" : "rgba(255, 248, 240, 0.18)",
      countrycolor: isLight ? "rgba(101, 123, 131, 0.5)" : "rgba(255, 248, 240, 0.28)",
      showland: true,
      landcolor: isLight ? "#eee8d5" : "#1e1d1a",
    },
    paper_bgcolor: isLight ? "#fdf6e3" : "#131211",
    plot_bgcolor: isLight ? "#fdf6e3" : "#131211",
    margin: isPres ? { t: 8, b: 8, l: 8, r: 75 } : { t: 10, b: 10, l: 10, r: 85 },
    dragmode: false,
    annotations: note ? [{
      xref: "paper", yref: "paper", x: 0.45, y: 0.5, showarrow: false, text: note,
      font: { family: "Inter, sans-serif", size: 12, color: isLight ? "#586e75" : "#94a3b8" },
      bgcolor: isLight ? "rgba(253, 246, 227, 0.92)" : "rgba(19, 18, 17, 0.92)",
      bordercolor: isLight ? "rgba(101, 123, 131, 0.25)" : "rgba(255, 255, 255, 0.08)", borderwidth: 1, borderpad: 8,
    }] : [],
  };

  const config = {
    responsive: true,
    displayModeBar: false,
    scrollZoom: false,
  };

  Plotly.react("spatial-map-plot", [trace], layout, config)
    .then((gd) => {
      if (gd && gd.on && !gd._hasClickListener) {
        gd.on("plotly_click", (data) => {
          if (!data || !data.points || data.points.length === 0) return;
          const pt = data.points[0];
          const abbr = pt.location;
          if (!abbr) return;
          state.spatialSelectedState = abbr;
          const spatialInspectorPanel = document.getElementById("spatial-inspector-panel");
          if (spatialInspectorPanel && spatialInspectorPanel.classList.contains("collapsed")) {
            toggleSpatialInspector(true);
          } else {
            updateSpatialInspector();
          }
        });
        gd._hasClickListener = true;
      }
      setTimeout(() => {
        Plotly.Plots.resize("spatial-map-plot");
      }, 35);
    })
    .catch((err) => {
      console.error("Plotly spatial rendering error:", err);
    });
}

export function updateSpatialInspector() {
  const spatialInspectorPanel = document.getElementById("spatial-inspector-panel");
  if (!spatialInspectorPanel) return;
  if (!state.spatialData || !state.spatialData.states) return;

  const inspStateCode = document.getElementById("insp-state-code");
  const inspStateName = document.getElementById("insp-state-name");
  const inspStatePop = document.getElementById("insp-state-pop");
  const inspValAdmissions = document.getElementById("insp-val-admissions");
  const inspValInterval = document.getElementById("insp-val-interval");
  const inspValTruth = document.getElementById("insp-val-truth");
  const inspValTruthSub = document.getElementById("insp-val-truth-sub");
  const inspValRate = document.getElementById("insp-val-rate");
  const inspValTrend = document.getElementById("insp-val-trend");
  const inspValTrendSub = document.getElementById("insp-val-trend-sub");
  const inspValWis = document.getElementById("insp-val-wis");
  const inspWisBadge = document.getElementById("insp-wis-badge");
  const inspWisDesc = document.getElementById("insp-wis-desc");

  let abbr = state.spatialSelectedState;
  if (!abbr || !state.spatialData.states[abbr]) {
    let maxRate = -1;
    let maxAbbr = "CA";
    for (const [st, info] of Object.entries(state.spatialData.states)) {
      const mData = info.models[state.spatialActiveModel]?.[state.spatialActiveHorizon];
      if (mData && mData.rate_per_100k !== null && mData.rate_per_100k > maxRate) {
        maxRate = mData.rate_per_100k;
        maxAbbr = st;
      }
    }
    abbr = maxAbbr;
    state.spatialSelectedState = abbr;
  }

  const stObj = state.spatialData.states[abbr];
  if (!stObj) return;

  const h = state.spatialActiveHorizon;
  const mData = stObj.models[state.spatialActiveModel]?.[h];
  const targetEndDate = state.spatialData.dates_by_horizon?.[h] || "";

  if (inspStateCode) inspStateCode.textContent = abbr;
  if (inspStateName) inspStateName.textContent = stObj.name;
  if (inspStatePop) {
    inspStatePop.textContent = stObj.population
      ? `${stObj.population.toLocaleString()} residents · Horizon h=${h}`
      : `Horizon h=${h}`;
  }

  if (mData) {
    if (inspValAdmissions) {
      inspValAdmissions.textContent = mData.median !== null ? Math.round(mData.median).toLocaleString() : "--";
    }
    if (inspValInterval) {
      if (mData.q025 !== null && mData.q975 !== null) {
        inspValInterval.textContent = `95% PI: [${Math.round(mData.q025).toLocaleString()} – ${Math.round(mData.q975).toLocaleString()}]`;
      } else {
        inspValInterval.textContent = "95% PI: [-- – --]";
      }
    }

    const truthVal = stObj.truth?.[targetEndDate];
    if (inspValTruth) {
      if (truthVal !== undefined && truthVal !== null) {
        inspValTruth.textContent = Math.round(truthVal).toLocaleString();
        inspValTruth.style.color = "var(--text-primary)";
        if (inspValTruthSub) inspValTruthSub.textContent = "Observed truth";
      } else {
        inspValTruth.textContent = "Pending";
        inspValTruth.style.color = "var(--text-muted)";
        if (inspValTruthSub) inspValTruthSub.textContent = "Pending truth";
      }
    }

    if (inspValRate) {
      inspValRate.textContent = mData.rate_per_100k !== null ? `${mData.rate_per_100k.toFixed(2)}` : "--";
    }

    if (inspValTrend) {
      if (mData.trend_pct !== null && h > 0) {
        const sign = mData.trend_pct > 0 ? "+" : "";
        const arrow = mData.trend_pct > 0 ? "▲" : mData.trend_pct < 0 ? "▼" : "▶";
        inspValTrend.textContent = `${arrow} ${sign}${mData.trend_pct.toFixed(1)}%`;
        inspValTrend.style.color = mData.trend_pct > 0 ? "var(--pastel-coral)" : mData.trend_pct < 0 ? "var(--pastel-mint)" : "var(--text-primary)";
      } else {
        inspValTrend.textContent = h === 0 ? "0.0% (Anchor)" : "--";
        inspValTrend.style.color = "var(--text-primary)";
      }
    }
    if (inspValTrendSub) {
      inspValTrendSub.textContent = h === 0 ? "Nowcast anchor" : "vs Nowcast (h=0)";
    }

    if (inspValWis) {
      if (mData.wis !== null) {
        inspValWis.textContent = mData.wis.toFixed(2);
        inspValWis.className = "insp-metric-val highlight-amber";
      } else {
        inspValWis.textContent = "--";
        inspValWis.className = "insp-metric-val";
      }
    }

    if (inspWisBadge && inspWisDesc) {
      if (mData.wis !== null && truthVal !== undefined && truthVal !== null) {
        if (mData.q025 !== null && mData.q975 !== null && truthVal >= mData.q025 && truthVal <= mData.q975) {
          inspWisBadge.textContent = "Within 95% PI";
          inspWisBadge.className = "badge-micro badge-covered";
          inspWisDesc.textContent = "Observed within 95% corridor";
        } else {
          inspWisBadge.textContent = "Interval Miss";
          inspWisBadge.className = "badge-micro badge-missed";
          inspWisDesc.textContent = (mData.q025 !== null && truthVal < mData.q025) ? "Overpredicted outcome" : "Underpredicted outcome";
        }
      } else {
        inspWisBadge.textContent = "Unscored";
        inspWisBadge.className = "badge-micro";
        inspWisDesc.textContent = "Awaiting NHSN observations";
      }
    }
  } else {
    if (inspValAdmissions) inspValAdmissions.textContent = "--";
    if (inspValInterval) inspValInterval.textContent = "95% PI: [-- – --]";
    if (inspValTruth) inspValTruth.textContent = "--";
    if (inspValRate) inspValRate.textContent = "--";
    if (inspValTrend) inspValTrend.textContent = "--";
    if (inspValWis) inspValWis.textContent = "--";
    if (inspWisBadge) {
      inspWisBadge.textContent = "Pending";
      inspWisBadge.className = "badge-micro";
    }
    if (inspWisDesc) inspWisDesc.textContent = "Awaiting model data";
  }
}

export function toggleSpatialInspector(forceState) {
  const spatialInspectorPanel = document.getElementById("spatial-inspector-panel");
  const btnExpandInspector = document.getElementById("btn-expand-inspector");
  const spatialMapPlot = document.getElementById("spatial-map-plot");
  if (!spatialInspectorPanel) return;

  const isCurrentlyCollapsed = spatialInspectorPanel.classList.contains("collapsed");
  const willBeCollapsed = typeof forceState === "boolean" ? !forceState : !isCurrentlyCollapsed;

  spatialInspectorPanel.classList.toggle("collapsed", willBeCollapsed);
  if (btnExpandInspector) {
    btnExpandInspector.classList.toggle("hidden", !willBeCollapsed);
  }
  const workspaceLayout = document.querySelector(".spatial-workspace-layout");
  if (workspaceLayout) {
    workspaceLayout.classList.toggle("inspector-collapsed", willBeCollapsed);
  }

  if (btnExpandInspector) {
    const railText = document.getElementById("rail-state-text");
    if (railText) {
      railText.textContent = state.spatialSelectedState
        ? `${state.spatialSelectedState} Inspector`
        : "State Inspector";
    }
  }

  setTimeout(() => {
    if (spatialMapPlot) {
      Plotly.Plots.resize("spatial-map-plot");
    }
  }, 40);
}

export function resetSpatialInspector() {
  state.spatialSelectedState = null;
  updateSpatialInspector();
}

export function jumpToStateTimeline(onJumpCallback) {
  if (!state.spatialSelectedState || !state.spatialData) return;
  const stateObj = state.spatialData.states[state.spatialSelectedState];
  if (!stateObj) return;

  const fips = stateObj.fips;
  state.selectedLocation = fips;
  const locationSelect = document.getElementById("location-select");
  if (locationSelect) locationSelect.value = fips;
  document.querySelectorAll("#quick-loc-segmented .segment-btn").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-loc") === fips);
  });

  if (onJumpCallback) {
    onJumpCallback(fips);
  }
}

export function updateSpatialInsights() {
  if (!state.spatialData || !state.spatialData.states) return;

  const insightTopRate = document.getElementById("insight-top-rate");
  const insightTopRateSub = document.getElementById("insight-top-rate-sub");
  const insightTopSurge = document.getElementById("insight-top-surge");
  const insightTopSurgeSub = document.getElementById("insight-top-surge-sub");
  const insightNationalSum = document.getElementById("insight-national-sum");
  const insightNationalSumSub = document.getElementById("insight-national-sum-sub");
  const insightSpreadStatus = document.getElementById("insight-spread-status");
  const insightSpreadSub = document.getElementById("insight-spread-sub");

  const h = state.spatialActiveHorizon;
  const mid = state.spatialActiveModel;
  let maxRate = -1;
  let maxRateState = null;
  let maxSurge = -999;
  let maxSurgeState = null;
  let totalAdmissions = 0;
  let risingCount = 0;
  let fallingCount = 0;
  let flatCount = 0;
  let totalStatesEvaluated = 0;

  for (const [abbr, stObj] of Object.entries(state.spatialData.states)) {
    const mData = stObj.models[mid]?.[h];
    if (!mData) continue;
    totalStatesEvaluated++;

    if (mData.median !== null) {
      totalAdmissions += mData.median;
    }

    if (mData.rate_per_100k !== null && mData.rate_per_100k > maxRate) {
      maxRate = mData.rate_per_100k;
      maxRateState = { abbr, name: stObj.name, rate: mData.rate_per_100k };
    }

    if (mData.trend_pct !== null) {
      if (mData.trend_pct > maxSurge) {
        maxSurge = mData.trend_pct;
        maxSurgeState = { abbr, name: stObj.name, surge: mData.trend_pct };
      }
      if (mData.trend_pct > 5) risingCount++;
      else if (mData.trend_pct < -5) fallingCount++;
      else flatCount++;
    }
  }

  if (insightTopRate) {
    if (maxRateState) {
      insightTopRate.textContent = `${maxRateState.abbr}: ${maxRateState.rate.toFixed(2)}`;
      if (insightTopRateSub) insightTopRateSub.textContent = `${maxRateState.name} · per 100k residents`;
    } else {
      insightTopRate.textContent = "--";
      if (insightTopRateSub) insightTopRateSub.textContent = "Admissions per 100k";
    }
  }

  if (insightTopSurge) {
    if (maxSurgeState && maxSurge > 0) {
      insightTopSurge.textContent = `${maxSurgeState.abbr}: +${maxSurgeState.surge.toFixed(1)}%`;
      if (insightTopSurgeSub) insightTopSurgeSub.textContent = `${maxSurgeState.name} · fastest accelerating`;
    } else {
      insightTopSurge.textContent = "Flat / Decelerating";
      if (insightTopSurgeSub) insightTopSurgeSub.textContent = "No states surging > 0%";
    }
  }

  if (insightNationalSum) {
    if (totalAdmissions > 0) {
      insightNationalSum.textContent = Math.round(totalAdmissions).toLocaleString();
      if (insightNationalSumSub) insightNationalSumSub.textContent = `Sum across ${totalStatesEvaluated} states & territories`;
    } else {
      insightNationalSum.textContent = "--";
      if (insightNationalSumSub) insightNationalSumSub.textContent = "Sum of state medians";
    }
  }

  if (insightSpreadStatus) {
    if (risingCount > 0 || fallingCount > 0) {
      if (risingCount > fallingCount * 1.5) {
        insightSpreadStatus.textContent = `Surge (${risingCount} Rising)`;
        insightSpreadStatus.style.color = "var(--pastel-coral)";
      } else if (fallingCount > risingCount * 1.5) {
        insightSpreadStatus.textContent = `Receding (${fallingCount} Falling)`;
        insightSpreadStatus.style.color = "var(--pastel-mint)";
      } else {
        insightSpreadStatus.textContent = `Plateau / Mixed`;
        insightSpreadStatus.style.color = "var(--pastel-sky)";
      }
      if (insightSpreadSub) {
        insightSpreadSub.textContent = `${risingCount} rising · ${fallingCount} falling · ${flatCount} steady`;
      }
    } else {
      insightSpreadStatus.textContent = "Nowcast Baseline";
      insightSpreadStatus.style.color = "var(--text-primary)";
      if (insightSpreadSub) insightSpreadSub.textContent = "Trajectory starts at Horizon 0";
    }
  }
}

export function toggleSpatialPlayback(onTick) {
  if (state.spatialPlayInterval) {
    stopSpatialPlayback();
  } else {
    startSpatialPlayback(onTick);
  }
}

export function startSpatialPlayback(onTick) {
  const btnSpatialPlay = document.getElementById("btn-spatial-play");
  const spatialPlayIcon = document.getElementById("spatial-play-icon");
  const spatialPlayText = document.getElementById("spatial-play-text");
  const spatialHorizonSegmented = document.getElementById("spatial-horizon-segmented");

  if (state.spatialPlayInterval) clearInterval(state.spatialPlayInterval);
  if (btnSpatialPlay) {
    btnSpatialPlay.classList.add("playing");
    if (spatialPlayIcon) spatialPlayIcon.innerHTML = ICONS.pause;
    if (spatialPlayText) spatialPlayText.textContent = "Pause";
  }

  state.spatialPlayInterval = setInterval(() => {
    state.spatialActiveHorizon = (state.spatialActiveHorizon + 1) % 4;

    if (spatialHorizonSegmented) {
      spatialHorizonSegmented.querySelectorAll(".segment-btn").forEach((b) => {
        b.classList.toggle("active", parseInt(b.getAttribute("data-h"), 10) === state.spatialActiveHorizon);
      });
    }

    renderSpatialMap();
    updateSpatialInspector();
    updateSpatialInsights();
    if (onTick) onTick();
  }, 1200);
}

export function stopSpatialPlayback() {
  const btnSpatialPlay = document.getElementById("btn-spatial-play");
  const spatialPlayIcon = document.getElementById("spatial-play-icon");
  const spatialPlayText = document.getElementById("spatial-play-text");

  if (state.spatialPlayInterval) {
    clearInterval(state.spatialPlayInterval);
    state.spatialPlayInterval = null;
  }
  if (btnSpatialPlay) {
    btnSpatialPlay.classList.remove("playing");
    if (spatialPlayIcon) spatialPlayIcon.innerHTML = ICONS.play;
    if (spatialPlayText) spatialPlayText.textContent = "Play";
  }
}
