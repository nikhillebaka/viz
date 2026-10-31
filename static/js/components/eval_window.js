/**
 * FluSight Sandbox Lab — Leaderboard evaluation window: Date | Season toggle with a menu for seasons,
 * season phase (pre-peak / peak / post-peak), and a draggable week range over a mini season chart.
 *
 * The window applies to the forecast (target) week. Phases come from each location's own truth curve,
 * so with "All States" every state is scored on its own peak; the chart shows the national curve then.
 */

import { escapeHtml } from "../constants.js";
import { state, formatSeasonShort, getSeasonForDate } from "../state.js";
import { fetchSeasonCurves } from "../api.js";

const PHASES = [
  { key: null, label: "Full season" },
  { key: "pre", label: "Pre-peak" },
  { key: "peak", label: "Peak" },
  { key: "post", label: "Post-peak" },
];
const PHASE_LABEL = { pre: "Pre-peak", peak: "Peak", post: "Post-peak" };
const SEASON_COLORS = ["--pastel-sky", "--pastel-lavender", "--pastel-mint", "--pastel-amber", "--pastel-coral", "--pastel-teal"];

// Chart geometry (SVG user units; the SVG scales to the popover width)
const W = 440;
const H = 138;
const PAD = { l: 10, r: 10, t: 12, b: 22 };
const MAX_WEEK = 53;

const ui = {
  draft: null,
  curves: new Map(), // `${target}|${location}` -> season-curves payload
  loading: false,
  drag: null,
  onApply: null,
};

// ----------------------------------------------------------------------------
// Scope resolution (shared by the leaderboard, CSV export, and Copy CLI)
// ----------------------------------------------------------------------------

function focalSeason() {
  const info = state.dateInfo ? state.dateInfo[state.selectedDate] : null;
  return (info && info.season) || (state.selectedDate ? getSeasonForDate(state.selectedDate) : state.latestSeason) || "";
}

function availableSeasons() {
  const list = (state.seasonSummaries && state.seasonSummaries.length)
    ? state.seasonSummaries.map((s) => s.season)
    : (state.forecastSeasons || []);
  return [...new Set(list)].sort().reverse();
}

function resolvedSeasons(win) {
  const w = win || state.evalWindow;
  return w && w.seasons && w.seasons.length ? [...w.seasons].sort().reverse() : [focalSeason()].filter(Boolean);
}

function seasonsLabel(seasons) {
  if (!seasons.length) return "Season";
  const all = availableSeasons();
  if (seasons.length > 1 && all.length > 1 && seasons.length === all.length) return "All seasons";
  if (seasons.length === 1) return `Season ${formatSeasonShort(seasons[0])}`;
  return `${seasons.length} seasons`;
}

/** Saturday ending a given season week (1 = MMWR week 31) of the season starting in startYear. */
function seasonWeekDate(startYear, week) {
  const day = 864e5;
  const jan4 = Date.UTC(startYear, 0, 4);
  const startSun = jan4 - new Date(jan4).getUTCDay() * day;
  return new Date(startSun + 30 * 7 * day + 6 * day + (week - 1) * 7 * day);
}

