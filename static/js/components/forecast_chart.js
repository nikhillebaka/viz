/**
 * FluSight Sandbox Lab — Hero Forecast Fan Chart & Signal Overlays
 * Powered by Plotly with Smart Y-Axis Stabilization & Viewport Tracking.
 * Refactored for modularity, strict statistical correctness, and dynamic configuration.
 */

import {
  parseIsoDateToMs,
  formatMsToIsoDate,
  hexToRgba,
  CHART_CONSTANTS,
  TECHNICAL_INDICATORS,
  getChartThemeColors,
  PALETTE,
  modelLabel,
} from "../constants.js";
import { state } from "../state.js";
import { peakHoverHtml, fmtCount, fmtWeek } from "./peak_view.js";

// Reentrancy guard to prevent relayout feedback loops
let activeProgrammaticUpdates = 0;

/**
 * Calculates a clean, human-friendly round ceiling for chart axes.
 * Uses a pure mathematical logarithmic scale to eliminate hardcoded lookup tables.
 */
export function getNiceRoundCeiling(val) {
  if (!val || isNaN(val) || val <= 0) {
    return 100;
  }

  const exp = Math.floor(Math.log10(val));
  const frac = val / Math.pow(10, exp);

  if (val < 1.0) {
    const steps = [1.2, 1.5, 2.0, 2.5, 3.5, 5.0, 7.5, 10.0];
    const niceFrac = steps.find((s) => frac <= s + 1e-9) || 10.0;
    const result = niceFrac * Math.pow(10, exp);
    const precision = Math.max(0, -exp + 2);
    return Number(result.toFixed(precision));
  }

  const steps = [1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 7.5, 8.0, 9.0, 10.0];
  const niceFrac = steps.find((s) => frac <= s + 1e-9) || 10.0;
  return Math.round(niceFrac * Math.pow(10, exp));
}

/**
 * Pure function: calculates the active horizontal range [X_min, X_max] in ISO string dates.
 */
export function computeTargetXRange(refDate, smartZoom) {
  const refMs = parseIsoDateToMs(refDate);
  if (isNaN(refMs)) {
    return null;
  }

  const dateChanged = Boolean(smartZoom.lastRefDate && smartZoom.lastRefDate !== refDate);

  if (
    smartZoom.isUserZoomedX &&
    smartZoom.userOffsetDaysLeft !== null &&
    smartZoom.userOffsetDaysRight !== null
  ) {
    if (!dateChanged && smartZoom.currentX0 && smartZoom.currentX1) {
      return [
        formatMsToIsoDate(smartZoom.currentX0),
        formatMsToIsoDate(smartZoom.currentX1),
      ];
    }

    const newX0 = refMs + smartZoom.userOffsetDaysLeft * CHART_CONSTANTS.DAY_MS;
    const newX1 = refMs + smartZoom.userOffsetDaysRight * CHART_CONSTANTS.DAY_MS;
    smartZoom.currentX0 = newX0;
    smartZoom.currentX1 = newX1;
    smartZoom.lastRefDate = refDate;
    smartZoom.isUserZoomedY = false;
    smartZoom.userYRange = null;

    return [
      formatMsToIsoDate(newX0),
      formatMsToIsoDate(newX1),
    ];
  }

  const defX0 = refMs - CHART_CONSTANTS.DEFAULT_WEEKS_PAST * CHART_CONSTANTS.WEEK_MS;
  const defX1 = refMs + CHART_CONSTANTS.DEFAULT_WEEKS_FUTURE * CHART_CONSTANTS.WEEK_MS;
  smartZoom.currentX0 = defX0;
  smartZoom.currentX1 = defX1;
  smartZoom.lastRefDate = refDate;

  return [
    formatMsToIsoDate(defX0),
    formatMsToIsoDate(defX1),
  ];
}

/**
 * Rounds an axis bound up to a clean value: tens on the normalized % axis, nice steps otherwise.
 */
function niceAxisBound(val, isNorm) {
  return isNorm ? Math.ceil(val / 10) * 10 : getNiceRoundCeiling(val);
}

/**
 * Applies temporal hysteresis to one axis bound (a non-negative magnitude). The previous bound is
 * kept while it still contains the data and is at most HOLD_RATIO looser than the fitted bound;
 * beyond that it eases halfway (geometric mean) toward the fitted bound instead of snapping.
 */
function stabilizeBound(required, fitted, previous, isNorm) {
  if (!(previous > 0) || previous < required) return fitted;
  if (previous <= fitted * CHART_CONSTANTS.Y_HOLD_RATIO) return previous;
  return Math.max(fitted, niceAxisBound(Math.sqrt(previous * fitted), isNorm));
}

/**
 * Computes a stable range for one y-axis of the fan chart.
 *
 * Accuracy comes first: the range always contains every visible value on that axis inside the
 * x window (truth, medians, every displayed interval band and ruler, indicators, reference lines),
 * so nothing is clipped or capped. Stability comes second: when stepping between dates the previous
 * range is held or eased (see stabilizeBound), so a wide peak-week forecast does not make the next
 * week's axis collapse abruptly. Returns null for a secondary axis with nothing visible on it.
 */
export function computeSmartYRange(
  traces,
  targetXRange,
  isNorm,
  lastRange,
  contextChanged,
  targetMeta = null,
  { axis = "y", referenceLevels = [] } = {}
) {
  let xMinMs = -Infinity;
  let xMaxMs = Infinity;
  if (targetXRange && targetXRange.length === 2) {
    const t0 = parseIsoDateToMs(targetXRange[0]);
    const t1 = parseIsoDateToMs(targetXRange[1]);
    if (!isNaN(t0) && !isNaN(t1)) {
      xMinMs = Math.min(t0, t1) - 2 * CHART_CONSTANTS.DAY_MS;
      xMaxMs = Math.max(t0, t1) + 2 * CHART_CONSTANTS.DAY_MS;
    }
  }

  let maxVal = -Infinity;
  let minVal = Infinity;
  traces.forEach((tr) => {
    if ((tr.yaxis || "y") !== axis || tr.visible === false || tr.visible === "legendonly") return;
    if (!tr.x || !tr.y) return;
    for (let i = 0; i < tr.x.length; i++) {
      const yVal = tr.y[i];
      if (yVal === null || yVal === undefined || !Number.isFinite(Number(yVal))) continue;
      const xMs = parseIsoDateToMs(tr.x[i]);
      if (!isNaN(xMs) && (xMs < xMinMs || xMs > xMaxMs)) continue;
      maxVal = Math.max(maxVal, Number(yVal));
      minVal = Math.min(minVal, Number(yVal));
    }
  });
  referenceLevels.forEach((v) => {
    if (Number.isFinite(v)) maxVal = Math.max(maxVal, v);
  });

  const isPrimary = axis === "y";
  const headroom = CHART_CONSTANTS.Y_CEILING_HEADROOM_MULTIPLIER;
  if (!Number.isFinite(maxVal)) {
    if (!isPrimary) return null;
    if (isNorm) return [0, 110];
    const isRateTarget = targetMeta?.is_rate ?? (state.selectedTarget === "wk inc flu prop ed visits");
    return isRateTarget ? [0, 0.1] : [0, 100];
  }

  // The normalized axis always keeps the 100% (peak) reference in view
  const peakFloor = isPrimary && isNorm ? 100 : 0;
  const requiredUpper = Math.max(maxVal, peakFloor) * headroom;
  const fittedUpper = requiredUpper > 0 ? niceAxisBound(requiredUpper, isNorm) : 0;
  const prev = contextChanged ? null : lastRange;
  let upper = stabilizeBound(requiredUpper, fittedUpper, prev?.[1], isNorm);

  // The primary axis is always non-negative; secondary derivative axes may dip below zero
  let lower = 0;
  if (!isPrimary && minVal < 0) {
    const requiredLower = -minVal * headroom;
    lower = -stabilizeBound(requiredLower, niceAxisBound(requiredLower, isNorm), prev ? -prev[0] : null, isNorm);
  }
  if (upper <= lower) upper = lower + (isNorm ? 10 : niceAxisBound(Math.abs(lower) || 1, isNorm));
  return [lower, upper];
}

