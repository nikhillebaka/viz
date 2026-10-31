/**
 * FluSight Sandbox Lab — Statistical Diagnostics Suite
 * WIS Error Decomposition, Calibration Reliability Diagrams & Horizon Decay Analysis.
 */

import { ICONS, SIMPLE_INFO_SVG, PALETTE, escapeHtml, sourceTagHtml, modelLabel } from "../constants.js";
import { state } from "../state.js";

export function setupDiagnosticsControls() {
  const decompScaleSeg = document.getElementById("decomp-scale-segmented");
  if (decompScaleSeg) {
    decompScaleSeg.querySelectorAll(".segment-btn, .segmented-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        decompScaleSeg.querySelectorAll(".segment-btn, .segmented-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.decompScale = btn.getAttribute("data-scale") || "absolute";
        renderDecompositionPlot();
      });
    });
  }
}

export function getNominalCoverage(calibObj, level) {
  if (!calibObj || typeof calibObj !== "object") return null;
  if (calibObj[level] !== undefined && calibObj[level] !== null) return Number(calibObj[level]);
  const strKey = String(level);
  if (calibObj[strKey] !== undefined && calibObj[strKey] !== null) return Number(calibObj[strKey]);
  const numKey = Number(level);
  if (calibObj[numKey] !== undefined && calibObj[numKey] !== null) return Number(calibObj[numKey]);
  for (const [k, v] of Object.entries(calibObj)) {
    if (Math.abs(parseFloat(k) - level) < 0.001) return Number(v);
  }
  return null;
}

export function renderDecompositionView() {
  const guardEl = document.getElementById("decomp-sample-guard");
  const rankings = (state.latestRankings || []).filter((r) => r.has_data_in_scope && r.wis !== null && r.count > 0);

  if (rankings.length === 0) {
    if (guardEl) {
      if (state.selectedModels.size > 0 && state.fairCommonTasks) {
        guardEl.innerHTML = `
          <div class="stats-sample-warning">
            <span class="warning-icon">${ICONS.warning}</span>
            <div class="warning-body">
              <div class="warning-title">Zero Common Tasks Across Selected Models</div>
              <div class="warning-desc">The ${state.selectedModels.size} selected models share no common forecast dates or locations in this scope. Turn <strong>Common Tasks: OFF</strong> to inspect individual model error anatomy across each model's full evaluation window.</div>
            </div>
          </div>
        `;
      } else {
        guardEl.innerHTML = `
          <div class="stats-sample-warning">
            <span class="warning-icon info-icon">${ICONS.info}</span>
            <div class="warning-body">
              <div class="warning-title">No Models Evaluated</div>
              <div class="warning-desc">Select one or more forecasting models from the drawer above to inspect WIS error decomposition and directional penalties.</div>
            </div>
          </div>
        `;
      }
    }
    const plotEl = document.getElementById("decomp-plot");
    if (plotEl) {
      plotEl.innerHTML = (state.selectedModels.size > 0 && state.fairCommonTasks)
        ? `<div class="plot-empty-state">No shared forecast tasks to decompose. Turn Common Tasks OFF or select models with overlapping dates.</div>`
        : `<div class="plot-empty-state">No model metrics available. Select models in the top drawer.</div>`;
    }
    const cardsEl = document.getElementById("decomp-cards");
    if (cardsEl) cardsEl.innerHTML = "";
    return;
  }

  const maxN = rankings.reduce((m, r) => Math.max(m, r.count || 0), 0);
  const isSmallSample = maxN < 10;

  if (guardEl) {
    if (isSmallSample) {
      guardEl.innerHTML = `
        <div class="stats-sample-warning">
          <span class="warning-icon">${ICONS.warning}</span>
          <div class="warning-body">
            <div class="warning-title">Small Sample Notice (N = ${maxN} forecast tasks)</div>
            <div class="warning-desc">
              Computing error decomposition on a small number of tasks (N &le; 10) is subject to high sample variance. A single anomalous week or reporting artifact can disproportionately skew the proportion of sharpness and over/underprediction penalties. Consider evaluating across more jurisdictions or dates.
            </div>
            <div class="warning-actions">
              <button type="button" class="warning-action-btn" id="btn-decomp-to-states">
                Evaluate All 50 States
              </button>
              <button type="button" class="warning-action-btn secondary" id="btn-decomp-to-season">
                Full Season Across States
              </button>
            </div>
          </div>
        </div>
      `;
      const btnStates = document.getElementById("btn-decomp-to-states");
      if (btnStates) btnStates.addEventListener("click", () => window.setEvalScope?.("states"));
      const btnSeason = document.getElementById("btn-decomp-to-season");
      if (btnSeason) btnSeason.addEventListener("click", () => window.setEvalScope?.("all"));
    } else {
      guardEl.innerHTML = "";
    }
  }

  renderDecompositionPlot();
  renderDecompositionCards();
}

