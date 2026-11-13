/* Interval refinement, full screen. This page is the reference for the fan chart: the drawing lives
 * in lib/chart.js (fanChart); this file adds the page around it: focus state, the hover readout, the
 * chrome, and time keys (left/right always step the forecast date). Decisions: intervals-goals.md. */
import { LiquidGlass } from "../lib/glass.js";
import { loadData, fanChart, short, seriesVar, WEEK } from "../lib/chart.js";
import { Stepper, tooltip, openPopover, icon } from "../lib/controls.js";
import { ModelSelection, groupModels, inferFamily, teamOf } from "../lib/selection.js";
import { TimeNav } from "../lib/time.js";
import { sizeClass } from "../lib/position.js";

const root = document.documentElement;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
if (store.get("viz-ds-theme")) root.dataset.theme = store.get("viz-ds-theme");
const $ = (id) => document.getElementById(id);

const data = await loadData("../data/");
const { D, DATES, truth, DI0 } = data;
const fmtN = d3.format(",.0f"), fmtHalf = d3.format(".2~s");
const fmtLong = d3.utcFormat("%b %-d, %Y"), fmtShort = d3.utcFormat("%b %-d");
const truthAt = new Map(truth.map((t) => [+t.date, t.v]));

const S = { di: DI0, rulers: false, misses: true, focus: null, preview: null, hot: null, hoverH: null };
const focused = () => S.preview ?? S.focus;

/* ---------------- models: selection (lib/selection.js) and metadata ----------------
 * Provenance below is SAMPLE metadata for the prototype (the real app reads it from each model's
 * metadata / which folder it came from): two models stand in for local experiments, names with
 * experimental suffixes stand in for staged ones, the rest are hub models. */
const ALL = D.models.filter((m) => m !== D.baseline);
const SAMPLE_LOCAL = new Set(["UMass-timesfm3_nhsn", "UMass-AR2_nc_none"]);
const provenance = (m) => (SAMPLE_LOCAL.has(m) ? "Local" : /_nc_|otid|_spatial|_prod/.test(m) ? "Staged" : "Hub");
const metaOf = () => ({});
const GROUPS = groupModels(ALL, metaOf);
const familyTag = (m) => { const f = inferFamily(m); return GROUPS.families.some((g) => g.title === f) ? f : teamOf(m); };
const sel = new ModelSelection({
  max: 5,
  selected: ["UMass-flusion", "UMass-AR6_pooled", "UMass-gbqr_4src", "UMass-WISAR6_fourthroot_adaptive_t", "axial-tfm_L4v5", "UMass-AR2", "UMass-timesfm3_nhsn"],
  onChange: () => { if (S.focus && !sel.isCharted(S.focus)) S.focus = null; renderModelsPill(); pickerRefresh?.(); frame(); },
});

const view = $("view"), svg = d3.select("#chart");
let chromeTop = 70, chromeBottom = 70, G = null;

// charted models in a stable order (by color slot), then the baseline if it's on
function models() {
  const list = [...sel.charted].sort((a, b) => a.slot - b.slot).map(({ m, slot }) => ({ m, slot }));
  if (sel.baseline) list.push({ m: D.baseline, slot: "baseline" });
  return list;
}

/* ---------------- draw ---------------- */
function draw() {
  const w = svg.node().clientWidth, compact = sizeClass(view) === "compact";
  const u = nav.mix; // 0 close up, 1 Season
  const P = fanChart(svg, data, {
    id: "chart-src", models: models(), t: nav.T, domain: nav.domain(),
    // the right margin holds the model labels close up; in Season they sit at the fan's end instead
    pad: { l: 64, r: 168 + (56 - 168) * u, t: chromeTop + 24, b: chromeBottom + 48 }, topClear: chromeTop,
    focus: focused(), hover: nav.moving ? null : S.hoverH, rulers: rulerK, misses: S.misses,
    context: sel.context, hot: S.hot,
    onLabel: activate,
  });
  G = { ...P, compact, w };
  readout();
  previewUnderPointer();
  renderNote();
  // panned so far that the forecast is off-screen: show which way it is, and bring it back on click
  const xr = P.x(P.ref), off = xr < 0 ? "left" : xr > w ? "right" : null, rc = $("recenter"), wrap = $("recenter-wrap");
  if (wrap.hidden !== !off) { wrap.hidden = !off; if (off) requestAnimationFrame(() => rcGlass?.update()); }
  if (off) {
    wrap.className = off;
    rc.querySelector(".arr").textContent = off === "left" ? "←" : "";
    rc.querySelector(".lb").textContent = `${fmtShort(DATES[nav.week])} forecast${off === "right" ? " →" : ""}`;
  }
}

