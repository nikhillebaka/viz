/* Companion categorical Rate change section (e.g. weekly hospital admissions rate change).
 * Sits alongside Scores · Heatmap · Map · Peaks in the compact section rail rather than polluting the Target menu. */
import { h } from "../../lib/dom.js";
import { mountPmfView } from "../../features/PmfView.js";

/**
 * Resolve the companion categorical target matching the active pathogen and place, if available.
 * @param {object | null} catalog
 * @param {import("../../lib/api.js").Manifest} manifest
 * @param {string | null} activeTargetId
 * @param {string | null} activeLocationId
 * @returns {{ hubId: string | null, targetId: string, locationId: string, locationName: string, viaParent: boolean, title: string, label: string } | null}
 */
export function findRateChangeTarget(catalog, manifest, activeTargetId, activeLocationId) {
  if (!activeTargetId || !activeLocationId) return null;
  const activeHubId = manifest?.hub_id || null;
  const catTargets = catalog?.targets;

  if (Array.isArray(catTargets) && catTargets.length) {
    const activeCat = catTargets.find((t) => (t.hub_id === activeHubId || !activeHubId) && t.target_id === activeTargetId);
    const activePathogen = activeCat?.pathogen || null;
    const cands = catTargets.filter((t) => t.is_categorical && (!activePathogen || t.pathogen === activePathogen));
    if (!cands.length) return null;

    const places = catalog.places || {};
    let curPlace = null;
    for (const p of Object.values(places)) {
      if (p.hubs?.some((ent) => ent.hub_id === activeHubId && ent.location_id === activeLocationId)) {
        curPlace = p;
        break;
      }
    }
    if (!curPlace && places[activeLocationId]) curPlace = places[activeLocationId];
    const SUBNATIONAL_LEVELS = new Set(["hsa", "metro", "borough", "region", "subnational"]);
    const canInherit = SUBNATIONAL_LEVELS.has(String(curPlace?.level || "").toLowerCase());
    const parentPlace = canInherit && curPlace?.parent_key ? places[curPlace.parent_key] || null : null;
    const hubAllows = (ent, tid) => !Array.isArray(ent?.targets)
      || ent.targets.some((x) => (typeof x === "string" ? x : (x.target_id || x.id)) === tid);

    for (const cand of cands) {
      const direct = curPlace?.hubs?.find((ent) => ent.hub_id === cand.hub_id && hubAllows(ent, cand.target_id));
      if (direct) {
        return {
          hubId: cand.hub_id === activeHubId ? null : cand.hub_id,
          targetId: cand.target_id,
          locationId: direct.location_id,
          locationName: curPlace.name || direct.location_id,
          viaParent: false,
          title: "Rate change",
          label: cand.label || cand.short || cand.target_id,
        };
      }
      const via = parentPlace?.hubs?.find((ent) => ent.hub_id === cand.hub_id && hubAllows(ent, cand.target_id));
      if (via) {
        return {
          hubId: cand.hub_id === activeHubId ? null : cand.hub_id,
          targetId: cand.target_id,
          locationId: via.location_id,
          locationName: parentPlace.name || via.location_id,
          viaParent: true,
          title: "Rate change",
          label: cand.label || cand.short || cand.target_id,
        };
      }
    }
    return null;
  }

  const mCat = (manifest?.targets || []).find((t) => t.is_categorical && t.id !== activeTargetId);
  if (!mCat || !manifest?.locationById?.has(activeLocationId)) return null;
  const loc = manifest.locationById.get(activeLocationId);
  return {
    hubId: null,
    targetId: mCat.id,
    locationId: activeLocationId,
    locationName: loc?.name || activeLocationId,
    viaParent: false,
    title: "Rate change",
    label: mCat.label || mCat.short || mCat.id,
  };
}

/**
 * Mount compact categorical Rate change section into `el`.
 * @param {HTMLElement} el
 * @param {object} ctx
 * @returns {{ destroy(): void }}
 */
export function mount(el, ctx) {
  const { manifest, store } = ctx;
  const host = h("div", { class: "rc-host" });
  el.replaceChildren(host);
  const srcFor = () => {
    const s = store.get();
    return findRateChangeTarget(ctx.catalog, manifest, s.target, s.location);
  };
  const pmf = mountPmfView(host, {
    manifest,
    store,
    compact: true,
    getSource: srcFor,
  });
  return {
    resize: () => pmf.resize?.(),
    update: () => pmf.update?.(),
    destroy() {
      pmf.destroy();
      host.remove();
    },
  };
}
