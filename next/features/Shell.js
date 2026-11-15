/* The page (design/fan-chart.md, "What is on screen"): the full-viewport chart view, the fixed bubbles
 * over it (Models, Location, Target top left; theme top right), the global keys, the theme, and the
 * loading and error states.
 *
 * The fixed bubbles stay on screen when the page scrolls, so they are glass in backdrop mode; the chart's
 * own bubbles belong to the view (FanChart). The pickers are loaded on first use. */
import { h, on, storage } from "../lib/dom.js";
import { glass } from "../ui/glass.js";
import { activeLayer, tooltip } from "../ui/floating.js";
import { pill, icon, timeKeys } from "../ui/controls.js";
import { seriesColor } from "../chart/layout.js";
import { FanChart } from "./FanChart.js";
import { openTargetMenu } from "./TargetMenu.js";
import { mountSections } from "../sections/index.js";

const pickers = {
  models: () => import("./ModelPicker.js").then((m) => m.openModelPicker),
  location: () => import("./LocationPicker.js").then((m) => m.openLocationPicker),
};

/* The attic: a strip of page above the chart, scrolled out of view, so scrolling up past the chart shows
 * the chart's shade carrying on (and a line of nonsense) instead of a hard edge. Browsers draw nothing
 * above the page itself during the overscroll bounce, so this is real page that springs back. */
const ATTIC_LINES = [
  "Nothing up here but last season's flu",
  "Forecasts grow down, not up",
  "You found the attic",
  "The peak is below. Probably.",
  "Week 54 is up here somewhere",
  "Quantile 0.999 lives here",
  "No horizons beyond this point",
  "This space intentionally left uncertain",
];

const TEXT_FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/**
 * Builds the page in `root` and creates the chart (ctx.chart).
 * @param {HTMLElement} root
 * @param {{ manifest: import("../lib/api.js").Manifest, store: object, chart: object | null }} ctx
 * @returns {{ view: HTMLElement, destroy(): void }}
 */
