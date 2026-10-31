/**
 * FluSight Sandbox Lab — Leaderboard Table, Telemetry Strip & Evaluation Scope
 */

import { ICONS, SIMPLE_INFO_SVG, escapeHtml, sourceTagHtml, modelLabel } from "../constants.js";
import { state, formatSeasonShort } from "../state.js";
import { fetchMetrics, createRequestGuard } from "../api.js";
import { resolveEvalScope, describeWindow } from "./eval_window.js";

const metricsGuard = createRequestGuard();

// Fixed decimals, but small magnitudes (e.g. proportion targets, WIS ~0.003) keep 3 significant digits
const fmtScore = (v, digits) => (v !== 0 && Math.abs(v) < 1 ? Number(v.toPrecision(3)).toString() : v.toFixed(digits));
let lastMetricsParamsKey = "";
const metricsResponseCache = new Map();
const MAX_METRICS_CACHE_SIZE = 50;

/** Forget cached leaderboard responses (the model inventory or truth data changed). */
export function clearMetricsCache() {
  metricsResponseCache.clear();
  lastMetricsParamsKey = "";
}

export function setMetricsLoadingState(isLoading, customMessage = "") {
  const overlay = document.getElementById("metrics-loading-overlay");
  const subText = document.getElementById("loading-sub-text");
  const locSegmented = document.getElementById("eval-loc-segmented");
  const horizonSegmented = document.getElementById("eval-horizon-segmented");
  const telemetryStrip = document.getElementById("telemetry-strip");
  const btnToggleFair = document.getElementById("btn-toggle-fair");

  if (isLoading) {
    if (overlay) {
      if (customMessage && subText) {
        subText.textContent = customMessage;
      }
      overlay.classList.remove("hidden");
    }
    if (btnToggleFair) btnToggleFair.classList.add("loading");
    if (locSegmented) locSegmented.classList.add("loading");
    if (horizonSegmented) horizonSegmented.classList.add("loading");
    if (telemetryStrip) telemetryStrip.classList.add("loading");
  } else {
    if (overlay) overlay.classList.add("hidden");
    if (btnToggleFair) btnToggleFair.classList.remove("loading");
    if (locSegmented) locSegmented.classList.remove("loading");
    if (horizonSegmented) horizonSegmented.classList.remove("loading");
    if (telemetryStrip) telemetryStrip.classList.remove("loading");
  }
}

