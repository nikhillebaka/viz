/* Interval refinement, full screen. This page is the reference for the fan chart: the drawing lives
 * in lib/chart.js (fanCanvas: drawn on a canvas, refracted by the WebGL glass); this file adds the page around it: focus state, the hover readout, the
 * chrome, and time keys (left/right always step the forecast date). Decisions: intervals-goals.md. */
import { LiquidGlass } from "../lib/glass.js";
import { fanCanvas, short, seriesVar, WEEK } from "../lib/chart.js";
import { loadFan, timeline, seasonLabel, isoDay } from "../lib/fandata.js";
import { Stepper, tooltip, openPopover, icon } from "../lib/controls.js";
import { ModelSelection, groupModels, inferFamily, teamOf } from "../lib/selection.js";
import { TimeNav } from "../lib/time.js";
import { sizeClass } from "../lib/position.js";
import { loadManifest } from "../lib/scores.js";
import { mountScores } from "../lib/evaluation.js";

const root = document.documentElement;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
if (store.get("viz-ds-theme")) root.dataset.theme = store.get("viz-ds-theme");
const $ = (id) => document.getElementById(id);

/* Data: one season and one location at a time (studies/seasons-locations-goals.md). The season follows the
 * chart's date; the place is the Location bubble. useData() swaps everything that depends on them. */
const man = await loadManifest("../data/");
const SEASONS = man.seasons.map((s) => s.id);
const placeName = (id) => man.locations.find((l) => l.id === id)?.name ?? id;
let place = man.locIndex.has(store.get("viz-place")) ? store.get("viz-place") : "US";
let data = await loadFan(man, SEASONS.at(-1), place);
let D = data.D, DATES = data.DATES, truth = data.truth;
const DI0 = Math.max(0, data.D.dates.indexOf("2025-12-27")) || data.DI0;
const fmtN = d3.format(",.0f"), fmtHalf = d3.format(".2~s");
const fmtLong = d3.utcFormat("%b %-d, %Y"), fmtShort = d3.utcFormat("%b %-d");
let truthAt = new Map(truth.map((t) => [+t.date, t.v]));
const niceTop = (v) => d3.scaleLinear().domain([0, v]).nice(5).domain()[1];
let yTop = niceTop(data.YMAX); // the axis maximum at normal height, fixed per season and place, animated between them
function useData(nd) {
  data = nd; D = nd.D; DATES = nd.DATES; truth = nd.truth; truthAt = new Map(truth.map((t) => [+t.date, t.v]));
  if (S.focus && !nd.present.has(S.focus)) S.focus = null;
}

let fromScores = false; // the focus preview comes from hovering the scores, not the chart
const S = { di: DI0, rulers: false, misses: true, focus: null, preview: null, hot: null, hoverH: null };
const focused = () => S.preview ?? S.focus;

/* ---------------- models: selection (lib/selection.js) and metadata ----------------
 * Provenance below is SAMPLE metadata for the prototype (the real app reads it from each model's
 * metadata / which folder it came from): two models stand in for local experiments, names with
 * experimental suffixes stand in for staged ones, the rest are hub models. */
const ALL = [...new Set(man.seasons.flatMap((s) => s.models))].filter((m) => m !== man.baseline).sort(); // every season's models
const SAMPLE_LOCAL = new Set(["UMass-timesfm3_nhsn", "UMass-AR2_nc_none"]);
const provenance = (m) => (SAMPLE_LOCAL.has(m) ? "Local" : /_nc_|otid|_spatial|_prod/.test(m) ? "Staged" : "Hub");
const metaOf = () => ({});
const GROUPS = groupModels(ALL, metaOf);
const familyTag = (m) => { const f = inferFamily(m); return GROUPS.families.some((g) => g.title === f) ? f : teamOf(m); };
const sel = new ModelSelection({
  max: 5,
  selected: ["UMass-flusion", "UMass-AR6_pooled", "UMass-gbqr_4src", "UMass-WISAR6_fourthroot_adaptive_t", "axial-tfm_L4v5", "UMass-AR2", "UMass-timesfm3_nhsn"],
  onChange: () => { if (S.focus && !sel.isCharted(S.focus)) S.focus = null; renderModelsPill(); pickerRefresh?.(); frame(); scoresChanged(); },
});