export function renderDecompositionPlot() {
  const plotEl = document.getElementById("decomp-plot");
  if (!plotEl) return;

  const rankings = (state.latestRankings || []).slice(0, 10);
  if (rankings.length === 0) {
    plotEl.innerHTML = `<div class="plot-empty-state">No model metrics available.</div>`;
    return;
  }

  const sorted = [...rankings].reverse();
  const yModels = sorted.map((r) => r.model_id);

  const xSharp = [];
  const xOver = [];
  const xUnder = [];
  const customSharp = [];
  const customOver = [];
  const customUnder = [];

  const isRelative = state.decompScale === "relative";

  sorted.forEach((r) => {
    const s = r.decomp_sharpness !== null && r.decomp_sharpness !== undefined ? r.decomp_sharpness : 0;
    const o = r.decomp_overpred !== null && r.decomp_overpred !== undefined ? r.decomp_overpred : 0;
    const u = r.decomp_underpred !== null && r.decomp_underpred !== undefined ? r.decomp_underpred : 0;
    const tot = s + o + u > 0 ? (s + o + u) : (r.wis || 1);

    const pctS = (s / tot) * 100;
    const pctO = (o / tot) * 100;
    const pctU = (u / tot) * 100;

    if (isRelative) {
      xSharp.push(pctS);
      xOver.push(pctO);
      xUnder.push(pctU);
    } else {
      xSharp.push(s);
      xOver.push(o);
      xUnder.push(u);
    }

    customSharp.push({ val: s, pct: pctS, tot: tot, wis: r.wis });
    customOver.push({ val: o, pct: pctO, tot: tot, wis: r.wis });
    customUnder.push({ val: u, pct: pctU, tot: tot, wis: r.wis });
  });

  const traces = [
    {
      x: xSharp,
      y: yModels,
      name: "Spread (Sharpness)",
      type: "bar",
      orientation: "h",
      marker: { color: "#38bdf8" },
      customdata: customSharp,
      hovertemplate: isRelative
        ? "<b>%{y}</b><br>Spread Component: <b>%{x:.1f}%</b> (%{customdata.val:.2f} WIS pts)<br>Total WIS: %{customdata.wis:.2f}<extra>Spread Component</extra>"
        : "<b>%{y}</b><br>Spread Component: <b>%{x:.2f} pts</b> (%{customdata.pct:.1f}%)<br>Total WIS: %{customdata.wis:.2f}<extra>Spread Component</extra>",
    },
    {
      x: xOver,
      y: yModels,
      name: "Overprediction Penalty",
      type: "bar",
      orientation: "h",
      marker: { color: "#f59e0b" },
      customdata: customOver,
      hovertemplate: isRelative
        ? "<b>%{y}</b><br>Overprediction Penalty: <b>%{x:.1f}%</b> (%{customdata.val:.2f} WIS pts)<br>Total WIS: %{customdata.wis:.2f}<extra>Overprediction</extra>"
        : "<b>%{y}</b><br>Overprediction Penalty: <b>%{x:.2f} pts</b> (%{customdata.pct:.1f}%)<br>Total WIS: %{customdata.wis:.2f}<extra>Overprediction</extra>",
    },
    {
      x: xUnder,
      y: yModels,
      name: "Underprediction Penalty",
      type: "bar",
      orientation: "h",
      marker: { color: "#f43f5e" },
      customdata: customUnder,
      hovertemplate: isRelative
        ? "<b>%{y}</b><br>Underprediction Penalty: <b>%{x:.1f}%</b> (%{customdata.val:.2f} WIS pts)<br>Total WIS: %{customdata.wis:.2f}<extra>Underprediction</extra>"
        : "<b>%{y}</b><br>Underprediction Penalty: <b>%{x:.2f} pts</b> (%{customdata.pct:.1f}%)<br>Total WIS: %{customdata.wis:.2f}<extra>Underprediction</extra>",
    },
  ];

  const isLight = document.body.classList.contains("theme-light");
  const axisColor = isLight ? "#586e75" : "#94a3b8";
  const gridColor = isLight ? "rgba(101, 123, 131, 0.14)" : "rgba(255, 255, 255, 0.04)";
  const legendColor = isLight ? "#073642" : "#cbd5e1";

  const layout = {
    barmode: "stack",
    paper_bgcolor: "rgba(0, 0, 0, 0)",
    plot_bgcolor: "rgba(0, 0, 0, 0)",
    font: { family: "Inter, -apple-system, sans-serif", color: axisColor, size: 10 },
    margin: { l: 150, r: 25, t: 15, b: 65 },
    xaxis: {
      title: {
        text: isRelative ? "Error Anatomy Share (% of Total WIS)" : "WIS Decomposition Components (Lower = Better)",
        font: { size: 10, color: axisColor },
      },
      gridcolor: gridColor,
      tickfont: { family: "JetBrains Mono, monospace", color: axisColor },
      ticksuffix: isRelative ? "%" : "",
      range: isRelative ? [0, 100] : undefined,
      automargin: true,
    },
    yaxis: {
      gridcolor: "transparent",
      tickfont: { family: "JetBrains Mono, monospace", color: axisColor, size: 10 },
      automargin: true,
    },
    legend: {
      orientation: "h",
      yanchor: "bottom",
      y: 1.02,
      xanchor: "right",
      x: 1,
      font: { color: legendColor, size: 10 },
    },
  };

  Plotly.react("decomp-plot", traces, layout, { responsive: true, displayModeBar: false });
}

