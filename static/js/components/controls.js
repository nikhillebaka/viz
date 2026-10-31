/**
 * FluSight Sandbox Lab — Navigation & Controls Component
 * Controls for Location, Dates, Targets, Model Selection, and Season Filters.
 */

import { SIMPLE_INFO_SVG, escapeHtml, parseIsoDateToMs, formatMsToIsoDate, modelLabel, sourceTag } from "../constants.js";
import { state, formatSeasonShort, getSeasonForDate } from "../state.js";
import { onEvalWindowContextChange } from "./eval_window.js";

let datePickerActiveTab = "all";
let datePickerSearchQuery = "";

// ----------------------------------------------------------------------------
// Date Picker & Stepper
// ----------------------------------------------------------------------------

export function updateCustomDatePickerTrigger() {
  const displayEl = document.getElementById("custom-date-display");
  const badgeEl = document.getElementById("custom-date-badge");
  if (!displayEl) return;

  const curDate = state.selectedDate;
  if (!curDate) {
    displayEl.textContent = "Select date";
    if (badgeEl) badgeEl.textContent = "--";
    return;
  }

  displayEl.textContent = curDate;
  const info = state.dateInfo ? state.dateInfo[curDate] : null;
  if (badgeEl) {
    if (info && info.has_models) {
      const count = info.model_count;
      badgeEl.textContent = `${count} ${count === 1 ? "model" : "models"}`;
      badgeEl.className = "date-trigger-badge has-models";
      badgeEl.title = `${count} model ${count === 1 ? "forecast" : "forecasts"} available for this week`;
    } else if (info && info.has_truth) {
      const parts = curDate.split("-").map(Number);
      const m = parts[1];
      const isOffSeason = m >= 6 && m <= 9;
      badgeEl.textContent = isOffSeason ? "Off-Season" : "Surveillance";
      badgeEl.className = "date-trigger-badge " + (isOffSeason ? "off-season" : "surv-only");
      badgeEl.title = isOffSeason ? "Summer off-season surveillance" : "In-season surveillance ground truth";
    } else {
      badgeEl.textContent = info ? formatSeasonShort(info.season) : "--";
      badgeEl.className = "date-trigger-badge";
    }
  }

  updateSelectedDateInPicker(curDate);
}