/* One rule for every model on the chart (label or line): click focuses it; a grey (context) model is
 * put on the chart first, then focused, so you see where it went and in which color. */
function activate(m) {
  if (m !== D.baseline && !sel.isCharted(m)) { sel.chart(m); S.focus = m; }
  else S.focus = S.focus === m ? null : m;
  S.preview = null; S.hot = null;
  $("hint").style.opacity = 0;
  draw();
}

/* ---------------- readout ---------------- */
function readout() {
  const el = $("readout");
  if (S.hoverH == null || nav.moving) { el.hidden = true; return; }
  const hp = { h: S.hoverH, date: new Date(+G.ref + S.hoverH * WEEK) }, f = G.focus, hasFocus = f != null;
  const rows = G.bands.map((b) => ({ b, p: b.pts.find((p) => p.h === hp.h) })).filter((d) => d.p);
  if (hasFocus) rows.sort((a, b) => (b.b.m === f) - (a.b.m === f));
  const obs = truthAt.get(+hp.date);
  // Show all: a hovered grey model gets its own row at the top; the rest are summarized in one line
  const ctxAt = (G.context || []).map((c) => ({ c, p: c.pts.find((p) => p.h === hp.h) })).filter((d) => d.p);
  const hotRow = ctxAt.find((d) => d.c.m === S.hot);
  const ctxN = sel.context.length, ctxMissing = ctxN - (G.context || []).length;
  const meds = ctxAt.map((d) => d.p.med);
  const ctxLine = sel.showAll && ctxN ? `<div class="obs"><span>and ${ctxN} more selected${ctxMissing ? ` (${ctxMissing} with no forecast)` : ""}</span><span class="mono">${meds.length ? `${fmtN(d3.min(meds))} – ${fmtN(d3.max(meds))}` : ""}</span></div>` : "";
  const hotHtml = hotRow ? `<tr><td><span class="nm"><i style="background:var(--ink-tertiary)"></i><span class="t">${short(hotRow.c.m)}</span></span></td><td class="rng">${fmtN(hotRow.p.lo)} – ${fmtN(hotRow.p.hi)}</td><td class="wd">±${fmtHalf((hotRow.p.hi - hotRow.p.lo) / 2)}</td></tr>` : "";
  el.innerHTML = `<div class="when"><span>${fmtShort(hp.date)}</span><span>${hp.h === 0 ? "this week" : `${hp.h} wk ahead`} · 95%</span></div>
    <table>${hotHtml}${rows.map(({ b, p }) => {
      const out = obs != null && (obs < p.lo || obs > p.hi);
      return `<tr class="${hasFocus && b.m !== f ? "dim" : ""}"><td><span class="nm"><i style="background:${b.c}"></i><span class="t">${short(b.m)}</span></span></td><td class="rng">${fmtN(p.lo)} – ${fmtN(p.hi)}</td><td class="wd">±${fmtHalf((p.hi - p.lo) / 2)}</td></tr>`;
    }).join("")}</table>${ctxLine}
    ${obs != null ? `<div class="obs"><span>Observed</span><span class="mono">${fmtN(obs)}${rows.some(({ p }) => obs < p.lo || obs > p.hi) ? `<span class="out">outside ${rows.filter(({ p }) => obs < p.lo || obs > p.hi).map(({ b }) => `<i style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${b.c}"></i>`).join(" ")}</span>` : ""}</span></div>` : ""}`;
  el.hidden = false;
  // place on the history side, which is empty space at the top; below the top chrome
  const px = G.x(hp.date), rw = el.offsetWidth;
  if (G.compact) { el.style.left = "12px"; el.style.top = "auto"; el.style.bottom = `${chromeBottom + 44}px`; }
  else { el.style.bottom = "auto"; el.style.top = `${G.pad.t}px`; const lx = G.x(G.ref) - 24 - rw; // left of the forecast date: over history, never over a band
    el.style.left = `${lx > 12 ? lx : px + 18}px`; }
}

/* ---------------- time: date and zoom ----------------
 * lib/time.js owns the date (scrub, glide, keys) and the zoom (close up 6–20 weeks, or Season). */
const chartEl = svg.node();
let frameQueued = 0;
function frame() { if (!frameQueued) frameQueued = requestAnimationFrame(() => { frameQueued = 0; draw(); }); }
/* ---------------- hover ---------------- */
function setHover(h) { if (h === S.hoverH) return; S.hoverH = h; if (h != null) $("hint").style.opacity = 0; frame(); }
function hoverAt(clientX) {
  if (!G || nav.moving) return;
  const px = clientX - chartEl.getBoundingClientRect().left;
  const weeks = [0, 1, 2, 3];
  const near = weeks.reduce((a, b) => (Math.abs(G.x(new Date(+G.ref + b * WEEK)) - px) < Math.abs(G.x(new Date(+G.ref + a * WEEK)) - px) ? b : a));
  // hover counts within half a week (at most 60px) beyond the first and last forecast weeks, on both sides
  const reach = Math.min(60, (G.x(new Date(+G.ref + WEEK)) - G.x(G.ref)) / 2);
  const far = px < G.x(G.ref) - reach || px > G.x(new Date(+G.ref + 3 * WEEK)) + reach;
  setHover(far ? null : near);
}
// hover runs everywhere, including over the labels: their invisible hit areas reach to the screen's edge,
// and skipping them there left the 3-weeks-ahead readout up far past its half-week reach
chartEl.addEventListener("pointermove", (e) => hoverAt(e.clientX));
chartEl.addEventListener("pointerdown", (e) => hoverAt(e.clientX));
chartEl.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { mouse = null; setHover(null); previewUnderPointer(); } });