export function renderDecompositionCards() {
  const cardsEl = document.getElementById("decomp-cards");
  if (!cardsEl) return;

  const rankings = (state.latestRankings || []).slice(0, 12);
  if (rankings.length === 0) {
    cardsEl.innerHTML = "";
    return;
  }

  cardsEl.innerHTML = "";

  rankings.forEach((r, idx) => {
    const card = document.createElement("div");
    card.className = "decomp-diag-card";

    const s = r.decomp_sharpness !== null && r.decomp_sharpness !== undefined ? r.decomp_sharpness : 0;
    const o = r.decomp_overpred !== null && r.decomp_overpred !== undefined ? r.decomp_overpred : 0;
    const u = r.decomp_underpred !== null && r.decomp_underpred !== undefined ? r.decomp_underpred : 0;
    const tot = s + o + u > 0 ? (s + o + u) : (r.wis || 1);

    const pctS = (s / tot) * 100;
    const pctO = (o / tot) * 100;
    const pctU = (u / tot) * 100;

    let biasClass = "balanced";
    let biasText = "Balanced Error Distribution";
    let adviceHtml = `Error is distributed across components without a single dominant directional penalty (Spread: ${pctS.toFixed(0)}%, Overprediction: ${pctO.toFixed(0)}%, Underprediction: ${pctU.toFixed(0)}%).`;

    if (pctU > 35 && u > 1.4 * Math.max(o, 0.001)) {
      biasClass = "underpred";
      biasText = "Underprediction Penalty Dominant";
      adviceHtml = `Underprediction penalty accounts for ${pctU.toFixed(1)}% of total WIS (${u.toFixed(2)} pts). Observed hospitalizations exceeded forecast quantiles and median more frequently or by larger magnitudes than they fell below.`;
    } else if (pctO > 35 && o > 1.4 * Math.max(u, 0.001)) {
      biasClass = "overpred";
      biasText = "Overprediction Penalty Dominant";
      adviceHtml = `Overprediction penalty accounts for ${pctO.toFixed(1)}% of total WIS (${o.toFixed(2)} pts). Forecast quantiles and median exceeded observed hospitalizations more frequently or by larger magnitudes than they fell below.`;
    } else if (pctS > 65) {
      biasClass = "sharpness";
      biasText = "Spread (Sharpness) Dominant";
      adviceHtml = `Spread / sharpness accounts for ${pctS.toFixed(1)}% of total WIS (${s.toFixed(2)} pts). Ground truth landed primarily within prediction corridors; the majority of WIS penalty reflects interval width rather than directional quantile misses.`;
    }

    const modelColor = state.modelColors[r.model_id] || PALETTE[idx % PALETTE.length];
    const typeBadge = sourceTagHtml(state.models[r.model_id] || { is_local: r.is_local, is_synthetic: r.is_synthetic });

    card.innerHTML = `
      <div class="decomp-card-header">
        <div class="decomp-model-info">
          <span class="decomp-model-color-bar" style="background: ${modelColor};"></span>
          <div style="min-width: 0; overflow: hidden;">
            <div class="decomp-model-name"><button type="button" class="btn-model-inspect-link" data-model="${escapeHtml(r.model_id)}" title="Inspect ${escapeHtml(r.model_id)}">${escapeHtml(modelLabel(r.model_id, state.models[r.model_id]))} <span class="inspect-icon">${SIMPLE_INFO_SVG}</span></button> ${typeBadge}</div>
            <div class="subtext" style="font-size: 0.65rem; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Rank #${idx + 1} &middot; Total WIS: ${r.wis !== null ? r.wis.toFixed(2) : "N/A"} &middot; N=${r.count || 0}</div>
          </div>
        </div>
        <span class="decomp-bias-badge ${biasClass}">${biasText}</span>
      </div>

      <div class="decomp-stacked-bar" title="Spread: ${pctS.toFixed(1)}% | Over: ${pctO.toFixed(1)}% | Under: ${pctU.toFixed(1)}%">
        <div class="decomp-bar-segment" style="width: ${pctS.toFixed(1)}%; background: #38bdf8;"></div>
        <div class="decomp-bar-segment" style="width: ${pctO.toFixed(1)}%; background: #f59e0b;"></div>
        <div class="decomp-bar-segment" style="width: ${pctU.toFixed(1)}%; background: #f43f5e;"></div>
      </div>

      <div class="decomp-metrics-row">
        <div class="decomp-metric-item">
          <span class="decomp-metric-label" style="color: #38bdf8;">Spread (Sharpness)</span>
          <span class="decomp-metric-val">${s.toFixed(2)} <span style="font-size: 0.6rem; color: var(--text-muted);">(${pctS.toFixed(1)}%)</span></span>
        </div>
        <div class="decomp-metric-item">
          <span class="decomp-metric-label" style="color: #f59e0b;">Overprediction</span>
          <span class="decomp-metric-val">${o.toFixed(2)} <span style="font-size: 0.6rem; color: var(--text-muted);">(${pctO.toFixed(1)}%)</span></span>
        </div>
        <div class="decomp-metric-item">
          <span class="decomp-metric-label" style="color: #f43f5e;">Underprediction</span>
          <span class="decomp-metric-val">${u.toFixed(2)} <span style="font-size: 0.6rem; color: var(--text-muted);">(${pctU.toFixed(1)}%)</span></span>
        </div>
      </div>

      <div class="decomp-finding-text">
        ${adviceHtml}
      </div>
    `;

    cardsEl.appendChild(card);
  });
}

