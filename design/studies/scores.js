/* Score study: the leaderboard and heatmap from studies/evaluation-goals.md on real scores (three seasons),
 * with three candidate diverging palettes. Scoring is lib/scores.js; this file is the page. */
import { LiquidGlass } from "../lib/glass.js";
import { Segmented, openPopover, icon } from "../lib/controls.js";
import { loadManifest, loadSeason, score, slices, seasonLabel } from "../lib/scores.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
root.dataset.theme = store.get("viz-theme") || "dark";

/* Diverging ramps (cool = better / too wide, warm = worse / too narrow), 9 steps with a grey middle.
 * Made in OKLCH and checked with the dataviz validator: poles pass every check in both modes (band, chroma,
 * CVD ΔE ≥ 24, contrast ≥ 5:1); the inner steps recede toward the surface by design. */
const RAMPS = {
  "blue-orange": { light: ["#0267c7", "#4689db", "#75abef", "#a3ccff", "#ebebeb", "#f8b996", "#e19164", "#ca6a2b", "#b13f00"], dark: ["#4b92ea", "#3e77be", "#325e95", "#26466d", "#2e2e2e", "#65371b", "#894a22", "#af5d28", "#d7712e"] },
  "blue-red": { light: ["#006ac5", "#388cd9", "#6daded", "#9eceff", "#ebebeb", "#fdb3af", "#e78a87", "#d06060", "#b63039"], dark: ["#3c95e8", "#337abd", "#2a6093", "#21476c", "#2e2e2e", "#683232", "#8d4342", "#b45454", "#dd6666"] },
  "violet-amber": { light: ["#6b50c2", "#8876d7", "#a79beb", "#c7c0fe", "#ebebeb", "#eebf8a", "#d69a51", "#bd7500", "#a44f00"], dark: ["#917ee5", "#7667ba", "#5d5292", "#443d6b", "#2e2e2e", "#5f3c0c", "#815105", "#a46700", "#c97d00"] },
};
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
let rampRgb = [];
function setRamp() { rampRgb = RAMPS[S.palette][root.dataset.theme].map(hexRgb); }
/* x in [-1, 1]: -1 best (cool pole), 0 neutral, 1 worst (warm pole). */
function divColor(x) {
  if (!(x === x)) return null;
  const p = (Math.max(-1, Math.min(1, x)) + 1) * 4, i = Math.min(7, Math.floor(p)), f = p - i, a = rampRgb[i], b = rampRgb[i + 1];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
}
const ratioColor = (r) => divColor(Math.log2(r));               // ½× → -1, 2× → +1
const covColor = (cov, target) => divColor((target - cov) / 25);  // 25 points under target → warm pole

const man = await loadManifest("../data/");
const SEASONS = man.seasons.map((s) => s.id);
await Promise.all(SEASONS.map((id) => loadSeason(man, id)));

/* the five charted (their series slot) and a working selection, as on the fan chart page */
const CHARTED = { "UMass-flusion": 0, "UMass-gbqr_4src": 1, "UMass-AR2": 2, "UMass-timesfm3_nhsn": 3, "axial-tfm_L4v5": 4 };
const SELECTED = [...Object.keys(CHARTED), "UMass-gbqr_4src_spatial", "UMass-flusion_4src_spatial", "UMass-AR6_pooled", "UMass-trends_ensemble", "UMass-chronos_small", "UMass-gbqr_1src", "UMass-WISAR6_fourthroot_adaptive_t"];

const S = {
  palette: store.get("score-palette") || "blue-orange", rows: "selected",
  scope: { seasons: [SEASONS.at(-1)], locations: "states", horizons: [0, 1, 2, 3], shared: false, among: "all" },
  sort: { key: "rel", dir: 1 }, heatAxis: "weeks",
};
setRamp();

const short = (m) => (m.includes("-") ? m.split("-").slice(1).join("-") : m);
const team = (m) => man.meta[m]?.team_abbr || (m.includes("-") ? m.split("-")[0] : "");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (v, d = 2) => (v === v ? v.toFixed(d) : "–");
const fmtW = (v) => (v === v ? (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1)) : "–");
const dotFor = (m) => (m in CHARTED ? `var(--series-${CHARTED[m] + 1})` : null);

let result = null;
function compute() {
  const scope = { ...S.scope, selected: SELECTED };
  result = score(man, scope);
}