function fmtDay(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function weeksLabel(weeks, seasons) {
  if (!weeks) return "";
  const startYear = parseInt((seasons[0] || focalSeason() || "2025").slice(0, 4), 10);
  return `${fmtDay(seasonWeekDate(startYear, weeks[0]))}–${fmtDay(seasonWeekDate(startYear, weeks[1]))}`;
}

/** Parameters and labels for the active leaderboard time scope. */
export function resolveEvalScope() {
  if (state.evalHorizonScope !== "window") {
    const d = state.selectedDate || "all";
    return { date: d, season: "", weeks: "", phase: "", label: `Date (${d})`, fileTag: d, cliArgs: `--date ${d}` };
  }
  const win = state.evalWindow || {};
  const seasons = resolvedSeasons(win);
  const all = availableSeasons();
  const season = seasons.length === all.length && all.length > 1 ? "all" : seasons.join(",");
  const weeks = win.weeks ? `${win.weeks[0]}-${win.weeks[1]}` : "";
  const phase = win.phase || "";
  const parts = [seasonsLabel(seasons)];
  if (win.weeks) parts.push(weeksLabel(win.weeks, seasons));
  if (phase) parts.push(PHASE_LABEL[phase]);
  let cliArgs = `--season ${season}`;
  if (weeks) cliArgs += ` --weeks ${weeks}`;
  if (phase) cliArgs += ` --phase ${phase}`;
  return {
    date: "all",
    season,
    weeks,
    phase,
    label: parts.join(" · "),
    fileTag: [season.replace(/,/g, "+"), weeks && `wk${weeks}`, phase].filter(Boolean).join("_"),
    cliArgs,
  };
}

/** Human description of a metrics response's window (for the scope banner). */
export function describeWindow(win) {
  if (!win) return "";
  const parts = [];
  if (win.weeks) parts.push(`${weeksLabel(win.weeks, resolvedSeasons())} (season wk ${win.weeks[0]}–${win.weeks[1]})`);
  if (win.phase) parts.push(`${PHASE_LABEL[win.phase]} weeks`);
  return parts.join(" · ");
}

// ----------------------------------------------------------------------------
// Toolbar control
// ----------------------------------------------------------------------------

export function initEvalWindow({ onApply } = {}) {
  ui.onApply = onApply;
  if (!state.evalWindow) state.evalWindow = { seasons: null, weeks: null, phase: null };

  const main = document.getElementById("btn-eval-window");
  const caret = document.getElementById("btn-eval-window-menu");
  const pop = document.getElementById("eval-window-popover");
  if (!main || !caret || !pop) return;

  main.addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.evalHorizonScope === "window") {
      togglePopover();
    } else if (ui.onApply) {
      ui.onApply("window");
    }
  });
  caret.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopover();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.isConnected) return;
    if (e.target.closest("#definition-popover, #methodology-modal")) return;
    if (isOpen() && !pop.contains(e.target) && !main.contains(e.target) && !caret.contains(e.target)) closePopover();
  });
  document.addEventListener("keydown", (e) => {
    // A definition card or the Guide on top closes first; the window menu closes on the next Escape
    const overlayOpen = !document.getElementById("definition-popover")?.classList.contains("hidden")
      || !document.getElementById("methodology-modal")?.classList.contains("hidden");
    if (e.key === "Escape" && isOpen() && !overlayOpen) {
      e.stopPropagation();
      closePopover();
    }
  }, true);
  window.addEventListener("resize", () => isOpen() && placePopover());
  updateEvalWindowButton();
}

/** Refresh the toolbar label (also when the focal season changes with the selected date). */
export function updateEvalWindowButton() {
  const main = document.getElementById("btn-eval-window");
  if (!main) return;
  const scope = state.evalHorizonScope === "window" ? resolveEvalScope() : null;
  const win = state.evalWindow || {};
  const label = scope ? scope.label : seasonsLabel(resolvedSeasons(win));
  main.textContent = label;
  main.title = scope
    ? `Evaluating ${label}. Click to adjust seasons, weeks, and phase.`
    : "Evaluate a span of the season (seasons, weeks, or phase)";
  document.querySelectorAll("#eval-horizon-segmented .segment-btn[data-horizon]").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-horizon") === (state.evalHorizonScope === "window" ? "window" : "date"));
  });
  document.getElementById("eval-season-split")?.classList.toggle("active", state.evalHorizonScope === "window");
}

/** Called when location, target, or date changes so an open menu tracks the current view. */
export function onEvalWindowContextChange() {
  updateEvalWindowButton();
  if (isOpen()) {
    renderPopover();
    loadCurves();
  }
}

function isOpen() {
  return document.getElementById("eval-window-popover")?.classList.contains("open");
}

function togglePopover() {
  if (isOpen()) closePopover();
  else openPopover();
}

function openPopover() {
  const pop = document.getElementById("eval-window-popover");
  const caret = document.getElementById("btn-eval-window-menu");
  if (!pop) return;
  const w = state.evalWindow || {};
  ui.draft = {
    seasons: w.seasons ? [...w.seasons] : null,
    weeks: w.weeks ? [...w.weeks] : null,
    phase: w.phase || null,
  };
  pop.classList.add("open");
  caret?.setAttribute("aria-expanded", "true");
  renderPopover();
  placePopover();
  loadCurves();
}

function closePopover() {
  const pop = document.getElementById("eval-window-popover");
  pop?.classList.remove("open");
  document.getElementById("btn-eval-window-menu")?.setAttribute("aria-expanded", "false");
  ui.draft = null;
  ui.drag = null;
}