/**
 * Builds all Plotly data traces including ground truth, forecast intervals,
 * and technical/surveillance indicators.
 */
// Prediction interval bands drawn on the fan chart, outermost first, with fill opacity per level
const PI_BANDS = [
  { level: "95", alpha: 0.1 },
  { level: "80", alpha: 0.12 },
  { level: "50", alpha: 0.18 },
];

// Missing or non-numeric surveillance values become null, so Plotly leaves a gap instead of a false drop to 0
const numOrNull = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function buildForecastTraces(data, state, theme, isNorm, truthMax, targetMeta) {
  const traces = [];
  const truth = data.truth || { history: [], future: [], anchor: null };
  const unitLabel = targetMeta?.unit || (isNorm ? "%" : "Patients / Wk");

  const scaleVal = (v) => {
    if (v === null || v === undefined || isNaN(v)) return null;
    return isNorm ? (Number(v) / truthMax) * 100 : Number(v);
  };

  // 1. Reported History
  if (state.showTruth && truth.history.length > 0) {
    traces.push({
      x: truth.history.map((d) => d.date),
      y: truth.history.map((d) => scaleVal(d.value)),
      customdata: truth.history.map((d) => d.value),
      name: isNorm ? "Reported History (Norm)" : "Reported History",
      type: "scatter",
      mode: "lines+markers",
      line: { color: theme.truthHistLine, width: 2 },
      marker: { size: 5, color: theme.truthHistMarker },
      hoverinfo: "skip",
      leftMarginLabel: {
        text: "History",
        color: theme.truthHistMarker,
        yaxis: "y",
      },
    });
  }

  // 2. Oracle Forecast Outcomes
  const anchor = truth.anchor;
  if (state.showTruth && truth.future.length > 0) {
    const futDates = (anchor ? [anchor.date] : []).concat(truth.future.map((d) => d.date));
    const futRawVals = (anchor ? [anchor.value] : []).concat(truth.future.map((d) => d.value));
    const futVals = futRawVals.map((v) => scaleVal(v));

    traces.push({
      x: futDates,
      y: futVals,
      customdata: futRawVals,
      name: isNorm ? "Oracle Outcome (Norm)" : "Oracle Outcome (Truth)",
      type: "scatter",
      mode: "lines+markers",
      line: { color: theme.truthFutLine, width: 2, dash: "dash" },
      marker: {
        size: futDates.map((d, i) => (anchor && i === 0 ? 0 : 7)),
        color: theme.truthFutMarker,
        symbol: "diamond",
      },
      hoverinfo: "skip",
    });
  }

  // 3. Rest of Known Season Truth
  const seasonRemainder = truth.season_remainder || [];
  if (state.showTruth && seasonRemainder.length > 1) {
    traces.push({
      x: seasonRemainder.map((d) => d.date),
      y: seasonRemainder.map((d) => scaleVal(d.value)),
      customdata: seasonRemainder.map((d) => d.value),
      name: isNorm ? "Rest of Season (Norm)" : "Rest of Season (Truth)",
      type: "scatter",
      mode: "lines",
      line: {
        color: theme.truthRestLine,
        width: 1.2,
      },
      hoverinfo: "skip",
    });
  }

  // 4. Model Quantile Bands & Median Trajectory
  // Strictly filters by state.selectedModels so deselected models do not display or inflate scale
  const allModels = data.models || [];
  const selectedModelsData = allModels.filter((m) => state.selectedModels.has(m.model_id));

  selectedModelsData.forEach((m) => {
    const color = state.modelColors[m.model_id] || PALETTE[0];
    const legendName = modelLabel(m.model_id, state.models[m.model_id], { withHub: true });
    const rawDates = m.target_end_dates;

    if (!rawDates || rawDates.length === 0) return;

    const dates = (anchor ? [anchor.date] : []).concat(rawDates);
    const rawMedians = (anchor ? [anchor.value] : []).concat(m.median || []);
    const medians = rawMedians.map((v) => scaleVal(v));

    // Prediction interval bands, outermost first so inner bands layer on top
    // (legendgroup links them to the median line for unified toggling)
    PI_BANDS.forEach((band) => {
      const lower = m[`q${band.level}_lower`];
      const upper = m[`q${band.level}_upper`];
      if (!state.piLevels.has(band.level) || !lower?.length || !upper?.length) return;
      const withAnchor = (arr) => (anchor ? [anchor.value] : []).concat(arr).map((v) => scaleVal(v));
      traces.push({
        x: dates,
        y: withAnchor(upper),
        type: "scatter",
        mode: "lines",
        line: { width: 0, color: "transparent" },
        legendgroup: m.model_id,
        showlegend: false,
        hoverinfo: "skip",
      });
      traces.push({
        x: dates,
        y: withAnchor(lower),
        type: "scatter",
        mode: "lines",
        line: { width: 0, color: "transparent" },
        fill: "tonexty",
        fillcolor: hexToRgba(color, band.alpha),
        name: `${legendName} (${band.level}% PI)`,
        legendgroup: m.model_id,
        showlegend: false,
        hoverinfo: "skip",
      });
    });

    // Forecast Median Trajectory
    if (medians.length > 0) {
      traces.push({
        x: dates,
        y: medians,
        name: legendName,
        legendgroup: m.model_id,
        showlegend: true,
        type: "scatter",
        mode: "lines+markers",
        line: { color: color, width: 2.5 },
        marker: {
          size: dates.map((d, i) => (anchor && i === 0 ? 0 : 6)),
          color: color,
        },
        hoverinfo: "skip",
      });
    }
  });

  // 4b. Season peak forecasts: each model's peak week × peak size as a ▲ at the medians, a 50% × 50%
  // box, and 90% whiskers, plus the observed peak (final) or the highest week so far
  const activeInds = state.indicators ? state.indicators.active : new Set();
  traces.push(...buildPeakTraces(data, theme, scaleVal));

  // 5. Surveillance Indicators & Auxiliary Streams
  const surv = data.surveillance || {};
  const isLight = document.body.classList.contains("theme-light");

  // Track whether we need secondary axes
  const hasRateInds = activeInds.has("nssp") || activeInds.has("ilinet") || activeInds.has("flusurvnet");
  const hasDerivInds = activeInds.has("velocity") || activeInds.has("growth");

  // Determine derivative axis target: if rate indicators are already on y2 in dual mode,
  // put derivatives on y3 so scales never collide
  const derivAxis = (!isNorm && hasRateInds) ? "y3" : "y2";

  // NSSP Emergency Department visits
  if (activeInds.has("nssp") && surv.nssp && surv.nssp.data && surv.nssp.data.length > 0) {
    const meta = TECHNICAL_INDICATORS.nssp;
    const nsspYRaw = surv.nssp.data.map((d) => numOrNull(d.pct));
    const nsspMax = Math.max(...nsspYRaw.filter((v) => v !== null), 0.01);
    const nsspY = isNorm ? nsspYRaw.map((v) => (v === null ? null : (v / nsspMax) * 100)) : nsspYRaw;

    traces.push({
      x: surv.nssp.data.map((d) => d.date),
      y: nsspY,
      name: meta.label,
      yaxis: isNorm ? "y" : "y2",
      type: "scatter",
      mode: "lines",
      showlegend: false,
      line: { color: isLight ? meta.colorLight : meta.colorDark, width: meta.width, dash: meta.dash },
      hoverinfo: "skip",
      leftMarginLabel: {
        text: meta.shortLabel,
        color: isLight ? meta.colorLight : meta.colorDark,
        yaxis: isNorm ? "y" : "y2",
      },
    });
  }

  // ILINet Outpatient ILI
  if (activeInds.has("ilinet") && surv.ilinet && surv.ilinet.data && surv.ilinet.data.length > 0) {
    const meta = TECHNICAL_INDICATORS.ilinet;
    const iliYRaw = surv.ilinet.data.map((d) => numOrNull(d.pct));
    const iliMax = Math.max(...iliYRaw.filter((v) => v !== null), 0.01);
    const iliY = isNorm ? iliYRaw.map((v) => (v === null ? null : (v / iliMax) * 100)) : iliYRaw;

    traces.push({
      x: surv.ilinet.data.map((d) => d.date),
      y: iliY,
      name: meta.label,
      yaxis: isNorm ? "y" : "y2",
      type: "scatter",
      mode: "lines",
      showlegend: false,
      line: { color: isLight ? meta.colorLight : meta.colorDark, width: meta.width, dash: meta.dash },
      hoverinfo: "skip",
      leftMarginLabel: {
        text: meta.shortLabel,
        color: isLight ? meta.colorLight : meta.colorDark,
        yaxis: isNorm ? "y" : "y2",
      },
    });
  }

  // FluSurv-NET Laboratory-Confirmed Hospitalization Rate
  if (activeInds.has("flusurvnet") && surv.flusurvnet && surv.flusurvnet.data && surv.flusurvnet.data.length > 0) {
    const meta = TECHNICAL_INDICATORS.flusurvnet;
    const fsnYRaw = surv.flusurvnet.data.map((d) => numOrNull(d.rate));
    const fsnMax = Math.max(...fsnYRaw.filter((v) => v !== null), 0.01);
    const fsnY = isNorm ? fsnYRaw.map((v) => (v === null ? null : (v / fsnMax) * 100)) : fsnYRaw;

    traces.push({
      x: surv.flusurvnet.data.map((d) => d.date),
      y: fsnY,
      name: meta.label,
      yaxis: isNorm ? "y" : "y2",
      type: "scatter",
      mode: "lines",
      showlegend: false,
      line: { color: isLight ? meta.colorLight : meta.colorDark, width: meta.width, dash: meta.dash },
      hoverinfo: "skip",
      leftMarginLabel: {
        text: meta.shortLabel,
        color: isLight ? meta.colorLight : meta.colorDark,
        yaxis: isNorm ? "y" : "y2",
      },
    });
  }

  // Moving Average 2-Week (MA-2)
  if (activeInds.has("ma2") && truth.history.length >= 2) {
    const meta = TECHNICAL_INDICATORS.ma2;
    const ma2Dates = [];
    const ma2Vals = [];
    for (let i = 1; i < truth.history.length; i++) {
      ma2Dates.push(truth.history[i].date);
      const avg = (truth.history[i].value + truth.history[i - 1].value) / 2;
      ma2Vals.push(isNorm ? (avg / truthMax) * 100 : avg);
    }
    traces.push({
      x: ma2Dates,
      y: ma2Vals,
      name: meta.label,
      type: "scatter",
      mode: "lines",
      showlegend: false,
      line: { color: isLight ? meta.colorLight : meta.colorDark, width: meta.width, dash: meta.dash },
      hoverinfo: "skip",
      leftMarginLabel: {
        text: meta.shortLabel,
        color: isLight ? meta.colorLight : meta.colorDark,
        yaxis: "y",
      },
    });
  }

  // Moving Average 4-Week (MA-4)
  if (activeInds.has("ma4") && truth.history.length >= 4) {
    const meta = TECHNICAL_INDICATORS.ma4;
    const ma4Dates = [];
    const ma4Vals = [];
    for (let i = 3; i < truth.history.length; i++) {
      ma4Dates.push(truth.history[i].date);
      const avg =
        (truth.history[i].value +
          truth.history[i - 1].value +
          truth.history[i - 2].value +
          truth.history[i - 3].value) /
        4;
      ma4Vals.push(isNorm ? (avg / truthMax) * 100 : avg);
    }
    traces.push({
      x: ma4Dates,
      y: ma4Vals,
      name: meta.label,
      type: "scatter",
      mode: "lines",
      showlegend: false,
      line: { color: isLight ? meta.colorLight : meta.colorDark, width: meta.width, dash: meta.dash },
      hoverinfo: "skip",
      leftMarginLabel: {
        text: meta.shortLabel,
        color: isLight ? meta.colorLight : meta.colorDark,
        yaxis: "y",
      },
    });
  }

  // Exponential Moving Average 3-Week (EMA-3)
  if (activeInds.has("ema3") && truth.history.length >= 2) {
    const meta = TECHNICAL_INDICATORS.ema3;
    const ema3Dates = [];
    const ema3Vals = [];
    const alpha = 2 / (3 + 1);
    let prev = null;
    for (let i = 0; i < truth.history.length; i++) {
      const v = truth.history[i].value;
      prev = prev === null ? v : alpha * v + (1 - alpha) * prev;
      ema3Dates.push(truth.history[i].date);
      ema3Vals.push(isNorm ? (prev / truthMax) * 100 : prev);
    }
    traces.push({
      x: ema3Dates,
      y: ema3Vals,
      name: meta.label,
      type: "scatter",
      mode: "lines",
      showlegend: false,
      line: { color: isLight ? meta.colorLight : meta.colorDark, width: meta.width, dash: meta.dash },
      hoverinfo: "skip",
      leftMarginLabel: {
        text: meta.shortLabel,
        color: isLight ? meta.colorLight : meta.colorDark,
        yaxis: "y",
      },
    });
  }

  // Week-over-Week Case Velocity (Always placed on derivative axis with signed zero baseline)
  if (activeInds.has("velocity") && truth.history.length >= 2) {
    const meta = TECHNICAL_INDICATORS.velocity;
    const velDates = [];
    const velVals = [];
    for (let i = 1; i < truth.history.length; i++) {
      velDates.push(truth.history[i].date);
      const diff = truth.history[i].value - truth.history[i - 1].value;
      velVals.push(diff);
    }
    traces.push({
      x: velDates,
      y: velVals,
      name: meta.label,
      yaxis: derivAxis,
      type: "scatter",
      mode: "lines+markers",
      showlegend: false,
      line: { color: isLight ? meta.colorLight : meta.colorDark, width: meta.width },
      marker: { size: 4, color: isLight ? meta.colorLight : meta.colorDark },
      hoverinfo: "skip",
      leftMarginLabel: {
        text: meta.shortLabel,
        color: isLight ? meta.colorLight : meta.colorDark,
        yaxis: derivAxis,
      },
    });
  }

  // Week-over-Week Growth Rate % (Always placed on derivative axis with signed zero baseline)
  if (activeInds.has("growth") && truth.history.length >= 2) {
    const meta = TECHNICAL_INDICATORS.growth;
    const growthDates = [];
    const growthVals = [];
    for (let i = 1; i < truth.history.length; i++) {
      const prev = truth.history[i - 1].value;
      if (prev > 0) {
        growthDates.push(truth.history[i].date);
        growthVals.push(((truth.history[i].value - prev) / prev) * 100);
      }
    }
    traces.push({
      x: growthDates,
      y: growthVals,
      name: meta.label,
      yaxis: derivAxis,
      type: "scatter",
      mode: "lines",
      showlegend: false,
      line: { color: isLight ? meta.colorLight : meta.colorDark, width: meta.width, dash: meta.dash },
      hoverinfo: "skip",
      leftMarginLabel: {
        text: meta.shortLabel,
        color: isLight ? meta.colorLight : meta.colorDark,
        yaxis: derivAxis,
      },
    });
  }

  // 6. Aligned Historical Season Waves (Dynamically constructed from surveillance payload)
  const isSeasonMono = (state.indicators && state.indicators.seasonPalette === "mono");
  const histSeasons = surv.historical_seasons || {};
  const seasonKeys = Object.keys(histSeasons);

  // Distinct curated tint palette for historical waves
  const seasonTintColors = [
    { dark: "rgba(251, 113, 133, 0.55)", light: "rgba(225, 29, 72, 0.55)", labelDark: "#fb7185", labelLight: "#e11d48" },
    { dark: "rgba(245, 158, 11, 0.50)", light: "rgba(180, 83, 9, 0.50)", labelDark: "#f59e0b", labelLight: "#b45309" },
    { dark: "rgba(192, 132, 252, 0.45)", light: "rgba(126, 34, 206, 0.48)", labelDark: "#c084fc", labelLight: "#7e22ce" },
    { dark: "rgba(52, 211, 153, 0.42)", light: "rgba(5, 150, 105, 0.45)", labelDark: "#34d399", labelLight: "#059669" },
    { dark: "rgba(56, 189, 248, 0.40)", light: "rgba(2, 132, 199, 0.45)", labelDark: "#38bdf8", labelLight: "#0284c7" },
  ];

  seasonKeys.forEach((sKey, sIdx) => {
    const indKey = `season_${sKey}`;
    const isSeasonActive = activeInds.has(indKey) || (sIdx === 0 && activeInds.has("prior_season"));
    if (!isSeasonActive) return;

    const sData = histSeasons[sKey];
    if (sData && sData.data && sData.data.length > 0) {
      const priorMax = sData.peak || Math.max(...sData.data.map((d) => Number(d.value) || 0), 1);
      const priorY = isNorm
        ? sData.data.map((d) => ((Number(d.value) || 0) / priorMax) * 100)
        : sData.data.map((d) => Number(d.value) || 0);

      const tintCfg = seasonTintColors[sIdx % seasonTintColors.length];
      const monoAlpha = Math.max(0.20, 0.52 - sIdx * 0.08);
      const monoColor = isLight
        ? `rgba(100, 116, 139, ${monoAlpha + 0.05})`
        : `rgba(148, 163, 184, ${monoAlpha})`;

      const lineColor = isSeasonMono
        ? monoColor
        : (isLight ? tintCfg.light : tintCfg.dark);
      const labelColor = isSeasonMono
        ? (isLight ? "#475569" : "#94a3b8")
        : (isLight ? tintCfg.labelLight : tintCfg.labelDark);

      const shortLabel = `'${sKey.slice(2, 4)}–'${sKey.slice(-2)}`;

      traces.push({
        x: sData.data.map((d) => d.date),
        y: priorY,
        name: sData.label || `${sKey} Wave`,
        type: "scatter",
        mode: "lines",
        showlegend: false,
        line: { color: lineColor, width: 1.2, dash: "solid" },
        hoverinfo: "skip",
        leftMarginLabel: {
          text: shortLabel,
          color: labelColor,
          yaxis: "y",
        },
      });
    }
  });

  // 6b. As-of Reports (Point-in-Time Surveillance Stream for Focal Season)
  const asOfStream = surv.as_of || surv.unrevised;
  if (activeInds.has("unrevised") && asOfStream && asOfStream.data && asOfStream.data.length > 0) {
    const meta = TECHNICAL_INDICATORS.unrevised;
    // Strictly cap as-of reports at the data cutoff date (target_end_date < reference_date, aligning with anchor.date)
    const cutoffDate = (anchor && anchor.date) ? anchor.date : state.selectedDate;
    const unrevData = asOfStream.data.filter((d) => d && d.date && d.date <= cutoffDate && d.date < state.selectedDate);
    if (unrevData.length > 0) {
      const unrevY = unrevData.map((d) => scaleVal(d.value));
      const faintLineColor = isLight ? meta.colorLight : meta.colorDark;
      const faintLabelColor = isLight ? "#64748b" : "#94a3b8";

      traces.push({
        x: unrevData.map((d) => d.date),
        y: unrevY,
        name: isNorm ? "As-of Reports (Norm)" : (asOfStream.label || "Target as of " + (asOfStream.as_of || cutoffDate)),
        type: "scatter",
        mode: "lines",
        showlegend: false,
        line: {
          color: faintLineColor,
          width: meta.width || 1.6,
          dash: meta.dash || "dash",
        },
        hoverinfo: "skip",
        leftMarginLabel: {
          text: meta.shortLabel,
          color: faintLabelColor,
          yaxis: "y",
        },
      });
    }
  }

  // 7. Unified Date Tracker (For cursor line and clean header banner)
  const allDatesSet = new Set();
  (truth.history || []).forEach((d) => d && d.date && allDatesSet.add(d.date));
  (truth.future || []).forEach((d) => d && d.date && allDatesSet.add(d.date));
  (truth.season_remainder || []).forEach((d) => d && d.date && allDatesSet.add(d.date));
  selectedModelsData.forEach((m) => {
    (m.target_end_dates || []).forEach((d) => d && allDatesSet.add(d));
  });
  if (anchor && anchor.date) allDatesSet.add(anchor.date);
  const allSortedDates = Array.from(allDatesSet).sort();

  if (allSortedDates.length > 0) {
    const dateToY = {};
    (truth.history || []).forEach((d) => { if (d && d.date) dateToY[d.date] = scaleVal(d.value); });
    if (anchor && anchor.date) dateToY[anchor.date] = scaleVal(anchor.value);
    (truth.future || []).forEach((d) => { if (d && d.date) dateToY[d.date] = scaleVal(d.value); });
    (truth.season_remainder || []).forEach((d) => { if (d && d.date && dateToY[d.date] === undefined) dateToY[d.date] = scaleVal(d.value); });

    traces.push({
      x: allSortedDates,
      y: allSortedDates.map((d) => dateToY[d] ?? 0),
      name: "Date",
      type: "scatter",
      mode: "lines",
      line: { color: "transparent", width: 0 },
      showlegend: false,
      hoverinfo: "x",
      hovertemplate: "%{x|%b %d, %Y}<extra></extra>",
      hoverlabel: {
        bgcolor: theme.hoverBg,
        bordercolor: theme.hoverBorder,
        font: { family: "Inter, sans-serif", color: theme.hoverText, size: 11, weight: 600 },
        align: "center",
      },
    });
  }

  return traces;
}

