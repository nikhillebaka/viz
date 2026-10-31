/**
 * FluSight Sandbox Lab — Heatmap View Component
 * High-performance 2D heatmap visualizing surveillance signals, wave propagation,
 * and multi-model benchmarking across jurisdictions, dates, and horizons.
 * Fully interactive with direct user-selectable X and Y axes, Leaderboard-parity
 * time and location scopes, and responsive container-bounded Plotly canvas.
 */

import { ICONS, HHS_REGIONS, STATE_TO_HHS_REGION, HEATMAP_PALETTES, escapeHtml, bindDropdownMenu, modelLabel } from "../constants.js";
import { state, formatSeasonShort } from "../state.js";
import { fetchHeatmap, createRequestGuard } from "../api.js";
import { triggerPlotResizeSequence } from "./forecast_chart.js";

let heatmapCallbacks = {};

/**
 * Initialize all DOM event listeners for the Heatmap ribbon, controls, and inspector.
 */
export function initHeatmapEvents(callbacks = {}) {
  const displayBtn = document.getElementById("heatmap-display-btn");
  const displayMenu = document.getElementById("heatmap-display-menu");
  if (displayBtn && displayMenu) bindDropdownMenu(displayBtn, displayMenu);

  heatmapCallbacks = callbacks;

  const rowsSelect = document.getElementById("heatmap-rows-select");
  const colsSelect = document.getElementById("heatmap-cols-select");
  const swapAxesBtn = document.getElementById("heatmap-swap-axes-btn");
  const modelSelect = document.getElementById("heatmap-model-select");
  const metricSelect = document.getElementById("heatmap-metric-select");
  const sortSelect = document.getElementById("heatmap-sort-select");
  const normSelect = document.getElementById("heatmap-norm-select");
  const paletteSelect = document.getElementById("heatmap-palette-select");
  const reversePaletteBtn = document.getElementById("heatmap-reverse-palette-btn");
  const toggleInspectorBtn = document.getElementById("btn-toggle-heatmap-inspector");
  const expandInspectorBtn = document.getElementById("btn-expand-heatmap-inspector");

  // 1. Direct Axis: ROWS (Y-Axis)
  if (rowsSelect) {
    rowsSelect.value = state.heatmapRows || "location";
    rowsSelect.addEventListener("change", (e) => {
      state.heatmapRows = e.target.value;
      populateHeatmapColsOptions();
      updateMetricDropdownOptions();
      updateSortDropdownOptions();
      updateToolbarVisibility();
      if (callbacks.onUrlUpdate) callbacks.onUrlUpdate();
      fetchAndRenderHeatmap(callbacks);
    });
  }

  // 2. Direct Axis: COLS (X-Axis)
  if (colsSelect) {
    populateHeatmapColsOptions();
    colsSelect.addEventListener("change", (e) => {
      state.heatmapCols = e.target.value;
      updateMetricDropdownOptions();
      updateSortDropdownOptions();
      updateToolbarVisibility();
      if (callbacks.onUrlUpdate) callbacks.onUrlUpdate();
      fetchAndRenderHeatmap(callbacks);
    });
  }

  // 3. Swap Axes Button (⇄)
  if (swapAxesBtn) {
    swapAxesBtn.addEventListener("click", () => {
      const prevRows = state.heatmapRows || "location";
      const prevCols = state.heatmapCols || "date";
      state.heatmapRows = prevCols;
      state.heatmapCols = prevRows;

      if (rowsSelect) rowsSelect.value = state.heatmapRows;
      populateHeatmapColsOptions();
      if (colsSelect) colsSelect.value = state.heatmapCols;

      updateMetricDropdownOptions();
      updateSortDropdownOptions();
      updateToolbarVisibility();
      if (callbacks.onUrlUpdate) callbacks.onUrlUpdate();
      fetchAndRenderHeatmap(callbacks);
    });
  }

  // 4. LOC Scope: All States vs Current Location
  document.querySelectorAll("#heatmap-horizon-segmented .segment-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.heatmapActiveHorizon = parseInt(btn.getAttribute("data-h"), 10);
      if (callbacks.onUrlUpdate) callbacks.onUrlUpdate();
      fetchAndRenderHeatmap(callbacks);
    });
  });

  document.querySelectorAll("#heatmap-loc-segmented .segment-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#heatmap-loc-segmented .segment-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.heatmapLocScope = btn.getAttribute("data-loc") || "states";
      if (callbacks.onUrlUpdate) callbacks.onUrlUpdate();
      fetchAndRenderHeatmap(callbacks);
    });
  });

  // 5. TIME Scope: Date, Season, Seasons ▾, All Time
  document.querySelectorAll("#heatmap-time-segmented .segment-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const timeScope = btn.getAttribute("data-time");
      if (timeScope === "custom") {
        e.stopPropagation();
        const menu = document.getElementById("hm-season-dropdown-menu");
        if (menu) menu.classList.toggle("open");
        return;
      }

      // Close custom menu if open
      const menu = document.getElementById("hm-season-dropdown-menu");
      if (menu) menu.classList.remove("open");

      document.querySelectorAll("#heatmap-time-segmented .segment-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.heatmapTimeScope = timeScope || "season";
      if (callbacks.onUrlUpdate) callbacks.onUrlUpdate();
      fetchAndRenderHeatmap(callbacks);
    });
  });

  // Custom Seasons Checklist Select All
  const btnSelectAll = document.getElementById("btn-hm-season-select-all");
  if (btnSelectAll) {
    btnSelectAll.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".hm-season-cb").forEach((cb) => (cb.checked = true));
    });
  }

  // Custom Seasons Checklist Apply
  const btnApplySeasons = document.getElementById("btn-hm-season-apply");
  if (btnApplySeasons) {
    btnApplySeasons.addEventListener("click", (e) => {
      e.stopPropagation();
      const checkedBoxes = Array.from(document.querySelectorAll(".hm-season-cb:checked"));
      const selected = checkedBoxes.map((cb) => cb.value);
      if (selected.length === 0) {
        selected.push(state.evalFocalSeason || state.latestSeason || "2024-2025");
      }
      state.heatmapSelectedSeasons = new Set(selected);

      const menu = document.getElementById("hm-season-dropdown-menu");
      if (menu) menu.classList.remove("open");

      const customBtn = document.getElementById("btn-hm-custom-season");
      if (customBtn) {
        customBtn.textContent = selected.length === 1 ? `${formatSeasonShort(selected[0])} ▾` : `${selected.length} Seasons ▾`;
      }

      document.querySelectorAll("#heatmap-time-segmented .segment-btn").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-time") === "custom");
      });
      state.heatmapTimeScope = "custom";
      if (callbacks.onUrlUpdate) callbacks.onUrlUpdate();
      fetchAndRenderHeatmap(callbacks);
    });
  }

  // Outside click to close custom seasons menu
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("hm-season-dropdown-menu");
    const customBtn = document.getElementById("btn-hm-custom-season");
    if (menu && menu.classList.contains("open")) {
      if (!menu.contains(e.target) && !customBtn?.contains(e.target)) {
        menu.classList.remove("open");
      }
    }
  });

  // 6. Contextual Model Selector (when Model is not an axis)
  if (modelSelect) {
    modelSelect.addEventListener("change", (e) => {
      state.heatmapActiveModel = e.target.value || "truth";
      updateMetricDropdownOptions();
      if (callbacks.onUrlUpdate) callbacks.onUrlUpdate();
      fetchAndRenderHeatmap(callbacks);
    });
  }

  // 7. Cell Metric Selector
  if (metricSelect) {
    metricSelect.addEventListener("change", (e) => {
      state.heatmapMetric = e.target.value;
      if (callbacks.onUrlUpdate) callbacks.onUrlUpdate();
      fetchAndRenderHeatmap(callbacks);
    });
  }

  // 8. Row Sort Selector
  if (sortSelect) {
    sortSelect.addEventListener("change", (e) => {
      state.heatmapSortBy = e.target.value;
      if (callbacks.onUrlUpdate) callbacks.onUrlUpdate();
      fetchAndRenderHeatmap(callbacks);
    });
  }

  // 9. Row Normalization Selector (Scale)
  if (normSelect) {
    normSelect.addEventListener("change", (e) => {
      state.heatmapNormalize = e.target.value;
      if (callbacks.onUrlUpdate) callbacks.onUrlUpdate();
      fetchAndRenderHeatmap(callbacks);
    });
  }

  // 10. Palette Selector
  if (paletteSelect) {
    populatePaletteSelect(paletteSelect);
    paletteSelect.addEventListener("change", (e) => {
      state.heatmapPalette = e.target.value;
      renderHeatmapPlot();
    });
  }

  // 11. Invert Palette Button
  if (reversePaletteBtn) {
    reversePaletteBtn.classList.toggle("active", Boolean(state.heatmapReversePalette));
    reversePaletteBtn.addEventListener("click", () => {
      state.heatmapReversePalette = !state.heatmapReversePalette;
      reversePaletteBtn.classList.toggle("active", state.heatmapReversePalette);
      renderHeatmapPlot();
    });
  }

  // 12. Inspector Toggle Buttons
  if (toggleInspectorBtn) {
    toggleInspectorBtn.addEventListener("click", () => toggleHeatmapInspector(false));
  }

  if (expandInspectorBtn) {
    expandInspectorBtn.addEventListener("click", () => toggleHeatmapInspector(true));
  }

  // 13. Cross-Navigation Jump Buttons
  const jumpTimelineBtn = document.getElementById("btn-hm-jump-timeline");
  if (jumpTimelineBtn) {
    jumpTimelineBtn.addEventListener("click", () => jumpToTimelineFromHeatmap(callbacks));
  }

  const jumpSpatialBtn = document.getElementById("btn-hm-jump-spatial");
  if (jumpSpatialBtn) {
    jumpSpatialBtn.addEventListener("click", () => jumpToSpatialFromHeatmap(callbacks));
  }

  // 14. Non-Reporting Inactive Models Tray Event Handlers
  const btnToggleInactiveInPlot = document.getElementById("btn-toggle-inactive-in-plot");
  if (btnToggleInactiveInPlot) {
    btnToggleInactiveInPlot.addEventListener("click", () => {
      state.heatmapIncludeInactive = !state.heatmapIncludeInactive;
      fetchAndRenderHeatmap(heatmapCallbacks);
    });
  }

  const btnCollapseInactiveTray = document.getElementById("btn-collapse-inactive-tray");
  if (btnCollapseInactiveTray) {
    btnCollapseInactiveTray.addEventListener("click", () => {
      const chipsEl = document.getElementById("hm-inactive-chips-container");
      const labelEl = document.getElementById("label-collapse-inactive-tray");
      if (chipsEl) {
        const isCollapsed = chipsEl.classList.toggle("collapsed");
        if (labelEl) {
          labelEl.textContent = isCollapsed
            ? `Show List (${state.heatmapData?.inactive_models?.length || 0})`
            : "Hide List";
        }
      }
    });
  }

  // 15. Window Resize Handler
  window.addEventListener("resize", () => {
    if (state.currentView === "heatmap") {
      triggerPlotResizeSequence("heatmap-plot");
      drawInspectorSparkline();
    }
  });
}

