import { LiquidGlass } from "./lib/glass.js";
import { loadData, fanChart, seriesVar, short } from "./lib/chart.js";
import { Segmented, Stepper, Search, StatusIsland, openMenu, openPopover, tooltip, toast, icon, timeKeys } from "./lib/controls.js";
import { sizeClass } from "./lib/position.js";

const root = document.documentElement;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
if (store.get("viz-ds-theme")) root.dataset.theme = store.get("viz-ds-theme");

const data = await loadData("data/");
const { D, DATES, DI0, ranked } = data;
const fmtLong = d3.utcFormat("%b %-d, %Y"), fmtShort = d3.utcFormat("%b %-d");
const $ = (id) => document.getElementById(id);

/* ---------- page chrome ---------- */
for (const id of ["brand", "nav", "theme"]) new LiquidGlass($(id), {});
$("theme").addEventListener("click", () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  store.set("viz-ds-theme", root.dataset.theme);
  requestAnimationFrame(() => LiquidGlass.updateAll());
});
tooltip($("theme"), "Light or dark appearance", { placement: "bottom" });
const navLinks = [...document.querySelectorAll("#nav a:not(.page)")];
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) navLinks.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#${e.target.id}`)); }), { rootMargin: "-40% 0px -55% 0px" });
document.querySelectorAll("main section").forEach((s) => io.observe(s));

/* ---------- shared model selection logic (used by the demo and the popover section) ---------- */
// Eight colors in a fixed order; a new model takes the first free color, and past eight they repeat.
// The baseline is always grey. A model keeps its color while it stays selected.
function selection(initial) {
  const s = { list: [] };
  s.has = (m) => s.list.some((x) => x.m === m);
  s.add = (m) => {
    if (s.has(m)) return;
    if (m === D.baseline) { s.list.push({ m, slot: "baseline" }); return; }
    const used = new Set(s.list.map((x) => x.slot));
    let slot = [0, 1, 2, 3, 4, 5, 6, 7].find((k) => !used.has(k));
    if (slot === undefined) slot = s.list.filter((x) => x.slot !== "baseline").length % 8;
    s.list.push({ m, slot });
  };
  s.toggle = (m) => { if (s.has(m)) s.list = s.list.filter((x) => x.m !== m); else s.add(m); };
  initial.forEach(s.add);
  return s;
}
const top = ranked.filter((m) => m !== D.baseline && data.fcPts(m, DI0));

function renderModelPill(dotsEl, labelEl, pill, sel) {
  const shown = sel.list.slice(0, 4);
  dotsEl.innerHTML = shown.map((x) => `<i style="background:${seriesVar(x.slot)}"></i>`).join("");
  const n = sel.list.length;
  labelEl.textContent = n === 0 ? "No models" : `${n} model${n === 1 ? "" : "s"}`;
  pill.setAttribute("aria-label", `Models: ${sel.list.map((x) => short(x.m)).join(", ") || "none"}. Change`);
}
function openModelPicker(anchor, sel, onChange) {
  openPopover(anchor, {
    title: "Models", width: 340,
    content: (el) => {
      el.innerHTML = `<label class="pop-search">${icon.search}<input type="search" placeholder="Search ${D.models.length} models" aria-label="Search models"></label>
        <div class="model-list" role="group" aria-label="Models"></div>
        <div class="pop-note t-small">Colors follow the order you add models and repeat after eight. The baseline is always grey.</div>`;
      const list = el.querySelector(".model-list"), input = el.querySelector("input");
      const draw = () => {
        const q = input.value.trim().toLowerCase();
        const items = [D.baseline, ...ranked.filter((m) => m !== D.baseline)].filter((m) => m.toLowerCase().includes(q));
        list.innerHTML = items.map((m) => {
          const s = sel.list.find((x) => x.m === m);
          return `<button type="button" class="model-row" role="checkbox" aria-checked="${!!s}" data-m="${m}" style="--c:${s ? seriesVar(s.slot) : "transparent"}"><i></i><span>${short(m)}</span><span class="v">${data.seasonRel.get(m)?.toFixed(2) ?? ""}</span></button>`;
        }).join("") || `<div class="c-empty t-small">No models match</div>`;
        list.querySelectorAll(".model-row").forEach((b) => b.addEventListener("click", () => { sel.toggle(b.dataset.m); onChange(); draw(); list.querySelector(`[data-m="${CSS.escape(b.dataset.m)}"]`)?.focus(); }));
      };
      input.addEventListener("input", draw);
      draw();
    },
  });
}

