/**
 * FluSight Sandbox Lab — Main Application Bootstrap & Orchestrator
 * Pure ES Module Zero-Build Architecture
 */

import { ICONS, INDICATOR_META, escapeHtml, setFetchError, bindDropdownMenu, showToast } from "./constants.js";
import {
  state,
  assignModelColors,
  shuffleModelColors,
  parseUrlParams,
  updateUrlParams,
  formatSeasonShort,
} from "./state.js";
import { fetchMetadata, fetchForecast, fetchMetrics, createRequestGuard } from "./api.js";
import {
  initCustomDatePicker,
  populateLocationSelect,
  populateDateSelect,
  populateFamilyFilters,
  populateSeasonFilters,
  renderModelChips,
  updateHeaderContext,
  getFilteredWorkspaceModels,
  stepPreviousDate,
  stepNextDate,
  selectDate,
  closeCustomDatePicker,
  updateCustomDatePickerTrigger,
} from "./components/controls.js";
import {
  renderForecastPlot,
  setupPlotResizeObservers,
  triggerPlotResizeSequence,
} from "./components/forecast_chart.js";
import {
  sortAndRenderTable,
  extractModelSortValue,
  fetchAndRenderMetrics as fetchMetricsModule,
  setMetricsLoadingState,
  showValidationWarningsModal,
  clearMetricsCache,
} from "./components/leaderboard.js";
import {
  initEvalWindow,
  updateEvalWindowButton,
  resolveEvalScope,
  clearEvalWindowCache,
} from "./components/eval_window.js";
import {
  initRemoteHubs,
  setRemoteHubsFromMetadata,
  openRemoteHubModal,
  closeRemoteHubModal,
  isRemoteHubModalOpen,
} from "./components/remote_hubs.js";
import {
  switchViewMode,
  fetchAndRenderSpatial,
  renderSpatialMap,
  updateSpatialInspector,
  updateSpatialInsights,
  toggleSpatialInspector,
  toggleSpatialPlayback,
  stopSpatialPlayback,
} from "./components/spatial_map.js";
import {
  initHeatmapEvents,
  fetchAndRenderHeatmap,
  renderHeatmapPlot,
  toggleHeatmapInspector,
} from "./components/heatmap_view.js";
import {
  fetchAndRenderPeaks,
  renderPeakView,
  initPeakControls,
  resizePeakPlots,
} from "./components/peak_view.js";
import {
  setupDiagnosticsControls,
  renderDecompositionView,
  renderCalibrationView,
  renderHorizonBarChart,
} from "./components/diagnostics.js";
import {
  openMethodologyModal,
  closeMethodologyModal,
  setupMethodologySearch,
  showDefinitionPopover,
  hideDefinitionPopover,
  openModelDetailsModal,
  hideModelDetailsModal,
  updateModelDetailSelectButton,
  renderModelDetailActiveTab,
} from "./components/modals.js";
import {
  initEnsembleStudio,
  openEnsembleStudio,
  closeEnsembleStudio,
  updateNavbarEnsembleCount,
} from "./components/ensemble_studio.js";

// Make setEvalScope available globally for inline HTML click handlers
window.setEvalScope = function (scope) {
  if (scope === "states") {
    setEvalLocScope("states");
  } else if (scope === "all") {
    setEvalHorizonScope("all");
    setEvalLocScope("states");
  } else {
    setEvalLocScope("current");
  }
};

window.openModelDetailsModal = openModelDetailsModal;
window.openEnsembleStudio = openEnsembleStudio;

// ----------------------------------------------------------------------------
// Application Initialization
// ----------------------------------------------------------------------------

export async function initApp() {
  initTheme();
  setupEventListeners();
  setupPlotResizeObservers();
  initEnsembleStudio({
    onEnsembleCreated: async () => {
      await loadMetadata();
      renderModelChips({
        onSelectionChange: refreshAll,
        onModelInspect: openModelDetailsModal,
      });
      refreshAll();
    },
    onEnsembleDeleted: async () => {
      await loadMetadata();
      renderModelChips({
        onSelectionChange: refreshAll,
        onModelInspect: openModelDetailsModal,
      });
      refreshAll();
    },
    onSelectionChange: refreshAll,
    onEnsembleUpdated: async () => {
      await loadMetadata();
      renderModelChips({
        onSelectionChange: refreshAll,
        onModelInspect: openModelDetailsModal,
      });
      refreshAll();
    },
  });
  initRemoteHubs({
    onInventoryChanged: handleInventoryChanged,
    onCompare: (modelKey, latestDate) => {
      renderModelChips({ onSelectionChange: refreshAll, onModelInspect: openModelDetailsModal });
      if (latestDate && latestDate !== state.selectedDate) {
        selectDate(latestDate, () => refreshAll());
      } else {
        refreshAll();
      }
    },
  });
  await loadMetadata();
  parseUrlParams();
  notifyMissingHubModels();
  renderModelChips({
    onSelectionChange: refreshAll,
    onModelInspect: openModelDetailsModal,
  });
  syncToggleButtons();
  updateActiveIndicatorsUI();
  updateHeaderContext();

  initHeatmapEvents({
    onUrlUpdate: updateUrlParams,
    onHeaderUpdate: updateHeaderContext,
    onOpenMethodology: openMethodologyModal,
    onSwitchView: (v) => switchViewMode(v, viewCallbacks()),
  });

  if (state.currentView !== "timeline") {
    switchViewMode(state.currentView, viewCallbacks());
  } else {
    refreshAll();
  }
}

async function loadMetadata() {
  try {
    const data = await fetchMetadata();
    state.models = data.models || {};
    state.recommendedModels = data.recommended_models || [];
    state.locations = data.locations || [];
    state.dates = data.dates || [];
    state.forecastDates = data.forecast_dates || [];
    state.dateInfo = data.date_info || {};
    state.allSeasons = data.seasons || [];
    state.forecastSeasons = data.forecast_seasons || [];
    state.seasonSummaries = data.season_summaries || [];
    state.targets = data.targets || state.targets;
    state.targetsMeta = data.targets_meta || {};
    state.peakTargets = data.peak_targets || {};
    state.latestSeason = data.latest_season || "";
    state.latestDate = data.latest_date || "";
    state.truthInfo = data.truth_info || null;
    setRemoteHubsFromMetadata(data.remote_hubs || []);

    // Drop selections whose model is no longer in the inventory (e.g. a hub was hidden or removed)
    Array.from(state.selectedModels).forEach((id) => {
      if (!state.models[id]) state.selectedModels.delete(id);
    });

    assignModelColors();
    populateLocationSelect();
    populateDateSelect();
    updateEvalWindowButton();

    if (data.families && data.families.length > 0) {
      populateFamilyFilters(data.families);
    } else {
      populateFamilyFilters([]);
    }

    if (data.seasons && data.seasons.length > 0) {
      populateSeasonFilters(data.seasons, {
        onSelectionChange: refreshAll,
        onModelInspect: openModelDetailsModal,
      });
    }

    if (state.dates.length > 0 && !state.selectedDate) {
      state.selectedDate = (state.forecastDates && state.forecastDates.length > 0)
        ? state.forecastDates[0]
        : state.dates[0];
      const dateSelect = document.getElementById("date-select");
      if (dateSelect) dateSelect.value = state.selectedDate;
    }

    if (data.default_target && !new URLSearchParams(window.location.search).has("target")) {
      state.selectedTarget = data.default_target;
      document.querySelectorAll("#target-segmented .segment-btn").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-target") === state.selectedTarget);
      });
    }

    renderModelChips({
      onSelectionChange: refreshAll,
      onModelInspect: openModelDetailsModal,
    });
    updateHeaderContext();
    setFetchError("forecast-plot", "");
  } catch (err) {
    console.error("Error loading metadata:", err);
    setFetchError("forecast-plot", "Could not load hub metadata. Check that the viz server is running, then reload.");
  }
}

/**
 * Reload everything that depends on the model inventory or truth after a hub sync, toggle, or removal.
 */
async function handleInventoryChanged() {
  clearMetricsCache();
  clearEvalWindowCache();
  state.modelDetailCache = {};
  state.smartZoom.lastStableYMax = null;
  state.spatialPeakData = null;
  await loadMetadata();
  refreshAll();
}