function placePopover() {
  const pop = document.getElementById("eval-window-popover");
  if (!pop) return;
  pop.style.left = "";
  pop.style.right = "0px";
  const rect = pop.getBoundingClientRect();
  if (rect.left < 8) {
    pop.style.right = "auto";
    pop.style.left = "0px";
  }
}

function chartLocation() {
  return state.evalLocScope === "states" ? "US" : (state.selectedLocation || "US");
}

function chartLocationLabel() {
  if (state.evalLocScope === "states") return "US National (states use their own curves)";
  const loc = (state.locations || []).find((l) => l.id === chartLocation());
  return loc ? (loc.id === "US" ? "US National" : loc.name) : chartLocation();
}

async function loadCurves() {
  const key = `${state.selectedTarget}|${chartLocation()}`;
  if (ui.curves.has(key)) {
    renderChart();
    return;
  }
  ui.loading = true;
  renderChart();
  try {
    const data = await fetchSeasonCurves({
      target: state.selectedTarget,
      location: chartLocation(),
      seasons: availableSeasons(),
    });
    ui.curves.set(key, data);
  } catch (err) {
    console.warn("Could not load season curves:", err);
  } finally {
    ui.loading = false;
    if (isOpen()) renderChart();
  }
}

/** Forget cached curves (truth data changed, e.g. after a hub sync). */
export function clearEvalWindowCache() {
  ui.curves.clear();
}

// ----------------------------------------------------------------------------
// Popover
// ----------------------------------------------------------------------------

function draftSeasons() {
  return resolvedSeasons(ui.draft);
}

function renderPopover() {
  const pop = document.getElementById("eval-window-popover");
  if (!pop || !ui.draft) return;
  const all = availableSeasons();
  const chosen = new Set(draftSeasons());
  const isFocal = !ui.draft.seasons;
  const allOn = chosen.size === all.length && all.length > 1;

  const chips = all.map((s) => {
    const on = chosen.has(s);
    const summary = (state.seasonSummaries || []).find((x) => x.season === s);
    const rounds = summary ? `${summary.dates_count} rounds` : "";
    return `<button type="button" class="ew-chip ${on ? "on" : ""}" data-season="${escapeHtml(s)}" aria-pressed="${on}"
      title="${escapeHtml(s)}${rounds ? ` · ${rounds}` : ""}">${escapeHtml(formatSeasonShort(s))}</button>`;
  }).join("");

  const phaseBtns = PHASES.map((p) => `
    <button type="button" class="segment-btn ${ui.draft.phase === p.key ? "active" : ""}" data-phase="${p.key || ""}">${p.label}</button>`).join("");

  pop.innerHTML = `
    <div class="ew-head">
      <span class="ew-title">EVALUATION WINDOW</span>
      <button type="button" class="ew-link" id="ew-reset" title="Back to the selected date's season, all weeks">Reset</button>
    </div>
    <div class="ew-row">
      <span class="ew-label">SEASONS</span>
      <div class="ew-chips">
        ${chips}
        <button type="button" class="ew-chip ew-chip-all ${allOn ? "on" : ""}" id="ew-all" aria-pressed="${allOn}">All</button>
      </div>
    </div>
    <div class="ew-hint">${isFocal ? `Following the selected date (${escapeHtml(formatSeasonShort(focalSeason()))}). Pick seasons to pin them.` : `${chosen.size} season${chosen.size === 1 ? "" : "s"} pinned`}</div>
    <div class="ew-row">
      <span class="ew-label">PHASE</span>
      <div class="segmented-control ew-phase" role="group" aria-label="Season phase">${phaseBtns}</div>
      <button type="button" class="info-trigger-btn ew-phase-info" data-term="season_phase" title="Definition: Season phases" aria-label="How season phases are defined"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg></button>
    </div>
    <div class="ew-chart-wrap" id="ew-chart-wrap"></div>
    <div class="ew-chart-meta">
      <div class="ew-legend" id="ew-legend"></div>
      <span class="ew-chart-loc">${escapeHtml(chartLocationLabel())}</span>
    </div>
    <div class="ew-row ew-weeks-row">
      <span class="ew-label">WEEKS</span>
      <span class="ew-weeks-readout" id="ew-weeks-readout"></span>
      <button type="button" class="ew-link" id="ew-weeks-clear">All weeks</button>
    </div>
    <div class="ew-foot">
      <span class="ew-summary" id="ew-summary"></span>
      <div class="ew-foot-actions">
        <button type="button" class="micro-btn" id="ew-cancel">Cancel</button>
        <button type="button" class="micro-btn ew-apply" id="ew-apply">Apply</button>
      </div>
    </div>`;

  pop.querySelectorAll(".ew-chip[data-season]").forEach((b) => b.addEventListener("click", () => {
    const s = b.getAttribute("data-season");
    const set = new Set(draftSeasons());
    if (set.has(s)) set.delete(s);
    else set.add(s);
    ui.draft.seasons = set.size ? [...set] : [s];
    renderPopover();
    renderChart();
  }));
  pop.querySelector("#ew-all")?.addEventListener("click", () => {
    ui.draft.seasons = allOn ? [focalSeason()] : [...all];
    renderPopover();
    renderChart();
  });
  pop.querySelectorAll(".ew-phase .segment-btn").forEach((b) => b.addEventListener("click", () => {
    ui.draft.phase = b.getAttribute("data-phase") || null;
    renderPopover();
    renderChart();
  }));
  pop.querySelector("#ew-reset")?.addEventListener("click", () => {
    ui.draft = { seasons: null, weeks: null, phase: null };
    renderPopover();
    renderChart();
  });
  pop.querySelector("#ew-weeks-clear")?.addEventListener("click", () => {
    ui.draft.weeks = null;
    renderChart();
  });
  pop.querySelector("#ew-cancel")?.addEventListener("click", closePopover);
  pop.querySelector("#ew-apply")?.addEventListener("click", applyDraft);
  renderChart();
}