/* ---------- 01 placement demo ---------- */
const demo = $("demo"), chrome = $("demo-chrome"), frame = $("frame");
const G = { source: "#demo-chart-src", container: demo };
const demoSel = selection(top.slice(0, 3).concat([D.baseline]));
const demoState = { di: DI0, band: 0.95 };
let chromeTop = 70, chromeBottom = 70;
function drawDemo() {
  const compact = sizeClass(demo) === "compact";
  fanChart(d3.select("#demo-chart"), data, {
    id: "demo-chart-src", models: demoSel.list, di: demoState.di, band: demoState.band || null,
    topClear: chromeTop, pad: { t: chromeTop + 32, b: chromeBottom + 52, r: compact ? 104 : 160, l: compact ? 44 : 56 },
    domain: compact ? [new Date(+DATES[demoState.di] - 8 * 6048e5), new Date(+DATES[demoState.di] + 4 * 6048e5)] : undefined,
  });
}
// the chrome tells the chart (and toasts) how much room it occupies
let mRaf = 0;
const measureChrome = () => {
  cancelAnimationFrame(mRaf);
  mRaf = requestAnimationFrame(() => {
    const sr = demo.getBoundingClientRect();
    const topZones = chrome.querySelectorAll('[data-zone="tl"], [data-zone="tc"], [data-zone="tr"]');
    const botZones = chrome.querySelectorAll('[data-zone="bl"], [data-zone="bc"], [data-zone="br"]');
    const t = Math.max(...[...topZones].map((z) => z.getBoundingClientRect().bottom - sr.top));
    const b = Math.max(...[...botZones].map((z) => sr.bottom - z.getBoundingClientRect().top));
    if (Math.abs(t - chromeTop) > 1 || Math.abs(b - chromeBottom) > 1 || !measureChrome.done) {
      chromeTop = t; chromeBottom = b; measureChrome.done = true;
      demo.style.setProperty("--chrome-top", `${t}px`); demo.style.setProperty("--chrome-bottom", `${b}px`);
      drawDemo();
    }
  });
};
new ResizeObserver(measureChrome).observe(demo);
chrome.querySelectorAll(".c-zone").forEach((z) => new ResizeObserver(measureChrome).observe(z));

