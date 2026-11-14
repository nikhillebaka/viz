/* The target menu: one radio item per target the hub forecasts (its full label), the current one checked.
 * Changing target keeps everything else; models that don't forecast it simply have no data there. */
import { openMenu } from "../ui/floating.js";

/**
 * @param {HTMLElement} anchor the Target bubble
 * @param {{ manifest: import("../lib/api.js").Manifest, store: object }} ctx
 * @returns {object | null} the layer, or null when this call closed it
 */
export function openTargetMenu(anchor, { manifest, store }) {
  const cur = store.get().target;
  return openMenu(anchor, {
    label: "Target", placement: "bottom-start",
    items: manifest.targets.map((t) => ({ label: t.label || t.short || t.id, value: t.id, checked: t.id === cur, onSelect: (id) => store.set({ target: id }) })),
  });
}