function applyDraft() {
  const d = ui.draft;
  if (!d) return;
  state.evalWindow = {
    seasons: d.seasons && d.seasons.length ? [...d.seasons] : null,
    weeks: d.weeks && !(d.weeks[0] <= 1 && d.weeks[1] >= MAX_WEEK) ? [...d.weeks] : null,
    phase: d.phase || null,
  };
  closePopover();
  if (ui.onApply) ui.onApply("window");
}

function updateReadouts() {
  const pop = document.getElementById("eval-window-popover");
  if (!pop || !ui.draft) return;
  const seasons = draftSeasons();
  const readout = pop.querySelector("#ew-weeks-readout");
  if (readout) {
    readout.innerHTML = ui.draft.weeks
      ? `${escapeHtml(weeksLabel(ui.draft.weeks, seasons))} <span class="ew-mono">wk ${ui.draft.weeks[0]}–${ui.draft.weeks[1]}</span>`
      : `<span class="ew-muted">All weeks · drag across the chart to narrow</span>`;
  }
  pop.querySelector("#ew-weeks-clear")?.classList.toggle("hidden", !ui.draft.weeks);
  const summary = pop.querySelector("#ew-summary");
  if (summary) {
    const parts = [seasonsLabel(seasons)];
    if (ui.draft.weeks) parts.push(weeksLabel(ui.draft.weeks, seasons));
    if (ui.draft.phase) parts.push(`${PHASE_LABEL[ui.draft.phase]} weeks`);
    summary.textContent = parts.join(" · ");
  }
}

// ----------------------------------------------------------------------------
// Mini season chart with a draggable week range
// ----------------------------------------------------------------------------

const xOf = (week) => PAD.l + ((week - 1) / (MAX_WEEK - 1)) * (W - PAD.l - PAD.r);
const weekAt = (x) => Math.round(1 + ((x - PAD.l) / (W - PAD.l - PAD.r)) * (MAX_WEEK - 1));
const clampWeek = (w) => Math.max(1, Math.min(MAX_WEEK, w));