// location
const locPill = $("d-loc");
new LiquidGlass(locPill, G);
locPill.addEventListener("click", () => openMenu(locPill, {
  title: "Location", label: "Location",
  items: D.locations.map((l) => ({ label: l.name, value: l.name, checked: locPill.querySelector(".label").textContent === l.name, onSelect: (v) => {
    locPill.querySelector(".label").textContent = v;
    if (v !== "US") toast(demo, { message: "This demo only loads US forecasts", glass: G });
  } })),
}));
// view switch
new Segmented($("d-view"), { label: "View", items: [{ value: "forecast", label: "Forecast" }, { value: "evaluate", label: "Evaluate" }, { value: "map", label: "Map" }], value: "forecast", glass: G });
// status island
const island = new StatusIsland($("d-island"), { idle: { title: "FluSight hub" }, glass: G });
const runSync = (fail = false) => {
  let p = 0;
  island.set({ state: "busy", title: "Syncing FluSight hub", detail: "Fetching model output", progress: 0 });
  const iv = setInterval(() => {
    p += 0.12;
    if (fail && p > 0.5) { clearInterval(iv); island.set({ state: "error", title: "Sync failed", detail: "Network unreachable. Select to retry" }); return; }
    if (p >= 1) { clearInterval(iv); island.set({ state: "done", title: "Up to date", detail: `${D.models.length} models · ${DATES.length} dates` }); return; }
    island.set({ state: "busy", title: "Syncing FluSight hub", detail: p < 0.5 ? "Fetching model output" : "Scoring", progress: p });
  }, 260);
};
$("d-island").addEventListener("click", () => runSync());
$("d-island").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); runSync(); } });
$("d-island").setAttribute("aria-label", "Hub status. Press to sync");
// search
const searchSource = (sel) => (q) => {
  const ql = q.toLowerCase();
  const locs = D.locations.filter((l) => !ql || l.name.toLowerCase().includes(ql) || l.abbr.toLowerCase() === ql).slice(0, q ? 6 : 4).map((l) => ({ label: l.name, sub: l.abbr, value: l.id, group: "Locations", kind: "loc" }));
  // match the name people see first (short), then the full ID
  const score = (m) => (!ql ? 0 : short(m).toLowerCase().includes(ql) ? 0 : m.toLowerCase().includes(ql) ? 1 : 2);
  const ms = ranked.filter((m) => score(m) < 2).sort((a, b) => score(a) - score(b)).slice(0, q ? 12 : 5).map((m) => {
    const s = sel?.list.find((x) => x.m === m);
    return { label: short(m), sub: data.seasonRel.get(m)?.toFixed(2), value: m, group: "Models", kind: "model", swatch: s ? seriesVar(s.slot) : null };
  });
  return [...locs, ...ms];
};
new Search($("d-search"), {
  placeholder: "Search locations and models", label: "Search locations and models", glass: G, source: searchSource(demoSel),
  onSelect: (r) => {
    if (r.kind === "model") { demoSel.add(r.value); refreshModels(); toast(demo, { message: `Added ${r.label}`, glass: G, action: { label: "Undo", onClick: () => { demoSel.toggle(r.value); refreshModels(); } } }); }
    else locPill.querySelector(".label").textContent = r.label;
  },
});
// share, more
const share = $("d-share"); new LiquidGlass(share, G); tooltip(share, "Share this view", { placement: "bottom" });
share.addEventListener("click", () => toast(demo, { message: "Link copied", glass: G }));
const more = $("d-more"); new LiquidGlass(more, G);
more.addEventListener("click", () => openMenu(more, { title: "More", items: [
  { label: "Share this view", onSelect: () => toast(demo, { message: "Link copied", glass: G }) },
  { label: root.dataset.theme === "dark" ? "Light appearance" : "Dark appearance", onSelect: () => $("theme").click() },
] }));
// models
const modelsPill = $("d-models"); new LiquidGlass(modelsPill, G);
const refreshModels = () => { renderModelPill($("d-dots"), $("d-models-label"), modelsPill, demoSel); drawDemo(); };
modelsPill.addEventListener("click", () => openModelPicker(modelsPill, demoSel, refreshModels));
// date
const demoStepper = new Stepper($("d-stepper"), { values: DATES, index: DI0, label: "Forecast date", format: { long: fmtLong, short: fmtShort }, glass: G, onChange: (i) => { demoState.di = i; drawDemo(); } });
// left/right step the demo's date whenever the demo chart is on screen
let demoVisible = false;
new IntersectionObserver(([e]) => (demoVisible = e.isIntersecting), { threshold: 0.3 }).observe(demo);
timeKeys((d) => demoStepper.step(d), { active: () => demoVisible });
// interval
const band = $("d-band"); new LiquidGlass(band, G);
const BANDS = [[0, "No interval"], [0.5, "50% interval"], [0.8, "80% interval"], [0.95, "95% interval"]];
band.addEventListener("click", () => openMenu(band, { title: "Interval", placement: "top-end", items: BANDS.map(([v, l]) => ({ label: l, value: v, checked: v === demoState.band, onSelect: (v) => { demoState.band = v; $("d-band-label").textContent = BANDS.find((b) => b[0] === v)[1]; band.setAttribute("aria-label", BANDS.find((b) => b[0] === v)[1]); drawDemo(); } })) }));
band.setAttribute("aria-label", "95% interval");
renderModelPill($("d-dots"), $("d-models-label"), modelsPill, demoSel);
drawDemo();

