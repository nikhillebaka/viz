/* Place-First Live Briefing view — multi-hub forecasts + live external surveillance & virology. */

import { h, safeHref } from "../lib/dom.js";
import {
  invalidateBriefingCache,
  loadBriefing,
  loadBriefingStatus,
  refreshBriefingFeeds,
} from "../lib/api.js";
import { icon } from "../ui/controls.js";
import {
  buildCladeTimelineGeometry,
  buildOutlookGeometry,
  buildSparklineGeometry,
  buildSubtypeTimelineGeometry,
  formatIsoShort,
  formatMetricValue,
  formatSignedPct,
  formatTimeAgo,
  normalizeRateChangePmf,
} from "./briefing/model.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      el.setAttribute(k, String(v));
    }
  }
  for (const ch of children) {
    if (ch == null || ch === false) continue;
    if (Array.isArray(ch)) {
      for (const nested of ch) if (nested != null && nested !== false) el.appendChild(nested instanceof Node ? nested : document.createTextNode(String(nested)));
    } else {
      el.appendChild(ch instanceof Node ? ch : document.createTextNode(String(ch)));
    }
  }
  return el;
}

function deltaClass(val) {
  if (val == null || !Number.isFinite(val) || Math.abs(val) < 0.05) return "br-delta-flat";
  return val > 0 ? "br-delta-up" : "br-delta-dn";
}

function renderSparklineSvg(values, { width = 104, height = 24, tone = "var(--ink-secondary)" } = {}) {
  const geom = buildSparklineGeometry(values, width, height, 2);
  if (!geom.path) return h("span", { class: "br-delta-flat" }, "—");
  return svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: "br-spark",
    "aria-hidden": "true",
  },
  svgEl("path", { d: geom.path, fill: "none", stroke: tone, "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }),
  svgEl("circle", { cx: geom.lastX, cy: geom.lastY, r: 2.1, fill: tone }));
}

function renderOutlookSvg(signal, { showPrior = false, onReadout }) {
  const g = buildOutlookGeometry(signal, { showPrior });
  const isPct = String(signal?.unit || "").includes("%");
  const svg = svgEl("svg", {
    viewBox: `0 0 ${g.width} ${g.height}`,
    class: "br-svg",
    role: "img",
    "aria-label": `${signal.label} observed trajectory and ensemble forecast`,
  });

  for (const t of g.yTicks) {
    svg.appendChild(svgEl("line", {
      x1: g.pad.l, x2: g.width - g.pad.r, y1: t.y, y2: t.y,
      class: "br-grid-line",
    }));
    svg.appendChild(svgEl("text", {
      x: g.pad.l - 8, y: t.y + 3.5,
      "text-anchor": "end",
      class: "br-axis-text",
    }, t.label));
  }

  if (g.fan && g.fan.shadeRect.w > 0) {
    svg.appendChild(svgEl("rect", {
      x: g.fan.shadeRect.x,
      y: g.pad.t,
      width: g.fan.shadeRect.w,
      height: g.innerH,
      fill: "var(--shade-forecast)",
    }));
    svg.appendChild(svgEl("line", {
      x1: g.fan.refX, x2: g.fan.refX, y1: g.pad.t, y2: g.height - g.pad.b,
      stroke: "var(--line-axis)", "stroke-width": 1, "stroke-dasharray": "3 3",
    }));
    svg.appendChild(svgEl("text", {
      x: Math.min(g.width - g.pad.r - 4, g.fan.refX + 6),
      y: g.pad.t + 11,
      class: "br-axis-text",
    }, `Forecast · ${formatIsoShort(g.fan.refDate)}`));
  }

  for (const ps of g.priorSeries) {
    svg.appendChild(svgEl("path", {
      d: ps.path,
      fill: "none",
      stroke: `var(${ps.colorVar})`,
      "stroke-width": 1.25,
      "stroke-dasharray": "4 3",
      opacity: 0.8,
    }));
  }

  if (g.fan) {
    if (g.fan.q95Path) svg.appendChild(svgEl("path", { d: g.fan.q95Path, fill: "var(--series-1)", opacity: 0.12 }));
    if (g.fan.q80Path) svg.appendChild(svgEl("path", { d: g.fan.q80Path, fill: "var(--series-1)", opacity: 0.2 }));
    if (g.fan.q50Path) svg.appendChild(svgEl("path", { d: g.fan.q50Path, fill: "var(--series-1)", opacity: 0.3 }));
    if (g.fan.medianPath) {
      svg.appendChild(svgEl("path", {
        d: g.fan.medianPath,
        fill: "none",
        stroke: "var(--series-1)",
        "stroke-width": 2.25,
        "stroke-linecap": "round",
      }));
    }
    for (const pt of g.fan.points) {
      svg.appendChild(svgEl("circle", { cx: pt.x, cy: pt.y, r: 2.8, fill: "var(--series-1)" }));
    }
  }

  if (g.observedPath) {
    svg.appendChild(svgEl("path", {
      d: g.observedPath,
      fill: "none",
      stroke: "var(--ink-primary)",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }));
    for (const pt of g.observedPoints) {
      svg.appendChild(svgEl("circle", { cx: pt.x, cy: pt.y, r: 2.4, fill: "var(--ink-primary)" }));
    }
  }

  for (const xt of g.xTicks) {
    svg.appendChild(svgEl("text", {
      x: xt.x, y: g.height - 8,
      "text-anchor": "middle",
      class: "br-axis-text",
    }, xt.label));
  }

  const hoverLine = svgEl("line", {
    x1: 0, x2: 0, y1: g.pad.t, y2: g.height - g.pad.b,
    stroke: "var(--ink-tertiary)", "stroke-width": 1, opacity: 0,
  });
  const hoverDot = svgEl("circle", { cx: 0, cy: 0, r: 4, fill: "var(--accent)", opacity: 0 });
  svg.appendChild(hoverLine);
  svg.appendChild(hoverDot);

  const combined = [
    ...g.observedPoints.map((p) => ({ kind: "obs", ...p })),
    ...(g.fan?.points || []).map((p) => ({ kind: "fc", ...p })),
  ];
  if (combined.length && onReadout) {
    const fmt = (v) => formatMetricValue(v, { unit: isPct ? "%" : signal.unit, per100k: signal.per_100k });
    const unitLbl = signal.unit && !isPct ? ` ${signal.unit}` : "";
    const hitRect = svgEl("rect", {
      x: g.pad.l, y: g.pad.t, width: g.innerW, height: g.innerH,
      fill: "transparent", style: "cursor:crosshair",
    });
    hitRect.addEventListener("pointermove", (ev) => {
      const r = svg.getBoundingClientRect();
      if (!r.width) return;
      const sx = ((ev.clientX - r.left) / r.width) * g.width;
      let best = combined[0];
      let bestDist = Math.abs(sx - best.x);
      for (const c of combined) {
        const d = Math.abs(sx - c.x);
        if (d < bestDist || (d === bestDist && c.kind === "fc")) {
          best = c;
          bestDist = d;
        }
      }
      hoverLine.setAttribute("x1", best.x);
      hoverLine.setAttribute("x2", best.x);
      hoverLine.setAttribute("opacity", "0.75");
      hoverDot.setAttribute("cx", best.x);
      hoverDot.setAttribute("cy", best.y);
      hoverDot.setAttribute("opacity", "1");
      if (best.kind === "obs") {
        onReadout(`${formatIsoShort(best.date, true)} · Observed ${fmt(best.value)}${unitLbl}`);
      } else {
        const q = best.q95;
        const band = q && q[0] != null && q[1] != null ? ` (95% PI ${fmt(q[0])}–${fmt(q[1])})` : "";
        onReadout(`${formatIsoShort(best.date, true)} · Median (${signal.model_display || signal.model_id}, h${best.horizon}): ${fmt(best.median)}${unitLbl}${band}`);
      }
    });
    hitRect.addEventListener("pointerleave", () => {
      hoverLine.setAttribute("opacity", "0");
      hoverDot.setAttribute("opacity", "0");
      onReadout("");
    });
    svg.appendChild(hitRect);
  }

  return svg;
}