export function updateSelectedDateInPicker(newDate) {
  if (!newDate) return;
  const cards = document.querySelectorAll(".date-picker-card");
  let activeCard = null;
  cards.forEach((card) => {
    const isCur = card.getAttribute("data-date") === newDate;
    card.classList.toggle("is-selected", isCur);
    if (isCur) {
      card.setAttribute("aria-selected", "true");
      activeCard = card;
    } else {
      card.removeAttribute("aria-selected");
    }
  });

  const popover = document.getElementById("custom-date-popover");
  if (activeCard && popover && !popover.classList.contains("hidden")) {
    activeCard.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function matchDateQuery(d, s, info, query) {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;

  if (d.toLowerCase().includes(q)) return true;

  if (s && s.toLowerCase().includes(q)) return true;
  const sShort = s ? formatSeasonShort(s).toLowerCase() : "";
  if (sShort && (sShort.includes(q) || sShort.replace(/['–-]/g, "").includes(q.replace(/['–-]/g, "")))) {
    return true;
  }

  const parts = d.split("-").map(Number);
  if (parts.length < 3 || isNaN(parts[0]) || isNaN(parts[1]) || isNaN(parts[2])) {
    return false;
  }

  const [y, m, dayNum] = parts;
  const monthsAbbr = ["", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const monthsFull = ["", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

  const mAbbr = (m >= 1 && m <= 12) ? monthsAbbr[m] : "";
  const mFull = (m >= 1 && m <= 12) ? monthsFull[m] : "";
  const dayStr = String(dayNum);
  const dayPadded = dayNum < 10 ? `0${dayNum}` : String(dayNum);
  const yearStr = String(y);

  const phrases = [
    `${mAbbr} ${dayStr}`,
    `${mAbbr} ${dayPadded}`,
    `${mFull} ${dayStr}`,
    `${mFull} ${dayPadded}`,
    `${mAbbr} ${dayStr}, ${yearStr}`,
    `${mAbbr} ${dayStr} ${yearStr}`,
    `${mFull} ${dayStr}, ${yearStr}`,
    `${mFull} ${dayStr} ${yearStr}`,
    `${mAbbr} ${yearStr}`,
    `${mFull} ${yearStr}`,
  ];

  for (let i = 0; i < phrases.length; i++) {
    if (phrases[i].includes(q)) return true;
  }

  const tokens = q.split(/[\s,/-]+/).filter(Boolean);
  if (tokens.length > 0) {
    const allMatch = tokens.every((tok) => {
      if (mAbbr.startsWith(tok) || mFull.startsWith(tok)) return true;
      if (tok === dayStr || tok === dayPadded) return true;
      if (yearStr === tok || yearStr.endsWith(tok)) return true;
      if (s && s.toLowerCase().includes(tok)) return true;
      if (sShort && sShort.includes(tok)) return true;
      if (info) {
        if (info.has_models && ("models".startsWith(tok) || "model".startsWith(tok))) return true;
        if (!info.has_models && info.has_truth) {
          const isOffSeason = m >= 6 && m <= 9;
          if (isOffSeason && "off-season".includes(tok)) return true;
          if (!isOffSeason && "surveillance".startsWith(tok)) return true;
        }
      }
      return false;
    });
    if (allMatch) return true;
  }

  return false;
}

export function initCustomDatePicker(onSelectCallback) {
  const triggerBtn = document.getElementById("custom-date-btn");
  const popover = document.getElementById("custom-date-popover");
  const searchInput = document.getElementById("date-picker-search");
  const clearSearchBtn = document.getElementById("date-picker-clear-search");
  const btnRecent = document.getElementById("date-quick-recent");

  if (!triggerBtn || !popover) return;

  popover.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  triggerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isExpanded = triggerBtn.getAttribute("aria-expanded") === "true";
    if (isExpanded) {
      closeCustomDatePicker();
    } else {
      openCustomDatePicker(onSelectCallback);
    }
  });

  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      datePickerSearchQuery = (e.target.value || "").trim().toLowerCase();
      if (clearSearchBtn) {
        clearSearchBtn.classList.toggle("hidden", !datePickerSearchQuery);
      }
      renderDatePickerList(onSelectCallback);
    });
  }

  if (clearSearchBtn) {
    clearSearchBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (searchInput) searchInput.value = "";
      datePickerSearchQuery = "";
      clearSearchBtn.classList.add("hidden");
      renderDatePickerList(onSelectCallback);
      if (searchInput) searchInput.focus();
    });
  }

  if (btnRecent) {
    btnRecent.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.dates && state.dates.length > 0) {
        selectDate(state.dates[0], onSelectCallback);
      }
    });
  }

  document.addEventListener("click", (e) => {
    if (popover.contains(e.target) || triggerBtn.contains(e.target)) return;
    if (!popover.classList.contains("hidden")) {
      closeCustomDatePicker();
    }
  });
}

export function openCustomDatePicker(onSelectCallback) {
  const triggerBtn = document.getElementById("custom-date-btn");
  const popover = document.getElementById("custom-date-popover");
  if (!triggerBtn || !popover) return;

  triggerBtn.setAttribute("aria-expanded", "true");
  popover.classList.remove("hidden");

  if (!datePickerActiveTab) {
    datePickerActiveTab = "all";
  }

  renderDatePickerTabs(onSelectCallback);
  renderDatePickerList(onSelectCallback);

  const searchInput = document.getElementById("date-picker-search");
  if (searchInput) {
    setTimeout(() => searchInput.focus(), 60);
  }
}

export function closeCustomDatePicker() {
  const triggerBtn = document.getElementById("custom-date-btn");
  const popover = document.getElementById("custom-date-popover");
  if (triggerBtn) triggerBtn.setAttribute("aria-expanded", "false");
  if (popover) popover.classList.add("hidden");
}

export function selectDate(newDate, onSelectCallback) {
  if (!newDate) return;
  state.selectedDate = newDate;
  const dateSelect = document.getElementById("date-select");
  if (dateSelect) dateSelect.value = newDate;
  updateHeaderContext();
  updateSelectedDateInPicker(newDate);
  closeCustomDatePicker();
  if (onSelectCallback) onSelectCallback(newDate);
}

export function renderDatePickerTabs(onSelectCallback) {
  const tabsContainer = document.getElementById("date-popover-tabs");
  if (!tabsContainer || !state.dates || state.dates.length === 0) return;

  const seasonsSet = new Set();
  state.dates.forEach((d) => {
    const info = state.dateInfo ? state.dateInfo[d] : null;
    if (info && info.season) seasonsSet.add(info.season);
  });

  const sortedSeasonKeys = Array.from(seasonsSet).sort().reverse();
  let tabsHtml = `
    <button type="button" class="date-tab-btn ${datePickerActiveTab === "all" ? "active" : ""}" data-tab="all">
      All
    </button>
  `;

  sortedSeasonKeys.forEach((s) => {
    const shortLabel = formatSeasonShort(s);
    tabsHtml += `
      <button type="button" class="date-tab-btn ${datePickerActiveTab === s ? "active" : ""}" data-tab="${s}">
        ${shortLabel}
      </button>
    `;
  });

  tabsContainer.innerHTML = tabsHtml;
  tabsContainer.querySelectorAll(".date-tab-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      datePickerActiveTab = btn.getAttribute("data-tab") || "all";
      renderDatePickerTabs(onSelectCallback);
      renderDatePickerList(onSelectCallback);
    });
  });
}

