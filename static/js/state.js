/**
 * FluSight Sandbox Lab — Application State & Color Management
 */
import { PALETTE, formatMsToIsoDate } from "./constants.js";

export const state = {
  models: {},
  recommendedModels: [],
  selectedModels: new Set(),
  locations: [],
  dates: [],
  forecastDates: [],
  dateInfo: {},
  targets: ["wk inc flu hosp", "wk inc flu prop ed visits"],
  targetsMeta: {},
  latestSeason: "",
  latestDate: "",
  selectedTarget: "wk inc flu hosp",
  selectedLocation: "US",
  selectedDate: "",
  piLevels: new Set(["95"]), // Prediction intervals drawn on the fan chart: any of "95", "80", "50"
  showPiRulers: false, // Final-horizon interval width rulers beside the fan
  showTruth: true,
  evalLocScope: "current", // 'current', 'states'
  evalHorizonScope: "date", // "date" or "window" (seasons / weeks / phase)
  evalScale: "natural", // 'natural', 'log'
  evalFocalSeason: "",
  evalWindow: { seasons: null, weeks: null, phase: null }, // seasons null = follow the selected date
  forecastSeasons: [],
  seasonSummaries: [],
  evalScopeMeta: null,
  fairCommonTasks: false,
  sortKey: "wis",
  sortAsc: true,
  latestRankings: [],
  latestBaselineModel: null,
  latestValidationWarnings: [],
  modelColors: {},
  modelSearchQuery: "",
  modelFamilyFilter: "all",
  modelSeasonFilters: new Set(),
  isModelsExpanded: false,
  activePopoverTerm: null,
  activePopoverSectionId: null,
  currentDetailModel: null,
  modelDetailCache: {},
  // Live hub data (brand menu) and the hub shelf in the model bar
  remoteHubs: [],
  hubShelfOpen: (() => {
    try {
      return JSON.parse(localStorage.getItem("flusight_hub_shelves") || "{}") || {};
    } catch (e) {
      return {};
    }
  })(),
  hubRoundOnly: true,
  hubDesignatedOnly: false,
  truthInfo: null,
  activeModelDetailTab: "coverage",
  // Synthetic Ensemble Studio State
  ensemblesList: [],
  ensembleStudioOpen: false,
  // Spatial Map State
  currentView: "timeline", // 'timeline', 'spatial', 'heatmap', or 'peak'
  // Season peak forecasts: weekly target -> {size, timing} companion targets (from /api/metadata)
  peakTargets: {},
  peakData: null,
  peakEvolutionModel: null,
  peakScoreMode: "round", // 'round' (this round's calls) or 'skill' (season scores once the peak is final)
  peakSkillScope: "location", // 'location' or 'states'
  spatialData: null,
  spatialActiveHorizon: 1, // 0..3
  spatialActiveLayer: "rate", // 'rate', 'count', 'trend', 'wis'
  spatialActiveModel: null,
  spatialPlayInterval: null,
  spatialSelectedState: null,
  // Heatmap State
  heatmapData: null,
  heatmapRows: "location", // 'location', 'model', 'date', 'horizon'
  heatmapCols: "date", // 'date', 'horizon', 'location', 'model'
  heatmapLocScope: "states", // 'states' | 'current'
  heatmapTimeScope: "season", // 'date' | 'season' | 'custom' | 'all'
  heatmapSelectedSeasons: new Set(),
  heatmapMetric: "rate", // 'rate', 'count', 'trend', 'wis', 'mae', 'cov95', 'sharpness'
  heatmapSeason: "2024-2025",
  heatmapSortBy: "hhs_region", // 'hhs_region', 'peak_timing', 'magnitude', 'population', 'alphabetical'
  heatmapNormalize: "none", // 'none', 'row_min_max'
  heatmapPalette: "YlOrRd",
  heatmapReversePalette: false,
  heatmapActiveHorizon: 1, // 0..3
  heatmapActiveModel: null,
  heatmapSelectedCell: null,
  heatmapInspectorOpen: true,
  heatmapIncludeInactive: false,
  // Forecast Data Cache
  currentForecastData: null,
  // Smart Zoom & Viewport Tracking State
  smartZoom: {
    isUserZoomedX: false,
    isUserZoomedY: false,
    userOffsetDaysLeft: null,   // days relative to refDate (start - refDate)
    userOffsetDaysRight: null,  // days relative to refDate (end - refDate)
    userSpanDays: null,
    currentX0: null,            // ms timestamp
    currentX1: null,            // ms timestamp
    lastRefDate: null,
    lastLocation: null,
    lastTarget: null,
    userYRange: null,           // [y0, y1]
    lastStableYMax: null,       // Primary y-axis ceiling, held across dates for stability (null = re-fit)
    lastSecondaryRanges: {},    // Indicator axes (y2/y3) ranges, stabilized the same way
  },
  // Diagnostics & Evaluation Suite State
  decompScale: "absolute", // 'absolute' or 'relative'
  activeStatsTab: "tab-table", // 'tab-table', 'tab-decomp', 'tab-calibration', 'tab-horizon'
  // Surveillance Signals & Indicators State
  indicators: {
    isOpen: false,
    mode: "dual", // 'dual' | 'normalized'
    seasonPalette: "mono", // 'mono' | 'tints'
    normBaseline: "full_season", // 'full_season' (focal season peak) | 'history' (peak observed up to ref date)
    active: new Set(),
  },
};

