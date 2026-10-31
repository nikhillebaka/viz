/**
 * FluSight Sandbox Lab — Synthetic Ensemble Studio Component
 * Interactive wizard to construct, backtest, audit, and persist custom quantile ensembles.
 */

import { fetchEnsembles, previewEnsemble, createEnsemble, saveEnsemble, deleteEnsemble, createRequestGuard } from "../api.js";
import { escapeHtml, SIMPLE_INFO_SVG, sourceTag, modelLabel } from "../constants.js";
import { state } from "../state.js";

let studioActiveTab = "builder";
let preflightDebounceTimer = null;
const previewGuard = createRequestGuard();

export function initEnsembleStudio(callbacks = {}) {
  const modal = document.getElementById("ensemble-studio-modal");
  const btnOpen = document.getElementById("btn-open-ensemble-studio");
  const btnClose = document.getElementById("btn-close-ensemble-studio");
  const btnCloseBottom = document.getElementById("btn-close-ensemble-studio-bottom");

  if (!modal) return;

  if (btnOpen) {
    btnOpen.addEventListener("click", () => openEnsembleStudio("builder", callbacks));
  }
  if (btnClose) {
    btnClose.addEventListener("click", closeEnsembleStudio);
  }
  if (btnCloseBottom) {
    btnCloseBottom.addEventListener("click", closeEnsembleStudio);
  }

  // Backdrop click closes modal
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      closeEnsembleStudio();
    }
  });

  // Tab switching
  const tabBtns = modal.querySelectorAll(".ensemble-studio-tabs .model-tab-btn");
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetTab = btn.getAttribute("data-tab");
      switchStudioTab(targetTab, callbacks);
    });
  });

  // Method radios
  const methodRadios = modal.querySelectorAll("input[name='ensemble-method']");
  methodRadios.forEach((r) => {
    r.addEventListener("change", () => {
      document.querySelectorAll(".method-card").forEach((card) => {
        const inp = card.querySelector("input");
        card.classList.toggle("active", inp && inp.checked);
      });
      triggerPreflightDebounced();
    });
  });

  // Spatial routing radios
  const routingRadios = modal.querySelectorAll("input[name='ensemble-routing']");
  routingRadios.forEach((r) => {
    r.addEventListener("change", () => {
      document.querySelectorAll(".routing-toggle-wrap .routing-option").forEach((opt) => {
        const inp = opt.querySelector("input");
        opt.classList.toggle("active", inp && inp.checked);
      });
      const isSplit = r.value === "split";
      const uniformContainer = document.getElementById("studio-uniform-container");
      const splitContainer = document.getElementById("studio-split-container");
      if (uniformContainer && splitContainer) {
        uniformContainer.classList.toggle("hidden", isSplit);
        splitContainer.classList.toggle("hidden", !isSplit);
      }
      const explanationBox = document.getElementById("routing-explanation-box");
      if (explanationBox) {
        if (isSplit) {
          explanationBox.innerHTML = `<strong>Spatial Split:</strong> States Pool forecasts the 50 States, DC, and PR. National Pool forecasts US National (matching Hubverse production models like <code>UMass-flusion_spatial2_prod</code>).`;
        } else {
          explanationBox.innerHTML = `<strong>Uniform:</strong> All selected models are combined across both US national and state locations.`;
        }
      }
      triggerPreflightDebounced();
    });
  });

  // Missing policy radios
  const policyRadios = modal.querySelectorAll("input[name='ensemble-policy']");
  policyRadios.forEach((r) => {
    r.addEventListener("change", () => {
      document.querySelectorAll("input[name='ensemble-policy']").forEach((inp) => {
        const parent = inp.closest(".routing-option");
        if (parent) parent.classList.toggle("active", inp.checked);
      });
      triggerPreflightDebounced();
    });
  });

  // Search input
  const searchInput = document.getElementById("studio-model-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      filterCandidateModelGrids(searchInput.value.trim().toLowerCase());
    });
  }

  // Quick select buttons
  const btnAll = document.getElementById("btn-studio-sel-all");
  if (btnAll) {
    btnAll.addEventListener("click", () => {
      setAllCheckboxes(() => true);
    });
  }

  const btnNone = document.getElementById("btn-studio-sel-none");
  if (btnNone) {
    btnNone.addEventListener("click", () => {
      setAllCheckboxes(() => false);
    });
  }

  // Submit button
  const btnSubmit = document.getElementById("btn-submit-create-ensemble");
  if (btnSubmit) {
    btnSubmit.addEventListener("click", () => handleCreateEnsemble(callbacks));
  }

  // Initial count check
  updateNavbarEnsembleCount();
}