/** Peak forecasts drawn on the fan chart: selected models with both a peak-week and a peak-size forecast. */
function peakOverlayModels(data) {
  if (!state.indicators?.active?.has("peak_forecasts") || !data.peaks?.models) return [];
  return data.peaks.models.filter((p) => state.selectedModels.has(p.model_id) && p.timing && p.size);
}

const HALF_WEEK_MS = 3.5 * CHART_CONSTANTS.DAY_MS;

function buildPeakTraces(data, theme, scaleVal) {
  const models = peakOverlayModels(data);
  const traces = [];
  const isNorm = Boolean(state.indicators && state.indicators.mode === "normalized");
  models.forEach((p) => {
    const color = state.modelColors[p.model_id] || PALETTE[0];
    const t = p.timing;
    const s = p.size;
    const x0 = parseIsoDateToMs(t.i50[0]) - HALF_WEEK_MS;
    const x1 = parseIsoDateToMs(t.i50[1]) + HALF_WEEK_MS;
    const xm = parseIsoDateToMs(t.median);
    traces.push({
      x: [x0, x1, x1, x0, x0],
      y: [s.i50[0], s.i50[0], s.i50[1], s.i50[1], s.i50[0]].map(scaleVal),
      type: "scatter", mode: "lines", fill: "toself", fillcolor: hexToRgba(color, 0.12),
      line: { color: hexToRgba(color, 0.5), width: 1 }, legendgroup: p.model_id, showlegend: false, hoverinfo: "skip",
    });
    traces.push({
      x: [parseIsoDateToMs(t.i90[0]) - HALF_WEEK_MS, parseIsoDateToMs(t.i90[1]) + HALF_WEEK_MS, null, xm, xm],
      y: [scaleVal(s.median), scaleVal(s.median), null, scaleVal(s.i90[0]), scaleVal(s.i90[1])],
      type: "scatter", mode: "lines", line: { color: hexToRgba(color, 0.65), width: 1.1 },
      legendgroup: p.model_id, showlegend: false, hoverinfo: "skip",
    });
    traces.push({
      x: [xm], y: [scaleVal(s.median)], type: "scatter", mode: "markers", name: `${p.model_id} peak`,
      marker: { symbol: "triangle-up", size: 12, color, line: { color: theme.badgeBg, width: 1.5 } },
      legendgroup: p.model_id, showlegend: false,
      hovertemplate: `${peakHoverHtml(p, data.peaks, isNorm)}<extra></extra>`,
      hoverlabel: { align: "left" },
    });
  });
  const obs = data.peaks?.observed;
  if (models.length && obs && state.showTruth) {
    const isLight = document.body.classList.contains("theme-light");
    traces.push({
      x: [obs.date], y: [scaleVal(obs.value)], type: "scatter", mode: "markers",
      name: obs.final ? "Observed peak" : "Peak so far",
      marker: obs.final
        ? { symbol: "star", size: 14, color: isLight ? "#073642" : "#f6f4ee", line: { color: theme.badgeBg, width: 1.5 } }
        : { symbol: "diamond-open", size: 10, color: isLight ? "#073642" : "#dddddd", line: { width: 2 } },
      showlegend: false,
      hovertemplate: `<b>${obs.final ? "Observed season peak" : "Highest week so far"}</b><br>${fmtWeek(obs.date, true)}: ${fmtCount(obs.value)}<extra></extra>`,
    });
  }
  return traces;
}