export function getSeasonForDate(dateStr) {
  if (!dateStr) {
    return state.latestSeason || `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`;
  }
  try {
    const parts = dateStr.split("-").map((p) => parseInt(p, 10));
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    // Accurate MMWR season boundary (week 31 cutoff)
    const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const startSun = new Date(Date.UTC(d.getUTCFullYear(), 0, 4 - ((jan4.getUTCDay() + 1) % 7)));
    let ewYear = d.getUTCFullYear();
    let start = startSun;
    if (d < startSun) {
      const prevJan4 = new Date(Date.UTC(d.getUTCFullYear() - 1, 0, 4));
      start = new Date(Date.UTC(d.getUTCFullYear() - 1, 0, 4 - ((prevJan4.getUTCDay() + 1) % 7)));
      ewYear = d.getUTCFullYear() - 1;
    } else {
      const nextJan4 = new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 4));
      const nextStartSun = new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 4 - ((nextJan4.getUTCDay() + 1) % 7)));
      if (d >= nextStartSun) {
        start = nextStartSun;
        ewYear = d.getUTCFullYear() + 1;
      }
    }
    const diffDays = Math.floor((d - start) / 86400000);
    const mmwrWeek = Math.floor(diffDays / 7) + 1;
    const seasonStart = mmwrWeek >= 31 ? ewYear : ewYear - 1;
    return `${seasonStart}-${seasonStart + 1}`;
  } catch (e) {
    return state.latestSeason || "2024-2025";
  }
}


export function formatSeasonShort(seasonStr) {
  if (!seasonStr) return "";
  const match = seasonStr.match(/(\d{4})[-/](\d{2,4})/);
  if (match) {
    const y1 = match[1].slice(2);
    const y2 = match[2].length === 4 ? match[2].slice(2) : match[2];
    return `'${y1}–'${y2}`;
  }
  return seasonStr;
}

export function assignModelColors() {
  // Repository/local/synthetic models keep the colors they had before any hub was synced, and a color
  // already assigned (e.g. after a shuffle) survives inventory reloads; hub models continue the palette.
  const ids = Object.keys(state.models);
  const workspace = ids.filter((id) => state.models[id]?.source !== "hub");
  const hub = ids.filter((id) => state.models[id]?.source === "hub");
  [...workspace, ...hub].forEach((id, idx) => {
    if (!state.modelColors[id]) state.modelColors[id] = PALETTE[idx % PALETTE.length];
  });
}