const view = $("view"), chartEl = $("chart");
let chromeTop = 70, chromeBottom = 70, G = null;

// charted models in a stable order (by color slot), then the baseline if it's on
// charted models with nothing in this season or place aren't drawn; absent() names them in one line
function models() {
  const list = [...sel.charted].sort((a, b) => a.slot - b.slot).filter(({ m }) => data.present.has(m)).map(({ m, slot }) => ({ m, slot }));
  if (sel.baseline && data.present.has(D.baseline)) list.push({ m: D.baseline, slot: "baseline" });
  return list;
}
function absent() {
  const inSeason = new Set(D.models), gone = sel.charted.map((c) => c.m).filter((m) => !data.present.has(m));
  const notSeason = gone.filter((m) => !inSeason.has(m)).length, notHere = gone.length - notSeason;
  return [notSeason ? `${notSeason} not in ${seasonLabel(data.sid)}` : null, notHere ? `${notHere} not in ${placeName(place)}` : null].filter(Boolean).join(" · ") || null;
}

/* ---------------- draw ---------------- */
function draw() {
  const w = chartEl.clientWidth, compact = sizeClass(view) === "compact";
  const u = nav.mix; // 0 close up, 1 fully zoomed out
  const P = fanCanvas(chartEl, data, {
    models: models(), t: nav.T, domain: nav.domain(),
    ymax: yTop / nav.heightZoom, nice: false, // height zoom: the normal (rounded) axis maximum, divided
    // the right margin holds the model labels close up; in Season they sit at the fan's end instead
    // while the model picker is open, the plot moves into the space to its right (pickerInset)
    pad: { l: 64 + pickerInset, r: 168 + (56 - 168) * u, t: chromeTop + 24, b: chromeBottom + 48 }, topClear: chromeTop,
    focus: focused(), hover: nav.moving ? null : S.hoverH, rulers: rulerK, misses: S.misses,
    context: sel.context.filter((m) => data.present.has(m)), hot: S.hot, absent: absent(),
  });
  G = { ...P, compact, w };
  window.__G = G; // for tests
  LiquidGlass.frame(); // the glass refracts the new frame
  labelButtons();
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
  if (S.hoverH == null || nav.moving || document.querySelector(".c-float")) { el.hidden = true; return; }
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
  if (fromScores && !mouse) return; // the preview comes from a hovered scores row, not the chart
  let hit = null; // { m, ctx }
  if (mouse && !nav.moving && G) {
    const l = labelAt(mouse.x, mouse.y);
    hit = l ? { m: l.m, ctx: !!l.ctx } : lineUnder(mouse.x, mouse.y);
  }
  // a charted model previews focus, exactly as hovering its label does; a grey one is lifted and named
  const preview = hit && !hit.ctx ? hit.m : null, hot = hit && hit.ctx ? hit.m : null;
  chartEl.style.cursor = hit ? "pointer" : "";
  if (preview !== S.preview || hot !== S.hot) { S.preview = preview; S.hot = hot; frame(); ev?.highlight(preview ?? hot); }
}
/* The label under a page point, from the hit boxes the layout computed (no DOM reads). */
function labelAt(cx, cy) {
  if (!G) return null;
  const r = chartEl.getBoundingClientRect(), px = cx - r.left, py = cy - r.top;
  return G.labels.find((d) => px >= d.hit.x0 && px <= d.hit.x1 && py >= d.hit.y0 && py <= d.hit.y1) || null;
}
/* Labels are painted on the canvas, so keyboard and screen-reader users get a matching list of buttons
 * (visually hidden), rebuilt only when the set of labels changes. */