/* ---------------------------------------------------------------- scope line */
const DEFAULT = { seasons: [SEASONS.at(-1)].join(), locations: "states", horizons: "0,1,2,3", shared: false, among: "all" };
function scopeText() {
  const sc = S.scope;
  const seasons = sc.seasons.length === SEASONS.length && SEASONS.length > 1 ? "All seasons" : sc.seasons.length > 1 ? `${sc.seasons.length} seasons` : seasonLabel(sc.seasons[0]);
  const H = sc.horizons, hz = H.length === 4 ? "0–3 wk" : H.length === 1 ? `${H[0]} wk` : H.join(", ") + " wk";
  const metric = "Relative WIS" + (sc.shared ? " · shared" : "") + (sc.among === "selected" ? " · among selected" : "");
  return [
    { k: "metric", t: metric, set: sc.shared || sc.among !== "all" },
    { k: "loc", t: sc.locations === "states" ? "All states" : "US", set: sc.locations !== "states" },
    { k: "dates", t: seasons, set: sc.seasons.join() !== DEFAULT.seasons },
    { k: "h", t: hz, set: H.length !== 4 },
  ];
}
function renderScope() {
  const el = $("scope");
  el.innerHTML = scopeText().map((f, i) => `${i ? '<span class="dot">·</span>' : ""}<button class="f${f.set ? " set" : ""}" data-k="${f.k}">${esc(f.t)}</button>`).join("")
    + `<button class="exp" aria-label="Export">${icon.download || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>'}</button>`;
  el.querySelectorAll(".f").forEach((b) => b.addEventListener("click", () => openScope(b)));
}
function checklist(body, groups, onPick) {
  const box = document.createElement("div"); box.className = "checks";
  groups.forEach((g, gi) => {
    if (gi) box.insertAdjacentHTML("beforeend", '<div class="sep"></div>');
    if (g.title) box.insertAdjacentHTML("beforeend", `<div class="hd">${esc(g.title)}</div>`);
    for (const it of g.items) {
      const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "menuitemcheckbox"); b.setAttribute("aria-checked", !!it.on);
      b.innerHTML = `<span>${esc(it.label)}</span><span class="ck">${it.on ? icon.check : ""}</span>`;
      b.addEventListener("click", () => { onPick(it); });
      box.appendChild(b);
    }
  });
  body.appendChild(box);
}
function openScope(btn) {
  const k = btn.dataset.k, sc = S.scope;
  const groups = () => k === "metric" ? [
      { items: [{ label: "Relative WIS", on: true, v: null }] },
      { items: [{ label: "Shared forecasts only", on: sc.shared, v: "shared" }] },
      { title: "Rank among", items: [{ label: "Every model in scope", on: sc.among === "all", v: "among:all" }, { label: "Selected", on: sc.among === "selected", v: "among:selected" }] },
    ] : k === "loc" ? [{ items: [{ label: "All states", on: sc.locations === "states", v: "states" }, { label: "US", on: sc.locations === "US", v: "US" }] }]
    : k === "dates" ? [{ title: "Seasons", items: [...SEASONS].reverse().map((s) => ({ label: seasonLabel(s), on: sc.seasons.includes(s), v: s })) }, { items: [{ label: "All", on: sc.seasons.length === SEASONS.length, v: "all" }] }]
    : [{ items: [0, 1, 2, 3].map((h) => ({ label: `${h} wk ahead`, on: sc.horizons.includes(h), v: h })) }];
  openPopover(btn, { width: 260, morph: false, content: (body) => {
    const paint = () => { body.innerHTML = ""; checklist(body, groups(), (it) => { apply(k, it.v); paint(); }); };
    paint();
  } });
}
function apply(k, v) {
  const sc = S.scope;
  if (k === "metric") { if (v === "shared") sc.shared = !sc.shared; else if (v?.startsWith("among:")) sc.among = v.slice(6); }
  else if (k === "loc") sc.locations = v;
  else if (k === "dates") {
    if (v === "all") sc.seasons = sc.seasons.length === SEASONS.length ? [SEASONS.at(-1)] : [...SEASONS];
    else { const on = sc.seasons.includes(v); if (on && sc.seasons.length > 1) sc.seasons = sc.seasons.filter((s) => s !== v); else if (!on) sc.seasons = SEASONS.filter((s) => s === v || sc.seasons.includes(s)); }
  } else if (k === "h") { const on = sc.horizons.includes(v); if (on && sc.horizons.length > 1) sc.horizons = sc.horizons.filter((h) => h !== v); else if (!on) sc.horizons = [...sc.horizons, v].sort(); }
  update();
}