/**
 * Dynamically populate column choices based on the active row selection.
 */
export function populateHeatmapColsOptions() {
  const colsSelect = document.getElementById("heatmap-cols-select");
  if (!colsSelect) return;

  const currentRows = state.heatmapRows || "location";
  let allowedCols = [];

  if (currentRows === "location") {
    allowedCols = [
      { value: "date", label: "Date (Epidemic Wave)" },
      { value: "model", label: "Model (Performance by State)" },
    ];
  } else if (currentRows === "model") {
    allowedCols = [
      { value: "horizon", label: "Horizon (Lead Decay h=0..3)" },
      { value: "location", label: "Location (State Breakdown)" },
      { value: "date", label: "Date (Timeline Error)" },
    ];
  } else if (currentRows === "date") {
    allowedCols = [
      { value: "location", label: "Location (Epidemic Wave)" },
      { value: "model", label: "Model (Timeline Error)" },
    ];
  } else {
    // horizon
    allowedCols = [
      { value: "model", label: "Model (Lead Decay h=0..3)" },
    ];
  }

  colsSelect.innerHTML = "";
  allowedCols.forEach((opt) => {
    const el = document.createElement("option");
    el.value = opt.value;
    el.textContent = opt.label;
    colsSelect.appendChild(el);
  });

  if (allowedCols.some((c) => c.value === state.heatmapCols)) {
    colsSelect.value = state.heatmapCols;
  } else {
    state.heatmapCols = allowedCols[0].value;
    colsSelect.value = state.heatmapCols;
  }
}

/**
 * Populate the color palette dropdown.
 */
function populatePaletteSelect(selectEl) {
  if (!selectEl) return;
  selectEl.innerHTML = "";
  HEATMAP_PALETTES.forEach((pal) => {
    const opt = document.createElement("option");
    opt.value = pal.id;
    opt.textContent = pal.name;
    if (pal.id === state.heatmapPalette) opt.selected = true;
    selectEl.appendChild(opt);
  });
}

/**
 * Populate the custom multi-season checklist dropdown menu.
 */
export function populateHeatmapCustomSeasonsMenu() {
  const listEl = document.getElementById("hm-season-menu-list");
  if (!listEl) return;

  const seasons = (state.forecastSeasons && state.forecastSeasons.length > 0)
    ? state.forecastSeasons
    : (state.allSeasons && state.allSeasons.length > 0 ? state.allSeasons : ["2025-2026", "2024-2025", "2023-2024"]);

  const sorted = [...seasons].sort((a, b) => b.localeCompare(a));

  if (state.heatmapSelectedSeasons.size === 0) {
    sorted.forEach((s) => state.heatmapSelectedSeasons.add(s));
  }

  listEl.innerHTML = "";
  sorted.forEach((s) => {
    const isChecked = state.heatmapSelectedSeasons.has(s);
    const label = document.createElement("label");
    label.className = "season-checkbox-item";
    label.innerHTML = `
      <span class="season-checkbox-left">
        <input type="checkbox" value="${escapeHtml(s)}" class="hm-season-cb" ${isChecked ? "checked" : ""}>
        <span>${escapeHtml(s)} Season</span>
      </span>
    `;
    listEl.appendChild(label);
  });
}

/**
 * Update the Season (XX-XX) focal button text.
 */
export function updateHeatmapFocalSeasonButton() {
  const btn = document.getElementById("btn-hm-season");
  if (!btn) return;
  const s = state.evalFocalSeason || state.latestSeason || "2024-2025";
  const shortCode = formatSeasonShort(s);
  btn.textContent = `Season (${shortCode})`;
  btn.title = `Evaluate all rounds in the focal ${s} season`;
}

/**
 * Toggle visibility of contextual toolbar groups.
 */
