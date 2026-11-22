/* Live Sample Trajectories workbench: borderless HiDPI Canvas 2D fan with aligned Peak Cloud,
 * empirical CRPS & multivariate Energy Score KPIs, nearest-path hover/pin, and drag conditioning gate. */
import { onThemeChange, cssColor } from "../../lib/dom.js";
import { fmtDay, valueFormat } from "../../lib/format.js";
import { parseIso, linear, niceMax, ticks, DAY, WEEK } from "../../lib/scale.js";
import { loadFan, loadSampleScores } from "../../lib/api.js";
import { seriesColor } from "../../chart/layout.js";
import { slotOf } from "../../features/selection.js";
import { seasonWeek1 } from "../../features/chart/layers.js";
import { loadRoundTrajectories } from "../../features/chart/trajectories.js";
import { activeLayer } from "../../ui/floating.js";
import {
  h, on, linkStyle, frame, fragment, action, setLine, getJson, query,
  fitCanvas, perFrame, pointerReadout, readoutContent, onScreen, onDprChange,
} from "../shared.js";
import {
  sampleScoresQuery,
  sampleModelsForTarget,
  pickDefaultSampleModel,
  summarizeTrajectories,
  passesGate,
  gateStats,
} from "./model.js";

const PLOT_HEIGHT = 440;
const MAX_HIST_WEEKS = 10;
const MIN_PAN_SPAN = 4 * WEEK;