/* ---------------------------------------------------------------- leaderboard */
const COLS = [
  { key: "rank" }, { key: "name", label: "Model", sort: "name" }, { key: "rel", label: "Rel. WIS", num: true, sort: "rel" },
  { key: "lolli" }, { key: "wis", label: "WIS", num: true, sort: "wis" }, { key: "c50", label: "50%", num: true, sort: "c50" }, { key: "c95", label: "95%", num: true, sort: "c95" }, { key: "plus" },
];
const AX = { lo: Math.log(0.4), hi: Math.log(1.6) };
function renderHead() {
  const w = lolliWidth();
  const pos = (v) => ((Math.log(v) - AX.lo) / (AX.hi - AX.lo)) * w;
  $("lb-head").innerHTML = COLS.map((c) => {
    if (c.key === "rank") return "<span></span>";
    if (c.key === "lolli") return `<div class="axis">${[0.5, 1, 1.5].map((v) => `<span style="left:${pos(v)}px">${v}</span>`).join("")}</div>`;
    if (c.key === "plus") return `<button class="plus" aria-label="Columns">${icon.plus || "+"}</button>`;
    const on = S.sort.key === c.sort, ar = on ? (S.sort.dir > 0 ? "▲" : "▼") : "";
    return `<button class="h${c.num ? " num" : ""}${on ? " on" : ""}" data-sort="${c.sort}">${c.num ? `<span class="ar">${ar}</span>` : ""}${c.label}${c.num ? "" : `<span class="ar">${ar}</span>`}</button>`;
  }).join("");
  $("lb-head").querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.sort; S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: 1 }; renderBoard();
  }));
}
function lolliWidth() { const c = $("lb-head").children[3]; return c ? c.getBoundingClientRect().width : 168; }
const sortVal = (r, k) => k === "name" ? short(r.m).toLowerCase() : k === "c50" ? Math.abs(r.cov[50] - 50) : k === "c95" ? Math.abs(r.cov[95] - 95) : r[k];
function lolli(r, w) {
  if (!(r.rel === r.rel) || w < 20) return "";
  const x = (v) => Math.max(0, Math.min(w, ((Math.log(v) - AX.lo) / (AX.hi - AX.lo)) * w));
  const x1 = x(1), xv = x(r.rel), c = ratioColor(r.rel), base = r.m === result.baseline;
  return `<svg class="lolli" width="${w}" height="30" viewBox="0 0 ${w} 30"><line x1="${x1}" x2="${x1}" y1="4" y2="26" stroke="var(--ink-faint)" stroke-width="1"/>`
    + (base ? "" : `<line x1="${x1}" x2="${xv}" y1="15" y2="15" stroke="${c}" stroke-width="1.5"/>`)
    + `<circle cx="${xv}" cy="15" r="3.5" fill="${base ? "var(--ink-tertiary)" : c}"/></svg>`;
}
function renderBoard() {
  renderHead();
  const w = lolliWidth();
  let rows = result.rows.filter((r) => S.rows === "all" || SELECTED.includes(r.m) || r.m === result.baseline);
  const ranked = rows.filter((r) => r.rel === r.rel), un = rows.filter((r) => !(r.rel === r.rel));
  const { key, dir } = S.sort;
  ranked.sort((a, b) => { const va = sortVal(a, key), vb = sortVal(b, key); return (va < vb ? -1 : va > vb ? 1 : a.m.localeCompare(b.m)) * dir; });
  // rank by the sorted score; ties share a number
  let prev = null, rank = 0;
  const html = (r, i, ranked) => {
    let rk = "";
    if (ranked && key !== "name") { const v = sortVal(r, key); if (v !== prev) rank = i + 1; prev = v; rk = rank; }
    const d = dotFor(r.m), base = r.m === result.baseline, small = r.n && r.n < 10;
    const cov = (lv) => r.n ? `<span class="cv"><b style="background:${covColor(r.cov[lv], lv)}"></b>${Math.round(r.cov[lv])}</span>` : "–";
    const partial = r.n && r.possible && r.n < r.possible ? `<svg width="10" height="10" viewBox="0 0 10 10" aria-label="${r.n} of ${r.possible} forecasts"><circle cx="5" cy="5" r="4" fill="none" stroke="var(--ink-tertiary)" stroke-width="1"/><path d="M5 5 L5 1 A4 4 0 ${r.n / r.possible > 0.5 ? 1 : 0} 1 ${5 + 4 * Math.sin(2 * Math.PI * r.n / r.possible)} ${5 - 4 * Math.cos(2 * Math.PI * r.n / r.possible)} Z" fill="var(--ink-tertiary)"/></svg>` : "";
    const why = r.status === "ok" ? "" : r.seasons.length ? "no forecasts in scope" : "other seasons only";
    return `<div class="row lb-grid${base ? " base" : ""}${small || !ranked ? " dimmed" : ""}" data-m="${esc(r.m)}" title="${esc(r.m)}${why ? " · " + why : ""}">
      <span class="rk">${rk}</span>
      <span class="nm"><i ${d ? `style="background:${d}"` : 'class="none"'}></i><span class="t">${esc(base ? "Baseline" : short(r.m))}</span>${base ? "" : `<span class="tm">${esc(team(r.m))}</span>`}${partial}</span>
      <span class="v">${fmt(r.rel)}</span><span class="lolli-cell">${lolli(r, w)}</span>
      <span class="v">${fmtW(r.wis)}</span><span class="v">${cov(50)}</span><span class="v">${cov(95)}</span><span></span></div>`;
  };
  $("lb-rows").innerHTML = ranked.map((r, i) => html(r, i, true)).join("") + (un.length ? '<div class="rule"></div>' + un.map((r, i) => html(r, i, false)).join("") : "");
}