/* Focus preview follows whatever label is under the mouse, checked after every frame. Enter/leave
 * events can't do this: the chart is redrawn each frame, so a label that moves under or away from a
 * still mouse (while the date changes) never gets a leave event, and its highlight used to stick. */
let mouse = null;
chartEl.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") { mouse = { x: e.clientX, y: e.clientY }; previewUnderPointer(); } });
function previewUnderPointer() {
  let hit = null; // { m, ctx }
  if (mouse && !nav.moving && G) {
    for (const g of chartEl.querySelectorAll(".fc-label")) {
      const r = g.getBoundingClientRect();
      if (mouse.x >= r.left && mouse.x <= r.right && mouse.y >= r.top && mouse.y <= r.bottom) { const d = d3.select(g).datum(); hit = { m: d.s.m, ctx: !!d.ctx }; break; }
    }
    if (!hit) hit = lineUnder(mouse.x, mouse.y);
  }
  // a charted model previews focus, exactly as hovering its label does; a grey one is lifted and named
  const preview = hit && !hit.ctx ? hit.m : null, hot = hit && hit.ctx ? hit.m : null;
  chartEl.style.cursor = hit ? "pointer" : "";
  if (preview !== S.preview || hot !== S.hot) { S.preview = preview; S.hot = hot; frame(); }
}
/* The median line under the pointer (within 6px), by priority: the focused model, other charted models,
 * then grey context lines; nearest first within a priority. Medians are interpolated at the pointer's x. */
function lineUnder(cx, cy) {
  const r = chartEl.getBoundingClientRect(), px = cx - r.left, py = cy - r.top, t = +G.x.invert(px);
  const at = (pts) => {
    if (t < +pts[1]?.date - 2 * 864e5 || t > +pts.at(-1).date) return null; // skip the shared anchor at the cutoff
    const i = pts.findIndex((p) => +p.date >= t); if (i <= 0) return pts[0].med;
    const a = pts[i - 1], b = pts[i]; return a.med + ((b.med - a.med) * (t - a.date)) / (b.date - a.date);
  };
  const c = [];
  for (const s of G.series) { const v = at(s.pts); if (v != null) c.push({ m: s.m, ctx: false, pri: s.m === S.focus ? 0 : 1, d: Math.abs(G.y(v) - py) }); }
  for (const s of G.context || []) { const v = at(s.pts); if (v != null) c.push({ m: s.m, ctx: true, pri: 2, d: Math.abs(G.y(v) - py) }); }
  return c.filter((h) => h.d <= 6).sort((a, b) => a.pri - b.pri || a.d - b.d)[0] || null;
}
// click on a line = click on its label; a press that moved (a scrub or pan) is never a click
let down = null;
chartEl.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
chartEl.addEventListener("click", (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.target.closest(".fc-label")) return;
  const hit = G && lineUnder(e.clientX, e.clientY);
  if (hit) activate(hit.m);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.focus && !document.querySelector(".c-float")) { S.focus = null; draw(); } });

