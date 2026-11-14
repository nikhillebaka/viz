/* The Dates popover: the evaluation window (design/studies/evaluation-goals.md, "The Dates popover").
 * Seasons (multi, following the chart by default), phase, and a week range drawn on the seasons' observed
 * curves. Changes apply live; the range applies on release. Reset returns to following the chart. */
import { h, on } from "../../lib/dom.js";
import { openPopover } from "../../ui/floating.js";
import { linear } from "../../lib/scale.js";
import { scopeOf, setScope, startYearOf } from "../scope.js";
import { loadCurves } from "./data.js";
import { PHASE_LABEL, weeksDates } from "./model.js";
import { s } from "./figures.js";

const W1 = 1, W53 = 53;
const clampW = (w) => Math.max(W1, Math.min(W53, Math.round(w)));

/**
 * @param {HTMLElement} anchor the Dates fragment
 * @param {{ manifest, store, chart }} ctx
 * @returns {object | null} the layer (null: it was open and is now closed)
 */
export function openDates(anchor, ctx) {
  const { manifest, store } = ctx;
  const seasons = [...manifest.seasons].map((x) => x.id).sort().reverse();
  const label = (id) => manifest.seasonById.get(id)?.label || id;
  let curves = null, offStore = () => {};

  return openPopover(anchor, {
    title: "Dates",
    className: "sc-dates",
    width: 420,
    onClose: () => offStore(),
    content(body, layer) {
      const chips = h("div", { class: "sc-chips", role: "group", "aria-label": "Seasons" });
      const phases = h("div", { class: "sc-chips", role: "group", "aria-label": "Phase" });
      const plot = s("svg", { class: "sc-season", role: "img" });
      const readout = h("div", { class: "sc-readout" });
      const reset = h("button", { type: "button", class: "c-section-action", onclick: () => setScope(store, { seasons: null, weeks: null, phase: null }) }, "Reset");
      const follow = h("span", { class: "c-section-count" });
      body.append(
        h("div", { class: "c-section" }, h("span", { class: "c-section-title" }, "Seasons"), follow, reset),
        chips,
        h("div", { class: "c-section" }, h("span", { class: "c-section-title" }, "Phase")),
        phases,
        h("div", { class: "c-section" }, h("span", { class: "c-section-title" }, "Weeks")),
        h("div", { class: "sc-season-wrap" }, plot),
        readout,
      );

      const render = () => {
        const sc = scopeOf(store.get(), manifest);
        const on = new Set(sc.seasons);
        follow.textContent = sc.following ? "follows chart" : "";
        reset.hidden = sc.following && !sc.weeks && !sc.phase;
        const allOn = seasons.length > 1 && seasons.every((x) => on.has(x));
        chips.replaceChildren(...[
          ...seasons.map((id) => h("button", {
            type: "button", class: ["c-chip", sc.following && on.has(id) && "is-following"], "aria-pressed": String(on.has(id)),
            onclick: () => {
              const next = new Set(sc.seasons);
              if (next.has(id)) next.delete(id); else next.add(id);
              if (!next.size) next.add(id); // one season always stays
              setScope(store, { seasons: [...next] });
            },
          }, label(id))),
          seasons.length > 1 ? h("button", {
            type: "button", class: "c-chip", "aria-pressed": String(allOn),
            onclick: () => setScope(store, { seasons: allOn ? [sc.seasons[0] || seasons[0]] : [...seasons] }),
          }, "All") : null,
        ].filter(Boolean));
        phases.replaceChildren(...[[null, "Full"], ...Object.entries(PHASE_LABEL)].map(([v, l]) => h("button", {
          type: "button", class: "c-chip", "aria-pressed": String(sc.phase === v), onclick: () => setScope(store, { phase: v }),
        }, l)));
        readout.textContent = sc.weeks ? `${weeksDates(sc.seasons[0], sc.weeks)} · wk ${sc.weeks[0]}–${sc.weeks[1]}` : "All weeks";
        drawSeason(plot, { curves, sc, brush });
        layer.place();
      };

      // the range being drawn (live while dragging, stored on release)
      const brush = { weeks: null, drag: null };
      const commit = (weeks) => setScope(store, { weeks: weeks && !(weeks[0] <= W1 && weeks[1] >= W53) ? weeks : null });
      bindBrush(plot, brush, () => scopeOf(store.get(), manifest).weeks, render, commit);

      offStore = store.select(["scope", "date", "location", "target"], render);
      render();
      const sc = scopeOf(store.get(), manifest);
      const loc = sc.place === "current" ? store.get().location : "US";
      loadCurves(store.get().target, loc, seasons).then((d) => { curves = d; if (plot.isConnected) render(); }, () => { curves = { curves: [], failed: true }; if (plot.isConnected) render(); });
    },
  });
}

const PAD = { l: 8, r: 8, t: 10, b: 20 };