// frame sizes
const SIZES = { phone: 390, tablet: 820, desktop: null };
const wrapW = () => frame.parentElement.clientWidth;
const setFrame = (w) => {
  const W = w == null ? wrapW() : Math.max(320, Math.min(wrapW(), w));
  frame.style.width = `${W}px`;
  $("frame-readout").textContent = `${Math.round(W)} px · ${W < 600 ? "compact" : W < 1024 ? "regular" : "wide"}`;
};
const frameSeg = new Segmented($("frame-seg"), { label: "Demo size", items: [{ value: "phone", label: "Phone" }, { value: "tablet", label: "Tablet" }, { value: "desktop", label: "Desktop" }], value: "desktop", onChange: (v) => setFrame(SIZES[v]) });
setFrame(null);
addEventListener("resize", () => setFrame(frameSeg.value === "desktop" ? null : parseFloat(frame.style.width)));
const handle = $("frame-handle");
let fd = null;
handle.addEventListener("pointerdown", (e) => { fd = { x: e.clientX, w: frame.offsetWidth }; handle.setPointerCapture(e.pointerId); frame.classList.add("dragging"); });
handle.addEventListener("pointermove", (e) => { if (fd) setFrame(fd.w + (e.clientX - fd.x) * 2); });
handle.addEventListener("pointerup", () => { fd = null; frame.classList.remove("dragging"); });
handle.addEventListener("keydown", (e) => { const d = { ArrowLeft: -20, ArrowRight: 20 }[e.key]; if (d) { e.preventDefault(); setFrame(frame.offsetWidth + d * (e.shiftKey ? 4 : 1)); } });
$("show-zones").addEventListener("change", (e) => demo.classList.toggle("show-zones", e.target.checked));

/* ---------- small stages ---------- */
const stage = (svgId, opts = {}) => {
  const svg = $(svgId), st = svg.closest(".stage");
  const draw = () => fanChart(d3.select(svg), data, { id: `${svgId}-src`, models: top.slice(0, 3).map((m, i) => ({ m, slot: i })).concat([{ m: D.baseline, slot: "baseline" }]), pad: { t: 56, b: 56, r: 150 }, ...opts, ...(opts.dyn?.() || {}) });
  let raf = 0; new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }).observe(st);
  queueMicrotask(draw); // draw at once; the observer handles later size changes
  return { st, glass: { source: `#${svgId}-src`, container: st }, draw };
};