/* ---------------- models pill, baseline toggle, "Showing 5 of 12" note ---------------- */
function renderModelsPill() {
  const pill = $("c-models"), charted = [...sel.charted].sort((a, b) => a.slot - b.slot);
  pill.querySelector(".dots").innerHTML = charted.map((c) => `<i style="background:${seriesVar(c.slot)}"></i>`).join("");
  const n = sel.selected.length;
  pill.querySelector(".label").textContent = n === 0 ? "Choose models" : `${n} model${n === 1 ? "" : "s"}`;
  pill.setAttribute("aria-label", `Models: ${n} selected, ${charted.length} on the chart. Change`);
  $("c-baseline").setAttribute("aria-pressed", sel.baseline);
  modelsGlass?.update();
}
function renderNote() {
  const wrap = $("more-wrap"), n = sel.selected.length, on = sel.charted.length, show = n > on;
  if (wrap.hidden !== !show) { wrap.hidden = !show; if (show) requestAnimationFrame(() => noteGlass?.update()); }
  if (!show) return;
  wrap.querySelector(".t").textContent = sel.showAll ? `Showing all ${n} ·` : `Showing ${on} of ${n} ·`;
  $("more-btn").textContent = sel.showAll ? `Show ${on}` : "Show all";
}

/* ---------------- the model picker ----------------
 * Name selects (for evaluation). The circle puts a model on the chart (filled in its color); with five
 * charted, the one charted longest comes off. Under Show all, selected-but-not-charted rows show a small
 * grey dot: drawn as context. Sections: Selected and Local pinned, then families, then By team. */