function renderChart() {
  const wrap = document.getElementById("ew-chart-wrap");
  if (!wrap || !ui.draft) return;
  updateReadouts();
  const data = ui.curves.get(`${state.selectedTarget}|${chartLocation()}`);
  const seasons = draftSeasons();
  const curves = data ? data.curves.filter((c) => seasons.includes(c.season)) : [];
  const legend = document.getElementById("ew-legend");

  if (!data || curves.length === 0) {
    wrap.innerHTML = `<div class="ew-chart-empty">${ui.loading || !data ? '<span class="remote-spinner"></span> Loading season curves…' : "No observed data for these seasons here."}</div>`;
    if (legend) legend.innerHTML = "";
    return;
  }

  const maxV = Math.max(...curves.flatMap((c) => c.points.map((p) => p.value)), 1e-9) * 1.08;
  const yOf = (v) => H - PAD.b - (v / maxV) * (H - PAD.t - PAD.b);
  const weeks = ui.draft.weeks;
  const phase = ui.draft.phase;
  const inScope = (p) => (!weeks || (p.week >= weeks[0] && p.week <= weeks[1])) && (!phase || p.phase === phase);

  // Month grid and labels
  let grid = "";
  (data.month_ticks || []).forEach((t) => {
    const x = xOf(t.week);
    grid += `<line class="ew-grid" x1="${x}" x2="${x}" y1="${PAD.t - 4}" y2="${H - PAD.b}"></line>`;
    grid += `<text class="ew-tick" x="${x + 2}" y="${H - 7}">${escapeHtml(t.label)}</text>`;
  });

  // Curves: full path dimmed, scored stretches drawn bright on top (oldest season first)
  const ordered = [...curves].sort((a, b) => a.season.localeCompare(b.season));
  let paths = "";
  const colorFor = (season) => `var(${SEASON_COLORS[Math.max(0, seasons.indexOf(season)) % SEASON_COLORS.length]})`;
  ordered.forEach((c) => {
    const pts = c.points;
    const color = colorFor(c.season);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${xOf(p.week).toFixed(1)},${yOf(p.value).toFixed(1)}`).join("");
    paths += `<path class="ew-curve-dim" d="${d}" style="stroke:${color}"></path>`;
    let seg = [];
    const flush = () => {
      if (seg.length > 1) {
        paths += `<path class="ew-curve" d="${seg.map((p, i) => `${i ? "L" : "M"}${xOf(p.week).toFixed(1)},${yOf(p.value).toFixed(1)}`).join("")}" style="stroke:${color}"></path>`;
      } else if (seg.length === 1) {
        paths += `<circle class="ew-dot" cx="${xOf(seg[0].week).toFixed(1)}" cy="${yOf(seg[0].value).toFixed(1)}" r="2" style="fill:${color}"></circle>`;
      }
      seg = [];
    };
    pts.forEach((p) => (inScope(p) ? seg.push(p) : flush()));
    flush();
  });

  // Soft area under the most recent selected season, for depth (matches the heatmap inspector sparkline)
  const lead = curves[0];
  const area = `M${xOf(lead.points[0].week)},${H - PAD.b}` + lead.points.map((p) => `L${xOf(p.week).toFixed(1)},${yOf(p.value).toFixed(1)}`).join("")
    + `L${xOf(lead.points[lead.points.length - 1].week)},${H - PAD.b}Z`;

  // Brush
  let brush = "";
  if (weeks) {
    const x0 = xOf(weeks[0]) - 3;
    const x1 = xOf(weeks[1]) + 3;
    const hy = (H - PAD.b + PAD.t) / 2 - 11;
    brush = `
      <rect class="ew-brush" data-role="move" x="${x0}" y="${PAD.t - 6}" width="${Math.max(6, x1 - x0)}" height="${H - PAD.b - PAD.t + 6}" rx="3"
        tabindex="0" role="slider" aria-label="Selected weeks; arrow keys move the range" aria-valuetext="weeks ${weeks[0]} to ${weeks[1]}"></rect>
      <rect class="ew-handle" data-role="a" x="${x0 - 3}" y="${hy}" width="6" height="22" rx="2" tabindex="0" role="slider"
        aria-label="Range start" aria-valuemin="1" aria-valuemax="${MAX_WEEK}" aria-valuenow="${weeks[0]}"></rect>
      <rect class="ew-handle" data-role="b" x="${x1 - 3}" y="${hy}" width="6" height="22" rx="2" tabindex="0" role="slider"
        aria-label="Range end" aria-valuemin="1" aria-valuemax="${MAX_WEEK}" aria-valuenow="${weeks[1]}"></rect>`;
  }

  wrap.innerHTML = `
    <svg class="ew-chart" id="ew-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="Season curves; drag to choose a range of weeks">
      <defs><linearGradient id="ew-area-grad" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" class="ew-area-top"></stop><stop offset="100%" class="ew-area-bottom"></stop>
      </linearGradient></defs>
      <rect class="ew-hit" x="0" y="0" width="${W}" height="${H}"></rect>
      ${grid}
      <path class="ew-area" d="${area}"></path>
      ${paths}
      ${brush}
    </svg>`;

  if (legend) {
    legend.innerHTML = curves.map((c) => {
      const pk = c.peak_weeks
        ? ` <span class="ew-legend-peak">peak ${escapeHtml(fmtDay(seasonWeekDate(parseInt(c.season, 10), c.peak_weeks[0])))}–${escapeHtml(fmtDay(seasonWeekDate(parseInt(c.season, 10), c.peak_weeks[1])))}</span>`
        : ` <span class="ew-legend-peak">not peaked yet</span>`;
      return `<span class="ew-legend-item"><span class="ew-legend-swatch" style="background:${colorFor(c.season)}"></span>${escapeHtml(formatSeasonShort(c.season))}${phase === "peak" ? pk : ""}</span>`;
    }).join("");
  }

  wireChart(wrap.querySelector("svg"));
}

function svgX(svg, clientX) {
  const r = svg.getBoundingClientRect();
  return ((clientX - r.left) / r.width) * W;
}

function wireChart(svg) {
  if (!svg) return;
  svg.addEventListener("pointerdown", (e) => {
    const role = e.target.getAttribute("data-role");
    const x = svgX(svg, e.clientX);
    const w = clampWeek(weekAt(x));
    const weeks = ui.draft.weeks;
    if (role === "a" || role === "b") {
      ui.drag = { mode: role };
    } else if (role === "move" && weeks) {
      ui.drag = { mode: "move", grab: w, start: [...weeks] };
    } else {
      ui.drag = { mode: "new", anchor: w, moved: false, hadRange: !!weeks };
    }
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  svg.addEventListener("pointermove", (e) => {
    if (!ui.drag) return;
    const w = clampWeek(weekAt(svgX(svg, e.clientX)));
    const d = ui.drag;
    let weeks = ui.draft.weeks ? [...ui.draft.weeks] : null;
    if (d.mode === "a") weeks = [Math.min(w, weeks[1]), Math.max(w, weeks[1])];
    else if (d.mode === "b") weeks = [Math.min(weeks[0], w), Math.max(weeks[0], w)];
    else if (d.mode === "move") {
      const span = d.start[1] - d.start[0];
      let a = d.start[0] + (w - d.grab);
      a = Math.max(1, Math.min(MAX_WEEK - span, a));
      weeks = [a, a + span];
    } else {
      if (w === d.anchor && !d.moved) return;
      d.moved = true;
      weeks = [Math.min(d.anchor, w), Math.max(d.anchor, w)];
    }
    if (!ui.draft.weeks || weeks[0] !== ui.draft.weeks[0] || weeks[1] !== ui.draft.weeks[1]) {
      ui.draft.weeks = weeks;
      renderChart();
      // Re-rendering replaced the SVG; keep receiving events on the new one
      const fresh = document.getElementById("ew-chart");
      if (fresh && e.pointerId !== undefined) {
        try { fresh.setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
      }
    }
  });
  const end = () => {
    const d = ui.drag;
    ui.drag = null;
    // A plain click outside the selection clears it (standard brush behaviour)
    if (d && d.mode === "new" && !d.moved && d.hadRange) {
      ui.draft.weeks = null;
      renderChart();
    }
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("dblclick", () => {
    ui.draft.weeks = null;
    renderChart();
  });
  svg.querySelectorAll("[data-role]").forEach((el) => el.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.key === "ArrowLeft" ? -1 : 1;
    const [a, b] = ui.draft.weeks;
    const role = el.getAttribute("data-role");
    if (role === "a") ui.draft.weeks = [clampWeek(Math.min(a + step, b)), b];
    else if (role === "b") ui.draft.weeks = [a, clampWeek(Math.max(b + step, a))];
    else if (a + step >= 1 && b + step <= MAX_WEEK) ui.draft.weeks = [a + step, b + step];
    renderChart();
    document.querySelector(`#ew-chart [data-role="${role}"]`)?.focus();
  }));
}