/** A shared link may reference hub models that were never synced on this machine. */
function notifyMissingHubModels() {
  const missing = (state.missingUrlModels || []).filter((m) => /^[a-z][a-z0-9_]*:/.test(m) && !m.startsWith("local:"));
  if (missing.length === 0) return;
  const hubId = missing[0].split(":")[0];
  const hub = (state.remoteHubs || []).find((h) => h.id === hubId);
  const label = hub ? hub.label : hubId;
  showToast(`This link includes ${missing.length} ${label} model${missing.length === 1 ? "" : "s"} that ${missing.length === 1 ? "isn't" : "aren't"} synced here.`, {
    kind: "info",
    duration: 12000,
    action: hub ? { label: "Sync…", onClick: () => openRemoteHubModal(hubId) } : null,
  });
}

// ----------------------------------------------------------------------------
// Core Refresh & Data Fetching Orchestrators
// ----------------------------------------------------------------------------

/** Callbacks every view switch needs (header, URL, and how to render each view). */
function viewCallbacks() {
  return {
    onHeaderUpdate: updateHeaderContext,
    onUrlUpdate: updateUrlParams,
    onRenderForecast: fetchAndRenderForecast,
    onRenderPeaks: fetchAndRenderPeaksMain,
    onOpenMethodology: openMethodologyModal,
  };
}

export function refreshAll() {
  updateUrlParams();
  if (state.currentView === "spatial") {
    fetchAndRenderSpatial();
  } else if (state.currentView === "heatmap") {
    fetchAndRenderHeatmapMain();
  } else if (state.currentView === "peak") {
    fetchAndRenderPeaksMain();
  } else {
    fetchAndRenderForecast();
  }
  fetchAndRenderMetricsMain();
}

export function fetchAndRenderPeaksMain() {
  return fetchAndRenderPeaks({
    onSelectDate: (d) => selectDate(d, () => refreshAll()),
    onSwitchTarget: (t) => document.querySelector(`#target-segmented .segment-btn[data-target="${CSS.escape(t)}"]`)?.click(),
    onUrlUpdate: updateUrlParams,
  });
}

const forecastGuard = createRequestGuard();

export async function fetchAndRenderForecast() {
  if (!state.selectedDate) return;

  const modelsParam = Array.from(state.selectedModels);
  const request = forecastGuard.start();
  try {
    const data = await fetchForecast({
      date: state.selectedDate,
      location: state.selectedLocation,
      target: state.selectedTarget,
      models: modelsParam,
      signal: request.signal,
    });
    if (!request.isCurrent()) return;
    setFetchError("forecast-plot", "");
    state.currentForecastData = data;
    if (data.surveillance && data.surveillance.historical_seasons) {
      renderHistoricalSeasonPills(data.surveillance.historical_seasons);
    }
    renderForecastPlot(data);
    updatePresentationControls();
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error("Error fetching forecast:", err);
    setFetchError("forecast-plot", `Could not load forecasts for ${state.selectedDate}; the chart below is out of date. (${err.message})`);
  }
}

export async function fetchAndRenderMetricsMain(forceRefresh = false) {
  await fetchMetricsModule(forceRefresh, {
    onMetricsUpdated: (rankings) => {
      if (state.activeStatsTab === "tab-decomp") {
        renderDecompositionView();
      } else if (state.activeStatsTab === "tab-calibration") {
        renderCalibrationView();
      } else if (state.activeStatsTab === "tab-horizon") {
        renderHorizonBarChart(rankings);
      }
    },
  });
}

// ----------------------------------------------------------------------------
// Presentation / Focus Mode
// ----------------------------------------------------------------------------

export function togglePresentationMode(forceState) {
  const isNowPres = typeof forceState === "boolean"
    ? document.body.classList.toggle("presentation-mode", forceState)
    : document.body.classList.toggle("presentation-mode");

  const btnFocus = document.getElementById("btn-focus-mode");
  if (btnFocus) {
    const textSpan = btnFocus.querySelector(".nav-btn-text");
    if (textSpan) {
      textSpan.textContent = isNowPres ? "Exit Focus" : "Presentation";
    }
  }

  const forecastPlot = document.getElementById("forecast-plot");
  const isTimelineView = state.currentView === "timeline";
  if (forecastPlot) {
    forecastPlot.style.display = isTimelineView ? "" : "none";
    forecastPlot.classList.toggle("hidden", !isTimelineView);
  }
  [["spatial", "spatial-container"], ["heatmap", "heatmap-container"], ["peak", "peak-container"]].forEach(([view, id]) => {
    document.getElementById(id)?.classList.toggle("hidden", state.currentView !== view);
  });

  updatePresentationControls();
  updatePresentationActiveFeatures();

  if (state.currentView === "spatial") {
    if (state.spatialData) {
      renderSpatialMap();
    }
    triggerPlotResizeSequence("spatial-map-plot");
  } else if (state.currentView === "heatmap") {
    if (state.heatmapData) {
      renderHeatmapPlot();
    }
    triggerPlotResizeSequence("heatmap-plot");
  } else if (state.currentView === "peak") {
    if (state.peakData) renderPeakView();
  } else {
    if (state.currentForecastData) {
      renderForecastPlot(state.currentForecastData);
    }
    triggerPlotResizeSequence("forecast-plot");
  }
}

export async function fetchAndRenderHeatmapMain() {
  await fetchAndRenderHeatmap({
    onHeaderUpdate: updateHeaderContext,
    onUrlUpdate: updateUrlParams,
    onOpenMethodology: openMethodologyModal,
    onSwitchView: (v) => switchViewMode(v, viewCallbacks()),
  });
}
window.__retryHeatmap = () => fetchAndRenderHeatmapMain();

export function updatePresentationControls() {
  const presDateLabel = document.getElementById("pres-date-label");
  if (presDateLabel) {
    presDateLabel.textContent = state.selectedDate || "--";
  }

  const isSpatial = state.currentView === "spatial";

  // Prediction intervals only apply to the timeline fan chart
  const presPiWrapper = document.getElementById("pres-pi-menu")?.parentElement;
  if (presPiWrapper) presPiWrapper.style.display = state.currentView === "timeline" ? "" : "none";

  const presToggleTruth = document.getElementById("pres-toggle-truth");
  if (presToggleTruth) {
    presToggleTruth.style.display = isSpatial ? "none" : "";
    presToggleTruth.classList.toggle("active", state.showTruth);
  }

  const btnIndicators = document.getElementById("btn-indicators-toggle");
  if (btnIndicators && isSpatial) {
    btnIndicators.style.display = "none";
    btnIndicators.classList.add("hidden");
  }
}