let pickerRefresh = null;
const collapsed = new Set();
function openModelPicker() {
  const anchor = $("c-models");
  const layer = openPopover(anchor, {
    title: "Models", width: 480,
    onClose: () => { pickerRefresh = null; },
    content: (el) => {
      el.innerHTML = `<div class="pk-head"><label class="pop-search">${icon.search}<input type="search" placeholder="Search ${ALL.length} models, teams, families" aria-label="Search models"></label>
          <button type="button" class="pk-base" role="switch" aria-checked="${sel.baseline}"><i></i>Baseline</button></div>
        <div class="pk-list" role="group" aria-label="Models"></div>
        <div class="pk-foot"></div>`;
      const list = el.querySelector(".pk-list"), input = el.querySelector("input"), foot = el.querySelector(".pk-foot");
      el.querySelector(".pk-base").addEventListener("click", (e) => { sel.setBaseline(!sel.baseline); e.currentTarget.setAttribute("aria-checked", sel.baseline); });
      let lastClicked = null;
      const week = DATES[nav.week], weekKey = d3.utcFormat("%Y-%m-%d")(week);
      const row = (m) => {
        const slot = sel.slotOf(m), chosen = sel.has(m), ctx = sel.showAll && chosen && slot == null;
        return `<div class="pk-row${chosen ? " sel" : ""}" data-m="${m}">
          <button type="button" class="pk-dot${ctx ? " ctx" : ""}" aria-pressed="${slot != null}" aria-label="${slot != null ? "On the chart. Take off" : "Put on the chart"}: ${short(m)}" style="--c:${slot != null ? seriesVar(slot) : "transparent"}"><i></i></button>
          <button type="button" class="pk-name" role="checkbox" aria-checked="${chosen}"><span class="nm">${short(m)}</span><span class="sub">${[teamOf(m), familyTag(m) !== teamOf(m) ? familyTag(m) : null, provenance(m)].filter(Boolean).join(" · ")}${data.FC[m]?.[weekKey] ? "" : ` · <span class="miss">no forecast ${fmtShort(week)}</span>`}</span></button>
          <span class="pk-check" aria-hidden="true">${icon.check}</span></div>`;
      };
      const chev = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
      // headers are plain text; every section but Selected collapses, and has a quiet Select all / Deselect all
      const section = (key, title, ms, inner) => {
        if (key === "sel") return `<div class="pk-sec fixed" data-key="${key}"><span class="pk-sec-t">${title} <span class="n">${ms.length}</span></span></div>${inner}`;
        const all = ms.every((m) => sel.has(m)), open = !collapsed.has(key);
        return `<div class="pk-sec${open ? "" : " collapsed"}" data-key="${key}"><button type="button" class="pk-sec-t" aria-expanded="${open}">${chev}${title} <span class="n">${ms.length}</span></button><button type="button" class="pk-all">${all ? "Deselect all" : "Select all"}</button></div>${open ? inner : ""}`;
      };
      const sections = () => {
        const q = input.value.trim().toLowerCase();
        const match = (m) => !q || m.toLowerCase().includes(q) || teamOf(m).toLowerCase().includes(q) || familyTag(m).toLowerCase().includes(q) || provenance(m).toLowerCase() === q;
        const out = [];
        const selMs = sel.selected.filter(match);
        if (selMs.length) out.push({ key: "sel", title: "Selected", ms: selMs });
        const local = ALL.filter((m) => provenance(m) === "Local" && match(m));
        if (local.length) out.push({ key: "local", title: "Local", ms: local });
        for (const g of GROUPS.families) { const ms = g.models.filter(match); if (ms.length) out.push({ key: g.key, title: g.title, ms }); }
        const teams = GROUPS.teams.map((t) => ({ team: t.team, ms: t.models.filter(match) })).filter((t) => t.ms.length);
        if (teams.length) out.push({ key: "team", title: "By team", ms: teams.flatMap((t) => t.ms), teams });
        return out;
      };
      const render = () => {
        const keep = document.activeElement?.closest?.(".pk-row"), keepM = keep?.dataset.m, keepCls = document.activeElement?.className, top = list.scrollTop;
        const secs = sections();
        list.innerHTML = secs.map((s) => section(s.key, s.title, s.ms, s.teams
          ? s.teams.map((t) => `<div class="pk-team">${t.team}</div>${t.ms.map(row).join("")}`).join("")
          : s.ms.map(row).join(""))).join("") || `<div class="c-empty t-small">No models match</div>`;
        list.scrollTop = top;
        if (keepM) list.querySelector(`.pk-row[data-m="${CSS.escape(keepM)}"] .${keepCls?.split(" ")[0]}`)?.focus({ preventScroll: true });
        const n = sel.selected.length, on = sel.charted.length;
        foot.textContent = [`${n} selected`, `${on} charted`, sel.showAll && n > on ? `${n - on} grey` : null].filter(Boolean).join(" · ");
      };
      list.addEventListener("click", (e) => {
        const r = e.target.closest(".pk-row"), sec = e.target.closest(".pk-sec");
        if (sec) {
          const s = sections().find((x) => x.key === sec.dataset.key);
          if (s.key === "sel") return;
          if (e.target.closest(".pk-all")) sel.setMany(s.ms, !s.ms.every((m) => sel.has(m)));
          else if (e.target.closest(".pk-sec-t")) { collapsed.has(s.key) ? collapsed.delete(s.key) : collapsed.add(s.key); render(); }
          return;
        }
        if (!r) return;
        const m = r.dataset.m;
        if (e.target.closest(".pk-dot")) { sel.toggleChart(m); return; }
        if (e.target.closest(".pk-name")) {
          if (e.shiftKey && lastClicked) { // a range, in the order rows appear, set to the clicked row's new state
            const rows = [...list.querySelectorAll(".pk-row")].map((x) => x.dataset.m), a = rows.indexOf(lastClicked), b = rows.indexOf(m);
            if (a >= 0 && b >= 0) { sel.setMany(rows.slice(Math.min(a, b), Math.max(a, b) + 1), !sel.has(m)); lastClicked = m; return; }
          }
          sel.toggle(m); lastClicked = m;
        }
      });
      list.addEventListener("keydown", (e) => {
        const names = [...list.querySelectorAll(".pk-name")], i = names.indexOf(document.activeElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); names[Math.max(0, Math.min(names.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus(); }
        if (e.key === "Enter" && i >= 0) { e.preventDefault(); sel.toggleChart(names[i].closest(".pk-row").dataset.m); }
      });
      input.addEventListener("input", render);
      pickerRefresh = render;
      render();
    },
  });
}

/* ---------------- chrome ---------------- */
const GL = { source: "#chart-src", container: view };
for (const id of ["back", "theme", "c-rulers", "c-misses"]) new LiquidGlass($(id), GL);
tooltip($("back"), "Back to the design system", { placement: "bottom" });
$("theme").addEventListener("click", () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  store.set("viz-ds-theme", root.dataset.theme);
  requestAnimationFrame(() => LiquidGlass.updateAll());
});
renderModelsPill(); // fill it before the glass measures it
var modelsGlass = new LiquidGlass($("c-models"), GL); new LiquidGlass($("c-baseline"), GL);
$("c-models").addEventListener("click", openModelPicker);
$("c-baseline").addEventListener("click", () => sel.setBaseline(!sel.baseline));
var noteGlass = new LiquidGlass($("more"), GL);
$("more-btn").addEventListener("click", () => sel.setShowAll(!sel.showAll));
renderModelsPill();
const stepper = new Stepper($("c-date"), { values: DATES, index: DI0, label: "Forecast date", glass: GL, format: { long: fmtLong, short: fmtShort }, onChange: (i) => nav.goTo(i) });
const nav = new TimeNav({
  surface: chartEl, dates: DATES, index: DI0,
  season: [truth[0].date, new Date(Math.max(+truth.at(-1).date, +DATES.at(-1) + 3 * WEEK))],
  scale: () => G.x,
  ignore: (e) => !!e.target.closest(".fc-label"),
  tapTarget: (e) => !!(G && lineUnder(e.clientX, e.clientY)),
  onFrame: draw,
  onWeek: (i) => { S.di = i; stepper.show(i); $("hint").style.opacity = 0; },
});
window.__nav = nav; // for testing from the console
$("recenter").addEventListener("click", () => nav.recenter());
var rcGlass = new LiquidGlass($("recenter"), GL);
for (const [id, key] of [["c-rulers", "rulers"], ["c-misses", "misses"]]) $(id).addEventListener("click", () => { S[key] = !S[key]; $(id).setAttribute("aria-pressed", S[key]); key === "rulers" ? animateRulers() : draw(); });
// rulers fade and slide in or out over ~180ms (the labels step aside with them); instant with reduced motion
let rulerK = 0, rulerRaf = 0;
function animateRulers() {
  cancelAnimationFrame(rulerRaf);
  const to = S.rulers ? 1 : 0, from = rulerK, t0 = performance.now();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { rulerK = to; draw(); return; }
  const tick = () => { const u = Math.min(1, (performance.now() - t0) / 180); rulerK = from + (to - from) * (1 - (1 - u) ** 3); draw(); if (u < 1) rulerRaf = requestAnimationFrame(tick); };
  rulerRaf = requestAnimationFrame(tick);
}

// the chrome tells the chart how much room it takes, top and bottom
const chrome = $("chrome");
function measure() {
  const vr = view.getBoundingClientRect();
  const t = Math.max(...[...chrome.querySelectorAll('[data-zone="tl"],[data-zone="tc"],[data-zone="tr"]')].map((z) => z.getBoundingClientRect().bottom - vr.top));
  const b = Math.max(...[...chrome.querySelectorAll('[data-zone="bl"],[data-zone="bc"],[data-zone="br"]')].map((z) => vr.bottom - z.getBoundingClientRect().top));
  const changed = Math.abs(t - chromeTop) > 1 || Math.abs(b - chromeBottom) > 1;
  chromeTop = t; chromeBottom = b;
  view.style.setProperty("--chrome-top", `${t}px`); view.style.setProperty("--chrome-bottom", `${b}px`);
  return changed;
}
measure(); draw();
let rt = 0;
new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { measure(); draw(); }, 16); }).observe(view);
chrome.querySelectorAll(".c-zone").forEach((z) => new ResizeObserver(() => { if (measure()) draw(); }).observe(z));
document.fonts?.ready.then(() => { measure(); draw(); });