/**
 * Widens the default x window so the drawn peak markers (90% timing whiskers) and the observed peak are in
 * view. Returns the range unchanged when the user has zoomed or no peak markers are drawn.
 */
export function extendXRangeForPeaks(range, data) {
  const models = data ? peakOverlayModels(data) : [];
  if (!range || models.length === 0 || state.smartZoom.isUserZoomedX) return range;
  let lo = parseIsoDateToMs(range[0]);
  let hi = parseIsoDateToMs(range[1]);
  const pad = CHART_CONSTANTS.WEEK_MS;
  models.forEach((p) => {
    lo = Math.min(lo, parseIsoDateToMs(p.timing.i90[0]) - pad);
    hi = Math.max(hi, parseIsoDateToMs(p.timing.i90[1]) + pad);
  });
  const obs = data.peaks?.observed;
  if (obs && state.showTruth) {
    lo = Math.min(lo, parseIsoDateToMs(obs.date) - pad);
    hi = Math.max(hi, parseIsoDateToMs(obs.date) + pad);
  }
  return [formatMsToIsoDate(lo), formatMsToIsoDate(hi)];
}

/**
 * Builds the Plotly layout configuration, annotations, shapes, and axes.
 */
/**
 * Season-peak reference line (when that indicator is active): its value on the primary axis.
 */