function renderLargeCladeSvg(cladeObj, onReadout) {
  const g = buildCladeTimelineGeometry(cladeObj);
  if (!g.areas.length) return null;
  const svg = svgEl("svg", {
    viewBox: `0 0 ${g.width} ${g.height}`,
    class: "br-svg",
    role: "img",
    "aria-label": `${cladeObj.subtype} circulating clades over time`,
  });

  for (const yt of g.yTicks) {
    svg.appendChild(svgEl("line", { x1: g.pad.l, x2: g.pad.l + g.innerW, y1: yt.y, y2: yt.y, class: "br-grid-line" }));
    svg.appendChild(svgEl("text", { x: g.pad.l - 8, y: yt.y + 3.5, "text-anchor": "end", class: "br-axis-text" }, yt.label));
  }

  for (const a of g.areas) {
    if (!a.path) continue;
    svg.appendChild(svgEl("path", {
      d: a.path,
      fill: `var(${a.colorVar})`,
      "fill-opacity": 0.86,
      stroke: "var(--surface-paper)",
      "stroke-width": 1,
    }));
  }

  // Direct collision-resolved right-margin labels + leader ticks
  for (const lb of g.rightLabels) {
    svg.appendChild(svgEl("line", {
      x1: lb.xEdge,
      y1: lb.anchorY,
      x2: lb.xText - 4,
      y2: lb.labelY - 3,
      stroke: `var(${lb.colorVar})`,
      "stroke-width": 1.25,
      opacity: 0.9,
    }));
    svg.appendChild(svgEl("circle", { cx: lb.xEdge, cy: lb.anchorY, r: 2.2, fill: `var(${lb.colorVar})` }));
    const txtEl = svgEl("text", { x: lb.xText, y: lb.labelY, class: "br-direct-label" },
      lb.clade, " ",
      svgEl("tspan", { class: "br-direct-pct" }, `${lb.pct.toFixed(0)}%`),
    );
    svg.appendChild(txtEl);
  }

  for (const xt of g.xTicks) {
    svg.appendChild(svgEl("text", { x: xt.x, y: g.height - 6, "text-anchor": "middle", class: "br-axis-text" }, xt.label));
  }

  const hoverLine = svgEl("line", {
    x1: 0, x2: 0, y1: g.pad.t, y2: g.height - g.pad.b,
    stroke: "var(--ink-primary)", "stroke-width": 1, opacity: 0,
  });
  svg.appendChild(hoverLine);

  if (g.columns.length && onReadout) {
    const hitRect = svgEl("rect", {
      x: g.pad.l, y: g.pad.t, width: g.innerW, height: g.innerH,
      fill: "transparent", style: "cursor:crosshair",
    });
    hitRect.addEventListener("pointermove", (ev) => {
      const r = svg.getBoundingClientRect();
      if (!r.width) return;
      const sx = ((ev.clientX - r.left) / r.width) * g.width;
      let best = g.columns[0];
      let bestD = Math.abs(sx - best.x);
      for (const col of g.columns) {
        const d = Math.abs(sx - col.x);
        if (d < bestD) { best = col; bestD = d; }
      }
      hoverLine.setAttribute("x1", best.x);
      hoverLine.setAttribute("x2", best.x);
      hoverLine.setAttribute("opacity", "0.75");
      const summary = best.shares.slice(0, 4).map((s) => `${s.clade} ${s.pct.toFixed(1)}%`).join(" · ");
      onReadout(`${formatIsoShort(best.date, true)} · ${summary}`);
    });
    hitRect.addEventListener("pointerleave", () => {
      hoverLine.setAttribute("opacity", "0");
      onReadout("");
    });
    svg.appendChild(hitRect);
  }

  return svg;
}

function renderLargeSubtypeSvg(series, onReadout) {
  const g = buildSubtypeTimelineGeometry(series);
  if (!g.bars.length) return null;
  const svg = svgEl("svg", {
    viewBox: `0 0 ${g.width} ${g.height}`,
    class: "br-svg",
    role: "img",
    "aria-label": "Weekly influenza subtype detections over time",
  });

  for (const yt of g.yTicks) {
    svg.appendChild(svgEl("line", { x1: g.pad.l, x2: g.width - g.pad.r, y1: yt.y, y2: yt.y, class: "br-grid-line" }));
    svg.appendChild(svgEl("text", { x: g.pad.l - 8, y: yt.y + 3.5, "text-anchor": "end", class: "br-axis-text" }, yt.label));
  }

  for (const bar of g.bars) {
    for (const seg of bar.segments) {
      svg.appendChild(svgEl("rect", {
        x: seg.x,
        y: seg.y,
        width: seg.w,
        height: seg.h,
        fill: `var(${seg.colorVar})`,
        rx: 1,
      }));
    }
  }

  for (const xt of g.xTicks) {
    svg.appendChild(svgEl("text", { x: xt.x, y: g.height - 6, "text-anchor": "middle", class: "br-axis-text" }, xt.label));
  }

  if (onReadout) {
    const hoverBox = svgEl("rect", {
      x: 0, y: g.pad.t, width: 1, height: g.innerH,
      fill: "var(--ink-primary)", opacity: 0,
    });
    svg.appendChild(hoverBox);
    const hitRect = svgEl("rect", {
      x: g.pad.l, y: g.pad.t, width: g.innerW, height: g.innerH,
      fill: "transparent", style: "cursor:crosshair",
    });
    hitRect.addEventListener("pointermove", (ev) => {
      const r = svg.getBoundingClientRect();
      if (!r.width) return;
      const sx = ((ev.clientX - r.left) / r.width) * g.width;
      let best = g.bars[0];
      let bestD = Math.abs(sx - best.cx);
      for (const b of g.bars) {
        const d = Math.abs(sx - b.cx);
        if (d < bestD) { best = b; bestD = d; }
      }
      hoverBox.setAttribute("x", best.x - 1);
      hoverBox.setAttribute("width", best.w + 2);
      hoverBox.setAttribute("opacity", "0.08");
      const parts = best.segments.map((s) => `${s.label} ${s.value.toLocaleString("en-US")} (${s.pct}%)`).join(" · ");
      onReadout(`${formatIsoShort(best.date, true)} · Total positive: ${best.total.toLocaleString("en-US")}${parts ? ` · ${parts}` : ""}`);
    });
    hitRect.addEventListener("pointerleave", () => {
      hoverBox.setAttribute("opacity", "0");
      onReadout("");
    });
    svg.appendChild(hitRect);
  }

  return { svg, legend: g.legend };
}

function _niceAxisMax(rawMax) {
  const m = Math.max(1, Number(rawMax) || 1);
  const exp = Math.floor(Math.log10(m));
  const base = 10 ** exp;
  const frac = m / base;
  const nice = frac <= 1 ? 1 : (frac <= 2 ? 2 : (frac <= 2.5 ? 2.5 : (frac <= 5 ? 5 : 10)));
  return nice * base;
}

