/**
 * FluSight Sandbox Lab — Interactive Modals & Explanatory Flyouts
 * Definition popovers, Methodology guide, and Model details dossier.
 */

import { DEFINITIONS, ICONS, escapeHtml } from "../constants.js";
import { state, formatSeasonShort } from "../state.js";
import { fetchModelDetails } from "../api.js";

// ----------------------------------------------------------------------------
// Definition Popover Controller
// ----------------------------------------------------------------------------

export function showDefinitionPopover(term, triggerBtn) {
  const def = DEFINITIONS[term];
  const definitionPopover = document.getElementById("definition-popover");
  const popoverTitle = document.getElementById("popover-title");
  const popoverTag = document.getElementById("popover-tag");
  const popoverDesc = document.getElementById("popover-desc");
  const popoverCalc = document.getElementById("popover-calc");
  const popoverIntuition = document.getElementById("popover-intuition");
  const popoverCalcWrap = document.getElementById("popover-calc-wrap");
  const popoverTarget = document.getElementById("popover-target");
  const targetWrap = document.getElementById("popover-target-wrap");

  if (!def || !definitionPopover) return;

  document.querySelectorAll(".info-trigger-btn.active").forEach((btn) => btn.classList.remove("active"));
  triggerBtn.classList.add("active");

  if (popoverTitle) popoverTitle.textContent = def.title;
  if (popoverTag) popoverTag.textContent = def.tag;
  if (popoverDesc) popoverDesc.textContent = def.desc;

  if (popoverCalc && popoverIntuition && popoverCalcWrap) {
    if (def.howCalculated || def.breakdown) {
      popoverCalc.textContent = def.howCalculated || "";
      popoverIntuition.textContent = def.breakdown || "";
      popoverCalcWrap.style.display = "flex";
    } else {
      popoverCalcWrap.style.display = "none";
    }
  }

  if (def.target && popoverTarget && targetWrap) {
    popoverTarget.textContent = def.target;
    targetWrap.style.display = "flex";
  } else if (targetWrap) {
    targetWrap.style.display = "none";
  }

  state.activePopoverTerm = term;
  state.activePopoverSectionId = def.sectionId || null;
  definitionPopover.classList.remove("hidden");
  definitionPopover.setAttribute("aria-hidden", "false");

  const rect = triggerBtn.getBoundingClientRect();
  const popoverWidth = definitionPopover.offsetWidth || 340;
  const popoverHeight = definitionPopover.offsetHeight || 240;

  let left = rect.left + rect.width / 2 - popoverWidth / 2;
  left = Math.max(12, Math.min(window.innerWidth - popoverWidth - 12, left));

  let top = rect.bottom + 8;
  if (top + popoverHeight > window.innerHeight - 12) {
    top = Math.max(12, rect.top - popoverHeight - 8);
  }

  definitionPopover.style.left = `${Math.round(left)}px`;
  definitionPopover.style.top = `${Math.round(top)}px`;
}

export function hideDefinitionPopover() {
  const definitionPopover = document.getElementById("definition-popover");
  if (!definitionPopover) return;
  definitionPopover.classList.add("hidden");
  definitionPopover.setAttribute("aria-hidden", "true");
  document.querySelectorAll(".info-trigger-btn.active").forEach((btn) => btn.classList.remove("active"));
  state.activePopoverTerm = null;
  state.activePopoverSectionId = null;
}

// ----------------------------------------------------------------------------
// Methodology Guide Modal Controller
// ----------------------------------------------------------------------------