export async function openEnsembleStudio(tab = "builder", callbacks = {}) {
  const modal = document.getElementById("ensemble-studio-modal");
  if (!modal) return;

  state.ensembleStudioOpen = true;
  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");

  // Populate candidate model checkboxes
  populateCandidateModelGrids();

  // Switch to requested tab
  switchStudioTab(tab, callbacks);

  // Trigger pre-flight check
  runPreflightAudit();
}

export function closeEnsembleStudio() {
  const modal = document.getElementById("ensemble-studio-modal");
  if (!modal) return;

  state.ensembleStudioOpen = false;
  modal.classList.add("hidden");
  document.body.classList.remove("modal-open");
}

function switchStudioTab(tab, callbacks = {}) {
  studioActiveTab = tab;
  const modal = document.getElementById("ensemble-studio-modal");
  if (!modal) return;

  modal.querySelectorAll(".ensemble-studio-tabs .model-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
  });

  const paneBuilder = document.getElementById("pane-ensemble-builder");
  const paneActive = document.getElementById("pane-ensemble-active");

  if (paneBuilder) paneBuilder.classList.toggle("hidden", tab !== "builder");
  if (paneActive) paneActive.classList.toggle("hidden", tab !== "active");

  if (tab === "active") {
    loadAndRenderActiveEnsembles(callbacks);
  }
}

function populateCandidateModelGrids() {
  const uniformGrid = document.getElementById("studio-uniform-models-grid");
  const stateGrid = document.getElementById("studio-state-models-grid");
  const natGrid = document.getElementById("studio-nat-models-grid");

  if (!uniformGrid || !stateGrid || !natGrid) return;

  // Repo models first, then local, then hub models, then alphabetical
  const rank = (id) => {
    const m = state.models[id] || {};
    if (m.source === "hub") return 2;
    return m.is_local ? 1 : 0;
  };
  const modelIds = Object.keys(state.models).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  const buildCheckboxItem = (mid, groupName) => {
    const meta = state.models[mid] || {};
    const label = document.createElement("label");
    label.className = "model-picker-item";
    label.setAttribute("data-model", mid);

    const tag = sourceTag(meta);
    const badgeCls = tag.cls;
    const badgeTxt = meta.is_synthetic ? "SYNTH" : tag.text;

    label.innerHTML = `
      <input type="checkbox" name="${groupName}" value="${escapeHtml(mid)}" />
      <span class="custom-checkbox-box"></span>
      <span class="model-picker-name" title="${escapeHtml(mid)}">${escapeHtml(modelLabel(mid, meta))}</span>
      <span class="chip-tag ${badgeCls}">${badgeTxt}</span>
    `;

    const input = label.querySelector("input");
    input.addEventListener("change", () => {
      label.classList.toggle("selected", input.checked);
      updateSelectedModelsCounter();
      triggerPreflightDebounced();
    });

    return label;
  };

  uniformGrid.innerHTML = "";
  stateGrid.innerHTML = "";
  natGrid.innerHTML = "";

  modelIds.forEach((mid) => {
    uniformGrid.appendChild(buildCheckboxItem(mid, "model-uniform"));
    stateGrid.appendChild(buildCheckboxItem(mid, "model-state"));
    natGrid.appendChild(buildCheckboxItem(mid, "model-nat"));
  });

  // Pre-select currently active models from state in uniform grid
  if (state.selectedModels.size > 0) {
    uniformGrid.querySelectorAll("input[type='checkbox']").forEach((inp) => {
      if (state.selectedModels.has(inp.value)) {
        inp.checked = true;
        inp.closest(".model-picker-item")?.classList.add("selected");
      }
    });
  }

  updateSelectedModelsCounter();
}