export function updateToolbarVisibility() {
  const rows = state.heatmapRows || "location";
  const cols = state.heatmapCols || "date";
  const isModelAnAxis = (rows === "model" || cols === "model");

  // MODEL selector: Only shown when Model is NOT an axis
  const modelGroup = document.getElementById("heatmap-model-group");
  if (modelGroup) {
    modelGroup.classList.toggle("hidden", isModelAnAxis);
  }

  // HORIZON selector: Only Location x Date cells of a single model depend on one horizon
  const horizonGroup = document.getElementById("heatmap-horizon-group");
  const isWaveAxes = [rows, cols].includes("location") && [rows, cols].includes("date");
  const hasModel = Boolean(state.heatmapActiveModel) && state.heatmapActiveModel !== "truth";
  if (horizonGroup) {
    horizonGroup.classList.toggle("hidden", !(isWaveAxes && hasModel));
  }

  // SORT selector: Shown when rows is Location or Model
  const sortGroup = document.getElementById("heatmap-sort-group");
  const sortDivider = document.getElementById("heatmap-sort-divider");
  const canSort = (rows === "location" || rows === "model");
  if (sortGroup) sortGroup.classList.toggle("hidden", !canSort);
  if (sortDivider) sortDivider.classList.toggle("hidden", !canSort);

  // SCALE / Normalization: Shown when rows is Location or Model
  const normGroup = document.getElementById("heatmap-norm-group");
  const normDivider = document.getElementById("heatmap-norm-divider");
  if (normGroup) normGroup.classList.toggle("hidden", !canSort);
  if (normDivider) normDivider.classList.toggle("hidden", !canSort);
}

/**
 * Populate contextual model dropdown options.
 */
export function populateHeatmapModelSelect() {
  const modelSelect = document.getElementById("heatmap-model-select");
  if (!modelSelect) return;

  const currentVal = state.heatmapActiveModel || "truth";
  modelSelect.innerHTML = "";

  // Ground Truth Option
  const truthOpt = document.createElement("option");
  truthOpt.value = "truth";
  truthOpt.textContent = "Observed Ground Truth (CDC/NHSN)";
  modelSelect.appendChild(truthOpt);

  const candidateModels = state.selectedModels.size > 0
    ? Array.from(state.selectedModels)
    : Object.keys(state.models);

  candidateModels.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m;
    const meta = state.models[m];
    opt.textContent = meta?.source === "hub"
      ? modelLabel(m, meta, { withHub: true })
      : `${m} ${meta?.is_local ? "[LOCAL]" : ""}`.trim();
    modelSelect.appendChild(opt);
  });

  if (Array.from(modelSelect.options).some((o) => o.value === currentVal)) {
    modelSelect.value = currentVal;
  } else {
    modelSelect.value = "truth";
    state.heatmapActiveModel = "truth";
  }
}

/**
 * Update options in the metric dropdown according to active axes and model.
 */
export function updateMetricDropdownOptions() {
  const metricSelect = document.getElementById("heatmap-metric-select");
  if (!metricSelect) return;

  const rows = state.heatmapRows || "location";
  const cols = state.heatmapCols || "date";
  const isModelAnAxis = (rows === "model" || cols === "model");
  const isTruth = (!state.heatmapActiveModel || state.heatmapActiveModel === "truth");
  // Rate/proportion targets are already population-normalized, so per-100k views do not apply
  const isRateTarget = Boolean(state.targetsMeta?.[state.selectedTarget]?.is_rate);

  let options = [];

  if (isModelAnAxis) {
    options = [
      { value: "wis", label: "Weighted Interval Score (WIS)" },
      { value: "wis_rate", label: "Rate WIS / 100k (Standardized)" },
      { value: "mae", label: "Mean Absolute Error (MAE)" },
      { value: "cov95", label: "95% Interval Coverage (%)" },
      { value: "sharpness", label: "Sharpness (Interval Width)" },
    ];
    if (isRateTarget) options = options.filter((o) => o.value !== "wis_rate");
  } else if (isTruth) {
    options = [
      { value: "rate", label: "Rate / 100k (Incidence)" },
      { value: "count", label: "Admissions (Volume)" },
      { value: "trend", label: "Trend (% Weekly Change)" },
    ];
  } else {
    // Single model forecast view
    options = [
      { value: "rate", label: "Forecast Rate / 100k" },
      { value: "count", label: "Forecast Admissions (Volume)" },
      { value: "error", label: "Absolute Error (Forecast - Truth)" },
      { value: "wis", label: "WIS Error (Calibration)" },
    ];
  }
  if (isRateTarget && !isModelAnAxis) {
    const unit = state.targetsMeta[state.selectedTarget].unit || "Value";
    options = options
      .filter((o) => o.value !== "rate")
      .map((o) => (o.value === "count" ? { value: "count", label: `${isTruth ? "Observed" : "Forecast"} Value (${unit})` } : o));
  }

  metricSelect.innerHTML = "";
  options.forEach((opt) => {
    const el = document.createElement("option");
    el.value = opt.value;
    el.textContent = opt.label;
    if (opt.value === state.heatmapMetric) el.selected = true;
    metricSelect.appendChild(el);
  });

  if (!options.some((o) => o.value === state.heatmapMetric)) {
    state.heatmapMetric = options[0].value;
    metricSelect.value = state.heatmapMetric;
  }
}

/**
 * Update row sorting options according to row type.
 */
export function updateSortDropdownOptions() {
  const sortSelect = document.getElementById("heatmap-sort-select");
  if (!sortSelect) return;

  const rows = state.heatmapRows || "location";
  let options = [];

  if (rows === "location") {
    options = [
      { value: "hhs_region", label: "HHS Region (1–10 Geographical)" },
      { value: "peak_timing", label: "Peak Timing (Wave Cascade)" },
      { value: "magnitude", label: "Incidence Magnitude (Highest First)" },
      { value: "population", label: "Population (Largest First)" },
      { value: "alphabetical", label: "Alphabetical (A–Z)" },
    ];
  } else if (rows === "model") {
    options = [
      { value: "performance", label: "Best Performance (Lowest Mean WIS)" },
      { value: "alphabetical", label: "Alphabetical (A–Z)" },
    ];
  } else {
    options = [
      { value: "alphabetical", label: "Default Order" },
    ];
  }

  const currentVal = state.heatmapSortBy;
  sortSelect.innerHTML = "";
  options.forEach((opt) => {
    const el = document.createElement("option");
    el.value = opt.value;
    el.textContent = opt.label;
    if (opt.value === currentVal) el.selected = true;
    sortSelect.appendChild(el);
  });

  if (!options.some((o) => o.value === state.heatmapSortBy)) {
    state.heatmapSortBy = options[0].value;
    sortSelect.value = state.heatmapSortBy;
  }
}

/**
 * Fetch data and render heatmap view.
 */
const heatmapGuard = createRequestGuard();