export function renderDatePickerList(onSelectCallback) {
  const listContainer = document.getElementById("date-popover-list");
  if (!listContainer || !state.dates) return;

  const filtered = state.dates.filter((d) => {
    const info = state.dateInfo ? state.dateInfo[d] : null;
    const s = info ? info.season : "";
    if (datePickerActiveTab !== "all" && s !== datePickerActiveTab) {
      return false;
    }
    return matchDateQuery(d, s, info, datePickerSearchQuery);
  });

  if (filtered.length === 0) {
    if (datePickerActiveTab !== "all" && datePickerSearchQuery) {
      listContainer.innerHTML = `
        <div class="date-popover-empty">
          No dates matching "${escapeHtml(datePickerSearchQuery)}" in ${formatSeasonShort(datePickerActiveTab)}.
          <div style="margin-top: 8px;">
            <button type="button" id="date-search-all-btn" class="date-shortcut-btn">Search across all seasons</button>
          </div>
        </div>
      `;
      const searchAllBtn = document.getElementById("date-search-all-btn");
      if (searchAllBtn) {
        searchAllBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          datePickerActiveTab = "all";
          renderDatePickerTabs(onSelectCallback);
          renderDatePickerList(onSelectCallback);
        });
      }
    } else {
      listContainer.innerHTML = `<div class="date-popover-empty">No reference dates found matching "${escapeHtml(datePickerSearchQuery)}".</div>`;
    }
    return;
  }

  const grouped = {};
  filtered.forEach((d) => {
    const info = state.dateInfo ? state.dateInfo[d] : null;
    const s = info ? info.season : "Other";
    if (!grouped[s]) grouped[s] = [];
    grouped[s].push(d);
  });

  let html = "";
  Object.keys(grouped).forEach((s) => {
    const datesInSeason = grouped[s];
    const sShort = formatSeasonShort(s);
    html += `
      <div class="date-picker-season-group">
        <div class="date-picker-group-header">
          <span>${sShort} Season</span>
        </div>
        <div class="date-picker-grid">
    `;

    datesInSeason.forEach((d) => {
      const info = state.dateInfo ? state.dateInfo[d] : null;
      const isSelected = d === state.selectedDate;
      const hasModels = info && info.has_models;
      let badgeClass = "";
      let badgeText = "";

      if (hasModels) {
        badgeClass = "has-models";
        const count = info.model_count;
        badgeText = `● ${count} ${count === 1 ? "model" : "models"}`;
      } else if (info && info.has_truth) {
        const parts = d.split("-").map(Number);
        const m = parts[1];
        const isOffSeason = m >= 6 && m <= 9;
        if (isOffSeason) {
          badgeClass = "off-season";
          badgeText = "○ Off-Season";
        } else {
          badgeClass = "surv-only";
          badgeText = "○ Surveillance";
        }
      } else {
        badgeClass = "off-season";
        badgeText = "○ Off-Season";
      }

      const dParts = d.split("-").map(Number);
      const monthsAbbr = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const humanDate = (dParts.length === 3 && dParts[1] >= 1 && dParts[1] <= 12)
        ? `${monthsAbbr[dParts[1]]} ${dParts[2]}, ${dParts[0]}`
        : (info ? formatSeasonShort(info.season) : "");

      html += `
        <button type="button" class="date-picker-card ${isSelected ? "is-selected" : ""}" data-date="${d}" role="option" aria-selected="${isSelected ? "true" : "false"}">
          <div class="date-card-left">
            <span class="date-card-date">${d}</span>
            <span class="date-card-sub">${humanDate}</span>
          </div>
          <span class="date-card-badge ${badgeClass}">${badgeText}</span>
        </button>
      `;
    });

    html += `
        </div>
      </div>
    `;
  });

  listContainer.innerHTML = html;

  listContainer.querySelectorAll(".date-picker-card").forEach((card) => {
    card.addEventListener("click", () => {
      const d = card.getAttribute("data-date");
      if (d) selectDate(d, onSelectCallback);
    });
  });

  const activeCard = listContainer.querySelector(".date-picker-card.is-selected");
  if (activeCard) {
    setTimeout(() => {
      activeCard.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 40);
  }
}