/* ---------------------------------------------------------------- heatmap */
const HEAT = { row: 22, gap: 2, head: 30, label: 0 };
let heatGeom = null;
function renderHeatLine() {
  const axisName = { weeks: "Weeks", locations: "Locations", horizons: "Horizons" }[S.heatAxis];
  $("heat-line").innerHTML = `<button class="f" id="hl-axis">Models × ${axisName}</button><span class="dot">·</span><button class="f">Rel. WIS</button>
    <span class="legend">½×<canvas id="legend" width="240" height="12"></canvas>2×</span>`;
  $("hl-axis").addEventListener("click", (e) => openPopover(e.currentTarget, { width: 220, morph: false, content: (body) => {
    const paint = () => { body.innerHTML = ""; checklist(body, [{ title: "Columns", items: ["weeks", "locations", "horizons"].map((a) => ({ label: a[0].toUpperCase() + a.slice(1), on: S.heatAxis === a, v: a })) }], (it) => { S.heatAxis = it.v; renderHeat(); renderHeatLine(); paint(); }); };
    paint();
  } }));
  const lg = $("legend"), g = lg.getContext("2d");
  for (let x = 0; x < 240; x++) { g.fillStyle = divColor((x / 239) * 2 - 1); g.fillRect(x, 0, 1, 12); }
}
function renderHeat() {
  const sl = slices(man, result, S.heatAxis);
  const rows = result.rows.filter((r) => (S.rows === "all" || SELECTED.includes(r.m) || r.m === result.baseline) && r.rel === r.rel)
    .sort((a, b) => a.rel - b.rel);
  const cv = $("heat"), W = cv.parentElement.clientWidth, dpr = devicePixelRatio || 1;
  const cols = sl.cols, C = cols.length;
  const mg = cv.getContext("2d"); mg.font = `13px ${getComputedStyle(root).getPropertyValue("--font-sans")}`;
  const labelW = Math.min(300, 32 + 12 + 15 + Math.max(...rows.map((r) => mg.measureText(r.m === result.baseline ? "Baseline" : short(r.m)).width)) + 24);
  // season breaks get a wider gap
  const breaks = cols.map((c, i) => (i && S.heatAxis === "weeks" && c.season !== cols[i - 1].season ? 1 : 0));
  const nb = breaks.reduce((a, b) => a + b, 0), BG = 12;
  const cw = Math.max(4, (W - labelW - nb * BG) / C);
  const H = HEAT.head + rows.length * HEAT.row;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + "px";
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const css = getComputedStyle(root), ink = (n) => css.getPropertyValue(n).trim();
  const xs = []; let x = labelW; cols.forEach((c, i) => { x += breaks[i] * BG; xs.push(x); x += cw; });
  // header labels
  g.font = `10.5px ${ink("--font-mono")}`; g.fillStyle = ink("--ink-tertiary"); g.textBaseline = "alphabetic";
  if (S.heatAxis === "weeks") {
    let lastM = null, lastSeason = null;
    cols.forEach((c, i) => {
      const d = new Date(c.label + "T00:00:00Z"), m = d.getUTCMonth();
      if (c.season !== lastSeason) { g.fillStyle = ink("--ink-secondary"); g.font = `500 11px ${ink("--font-sans")}`; g.fillText(seasonLabel(c.season), xs[i], 11); g.font = `10.5px ${ink("--font-mono")}`; g.fillStyle = ink("--ink-tertiary"); lastSeason = c.season; lastM = m; return; }
      if (m !== lastM && cw * 2 > 10) { g.fillText(d.toLocaleString("en", { month: "short", timeZone: "UTC" }), xs[i], 24); lastM = m; }
    });
  } else {
    const every = Math.ceil(16 / cw);
    cols.forEach((c, i) => { if (i % every === 0) { g.textAlign = "center"; g.fillText(S.heatAxis === "horizons" ? `${c.label} wk` : c.label, xs[i] + cw / 2, 22); } });
    g.textAlign = "left";
  }
  // rows
  rows.forEach((r, ri) => {
    const y = HEAT.head + ri * HEAT.row, cells = sl.cells.get(r.m);
    const d = dotFor(r.m);
    if (d) { g.fillStyle = css.getPropertyValue(d.slice(4, -1)).trim(); g.beginPath(); g.arc(32 + 12 + 3.5, y + HEAT.row / 2, 3.5, 0, 7); g.fill(); }
    g.fillStyle = r.m === result.baseline ? ink("--ink-tertiary") : ink("--ink-primary"); g.font = `13px ${ink("--font-sans")}`; g.textBaseline = "middle";
    let label = r.m === result.baseline ? "Baseline" : short(r.m); const maxW = labelW - 32 - 12 - 15 - 16;
    while (g.measureText(label).width > maxW && label.length > 4) label = label.slice(0, -2) + "…";
    g.fillText(label, 32 + 12 + 15, y + HEAT.row / 2 + 0.5);
    cells.forEach((c, ci) => {
      const col = ratioColor(c.ratio); if (!col) return;
      g.fillStyle = col; g.beginPath(); g.roundRect(xs[ci], y + 1, cw - HEAT.gap, HEAT.row - HEAT.gap, Math.min(3, cw / 4)); g.fill();
    });
  });
  heatGeom = { xs, cw, rows, cols, cells: sl.cells, labelW };
}
$("heat").addEventListener("pointermove", (e) => {
  const G = heatGeom, ro = $("readout"); if (!G) return;
  const rect = e.currentTarget.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
  const ri = Math.floor((y - HEAT.head) / HEAT.row), ci = G.xs.findIndex((x0) => x >= x0 && x < x0 + G.cw);
  if (ri < 0 || ri >= G.rows.length || ci < 0) { ro.hidden = true; return; }
  const r = G.rows[ri], c = G.cells.get(r.m)[ci], col = G.cols[ci];
  const what = S.heatAxis === "weeks" ? new Date(col.label + "T00:00:00Z").toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : S.heatAxis === "locations" ? man.locations.find((l) => l.abbr === col.label)?.name : `${col.label} wk ahead`;
  ro.innerHTML = `<div class="when">${esc(short(r.m))} · ${esc(what)}</div><table><tr><td>Rel. WIS</td><td>${fmt(c.ratio)}</td></tr><tr><td>WIS</td><td>${fmtW(c.wis)}</td></tr><tr><td>Baseline</td><td>${fmtW(c.base)}</td></tr><tr><td>Forecasts</td><td>${c.n}</td></tr></table>`;
  ro.hidden = false;
  const left = Math.min(innerWidth - ro.offsetWidth - 12, e.clientX + 14), top = e.clientY + 14 + ro.offsetHeight > innerHeight ? e.clientY - ro.offsetHeight - 10 : e.clientY + 14;
  ro.style.left = left + "px"; ro.style.top = top + "px";
});
$("heat").addEventListener("pointerleave", () => ($("readout").hidden = true));