export function openMethodologyModal(sectionId) {
  const methodologyModal = document.getElementById("methodology-modal");
  if (!methodologyModal) return;
  methodologyModal.classList.remove("hidden");

  const tabTimeline = document.getElementById("modal-tab-timeline");
  const tabSpatial = document.getElementById("modal-tab-spatial");
  const tabSignals = document.getElementById("modal-tab-signals");
  const tabHeatmap = document.getElementById("modal-tab-heatmap");

  const isSpatialSection = sectionId && (sectionId.includes("spatial") || sectionId === "methodology-part2-heading");
  const isSignalsSection = sectionId && (sectionId.includes("signals") || sectionId.includes("modes") || sectionId === "methodology-part3-heading");
  const isHeatmapSection = sectionId && (sectionId.includes("heatmap") || sectionId.includes("wave") || sectionId.includes("matrix") || sectionId.includes("hhs") || sectionId === "methodology-part4-heading");

  [tabTimeline, tabSpatial, tabSignals, tabHeatmap].forEach((tab) => {
    if (!tab) return;
    if (tab === tabHeatmap) tab.classList.toggle("active", Boolean(isHeatmapSection));
    else if (tab === tabSpatial) tab.classList.toggle("active", Boolean(isSpatialSection));
    else if (tab === tabSignals) tab.classList.toggle("active", Boolean(isSignalsSection));
    else tab.classList.toggle("active", !isSpatialSection && !isSignalsSection && !isHeatmapSection);
  });

  document.querySelectorAll(".methodology-section.highlighted, .methodology-divider-banner.highlighted").forEach((el) => el.classList.remove("highlighted"));

  if (sectionId) {
    const targetSection = document.getElementById(sectionId);
    if (targetSection) {
      const searchInput = document.getElementById("methodology-search-input");
      if (searchInput && searchInput.value) {
        searchInput.value = "";
        const clearBtn = document.getElementById("methodology-search-clear");
        if (clearBtn) clearBtn.classList.add("hidden");
        document.querySelectorAll(".methodology-scroll-body .methodology-section, .methodology-scroll-body .methodology-divider-banner").forEach((el) => el.classList.remove("search-hidden"));
      }
      clearMethodologyHighlights();

      setTimeout(() => {
        targetSection.scrollIntoView({ behavior: "smooth", block: "start" });
        targetSection.classList.add("highlighted");
        setTimeout(() => targetSection.classList.remove("highlighted"), 3000);
      }, 50);
    }
  } else {
    const scrollBody = methodologyModal.querySelector(".methodology-scroll-body");
    if (scrollBody) scrollBody.scrollTop = 0;
  }
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function clearMethodologyHighlights() {
  const marks = document.querySelectorAll(".methodology-scroll-body mark.search-highlight");
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (parent) {
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      parent.normalize();
    }
  });
}

export function applyMethodologyHighlights(rawQuery) {
  clearMethodologyHighlights();
  const q = (rawQuery || "").trim();
  if (!q) return;

  const escaped = escapeRegExp(q);
  const regex = new RegExp(`(${escaped})`, "gi");
  const visibleSections = document.querySelectorAll(".methodology-scroll-body .methodology-section:not(.search-hidden)");

  visibleSections.forEach((section) => {
    const textNodes = [];
    const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parentTag = node.parentElement ? node.parentElement.tagName.toLowerCase() : "";
        if (parentTag === "script" || parentTag === "style" || parentTag === "mark") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let currentNode;
    while ((currentNode = walker.nextNode())) {
      if (regex.test(currentNode.nodeValue)) {
        textNodes.push(currentNode);
      }
      regex.lastIndex = 0;
    }

    textNodes.forEach((node) => {
      const text = node.nodeValue;
      const parent = node.parentNode;
      if (!parent) return;

      const parts = text.split(regex);
      if (parts.length <= 1) return;

      const frag = document.createDocumentFragment();
      parts.forEach((part) => {
        if (part.toLowerCase() === q.toLowerCase()) {
          const mark = document.createElement("mark");
          mark.className = "search-highlight";
          mark.textContent = part;
          frag.appendChild(mark);
        } else if (part.length > 0) {
          frag.appendChild(document.createTextNode(part));
        }
      });

      parent.replaceChild(frag, node);
    });
  });
}

export function closeMethodologyModal() {
  const methodologyModal = document.getElementById("methodology-modal");
  if (methodologyModal) methodologyModal.classList.add("hidden");
  clearMethodologyHighlights();
  const searchInput = document.getElementById("methodology-search-input");
  if (searchInput && searchInput.value) {
    searchInput.value = "";
    const clearBtn = document.getElementById("methodology-search-clear");
    if (clearBtn) clearBtn.classList.add("hidden");
    document.querySelectorAll(".methodology-scroll-body .methodology-section, .methodology-scroll-body .methodology-divider-banner").forEach((el) => el.classList.remove("search-hidden"));
  }
}

