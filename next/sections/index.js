/* The page below the chart: a compact /next/ text tab rail switching one section at a time so
 * the page stays focused and uncluttered, plus conditional companion Rate change when available. */
import { h, storage } from "../lib/dom.js";
import { findRateChangeTarget } from "./rate_change/index.js";
import { hasSampleModels } from "./trajectories/model.js";

const TAB_KEY = "viz.section_tab";
const BASE_SECTIONS = [
  { id: "scores", label: "Scores" },
  { id: "heatmap", label: "Heatmap" },
  { id: "map", label: "Map" },
  { id: "peaks", label: "Peaks" },
  { id: "trajectories", label: "Trajectories", optional: true },
  { id: "rate_change", label: "Rate change", optional: true },
];

/** @returns {{ el: HTMLElement, destroy(): void }} */
export function mountSections(root, ctx) {
  const { manifest, store } = ctx;
  const wrap = h("div", { class: "app-sections" });
  const nav = h("nav", { class: "app-sec-nav", role: "tablist", "aria-label": "Sections" });
  const bodyWrap = h("div", { class: "app-sec-panels" });
  wrap.append(nav, bodyWrap);
  root.append(wrap);

  const panels = new Map();
  const tabs = new Map();
  const mounted = new Map();
  const loading = new Map();
  let gone = false;

  const isAvailable = (id) => {
    const s = store.get();
    if (manifest.targetById.get(s.target)?.is_categorical) return id === "scores";
    if (id === "rate_change") return !!findRateChangeTarget(ctx.catalog, manifest, s.target, s.location);
    if (id === "trajectories") return hasSampleModels(manifest, s.target);
    return true;
  };

  let activeId = storage.get(TAB_KEY, "scores");
  if (!BASE_SECTIONS.some((s) => s.id === activeId)) activeId = "scores";
  if (!isAvailable(activeId)) activeId = "scores";

  const ensureMounted = (id) => {
    if (mounted.has(id) || loading.has(id)) return;
    const panel = panels.get(id);
    if (!panel) return;
    const p = import(`./${id}/index.js`)
      .then((m) => {
        if (gone) return;
        panel.classList.remove("is-pending");
        const inst = m.mount(panel, ctx);
        mounted.set(id, inst);
        if (activeId === id) requestAnimationFrame(() => inst?.resize?.());
      })
      .catch((err) => {
        if (gone) return;
        console.error(`viz: the ${id} section could not load`, err);
        panel.replaceChildren(h("p", { class: "app-section-error" }, `Can't show ${panel.getAttribute("aria-label").toLowerCase()}`));
      })
      .finally(() => loading.delete(id));
    loading.set(id, p);
  };

  const syncTabs = () => {
    if (!isAvailable(activeId)) {
      activeId = "scores";
      ensureMounted(activeId);
    }
    for (const s of BASE_SECTIONS) {
      const btn = tabs.get(s.id);
      const panel = panels.get(s.id);
      const avail = !s.optional || isAvailable(s.id);
      const isActive = avail && s.id === activeId;
      btn.hidden = !avail;
      btn.setAttribute("aria-selected", String(isActive));
      btn.classList.toggle("is-active", isActive);
      panel.hidden = !isActive;
    }
  };

  const selectTab = (id) => {
    if (!BASE_SECTIONS.some((s) => s.id === id) || !isAvailable(id)) return;
    activeId = id;
    storage.set(TAB_KEY, id);
    syncTabs();
    ensureMounted(id);
    const inst = mounted.get(id);
    requestAnimationFrame(() => inst?.resize?.());
  };

  for (const s of BASE_SECTIONS) {
    const tabId = `tab-${s.id}`;
    const btn = h("button", {
      type: "button",
      id: tabId,
      role: "tab",
      class: "app-sec-tab",
      "aria-controls": s.id,
      "aria-selected": "false",
      onclick: () => selectTab(s.id),
    }, s.label);
    const panel = h("section", {
      class: "app-section is-pending",
      id: s.id,
      role: "tabpanel",
      "aria-labelledby": tabId,
      "data-section": s.id,
      "aria-label": s.label,
      hidden: true,
    });
    nav.append(btn);
    bodyWrap.append(panel);
    tabs.set(s.id, btn);
    panels.set(s.id, panel);
  }

  syncTabs();

  // Mount the active panel lazily once sections near the viewport, matching initial load budget
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    if (!gone) ensureMounted(activeId);
  }, { rootMargin: "600px 0px" });
  io.observe(wrap);

  const offStore = store.select(["target", "location"], () => {
    syncTabs();
    if (activeId === "rate_change") mounted.get("rate_change")?.update?.();
  });

  return {
    el: wrap,
    select: selectTab,
    destroy() {
      gone = true;
      io.disconnect();
      offStore();
      mounted.forEach((l) => l?.destroy?.());
      mounted.clear();
      wrap.remove();
    },
  };
}