/* ---------------------------------------------------------------- page */
function update() { const t0 = performance.now(); compute(); window.__scoreMs = performance.now() - t0; renderScope(); renderBoard(); renderHeatLine(); renderHeat(); }
for (const id of ["back", "theme"]) new LiquidGlass($(id), {});
new Segmented($("t-pal"), { label: "Score colors", value: S.palette, items: [{ value: "blue-orange", label: "Blue · orange" }, { value: "blue-red", label: "Blue · red" }, { value: "violet-amber", label: "Violet · amber" }], onChange: (v) => { S.palette = v; store.set("score-palette", v); setRamp(); renderBoard(); renderHeatLine(); renderHeat(); } });
new Segmented($("t-rows"), { label: "Rows", value: S.rows, items: [{ value: "selected", label: `Selected ${SELECTED.length}` }, { value: "all", label: "All models" }], onChange: (v) => { S.rows = v; renderBoard(); renderHeat(); } });
$("theme").addEventListener("click", () => { root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark"; store.set("viz-theme", root.dataset.theme); setRamp(); renderBoard(); renderHeatLine(); renderHeat(); requestAnimationFrame(() => LiquidGlass.updateAll?.()); });
let rz = 0; new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { renderBoard(); renderHeat(); }); }).observe($("board"));
update();
window.__S = S; window.__result = () => result;