export function updateEvalContextBanner(data) {
  const banner = document.getElementById("eval-context-banner");
  const textEl = document.getElementById("eval-banner-text");
  const rightEl = document.getElementById("eval-banner-right");
  const iconEl = document.getElementById("eval-banner-icon");
  const btnToggleFair = document.getElementById("btn-toggle-fair");
  if (!banner || !textEl || !rightEl) return;

  if (!data) {
    banner.classList.remove("warning");
    textEl.textContent = "Select models to begin evaluation.";
    rightEl.innerHTML = "";
    return;
  }

  if (data.common_task_status === "empty_disjoint") {
    banner.classList.add("warning");
    if (iconEl) {
      iconEl.innerHTML = ICONS.warningSmall;
    }
    textEl.textContent = data.common_task_message || "Zero common tasks found across selected models (disjoint forecast rounds).";
    rightEl.innerHTML = `<button type="button" class="eval-banner-action-btn" id="btn-banner-fair-off">Turn Common Tasks OFF</button>`;
    const btn = document.getElementById("btn-banner-fair-off");
    if (btn && btnToggleFair) {
      btn.addEventListener("click", () => {
        btnToggleFair.click();
      });
    }
    return;
  }

  banner.classList.remove("warning");
  if (iconEl) {
    iconEl.innerHTML = `<svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`;
  }

  const scopeType = data.scope_type || "date";
  const numRounds = data.scope_dates_count || (data.scope_dates ? data.scope_dates.length : 1);
  const locTitle = data.location_filter === "states" ? "All States (52 jurisdictions)" : (data.location_filter === "all" ? "National + States" : (data.location_filter === "US" ? "US National" : data.location_filter));

  let scopeTitle = "";
  if (scopeType === "date") {
    scopeTitle = `Single Date: ${data.date_filter}`;
  } else if (scopeType === "season") {
    const s = data.selected_seasons && data.selected_seasons[0] ? data.selected_seasons[0] : "";
    scopeTitle = `${s} Season (${numRounds} round${numRounds > 1 ? "s" : ""})`;
  } else if (scopeType === "seasons") {
    scopeTitle = `Multi-Season: ${(data.selected_seasons || []).join(", ")} (${numRounds} rounds)`;
  } else if (scopeType === "all") {
    scopeTitle = `All-Time (${numRounds} rounds across ${(data.selected_seasons || []).length} seasons)`;
  }
  const windowDesc = describeWindow(data.window);
  if (windowDesc) scopeTitle += ` • ${windowDesc}`;

  const activeCount = (data.rankings || []).filter((r) => r.has_data_in_scope).length;
  const totalCount = (data.rankings || []).length;
  const pendingCount = (data.rankings || []).filter((r) => r.pending_truth).length;
  const inactiveCount = totalCount - activeCount - pendingCount;

  let details = `${scopeTitle} • Location: ${locTitle} • ${activeCount}/${totalCount} active models`;
  if (data.fair_intersection && data.common_tasks_count !== null && data.common_tasks_count !== undefined) {
    details += ` • ${data.common_tasks_count.toLocaleString()} shared tasks`;
  }
  textEl.textContent = details;

  let rightHtml = "";

  // Validation Warnings Pill
  const valWarnings = data.validation_warnings || state.latestValidationWarnings || [];
  if (valWarnings.length > 0) {
    rightHtml += `
      <span class="badge-micro warning-tag" id="val-warnings-pill" title="${valWarnings.length} dataset warning(s) detected" style="cursor:pointer; display:inline-flex; align-items:center; gap:4px; margin-right:6px; background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3); border-radius:4px; padding:2px 6px; font-size:0.68rem; font-family:var(--font-mono);">
        ${ICONS.warningSmall} <span>${valWarnings.length} dataset warning${valWarnings.length > 1 ? "s" : ""}</span>
      </span>
    `;
  }

  if (pendingCount > 0) {
    rightHtml += `<span class="badge-inactive badge-pending" title="${pendingCount} selected model${pendingCount > 1 ? "s forecast" : " forecasts"} weeks that have not been observed yet">${pendingCount} pending truth</span>`;
  }
  if (inactiveCount > 0) {
    rightHtml += `<span class="badge-inactive" title="${inactiveCount} selected model${inactiveCount > 1 ? "s have" : " has"} no forecasts in this evaluation scope">${inactiveCount} inactive in scope</span>`;
  }

  rightEl.innerHTML = rightHtml;

  const warnPill = document.getElementById("val-warnings-pill");
  if (warnPill) {
    warnPill.addEventListener("click", () => {
      showValidationWarningsModal(valWarnings);
    });
  }
}