export function populateDateSelect() {
  const dateSelect = document.getElementById("date-select");
  if (dateSelect) {
    dateSelect.innerHTML = "";
    state.dates.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      dateSelect.appendChild(opt);
    });
    if (state.selectedDate) {
      dateSelect.value = state.selectedDate;
    }
  }
  updateCustomDatePickerTrigger();
  renderDatePickerTabs();
  renderDatePickerList();
}

export function stepPreviousDate(onSelectCallback) {
  if (!state.dates || state.dates.length === 0) return;
  const idx = state.dates.indexOf(state.selectedDate);
  if (idx < state.dates.length - 1) {
    selectDate(state.dates[idx + 1], onSelectCallback);
  }
}

export function stepNextDate(onSelectCallback) {
  if (!state.dates || state.dates.length === 0) return;
  const idx = state.dates.indexOf(state.selectedDate);
  if (idx > 0) {
    selectDate(state.dates[idx - 1], onSelectCallback);
  }
}

// ----------------------------------------------------------------------------
// Location & Target Controls
// ----------------------------------------------------------------------------

export function populateLocationSelect() {
  const locationSelect = document.getElementById("location-select");
  if (!locationSelect) return;
  locationSelect.innerHTML = "";
  state.locations.forEach((loc) => {
    const opt = document.createElement("option");
    opt.value = loc.id;
    if (loc.id === "US") {
      opt.textContent = "US National (US)";
    } else if (loc.name && loc.abbreviation && loc.name !== loc.abbreviation) {
      opt.textContent = `${loc.name} (${loc.abbreviation})`;
    } else {
      opt.textContent = loc.name || loc.id;
    }
    locationSelect.appendChild(opt);
  });
  locationSelect.value = state.selectedLocation;
}

// ----------------------------------------------------------------------------
// Model Filter & Chips Drawer
// ----------------------------------------------------------------------------

export function inferModelFamily(modelId, meta) {
  if (meta && meta.family) return meta.family;
  if (meta && meta.model_family) return meta.model_family;
  const name = modelId.includes("-") ? modelId.split("-").slice(1).join("-") : modelId;
  const mAr = name.match(/\b(ar\d*|autoreg)\b/i);
  if (mAr) return "AR";
  const firstPart = name.split(/[_\.\-]/)[0];
  const lower = firstPart.toLowerCase();
  const acronyms = ["gbqr", "ar", "arima", "lstm", "cnn", "gru", "eakf", "mobs", "cdc", "nhsn", "seir", "sir"];
  if (acronyms.includes(lower)) return firstPart.toUpperCase();
  return firstPart.charAt(0).toUpperCase() + firstPart.slice(1);
}

export function populateFamilyFilters(families) {
  const select = document.getElementById("models-family-select");
  if (!select) return;

  let famList = families;
  if (!famList || famList.length === 0) {
    const famSet = new Set();
    Object.keys(state.models).forEach((mId) => {
      const meta = state.models[mId] || {};
      const f = meta.family || inferModelFamily(mId, meta);
      if (f) famSet.add(f);
    });
    famList = Array.from(famSet).sort();
  }

  const currentVal = select.value || state.modelFamilyFilter || "all";
  let html = `<option value="all">All Families</option>`;
  html += `<option value="selected">Selected Only</option>`;

  famList.forEach((fam) => {
    html += `<option value="${escapeHtml(fam.toLowerCase())}">${escapeHtml(fam)}</option>`;
  });

  const hasLocal = Object.values(state.models).some((m) => m && m.is_local);
  if (hasLocal) {
    html += `<option value="local">Local Models</option>`;
  }

  select.innerHTML = html;

  if (currentVal && (currentVal === "all" || currentVal === "selected" || currentVal === "local" || famList.map((f) => f.toLowerCase()).includes(currentVal.toLowerCase()))) {
    select.value = currentVal;
    state.modelFamilyFilter = currentVal;
  } else {
    select.value = "all";
    state.modelFamilyFilter = "all";
  }
}

