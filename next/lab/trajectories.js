/* Tab 4: Sample Trajectories Explorer Prototype (Flu MetroCast 100-trajectory 28-32wk showcase).
 * Features:
 * - HiDPI Canvas 2D spaghetti trajectories + aligned Peak Timing/Size cloud strip
 * - End-to-end nearest-trajectory hover illumination + click-to-pin + solid .c-readout
 * - Interactive Exceedance Threshold Filter ("P(peak ≥ threshold)")
 * - Derived 50/80/95% Quantile Ribbon & Median overlays, Dual-model comparison
 * - Exact O(M log M) CRPS & Multivariate Energy Score readouts + Live API /api/next/trajectories bridge */
import { h, on, cssColor } from "../lib/dom.js";
import { pill } from "../ui/controls.js";
import { glass } from "../ui/glass.js";
import { fitCanvas, perFrame, resetColors } from "../sections/shared.js";
import { buildTrajectoriesFixture } from "./fixtures.js";
import { fetchLiveTrajectories, probeLiveBackend } from "./liveBridge.js";

function parseRgb(str) {
  const m = str.match(/[\d.]+/g);
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [131, 229, 188];
}

export function mount(root, ctx) {
  const showcaseData = buildTrajectoriesFixture();
  const offs = [];
  let dataset = showcaseData;
  let primaryModel = dataset.modelOrder[0];
  let showCompare = false;
  let showRibbon = true;
  let showMedian = true;
  let showPeakCloud = true;
  let filterOn = false;
  let thresholdVal = 75;
  let hoverSampleId = null;
  let pinnedSampleId = null;
  let pointerPos = null; // { x, y, weekIdx }
  let liveNote = null;
  let hitGeom = null; // saved mapping from last draw

  const paper = h("div", { class: "lab-paper" });
  const sec = h("section", { class: "v-section" });
  const line = h("div", { class: "v-line" });
  const head = h("header", { class: "v-head" },
    h("h2", { class: "v-title" }, "Sample Trajectories"),
    line,
  );
  const body = h("div", { class: "v-body" });
  sec.append(head, body);
  paper.append(sec);
  root.replaceChildren(paper);

  const metricsGrid = h("div", { class: "tr-top-metrics" });
  const controlsBar = h("div", { style: { display: "flex", alignItems: "center", gap: "var(--space-8)", flexWrap: "wrap", marginBottom: "var(--space-12)" } });
  const stage = h("div", { class: "tr-stage" });
  const canvas = h("canvas", { class: "tr-canvas", "aria-label": "Sample trajectories and peak distribution chart" });
  const readout = h("div", { class: "c-readout v-readout", role: "status", hidden: true });
  stage.append(canvas, readout);

  const filterBar = h("div", { class: "tr-filter-bar" });
  body.append(metricsGrid, controlsBar, stage, filterBar);

  function updateHeaderLine() {
    line.replaceChildren(...[
      h("span", { class: "v-frag is-set" }, dataset.locationName),
      h("span", { class: "v-sep" }, "·"),
      h("span", { class: "v-frag" }, `${dataset.target}`),
      h("span", { class: "v-sep" }, "·"),
      h("span", { class: "v-frag" }, `Round ${dataset.roundDate}`),
      liveNote ? h("span", { class: "lab-tag", style: { marginLeft: "auto" } }, liveNote) : null,
    ].filter(Boolean));
  }

  function renderControls() {
    const modelChips = dataset.modelOrder.map((id, i) =>
      h("button", {
        type: "button",
        class: ["c-chip", id === primaryModel && "on"],
        onclick: () => {
          primaryModel = id;
          pinnedSampleId = null;
          hoverSampleId = null;
          renderAll();
        },
      }, h("i", { class: "c-dot", style: { background: `var(--series-${(i % 8) + 1})` } }), id));

    const toggleChip = (label, active, fn) =>
      h("button", {
        type: "button",
        class: ["c-chip", active && "on"],
        "aria-pressed": String(active),
        onclick: fn,
      }, label);

    const hasSecond = dataset.modelOrder.length > 1;
    controlsBar.replaceChildren(...[
      ...modelChips,
      hasSecond ? toggleChip("Compare 2nd model", showCompare, () => { showCompare = !showCompare; renderAll(); }) : null,
      toggleChip("50 / 80 / 95% Ribbon", showRibbon, () => { showRibbon = !showRibbon; renderAll(); }),
      toggleChip("Median", showMedian, () => { showMedian = !showMedian; renderAll(); }),
      toggleChip("Peak Cloud", showPeakCloud, () => { showPeakCloud = !showPeakCloud; renderAll(); }),
      pinnedSampleId ? toggleChip(`Clear pin (${pinnedSampleId}) ×`, true, () => { pinnedSampleId = null; readout.hidden = true; renderAll(); }) : null,
    ].filter(Boolean));

    const m = dataset.models[primaryModel];
    const maxPeak = Math.max(20, ...m.samples.map((s) => s.peakValue));
    if (thresholdVal > maxPeak) thresholdVal = Math.round(maxPeak * 0.65);

    const slider = h("input", {
      type: "range",
      class: "tr-slider",
      min: "10",
      max: String(Math.ceil(maxPeak * 0.95)),
      step: "1",
      value: String(thresholdVal),
      "aria-label": "Peak threshold filter",
    });
    slider.addEventListener("input", () => {
      thresholdVal = Number(slider.value);
      if (!filterOn) filterOn = true;
      renderMetricsAndFilterLabel();
      scheduleDraw();
    });

    const filterBtn = pill({
      label: filterOn ? "Filter active" : "Exceedance gate",
      size: "sm",
      pressed: filterOn,
      onClick: () => {
        filterOn = !filterOn;
        renderAll();
      },
    });
    filterBar.replaceChildren(
      filterBtn,
      h("span", null, "Highlight paths peaking ≥ "),
      slider,
      h("strong", { class: "mono", id: "tr-thresh-readout" }, `${thresholdVal} ${dataset.unit}`),
      h("span", { id: "tr-thresh-pct", class: "lab-tag is-accent mono", style: { marginLeft: "auto" } }),
    );
    glass(filterBtn);
    renderMetricsAndFilterLabel();
  }

  function renderMetricsAndFilterLabel() {
    const m = dataset.models[primaryModel];
    if (!m) return;
    const peakWeeks = m.samples.map((s) => s.peakWeek).sort((a, b) => a - b);
    const peakVals = m.samples.map((s) => s.peakValue).sort((a, b) => a - b);
    const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))))];

    const medPeakW = q(peakWeeks, 0.5);
    const iqrLoW = q(peakWeeks, 0.25);
    const iqrHiW = q(peakWeeks, 0.75);
    const medPeakV = q(peakVals, 0.5);
    const p90PeakV = q(peakVals, 0.9);
    const passing = m.samples.filter((s) => s.peakValue >= thresholdVal).length;
    const passPct = Math.round((passing / m.samples.length) * 100);

    const thrOut = filterBar.querySelector("#tr-thresh-readout");
    if (thrOut) thrOut.textContent = `${thresholdVal} ${dataset.unit}`;
    const thrPct = filterBar.querySelector("#tr-thresh-pct");
    if (thrPct) thrPct.textContent = `${passing} / ${m.samples.length} paths (${passPct}%)`;

    metricsGrid.replaceChildren(
      h("div", { class: "tr-metric" },
        h("div", { class: "tr-metric-k" }, "CRPS / Energy Score"),
        h("div", { class: "tr-metric-v" }, Number.isFinite(m.scores.crps) ? `${m.scores.crps}` : "–", " ",
          h("span", { style: { fontSize: "var(--text-small)", color: "var(--ink-tertiary)", fontWeight: 400 } },
            Number.isFinite(m.scores.energyScore) ? `/ ${m.scores.energyScore}` : "")),
        h("div", { class: "tr-metric-s" }, m.scores.evaluatedWeeks ? `Exact O(M log M) over ${m.scores.evaluatedWeeks} realized wks` : "Pending truth realizations"),
      ),
      h("div", { class: "tr-metric" },
        h("div", { class: "tr-metric-k" }, "Peak Timing (Median / IQR)"),
        h("div", { class: "tr-metric-v" }, `+${medPeakW} wk`),
        h("div", { class: "tr-metric-s mono" }, `IQR +${iqrLoW} to +${iqrHiW} wks · ${m.samples[medPeakW]?.peakDate?.slice(5) || ""}`),
      ),
      h("div", { class: "tr-metric" },
        h("div", { class: "tr-metric-k" }, "Peak Intensity (Med / 90th)"),
        h("div", { class: "tr-metric-v" }, `${medPeakV}`),
        h("div", { class: "tr-metric-s mono" }, `90th percentile ${p90PeakV} ${dataset.unit}`),
      ),
      h("div", { class: "tr-metric" },
        h("div", { class: "tr-metric-k" }, `Exceedance P(Peak ≥ ${thresholdVal})`),
        h("div", { class: "tr-metric-v", style: { color: "var(--accent)" } }, `${passPct}%`),
        h("div", { class: "tr-metric-s mono" }, `${passing} of ${m.samples.length} ensemble paths`),
      ),
    );
  }

  function renderAll() {
    updateHeaderLine();
    renderControls();
    scheduleDraw();
  }

  // ---------------- Pointer Hit-Testing ----------------
  offs.push(on(canvas, "pointermove", (e) => {
    if (!hitGeom) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { xAt, yAt, histLen, futLen, padL, padR, W, plotTop, plotBot } = hitGeom;
    if (sx < padL || sx > W - padR || sy < plotTop - 60 || sy > plotBot + 20) {
      hoverSampleId = null;
      pointerPos = null;
      readout.hidden = true;
      scheduleDraw();
      return;
    }

    // Map sx to nearest integer future horizon week [0..futLen-1]
    let bestH = 0;
    let bestDx = Infinity;
    for (let h = 0; h < futLen; h++) {
      const dx = Math.abs(sx - xAt(histLen + h));
      if (dx < bestDx) { bestDx = dx; bestH = h; }
    }

    // Find closest trajectory of primaryModel near bestH
    const m = dataset.models[primaryModel];
    let bestSample = null;
    let bestDy = Infinity;
    for (const s of m.samples) {
      if (filterOn && s.peakValue < thresholdVal) continue;
      const py = yAt(s.values[bestH]);
      const dy = Math.abs(sy - py);
      if (dy < bestDy) { bestDy = dy; bestSample = s; }
    }
    hoverSampleId = bestDy < 42 && bestSample ? bestSample.id : null;
    pointerPos = { sx, sy, h: bestH };

    const activeSample = (pinnedSampleId && m.samples.find((s) => s.id === pinnedSampleId)) || (hoverSampleId && bestSample);
    if (activeSample) {
      const valAtH = activeSample.values[bestH];
      const obsVal = dataset.realizedFuture?.[bestH];
      readout.replaceChildren(
        h("div", { class: "c-readout-head" },
          h("span", { style: { fontWeight: "600", color: "var(--ink-primary)" } }, `Trajectory ${activeSample.id}`),
          h("span", { class: "quiet" }, `h = +${bestH} wk`),
        ),
        h("table", null,
          h("tbody", null,
            h("tr", null, h("td", { class: "c-readout-name" }, primaryModel), h("td", { class: "num" }, `${valAtH.toFixed(1)}`)),
            h("tr", null, h("td", { class: "c-readout-name" }, "Path peak"), h("td", { class: "num" }, `${activeSample.peakValue} @ +${activeSample.peakWeek}w`)),
            Number.isFinite(obsVal) ? h("tr", null, h("td", { class: "c-readout-name" }, "Realized"), h("td", { class: "num" }, `${obsVal}`)) : null,
          ),
        ),
        h("div", { class: "c-readout-foot" },
          h("span", null, pinnedSampleId ? "Pinned · click to unpin" : "Click to pin path"),
        ),
      );
      readout.hidden = false;
      readout.style.transform = `translate(${Math.min(Math.max(12, sx + 14), rect.width - 250)}px, ${Math.max(12, sy - 64)}px)`;
    } else {
      readout.hidden = true;
    }
    scheduleDraw();
  }));

  offs.push(on(canvas, "pointerleave", () => {
    hoverSampleId = null;
    pointerPos = null;
    if (!pinnedSampleId) readout.hidden = true;
    scheduleDraw();
  }));

  offs.push(on(canvas, "click", () => {
    if (hoverSampleId) {
      pinnedSampleId = pinnedSampleId === hoverSampleId ? null : hoverSampleId;
      renderControls();
      scheduleDraw();
    } else if (pinnedSampleId) {
      pinnedSampleId = null;
      readout.hidden = true;
      renderControls();
      scheduleDraw();
    }
  }));

  // ---------------- Canvas Renderer ----------------
  const scheduleDraw = perFrame(draw);
  function draw() {
    const W = stage.clientWidth;
    const H = 470;
    if (W < 60) return;
    const g = fitCanvas(canvas, W, H);

    const inkPrimary = cssColor("var(--ink-primary)");
    const inkSecondary = cssColor("var(--ink-secondary)");
    const inkTertiary = cssColor("var(--ink-tertiary)");
    const hairline = cssColor("var(--line-hairline)");
    const lineAxis = cssColor("var(--line-axis)");
    const shadeForecast = cssColor("var(--shade-forecast)");
    const accent = cssColor("var(--accent)");
    const fontMono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono");
    const fontSans = getComputedStyle(document.documentElement).getPropertyValue("--font-sans");

    const pIdx = dataset.modelOrder.indexOf(primaryModel);
    const rgb1 = parseRgb(cssColor(`var(--series-${(Math.max(0, pIdx) % 8) + 1})`));
    const otherModel = showCompare ? dataset.modelOrder.find((id) => id !== primaryModel) : null;
    const oIdx = otherModel ? dataset.modelOrder.indexOf(otherModel) : -1;
    const rgb2 = parseRgb(cssColor(`var(--series-${(Math.max(1, oIdx) % 8) + 1})`));

    const m = dataset.models[primaryModel];
    const m2 = otherModel ? dataset.models[otherModel] : null;
    if (!m) return;

    const histLen = dataset.observedHistory.length;
    const futLen = m.quantiles.length;
    const totalX = histLen + futLen;

    const padL = 52;
    const padR = 24;
    const cloudH = showPeakCloud ? 86 : 16;
    const plotTop = cloudH + 14;
    const plotBot = H - 34;

    let yMax = 20;
    for (const p of dataset.observedHistory) yMax = Math.max(yMax, p.value);
    for (const s of m.samples) for (const v of s.values) yMax = Math.max(yMax, v);
    if (m2) for (const s of m2.samples) for (const v of s.values) yMax = Math.max(yMax, v);
    yMax *= 1.08;

    const xAt = (idx) => padL + (idx / Math.max(1, totalX - 1)) * (W - padL - padR);
    const yAt = (val) => plotBot - (val / yMax) * (plotBot - plotTop);
    hitGeom = { xAt, yAt, histLen, futLen, padL, padR, W, plotTop, plotBot };

    // Shaded forecast half-plane (from anchor cutoff right)
    const xCutoff = xAt(Math.max(0, histLen - 0.5));
    g.fillStyle = shadeForecast;
    g.fillRect(xCutoff, showPeakCloud ? 16 : plotTop, W - padR - xCutoff, plotBot - (showPeakCloud ? 16 : plotTop));

    // Horizontal grid lines & Y axis labels
    g.font = `400 10.5px ${fontMono}`;
    g.textAlign = "right";
    g.textBaseline = "middle";
    const steps = 4;
    for (let k = 0; k <= steps; k++) {
      const val = (yMax * k) / steps;
      const y = yAt(val);
      g.beginPath();
      g.moveTo(padL, y);
      g.lineTo(W - padR, y);
      g.strokeStyle = k === 0 ? lineAxis : hairline;
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = inkTertiary;
      g.fillText(String(Math.round(val)), padL - 8, y);
    }

    // X axis labels & cutoff rule
    g.textAlign = "center";
    g.textBaseline = "top";
    for (let idx = 0; idx < totalX; idx += 4) {
      const x = xAt(idx);
      const label = idx < histLen ? `${idx - histLen}w` : `+${idx - histLen}w`;
      g.fillStyle = idx < histLen ? inkTertiary : inkSecondary;
      g.fillText(label, x, plotBot + 10);
    }
    g.beginPath();
    g.setLineDash([4, 4]);
    g.moveTo(xCutoff, 16);
    g.lineTo(xCutoff, plotBot);
    g.strokeStyle = lineAxis;
    g.stroke();
    g.setLineDash([]);

    // Aligned Peak Cloud Strip above chart
    if (showPeakCloud) {
      g.fillStyle = inkTertiary;
      g.font = `500 10.5px ${fontSans}`;
      g.textAlign = "left";
      g.textBaseline = "top";
      g.fillText("PEAK TIMING × PEAK SIZE CLOUD", padL, 10);
      g.beginPath();
      g.moveTo(padL, cloudH);
      g.lineTo(W - padR, cloudH);
      g.strokeStyle = hairline;
      g.stroke();

      const yPeak = (v) => cloudH - 6 - (v / yMax) * (cloudH - 30);
      if (m2) {
        g.fillStyle = `rgba(${rgb2.join(",")}, 0.42)`;
        for (const p of m2.peakCloud) {
          g.beginPath();
          g.arc(xAt(histLen + p.week), yPeak(p.value), 2.2, 0, Math.PI * 2);
          g.fill();
        }
      }
      for (const p of m.peakCloud) {
        const pass = !filterOn || p.value >= thresholdVal;
        const active = p.id === hoverSampleId || p.id === pinnedSampleId;
        g.beginPath();
        g.arc(xAt(histLen + p.week), yPeak(p.value), active ? 4.2 : 2.5, 0, Math.PI * 2);
        g.fillStyle = active ? accent : `rgba(${rgb1.join(",")}, ${pass ? 0.72 : 0.14})`;
        g.fill();
      }
    }

    const drawQuantileRibbon = (modelData, rgb) => {
      const qs = modelData.quantiles;
      if (!qs.length) return;
      for (const [loKey, hiKey, alpha] of [["q05", "q95", 0.08], ["q25", "q75", 0.14]]) {
        g.beginPath();
        qs.forEach((pt, i) => {
          const x = xAt(histLen + pt.h);
          const y = yAt(pt[hiKey]);
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        });
        for (let i = qs.length - 1; i >= 0; i--) {
          g.lineTo(xAt(histLen + qs[i].h), yAt(qs[i][loKey]));
        }
        g.closePath();
        g.fillStyle = `rgba(${rgb.join(",")}, ${alpha})`;
        g.fill();
      }
    };

    if (showRibbon) {
      if (m2) drawQuantileRibbon(m2, rgb2);
      drawQuantileRibbon(m, rgb1);
    }

    // Secondary comparison model trajectories (soft background)
    const anchorY = histLen ? yAt(dataset.observedHistory[histLen - 1].value) : null;
    const anchorX = histLen ? xAt(histLen - 1) : null;

    const strokePaths = (modelData, rgb, isPrimary) => {
      for (const s of modelData.samples) {
        const isFocus = isPrimary && (s.id === hoverSampleId || s.id === pinnedSampleId);
        if (isFocus) continue; // draw last on top!
        const pass = !isPrimary || !filterOn || s.peakValue >= thresholdVal;
        g.beginPath();
        if (anchorX != null) { g.moveTo(anchorX, anchorY); }
        s.values.forEach((v, i) => {
          const x = xAt(histLen + i);
          const y = yAt(v);
          if (anchorX == null && i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        });
        const alpha = !isPrimary ? 0.12 : filterOn ? (pass ? 0.42 : 0.055) : 0.24;
        g.strokeStyle = `rgba(${rgb.join(",")}, ${alpha})`;
        g.lineWidth = filterOn && pass && isPrimary ? 1.2 : 0.95;
        g.stroke();
      }
    };

    if (m2) strokePaths(m2, rgb2, false);
    strokePaths(m, rgb1, true);

    // Threshold line when gate active
    if (filterOn) {
      const yThr = yAt(thresholdVal);
      g.beginPath();
      g.setLineDash([5, 4]);
      g.moveTo(padL, yThr);
      g.lineTo(W - padR, yThr);
      g.strokeStyle = accent;
      g.lineWidth = 1.25;
      g.stroke();
      g.setLineDash([]);
    }

    // Derived Medians
    if (showMedian) {
      for (const [mod, rgb] of m2 ? [[m2, rgb2], [m, rgb1]] : [[m, rgb1]]) {
        g.beginPath();
        if (anchorX != null) g.moveTo(anchorX, anchorY);
        mod.quantiles.forEach((pt, i) => {
          const x = xAt(histLen + pt.h);
          const y = yAt(pt.q50);
          if (anchorX == null && i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        });
        g.strokeStyle = `rgb(${rgb.join(",")})`;
        g.lineWidth = 2.1;
        g.stroke();
      }
    }

    // Highlighted hovered / pinned single trajectory
    const focusId = pinnedSampleId || hoverSampleId;
    if (focusId) {
      const fs = m.samples.find((s) => s.id === focusId);
      if (fs) {
        g.beginPath();
        if (anchorX != null) g.moveTo(anchorX, anchorY);
        fs.values.forEach((v, i) => {
          const x = xAt(histLen + i);
          const y = yAt(v);
          if (anchorX == null && i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        });
        g.strokeStyle = inkPrimary;
        g.lineWidth = 2.4;
        g.stroke();

        // Peak marker dot
        g.beginPath();
        g.arc(xAt(histLen + fs.peakWeek), yAt(fs.peakValue), 4.5, 0, Math.PI * 2);
        g.fillStyle = accent;
        g.fill();
      }
    }

    // Observed history & realized truth markers
    if (histLen) {
      g.beginPath();
      dataset.observedHistory.forEach((p, i) => {
        const x = xAt(i);
        const y = yAt(p.value);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.strokeStyle = inkPrimary;
      g.lineWidth = 2;
      g.stroke();
      for (let i = 0; i < histLen; i++) {
        g.beginPath();
        g.arc(xAt(i), yAt(dataset.observedHistory[i].value), 2.5, 0, Math.PI * 2);
        g.fillStyle = inkPrimary;
        g.fill();
      }
    }

    if (dataset.realizedFuture?.length) {
      for (let h = 0; h < dataset.realizedFuture.length; h++) {
        const v = dataset.realizedFuture[h];
        if (!Number.isFinite(v)) continue;
        g.beginPath();
        g.arc(xAt(histLen + h), yAt(v), 3.3, 0, Math.PI * 2);
        g.fillStyle = cssColor("var(--surface-paper)");
        g.fill();
        g.strokeStyle = inkPrimary;
        g.lineWidth = 1.6;
        g.stroke();
      }
    }

    // Subtle hover vertical crosshair
    if (pointerPos) {
      const hx = xAt(histLen + pointerPos.h);
      g.beginPath();
      g.moveTo(hx, plotTop);
      g.lineTo(hx, plotBot);
      g.strokeStyle = hairline;
      g.lineWidth = 1;
      g.stroke();
    }
  }

  const ro = new ResizeObserver(() => scheduleDraw());
  ro.observe(stage);

  async function refreshMode() {
    dataset = showcaseData;
    liveNote = null;
    if (ctx.state.dataMode === "live") {
      const info = await probeLiveBackend();
      const res = await fetchLiveTrajectories(info, ctx.state.primaryLocation || "US");
      if (res.live) {
        dataset = res.dataset;
        liveNote = `Live VZT1: ${info.hubName}`;
      } else {
        liveNote = res.reason;
      }
    }
    primaryModel = dataset.modelOrder[0];
    pinnedSampleId = null;
    hoverSampleId = null;
    renderAll();
  }

  offs.push(ctx.onThemeChange(() => { resetColors(); scheduleDraw(); }));
  offs.push(ctx.onModeChange(refreshMode));
  refreshMode();

  return {
    resize: scheduleDraw,
    destroy() {
      ro.disconnect();
      offs.forEach((off) => off());
    },
  };
}
