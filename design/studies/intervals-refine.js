/* Interval refinement, full screen. This page is the reference for the fan chart: the drawing lives
 * in lib/chart.js (fanChart); this file adds the page around it: focus state, the hover readout, the
 * chrome, and time keys (left/right always step the forecast date). Decisions: intervals-goals.md. */
import { LiquidGlass } from "../lib/glass.js";
import { loadData, fanChart, bands, short, WEEK } from "../lib/chart.js";
import { Segmented, Stepper, tooltip } from "../lib/controls.js";
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

const SETS = {
  close: ["UMass-flusion", "UMass-AR6_pooled", "UMass-gbqr_4src"],
  apart: ["UMass-flusion", "UMass-WISAR6_fourthroot_adaptive_t", "UMass-AR2"],
  skewed: ["UMass-flusion", "axial-tfm_L4v5", "UMass-timesfm3_nhsn"],
  baseline: ["UMass-flusion", "UMass-AR6_pooled", D.baseline],
};
const S = { set: "close", count: 3, di: DI0, rulers: false, misses: true, focus: null, preview: null, hoverH: null };
const focused = () => S.preview ?? S.focus;

const view = $("view"), svg = d3.select("#chart");
let chromeTop = 70, chromeBottom = 70, G = null;

function models() {
  let slot = 0;
  return SETS[S.set].slice(0, S.count).map((m) => ({ m, slot: m === D.baseline ? "baseline" : slot++ }));
}

/* ---------------- draw ---------------- */
function draw() {
  const w = svg.node().clientWidth, compact = sizeClass(view) === "compact";
  const u = nav.mix; // 0 close up, 1 Season
  const P = fanChart(svg, data, {
    id: "chart-src", models: models(), t: nav.T, domain: nav.domain(),
    // the right margin holds the model labels close up; in Season they sit at the fan's end instead
    pad: { l: 64, r: 168 + (56 - 168) * u, t: chromeTop + 24, b: chromeBottom + 48 }, topClear: chromeTop,
    focus: focused(), hover: nav.moving ? null : S.hoverH, rulers: S.rulers && u < 0.001, misses: S.misses,
    onLabel: toggleFocus,
  });
  G = { ...P, compact, w };
  readout();
  previewUnderPointer();
  // panned so far that the forecast is off-screen: show which way it is, and bring it back on click
  const xr = P.x(P.ref), off = xr < 0 ? "left" : xr > w ? "right" : null, rc = $("recenter"), wrap = $("recenter-wrap");
  if (wrap.hidden !== !off) { wrap.hidden = !off; if (off) requestAnimationFrame(() => rcGlass?.update()); }
  if (off) {
    wrap.className = off;
    rc.querySelector(".arr").textContent = off === "left" ? "←" : "";
    rc.querySelector(".lb").textContent = `${fmtShort(DATES[nav.week])} forecast${off === "right" ? " →" : ""}`;
  }
}

function toggleFocus(m) {
  S.focus = S.focus === m ? null : m; S.preview = null;
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
  el.innerHTML = `<div class="when"><span>${fmtShort(hp.date)}</span><span>${hp.h === 0 ? "this week" : `${hp.h} wk ahead`} · 95%</span></div>
    <table>${rows.map(({ b, p }) => {
      const out = obs != null && (obs < p.lo || obs > p.hi);
      return `<tr class="${hasFocus && b.m !== f ? "dim" : ""}"><td><span class="nm"><i style="background:${b.c}"></i><span class="t">${short(b.m)}</span></span></td><td class="rng">${fmtN(p.lo)} – ${fmtN(p.hi)}</td><td class="wd">±${fmtHalf((p.hi - p.lo) / 2)}</td></tr>`;
    }).join("")}</table>
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
chartEl.addEventListener("pointermove", (e) => { if (!e.target.closest(".fc-label")) hoverAt(e.clientX); });
chartEl.addEventListener("pointerdown", (e) => { if (!e.target.closest(".fc-label")) hoverAt(e.clientX); });
chartEl.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { mouse = null; setHover(null); previewUnderPointer(); } });

/* Focus preview follows whatever label is under the mouse, checked after every frame. Enter/leave
 * events can't do this: the chart is redrawn each frame, so a label that moves under or away from a
 * still mouse (while the date changes) never gets a leave event, and its highlight used to stick. */
let mouse = null;
chartEl.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") { mouse = { x: e.clientX, y: e.clientY }; previewUnderPointer(); } });
function previewUnderPointer() {
  let m = null;
  if (mouse && !nav.moving) {
    for (const g of chartEl.querySelectorAll(".fc-label")) {
      const r = g.getBoundingClientRect();
      if (mouse.x >= r.left && mouse.x <= r.right && mouse.y >= r.top && mouse.y <= r.bottom) { m = d3.select(g).datum().s.m; break; }
    }
  }
  if (m !== S.preview) { S.preview = m; frame(); }
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.focus && !document.querySelector(".c-float")) { S.focus = null; draw(); } });

/* ---------------- chrome ---------------- */
const GL = { source: "#chart-src", container: view };
for (const id of ["back", "theme", "c-rulers", "c-misses"]) new LiquidGlass($(id), GL);
tooltip($("back"), "Back to the design system", { placement: "bottom" });
$("theme").addEventListener("click", () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  store.set("viz-ds-theme", root.dataset.theme);
  requestAnimationFrame(() => LiquidGlass.updateAll());
});
new Segmented($("c-set"), { label: "Models", value: S.set, glass: GL, items: [{ value: "close", label: "Close" }, { value: "apart", label: "Apart" }, { value: "skewed", label: "Skewed" }, { value: "baseline", label: "+ Baseline" }], onChange: (v) => { S.set = v; S.focus = null; draw(); } });
new Segmented($("c-count"), { label: "Models shown", value: "3", glass: GL, items: [{ value: "1", label: "1" }, { value: "2", label: "2" }, { value: "3", label: "3" }], onChange: (v) => { S.count = +v; if (!SETS[S.set].slice(0, S.count).includes(S.focus)) S.focus = null; draw(); } });
const stepper = new Stepper($("c-date"), { values: DATES, index: DI0, label: "Forecast date", glass: GL, format: { long: fmtLong, short: fmtShort }, onChange: (i) => nav.goTo(i) });
const zoomSeg = new Segmented($("c-zoom"), { label: "Time span", value: "close", glass: GL, items: [{ value: "close", label: "Forecast" }, { value: "season", label: "Season" }], onChange: (v) => nav.setSeason(v === "season") });
tooltip($("c-zoom"), "Pinch or = − to zoom, ⌘ + side scroll to pan. Double-click the chart to switch.", { placement: "top" });
const nav = new TimeNav({
  surface: chartEl, dates: DATES, index: DI0,
  season: [truth[0].date, new Date(Math.max(+truth.at(-1).date, +DATES.at(-1) + 3 * WEEK))],
  scale: () => G.x,
  ignore: (e) => !!e.target.closest(".fc-label"),
  onFrame: draw,
  onWeek: (i) => { S.di = i; if (stepper.index !== i) { stepper.index = i; stepper.render(true); } $("hint").style.opacity = 0; },
  onZoom: (m) => { if (zoomSeg.value !== m) zoomSeg.set(m, false); },
});
window.__nav = nav; // for testing from the console
$("recenter").addEventListener("click", () => nav.recenter());
var rcGlass = new LiquidGlass($("recenter"), GL);
for (const [id, key] of [["c-rulers", "rulers"], ["c-misses", "misses"]]) $(id).addEventListener("click", () => { S[key] = !S[key]; $(id).setAttribute("aria-pressed", S[key]); draw(); });

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