function setAllCheckboxes(predicate) {
  const isSplit = isSpatialSplitActive();
  const containers = isSplit
    ? [document.getElementById("studio-state-models-grid"), document.getElementById("studio-nat-models-grid")]
    : [document.getElementById("studio-uniform-models-grid")];

  containers.forEach((c) => {
    if (!c) return;
    c.querySelectorAll(".model-picker-item").forEach((item) => {
      if (item.classList.contains("search-hidden")) return;
      const inp = item.querySelector("input");
      if (inp) {
        inp.checked = predicate(inp.value);
        item.classList.toggle("selected", inp.checked);
      }
    });
  });

  updateSelectedModelsCounter();
  triggerPreflightDebounced();
}

function filterCandidateModelGrids(query) {
  const items = document.querySelectorAll(".model-picker-item");
  items.forEach((item) => {
    const mid = (item.getAttribute("data-model") || "").toLowerCase();
    const matches = !query || mid.includes(query);
    item.classList.toggle("search-hidden", !matches);
  });
}

function isSpatialSplitActive() {
  const rad = document.querySelector("input[name='ensemble-routing']:checked");
  return rad ? rad.value === "split" : false;
}

function getSelectedCandidateModels() {
  const isSplit = isSpatialSplitActive();
  if (isSplit) {
    const stateModels = Array.from(
      document.querySelectorAll("input[name='model-state']:checked")
    ).map((i) => i.value);
    const nationalModels = Array.from(
      document.querySelectorAll("input[name='model-nat']:checked")
    ).map((i) => i.value);
    return {
      isSplit: true,
      stateModels,
      nationalModels,
      allModels: Array.from(new Set([...stateModels, ...nationalModels])),
    };
  } else {
    const models = Array.from(
      document.querySelectorAll("input[name='model-uniform']:checked")
    ).map((i) => i.value);
    return {
      isSplit: false,
      stateModels: [],
      nationalModels: [],
      allModels: models,
    };
  }
}

function updateSelectedModelsCounter() {
  const counter = document.getElementById("studio-selected-models-count");
  const stateCount = document.getElementById("studio-state-models-count");
  const natCount = document.getElementById("studio-nat-models-count");

  const sel = getSelectedCandidateModels();
  if (counter) {
    counter.textContent = `${sel.allModels.length} selected`;
  }
  if (stateCount) stateCount.textContent = `${sel.stateModels.length}`;
  if (natCount) natCount.textContent = `${sel.nationalModels.length}`;
}

function triggerPreflightDebounced() {
  clearTimeout(preflightDebounceTimer);
  preflightDebounceTimer = setTimeout(runPreflightAudit, 200);
}