let labelKey = "";
function labelButtons() {
  const ls = G.labels.filter((d) => !d.ctx || d.hot), key = ls.map((d) => `${d.m}|${d.m === G.focus}`).join(",");
  if (key === labelKey) return;
  labelKey = key;
  const box = $("label-a11y"), had = document.activeElement?.closest?.("#label-a11y")?.dataset.m;
  box.innerHTML = ls.map((d) => `<button type="button" data-m="${d.m}" aria-pressed="${d.m === G.focus}">${d.full}${d.m === G.focus ? ", focused" : ""}</button>`).join("");
  if (had) box.querySelector(`[data-m="${CSS.escape(had)}"]`)?.focus();
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
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
  const hit = G && (labelAt(e.clientX, e.clientY) || lineUnder(e.clientX, e.clientY));
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
const collapsed = new Set(SEASONS.map((s) => `away:${s}`)); // "Not in 2023–24" starts collapsed
/* While the picker is open, the chart previews: the plot slides into the space right of the panel and the
 * view zooms out to most of the season (recentered), so models can be judged as they're added. Closing
 * puts the view back exactly as it was. Left/right keep stepping the date throughout. */
let pickerInset = 0, insetRaf = 0, savedView = null;
function animateInset(to) {
  cancelAnimationFrame(insetRaf);
  const from = pickerInset, t0 = performance.now();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { pickerInset = to; document.body.style.setProperty("--pk-inset", `${to}px`); frame(); return; }
  const tick = () => { const u = Math.min(1, (performance.now() - t0) / 320); pickerInset = from + (to - from) * (1 - (1 - u) ** 3); document.body.style.setProperty("--pk-inset", `${pickerInset}px`); draw(); if (u < 1) insetRaf = requestAnimationFrame(tick); };
  insetRaf = requestAnimationFrame(tick);
}
const PREVIEW_WEEKS = 14; // close enough that the four forecast weeks stay distinct; ← → move through the season
function pickerWidth(n) { // the left half (two columns) or quarter (one), minus the outer margin
  const vw = view.clientWidth, inset = 16;
  return n > 24 ? vw * 0.5 - inset * 1.5 : Math.max(vw * 0.25 - inset * 1.5, 360);
}
function openModelPicker() {
  const anchor = $("c-models");
  savedView = nav.view();
  openPopover(anchor, {
    title: "Models", width: pickerWidth(ALL.length), className: "pk-panel", timeKeys: true,
    onClose: () => { pickerRefresh = null; view.classList.remove("picker-open"); document.body.classList.remove("picker-open"); if (savedView) nav.setView(savedView); savedView = null; insetGoal = 0; animateInset(0); },
    content: (el, layer) => {
      el.innerHTML = `<div class="pk-head"><label class="pop-search">${icon.search}<input type="search" placeholder="Search ${ALL.length} models, teams, families" aria-label="Search models"></label>
          <button type="button" class="pk-base" aria-pressed="${sel.baseline}"><span class="tick"></span>Baseline</button></div>
        <div class="pk-list" role="group" aria-label="Models"></div>
        <div class="pk-foot"></div>`;
      const list = el.querySelector(".pk-list"), input = el.querySelector("input"), foot = el.querySelector(".pk-foot");
      el.querySelector(".pk-base").addEventListener("click", (e) => { sel.setBaseline(!sel.baseline); e.currentTarget.setAttribute("aria-pressed", sel.baseline); });
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
        const all = ms.every((m) => sel.has(m)), open = !collapsed.has(key);
        return `<div class="pk-sec${open ? "" : " collapsed"}" data-key="${key}"><button type="button" class="pk-sec-t" aria-expanded="${open}">${chev}${title} <span class="n">${ms.length}</span></button><button type="button" class="pk-all">${all ? "Deselect all" : "Select all"}</button></div>${open ? inner : ""}`;
      };
      const sections = () => {
        const q = input.value.trim().toLowerCase();
        const match = (m) => !q || m.toLowerCase().includes(q) || teamOf(m).toLowerCase().includes(q) || familyTag(m).toLowerCase().includes(q) || provenance(m).toLowerCase() === q;
        const out = [];
        const here = new Set(D.models), away = (m) => !here.has(m);
        const local = ALL.filter((m) => provenance(m) === "Local" && match(m) && !away(m));
        if (local.length) out.push({ key: "local", title: "Local", ms: local });
        for (const g of GROUPS.families) { const ms = g.models.filter((m) => match(m) && !away(m)); if (ms.length) out.push({ key: g.key, title: g.title, ms }); }
        const teams = GROUPS.teams.map((t) => ({ team: t.team, ms: t.models.filter((m) => match(m) && !away(m)) })).filter((t) => t.ms.length);
        if (teams.length) out.push({ key: "team", title: "By team", ms: teams.flatMap((t) => t.ms), teams });
        const gone = ALL.filter((m) => away(m) && match(m));
        if (gone.length) out.push({ key: `away:${data.sid}`, title: `Not in ${seasonLabel(data.sid)}`, ms: gone });
        return out;
      };
      const render = () => {
        const keep = document.activeElement?.closest?.(".pk-row"), keepM = keep?.dataset.m, keepCls = document.activeElement?.className, top = list.scrollTop;
        const secs = sections();
        // two columns when the list is long, one when it's short; the panel and the chart's inset follow
        const shown = new Set(secs.flatMap((x) => x.ms)).size, two = shown > 24, wNow = pickerWidth(shown);
        list.classList.toggle("two", two);
        if (layer?.panel && Math.abs(layer.panel.offsetWidth - wNow) > 1) layer.panel.style.width = `${wNow}px`;
        const right = 16 + wNow + 24;
        if (Math.abs(right - insetGoal) > 1) { insetGoal = right; animateInset(right); }
        view.style.setProperty("--pk-shift", `${right / 2}px`); // the date control centres on the chart half
        list.innerHTML = `<div class="pk-cols">${secs.map((s) => section(s.key, s.title, s.ms, s.teams
          ? s.teams.map((t) => `<div class="pk-team">${t.team}</div>${t.ms.map(row).join("")}`).join("")
          : s.ms.map(row).join(""))).join("") || `<div class="c-empty t-small">No models match</div>`}</div>`;
        list.scrollTop = top;
        if (keepM) list.querySelector(`.pk-row[data-m="${CSS.escape(keepM)}"] .${keepCls?.split(" ")[0]}`)?.focus({ preventScroll: true });
        const n = sel.selected.length, on = sel.charted.length;
        foot.textContent = [`${n} selected`, `${on} charted`, sel.showAll && n > on ? `${n - on} grey` : null].filter(Boolean).join(" · ");
      };
      list.addEventListener("click", (e) => {
        const r = e.target.closest(".pk-row"), sec = e.target.closest(".pk-sec");
        if (sec) {
          const s = sections().find((x) => x.key === sec.dataset.key);
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
      requestAnimationFrame(render); // after the panel exists, so its width and the chart inset line up
      render();
    },
  });
  view.classList.add("picker-open"); document.body.classList.add("picker-open");
  nav.zoomTo(PREVIEW_WEEKS, { recenter: true });
  nav.setHeight(1); // normal height while previewing; closing restores the user's height zoom with the rest
}
let insetGoal = 0;

/* ---------------- chrome ---------------- */
const GL = { canvas: chartEl, container: view };
$("label-a11y").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) activate(b.dataset.m); });
for (const id of ["back", "theme", "c-rulers", "c-misses"]) new LiquidGlass($(id), GL); // back, theme: fixed, refracting the chart until they scroll off it
tooltip($("back"), "Back to the design system", { placement: "bottom" });
$("theme").addEventListener("click", () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  store.set("viz-ds-theme", root.dataset.theme);
  draw(); // the canvas resolves token colors when it draws, so redraw in the new theme
  ev?.redraw();
  requestAnimationFrame(() => LiquidGlass.updateAll());
});
renderModelsPill(); // fill it before the glass measures it
var modelsGlass = new LiquidGlass($("c-models"), GL);
$("c-models").addEventListener("click", openModelPicker);
renderPlacePill(); // fill it before the glass measures it
var placeGlass = new LiquidGlass($("c-place"), GL);
$("c-place").addEventListener("click", openPlacePicker);
var noteGlass = new LiquidGlass($("more"), GL);
$("more-btn").addEventListener("click", () => sel.setShowAll(!sel.showAll));
renderModelsPill();
const stepper = new Stepper($("c-date"), {
  values: DATES, index: DI0, label: "Forecast date", glass: GL, format: { long: fmtLong, short: fmtShort }, onChange: (i) => nav.goTo(i),
  edge: (d) => crossSeason(d), canEdge: (d) => !!neighbour(d), onLabel: (btn) => openDatePicker(btn),
});
const nav = new TimeNav({
  surface: chartEl, dates: DATES, index: DI0,
  season: data.timeline.window,
  onEdge: (d) => crossSeason(d),
  scale: () => G.x,
  ignore: (e) => !!labelAt(e.clientX, e.clientY),
  tapTarget: (e) => !!(G && lineUnder(e.clientX, e.clientY)),
  onFrame: draw,
  onWeek: (i) => { S.di = i; stepper.show(i); $("hint").style.opacity = 0; weekChanged(); },
});
window.__nav = nav; window.__sel = sel; window.__draw = () => draw(); window.__models = ALL; // for tests and benchmarks from the console
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
const chrome = $("chrome"), chromeTopEl = $("chrome-top");
function measure() {
  const vr = view.getBoundingClientRect();
  // the top bubbles are fixed to the screen, so their room is measured from the screen's top
  const t = Math.max(...[...chromeTopEl.querySelectorAll('[data-zone="tl"],[data-zone="tr"]')].map((z) => z.getBoundingClientRect().bottom));
  const b = Math.max(...[...chrome.querySelectorAll('[data-zone="bl"],[data-zone="bc"],[data-zone="br"]')].map((z) => vr.bottom - z.getBoundingClientRect().top));
  const changed = Math.abs(t - chromeTop) > 1 || Math.abs(b - chromeBottom) > 1;
  chromeTop = t; chromeBottom = b;
  view.style.setProperty("--chrome-top", `${t}px`); view.style.setProperty("--chrome-bottom", `${b}px`);
  return changed;
}
measure(); draw();
let rt = 0;
new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { measure(); draw(); }, 16); }).observe(view);
document.querySelectorAll("#chrome .c-zone, #chrome-top .c-zone:not([data-zone=tc])").forEach((z) => new ResizeObserver(() => { if (measure()) draw(); }).observe(z));
document.fonts?.ready.then(() => { measure(); draw(); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => draw()); // system theme, when not overridden


/* ---------------- seasons and places (studies/seasons-locations-goals.md) ----------------
 * ← → and the stepper cross into the next or previous season at either end, as a cut: a 150 ms
 * crossfade, the camera keeping its zoom (and pan, if it fits), height back to normal, the axis easing to
 * the new season's maximum. Drag and side scroll never cross (they rubber-band in TimeNav). */
const neighbour = (d) => SEASONS[SEASONS.indexOf(data.sid) + d] ?? null;
let switching = false;
/* the old frame fades out over the new one */
function cut(apply) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const g = document.createElement("canvas");
  g.width = chartEl.width; g.height = chartEl.height; g.getContext("2d").drawImage(chartEl, 0, 0);
  Object.assign(g.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", transition: "opacity 150ms ease" });
  if (!reduce) chartEl.after(g);
  apply();
  requestAnimationFrame(() => { g.style.opacity = "0"; });
  setTimeout(() => g.remove(), 260); // not tied to frames: a hidden tab never leaves copies behind
}
/* the axis maximum eases to a new value (no overshoot) */
let yRaf = 0;
function animateY(to) {
  cancelAnimationFrame(yRaf);
  const from = yTop, t0 = performance.now();
  if (Math.abs(to - from) < 1e-6 || matchMedia("(prefers-reduced-motion: reduce)").matches) { yTop = to; frame(); return; }
  const tick = () => { const u = Math.min(1, (performance.now() - t0) / 300); yTop = from + (to - from) * (1 - (1 - u) ** 3); draw(); if (u < 1) yRaf = requestAnimationFrame(tick); };
  yRaf = requestAnimationFrame(tick);
}
/* while data loads (rarely over 100 ms), the old plot stays, slightly dimmed after a moment */
async function load(sid, loc) {
  const dim = setTimeout(() => { chartEl.style.opacity = "0.75"; }, 80);
  try { return await loadFan(man, sid, loc); } finally { clearTimeout(dim); chartEl.style.opacity = ""; }
}
async function showSeason(sid, index) {
  if (switching) return; switching = true;
  try {
    const nd = await load(sid, place);
    cut(() => {
      useData(nd);
      nav.setTimeline({ dates: DATES, season: nd.timeline.window, index: index < 0 ? DATES.length + index : index });
      nav.setHeight(1);
      stepper.setValues(DATES, nav.week);
      draw();
    });
    animateY(niceTop(nd.YMAX));
    ev?.followSeason(sid);
    pickerRefresh?.();
  } finally { switching = false; }
}
function crossSeason(d) {
  const sid = neighbour(d);
  if (!sid) return false;
  showSeason(sid, d > 0 ? 0 : -1);
  return true;
}
/* any round in any season: the date picker, a heatmap cell */
function goToRound(sid, iso) {
  if (sid && sid !== data.sid) { const tl = timeline(man, sid); showSeason(sid, Math.max(0, tl.iso.indexOf(iso))); return; }
  const i = D.dates.indexOf(iso); if (i >= 0) nav.goTo(i, { recenter: "auto" });
}
/* another place: the same date, zoom and focus; the plot crossfades and the axis eases to the new scale */
async function setPlace(loc) {
  if (loc === place || switching) return;
  switching = true;
  try {
    const nd = await load(data.sid, loc);
    place = loc; store.set("viz-place", loc);
    const recent = [loc, ...(JSON.parse(store.get("viz-places") || "[]")).filter((x) => x !== loc)].slice(0, 4);
    store.set("viz-places", JSON.stringify(recent));
    cut(() => { useData(nd); nav.setHeight(1); draw(); });
    animateY(niceTop(nd.YMAX));
    renderPlacePill();
    ev?.followPlace();
  } finally { switching = false; }
}

/* ---------------- the date picker ----------------
 * Season chips, then that season's forecast rounds as a calendar: one row per month, a button per round.
 * Nothing else per date (counts and per-model marks were tried and dropped: the chart and the scores
 * carry that). ← → ↑ ↓ move through the days, a letter jumps to a month, Enter goes, Escape closes. */
function openDatePicker(btn) {
  let shown = data.sid;
  openPopover(btn, { width: 340, placement: "top", morph: false, className: "dp-panel", content: (body, layer) => {
    const paint = () => {
      const months = d3.groups(man.seasonById.get(shown).rounds, (r) => r.slice(0, 7));
      const cur = shown === data.sid ? D.dates[nav.week] : null;
      body.innerHTML = `<div class="dp-seasons">${[...SEASONS].reverse().map((sid) => `<button type="button" class="dp-chip${sid === shown ? " on" : ""}" data-sid="${sid}">${seasonLabel(sid)}</button>`).join("")}</div>
        <div class="dp-grid" role="grid" aria-label="${seasonLabel(shown)} forecast dates">${months.map(([ym, rs]) => `<div class="dp-row" role="row"><span class="dp-m">${d3.utcFormat("%b")(new Date(ym + "-01T00:00:00Z"))}</span>${rs.map((r) => `<button type="button" class="dp-day${r === cur ? " on" : ""}" role="gridcell" data-r="${r}" aria-label="${fmtLong(new Date(r + "T00:00:00Z"))}">${+r.slice(8)}</button>`).join("")}</div>`).join("")}</div>`;
      body.querySelectorAll(".dp-chip").forEach((b) => b.addEventListener("click", () => { shown = b.dataset.sid; paint(); body.querySelector(".dp-day")?.focus({ preventScroll: true }); }));
      body.querySelectorAll(".dp-day").forEach((b) => b.addEventListener("click", () => { layer.close(true); goToRound(shown, b.dataset.r); }));
    };
    body.addEventListener("keydown", (e) => {
      const days = [...body.querySelectorAll(".dp-day")], i = days.indexOf(document.activeElement);
      const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 }[e.key];
      if (d) { e.preventDefault(); e.stopPropagation(); if (i >= 0) days[Math.max(0, Math.min(days.length - 1, i + d))].focus({ preventScroll: true }); else days[0]?.focus({ preventScroll: true }); }
      else if (/^[a-z]$/i.test(e.key) && !e.metaKey && !e.ctrlKey) { const row = [...body.querySelectorAll(".dp-row")].find((r) => r.querySelector(".dp-m").textContent.toLowerCase().startsWith(e.key.toLowerCase())); row?.querySelector(".dp-day")?.focus({ preventScroll: true }); }
    });
    paint();
    requestAnimationFrame(() => (body.querySelector(".dp-day.on") || body.querySelector(".dp-day"))?.focus({ preventScroll: true }));
  } });
}

