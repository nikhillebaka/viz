/**
 * FluSight Sandbox Lab — Season Peak view
 *
 * Season peak forecasts are two season-level targets that sit beside a weekly target:
 *   timing  'peak week inc flu hosp'  a probability for each candidate week (pmf)
 *   size    'peak inc flu hosp'       quantiles of the highest weekly count of the season
 * This view shows them on their own terms instead of forcing them into the weekly fan:
 *   1. Peak Outlook   the season so far with each model's peak "target zone" (50% timing × 50% size box,
 *                     90% whiskers, ▲ at the medians) above a ridgeline of every model's timing pmf.
 *   2. Peak Call by Round   how one model's timing distribution and size interval moved round to round.
 *   3. Scorecard      this round's calls side by side, or season skill once the observed peak is final.
 */

import {
  PALETTE,
  escapeHtml,
  getChartThemeColors,
  hexToRgba,
  modelLabel,
  parseIsoDateToMs,
  formatMsToIsoDate,
  setFetchError,
} from "../constants.js";
import { state } from "../state.js";
import { fetchPeaks, createRequestGuard } from "../api.js";

const DAY = 86400000;
const HALF_WEEK = 3.5 * DAY;
const guard = createRequestGuard();
let callbacks = {};

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------

const ms = (d) => parseIsoDateToMs(d);
const iso = (t) => formatMsToIsoDate(t);
const shiftDays = (d, days) => iso(ms(d) + days * DAY);

export function fmtWeek(d, withYear = false) {
  if (!d) return "—";
  const opts = { month: "short", day: "numeric", timeZone: "UTC" };
  if (withYear) opts.year = "numeric";
  return new Date(ms(d)).toLocaleDateString(undefined, opts);
}

export function fmtCount(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  return n >= 100 ? Math.round(n).toLocaleString() : n.toLocaleString(undefined, { maximumSignificantDigits: 3 });
}