async function runPreflightAudit() {
  const sel = getSelectedCandidateModels();
  const method = document.querySelector("input[name='ensemble-method']:checked")?.value || "median";
  const policy = document.querySelector("input[name='ensemble-policy']:checked")?.value || "flexible";

  const pfModelCount = document.getElementById("pf-model-count");
  const pfCommonRounds = document.getElementById("pf-common-rounds");
  const pfUnionRounds = document.getElementById("pf-union-rounds");
  const pfOverlapPct = document.getElementById("pf-overlap-pct");
  const pfBarFill = document.getElementById("pf-bar-fill");
  const pfStatusBadge = document.getElementById("preflight-status-badge");
  const pfWarningBanner = document.getElementById("pf-warning-banner");

  if (pfModelCount) pfModelCount.textContent = `${sel.allModels.length}`;

  if (sel.allModels.length < 2) {
    if (pfCommonRounds) pfCommonRounds.textContent = "--";
    if (pfUnionRounds) pfUnionRounds.textContent = "--";
    if (pfOverlapPct) pfOverlapPct.textContent = "--%";
    if (pfBarFill) pfBarFill.style.width = "0%";
    if (pfStatusBadge) {
      pfStatusBadge.className = "audit-status-badge warning";
      pfStatusBadge.textContent = "Select >= 2 Models";
    }
    if (pfWarningBanner) {
      pfWarningBanner.classList.remove("hidden");
      pfWarningBanner.innerHTML = "<span>Please select at least two models to form an ensemble.</span>";
    }
    return;
  }

  const payload = {
    method,
    spatial_split: sel.isSplit,
    models: sel.allModels,
    state_models: sel.stateModels,
    national_models: sel.nationalModels,
    missing_policy: policy,
  };

  const request = previewGuard.start();
  try {
    const res = await previewEnsemble(payload, request.signal);
    if (!request.isCurrent()) return;
    if (!res.valid) {
      if (pfStatusBadge) {
        pfStatusBadge.className = "audit-status-badge error";
        pfStatusBadge.textContent = "Configuration Error";
      }
      if (pfWarningBanner) {
        pfWarningBanner.classList.remove("hidden");
        pfWarningBanner.innerHTML = `<span>${escapeHtml(res.error || "Invalid configuration")}</span>`;
      }
      return;
    }

    const common = res.common_dates_count || 0;
    const union = res.union_dates_count || 0;
    const pct = res.date_overlap_percentage || 0;

    if (pfCommonRounds) pfCommonRounds.textContent = `${common} rounds`;
    if (pfUnionRounds) pfUnionRounds.textContent = `${union} rounds`;
    if (pfOverlapPct) pfOverlapPct.textContent = `${pct}%`;
    if (pfBarFill) pfBarFill.style.width = `${Math.min(100, pct)}%`;

    if (pfStatusBadge) {
      if (pct === 100) {
        pfStatusBadge.className = "audit-status-badge valid";
        pfStatusBadge.textContent = "Perfect Overlap (100%)";
      } else if (pct >= 50) {
        pfStatusBadge.className = "audit-status-badge valid";
        pfStatusBadge.textContent = "Good Alignment";
      } else {
        pfStatusBadge.className = "audit-status-badge warning";
        pfStatusBadge.textContent = "Partial Overlap";
      }
    }

    if (pfWarningBanner) {
      if (res.has_date_mismatch) {
        pfWarningBanner.classList.remove("hidden");
        const policyNote = policy === "strict"
          ? "Under <strong>Strict</strong> policy, only the mutual overlapping rounds will be evaluated."
          : "Under <strong>Flexible</strong> policy, each task pools only the members that forecast it.";
        pfWarningBanner.innerHTML = `
          <span>
            Constituent models have date coverage divergence (${common} common of ${union} total rounds).
            ${policyNote}
          </span>
        `;
      } else {
        pfWarningBanner.classList.add("hidden");
      }
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    if (pfStatusBadge) {
      pfStatusBadge.className = "audit-status-badge error";
      pfStatusBadge.textContent = "Preview Error";
    }
    if (pfWarningBanner) {
      pfWarningBanner.classList.remove("hidden");
      pfWarningBanner.innerHTML = `<span>Error checking overlap: ${escapeHtml(err.message)}</span>`;
    }
  }
}

async function handleCreateEnsemble(callbacks = {}) {
  const nameInput = document.getElementById("ensemble-name-input");
  const descInput = document.getElementById("ensemble-desc-input");
  const btnSubmit = document.getElementById("btn-submit-create-ensemble");

  const name = nameInput ? nameInput.value.trim() : "";
  if (!name) {
    showStudioInlineWarning("Please provide a name for this synthetic ensemble.");
    if (nameInput) nameInput.focus();
    return;
  }

  const sel = getSelectedCandidateModels();
  if (sel.allModels.length < 2) {
    showStudioInlineWarning("Please select at least 2 models to form an ensemble.");
    return;
  }

  if (sel.isSplit && (sel.stateModels.length === 0 || sel.nationalModels.length === 0)) {
    showStudioInlineWarning("Spatial split requires at least one model for States and one model for US National.");
    return;
  }

  const method = document.querySelector("input[name='ensemble-method']:checked")?.value || "median";
  const policy = document.querySelector("input[name='ensemble-policy']:checked")?.value || "flexible";

  const payload = {
    name,
    description: descInput ? descInput.value.trim() : "",
    method,
    spatial_split: sel.isSplit,
    models: sel.allModels,
    state_models: sel.stateModels,
    national_models: sel.nationalModels,
    missing_policy: policy,
    save_to_disk: false,
  };

  const originalHtml = btnSubmit ? btnSubmit.innerHTML : "";
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = `<span class="spinner-inline"></span> <span>Creating Ensemble...</span>`;
  }

  try {
    const res = await createEnsemble(payload);
    const createdId = res.ensemble?.id;

    // Automatically add newly created ensemble to active visualizer selection
    if (createdId) {
      state.selectedModels.add(createdId);
    }

    // Update navbar badge
    await updateNavbarEnsembleCount();

    // Re-populate candidates so the new ensemble can be referenced
    populateCandidateModelGrids();

    // Close modal and trigger visualizer re-render
    closeEnsembleStudio();

    if (callbacks.onEnsembleCreated) {
      await callbacks.onEnsembleCreated(res.ensemble);
    }
  } catch (err) {
    showStudioInlineWarning(`Failed to create synthetic ensemble: ${err.message}`);
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = originalHtml;
    }
  }
}

