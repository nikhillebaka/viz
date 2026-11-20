/* Tab 4: Sample Trajectories (/next/ print-on-paper aesthetic + direct-manipulation conditioning gate).
 * Borderless HiDPI Canvas 2D fan on paper with aligned Peak Timing × Peak Size cloud,
 * nearest-trajectory hover illumination, click-to-pin, and drag-vertical canvas conditioning brush. */
import { h, on, cssColor } from "../lib/dom.js";
import { fragment, action, setLine, fitCanvas, perFrame, resetColors } from "../sections/shared.js";
import { buildTrajectoriesFixture } from "./fixtures.js";

function parseRgb(str) {
  const m = str.match(/[\d.]+/g);
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [131, 229, 188];
}

export function mount(root, ctx) {
  const dataset = buildTrajectoriesFixture();
  const offs = [];

  let primaryModel = dataset.modelOrder[0];
  let showCompare = false;
  let showRibbon = true;
  let showPeakCloud = true;
  let hoverSampleId = null;
  let pinnedSampleId = null;
  let pointerPos = null;
  let gate = null; // { h: number, lo: number, hi: number } | null
  let dragBrush = null; // { h: number, y0: number, y1: number, moved: boolean }
  let hitGeom = null;

  const paper = h("div", { class: "lab-paper" });
  const sec = h("section", { class: "v-section" });
  const line = h("div", { class: "v-line" });
  const head = h("header", { class: "v-head" }, h("h2", { class: "v-title" }, "Trajectories"), line);
  const progress = h("div", { class: "v-progress", "aria-hidden": "true" });
  const nums = h("div", { class: "tr-nums" });
  const fig = h("div", { class: "tr-fig" });
  const canvas = h("canvas", { class: "tr-canvas", "aria-label": "Sample trajectories chart" });
  const readout = h("div", { class: "c-readout v-readout", role: "status", hidden: true });
  const foot = h("p", { class: "v-note" }, "Drag vertically over a week to condition · Click a path to pin");

  fig.append(canvas, readout);
  sec.append(head, progress, nums, fig, foot);
  paper.append(sec);
  root.replaceChildren(paper);

  const F = {
    place: fragment({
      label: "Place", title: "Place",
      items: () => [{ value: dataset.locationId, label: dataset.locationName }],
      value: () => dataset.locationId, isDefault: () => true,
      onSelect: () => {},
    }),
    model: fragment({
      label: "Model", title: "Model",
      items: () => dataset.modelOrder.map((id) => ({ value: id, label: id })),
      value: () => primaryModel, isDefault: () => primaryModel === dataset.modelOrder[0],
      onSelect: (v) => { primaryModel = v; pinnedSampleId = null; hoverSampleId = null; renderAll(); },
    }),
    compare: fragment({
      label: "Compare", title: "Compare",
      items: () => [{ value: false, label: "Single model" }, { value: true, label: "Compare 2nd" }],
      value: () => showCompare, isDefault: () => !showCompare,
      onSelect: (v) => { showCompare = v; renderAll(); },
    }),
    ribbon: fragment({
      label: "Band", title: "Derived quantile band",
      items: () => [{ value: true, label: "50/80/95% ribbon" }, { value: false, label: "Paths only" }],
      value: () => showRibbon, isDefault: () => showRibbon,
      onSelect: (v) => { showRibbon = v; renderAll(); },
    }),
    cloud: fragment({
      label: "Cloud", title: "Peak cloud",
      items: () => [{ value: true, label: "Peak cloud on" }, { value: false, label: "Peak cloud off" }],
      value: () => showPeakCloud, isDefault: () => showPeakCloud,
      onSelect: (v) => { showPeakCloud = v; renderAll(); },
    }),
  };

  const clearGateBtn = action("Clear gate ×", "Clear conditioning gate", () => { gate = null; renderAll(); });
  const clearPinBtn = action("Unpin ×", "Unpin trajectory", () => { pinnedSampleId = null; readout.hidden = true; renderAll(); });

  function syncLine() {
    Object.values(F).forEach((b) => b.sync());
    setLine(line, [F.place, F.model, F.compare, F.ribbon, F.cloud, gate && clearGateBtn, pinnedSampleId && clearPinBtn]);
  }

  function passesGate(s) {
    if (!gate) return true;
    const v = s.values[gate.h];
    return v >= gate.lo && v <= gate.hi;
  }

  function renderNums() {
    const m = dataset.models[primaryModel];
    if (!m) return;
    const activeSamples = m.samples.filter(passesGate);
    const peakWeeks = activeSamples.map((s) => s.peakWeek).sort((a, b) => a - b);
    const peakVals = activeSamples.map((s) => s.peakValue).sort((a, b) => a - b);
    const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))))] : NaN);

    const medPeakW = q(peakWeeks, 0.5);
    const iqrLoW = q(peakWeeks, 0.25);
    const iqrHiW = q(peakWeeks, 0.75);
    const medPeakV = q(peakVals, 0.5);
    const p90PeakV = q(peakVals, 0.9);
    const condPct = Math.round((activeSamples.length / m.samples.length) * 100);

    nums.replaceChildren(
      h("div", { class: "ms-num-row" },
        h("div", { class: "ms-num" },
          h("span", { class: "ms-num-k" }, "CRPS · Energy"),
          h("span", { class: "ms-num-v mono" }, `${m.scores.crps} · ${m.scores.energyScore}`),
          h("span", { class: "ms-num-s" }, `${m.scores.evaluatedWeeks} realized wks`),
        ),
        h("div", { class: "ms-num" },
          h("span", { class: "ms-num-k" }, "Peak timing"),
          h("span", { class: "ms-num-v mono" }, Number.isFinite(medPeakW) ? `+${medPeakW} wk` : "–"),
          h("span", { class: "ms-num-s mono" }, Number.isFinite(iqrLoW) ? `IQR +${iqrLoW}..+${iqrHiW}w` : "0 paths"),
        ),
        h("div", { class: "ms-num" },
          h("span", { class: "ms-num-k" }, "Peak height"),
          h("span", { class: "ms-num-v mono" }, Number.isFinite(medPeakV) ? `${medPeakV}` : "–"),
          h("span", { class: "ms-num-s mono" }, Number.isFinite(p90PeakV) ? `90th ${p90PeakV} ${dataset.unit}` : "–"),
        ),
        gate ? h("div", { class: "ms-num" },
          h("span", { class: "ms-num-k" }, `Gate at +${gate.h} wk`),
          h("span", { class: "ms-num-v mono", style: { color: "var(--accent)" } }, `${condPct}%`),
          h("span", { class: "ms-num-s mono" }, `${activeSamples.length} / ${m.samples.length} in [${Math.round(gate.lo)}, ${Math.round(gate.hi)}]`),
        ) : null,
      ),
    );
  }

  function renderAll() {
    syncLine();
    renderNums();
    scheduleDraw();
  }

  /* ---------------- Pointer & Canvas Conditioning Gate ---------------- */
  function nearestFutureH(sx) {
    if (!hitGeom) return 0;
    const { xAt, histLen, futLen } = hitGeom;
    let bestH = 0, bestDx = Infinity;
    for (let h = 0; h < futLen; h++) {
      const dx = Math.abs(sx - xAt(histLen + h));
      if (dx < bestDx) { bestDx = dx; bestH = h; }
    }
    return bestH;
  }

  offs.push(on(canvas, "pointerdown", (e) => {
    if (!hitGeom) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { padL, padR, W, plotTop, plotBot, xAt, histLen } = hitGeom;
    if (sx < xAt(histLen) - 10 || sx > W - padR || sy < plotTop || sy > plotBot) return;
    canvas.setPointerCapture?.(e.pointerId);
    const hIdx = nearestFutureH(sx);
    dragBrush = { h: hIdx, y0: sy, y1: sy, moved: false };
    void padL;
  }));

  offs.push(on(canvas, "pointermove", (e) => {
    if (!hitGeom) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { xAt, yAt, vAt, histLen, futLen, padL, padR, W, plotTop, plotBot } = hitGeom;

    if (dragBrush) {
      dragBrush.y1 = Math.max(plotTop, Math.min(plotBot, sy));
      if (Math.abs(dragBrush.y1 - dragBrush.y0) > 8) dragBrush.moved = true;
      if (dragBrush.moved) {
        const va = vAt(dragBrush.y0);
        const vb = vAt(dragBrush.y1);
        gate = { h: dragBrush.h, lo: Math.min(va, vb), hi: Math.max(va, vb) };
        renderNums();
        scheduleDraw();
      }
      return;
    }

    if (sx < padL || sx > W - padR || sy < plotTop - 60 || sy > plotBot + 20) {
      hoverSampleId = null;
      pointerPos = null;
      if (!pinnedSampleId) readout.hidden = true;
      scheduleDraw();
      return;
    }

    let bestH = 0, bestDx = Infinity;
    for (let h = 0; h < futLen; h++) {
      const dx = Math.abs(sx - xAt(histLen + h));
      if (dx < bestDx) { bestDx = dx; bestH = h; }
    }

    const m = dataset.models[primaryModel];
    let bestSample = null, bestDy = Infinity;
    for (const s of m.samples) {
      if (!passesGate(s)) continue;
      const dy = Math.abs(sy - yAt(s.values[bestH]));
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
          h("span", { class: "quiet" }, `+${bestH} wk`),
        ),
        h("table", null,
          h("tbody", null,
            ...[
              h("tr", null, h("td", { class: "c-readout-name" }, primaryModel), h("td", { class: "num" }, `${valAtH.toFixed(1)}`)),
              h("tr", null, h("td", { class: "c-readout-name" }, "Peak"), h("td", { class: "num" }, `${activeSample.peakValue} @ +${activeSample.peakWeek}w`)),
              Number.isFinite(obsVal) ? h("tr", null, h("td", { class: "c-readout-name" }, "Realized"), h("td", { class: "num" }, `${obsVal}`)) : null,
            ].filter(Boolean),
          ),
        ),
      );
      readout.hidden = false;
      readout.style.transform = `translate(${Math.min(Math.max(10, sx + 14), rect.width - 230)}px, ${Math.max(12, sy - 58)}px)`;
    } else {
      readout.hidden = true;
    }
    scheduleDraw();
  }));

  offs.push(on(canvas, "pointerup", () => {
    if (dragBrush) {
      const wasMoved = dragBrush.moved;
      dragBrush = null;
      if (wasMoved) {
        renderAll();
        return;
      }
    }
    if (hoverSampleId) {
      pinnedSampleId = pinnedSampleId === hoverSampleId ? null : hoverSampleId;
      renderAll();
    } else if (gate) {
      gate = null;
      renderAll();
    } else if (pinnedSampleId) {
      pinnedSampleId = null;
      readout.hidden = true;
      renderAll();
    }
  }));

  offs.push(on(canvas, "pointerleave", () => {
    hoverSampleId = null;
    pointerPos = null;
    if (!pinnedSampleId) readout.hidden = true;
    scheduleDraw();
  }));

  offs.push(on(document, "keydown", (e) => {
    if (e.key === "Escape" && (gate || pinnedSampleId)) {
      gate = null;
      pinnedSampleId = null;
      readout.hidden = true;
      renderAll();
    }
  }));

  /* ---------------- Canvas 2D ---------------- */
  const scheduleDraw = perFrame(draw);
  function draw() {
    const W = fig.clientWidth;
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

    const rgb1 = parseRgb(cssColor(`var(--series-${dataset.modelOrder.indexOf(primaryModel) + 1})`));
    const otherModel = showCompare ? dataset.modelOrder.find((id) => id !== primaryModel) : null;
    const rgb2 = parseRgb(cssColor(`var(--series-${(otherModel ? dataset.modelOrder.indexOf(otherModel) : 1) + 1})`));

    const m = dataset.models[primaryModel];
    const m2 = otherModel ? dataset.models[otherModel] : null;
    if (!m) return;

    const histLen = dataset.observedHistory.length;
    const futLen = m.quantiles.length;
    const totalX = histLen + futLen;

    const padL = 46, padR = 16;
    const cloudH = showPeakCloud ? 82 : 12;
    const plotTop = cloudH + 16;
    const plotBot = H - 30;

    let yMax = 20;
    for (const p of dataset.observedHistory) yMax = Math.max(yMax, p.value);
    for (const s of m.samples) for (const v of s.values) yMax = Math.max(yMax, v);
    if (m2) for (const s of m2.samples) for (const v of s.values) yMax = Math.max(yMax, v);
    yMax *= 1.08;

    const xAt = (idx) => padL + (idx / Math.max(1, totalX - 1)) * (W - padL - padR);
    const yAt = (val) => plotBot - (val / yMax) * (plotBot - plotTop);
    const vAt = (sy) => Math.max(0, ((plotBot - sy) / (plotBot - plotTop)) * yMax);
    hitGeom = { xAt, yAt, vAt, histLen, futLen, padL, padR, W, plotTop, plotBot };

    const xCutoff = xAt(Math.max(0, histLen - 0.5));
    g.fillStyle = shadeForecast;
    g.fillRect(xCutoff, showPeakCloud ? 16 : plotTop, W - padR - xCutoff, plotBot - (showPeakCloud ? 16 : plotTop));

    g.font = `400 10.5px ${fontMono}`;
    g.textAlign = "right";
    g.textBaseline = "middle";
    for (let k = 0; k <= 4; k++) {
      const val = (yMax * k) / 4;
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

    g.textAlign = "center";
    g.textBaseline = "top";
    for (let idx = 0; idx < totalX; idx += 4) {
      const label = idx < histLen ? `${idx - histLen}w` : `+${idx - histLen}w`;
      g.fillStyle = idx < histLen ? inkTertiary : inkSecondary;
      g.fillText(label, xAt(idx), plotBot + 10);
    }

    g.beginPath();
    g.setLineDash([4, 4]);
    g.moveTo(xCutoff, 16);
    g.lineTo(xCutoff, plotBot);
    g.strokeStyle = lineAxis;
    g.stroke();
    g.setLineDash([]);

    if (showPeakCloud) {
      g.fillStyle = inkTertiary;
      g.font = `500 10.5px ${fontSans}`;
      g.textAlign = "left";
      g.textBaseline = "top";
      g.fillText("PEAK CLOUD", padL, 8);
      g.beginPath();
      g.moveTo(padL, cloudH);
      g.lineTo(W - padR, cloudH);
      g.strokeStyle = hairline;
      g.stroke();

      const yPeak = (v) => cloudH - 6 - (v / yMax) * (cloudH - 28);
      if (m2) {
        g.fillStyle = `rgba(${rgb2.join(",")}, 0.35)`;
        for (const p of m2.peakCloud) {
          g.beginPath();
          g.arc(xAt(histLen + p.week), yPeak(p.value), 2.1, 0, Math.PI * 2);
          g.fill();
        }
      }
      for (const s of m.samples) {
        const pass = passesGate(s);
        const active = s.id === hoverSampleId || s.id === pinnedSampleId;
        g.beginPath();
        g.arc(xAt(histLen + s.peakWeek), yPeak(s.peakValue), active ? 4 : 2.3, 0, Math.PI * 2);
        g.fillStyle = active ? accent : `rgba(${rgb1.join(",")}, ${pass ? 0.72 : 0.12})`;
        g.fill();
      }
    }

    const drawRibbon = (modelData, rgb) => {
      const qs = modelData.quantiles;
      for (const [loKey, hiKey, alpha] of [["q05", "q95", 0.08], ["q25", "q75", 0.14]]) {
        g.beginPath();
        qs.forEach((pt, i) => {
          const x = xAt(histLen + pt.h), y = yAt(pt[hiKey]);
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        });
        for (let i = qs.length - 1; i >= 0; i--) g.lineTo(xAt(histLen + qs[i].h), yAt(qs[i][loKey]));
        g.closePath();
        g.fillStyle = `rgba(${rgb.join(",")}, ${alpha})`;
        g.fill();
      }
    };

    if (showRibbon) {
      if (m2) drawRibbon(m2, rgb2);
      drawRibbon(m, rgb1);
    }

    const anchorX = histLen ? xAt(histLen - 1) : null;
    const anchorY = histLen ? yAt(dataset.observedHistory[histLen - 1].value) : null;

    const strokePaths = (modelData, rgb, isPrimary) => {
      for (const s of modelData.samples) {
        if (isPrimary && (s.id === hoverSampleId || s.id === pinnedSampleId)) continue;
        const pass = !isPrimary || passesGate(s);
        g.beginPath();
        if (anchorX != null) g.moveTo(anchorX, anchorY);
        s.values.forEach((v, i) => {
          const x = xAt(histLen + i), y = yAt(v);
          if (anchorX == null && i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        });
        const alpha = !isPrimary ? 0.12 : gate ? (pass ? 0.44 : 0.05) : 0.24;
        g.strokeStyle = `rgba(${rgb.join(",")}, ${alpha})`;
        g.lineWidth = gate && pass && isPrimary ? 1.2 : 0.95;
        g.stroke();
      }
    };

    if (m2) strokePaths(m2, rgb2, false);
    strokePaths(m, rgb1, true);

    // Median line
    for (const [mod, rgb] of m2 ? [[m2, rgb2], [m, rgb1]] : [[m, rgb1]]) {
      g.beginPath();
      if (anchorX != null) g.moveTo(anchorX, anchorY);
      mod.quantiles.forEach((pt, i) => {
        const x = xAt(histLen + pt.h), y = yAt(pt.q50);
        if (anchorX == null && i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.strokeStyle = `rgb(${rgb.join(",")})`;
      g.lineWidth = 2.0;
      g.stroke();
    }

    // Conditioning gate bracket rendered crisply on the week column
    if (gate) {
      const gx = xAt(histLen + gate.h);
      const yTop = yAt(gate.hi);
      const yBot = yAt(gate.lo);
      g.save();
      g.strokeStyle = accent;
      g.lineWidth = 2.2;
      g.beginPath();
      g.moveTo(gx - 5, yTop);
      g.lineTo(gx + 5, yTop);
      g.moveTo(gx, yTop);
      g.lineTo(gx, yBot);
      g.moveTo(gx - 5, yBot);
      g.lineTo(gx + 5, yBot);
      g.stroke();
      g.restore();
    }

    const focusId = pinnedSampleId || hoverSampleId;
    if (focusId) {
      const fs = m.samples.find((s) => s.id === focusId);
      if (fs) {
        g.beginPath();
        if (anchorX != null) g.moveTo(anchorX, anchorY);
        fs.values.forEach((v, i) => {
          const x = xAt(histLen + i), y = yAt(v);
          if (anchorX == null && i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        });
        g.strokeStyle = inkPrimary;
        g.lineWidth = 2.25;
        g.stroke();

        g.beginPath();
        g.arc(xAt(histLen + fs.peakWeek), yAt(fs.peakValue), 4.2, 0, Math.PI * 2);
        g.fillStyle = accent;
        g.fill();
      }
    }

    if (histLen) {
      g.beginPath();
      dataset.observedHistory.forEach((p, i) => {
        const x = xAt(i), y = yAt(p.value);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.strokeStyle = inkPrimary;
      g.lineWidth = 2;
      g.stroke();
      for (const p of dataset.observedHistory) {
        g.beginPath();
        g.arc(xAt(dataset.observedHistory.indexOf(p)), yAt(p.value), 2.4, 0, Math.PI * 2);
        g.fillStyle = inkPrimary;
        g.fill();
      }
    }

    if (dataset.realizedFuture?.length) {
      for (let h = 0; h < dataset.realizedFuture.length; h++) {
        const v = dataset.realizedFuture[h];
        if (!Number.isFinite(v)) continue;
        g.beginPath();
        g.arc(xAt(histLen + h), yAt(v), 3.1, 0, Math.PI * 2);
        g.fillStyle = cssColor("var(--surface-paper)");
        g.fill();
        g.strokeStyle = inkPrimary;
        g.lineWidth = 1.6;
        g.stroke();
      }
    }

    if (pointerPos && !dragBrush) {
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
  ro.observe(fig);
  offs.push(ctx.onThemeChange(() => { resetColors(); renderAll(); }));

  renderAll();

  return {
    resize: scheduleDraw,
    destroy() {
      ro.disconnect();
      offs.forEach((off) => off());
    },
  };
}