// 02 pill states
{
  const s = stage("pill-chart", { pad: { t: 24, b: 24, r: 150 } });
  const ex = [
    ["Rest", `<button class="c-pill">United States</button>`],
    ["Hover", `<button class="c-pill is-hover">United States</button>`],
    ["Pressed", `<button class="c-pill is-active">United States</button>`],
    ["Selected", `<button class="c-pill selected" aria-pressed="true">Trails</button>`],
    ["Disabled", `<button class="c-pill" aria-disabled="true">Export</button>`],
    ["Icon", `<button class="c-pill icon" aria-label="Search">${icon.search}</button>`],
    ["Small · Large", `<span style="display:flex;gap:8px;align-items:center"><button class="c-pill sm">Small</button><button class="c-pill lg">Large</button></span>`],
    ["Truncated", `<button class="c-pill" style="--pill-max:150px"><span class="label">UMass-gbqr_4src_spatial_nc_none</span></button>`],
  ];
  $("pill-states").innerHTML = ex.map(([c, h]) => `<figure>${h}<figcaption class="t-small">${c}</figcaption></figure>`).join("");
  $("pill-states").querySelectorAll(".c-pill").forEach((p) => new LiquidGlass(p, s.glass));
}
// 03 segmented
{
  const a = stage("seg-chart"), b = stage("seg-chart2");
  const items = [{ value: "50", label: "50%" }, { value: "80", label: "80%" }, { value: "90", label: "90%" }, { value: "95", label: "95%" }];
  new Segmented($("seg-a"), { label: "Interval", items, value: "80", glass: a.glass });
  new Segmented($("seg-b"), { label: "Interval", items, value: "80", glass: b.glass });
}
// 04 stepper
{
  const st = { di: DI0 };
  const s = stage("step-chart", { dyn: () => ({ di: st.di }) });
  new Stepper($("step-a"), { values: DATES, index: DI0, label: "Forecast date", format: { long: fmtLong, short: fmtShort }, glass: s.glass, onChange: (i) => { st.di = i; s.draw(); } });
}
// 05 search
{
  const s = stage("search-chart");
  new Search($("search-a"), { placeholder: "Search locations and models", label: "Search locations and models", glass: s.glass, shortcut: false, source: searchSource(null), onSelect: (r) => toast(s.st, { message: `Picked ${r.label}`, glass: s.glass }) });
}
// 06 menu
{
  const s = stage("menu-chart");
  const tl = $("m-tl"), br = $("m-br");
  new LiquidGlass(tl, s.glass); new LiquidGlass(br, s.glass);
  let v = 0.8;
  tl.addEventListener("click", () => openMenu(tl, { title: "Interval", items: BANDS.map(([b, l]) => ({ label: l, value: b, checked: b === v, onSelect: (x) => (v = x) })) }));
  br.addEventListener("click", () => openMenu(br, { title: "Actions", placement: "bottom-end", items: [
    { header: "Share" },
    { label: "Copy link", shortcut: "⌘L", onSelect: () => toast(s.st, { message: "Link copied", glass: s.glass }) },
    { label: "Copy CLI command", onSelect: () => toast(s.st, { message: "Command copied", glass: s.glass }) },
    { header: "Export" },
    { label: "Download CSV", shortcut: "⌘S" }, { label: "Download PNG" }, { label: "Download SVG", disabled: true },
    "-",
    { label: "Reset view", danger: true },
  ] }));
}
// 07 popover
{
  const s = stage("pop-chart", { dyn: () => ({ models: popSel.list }) });
  const popSel = selection(top.slice(0, 3).concat([D.baseline]));
  const pill = $("pop-a"); new LiquidGlass(pill, s.glass);
  const refresh = () => { renderModelPill($("pop-dots"), $("pop-label"), pill, popSel); s.draw(); };
  pill.addEventListener("click", () => openModelPicker(pill, popSel, refresh));
  renderModelPill($("pop-dots"), $("pop-label"), pill, popSel);
}
// 08 tooltip + value tags
{
  let P = null;
  const s = stage("tip-chart", { pad: { t: 64, b: 48, r: 150 } });
  const zone = $("tip-zone");
  const icons = [
    ["Search", icon.search],
    ["Share this view", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7.5 7.5L12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>'],
    ["Download", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/></svg>'],
  ];
  for (const [label, svg] of icons) { const b = document.createElement("button"); b.className = "c-pill icon"; b.setAttribute("aria-label", label); b.innerHTML = svg; zone.appendChild(b); new LiquidGlass(b, s.glass); tooltip(b, label, { placement: "bottom" }); }
  // tags at the 2-week horizon, nudged apart vertically so they never overlap
  const tags = $("tip-tags");
  const placeTags = () => {
    P = fanChart(d3.select("#tip-chart"), data, { id: "tip-chart-src", models: top.slice(0, 3).map((m, i) => ({ m, slot: i })), pad: { t: 64, b: 60, r: 150 } });
    const items = P.bands.map((sr) => { const p = sr.pts.find((q) => q.h === 2); return p && { sr, p, x: P.x(p.date), y: P.y(p.med) }; }).filter(Boolean).sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) items[i].y = Math.max(items[i].y, items[i - 1].y + 24);
    const fmt = d3.format(".3~s");
    tags.innerHTML = items.map((d) => `<span class="c-tag" style="position:absolute;left:${d.x + 10}px;top:${d.y - 10}px;z-index:5"><i style="background:${d.sr.c}"></i>${fmt(d.p.med)}<span class="rng">${fmt(d.p.lo)}–${fmt(d.p.hi)}</span></span>`).join("");
  };
  new ResizeObserver(() => requestAnimationFrame(placeTags)).observe(s.st);
  placeTags();
}
// 09 status + toast
{
  const s = stage("st-chart", { pad: { t: 64, b: 64, r: 150 } });
  s.st.style.setProperty("--chrome-bottom", "62px");
  const isl = new StatusIsland($("st-island"), { idle: { title: "FluSight hub" }, glass: s.glass });
  ["st-sync", "st-fail", "st-toast"].forEach((id) => new LiquidGlass($(id), s.glass));
  const run = (fail) => {
    let p = 0;
    const tick = () => {
      p += 0.1;
      if (fail && p > 0.55) { isl.set({ state: "error", title: "Sync failed", detail: "Network unreachable" }); return; }
      if (p >= 1) { isl.set({ state: "done", title: "Up to date", detail: `${D.models.length} models` }); return; }
      isl.set({ state: "busy", title: "Syncing FluSight hub", detail: p < 0.5 ? "Fetching model output" : "Scoring", progress: p });
      setTimeout(tick, 240);
    };
    tick();
  };
  $("st-sync").addEventListener("click", () => run(false));
  $("st-fail").addEventListener("click", () => run(true));
  $("st-toast").addEventListener("click", () => toast(s.st, { message: "Link copied", glass: s.glass, action: { label: "Undo", onClick: () => {} } }));
}