export function populateSeasonFilters(seasons, onFilterChange) {
  const select = document.getElementById("models-season-select");
  if (!seasons || seasons.length === 0) return;

  const sortedSeasons = [...seasons].sort().reverse();

  if (select) {
    const currentVal = select.value || (state.modelSeasonFilters.size === 1 ? Array.from(state.modelSeasonFilters)[0] : "all");
    let optionsHtml = `<option value="all">All Seasons</option>`;
    sortedSeasons.forEach((s) => {
      const shortLabel = formatSeasonShort(s);
      optionsHtml += `<option value="${s}">${shortLabel} Season</option>`;
    });
    select.innerHTML = optionsHtml;

    if (currentVal && (currentVal === "all" || sortedSeasons.includes(currentVal))) {
      select.value = currentVal;
    } else {
      select.value = "all";
      state.modelSeasonFilters.clear();
    }

    select.onchange = (e) => {
      handleSeasonFilterClick(e.target.value, onFilterChange);
    };
  }
}

export function handleSeasonFilterClick(seasonKey, onFilterChange) {
  const select = document.getElementById("models-season-select");

  if (seasonKey === "all" || !seasonKey) {
    state.modelSeasonFilters.clear();
    if (select) select.value = "all";
  } else {
    state.modelSeasonFilters.clear();
    state.modelSeasonFilters.add(seasonKey);
    if (select) select.value = seasonKey;
  }

  renderModelChips(onFilterChange);
}

function isHubModel(meta) {
  return !!meta && meta.source === "hub";
}

function passesModelFilters(id, meta) {
  const q = (state.modelSearchQuery || "").toLowerCase();
  const fam = state.modelFamilyFilter || "all";

  if (q && !id.toLowerCase().includes(q) && !(meta.display_name || "").toLowerCase().includes(q)) {
    return false;
  }

  if (fam === "selected") {
    if (!state.selectedModels.has(id)) return false;
  } else if (fam === "local") {
    if (!meta.is_local) return false;
  } else if (fam !== "all") {
    const modelFamily = meta.family || inferModelFamily(id, meta);
    if (modelFamily.toLowerCase() !== fam.toLowerCase()) {
      return false;
    }
  }

  // Filter by active target: only show models that submitted for the active target
  if (state.selectedTarget) {
    const modelTargets = meta.targets || [];
    if (modelTargets.length > 0 && !modelTargets.includes(state.selectedTarget)) {
      return false;
    }
  }

  if (state.modelSeasonFilters && state.modelSeasonFilters.size > 0) {
    const modelSeasons = meta.seasons || [];
    const selectedSeasons = Array.from(state.modelSeasonFilters);
    if (!selectedSeasons.some((s) => modelSeasons.includes(s))) return false;
  }

  return true;
}

/** Repository, local, and synthetic models shown in the main chip strip. */
export function getFilteredWorkspaceModels() {
  return Object.keys(state.models).filter((id) => {
    const meta = state.models[id] || {};
    return !isHubModel(meta) && passesModelFilters(id, meta);
  });
}

function hubHasRound(meta) {
  return !state.selectedDate || (meta.dates || []).includes(state.selectedDate);
}

function isHubShelfOpen(hubId) {
  return !!(state.hubShelfOpen && state.hubShelfOpen[hubId]) || !!state.modelSearchQuery;
}

/**
 * Hub models grouped per hub. `shown` is what the hub row displays: selected models while the shelf is
 * closed, or every model passing the filters (optionally only those forecasting this round) while open.
 */
function getHubGroups() {
  const groups = new Map();
  Object.keys(state.models).forEach((id) => {
    const meta = state.models[id] || {};
    if (!isHubModel(meta)) return;
    if (!groups.has(meta.hub)) {
      groups.set(meta.hub, { hubId: meta.hub, label: meta.hub_label || meta.hub, all: [], matching: [], shown: [], inRound: 0 });
    }
    const g = groups.get(meta.hub);
    g.all.push(id);
    if (passesModelFilters(id, meta)) {
      g.matching.push(id);
      if (hubHasRound(meta)) g.inRound += 1;
    }
  });
  groups.forEach((g) => {
    const open = isHubShelfOpen(g.hubId);
    g.open = open;
    g.shown = g.matching.filter((id) => {
      const meta = state.models[id] || {};
      if (state.selectedModels.has(id)) return true;
      if (!open) return false;
      if (state.hubRoundOnly && !hubHasRound(meta)) return false;
      if (state.hubDesignatedOnly && !meta.designated) return false;
      return true;
    });
  });
  return Array.from(groups.values());
}

export function getFilteredModels() {
  const ids = getFilteredWorkspaceModels();
  getHubGroups().forEach((g) => ids.push(...g.shown));
  return ids;
}