export function shuffleModelColors(callbacks = {}) {
  const modelIds = Object.keys(state.models);
  if (modelIds.length === 0) return;

  const shuffledPalette = [...PALETTE];
  for (let i = shuffledPalette.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledPalette[i], shuffledPalette[j]] = [shuffledPalette[j], shuffledPalette[i]];
  }

  const selected = Array.from(state.selectedModels);
  const unselected = modelIds.filter((m) => !state.selectedModels.has(m));

  selected.forEach((id, idx) => {
    state.modelColors[id] = shuffledPalette[idx % shuffledPalette.length];
  });

  const offset = selected.length;
  unselected.forEach((id, idx) => {
    state.modelColors[id] = shuffledPalette[(offset + idx) % shuffledPalette.length];
  });

  if (callbacks.onColorChange) {
    callbacks.onColorChange();
  }
}

export function parseUrlParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.has("models")) {
    const raw = params.get("models");
    state.selectedModels.clear();
    state.missingUrlModels = [];
    if (raw && raw !== "none") {
      raw.split(",").forEach((m) => {
        const trimmed = m.trim();
        if (trimmed && state.models[trimmed]) {
          state.selectedModels.add(trimmed);
        } else if (trimmed) {
          state.missingUrlModels.push(trimmed);
        }
      });
    }
  } else {
    if (state.selectedModels.size === 0) {
      if (state.recommendedModels && state.recommendedModels.length > 0) {
        state.recommendedModels.slice(0, 3).forEach((m) => {
          if (state.models[m]) state.selectedModels.add(m);
        });
      }
      if (state.selectedModels.size === 0) {
        const allKeys = Object.keys(state.models);
        if (allKeys.length > 0) {
          state.selectedModels.add(allKeys[0]);
          if (allKeys.length > 1) state.selectedModels.add(allKeys[1]);
        }
      }
    }
  }

  if (params.has("date")) {
    const d = params.get("date");
    if (state.dates.includes(d)) {
      state.selectedDate = d;
      const dateSelect = document.getElementById("date-select");
      if (dateSelect) dateSelect.value = d;
    }
  }

  if (params.has("loc") && state.locations.some((loc) => loc.id === params.get("loc"))) {
    const l = params.get("loc");
    state.selectedLocation = l;
    const locationSelect = document.getElementById("location-select");
    if (locationSelect) locationSelect.value = l;
    document.querySelectorAll("#quick-loc-segmented .segment-btn").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-loc") === l);
    });
  }

  if (params.has("target")) {
    const t = params.get("target");
    if (state.targets.includes(t)) {
      state.selectedTarget = t;
      document.querySelectorAll("#target-segmented .segment-btn").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-target") === t);
      });
    }
  }

  if (params.has("scale")) {
    const sc = params.get("scale");
    if (sc === "log" || sc === "natural") {
      state.evalScale = sc;
    }
  }

  if (params.has("view")) {
    const v = params.get("view");
    if (v === "spatial" || v === "timeline" || v === "heatmap" || v === "peak") {
      state.currentView = v;
    }
  }
  if (params.has("peak_model")) {
    state.peakEvolutionModel = params.get("peak_model") || null;
  }

  if (params.has("hm_rows")) {
    state.heatmapRows = params.get("hm_rows");
  }
  if (params.has("hm_cols")) {
    state.heatmapCols = params.get("hm_cols");
  }
  if (params.has("hm_loc")) {
    state.heatmapLocScope = params.get("hm_loc");
  }
  if (params.has("hm_time")) {
    state.heatmapTimeScope = params.get("hm_time");
  }
  if (params.has("hm_metric")) {
    state.heatmapMetric = params.get("hm_metric");
  }
  if (params.has("hm_season")) {
    state.heatmapSeason = params.get("hm_season");
  }
  if (params.has("hm_sort")) {
    state.heatmapSortBy = params.get("hm_sort");
  }
  if (params.has("hm_norm")) {
    state.heatmapNormalize = params.get("hm_norm");
  }
  if (params.has("hm_pal")) {
    state.heatmapPalette = params.get("hm_pal");
  }

  if (params.has("indicators")) {
    const raw = params.get("indicators");
    raw.split(",").forEach((ind) => {
      const trimmed = ind.trim();
      // Indicator keys are short identifiers (e.g. "nssp", "season_2023/24"); ignore anything else
      if (/^[a-z0-9_]+(\/\d{2})?$/.test(trimmed)) {
        state.indicators.active.add(trimmed);
      }
    });
  }

  if (params.has("pi")) {
    state.piLevels = new Set(params.get("pi").split(",").filter((l) => ["95", "80", "50"].includes(l)));
  }
  state.showPiRulers = params.get("rulers") === "1";

  if (params.get("ind_mode") === "normalized") {
    state.indicators.mode = "normalized";
  }
  if (params.get("ind_palette") === "tints") {
    state.indicators.seasonPalette = "tints";
  } else if (params.get("ind_palette") === "mono") {
    state.indicators.seasonPalette = "mono";
  }
}