/* the seasons' observed curves on a season-week axis, the range over them */
function drawSeason(svg, { curves, sc, brush }) {
  const w = svg.clientWidth || 380, hgt = svg.clientHeight || 128;
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  const X = linear([W1, W53], [PAD.l, w - PAD.r]);
  svg._x = X;
  const on = sc.seasons;
  const list = (curves?.curves || []).filter((c) => on.includes(c.season)).sort((a, b) => a.season.localeCompare(b.season));
  const max = Math.max(1e-9, ...list.flatMap((c) => c.points.map((p) => p.value ?? 0)));
  const Y = linear([0, max * 1.08], [hgt - PAD.b, PAD.t]);
  for (const m of curves?.month_ticks || []) {
    if (m.week < W1 || m.week > 52) continue;
    svg.append(s("line", { x1: X(m.week), x2: X(m.week), y1: PAD.t, y2: hgt - PAD.b, class: "sc-grid" }));
    svg.append(s("text", { x: X(m.week) + 3, y: hgt - 6, class: "sc-tick", text: m.label }));
  }
  if (!curves) svg.append(s("text", { x: w / 2, y: hgt / 2, class: "sc-tick", "text-anchor": "middle", text: "Loading" }));
  else if (!list.length) svg.append(s("text", { x: w / 2, y: hgt / 2, class: "sc-tick", "text-anchor": "middle", text: curves.failed ? "Can't load curves" : "No observed data" }));
  const weeks = brush.weeks || sc.weeks;
  const inWin = (p) => (!weeks || (p.week >= weeks[0] && p.week <= weeks[1])) && (!sc.phase || p.phase === sc.phase);
  list.forEach((c, i) => {
    const age = list.length - 1 - i; // 0 = newest
    const pts = c.points.filter((p) => p.value != null);
    const d = (ps) => ps.map((p, j) => `${j ? "L" : "M"}${X(p.week).toFixed(1)},${Y(p.value).toFixed(1)}`).join("");
    svg.append(s("path", { d: d(pts), class: ["sc-curve", "is-dim", age && "is-old"] }));
    // in-scope stretches, bright
    let run = [];
    const flush = () => { if (run.length) svg.append(s("path", { d: d(run.length === 1 ? [run[0], { ...run[0], week: run[0].week + 0.01 }] : run), class: ["sc-curve", age && "is-old"] })); run = []; };
    for (const p of pts) { if (inWin(p)) run.push(p); else flush(); }
    flush();
    if (sc.phase === "peak" && c.peak_weeks && age === 0) {
      const [a, b] = c.peak_weeks, y = PAD.t + 2;
      svg.append(s("path", { d: `M${X(a)},${y + 4}V${y}H${X(b)}V${y + 4}`, class: "sc-bracket" }));
    }
  });
  if (weeks) {
    const x0 = X(weeks[0] - 0.5), x1 = X(weeks[1] + 0.5);
    svg.append(s("rect", { x: x0, y: PAD.t, width: Math.max(2, x1 - x0), height: hgt - PAD.t - PAD.b, class: "sc-brush", "data-part": "body" }));
    for (const [part, x] of [["a", x0], ["b", x1]]) svg.append(s("rect", { x: x - 3, y: PAD.t, width: 6, height: hgt - PAD.t - PAD.b, class: "sc-handle", "data-part": part }));
  }
  const y0 = startYearOf(on[0]);
  svg.setAttribute("tabindex", "0");
  svg.setAttribute("role", "slider");
  svg.setAttribute("aria-label", "Weeks");
  svg.setAttribute("aria-valuetext", weeks && Number.isFinite(y0) ? `weeks ${weeks[0]} to ${weeks[1]}` : "all weeks");
}

/* drag to draw a range, drag an edge to resize, drag inside to move, double-click for every week;
 * ← → move it, shift ← → resize its end */
function bindBrush(svg, brush, current, render, commit) {
  const weekAt = (e) => { const r = svg.getBoundingClientRect(); return clampW(svg._x.invert(e.clientX - r.left)); };
  on(svg, "pointerdown", (e) => {
    if (e.button !== 0) return;
    const cur = current(), w = weekAt(e), part = e.target.dataset?.part;
    svg.setPointerCapture(e.pointerId);
    brush.drag = { part: cur && part ? part : "new", start: w, from: cur, moved: false };
    brush.weeks = cur && part ? [...cur] : null;
    e.preventDefault();
  });
  on(svg, "pointermove", (e) => {
    const d = brush.drag;
    if (!d) return;
    const w = weekAt(e);
    if (w !== d.start) d.moved = true;
    if (!d.moved) return;
    if (d.part === "new") brush.weeks = [Math.min(d.start, w), Math.max(d.start, w)];
    else if (d.part === "a") brush.weeks = [Math.min(w, d.from[1]), Math.max(w, d.from[1])];
    else if (d.part === "b") brush.weeks = [Math.min(d.from[0], w), Math.max(d.from[0], w)];
    else {
      const span = d.from[1] - d.from[0];
      const a = Math.max(W1, Math.min(W53 - span, d.from[0] + w - d.start));
      brush.weeks = [a, a + span];
    }
    render();
  });
  const end = () => {
    const d = brush.drag;
    if (!d) return;
    brush.drag = null;
    const weeks = brush.weeks;
    brush.weeks = null;
    if (d.moved) commit(weeks);
    else if (d.part === "new" && d.from) commit(null); // a plain click clears the range
    else render();
  };
  on(svg, "pointerup", end);
  on(svg, "pointercancel", end);
  on(svg, "dblclick", () => commit(null));
  on(svg, "keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault(); e.stopPropagation();
    const d = e.key === "ArrowRight" ? 1 : -1;
    const cur = current() || [W1, W53];
    if (e.shiftKey) commit([cur[0], Math.max(cur[0], Math.min(W53, cur[1] + d))]);
    else {
      const span = cur[1] - cur[0], a = Math.max(W1, Math.min(W53 - span, cur[0] + d));
      commit([a, a + span]);
    }
  });
}