export function renderCalibrationView() {
  const guardEl = document.getElementById("calib-sample-guard");
  const rankings = (state.latestRankings || []).filter((r) => r.has_data_in_scope && r.wis !== null && r.count > 0);

  if (rankings.length === 0) {
    if (guardEl) {
      if (state.selectedModels.size > 0 && state.fairCommonTasks) {
        guardEl.innerHTML = `
          <div class="stats-sample-warning">
            <span class="warning-icon">${ICONS.warning}</span>
            <div class="warning-body">
              <div class="warning-title">Zero Common Tasks Across Selected Models</div>
              <div class="warning-desc">The ${state.selectedModels.size} selected models share no common forecast dates or locations in this scope. Turn <strong>Common Tasks: OFF</strong> to inspect calibration and reliability curves for each model.</div>
            </div>
          </div>
        `;
      } else {
        guardEl.innerHTML = `
          <div class="stats-sample-warning">
            <span class="warning-icon info-icon">${ICONS.info}</span>
            <div class="warning-body">
              <div class="warning-title">No Models Evaluated</div>
              <div class="warning-desc">Select models from the top drawer to inspect empirical calibration curves and coverage scorecards.</div>
            </div>
          </div>
        `;
      }
    }
    const plotEl = document.getElementById("calibration-plot");
    if (plotEl) {
      plotEl.innerHTML = (state.selectedModels.size > 0 && state.fairCommonTasks)
        ? `<div class="plot-empty-state">No shared forecast tasks to evaluate reliability curves. Turn Common Tasks OFF or select models with overlapping dates.</div>`
        : `<div class="plot-empty-state">No model metrics available.</div>`;
    }
    const tableContainer = document.getElementById("calibration-table-container");
    if (tableContainer) tableContainer.innerHTML = "";
    return;
  }

  const maxN = rankings.reduce((m, r) => Math.max(m, r.count || 0), 0);
  const isSmallSample = maxN < 10;

  if (guardEl) {
    if (isSmallSample) {
      guardEl.innerHTML = `
        <div class="stats-sample-warning">
          <span class="warning-icon">${ICONS.warning}</span>
          <div class="warning-body">
            <div class="warning-title">Small Sample Notice (N = ${maxN} forecast tasks)</div>
            <div class="warning-desc">
              Reliability curves evaluated on small sample sizes (N &le; 10) exhibit high empirical variance and coarse coverage steps. Consider evaluating across more jurisdictions or reference dates for smoother, more stable empirical coverage curves.
            </div>
            <div class="warning-actions">
              <button type="button" class="warning-action-btn" id="btn-calib-to-states">
                Evaluate All 50 States
              </button>
              <button type="button" class="warning-action-btn secondary" id="btn-calib-to-season">
                Full Season Across States
              </button>
            </div>
          </div>
        </div>
      `;
      const btnStates = document.getElementById("btn-calib-to-states");
      if (btnStates) btnStates.addEventListener("click", () => window.setEvalScope?.("states"));
      const btnSeason = document.getElementById("btn-calib-to-season");
      if (btnSeason) btnSeason.addEventListener("click", () => window.setEvalScope?.("all"));
    } else {
      guardEl.innerHTML = "";
    }
  }

  renderCalibrationPlot();
  renderCalibrationTable();
}