export function updateDrawerButtonText(filteredCount) {
  const footer = document.getElementById("models-strip-footer");
  const modelsExpandText = document.getElementById("models-expand-text");
  const btnToggleExpandModels = document.getElementById("btn-toggle-expand-models");
  const modelsChipStrip = document.getElementById("models-chip-strip");
  if (!modelsExpandText || !footer) return;

  const count = typeof filteredCount === "number" ? filteredCount : getFilteredWorkspaceModels().length;
  const scrollH = modelsChipStrip ? modelsChipStrip.scrollHeight : 0;
  const needsDrawer = count > 5 && scrollH > 68;

  footer.style.display = needsDrawer ? "" : "none";

  if (!needsDrawer) {
    if (modelsChipStrip) {
      modelsChipStrip.classList.remove("collapsed");
    }
    return;
  }

  if (modelsChipStrip) {
    modelsChipStrip.classList.toggle("collapsed", !state.isModelsExpanded);
  }

  if (btnToggleExpandModels) {
    btnToggleExpandModels.classList.toggle("expanded", state.isModelsExpanded);
    btnToggleExpandModels.setAttribute("aria-expanded", String(state.isModelsExpanded));
  }

  modelsExpandText.textContent = state.isModelsExpanded
    ? `Collapse drawer (${count})`
    : `Show all models (${count})`;
}

function buildModelChip(id, callbacks, { showTag = true } = {}) {
  const meta = state.models[id] || {};
  const isSelected = state.selectedModels.has(id);
  const color = state.modelColors[id] || "#00f0ff";

  const chip = document.createElement("div");
  chip.className = `model-chip ${isSelected ? "active" : ""}`;
  if (isHubModel(meta) && !hubHasRound(meta)) {
    chip.classList.add("no-round");
    chip.title = `No ${meta.hub_label || "hub"} forecast for ${state.selectedDate}`;
  }
  chip.setAttribute("data-model", id);
  chip.setAttribute("role", "button");
  chip.setAttribute("tabindex", "0");
  chip.setAttribute("aria-pressed", String(isSelected));
  chip.style.setProperty("--chip-color", color);
  if (isSelected) {
    chip.style.borderColor = color;
  }

  const dot = document.createElement("span");
  dot.className = "chip-dot";
  dot.style.backgroundColor = color;

  const displayName = modelLabel(id, meta);

  const name = document.createElement("span");
  name.className = "chip-name";
  name.textContent = displayName;

  chip.appendChild(dot);
  chip.appendChild(name);

  if (showTag) {
    const t = sourceTag(meta);
    const tag = document.createElement("span");
    tag.className = `chip-tag ${t.cls}`;
    tag.textContent = t.text;
    chip.appendChild(tag);
  }

  const infoBtn = document.createElement("button");
  infoBtn.type = "button";
  infoBtn.className = "chip-info-btn";
  infoBtn.title = `Inspect ${displayName} (seasons, dates & methods)`;
  infoBtn.setAttribute("aria-label", `Inspect ${displayName}`);
  infoBtn.innerHTML = SIMPLE_INFO_SVG;
  infoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (callbacks.onModelInspect) {
      callbacks.onModelInspect(id);
    }
  });
  chip.appendChild(infoBtn);

  chip.addEventListener("click", () => {
    state.smartZoom.lastStableYMax = null;
    if (state.selectedModels.has(id)) {
      state.selectedModels.delete(id);
    } else {
      state.selectedModels.add(id);
    }
    renderModelChips(callbacks);
    if (callbacks.onSelectionChange) {
      callbacks.onSelectionChange();
    }
  });
  chip.addEventListener("keydown", (e) => {
    if (e.target === chip && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      chip.click();
    }
  });
  return chip;
}

const sortSelectedFirst = (a, b) => {
  const aSel = state.selectedModels.has(a);
  const bSel = state.selectedModels.has(b);
  if (aSel && !bSel) return -1;
  if (!aSel && bSel) return 1;
  return a.localeCompare(b);
};

// Within a hub: selected, then the hub's own ensembles/baselines, then designated models, then the rest
function hubSortKey(id) {
  const meta = state.models[id] || {};
  const name = meta.display_name || id;
  if (state.selectedModels.has(id)) return `0${name}`;
  if (/^FluSight-/i.test(name)) return `1${name}`;
  if (meta.designated) return `2${name}`;
  return `3${name}`;
}