export async function fetchAndRenderHeatmap(callbacks = {}) {
  const plotEl = document.getElementById("heatmap-plot");
  if (!plotEl) return;

  const request = heatmapGuard.start();
  showHeatmapLoading(true);

  // Sync toolbar controls
  populateHeatmapCustomSeasonsMenu();
  updateHeatmapFocalSeasonButton();
  populateHeatmapModelSelect();
  updateToolbarVisibility();
  updateMetricDropdownOptions();
  updateSortDropdownOptions();

  // Sync active segmented UI states
  document.querySelectorAll("#heatmap-loc-segmented .segment-btn").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-loc") === (state.heatmapLocScope || "states"));
  });

  document.querySelectorAll("#heatmap-time-segmented .segment-btn").forEach((b) => {
    if (b.id === "btn-hm-custom-season") {
      b.classList.toggle("active", state.heatmapTimeScope === "custom");
    } else {
      b.classList.toggle("active", b.getAttribute("data-time") === (state.heatmapTimeScope || "season"));
    }
  });

  document.querySelectorAll("#heatmap-horizon-segmented .segment-btn").forEach((b) => {
    b.classList.toggle("active", parseInt(b.getAttribute("data-h"), 10) === state.heatmapActiveHorizon);
  });

  // Resolve season scope parameter
  let seasonParam = "";
  let dateParam = "";

  if (state.heatmapTimeScope === "date") {
    dateParam = state.selectedDate || "";
    seasonParam = "";
  } else if (state.heatmapTimeScope === "season") {
    seasonParam = state.evalFocalSeason || state.latestSeason || "2024-2025";
    dateParam = "";
  } else if (state.heatmapTimeScope === "custom") {
    seasonParam = Array.from(state.heatmapSelectedSeasons).join(",");
    dateParam = "";
  } else if (state.heatmapTimeScope === "all") {
    seasonParam = "all";
    dateParam = "";
  }

  // Location scope parameter
  const locParam = state.heatmapLocScope === "states" ? "states" : (state.selectedLocation || "US");

  const candidateModels = state.selectedModels.size > 0
    ? Array.from(state.selectedModels)
    : Object.keys(state.models);

  try {
    const data = await fetchHeatmap({
      rows: state.heatmapRows || "location",
      cols: state.heatmapCols || "date",
      location: locParam,
      target: state.selectedTarget,
      metric: state.heatmapMetric,
      date: dateParam,
      season: seasonParam,
      horizon: state.heatmapActiveHorizon ?? 1,
      model: state.heatmapActiveModel || "truth",
      models: candidateModels,
      sortBy: state.heatmapSortBy,
      normalize: state.heatmapNormalize || "none",
      includeInactive: Boolean(state.heatmapIncludeInactive),
      signal: request.signal,
    });
    if (!request.isCurrent()) return;

    state.heatmapData = data;
    renderHeatmapPlot();
    renderHeatmapInactiveTray(data);

    // Default select first cell if none selected
    if (!state.heatmapSelectedCell && data.y_keys?.length && data.x_keys?.length) {
      const firstKey = `${data.y_keys[0]}:${data.x_keys[0]}`;
      state.heatmapSelectedCell = data.cell_meta?.[firstKey] || {
        row: data.y_keys[0],
        col: data.x_keys[0],
        rowLabel: data.y_labels?.[0],
        colLabel: data.x_labels?.[0],
        metric_value: data.matrix?.[0]?.[0],
      };
    }
    updateHeatmapInspector();
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error("Heatmap loading error:", err);
    renderHeatmapError(err.message);
  } finally {
    if (request.isCurrent()) showHeatmapLoading(false);
  }
}

/**
 * Main Plotly heatmap canvas renderer.
 */