export function setupMethodologySearch() {
  const searchInput = document.getElementById("methodology-search-input");
  const clearBtn = document.getElementById("methodology-search-clear");
  if (!searchInput) return;

  const performFilter = () => {
    const q = (searchInput.value || "").trim().toLowerCase();
    if (clearBtn) {
      clearBtn.classList.toggle("hidden", q.length === 0);
    }

    const sections = document.querySelectorAll(".methodology-scroll-body .methodology-section");
    sections.forEach((sec) => {
      if (!q) {
        sec.classList.remove("search-hidden");
      } else {
        const text = (sec.textContent || "").toLowerCase();
        const matches = text.includes(q);
        sec.classList.toggle("search-hidden", !matches);
      }
    });

    ["methodology-part1-heading", "methodology-part2-heading", "methodology-part3-heading", "methodology-part4-heading"].forEach((bannerId) => {
      const banner = document.getElementById(bannerId);
      if (!banner) return;
      if (!q) {
        banner.classList.remove("search-hidden");
        return;
      }
      let nextEl = banner.nextElementSibling;
      let hasVisibleChild = false;
      while (nextEl && !nextEl.classList.contains("methodology-divider-banner")) {
        if (nextEl.classList.contains("methodology-section") && !nextEl.classList.contains("search-hidden")) {
          hasVisibleChild = true;
          break;
        }
        nextEl = nextEl.nextElementSibling;
      }
      banner.classList.toggle("search-hidden", !hasVisibleChild);
    });

    if (!q) {
      clearMethodologyHighlights();
    } else {
      applyMethodologyHighlights(q);
    }
  };

  searchInput.addEventListener("input", performFilter);
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      searchInput.value = "";
      clearMethodologyHighlights();
      performFilter();
      searchInput.focus();
    });
  }

  // Methodology modal tabs navigation
  const tabTimeline = document.getElementById("modal-tab-timeline");
  const tabSpatial = document.getElementById("modal-tab-spatial");
  const tabSignals = document.getElementById("modal-tab-signals");
  const tabHeatmap = document.getElementById("modal-tab-heatmap");
  const scrollToHeading = (bannerId, activeTabBtn) => {
    if (searchInput.value) {
      searchInput.value = "";
      clearMethodologyHighlights();
      performFilter();
    }
    [tabTimeline, tabSpatial, tabSignals, tabHeatmap].forEach((btn) => {
      if (btn) btn.classList.toggle("active", btn === activeTabBtn);
    });
    const heading = document.getElementById(bannerId);
    if (heading) {
      heading.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  if (tabTimeline) {
    tabTimeline.addEventListener("click", () => scrollToHeading("methodology-part1-heading", tabTimeline));
  }
  if (tabSpatial) {
    tabSpatial.addEventListener("click", () => scrollToHeading("methodology-part2-heading", tabSpatial));
  }
  if (tabSignals) {
    tabSignals.addEventListener("click", () => scrollToHeading("methodology-part3-heading", tabSignals));
  }
  if (tabHeatmap) {
    tabHeatmap.addEventListener("click", () => scrollToHeading("methodology-part4-heading", tabHeatmap));
  }
}

// ----------------------------------------------------------------------------
// Model Details Modal Controller
// ----------------------------------------------------------------------------

function formatModelDateShort(dStr) {
  if (!dStr) return "--";
  try {
    const parts = dStr.split("-");
    const months = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const m = parseInt(parts[1], 10);
    return `${months[m] || parts[1]} ${parts[0]}`;
  } catch (e) {
    return dStr;
  }
}

export async function openModelDetailsModal(modelId, callbacks = {}) {
  const modelDetailModal = document.getElementById("model-detail-modal");
  if (!modelDetailModal) return;

  if (!modelId) {
    const sel = Array.from(state.selectedModels);
    modelId = sel.length > 0 ? sel[0] : (Object.keys(state.models)[0] || "");
  }
  if (!modelId) return;

  state.currentDetailModel = modelId;
  modelDetailModal.classList.remove("hidden");

  // Keep tabs in sync with state
  const activeTab = state.activeModelDetailTab || "coverage";
  const mdTabs = document.getElementById("md-tabs");
  if (mdTabs) {
    mdTabs.querySelectorAll(".model-tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-tab") === activeTab);
    });
  }

  updateModelDetailSelectButton(modelId);

  if (state.modelDetailCache[modelId]) {
    renderModelDetailModal(state.modelDetailCache[modelId], callbacks);
    return;
  }

  renderModelDetailLoading(modelId);

  try {
    const data = await fetchModelDetails(modelId);
    state.modelDetailCache[modelId] = data;
    renderModelDetailModal(data, callbacks);
  } catch (err) {
    console.error("Failed to load model details:", err);
    renderModelDetailError(modelId, err.message);
  }
}

