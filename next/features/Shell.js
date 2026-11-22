/* The page: the full-viewport chart view, the fixed bubbles
 * over it (Models, Location, Target top left; theme top right), the global keys, the theme, and the
 * loading and error states.
 *
 * The fixed bubbles stay on screen when the page scrolls, so they are glass in backdrop mode; the chart's
 * own bubbles belong to the view (FanChart). The pickers are loaded on first use. */
import { h, on, storage } from "../lib/dom.js";
import { glass } from "../ui/glass.js";
import { activeLayer, openMenu, tooltip } from "../ui/floating.js";
import { pill, icon, timeKeys } from "../ui/controls.js";
import { seriesColor } from "../chart/layout.js";
import { FanChart } from "./FanChart.js";
import { loadGlobe } from "../lib/api.js";
import { openTargetMenu } from "./TargetMenu.js";
import { targetDimSpecs, defaultDims, isCategoricalTarget } from "./url.js";
import { mountSections } from "../sections/index.js";
import { mountBriefing } from "./BriefingView.js";
import { buildBriefingHash, parseBriefingHash } from "./briefing/model.js";

const pickers = {
  models: () => import("./ModelPicker.js").then((m) => m.openModelPicker),
  location: () => import("./LocationPicker.js").then((m) => m.openLocationPicker),
};

const TEXT_FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/**
 * Builds the page in `root` and creates the chart (ctx.chart).
 * @param {HTMLElement} root
 * @param {{ manifest: import("../lib/api.js").Manifest, store: object, chart: object | null }} ctx
 * @returns {{ view: HTMLElement, destroy(): void }}
 */