function getSeasonPeakReference(truth, isNorm) {
  const activeInds = state.indicators ? state.indicators.active : new Set();
  if (!activeInds.has("season_peak") || !(truth.history.length > 0 || (truth.season_peak && truth.season_peak > 0))) {
    return null;
  }
  const normBaseline = state.indicators?.normBaseline || "full_season";
  let rawPeak = 0;
  if (normBaseline === "history") {
    rawPeak = Number(truth.peak_to_date) || 0;
    if (rawPeak <= 0 && truth.history.length > 0) {
      rawPeak = Math.max(...truth.history.map((d) => Number(d.value) || 0), 0);
    }
  } else {
    rawPeak = Number(truth.season_peak) || 0;
    if (rawPeak <= 0) {
      const peakSource = (truth.history || []).concat(truth.future || []).concat(truth.season_remainder || []);
      rawPeak = Math.max(...peakSource.map((d) => Number(d.value) || 0), 0);
    }
  }
  return { normBaseline, rawPeak, y: isNorm ? 100 : rawPeak };
}

/**
 * Interval width rulers: each selected model's final-horizon prediction intervals redrawn as solid
 * vertical bars a short gap right of the fan, side by side, so widths can be compared at a glance.
 * Spacing and stroke widths are set in screen pixels and tighten gracefully as more models are shown.
 */
function buildPiRulerTraces(data, isNorm, truthMax, targetXRange, plotWidthPx, theme) {
  const levels = PI_BANDS.map((b) => b.level).filter((l) => state.piLevels.has(l));
  if (!state.showPiRulers || levels.length === 0 || !targetXRange) return [];

  const specs = (data.models || [])
    .filter((m) => state.selectedModels.has(m.model_id) && m.target_end_dates?.length)
    .map((m) => {
      const last = m.target_end_dates.length - 1;
      const bars = levels
        .map((level) => ({ level, lo: m[`q${level}_lower`]?.[last], hi: m[`q${level}_upper`]?.[last] }))
        .filter((b) => Number.isFinite(b.lo) && Number.isFinite(b.hi));
      return { m, date: m.target_end_dates[last], bars };
    })
    .filter((spec) => spec.bars.length > 0);
  if (specs.length === 0) return [];

  const scale = (v) => (isNorm ? (v / truthMax) * 100 : v);
  const fmt = (v) => Number(v).toLocaleString(undefined, { maximumSignificantDigits: 4 });
  const msPerPx = (parseIsoDateToMs(targetXRange[1]) - parseIsoDateToMs(targetXRange[0])) / plotWidthPx;
  const gutterPx = Math.min(Math.max(plotWidthPx * 0.12, 60), 180);
  const pitchPx = Math.max(5, Math.min(16, gutterPx / specs.length));
  const strokeScale = pitchPx / 16;
  const STROKE = { 95: 2.5, 80: 4.5, 50: 7 };
  const startMs = Math.max(...specs.map((spec) => parseIsoDateToMs(spec.date))) + 32 * msPerPx;

  const traces = [];
  specs.forEach((spec, i) => {
    const id = spec.m.model_id;
    const color = state.modelColors[id] || PALETTE[i % PALETTE.length];
    const xMs = startMs + i * pitchPx * msPerPx;
    const widths = spec.bars.map((b) => Math.max(1, STROKE[b.level] * strokeScale));
    const common = { x: [xMs, xMs], type: "scatter", mode: "lines", legendgroup: id, showlegend: false };

    // Background-colored halo keeps bars legible over gridlines and truth lines in both themes
    traces.push({
      ...common,
      y: [scale(spec.bars[0].lo), scale(spec.bars[0].hi)],
      line: { color: theme.badgeBg, width: Math.max(...widths) + 3 },
      hoverinfo: "skip",
    });
    spec.bars.forEach((b, j) => {
      traces.push({
        ...common,
        y: [scale(b.lo), scale(b.hi)],
        line: { color, width: widths[j] },
        name: `${id} (${b.level}% PI width)`,
        hovertemplate: `<b>${id}</b><br>${b.level}% PI on ${spec.date}: ${fmt(b.lo)} – ${fmt(b.hi)}<br>Width: ${fmt(b.hi - b.lo)}<extra></extra>`,
      });
    });
  });
  return traces;
}