export function renderHeatmapPlot() {
  const plotEl = document.getElementById("heatmap-plot");
  if (!plotEl || !state.heatmapData) return;

  const data = state.heatmapData;
  const isLight = document.body.classList.contains("theme-light");

  const yLabels = [...(data.y_labels || [])];
  const yKeys = [...(data.y_keys || [])];
  const xLabels = [...(data.x_labels || [])];
  const xKeys = [...(data.x_keys || [])];
  const matrix = data.matrix || [];
  const rawMatrix = data.raw_matrix || [];
  const textMatrix = data.text_matrix || [];

  if (yLabels.length === 0 || xLabels.length === 0) {
    const inactiveList = data.inactive_models || [];
    let emptyMsg = `No valid data points found for ${escapeHtml(state.heatmapRows)} &times; ${escapeHtml(state.heatmapCols)} in the selected scope.`;
    let switchSeasonBtn = "";
    if (inactiveList.length > 0) {
      const firstSeason = inactiveList.find((m) => m.seasons && m.seasons.length)?.seasons?.[0];
      emptyMsg = `None of the candidate models submitted forecasts for the <b>${escapeHtml(state.heatmapSeason || "selected")}</b> season.`;
      if (firstSeason) {
        switchSeasonBtn = `<button type="button" class="micro-btn primary" id="btn-hm-empty-switch-season" data-season="${escapeHtml(firstSeason)}" style="margin-top: 12px; padding: 6px 14px; font-size: 11px;">Switch Season to ${escapeHtml(firstSeason)}</button>`;
      }
    }
    plotEl.innerHTML = `
      <div class="heatmap-empty-state">
        <svg class="ui-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
        <h4>No Active Forecasts in Scope</h4>
        <p>${emptyMsg}</p>
        ${switchSeasonBtn}
      </div>`;
    const btnSwitch = document.getElementById("btn-hm-empty-switch-season");
    if (btnSwitch) {
      btnSwitch.addEventListener("click", () => {
        const s = btnSwitch.dataset.season;
        state.evalFocalSeason = s;
        state.heatmapSeason = s;
        state.heatmapTimeScope = "season";
        if (heatmapCallbacks.onUrlUpdate) heatmapCallbacks.onUrlUpdate();
        fetchAndRenderHeatmap(heatmapCallbacks);
      });
    }
    return;
  }

  // Build customdata 2D array and concise, formatted hover text for every cell
  const customDataMatrix = [];
  const hoverTextMatrix = [];

  for (let r = 0; r < yKeys.length; r++) {
    const rowCd = [];
    const rowHt = [];
    const yk = yKeys[r];
    const rowLabel = yLabels[r];

    for (let c = 0; c < xKeys.length; c++) {
      const xk = xKeys[c];
      const colLabel = xLabels[c];
      const cellKey = `${yk}:${xk}`;
      const meta = data.cell_meta?.[cellKey] || {};
      const rawVal = rawMatrix[r]?.[c];
      const normVal = matrix[r]?.[c];

      rowCd.push({
        rowKey: yk,
        colKey: xk,
        rowLabel: rowLabel,
        colLabel: colLabel,
        rawVal: rawVal,
        normVal: normVal,
        ...meta,
      });

      // Construct concise, clear hover card
      const lines = [];
      lines.push(`<b>${rowLabel}</b> · <b>${colLabel}</b>`);

      if (rawVal === null || rawVal === undefined) {
        const inactiveMatch = (data.inactive_models || []).find((im) => im.id === yk || im.id === xk);
        if (inactiveMatch) {
          lines.push(`<i>Did not forecast in this scope</i>`);
          lines.push(`<b>Reason:</b> ${escapeHtml(inactiveMatch.reason)}`);
        } else {
          lines.push(`<i>No Data</i>`);
        }
      } else {
        // Active metric formatted value
        let valStr = "";
        if (state.heatmapMetric === "rate") {
          valStr = `${rawVal.toFixed(2)} / 100k`;
        } else if (state.heatmapMetric === "count") {
          valStr = `${Math.round(rawVal).toLocaleString()} adm`;
        } else if (state.heatmapMetric === "trend") {
          valStr = `${rawVal > 0 ? "+" : ""}${rawVal.toFixed(1)}%`;
        } else if (state.heatmapMetric === "wis" || state.heatmapMetric === "wis_rate") {
          valStr = `${rawVal.toFixed(2)}`;
        } else if (state.heatmapMetric === "cov95") {
          valStr = `${rawVal.toFixed(1)}%`;
        } else {
          valStr = `${rawVal.toFixed(2)}`;
        }

        const metricName = state.heatmapMetric === "rate" ? "Incidence Rate" :
                           state.heatmapMetric === "count" ? "Admissions" :
                           state.heatmapMetric === "trend" ? "Weekly Change" :
                           state.heatmapMetric === "wis" ? "WIS Error" :
                           state.heatmapMetric === "mae" ? "MAE Error" :
                           state.heatmapMetric === "cov95" ? "95% Coverage" :
                           state.heatmapMetric === "sharpness" ? "Sharpness" : "Value";

        lines.push(`<b>${metricName}:</b> ${valStr}`);

        if (state.heatmapNormalize === "row_min_max" && normVal !== null && normVal !== undefined) {
          lines.push(`<b>Peak Timing:</b> ${(normVal * 100).toFixed(0)}%`);
        }

        if (meta.truth !== null && meta.truth !== undefined) {
          lines.push(`<b>Observed Truth:</b> ${Math.round(meta.truth).toLocaleString()} adm`);
        }
        if (meta.trend !== null && meta.trend !== undefined && state.heatmapMetric !== "trend") {
          lines.push(`<b>WoW Growth:</b> ${meta.trend > 0 ? "+" : ""}${meta.trend.toFixed(1)}%`);
        }
        if (meta.wis !== null && meta.wis !== undefined && state.heatmapMetric !== "wis") {
          lines.push(`<b>WIS Error:</b> ${meta.wis.toFixed(2)}`);
        }
      }

      rowHt.push(lines.join("<br>"));
    }
    customDataMatrix.push(rowCd);
    hoverTextMatrix.push(rowHt);
  }

  // Colorbar Title
  let colorbarTitle = "";
  if (state.heatmapNormalize === "row_min_max") {
    colorbarTitle = "Peak Timing (0 → 1)";
  } else if (state.heatmapMetric === "rate") {
    colorbarTitle = "Admissions / 100k";
  } else if (state.heatmapMetric === "count") {
    colorbarTitle = "Admissions Volume";
  } else if (state.heatmapMetric === "trend") {
    colorbarTitle = "WoW % Growth";
  } else if (state.heatmapMetric === "wis" || state.heatmapMetric === "wis_rate") {
    colorbarTitle = "WIS (Error)";
  } else if (state.heatmapMetric === "mae") {
    colorbarTitle = "MAE Error";
  } else if (state.heatmapMetric === "cov95") {
    colorbarTitle = "Coverage %";
  } else if (state.heatmapMetric === "sharpness") {
    colorbarTitle = "Sharpness (Width)";
  } else {
    colorbarTitle = state.heatmapMetric.toUpperCase();
  }

  // Determine if HHS Region grouping applies
  const hasHhsRowGroups = (state.heatmapRows === "location" && state.heatmapSortBy === "hhs_region" && Array.isArray(data.row_groups) && data.row_groups.length > 0);
  const colorbarX = hasHhsRowGroups ? 1.15 : 1.00;

  // Plotly Heatmap Trace
  const trace = {
    type: "heatmap",
    x: xLabels,
    y: yLabels,
    z: matrix,
    text: textMatrix,
    hovertext: hoverTextMatrix,
    customdata: customDataMatrix,
    colorscale: state.heatmapPalette || "YlOrRd",
    reversescale: Boolean(state.heatmapReversePalette),
    xgap: 1,
    ygap: 1,
    hoverongaps: false,
    hovertemplate: "%{hovertext}<extra></extra>",
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
    colorbar: {
      title: {
        text: colorbarTitle,
        side: "top",
        font: { family: "Inter, sans-serif", size: 10, color: isLight ? "#073642" : "#a8a29e" },
      },
      tickfont: { family: "JetBrains Mono, monospace", size: 9, color: isLight ? "#586e75" : "#a8a29e" },
      bgcolor: isLight ? "rgba(238, 232, 213, 0.9)" : "rgba(24, 23, 21, 0.85)",
      bordercolor: isLight ? "rgba(101, 123, 131, 0.25)" : "rgba(255, 248, 240, 0.1)",
      thickness: 12,
      len: 0.82,
      x: colorbarX,
      xanchor: "left",
      y: 0.5,
      yanchor: "middle",
    },
  };

  // Adjust container height to match inspector when open, eliminating blank space
  adjustHeatmapCanvasHeight();

  // HHS Region visual divider lines & regional grouping annotations
  const shapes = [];
  const annotations = [];

  if (hasHhsRowGroups) {
    data.row_groups.forEach((grp) => {
      // Delineate each HHS region group with a prominent, high-contrast boundary line above the cells
      if (grp.end_idx < yLabels.length - 1) {
        shapes.push({
          type: "line",
          xref: "paper",
          x0: 0,
          x1: 1.0,
          yref: "y",
          y0: grp.end_idx + 0.5,
          y1: grp.end_idx + 0.5,
          layer: "above",
          line: {
            color: isLight ? "#002b36" : "#f8fafc",
            width: 2.5,
            dash: "solid",
          },
        });
      }

      // Label each delineated region group with an on-theme styled badge on the right margin
      const yMid = (grp.start_idx + grp.end_idx) / 2;
      const shortName = grp.short || grp.label || `Region ${grp.region_id}`;
      annotations.push({
        xref: "paper",
        x: 1.015,
        yref: "y",
        y: yMid,
        xanchor: "left",
        yanchor: "middle",
        text: `<span style="font-size:7.5px;font-weight:700;letter-spacing:0.5px;opacity:0.75;">REGION ${grp.region_id}</span><br><b>${shortName}</b>`,
        showarrow: false,
        bgcolor: isLight ? "rgba(238, 232, 213, 0.92)" : "rgba(30, 29, 26, 0.92)",
        bordercolor: isLight ? "rgba(101, 123, 131, 0.35)" : "rgba(255, 248, 240, 0.18)",
        borderwidth: 1,
        borderpad: 4,
        align: "left",
        font: {
          family: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
          size: 9.5,
          color: isLight ? "#002b36" : "#f6f4ee",
        },
      });
    });
  }

  // Column grouping by HHS Region when columns represent locations
  if (Array.isArray(data.col_groups) && data.col_groups.length > 0) {
    data.col_groups.forEach((grp) => {
      if (grp.end_idx < xLabels.length - 1) {
        shapes.push({
          type: "line",
          xref: "x",
          x0: grp.end_idx + 0.5,
          x1: grp.end_idx + 0.5,
          yref: "paper",
          y0: 0,
          y1: 1,
          layer: "above",
          line: {
            color: isLight ? "#002b36" : "#f8fafc",
            width: 2.5,
            dash: "solid",
          },
        });
      }
    });
  }

  // Visual divider line separating active reporting models from inactive models
  if (data.include_inactive && data.inactive_models && data.inactive_models.length > 0) {
    const activeCount = yLabels.length - data.inactive_models.length;
    if (activeCount > 0 && activeCount < yLabels.length) {
      shapes.push({
        type: "line",
        xref: "paper",
        x0: 0,
        x1: 1,
        yref: "y",
        y0: activeCount - 0.5,
        y1: activeCount - 0.5,
        line: {
          color: isLight ? "rgba(217, 119, 6, 0.75)" : "rgba(245, 158, 11, 0.75)",
          width: 1.5,
          dash: "dot",
        },
      });
      annotations.push({
        xref: "paper",
        x: 0.99,
        yref: "y",
        y: activeCount - 0.5,
        xanchor: "right",
        yanchor: "bottom",
        text: "Non-Reporting Models ↓",
        showarrow: false,
        font: {
          family: "Inter, sans-serif",
          size: 10,
          color: isLight ? "#b45309" : "#f59e0b",
        },
      });
    }
  }

  const maxLabelLen = Math.max(...yLabels.map((l) => (l ? l.length : 0)), 0);
  const leftMargin = maxLabelLen > 18 ? 160 : (maxLabelLen > 12 ? 140 : (maxLabelLen > 7 ? 115 : 75));
  const rightMargin = hasHhsRowGroups ? 165 : 95;

  const layout = {
    paper_bgcolor: "rgba(0, 0, 0, 0)",
    plot_bgcolor: "rgba(0, 0, 0, 0)",
    autosize: true,
    margin: {
      t: 25,
      b: xLabels.length > 8 ? 70 : 45,
      l: leftMargin,
      r: rightMargin,
    },
    shapes: shapes,
    annotations: annotations,
    xaxis: {
      title: "",
      tickangle: xLabels.length > 8 ? -45 : 0,
      tickfont: {
        family: "JetBrains Mono, monospace",
        size: xLabels.length > 35 ? 8.5 : 9.5,
        color: isLight ? "#586e75" : "#a8a29e",
      },
      gridcolor: "transparent",
      zeroline: false,
    },
    yaxis: {
      title: "",
      autorange: "reversed", // Matrix row orientation top-down
      tickfont: {
        family: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
        size: yLabels.length > 40 ? 9 : (yLabels.length > 20 ? 10 : 11),
        color: isLight ? "#073642" : "#f5f5f4",
      },
      gridcolor: "transparent",
      zeroline: false,
    },
  };

  const config = {
    responsive: true,
    displayModeBar: false,
    scrollZoom: false,
  };

  Plotly.react("heatmap-plot", [trace], layout, config)
    .then((gd) => {
      gd.removeAllListeners?.("plotly_click");
      gd.on("plotly_click", (ev) => {
        if (!ev || !ev.points || !ev.points.length) return;
        const pt = ev.points[0];
        const cd = pt.customdata;
        if (cd) {
          state.heatmapSelectedCell = cd;
          updateHeatmapInspector();
        }
      });
      triggerPlotResizeSequence("heatmap-plot");
    })
    .catch((err) => console.error("Plotly heatmap render error:", err));
}

