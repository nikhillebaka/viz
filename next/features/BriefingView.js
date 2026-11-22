/* Place-First Live Briefing view — multi-hub synthesis + live external surveillance & virology. */

import { h } from "../lib/dom.js";
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
  buildStackedSegments,
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

function renderSparklineSvg(values, { width = 92, height = 22, tone = "var(--ink-secondary)" } = {}) {
  const geom = buildSparklineGeometry(values, width, height, 2);
  if (!geom.path) return h("span", { class: "br-delta-flat" }, "—");
  return svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: "br-spark",
    "aria-hidden": "true",
  },
  svgEl("path", { d: geom.path, fill: "none", stroke: tone, "stroke-width": 1.5, "stroke-linecap": "round", "stroke-linejoin": "round" }),
  svgEl("circle", { cx: geom.lastX, cy: geom.lastY, r: 2, fill: tone }));
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

  // Grid & Y ticks
  for (const t of g.yTicks) {
    svg.appendChild(svgEl("line", {
      x1: g.pad.l, x2: g.width - g.pad.r, y1: t.y, y2: t.y,
      class: "br-grid-line",
    }));
    svg.appendChild(svgEl("text", {
      x: g.pad.l - 6, y: t.y + 3,
      "text-anchor": "end",
      class: "br-axis-text",
    }, t.label));
  }

  // Forecast shading region
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
      x: Math.min(g.width - g.pad.r - 4, g.fan.refX + 5),
      y: g.pad.t + 10,
      class: "br-axis-text",
    }, `Forecast (${formatIsoShort(g.fan.refDate)})`));
  }

  // Optional prior season waves (season week aligned)
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

  // Forecast intervals + median
  if (g.fan) {
    if (g.fan.q95Path) svg.appendChild(svgEl("path", { d: g.fan.q95Path, fill: "var(--series-1)", opacity: 0.12 }));
    if (g.fan.q80Path) svg.appendChild(svgEl("path", { d: g.fan.q80Path, fill: "var(--series-1)", opacity: 0.2 }));
    if (g.fan.q50Path) svg.appendChild(svgEl("path", { d: g.fan.q50Path, fill: "var(--series-1)", opacity: 0.3 }));
    if (g.fan.medianPath) {
      svg.appendChild(svgEl("path", {
        d: g.fan.medianPath,
        fill: "none",
        stroke: "var(--series-1)",
        "stroke-width": 2.2,
        "stroke-linecap": "round",
      }));
    }
    for (const pt of g.fan.points) {
      svg.appendChild(svgEl("circle", { cx: pt.x, cy: pt.y, r: 2.8, fill: "var(--series-1)" }));
    }
  }

  // Observed line & vertices
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
      svg.appendChild(svgEl("circle", { cx: pt.x, cy: pt.y, r: 2.3, fill: "var(--ink-primary)" }));
    }
  }

  // X ticks
  for (const xt of g.xTicks) {
    svg.appendChild(svgEl("text", {
      x: xt.x, y: g.height - 8,
      "text-anchor": "middle",
      class: "br-axis-text",
    }, xt.label));
  }

  // Interactive hover crosshair & overlay
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
        onReadout(`${formatIsoShort(best.date, true)} · Observed: ${fmt(best.value)}${unitLbl}`);
      } else {
        const q = best.q95;
        const band = q && q[0] != null && q[1] != null ? ` (95% PI ${fmt(q[0])}–${fmt(q[1])})` : "";
        onReadout(`${formatIsoShort(best.date, true)} · Forecast median (h${best.horizon}): ${fmt(best.median)}${unitLbl}${band}`);
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

function renderCladeTimelineSvg(cladeObj) {
  const g = buildCladeTimelineGeometry(cladeObj);
  if (!g.areas.length) return null;
  const svg = svgEl("svg", {
    viewBox: `0 0 ${g.width} ${g.height}`,
    class: "br-svg",
    role: "img",
    "aria-label": `${cladeObj.subtype} clade prevalence over time`,
  });
  for (const yt of g.yTicks) {
    svg.appendChild(svgEl("line", { x1: g.pad.l, x2: g.width - g.pad.r, y1: yt.y, y2: yt.y, class: "br-grid-line" }));
    svg.appendChild(svgEl("text", { x: g.pad.l - 5, y: yt.y + 3, "text-anchor": "end", class: "br-axis-text" }, yt.label));
  }
  for (const a of g.areas) {
    if (!a.path) continue;
    svg.appendChild(svgEl("path", {
      d: a.path,
      fill: `var(${a.colorVar})`,
      "fill-opacity": 0.85,
      stroke: "var(--surface-paper)",
      "stroke-width": 0.8,
    }, svgEl("title", null, `${a.clade}: ${a.latestPct}% latest`)));
  }
  for (const xt of g.xTicks) {
    svg.appendChild(svgEl("text", { x: xt.x, y: g.height - 6, "text-anchor": "middle", class: "br-axis-text" }, xt.label));
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
  const width = 270;
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
  let showPriorSeasons = false;
  let loadToken = 0;
  let pollTimer = null;
  let refreshing = false;
  let errorMsg = null;

  function stopPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function startPoll() {
    stopPoll();
    pollTimer = setTimeout(async () => {
      try {
        const st = await loadBriefingStatus();
        refreshing = !!st?.refreshing;
        if (refreshing) {
          startPoll();
          return;
        }
        invalidateBriefingCache();
        await fetchAndRender(currentPlace, { bust: true, preserveSignal: true });
      } catch {
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
      refreshing = !!res?.status?.refreshing;
      if (refreshing) {
        startPoll();
      } else {
        invalidateBriefingCache();
        await fetchAndRender(currentPlace, { bust: true, preserveSignal: true });
      }
    } catch (e) {
      refreshing = false;
      errorMsg = e?.message || "Failed to start feed refresh";
      render();
    }
  }

  async function fetchAndRender(targetPlace, { bust = false, preserveSignal = false } = {}) {
    const token = ++loadToken;
    errorMsg = null;
    if (!data) renderLoading();
    try {
      const res = await loadBriefing(targetPlace || "", { bust });
      if (token !== loadToken) return;
      const prevSigId = preserveSignal ? data?.signals?.[activeSignalIdx]?.signal_id : null;
      data = res;
      currentPlace = res?.place?.key || targetPlace || null;
      refreshing = !!res?.feed_status?.refreshing;
      if (refreshing) startPoll();
      if (prevSigId && Array.isArray(res?.signals)) {
        const idx = res.signals.findIndex((s) => s.signal_id === prevSigId);
        activeSignalIdx = idx >= 0 ? idx : 0;
      } else {
        activeSignalIdx = 0;
      }
      onPlaceChange?.(currentPlace);
      render();
    } catch (e) {
      if (token !== loadToken) return;
      errorMsg = e?.message || "Failed to load briefing";
      render();
    }
  }

  function renderLoading() {
    host.replaceChildren();
    host.appendChild(
      h("div", { class: "br-page" },
        h("header", { class: "br-masthead" },
          h("span", { class: "br-kicker" }, "Place Briefing"),
          h("h1", { class: "br-h1" }, "Loading briefing…"),
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
        ? h("optgroup", { label }, list.map((c) => h("option", { value: c.key, selected: c.key === currentPlace }, `${c.name} (${c.abbr})`)))
        : null;

    const sel = h("select", {
      class: "br-select",
      "aria-label": "Jump to location briefing",
      onchange: (e) => {
        const nextKey = e.target.value;
        if (nextKey && nextKey !== currentPlace) fetchAndRender(nextKey);
      },
    },
    makeGroup("National & Countries", groups.national),
    makeGroup("States & Territories", groups.states),
    makeGroup("Cities, Regions & HSAs", groups.substate),
    );
    return sel;
  }

  function openSignalInChart(sig, goScores = false) {
    if (!sig) return;
    if (goScores && onOpenScores) {
      onOpenScores(sig);
    } else if (onOpenChart) {
      onOpenChart(sig);
    } else if (ctx?.switchContext) {
      ctx.switchContext({ hub: sig.hub_id, target: sig.target_id, location: sig.location_id, date: sig.ref_date });
    }
  }

  function render() {
    host.replaceChildren();
    if (!data && errorMsg) {
      host.appendChild(h("div", { class: "br-page" },
        h("header", { class: "br-masthead" },
          h("span", { class: "br-kicker" }, "Place Briefing"),
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
      host.appendChild(h("div", { class: "br-page" },
        h("header", { class: "br-masthead" },
          h("span", { class: "br-kicker" }, "Place Briefing"),
          h("h1", { class: "br-h1" }, "No synced forecast hubs"),
          h("p", { class: "br-prose" }, "Connect or sync a local or remote forecast hub from Data Sources or Globe to inspect place-first briefings."),
          h("div", { class: "br-actions" },
            onOpenGlobe ? h("button", { type: "button", class: "br-btn", onclick: () => onOpenGlobe() }, "Open Globe") : null,
          ),
        ),
      ));
      return;
    }

    const signals = data.signals || [];
    const activeSig = signals[activeSignalIdx] || signals[0] || null;
    const virology = data.virology || {};
    const peers = data.peers || {};
    const calibrations = data.calibration || [];
    const sources = data.sources || {};
    const repWeek = data.meta?.reporting_week;

    const page = h("div", { class: "br-page" });

    // 1. MASTHEAD
    const crumbBits = [];
    if (place.parent) {
      crumbBits.push(
        h("button", {
          type: "button",
          class: "br-link-btn",
          onclick: () => fetchAndRender(place.parent.key),
        }, place.parent.name),
        h("span", { "aria-hidden": "true" }, "›"),
      );
    }
    crumbBits.push(h("span", null, place.name));
    if (place.hhs_region_label) {
      crumbBits.push(h("span", { "aria-hidden": "true" }, "·"), h("span", null, `HHS ${place.hhs_region_label}`));
    }

    const subtitleParts = [
      place.level ? place.level.replace(/_/g, " ") : null,
      place.population ? `Pop. ${Number(place.population).toLocaleString("en-US")}` : null,
      `${sources.hubs?.length || 0} connected hub${(sources.hubs?.length || 0) === 1 ? "" : "s"}`,
    ].filter(Boolean);

    const refreshBtn = h("button", {
      type: "button",
      class: "br-btn",
      disabled: refreshing,
      onclick: triggerRefresh,
    }, refreshing ? "Refreshing feeds…" : "Refresh feeds");

    page.appendChild(h("header", { class: "br-masthead" },
      h("div", { class: "br-crumb-row" },
        h("nav", { class: "br-crumb", "aria-label": "Place hierarchy" }, crumbBits),
        repWeek ? h("span", { class: "br-mono" }, `Reporting week · ${formatIsoShort(repWeek, true)}`) : null,
      ),
      h("div", { class: "br-title-bar" },
        h("div", { class: "br-title-block" },
          h("span", { class: "br-kicker" }, "Epidemiological Briefing"),
          h("h1", { class: "br-h1" }, place.name),
          h("p", { class: "br-subtitle" }, subtitleParts.join(" · ")),
        ),
        h("div", { class: "br-actions" },
          buildChooserSelect(),
          onOpenGlobe ? h("button", { type: "button", class: "br-btn", onclick: () => onOpenGlobe() }, "Globe") : null,
          activeSig ? h("button", {
            type: "button",
            class: "br-btn",
            onclick: () => openSignalInChart(activeSig, false),
          }, "Chart ", h("span", { html: icon.open })) : null,
          h("button", { type: "button", class: "br-btn", onclick: () => window.print() }, "Print / PDF"),
          refreshBtn,
        ),
      ),
      errorMsg ? h("p", { class: "br-scope-note", style: { color: "var(--status-error)" } }, errorMsg) : null,
    ));

    // 2. SUMMARY & ADAPTIVE KPIS
    const summaryEl = h("section", { class: "br-summary-wrap", "aria-label": "Situation summary" },
      (data.summary?.paragraphs || []).map((p) => h("p", { class: "br-prose" }, p)),
      data.summary?.scope_note ? h("p", { class: "br-scope-note" }, data.summary.scope_note) : null,
    );
    if (data.kpis?.length) {
      summaryEl.appendChild(h("div", { class: "br-kpi-strip" },
        data.kpis.map((k) => h("div", { class: "br-kpi" },
          h("span", { class: "br-kpi-label", title: k.label }, k.label),
          h("div", { class: "br-kpi-val" },
            h("span", null, k.value),
            k.unit ? h("span", { class: "br-kpi-unit" }, k.unit) : null,
          ),
          k.sub ? h("span", { class: "br-kpi-sub" }, k.sub) : null,
        )),
      ));
    }
    page.appendChild(summaryEl);

    // 3. ACTIVITY & FORECAST OUTLOOK
    if (signals.length && activeSig) {
      const outSec = h("section", { class: "br-section", "aria-label": "Activity and forecast outlook" });
      outSec.appendChild(h("div", { class: "br-section-head" },
        h("h2", { class: "br-h2" }, "Activity & Forecast Outlook"),
        h("div", { class: "br-head-meta" },
          h("span", null, `${activeSig.hub_label} · Season ${activeSig.season}`),
          h("button", {
            type: "button",
            class: "br-link-btn is-accent",
            onclick: () => openSignalInChart(activeSig, false),
          }, "Open in Chart ", h("span", { html: icon.open })),
        ),
      ));

      if (signals.length > 1) {
        outSec.appendChild(h("div", { class: "br-tabs", role: "tablist", "aria-label": "Connected forecast signals" },
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
            `Show ${activeSig.prior_seasons.length} prior season${activeSig.prior_seasons.length > 1 ? "s" : ""}`,
          )
        : null;

      const svgChart = renderOutlookSvg(activeSig, {
        showPrior: showPriorSeasons,
        onReadout: (txt) => { readoutEl.textContent = txt; },
      });

      const legendItems = [
        h("span", { class: "br-legend-item" }, h("span", { class: "br-swatch", style: { background: "var(--ink-primary)" } }), "Observed"),
        activeSig.fan ? h("span", { class: "br-legend-item" }, h("span", { class: "br-swatch", style: { background: "var(--series-1)" } }), `${activeSig.fan.model_id} median + 50/80/95% PI`) : null,
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
          h("span", null, `${activeSig.target_short}${activeSig.unit ? ` (${activeSig.unit})` : ""} · Ref. ${formatIsoShort(activeSig.ref_date, true)}`),
          priorCheckbox,
        ),
        h("div", { class: "br-svg-wrap" }, svgChart),
        readoutEl,
        h("div", { class: "br-legend-row" }, legendItems),
      );

      // Right rail: PMF, Peak Outlook, matched CFA Rt
      const matchedRt = (virology.cfa_rt || []).find((r) => r.pathogen === activeSig.pathogen) || (virology.cfa_rt?.[0] ?? null);
      const pmfBars = normalizeRateChangePmf(activeSig.rate_change_pmf);
      const pk = activeSig.peak_outlook;
      const railBlocks = [];

      if (pmfBars.length) {
        const pmfMeta = activeSig.rate_change_pmf;
        railBlocks.push(h("div", { class: "br-rail-block" },
          h("div", { class: "br-rail-title" },
            h("span", null, pmfMeta.label || "Weekly Rate Change"),
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
          h("span", { class: "br-scope-note" }, `${pmfMeta.model_id} · horizon h${pmfMeta.horizon}`),
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
          h("div", { class: "br-rail-title" }, h("span", null, "Season Peak Outlook"), h("span", null, pk.model_id)),
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
              h("span", null, "Median Rt (95% CrI)"),
              h("span", { class: "br-mono" }, `${lat.median.toFixed(2)}${lat.lower != null && lat.upper != null ? ` (${lat.lower.toFixed(2)}–${lat.upper.toFixed(2)})` : ""}`),
            ),
            h("div", { class: "br-kv-row" },
              h("span", null, "Category / P(grow)"),
              h("span", { class: "br-mono" }, `${lat.category || "—"}${lat.p_growing != null ? ` · ${Math.round(lat.p_growing * 100)}%` : ""}`),
            ),
          ),
          renderRtMiniChart(matchedRt),
        ));
      }

      outSec.appendChild(
        railBlocks.length
          ? h("div", { class: "br-outlook-grid" }, chartCol, h("aside", { class: "br-rail", "aria-label": "Secondary indicators" }, railBlocks))
          : chartCol,
      );
      page.appendChild(outSec);
    }

    // 4. WHERE IT IS SPREADING
    if (peers?.rows?.length) {
      const showRtCol = peers.rows.some((r) => r.rt?.median != null);
      const showWhoCol = peers.rows.some((r) => r.who_pct_pos != null);
      const unitCol = peers.unit ? `Latest (${peers.unit})` : "Latest";

      const peerSec = h("section", { class: "br-section", "aria-label": "Geographic distribution" },
        h("div", { class: "br-section-head" },
          h("h2", { class: "br-h2" }, "Where It Is Spreading"),
          h("div", { class: "br-head-meta" },
            h("span", null, `${peers.title} · showing ${peers.rows.length}${peers.total_count > peers.rows.length ? ` of ${peers.total_count}` : ""}`),
          ),
        ),
        h("div", { class: "br-table-wrap" },
          h("table", { class: "br-table" },
            h("thead", null, h("tr", null,
              h("th", null, "Jurisdiction"),
              h("th", { class: "num" }, unitCol),
              h("th", { class: "num" }, "1-wk Change"),
              h("th", null, "10-wk Trend"),
              showRtCol ? h("th", { class: "num" }, "Rt (CFA)") : null,
              showWhoCol ? h("th", { class: "num" }, "Flu % Pos") : null,
            )),
            h("tbody", null,
              peers.rows.map((row) => {
                const isFocal = row.key === peers.focal_key;
                const valTxt = formatMetricValue(row.value, { unit: peers.unit, per100k: String(peers.unit).includes("100k") });
                const tr = h("tr", {
                  class: ["is-clickable", isFocal && "is-focal"],
                  tabindex: "0",
                  onclick: () => { if (!isFocal) fetchAndRender(row.key); },
                  onkeydown: (e) => {
                    if ((e.key === "Enter" || e.key === " ") && !isFocal) {
                      e.preventDefault();
                      fetchAndRender(row.key);
                    }
                  },
                },
                h("td", null, row.name, isFocal ? h("span", { class: "br-scope-note" }, " · current") : null),
                h("td", { class: "num br-mono" }, valTxt),
                h("td", { class: ["num br-mono", deltaClass(row.pct_1wk)] }, formatSignedPct(row.pct_1wk)),
                h("td", null, renderSparklineSvg(row.sparkline)),
                showRtCol ? h("td", { class: "num br-mono" }, row.rt?.median != null ? `${row.rt.median.toFixed(2)} ${row.rt.category || ""}`.trim() : "—") : null,
                showWhoCol ? h("td", { class: "num br-mono" }, row.who_pct_pos != null ? `${row.who_pct_pos.toFixed(1)}%` : "—") : null,
                );
                return tr;
              }),
            ),
          ),
        ),
      );
      page.appendChild(peerSec);
    }

    // 5. VIROLOGY, VARIANTS & VACCINE MATCH
    const virSec = h("section", { class: "br-section", "aria-label": "Virology and vaccine composition" },
      h("div", { class: "br-section-head" },
        h("h2", { class: "br-h2" }, "Virology, Variants & Vaccine Reference"),
        h("div", { class: "br-head-meta" },
          h("span", null, place.clade_region ? `Regional genomics: ${place.clade_region}` : "Reference composition"),
        ),
      ),
    );

    if (!virology.feeds_cached) {
      virSec.appendChild(h("div", { class: "br-cta-banner" },
        h("div", { class: "br-cta-copy" },
          h("strong", null, "Live surveillance & virology feeds are not yet cached locally."),
          h("span", null, "Fetch open CDC NWSS wastewater, CFA Rt, NSSP ED visits, NREVSS/Delphi clinical labs, WHO FluNet, UKHSA, and Nextstrain clade feeds to populate this section."),
        ),
        h("button", {
          type: "button",
          class: "br-btn is-primary",
          disabled: refreshing,
          onclick: triggerRefresh,
        }, refreshing ? "Fetching feeds…" : "Fetch live surveillance & virology feeds"),
      ));
    }

    const virPanels = [];

    // 5a. Wastewater (US/State)
    if (virology.wastewater?.length) {
      virPanels.push(h("div", { class: "br-vir-panel" },
        h("div", { class: "br-rail-title" },
          h("span", null, "Wastewater Viral Activity (CDC NWSS)"),
          h("span", null, virology.wastewater[0].geo_scope),
        ),
        h("table", { class: "br-table" },
          h("thead", null, h("tr", null,
            h("th", null, "Pathogen"),
            h("th", { class: "num" }, "WVAL"),
            h("th", { class: "num" }, "1-wk"),
            h("th", null, "Trend"),
          )),
          h("tbody", null, virology.wastewater.map((w) => h("tr", null,
            h("td", null, w.label, h("div", { class: "br-scope-note" }, `${w.sites} sites · ${formatIsoShort(w.latest_date)}`)),
            h("td", { class: "num br-mono" }, w.latest_wval.toFixed(2)),
            h("td", { class: ["num br-mono", deltaClass(w.pct_1wk)] }, formatSignedPct(w.pct_1wk)),
            h("td", null, renderSparklineSvg(w.series.map((p) => p.value))),
          ))),
        ),
      ));
    }

    // 5b. Emergency Dept Visits (US/State)
    if (virology.ed_visits?.length) {
      virPanels.push(h("div", { class: "br-vir-panel" },
        h("div", { class: "br-rail-title" },
          h("span", null, "Emergency Dept. Visits % (CDC NSSP)"),
          h("span", null, virology.ed_visits[0].geo_scope),
        ),
        h("table", { class: "br-table" },
          h("thead", null, h("tr", null,
            h("th", null, "Pathogen"),
            h("th", { class: "num" }, "% ED"),
            h("th", { class: "num" }, "1-wk"),
            h("th", null, "Trend"),
          )),
          h("tbody", null, virology.ed_visits.map((ed) => h("tr", null,
            h("td", null, ed.label, h("div", { class: "br-scope-note" }, formatIsoShort(ed.latest_date))),
            h("td", { class: "num br-mono" }, `${ed.latest_pct.toFixed(1)}%`),
            h("td", { class: ["num br-mono", deltaClass(ed.pct_1wk)] }, formatSignedPct(ed.pct_1wk)),
            h("td", null, renderSparklineSvg(ed.series.map((p) => p.value))),
          ))),
        ),
      ));
    }

    // 5c. Lab Positivity (NREVSS or UKHSA)
    const labRows = [
      ...(virology.nrevss_positivity || []).map((x) => ({ ...x, sourceTag: "NREVSS" })),
      ...(virology.ukhsa_positivity || []).map((x) => ({ ...x, sourceTag: "UKHSA" })),
    ];
    if (labRows.length) {
      virPanels.push(h("div", { class: "br-vir-panel" },
        h("div", { class: "br-rail-title" },
          h("span", null, "Sentinel PCR Test Positivity"),
          h("span", null, labRows[0].geo_scope),
        ),
        h("table", { class: "br-table" },
          h("thead", null, h("tr", null,
            h("th", null, "Pathogen"),
            h("th", { class: "num" }, "% Pos"),
            h("th", { class: "num" }, "1-wk"),
            h("th", null, "Trend"),
          )),
          h("tbody", null, labRows.map((lb) => h("tr", null,
            h("td", null, lb.label, h("div", { class: "br-scope-note" }, `${lb.sourceTag} · ${formatIsoShort(lb.latest_date)}`)),
            h("td", { class: "num br-mono" }, `${lb.latest_pct.toFixed(1)}%`),
            h("td", { class: ["num br-mono", deltaClass(lb.pct_1wk)] }, formatSignedPct(lb.pct_1wk)),
            h("td", null, renderSparklineSvg(lb.series.map((p) => p.value))),
          ))),
        ),
      ));
    }

    // 5d. Influenza Subtypes (Delphi + WHO FluNet)
    if (virology.flu_subtypes?.latest_counts) {
      const fs = virology.flu_subtypes;
      const c = fs.latest_counts;
      const segs = buildStackedSegments([
        { label: "A(H1N1)pdm09", value: c.ah1n1pdm09, colorVar: "--series-2" },
        { label: "A(H3N2)", value: c.ah3n2, colorVar: "--series-3" },
        { label: "A (unsubtyped)", value: Math.max(0, (c.inf_a || 0) - (c.ah1n1pdm09 || 0) - (c.ah3n2 || 0)) || c.a_unsubtyped, colorVar: "--ink-tertiary" },
        { label: "Influenza B", value: c.inf_b, colorVar: "--series-4" },
      ]);
      virPanels.push(h("div", { class: "br-vir-panel" },
        h("div", { class: "br-rail-title" },
          h("span", null, "Influenza Subtype Composition"),
          h("span", null, fs.subtyping_geo_scope || fs.geo_scope),
        ),
        h("div", { class: "br-kv-list" },
          fs.percent_positive != null ? h("div", { class: "br-kv-row" },
            h("span", null, `Clinical % positivity (${fs.geo_scope})`),
            h("span", { class: "br-mono" }, `${fs.percent_positive.toFixed(1)}%${fs.total_specimens ? ` of ${fs.total_specimens.toLocaleString("en-US")}` : ""}`),
          ) : null,
          h("div", { class: "br-kv-row" },
            h("span", null, "Subtyped week"),
            h("span", { class: "br-mono" }, formatIsoShort(c.date, true)),
          ),
        ),
        segs.length
          ? [
              h("div", { class: "br-stacked-bar", role: "img", "aria-label": "Influenza subtype proportions" },
                segs.map((s) => h("div", { style: { width: `${s.widthPct}%`, background: `var(${s.colorVar})` }, title: `${s.label}: ${s.pct}% (${s.value})` })),
              ),
              h("div", { class: "br-stacked-chips" },
                segs.map((s) => h("span", null, h("span", { class: "br-chip-dot", style: { background: `var(${s.colorVar})` } }), `${s.label} ${s.pct}%`)),
              ),
            ]
          : h("p", { class: "br-scope-note" }, "No positive influenza specimens reported in the most recent week."),
      ));
    }

    // 5e. Nextstrain Clades
    for (const cl of virology.clades || []) {
      const segs = buildStackedSegments(
        (cl.latest_shares || []).map((s, idx) => ({
          label: s.clade,
          value: s.pct,
          colorVar: s.clade === "Other" ? "--ink-faint" : `--series-${(idx % 8) + 1}`,
        })),
      );
      virPanels.push(h("div", { class: "br-vir-panel" },
        h("div", { class: "br-rail-title" },
          h("span", null, `${cl.subtype} Clades (Nextstrain)`),
          h("span", null, `${cl.region} · ${formatIsoShort(cl.latest_date)}`),
        ),
        segs.length
          ? [
              h("div", { class: "br-stacked-bar", role: "img", "aria-label": `${cl.subtype} latest clade breakdown` },
                segs.map((s) => h("div", { style: { width: `${s.widthPct}%`, background: `var(${s.colorVar})` }, title: `${s.label}: ${s.pct}%` })),
              ),
              h("div", { class: "br-stacked-chips" },
                segs.map((s) => h("span", null, h("span", { class: "br-chip-dot", style: { background: `var(${s.colorVar})` } }), `${s.label} ${s.pct}%`)),
              ),
              renderCladeTimelineSvg(cl),
            ]
          : h("p", { class: "br-scope-note" }, "No clade frequency estimates available."),
      ));
    }

    if (virPanels.length) virSec.appendChild(h("div", { class: "br-vir-grid" }, virPanels));

    // 5f. WHO Northern Hemisphere Vaccine Reference Table (strictly factual strain reference)
    const vaccRows = virology.vaccine_reference || [];
    if (vaccRows.length) {
      const curSeason = virology.vaccine_season || "2026-27";
      const curRows = vaccRows.filter((r) => r.season === curSeason);
      const prevRows = vaccRows.filter((r) => r.season !== curSeason);
      const renderVaccTable = (rows) => h("div", { class: "br-table-wrap" },
        h("table", { class: "br-table" },
          h("thead", null, h("tr", null,
            h("th", null, "Season"),
            h("th", null, "Target / Subtype"),
            h("th", null, "Egg / Primary Antigen"),
            h("th", null, "Cell / Recombinant"),
            h("th", null, "Authority"),
          )),
          h("tbody", null, rows.map((r) => h("tr", null,
            h("td", { class: "br-mono" }, r.season),
            h("td", null, `${r.pathogen} · ${r.subtype}`),
            h("td", null, r.egg_strain),
            h("td", null, r.cell_strain),
            h("td", null, h("a", { href: r.url, target: "_blank", rel: "noopener noreferrer", class: "br-link-btn" }, r.authority, " ↗")),
          ))),
        ),
      );
      virSec.appendChild(h("div", { class: "br-vir-panel" },
        h("div", { class: "br-rail-title" },
          h("span", null, `Northern Hemisphere Reference Vaccine Strains (${curSeason})`),
          h("span", null, "Reference strains vs circulating clades above"),
        ),
        renderVaccTable(curRows.length ? curRows : vaccRows),
        prevRows.length
          ? h("details", { class: "br-details" },
              h("summary", null, "Prior season reference strains"),
              renderVaccTable(prevRows),
            )
          : null,
      ));
    }
    page.appendChild(virSec);

    // 6. LOCAL FORECAST CALIBRATION
    if (calibrations.length) {
      const calSec = h("section", { class: "br-section", "aria-label": "Local forecast calibration" },
        h("div", { class: "br-section-head" },
          h("h2", { class: "br-h2" }, "Local Forecast Calibration"),
          h("div", { class: "br-head-meta" }, h("span", null, `Location-specific season scores in ${place.name}`)),
        ),
      );
      for (const calItem of calibrations) {
        const matchSig = signals.find((s) => s.signal_id === calItem.signal_id) || activeSig;
        calSec.appendChild(h("div", { class: "br-vir-panel" },
          h("div", { class: "br-rail-title" },
            h("span", null, `${calItem.signal_label} (${calItem.season}) · Baseline: ${calItem.baseline_model || "—"}`),
            matchSig ? h("button", {
              type: "button",
              class: "br-link-btn is-accent",
              onclick: () => openSignalInChart(matchSig, true),
            }, "Open Scores ", h("span", { html: icon.open })) : null,
          ),
          h("div", { class: "br-table-wrap" },
            h("table", { class: "br-table" },
              h("thead", null, h("tr", null,
                h("th", null, "#"),
                h("th", null, "Model"),
                h("th", { class: "num" }, "Rel. WIS"),
                h("th", { class: "num" }, "WIS"),
                h("th", { class: "num" }, "MAE"),
                h("th", { class: "num" }, "50% Cov"),
                h("th", { class: "num" }, "95% Cov"),
                h("th", { class: "num" }, "N"),
              )),
              h("tbody", null, calItem.models.map((m) => h("tr", {
                class: m.model_id === matchSig?.model_id ? "is-focal" : null,
              },
              h("td", { class: "br-mono" }, String(m.rank)),
              h("td", null, m.model_id),
              h("td", { class: "num br-mono" }, m.relative_wis != null ? m.relative_wis.toFixed(2) : "—"),
              h("td", { class: "num br-mono" }, m.wis != null ? m.wis.toFixed(2) : "—"),
              h("td", { class: "num br-mono" }, m.mae != null ? m.mae.toFixed(2) : "—"),
              h("td", { class: "num br-mono" }, m.cov50 != null ? `${m.cov50.toFixed(0)}%` : "—"),
              h("td", { class: "num br-mono" }, m.cov95 != null ? `${m.cov95.toFixed(0)}%` : "—"),
              h("td", { class: "num br-mono" }, String(m.count)),
              ))),
            ),
          ),
        ));
      }
      page.appendChild(calSec);
    }

    // 7. DATA SOURCES & FRESHNESS AUDIT
    const feedList = sources.feeds || [];
    const cachedCount = feedList.filter((f) => f.cached).length;
    const hubList = sources.hubs || [];
    const auditSec = h("details", { class: "br-details" },
      h("summary", null,
        h("span", null, "Data Sources & Freshness Audit"),
        h("span", { class: "br-mono" }, `${hubList.length} hub${hubList.length === 1 ? "" : "s"} · ${cachedCount}/${feedList.length} live feeds cached`),
      ),
      h("div", { class: "br-table-wrap", style: { marginTop: "12px" } },
        h("table", { class: "br-table" },
          h("thead", null, h("tr", null,
            h("th", null, "Source"),
            h("th", null, "Scope"),
            h("th", null, "Latest Data"),
            h("th", { class: "num" }, "Rows"),
            h("th", null, "Fetched"),
            h("th", null, "Status"),
          )),
          h("tbody", null,
            ...hubList.map((hb) => h("tr", null,
              h("td", null, hb.label, h("div", { class: "br-scope-note" }, `Hubverse · ${hb.pathogen}`)),
              h("td", null, hb.location_id),
              h("td", { class: "br-mono" }, hb.latest_obs_date || hb.latest_ref_date || "—"),
              h("td", { class: "num br-mono" }, "Hub"),
              h("td", { class: "br-mono" }, hb.latest_ref_date ? `Ref ${hb.latest_ref_date}` : "Local/Remote"),
              h("td", null, "Synced"),
            )),
            ...feedList.map((f) => h("tr", null,
              h("td", null,
                h("a", { href: f.source_url, target: "_blank", rel: "noopener noreferrer", class: "br-link-btn" }, f.label, " ↗"),
                h("div", { class: "br-scope-note" }, f.description),
              ),
              h("td", null, f.scope),
              h("td", { class: "br-mono" }, f.latest_week || "—"),
              h("td", { class: "num br-mono" }, f.cached ? String(f.rows ?? 0) : "0"),
              h("td", { class: "br-mono" }, f.fetched_at ? formatTimeAgo(f.fetched_at) : "not fetched"),
              h("td", { style: f.error ? { color: "var(--status-error)" } : null },
                f.error ? `Error: ${f.error}` : (f.cached ? (f.stale ? "Stale" : "Ready") : "Uncached"),
              ),
            )),
          ),
        ),
      ),
    );
    page.appendChild(auditSec);

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
      return fetchAndRender(currentPlace, { bust: true, preserveSignal: true });
    },
    destroy() {
      stopPoll();
      loadToken += 1;
      host.replaceChildren();
    },
  };
}