function buildChartLayout(data, traces, targetXRange, computedYRange, state, theme, isNorm, targetMeta) {
  const truth = data.truth || { history: [], future: [], anchor: null };
  const isLight = document.body.classList.contains("theme-light");
  const isPres = document.body.classList.contains("presentation-mode");
  const activeInds = state.indicators ? state.indicators.active : new Set();
  const anchor = truth.anchor;
  const cutoffDate = anchor ? anchor.date : null;
  const refDate = state.selectedDate;

  const shapes = [];
  const annotations = [];

  // 1. Season Peak Reference Line
  const peakRef = getSeasonPeakReference(truth, isNorm);
  if (peakRef) {
    const { normBaseline, rawPeak, y: peakVal } = peakRef;
    const peakLabel = normBaseline === "history"
      ? (isNorm ? "Peak to Date (100%)" : `Peak to Date: ${rawPeak.toLocaleString()}`)
      : (isNorm ? "Full Season Peak (100%)" : `Season Peak: ${rawPeak.toLocaleString()}`);

    shapes.push({
      type: "line",
      xref: "paper",
      x0: 0,
      x1: 1,
      y0: peakVal,
      y1: peakVal,
      line: { color: "rgba(239, 68, 68, 0.65)", width: 1.5, dash: "dash" },
    });
    annotations.push({
      xref: "paper",
      x: 0.99,
      y: peakVal,
      xanchor: "right",
      yanchor: "bottom",
      text: peakLabel,
      showarrow: false,
      font: { family: "JetBrains Mono, monospace", size: 9, color: "#f87171" },
    });
  }

  // 2. Data Cutoff & Reference Date Vertical Demarcation Lines
  if (cutoffDate && refDate && cutoffDate !== refDate) {
    shapes.push({
      type: "rect",
      x0: cutoffDate,
      x1: refDate,
      y0: 0,
      y1: 1,
      yref: "paper",
      fillcolor: theme.cutoffFill,
      line: { width: 0 },
    });

    shapes.push({
      type: "line",
      x0: cutoffDate,
      x1: cutoffDate,
      y0: 0,
      y1: 1,
      yref: "paper",
      line: { color: theme.cutoffLine, width: 1.5, dash: "dot" },
    });

    annotations.push({
      x: cutoffDate,
      y: 0.97,
      yref: "paper",
      xanchor: "right",
      text: "Data Cutoff\u00a0",
      showarrow: false,
      font: { family: "JetBrains Mono, monospace", size: 9, color: theme.axisColor },
    });

    shapes.push({
      type: "line",
      x0: refDate,
      x1: refDate,
      y0: 0,
      y1: 1,
      yref: "paper",
      line: { color: theme.refLine, width: 1, dash: "dot" },
    });

    annotations.push({
      x: refDate,
      y: 0.97,
      yref: "paper",
      xanchor: "left",
      text: "\u00a0Ref Date (h=0)",
      showarrow: false,
      font: { family: "JetBrains Mono, monospace", size: 9, color: theme.textMuted },
    });
  } else if (refDate) {
    shapes.push({
      type: "line",
      x0: refDate,
      x1: refDate,
      y0: 0,
      y1: 1,
      yref: "paper",
      line: { color: theme.refLine, width: 1.5, dash: "dot" },
    });
  }

  // 3. Margin Annotations with Vertical Collision Avoidance
  const refMs = parseIsoDateToMs(refDate);
  const xMinMs = targetXRange
    ? parseIsoDateToMs(targetXRange[0])
    : refMs - CHART_CONSTANTS.DEFAULT_WEEKS_PAST * CHART_CONSTANTS.WEEK_MS;

  const placedMarginLabels = [];
  traces.forEach((tr) => {
    if (!tr.leftMarginLabel || !tr.x || tr.x.length === 0 || !tr.y || tr.y.length === 0) return;
    const lbl = tr.leftMarginLabel;

    let bestIdx = -1;
    for (let i = 0; i < tr.x.length; i++) {
      const ptMs = parseIsoDateToMs(tr.x[i]);
      if (!isNaN(ptMs) && ptMs >= xMinMs) {
        bestIdx = i;
        break;
      }
    }
    if (bestIdx === -1) bestIdx = 0;

    const ptX = tr.x[bestIdx];
    const ptY = tr.y[bestIdx];
    if (ptX === undefined || ptY === undefined || ptY === null || isNaN(ptY)) return;

    placedMarginLabels.push({
      lbl,
      ptX,
      ptY: Number(ptY),
      yref: lbl.yaxis || "y",
    });
  });

  placedMarginLabels.sort((a, b) => a.ptY - b.ptY);
  let accumulatedShift = 0;
  const collisionThreshold = computedYRange && computedYRange[1]
    ? computedYRange[1] * 0.045
    : (isNorm ? 6 : 1000);

  for (let k = 0; k < placedMarginLabels.length; k++) {
    const item = placedMarginLabels[k];
    let yshift = 0;
    if (k > 0) {
      const prev = placedMarginLabels[k - 1];
      const diff = Math.abs(item.ptY - prev.ptY);
      if (diff < collisionThreshold) {
        accumulatedShift += CHART_CONSTANTS.COLLISION_SHIFT_PX;
        yshift = accumulatedShift;
      } else {
        accumulatedShift = 0;
      }
    } else {
      accumulatedShift = 0;
    }

    annotations.push({
      x: item.ptX,
      y: item.ptY,
      yshift: yshift,
      xref: "x",
      yref: item.yref,
      text: ` ${item.lbl.text} `,
      xanchor: "left",
      yanchor: "bottom",
      showarrow: false,
      font: {
        family: "JetBrains Mono, SF Mono, Menlo, monospace",
        size: 8.5,
        color: item.lbl.color,
      },
      bgcolor: theme.badgeBg,
      bordercolor: item.lbl.color,
      borderwidth: 0.8,
      borderpad: 2,
      opacity: 0.94,
    });
  }

  // Helpful empty state prompt when no models are active
  if (state.selectedModels.size === 0) {
    annotations.push({
      xref: "paper",
      yref: "paper",
      x: 0.5,
      y: 0.5,
      text: "No models selected · Click model chips above or 'Select All' to display fan forecasts",
      showarrow: false,
      font: {
        family: "Inter, sans-serif",
        size: 12,
        color: theme.textMuted,
      },
      bgcolor: theme.badgeBg,
      bordercolor: theme.lineColor,
      borderwidth: 1,
      borderpad: 8,
    });
  }

  // 4. Primary and Secondary Y-Axes Layout Setup
  const hasY2 = traces.some((t) => t.yaxis === "y2");
  const hasY3 = traces.some((t) => t.yaxis === "y3");

  const yTitle = isNorm
    ? "Normalized Amplitude (% of Peak)"
    : targetMeta?.display_name
    ? `${targetMeta.display_name} (${targetMeta.unit || "Value"})`
    : state.selectedTarget === "wk inc flu hosp"
    ? "Incident Flu Admissions (Patients / Wk)"
    : "ED Visits Proportion (% ED Visits)";

  const layout = {
    paper_bgcolor: "rgba(0, 0, 0, 0)",
    plot_bgcolor: "rgba(0, 0, 0, 0)",
    font: {
      family: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
      color: theme.axisColor,
      size: 11,
    },
    margin: isPres
      ? { l: 48, r: hasY3 ? 90 : hasY2 ? 55 : 16, t: 15, b: 50 }
      : { l: 60, r: hasY3 ? 100 : hasY2 ? 65 : 25, t: 25, b: 65 },
    xaxis: {
      type: "date",
      range: targetXRange || undefined,
      autorange: !targetXRange,
      gridcolor: theme.gridColor,
      linecolor: theme.lineColor,
      tickfont: { family: "JetBrains Mono, monospace", color: theme.axisColor, size: 10 },
      showspikes: true,
      spikemode: "across",
      spikesnap: "data",
      spikethickness: 1,
      spikedash: "dot",
      spikecolor: theme.spikeColor,
    },
    yaxis: {
      title: { text: yTitle, font: { color: theme.axisColor, size: 11 } },
      gridcolor: theme.gridColor,
      linecolor: theme.lineColor,
      tickfont: { family: "JetBrains Mono, monospace", color: theme.axisColor, size: 10 },
      ticksuffix: isNorm ? "%" : "",
      dtick: isNorm && computedYRange[1] <= 115 ? 20 : undefined,
      range: computedYRange,
      rangemode: "tozero",
    },
    uirevision: `${state.selectedLocation}_${state.selectedTarget}`,
    shapes: shapes,
    annotations: annotations,
    showlegend: true,
    legend: {
      orientation: "h",
      yanchor: "top",
      y: isPres ? -0.10 : -0.14,
      xanchor: "center",
      x: 0.5,
      font: { color: theme.legendColor, size: 10 },
    },
    hovermode: "x",
    hoverlabel: {
      bgcolor: theme.hoverBg,
      bordercolor: theme.hoverBorder,
      font: {
        family: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
        color: theme.hoverText,
        size: 11,
      },
      align: "center",
      namelength: 0,
    },
  };

  // Configure Secondary Rate / Derivative Axis (Y2). In normalized mode surveillance rates share the
  // primary % axis, so Y2 only ever carries the derivative indicators.
  if (hasY2) {
    const hasRateInds = activeInds.has("nssp") || activeInds.has("ilinet") || activeInds.has("flusurvnet");
    const isDerivOnY2 = isNorm || (!hasRateInds && (activeInds.has("velocity") || activeInds.has("growth")));

    let y2Title = "Surveillance Rate";
    let y2TickFmt = undefined;

    if (!isDerivOnY2 && (activeInds.has("nssp") || activeInds.has("ilinet"))) {
      y2Title = "Surveillance Rate (% ED / % ILI)";
      y2TickFmt = ".1f%";
    } else if (!isDerivOnY2 && activeInds.has("flusurvnet")) {
      y2Title = "FluSurv-NET Rate / 100k";
      y2TickFmt = ".1f";
    } else if (activeInds.has("growth")) {
      y2Title = "Growth Rate (% WoW)";
      y2TickFmt = "+.1f%";
    } else if (activeInds.has("velocity")) {
      y2Title = "Case Velocity (Δ Cases/Wk)";
      y2TickFmt = "+,d";
    }

    layout.yaxis2 = {
      title: { text: y2Title, font: { color: isLight ? "#0f766e" : "#38bdf8", size: 10 } },
      overlaying: "y",
      side: "right",
      showgrid: false,
      zeroline: isDerivOnY2,
      zerolinecolor: isLight ? "rgba(101, 123, 131, 0.4)" : "rgba(255, 255, 255, 0.2)",
      zerolinewidth: 1.2,
      tickfont: { family: "JetBrains Mono, monospace", color: isLight ? "#0f766e" : "#38bdf8", size: 9 },
      ticks: "outside",
      ticklen: 4,
      tickformat: y2TickFmt,
    };
  }

  // Configure Tertiary Derivative Axis (Y3) if rate and derivative streams are simultaneously active
  if (hasY3 && !isNorm) {
    let y3Title = "WoW Dynamics";
    let y3TickFmt = undefined;
    if (activeInds.has("growth")) {
      y3Title = "Growth Rate (% WoW)";
      y3TickFmt = "+.1f%";
    } else if (activeInds.has("velocity")) {
      y3Title = "Velocity (Δ/Wk)";
      y3TickFmt = "+,d";
    }

    layout.yaxis3 = {
      title: { text: y3Title, font: { color: isLight ? "#b45309" : "#f59e0b", size: 10 } },
      overlaying: "y",
      side: "right",
      position: 0.96,
      anchor: "free",
      showgrid: false,
      zeroline: true,
      zerolinecolor: isLight ? "rgba(101, 123, 131, 0.4)" : "rgba(255, 255, 255, 0.2)",
      zerolinewidth: 1.2,
      tickfont: { family: "JetBrains Mono, monospace", color: isLight ? "#b45309" : "#f59e0b", size: 9 },
      ticks: "outside",
      ticklen: 4,
      tickformat: y3TickFmt,
    };
  }

  return layout;
}