export function updatePresentationActiveFeatures() {
  const bar = document.getElementById("pres-active-features-bar");
  const container = document.getElementById("pres-active-features-chips");
  if (!bar || !container) return;

  const isPres = document.body.classList.contains("presentation-mode");
  const isTimeline = state.currentView === "timeline";
  const isDrawerClosed = !state.indicators || !state.indicators.isOpen;
  const count = state.indicators ? state.indicators.active.size : 0;

  if (!isPres || !isTimeline || !isDrawerClosed || count === 0) {
    bar.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  bar.classList.remove("hidden");
  container.innerHTML = "";

  const isNorm = state.indicators && state.indicators.mode === "normalized";
  const label = bar.querySelector(".pres-active-features-label");
  if (label) {
    label.textContent = isNorm ? "ACTIVE SIGNALS (NORMALIZED):" : "ACTIVE SIGNALS:";
  }

  state.indicators.active.forEach((key) => {
    const meta = INDICATOR_META[key] || { name: key, shortLabel: key, pipClass: "pip-ma2" };
    const chip = document.createElement("span");
    chip.className = "pres-indicator-chip";
    const name = escapeHtml(meta.name || meta.shortLabel);
    chip.innerHTML = `
      <span class="indicator-color-pip ${escapeHtml(meta.pipClass)}"></span>
      <span>${name}</span>
      <button type="button" class="pres-chip-remove" data-indicator="${escapeHtml(key)}" title="Dismiss ${name}" aria-label="Dismiss ${name}">&times;</button>
    `;
    container.appendChild(chip);
  });
}

// Prediction interval levels offered on the fan chart (outermost first)
const PI_OPTIONS = [
  { level: "95", range: "q0.025 – q0.975" },
  { level: "80", range: "q0.10 – q0.90" },
  { level: "50", range: "q0.25 – q0.75" },
];

/**
 * Build the prediction-interval menus (command bar + presentation bar). Intervals are
 * multi-select; width rulers compare each model's final-horizon interval side by side.
 */
function setupPiMenus() {
  const menuHtml = `
    <div class="season-menu-header"><span>PREDICTION INTERVALS</span></div>
    <div class="season-menu-list">
      ${PI_OPTIONS.map((o) => `
        <label class="season-checkbox-item">
          <span class="season-checkbox-left"><input type="checkbox" data-pi="${o.level}">${o.level}% PI</span>
          <span class="season-dates-count">${o.range}</span>
        </label>`).join("")}
    </div>
    <div class="season-menu-header pi-menu-subheader"><span>COMPARE WIDTHS</span></div>
    <label class="season-checkbox-item" title="Solid bars beside the fan showing each model's interval width at the last horizon">
      <span class="season-checkbox-left"><input type="checkbox" data-pi-rulers>Width rulers</span>
      <span class="season-dates-count">last horizon</span>
    </label>`;

  [["btn-pi-menu", "pi-dropdown-menu"], ["pres-pi-menu", "pres-pi-dropdown-menu"]].forEach(([btnId, menuId]) => {
    const btn = document.getElementById(btnId);
    const menu = document.getElementById(menuId);
    if (!btn || !menu) return;
    menu.innerHTML = menuHtml;
    bindDropdownMenu(btn, menu);
    menu.addEventListener("change", (e) => {
      const input = e.target;
      if (input.dataset.pi) {
        if (input.checked) state.piLevels.add(input.dataset.pi);
        else state.piLevels.delete(input.dataset.pi);
      } else if (input.hasAttribute("data-pi-rulers")) {
        state.showPiRulers = input.checked;
      }
      // Interval choice changes what must fit vertically, so let the axis re-fit from scratch
      state.smartZoom.lastStableYMax = null;
      syncToggleButtons();
      updateUrlParams();
      if (state.currentForecastData) renderForecastPlot(state.currentForecastData);
    });
  });
  syncToggleButtons();
}

export function syncToggleButtons() {
  const levels = PI_OPTIONS.map((o) => o.level).filter((l) => state.piLevels.has(l));
  const piLabel = levels.length > 0 ? `${levels.join(" · ")}% PI` : "No PI";
  document.querySelectorAll(".pi-menu-btn").forEach((btn) => {
    btn.innerHTML = `${piLabel}${state.showPiRulers ? ` <span class="pi-ruler-flag" aria-label="with width rulers">${ICONS.rulers}</span>` : ""} <span class="pi-menu-caret" aria-hidden="true">▾</span>`;
    btn.classList.toggle("active", levels.length > 0 || state.showPiRulers);
  });
  document.querySelectorAll(".pi-dropdown-menu input[data-pi]").forEach((input) => {
    input.checked = state.piLevels.has(input.dataset.pi);
  });
  document.querySelectorAll(".pi-dropdown-menu input[data-pi-rulers]").forEach((input) => {
    input.checked = state.showPiRulers;
  });

  const btnToggleTruth = document.getElementById("btn-toggle-truth");
  if (btnToggleTruth) btnToggleTruth.classList.toggle("active", state.showTruth);

  const presToggleTruth = document.getElementById("pres-toggle-truth");
  if (presToggleTruth) presToggleTruth.classList.toggle("active", state.showTruth);
}

export function updateActiveIndicatorsUI() {
  if (!state.indicators) return;

  const count = state.indicators.active.size;
  const countBadge = document.getElementById("indicator-active-badge");
  const toggleBtn = document.getElementById("btn-indicators-toggle");
  const drawer = document.getElementById("indicators-drawer");
  const arrow = document.getElementById("indicators-expand-arrow");

  if (countBadge) {
    countBadge.textContent = count;
    countBadge.classList.toggle("hidden", count === 0);
  }
  if (toggleBtn) {
    toggleBtn.classList.toggle("open", state.indicators.isOpen);
    toggleBtn.classList.toggle("has-active", count > 0);
    toggleBtn.setAttribute("aria-expanded", String(state.indicators.isOpen));
  }
  if (drawer) {
    drawer.classList.toggle("collapsed", !state.indicators.isOpen);
  }
  if (arrow) {
    arrow.textContent = state.indicators.isOpen ? "▴" : "▾";
  }

  document.querySelectorAll(".indicator-checkbox").forEach((cb) => {
    cb.checked = state.indicators.active.has(cb.value);
    const parentItem = cb.closest(".indicator-item");
    if (parentItem) {
      parentItem.classList.toggle("active", cb.checked);
    }
  });

  // Peak forecast markers exist only for targets with season peak companions (hospital admissions)
  const peakItem = document.getElementById("ind-item-peak-forecasts");
  if (peakItem) {
    const ok = Boolean(state.peakTargets && state.peakTargets[state.selectedTarget]);
    const cb = peakItem.querySelector("input");
    if (cb) cb.disabled = !ok;
    peakItem.classList.toggle("disabled", !ok);
    peakItem.title = ok ? "" : "Season peak forecasts are made for hospital admissions only";
    const sub = document.getElementById("ind-peak-forecasts-sub");
    if (sub) sub.textContent = ok ? "Each model's peak week × size (▲)" : "Hospital admissions only";
  }

  document.querySelectorAll(".season-wave-pill").forEach((pill) => {
    const cb = pill.querySelector("input[type='checkbox']");
    if (cb) {
      cb.checked = state.indicators.active.has(cb.value);
      pill.classList.toggle("active", cb.checked);
    }
  });

  const isNorm = state.indicators.mode === "normalized";
  const btnDual = document.getElementById("btn-mode-dual");
  const btnNorm = document.getElementById("btn-mode-normalized");
  if (btnDual) btnDual.classList.toggle("active", !isNorm);
  if (btnNorm) btnNorm.classList.toggle("active", isNorm);

  const isMono = state.indicators.seasonPalette === "mono";
  const btnPaletteMono = document.getElementById("btn-palette-mono");
  const btnPaletteTints = document.getElementById("btn-palette-tints");
  if (btnPaletteMono) btnPaletteMono.classList.toggle("active", isMono);
  if (btnPaletteTints) btnPaletteTints.classList.toggle("active", !isMono);
  const seasonPillsWrap = document.getElementById("season-waves-pills");
  if (seasonPillsWrap) {
    seasonPillsWrap.setAttribute("data-palette", isMono ? "mono" : "tints");
  }

  const plotSubBadge = document.getElementById("plot-sub-active-badge");
  if (plotSubBadge) {
    plotSubBadge.classList.toggle("hidden", count === 0);
    if (count > 0) {
      plotSubBadge.textContent = `${count} Signal${count > 1 ? "s" : ""}${isNorm ? " (Normalized)" : ""}`;
    }
  }

  updatePresentationActiveFeatures();
}

/**
 * Dynamically renders historical season wave pills from the surveillance payload.
 */
export function renderHistoricalSeasonPills(historicalSeasons) {
  const container = document.getElementById("season-waves-pills");
  if (!container || !historicalSeasons) return;
  const seasons = Object.keys(historicalSeasons);
  if (seasons.length === 0) return;

  container.innerHTML = "";
  seasons.forEach((sKey, idx) => {
    const sInfo = historicalSeasons[sKey];
    const indVal = `season_${sKey}`;
    const cleanId = `ind-season-${sKey.replace(/[^a-zA-Z0-9]/g, "-")}`;
    const label = sInfo.label || sKey;
    const shortLabel = `'${sKey.slice(2, 4)}–'${sKey.slice(-2)}`;

    const pill = document.createElement("label");
    pill.className = "season-wave-pill";
    pill.setAttribute("data-season", sKey);
    pill.title = `${label} Wave (Aligned)`;
    const isActive = state.indicators.active.has(indVal) || (idx === 0 && state.indicators.active.has("prior_season"));
    if (isActive) {
      pill.classList.add("active");
    }

    const pipClass = `pip-s${Math.min(idx + 1, 6)}`;
    pill.innerHTML = `
      <input type="checkbox" class="indicator-checkbox season-wave-checkbox" value="${indVal}" id="${cleanId}">
      <span class="season-pill-pip ${pipClass}"></span>
      <span class="season-pill-text">${shortLabel}</span>
    `;

    const cb = pill.querySelector("input");
    cb.checked = isActive;
    cb.addEventListener("change", () => {
      if (cb.checked) {
        state.indicators.active.add(indVal);
      } else {
        state.indicators.active.delete(indVal);
        if (idx === 0) state.indicators.active.delete("prior_season");
      }
      pill.classList.toggle("active", cb.checked);
      updateActiveIndicatorsUI();
      updateUrlParams();
      if (state.currentForecastData) {
        renderForecastPlot(state.currentForecastData);
      }
    });

    container.appendChild(pill);
  });
}

// ----------------------------------------------------------------------------
// Theme Management
// ----------------------------------------------------------------------------

export function initTheme() {
  const savedTheme = localStorage.getItem("flusight_theme") || "dark";
  setTheme(savedTheme, false);

  const btnThemeToggle = document.getElementById("btn-theme-toggle");
  if (btnThemeToggle) {
    btnThemeToggle.addEventListener("click", () => {
      const isCurrentlyLight = document.body.classList.contains("theme-light");
      setTheme(isCurrentlyLight ? "dark" : "light", true);
    });
  }
}

export function setTheme(theme, rerenderPlots = true) {
  const isLight = theme === "light";
  document.documentElement.classList.toggle("theme-light", isLight);
  document.body.classList.toggle("theme-light", isLight);
  try {
    localStorage.setItem("flusight_theme", isLight ? "light" : "dark");
  } catch (e) {}

  const btnThemeToggle = document.getElementById("btn-theme-toggle");
  if (btnThemeToggle) {
    btnThemeToggle.setAttribute("aria-checked", isLight ? "true" : "false");
    btnThemeToggle.title = isLight
      ? "Switch to Dark Mode (Current: Solarized Light)"
      : "Switch to Solarized Light Mode (Current: Dark)";
  }

  if (rerenderPlots) {
    if (state.currentView === "spatial") {
      renderSpatialMap();
    } else if (state.currentView === "heatmap") {
      renderHeatmapPlot();
    } else if (state.currentView === "peak") {
      if (state.peakData) renderPeakView();
    } else if (state.currentForecastData) {
      renderForecastPlot(state.currentForecastData);
    }
    if (state.latestRankings && state.latestRankings.length > 0) {
      renderHorizonBarChart(state.latestRankings);
    }
  }
}

// ----------------------------------------------------------------------------
// Export Dropdown & File Download
// ----------------------------------------------------------------------------

export function setupExportDropdown() {
  const btnExport = document.getElementById("btn-export-csv");
  const menu = document.getElementById("export-dropdown-menu");
  if (!btnExport || !menu) return;

  const savedFormat = localStorage.getItem("flusight_export_format") || "csv";
  setActiveExportFormat(savedFormat, false);

  btnExport.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.contains("open");
    toggleExportDropdown(!isOpen);
  });

  menu.querySelectorAll(".export-menu-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const format = item.getAttribute("data-format") || "csv";
      setActiveExportFormat(format, true);
      toggleExportDropdown(false);
      exportEvaluation(format);
    });
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".export-dropdown-wrapper")) {
      toggleExportDropdown(false);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      toggleExportDropdown(false);
    }
  });
}