function renderDrcEpiCurveSvg(curve, mode, onReadout) {
  const isNew7d = mode === "new_7d";
  const pts = (curve || []).filter((p) =>
    isNew7d ? (p.new_cases_7d != null && Number.isFinite(p.new_cases_7d)) : (p.cum_cases != null && Number.isFinite(p.cum_cases)),
  );
  if (pts.length < 2) return null;

  const width = 760;
  const height = 240;
  const pad = { t: 18, r: 24, b: 28, l: 54 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;

  const primaryVals = pts.map((p) => (isNew7d ? p.new_cases_7d : p.cum_cases));
  const secondaryVals = pts.map((p) => (isNew7d ? p.new_deaths_7d : p.cum_deaths)).filter(Number.isFinite);
  const yMax = _niceAxisMax(Math.max(...primaryVals, ...(secondaryVals.length ? secondaryVals : [0]), 1));
  const xOf = (i) => Number((pad.l + (i / (pts.length - 1)) * innerW).toFixed(2));
  const yOf = (v) => Number((pad.t + (1 - Math.max(0, v) / yMax) * innerH).toFixed(2));
  const baseY = pad.t + innerH;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "br-svg",
    role: "img",
    "aria-label": isNew7d ? "DRC Bundibugyo Ebola 7-day new confirmed cases" : "DRC Bundibugyo Ebola cumulative cases and deaths",
  });

  for (let i = 0; i <= 4; i++) {
    const val = (yMax * i) / 4;
    const y = yOf(val);
    svg.appendChild(svgEl("line", { x1: pad.l, x2: width - pad.r, y1: y, y2: y, class: "br-grid-line" }));
    svg.appendChild(svgEl("text", { x: pad.l - 8, y: y + 3.5, "text-anchor": "end", class: "br-axis-text" }, Math.round(val).toLocaleString("en-US")));
  }

  const xTickIdxs = [];
  const tickCount = Math.min(5, pts.length);
  for (let t = 0; t < tickCount; t++) {
    const idx = Math.round((t / Math.max(1, tickCount - 1)) * (pts.length - 1));
    if (!xTickIdxs.includes(idx)) xTickIdxs.push(idx);
  }
  for (const idx of xTickIdxs) {
    svg.appendChild(svgEl("text", {
      x: xOf(idx),
      y: height - 6,
      "text-anchor": idx === 0 ? "start" : (idx === pts.length - 1 ? "end" : "middle"),
      class: "br-axis-text",
    }, formatIsoShort(pts[idx].date, idx === 0 || idx === pts.length - 1)));
  }

  if (isNew7d) {
    const barW = Math.max(1.8, Math.min(12, (innerW / pts.length) * 0.72));
    pts.forEach((p, i) => {
      const cx = xOf(i);
      const y = yOf(p.new_cases_7d);
      svg.appendChild(svgEl("rect", {
        x: Number((cx - barW / 2).toFixed(2)),
        y,
        width: Number(barW.toFixed(2)),
        height: Math.max(0, Number((baseY - y).toFixed(2))),
        fill: "var(--series-1)",
        opacity: 0.78,
        rx: 1,
      }));
    });
    const dPathParts = [];
    pts.forEach((p, i) => {
      if (p.new_deaths_7d == null || !Number.isFinite(p.new_deaths_7d)) return;
      dPathParts.push(`${dPathParts.length ? "L" : "M"}${xOf(i)},${yOf(p.new_deaths_7d)}`);
    });
    if (dPathParts.length > 1) {
      svg.appendChild(svgEl("path", {
        d: dPathParts.join(" "),
        fill: "none",
        stroke: "var(--score-9)",
        "stroke-width": 1.8,
      }));
    }
  } else {
    const cPath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(i)},${yOf(p.cum_cases)}`).join(" ");
    const areaD = `${cPath} L${xOf(pts.length - 1)},${baseY} L${xOf(0)},${baseY} Z`;
    svg.appendChild(svgEl("path", { d: areaD, fill: "var(--series-1)", opacity: 0.08 }));
    svg.appendChild(svgEl("path", { d: cPath, fill: "none", stroke: "var(--series-1)", "stroke-width": 2.2 }));

    const dPathParts = [];
    let lastDeathIdx = -1;
    pts.forEach((p, i) => {
      if (p.cum_deaths == null || !Number.isFinite(p.cum_deaths)) return;
      dPathParts.push(`${dPathParts.length ? "L" : "M"}${xOf(i)},${yOf(p.cum_deaths)}`);
      lastDeathIdx = i;
    });
    if (dPathParts.length > 1) {
      svg.appendChild(svgEl("path", { d: dPathParts.join(" "), fill: "none", stroke: "var(--score-9)", "stroke-width": 2.0 }));
      const ld = pts[lastDeathIdx];
      svg.appendChild(svgEl("circle", { cx: xOf(lastDeathIdx), cy: yOf(ld.cum_deaths), r: 3, fill: "var(--score-9)" }));
    }
    const lc = pts[pts.length - 1];
    svg.appendChild(svgEl("circle", { cx: xOf(pts.length - 1), cy: yOf(lc.cum_cases), r: 3, fill: "var(--series-1)" }));
  }

  if (onReadout) {
    const hoverLine = svgEl("line", {
      x1: 0, x2: 0, y1: pad.t, y2: baseY,
      stroke: "var(--ink-primary)", "stroke-width": 1, "stroke-dasharray": "3 3", opacity: 0,
    });
    const dotPrimary = svgEl("circle", { cx: 0, cy: 0, r: 3.5, fill: "var(--series-1)", opacity: 0 });
    const dotSecondary = svgEl("circle", { cx: 0, cy: 0, r: 3.5, fill: "var(--score-9)", opacity: 0 });
    svg.append(hoverLine, dotPrimary, dotSecondary);

    const hitRect = svgEl("rect", {
      x: pad.l, y: pad.t, width: innerW, height: innerH,
      fill: "transparent", style: "cursor:crosshair",
    });
    hitRect.addEventListener("pointermove", (ev) => {
      const r = svg.getBoundingClientRect();
      if (!r.width) return;
      const sx = ((ev.clientX - r.left) / r.width) * width;
      const ratio = Math.max(0, Math.min(1, (sx - pad.l) / innerW));
      const idx = Math.round(ratio * (pts.length - 1));
      const p = pts[idx];
      const cx = xOf(idx);
      const pv = isNew7d ? p.new_cases_7d : p.cum_cases;
      const sv = isNew7d ? p.new_deaths_7d : p.cum_deaths;
      hoverLine.setAttribute("x1", cx);
      hoverLine.setAttribute("x2", cx);
      hoverLine.setAttribute("opacity", "0.55");
      dotPrimary.setAttribute("cx", cx);
      dotPrimary.setAttribute("cy", yOf(pv));
      dotPrimary.setAttribute("opacity", "1");
      if (sv != null && Number.isFinite(sv)) {
        dotSecondary.setAttribute("cx", cx);
        dotSecondary.setAttribute("cy", yOf(sv));
        dotSecondary.setAttribute("opacity", "1");
      } else {
        dotSecondary.setAttribute("opacity", "0");
      }
      if (isNew7d) {
        const dTxt = sv != null ? ` · ${sv.toLocaleString("en-US")} deaths (7d)` : "";
        onReadout(`${formatIsoShort(p.date, true)} · ${pv.toLocaleString("en-US")} new confirmed cases (7d)${dTxt}`);
      } else {
        const cfr = pv > 0 && sv != null ? ` (${((sv / pv) * 100).toFixed(1)}% CFR)` : "";
        const n7 = p.new_cases_7d != null ? ` · +${p.new_cases_7d.toLocaleString("en-US")} (7d)` : "";
        onReadout(`${formatIsoShort(p.date, true)} · ${pv.toLocaleString("en-US")} cases · ${sv != null ? `${sv.toLocaleString("en-US")} deaths${cfr}` : "—"}${n7}`);
      }
    });
    hitRect.addEventListener("pointerleave", () => {
      hoverLine.setAttribute("opacity", "0");
      dotPrimary.setAttribute("opacity", "0");
      dotSecondary.setAttribute("opacity", "0");
      onReadout("");
    });
    svg.appendChild(hitRect);
  }

  return svg;
}

function renderRtMiniChart(rtItem) {
  const series = rtItem?.series || [];
  if (!series.length) return null;
  const vals = series.map((p) => p.median).filter(Number.isFinite);
  const lo = Math.min(0.6, ...vals);
  const hi = Math.max(1.4, ...vals);
  const span = Math.max(0.2, hi - lo);
  const width = 260;
  const height = 42;
  const pad = 4;
  const yOf = (v) => Number((pad + (1 - (v - lo) / span) * (height - pad * 2)).toFixed(2));
  const xOf = (i) => Number((pad + (series.length === 1 ? 0.5 : i / (series.length - 1)) * (width - pad * 2)).toFixed(2));
  const path = series.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(i)},${yOf(p.median)}`).join(" ");
  const y1 = yOf(1.0);
  const lat = rtItem.latest;
  const dotColor = lat.median >= 1.05 ? "var(--score-9)" : (lat.median <= 0.95 ? "var(--score-1)" : "var(--ink-secondary)");
  return svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height: 42, "aria-label": `${rtItem.label} Rt trend` },
    svgEl("line", { x1: pad, x2: width - pad, y1, y2: y1, stroke: "var(--line-axis)", "stroke-dasharray": "3 3", "stroke-width": 1 }),
    svgEl("path", { d: path, fill: "none", stroke: dotColor, "stroke-width": 1.6 }),
    svgEl("circle", { cx: xOf(series.length - 1), cy: yOf(lat.median), r: 3, fill: dotColor }),
  );
}

/**
 * Mount Place-First Briefing view into `host`.
 */