export function mountShell(root, ctx, { pickLocation = false } = {}) {
  const { manifest, store } = ctx;
  const doc = document.documentElement;
  root.classList.add("app");
  const view = h("section", { id: "view", class: "app-view", "aria-label": "Forecast chart" });
  const pmfHost = h("section", { class: "app-pmf", hidden: true, "aria-label": "Categorical forecast" });
  const zone = (z) => h("div", { class: "c-zone", "data-zone": z });
  const tl = zone("tl"), tr = zone("tr");
  const fixed = h("div", { class: "c-chrome app-fixed" }, tl, tr);
  root.append(view, pmfHost, fixed);

  /* ---------- fixed bubbles ---------- */
  // labels are filled in below (a pill only gets a label element when it starts with text)
  const backBtn = pill({ label: "← Chart", className: "app-globe-back" });
  const modelsBtn = pill({ label: "Models", dots: [], chevron: true, className: "app-models" });
  const placeBtn = pill({ label: "Location", chevron: true, className: "app-place" });
  const showTargetBtn = (ctx.catalog?.targets?.length || 0) > 1 || manifest.targets.length > 1;
  const targetBtn = showTargetBtn ? pill({ label: "Target", chevron: true, className: "app-target" }) : null;
  const briefingBtn = pill({ label: "Briefing", className: "app-briefing-btn" });
  const themeBtn = pill({ icon: icon.theme, ariaLabel: "Light or dark", className: "app-theme" });
  for (const b of [modelsBtn, placeBtn, targetBtn]) b?.setAttribute("aria-haspopup", b === targetBtn ? "menu" : "dialog");
  tl.append(...[backBtn, modelsBtn, placeBtn, targetBtn, briefingBtn].filter(Boolean));
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
    const locId = store.get().location;
    const loc = locId ? manifest.locationById.get(locId) : null;
    placeBtn.querySelector(".c-pill-label").textContent = loc ? (loc.name ?? locId) : "Choose location";
    placeBtn.setAttribute("aria-label", loc ? `Location: ${loc.name ?? locId}` : "Choose location");
  };
  const renderTarget = () => {
    if (!targetBtn) return;
    const t = manifest.targetById.get(store.get().target);
    let text = t?.short || t?.label || store.get().target;
    const catTargets = ctx.catalog?.targets || [];
    const multiPathogen = new Set(catTargets.map((x) => x.pathogen)).size > 1;
    if (multiPathogen && !/\b(flu|influenza|covid|sars|rsv|ili|ari)\b/i.test(text)) {
      const catT = catTargets.find((x) => x.hub_id === manifest.hub_id && x.target_id === t?.id);
      if (catT?.pathogen_label) text = `${catT.pathogen_label} · ${text}`;
    }
    targetBtn.querySelector(".c-pill-label").textContent = text;
    targetBtn.setAttribute("aria-label", `Target: ${t?.label ?? store.get().target}`);
  };
  renderModels(); renderPlace(); renderTarget();
  const glasses = [modelsBtn, placeBtn, targetBtn, briefingBtn, themeBtn].filter(Boolean).map((b) => glass(b));
  const [gModels, gPlace, gTarget] = glasses;
  const gBack = glass(backBtn);
  glasses.push(gBack);

  const dimPills = [];
  const dimGlasses = [];
  function syncDimLabels() {
    const s = store.get();
    const specs = targetDimSpecs(manifest.targetById.get(s.target));
    const defD = defaultDims(manifest, s.target);
    specs.forEach((spec, idx) => {
      const btn = dimPills[idx];
      if (!btn) return;
      const cur = s.dims?.[spec.name] ?? defD[spec.name] ?? spec.values[0];
      const lbl = btn.querySelector(".c-pill-label");
      if (lbl && lbl.textContent !== String(cur)) lbl.textContent = String(cur);
      btn.setAttribute("aria-label", `${spec.label}: ${cur}`);
      dimGlasses[idx]?.update();
    });
  }
  function renderDims() {
    dimGlasses.splice(0).forEach((g) => g.destroy());
    dimPills.splice(0).forEach((b) => b.remove());
    const s = store.get();
    const specs = targetDimSpecs(manifest.targetById.get(s.target));
    if (!specs.length) return;
    const defD = defaultDims(manifest, s.target);
    for (const spec of specs) {
      const cur = s.dims?.[spec.name] ?? defD[spec.name] ?? spec.values[0];
      const btn = pill({ label: String(cur), chevron: true, className: "app-dim" });
      btn.setAttribute("aria-haspopup", "menu");
      btn.setAttribute("aria-label", `${spec.label}: ${cur}`);
      btn.addEventListener("click", () => {
        const nowCur = String(store.get().dims?.[spec.name] ?? defD[spec.name] ?? cur);
        openMenu(btn, {
          label: spec.label,
          placement: "bottom-start",
          items: spec.values.map((val) => ({
            label: val,
            value: val,
            checked: val === nowCur,
            onSelect: (v) => store.set({ dims: { ...(store.get().dims || {}), [spec.name]: v } }),
          })),
        });
      });
      tl.append(btn);
      dimPills.push(btn);
      dimGlasses.push(glass(btn));
    }
  }
  renderDims();

  let sections = null;
  const syncSectionVis = () => {
    const s = store.get();
    const cat = isCategoricalTarget(manifest.targetById.get(s.target));
    if (sections?.el) sections.el.hidden = cat || !s.location;
  };

  const offs = [
    store.select(["sel"], () => { renderModels(); gModels.update(); }),
    store.select(["location"], () => { renderPlace(); gPlace.update(); syncSectionVis(); }),
    store.select(["target"], () => { renderTarget(); if (targetBtn) gTarget.update(); renderDims(); syncTargetMode(); }),
    store.select(["dims"], () => syncDimLabels()),
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

  /* ---------- the chart, categorical PMF, & Globe ---------- */
  let readyDone = false;
  function markReady() {
    if (readyDone) return;
    readyDone = true;
    root.classList.add("is-ready");
    progress.classList.add("is-done");
    setTimeout(() => progress.remove(), 600);
    // the pickers are needed on first click: fetch them while nothing else is happening
    (window.requestIdleCallback ?? setTimeout)(() => { pickers.models().catch(() => {}); pickers.location().catch(() => {}); loadGlobe().catch(() => {}); });
  }

  const chart = new FanChart(view, ctx, {
    onReady: markReady,
    onError: showError,
    onInset: (px) => {
      root.classList.toggle("is-inset", px > 0);
      root.style.setProperty("--inset-goal", `${px}px`);
    },
  });
  ctx.chart = chart;
  // model pages: data-model-sheet="<id>" anywhere opens the sheet; #model/<id> opens it on load and on change
  const sheet = () => import("./ModelSheet.js");
  sheet().then((m) => { m.installModelLinks(ctx); const id = m.modelHash(); if (id) m.openModel(id, ctx); }).catch(() => {});
  sections = mountSections(root, ctx);
  syncSectionVis();

  let pmfInst = null;
  let pmfLoadToken = 0;
  function syncTargetMode() {
    const s = store.get();
    const cat = isCategoricalTarget(manifest.targetById.get(s.target));
    view.hidden = cat;
    pmfHost.hidden = !cat;
    syncSectionVis();
    if (cat) {
      if (pmfInst) return;
      const tok = ++pmfLoadToken;
      import("./PmfView.js").then((m) => {
        if (gone || tok !== pmfLoadToken || !isCategoricalTarget(manifest.targetById.get(store.get().target))) return;
        pmfInst = m.mountPmfView(pmfHost, { manifest, store, onReady: markReady });
      }).catch((err) => console.error("viz: PMF view could not load", err));
    } else {
      pmfLoadToken++;
      pmfInst?.destroy();
      pmfInst = null;
      chart.request();
    }
  }

  let globeOpen = false;
  let globeHost = null;
  let globeInst = null;
  let globeToken = 0;
  let prevBodyOverflow = "";
  function setGlobeOpen(open, updateHash = true) {
    const want = !!open;
    if (want === globeOpen) return;
    if (want && briefingOpen) setBriefingOpen(false, null, false);
    globeOpen = want;
    root.classList.toggle("is-globe-open", want);
    if (want) {
      prevBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      markReady();
      gBack.update();
      globeHost = h("section", { class: "app-globe", "aria-label": "Globe" });
      root.append(globeHost);
      const tok = ++globeToken;
      import("./GlobeView.js").then((m) => {
        if (gone || !globeOpen || tok !== globeToken || !globeHost) return;
        globeInst = m.mountGlobeView(globeHost, { ...ctx, onClose: () => setGlobeOpen(false) });
      }).catch((err) => {
        console.error("viz: Globe could not load", err);
        setGlobeOpen(false);
      });
      if (updateHash && location.hash !== "#globe") {
        history.replaceState(history.state, "", `${location.pathname}${location.search}#globe`);
      }
    } else {
      globeToken++;
      globeInst?.destroy();
      globeInst = null;
      globeHost?.remove();
      globeHost = null;
      document.body.style.overflow = prevBodyOverflow;
      gModels.update(); gPlace.update(); gTarget?.update();
      dimGlasses.forEach((g) => g.update());
      if (updateHash && location.hash === "#globe") {
        history.replaceState(history.state, "", `${location.pathname}${location.search}`);
      }
      chart.request();
    }
  }
  backBtn.addEventListener("click", () => {
    if (briefingOpen) setBriefingOpen(false);
    if (globeOpen) setGlobeOpen(false);
  });
  ctx.openGlobe = () => setGlobeOpen(true);
  ctx.closeGlobe = () => setGlobeOpen(false);

  function currentPlaceKeyForBriefing() {
    const loc = store?.get?.()?.location;
    if (!loc || !ctx.catalog?.places) return loc || null;
    const hubId = manifest?.hub_id;
    for (const p of Object.values(ctx.catalog.places)) {
      if (p.key === loc) return p.key;
      if ((p.hubs || []).some((h) => (!hubId || h.hub_id === hubId) && h.location_id === loc)) return p.key;
    }
    return loc;
  }

  let briefingOpen = false;
  let briefingHost = null;
  let briefingInst = null;
  let prevBriefingOverflow = "";
  function setBriefingOpen(open, placeKey = null, updateHash = true) {
    const want = !!open;
    if (want && globeOpen) setGlobeOpen(false, false);
    if (want && briefingOpen) {
      if (placeKey && briefingInst) briefingInst.loadPlace(placeKey);
      return;
    }
    if (!want && !briefingOpen) return;
    briefingOpen = want;
    if (want) {
      prevBriefingOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      markReady();
      gBack.update();
      root.classList.add("is-briefing-open");
      if (!briefingHost) {
        briefingHost = h("section", { class: "app-briefing", "aria-label": "Briefing" });
        root.append(briefingHost);
      }
      if (!briefingInst) {
        briefingInst = mountBriefing(briefingHost, ctx, {
          placeKey,
          onPlaceChange: (k) => {
            if (!briefingOpen) return;
            const targetHash = buildBriefingHash(k);
            if (location.hash !== targetHash) {
              history.replaceState(history.state, "", `${location.pathname}${location.search}${targetHash}`);
            }
          },
          onOpenChart: (sig) => {
            setBriefingOpen(false, null, true);
            ctx.switchContext?.({ hub: sig.hub_id, target: sig.target_id, location: sig.location_id, date: sig.ref_date });
          },
          onOpenScores: (sig) => {
            setBriefingOpen(false, null, true);
            const p = ctx.switchContext?.({ hub: sig.hub_id, target: sig.target_id, location: sig.location_id, date: sig.ref_date });
            Promise.resolve(p).then(() => {
              setTimeout(() => document.querySelector(".app-sections")?.scrollIntoView({ behavior: "smooth" }), 140);
            });
          },
          onOpenGlobe: () => setGlobeOpen(true),
        });
      } else if (placeKey) {
        briefingInst.loadPlace(placeKey);
      }
      if (updateHash) {
        const targetHash = buildBriefingHash(placeKey);
        if (location.hash !== targetHash) {
          history.replaceState(history.state, "", `${location.pathname}${location.search}${targetHash}`);
        }
      }
    } else {
      root.classList.remove("is-briefing-open");
      document.body.style.overflow = prevBriefingOverflow;
      briefingInst?.destroy?.();
      briefingInst = null;
      briefingHost?.remove();
      briefingHost = null;
      glasses.forEach((g) => g.update());
      dimGlasses.forEach((g) => g.update());
      if (updateHash && location.hash.startsWith("#briefing")) {
        history.replaceState(history.state, "", `${location.pathname}${location.search}`);
      }
      chart.request();
    }
  }
  briefingBtn.addEventListener("click", () => setBriefingOpen(true, currentPlaceKeyForBriefing(), true));
  ctx.openBriefing = (pk = null) => setBriefingOpen(true, pk ?? currentPlaceKeyForBriefing(), true);
  ctx.closeBriefing = () => setBriefingOpen(false);

  // ⋯ bubble (hubs, warnings, the Guide): loaded when idle; the page works without it
  let more = null, gone = false;
  import("./More.js").then((m) => { if (!gone) more = m.mountMore(tr, ctx); }).catch(() => {});
  syncTargetMode();
  if (pickLocation) {
    markReady();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!gone && !store.get().location && !globeOpen && !briefingOpen) openPicker("location", placeBtn);
    }));
  }

  // The chart's own bubbles (bottom row, note, recenter) scroll with the chart; once that bottom row
  // reaches the fixed top bubbles they fade out instead of piling onto them. An observer, not a scroll
  // handler: nothing runs while scrolling.
  const tuckAt = Math.round(tl.getBoundingClientRect().bottom + 8);
  const tuck = new IntersectionObserver(([e]) => {
    root.classList.toggle("is-tucked", !e.isIntersecting && e.boundingClientRect.top < tuckAt);
  }, { rootMargin: `-${tuckAt}px 0px 0px 0px` });
  if (chart.bubbles?.zones?.bc) tuck.observe(chart.bubbles.zones.bc);
  else { const once = setInterval(() => { if (chart.bubbles?.zones?.bc) { tuck.observe(chart.bubbles.zones.bc); clearInterval(once); } }, 200); offs.push(() => clearInterval(once)); }
  offs.push(() => tuck.disconnect());

  // the chart's plot starts under the fixed top bubbles
  const measureTop = () => chart.setTop(Math.max(tl.getBoundingClientRect().bottom, tr.getBoundingClientRect().bottom));
  const ro = new ResizeObserver(measureTop);
  ro.observe(tl); ro.observe(tr);
  measureTop();

  /* ---------- theme and keys ---------- */
  function toggleTheme() { store.set({ theme: store.get().theme === "light" ? "dark" : "light" }); }

  const stopTime = timeKeys((dir) => chart.step(dir), {
    active: () => { if (globeOpen || briefingOpen) return false; const l = activeLayer(); return !l || l.panel.hasAttribute("data-time-keys"); },
  });
  offs.push(on(window, "hashchange", () => {
    if (location.hash === "#globe") { setGlobeOpen(true, false); return; }
    const bh = parseBriefingHash(location.hash);
    if (bh.active) { setBriefingOpen(true, bh.placeKey, false); return; }
    if (globeOpen && !location.hash) setGlobeOpen(false, false);
    if (briefingOpen && !location.hash) setBriefingOpen(false, null, false);
    sheet().then((m) => { const id = m.modelHash(); if (id) m.openModel(id, ctx); });
  }));
  const initBriefing = parseBriefingHash(location.hash);
  if (location.hash === "#globe") setGlobeOpen(true, false);
  else if (initBriefing.active) setBriefingOpen(true, initBriefing.placeKey, false);
  offs.push(stopTime, on(document, "keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const layer = activeLayer();
    // Escape: an open layer closes itself first (it stops the event), then Globe/Briefing, then focus.
    if (e.key === "Escape") {
      if (!layer && briefingOpen) { e.preventDefault(); setBriefingOpen(false); return; }
      if (!layer && globeOpen) { e.preventDefault(); setGlobeOpen(false); return; }
      if (!layer && store.get().focus && !e.target.closest?.(TEXT_FIELD)) { e.preventDefault(); chart.clearFocus(); }
      return;
    }
    if (globeOpen || briefingOpen || layer || e.target.closest?.(TEXT_FIELD)) return;
    switch (e.key) {
      case "=": case "+": chart.zoom(1); break;
      case "-": chart.zoom(-1); break;
      case "0": chart.zoom(0); break;
      case "/": e.preventDefault(); openPicker("models", modelsBtn); break;
      case "b": case "B": e.preventDefault(); ctx.openBriefing?.(); break;
      case "t": case "T": toggleTheme(); break;
      default: return;
    }
  }), () => ro.disconnect());

  return {
    view,
    destroy() {
      gone = true;
      pmfLoadToken++;
      pmfInst?.destroy();
      if (globeOpen) document.body.style.overflow = prevBodyOverflow;
      if (briefingOpen) document.body.style.overflow = prevBriefingOverflow;
      briefingInst?.destroy?.();
      briefingHost?.remove();
      globeToken++;
      globeInst?.destroy();
      more?.destroy();
      offs.forEach((off) => off());
      sections.destroy();
      chart.destroy();
      dimGlasses.forEach((g) => g.destroy());
      glasses.forEach((g) => g.destroy());
      pmfHost.remove();
      globeHost?.remove();
      view.remove();
      fixed.remove();
      root.classList.remove("is-inset", "is-tucked", "is-globe-open", "is-ready");
      root.style.removeProperty("--inset-goal");
    },
  };
}

/** The theme to start with: stored, else dark (DECISIONS #12). */
export const storedTheme = () => (storage.get("viz.theme") === "light" ? "light" : "dark");