/* ---------------- the Location bubble: search, recent, a US tile map ---------------- */
const TILES = { AK: [0, 0], ME: [10, 0], VT: [9, 1], NH: [10, 1], WA: [0, 2], ID: [1, 2], MT: [2, 2], ND: [3, 2], MN: [4, 2], IL: [5, 2], WI: [6, 2], MI: [7, 2], NY: [8, 2], RI: [9, 2], MA: [10, 2],
  OR: [0, 3], NV: [1, 3], WY: [2, 3], SD: [3, 3], IA: [4, 3], IN: [5, 3], OH: [6, 3], PA: [7, 3], NJ: [8, 3], CT: [9, 3],
  CA: [0, 4], UT: [1, 4], CO: [2, 4], NE: [3, 4], MO: [4, 4], KY: [5, 4], WV: [6, 4], VA: [7, 4], MD: [8, 4], DE: [9, 4],
  AZ: [1, 5], NM: [2, 5], KS: [3, 5], AR: [4, 5], TN: [5, 5], NC: [6, 5], SC: [7, 5], DC: [8, 5],
  OK: [3, 6], LA: [4, 6], MS: [5, 6], AL: [6, 6], GA: [7, 6], HI: [0, 7], TX: [3, 7], FL: [8, 7], PR: [10, 7] };