/**
 * Renders the Non-Reporting Models tray directly underneath the heatmap canvas.
 */
export function renderHeatmapInactiveTray(data) {
  const trayEl = document.getElementById("heatmap-inactive-models-tray");
  if (!trayEl) return;

  const inactiveList = data.inactive_models || [];
  if (inactiveList.length === 0) {
    trayEl.classList.add("hidden");
    return;
  }

  trayEl.classList.remove("hidden");

  const titleEl = document.getElementById("hm-inactive-title");
  const badgeEl = document.getElementById("hm-inactive-badge");
  const subEl = document.getElementById("hm-inactive-subtitle");
  const toggleBtn = document.getElementById("btn-toggle-inactive-in-plot");
  const toggleLabel = document.getElementById("label-toggle-inactive-in-plot");
  const chipsContainer = document.getElementById("hm-inactive-chips-container");

  const count = inactiveList.length;
  if (titleEl) {
    titleEl.textContent = `Non-Reporting Models in Scope`;
  }
  if (badgeEl) {
    badgeEl.textContent = `${count}`;
  }
  if (subEl) {
    subEl.textContent = state.heatmapIncludeInactive
      ? `Displaying ${count} non-reporting models at the bottom of the heatmap`
      : `Excluded from the plot above to preserve continuous rows. Click any model to inspect why.`;
  }

  if (toggleLabel) {
    toggleLabel.textContent = state.heatmapIncludeInactive
      ? `Clean View (Active Only)`
      : `Show in Heatmap (${count})`;
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle("active", Boolean(state.heatmapIncludeInactive));
  }

  if (chipsContainer) {
    chipsContainer.innerHTML = "";
    inactiveList.forEach((m) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "inactive-model-chip";
      chip.dataset.modelId = m.id;
      const isSelected = state.heatmapSelectedCell?.row === m.id || state.heatmapSelectedCell?.model_name === m.id;
      if (isSelected) chip.classList.add("selected");

      chip.title = `${m.name}: ${m.reason}`;

      const reasonTag = (m.seasons && m.seasons.length > 0)
        ? `${m.seasons.join(", ")} only`
        : (m.count === 0 ? "No submissions" : "0 in scope");

      chip.innerHTML = `
        <span class="chip-name">${escapeHtml(m.name || m.id)}</span>
        <span class="chip-reason">${escapeHtml(reasonTag)}</span>
      `;

      chip.addEventListener("click", () => {
        inspectInactiveModel(m);
      });

      chipsContainer.appendChild(chip);
    });
  }
}

/**
 * Inspect an inactive non-reporting model in the Data Inspector.
 */
export function inspectInactiveModel(modelMeta) {
  state.heatmapSelectedCell = {
    is_inactive: true,
    row: modelMeta.id,
    rowLabel: modelMeta.name || modelMeta.id,
    model_name: modelMeta.name || modelMeta.id,
    col: state.heatmapCols || "scope",
    colLabel: state.heatmapCols || "scope",
    reason: modelMeta.reason,
    seasons: modelMeta.seasons || [],
    count: modelMeta.count || 0,
    min_date: modelMeta.min_date,
    max_date: modelMeta.max_date,
    is_local: modelMeta.is_local,
  };

  // Open inspector if collapsed
  toggleHeatmapInspector(true);
  updateHeatmapInspector();

  // Highlight selected chip in tray
  document.querySelectorAll(".inactive-model-chip").forEach((c) => {
    c.classList.toggle("selected", c.dataset.modelId === modelMeta.id);
  });
}

/**
 * Updates the collapsible Heatmap Inspector with details of the selected cell.
 */
