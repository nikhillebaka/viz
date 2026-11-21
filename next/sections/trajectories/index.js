/* Live Sample Trajectories workbench: borderless HiDPI Canvas 2D fan with aligned Peak Cloud,
 * empirical CRPS & multivariate Energy Score KPIs, nearest-path hover/pin, and drag conditioning gate. */
import { onThemeChange, cssColor } from "../../lib/dom.js";
import { fmtDay, valueFormat } from "../../lib/format.js";
import { parseIso, linear, niceMax, ticks, DAY, WEEK } from "../../lib/scale.js";
import { loadFan } from "../../lib/api.js";
import { seriesColor } from "../../chart/layout.js";
import { slotOf } from "../../features/selection.js";
import { loadRoundTrajectories } from "../../features/chart/trajectories.js";
import {
  h, on, linkStyle, frame, fragment, action, setLine,
  fitCanvas, perFrame, pointerReadout, readoutContent, onScreen, onDprChange,
} from "../shared.js";
import {
  sampleModelsForTarget,
  pickDefaultSampleModel,
  summarizeTrajectories,
  passesGate,
  gateStats,
} from "./model.js";

const PLOT_HEIGHT = 440;
const MAX_HIST_WEEKS = 10;

function resolveModelColor(id, manifest, sel, fallbackSlot) {
  const slot = slotOf(sel, id);
  if (slot != null) return cssColor(seriesColor(slot));
  if (manifest && (id === manifest.baseline || sel?.baseline && manifest.baseline === id)) {
    return cssColor(seriesColor("baseline"));
  }
  return cssColor(seriesColor(fallbackSlot));
}

function nearestIdxByX(sx, times, xScale) {
  let best = 0;
  let bestDx = Infinity;
  for (let i = 0; i < times.length; i++) {
    const dx = Math.abs(sx - xScale(times[i]));
    if (dx < bestDx) { bestDx = dx; best = i; }
  }
  return best;
}

function drawBand(g, quantiles, xScale, yScale, color, loKey, hiKey, alpha) {
  if (quantiles.length < 2) return;
  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = color;
  g.beginPath();
  let started = false;
  for (let i = 0; i < quantiles.length; i++) {
    const q = quantiles[i];
    if (!Number.isFinite(q[hiKey])) continue;
    const px = xScale(q.t);
    const py = yScale(q[hiKey]);
    if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
  }
  for (let i = quantiles.length - 1; i >= 0; i--) {
    const q = quantiles[i];
    if (!Number.isFinite(q[loKey])) continue;
    g.lineTo(xScale(q.t), yScale(q[loKey]));
  }
  g.closePath();
  g.fill();
  g.restore();
}

function strokeTrajectoryList(g, sum, times, anchor, xScale, yScale, color, { isPrimary, gate, skipIds }) {
  for (const s of sum.samples) {
    if (isPrimary && skipIds.has(s.id)) continue;
    const pass = !isPrimary || passesGate(s, gate);
    g.save();
    g.globalAlpha = !isPrimary ? 0.14 : gate ? (pass ? 0.45 : 0.05) : 0.24;
    g.strokeStyle = color;
    g.lineWidth = gate && pass && isPrimary ? 1.2 : 0.95;
    g.beginPath();
    let started = false;
    if (anchor) {
      g.moveTo(xScale(anchor.t), yScale(anchor.v));
      started = true;
    }
    for (let k = 0; k < times.length; k++) {
      const v = s.values[k];
      if (!Number.isFinite(v)) continue;
      const px = xScale(times[k]);
      const py = yScale(v);
      if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
    }
    if (started) g.stroke();
    g.restore();
  }
}