function toggleExportDropdown(open) {
  const btnExport = document.getElementById("btn-export-csv");
  const menu = document.getElementById("export-dropdown-menu");
  if (!menu) return;
  if (open) {
    menu.classList.add("open");
    if (btnExport) {
      btnExport.classList.add("is-active");
      btnExport.setAttribute("aria-expanded", "true");
    }
  } else {
    menu.classList.remove("open");
    if (btnExport) {
      btnExport.classList.remove("is-active");
      btnExport.setAttribute("aria-expanded", "false");
    }
  }
}

function setActiveExportFormat(format, persist = true) {
  const validFormats = ["csv", "tsv", "xlsx"];
  const fmt = validFormats.includes(format) ? format : "csv";
  if (persist) {
    try {
      localStorage.setItem("flusight_export_format", fmt);
    } catch (_) {}
  }
  const label = document.getElementById("export-btn-label");
  if (label) {
    label.textContent = fmt.toUpperCase();
  }
  document.querySelectorAll(".export-menu-item").forEach((item) => {
    const isMatch = item.getAttribute("data-format") === fmt;
    item.classList.toggle("active", isMatch);
    const check = item.querySelector(".export-item-check");
    if (check) check.innerHTML = isMatch ? ICONS.check : "";
  });
}

function triggerBlobDownload(blob, filename) {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.setAttribute("href", blobUrl);
  a.setAttribute("download", filename);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
}