function resolveModelColor(id, manifest, sel, fallbackSlot, target, season) {
  const slot = slotOf(sel, id);
  if (slot != null) return cssColor(seriesColor(slot));
  const base = manifest?.baselineFor?.(target, season) ?? manifest?.baseline;
  if (id && base && id === base) {
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
  const f = frame(el, "Trajectories", "trajectories");

  let primaryModel = null;
  let compareModel = null;
  let userSeason = null;     // null -> follow active chart season
  let userRound = null;      // null -> follow chart date (same season) or latest model round
  let spanMode = "forecast"; // "forecast" | "season"
  let showPastSeasons = false;
  let showRibbon = true;
  let showPeakCloud = false;
  let userToggledCloud = false;
  let scoreScope = "current"; // "current" | "all"
  let boardData = null;
  let boardLoading = false;
  let boardErr = false;
  let boardReqSeq = 0;
  let boardKey = "";
  let boardAbortCtl = null;

  let curSum = null;
  let cmpSum = null;
  let histObs = [];
  let allFanObs = [];
  let fanWindow = null;
  let fanRounds = [];
  let pastLines = [];
  let activeRound = null;
  let viewDomain = null;     // null | [t0, t1] panned/zoomed viewport
  let targetMeta = null;
  let vf = valueFormat(null);

  let hoverSampleId = null;
  let pinnedSampleId = null;
  let pointerPos = null;
  let gate = null;
  let dragBrush = null;
  let hitGeom = null;
  let reqSeq = 0;

  const chartSeason = () => {
    const s = store.get();
    return manifest.seasonOf(s.date) ?? manifest.seasons.at(-1)?.id ?? "";
  };
  const effSeason = () => userSeason || chartSeason();
  const seasonLabel = (id) => manifest.seasonById?.get(id)?.label || id;
  const availableSeasons = () => [...(manifest.seasons || [])].slice().reverse();
  const modelList = () => sampleModelsForTarget(manifest, store.get().target, effSeason());
  const modelLabel = (id) => manifest.label(id, modelList().map((m) => m.id));
  const roundOptions = () => {
    const sId = effSeason();
    const mInfo = manifest.modelById.get(primaryModel);
    const mDates = mInfo?.dates?.length ? new Set(mInfo.dates) : null;
    const base = fanRounds.length ? fanRounds : (manifest.datesOf?.(sId) || []);
    const filtered = mDates ? base.filter((d) => mDates.has(d)) : base;
    return filtered.length ? filtered : base;
  };

  const F = {
    model: fragment({
      label: "Model",
      title: "Sample model",
      items: () => modelList().map((m) => ({ value: m.id, label: modelLabel(m.id) })),
      value: () => primaryModel,
      isDefault: () => primaryModel === pickDefaultSampleModel(modelList(), store.get().sel, manifest, store.get().target),
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
    season: fragment({
      label: "Season",
      title: "Season",
      items: () => availableSeasons().map((se) => ({ value: se.id, label: se.label || se.id })),
      value: () => effSeason(),
      isDefault: () => effSeason() === chartSeason(),
      onSelect: (v) => {
        const cs = chartSeason();
        userSeason = v === cs ? null : v;
        userRound = null;
        viewDomain = null;
        gate = null; pinnedSampleId = null; hoverSampleId = null;
        load();
        loadLeaderboard(true);
      },
    }),
    round: fragment({
      label: "Round",
      title: "Forecast round",
      items: () => roundOptions().slice().reverse().map((d) => ({ value: d, label: fmtDay(parseIso(d)) })),
      value: () => activeRound || store.get().date,
      isDefault: () => effSeason() === chartSeason() && !userRound,
      onSelect: (v) => {
        userRound = (effSeason() === chartSeason() && v === store.get().date) ? null : v;
        viewDomain = null;
        gate = null; pinnedSampleId = null; hoverSampleId = null;
        load();
      },
    }),
    span: fragment({
      label: "Span",
      title: "Time span",
      items: () => [
        { value: "forecast", label: "Forecast", short: "Forecast" },
        { value: "season", label: "Full season", short: "Full season" },
      ],
      value: () => spanMode,
      isDefault: () => spanMode === "forecast",
      onSelect: (v) => { spanMode = v; viewDomain = null; refreshView(); },
    }),
    past: fragment({
      label: "Past seasons",
      title: "Past seasons overlay",
      items: () => [
        { value: false, label: "Past seasons off", short: "Past off" },
        { value: true, label: "Past seasons on", short: "Past on" },
      ],
      value: () => showPastSeasons,
      isDefault: () => !showPastSeasons,
      onSelect: (v) => { showPastSeasons = v; if (v && !pastLines.length) load(); else refreshView(); },
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

  const resetPanBtn = action("Reset pan ×", "Reset horizontal pan and zoom", () => { viewDomain = null; refreshView(); });
  const clearGateBtn = action("Clear gate ×", "Clear conditioning gate", () => { gate = null; refreshView(); });
  const clearPinBtn = action("Unpin ×", "Unpin trajectory", () => {
    pinnedSampleId = null;
    readout.hide();
    refreshView();
    renderLeaderboard();
  });

  function syncLine() {
    Object.values(F).forEach((b) => b.sync());
    const hasCompareOptions = modelList().length > 1;
    const hasSeasons = availableSeasons().length > 1;
    const hasRounds = roundOptions().length > 1;
    setLine(f.line, [
      F.model,
      hasCompareOptions && F.compare,
      hasSeasons && F.season,
      hasRounds && F.round,
      F.span,
      hasSeasons && F.past,
      F.ribbon,
      F.cloud,
      viewDomain && resetPanBtn,
      gate && clearGateBtn,
      pinnedSampleId && clearPinBtn,
    ]);
  }

  const nums = h("div", { class: "tr-nums" });
  const fig = h("div", { class: "tr-fig" });
  const canvas = h("canvas", { class: "tr-canvas", "aria-label": "Sample trajectories chart" });
  fig.append(canvas);
  const readout = pointerReadout(fig);
  const foot = h("p", { class: "v-note" }, "Drag vertically over a future week to condition · Swipe or drag horizontally to pan · Pinch to zoom · Click a path to pin");
  const boardWrap = h("div", { class: "tr-board-wrap" });
  f.body.append(nums, fig, foot, boardWrap);

  const boardScopeFrag = fragment({
    label: "Scope",
    title: "Skill over",
    items: () => {
      const s = store.get();
      const locName = manifest.locationById.get(s.location)?.name || s.location || "This place";
      return [
        { value: "current", label: locName },
        { value: "all", label: `All places · ${seasonLabel(effSeason())}` },
      ];
    },
    value: () => scoreScope,
    isDefault: () => scoreScope === "current",
    onSelect: (v) => { if (v !== scoreScope) { scoreScope = v; loadLeaderboard(true); } },
  });
  const boardLine = h("div", { class: "v-line" });
  const boardHead = h("div", { class: "v-subhead" }, h("h3", { class: "v-subtitle" }, "Season skill"), boardLine);

  function renderLeaderboard() {
    const s = store.get();
    const models = modelList();
    if (!models.length || !s.target || !s.location) {
      boardWrap.replaceChildren();
      return;
    }
    const season = effSeason();
    boardScopeFrag.sync();
    setLine(boardLine, [boardScopeFrag]);

    const allIds = (boardData?.rankings || []).map((r) => r.model_id);
    const lbl = (id) => (allIds.length ? manifest.label(id, allIds) : modelLabel(id));

    if (boardLoading) {
      boardWrap.replaceChildren(boardHead, h("p", { class: "v-note" }, "Scoring sample trajectories across season rounds…"));
      return;
    }
    if (boardErr) {
      boardWrap.replaceChildren(boardHead, h("p", { class: "v-note" }, "Sample scores unavailable for this scope."));
      return;
    }
    const rows = (boardData?.rankings || []).filter((r) => r.has_data_in_scope && r.count > 0);
    if (!rows.length) {
      boardWrap.replaceChildren(boardHead, h("p", { class: "v-note" }, `No realized sample forecasts in ${seasonLabel(season)} for this scope.`));
      return;
    }
    const baseId = boardData?.baseline_model || manifest.baselineFor?.(s.target, season) || null;
    const priColor = resolveModelColor(primaryModel, manifest, s.sel, 0, s.target, season);
    const cmpColor = compareModel ? resolveModelColor(compareModel, manifest, s.sel, 1, s.target, season) : null;

    boardWrap.replaceChildren(
      boardHead,
      h("div", { class: "tr-table-scroll" },
        h("table", { class: "v-table" },
          h("thead", null,
            h("tr", null,
              h("th", null, "Rank"),
              h("th", null, "Model"),
              h("th", { class: "num" }, "Rel. CRPS"),
              h("th", { class: "num" }, "CRPS"),
              h("th", { class: "num" }, "Energy"),
              h("th", { class: "num" }, "N"),
            )),
          h("tbody", null,
            ...rows.map((r, idx) => {
              const isPri = r.model_id === primaryModel;
              const isCmp = r.model_id === compareModel;
              const dotColor = isPri ? priColor : (isCmp ? cmpColor : null);
              return h("tr", {
                "data-model": r.model_id,
                class: isPri ? "is-primary" : (isCmp ? "is-cmp" : null),
                onclick: (e) => {
                  if (e.shiftKey && r.model_id !== primaryModel) {
                    compareModel = isCmp ? null : r.model_id;
                    load();
                    renderLeaderboard();
                    return;
                  }
                  if (r.model_id === primaryModel) return;
                  primaryModel = r.model_id;
                  if (compareModel === primaryModel) compareModel = null;
                  gate = null; pinnedSampleId = null; hoverSampleId = null;
                  load();
                  renderLeaderboard();
                },
              },
              h("td", { class: "mono" }, String(idx + 1)),
              h("td", null,
                h("span", {
                  class: "v-name",
                  "data-model-sheet": r.model_id,
                  title: `${lbl(r.model_id)} · details`,
                  style: dotColor ? { "--c": dotColor } : null,
                }, h("i"), lbl(r.model_id))),
              h("td", { class: "num mono" }, r.model_id === baseId ? "1.00" : (typeof r.relative_crps === "number" ? r.relative_crps.toFixed(2) : "–")),
              h("td", { class: "num mono" }, typeof r.crps === "number" ? vf.value(r.crps) : "–"),
              h("td", { class: "num mono" }, typeof r.energy_score === "number" ? vf.value(r.energy_score) : "–"),
              h("td", { class: "num mono" }, String(r.count ?? 0)),
              );
            }),
          ),
        ),
      ),
      h("p", { class: "v-note" }, "Click a row to plot · Shift-click to compare · Click model name for details"),
    );
  }

  function loadLeaderboard(force = false) {
    const s = store.get();
    const models = modelList();
    const season = effSeason();
    if (!models.length || !s.target || !s.location || !season) {
      boardKey = "";
      boardData = null;
      renderLeaderboard();
      return;
    }
    const queryStr = sampleScoresQuery({ target: s.target, season, location: s.location, scopePlace: scoreScope, dims: s.dims });
    const nextKey = `${manifest.hub_id || ""}|${queryStr}`;
    if (!force && nextKey === boardKey && boardData) {
      renderLeaderboard();
      return;
    }
    boardKey = nextKey;
    boardAbortCtl?.abort();
    boardAbortCtl = new AbortController();
    const seq = ++boardReqSeq;
    boardLoading = true;
    boardErr = false;
    renderLeaderboard();
    loadSampleScores(queryStr, { signal: boardAbortCtl.signal })
      .then((res) => {
        if (seq !== boardReqSeq) return;
        boardLoading = false;
        boardErr = false;
        boardData = res;
        renderLeaderboard();
      })
      .catch((err) => {
        if (err?.name === "AbortError" || seq !== boardReqSeq) return;
        boardLoading = false;
        boardErr = true;
        renderLeaderboard();
      });
  }

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

    const season = effSeason();
    const models = modelList();
    if (!models.length) {
      curSum = null; cmpSum = null; hitGeom = null; allFanObs = []; fanWindow = null; fanRounds = []; pastLines = [];
      f.loading(false);
      f.empty("No models with sample trajectories for this target.");
      syncLine();
      return;
    }

    if (!primaryModel || !models.some((m) => m.id === primaryModel)) {
      primaryModel = pickDefaultSampleModel(models, s.sel, manifest, s.target);
    }
    if (compareModel && (!models.some((m) => m.id === compareModel) || compareModel === primaryModel)) {
      compareModel = null;
    }

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

    const fan = await loadFan(s.target, season, s.location, { dims: s.dims }).catch(() => null);
    if (seq !== reqSeq) return;

    fanRounds = fan?.rounds || [];
    fanWindow = fan?.window || null;
    allFanObs = fan?.observed || [];

    const validRounds = roundOptions();
    let useRound = s.date;
    if (season !== chartSeason() || userRound) {
      if (userRound && validRounds.includes(userRound)) useRound = userRound;
      else useRound = validRounds.at(-1) || s.date;
    } else if (validRounds.length && !validRounds.includes(useRound)) {
      useRound = validRounds.at(-1);
    }
    activeRound = useRound;

    const reqModels = [primaryModel, compareModel].filter(Boolean);
    const otherSeasons = availableSeasons().filter((x) => x.id !== season).slice(0, 4).map((x) => x.id);
    const [traj, curvesRes] = await Promise.all([
      loadRoundTrajectories(s.target, season, s.location, useRound, { models: reqModels, dims: s.dims }).catch(() => null),
      showPastSeasons && otherSeasons.length
        ? getJson(`/api/season-curves?${query({ target: s.target, location: s.location, seasons: otherSeasons.join(",") })}`).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (seq !== reqSeq) return;
    f.loading(false);

    if (showPastSeasons && curvesRes?.curves) {
      const y = Number(String(season).slice(0, 4));
      const w1 = Number.isFinite(y) ? seasonWeek1(y) : null;
      pastLines = w1 == null ? [] : curvesRes.curves
        .filter((c) => c.season !== season)
        .slice(0, 4)
        .map((c) => ({
          season: c.season,
          pts: (c.points || [])
            .map((p) => ({ t: w1 + (p.week - 1) * WEEK, v: p.value }))
            .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)),
        }))
        .filter((l) => l.pts.length >= 2);
    } else if (!showPastSeasons) {
      pastLines = [];
    }

    const entry1 = traj?.modelTrajectories?.get(primaryModel);
    if (!entry1?.samples?.length || !entry1?.horizons?.length) {
      curSum = null; cmpSum = null; hitGeom = null;
      syncLine();
      f.empty(`No sample trajectories for ${modelLabel(primaryModel)} on ${fmtDay(parseIso(useRound))}.`);
      renderNums();
      return;
    }

    const refT = parseIso(traj.reference_date || useRound);
    const offsetDays = Number(traj.horizon_offset_days ?? fan?.horizonOffsetDays ?? 0);
    const obsByTime = fan?.observed ? new Map(fan.observed.map((o) => [o.t, o.v])) : null;

    curSum = summarizeTrajectories(entry1, { refT, horizonOffsetDays: offsetDays, observedByTime: obsByTime });
    const entry2 = compareModel ? traj?.modelTrajectories?.get(compareModel) : null;
    cmpSum = entry2 ? summarizeTrajectories(entry2, { refT, horizonOffsetDays: offsetDays, observedByTime: obsByTime }) : null;

    const firstT = curSum?.times?.[0] ?? refT;
    const priorObs = allFanObs.filter((o) => o.t < firstT);
    histObs = priorObs.slice(-MAX_HIST_WEEKS);

    if (!userToggledCloud && curSum) showPeakCloud = curSum.horizons.length >= 6;
    if (gate && (!curSum || gate.hIdx >= curSum.horizons.length)) gate = null;
    hoverSampleId = null;
    if (pinnedSampleId && !curSum?.samples?.some((sp) => sp.id === pinnedSampleId)) pinnedSampleId = null;
    readout.hide();

    refreshView();
    renderLeaderboard();
  }

  /* ---------------- Canvas drawing ---------------- */
  function draw() {
    if (!curSum) return;
    const W = fig.clientWidth;
    const H = PLOT_HEIGHT;
    if (W < 80) return;
    const g = fitCanvas(canvas, W, H);
    const s = store.get();
    const season = effSeason();

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

    const color1 = resolveModelColor(primaryModel, manifest, s.sel, 0, s.target, season);
    const color2 = compareModel ? resolveModelColor(compareModel, manifest, s.sel, 1, s.target, season) : null;

    const futTimes = curSum.times;
    const obsSeries = allFanObs.length ? allFanObs : histObs;
    const firstRecent = histObs[0]?.t;
    const winStart = fanWindow?.[0] ?? obsSeries[0]?.t ?? futTimes[0];
    const winEnd = fanWindow?.[1] ?? futTimes.at(-1);
    const pastMaxT = showPastSeasons && pastLines.length
      ? Math.max(...pastLines.map((l) => l.pts.at(-1).t))
      : -Infinity;

    const tMinBase = spanMode === "season"
      ? Math.min(winStart, obsSeries[0]?.t ?? winStart, futTimes[0])
      : (Number.isFinite(firstRecent) ? firstRecent : futTimes[0]);
    const tMaxBase = spanMode === "season"
      ? Math.max(winEnd, obsSeries.at(-1)?.t ?? winEnd, futTimes.at(-1), pastMaxT)
      : futTimes.at(-1);
    const padDomain = tMaxBase <= tMinBase ? WEEK : 0;
    const baseDomain = [tMinBase - padDomain, tMaxBase + padDomain];
    const maxPanBounds = [
      Math.min(winStart, obsSeries[0]?.t ?? winStart, futTimes[0]) - 2 * WEEK,
      Math.max(winEnd, obsSeries.at(-1)?.t ?? winEnd, futTimes.at(-1), pastMaxT) + 2 * WEEK,
    ];
    const dom = viewDomain || baseDomain;

    const padL = 52;
    const padR = 18;
    const cloudH = showPeakCloud ? 84 : 12;
    const plotTop = showPeakCloud ? cloudH + 18 : 16;
    const plotBot = H - 30;

    let rawMax = 0;
    for (const o of (viewDomain || spanMode === "season" ? obsSeries : histObs)) if (Number.isFinite(o.v)) rawMax = Math.max(rawMax, o.v);
    for (const sp of curSum.samples) for (const v of sp.values) if (Number.isFinite(v)) rawMax = Math.max(rawMax, v);
    if (cmpSum) for (const sp of cmpSum.samples) for (const v of sp.values) if (Number.isFinite(v)) rawMax = Math.max(rawMax, v);
    for (const rv of curSum.realized) if (Number.isFinite(rv)) rawMax = Math.max(rawMax, rv);
    if (showPastSeasons) for (const pl of pastLines) for (const pt of pl.pts) if (pt.t >= dom[0] && pt.t <= dom[1]) rawMax = Math.max(rawMax, pt.v);
    const yTop = niceMax(rawMax > 0 ? rawMax * 1.06 : 1, 4);

    const x = linear(dom, [padL, W - padR]);
    const y = linear([0, yTop], [plotBot, plotTop]);
    hitGeom = { x, y, times: futTimes, padL, padR, W, plotTop, plotBot, baseDomain, maxPanBounds, dom };

    const shadeTop = showPeakCloud ? 16 : plotTop;
    const xCutRaw = x(futTimes[0] - 3.5 * DAY);
    const xCut = Math.max(padL, Math.min(W - padR, xCutRaw));
    if (xCutRaw < W - padR) {
      g.fillStyle = shadeForecast;
      g.fillRect(xCut, shadeTop, Math.max(0, W - padR - xCut), plotBot - shadeTop);
    }

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

    // X calendar ticks generated smoothly across current pan/zoom viewport
    const visibleWeeks = Math.max(1, Math.round((dom[1] - dom[0]) / WEEK));
    const maxLabels = Math.max(3, Math.floor((W - padL - padR) / 86));
    const stepWeeks = Math.max(1, Math.ceil(visibleWeeks / maxLabels));
    const anchorT = futTimes[0];
    const startStep = Math.ceil((dom[0] - anchorT) / (stepWeeks * WEEK));
    const tickTimes = [];
    for (let k = startStep; ; k++) {
      const tVal = anchorT + k * stepWeeks * WEEK;
      if (tVal > dom[1] + DAY) break;
      if (tVal >= dom[0] - DAY) tickTimes.push(tVal);
    }
    g.textAlign = "center";
    g.textBaseline = "top";
    for (const tVal of tickTimes) {
      const px = x(tVal);
      if (px < padL - 12 || px > W - padR + 12) continue;
      g.fillStyle = tVal < futTimes[0] ? inkTertiary : inkSecondary;
      g.fillText(fmtDay(tVal), px, plotBot + 10);
    }

    // Cutoff hairline (when visible inside viewport)
    if (xCutRaw >= padL && xCutRaw <= W - padR) {
      g.save();
      g.beginPath();
      g.setLineDash([4, 4]);
      g.moveTo(xCutRaw, shadeTop);
      g.lineTo(xCutRaw, plotBot);
      g.strokeStyle = lineAxis;
      g.lineWidth = 1;
      g.stroke();
      g.restore();
    }

    // Clip dynamic plot lines/bands inside plot rectangle so panning stays tidy
    g.save();
    g.beginPath();
    g.rect(padL, 0, Math.max(0, W - padL - padR), plotBot + 4);
    g.clip();

    // Past seasons background reference curves (aligned to active season weeks)
    if (showPastSeasons && pastLines.length) {
      pastLines.forEach((pl, idx) => {
        g.save();
        g.strokeStyle = inkTertiary;
        g.globalAlpha = Math.max(0.18, 0.42 - idx * 0.08);
        g.lineWidth = 1.1;
        g.setLineDash([3, 3]);
        g.beginPath();
        pl.pts.forEach((pt, i) => {
          const px = x(pt.t), py = y(pt.v);
          if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
        });
        g.stroke();
        const lastPt = pl.pts.at(-1);
        const lx = x(lastPt.t), ly = y(lastPt.v);
        if (lx >= padL && lx <= W - padR - 8) {
          g.setLineDash([]);
          g.font = `400 10px ${fontMono}`;
          g.fillStyle = inkTertiary;
          g.textAlign = "right";
          g.textBaseline = "bottom";
          g.fillText(seasonLabel(pl.season), lx - 2, Math.max(plotTop + 12, ly - 3));
        }
        g.restore();
      });
    }

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

    // Historical observed line + dots (draw full season curve so panning left reveals prior weeks)
    const obsToDraw = allFanObs.length ? allFanObs : histObs;
    if (obsToDraw.length) {
      g.save();
      g.strokeStyle = inkPrimary;
      g.lineWidth = 2;
      g.beginPath();
      obsToDraw.forEach((o, i) => {
        const px = x(o.t), py = y(o.v);
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      });
      g.stroke();
      g.fillStyle = inkPrimary;
      for (const o of obsToDraw) {
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
    g.restore();
  }

  function clampPanDomain([d0, d1], [b0, b1]) {
    const span = Math.min(d1 - d0, Math.max(MIN_PAN_SPAN, b1 - b0));
    let s0 = d0, s1 = d0 + span;
    if (s0 < b0) { s0 = b0; s1 = b0 + span; }
    if (s1 > b1) { s1 = b1; s0 = Math.max(b0, b1 - span); }
    return [s0, s1];
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
      const { x, times, padL, padR, W, plotTop, plotBot, dom } = hitGeom;
      if (sx < padL || sx > W - padR || sy < 0 || sy > plotBot) return;
      canvas.setPointerCapture?.(e.pointerId);
      const hIdx = nearestIdxByX(sx, times, x);
      const startInForecast = sx >= x(times[0]) - 12 && sy >= plotTop && sy <= plotBot;
      dragBrush = { mode: null, hIdx, sx0: sx, y0: sy, y1: sy, startInForecast, shift: e.shiftKey, domain0: [...dom], moved: false };
    }),
    on(canvas, "pointermove", (e) => {
      if (!hitGeom || !curSum) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { x, y, times, padL, padR, W, plotTop, plotBot, maxPanBounds } = hitGeom;

      if (dragBrush) {
        const dx = sx - dragBrush.sx0;
        const dy = sy - dragBrush.y0;
        if (!dragBrush.mode && Math.hypot(dx, dy) > 6) {
          dragBrush.mode = (!dragBrush.startInForecast || dragBrush.shift || Math.abs(dx) > Math.abs(dy) * 1.25) ? "pan" : "gate";
          dragBrush.moved = true;
        }
        if (dragBrush.mode === "pan") {
          const plotW = Math.max(1, W - padL - padR);
          const span = dragBrush.domain0[1] - dragBrush.domain0[0];
          const dt = -(dx / plotW) * span;
          viewDomain = clampPanDomain([dragBrush.domain0[0] + dt, dragBrush.domain0[1] + dt], maxPanBounds);
          scheduleDraw();
          return;
        }
        if (dragBrush.mode === "gate") {
          dragBrush.y1 = Math.max(plotTop, Math.min(plotBot, sy));
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
        const wasMode = dragBrush.mode;
        const wasMoved = dragBrush.moved;
        dragBrush = null;
        if (wasMoved) { syncLine(); if (wasMode === "gate") refreshView(); return; }
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
    on(canvas, "dblclick", () => {
      if (viewDomain) { viewDomain = null; refreshView(); }
    }),
    on(canvas, "wheel", (e) => {
      if (!hitGeom || !curSum) return;
      const { padL, padR, W, dom, maxPanBounds } = hitGeom;
      const plotW = Math.max(1, W - padL - padR);
      const span = dom[1] - dom[0];
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const sx = Math.max(padL, Math.min(W - padR, e.clientX - rect.left));
        const frac = (sx - padL) / plotW;
        const pivot = dom[0] + frac * span;
        const factor = Math.exp(e.deltaY * 0.004);
        const maxSpan = Math.max(MIN_PAN_SPAN, maxPanBounds[1] - maxPanBounds[0]);
        const nextSpan = Math.min(maxSpan, Math.max(MIN_PAN_SPAN, span * factor));
        viewDomain = clampPanDomain([pivot - frac * nextSpan, pivot + (1 - frac) * nextSpan], maxPanBounds);
        syncLine();
        scheduleDraw();
        return;
      }
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 0.5) {
        e.preventDefault();
        const dt = (e.deltaX / plotW) * span;
        viewDomain = clampPanDomain([dom[0] + dt, dom[1] + dt], maxPanBounds);
        syncLine();
        scheduleDraw();
      }
    }, { passive: false }),
    on(canvas, "pointerleave", () => {
      hoverSampleId = null;
      pointerPos = null;
      if (!pinnedSampleId) readout.hide();
      scheduleDraw();
    }),
    on(document, "keydown", (e) => {
      if (
        e.key === "Escape"
        && (gate || pinnedSampleId)
        && !el.hidden
        && !activeLayer()
        && !document.querySelector("#app.is-globe-open, #app.is-briefing-open")
      ) {
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
          userSeason = null;
        }
        if (changed.has("target") || changed.has("location") || changed.has("date")) {
          userRound = null;
          viewDomain = null;
          gate = null;
          pinnedSampleId = null;
          hoverSampleId = null;
        }
        screen.run(() => { load(); loadLeaderboard(); });
      } else if (changed.has("sel")) {
        scheduleDraw();
        renderLeaderboard();
      }
    }),
  ];

  load();
  loadLeaderboard();
  return {
    resize: scheduleDraw,
    destroy() {
      reqSeq++;
      boardReqSeq++;
      boardAbortCtl?.abort();
      offs.forEach((off) => off());
    },
  };
}