function renderPlacePill() {
  const pill = $("c-place");
  pill.querySelector(".label").textContent = placeName(place);
  pill.setAttribute("aria-label", `Location: ${placeName(place)}. Change`);
  placeGlass?.update();
}
function openPlacePicker() {
  openPopover($("c-place"), { width: 420, morph: true, className: "lp-panel", content: (body, layer) => {
    const recent = JSON.parse(store.get("viz-places") || "[]").filter((x) => x !== place && man.locIndex.has(x));
    body.innerHTML = `<div class="lp-head"><label class="pop-search">${icon.search}<input type="search" placeholder="Search 53 locations" aria-label="Search locations"></label></div>
      ${recent.length ? `<div class="lp-recent">${recent.map((id) => `<button type="button" class="dp-chip" data-loc="${id}">${placeName(id)}</button>`).join("")}</div>` : ""}
      <div class="lp-map"><button type="button" class="lp-us${place === "US" ? " on" : ""}" data-loc="US">United States</button>
      <div class="lp-tiles">${man.locations.filter((l) => TILES[l.abbr]).map((l) => `<button type="button" class="lp-tile${l.id === place ? " on" : ""}" data-loc="${l.id}" data-abbr="${l.abbr}" style="grid-column:${TILES[l.abbr][0] + 1};grid-row:${TILES[l.abbr][1] + 1}" title="${l.name}">${l.abbr}</button>`).join("")}</div></div>`;
    const input = body.querySelector("input"), tiles = [...body.querySelectorAll("[data-loc]")];
    const pick = (id) => { layer.close(true); setPlace(id); };
    tiles.forEach((b) => { b.addEventListener("click", () => pick(b.dataset.loc)); b.addEventListener("pointerenter", () => loadFan(man, data.sid, b.dataset.loc)); }); // hover prefetches
    const matches = () => { const q = input.value.trim().toLowerCase(); return q ? man.locations.filter((l) => l.name.toLowerCase().includes(q) || l.abbr.toLowerCase() === q || l.id.toLowerCase() === q).sort((a, b) => (b.abbr.toLowerCase() === q) - (a.abbr.toLowerCase() === q) || (b.name.toLowerCase().startsWith(q)) - (a.name.toLowerCase().startsWith(q))) : []; };
    input.addEventListener("input", () => { const ms = new Set(matches().map((l) => l.id)); body.classList.toggle("filtering", !!input.value.trim()); tiles.forEach((b) => b.classList.toggle("match", ms.has(b.dataset.loc))); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { const m = matches()[0]; if (m) pick(m.id); } if (e.key === "ArrowDown") { e.preventDefault(); body.querySelector(".lp-tile.on, .lp-us.on, .lp-tile")?.focus({ preventScroll: true }); } });
    // arrows move across the tile map by its grid
    body.querySelector(".lp-map").addEventListener("keydown", (e) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key], at = document.activeElement?.dataset.abbr;
      if (!d) return; e.preventDefault(); e.stopPropagation();
      if (!at) { body.querySelector(".lp-tile")?.focus({ preventScroll: true }); return; }
      const [x, y] = TILES[at]; let best = null, bd = Infinity;
      for (const [ab, [tx, ty]] of Object.entries(TILES)) { const dx = tx - x, dy = ty - y; if ((d[0] && Math.sign(dx) === d[0]) || (d[1] && Math.sign(dy) === d[1])) { const dist = (d[0] ? Math.abs(dx) + 2 * Math.abs(dy) : Math.abs(dy) + 2 * Math.abs(dx)); if (dist < bd) { bd = dist; best = ab; } } }
      if (best) body.querySelector(`[data-abbr="${best}"]`)?.focus({ preventScroll: true });
    });
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  } });
}