export function hideModelDetailsModal() {
  const modelDetailModal = document.getElementById("model-detail-modal");
  if (modelDetailModal) {
    modelDetailModal.classList.add("hidden");
  }
}

export function updateModelDetailSelectButton(modelId) {
  const mdBtnToggleSelect = document.getElementById("md-btn-toggle-select");
  const mdBtnSelectIcon = document.getElementById("md-btn-select-icon");
  const mdBtnSelectText = document.getElementById("md-btn-select-text");
  if (!mdBtnToggleSelect) return;
  const isSelected = state.selectedModels.has(modelId);
  mdBtnToggleSelect.classList.toggle("is-selected", isSelected);
  if (mdBtnSelectIcon) mdBtnSelectIcon.innerHTML = isSelected ? ICONS.check : "+";
  if (mdBtnSelectText) mdBtnSelectText.textContent = isSelected ? "Selected in Visualizer" : "Compare in Visualizer";
}

function renderModelDetailLoading(modelId) {
  const titleEl = document.getElementById("model-detail-title");
  const mdModalBody = document.getElementById("md-modal-body");
  if (titleEl) titleEl.textContent = modelId;

  if (mdModalBody) {
    mdModalBody.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding: 48px 24px; gap: 14px;">
        <div class="metrics-spinner" style="width:28px; height:28px; border-width:2.5px;"></div>
        <div style="font-size: 0.82rem; color: var(--text-muted); font-family: var(--font-mono);">
          Loading seasonal forecast schedule &amp; model specification...
        </div>
      </div>
    `;
  }
}

function renderModelDetailError(modelId, errorMsg) {
  const mdModalBody = document.getElementById("md-modal-body");
  if (mdModalBody) {
    mdModalBody.innerHTML = `
      <div class="stats-sample-warning" style="margin: 20px 0;">
        <span class="warning-icon">${ICONS.warning}</span>
        <div class="warning-body">
          <div class="warning-title">Could Not Load Details for ${escapeHtml(modelId)}</div>
          <div class="warning-desc">
            Failed to fetch model metadata and seasonal coverage: ${escapeHtml(errorMsg)}.
          </div>
          <div class="warning-actions" style="margin-top: 8px;">
            <button type="button" class="warning-action-btn" id="btn-retry-model-details">
              Retry
            </button>
          </div>
        </div>
      </div>
    `;
    const btnRetry = document.getElementById("btn-retry-model-details");
    if (btnRetry) {
      btnRetry.addEventListener("click", () => openModelDetailsModal(modelId));
    }
  }
}

export function renderModelDetailModal(data, callbacks = {}) {
  if (!data || !data.model_id) return;
  const meta = data.metadata || {};
  const specs = data.specs || {};

  const titleEl = document.getElementById("model-detail-title");
  if (titleEl) titleEl.textContent = data.display_name || data.model_id;

  const badgeTypeEl = document.getElementById("md-badge-type");
  if (badgeTypeEl) {
    if (data.is_synthetic) {
      badgeTypeEl.className = "md-badge synth";
      badgeTypeEl.textContent = "SYNTHETIC";
    } else if (data.hub) {
      badgeTypeEl.className = "md-badge hub";
      badgeTypeEl.textContent = `${(data.hub.short_label || "HUB").toUpperCase()} · LIVE`;
    } else {
      badgeTypeEl.className = "md-badge";
      badgeTypeEl.textContent = data.is_local ? "LOCAL" : "REPO";
    }
  }

  const badgeDesigEl = document.getElementById("md-badge-designated");
  if (badgeDesigEl) {
    badgeDesigEl.className = "md-badge designated";
    badgeDesigEl.style.display = meta.designated_model ? "inline-block" : "none";
    badgeDesigEl.textContent = "PRIMARY";
  }

  const badgeLicenseEl = document.getElementById("md-badge-license");
  if (badgeLicenseEl) {
    badgeLicenseEl.className = "md-badge";
    badgeLicenseEl.textContent = meta.license || "CC-BY-4.0";
  }

  const teamEl = document.getElementById("md-team-name");
  if (teamEl) teamEl.textContent = meta.team_name || "Modeling Team";

  const modelNameEl = document.getElementById("md-model-name");
  if (modelNameEl) modelNameEl.textContent = meta.model_name || meta.model_abbr || data.model_id;

  const versionEl = document.getElementById("md-version");
  if (versionEl) versionEl.textContent = `v${meta.model_version || "1.0"}`;

  const statSeasons = document.getElementById("md-stat-seasons");
  if (statSeasons) statSeasons.textContent = `${(data.active_seasons || []).length} of ${(data.seasons || []).length}`;
  const statSeasonsSub = document.getElementById("md-stat-seasons-sub");
  if (statSeasonsSub) {
    statSeasonsSub.textContent = (data.active_seasons && data.active_seasons.length > 0)
      ? data.active_seasons.join(", ")
      : "No active seasons";
  }

  const statRounds = document.getElementById("md-stat-rounds");
  if (statRounds) statRounds.textContent = `${data.total_dates_count || 0} Weeks`;
  const statRoundsSub = document.getElementById("md-stat-rounds-sub");
  if (statRoundsSub) {
    statRoundsSub.textContent = data.first_date && data.last_date
      ? `${formatModelDateShort(data.first_date)} – ${formatModelDateShort(data.last_date)}`
      : "No dates";
  }

  const statHorizons = document.getElementById("md-stat-horizons");
  if (statHorizons) statHorizons.textContent = `${(specs.horizons || []).length} Horizons`;
  const statHorizonsSub = document.getElementById("md-stat-horizons-sub");
  if (statHorizonsSub) {
    statHorizonsSub.textContent = (specs.horizons && specs.horizons.length > 0)
      ? `h = ${specs.horizons.join(", ")} (0–3 wks)`
      : "Standard 4 horizons";
  }

  const statLocs = document.getElementById("md-stat-locs");
  if (statLocs) statLocs.textContent = `${specs.locations_count || 1} Jurisdictions`;
  const statLocsSub = document.getElementById("md-stat-locs-sub");
  if (statLocsSub) {
    statLocsSub.textContent = (specs.locations_count || 0) >= 50
      ? "National + 50 States, DC, PR, VI"
      : "US National Focus";
  }

  const statVolume = document.getElementById("md-stat-volume");
  if (statVolume) {
    const pts = specs.total_predictions_est || 0;
    statVolume.textContent = pts > 1000 ? `~${Math.round(pts / 1000)}k Points` : `${pts} Points`;
  }
  const statVolumeSub = document.getElementById("md-stat-volume-sub");
  if (statVolumeSub) {
    statVolumeSub.textContent = `${specs.total_files || 0} files (${specs.total_disk_human || "0 KB"})`;
  }

  renderModelDetailActiveTab(data);
}

export function renderModelDetailActiveTab(data) {
  const mdModalBody = document.getElementById("md-modal-body");
  if (!mdModalBody) return;
  const tab = state.activeModelDetailTab || "coverage";

  if (tab === "coverage") {
    mdModalBody.innerHTML = renderModelDetailCoverageTab(data);
  } else if (tab === "methodology") {
    mdModalBody.innerHTML = renderModelDetailMethodologyTab(data);
  } else if (tab === "specs") {
    mdModalBody.innerHTML = renderModelDetailSpecsTab(data);
  }
}

export function renderModelDetailCoverageTab(data) {
  let html = "";
  const seasons = data.seasons || [];

  if (seasons.length === 0) {
    return `<div class="doc-empty">No seasonal forecast data cataloged for this model.</div>`;
  }

  html += `
    <div class="coverage-legend-bar">
      <div class="legend-item"><span class="legend-swatch swatch-full"></span> <span>Full Coverage (All 53 Jurisdictions)</span></div>
      <div class="legend-item"><span class="legend-swatch swatch-partial"></span> <span>Partial Geographic Coverage</span></div>
      <div class="legend-item"><span class="legend-swatch swatch-missing"></span> <span>Not Submitted</span></div>
    </div>
  `;

  const activeSeasons = seasons
    .filter((s) => s.submitted_count > 0)
    .sort((a, b) => b.season.localeCompare(a.season));
  const activeSeasonKeys = new Set(activeSeasons.map((s) => s.season));

  const allKnownSeasonKeys = new Set([
    ...(state.allSeasons || []),
    ...seasons.map((s) => s.season),
  ]);

  const inactiveSeasonKeys = Array.from(allKnownSeasonKeys)
    .filter((sKey) => !activeSeasonKeys.has(sKey))
    .sort();

  if (activeSeasons.length === 0) {
    html += `<div class="doc-empty">No forecasts submitted by this model in any cataloged seasons.</div>`;
  } else {
    activeSeasons.forEach((s) => {
      const partCount = s.partial_coverage_count || 0;
      const badgeClass = s.status === "Complete" ? "complete" : "partial";
      const sShort = formatSeasonShort(s.season);

      let badgeText = `${s.submitted_count} of ${s.total_hub_rounds} Rounds`;
      if (partCount > 0) {
        badgeText += ` • ${partCount} partial jurisdictions`;
      } else {
        badgeText += ` • All 53 Jurisdictions`;
      }

      const dateSpanText = (s.min_date && s.max_date)
        ? `${formatModelDateShort(s.min_date)} – ${formatModelDateShort(s.max_date)}`
        : "No submissions";

      html += `
        <div class="season-section">
          <div class="season-section-header">
            <div class="season-title-row">
              <h4 class="season-name">${sShort} Season</h4>
              <span class="season-status-pill ${badgeClass}">${badgeText}</span>
            </div>
            <span class="season-span-text">${dateSpanText}</span>
          </div>

          <div class="season-progress-track">
            <div class="season-progress-fill ${badgeClass}" style="width: ${Math.min(100, s.coverage_pct)}%;"></div>
          </div>

          <div class="season-matrix-grid">
      `;

      (s.dates || []).forEach((c) => {
        const isSub = c.submitted;
        const locInfo = c.loc_info;
        let tileClass = "missing";
        let tooltip = `No forecast submitted for ${c.date}`;

        if (isSub) {
          if (locInfo && locInfo.is_full_coverage) {
            tileClass = "submitted full-coverage";
            tooltip = `Full Coverage: ${c.date} • All 53 Jurisdictions (US + 52 States/Territories) • Click to load`;
          } else if (locInfo && !locInfo.is_full_coverage) {
            tileClass = "submitted partial-coverage";
            const missText = locInfo.missing_locations && locInfo.missing_locations.length > 0
              ? ` (Missing: ${locInfo.missing_locations.join(", ")})`
              : "";
            tooltip = `Partial Coverage: ${c.date} • ${locInfo.locations_count} of ${locInfo.total_locations} Jurisdictions${missText} • Click to load`;
          } else {
            tileClass = "submitted full-coverage";
            tooltip = `Submitted: ${c.date} • Click to load forecast in visualizer`;
          }
        }

        html += `
          <div class="matrix-tile ${tileClass}" data-date="${escapeHtml(c.date)}" data-model="${escapeHtml(data.model_id)}" title="${escapeHtml(tooltip)}">
            <span class="tile-mo">${c.month}</span>
            <span class="tile-num">${c.day}</span>
          </div>
        `;
      });

      html += `
          </div>
        </div>
      `;
    });
  }

  if (inactiveSeasonKeys.length > 0) {
    html += `
      <div class="model-inactive-seasons-summary">
        <span class="inactive-summary-label">No submissions in:</span>
        <div class="inactive-seasons-pills">
          ${inactiveSeasonKeys.map((sKey) => `<span class="inactive-season-tag">${formatSeasonShort(sKey)} ✕</span>`).join("")}
        </div>
      </div>
    `;
  }

  return html;
}

export function renderModelDetailMethodologyTab(data) {
  const meta = data.metadata || {};
  let rawContributors = meta.model_contributors;
  if (!rawContributors) rawContributors = [];
  if (typeof rawContributors === "string") {
    rawContributors = [{ name: rawContributors, affiliation: meta.team_name || "Research Team" }];
  } else if (!Array.isArray(rawContributors)) {
    rawContributors = [rawContributors];
  }
  const contributors = rawContributors;

  let contribHtml = "";
  if (contributors.length > 0) {
    contribHtml = `<div class="contrib-list">`;
    contributors.forEach((c) => {
      contribHtml += `
        <div class="contrib-item">
          <span class="contrib-name">${escapeHtml(c.name || "Contributor")}</span>
          <span class="contrib-dot">&bull;</span>
          <span class="contrib-affil">${escapeHtml(c.affiliation || "Research Affiliate")}</span>
          ${c.email ? `<span class="contrib-dot">&bull;</span><a href="mailto:${escapeHtml(c.email)}" class="contrib-mail">${escapeHtml(c.email)}</a>` : ""}
        </div>
      `;
    });
    contribHtml += `</div>`;
  } else {
    contribHtml = `<div class="doc-empty-subtle">No named individual contributors listed in model metadata.</div>`;
  }

  // Only http(s) links are rendered; other schemes (e.g. javascript:) from YAML metadata are ignored
  const websiteLink = /^https?:\/\//i.test(String(meta.website_url || "")) ? `
    <div class="doc-key-row">
      <span class="doc-key">Source Repository</span>
      <span class="doc-val"><a href="${escapeHtml(meta.website_url)}" target="_blank" rel="noopener noreferrer" class="doc-ext-link">${escapeHtml(meta.website_url)} &rarr;</a></span>
    </div>
  ` : "";

  const methodsText = (typeof meta.methods === "string" ? meta.methods : (meta.methods ? JSON.stringify(meta.methods) : "No brief method summary provided.")).trim();
  const methodsLongText = (typeof meta.methods_long === "string" ? meta.methods_long : (meta.methods_long ? JSON.stringify(meta.methods_long) : methodsText)).trim();

  return `
    <div class="doc-container">
      <div class="doc-block">
        <div class="doc-section-title">Summary of Modeling Methodology</div>
        <div class="doc-prose">${escapeHtml(methodsText)}</div>
      </div>

      <div class="doc-block">
        <div class="doc-section-title">Technical Architecture &amp; Data Pipeline</div>
        <div class="doc-prose-tech">${escapeHtml(methodsLongText)}</div>
      </div>

      <div class="doc-block">
        <div class="doc-section-title">Model Attributes &amp; Registry Metadata</div>
        <div class="doc-meta-table">
          <div class="doc-key-row">
            <span class="doc-key">Designation</span>
            <span class="doc-val">${meta.designated_model ? "Primary Designated Hub Model" : "Component / Benchmark Model"}</span>
          </div>
          <div class="doc-key-row">
            <span class="doc-key">Model Architecture</span>
            <span class="doc-val">${meta.ensemble_of_models ? (meta.ensemble_of_hub_models ? "Hub Ensemble" : "Internal Ensemble") : "Standalone Statistical Model"}</span>
          </div>
          <div class="doc-key-row">
            <span class="doc-key">Primary Training Inputs</span>
            <span class="doc-val">${escapeHtml(meta.data_inputs || "Weekly NHSN confirmed influenza hospital admissions")}</span>
          </div>
          <div class="doc-key-row">
            <span class="doc-key">License</span>
            <span class="doc-val font-mono">${escapeHtml(meta.license || "CC-BY-4.0")}</span>
          </div>
          ${websiteLink}
        </div>
      </div>

      <div class="doc-block">
        <div class="doc-section-title">Research Team &amp; Authors (${contributors.length})</div>
        ${contribHtml}
      </div>
    </div>
  `;
}

export function renderModelDetailSpecsTab(data) {
  const specs = data.specs || {};
  const horizons = specs.horizons || [];
  const targets = specs.targets || [];

  return `
    <div class="doc-container">
      <div class="doc-grid-2">
        <div class="doc-panel">
          <div class="doc-panel-title">TARGET SPECIFICATIONS</div>
          <div class="doc-meta-table">
            <div class="doc-key-row">
              <span class="doc-key">Target Variable</span>
              <span class="doc-val font-mono">${escapeHtml(targets.join(", ") || "wk inc flu hosp")}</span>
            </div>
            <div class="doc-key-row">
              <span class="doc-key">Target Phenomenon</span>
              <span class="doc-val">Weekly incident influenza hospital admissions</span>
            </div>
            <div class="doc-key-row">
              <span class="doc-key">Reporting Cadence</span>
              <span class="doc-val">Saturday-to-Saturday CDC MMWR epidemiological weeks</span>
            </div>
            <div class="doc-key-row">
              <span class="doc-key">Observation Unit</span>
              <span class="doc-val">Discrete count of laboratory-confirmed admissions</span>
            </div>
            ${specs.peak_targets === undefined ? "" : `
            <div class="doc-key-row" title="Season-level targets with no horizon, shown in the Season Peak view">
              <span class="doc-key">Season Peak</span>
              <span class="doc-val font-mono">${specs.peak_targets.length
                ? `${escapeHtml(specs.peak_targets.join(", "))} · ${specs.peak_rounds} round${specs.peak_rounds === 1 ? "" : "s"} (latest ${escapeHtml(specs.peak_latest || "—")})`
                : "Not submitted"}</span>
            </div>`}
          </div>
        </div>

        <div class="doc-panel">
          <div class="doc-panel-title">EVALUATION HORIZONS</div>
          <div class="doc-meta-table">
            <div class="doc-key-row">
              <span class="doc-key">Nowcast (h = 0)</span>
              <span class="doc-val">Current week estimate relative to Saturday data cutoff</span>
            </div>
            <div class="doc-key-row">
              <span class="doc-key">Projections (h = 1..3)</span>
              <span class="doc-val">1-week, 2-week, and 3-week ahead forecasts</span>
            </div>
            <div class="doc-key-row">
              <span class="doc-key">Temporal Anchoring</span>
              <span class="doc-val">Official Saturday epidemiological reference date</span>
            </div>
            <div class="doc-key-row">
              <span class="doc-key">Active Leads</span>
              <span class="doc-val font-mono">${horizons.length} horizons (${horizons.map(h => `h=${h}`).join(", ")})</span>
            </div>
          </div>
        </div>
      </div>

      <div class="doc-grid-2">
        <div class="doc-panel">
          <div class="doc-panel-title">SCHEMA &amp; HUB COMPLIANCE</div>
          <div class="doc-meta-table">
            <div class="doc-key-row">
              <span class="doc-key">Hub Standard</span>
              <span class="doc-val">Hubverse Standard Schema (FluSight v5.1 compliant)</span>
            </div>
            <div class="doc-key-row">
              <span class="doc-key">Representation</span>
              <span class="doc-val">Probabilistic quantiles (CDC FluSight standard 23 quantiles)</span>
            </div>
            <div class="doc-key-row">
              <span class="doc-key">Quantile Levels</span>
              <span class="doc-val font-mono">0.010 &rarr; 0.990 (50%, 80%, 95% prediction intervals)</span>
            </div>
            <div class="doc-key-row">
              <span class="doc-key">Spatial Units</span>
              <span class="doc-val">US National aggregate + 53 state &amp; territorial jurisdictions</span>
            </div>
          </div>
        </div>

        <div class="doc-panel">
          <div class="doc-panel-title">WORKSPACE STORAGE &amp; COMPUTE</div>
          <div class="doc-meta-table">
            <div class="doc-key-row">
              <span class="doc-key">Submission Rounds</span>
              <span class="doc-val font-mono">${specs.total_files || 0} forecast files</span>
            </div>
            <div class="doc-key-row">
              <span class="doc-key">Disk Footprint</span>
              <span class="doc-val font-mono">${specs.total_disk_human || "0 KB"} (${(specs.total_disk_bytes || 0).toLocaleString()} bytes)</span>
            </div>
            <div class="doc-key-row">
              <span class="doc-key">Evaluated Points</span>
              <span class="doc-val font-mono">~${(specs.total_predictions_est || 0).toLocaleString()} forecast rows</span>
            </div>
            ${data.hub ? renderHubSourceRows(data.hub) : `<div class="doc-key-row">
              <span class="doc-key">Filesystem Path</span>
              <span class="doc-val font-mono text-cyan">${data.is_local ? "local-output/" : "model-output/"}${escapeHtml(data.model_id)}/</span>
            </div>`}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderHubSourceRows(hub) {
  const subs = hub.submissions || [];
  const latest = subs[0];
  const revised = subs.filter((r) => r.revisions > 0).length;
  const posted = latest && latest.posted ? latest.posted.slice(0, 16).replace("T", " ") + " UTC" : "—";
  return `
    <div class="doc-key-row">
      <span class="doc-key">Source</span>
      <span class="doc-val font-mono text-cyan">s3://${escapeHtml(hub.bucket || "")}/${escapeHtml(hub.s3_prefix || "")}</span>
    </div>
    <div class="doc-key-row">
      <span class="doc-key">Latest Round Posted</span>
      <span class="doc-val font-mono">${escapeHtml(latest ? latest.reference_date : "—")} &bull; ${escapeHtml(posted)}</span>
    </div>
    <div class="doc-key-row">
      <span class="doc-key">Upstream Revisions</span>
      <span class="doc-val font-mono">${revised ? `${revised} round${revised === 1 ? "" : "s"} resubmitted since first sync` : "None seen"}</span>
    </div>
    <div class="doc-key-row">
      <span class="doc-key">Last Synced</span>
      <span class="doc-val font-mono">${escapeHtml(hub.last_sync ? hub.last_sync.replace("T", " ").replace("Z", " UTC") : "—")}</span>
    </div>`;
}