export function renderCalibrationPlot() {
  const plotEl = document.getElementById("calibration-plot");
  if (!plotEl) return;

  const rankings = (state.latestRankings || []).slice(0, 8);
  if (rankings.length === 0) {
    plotEl.innerHTML = `<div class="plot-empty-state">No model metrics available.</div>`;
    return;
  }

  const nominalLevels = [0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 0.95, 0.98];
  const nominalPct = nominalLevels.map((l) => Math.round(l * 100));

  const traces = [];

  const corridorX = [0, ...nominalPct, 100];
  const lowerCorridorY = corridorX.map((x) => Math.max(0, x - 5));
  const upperCorridorY = corridorX.map((x) => Math.min(100, x + 5));

  traces.push({
    x: corridorX,
    y: lowerCorridorY,
    mode: "lines",
    line: { color: "transparent" },
    showlegend: false,
    hoverinfo: "skip",
  });

  traces.push({
    x: corridorX,
    y: upperCorridorY,
    mode: "lines",
    fill: "tonexty",
    fillcolor: "rgba(52, 211, 153, 0.08)",
    line: { color: "transparent" },
    name: "±5% Tolerance Corridor",
    hoverinfo: "skip",
  });

  traces.push({
    x: [0, 100],
    y: [0, 100],
    mode: "lines",
    line: { color: "#64748b", dash: "dash", width: 1.5 },
    name: "Ideal 1:1 Calibration",
    hoverinfo: "skip",
  });

  rankings.forEach((r, idx) => {
    const color = state.modelColors[r.model_id] || PALETTE[idx % PALETTE.length];
    const xVals = [];
    const yVals = [];
    const gapVals = [];

    nominalLevels.forEach((nom, i) => {
      const emp = getNominalCoverage(r.calibration, nom);
      if (emp !== null && !isNaN(emp)) {
        xVals.push(nominalPct[i]);
        yVals.push(emp);
        gapVals.push(emp - nominalPct[i]);
      }
    });

    if (xVals.length > 0) {
      traces.push({
        x: xVals,
        y: yVals,
        mode: "lines+markers",
        name: r.model_id,
        line: { color: color, width: 2 },
        marker: { color: color, size: 6 },
        customdata: gapVals,
        hovertemplate: `<b>${r.model_id}</b><br>Nominal Interval: %{x}%<br>Actual Empirical Coverage: %{y:.1f}%<br>Calibration Gap: %{customdata:+.1f}%<extra></extra>`,
      });
    }
  });

  const isLight = document.body.classList.contains("theme-light");
  const axisColor = isLight ? "#586e75" : "#94a3b8";
  const gridColor = isLight ? "rgba(101, 123, 131, 0.14)" : "rgba(255, 255, 255, 0.04)";
  const legendColor = isLight ? "#073642" : "#cbd5e1";

  const layout = {
    paper_bgcolor: "rgba(0, 0, 0, 0)",
    plot_bgcolor: "rgba(0, 0, 0, 0)",
    font: { family: "Inter, -apple-system, sans-serif", color: axisColor, size: 10 },
    margin: { l: 48, r: 20, t: 25, b: 45 },
    xaxis: {
      title: { text: "Nominal Prediction Interval (%)", font: { size: 10, color: axisColor } },
      gridcolor: gridColor,
      tickfont: { family: "JetBrains Mono, monospace", color: axisColor },
      range: [0, 102],
      dtick: 20,
      automargin: true,
    },
    yaxis: {
      title: { text: "Empirical Ground-Truth Coverage (%)", font: { size: 10, color: axisColor } },
      gridcolor: gridColor,
      tickfont: { family: "JetBrains Mono, monospace", color: axisColor },
      range: [0, 105],
      dtick: 20,
      automargin: true,
    },
    legend: {
      orientation: "h",
      yanchor: "bottom",
      y: 1.03,
      xanchor: "right",
      x: 1,
      font: { color: legendColor, size: 9 },
    },
    annotations: [
      {
        x: 20,
        y: 86,
        xref: "x",
        yref: "y",
        text: "<b>Overdispersed Zone ↑</b><br><span style='font-size:8.5px;opacity:0.8;'>Wider intervals / conservative</span>",
        showarrow: false,
        font: { size: 9.5, color: isLight ? "#0284c7" : "#38bdf8" },
        align: "left",
      },
      {
        x: 75,
        y: 16,
        xref: "x",
        yref: "y",
        text: "<b>Underdispersed Zone ↓</b><br><span style='font-size:8.5px;opacity:0.8;'>Narrower intervals / overconfident</span>",
        showarrow: false,
        font: { size: 9.5, color: isLight ? "#e11d48" : "#f43f5e" },
        align: "right",
      },
    ],
  };

  Plotly.react("calibration-plot", traces, layout, { responsive: true, displayModeBar: false });
}