export function mountShell(root, ctx) {
  const { manifest, store } = ctx;
  const doc = document.documentElement;
  root.classList.add("app");
  const atticShade = h("div", { class: "app-attic-shade" });
  const attic = h("div", { class: "app-attic", "aria-hidden": "true" }, atticShade,
    h("p", { class: "app-attic-line" }, ATTIC_LINES[Math.floor(Math.random() * ATTIC_LINES.length)]));
  root.before(attic);
  const atticH = () => attic.offsetHeight;
  const view = h("section", { id: "view", class: "app-view", "aria-label": "Forecast chart" });
  const zone = (z) => h("div", { class: "c-zone", "data-zone": z });
  const tl = zone("tl"), tr = zone("tr");
  const fixed = h("div", { class: "c-chrome app-fixed" }, tl, tr);
  root.append(view, fixed);

  /* ---------- fixed bubbles ---------- */
  // labels are filled in below (a pill only gets a label element when it starts with text)
  const modelsBtn = pill({ label: "Models", dots: [], chevron: true, className: "app-models" });
  const placeBtn = pill({ label: "Location", chevron: true, className: "app-place" });
  const targetBtn = manifest.targets.length > 1 ? pill({ label: "Target", chevron: true, className: "app-target" }) : null;
  const themeBtn = pill({ icon: icon.theme, ariaLabel: "Light or dark", className: "app-theme" });
  for (const b of [modelsBtn, placeBtn, targetBtn]) b?.setAttribute("aria-haspopup", b === targetBtn ? "menu" : "dialog");
  tl.append(...[modelsBtn, placeBtn, targetBtn].filter(Boolean));
  tr.append(themeBtn);
  tooltip(themeBtn, "Light or dark", { placement: "bottom" });

  const openPicker = (name, anchor) => pickers[name]().then((open) => open(anchor, ctx)).catch((err) => console.error(`viz: the ${name} picker could not open`, err));
  modelsBtn.addEventListener("click", () => openPicker("models", modelsBtn));
  placeBtn.addEventListener("click", () => openPicker("location", placeBtn));
  targetBtn?.addEventListener("click", () => openTargetMenu(targetBtn, ctx));
  themeBtn.addEventListener("click", () => toggleTheme());

  const renderModels = () => {
    const sel = store.get().sel, n = sel.selected.length;
    const charted = [...sel.charted].sort((a, b) => a.slot - b.slot);
    const dots = modelsBtn.querySelector(".c-dots");
    dots.replaceChildren(...charted.map((c) => h("i", { style: { background: seriesColor(c.slot) } })));
    dots.hidden = !charted.length;
    modelsBtn.querySelector(".c-pill-label").textContent = n ? `${n} model${n === 1 ? "" : "s"}` : "Choose models";
    modelsBtn.setAttribute("aria-label", n ? `Models: ${n} selected, ${charted.length} on the chart` : "Choose models");
  };
  const renderPlace = () => {
    const loc = manifest.locationById.get(store.get().location);
    placeBtn.querySelector(".c-pill-label").textContent = loc?.name ?? store.get().location;
    placeBtn.setAttribute("aria-label", `Location: ${loc?.name ?? store.get().location}`);
  };
  const renderTarget = () => {
    if (!targetBtn) return;
    const t = manifest.targetById.get(store.get().target);
    targetBtn.querySelector(".c-pill-label").textContent = t?.short || t?.label || store.get().target;
    targetBtn.setAttribute("aria-label", `Target: ${t?.label ?? store.get().target}`);
  };
  renderModels(); renderPlace(); renderTarget();
  const glasses = [modelsBtn, placeBtn, targetBtn, themeBtn].filter(Boolean).map((b) => glass(b));
  const [gModels, gPlace, gTarget] = glasses;
  const offs = [
    store.select(["sel"], () => { renderModels(); gModels.update(); }),
    store.select(["location"], () => { renderPlace(); gPlace.update(); }),
    store.select(["target"], () => { renderTarget(); if (targetBtn) gTarget.update(); }),
    store.select(["theme"], (s) => { doc.dataset.theme = s.theme; }),
  ];
  doc.dataset.theme = store.get().theme;

  /* ---------- loading and errors ---------- */
  const progress = document.querySelector(".app-progress") || document.body.appendChild(h("div", { class: "app-progress", role: "progressbar", "aria-label": "Loading" }));
  let error = null;
  const showError = (retry) => {
    error?.remove();
    error = null;
    if (!retry) return;
    progress.classList.add("is-done");
    error = h("div", { class: "app-error", role: "alert" },
      h("span", null, "Can't reach viz · "),
      h("button", { type: "button", class: "c-link", onclick: () => { error?.remove(); error = null; if (!root.classList.contains("is-ready")) progress.classList.remove("is-done"); retry(); } }, "Retry"));
    view.append(error);
  };

  /* ---------- the chart ---------- */
  const chart = new FanChart(view, ctx, {
    onReady: () => {
      root.classList.add("is-ready");
      progress.classList.add("is-done");
      setTimeout(() => progress.remove(), 600);
      // the pickers are needed on first click: fetch them while nothing else is happening
      (window.requestIdleCallback ?? setTimeout)(() => { pickers.models().catch(() => {}); pickers.location().catch(() => {}); });
    },
    onError: showError,
    onInset: (px) => {
      root.classList.toggle("is-inset", px > 0);
      root.style.setProperty("--inset-goal", `${px}px`);
    },
  });
  ctx.chart = chart;
  chart.attic = atticShade; // the chart moves the attic's shade to its own shade edge (ChartBubbles.frame)
  const sections = mountSections(root, ctx);
  // ⋯ bubble (hubs, warnings, the Guide): loaded when idle; the page works without it
  let more = null, gone = false;
  import("./More.js").then((m) => { if (!gone) more = m.mountMore(tr, ctx); }).catch(() => {});

  // the chart's plot starts under the fixed top bubbles
  const measureTop = () => chart.setTop(Math.max(tl.getBoundingClientRect().bottom, tr.getBoundingClientRect().bottom));
  const ro = new ResizeObserver(measureTop);
  ro.observe(tl); ro.observe(tr);
  measureTop();

  /* ---------- theme and keys ---------- */
  function toggleTheme() { store.set({ theme: store.get().theme === "light" ? "dark" : "light" }); }

  const stopTime = timeKeys((dir) => chart.step(dir), {
    active: () => { const l = activeLayer(); return !l || l.panel.hasAttribute("data-time-keys"); },
  });
  // open on the chart, not the attic (unless the browser restored a scroll position further down)
  if (scrollY < atticH()) scrollTo(0, atticH());

  // let go in the attic: back down to the chart
  let atticTimer = 0;
  offs.push(on(window, "scroll", () => {
    clearTimeout(atticTimer);
    atticTimer = setTimeout(() => {
      if (scrollY < atticH() - 1) scrollTo({ top: atticH(), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }, 140);
  }, { passive: true }), () => { clearTimeout(atticTimer); attic.remove(); });

  offs.push(stopTime, on(document, "keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const layer = activeLayer();
    // Escape: an open layer closes itself first (it stops the event), then the focus clears. Text
    // fields keep theirs.
    if (e.key === "Escape") {
      if (!layer && store.get().focus && !e.target.closest?.(TEXT_FIELD)) { e.preventDefault(); chart.clearFocus(); }
      return;
    }
    if (layer || e.target.closest?.(TEXT_FIELD)) return;
    switch (e.key) {
      case "=": case "+": chart.zoom(1); break;
      case "-": chart.zoom(-1); break;
      case "0": chart.zoom(0); break;
      case "/": e.preventDefault(); openPicker("models", modelsBtn); break;
      case "t": case "T": toggleTheme(); break;
      default: return;
    }
  }), () => ro.disconnect());

  return {
    view,
    destroy() { gone = true; more?.destroy(); offs.forEach((off) => off()); sections.destroy(); chart.destroy(); glasses.forEach((g) => g.destroy()); view.remove(); fixed.remove(); },
  };
}

/** The theme to start with: stored, else dark (DECISIONS #12). */
export const storedTheme = () => (storage.get("viz.theme") === "light" ? "light" : "dark");