export async function exportEvaluation(format = "csv") {
  const btnExport = document.getElementById("btn-export-csv");
  const textSpan = document.getElementById("export-btn-label") || (btnExport ? btnExport.querySelector(".table-micro-text") : null);
  const originalText = textSpan ? textSpan.textContent : format.toUpperCase();

  const selectedModelIds = state.selectedModels.size > 0
    ? Array.from(state.selectedModels)
    : (state.currentView === "spatial" && state.spatialActiveModel ? [state.spatialActiveModel] : []);

  if (selectedModelIds.length === 0) {
    alert("Please select one or more models to export.");
    return;
  }

  if (textSpan) textSpan.textContent = "Exporting...";

  try {
    let locParam = state.selectedLocation || "US";
    let scopeName = "current_location";
    if (state.evalLocScope === "states") {
      locParam = "states";
      scopeName = "all_states";
    }

    const scope = resolveEvalScope();
    const dateParam = scope.date;
    const seasonParam = scope.season;
    const timeScopeName = scope.fileTag || "scope";

    let rankings = [];
    if (state.latestRankings && state.latestRankings.length > 0) {
      const cachedMap = new Map(state.latestRankings.map((r) => [r.model_id, r]));
      if (selectedModelIds.every((id) => cachedMap.has(id))) {
        rankings = selectedModelIds.map((id) => cachedMap.get(id)).filter(Boolean);
      }
    }

    if (rankings.length === 0) {
      const data = await fetchMetrics({
        target: state.selectedTarget,
        location: locParam,
        date: dateParam,
        season: seasonParam,
        weeks: scope.weeks,
        phase: scope.phase,
        models: selectedModelIds,
        fair: state.fairCommonTasks,
      });
      const resMap = new Map((data.rankings || []).map((r) => [r.model_id, r]));
      rankings = selectedModelIds.map((id) => resMap.get(id)).filter(Boolean);
    }

    if (rankings.length === 0) {
      alert("No evaluation metrics available for the selected models in this scope.");
      if (textSpan) textSpan.textContent = originalText;
      return;
    }

    const sortKey = state.sortKey || "wis";
    const sortAsc = state.sortAsc !== false;
    rankings.sort((a, b) => {
      let valA = extractModelSortValue(a, sortKey);
      let valB = extractModelSortValue(b, sortKey);
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;
      if (typeof valA === "string") {
        return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      return sortAsc ? valA - valB : valB - valA;
    });

    const headers = [
      "rank",
      "model_id",
      "model_type",
      "quantiles",
      "tasks_evaluated",
      "overall_wis",
      "relative_wis",
      "weeks_won",
      "weeks_competed",
      "pct_diff_vs_baseline",
      "wis_per_100k",
      "baseline_model",
      "mae",
      "coverage_95_pct",
      "coverage_50_pct",
      "sharpness",
      "h0_wis_nowcast",
      "h1_wis_1wk",
      "h2_wis_2wk",
      "h3_wis_3wk",
      "target",
      "evaluation_location",
      "evaluation_scope",
      "reference_date",
      "time_window",
      "common_tasks_fair",
    ];

    const rawRows = rankings.map((r, idx) => {
      const b0 = r.by_horizon && (r.by_horizon[0] || r.by_horizon["0"]);
      const b1 = r.by_horizon && (r.by_horizon[1] || r.by_horizon["1"]);
      const b2 = r.by_horizon && (r.by_horizon[2] || r.by_horizon["2"]);
      const b3 = r.by_horizon && (r.by_horizon[3] || r.by_horizon["3"]);

      const h0 = b0 && b0.wis !== null && b0.wis !== undefined ? Number(b0.wis.toFixed(2)) : null;
      const h1 = b1 && b1.wis !== null && b1.wis !== undefined ? Number(b1.wis.toFixed(2)) : null;
      const h2 = b2 && b2.wis !== null && b2.wis !== undefined ? Number(b2.wis.toFixed(2)) : null;
      const h3 = b3 && b3.wis !== null && b3.wis !== undefined ? Number(b3.wis.toFixed(2)) : null;
      const qCount = r.quantile_count || (r.has_23_quantiles ? 23 : 7);

      const relWis = r.relative_wis !== null && r.relative_wis !== undefined ? Number(r.relative_wis.toFixed(3)) : null;
      const rateWis = r.wis_per_100k !== null && r.wis_per_100k !== undefined ? Number(r.wis_per_100k.toFixed(2)) : null;

      return [
        idx + 1,
        r.model_id,
        r.is_synthetic ? "synthetic" : (state.models[r.model_id]?.source === "hub" ? `hub:${state.models[r.model_id].hub}` : (r.is_local ? "local" : "repo")),
        qCount,
        r.count !== null && r.count !== undefined ? r.count : null,
        r.wis !== null && r.wis !== undefined ? Number(r.wis.toFixed(2)) : null,
        relWis,
        (state.evalScale === "log" ? r.weeks_won_log : r.weeks_won) ?? null,
        r.weeks_competed ?? null,
        r.pct_diff_vs_baseline !== null && r.pct_diff_vs_baseline !== undefined ? Number(r.pct_diff_vs_baseline.toFixed(1)) : null,
        rateWis,
        r.baseline_model || "",
        r.mae !== null && r.mae !== undefined ? Number(r.mae.toFixed(2)) : null,
        r.cov95 !== null && r.cov95 !== undefined ? Number(r.cov95.toFixed(1)) : null,
        r.cov50 !== null && r.cov50 !== undefined ? Number(r.cov50.toFixed(1)) : null,
        r.sharpness !== null && r.sharpness !== undefined ? Number(r.sharpness.toFixed(1)) : null,
        h0,
        h1,
        h2,
        h3,
        state.selectedTarget,
        locParam,
        scopeName,
        dateParam,
        scope.label,
        state.fairCommonTasks ? "true" : "false",
      ];
    });

    let modelSlug = selectedModelIds.length === 1
      ? selectedModelIds[0]
      : (selectedModelIds.length <= 3 ? selectedModelIds.join("_") : `${selectedModelIds.length}_models`);
    modelSlug = modelSlug.replace(/[^a-zA-Z0-9_\-]/g, "_");
    const targetSlug = (state.selectedTarget || "flusight").replace(/\s+/g, "_");
    const baseFilename = `flusight_eval_${modelSlug}_${locParam}_${timeScopeName}_${targetSlug}`;

    if (format === "xlsx") {
      if (typeof window.XLSX === "undefined") {
        throw new Error("XLSX export library is not available. Please refresh the page.");
      }
      const dataGrid = [
        headers,
        ...rawRows.map((row) => row.map((cell) => (cell === null || cell === undefined ? "" : cell))),
      ];
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(dataGrid);
      XLSX.utils.book_append_sheet(wb, ws, "Evaluation");
      const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const blob = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      triggerBlobDownload(blob, `${baseFilename}.xlsx`);
    } else if (format === "tsv") {
      const tsvRows = rawRows.map((row) =>
        row
          .map((val) => {
            if (val === null || val === undefined) return "";
            if (typeof val === "number") return val;
            return String(val).replace(/[\t\r\n]/g, " ");
          })
          .join("\t")
      );
      const tsvContent = "\uFEFF" + [headers.join("\t"), ...tsvRows].join("\r\n");
      const blob = new Blob([tsvContent], { type: "text/tab-separated-values;charset=utf-8;" });
      triggerBlobDownload(blob, `${baseFilename}.tsv`);
    } else {
      const csvRows = rawRows.map((row) =>
        row
          .map((val) => {
            if (val === null || val === undefined) return "";
            if (typeof val === "number") return val;
            return `"${String(val).replace(/"/g, '""')}"`;
          })
          .join(",")
      );
      const csvContent = "\uFEFF" + [headers.join(","), ...csvRows].join("\r\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      triggerBlobDownload(blob, `${baseFilename}.csv`);
    }

    if (textSpan) {
      textSpan.textContent = "Exported!";
      setTimeout(() => {
        textSpan.textContent = format.toUpperCase();
      }, 1800);
    }
  } catch (err) {
    console.error(`Error exporting evaluation ${format.toUpperCase()}:`, err);
    alert(`Failed to export evaluation ${format.toUpperCase()}. Please try again.`);
    if (textSpan) textSpan.textContent = originalText;
  }
}

// ----------------------------------------------------------------------------
// Helpers for Evaluation Scope Switching
// ----------------------------------------------------------------------------

function setEvalLocScope(locScope) {
  const wasActive = state.evalLocScope === locScope;
  state.evalLocScope = locScope;
  document.querySelectorAll("#eval-loc-segmented .segment-btn").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-loc") === locScope);
  });
  fetchAndRenderMetricsMain(wasActive);
}

function setEvalHorizonScope(horizonScope) {
  // "date" = the selected reference date; "window" = seasons / weeks / phase from the evaluation window menu
  state.evalHorizonScope = horizonScope === "window" ? "window" : "date";
  updateEvalWindowButton();
  fetchAndRenderMetricsMain();
}

function setEvalScale(scale) {
  state.evalScale = scale;
  document.querySelectorAll("#eval-scale-segmented .segment-btn").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-scale") === scale);
  });
  updateUrlParams();
  sortAndRenderTable();
}

// ----------------------------------------------------------------------------
// Event Listeners Wire-Up
// ----------------------------------------------------------------------------