function renderHubStrip(groups, callbacks) {
  const host = document.getElementById("models-hub-strip");
  if (!host) return;
  host.innerHTML = "";
  host.classList.toggle("hidden", groups.length === 0);

  groups.forEach((g) => {
    const row = document.createElement("div");
    row.className = "hub-row";

    const selectedCount = g.all.filter((id) => state.selectedModels.has(id)).length;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "hub-shelf-toggle";
    toggle.setAttribute("aria-expanded", String(g.open));
    toggle.title = g.open ? `Collapse ${g.label} models` : `Show all ${g.all.length} ${g.label} models`;
    toggle.innerHTML = `<span class="hub-shelf-label">${escapeHtml(g.label.toUpperCase())}</span>`
      + `<span class="hub-shelf-count">${selectedCount ? `${selectedCount} selected · ` : ""}${g.all.length} models</span>`
      + `<span class="hub-shelf-arrow">▸</span>`;
    toggle.addEventListener("click", () => {
      state.hubShelfOpen = { ...(state.hubShelfOpen || {}), [g.hubId]: !(state.hubShelfOpen || {})[g.hubId] };
      try {
        localStorage.setItem("flusight_hub_shelves", JSON.stringify(state.hubShelfOpen));
      } catch (e) { /* storage unavailable */ }
      renderModelChips(callbacks);
    });
    row.appendChild(toggle);

    if (g.open) {
      const roundBtn = document.createElement("button");
      roundBtn.type = "button";
      roundBtn.className = `hub-shelf-filter ${state.hubRoundOnly ? "on" : ""}`;
      roundBtn.setAttribute("aria-pressed", String(!!state.hubRoundOnly));
      roundBtn.textContent = `This round · ${g.inRound}`;
      roundBtn.title = `Only models with a forecast for ${state.selectedDate || "the selected date"}`;
      roundBtn.addEventListener("click", () => {
        state.hubRoundOnly = !state.hubRoundOnly;
        renderModelChips(callbacks);
      });
      row.appendChild(roundBtn);

      const desigBtn = document.createElement("button");
      desigBtn.type = "button";
      desigBtn.className = `hub-shelf-filter ${state.hubDesignatedOnly ? "on" : ""}`;
      desigBtn.setAttribute("aria-pressed", String(!!state.hubDesignatedOnly));
      desigBtn.textContent = "Designated only";
      desigBtn.title = "Only each team's designated model (the ones eligible for the hub ensemble)";
      desigBtn.addEventListener("click", () => {
        state.hubDesignatedOnly = !state.hubDesignatedOnly;
        renderModelChips(callbacks);
      });
      row.appendChild(desigBtn);
    }

    // Per-hub selection actions, independent of the repository strip's Select All / Clear
    const actions = document.createElement("div");
    actions.className = "hub-row-actions";
    const applySelection = (fn) => {
      state.smartZoom.lastStableYMax = null;
      fn();
      renderModelChips(callbacks);
      if (callbacks.onSelectionChange) callbacks.onSelectionChange();
    };
    if (g.open) {
      const selectable = g.shown.filter((id) => !state.selectedModels.has(id));
      const selAll = document.createElement("button");
      selAll.type = "button";
      selAll.className = "micro-btn";
      selAll.textContent = "Select All";
      selAll.title = `Select the ${g.shown.length} ${g.label} models shown`;
      selAll.disabled = selectable.length === 0;
      selAll.addEventListener("click", () => applySelection(() => selectable.forEach((id) => state.selectedModels.add(id))));
      actions.appendChild(selAll);
    }
    if (g.open || selectedCount > 0) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "micro-btn";
      clear.textContent = "Clear";
      clear.title = `Deselect all ${g.label} models (repository selections are kept)`;
      clear.disabled = selectedCount === 0;
      clear.addEventListener("click", () => applySelection(() => g.all.forEach((id) => state.selectedModels.delete(id))));
      actions.appendChild(clear);
    }

    const chips = document.createElement("div");
    chips.className = "hub-row-chips";
    const shown = [...g.shown].sort((a, b) => hubSortKey(a).localeCompare(hubSortKey(b)));
    shown.forEach((id) => chips.appendChild(buildModelChip(id, callbacks, { showTag: false })));
    if (shown.length === 0) {
      const empty = document.createElement("span");
      empty.className = "hub-shelf-empty";
      empty.textContent = g.open
        ? (g.matching.length ? "No models match the shelf filters for this round." : "No models match the current filters.")
        : "Open to browse and compare live forecasts.";
      chips.appendChild(empty);
    }

    host.appendChild(row);
    // Selected chips sit inline with the toggle while closed; the open shelf gets its own scroll area
    if (g.open) host.appendChild(chips);
    else Array.from(chips.children).forEach((c) => row.appendChild(c));
    if (actions.childElementCount) row.appendChild(actions);
  });
}