export function updateUrlParams() {
  const url = new URL(window.location);
  url.searchParams.set("loc", state.selectedLocation);
  url.searchParams.set("target", state.selectedTarget);
  url.searchParams.set("date", state.selectedDate);
  if (state.evalScale === "log") {
    url.searchParams.set("scale", "log");
  } else {
    url.searchParams.delete("scale");
  }
  // View-specific parameters: clear every view's keys, then set the active view's
  ["hm_rows", "hm_cols", "hm_loc", "hm_time", "hm_metric", "hm_season", "hm_sort", "hm_norm", "peak_model"].forEach((k) =>
    url.searchParams.delete(k)
  );
  if (state.currentView === "spatial") {
    url.searchParams.set("view", "spatial");
  } else if (state.currentView === "heatmap") {
    url.searchParams.set("view", "heatmap");
    url.searchParams.set("hm_rows", state.heatmapRows);
    url.searchParams.set("hm_cols", state.heatmapCols);
    url.searchParams.set("hm_loc", state.heatmapLocScope);
    url.searchParams.set("hm_time", state.heatmapTimeScope);
    url.searchParams.set("hm_metric", state.heatmapMetric);
    if (state.heatmapSeason) url.searchParams.set("hm_season", state.heatmapSeason);
    if (state.heatmapSortBy !== "hhs_region") url.searchParams.set("hm_sort", state.heatmapSortBy);
    if (state.heatmapNormalize !== "none") url.searchParams.set("hm_norm", state.heatmapNormalize);
  } else if (state.currentView === "peak") {
    url.searchParams.set("view", "peak");
    if (state.peakEvolutionModel) url.searchParams.set("peak_model", state.peakEvolutionModel);
  } else {
    url.searchParams.delete("view");
  }

  const piParam = ["95", "80", "50"].filter((l) => state.piLevels.has(l)).join(",");
  if (piParam === "95") {
    url.searchParams.delete("pi");
  } else {
    url.searchParams.set("pi", piParam || "none");
  }
  if (state.showPiRulers) {
    url.searchParams.set("rulers", "1");
  } else {
    url.searchParams.delete("rulers");
  }

  // An explicit "none" keeps a shared zero-model link from falling back to the recommended set
  url.searchParams.set("models", state.selectedModels.size > 0 ? Array.from(state.selectedModels).join(",") : "none");

  if (state.indicators && state.indicators.active && state.indicators.active.size > 0) {
    url.searchParams.set("indicators", Array.from(state.indicators.active).join(","));
    if (state.indicators.mode === "normalized") {
      url.searchParams.set("ind_mode", "normalized");
    } else {
      url.searchParams.delete("ind_mode");
    }
    if (state.indicators.seasonPalette === "tints") {
      url.searchParams.set("ind_palette", "tints");
    } else {
      url.searchParams.delete("ind_palette");
    }
  } else {
    url.searchParams.delete("indicators");
    url.searchParams.delete("ind_mode");
    url.searchParams.delete("ind_palette");
  }

  window.history.replaceState({}, "", url);
}