/**
 * Main Forecast Chart Plotter Orchestrator.
 */
export function renderForecastPlot(data) {
  const plotEl = document.getElementById("forecast-plot");
  if (!plotEl || !data) return;

  const isLight = document.body.classList.contains("theme-light");
  const theme = getChartThemeColors(isLight);
  const isNorm = Boolean(state.indicators && state.indicators.mode === "normalized");
  const truth = data.truth || { history: [], future: [], anchor: null };

  // Calculate truth max for normalized amplitude mode
  let truthMax = 1;
  if (isNorm) {
    const normBaseline = state.indicators?.normBaseline || "full_season";
    if (normBaseline === "history") {
      truthMax = Number(truth.peak_to_date) || 0;
      if (truthMax <= 0 && truth.history && truth.history.length > 0) {
        truthMax = Math.max(...truth.history.map((d) => Number(d.value) || 0), 0);
      }
    } else {
      truthMax = Number(truth.season_peak) || 0;
      if (truthMax <= 0) {
        const peakSource = (truth.history || []).concat(truth.future || []).concat(truth.season_remainder || []);
        if (peakSource.length > 0) {
          truthMax = Math.max(...peakSource.map((d) => Number(d.value) || 0), 0);
        }
      }
    }
    if (truthMax <= 0) truthMax = 1;
  }

  // Retrieve dynamic target metadata
  const targetMeta = (state.targetsMeta && state.targetsMeta[state.selectedTarget]) || {
    display_name: state.selectedTarget === "wk inc flu hosp" ? "Incident Flu Admissions" : state.selectedTarget,
    unit: state.selectedTarget === "wk inc flu hosp" ? "Patients / Wk" : "Value",
    is_rate: state.selectedTarget === "wk inc flu prop ed visits",
  };

  // Build clean traces
  const traces = buildForecastTraces(data, state, theme, isNorm, truthMax, targetMeta);

  // Check for context change (location, target, or selected model roster change)
  const locOrTargetChanged =
    state.smartZoom.lastLocation !== state.selectedLocation ||
    state.smartZoom.lastTarget !== state.selectedTarget;

  if (locOrTargetChanged) {
    state.smartZoom.isUserZoomedY = false;
    state.smartZoom.userYRange = null;
    state.smartZoom.lastStableYMax = null;
    state.smartZoom.lastLocation = state.selectedLocation;
    state.smartZoom.lastTarget = state.selectedTarget;
  }

  // Compute clean, synchronized horizontal date window
  const targetXRange = extendXRangeForPeaks(computeTargetXRange(state.selectedDate, state.smartZoom), data);
  const plotWidthPx = Math.max(200, plotEl.clientWidth - 90);
  traces.push(...buildPiRulerTraces(data, isNorm, truthMax, targetXRange, plotWidthPx, theme));

  // Compute smart vertical ranges. Any reset of the primary axis (context, mode, model or
  // interval changes) also re-fits the secondary indicator axes from scratch.
  const freshAxes = state.smartZoom.lastStableYMax === null;
  const peakRef = getSeasonPeakReference(truth, isNorm);
  let computedYRange;
  if (state.smartZoom.isUserZoomedY && state.smartZoom.userYRange) {
    computedYRange = state.smartZoom.userYRange;
  } else {
    computedYRange = computeSmartYRange(
      traces,
      targetXRange,
      isNorm,
      freshAxes ? null : [0, state.smartZoom.lastStableYMax],
      freshAxes,
      targetMeta,
      { referenceLevels: peakRef ? [peakRef.y] : [] }
    );
    state.smartZoom.lastStableYMax = computedYRange[1];
  }
  const prevSecondary = freshAxes ? {} : (state.smartZoom.lastSecondaryRanges || {});
  const secondaryRanges = {};
  ["y2", "y3"].forEach((axis) => {
    const range = computeSmartYRange(traces, targetXRange, false, prevSecondary[axis] || null, freshAxes, targetMeta, { axis });
    if (range) secondaryRanges[axis] = range;
  });
  state.smartZoom.lastSecondaryRanges = secondaryRanges;

  // Build complete layout configuration
  const layout = buildChartLayout(
    data,
    traces,
    targetXRange,
    computedYRange,
    state,
    theme,
    isNorm,
    targetMeta
  );
  Object.entries(secondaryRanges).forEach(([axis, range]) => {
    const axisLayout = layout[axis.replace("y", "yaxis")];
    if (axisLayout) {
      axisLayout.range = range;
      axisLayout.autorange = false;
    }
  });

  const config = {
    responsive: true,
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  };

  // Perform Plotly rendering with atomic update guard
  activeProgrammaticUpdates++;
  Promise.resolve(Plotly.react("forecast-plot", traces, layout, config))
    .then(() => {
      const el = document.getElementById("forecast-plot");
      if (el && !el._smartZoomBound) {
        el._smartZoomBound = true;
        el.on("plotly_relayout", handleForecastPlotRelayout);
      }
    })
    .catch((err) => {
      console.warn("Plotly.react forecast render warning:", err);
    })
    .finally(() => {
      // Release lock on next microtask frame
      requestAnimationFrame(() => {
        activeProgrammaticUpdates = Math.max(0, activeProgrammaticUpdates - 1);
      });
    });
}