export async function loadAndRenderActiveEnsembles(callbacks = {}) {
  const listEl = document.getElementById("studio-active-list");
  if (!listEl) return;

  listEl.innerHTML = `<div class="loading-state-p"><span class="spinner-inline"></span> Loading ensembles...</div>`;

  try {
    const res = await fetchEnsembles();
    const ensembles = res.ensembles || [];
    state.ensemblesList = ensembles;

    const countTab = document.getElementById("studio-active-count-tab");
    if (countTab) countTab.textContent = String(ensembles.length);

    if (ensembles.length === 0) {
      listEl.innerHTML = `
        <div class="empty-ensembles-box">
          <p>No synthetic ensembles created yet.</p>
          <button type="button" class="btn-create-ensemble-cta" id="btn-empty-go-builder">Create an Ensemble</button>
        </div>
      `;
      const btnGo = document.getElementById("btn-empty-go-builder");
      if (btnGo) {
        btnGo.addEventListener("click", () => switchStudioTab("builder", callbacks));
      }
      return;
    }

    listEl.innerHTML = "";
    ensembles.forEach((ens) => {
      const card = document.createElement("div");
      card.className = "ensemble-item-card";

      const isSelected = state.selectedModels.has(ens.id);
      const compModels = ens.spatial_split
        ? (ens.state_models || []).concat(ens.national_models || [])
        : (ens.models || []);

      card.innerHTML = `
        <div class="ens-card-header">
          <div class="ens-card-title-row">
            <span class="ens-card-name">${escapeHtml(ens.name)}</span>
            <span class="chip-tag synth">[SYNTHETIC]</span>
            <span class="chip-tag ${ens.is_saved ? "local" : "repo"}">${ens.is_saved ? "SAVED ON DISK" : "SESSION ONLY"}</span>
          </div>
          <div class="ens-card-meta">
            ID: <code>${escapeHtml(ens.id)}</code> &bull; Method: <strong>Quantile ${escapeHtml(ens.method)}</strong> &bull; Routing: <strong>${ens.spatial_split ? "Spatial Split" : "Uniform"}</strong>
          </div>
          ${ens.description ? `<div class="ens-card-desc">${escapeHtml(ens.description)}</div>` : ""}
        </div>

        <div class="ens-card-members">
          <span class="members-label">Constituent Models (${compModels.length}):</span>
          <div class="members-chips">
            ${compModels.map((m) => `<span class="member-chip">${escapeHtml(m)}</span>`).join("")}
          </div>
        </div>

        <div class="ens-card-actions">
          <button type="button" class="ens-action-btn ${isSelected ? "active" : ""}" data-action="toggle-select" data-id="${escapeHtml(ens.id)}">
            ${isSelected ? "Remove from Visualizer" : "Compare in Visualizer"}
          </button>
          ${!ens.is_saved ? `
            <button type="button" class="ens-action-btn" data-action="save" data-id="${escapeHtml(ens.id)}">
              Save to local-output/
            </button>
          ` : ""}
          <button type="button" class="ens-action-btn danger" data-action="delete" data-id="${escapeHtml(ens.id)}">
            Delete
          </button>
        </div>
      `;

      // Hook up card buttons
      const btnToggle = card.querySelector("[data-action='toggle-select']");
      if (btnToggle) {
        btnToggle.addEventListener("click", () => {
          if (state.selectedModels.has(ens.id)) {
            state.selectedModels.delete(ens.id);
          } else {
            state.selectedModels.add(ens.id);
          }
          loadAndRenderActiveEnsembles(callbacks);
          if (callbacks.onSelectionChange) {
            callbacks.onSelectionChange();
          }
        });
      }

      const btnSave = card.querySelector("[data-action='save']");
      if (btnSave) {
        btnSave.addEventListener("click", async () => {
          btnSave.disabled = true;
          btnSave.textContent = "Saving...";
          try {
            await saveEnsemble(ens.id);
            await loadAndRenderActiveEnsembles(callbacks);
            if (callbacks.onEnsembleUpdated) callbacks.onEnsembleUpdated();
          } catch (err) {
            alert(`Failed to save ensemble: ${err.message}`);
            btnSave.disabled = false;
            btnSave.textContent = "Save to local-output/";
          }
        });
      }

      const btnDel = card.querySelector("[data-action='delete']");
      if (btnDel) {
        let deleteConfirmTimer = null;
        btnDel.addEventListener("click", async () => {
          if (!btnDel.classList.contains("confirm-delete")) {
            btnDel.classList.add("confirm-delete");
            btnDel.textContent = "Confirm Delete?";
            clearTimeout(deleteConfirmTimer);
            deleteConfirmTimer = setTimeout(() => {
              btnDel.classList.remove("confirm-delete");
              btnDel.textContent = "Delete";
            }, 4000);
            return;
          }

          clearTimeout(deleteConfirmTimer);
          btnDel.disabled = true;
          btnDel.textContent = "Deleting...";

          try {
            await deleteEnsemble(ens.id);
            state.selectedModels.delete(ens.id);
            delete state.models[ens.id];
            await updateNavbarEnsembleCount();
            populateCandidateModelGrids();
            await loadAndRenderActiveEnsembles(callbacks);
            if (callbacks.onEnsembleDeleted) {
              await callbacks.onEnsembleDeleted(ens.id);
            }
          } catch (err) {
            btnDel.disabled = false;
            btnDel.classList.remove("confirm-delete");
            btnDel.textContent = "Delete";
            alert(`Failed to delete ensemble: ${err.message}`);
          }
        });
      }

      listEl.appendChild(card);
    });
  } catch (err) {
    listEl.innerHTML = `<div class="error-msg">Failed to load ensembles: ${escapeHtml(err.message)}</div>`;
  }
}

export async function updateNavbarEnsembleCount() {
  const badge = document.getElementById("nav-ensemble-badge");
  const navBtn = document.getElementById("btn-open-ensemble-studio");
  if (!badge && !navBtn) return;

  try {
    const res = await fetchEnsembles();
    const count = (res.ensembles || []).length;
    if (count > 0) {
      if (badge) {
        badge.style.display = "inline-flex";
        badge.textContent = String(count);
      }
      if (navBtn) {
        navBtn.classList.add("has-active");
      }
    } else {
      if (badge) badge.style.display = "none";
      if (navBtn) {
        navBtn.classList.remove("has-active");
      }
    }
  } catch {
    if (badge) badge.style.display = "none";
    if (navBtn) navBtn.classList.remove("has-active");
  }
}

function showStudioInlineWarning(msg) {
  const banner = document.getElementById("pf-warning-banner");
  if (banner) {
    banner.classList.remove("hidden");
    banner.innerHTML = `<span>${escapeHtml(msg)}</span>`;
  }
}
