/* Combine: build a quantile ensemble from the selected models (old viz's Ensemble Studio, rethought).
 * Opened from the model picker's footer. Members start as the selection and can be dropped; the method
 * (median or mean of each quantile, as old viz) and the missing-member policy are chosen; a preview reports
 * how well the members' rounds overlap; Create registers it on the server. Ensembles live in server
 * memory until saved to local-output/synthetic; both appear as models once the page reloads. */
import { h } from "../lib/dom.js";
import { openPopover } from "../ui/floating.js";
import { Segmented, icon, toast } from "../ui/controls.js";
import { clearAllCaches } from "../lib/api.js";
import { getJSON, postJSON, reloadSoon } from "./More.js";
import { select, chartedBySlot } from "./selection.js";

const ARM_MS = 3500;
const METHODS = [{ value: "median", label: "Median" }, { value: "mean", label: "Mean" }];
const POLICIES = [{ value: "flexible", label: "Pool present" }, { value: "strict", label: "All or none" }];

/**
 * @param {HTMLElement} anchor what the panel hangs from (the Models bubble)
 * @param {{ manifest: object, store: object }} ctx
 * @returns {object | null} the layer
 */
export function openCombine(anchor, { manifest, store }) {
  let members = store.get().sel.selected.slice();
  let method = "median", policy = "flexible", named = false, seq = 0, timer = 0;
  const label = (id) => manifest.label(id, members);
  const autoName = () => `${method === "median" ? "Median" : "Mean"} of ${members.length > 2 ? `${members.length} models` : members.map(label).join(", ")}`;

  const memberList = h("div", { class: "mo-members", role: "list", "aria-label": "Members" });
  const nameInput = h("input", { type: "text", maxlength: "64", autocomplete: "off", spellcheck: "false", "aria-label": "Name" });
  const preview = h("div", { class: "mo-preview", "aria-live": "polite" });
  const createBtn = h("button", { type: "button", class: "c-btn sm mo-primary" }, "Create");
  const saved = h("div", { class: "mo-saved" });
  const methodEl = h("div", { class: "mo-seg" }), policyEl = h("div", { class: "mo-seg" });

  const layer = openPopover(anchor, {
    title: "Combine", placement: "bottom-start", width: 420, className: "mo-panel",
    onClose() { clearTimeout(timer); seq++; },
    content(body) {
      body.append(
        h("div", { class: "c-section" }, h("span", { class: "c-section-title" }, "Members")),
        memberList,
        h("div", { class: "mo-form" },
          h("span", { class: "mo-form-label" }, "Method"), methodEl,
          h("span", { class: "mo-form-label" }, "Missing"), policyEl,
          h("span", { class: "mo-form-label" }, "Name"), h("label", { class: "c-search mo-field" }, nameInput)),
        preview,
        h("div", { class: "mo-actions" }, createBtn),
        saved);
    },
  });
  if (!layer) return null;
  new Segmented(methodEl, { items: METHODS, value: method, label: "Method", onChange: (v) => { method = v; changed(); } });
  new Segmented(policyEl, { items: POLICIES, value: policy, label: "When a member is missing", onChange: (v) => { policy = v; changed(); } });
  nameInput.addEventListener("input", () => { named = nameInput.value.trim() !== ""; });
  createBtn.addEventListener("click", create);
  drawMembers();
  changed(true);
  loadSaved();
  return layer;

  function drawMembers() {
    memberList.replaceChildren(...members.map((id) => h("div", { class: "mo-member", role: "listitem" },
      h("span", { class: "mo-member-name", title: id }, label(id)),
      h("button", { type: "button", class: "c-btn icon sm", "aria-label": `Drop ${label(id)}`, html: icon.close, onclick: () => { members = members.filter((m) => m !== id); drawMembers(); changed(); } }))));
    if (!members.length) memberList.append(h("div", { class: "mo-note" }, "No members"));
    layer.place();
  }

  function changed(now = false) {
    if (!named) nameInput.value = autoName();
    createBtn.disabled = members.length < 2;
    clearTimeout(timer);
    timer = setTimeout(runPreview, now ? 0 : 200);
  }

  async function runPreview() {
    const n = ++seq;
    if (members.length < 2) { preview.className = "mo-preview"; preview.textContent = "Needs 2 or more members"; return; }
    preview.className = "mo-preview"; preview.textContent = "Checking overlap…";
    let r;
    try { r = await postJSON("/api/ensemble/preview", { method, models: members, missing_policy: policy, spatial_split: false }, { okStatuses: [400] }); }
    catch (err) { r = { valid: false, error: err.message }; }
    if (n !== seq) return;
    if (!r.valid) { preview.className = "mo-preview is-bad"; preview.textContent = r.error || "Invalid"; return; }
    const pct = r.date_overlap_percentage ?? 0;
    preview.className = ["mo-preview", pct >= 100 ? "is-good" : pct >= 50 ? "" : "is-warn"].filter(Boolean).join(" ");
    preview.replaceChildren(
      h("span", { class: "mo-preview-num" }, `${pct}%`),
      ` overlap · ${r.common_dates_count} of ${r.union_dates_count} rounds in common`,
      r.has_date_mismatch ? ` · ${policy === "strict" ? "others dropped" : "others pool who is present"}` : "");
  }

  async function create() {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    createBtn.disabled = true; createBtn.textContent = "Creating…";
    try {
      const r = await postJSON("/api/ensemble/create", { name, method, models: members, missing_policy: policy, spatial_split: false, save_to_disk: false });
      // select it once the page has reloaded with the new manifest: the URL names the whole current
      // selection plus the ensemble (it may have named none, the selection then coming from storage)
      const next = select(store.get().sel, r.ensemble.id);
      const url = new URL(location.href);
      if (manifest.hub_id) url.searchParams.set("hub", manifest.hub_id);
      url.searchParams.set("models", next.selected.join(","));
      url.searchParams.set("chart", chartedBySlot(next).map((id) => id ?? "").join(","));
      history.replaceState(history.state, "", url);
      clearAllCaches();
      toast(`Created ${r.ensemble.name}`);
      layer.close(false);
      reloadSoon();
    } catch (err) {
      preview.className = "mo-preview is-bad"; preview.textContent = err.message;
      createBtn.disabled = false; createBtn.textContent = "Create";
    }
  }

  async function loadSaved() {
    let list = [];
    try { list = (await getJSON("/api/ensemble/list")).ensembles || []; } catch { return; }
    if (!list.length) { saved.replaceChildren(); layer.place(); return; }
    const armed = new Map();
    const row = (e) => {
      const del = h("button", { type: "button", class: "c-btn sm mo-remove" }, "Delete");
      del.addEventListener("click", async () => {
        if (!armed.has(e.id)) {
          del.textContent = "Delete?"; del.classList.add("armed");
          armed.set(e.id, setTimeout(() => { armed.delete(e.id); del.textContent = "Delete"; del.classList.remove("armed"); }, ARM_MS));
          return;
        }
        clearTimeout(armed.get(e.id));
        del.disabled = true;
        try { await postJSON("/api/ensemble/delete", { ensemble_id: e.id }); clearAllCaches(); toast(`Deleted ${e.name}`); reloadSoon(); }
        catch (err) { del.disabled = false; del.textContent = "Delete"; toast(`Couldn't delete · ${err.message}`, { tone: "error" }); }
      });
      const keep = e.is_saved ? null : h("button", { type: "button", class: "c-btn filled sm" }, "Save");
      keep?.addEventListener("click", async () => {
        keep.disabled = true; keep.textContent = "Saving…";
        try { await postJSON("/api/ensemble/save", { ensemble_id: e.id }); toast(`Saved ${e.name}`); loadSaved(); }
        catch (err) { keep.disabled = false; keep.textContent = "Save"; toast(`Couldn't save · ${err.message}`, { tone: "error" }); }
      });
      const n = new Set([...(e.models || []), ...(e.state_models || []), ...(e.national_models || [])]).size;
      return h("div", { class: "mo-ens" },
        h("div", { class: "mo-ens-text" },
          h("span", { class: "mo-ens-name" }, e.name),
          h("span", { class: "mo-src-meta" }, [e.method, `${n} members`, e.spatial_split ? "split" : null, e.is_saved ? "on disk" : "this session"].filter(Boolean).join(" · "))),
        keep, del);
    };
    saved.replaceChildren(h("div", { class: "c-section" }, h("span", { class: "c-section-title" }, h("span", null, "Saved"), h("span", { class: "c-section-count" }, String(list.length)))), ...list.map(row));
    layer.place();
  }
}