export function updateHeatmapInspector() {
  const panel = document.getElementById("heatmap-inspector-panel");
  if (!panel || !state.heatmapSelectedCell) return;

  const cell = state.heatmapSelectedCell;

  // Title and Header
  const badgeEl = document.getElementById("hm-insp-badge");
  const nameEl = document.getElementById("hm-insp-title");
  const metaEl = document.getElementById("hm-insp-meta");

  // Metric Cards
  const valPrimaryEl = document.getElementById("hm-insp-val-primary");
  const subPrimaryEl = document.getElementById("hm-insp-sub-primary");
  const valTruthEl = document.getElementById("hm-insp-val-truth");
  const subTruthEl = document.getElementById("hm-insp-sub-truth");
  const valTrendEl = document.getElementById("hm-insp-val-trend");
  const valWisEl = document.getElementById("hm-insp-val-wis");
  const badgeWisEl = document.getElementById("hm-insp-wis-badge");
  const jumpTimelineBtn = document.getElementById("btn-hm-jump-timeline");

  // Special handling for non-reporting inactive models
  if (cell.is_inactive) {
    if (badgeEl) {
      badgeEl.style.display = "flex";
      badgeEl.textContent = "OFF";
    }
    if (nameEl) {
      nameEl.textContent = cell.model_name || cell.row;
    }
    if (metaEl) {
      metaEl.textContent = `Excluded from Heatmap · ${cell.reason}`;
    }
    if (valPrimaryEl) valPrimaryEl.textContent = "0 files";
    if (subPrimaryEl) subPrimaryEl.textContent = cell.reason;
    if (valTruthEl) valTruthEl.textContent = (cell.seasons && cell.seasons.length > 0) ? cell.seasons.join(", ") : "None";
    if (subTruthEl) subTruthEl.textContent = "Recorded seasons";
    if (valTrendEl) {
      valTrendEl.textContent = `${cell.count || 0}`;
      valTrendEl.className = "insp-metric-val";
    }
    if (valWisEl) valWisEl.textContent = cell.min_date ? `${cell.min_date.slice(0, 4)}–${(cell.max_date || "").slice(0, 4)}` : "--";
    if (badgeWisEl) {
      badgeWisEl.textContent = "Inactive";
      badgeWisEl.className = "badge-micro badge-neutral";
    }

    if (jumpTimelineBtn) {
      const targetSeason = cell.seasons && cell.seasons.length > 0 ? cell.seasons[0] : null;
      if (targetSeason) {
        jumpTimelineBtn.dataset.targetSeason = targetSeason;
        jumpTimelineBtn.style.display = "flex";
        const span = jumpTimelineBtn.querySelector("span");
        if (span) span.textContent = `Switch Season to ${targetSeason}`;
      } else {
        delete jumpTimelineBtn.dataset.targetSeason;
        jumpTimelineBtn.style.display = "none";
      }
    }

    drawInspectorSparkline();
    return;
  }

  // Restore jump button for standard cells
  if (jumpTimelineBtn) {
    delete jumpTimelineBtn.dataset.targetSeason;
    jumpTimelineBtn.style.display = "flex";
    const span = jumpTimelineBtn.querySelector("span");
    if (span) span.textContent = "Open State Timeline Fan";
  }

  const isStateRow = cell.row && cell.row.length <= 3;
  if (badgeEl) {
    if (isStateRow) {
      badgeEl.style.display = "flex";
      badgeEl.textContent = cell.row;
    } else {
      badgeEl.style.display = "none";
    }
  }
  if (nameEl) {
    nameEl.textContent = cell.row_name || cell.rowLabel || cell.row || "Selected Item";
  }

  if (metaEl) {
    const reg = cell.region_name ? ` · ${cell.region_name}` : "";
    metaEl.textContent = `${cell.colLabel || cell.col || ""}${reg}`;
  }

  // Primary Metric
  if (valPrimaryEl) {
    if (cell.metric_value !== null && cell.metric_value !== undefined) {
      if (cell.metric_name === "rate") valPrimaryEl.textContent = `${Number(cell.metric_value).toFixed(2)}`;
      else if (cell.metric_name === "count") valPrimaryEl.textContent = `${Math.round(cell.metric_value).toLocaleString()}`;
      else if (cell.metric_name === "trend") valPrimaryEl.textContent = `${Number(cell.metric_value) > 0 ? "+" : ""}${Number(cell.metric_value).toFixed(1)}%`;
      else if (cell.metric_name === "cov95") valPrimaryEl.textContent = `${Number(cell.metric_value).toFixed(1)}%`;
      else valPrimaryEl.textContent = `${Number(cell.metric_value).toFixed(2)}`;
    } else {
      valPrimaryEl.textContent = "--";
    }
  }

  if (subPrimaryEl) {
    if (cell.metric_name === "rate") subPrimaryEl.textContent = "Admissions / 100k population";
    else if (cell.metric_name === "count") subPrimaryEl.textContent = "Weekly admissions volume";
    else if (cell.metric_name === "trend") subPrimaryEl.textContent = "Week-over-week velocity";
    else subPrimaryEl.textContent = "Active cell metric";
  }

  // Observed Truth / Median
  if (valTruthEl) {
    if (cell.truth !== null && cell.truth !== undefined) {
      valTruthEl.textContent = `${Math.round(cell.truth).toLocaleString()}`;
    } else if (cell.median !== null && cell.median !== undefined) {
      valTruthEl.textContent = `${Math.round(cell.median).toLocaleString()}`;
    } else {
      valTruthEl.textContent = "--";
    }
  }

  if (subTruthEl) {
    if (cell.truth !== null && cell.truth !== undefined) {
      const errStr = cell.error !== null && cell.error !== undefined ? ` (Δ: ${cell.error > 0 ? "+" : ""}${cell.error})` : "";
      subTruthEl.textContent = `Observed admissions volume${errStr}`;
    } else if (cell.q025 !== undefined && cell.q975 !== undefined) {
      subTruthEl.textContent = `95% PI: [${Math.round(cell.q025)} – ${Math.round(cell.q975)}]`;
    } else {
      subTruthEl.textContent = "Observed admissions / projection";
    }
  }

  // Trajectory / WoW Trend
  if (valTrendEl) {
    if (cell.trend !== null && cell.trend !== undefined) {
      const sign = cell.trend > 0 ? "+" : "";
      valTrendEl.textContent = `${sign}${Number(cell.trend).toFixed(1)}%`;
      valTrendEl.className = `insp-metric-val ${cell.trend > 15 ? "highlight-rose" : (cell.trend < -15 ? "highlight-emerald" : "")}`;
    } else {
      valTrendEl.textContent = "--";
      valTrendEl.className = "insp-metric-val";
    }
  }

  // WIS Score
  if (valWisEl) {
    if (cell.wis !== null && cell.wis !== undefined) {
      valWisEl.textContent = `${Number(cell.wis).toFixed(2)}`;
    } else {
      valWisEl.textContent = "--";
    }
  }

  if (badgeWisEl) {
    if (cell.wis !== null && cell.wis !== undefined) {
      badgeWisEl.textContent = "Scored";
      badgeWisEl.className = "badge-micro badge-verified";
    } else {
      badgeWisEl.textContent = "Unscored";
      badgeWisEl.className = "badge-micro badge-neutral";
    }
  }

  // Draw sparkline for the active row
  drawInspectorSparkline();
}

/**
 * Draws an interactive HTML5 canvas mini-sparkline for the selected row across all columns.
 */