export function setupEventListeners() {
  // Target switcher buttons
  document.querySelectorAll("#target-segmented .segment-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#target-segmented .segment-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.selectedTarget = btn.getAttribute("data-target");
      updateHeaderContext();
      updateActiveIndicatorsUI();
      renderModelChips({ onSelectionChange: refreshAll, onModelInspect: openModelDetailsModal });
      refreshAll();
    });
  });

  // Quick location segmented buttons
  document.querySelectorAll("#quick-loc-segmented .segment-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#quick-loc-segmented .segment-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const loc = btn.getAttribute("data-loc");
      state.selectedLocation = loc;
      const locationSelect = document.getElementById("location-select");
      if (locationSelect) locationSelect.value = loc;
      updateHeaderContext();
      refreshAll();
    });
  });

  // Location dropdown change
  const locationSelect = document.getElementById("location-select");
  if (locationSelect) {
    locationSelect.addEventListener("change", (e) => {
      state.selectedLocation = e.target.value;
      document.querySelectorAll("#quick-loc-segmented .segment-btn").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-loc") === state.selectedLocation);
      });
      updateHeaderContext();
      refreshAll();
    });
  }

  // Date stepper & dropdown
  const dateSelect = document.getElementById("date-select");
  if (dateSelect) {
    dateSelect.addEventListener("change", (e) => {
      state.selectedDate = e.target.value;
      updateHeaderContext();
      refreshAll();
    });
  }

  const prevDateBtn = document.getElementById("prev-date-btn");
  if (prevDateBtn) {
    prevDateBtn.addEventListener("click", () => stepPreviousDate(refreshAll));
  }
  const nextDateBtn = document.getElementById("next-date-btn");
  if (nextDateBtn) {
    nextDateBtn.addEventListener("click", () => stepNextDate(refreshAll));
  }

  initCustomDatePicker(refreshAll);

  // Keyboard navigation
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const datePopover = document.getElementById("custom-date-popover");
      if (datePopover && !datePopover.classList.contains("hidden")) {
        closeCustomDatePicker();
        return;
      }
      if (document.body.classList.contains("presentation-mode")) {
        togglePresentationMode(false);
        return;
      }
      const modelDetailModal = document.getElementById("model-detail-modal");
      if (modelDetailModal && !modelDetailModal.classList.contains("hidden")) {
        hideModelDetailsModal();
        return;
      }
      const definitionPopover = document.getElementById("definition-popover");
      if (definitionPopover && !definitionPopover.classList.contains("hidden")) {
        hideDefinitionPopover();
        return;
      }
      const studioModal = document.getElementById("ensemble-studio-modal");
      if (studioModal && !studioModal.classList.contains("hidden")) {
        closeEnsembleStudio();
        return;
      }
      if (isRemoteHubModalOpen()) {
        closeRemoteHubModal();
        return;
      }
      closeMethodologyModal();
      return;
    }

    if (e.key === "/" && e.target.tagName !== "INPUT" && e.target.tagName !== "SELECT" && e.target.tagName !== "TEXTAREA") {
      e.preventDefault();
      const modelSearchInput = document.getElementById("model-search-input");
      if (modelSearchInput) {
        modelSearchInput.focus();
        modelSearchInput.select();
      }
      return;
    }

    if ((e.key === "f" || e.key === "F") && e.target.tagName !== "INPUT" && e.target.tagName !== "SELECT" && e.target.tagName !== "TEXTAREA") {
      e.preventDefault();
      togglePresentationMode();
      return;
    }

    if ((e.key === "i" || e.key === "I") && e.target.tagName !== "INPUT" && e.target.tagName !== "SELECT" && e.target.tagName !== "TEXTAREA") {
      if (state.currentView === "spatial") {
        e.preventDefault();
        toggleSpatialInspector();
        return;
      }
      if (state.currentView === "heatmap") {
        e.preventDefault();
        toggleHeatmapInspector();
        return;
      }
    }

    if ((e.key === "h" || e.key === "H") && e.target.tagName !== "INPUT" && e.target.tagName !== "SELECT" && e.target.tagName !== "TEXTAREA") {
      e.preventDefault();
      switchViewMode("heatmap", viewCallbacks());
      return;
    }

    if ((e.key === "p" || e.key === "P") && !e.metaKey && !e.ctrlKey && e.target.tagName !== "INPUT" && e.target.tagName !== "SELECT" && e.target.tagName !== "TEXTAREA") {
      e.preventDefault();
      switchViewMode(state.currentView === "peak" ? "timeline" : "peak", viewCallbacks());
      return;
    }

    if ((e.key === "c" || e.key === "C") && e.target.tagName !== "INPUT" && e.target.tagName !== "SELECT" && e.target.tagName !== "TEXTAREA") {
      e.preventDefault();
      shuffleModelColors({
        onColorChange: () => {
          renderModelChips({ onSelectionChange: refreshAll, onModelInspect: openModelDetailsModal });
          if (state.currentView === "timeline" && state.currentForecastData) {
            renderForecastPlot(state.currentForecastData);
          } else if (state.currentView === "spatial" && state.spatialData) {
            renderSpatialMap();
          } else if (state.currentView === "heatmap" && state.heatmapData) {
            renderHeatmapPlot();
          } else if (state.currentView === "peak" && state.peakData) {
            renderPeakView();
          }
          sortAndRenderTable();
        },
      });
      return;
    }

    if ((e.key === "t" || e.key === "T") && e.target.tagName !== "INPUT" && e.target.tagName !== "SELECT" && e.target.tagName !== "TEXTAREA") {
      e.preventDefault();
      const isCurrentlyLight = document.body.classList.contains("theme-light");
      setTheme(isCurrentlyLight ? "dark" : "light", true);
      return;
    }

    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      stepPreviousDate(refreshAll);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      stepNextDate(refreshAll);
    }
  });

  // Display toggles (synchronized across command bar and presentation focus bar)
  setupPiMenus();

  const toggleTruthHandler = () => {
    state.showTruth = !state.showTruth;
    syncToggleButtons();
    if (state.currentForecastData) {
      renderForecastPlot(state.currentForecastData);
    } else {
      fetchAndRenderForecast();
    }
  };
  const btnToggleTruth = document.getElementById("btn-toggle-truth");
  if (btnToggleTruth) btnToggleTruth.addEventListener("click", toggleTruthHandler);
  const presToggleTruth = document.getElementById("pres-toggle-truth");
  if (presToggleTruth) presToggleTruth.addEventListener("click", toggleTruthHandler);

  const presPrevDate = document.getElementById("pres-prev-date");
  if (presPrevDate) presPrevDate.addEventListener("click", () => stepPreviousDate(refreshAll));
  const presNextDate = document.getElementById("pres-next-date");
  if (presNextDate) presNextDate.addEventListener("click", () => stepNextDate(refreshAll));

  // Model search
  const modelSearchInput = document.getElementById("model-search-input");
  const modelSearchClear = document.getElementById("model-search-clear");
  const modelsChipStrip = document.getElementById("models-chip-strip");
  const btnToggleExpandModels = document.getElementById("btn-toggle-expand-models");

  if (modelSearchInput) {
    modelSearchInput.addEventListener("input", (e) => {
      state.modelSearchQuery = e.target.value.trim();
      if (modelSearchClear) {
        modelSearchClear.classList.toggle("hidden", state.modelSearchQuery.length === 0);
      }
      if (state.modelSearchQuery.length > 0 && !state.isModelsExpanded) {
        state.isModelsExpanded = true;
        if (modelsChipStrip) modelsChipStrip.classList.remove("collapsed");
        if (btnToggleExpandModels) btnToggleExpandModels.classList.add("expanded");
      }
      renderModelChips({ onSelectionChange: refreshAll, onModelInspect: openModelDetailsModal });
    });
  }

  if (modelSearchClear) {
    modelSearchClear.addEventListener("click", () => {
      if (modelSearchInput) {
        modelSearchInput.value = "";
        modelSearchInput.focus();
      }
      state.modelSearchQuery = "";
      modelSearchClear.classList.add("hidden");
      renderModelChips({ onSelectionChange: refreshAll, onModelInspect: openModelDetailsModal });
    });
  }

  // Model Family Select
  const modelsFamilySelect = document.getElementById("models-family-select");
  if (modelsFamilySelect) {
    modelsFamilySelect.addEventListener("change", (e) => {
      state.modelFamilyFilter = e.target.value;
      renderModelChips({ onSelectionChange: refreshAll, onModelInspect: openModelDetailsModal });
    });
  }

  // Model Season Select
  const modelsSeasonSelect = document.getElementById("models-season-select");
  if (modelsSeasonSelect) {
    modelsSeasonSelect.addEventListener("change", (e) => {
      handleSeasonFilterClick(e.target.value, { onSelectionChange: refreshAll, onModelInspect: openModelDetailsModal });
    });
  }

  // Quick Action Buttons
  const triggerColorShuffle = () => {
    shuffleModelColors({
      onColorChange: () => {
        renderModelChips({ onSelectionChange: refreshAll, onModelInspect: openModelDetailsModal });
        if (state.currentView === "timeline" && state.currentForecastData) {
          renderForecastPlot(state.currentForecastData);
        } else if (state.currentView === "spatial" && state.spatialData) {
          renderSpatialMap();
        } else if (state.currentView === "heatmap" && state.heatmapData) {
          renderHeatmapPlot();
        } else if (state.currentView === "peak" && state.peakData) {
          renderPeakView();
        }
        sortAndRenderTable();
      },
    });
  };

  const btnShuffleColors = document.getElementById("btn-shuffle-colors");
  if (btnShuffleColors) {
    btnShuffleColors.addEventListener("click", triggerColorShuffle);
  }
  const presShuffleColors = document.getElementById("pres-shuffle-colors");
  if (presShuffleColors) {
    presShuffleColors.addEventListener("click", triggerColorShuffle);
  }

  const btnFilterSelectAll = document.getElementById("btn-filter-select-all");
  if (btnFilterSelectAll) {
    btnFilterSelectAll.addEventListener("click", () => {
      state.smartZoom.lastStableYMax = null;
      // Hub models have their own Select all in the hub row
      const filtered = getFilteredWorkspaceModels();
      filtered.forEach((id) => state.selectedModels.add(id));
      renderModelChips({ onSelectionChange: refreshAll, onModelInspect: openModelDetailsModal });
      refreshAll();
    });
  }

  const btnFilterClear = document.getElementById("btn-filter-clear");
  if (btnFilterClear) {
    btnFilterClear.addEventListener("click", () => {
      state.smartZoom.lastStableYMax = null;
      state.selectedModels.clear();
      renderModelChips({ onSelectionChange: refreshAll, onModelInspect: openModelDetailsModal });
      refreshAll();
    });
  }


  if (btnToggleExpandModels) {
    btnToggleExpandModels.addEventListener("click", () => {
      state.isModelsExpanded = !state.isModelsExpanded;
      if (modelsChipStrip) {
        modelsChipStrip.classList.toggle("collapsed", !state.isModelsExpanded);
      }
      btnToggleExpandModels.classList.toggle("expanded", state.isModelsExpanded);
      btnToggleExpandModels.setAttribute("aria-expanded", String(state.isModelsExpanded));
      const modelsExpandText = document.getElementById("models-expand-text");
      if (modelsExpandText) {
        const count = getFilteredWorkspaceModels().length;
        modelsExpandText.textContent = state.isModelsExpanded
          ? `Collapse drawer (${count})`
          : `Show all models (${count})`;
      }
    });
  }

  // Info Definition Trigger Popover
  document.addEventListener("click", (e) => {
    const trigger = e.target.closest(".info-trigger-btn");
    if (trigger) {
      e.stopPropagation();
      e.preventDefault();
      const term = trigger.getAttribute("data-term");
      if (state.activePopoverTerm === term) {
        hideDefinitionPopover();
      } else {
        showDefinitionPopover(term, trigger);
      }
      return;
    }

    const definitionPopover = document.getElementById("definition-popover");
    if (definitionPopover && !definitionPopover.classList.contains("hidden")) {
      if (!e.target.closest("#definition-popover")) {
        hideDefinitionPopover();
      }
    }
  });

  const popoverCloseBtn = document.getElementById("popover-close-btn");
  if (popoverCloseBtn) popoverCloseBtn.addEventListener("click", hideDefinitionPopover);

  const popoverMethodologyBtn = document.getElementById("popover-methodology-btn");
  if (popoverMethodologyBtn) {
    popoverMethodologyBtn.addEventListener("click", () => {
      const sectionId = state.activePopoverSectionId;
      hideDefinitionPopover();
      openMethodologyModal(sectionId);
    });
  }

  window.addEventListener("resize", () => {
    if (state.activePopoverTerm) hideDefinitionPopover();
    if (state.currentView === "spatial") {
      Plotly.Plots.resize("spatial-map-plot");
    } else if (state.currentView === "heatmap") {
      Plotly.Plots.resize("heatmap-plot");
    } else if (state.currentView === "peak") {
      resizePeakPlots();
    } else {
      Plotly.Plots.resize("forecast-plot");
    }
  });

  // Location & Horizon Scope Buttons
  document.querySelectorAll("#eval-loc-segmented .segment-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const loc = btn.getAttribute("data-loc");
      setEvalLocScope(loc);
    });
  });

  document.querySelector('#eval-horizon-segmented .segment-btn[data-horizon="date"]')?.addEventListener("click", () => {
    setEvalHorizonScope("date");
  });
  initEvalWindow({ onApply: () => setEvalHorizonScope("window") });

  // Scale (Natural vs Log) Buttons
  document.querySelectorAll("#eval-scale-segmented .segment-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sc = btn.getAttribute("data-scale");
      setEvalScale(sc);
    });
  });

  // Fair Common Tasks Toggle
  const btnToggleFair = document.getElementById("btn-toggle-fair");
  if (btnToggleFair) {
    btnToggleFair.addEventListener("click", () => {
      if (btnToggleFair.classList.contains("loading")) return;
      state.fairCommonTasks = !state.fairCommonTasks;
      btnToggleFair.classList.toggle("active", state.fairCommonTasks);
      btnToggleFair.textContent = state.fairCommonTasks ? "Common Tasks: ON" : "Common Tasks: OFF";
      fetchAndRenderMetricsMain();
    });
  }

  // Methodology Modal controls
  const btnOpenMethodologyNav = document.getElementById("btn-open-methodology-nav");
  if (btnOpenMethodologyNav) btnOpenMethodologyNav.addEventListener("click", () => openMethodologyModal());
  const btnOpenMethodology = document.getElementById("btn-open-methodology");
  if (btnOpenMethodology) btnOpenMethodology.addEventListener("click", () => openMethodologyModal());
  const btnCloseMethodology = document.getElementById("btn-close-methodology");
  if (btnCloseMethodology) btnCloseMethodology.addEventListener("click", closeMethodologyModal);
  const methodologyModal = document.getElementById("methodology-modal");
  if (methodologyModal) {
    methodologyModal.addEventListener("click", (e) => {
      if (e.target === methodologyModal) closeMethodologyModal();
    });
  }

  // Model Details Modal controls
  const btnCloseModelDetail = document.getElementById("btn-close-model-detail");
  if (btnCloseModelDetail) btnCloseModelDetail.addEventListener("click", hideModelDetailsModal);
  const btnCloseModelDetailBottom = document.getElementById("btn-close-model-detail-bottom");
  if (btnCloseModelDetailBottom) btnCloseModelDetailBottom.addEventListener("click", hideModelDetailsModal);
  const modelDetailModal = document.getElementById("model-detail-modal");
  if (modelDetailModal) {
    modelDetailModal.addEventListener("click", (e) => {
      if (e.target === modelDetailModal) hideModelDetailsModal();
    });
  }

  const mdTabs = document.getElementById("md-tabs");
  if (mdTabs) {
    mdTabs.querySelectorAll(".model-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        mdTabs.querySelectorAll(".model-tab-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.activeModelDetailTab = btn.getAttribute("data-tab");
        const mdModalBody = document.getElementById("md-modal-body");
        if (mdModalBody) mdModalBody.scrollTop = 0;
        if (state.currentDetailModel && state.modelDetailCache[state.currentDetailModel]) {
          renderModelDetailActiveTab(state.modelDetailCache[state.currentDetailModel]);
        }
      });
    });
  }

  const mdBtnToggleSelect = document.getElementById("md-btn-toggle-select");
  if (mdBtnToggleSelect) {
    mdBtnToggleSelect.addEventListener("click", () => {
      const mid = state.currentDetailModel;
      if (!mid) return;
      if (state.selectedModels.has(mid)) {
        state.selectedModels.delete(mid);
      } else {
        state.selectedModels.add(mid);
      }
      updateModelDetailSelectButton(mid);
      renderModelChips({ onSelectionChange: refreshAll, onModelInspect: openModelDetailsModal });
      refreshAll();
    });
  }

  // Delegated click for model inspection links (leaderboard, diagnostics, etc.)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-model-inspect-link");
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      const mid = btn.getAttribute("data-model");
      if (mid && typeof openModelDetailsModal === "function") {
        openModelDetailsModal(mid);
      }
      return;
    }

    const tile = e.target.closest(".matrix-tile.submitted");
    if (tile) {
      e.preventDefault();
      e.stopPropagation();
      const targetDate = tile.getAttribute("data-date");
      const targetModel = tile.getAttribute("data-model");
      if (targetDate) {
        state.selectedDate = targetDate;
        const dateSelect = document.getElementById("date-select");
        if (dateSelect) dateSelect.value = targetDate;
        if (targetModel) {
          state.selectedModels.add(targetModel);
        }
        hideModelDetailsModal();
        updateCustomDatePickerTrigger();
        updateHeaderContext();
        renderModelChips({ onSelectionChange: refreshAll, onModelInspect: openModelDetailsModal });
        refreshAll();
        window.dispatchEvent(new CustomEvent("sandbox:date-selected", { detail: { date: targetDate, model: targetModel } }));
      }
    }
  });

  // Header quick actions
  const btnCopyCli = document.getElementById("btn-copy-cli");
  if (btnCopyCli) {
    btnCopyCli.addEventListener("click", () => {
      // Mirror the leaderboard scope; the CLI only scores repository/local models, so hub models are left out
      const models = Array.from(state.selectedModels).filter((id) => state.models[id]?.source !== "hub").join(",") || "all";
      const loc = state.evalLocScope === "states" ? "states" : (state.selectedLocation || "US");
      const scope = resolveEvalScope();
      const target = state.selectedTarget ? ` --target "${state.selectedTarget}"` : "";
      const fair = state.fairCommonTasks ? " --fair" : "";
      const cmd = `python3 viz/score_cli.py --models ${models} ${scope.cliArgs} --location ${loc}${target}${fair}`;
      navigator.clipboard.writeText(cmd).then(() => {
        const textSpan = btnCopyCli.querySelector(".nav-btn-text");
        if (textSpan) {
          const original = textSpan.textContent;
          textSpan.textContent = "Copied!";
          setTimeout(() => { textSpan.textContent = original; }, 1800);
        }
      }).catch(() => {
        prompt("Copy CLI evaluation command:", cmd);
      });
    });
  }

  const btnShareLink = document.getElementById("btn-share-link");
  if (btnShareLink) {
    btnShareLink.addEventListener("click", () => {
      navigator.clipboard.writeText(window.location.href).then(() => {
        const textSpan = btnShareLink.querySelector(".nav-btn-text");
        if (textSpan) {
          const original = textSpan.textContent;
          textSpan.textContent = "Copied!";
          setTimeout(() => { textSpan.textContent = original; }, 1800);
        }
      }).catch(() => {
        prompt("Share view link:", window.location.href);
      });
    });
  }

  setupExportDropdown();
  setupDiagnosticsControls();

  // Focus mode
  const btnFocusMode = document.getElementById("btn-focus-mode");
  if (btnFocusMode) btnFocusMode.addEventListener("click", () => togglePresentationMode());
  const presBtnExit = document.getElementById("pres-btn-exit");
  if (presBtnExit) presBtnExit.addEventListener("click", () => togglePresentationMode(false));

  // Diagnostics Tabs
  document.querySelectorAll(".panel-tabs .tab-trigger").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".panel-tabs .tab-trigger").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      const targetId = tab.getAttribute("data-tab");
      state.activeStatsTab = targetId;
      const targetContent = document.getElementById(targetId);
      if (targetContent) targetContent.classList.add("active");

      if (targetId === "tab-decomp") {
        renderDecompositionView();
      } else if (targetId === "tab-calibration") {
        renderCalibrationView();
      } else if (targetId === "tab-horizon") {
        renderHorizonBarChart(state.latestRankings);
      }
    });
  });

  // Table header sorting
  document.querySelectorAll(".data-table th.sortable").forEach((th) => {
    th.addEventListener("click", (e) => {
      if (e.target.closest(".info-trigger-btn") || e.target.closest(".info-tooltip-popover")) {
        return;
      }
      const key = th.getAttribute("data-sort");
      if (state.sortKey === key) {
        state.sortAsc = !state.sortAsc;
      } else {
        state.sortKey = key;
        state.sortAsc = key === "wis" || key === "mae" || key === "rank" || key === "relative_wis" || key === "wis_per_100k" || key.startsWith("h");
      }
      sortAndRenderTable();
    });
  });

  // View mode switcher: Timeline vs Spatial
  const btnViewTimeline = document.getElementById("btn-view-timeline");
  const btnViewSpatial = document.getElementById("btn-view-spatial");
  if (btnViewTimeline) {
    btnViewTimeline.addEventListener("click", () => switchViewMode("timeline", viewCallbacks()));
  }
  if (btnViewSpatial) {
    btnViewSpatial.addEventListener("click", () => switchViewMode("spatial", viewCallbacks()));
  }
  const btnViewHeatmap = document.getElementById("btn-view-heatmap");
  if (btnViewHeatmap) {
    btnViewHeatmap.addEventListener("click", () => switchViewMode("heatmap", viewCallbacks()));
  }
  const btnViewPeak = document.getElementById("btn-view-peak");
  if (btnViewPeak) {
    btnViewPeak.addEventListener("click", () => switchViewMode("peak", viewCallbacks()));
  }
  initPeakControls({ onUrlUpdate: updateUrlParams });

  // Spatial controls
  const spatialHorizonSegmented = document.getElementById("spatial-horizon-segmented");
  if (spatialHorizonSegmented) {
    spatialHorizonSegmented.querySelectorAll(".segment-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        spatialHorizonSegmented.querySelectorAll(".segment-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.spatialActiveHorizon = parseInt(btn.getAttribute("data-h"), 10) || 0;
        renderSpatialMap();
        updateSpatialInspector();
        updateHeaderContext();
      });
    });
  }

  const btnSpatialPlay = document.getElementById("btn-spatial-play");
  if (btnSpatialPlay) {
    btnSpatialPlay.addEventListener("click", () => toggleSpatialPlayback(updateHeaderContext));
  }

  const btnToggleInspector = document.getElementById("btn-toggle-inspector");
  if (btnToggleInspector) btnToggleInspector.addEventListener("click", () => toggleSpatialInspector());
  const btnExpandInspector = document.getElementById("btn-expand-inspector");
  if (btnExpandInspector) btnExpandInspector.addEventListener("click", () => toggleSpatialInspector(true));

  const spatialModelSelect = document.getElementById("spatial-model-select");
  if (spatialModelSelect) {
    spatialModelSelect.addEventListener("change", (e) => {
      state.spatialActiveModel = e.target.value || null;
      renderSpatialMap();
      updateSpatialInspector();
      updateSpatialInsights();
    });
  }

  const spatialLayerSelect = document.getElementById("spatial-layer-select");
  if (spatialLayerSelect) {
    spatialLayerSelect.addEventListener("change", (e) => {
      state.spatialActiveLayer = e.target.value;
      renderSpatialMap();
      updateSpatialInspector();
    });
  }

  const btnH0JumpH1 = document.getElementById("btn-h0-jump-h1");
  if (btnH0JumpH1) {
    btnH0JumpH1.addEventListener("click", () => {
      document.querySelector('#spatial-horizon-segmented .segment-btn[data-h="1"]')?.click();
    });
  }

  const btnSpatialGuide = document.getElementById("btn-spatial-guide");
  if (btnSpatialGuide) btnSpatialGuide.addEventListener("click", () => openMethodologyModal("methodology-part2-heading"));

  // Inspector: open the selected state's fan chart in the timeline view
  const btnInspJumpTimeline = document.getElementById("btn-insp-jump-timeline");
  if (btnInspJumpTimeline) {
    btnInspJumpTimeline.addEventListener("click", () => {
      const fips = state.spatialData?.states?.[state.spatialSelectedState]?.fips;
      if (!fips || !locationSelect) return;
      document.getElementById("btn-view-timeline")?.click();
      locationSelect.value = fips;
      locationSelect.dispatchEvent(new Event("change"));
    });
  }

  // Surveillance Signals & Indicators
  const btnIndicatorsToggle = document.getElementById("btn-indicators-toggle");
  if (btnIndicatorsToggle) {
    btnIndicatorsToggle.addEventListener("click", () => {
      state.indicators.isOpen = !state.indicators.isOpen;
      updateActiveIndicatorsUI();
      triggerPlotResizeSequence("forecast-plot");
    });
  }

  const btnModeDual = document.getElementById("btn-mode-dual");
  const btnModeNorm = document.getElementById("btn-mode-normalized");
  if (btnModeDual) {
    btnModeDual.addEventListener("click", () => {
      state.indicators.mode = "dual";
      state.smartZoom.isUserZoomedY = false;
      state.smartZoom.userYRange = null;
      state.smartZoom.lastStableYMax = null;
      updateActiveIndicatorsUI();
      updateUrlParams();
      if (state.currentForecastData) renderForecastPlot(state.currentForecastData);
    });
  }
  if (btnModeNorm) {
    btnModeNorm.addEventListener("click", () => {
      state.indicators.mode = "normalized";
      state.smartZoom.isUserZoomedY = false;
      state.smartZoom.userYRange = null;
      state.smartZoom.lastStableYMax = null;
      updateActiveIndicatorsUI();
      updateUrlParams();
      if (state.currentForecastData) renderForecastPlot(state.currentForecastData);
    });
  }

  const btnPaletteMono = document.getElementById("btn-palette-mono");
  const btnPaletteTints = document.getElementById("btn-palette-tints");
  if (btnPaletteMono) {
    btnPaletteMono.addEventListener("click", () => {
      state.indicators.seasonPalette = "mono";
      updateActiveIndicatorsUI();
      updateUrlParams();
      if (state.currentForecastData) renderForecastPlot(state.currentForecastData);
    });
  }
  if (btnPaletteTints) {
    btnPaletteTints.addEventListener("click", () => {
      state.indicators.seasonPalette = "tints";
      updateActiveIndicatorsUI();
      updateUrlParams();
      if (state.currentForecastData) renderForecastPlot(state.currentForecastData);
    });
  }

  document.querySelectorAll(".indicator-checkbox").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const indKey = e.target.value;
      if (e.target.checked) {
        state.indicators.active.add(indKey);
      } else {
        state.indicators.active.delete(indKey);
      }
      updateActiveIndicatorsUI();
      updateUrlParams();
      if (state.currentForecastData) renderForecastPlot(state.currentForecastData);
    });
  });

  const btnResetInds = document.getElementById("btn-reset-indicators");
  if (btnResetInds) {
    btnResetInds.addEventListener("click", () => {
      state.indicators.active.clear();
      updateActiveIndicatorsUI();
      updateUrlParams();
      if (state.currentForecastData) renderForecastPlot(state.currentForecastData);
    });
  }

  setupMethodologySearch();
}

// Auto-run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