export function showValidationWarningsModal(warnings) {
  let modal = document.getElementById("validation-warnings-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "validation-warnings-modal";
    modal.className = "modal-backdrop hidden";
    modal.innerHTML = `
      <div class="modal-card" style="max-width: 620px; max-height: 80vh; display: flex; flex-direction: column;">
        <div class="modal-header">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="color:#f59e0b;">${ICONS.warning}</span>
            <h3 style="margin:0; font-size:1rem; font-weight:600;">Dataset Validation Warnings</h3>
          </div>
          <button type="button" class="btn-modal-close" id="btn-close-val-warnings">&times;</button>
        </div>
        <div class="modal-body" id="val-warnings-body" style="overflow-y:auto; padding:16px; font-size:0.82rem; font-family:var(--font-mono); line-height:1.6;">
        </div>
        <div class="modal-footer" style="padding:12px 16px; border-top:1px solid var(--border-subtle); display:flex; justify-content:flex-end;">
          <button type="button" class="warning-action-btn" id="btn-dismiss-val-warnings">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const closeBtn = document.getElementById("btn-close-val-warnings");
    const dismissBtn = document.getElementById("btn-dismiss-val-warnings");
    if (closeBtn) closeBtn.addEventListener("click", () => modal.classList.add("hidden"));
    if (dismissBtn) dismissBtn.addEventListener("click", () => modal.classList.add("hidden"));
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.add("hidden");
    });
  }

  const body = document.getElementById("val-warnings-body");
  if (body) {
    if (!warnings || warnings.length === 0) {
      body.innerHTML = `<div style="color:var(--text-muted); padding:12px;">No validation warnings found in active datasets.</div>`;
    } else {
      let listHtml = `<ul style="margin:0; padding-left:18px; color:var(--text-primary); display:flex; flex-direction:column; gap:8px;">`;
      warnings.forEach((w) => {
        listHtml += `<li style="background:rgba(245,158,11,0.06); padding:6px 10px; border-radius:4px; border-left:3px solid #f59e0b;">${escapeHtml(w)}</li>`;
      });
      listHtml += `</ul>`;
      body.innerHTML = listHtml;
    }
  }

  modal.classList.remove("hidden");
}

export function resetTelemetry(customBest = "--", customSub = "Mean across selected models") {
  const telBestModel = document.getElementById("tel-best-model");
  const telBestWis = document.getElementById("tel-best-wis");
  const telMeanWis = document.getElementById("tel-mean-wis");
  const telMeanSub = document.getElementById("tel-mean-sub");
  const telCoverage95 = document.getElementById("tel-coverage-95");
  const telMae = document.getElementById("tel-mae");

  if (telBestModel) telBestModel.textContent = customBest;
  if (telBestWis) telBestWis.textContent = "--";
  if (telMeanWis) telMeanWis.textContent = "--";
  if (telMeanSub) telMeanSub.textContent = customSub;
  if (telCoverage95) telCoverage95.textContent = "--";
  if (telMae) telMae.textContent = "--";
}

export function updateTelemetry(rankings) {
  const telBestModel = document.getElementById("tel-best-model");
  const telBestWis = document.getElementById("tel-best-wis");
  const telMeanWis = document.getElementById("tel-mean-wis");
  const telMeanSub = document.getElementById("tel-mean-sub");
  const telCoverage95 = document.getElementById("tel-coverage-95");
  const telMae = document.getElementById("tel-mae");
  const isLog = state.evalScale === "log";

  if (!rankings || rankings.length === 0) {
    if (state.selectedModels.size > 0 && state.fairCommonTasks) {
      resetTelemetry("0 Shared Tasks", "Zero common tasks across models");
    } else {
      resetTelemetry();
    }
    return;
  }

  // Best model on the active scale: lowest tournament relative WIS among models with data in scope
  const scoreOf = (r) => (isLog ? (r.relative_wis_log ?? r.wis_log) : (r.relative_wis ?? r.wis)) ?? Infinity;
  const active = rankings.filter((r) => r.has_data_in_scope !== false);
  if (active.length === 0) {
    resetTelemetry("--", "No selected model has forecasts in this scope");
    return;
  }
  const best = active.reduce((a, b) => (scoreOf(b) < scoreOf(a) ? b : a));
  if (telBestModel) {
    telBestModel.textContent = modelLabel(best.model_id, state.models[best.model_id], { withHub: true });
    telBestModel.title = `Top Performer: ${best.model_id}`;
  }

  const curBestWis = (isLog ? best.wis_log : best.wis) ?? null;
  if (telBestWis) {
    telBestWis.textContent = curBestWis !== null ? fmtScore(curBestWis, isLog ? 3 : 2) : "--";
    telBestWis.title = isLog ? `Log Scale WIS: ${curBestWis?.toFixed(4)}` : `Natural WIS: ${curBestWis?.toFixed(2)}`;
  }

  const validWis = rankings
    .map((r) => (isLog ? r.wis_log : r.wis))
    .filter((w) => w !== null && w !== undefined);
  const avgWis = validWis.length > 0 ? validWis.reduce((a, b) => a + b, 0) / validWis.length : null;

  if (telMeanWis) {
    telMeanWis.textContent = avgWis !== null ? fmtScore(avgWis, isLog ? 3 : 2) : "--";
    telMeanWis.title = isLog ? `Cohort Average Log WIS: ${avgWis?.toFixed(4)}` : `Cohort Average Natural WIS: ${avgWis?.toFixed(2)}`;
  }
  if (telMeanSub) {
    const n = rankings.length;
    const baseSub = n > 1 ? `Mean across ${n} selected models` : "Mean across 1 model";
    telMeanSub.textContent = isLog ? `${baseSub} (Log)` : baseSub;
  }

  if (telCoverage95) {
    telCoverage95.textContent = best.cov95 !== null && best.cov95 !== undefined ? `${best.cov95.toFixed(1)}%` : "--";
  }

  const curBestMae = (isLog ? best.mae_log : best.mae) ?? null;
  if (telMae) {
    telMae.textContent = curBestMae !== null ? fmtScore(curBestMae, isLog ? 3 : 1) : "--";
    telMae.title = isLog ? `Median Log MAE: ${curBestMae?.toFixed(4)}` : `Median MAE: ${curBestMae?.toFixed(1)}`;
  }
}

function winsCellHtml(r, wins, maxWins, isInactive) {
  if (isInactive || wins === null || wins === undefined || !r.weeks_competed) {
    return `<span class="text-dim">--</span>`;
  }
  const lead = wins > 0 && wins === maxWins;
  const title = `Ranked #1 in ${wins} of ${r.weeks_competed} rounds it competed in (lowest WIS among the selected models on shared tasks)`;
  return `<span class="td-wins ${lead ? "lead" : ""}" title="${title}">${wins}<span class="td-wins-of">/${r.weeks_competed}</span></span>`;
}

export function extractModelSortValue(item, key) {
  if (!item) return null;
  const isLog = state.evalScale === "log";

  if (key && key.startsWith("h") && !isNaN(parseInt(key.slice(1), 10))) {
    const hIdx = parseInt(key.slice(1), 10);
    const hObj = item.by_horizon?.[hIdx] ?? item.by_horizon?.[String(hIdx)];
    if (!hObj) return null;
    return (isLog ? hObj.wis_log : hObj.wis) ?? null;
  }

  if (key === "weeks_won") {
    return (isLog ? item.weeks_won_log : item.weeks_won) ?? null;
  }

  // Log scale never falls back to natural values, which would mix scales within a column
  if (isLog && ["wis", "relative_wis", "pct_diff_vs_baseline", "mae"].includes(key)) {
    const logKey = key === "pct_diff_vs_baseline" ? "pct_diff_vs_baseline_log" : `${key}_log`;
    return item[logKey] ?? null;
  }

  return item[key] !== undefined ? item[key] : null;
}

export function updateTableHeadersForScale() {
  const isLog = state.evalScale === "log";
  const thWis = document.querySelector("#leaderboard-table th[data-sort='wis'] .th-label-text");
  const thRelWis = document.querySelector("#leaderboard-table th[data-sort='relative_wis'] .th-label-text");
  const thDelta = document.querySelector("#leaderboard-table th[data-sort='pct_diff_vs_baseline'] .th-label-text");
  const thMae = document.querySelector("#leaderboard-table th[data-sort='mae'] .th-label-text");

  if (thWis) thWis.textContent = isLog ? "Log WIS" : "Overall WIS";
  if (thRelWis) thRelWis.textContent = isLog ? "Log Rel WIS" : "Rel WIS";
  if (thDelta) thDelta.innerHTML = isLog ? "&Delta;% Base (Log)" : "&Delta;% Base";
  if (thMae) thMae.textContent = isLog ? "Log MAE" : "MAE";

  document.querySelectorAll("#eval-scale-segmented .segment-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-scale") === (state.evalScale || "natural"));
  });
}