export function renderModelChips(callbacks = {}) {
  const modelsChipStrip = document.getElementById("models-chip-strip");
  const modelsCountBadge = document.getElementById("models-count-badge");
  if (!modelsChipStrip) return;
  modelsChipStrip.innerHTML = "";

  const totalModels = Object.keys(state.models).length;
  const filtered = getFilteredWorkspaceModels();
  const hubGroups = getHubGroups();
  const hubShown = hubGroups.reduce((n, g) => n + g.shown.length, 0);
  const hubTotal = hubGroups.reduce((n, g) => n + g.all.length, 0);

  if (modelsCountBadge) {
    const visible = filtered.length + hubShown;
    const workspaceTotal = totalModels - hubTotal;
    if (filtered.length < workspaceTotal || hubShown < hubTotal) {
      modelsCountBadge.textContent = `${state.selectedModels.size} selected · ${visible} of ${totalModels} shown`;
    } else {
      modelsCountBadge.textContent = `${state.selectedModels.size} / ${totalModels} active`;
    }
  }

  renderHubStrip(hubGroups, callbacks);

  if (filtered.length === 0) {
    const hint = document.createElement("div");
    hint.className = "no-models-hint";
    let filterDesc = [];
    if (state.modelSearchQuery) filterDesc.push(`query "${escapeHtml(state.modelSearchQuery)}"`);
    if (state.modelFamilyFilter !== "all") filterDesc.push(`category "${state.modelFamilyFilter}"`);
    if (state.modelSeasonFilters && state.modelSeasonFilters.size > 0) {
      filterDesc.push(`season(s) ${Array.from(state.modelSeasonFilters).join(", ")}`);
    }
    const descStr = filterDesc.length > 0 ? filterDesc.join(", ") : "filters";
    hint.textContent = `No ${hubTotal ? "repository " : ""}models match ${descStr}.`;
    modelsChipStrip.appendChild(hint);
    updateDrawerButtonText(0);
    return;
  }

  filtered.sort(sortSelectedFirst);
  filtered.forEach((id) => modelsChipStrip.appendChild(buildModelChip(id, callbacks)));

  updateDrawerButtonText(filtered.length);
}

// ----------------------------------------------------------------------------
// Header Context & Focal Season
// ----------------------------------------------------------------------------

export function updateFocalSeasonButton() {
  const dInfo = state.dateInfo ? state.dateInfo[state.selectedDate] : null;
  state.evalFocalSeason = dInfo && dInfo.season
    ? dInfo.season
    : (state.selectedDate ? getSeasonForDate(state.selectedDate) : (state.latestSeason || "2025-2026"));
  // The evaluation window follows the selected date's season until seasons are pinned
  onEvalWindowContextChange();
}

export function updateHeaderContext() {
  updateCustomDatePickerTrigger();
  updateFocalSeasonButton();
  const plotHeading = document.getElementById("plot-heading");
  const plotSubheading = document.getElementById("plot-subheading");

  if (state.currentView !== "spatial") {
    // Peak forecasts are per location: aggregates show the national forecast
    const isPeak = state.currentView === "peak";
    const shownLoc = isPeak && (state.selectedLocation === "states" || state.selectedLocation === "all") ? "US" : state.selectedLocation;
    const locObj = state.locations.find((l) => l.id === shownLoc);
    let locName = shownLoc;
    if (locObj) {
      if (locObj.id === "US") {
        locName = "US National";
      } else if (locObj.name && locObj.abbreviation && locObj.name !== locObj.abbreviation) {
        locName = `${locObj.name} (${locObj.abbreviation})`;
      } else {
        locName = locObj.name || locObj.id;
      }
    }
    if (plotHeading) {
      plotHeading.textContent = locName;
    }
    if (plotSubheading) {
      let cutoffStr = "";
      if (state.selectedDate) {
        // UTC date math keeps the cutoff correct in every timezone
        cutoffStr = ` (Cutoff: ${formatMsToIsoDate(parseIsoDateToMs(state.selectedDate) - 7 * 86400000)})`;
      }
      const peakPair = isPeak ? state.peakTargets?.[state.selectedTarget] : null;
      const targetPart = peakPair ? `${peakPair.timing} \u00b7 ${peakPair.size}` : state.selectedTarget;
      plotSubheading.innerHTML = `<span class="plot-sub-date-part">${isPeak ? "Season Peak \u00b7 Round" : "Reference Date:"} ${state.selectedDate}${cutoffStr}</span><span class="plot-sub-target-part"> \u2022 Target: ${targetPart}</span>`;
    }
  } else {
    if (plotHeading) plotHeading.textContent = "US Geographic Predictions & Epidemic Wave Tracking";
    if (plotSubheading) plotSubheading.textContent = "State-Level Choropleth · Population-Adjusted Rates & Trajectories";
  }
}