function drawInspectorSparkline() {
  const canvas = document.getElementById("heatmap-insp-sparkline");
  if (!canvas || !state.heatmapData || !state.heatmapSelectedCell) return;

  const data = state.heatmapData;
  const cell = state.heatmapSelectedCell;
  const isLight = document.body.classList.contains("theme-light");

  if (cell.is_inactive) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(100, Math.floor(rect.width || 280));
    const height = 65;

    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    ctx.font = "11px Inter, sans-serif";
    ctx.fillStyle = isLight ? "#94a3b8" : "#a8a29e";
    ctx.textAlign = "center";
    ctx.fillText("Model did not forecast in this scope", width / 2, height / 2 - 4);
    ctx.font = "9.5px 'JetBrains Mono', monospace";
    ctx.fillStyle = isLight ? "#64748b" : "#78716c";
    ctx.fillText(cell.reason || "", width / 2, height / 2 + 14);
    return;
  }

  const rowIdx = (data.y_keys || []).indexOf(cell.row);
  if (rowIdx < 0 || !data.raw_matrix?.[rowIdx]) return;

  const rowValues = data.raw_matrix[rowIdx];
  const activeColIdx = (data.x_keys || []).indexOf(cell.col);

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(100, Math.floor(rect.width || 280));
  const height = 65;

  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const validVals = rowValues.filter((v) => v !== null && v !== undefined && !isNaN(v));
  if (validVals.length < 2) {
    ctx.font = "11px Inter, sans-serif";
    ctx.fillStyle = isLight ? "#94a3b8" : "#64748b";
    ctx.textAlign = "center";
    ctx.fillText("Insufficient trend points", width / 2, height / 2 + 4);
    return;
  }

  const minV = Math.min(...validVals);
  const maxV = Math.max(...validVals);
  const range = maxV > minV ? maxV - minV : 1;
  const padX = 14;
  const padY = 12;

  const points = [];
  const stepX = (width - padX * 2) / Math.max(1, rowValues.length - 1);

  for (let i = 0; i < rowValues.length; i++) {
    const val = rowValues[i];
    if (val !== null && val !== undefined && !isNaN(val)) {
      const x = padX + i * stepX;
      const y = height - padY - ((val - minV) / range) * (height - padY * 2);
      points.push({ x, y, val, idx: i });
    }
  }

  if (points.length < 2) return;

  // Background Gradient
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, isLight ? "rgba(56, 189, 248, 0.35)" : "rgba(56, 189, 248, 0.25)");
  grad.addColorStop(1, isLight ? "rgba(56, 189, 248, 0.0)" : "rgba(56, 189, 248, 0.0)");

  ctx.beginPath();
  ctx.moveTo(points[0].x, height);
  points.forEach((pt) => ctx.lineTo(pt.x, pt.y));
  ctx.lineTo(points[points.length - 1].x, height);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Stroke line
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  points.forEach((pt) => ctx.lineTo(pt.x, pt.y));
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 2.2;
  ctx.stroke();

  // Active Marker Pin
  const activePt = points.find((p) => p.idx === activeColIdx);
  if (activePt) {
    ctx.beginPath();
    ctx.moveTo(activePt.x, 0);
    ctx.lineTo(activePt.x, height);
    ctx.strokeStyle = isLight ? "rgba(101, 123, 131, 0.3)" : "rgba(255, 255, 255, 0.2)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(activePt.x, activePt.y, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = isLight ? "rgba(56, 189, 248, 0.3)" : "rgba(56, 189, 248, 0.4)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(activePt.x, activePt.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#0284c7";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

/**
 * 1-Click Cross-Navigation: Jump directly to single-state timeline fan chart.
 */
export function jumpToTimelineFromHeatmap(callbacks = {}) {
  if (!state.heatmapSelectedCell) return;
  const cell = state.heatmapSelectedCell;
  const jumpTimelineBtn = document.getElementById("btn-hm-jump-timeline");

  if (cell.is_inactive && jumpTimelineBtn?.dataset?.targetSeason) {
    const s = jumpTimelineBtn.dataset.targetSeason;
    state.evalFocalSeason = s;
    state.heatmapSeason = s;
    state.heatmapTimeScope = "season";
    if (callbacks.onUrlUpdate) callbacks.onUrlUpdate();
    fetchAndRenderHeatmap(callbacks.onUrlUpdate ? callbacks : heatmapCallbacks);
    return;
  }

  const loc = cell.row;
  const date = cell.col;

  const locObj = Object.values(state.locations).find((l) => l.abbreviation === loc);
  if (locObj) {
    state.selectedLocation = locObj.id;
  }
  if (date && date.includes("-")) {
    state.selectedDate = date;
    const dateSelect = document.getElementById("date-select");
    if (dateSelect) dateSelect.value = date;
  }

  if (callbacks.onSwitchView) {
    callbacks.onSwitchView("timeline");
  }
}

/**
 * 1-Click Cross-Navigation: Jump directly to US Spatial Map for that date and horizon.
 */
export function jumpToSpatialFromHeatmap(callbacks = {}) {
  if (!state.heatmapSelectedCell) return;
  const cell = state.heatmapSelectedCell;
  const date = cell.col;

  if (date && date.includes("-")) {
    state.selectedDate = date;
    const dateSelect = document.getElementById("date-select");
    if (dateSelect) dateSelect.value = date;
  }

  if (cell.horizon !== undefined && cell.horizon !== null) {
    state.spatialActiveHorizon = Number(cell.horizon);
  }

  if (callbacks.onSwitchView) {
    callbacks.onSwitchView("spatial");
  }
}

/**
 * Adaptively adjust heatmap canvas height:
 * - If inspector is OPEN in normal mode: sets height to match the inspector panel (~460px),
 *   eliminating any blank space underneath the heatmap plot.
 * - If inspector is COLLAPSED in normal mode: shrinks down to fit small row counts snugly.
 * - In presentation mode: fills 100% of available viewport.
 */
export function adjustHeatmapCanvasHeight() {
  const plotCanvas = document.getElementById("heatmap-plot");
  const inspectorPanel = document.getElementById("heatmap-inspector-panel");
  const isPres = document.body.classList.contains("presentation-mode");
  if (!plotCanvas) return;

  if (isPres) {
    plotCanvas.style.height = "100%";
    plotCanvas.style.maxHeight = "none";
    return;
  }

  const isInspectorOpen = inspectorPanel && !inspectorPanel.classList.contains("collapsed");
  const numR = (state.heatmapData?.y_labels || []).length;
  let smartHeight = 620;

  if (isInspectorOpen) {
    // When the data inspector is open on the right, it has a natural height of ~460px.
    // The heatmap plot must be tall enough to fill the blank space beside the inspector.
    const inspectorHeight = (inspectorPanel && inspectorPanel.offsetHeight > 300) ? inspectorPanel.offsetHeight : 460;
    if (numR <= 12) {
      smartHeight = Math.max(inspectorHeight, 460);
    } else if (numR <= 25) {
      smartHeight = Math.max(inspectorHeight, 480);
    } else {
      smartHeight = Math.min(680, Math.max(inspectorHeight, numR * 12 + 60));
    }
  } else {
    // When the inspector is collapsed, shrink compactly to wrap small row counts snugly
    if (numR <= 2) {
      smartHeight = 230;
    } else if (numR <= 5) {
      smartHeight = 290;
    } else if (numR <= 12) {
      smartHeight = 380;
    } else if (numR <= 25) {
      smartHeight = 480;
    } else {
      smartHeight = Math.min(680, Math.max(540, numR * 12 + 60));
    }
  }

  plotCanvas.style.height = `${smartHeight}px`;
  plotCanvas.style.maxHeight = `${smartHeight}px`;
}

/**
 * Toggle collapsed / expanded state of the Heatmap inspector panel.
 */
export function toggleHeatmapInspector(forceState) {
  const panel = document.getElementById("heatmap-inspector-panel");
  const rail = document.getElementById("btn-expand-heatmap-inspector");
  if (!panel || !rail) return;

  const shouldOpen = forceState !== undefined ? forceState : panel.classList.contains("collapsed");
  state.heatmapInspectorOpen = shouldOpen;

  panel.classList.toggle("collapsed", !shouldOpen);
  rail.classList.toggle("hidden", shouldOpen);

  adjustHeatmapCanvasHeight();

  requestAnimationFrame(() => {
    triggerPlotResizeSequence("heatmap-plot");
    drawInspectorSparkline();
  });
}

/**
 * Show / hide loading indicator.
 */
function showHeatmapLoading(isLoading) {
  const loader = document.getElementById("heatmap-loading-overlay");
  if (loader) loader.classList.toggle("hidden", !isLoading);
}

/**
 * Display error state inside the plot container.
 */
function renderHeatmapError(msg) {
  const plotEl = document.getElementById("heatmap-plot");
  if (!plotEl) return;
  plotEl.innerHTML = `
    <div class="heatmap-error-state">
      <svg class="ui-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
      <h4>Failed to Load Heatmap Data</h4>
      <p>${escapeHtml(msg)}</p>
      <button type="button" class="micro-btn" onclick="window.__retryHeatmap && window.__retryHeatmap()">Retry</button>
    </div>`;
}