const fmtPct = (v, digits = 0) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(digits)}%`);
const weeksBetween = (a, b) => Math.round((ms(b) - ms(a)) / (7 * DAY));
const seasonLabel = (s) => (s ? `${s.slice(0, 4)}–${s.slice(7, 9)}` : "");
const colorOf = (id, i = 0) => state.modelColors[id] || PALETTE[i % PALETTE.length];
const nameOf = (id) => modelLabel(id, state.models[id], { withHub: true });
const shortName = (id) => modelLabel(id, state.models[id]);

/** Which weekly targets have season peak companions, and the companion names. */
export function peakTargetsFor(target) {
  return (state.peakTargets || {})[target] || null;
}

/** The location the peak view shows: aggregates ("All States") fall back to the national curve. */
export function peakLocation() {
  const loc = state.selectedLocation;
  return !loc || loc === "states" || loc === "all" ? "US" : loc;
}

// ----------------------------------------------------------------------------
// Fetch & render
// ----------------------------------------------------------------------------

export async function fetchAndRenderPeaks(cbs = {}) {
  callbacks = { ...callbacks, ...cbs };
  const container = document.getElementById("peak-container");
  if (!container || !state.selectedDate) return;

  const companions = peakTargetsFor(state.selectedTarget);
  if (!companions) {
    state.peakData = null;
    renderNotice({
      kind: "target",
      title: "Season peak forecasts belong to hospital admissions",
      body: `<strong>${escapeHtml(state.targetsMeta?.[state.selectedTarget]?.display_name || state.selectedTarget)}</strong> has no peak targets. Peak timing and peak size are forecast for weekly flu hospital admissions.`,
      action: Object.keys(state.peakTargets || {})[0]
        ? { label: "Switch to Flu Hosp", onClick: () => callbacks.onSwitchTarget?.(Object.keys(state.peakTargets)[0]) }
        : null,
    });
    clearPlots();
    return;
  }

  container.classList.add("is-loading");
  const request = guard.start();
  try {
    const data = await fetchPeaks({
      target: state.selectedTarget,
      location: peakLocation(),
      date: state.selectedDate,
      models: Array.from(state.selectedModels),
      skillScope: state.peakSkillScope,
      common: state.fairCommonTasks,
      signal: request.signal,
    });
    if (!request.isCurrent()) return;
    setFetchError("peak-outlook-plot", "");
    state.peakData = data;
    renderPeakView();
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error("Error fetching peak forecasts:", err);
    setFetchError("peak-outlook-plot", `Could not load season peak forecasts (${err.message}).`);
  } finally {
    if (request.isCurrent()) container.classList.remove("is-loading");
  }
}

export function renderPeakView() {
  const data = state.peakData;
  if (!data) return;
  renderToolbar(data);

  const withPeaks = data.models.filter((m) => (data.rounds[m.model_id] || []).length > 0 || m.timing || m.size);
  const thisRound = data.models.filter((m) => m.has_round);
  const outdatedHubs = (state.remoteHubs || []).filter((h) => h.synced && h.enabled && (h.peak_outdated || 0) > 0);

  if (state.selectedModels.size === 0) {
    renderNotice({
      kind: "empty",
      title: "No models selected",
      body: "Select models in the model bar to compare their season peak forecasts.",
    });
  } else if (data.models.length === 0) {
    const hint = outdatedHubs.length
      ? `${escapeHtml(outdatedHubs.map((h) => h.label).join(", "))} was synced before peak forecasts were supported. Update it from the <strong>FluSight Sandbox</strong> menu to bring them in.`
      : "Peak forecasts come from models that submit the hub's peak targets, for example the FluSight ensemble and many teams on the live hub shelf.";
    renderNotice({ kind: "empty", title: "None of the selected models submit season peak forecasts", body: hint });
  } else if (thisRound.length === 0) {
    const rounds = data.peak_rounds || [];
    const nearest = rounds.length ? rounds.reduce((a, b) => (Math.abs(ms(b) - ms(data.reference_date)) < Math.abs(ms(a) - ms(data.reference_date)) ? b : a)) : data.latest_peak_round;
    renderNotice({
      kind: "round",
      title: `No peak forecasts for the round of ${fmtWeek(data.reference_date, true)}`,
      body: rounds.length
        ? `The selected models submitted peak forecasts for ${rounds.length} round${rounds.length === 1 ? "" : "s"} of ${seasonLabel(data.season)}.`
        : "The selected models have no peak forecasts in this season.",
      action: nearest ? { label: `Go to ${fmtWeek(nearest, true)}`, onClick: () => callbacks.onSelectDate?.(nearest) } : null,
    });
  } else if (outdatedHubs.length) {
    renderNotice({
      kind: "info",
      title: "Some hub data predates peak support",
      body: `${escapeHtml(outdatedHubs.map((h) => h.label).join(", "))} has files synced before peak forecasts were kept. Update it from the <strong>FluSight Sandbox</strong> menu to fill in the missing rounds.`,
    });
  } else {
    renderNotice(null);
  }

  renderOutlook(data);
  populateEvolutionModelSelect(data, withPeaks);
  renderEvolution(data);
  renderScorecard(data);
}

function clearPlots() {
  ["peak-outlook-plot", "peak-evolution-plot"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.data) Plotly.purge(el);
    if (el) el.innerHTML = "";
  });
  const sc = document.getElementById("peak-scorecard");
  if (sc) sc.innerHTML = "";
  const sel = document.getElementById("peak-evolution-model");
  if (sel) sel.innerHTML = "";
  renderToolbar(null);
}

function renderNotice(notice) {
  const el = document.getElementById("peak-notice");
  if (!el) return;
  if (!notice) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  el.dataset.kind = notice.kind;
  el.innerHTML = `
    <div class="peak-notice-text">
      <span class="peak-notice-title">${escapeHtml(notice.title)}</span>
      <span class="peak-notice-body">${notice.body}</span>
    </div>
    ${notice.action ? `<button type="button" class="micro-btn peak-notice-action">${escapeHtml(notice.action.label)}</button>` : ""}`;
  const btn = el.querySelector(".peak-notice-action");
  if (btn && notice.action) btn.addEventListener("click", notice.action.onClick);
}

function renderToolbar(data) {
  const chip = document.getElementById("peak-round-chip");
  if (!chip) return;
  if (!data) {
    chip.innerHTML = "";
    return;
  }
  const obs = data.observed;
  let obsText = "No observations yet";
  if (obs) {
    obsText = obs.final
      ? `Observed peak <strong>${fmtCount(obs.value)}</strong> · ${fmtWeek(obs.date)}`
      : `Peak so far <strong>${fmtCount(obs.value)}</strong> · ${fmtWeek(obs.date)} <span class="peak-provisional">provisional until ${fmtWeek(data.window?.[1])}</span>`;
  }
  const aggregate = state.selectedLocation === "states" || state.selectedLocation === "all";
  chip.innerHTML = `
    <span class="peak-chip-seg"><span class="peak-chip-k">SEASON</span>${seasonLabel(data.season)}</span>
    <span class="peak-chip-seg"><span class="peak-chip-k">ROUND</span>${fmtWeek(data.reference_date, true)}</span>
    <span class="peak-chip-seg peak-chip-obs">${obsText}</span>
    ${aggregate ? `<span class="peak-chip-seg peak-chip-note" title="Peak forecasts are made per location; aggregates show the national forecast">Showing US National</span>` : ""}`;
}

// ----------------------------------------------------------------------------
// 1. Peak Outlook
// ----------------------------------------------------------------------------

/** A closed rectangle polygon (date x, value y), drawn as a filled scatter so it toggles with the legend. */
function boxXY(x0, x1, y0, y1) {
  return { x: [x0, x1, x1, x0, x0], y: [y0, y0, y1, y1, y0] };
}

/** Step outline of a pmf lane: each candidate week spans ±3.5 days around its Saturday. */
function ridgeXY(dates, probs, base, scale) {
  const x = [];
  const y = [];
  dates.forEach((d, i) => {
    const h = base + probs[i] * scale;
    x.push(ms(d) - HALF_WEEK, ms(d) + HALF_WEEK);
    y.push(h, h);
  });
  // Close along the baseline
  x.push(ms(dates[dates.length - 1]) + HALF_WEEK, ms(dates[0]) - HALF_WEEK, ms(dates[0]) - HALF_WEEK);
  y.push(base, base, y[0]);
  return { x, y };
}

export function peakHoverHtml(m, data, isNorm = false) {
  const t = m.timing;
  const s = m.size;
  const lines = [`<b>${escapeHtml(nameOf(m.model_id))}</b>`];
  if (t) {
    lines.push(`Peak week · median ${fmtWeek(t.median)} · most likely ${fmtWeek(t.mode)} (${fmtPct(t.mode_prob)})`);
    lines.push(`&nbsp;&nbsp;50% ${fmtWeek(t.i50[0])} – ${fmtWeek(t.i50[1])} · 90% ${fmtWeek(t.i90[0])} – ${fmtWeek(t.i90[1])}`);
    if (t.p_passed !== undefined && t.p_passed > 0.005) lines.push(`&nbsp;&nbsp;Chance the peak is already past: ${fmtPct(t.p_passed)}`);
  }
  if (s) {
    lines.push(`Peak size · median ${fmtCount(s.median)}`);
    lines.push(`&nbsp;&nbsp;50% ${fmtCount(s.i50[0])} – ${fmtCount(s.i50[1])} · 90% ${fmtCount(s.i90[0])} – ${fmtCount(s.i90[1])}`);
  }
  if (isNorm) lines.push("<i>Plotted as % of the season peak</i>");
  return lines.join("<br>");
}

function renderOutlook(data) {
  const el = document.getElementById("peak-outlook-plot");
  if (!el) return;
  const isLight = document.body.classList.contains("theme-light");
  const theme = getChartThemeColors(isLight);
  const traces = [];
  const shapes = [];
  const annotations = [];

  const lanes = data.models
    .map((m, i) => ({ m, i, timing: m.timing, size: m.size }))
    .filter((r) => r.timing || r.size);
  const ridges = lanes.filter((r) => r.timing);

  // Lane geometry: the ridgeline band grows with models, then compresses so the chart stays readable
  const lanePx = ridges.length ? Math.max(13, Math.min(40, 300 / ridges.length)) : 0;
  const ridgePx = ridges.length ? ridges.length * lanePx + 34 : 0;
  const mainPx = 340;
  const height = mainPx + ridgePx + 70;
  const ridgeTop = ridgePx / (mainPx + ridgePx);
  const mainDomain = ridges.length ? [Math.min(0.62, ridgeTop + 0.07), 1] : [0, 1];

  // ---- Season truth: observed through the data cutoff, then (historical rounds) the rest of the season
  const cutoff = data.data_cutoff;
  const truth = (data.truth || []).filter((p) => p && p.date);
  const past = truth.filter((p) => p.date <= cutoff);
  const later = truth.filter((p) => p.date >= (past.length ? past[past.length - 1].date : cutoff));
  if (past.length) {
    traces.push({
      x: past.map((p) => p.date), y: past.map((p) => p.value),
      type: "scatter", mode: "lines+markers", name: "Reported",
      line: { color: theme.truthHistMarker, width: 2 }, marker: { size: 4, color: theme.truthHistMarker },
      hovertemplate: "%{x|%b %d, %Y}<br>Reported: %{y:,.0f}<extra></extra>", showlegend: false,
    });
  }
  if (state.showTruth && later.length > 1) {
    traces.push({
      x: later.map((p) => p.date), y: later.map((p) => p.value),
      type: "scatter", mode: "lines", name: "Rest of season",
      line: { color: theme.truthRestLine, width: 1.3, dash: "dash" },
      hovertemplate: "%{x|%b %d, %Y}<br>Observed later: %{y:,.0f}<extra></extra>", showlegend: false,
    });
  }

  // ---- Peak target zones: 90% whiskers, 50% box, ▲ at the medians
  lanes.forEach(({ m, i, timing: t, size: s }) => {
    const color = colorOf(m.model_id, i);
    const group = m.model_id;
    const label = nameOf(m.model_id);
    if (t && s) {
      const b = boxXY(ms(t.i50[0]) - HALF_WEEK, ms(t.i50[1]) + HALF_WEEK, s.i50[0], s.i50[1]);
      traces.push({
        ...b, type: "scatter", mode: "lines", fill: "toself", fillcolor: hexToRgba(color, 0.13),
        line: { color: hexToRgba(color, 0.55), width: 1 }, legendgroup: group, showlegend: false, hoverinfo: "skip",
      });
      traces.push({
        x: [ms(t.i90[0]) - HALF_WEEK, ms(t.i90[1]) + HALF_WEEK, null, ms(t.median), ms(t.median)],
        y: [s.median, s.median, null, s.i90[0], s.i90[1]],
        type: "scatter", mode: "lines", line: { color: hexToRgba(color, 0.7), width: 1.2 },
        legendgroup: group, showlegend: false, hoverinfo: "skip",
      });
      traces.push({
        x: [ms(t.median)], y: [s.median], type: "scatter", mode: "markers", name: label,
        marker: { symbol: "triangle-up", size: 12, color, line: { color: theme.badgeBg, width: 1.5 } },
        legendgroup: group, showlegend: true,
        hovertemplate: `${peakHoverHtml(m, data)}<extra></extra>`,
      });
    } else if (s) {
      // Size without timing: a dashed level at the median with its 50% band, labelled at the right edge
      traces.push({
        x: [ms(data.window[0]), ms(data.window[1])], y: [s.median, s.median], type: "scatter", mode: "lines",
        name: `${label} (size only)`, line: { color, width: 1.2, dash: "dash" }, legendgroup: group, showlegend: true,
        hovertemplate: `${peakHoverHtml(m, data)}<br><i>No peak-week forecast</i><extra></extra>`,
      });
    }
  });

  // ---- Observed peak
  const obs = data.observed;
  if (obs && state.showTruth) {
    traces.push({
      x: [obs.date], y: [obs.value], type: "scatter", mode: "markers",
      name: obs.final ? "Observed peak" : "Peak so far",
      marker: obs.final
        ? { symbol: "star", size: 15, color: isLight ? "#073642" : "#f6f4ee", line: { color: theme.badgeBg, width: 1.5 } }
        : { symbol: "diamond-open", size: 11, color: isLight ? "#073642" : "#dddddd", line: { width: 2 } },
      hovertemplate: `<b>${obs.final ? "Observed season peak" : "Highest week so far"}</b><br>${fmtWeek(obs.date, true)}: ${fmtCount(obs.value)}${obs.final ? "" : `<br><i>Provisional until the window closes (${fmtWeek(data.window[1], true)})</i>`}<extra></extra>`,
      showlegend: true,
    });
    if (ridges.length) {
      shapes.push({
        type: "line", xref: "x", yref: "y2 domain", x0: obs.date, x1: obs.date, y0: 0, y1: 1,
        line: { color: isLight ? "rgba(7,54,66,0.55)" : "rgba(246,244,238,0.45)", width: 1.2, dash: obs.final ? "solid" : "dot" },
      });
    }
  }

  // ---- Ridgelines: each model's peak-week pmf in its own lane on the shared date axis
  const overlap = 1.7;
  const pmax = Math.max(0.05, ...ridges.map((r) => Math.max(...r.timing.probs)));
  ridges.forEach((r, k) => {
    const base = ridges.length - 1 - k;
    const color = colorOf(r.m.model_id, r.i);
    const { x, y } = ridgeXY(r.timing.dates, r.timing.probs, base, overlap / pmax);
    traces.push({
      x, y, xaxis: "x", yaxis: "y2", type: "scatter", mode: "lines", fill: "toself",
      fillcolor: hexToRgba(color, 0.32), line: { color, width: 1, shape: "linear" },
      legendgroup: r.m.model_id, showlegend: false, hoverinfo: "skip",
    });
    // Invisible per-week points carry the hover (probability of each week)
    traces.push({
      x: r.timing.dates.map(ms), y: r.timing.probs.map((p) => base + (p * overlap) / pmax),
      customdata: r.timing.probs, xaxis: "x", yaxis: "y2", type: "scatter", mode: "markers",
      marker: { size: 6, color: "rgba(0,0,0,0)" }, legendgroup: r.m.model_id, showlegend: false,
      hovertemplate: `<b>${escapeHtml(nameOf(r.m.model_id))}</b><br>Peak in week ending %{x|%b %d}: %{customdata:.1%}<extra></extra>`,
    });
    // Median tick
    traces.push({
      x: [ms(r.timing.median), ms(r.timing.median)], y: [base, base + 0.85], xaxis: "x", yaxis: "y2",
      type: "scatter", mode: "lines", line: { color, width: 2 }, legendgroup: r.m.model_id, showlegend: false, hoverinfo: "skip",
    });
    annotations.push({
      xref: "paper", yref: "y2", x: 0, y: base + 0.18, xanchor: "left", yanchor: "bottom", showarrow: false,
      text: escapeHtml(nameOf(r.m.model_id)).slice(0, 34),
      font: { family: "JetBrains Mono, monospace", size: lanePx < 17 ? 8 : 9, color },
      bgcolor: theme.badgeBg, borderpad: 1,
    });
  });

  // ---- Data cutoff / reference date demarcation (same language as the fan chart)
  const refDate = data.reference_date;
  shapes.push(
    { type: "rect", xref: "x", yref: "paper", x0: cutoff, x1: refDate, y0: 0, y1: 1, fillcolor: theme.cutoffFill, line: { width: 0 } },
    { type: "line", xref: "x", yref: "paper", x0: refDate, x1: refDate, y0: 0, y1: 1, line: { color: theme.refLine, width: 1, dash: "dot" } },
  );
  annotations.push({
    x: refDate, y: 1, xref: "x", yref: "paper", xanchor: "left", yanchor: "top", showarrow: false,
    text: " Round", font: { family: "JetBrains Mono, monospace", size: 9, color: theme.textMuted },
  });
  if (ridges.length) {
    annotations.push({
      xref: "paper", yref: "paper", x: 1, y: ridgeTop + 0.005, xanchor: "right", yanchor: "bottom", showarrow: false,
      text: "PEAK WEEK PROBABILITY", font: { family: "JetBrains Mono, monospace", size: 8.5, color: theme.textMuted },
    });
  }

  // ---- Axes: the whole forecast window, from a few weeks before it opens to a week after it closes
  const w0 = data.window?.[0] || (truth[0] && truth[0].date) || refDate;
  const w1 = data.window?.[1] || refDate;
  const xr = [ms(w0) - 21 * DAY, ms(w1) + 10 * DAY];
  const vis = (v) => Number.isFinite(v) ? v : 0;
  const yMax = Math.max(
    1,
    ...truth.filter((p) => ms(p.date) >= xr[0] && ms(p.date) <= xr[1]).map((p) => vis(p.value)),
    ...lanes.flatMap((r) => (r.size ? [vis(r.size.i90[1])] : [])),
    obs ? obs.value : 0,
  );

  const layout = {
    height,
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "Inter, sans-serif", color: theme.axisColor, size: 11 },
    margin: { l: 62, r: 22, t: 14, b: 40 },
    xaxis: {
      type: "date", range: [iso(xr[0]), iso(xr[1])], gridcolor: theme.gridColor, linecolor: theme.lineColor,
      tickfont: { family: "JetBrains Mono, monospace", size: 10, color: theme.axisColor }, anchor: ridges.length ? "y2" : "y",
      showspikes: true, spikemode: "across", spikethickness: 1, spikedash: "dot", spikecolor: theme.spikeColor,
    },
    yaxis: {
      domain: mainDomain, range: [0, yMax * 1.1], rangemode: "tozero", gridcolor: theme.gridColor, linecolor: theme.lineColor,
      tickfont: { family: "JetBrains Mono, monospace", size: 10, color: theme.axisColor },
      title: { text: "Peak weekly admissions", font: { size: 11, color: theme.axisColor } },
    },
    showlegend: true,
    legend: { orientation: "h", x: 0.5, xanchor: "center", y: -0.06 * (500 / height), yanchor: "top", font: { size: 10, color: theme.legendColor } },
    hovermode: "closest",
    hoverlabel: { bgcolor: theme.hoverBg, bordercolor: theme.hoverBorder, font: { family: "Inter, sans-serif", size: 11, color: theme.hoverText }, align: "left" },
    shapes, annotations,
    uirevision: `peak_${data.location}_${data.season}`,
  };
  if (ridges.length) {
    layout.yaxis2 = {
      domain: [0, ridgeTop], range: [-0.15, ridges.length + overlap - 0.6], showgrid: false, zeroline: false,
      showticklabels: false, fixedrange: true, linecolor: theme.lineColor,
    };
  }
  if (!lanes.length) {
    annotations.push({
      xref: "paper", yref: "paper", x: 0.5, y: 0.55, showarrow: false,
      text: data.models.length ? "No peak forecasts for this round" : "No peak forecasts for the selected models",
      font: { size: 12, color: theme.textMuted }, bgcolor: theme.badgeBg, bordercolor: theme.lineColor, borderwidth: 1, borderpad: 8,
    });
  }

  Plotly.react(el, traces, layout, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["lasso2d", "select2d"] });
}

// ----------------------------------------------------------------------------
// 2. Peak call by round (one model)
// ----------------------------------------------------------------------------

function populateEvolutionModelSelect(data, withPeaks) {
  const sel = document.getElementById("peak-evolution-model");
  if (!sel) return;
  const ids = withPeaks.map((m) => m.model_id).filter((id) => (data.rounds[id] || []).length > 0);
  if (!ids.includes(state.peakEvolutionModel)) {
    // Prefer an ensemble, then the first model with a forecast this round
    const ens = ids.find((id) => /ensemble/i.test(id));
    const cur = data.models.find((m) => m.has_round && ids.includes(m.model_id));
    state.peakEvolutionModel = ens || cur?.model_id || ids[0] || null;
  }
  sel.innerHTML = ids.length
    ? ids.map((id) => `<option value="${escapeHtml(id)}" ${id === state.peakEvolutionModel ? "selected" : ""}>${escapeHtml(nameOf(id))}</option>`).join("")
    : `<option value="">No peak forecasts</option>`;
  sel.disabled = ids.length === 0;
}

function renderEvolution(data) {
  const el = document.getElementById("peak-evolution-plot");
  if (!el) return;
  const isLight = document.body.classList.contains("theme-light");
  const theme = getChartThemeColors(isLight);
  const mid = state.peakEvolutionModel;
  const rounds = (mid && data.rounds[mid]) || [];
  const sub = document.getElementById("peak-evolution-sub");

  if (!rounds.length) {
    if (el.data) Plotly.purge(el);
    el.innerHTML = `<div class="peak-empty">No round-by-round peak forecasts to show for ${escapeHtml(seasonLabel(data.season))}.</div>`;
    if (sub) sub.textContent = "";
    return;
  }
  if (!el.data) el.innerHTML = "";
  const color = colorOf(mid, Object.keys(state.modelColors).indexOf(mid));
  // Rounds on a categorical axis, so every row is labelled with its own date
  const refs = rounds.map((r) => fmtWeek(r.reference_date));
  const refOf = Object.fromEntries(rounds.map((r) => [fmtWeek(r.reference_date), r.reference_date]));
  const rowOf = (ref) => fmtWeek(ref);
  const weeks = Array.from(new Set(rounds.flatMap((r) => (r.timing ? r.timing.dates : [])))).sort();
  const obs = data.observed;
  if (sub) sub.textContent = `${rounds.length} round${rounds.length === 1 ? "" : "s"} · click a row to open that round`;

  const traces = [];
  const shapes = [];
  if (weeks.length) {
    const z = rounds.map((r) => {
      if (!r.timing) return weeks.map(() => null);
      const byDate = Object.fromEntries(r.timing.dates.map((d, i) => [d, r.timing.probs[i]]));
      return weeks.map((w) => (byDate[w] === undefined ? 0 : byDate[w]));
    });
    traces.push({
      type: "heatmap", x: weeks, y: refs, z, xaxis: "x", yaxis: "y", zmin: 0,
      zmax: Math.max(0.05, ...z.flat().filter((v) => v !== null)),
      colorscale: [[0, hexToRgba(color, 0.03)], [0.08, hexToRgba(color, 0.22)], [0.4, hexToRgba(color, 0.62)], [1, hexToRgba(color, 1)]],
      showscale: false, xgap: 1, ygap: 1,
      hovertemplate: "Round %{y}<br>Peak in week ending %{x|%b %d}: %{z:.1%}<extra></extra>",
    });
    // Data cutoff of each round: weeks at or left of the tick were already observed when it was made
    traces.push({
      x: rounds.map((r) => shiftDays(r.reference_date, -7)), y: refs, xaxis: "x", yaxis: "y", type: "scatter", mode: "markers",
      marker: { symbol: "line-ns", size: 11, line: { width: 1.5, color: theme.textMuted } },
      hovertemplate: "Round %{y}: data through %{x|%b %d}<extra></extra>", showlegend: false,
    });
    // Median path across rounds
    const med = rounds.filter((r) => r.timing);
    traces.push({
      x: med.map((r) => r.timing.median), y: med.map((r) => rowOf(r.reference_date)), xaxis: "x", yaxis: "y",
      type: "scatter", mode: "lines+markers", line: { color: isLight ? "#073642" : "#f6f4ee", width: 1.2 },
      marker: { size: 5, color: isLight ? "#073642" : "#f6f4ee" },
      hovertemplate: "Round %{y}<br>Median peak week: %{x|%b %d}<extra></extra>", showlegend: false,
    });
  }

  // Size intervals per round on the right
  rounds.forEach((r) => {
    if (!r.size) return;
    traces.push({
      x: [r.size.i90[0], r.size.i90[1]], y: [rowOf(r.reference_date), rowOf(r.reference_date)], xaxis: "x2", yaxis: "y",
      type: "scatter", mode: "lines", line: { color: hexToRgba(color, 0.55), width: 2 }, hoverinfo: "skip", showlegend: false,
    });
    traces.push({
      x: [r.size.i50[0], r.size.i50[1]], y: [rowOf(r.reference_date), rowOf(r.reference_date)], xaxis: "x2", yaxis: "y",
      type: "scatter", mode: "lines", line: { color, width: 6 }, hoverinfo: "skip", showlegend: false,
    });
  });
  const sized = rounds.filter((r) => r.size);
  if (sized.length) {
    traces.push({
      x: sized.map((r) => r.size.median), y: sized.map((r) => rowOf(r.reference_date)), xaxis: "x2", yaxis: "y",
      type: "scatter", mode: "markers", marker: { size: 7, color: theme.badgeBg, line: { color, width: 2 } },
      customdata: sized.map((r) => [fmtCount(r.size.i50[0]), fmtCount(r.size.i50[1]), fmtCount(r.size.i90[0]), fmtCount(r.size.i90[1])]),
      hovertemplate: "Round %{y}<br>Peak size median %{x:,.0f}<br>50% %{customdata[0]} – %{customdata[1]} · 90% %{customdata[2]} – %{customdata[3]}<extra></extra>",
      showlegend: false,
    });
  }

  // Observed peak (vertical lines on both panels) and the round currently selected
  if (obs) {
    const dash = obs.final ? "solid" : "dot";
    const lineColor = isLight ? "rgba(7,54,66,0.7)" : "rgba(246,244,238,0.6)";
    if (weeks.length) shapes.push({ type: "line", xref: "x", yref: "paper", x0: obs.date, x1: obs.date, y0: 0, y1: 1, line: { color: lineColor, width: 1.3, dash } });
    if (sized.length) shapes.push({ type: "line", xref: "x2", yref: "paper", x0: obs.value, x1: obs.value, y0: 0, y1: 1, line: { color: lineColor, width: 1.3, dash } });
  }
  const curRow = refs.indexOf(rowOf(data.reference_date));
  if (curRow >= 0 && rounds[curRow].reference_date === data.reference_date) {
    shapes.push({
      type: "rect", xref: "paper", yref: "y", x0: 0, x1: 1, y0: curRow - 0.5, y1: curRow + 0.5,
      fillcolor: isLight ? "rgba(7,54,66,0.06)" : "rgba(255,255,255,0.05)", line: { width: 0 }, layer: "below",
    });
  }

  const height = Math.max(240, Math.min(560, 80 + rounds.length * 17));
  const sizeMax = Math.max(1, ...sized.map((r) => r.size.i90[1]), obs ? obs.value : 0);
  const layout = {
    height,
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: "Inter, sans-serif", color: theme.axisColor, size: 10 },
    margin: { l: 66, r: 16, t: 26, b: 36 },
    xaxis: {
      domain: [0, sized.length ? 0.62 : 1], type: "date", gridcolor: theme.gridColor, linecolor: theme.lineColor,
      tickfont: { family: "JetBrains Mono, monospace", size: 9 }, title: { text: "Peak week", font: { size: 10 } },
    },
    xaxis2: {
      domain: [weeks.length ? 0.69 : 0, 1], range: [0, sizeMax * 1.08], gridcolor: theme.gridColor, linecolor: theme.lineColor,
      tickfont: { family: "JetBrains Mono, monospace", size: 9 }, title: { text: "Peak size", font: { size: 10 } },
      anchor: "y", visible: sized.length > 0,
    },
    yaxis: {
      type: "category", categoryorder: "array", categoryarray: refs, autorange: "reversed",
      gridcolor: "rgba(0,0,0,0)", linecolor: theme.lineColor,
      tickfont: { family: "JetBrains Mono, monospace", size: 9 }, dtick: rounds.length > 24 ? 2 : 1,
    },
    hovermode: "closest",
    hoverlabel: { bgcolor: theme.hoverBg, bordercolor: theme.hoverBorder, font: { family: "Inter, sans-serif", size: 11, color: theme.hoverText } },
    shapes,
    annotations: [
      { xref: "paper", yref: "paper", x: 0, y: 1.02, xanchor: "left", yanchor: "bottom", showarrow: false,
        text: "TIMING (probability per week)", font: { family: "JetBrains Mono, monospace", size: 8.5, color: theme.textMuted } },
      ...(sized.length ? [{ xref: "paper", yref: "paper", x: weeks.length ? 0.69 : 0, y: 1.02, xanchor: "left", yanchor: "bottom", showarrow: false,
        text: "SIZE (median · 50% · 90%)", font: { family: "JetBrains Mono, monospace", size: 8.5, color: theme.textMuted } }] : []),
    ],
    showlegend: false,
    uirevision: `peakevo_${mid}_${data.location}_${data.season}`,
  };

  el._peakRefOf = refOf;
  Plotly.react(el, traces, layout, { responsive: true, displaylogo: false, displayModeBar: false }).then(() => {
    if (!el._peakClickBound) {
      el._peakClickBound = true;
      el.on("plotly_click", (ev) => {
        const pt = ev?.points?.[0];
        if (!pt || pt.y === undefined) return;
        const ref = el._peakRefOf?.[pt.y];
        if (ref && ref !== state.selectedDate) {
          callbacks.onSelectDate?.(ref);
        }
      });
    }
  });
}

// ----------------------------------------------------------------------------
// 3. Scorecard
// ----------------------------------------------------------------------------

function renderScorecard(data) {
  const el = document.getElementById("peak-scorecard");
  if (!el) return;
  document.querySelectorAll("#peak-score-mode .segment-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.peakScoreMode));
  document.querySelectorAll("#peak-skill-scope .segment-btn").forEach((b) => b.classList.toggle("active", b.dataset.scope === state.peakSkillScope));
  const scopeCtl = document.getElementById("peak-skill-scope");
  if (scopeCtl) scopeCtl.classList.toggle("hidden", state.peakScoreMode !== "skill");
  el.innerHTML = state.peakScoreMode === "skill" ? skillTableHtml(data) : roundTableHtml(data);
}

function roundTableHtml(data) {
  const rows = data.models.filter((m) => m.timing || m.size);
  const final = data.observed?.final;
  const noRound = data.models.filter((m) => !m.has_round).map((m) => m.model_id);
  const none = data.missing || [];
  if (!rows.length) {
    return `<div class="peak-empty">No peak forecasts for this round.${footnote(noRound, none)}</div>`;
  }
  rows.sort((a, b) => (a.timing && b.timing ? a.timing.median.localeCompare(b.timing.median) : a.timing ? -1 : 1));
  const obs = data.observed;
  const head = `
    <tr>
      <th>Model</th>
      <th title="Median of the peak-week distribution">Peak week</th>
      <th title="Central 50% of the peak-week distribution">50% window</th>
      <th title="Probability that the peak is in a week already observed at this round's data cutoff">Past?</th>
      <th title="Median forecast of the highest weekly count">Peak size</th>
      <th title="Central 90% interval of the peak size">90% range</th>
      ${final ? `<th title="Forecast median minus the observed peak week">Δ wks</th><th title="Ranked probability score of the timing forecast, in weeks (lower is better)">RPS</th><th title="Forecast median size vs the observed peak">Size err</th>` : ""}
    </tr>`;
  const body = rows.map((m) => {
    const t = m.timing;
    const s = m.size;
    const sc = m.scores || {};
    const color = colorOf(m.model_id, Object.keys(state.modelColors).indexOf(m.model_id));
    const dWk = sc.timing ? sc.timing.week_error : null;
    const sizeErr = sc.size && sc.size.pct_error !== null ? sc.size.pct_error : null;
    return `
      <tr>
        <td class="peak-td-model" title="${escapeHtml(nameOf(m.model_id))}"><span class="peak-swatch" style="background:${color}"></span>${escapeHtml(shortName(m.model_id))}</td>
        <td class="mono">${t ? fmtWeek(t.median) : "—"}</td>
        <td class="mono dim">${t ? `${fmtWeek(t.i50[0])} – ${fmtWeek(t.i50[1])}` : "—"}</td>
        <td class="mono dim">${t && t.p_passed !== undefined ? fmtPct(t.p_passed) : "—"}</td>
        <td class="mono">${s ? fmtCount(s.median) : "—"}</td>
        <td class="mono dim">${s ? `${fmtCount(s.i90[0])} – ${fmtCount(s.i90[1])}` : "—"}</td>
        ${final ? `
          <td class="mono ${dWk === 0 ? "lead" : ""}">${dWk === null ? "—" : dWk > 0 ? `+${dWk}` : dWk}</td>
          <td class="mono">${sc.timing ? sc.timing.rps.toFixed(2) : "—"}</td>
          <td class="mono">${sizeErr === null ? "—" : `${sizeErr > 0 ? "+" : ""}${sizeErr.toFixed(0)}%`}</td>` : ""}
      </tr>`;
  }).join("");
  const obsLine = obs
    ? obs.final
      ? `Observed peak: <strong>${fmtCount(obs.value)}</strong> in the week ending ${fmtWeek(obs.date, true)}.`
      : `Peak so far: ${fmtCount(obs.value)} (${fmtWeek(obs.date)}); scores appear once the window closes ${fmtWeek(data.window?.[1], true)}.`
    : "";
  return `
    <table class="peak-table"><thead>${head}</thead><tbody>${body}</tbody></table>
    <div class="peak-table-foot">${obsLine}${footnote(noRound, none)}</div>`;
}

function footnote(noRound, none) {
  const parts = [];
  const listed = (ids) => ids.slice(0, 6).map((id) => escapeHtml(nameOf(id))).join(", ") + (ids.length > 6 ? ` +${ids.length - 6} more` : "");
  if (noRound.length) parts.push(`No forecast this round: ${listed(noRound)}.`);
  if (none.length) parts.push(`No peak forecasts at all: ${listed(none)}.`);
  return parts.length ? `<span class="peak-foot-models">${parts.join(" ")}</span>` : "";
}

function skillTableHtml(data) {
  const sk = data.skill || {};
  const where = state.peakSkillScope === "states" ? "all states" : escapeHtml(data.location_name || data.location);
  if (!sk.final) {
    const obs = data.observed;
    return `<div class="peak-empty">
      The ${escapeHtml(seasonLabel(data.season))} peak is not final yet for ${where}. Peak forecasts are scored once observations
      reach the end of the forecast window (${fmtWeek(data.window?.[1], true)}).
      ${obs ? `<br>Highest week so far: ${fmtCount(obs.value)} (${fmtWeek(obs.date, true)}).` : ""}
    </div>`;
  }
  const rows = sk.models || [];
  if (!rows.length) return `<div class="peak-empty">No peak forecasts from the selected models in ${escapeHtml(seasonLabel(data.season))}.</div>`;
  const best = (key, lowIsGood = true) => {
    const vals = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
    if (!vals.length) return null;
    return lowIsGood ? Math.min(...vals) : Math.max(...vals);
  };
  const bRps = best("rps");
  const bLog = best("log_score");
  const bWk = best("abs_week_error");
  const bWis = best("size_wis_pct");
  const cell = (v, b, fmt) => `<td class="mono ${v !== null && v !== undefined && b !== null && Math.abs(v - b) < 1e-9 ? "lead" : ""}">${v === null || v === undefined ? "—" : fmt(v)}</td>`;
  const body = rows.map((r) => {
    const color = colorOf(r.model_id, Object.keys(state.modelColors).indexOf(r.model_id));
    return `<tr>
      <td class="peak-td-model" title="${escapeHtml(nameOf(r.model_id))}"><span class="peak-swatch" style="background:${color}"></span>${escapeHtml(shortName(r.model_id))}</td>
      <td class="mono dim">${r.n_timing || r.n_size}</td>
      ${cell(r.rps, bRps, (v) => v.toFixed(2))}
      ${cell(r.log_score, bLog, (v) => v.toFixed(2))}
      ${cell(r.abs_week_error, bWk, (v) => v.toFixed(1))}
      <td class="mono dim">${fmtPct(r.timing_in50)} / ${fmtPct(r.timing_in90)}</td>
      ${cell(r.size_wis_pct, bWis, (v) => `${v.toFixed(1)}%`)}
      <td class="mono">${r.size_abs_pct_error === null ? "—" : `${r.size_abs_pct_error.toFixed(0)}%`}</td>
      <td class="mono dim">${fmtPct(r.size_in50)} / ${fmtPct(r.size_in90)}</td>
    </tr>`;
  }).join("");
  return `
    <table class="peak-table">
      <thead><tr>
        <th>Model</th>
        <th title="Forecasts scored (rounds × locations)">N</th>
        <th title="Ranked probability score of the peak-week pmf, in weeks. Rewards near misses; lower is better">RPS</th>
        <th title="−ln P(observed peak week), floored at P = 0.001. Lower is better">Log</th>
        <th title="Mean |median peak week − observed peak week|, in weeks">|Δ| wks</th>
        <th title="How often the observed peak week fell in the 50% / 90% windows (nominal 50% / 90%)">Hit 50/90</th>
        <th title="Weighted interval score of the peak size, as % of the observed peak. Lower is better">WIS %</th>
        <th title="Mean |median size − observed peak| as % of the observed peak">|Err|</th>
        <th title="Coverage of the 50% / 90% peak-size intervals">Cov 50/90</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
    <div class="peak-table-foot">
      ${sk.scope === "states" ? `Pooled over ${sk.locations} states with a final peak` : "Every round"} in ${escapeHtml(seasonLabel(data.season))}${sk.common ? ", on the rounds all models forecast" : ", each model on its own rounds"}.
      ${sk.pending_locations ? ` ${sk.pending_locations} location(s) still provisional are left out.` : ""}
    </div>`;
}

// ----------------------------------------------------------------------------
// Controls (bound once from main.js)
// ----------------------------------------------------------------------------

export function initPeakControls(cbs = {}) {
  callbacks = { ...callbacks, ...cbs };
  const sel = document.getElementById("peak-evolution-model");
  if (sel && !sel._bound) {
    sel._bound = true;
    sel.addEventListener("change", () => {
      state.peakEvolutionModel = sel.value || null;
      callbacks.onUrlUpdate?.();
      if (state.peakData) renderEvolution(state.peakData);
    });
  }
  document.querySelectorAll("#peak-score-mode .segment-btn").forEach((btn) => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", () => {
      state.peakScoreMode = btn.dataset.mode;
      if (state.peakData) renderScorecard(state.peakData);
    });
  });
  document.querySelectorAll("#peak-skill-scope .segment-btn").forEach((btn) => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", () => {
      if (state.peakSkillScope === btn.dataset.scope) return;
      state.peakSkillScope = btn.dataset.scope;
      fetchAndRenderPeaks();
    });
  });
}

export function resizePeakPlots() {
  ["peak-outlook-plot", "peak-evolution-plot"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.data && el.offsetParent !== null) {
      try { Plotly.Plots.resize(el); } catch (_) { /* hidden */ }
    }
  });
}