export function renderCalibrationTable() {
  const container = document.getElementById("calibration-table-container");
  if (!container) return;

  const rankings = state.latestRankings || [];
  if (rankings.length === 0) {
    container.innerHTML = `<div class="subtext" style="padding: 16px; color: var(--text-muted);">No models available.</div>`;
    return;
  }

  const nominalLevels = [0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 0.95, 0.98];

  let tableHtml = `
    <table class="calibration-table">
      <colgroup>
        <col style="width: 27%;">
        <col style="width: 12%;">
        <col style="width: 12%;">
        <col style="width: 12%;">
        <col style="width: 11%;">
        <col style="width: 26%;">
      </colgroup>
      <thead>
        <tr>
          <th>Model</th>
          <th style="text-align:right;" title="Nominal Target: 95.0%">95% Cov</th>
          <th style="text-align:right;" title="Nominal Target: 80.0%">80% Cov</th>
          <th style="text-align:right;" title="Nominal Target: 50.0%">50% IQR</th>
          <th style="text-align:right;" title="Mean Calibration Error (lower is better)">MCE</th>
          <th style="text-align:center;">Status</th>
        </tr>
      </thead>
      <tbody>
  `;

  rankings.forEach((r, idx) => {
    const c95 = getNominalCoverage(r.calibration, 0.95);
    const c80 = getNominalCoverage(r.calibration, 0.80);
    const c50 = getNominalCoverage(r.calibration, 0.50);

    let totalAbsErr = 0;
    let evalPoints = 0;
    nominalLevels.forEach((nom) => {
      const emp = getNominalCoverage(r.calibration, nom);
      if (emp !== null && !isNaN(emp)) {
        totalAbsErr += Math.abs(emp - nom * 100);
        evalPoints += 1;
      }
    });

    const mce = evalPoints > 0 ? (totalAbsErr / evalPoints) : null;

    let diagBadge = `<span class="calib-status-badge moderate">N/A</span>`;
    if (mce !== null) {
      if (mce <= 4.5 && (c95 === null || c95 >= 91)) {
        diagBadge = `<span class="calib-status-badge nominal" title="Mean Calibration Error ${mce.toFixed(1)}% (Nominal coverage maintained)">Nominal</span>`;
      } else if ((c95 !== null && c95 < 85) || (c50 !== null && c50 < 35)) {
        // Under-coverage at either level means intervals are too narrow (overconfident / underdispersed)
        diagBadge = `<span class="calib-status-badge overconf" title="Empirical coverage well below nominal (95%: ${c95?.toFixed(1) ?? "--"}%, 50%: ${c50?.toFixed(1) ?? "--"}%)">Overconfident</span>`;
      } else if ((c95 !== null && c95 < 92) || (c50 !== null && c50 < 42)) {
        diagBadge = `<span class="calib-status-badge underdisp" title="Empirical coverage slightly below nominal (95%: ${c95?.toFixed(1) ?? "--"}%, 50%: ${c50?.toFixed(1) ?? "--"}%)">Slightly Overconfident</span>`;
      } else if ((c50 !== null && c50 > 65) || (c95 !== null && c95 > 98)) {
        diagBadge = `<span class="calib-status-badge overdisp" title="Empirical coverage exceeds nominal levels">Conservative</span>`;
      } else {
        diagBadge = `<span class="calib-status-badge moderate">Moderate</span>`;
      }
    }

    const modelColor = state.modelColors[r.model_id] || PALETTE[idx % PALETTE.length];
    const fmtCov = (val, nom) => {
      if (val === null || isNaN(val)) return "--";
      const gap = val - nom;
      const color = Math.abs(gap) <= 5 ? "var(--color-success)" : (gap < -8 ? "var(--color-danger)" : "var(--color-warning)");
      return `<span style="color: ${color}; font-weight: 600;">${val.toFixed(1)}%</span>`;
    };

    tableHtml += `
      <tr>
        <td style="font-weight: 500;">
          <div style="display:flex;align-items:center;gap:6px;min-width:0;">
            <span style="display:inline-block;width:3px;height:16px;background:${modelColor};border-radius:2px;flex-shrink:0;"></span>
            <div style="min-width:0;line-height:1.2;overflow:hidden;">
              <div class="mono-model-cell" style="font-size:0.71rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><button type="button" class="btn-model-inspect-link" data-model="${escapeHtml(r.model_id)}" title="Inspect ${escapeHtml(r.model_id)}">${escapeHtml(r.model_id)} <span class="inspect-icon">${SIMPLE_INFO_SVG}</span></button></div>
              <div style="font-size:0.61rem;color:var(--text-muted);font-family:var(--font-mono);white-space:nowrap;">N=${r.count || 0} tasks</div>
            </div>
          </div>
        </td>
        <td style="text-align:right;font-family:var(--font-mono);">${fmtCov(c95, 95)}</td>
        <td style="text-align:right;font-family:var(--font-mono);">${fmtCov(c80, 80)}</td>
        <td style="text-align:right;font-family:var(--font-mono);">${fmtCov(c50, 50)}</td>
        <td style="text-align:right;font-weight:600;font-family:var(--font-mono);">${mce !== null ? mce.toFixed(1) + "%" : "--"}</td>
        <td style="text-align:center;">${diagBadge}</td>
      </tr>
    `;
  });

  tableHtml += `
      </tbody>
    </table>
  `;

  container.innerHTML = tableHtml;
}