/** @returns {{ resize(): void, destroy(): void }} */
export function mount(el, ctx) {
  linkStyle("trajectories");
  linkStyle("sheet");
  const { manifest, store } = ctx;
  const f = frame(el, "Trajectories");

  let primaryModel = null;
  let compareModel = null;
  let showRibbon = true;
  let showPeakCloud = false;
  let userToggledCloud = false;

  let curSum = null;
  let cmpSum = null;
  let histObs = [];
  let targetMeta = null;
  let vf = valueFormat(null);

  let hoverSampleId = null;
  let pinnedSampleId = null;
  let pointerPos = null;
  let gate = null;
  let dragBrush = null;
  let hitGeom = null;
  let reqSeq = 0;

  const modelList = () => sampleModelsForTarget(manifest, store.get().target);
  const modelLabel = (id) => manifest.label(id, modelList().map((m) => m.id));

  const F = {
    model: fragment({
      label: "Model",
      title: "Sample model",
      items: () => modelList().map((m) => ({ value: m.id, label: modelLabel(m.id) })),
      value: () => primaryModel,
      isDefault: () => primaryModel === pickDefaultSampleModel(modelList(), store.get().sel, manifest),
      onSelect: (v) => {
        if (v === primaryModel) return;
        primaryModel = v;
        if (compareModel === primaryModel) compareModel = null;
        gate = null; pinnedSampleId = null; hoverSampleId = null;
        load();
      },
    }),
    compare: fragment({
      label: "Compare",
      title: "Compare with 2nd sample model",
      items: () => [
        { value: null, label: "Single model", short: "Compare" },
        ...modelList()
          .filter((m) => m.id !== primaryModel)
          .map((m) => ({ value: m.id, label: modelLabel(m.id) })),
      ],
      value: () => compareModel,
      isDefault: () => !compareModel,
      onSelect: (v) => { compareModel = v; load(); },
    }),
    ribbon: fragment({
      label: "Band",
      title: "Derived quantile band",
      items: () => [{ value: true, label: "50/80/95% ribbon" }, { value: false, label: "Paths only" }],
      value: () => showRibbon,
      isDefault: () => showRibbon,
      onSelect: (v) => { showRibbon = v; syncLine(); scheduleDraw(); },
    }),
    cloud: fragment({
      label: "Cloud",
      title: "Peak cloud strip",
      items: () => [{ value: true, label: "Peak cloud on" }, { value: false, label: "Peak cloud off" }],
      value: () => showPeakCloud,
      isDefault: () => !userToggledCloud,
      onSelect: (v) => { userToggledCloud = true; showPeakCloud = v; syncLine(); scheduleDraw(); },
    }),
  };

  const clearGateBtn = action("Clear gate ×", "Clear conditioning gate", () => { gate = null; refreshView(); });
  const clearPinBtn = action("Unpin ×", "Unpin trajectory", () => {
    pinnedSampleId = null;
    readout.hide();
    refreshView();
  });

  function syncLine() {
    Object.values(F).forEach((b) => b.sync());
    const hasCompareOptions = modelList().length > 1;
    setLine(f.line, [
      F.model,
      hasCompareOptions && F.compare,
      F.ribbon,
      F.cloud,
      gate && clearGateBtn,
      pinnedSampleId && clearPinBtn,
    ]);
  }

  const nums = h("div", { class: "tr-nums" });
  const fig = h("div", { class: "tr-fig" });
  const canvas = h("canvas", { class: "tr-canvas", "aria-label": "Sample trajectories chart" });
  fig.append(canvas);
  const readout = pointerReadout(fig);
  const foot = h("p", { class: "tr-note" }, "Drag vertically over a future week to condition · Click a path to pin");
  f.body.append(nums, fig, foot);

  function renderNums() {
    if (!curSum) { nums.replaceChildren(); return; }
    const st = gateStats(curSum.samples, gate);
    const { crps, energyScore: es, evaluatedWeeks } = curSum.scores;
    const scoreStr = crps != null
      ? `${vf.value(crps)}${es != null ? ` · ${vf.value(es)}` : ""}`
      : "Pending";
    const peakWhen = Number.isFinite(st.medPeakH)
      ? `${st.medPeakH >= 0 ? "+" : ""}${Math.round(st.medPeakH)} wk`
      : "–";
    const peakIqr = Number.isFinite(st.iqrLoH)
      ? `${fmtDay(st.medPeakT)} · IQR +${Math.round(st.iqrLoH)}..+${Math.round(st.iqrHiH)}w`
      : `${curSum.samples.length} draws`;

    nums.replaceChildren(
      h("div", { class: "ms-num-row" },
        h("div", { class: "ms-num" },
          h("span", { class: "ms-num-k" }, "CRPS · Energy"),
          h("span", { class: "ms-num-v mono" }, scoreStr),
          h("span", { class: "ms-num-s" }, `${evaluatedWeeks} realized ${evaluatedWeeks === 1 ? "wk" : "wks"}`),
        ),
        h("div", { class: "ms-num" },
          h("span", { class: "ms-num-k" }, "Peak timing"),
          h("span", { class: "ms-num-v mono" }, peakWhen),
          h("span", { class: "ms-num-s mono" }, peakIqr),
        ),
        h("div", { class: "ms-num" },
          h("span", { class: "ms-num-k" }, "Peak height"),
          h("span", { class: "ms-num-v mono" }, vf.value(st.medPeakVal)),
          h("span", { class: "ms-num-s mono" }, Number.isFinite(st.p90PeakVal) ? `90th ${vf.value(st.p90PeakVal)}` : "–"),
        ),
        gate ? h("div", { class: "ms-num" },
          h("span", { class: "ms-num-k" }, `Gate at ${gate.h >= 0 ? "+" : ""}${gate.h} wk`),
          h("span", { class: "ms-num-v mono", style: { color: "var(--accent)" } }, `${st.pct}%`),
          h("span", { class: "ms-num-s mono" }, `${st.active} / ${st.total} in [${vf.compact(gate.lo)}, ${vf.compact(gate.hi)}]`),
        ) : null,
      ),
    );
  }

  function refreshView() {
    syncLine();
    renderNums();
    scheduleDraw();
  }

  function updateReadoutFor(sx, sy, bestIdx) {
    if (!curSum || !hitGeom) return;
    const focusId = hoverSampleId || pinnedSampleId;
    const samp = focusId && curSum.samples.find((s) => s.id === focusId);
    if (!samp) { readout.hide(); return; }
    const hVal = curSum.horizons[bestIdx];
    const tVal = curSum.times[bestIdx];
    const valAtH = samp.values[bestIdx];
    const obsVal = curSum.realized[bestIdx];
    const unitTag = targetMeta?.unit && targetMeta.scale !== "proportion" ? ` ${targetMeta.unit}` : "";
    const head = `Trajectory ${samp.id} · ${fmtDay(tVal)} (${hVal >= 0 ? "+" : ""}${hVal}w)`;
    const rows = [
      [modelLabel(primaryModel), `${vf.value(valAtH)}${unitTag}`],
      ["Peak", `${vf.value(samp.peakValue)} @ ${fmtDay(samp.peakT)}`],
      Number.isFinite(obsVal) ? ["Observed", vf.value(obsVal)] : null,
    ];
    readout.show(sx, sy, readoutContent(head, rows));
  }

  /* ---------------- Load live data ---------------- */
  async function load() {
    const seq = ++reqSeq;
    const s = store.get();
    targetMeta = manifest.targetById.get(s.target) || null;
    vf = valueFormat(targetMeta);

    const models = modelList();
    if (!models.length) {
      curSum = null; cmpSum = null; hitGeom = null;
      f.loading(false);
      f.empty("No models with sample trajectories for this target.");
      syncLine();
      return;
    }

    if (!primaryModel || !models.some((m) => m.id === primaryModel)) {
      primaryModel = pickDefaultSampleModel(models, s.sel, manifest);
    }
    if (compareModel && (!models.some((m) => m.id === compareModel) || compareModel === primaryModel)) {
      compareModel = null;
    }

    const season = manifest.seasonOf(s.date) ?? manifest.seasons.at(-1)?.id ?? null;
    if (!s.location || !s.target || !season || !s.date) {
      curSum = null; cmpSum = null; hitGeom = null;
      f.loading(false);
      f.empty("Pick a place and forecast round above to inspect sample trajectories.");
      syncLine();
      return;
    }

    syncLine();
    f.loading(true);
    f.empty(null);

    const reqModels = [primaryModel, compareModel].filter(Boolean);
    const [fan, traj] = await Promise.all([
      loadFan(s.target, season, s.location, { dims: s.dims }).catch(() => null),
      loadRoundTrajectories(s.target, season, s.location, s.date, { models: reqModels, dims: s.dims }).catch(() => null),
    ]);
    if (seq !== reqSeq) return;
    f.loading(false);

    const entry1 = traj?.modelTrajectories?.get(primaryModel);
    if (!entry1?.samples?.length || !entry1?.horizons?.length) {
      curSum = null; cmpSum = null; hitGeom = null;
      f.empty(`No sample trajectories for ${modelLabel(primaryModel)} on ${fmtDay(parseIso(s.date))}.`);
      renderNums();
      return;
    }

    const refT = parseIso(traj.reference_date || s.date);
    const offsetDays = Number(traj.horizon_offset_days ?? fan?.horizonOffsetDays ?? 0);
    const obsByTime = fan?.observed ? new Map(fan.observed.map((o) => [o.t, o.v])) : null;

    curSum = summarizeTrajectories(entry1, { refT, horizonOffsetDays: offsetDays, observedByTime: obsByTime });
    const entry2 = compareModel ? traj?.modelTrajectories?.get(compareModel) : null;
    cmpSum = entry2 ? summarizeTrajectories(entry2, { refT, horizonOffsetDays: offsetDays, observedByTime: obsByTime }) : null;

    const firstT = curSum?.times?.[0] ?? refT;
    const priorObs = (fan?.observed || []).filter((o) => o.t < firstT);
    histObs = priorObs.slice(-MAX_HIST_WEEKS);

    if (!userToggledCloud && curSum) showPeakCloud = curSum.horizons.length >= 6;
    if (gate && (!curSum || gate.hIdx >= curSum.horizons.length)) gate = null;
    hoverSampleId = null;
    if (pinnedSampleId && !curSum?.samples?.some((sp) => sp.id === pinnedSampleId)) pinnedSampleId = null;
    readout.hide();

    refreshView();
  }

  /* ---------------- Canvas drawing ---------------- */
  function draw() {
    if (!curSum) return;
    const W = fig.clientWidth;
    const H = PLOT_HEIGHT;
    if (W < 80) return;
    const g = fitCanvas(canvas, W, H);
    const s = store.get();

    const inkPrimary = cssColor("var(--ink-primary)");
    const inkSecondary = cssColor("var(--ink-secondary)");
    const inkTertiary = cssColor("var(--ink-tertiary)");
    const hairline = cssColor("var(--line-hairline)");
    const lineAxis = cssColor("var(--line-axis)");
    const shadeForecast = cssColor("var(--shade-forecast)");
    const paper = cssColor("var(--surface-paper)");
    const accent = cssColor("var(--accent)");
    const fontMono = cssColor("var(--font-mono)") || "ui-monospace, monospace";
    const fontSans = cssColor("var(--font-sans)") || "system-ui, sans-serif";

    const color1 = resolveModelColor(primaryModel, manifest, s.sel, 0);
    const color2 = compareModel ? resolveModelColor(compareModel, manifest, s.sel, 1) : null;

    const futTimes = curSum.times;
    const firstObs = histObs[0]?.t;
    const tMinRaw = Number.isFinite(firstObs) ? firstObs : futTimes[0];
    const tMaxRaw = futTimes.at(-1);
    const padDomain = tMaxRaw <= tMinRaw ? WEEK : 0;
    const padL = 52;
    const padR = 18;
    const cloudH = showPeakCloud ? 84 : 12;
    const plotTop = showPeakCloud ? cloudH + 18 : 16;
    const plotBot = H - 30;

    let rawMax = 0;
    for (const o of histObs) if (Number.isFinite(o.v)) rawMax = Math.max(rawMax, o.v);
    for (const sp of curSum.samples) for (const v of sp.values) if (Number.isFinite(v)) rawMax = Math.max(rawMax, v);
    if (cmpSum) for (const sp of cmpSum.samples) for (const v of sp.values) if (Number.isFinite(v)) rawMax = Math.max(rawMax, v);
    for (const rv of curSum.realized) if (Number.isFinite(rv)) rawMax = Math.max(rawMax, rv);
    const yTop = niceMax(rawMax > 0 ? rawMax * 1.06 : 1, 4);

    const x = linear([tMinRaw - padDomain, tMaxRaw + padDomain], [padL, W - padR]);
    const y = linear([0, yTop], [plotBot, plotTop]);
    hitGeom = { x, y, times: futTimes, padL, padR, W, plotTop, plotBot };

    const xCut = Math.max(padL, Math.min(W - padR, x(futTimes[0] - 3.5 * DAY)));
    const shadeTop = showPeakCloud ? 16 : plotTop;
    g.fillStyle = shadeForecast;
    g.fillRect(xCut, shadeTop, Math.max(0, W - padR - xCut), plotBot - shadeTop);

    // Horizontal grid & Y ticks
    const yTicks = ticks(0, yTop, 4);
    g.font = `400 10.5px ${fontMono}`;
    g.textAlign = "right";
    g.textBaseline = "middle";
    for (const tv of yTicks) {
      const py = y(tv);
      if (py < plotTop - 4 || py > plotBot + 2) continue;
      g.beginPath();
      g.moveTo(padL, py);
      g.lineTo(W - padR, py);
      g.strokeStyle = tv === 0 ? lineAxis : hairline;
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = inkTertiary;
      g.fillText(vf.axis(tv), padL - 8, py);
    }

    // X calendar ticks
    const tickTimes = [];
    const allTimes = [...histObs.map((o) => o.t), ...futTimes];
    if (allTimes.length) {
      const targetTicks = Math.max(3, Math.floor((W - padL - padR) / 86));
      const stride = Math.max(1, Math.ceil(allTimes.length / targetTicks));
      for (let i = 0; i < allTimes.length; i += stride) tickTimes.push(allTimes[i]);
      const lastT = allTimes.at(-1);
      if (lastT - tickTimes.at(-1) > WEEK && x(lastT) - x(tickTimes.at(-1)) > 58) tickTimes.push(lastT);
    }
    g.textAlign = "center";
    g.textBaseline = "top";
    for (const tVal of tickTimes) {
      const px = x(tVal);
      g.fillStyle = tVal < futTimes[0] ? inkTertiary : inkSecondary;
      g.fillText(fmtDay(tVal), px, plotBot + 10);
    }

    // Cutoff hairline
    g.save();
    g.beginPath();
    g.setLineDash([4, 4]);
    g.moveTo(xCut, shadeTop);
    g.lineTo(xCut, plotBot);
    g.strokeStyle = lineAxis;
    g.lineWidth = 1;
    g.stroke();
    g.restore();

    // Aligned Peak Cloud strip
    if (showPeakCloud) {
      g.fillStyle = inkTertiary;
      g.font = `500 10.5px ${fontSans}`;
      g.textAlign = "left";
      g.textBaseline = "top";
      g.fillText("PEAK CLOUD", padL, 4);
      g.beginPath();
      g.moveTo(padL, cloudH);
      g.lineTo(W - padR, cloudH);
      g.strokeStyle = hairline;
      g.lineWidth = 1;
      g.stroke();

      const yPeak = (v) => cloudH - 6 - (v / yTop) * (cloudH - 26);
      if (cmpSum && color2) {
        g.save();
        g.fillStyle = color2;
        g.globalAlpha = 0.35;
        for (const sp of cmpSum.samples) {
          if (!Number.isFinite(sp.peakValue)) continue;
          g.beginPath();
          g.arc(x(sp.peakT), yPeak(sp.peakValue), 2.1, 0, Math.PI * 2);
          g.fill();
        }
        g.restore();
      }
      for (const sp of curSum.samples) {
        if (!Number.isFinite(sp.peakValue)) continue;
        const pass = passesGate(sp, gate);
        const active = sp.id === hoverSampleId || sp.id === pinnedSampleId;
        g.save();
        g.globalAlpha = active ? 1 : pass ? 0.72 : 0.12;
        g.fillStyle = active ? accent : color1;
        g.beginPath();
        g.arc(x(sp.peakT), yPeak(sp.peakValue), active ? 4 : 2.3, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
    }

    // Derived quantile ribbons
    if (showRibbon) {
      if (cmpSum && color2) {
        drawBand(g, cmpSum.quantiles, x, y, color2, "q05", "q95", 0.06);
        drawBand(g, cmpSum.quantiles, x, y, color2, "q25", "q75", 0.11);
      }
      drawBand(g, curSum.quantiles, x, y, color1, "q05", "q95", 0.08);
      drawBand(g, curSum.quantiles, x, y, color1, "q25", "q75", 0.14);
    }

    // Anchor to most recent observation only when within 7 days (matches FanChart rule)
    const lastObs = histObs.at(-1);
    const anchor = lastObs && lastObs.t < futTimes[0] && (futTimes[0] - lastObs.t) <= 7 * DAY ? lastObs : null;

    const skipIds = new Set([hoverSampleId, pinnedSampleId].filter(Boolean));
    if (cmpSum && color2) {
      strokeTrajectoryList(g, cmpSum, cmpSum.times, anchor, x, y, color2, { isPrimary: false, gate: null, skipIds });
    }
    strokeTrajectoryList(g, curSum, futTimes, anchor, x, y, color1, { isPrimary: true, gate, skipIds });

    // Median lines
    for (const [sum, c, w] of cmpSum && color2 ? [[cmpSum, color2, 1.6], [curSum, color1, 2.0]] : [[curSum, color1, 2.0]]) {
      g.save();
      g.strokeStyle = c;
      g.lineWidth = w;
      g.beginPath();
      let started = false;
      if (anchor) { g.moveTo(x(anchor.t), y(anchor.v)); started = true; }
      for (const q of sum.quantiles) {
        if (!Number.isFinite(q.q50)) continue;
        const px = x(q.t), py = y(q.q50);
        if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
      }
      if (started) g.stroke();
      g.restore();
    }

    // Conditioning gate bracket
    if (gate && gate.hIdx < futTimes.length) {
      const gx = x(futTimes[gate.hIdx]);
      const yTopG = y(gate.hi);
      const yBotG = y(gate.lo);
      g.save();
      g.strokeStyle = accent;
      g.lineWidth = 2.2;
      g.beginPath();
      g.moveTo(gx - 5, yTopG); g.lineTo(gx + 5, yTopG);
      g.moveTo(gx, yTopG); g.lineTo(gx, yBotG);
      g.moveTo(gx - 5, yBotG); g.lineTo(gx + 5, yBotG);
      g.stroke();
      g.restore();
    }

    // Highlighted (pinned or hovered) primary sample trajectory
    const focusId = pinnedSampleId || hoverSampleId;
    if (focusId) {
      const fs = curSum.samples.find((sp) => sp.id === focusId);
      if (fs) {
        g.save();
        g.strokeStyle = inkPrimary;
        g.lineWidth = 2.25;
        g.beginPath();
        let started = false;
        if (anchor) { g.moveTo(x(anchor.t), y(anchor.v)); started = true; }
        for (let k = 0; k < futTimes.length; k++) {
          const v = fs.values[k];
          if (!Number.isFinite(v)) continue;
          const px = x(futTimes[k]), py = y(v);
          if (!started) { g.moveTo(px, py); started = true; } else g.lineTo(px, py);
        }
        if (started) g.stroke();
        if (Number.isFinite(fs.peakValue)) {
          g.beginPath();
          g.arc(x(fs.peakT), y(fs.peakValue), 4.2, 0, Math.PI * 2);
          g.fillStyle = accent;
          g.fill();
        }
        g.restore();
      }
    }

    // Historical observed line + dots
    if (histObs.length) {
      g.save();
      g.strokeStyle = inkPrimary;
      g.lineWidth = 2;
      g.beginPath();
      histObs.forEach((o, i) => {
        const px = x(o.t), py = y(o.v);
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      });
      g.stroke();
      g.fillStyle = inkPrimary;
      for (const o of histObs) {
        g.beginPath();
        g.arc(x(o.t), y(o.v), 2.4, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    }

    // Realized future circles
    for (let k = 0; k < futTimes.length; k++) {
      const v = curSum.realized[k];
      if (!Number.isFinite(v)) continue;
      g.save();
      g.beginPath();
      g.arc(x(futTimes[k]), y(v), 3.1, 0, Math.PI * 2);
      g.fillStyle = paper;
      g.fill();
      g.strokeStyle = inkPrimary;
      g.lineWidth = 1.6;
      g.stroke();
      g.restore();
    }

    // Hover horizon guide hairline
    if (pointerPos && !dragBrush) {
      const hx = x(futTimes[pointerPos.hIdx]);
      g.save();
      g.beginPath();
      g.moveTo(hx, plotTop);
      g.lineTo(hx, plotBot);
      g.strokeStyle = hairline;
      g.lineWidth = 1;
      g.stroke();
      g.restore();
    }
  }

  /* ---------------- Direct manipulation ---------------- */
  const scheduleDraw = perFrame(draw);
  const ro = new ResizeObserver(scheduleDraw);
  ro.observe(fig);
  const screen = onScreen(el);

  const offs = [
    () => ro.disconnect(),
    () => screen.off(),
    onDprChange(scheduleDraw),
    onThemeChange(() => { scheduleDraw(); }),
    on(canvas, "pointerdown", (e) => {
      if (!hitGeom || !curSum) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { x, times, padR, W, plotTop, plotBot } = hitGeom;
      if (sx < x(times[0]) - 12 || sx > W - padR || sy < plotTop || sy > plotBot) return;
      canvas.setPointerCapture?.(e.pointerId);
      const hIdx = nearestIdxByX(sx, times, x);
      dragBrush = { hIdx, y0: sy, y1: sy, moved: false };
    }),
    on(canvas, "pointermove", (e) => {
      if (!hitGeom || !curSum) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { x, y, times, padL, padR, W, plotTop, plotBot } = hitGeom;

      if (dragBrush) {
        dragBrush.y1 = Math.max(plotTop, Math.min(plotBot, sy));
        if (Math.abs(dragBrush.y1 - dragBrush.y0) > 8) dragBrush.moved = true;
        if (dragBrush.moved) {
          const va = Math.max(0, y.invert(dragBrush.y0));
          const vb = Math.max(0, y.invert(dragBrush.y1));
          gate = {
            hIdx: dragBrush.hIdx,
            h: curSum.horizons[dragBrush.hIdx],
            t: times[dragBrush.hIdx],
            lo: Math.min(va, vb),
            hi: Math.max(va, vb),
          };
          renderNums();
          scheduleDraw();
        }
        return;
      }

      if (sx < padL || sx > W - padR || sy < plotTop - 70 || sy > plotBot + 20) {
        hoverSampleId = null;
        pointerPos = null;
        if (!pinnedSampleId) readout.hide();
        scheduleDraw();
        return;
      }

      const bestIdx = nearestIdxByX(sx, times, x);
      let bestSample = null;
      let bestDy = Infinity;
      for (const sp of curSum.samples) {
        if (!passesGate(sp, gate)) continue;
        const v = sp.values[bestIdx];
        if (!Number.isFinite(v)) continue;
        const dy = Math.abs(sy - y(v));
        if (dy < bestDy) { bestDy = dy; bestSample = sp; }
      }
      hoverSampleId = bestDy < 42 && bestSample ? bestSample.id : null;
      pointerPos = { sx, sy, hIdx: bestIdx };
      if (hoverSampleId || pinnedSampleId) updateReadoutFor(sx, sy, bestIdx);
      else readout.hide();
      scheduleDraw();
    }),
    on(canvas, "pointerup", () => {
      if (dragBrush) {
        const wasMoved = dragBrush.moved;
        dragBrush = null;
        if (wasMoved) { refreshView(); return; }
      }
      if (hoverSampleId) {
        pinnedSampleId = pinnedSampleId === hoverSampleId ? null : hoverSampleId;
        refreshView();
      } else if (gate) {
        gate = null;
        refreshView();
      } else if (pinnedSampleId) {
        pinnedSampleId = null;
        readout.hide();
        refreshView();
      }
    }),
    on(canvas, "pointerleave", () => {
      hoverSampleId = null;
      pointerPos = null;
      if (!pinnedSampleId) readout.hide();
      scheduleDraw();
    }),
    on(document, "keydown", (e) => {
      if (e.key === "Escape" && (gate || pinnedSampleId)) {
        gate = null;
        pinnedSampleId = null;
        readout.hide();
        refreshView();
      }
    }),
    store.on((s, _prev, changed) => {
      if (["target", "location", "date", "dims"].some((k) => changed.has(k))) {
        if (changed.has("target")) {
          userToggledCloud = false;
          gate = null;
          pinnedSampleId = null;
          hoverSampleId = null;
        }
        screen.run(load);
      } else if (changed.has("sel")) {
        scheduleDraw();
      }
    }),
  ];

  load();
  return {
    resize: scheduleDraw,
    destroy() {
      reqSeq++;
      offs.forEach((off) => off());
    },
  };
}