/**
 * Handles user interaction events (zoom, pan, reset) deterministically.
 */
function handleForecastPlotRelayout(eventData) {
  if (activeProgrammaticUpdates > 0 || !eventData) return;

  const refDate = state.selectedDate;
  const isNorm = Boolean(state.indicators && state.indicators.mode === "normalized");

  // User clicked "Reset Axes" or double-clicked the plot
  if (eventData["xaxis.autorange"] === true || eventData["autosize"] === true) {
    state.smartZoom.isUserZoomedX = false;
    state.smartZoom.isUserZoomedY = false;
    state.smartZoom.userYRange = null;
    state.smartZoom.lastStableYMax = null;
    state.smartZoom.userOffsetDaysLeft = null;
    state.smartZoom.userOffsetDaysRight = null;
    state.smartZoom.userSpanDays = null;

    const plotEl = document.getElementById("forecast-plot");
    const targetX = extendXRangeForPeaks(computeTargetXRange(refDate, state.smartZoom), state.currentForecastData);
    const targetMeta = state.targetsMeta?.[state.selectedTarget] || null;
    // Horizontal reference lines on the primary axis (e.g. season peak) must stay in view too
    const referenceLevels = (plotEl?.layout?.shapes || [])
      .filter((sh) => (sh.yref || "y") === "y" && sh.y0 === sh.y1)
      .map((sh) => Number(sh.y0));
    const smartY = computeSmartYRange(plotEl?.data || [], targetX, isNorm, null, true, targetMeta, { referenceLevels });

    activeProgrammaticUpdates++;
    Promise.resolve(
      Plotly.relayout("forecast-plot", {
        "xaxis.range": targetX || undefined,
        "xaxis.autorange": !targetX,
        "yaxis.range": smartY,
        "yaxis.autorange": false,
      })
    ).finally(() => {
      requestAnimationFrame(() => {
        activeProgrammaticUpdates = Math.max(0, activeProgrammaticUpdates - 1);
      });
    });
    return;
  }

  // User dragged or zoomed X-axis
  const x0Str = eventData["xaxis.range[0]"] || (Array.isArray(eventData["xaxis.range"]) ? eventData["xaxis.range"][0] : null);
  const x1Str = eventData["xaxis.range[1]"] || (Array.isArray(eventData["xaxis.range"]) ? eventData["xaxis.range"][1] : null);

  if (x0Str && x1Str) {
    const x0 = parseIsoDateToMs(x0Str);
    const x1 = parseIsoDateToMs(x1Str);
    const refMs = parseIsoDateToMs(refDate);

    if (!isNaN(x0) && !isNaN(x1) && x1 > x0) {
      state.smartZoom.isUserZoomedX = true;
      state.smartZoom.currentX0 = x0;
      state.smartZoom.currentX1 = x1;
      state.smartZoom.userSpanDays = (x1 - x0) / CHART_CONSTANTS.DAY_MS;
      if (!isNaN(refMs)) {
        state.smartZoom.userOffsetDaysLeft = (x0 - refMs) / CHART_CONSTANTS.DAY_MS;
        state.smartZoom.userOffsetDaysRight = (x1 - refMs) / CHART_CONSTANTS.DAY_MS;
        state.smartZoom.lastRefDate = refDate;
      }
    }
  }

  // User zoomed Y-axis
  if (eventData["yaxis.autorange"] === true) {
    state.smartZoom.isUserZoomedY = false;
    state.smartZoom.userYRange = null;
  } else {
    const y0 = eventData["yaxis.range[0]"] !== undefined ? Number(eventData["yaxis.range[0]"]) : null;
    const y1 = eventData["yaxis.range[1]"] !== undefined ? Number(eventData["yaxis.range[1]"]) : null;
    if (y0 !== null && y1 !== null && !isNaN(y0) && !isNaN(y1) && y1 > y0) {
      state.smartZoom.isUserZoomedY = true;
      state.smartZoom.userYRange = [y0, y1];
    }
  }
}

/**
 * Clean debounced plot resize trigger with requestAnimationFrame.
 */
export function triggerPlotResizeSequence(plotId = "forecast-plot") {
  requestAnimationFrame(() => {
    try {
      const el = document.getElementById(plotId);
      if (el && !el.classList.contains("hidden") && el.style.display !== "none") {
        Plotly.Plots.resize(plotId);
      }
    } catch (_) {}
  });
}

/**
 * Initializes performant ResizeObservers on chart containers.
 */
export function setupPlotResizeObservers() {
  if (typeof ResizeObserver === "undefined") return;

  let resizeTimeout = null;
  const debouncedResize = (targetId) => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      try {
        const el = document.getElementById(targetId);
        if (el && !el.classList.contains("hidden") && el.style.display !== "none") {
          Plotly.Plots.resize(targetId);
          // Ruler spacing is defined in screen pixels, so rebuild it for the new plot width
          if (targetId === "forecast-plot" && state.showPiRulers && state.currentForecastData) {
            renderForecastPlot(state.currentForecastData);
          }
        }
      } catch (_) {}
    }, 40);
  };

  const forecastEl = document.getElementById("forecast-plot");
  if (forecastEl && !forecastEl._hasResizeObs) {
    forecastEl._hasResizeObs = true;
    const obs = new ResizeObserver(() => debouncedResize("forecast-plot"));
    obs.observe(forecastEl);
  }

  const spatialEl = document.getElementById("spatial-map-plot");
  if (spatialEl && !spatialEl._hasResizeObs) {
    spatialEl._hasResizeObs = true;
    const obs = new ResizeObserver(() => debouncedResize("spatial-map-plot"));
    obs.observe(spatialEl);
  }

  if (!window._flusightFullscreenBound) {
    window._flusightFullscreenBound = true;
    const handleFullscreen = () => {
      const plotId = { spatial: "spatial-map-plot", heatmap: "heatmap-plot", peak: "peak-outlook-plot" }[state.currentView] || "forecast-plot";
      triggerPlotResizeSequence(plotId);
    };
    document.addEventListener("fullscreenchange", handleFullscreen);
    document.addEventListener("webkitfullscreenchange", handleFullscreen);
  }
}