export function renderHorizonBarChart(rankings) {
  const plotEl = document.getElementById("horizon-plot");
  if (!plotEl) return;

  const activeRankings = (rankings || []).filter((r) => r.has_data_in_scope && r.wis !== null && r.count > 0);
  if (!activeRankings || activeRankings.length === 0) {
    if (state.selectedModels.size > 0 && state.fairCommonTasks) {
      plotEl.innerHTML = `<div class="plot-empty-state">No shared forecast tasks across the selected models. Turn Common Tasks OFF to evaluate models across their individual seasons.</div>`;
    } else {
      plotEl.innerHTML = `<div class="plot-empty-state">No model metrics available. Select models in the top drawer.</div>`;
    }
    return;
  }

  const traces = [];
  const horizons = ["h=0 (Nowcast)", "h=1", "h=2", "h=3"];

  activeRankings.slice(0, 8).forEach((r) => {
    const color = state.modelColors[r.model_id] || "#00f0ff";
    const yVals = [0, 1, 2, 3].map((h) => {
      return r.by_horizon && r.by_horizon[h] ? r.by_horizon[h].wis : null;
    });

    traces.push({
      x: horizons,
      y: yVals,
      name: r.model_id,
      type: "bar",
      marker: { color: color },
      hovertemplate: `<b>${r.model_id}</b><br>%{x}<br>WIS: %{y:,.2f}<extra></extra>`,
    });
  });

  const isLight = document.body.classList.contains("theme-light");
  const axisColor = isLight ? "#586e75" : "#94a3b8";
  const gridColor = isLight ? "rgba(101, 123, 131, 0.14)" : "rgba(255, 255, 255, 0.04)";
  const legendColor = isLight ? "#073642" : "#cbd5e1";

  const layout = {
    barmode: "group",
    paper_bgcolor: "rgba(0, 0, 0, 0)",
    plot_bgcolor: "rgba(0, 0, 0, 0)",
    font: { family: "Inter, -apple-system, sans-serif", color: axisColor, size: 10 },
    margin: { l: 50, r: 20, t: 15, b: 35 },
    xaxis: {
      gridcolor: gridColor,
      tickfont: { family: "JetBrains Mono, monospace", color: axisColor },
    },
    yaxis: {
      title: { text: "WIS by Horizon (Lower = Better)", font: { size: 10, color: axisColor } },
      gridcolor: gridColor,
      tickfont: { family: "JetBrains Mono, monospace", color: axisColor },
    },
    legend: {
      orientation: "h",
      yanchor: "bottom",
      y: 1.02,
      xanchor: "right",
      x: 1,
      font: { color: legendColor, size: 10 },
    },
  };

  const config = { responsive: true, displayModeBar: false };
  Plotly.react("horizon-plot", traces, layout, config);
}
