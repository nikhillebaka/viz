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
  const hubInCatalog = !activeHubId || (catalog?.hubs || []).some((h) => h.id === activeHubId);
  if (!Array.isArray(catTargets) || !catTargets.length) {
    return (manifest?.targets || [])
      .filter((t) => !t.is_categorical && (!Array.isArray(t.locations) || !currentLocationId || t.locations.includes(currentLocationId)))
      .map((t) => ({
        type: "item",
        key: `${activeHubId || ""}::${t.id}`,
        hubId: activeHubId,
        targetId: t.id,
        locationId: currentLocationId,
        label: t.label || t.short || t.id,
        checked: t.id === currentTargetId,
      }));
  }

  const activePrivateItems = !hubInCatalog
    ? (manifest?.targets || [])
      .filter((t) => !t.is_categorical && (!Array.isArray(t.locations) || !currentLocationId || t.locations.includes(currentLocationId)))
      .map((t) => ({
        type: "item",
        key: `${activeHubId}::${t.id}`,
        hubId: activeHubId,
        targetId: t.id,
        locationId: currentLocationId,
        label: t.label || t.short || t.id,
        checked: t.id === currentTargetId,
      }))
    : [];

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
  const SUBNATIONAL_LEVELS = new Set(["hsa", "metro", "borough", "region", "subnational"]);
  const canInheritParent = SUBNATIONAL_LEVELS.has(String(curPlace?.level || "").toLowerCase());
  const parentPlace = canInheritParent && curPlace?.parent_key ? places[curPlace.parent_key] || null : null;

  const targetIdsOf = (hubEntry) => {
    if (!Array.isArray(hubEntry?.targets)) return null;
    return new Set(hubEntry.targets.map((x) => (typeof x === "string" ? x : (x.target_id || x.id))).filter(Boolean));
  };

  const directHubByHub = new Map((curPlace?.hubs || []).map((h) => [h.hub_id, { loc: h.location_id, targets: targetIdsOf(h) }]));
  const parentHubByHub = new Map((parentPlace?.hubs || []).map((h) => [h.hub_id, { loc: h.location_id, targets: targetIdsOf(h) }]));

  const inPlace = [];
  const otherPlace = [];
  for (const t of catTargets) {
    if (t.is_categorical) continue;
    const direct = directHubByHub.get(t.hub_id);
    const parent = !direct ? parentHubByHub.get(t.hub_id) : null;
    const directAllowed = direct && (!direct.targets || direct.targets.has(t.target_id));
    const parentAllowed = parent && (!parent.targets || parent.targets.has(t.target_id));
    if (directAllowed) {
      inPlace.push({
        t,
        locationId: direct.loc,
        viaParent: false,
      });
    } else if (parentAllowed) {
      inPlace.push({
        t,
        locationId: parent.loc,
        viaParent: true,
      });
    } else if (!direct && !parent) {
      otherPlace.push({
        t,
        locationId: null,
        viaParent: false,
      });
    }
  }

  // Prefer active hub -> direct place match -> local provider -> highest model count when deduplicating concepts
  const entryRank = (ent) => {
    const hub = hubById.get(ent.t.hub_id);
    return (
      (ent.t.hub_id === activeHubId && ent.t.target_id === currentTargetId ? 1e7 : 0)
      + (ent.t.hub_id === activeHubId ? 1e6 : 0)
      + (!ent.viaParent ? 1e5 : 0)
      + (hub?.kind === "local" ? 1e4 : 0)
      + (hub?.model_count || 0)
    );
  };
  const dedupEntries = (list, keyOf) => {
    const best = new Map();
    for (const ent of list) {
      const k = keyOf(ent);
      const cur = best.get(k);
      if (!cur || entryRank(ent) > entryRank(cur)) best.set(k, ent);
    }
    return [...best.values()];
  };

  const uniqInPlace = dedupEntries(inPlace, (ent) => ent.t.concept_id || ent.t.key);
  const uniqOtherPlace = uniqInPlace.length
    ? []
    : dedupEntries(otherPlace, (ent) => (ent.t.concept_id ? `${ent.t.region_label || "Other"}::${ent.t.concept_id}` : ent.t.key));
  const allShown = [...uniqInPlace, ...uniqOtherPlace];

  // Disambiguate when multiple hubs share the same pathogen across remaining items
  const hubsPerPathogen = new Map();
  for (const ent of allShown) {
    const { t } = ent;
    if (!hubsPerPathogen.has(t.pathogen)) hubsPerPathogen.set(t.pathogen, new Set());
    hubsPerPathogen.get(t.pathogen).add(t.hub_id);
  }

  const formatEntry = ({ t, locationId, viaParent }) => {
    const multiHub = (hubsPerPathogen.get(t.pathogen)?.size || 0) > 1;
    let shortcut = viaParent && parentPlace?.abbr ? parentPlace.abbr : undefined;
    if (!shortcut && multiHub && t.hub_short) {
      shortcut = t.hub_short;
    }
    const label = (!t.ambiguous && t.concept_label) ? t.concept_label : (t.label || t.short || t.target_id);
    return {
      type: "item",
      key: t.key,
      hubId: t.hub_id,
      targetId: t.target_id,
      locationId,
      label,
      shortcut,
      checked: t.hub_id === activeHubId && t.target_id === currentTargetId,
    };
  };

  const out = [];
  if (activePrivateItems.length) {
    out.push({ type: "header", label: manifest?.hub || "Uploaded hub" });
    out.push(...activePrivateItems);
    if (uniqInPlace.length || uniqOtherPlace.length) out.push({ type: "sep" });
  }
  if (uniqInPlace.length) {
    const byPathogen = new Map();
    for (const ent of uniqInPlace) {
      const grp = ent.t.pathogen_label || "Forecasts";
      if (!byPathogen.has(grp)) byPathogen.set(grp, []);
      byPathogen.get(grp).push(ent);
    }
    for (const [header, ents] of byPathogen) {
      out.push({ type: "header", label: header });
      for (const ent of ents) out.push(formatEntry(ent));
    }
  }

  if (uniqOtherPlace.length) {
    if (out.length) out.push({ type: "sep" });
    const byRegionPathogen = new Map();
    for (const ent of uniqOtherPlace) {
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