export function mountBriefing(
  host,
  ctx,
  {
    placeKey = null,
    onPlaceChange = null,
    onOpenChart = null,
    onOpenScores = null,
    onOpenGlobe = null,
  } = {},
) {
  let currentPlace = placeKey || null;
  let data = null;
  let activeSignalIdx = 0;
  let activeCladeIdx = 0;
  let showPriorSeasons = false;
  let drcCurveMode = "cumulative";
  let drcDonTab = "summary";
  let loadToken = 0;
  let pollTimer = null;
  let destroyed = false; // set by destroy(): every await below checks it before touching state or the DOM
  let refreshing = false;
  let errorMsg = null;
  const isWeb = (ctx?.manifest?.mode || "local") === "web";

  function stopPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function startPoll() {
    stopPoll();
    if (destroyed) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (destroyed) return;
      try {
        const st = await loadBriefingStatus();
        if (destroyed) return;
        refreshing = !!st?.refreshing;
        if (refreshing) {
          startPoll();
          return;
        }
        invalidateBriefingCache();
        await fetchAndRender(currentPlace, { bust: true, preserveTabs: true });
      } catch {
        if (destroyed) return;
        refreshing = false;
        render();
      }
    }, 1200);
  }

  async function triggerRefresh() {
    if (refreshing) return;
    refreshing = true;
    render();
    try {
      const res = await refreshBriefingFeeds({ force: true });
      if (destroyed) return;
      refreshing = !!res?.status?.refreshing;
      if (refreshing) {
        startPoll();
      } else {
        invalidateBriefingCache();
        await fetchAndRender(currentPlace, { bust: true, preserveTabs: true });
      }
    } catch (e) {
      if (destroyed) return;
      refreshing = false;
      errorMsg = e?.message || "Failed to start feed refresh";
      render();
    }
  }

  async function fetchAndRender(targetPlace, { bust = false, preserveTabs = false } = {}) {
    if (destroyed) return;
    const token = ++loadToken;
    errorMsg = null;
    if (!data) renderLoading();
    try {
      const res = await loadBriefing(targetPlace || "", { bust });
      if (destroyed || token !== loadToken) return;
      const prevSigId = preserveTabs ? data?.signals?.[activeSignalIdx]?.signal_id : null;
      const prevSubtype = preserveTabs ? data?.virology?.clades?.[activeCladeIdx]?.subtype : null;
      data = res;
      currentPlace = res?.place?.key || targetPlace || null;
      refreshing = !!res?.feed_status?.refreshing;
      if (refreshing) startPoll();

      activeSignalIdx = 0;
      if (prevSigId && Array.isArray(res?.signals)) {
        const idx = res.signals.findIndex((s) => s.signal_id === prevSigId);
        if (idx >= 0) activeSignalIdx = idx;
      }
      activeCladeIdx = 0;
      if (prevSubtype && Array.isArray(res?.virology?.clades)) {
        const cIdx = res.virology.clades.findIndex((c) => c.subtype === prevSubtype);
        if (cIdx >= 0) activeCladeIdx = cIdx;
      }
      if (!preserveTabs) {
        drcCurveMode = "cumulative";
        drcDonTab = "summary";
      }
      onPlaceChange?.(currentPlace);
      render();
    } catch (e) {
      if (destroyed || token !== loadToken) return;
      errorMsg = e?.message || "Failed to load briefing";
      render();
    }
  }

  function renderLoading() {
    host.replaceChildren(
      h("div", { class: "br-page" },
        h("header", { class: "br-masthead" },
          h("h1", { class: "br-h1" }, "Loading…"),
        ),
      ),
    );
  }

  function buildChooserSelect() {
    const chooser = data?.place_chooser || [];
    const groups = {
      national: chooser.filter((c) => c.key === "US" || c.level === "country"),
      states: chooser.filter((c) => c.key !== "US" && c.level === "state"),
      substate: chooser.filter((c) => c.level !== "country" && c.level !== "state"),
    };
    const makeGroup = (label, list) =>
      list.length
        ? h("optgroup", { label }, list.map((c) => h("option", { value: c.key }, c.key === currentPlace ? `${c.name} (current)` : c.name)))
        : null;

    return h("select", {
      class: "br-select",
      "aria-label": "Switch location",
      onchange: (e) => {
        const nextKey = e.target.value;
        e.target.value = "";
        if (nextKey && nextKey !== currentPlace) fetchAndRender(nextKey);
      },
    },
    h("option", { value: "", selected: true, disabled: true, hidden: true }, "Switch place"),
    makeGroup("Countries", groups.national),
    makeGroup("States", groups.states),
    makeGroup("Regions & Cities", groups.substate));
  }

  function openSignalInChart(sig) {
    if (!sig) return;
    if (onOpenChart) {
      onOpenChart(sig);
    } else if (ctx?.switchContext) {
      ctx.switchContext({ hub: sig.hub_id, target: sig.target_id, location: sig.location_id, date: sig.ref_date, model: sig.model_id || null });
    }
  }

  function openSignalInScores(sig) {
    if (!sig) return;
    if (onOpenScores) {
      onOpenScores(sig);
    } else if (ctx?.switchContext) {
      ctx.switchContext({ hub: sig.hub_id, target: sig.target_id, location: sig.location_id, date: sig.ref_date, model: sig.model_id || null });
    }
  }

  function render() {
    host.replaceChildren();
    if (!data && errorMsg) {
      host.append(h("div", { class: "br-page" },
        h("header", { class: "br-masthead" },
          h("h1", { class: "br-h1" }, "Unable to load briefing"),
          h("p", { class: "br-prose" }, errorMsg),
          h("div", { class: "br-actions" },
            h("button", { type: "button", class: "br-btn is-primary", onclick: () => fetchAndRender(currentPlace, { bust: true }) }, "Retry"),
          ),
        ),
      ));
      return;
    }
    if (!data) return renderLoading();

    const place = data.place;
    if (data.empty || !place) {
      host.append(h("div", { class: "br-page" },
        h("header", { class: "br-masthead" },
          h("h1", { class: "br-h1" }, "No synced forecast hubs"),
          h("p", { class: "br-prose" }, "Sync a forecast hub from Data Sources or Globe to inspect live briefings."),
          h("div", { class: "br-actions" },
            onOpenGlobe ? h("button", { type: "button", class: "br-btn", onclick: () => onOpenGlobe() }, "Globe") : null,
          ),
        ),
      ));
      return;
    }

    const signals = data.signals || [];
    const activeSig = signals[activeSignalIdx] || signals[0] || null;
    const virology = data.virology || {};
    const peers = data.peers || {};
    const sources = data.sources || {};
    const repWeek = data.meta?.reporting_week;

    const page = h("div", { class: "br-page" });

    // 1. MASTHEAD — clean hierarchy without duplicate labels or metadata boilerplate
    const crumbBits = [];
    if (place.parent) {
      crumbBits.push(
        h("button", {
          type: "button",
          class: "br-link-btn",
          onclick: () => fetchAndRender(place.parent.key),
        }, place.parent.name),
      );
      if (place.hhs_region_label) {
        crumbBits.push(h("span", { "aria-hidden": "true" }, "·"), h("span", null, `HHS ${place.hhs_region_label}`));
      }
    }

    const refreshBtn = isWeb
      ? null
      : h("button", {
        type: "button",
        class: "br-btn",
        disabled: refreshing,
        onclick: triggerRefresh,
      }, refreshing ? "Refreshing…" : "Refresh feeds");

    page.appendChild(h("header", { class: "br-masthead" },
      (crumbBits.length || repWeek) ? h("div", { class: "br-crumb-row" },
        h("nav", { class: "br-crumb", "aria-label": "Location hierarchy" }, crumbBits),
        repWeek ? h("span", { class: "br-mono" }, formatIsoShort(repWeek, true)) : null,
      ) : null,
      h("div", { class: "br-title-bar" },
        h("h1", { class: "br-h1" }, place.name),
        h("div", { class: "br-actions" },
          buildChooserSelect(),
          onOpenGlobe ? h("button", { type: "button", class: "br-btn", onclick: () => onOpenGlobe() }, "Globe") : null,
          activeSig ? h("button", {
            type: "button",
            class: "br-btn",
            onclick: () => openSignalInChart(activeSig),
          }, "Chart ", h("span", { html: icon.open })) : null,
          h("button", { type: "button", class: "br-btn", onclick: () => window.print() }, "Print / PDF"),
          refreshBtn,
        ),
      ),
      errorMsg ? h("p", { class: "br-scope-note", style: { color: "var(--status-error)" } }, errorMsg) : null,
    ));

    // 2. CONCISE SUMMARY & 4-CARD METRIC STRIP
    if ((data.summary?.paragraphs || []).length || data.kpis?.length) {
      const summaryEl = h("section", { class: "br-summary-wrap", "aria-label": "Summary" },
        (data.summary?.paragraphs || []).map((p) => h("p", { class: "br-prose" }, p)),
        data.summary?.scope_note ? h("p", { class: "br-scope-note" }, data.summary.scope_note) : null,
      );
      if (data.kpis?.length) {
        summaryEl.appendChild(h("div", { class: "br-kpi-strip" },
          data.kpis.map((k) => {
            const targetIdx = k.signal_id ? signals.findIndex((s) => s.signal_id === k.signal_id) : -1;
            const clickable = targetIdx >= 0;
            const activateKpi = () => {
              if (!clickable) return;
              activeSignalIdx = targetIdx;
              render();
            };
            return h("div", {
              class: clickable ? "br-kpi is-clickable" : "br-kpi",
              tabindex: clickable ? "0" : null,
              role: clickable ? "button" : null,
              onclick: clickable ? activateKpi : null,
              onkeydown: clickable ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activateKpi();
                }
              } : null,
            },
            h("span", { class: "br-kpi-label" }, k.label),
            h("div", { class: "br-kpi-val" },
              h("span", null, k.value),
              k.unit ? h("span", { class: "br-kpi-unit" }, k.unit) : null,
            ),
            k.sub ? h("span", { class: "br-kpi-sub" }, k.sub) : null,
            );
          }),
        ));
      }
      page.appendChild(summaryEl);
    }

    // 2b. DRC BUNDIBUGYO EBOLA EPIDEMIC SITUATION (dedicated OCHA / WHO DON / reporting-lag consolidation)
    const drc = data.drc_ebola;
    if (drc) {
      const drcSec = h("section", { class: "br-section", "aria-label": "DRC Bundibugyo Ebola situation" },
        h("div", { class: "br-section-head" },
          h("h2", { class: "br-h2" }, "DRC Bundibugyo Ebola Situation"),
          h("div", { class: "br-head-meta" },
            h("span", null, drc.national?.date ? `SitRep through ${formatIsoShort(drc.national.date, true)}` : "INRB-UMIE · WHO · BDBV Hub"),
          ),
        ),
      );

      if (!drc.feeds_cached && !isWeb) {
        drcSec.appendChild(h("div", { class: "br-cta-banner" },
          h("div", { class: "br-cta-copy" },
            h("strong", null, "External DRC outbreak feeds are not yet cached locally."),
            h("span", null, "Fetch OCHA / INRB-UMIE daily situation reports, WHO Disease Outbreak News risk assessments, and BDBV Hub reporting-delay statistics."),
          ),
          h("button", {
            type: "button",
            class: "br-btn is-primary",
            disabled: refreshing,
            onclick: triggerRefresh,
          }, refreshing ? "Fetching…" : "Fetch live DRC feeds"),
        ));
      }

      if (drc.epi_curve?.length) {
        const curveReadout = h("div", { class: "br-hover-readout", "aria-live": "polite" }, "");
        const curveSvg = renderDrcEpiCurveSvg(drc.epi_curve, drcCurveMode, (txt) => { curveReadout.textContent = txt; });
        const nat = drc.national;
        drcSec.appendChild(h("div", { class: "br-subpanel" },
          h("div", { class: "br-subhead" },
            h("h3", { class: "br-h3" }, "National Confirmed Epidemic Trajectory"),
            nat ? h("span", { class: "br-scope-note" }, `${nat.source || "INRB-UMIE"} · ${nat.cum_cases.toLocaleString("en-US")} cases · ${nat.cum_deaths.toLocaleString("en-US")} deaths (${nat.cfr_pct != null ? `${nat.cfr_pct.toFixed(1)}%` : "—"} CFR)`) : null,
          ),
          h("div", { class: "br-tabs", role: "tablist", "aria-label": "DRC epidemic curve metric" },
            [
              ["cumulative", "Cumulative cases & deaths"],
              ["new_7d", "7-day new confirmed cases"],
            ].map(([mId, mLbl]) => h("button", {
              type: "button",
              role: "tab",
              class: "br-tab",
              "aria-selected": String(drcCurveMode === mId),
              onclick: () => {
                drcCurveMode = mId;
                render();
              },
            }, mLbl)),
          ),
          curveSvg ? h("div", { class: "br-svg-wrap" }, curveSvg) : null,
          curveReadout,
          h("div", { class: "br-legend-row" },
            h("span", { class: "br-legend-item" },
              h("span", { class: "br-swatch", style: { background: "var(--series-1)" } }),
              drcCurveMode === "new_7d" ? "New confirmed cases (7d)" : "Cumulative confirmed cases",
            ),
            h("span", { class: "br-legend-item" },
              h("span", { class: "br-swatch", style: { background: "var(--score-9)" } }),
              drcCurveMode === "new_7d" ? "New confirmed deaths (7d)" : "Cumulative confirmed deaths",
            ),
          ),
        ));
      }

      const don = drc.latest_don;
      if (don) {
        const donSections = [
          ["summary", "Situation Summary", don.summary],
          ["assessment", "WHO Risk Assessment", don.assessment],
          ["overview", "Regional & Cross-Border", don.overview],
          ["response", "Public Health Response", don.response],
        ].filter(([, , txt]) => !!txt);
        const activeTab = donSections.find(([k]) => k === drcDonTab) || donSections[0];
        const activeParas = (activeTab?.[2] || "").split("\n").map((s) => s.trim()).filter(Boolean);

        const donUrl = safeHref(don.url);
        drcSec.appendChild(h("article", { class: "br-don-card", "aria-label": "WHO Disease Outbreak News" },
          h("div", { class: "br-don-head" },
            h("div", { class: "br-don-meta" },
              h("span", { class: "br-don-kicker" }, "WHO Disease Outbreak News"),
              h("span", { class: "br-mono" }, `${don.don_id} · ${formatIsoShort(don.date, true)}`),
            ),
            donUrl ? h("a", {
              href: donUrl,
              target: "_blank",
              rel: "noopener noreferrer",
              class: "br-link-btn is-accent",
            }, "WHO Report ↗") : null,
          ),
          h("h3", { class: "br-h3" }, don.title),
          donSections.length > 1 ? h("div", { class: "br-tabs", role: "tablist", "aria-label": "WHO report sections" },
            donSections.map(([k, lbl]) => h("button", {
              type: "button",
              role: "tab",
              class: "br-tab",
              "aria-selected": String(activeTab && activeTab[0] === k),
              onclick: () => {
                drcDonTab = k;
                render();
              },
            }, lbl)),
          ) : null,
          h("div", { class: "br-don-prose" },
            activeParas.slice(0, 6).map((p) => h("p", { class: "br-prose" }, p)),
          ),
          (don.epidemiology || don.advice || (drc.who_timeline?.length > 1)) ? h("details", { class: "br-details" },
            h("summary", null,
              h("span", null, `Epidemiology, WHO Advice & Archive (${drc.who_timeline?.length || 1} DON reports)`),
              h("span", { class: "br-mono" }, "Expand"),
            ),
            h("div", { class: "br-don-prose", style: { paddingTop: "10px" } },
              don.epidemiology ? [h("strong", { class: "br-don-subhead" }, "Epidemiology & Clinical Context"), ...don.epidemiology.split("\n").filter(Boolean).slice(0, 4).map((p) => h("p", { class: "br-prose" }, p))] : null,
              don.advice ? [h("strong", { class: "br-don-subhead" }, "WHO Advice"), ...don.advice.split("\n").filter(Boolean).slice(0, 3).map((p) => h("p", { class: "br-prose" }, p))] : null,
              drc.who_timeline?.length ? h("div", { class: "br-table-wrap", style: { marginTop: "8px" } },
                h("table", { class: "br-table" },
                  h("thead", null, h("tr", null,
                    h("th", null, "Published"),
                    h("th", null, "DON ID"),
                    h("th", null, "Report Title"),
                    h("th", { class: "num" }, "Link"),
                  )),
                  h("tbody", null, drc.who_timeline.map((item) => {
                    const itemUrl = safeHref(item.url);
                    return h("tr", null,
                      h("td", { class: "br-mono" }, formatIsoShort(item.date, true)),
                      h("td", { class: "br-mono" }, item.don_id),
                      h("td", null, item.title),
                      h("td", { class: "num" }, itemUrl ? h("a", { href: itemUrl, target: "_blank", rel: "noopener noreferrer", class: "br-link-btn" }, "Open ↗") : "—"),
                    );
                  })),
                ),
              ) : null,
            ),
          ) : null,
        ));
      }

      const hz = drc.health_zones;
      if (hz?.rows?.length) {
        drcSec.appendChild(h("div", { class: "br-subpanel" },
          h("div", { class: "br-subhead" },
            h("h3", { class: "br-h3" }, "Top Affected Health Zones"),
            h("span", { class: "br-scope-note" }, `${hz.total_zones} zones reported · ${hz.active_zones_14d} with new confirmed cases in past 14d · through ${formatIsoShort(hz.latest_date, true)}`),
          ),
          h("div", { class: "br-table-wrap" },
            h("table", { class: "br-table" },
              h("thead", null, h("tr", null,
                h("th", null, "Health Zone"),
                h("th", { class: "num" }, "Confirmed Cases"),
                h("th", { class: "num" }, "Deaths"),
                h("th", { class: "num" }, "CFR"),
                h("th", { class: "num" }, "New (14d)"),
              )),
              h("tbody", null, hz.rows.slice(0, 15).map((r) => h("tr", null,
                h("td", null, r.name, r.location_code ? h("span", { class: "br-scope-note", style: { marginLeft: "6px" } }, r.location_code) : null),
                h("td", { class: "num br-mono" }, r.cases.toLocaleString("en-US")),
                h("td", { class: "num br-mono" }, r.deaths.toLocaleString("en-US")),
                h("td", { class: "num br-mono" }, r.cfr_pct != null ? `${r.cfr_pct.toFixed(1)}%` : "—"),
                h("td", { class: "num br-mono" }, r.cases_14d != null ? (r.cases_14d > 0 ? `+${r.cases_14d.toLocaleString("en-US")}` : "0") : "—"),
              ))),
            ),
          ),
        ));
      }

      const del = drc.reporting_delays;
      if (del && (del.national_weeks?.length || del.by_province?.length)) {
        const mw = del.mature_week;
        drcSec.appendChild(h("div", { class: "br-subpanel" },
          h("div", { class: "br-subhead" },
            h("h3", { class: "br-h3" }, "Surveillance Reporting Lag & Backfill"),
            h("span", { class: "br-scope-note" }, del.as_of ? `BDBV Hub delay snapshots as of ${formatIsoShort(del.as_of, true)}` : "BDBV Hub delay distribution"),
          ),
          mw ? h("p", { class: "br-scope-note" },
            `Confirmed case counts undergo multi-week reporting backfill (median ${mw.median_days.toFixed(0)} days, P75 ${mw.p75_days.toFixed(0)} days, P90 ${mw.p90_days.toFixed(0)} days from symptom onset to report as of ${formatIsoShort(mw.date, true)}). Most recent incomplete weeks are marked partial.`,
          ) : null,
          del.national_weeks?.length ? h("div", { class: "br-table-wrap" },
            h("table", { class: "br-table" },
              h("thead", null, h("tr", null,
                h("th", null, "Week Ending"),
                h("th", { class: "num" }, "Cases Captured"),
                h("th", { class: "num" }, "Median Lag"),
                h("th", { class: "num" }, "P75 Lag"),
                h("th", { class: "num" }, "P90 Lag"),
              )),
              h("tbody", null, del.national_weeks.slice(0, 6).map((w) => h("tr", null,
                h("td", { class: "br-mono" },
                  formatIsoShort(w.date, true),
                  w.is_partial ? h("span", { class: "br-badge-partial" }, "partial") : null,
                ),
                h("td", { class: "num br-mono" }, w.n_cases.toLocaleString("en-US")),
                h("td", { class: "num br-mono" }, `${w.median_days.toFixed(1)}d`),
                h("td", { class: "num br-mono" }, `${w.p75_days.toFixed(1)}d`),
                h("td", { class: "num br-mono" }, `${w.p90_days.toFixed(1)}d`),
              ))),
            ),
          ) : null,
          del.by_province?.length ? h("details", { class: "br-details" },
            h("summary", null,
              h("span", null, `Provincial Delay Breakdown (${del.by_province.length} provinces)`),
              h("span", { class: "br-mono" }, del.mature_week ? formatIsoShort(del.mature_week.date) : "Latest"),
            ),
            h("div", { class: "br-table-wrap", style: { marginTop: "8px" } },
              h("table", { class: "br-table" },
                h("thead", null, h("tr", null,
                  h("th", null, "Province"),
                  h("th", { class: "num" }, "Cases"),
                  h("th", { class: "num" }, "Median"),
                  h("th", { class: "num" }, "P75"),
                  h("th", { class: "num" }, "P90"),
                )),
                h("tbody", null, del.by_province.map((pr) => {
                  const isFocal = pr.location_name.toLowerCase() === String(place.name || "").toLowerCase();
                  return h("tr", { class: isFocal ? "is-focal" : null },
                    h("td", null, pr.location_name),
                    h("td", { class: "num br-mono" }, pr.n_cases.toLocaleString("en-US")),
                    h("td", { class: "num br-mono" }, `${pr.median_days.toFixed(1)}d`),
                    h("td", { class: "num br-mono" }, `${pr.p75_days.toFixed(1)}d`),
                    h("td", { class: "num br-mono" }, `${pr.p90_days.toFixed(1)}d`),
                  );
                })),
              ),
            ),
          ) : null,
        ));
      }

      const drcLinks = (drc.external_links || [])
        .map((lk) => ({ lk, url: safeHref(lk?.url) }))
        .filter((x) => Boolean(x.url));
      if (drcLinks.length) {
        drcSec.appendChild(h("div", { class: "br-links-bar" },
          h("span", { class: "br-scope-note" }, "Official DRC & Outbreak References:"),
          drcLinks.map(({ lk, url }) => h("a", {
            href: url,
            target: "_blank",
            rel: "noopener noreferrer",
            class: "br-btn",
          }, lk.label, " ↗")),
        ));
      }

      page.appendChild(drcSec);
    }

    // 3. FORECAST OUTLOOK
    if (signals.length && activeSig) {
      const outSec = h("section", { class: "br-section", "aria-label": "Forecast outlook" });
      outSec.appendChild(h("div", { class: "br-section-head" },
        h("h2", { class: "br-h2" }, "Forecast Outlook"),
        h("div", { class: "br-head-meta" },
          h("span", null, `${activeSig.hub_label} · ${activeSig.season}`),
          h("button", {
            type: "button",
            class: "br-link-btn",
            onclick: () => openSignalInScores(activeSig),
          }, "Scores ↗"),
          h("button", {
            type: "button",
            class: "br-link-btn is-accent",
            onclick: () => openSignalInChart(activeSig),
          }, "Open in Chart ", h("span", { html: icon.open })),
        ),
      ));

      if (signals.length > 1) {
        outSec.appendChild(h("div", { class: "br-tabs", role: "tablist", "aria-label": "Forecast indicators" },
          signals.map((sig, idx) => h("button", {
            type: "button",
            role: "tab",
            class: "br-tab",
            "aria-selected": String(idx === activeSignalIdx),
            onclick: () => {
              activeSignalIdx = idx;
              render();
            },
          }, sig.label)),
        ));
      }

      const readoutEl = h("div", { class: "br-hover-readout", "aria-live": "polite" }, "");
      const hasPrior = Array.isArray(activeSig.prior_seasons) && activeSig.prior_seasons.length > 0;
      const priorCheckbox = hasPrior
        ? h("label", { class: "br-toggle" },
            h("input", {
              type: "checkbox",
              checked: showPriorSeasons,
              onchange: (e) => {
                showPriorSeasons = !!e.target.checked;
                render();
              },
            }),
            `Compare prior ${activeSig.prior_seasons.length} season${activeSig.prior_seasons.length > 1 ? "s" : ""}`,
          )
        : null;

      const svgChart = renderOutlookSvg(activeSig, {
        showPrior: showPriorSeasons,
        onReadout: (txt) => { readoutEl.textContent = txt; },
      });

      const modelLabel = activeSig.fan?.model_display || activeSig.model_display || activeSig.model_id;
      const legendItems = [
        h("span", { class: "br-legend-item" }, h("span", { class: "br-swatch", style: { background: "var(--ink-primary)" } }), "Observed"),
        activeSig.fan ? h("span", { class: "br-legend-item" }, h("span", { class: "br-swatch", style: { background: "var(--series-1)" } }), `${modelLabel} median · 50 / 80 / 95% intervals`) : null,
      ];
      if (showPriorSeasons && hasPrior) {
        activeSig.prior_seasons.forEach((ps, i) => {
          legendItems.push(h("span", { class: "br-legend-item" },
            h("span", { class: "br-swatch", style: { background: `var(--season-${(i % 4) + 1})`, borderTop: "1px dashed" } }),
            ps.season,
          ));
        });
      }

      const chartCol = h("div", { class: "br-chart-card" },
        h("div", { class: "br-chart-toolbar" },
          h("span", null, `${activeSig.label}${activeSig.unit ? ` (${activeSig.unit})` : ""} · Issued ${formatIsoShort(activeSig.ref_date, true)}`),
          priorCheckbox,
        ),
        h("div", { class: "br-svg-wrap" }, svgChart),
        readoutEl,
        h("div", { class: "br-legend-row" }, legendItems),
      );

      const normPath = String(activeSig.pathogen || "").toLowerCase().includes("flu")
        ? "flu"
        : (String(activeSig.pathogen || "").toLowerCase().includes("covid") ? "covid-19" : String(activeSig.pathogen || "").toLowerCase());
      const matchedRt = (virology.cfa_rt || []).find((r) => r.pathogen === normPath) || null;
      const pmfBars = normalizeRateChangePmf(activeSig.rate_change_pmf);
      const pk = activeSig.peak_outlook;
      const railBlocks = [];

      if (pmfBars.length) {
        const pmfMeta = activeSig.rate_change_pmf;
        railBlocks.push(h("div", { class: "br-rail-block" },
          h("div", { class: "br-rail-title" },
            h("span", null, pmfMeta.label || "Weekly rate change odds"),
            pmfMeta.target_end_date ? h("span", { class: "br-mono" }, formatIsoShort(pmfMeta.target_end_date)) : null,
          ),
          h("div", { class: "br-pmf-rows" },
            pmfBars.map((b) => h("div", { class: "br-pmf-row" },
              h("span", { title: b.label }, b.shortLabel),
              h("div", { class: "br-pmf-track" },
                h("div", { class: `br-pmf-fill tone-${b.tone}`, style: { width: `${Math.min(100, b.pct)}%` } }),
              ),
              h("span", { class: "br-mono", style: { textAlign: "right" } }, `${b.pct.toFixed(0)}%`),
            )),
          ),
        ));
      }

      if (pk && (pk.timing || pk.size)) {
        const rows = [];
        if (pk.timing?.median) rows.push(h("div", { class: "br-kv-row" }, h("span", null, "Median peak week"), h("span", { class: "br-mono" }, formatIsoShort(pk.timing.median))));
        if (pk.timing?.i50?.length === 2) rows.push(h("div", { class: "br-kv-row" }, h("span", null, "50% timing window"), h("span", { class: "br-mono" }, `${formatIsoShort(pk.timing.i50[0])}–${formatIsoShort(pk.timing.i50[1])}`)));
        if (pk.size?.median != null) {
          const fmtPk = (v) => formatMetricValue(v, { unit: activeSig.unit, per100k: activeSig.per_100k });
          rows.push(h("div", { class: "br-kv-row" }, h("span", null, "Median peak level"), h("span", { class: "br-mono" }, `${fmtPk(pk.size.median)}${activeSig.unit ? ` ${activeSig.unit}` : ""}`)));
        }
        if (pk.observed?.value != null) {
          const fmtPk = (v) => formatMetricValue(v, { unit: activeSig.unit, per100k: activeSig.per_100k });
          rows.push(h("div", { class: "br-kv-row" }, h("span", null, pk.observed.final ? "Observed peak" : "Peak to date"), h("span", { class: "br-mono" }, fmtPk(pk.observed.value))));
        }
        railBlocks.push(h("div", { class: "br-rail-block" },
          h("div", { class: "br-rail-title" }, h("span", null, "Season peak"), h("span", null, pk.model_id)),
          h("div", { class: "br-kv-list" }, rows),
        ));
      }

      if (matchedRt?.latest) {
        const lat = matchedRt.latest;
        railBlocks.push(h("div", { class: "br-rail-block" },
          h("div", { class: "br-rail-title" },
            h("span", null, `CDC CFA Rt · ${matchedRt.label}`),
            h("span", { class: "br-mono" }, formatIsoShort(lat.date)),
          ),
          h("div", { class: "br-kv-list" },
            h("div", { class: "br-kv-row" },
              h("span", null, "Median (95% CrI)"),
              h("span", { class: "br-mono" }, `${lat.median.toFixed(2)}${lat.lower != null && lat.upper != null ? ` (${lat.lower.toFixed(2)}–${lat.upper.toFixed(2)})` : ""}`),
            ),
            h("div", { class: "br-kv-row" },
              h("span", null, "Status"),
              h("span", { class: "br-mono" }, `${lat.category || "—"}${lat.p_growing != null ? ` · ${Math.round(lat.p_growing * 100)}%` : ""}`),
            ),
          ),
          renderRtMiniChart(matchedRt),
        ));
      }

      outSec.appendChild(
        railBlocks.length
          ? h("div", { class: "br-outlook-grid" }, chartCol, h("aside", { class: "br-rail", "aria-label": "Forecast details" }, railBlocks))
          : chartCol,
      );
      page.appendChild(outSec);
    }

    // 4. SUB-REGIONS ONLY (By State or Within State — never neighbor country lists)
    if (peers?.rows?.length) {
      const showRtCol = peers.rows.some((r) => r.rt?.median != null);
      const canOpenRowChart = !!(peers.hub_id && peers.target_id);
      const unitCol = peers.unit ? `Latest (${peers.unit})` : "Latest";

      const peerSec = h("section", { class: "br-section", "aria-label": peers.title || "Sub-regions" },
        h("div", { class: "br-section-head" },
          h("h2", { class: "br-h2" }, peers.title),
          h("div", { class: "br-head-meta" },
            h("span", null, `${peers.rows.length}${peers.total_count > peers.rows.length ? ` of ${peers.total_count}` : ""} areas`),
          ),
        ),
        h("div", { class: "br-table-wrap" },
          h("table", { class: "br-table" },
            h("thead", null, h("tr", null,
              h("th", null, "Area"),
              h("th", { class: "num" }, unitCol),
              h("th", { class: "num" }, "1-wk change"),
              h("th", null, "10-wk trend"),
              showRtCol ? h("th", { class: "num" }, "Rt") : null,
              canOpenRowChart ? h("th", { class: "num br-col-action" }, "") : null,
            )),
            h("tbody", null,
              peers.rows.map((row) => {
                const valTxt = formatMetricValue(row.value, { unit: peers.unit, per100k: String(peers.unit).includes("100k") });
                return h("tr", {
                  class: "is-clickable",
                  tabindex: "0",
                  onclick: () => fetchAndRender(row.key),
                  onkeydown: (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      fetchAndRender(row.key);
                    }
                  },
                },
                h("td", null, row.name),
                h("td", { class: "num br-mono" }, valTxt),
                h("td", { class: ["num br-mono", deltaClass(row.pct_1wk)] }, formatSignedPct(row.pct_1wk)),
                h("td", null, renderSparklineSvg(row.sparkline)),
                showRtCol ? h("td", { class: "num br-mono" }, row.rt?.median != null ? row.rt.median.toFixed(2) : "—") : null,
                canOpenRowChart ? h("td", { class: "num br-col-action" },
                  h("button", {
                    type: "button",
                    class: "br-link-btn br-row-chart-btn",
                    onclick: (e) => {
                      e.stopPropagation();
                      openSignalInChart({
                        hub_id: peers.hub_id,
                        target_id: peers.target_id,
                        location_id: row.location_id || row.key,
                        ref_date: peers.ref_date,
                        model_id: peers.model_id,
                      });
                    },
                  }, "Chart ↗"),
                ) : null,
                );
              }),
            ),
          ),
        ),
      );
      page.appendChild(peerSec);
    }

    // 5. SURVEILLANCE INDICATORS & LARGE FULL-WIDTH VARIANT / SUBTYPE CHARTS
    const virSec = h("section", { class: "br-section", "aria-label": "Surveillance and circulating strains" },
      h("div", { class: "br-section-head" },
        h("h2", { class: "br-h2" }, "Surveillance & Circulating Strains"),
        h("div", { class: "br-head-meta" },
          h("span", null, place.clade_region || ""),
        ),
      ),
    );

    if (!virology.feeds_cached && !isWeb) {
      virSec.appendChild(h("div", { class: "br-cta-banner" },
        h("div", { class: "br-cta-copy" },
          h("strong", null, "External surveillance and genomic feeds are not yet cached locally."),
          h("span", null, "Fetch CDC wastewater, ED visits, lab positivity, ECDC ERVISS, WHO FluNet subtypes, UKHSA, and Nextstrain clades."),
        ),
        h("button", {
          type: "button",
          class: "br-btn is-primary",
          disabled: refreshing,
          onclick: triggerRefresh,
        }, refreshing ? "Fetching…" : "Fetch live surveillance feeds"),
      ));
    }

    // 5a. Clean combined surveillance table (Wastewater, ED Visits %, PCR Positivity, ECDC ERVISS)
    const survRows = [];
    for (const ec of virology.ecdc_surveillance || []) {
      const valStr = ec.unit === "%" ? `${ec.latest_value.toFixed(1)}%` : `${ec.latest_value.toFixed(1)} ${ec.unit}`;
      survRows.push({
        metric: ec.label,
        source: `${ec.source || "ECDC ERVISS"} · ${ec.geo_scope}`,
        value: valStr,
        delta: ec.pct_1wk,
        date: formatIsoShort(ec.latest_date),
        spark: (ec.series || []).map((p) => p.value),
      });
    }
    for (const w of virology.wastewater || []) {
      survRows.push({
        metric: `${w.label} wastewater`,
        source: `CDC NWSS · ${w.geo_scope}`,
        value: `${w.latest_wval.toFixed(1)} WVAL`,
        delta: w.pct_1wk,
        date: formatIsoShort(w.latest_date),
        spark: w.series.map((p) => p.value),
      });
    }
    for (const ed of virology.ed_visits || []) {
      survRows.push({
        metric: `${ed.label} ED visits`,
        source: `CDC NSSP · ${ed.geo_scope}`,
        value: `${ed.latest_pct.toFixed(1)}%`,
        delta: ed.pct_1wk,
        date: formatIsoShort(ed.latest_date),
        spark: ed.series.map((p) => p.value),
      });
    }
    for (const nr of virology.nrevss_positivity || []) {
      survRows.push({
        metric: `${nr.label} lab positivity`,
        source: `CDC NREVSS · ${nr.geo_scope}`,
        value: `${nr.latest_pct.toFixed(1)}%`,
        delta: nr.pct_1wk,
        date: formatIsoShort(nr.latest_date),
        spark: nr.series.map((p) => p.value),
      });
    }
    for (const uk of virology.ukhsa_positivity || []) {
      survRows.push({
        metric: `${uk.label} PCR positivity`,
        source: `UKHSA · ${uk.geo_scope}`,
        value: `${uk.latest_pct.toFixed(1)}%`,
        delta: uk.pct_1wk,
        date: formatIsoShort(uk.latest_date),
        spark: uk.series.map((p) => p.value),
      });
    }

    if (survRows.length) {
      virSec.appendChild(h("div", { class: "br-table-wrap" },
        h("table", { class: "br-table" },
          h("thead", null, h("tr", null,
            h("th", null, "Indicator"),
            h("th", { class: "num" }, "Latest"),
            h("th", { class: "num" }, "1-wk"),
            h("th", null, "Trend"),
            h("th", { class: "num" }, "As of"),
          )),
          h("tbody", null, survRows.map((r) => h("tr", null,
            h("td", null, r.metric, h("div", { class: "br-scope-note" }, r.source)),
            h("td", { class: "num br-mono" }, r.value),
            h("td", { class: ["num br-mono", deltaClass(r.delta)] }, formatSignedPct(r.delta)),
            h("td", null, renderSparklineSvg(r.spark)),
            h("td", { class: "num br-mono" }, r.date),
          ))),
        ),
      ));
    }

    // 5b. Full-width Large Circulating Clades Chart (Nextstrain)
    const clades = virology.clades || [];
    if (clades.length) {
      const cladeObj = clades[activeCladeIdx] || clades[0];
      const cladeReadout = h("div", { class: "br-hover-readout", "aria-live": "polite" }, "");
      const cladeSvg = renderLargeCladeSvg(cladeObj, (txt) => { cladeReadout.textContent = txt; });

      virSec.appendChild(h("div", { class: "br-subpanel" },
        h("div", { class: "br-subhead" },
          h("h3", { class: "br-h3" }, "Circulating Variants"),
          h("span", { class: "br-scope-note" }, `Nextstrain ${cladeObj.region} · through ${formatIsoShort(cladeObj.latest_date, true)}`),
        ),
        clades.length > 1 ? h("div", { class: "br-tabs", role: "tablist", "aria-label": "Variant lineage" },
          clades.map((c, idx) => h("button", {
            type: "button",
            role: "tab",
            class: "br-tab",
            "aria-selected": String(idx === activeCladeIdx),
            onclick: () => {
              activeCladeIdx = idx;
              render();
            },
          }, c.subtype)),
        ) : null,
        cladeSvg ? h("div", { class: "br-svg-wrap" }, cladeSvg) : null,
        cladeReadout,
      ));
    }

    // 5c. Full-width Large Multi-Week Influenza Subtypes Chart (WHO FluNet / Delphi)
    const fluSub = virology.flu_subtypes;
    if (fluSub?.series?.length) {
      const subReadout = h("div", { class: "br-hover-readout", "aria-live": "polite" }, "");
      const rendered = renderLargeSubtypeSvg(fluSub.series, (txt) => { subReadout.textContent = txt; });
      if (rendered) {
        const metaParts = [
          fluSub.subtyping_geo_scope || fluSub.geo_scope,
          fluSub.percent_positive != null ? `${fluSub.percent_positive.toFixed(1)}% clinical positivity${fluSub.geo_scope && fluSub.geo_scope !== fluSub.subtyping_geo_scope ? ` (${fluSub.geo_scope})` : ""}` : null,
        ].filter(Boolean);
        virSec.appendChild(h("div", { class: "br-subpanel" },
          h("div", { class: "br-subhead" },
            h("h3", { class: "br-h3" }, "Weekly Influenza Subtype Detections"),
            h("span", { class: "br-scope-note" }, metaParts.join(" · ")),
          ),
          h("div", { class: "br-svg-wrap" }, rendered.svg),
          subReadout,
          h("div", { class: "br-legend-row" },
            rendered.legend.map((sp) => h("span", { class: "br-legend-item" },
              h("span", { class: "br-swatch-sq", style: { background: `var(${sp.colorVar})` } }),
              sp.label,
            )),
          ),
        ));
      }
    }

    // 5d. Vaccine Reference Strains (compact collapsible)
    const vaccRows = virology.vaccine_reference || [];
    if (vaccRows.length) {
      const curSeason = virology.vaccine_season || "2026-27";
      const curRows = vaccRows.filter((r) => r.season === curSeason);
      const prevRows = vaccRows.filter((r) => r.season !== curSeason);
      const renderVaccTable = (rows) => h("div", { class: "br-table-wrap", style: { marginTop: "10px" } },
        h("table", { class: "br-table" },
          h("thead", null, h("tr", null,
            h("th", null, "Season"),
            h("th", null, "Subtype"),
            h("th", null, "Egg / Primary"),
            h("th", null, "Cell / Recombinant"),
            h("th", null, "Source"),
          )),
          h("tbody", null, rows.map((r) => {
            const refUrl = safeHref(r.url);
            return h("tr", null,
              h("td", { class: "br-mono" }, r.season),
              h("td", null, `${r.pathogen} · ${r.subtype}`),
              h("td", null, r.egg_strain),
              h("td", null, r.cell_strain),
              h("td", null, refUrl ? h("a", { href: refUrl, target: "_blank", rel: "noopener noreferrer", class: "br-link-btn" }, r.authority, " ↗") : (r.authority || "—")),
            );
          })),
        ),
      );
      virSec.appendChild(h("details", { class: "br-details" },
        h("summary", null,
          h("span", null, `Northern Hemisphere Reference Vaccine Strains (${curSeason})`),
          h("span", { class: "br-mono" }, "WHO / FDA"),
        ),
        renderVaccTable(curRows.length ? [...curRows, ...prevRows] : vaccRows),
      ));
    }

    if (place.jurisdiction_scope !== "cd") {
      page.appendChild(virSec);
    }

    // 6. COLLAPSIBLE DATA SOURCES AUDIT
    const feedList = sources.feeds || [];
    const cachedCount = feedList.filter((f) => f.cached).length;
    const hubList = sources.hubs || [];
    const auditSec = h("details", { class: "br-details" },
      h("summary", null,
        h("span", null, "Data Sources"),
        h("span", { class: "br-mono" }, `${hubList.length} hub${hubList.length === 1 ? "" : "s"} · ${cachedCount}/${feedList.length} feeds cached`),
      ),
      h("div", { class: "br-table-wrap", style: { marginTop: "12px" } },
        h("table", { class: "br-table" },
          h("thead", null, h("tr", null,
            h("th", null, "Source"),
            h("th", null, "Scope"),
            h("th", null, "Latest"),
            h("th", { class: "num" }, "Rows"),
            h("th", null, "Fetched"),
            h("th", null, "Status"),
          )),
          h("tbody", null,
            ...hubList.map((hb) => h("tr", null,
              h("td", null, hb.label),
              h("td", null, hb.location_id),
              h("td", { class: "br-mono" }, hb.latest_obs_date || hb.latest_ref_date || "—"),
              h("td", { class: "num br-mono" }, "Hub"),
              h("td", { class: "br-mono" }, hb.latest_ref_date ? `Ref ${hb.latest_ref_date}` : "Synced"),
              h("td", null, "Ready"),
            )),
            ...feedList.map((f) => {
              const srcUrl = safeHref(f.source_url);
              return h("tr", null,
                h("td", null,
                  srcUrl
                    ? h("a", { href: srcUrl, target: "_blank", rel: "noopener noreferrer", class: "br-link-btn" }, f.label, " ↗")
                    : (f.label || "—"),
                ),
                h("td", null, f.scope),
                h("td", { class: "br-mono" }, f.latest_week || "—"),
                h("td", { class: "num br-mono" }, f.cached ? String(f.rows ?? 0) : "0"),
                h("td", { class: "br-mono" }, f.fetched_at ? formatTimeAgo(f.fetched_at) : "not fetched"),
                h("td", { style: f.error ? { color: "var(--status-error)" } : null },
                  f.error ? `Error: ${f.error}` : (f.cached ? (f.stale ? "Stale" : "Ready") : "Uncached"),
                ),
              );
            }),
          ),
        ),
      ),
    );
    page.appendChild(auditSec);

    const hubNames = hubList.map((hb) => hb.label).join(", ");
    page.appendChild(h("footer", { class: "br-print-footer" },
      h("span", null, `${place.name}${repWeek ? ` · ${formatIsoShort(repWeek, true)}` : ""}`),
      h("span", null, `${hubNames ? `Hubs: ${hubNames} · ` : ""}Printed ${new Date().toISOString().slice(0, 10)}`),
    ));

    host.append(h("div", { class: "br-scroll-scrim", "aria-hidden": "true" }), page);
  }

  fetchAndRender(currentPlace);

  return {
    loadPlace(nextKey) {
      if (nextKey && nextKey !== currentPlace) return fetchAndRender(nextKey);
      return Promise.resolve();
    },
    refresh() {
      invalidateBriefingCache();
      return fetchAndRender(currentPlace, { bust: true, preserveTabs: true });
    },
    destroy() {
      destroyed = true;
      stopPoll();
      loadToken += 1;
      host.replaceChildren();
    },
  };
}
