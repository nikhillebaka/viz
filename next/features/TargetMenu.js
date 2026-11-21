/* Unified Target menu: groups every target across all active hubs by pathogen and place.
 * Targets available for the active place (or its parent state) appear first grouped by pathogen;
 * targets in other connected geographies appear below a divider. Choosing a target from another
 * hub switches hubs seamlessly in place via `ctx.switchContext`. */
import { openMenu } from "../ui/floating.js";
import { defaultDims } from "./url.js";

/**
 * Build pure grouped target-menu descriptors for tests and `openTargetMenu`.
 * @param {object | null} catalog  response of GET /api/next/catalog
 * @param {import("../lib/api.js").Manifest} manifest
 * @param {string} currentLocationId
 * @param {string | null} activeHubId
 * @param {string} currentTargetId
 * @returns {Array<{ type: "header", label: string } | { type: "sep" } | { type: "item", key: string, hubId: string | null, targetId: string, locationId: string | null, label: string, shortcut?: string, checked: boolean }>}
 */
export function buildTargetMenuGroups(catalog, manifest, currentLocationId, activeHubId, currentTargetId) {
  const catTargets = catalog?.targets;
  if (!Array.isArray(catTargets) || !catTargets.length) {
    return (manifest?.targets || []).map((t) => ({
      type: "item",
      key: `${activeHubId || ""}::${t.id}`,
      hubId: activeHubId,
      targetId: t.id,
      locationId: currentLocationId,
      label: t.label || t.short || t.id,
      checked: t.id === currentTargetId,
    }));
  }

  const places = catalog.places || {};
  const hubById = new Map((catalog.hubs || []).map((h) => [h.id, h]));

  let curPlace = null;
  for (const p of Object.values(places)) {
    if (p.hubs?.some((h) => h.hub_id === activeHubId && h.location_id === currentLocationId)) {
      curPlace = p;
      break;
    }
  }
  if (!curPlace && currentLocationId && places[currentLocationId]) {
    curPlace = places[currentLocationId];
  }
  const parentPlace = curPlace?.parent_key ? places[curPlace.parent_key] || null : null;

  const directLocByHub = new Map((curPlace?.hubs || []).map((h) => [h.hub_id, h.location_id]));
  const parentLocByHub = new Map((parentPlace?.hubs || []).map((h) => [h.hub_id, h.location_id]));

  const inPlace = [];
  const otherPlace = [];
  for (const t of catTargets) {
    const directLoc = directLocByHub.get(t.hub_id);
    const pLoc = !directLoc ? parentLocByHub.get(t.hub_id) : null;
    if (directLoc || pLoc) {
      inPlace.push({
        t,
        locationId: directLoc || pLoc,
        viaParent: !directLoc && !!pLoc,
      });
    } else {
      otherPlace.push({
        t,
        locationId: hubById.get(t.hub_id)?.default_location || null,
        viaParent: false,
      });
    }
  }

  // Disambiguate when multiple hubs share the same pathogen (e.g. FluSight + MetroCast)
  const hubsPerPathogen = new Map();
  for (const t of catTargets) {
    if (!hubsPerPathogen.has(t.pathogen)) hubsPerPathogen.set(t.pathogen, new Set());
    hubsPerPathogen.get(t.pathogen).add(t.hub_id);
  }

  const formatEntry = ({ t, locationId, viaParent }) => {
    const multiHub = (hubsPerPathogen.get(t.pathogen)?.size || 0) > 1;
    let shortcut = viaParent && parentPlace?.abbr ? parentPlace.abbr : undefined;
    if (!shortcut && multiHub && t.hub_short) {
      shortcut = t.hub_short;
    }
    return {
      type: "item",
      key: t.key,
      hubId: t.hub_id,
      targetId: t.target_id,
      locationId,
      label: t.label || t.short || t.target_id,
      shortcut,
      checked: t.hub_id === activeHubId && t.target_id === currentTargetId,
    };
  };

  const out = [];
  if (inPlace.length) {
    const byPathogen = new Map();
    for (const ent of inPlace) {
      const grp = ent.t.pathogen_label || "Forecasts";
      if (!byPathogen.has(grp)) byPathogen.set(grp, []);
      byPathogen.get(grp).push(ent);
    }
    for (const [header, ents] of byPathogen) {
      out.push({ type: "header", label: header });
      for (const ent of ents) out.push(formatEntry(ent));
    }
  }

  if (otherPlace.length) {
    if (out.length) out.push({ type: "sep" });
    const byRegionPathogen = new Map();
    for (const ent of otherPlace) {
      const reg = ent.t.region_label || "Other";
      const path = ent.t.pathogen_label || "Forecasts";
      const grp = `${reg} · ${path}`;
      if (!byRegionPathogen.has(grp)) byRegionPathogen.set(grp, []);
      byRegionPathogen.get(grp).push(ent);
    }
    for (const [header, ents] of byRegionPathogen) {
      out.push({ type: "header", label: header });
      for (const ent of ents) out.push(formatEntry(ent));
    }
  }

  return out;
}

/**
 * @param {HTMLElement} anchor the Target bubble
 * @param {{ manifest: import("../lib/api.js").Manifest, store: object, catalog?: object, switchContext?: (o: object) => Promise<void> }} ctx
 * @returns {object | null} the layer, or null when this call closed it
 */
export function openTargetMenu(anchor, ctx) {
  const { manifest, store, catalog } = ctx;
  const s = store.get();
  const entries = buildTargetMenuGroups(catalog, manifest, s.location, manifest.hub_id || null, s.target);

  const items = entries.map((ent) => {
    if (ent.type === "sep") return "-";
    if (ent.type === "header") return { header: ent.label };
    return {
      label: ent.label,
      value: ent.key,
      shortcut: ent.shortcut,
      checked: ent.checked,
      onSelect: () => {
        if (!ent.hubId || ent.hubId === manifest.hub_id || !ctx.switchContext) {
          store.set({ target: ent.targetId, dims: defaultDims(manifest, ent.targetId) });
        } else {
          ctx.switchContext({ hub: ent.hubId, target: ent.targetId, location: ent.locationId });
        }
      },
    };
  });

  return openMenu(anchor, { label: "Target", placement: "bottom-start", items });
}