export function updateLeaderboardSortIndicators() {
  document.querySelectorAll("#leaderboard-table th.sortable").forEach((th) => {
    const key = th.getAttribute("data-sort");
    const isSorted = state.sortKey === key;
    th.classList.toggle("sort-active", isSorted);
    th.classList.toggle("sort-asc", isSorted && state.sortAsc);
    th.classList.toggle("sort-desc", isSorted && !state.sortAsc);
    th.setAttribute("aria-sort", isSorted ? (state.sortAsc ? "ascending" : "descending") : "none");
  });
}

export function sortAndRenderTable(callbacks = {}) {
  const leaderboardTbody = document.getElementById("leaderboard-tbody");
  const btnToggleFair = document.getElementById("btn-toggle-fair");
  if (!leaderboardTbody) return;

  updateLeaderboardSortIndicators();
  updateTableHeadersForScale();
  updateTelemetry(state.latestRankings);

  const rankings = [...state.latestRankings];
  if (!rankings || rankings.length === 0) {
    if (state.selectedModels.size > 0 && state.fairCommonTasks) {
      leaderboardTbody.innerHTML = `
        <tr>
          <td colspan="17" class="td-empty td-no-intersection">
            <div class="empty-intersection-box">
              <div class="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg></div>
              <div class="empty-title">Zero Common Tasks Across Selected Models</div>
              <div class="empty-desc">
                The <strong>${state.selectedModels.size} selected models</strong> do not share any overlapping forecast dates or locations in this evaluation scope (e.g. models evaluated in 2023–2024 vs 2025–2026 seasons).
              </div>
              <div class="empty-actions">
                <button type="button" class="empty-action-btn" id="btn-empty-toggle-fair">
                  ${ICONS.zap}
                  <span>Evaluate Individually (Common Tasks: OFF)</span>
                </button>
              </div>
            </div>
          </td>
        </tr>`;
      const btn = document.getElementById("btn-empty-toggle-fair");
      if (btn) {
        btn.addEventListener("click", () => {
          if (btnToggleFair) btnToggleFair.click();
        });
      }
    } else if (state.selectedModels.size > 0) {
      leaderboardTbody.innerHTML = `<tr><td colspan="17" class="td-empty">No evaluated forecasts found for the selected models in this scope.</td></tr>`;
    } else {
      leaderboardTbody.innerHTML = `<tr><td colspan="17" class="td-empty">Choose models for evaluation.</td></tr>`;
    }
    return;
  }

  rankings.sort((a, b) => {
    const aInactive = a.has_data_in_scope === false;
    const bInactive = b.has_data_in_scope === false;
    if (aInactive && !bInactive) return 1;
    if (!aInactive && bInactive) return -1;

    let valA = extractModelSortValue(a, state.sortKey);
    let valB = extractModelSortValue(b, state.sortKey);

    if (valA === null || valA === undefined) return 1;
    if (valB === null || valB === undefined) return -1;

    if (typeof valA === "string") {
      return state.sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    return state.sortAsc ? valA - valB : valB - valA;
  });

  leaderboardTbody.innerHTML = "";
  let activeRank = 0;
  const isLog = state.evalScale === "log";
  const winsOf = (r) => (isLog ? r.weeks_won_log : r.weeks_won);
  const maxWins = Math.max(0, ...rankings.map((r) => winsOf(r) || 0));

  rankings.forEach((r) => {
    const tr = document.createElement("tr");
    const isInactive = r.has_data_in_scope === false;
    if (isInactive) {
      tr.className = "row-inactive-model";
    } else {
      activeRank++;
    }

    const curWis = extractModelSortValue(r, "wis");
    const curRelWis = extractModelSortValue(r, "relative_wis");
    const curPctDiff = extractModelSortValue(r, "pct_diff_vs_baseline");
    const curMae = extractModelSortValue(r, "mae");

    let deltaHtml = `<span class="delta-mono neutral">--</span>`;
    if (!isInactive && curPctDiff !== null && curPctDiff !== undefined) {
      if (curPctDiff < 0) {
        deltaHtml = `<span class="delta-mono better" title="${isLog ? 'Log Scale: ' : ''}Better than baseline by ${Math.abs(curPctDiff)}%">&darr; ${Math.abs(curPctDiff).toFixed(1)}%</span>`;
      } else if (curPctDiff > 0) {
        deltaHtml = `<span class="delta-mono worse" title="${isLog ? 'Log Scale: ' : ''}Worse than baseline by ${curPctDiff}%">&uarr; ${curPctDiff.toFixed(1)}%</span>`;
      } else {
        deltaHtml = `<span class="delta-mono neutral">0.0% (Base)</span>`;
      }
    }

    let relWisHtml = `<span class="text-dim">--</span>`;
    if (!isInactive && curRelWis !== null && curRelWis !== undefined) {
      const relVal = curRelWis.toFixed(3);
      if (curRelWis < 1.0) {
        relWisHtml = `<span class="delta-mono better" title="${isLog ? 'Log Scale ' : ''}Tournament Rel WIS: ${relVal} (better than baseline)">${relVal}</span>`;
      } else if (curRelWis > 1.0) {
        relWisHtml = `<span class="delta-mono worse" title="${isLog ? 'Log Scale ' : ''}Tournament Rel WIS: ${relVal} (worse than baseline)">${relVal}</span>`;
      } else {
        relWisHtml = `<span class="delta-mono neutral" title="${isLog ? 'Log Scale ' : ''}Tournament Rel WIS: 1.000 (baseline)">1.000</span>`;
      }
    }

    let rateWisHtml = `<span class="text-dim">--</span>`;
    if (!isInactive && r.wis_per_100k !== null && r.wis_per_100k !== undefined) {
      rateWisHtml = `<span class="td-num" title="Population-standardized Rate WIS per 100k">${r.wis_per_100k.toFixed(2)}</span>`;
    }

    const typeBadge = r.is_synthetic
      ? `<span class="chip-tag synth" title="Synthetic Ensemble">[SYNTHETIC]</span>`
      : sourceTagHtml(state.models[r.model_id] || { is_local: r.is_local });

    let statusBadge = "";
    if (isInactive) {
      const note = r.status_note || "No forecasts in scope";
      statusBadge = r.pending_truth
        ? `<span class="badge-inactive badge-pending" title="${escapeHtml(note)}">Pending truth</span>`
        : `<span class="badge-inactive" title="${escapeHtml(note)}">Inactive</span>`;
    } else if (!r.has_23_quantiles) {
      statusBadge = `<span class="chip-tag" style="background:rgba(234,179,8,0.15);color:#facc15;" title="Evaluated on 7 quantiles (fast test config)">7Q</span>`;
    }

    let taskHtml = "";
    if (isInactive) {
      taskHtml = `<span class="td-tasks-badge" title="${escapeHtml(r.status_note || 'Inactive')}">N=0 (${r.scope_rounds_available || 0}/${r.scope_rounds_total || 0} rounds)</span>`;
    } else {
      taskHtml = `<span class="td-tasks-badge" title="${r.count} forecast tasks evaluated (${r.evaluated_dates_count || r.scope_rounds_available || 1} rounds × ${r.locations_count || 1} locs)">N=${r.count}</span>`;
    }

    const getHVal = (hIdx) => {
      if (isInactive || !r.by_horizon) return "--";
      const hObj = r.by_horizon[hIdx] ?? r.by_horizon[String(hIdx)];
      if (!hObj) return "--";
      const hVal = isLog ? hObj.wis_log : hObj.wis;
      return hVal !== null && hVal !== undefined ? hVal.toFixed(isLog ? 2 : 1) : "--";
    };

    const h0 = getHVal(0);
    const h1 = getHVal(1);
    const h2 = getHVal(2);
    const h3 = getHVal(3);

    const modelMeta = state.models && state.models[r.model_id];
    const displayModelName = escapeHtml(modelLabel(r.model_id, modelMeta));

    tr.innerHTML = `
      <td class="td-rank">${isInactive ? '<span class="text-dim">--</span>' : activeRank}</td>
      <td class="td-model-name"><button type="button" class="btn-model-inspect-link" data-model="${escapeHtml(r.model_id)}" title="Inspect ${displayModelName} (seasons, dates & methods)">${displayModelName} <span class="inspect-icon">${SIMPLE_INFO_SVG}</span></button> ${statusBadge}</td>
      <td>${typeBadge}</td>
      <td class="td-num">${taskHtml}</td>
      <td class="td-num"><strong>${!isInactive && curWis !== null ? fmtScore(curWis, isLog ? 3 : 2) : '<span class="text-dim">--</span>'}</strong></td>
      <td class="td-num">${relWisHtml}</td>
      <td class="td-num">${winsCellHtml(r, winsOf(r), maxWins, isInactive)}</td>
      <td class="td-num">${deltaHtml}</td>
      <td class="td-num">${rateWisHtml}</td>
      <td class="td-num">${!isInactive && curMae !== null ? fmtScore(curMae, isLog ? 3 : 1) : '<span class="text-dim">--</span>'}</td>
      <td class="td-num">${!isInactive && r.cov95 !== null ? r.cov95.toFixed(1) + "%" : '<span class="text-dim">--</span>'}</td>
      <td class="td-num">${!isInactive && r.cov50 !== null ? r.cov50.toFixed(1) + "%" : '<span class="text-dim">--</span>'}</td>
      <td class="td-num">${!isInactive && r.sharpness !== null ? r.sharpness.toFixed(1) : '<span class="text-dim">--</span>'}</td>
      <td class="td-num" title="Horizon 0 (Nowcast)">${h0}</td>
      <td class="td-num" title="Horizon 1 (1-wk projection)">${h1}</td>
      <td class="td-num" title="Horizon 2 (2-wk projection)">${h2}</td>
      <td class="td-num" title="Horizon 3 (3-wk projection)">${h3}</td>
    `;
    leaderboardTbody.appendChild(tr);
  });

  if (callbacks.onRenderComplete) {
    callbacks.onRenderComplete();
  }
}

export async function fetchAndRenderMetrics(forceRefresh = false, diagnosticsCallbacks = {}) {
  const modelsParam = Array.from(state.selectedModels).sort().join(",");
  const leaderboardTbody = document.getElementById("leaderboard-tbody");

  if (!modelsParam) {
    metricsGuard.cancel();
    setMetricsLoadingState(false);
    state.latestRankings = [];
    lastMetricsParamsKey = "";
    resetTelemetry();
    updateEvalContextBanner(null);
    sortAndRenderTable();
    if (diagnosticsCallbacks.onMetricsUpdated) {
      diagnosticsCallbacks.onMetricsUpdated([]);
    }
    return;
  }

  let locParam = state.selectedLocation || "US";
  if (state.evalLocScope === "states") {
    locParam = "states";
  }

  const scope = resolveEvalScope();
  const dateParam = scope.date;
  const seasonParam = scope.season;
  const timeDesc = scope.label;

  const activeTarget = state.selectedTarget || (state.availableTargets && state.availableTargets[0]) || "";
  const fairFlag = state.fairCommonTasks ? 1 : 0;
  const currentKey = `${activeTarget}|${locParam}|${state.evalHorizonScope}|${dateParam}|${seasonParam}|${scope.weeks}|${scope.phase}|${modelsParam}|${fairFlag}`;

  if (!forceRefresh && currentKey === lastMetricsParamsKey && state.latestRankings && state.latestRankings.length > 0) {
    return;
  }

  if (!forceRefresh && metricsResponseCache.has(currentKey)) {
    metricsGuard.cancel();
    setMetricsLoadingState(false);
    const cachedData = metricsResponseCache.get(currentKey);
    lastMetricsParamsKey = currentKey;
    applyMetricsResponse(cachedData, diagnosticsCallbacks);
    return;
  }

  const request = metricsGuard.start();

  const locDesc = state.evalLocScope === "states" ? "All States" : (state.selectedLocation || "Current Loc");
  const countModels = state.selectedModels.size;
  const loadingMsg = state.fairCommonTasks
    ? `Evaluating common tasks (${timeDesc} • ${locDesc} • ${countModels} models)...`
    : `Evaluating models across ${timeDesc} (${locDesc} • ${countModels} models)...`;

  setMetricsLoadingState(true, loadingMsg);

  try {
    const data = await fetchMetrics({
      target: state.selectedTarget,
      location: locParam,
      date: dateParam,
      season: seasonParam,
      weeks: scope.weeks,
      phase: scope.phase,
      models: modelsParam,
      fair: state.fairCommonTasks,
      signal: request.signal,
    });

    if (!request.isCurrent()) {
      return;
    }

    if (metricsResponseCache.size >= MAX_METRICS_CACHE_SIZE) {
      const oldestKey = metricsResponseCache.keys().next().value;
      metricsResponseCache.delete(oldestKey);
    }
    metricsResponseCache.set(currentKey, data);
    lastMetricsParamsKey = currentKey;

    applyMetricsResponse(data, diagnosticsCallbacks);
  } catch (err) {
    if (err.name === "AbortError") {
      return;
    }
    console.error("Error fetching metrics:", err);
    if (request.isCurrent()) {
      lastMetricsParamsKey = "";
      if (leaderboardTbody) {
        leaderboardTbody.innerHTML = `<tr><td colspan="17" class="td-empty error-text"><span style="display:inline-flex; align-items:center; gap:6px;">${ICONS.warningSmall} Error calculating statistics. Please adjust parameters or retry.</span></td></tr>`;
      }
    }
  } finally {
    if (request.isCurrent()) {
      setMetricsLoadingState(false);
    }
  }
}

function applyMetricsResponse(data, diagnosticsCallbacks = {}) {
  state.evalScopeMeta = data;
  state.latestRankings = data.rankings || [];
  state.latestBaselineModel = data.baseline_model || null;
  state.latestValidationWarnings = data.validation_warnings || [];

  updateEvalContextBanner(data);
  updateTelemetry(state.latestRankings);
  sortAndRenderTable();

  if (diagnosticsCallbacks.onMetricsUpdated) {
    diagnosticsCallbacks.onMetricsUpdated(state.latestRankings);
  }
}