/* ---------------- scores, under the chart (studies/evaluation-goals.md) ----------------
 * The same section as studies/scores.html, on the same selection. Linked both ways: hovering a row (or a
 * heatmap row) previews a charted model on the chart, hovering a model on the chart lights its row; the
 * dot charts a model; a heatmap cell shows that forecast on the chart. The scope line lifts into a bubble
 * at the top centre once it scrolls under the top chrome. */
var ev = null;
function scoresChanged() { if (!ev) return; cancelAnimationFrame(scoresChanged.raf); scoresChanged.raf = requestAnimationFrame(() => ev.update()); }
function weekChanged() { if (!ev) return; cancelAnimationFrame(weekChanged.raf); weekChanged.raf = requestAnimationFrame(() => ev.renderHeat()); }
ev = mountScores($("scores"), {
  man, seasons: [data.sid], chartLocation: () => place, placeName,
  selected: () => sel.selected, slotOf: (m) => sel.slotOf(m), seriesColor: seriesVar,
  currentRound: () => isoDay(DATES[nav.week]),
  onAdd: () => openModelPicker(),
  onChart: (m) => sel.toggleChart(m),
  onPreview: (m) => {
    ev.highlight(m);
    if (m) mouse = null; // the pointer is over the scores, not the chart
    // a charted model previews on the chart exactly as hovering its label does (only while some of the chart is on screen)
    const p = m && sel.isCharted(m) && view.getBoundingClientRect().bottom > 0 ? m : null;
    if (p) { fromScores = true; if (S.preview !== p) { S.preview = p; frame(); } }
    else if (fromScores) { fromScores = false; S.preview = null; frame(); }
  },
  onCell: ({ m, axis, col }) => {
    // show it on the chart: that week (when it's one of the chart's), the model charted and focused, the chart scrolled into view
    if (axis === "weeks") goToRound(col.season, col.label);
    if (axis === "locations") { const l = man.locations.find((x) => x.abbr === col.label); if (l) setPlace(l.id); }
    if (m !== D.baseline && !sel.isCharted(m)) sel.chart(m);
    S.focus = m; S.preview = null; fromScores = false; draw();
    scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  },
});
ev.cloneScope($("scope-bubble"));
var scopeGlass = new LiquidGlass($("scope-bubble"), GL); // the same glass as the other top bubbles (clear, over the page)
await ev.update();
// the lift: once the scope line passes under the top chrome, the bubble shows it instead
let lifted = false;
function onScroll() {
  const zTop = Math.min(...[...chrome.querySelectorAll('[data-zone="bl"],[data-zone="bc"]')].map((z) => z.getBoundingClientRect().top));
  chrome.classList.toggle("tucked", zTop < chromeTop + 12);
  const up = ev.scopeEl.getBoundingClientRect().top < chromeTop - 8;
  if (up === lifted) return;
  lifted = up;
  ev.scopeEl.classList.toggle("lifted", up);
  $("scope-bubble").classList.toggle("show", up);
  if (up) requestAnimationFrame(() => scopeGlass.update());
}
addEventListener("scroll", onScroll, { passive: true });
onScroll();
window.__ev = ev; window.__setPlace = setPlace; window.__data = () => data; window.__goToRound = goToRound; // for tests
