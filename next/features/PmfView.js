/* Live categorical PMF view (/next/ print-on-paper craft).
 * Supports 3 quiet representations via .v-line:
 *   - Matrix (default): restrained probability grid across rounds (All rounds) or models x horizons (Single round)
 *   - Flow: calm diverging figure-ground stream anchored on midpoint category (e.g. Stable)
 *   - Bars: discrete 5-bin / K-bin probability histograms with 50% dashed rule */
import { h, on, cssColor, onThemeChange } from "../lib/dom.js";
import { loadPmf } from "../lib/api.js";
import { fragment, action, setLine, linkStyle, fitCanvas, perFrame, resetColors, onDprChange } from "../sections/shared.js";

const CAT_LABELS = {
  large_decrease: { short: "−−", name: "Large dec" },
  decrease: { short: "−", name: "Decrease" },
  stable: { short: "0", name: "Stable" },
  increase: { short: "+", name: "Increase" },
  large_increase: { short: "++", name: "Large inc" },
};

function catShort(key, idx) {
  if (CAT_LABELS[key]) return CAT_LABELS[key].short;
  const s = String(key).replace(/_/g, " ").trim();
  return s.length <= 4 ? s : `${s.slice(0, 3)}.` || String(idx);
}

function catName(key) {
  if (CAT_LABELS[key]) return CAT_LABELS[key].name;
  const s = String(key).replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : String(key);
}

/**
 * Pure categorical scoring metrics for a forecast distribution and realized category index.
 * @param {readonly number[]} probs
 * @param {number} obsIdx
 * @returns {{ rps: number, logScore: number, brier: number, modeHit: boolean }}
 */
export function scorePmfDistribution(probs, obsIdx) {
  if (!Array.isArray(probs) || !probs.length || !Number.isInteger(obsIdx) || obsIdx < 0 || obsIdx >= probs.length) {
    return { rps: NaN, logScore: NaN, brier: NaN, modeHit: false };
  }
  const K = probs.length;
  let sum = 0;
  for (let i = 0; i < K; i++) {
    const v = probs[i];
    if (Number.isFinite(v) && v > 0) sum += v;
  }
  const p = sum > 0 ? probs.map((v) => (Number.isFinite(v) && v > 0 ? v / sum : 0)) : probs.map(() => 1 / K);

  let rps = 0;
  if (K > 1) {
    let cdf = 0;
    for (let k = 0; k < K - 1; k++) {
      cdf += p[k];
      rps += (cdf - (k >= obsIdx ? 1 : 0)) ** 2;
    }
    rps /= K - 1;
  }

  let brier = 0;
  let maxP = -1;
  let argMax = 0;
  for (let k = 0; k < K; k++) {
    brier += (p[k] - (k === obsIdx ? 1 : 0)) ** 2;
    if (p[k] > maxP) { maxP = p[k]; argMax = k; }
  }
  let maxCount = 0;
  for (let k = 0; k < K; k++) if (Math.abs(p[k] - maxP) < 1e-9) maxCount++;

  return {
    rps,
    logScore: Math.log(Math.max(1e-6, p[obsIdx])),
    brier,
    modeHit: maxCount === 1 && argMax === obsIdx,
  };
}

/** Stacked diverging vertical segments centered around the middle ordinal bin (Pure). */
export function verticalPmfSegments(probs) {
  const K = probs.length;
  if (!K) return [];
  const mid = Math.floor(K / 2);
  const segs = new Array(K);
  if (K % 2 === 1) {
    const half = (probs[mid] || 0) * 0.5;
    segs[mid] = { cat: mid, y0: -half, y1: half };
    let up = half;
    for (let k = mid + 1; k < K; k++) { segs[k] = { cat: k, y0: up, y1: up + (probs[k] || 0) }; up = segs[k].y1; }
    let down = -half;
    for (let k = mid - 1; k >= 0; k--) { segs[k] = { cat: k, y0: down - (probs[k] || 0), y1: down }; down = segs[k].y0; }
  } else {
    let up = 0;
    for (let k = mid; k < K; k++) { segs[k] = { cat: k, y0: up, y1: up + (probs[k] || 0) }; up = segs[k].y1; }
    let down = 0;
    for (let k = mid - 1; k >= 0; k--) { segs[k] = { cat: k, y0: down - (probs[k] || 0), y1: down }; down = segs[k].y0; }
  }
  return segs;
}

function parseRgb(str, fallback = [10, 132, 255]) {
  const m = String(str || "").match(/[\d.]+/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : fallback;
}

function mixRgb(a, b, t) {
  const u = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * u),
    Math.round(a[1] + (b[1] - a[1]) * u),
    Math.round(a[2] + (b[2] - a[2]) * u),
  ];
}

const rgbaStr = (rgb, a = 1) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;

/**
 * Normalizes a `/api/next/pmf` JSON payload into fast round/model indexed lookups.
 * @param {object} raw
 * @param {import("../lib/api.js").Manifest} manifest
 */
function normalizePmfPayload(raw, manifest) {
  const categories = Array.isArray(raw?.categories) ? raw.categories : [];
  const catIdx = new Map(categories.map((c, i) => [c, i]));
  const rounds = Array.isArray(raw?.rounds) ? raw.rounds : [];
  const obsByDate = new Map();
  for (const o of raw?.observed || []) {
    if (o?.date && catIdx.has(o.category)) obsByDate.set(o.date, catIdx.get(o.category));
  }

  const modelsObj = raw?.models || {};
  const modelIds = Object.keys(modelsObj).sort((a, b) => {
    const ma = manifest.modelById.get(a), mb = manifest.modelById.get(b);
    const ea = ma?.ensemble || /ens/i.test(a) ? 0 : 1;
    const eb = mb?.ensemble || /ens/i.test(b) ? 0 : 1;
    if (ea !== eb) return ea - eb;
    return manifest.label(a).localeCompare(manifest.label(b));
  });

  const horizonsSet = new Set();
  const byRound = {};
  for (const r of rounds) byRound[r] = { models: {} };

  for (const mid of modelIds) {
    const rMap = modelsObj[mid] || {};
    for (const r of Object.keys(rMap)) {
      if (!byRound[r]) { byRound[r] = { models: {} }; if (!rounds.includes(r)) rounds.push(r); }
      const hMap = rMap[r] || {};
      const outH = {};
      for (const hStr of Object.keys(hMap)) {
        const h = Number(hStr);
        if (!Number.isInteger(h)) continue;
        horizonsSet.add(h);
        const rec = hMap[hStr];
        const probs = categories.map((c) => Number(rec?.probs?.[c] ?? 0));
        const sum = probs.reduce((a, b) => a + b, 0);
        const norm = sum > 0 ? probs.map((v) => v / sum) : probs;
        const obsIdx = rec?.target_end_date && obsByDate.has(rec.target_end_date)
          ? obsByDate.get(rec.target_end_date)
          : null;
        const scores = obsIdx != null ? scorePmfDistribution(norm, obsIdx) : { rps: NaN, logScore: NaN, brier: NaN, modeHit: false };
        outH[h] = { targetEndDate: rec?.target_end_date || null, probs: norm, obsIdx, ...scores };
      }
      byRound[r].models[mid] = outH;
    }
  }
  rounds.sort();
  const horizons = [...horizonsSet].sort((a, b) => a - b);
  return {
    season: raw?.season,
    categories,
    ordinal: raw?.ordinal !== false && categories.length >= 2,
    rounds,
    horizons,
    modelIds,
    byRound,
  };
}

/**
 * Mounts the live categorical PMF view into `host`.
 * @param {HTMLElement} host
 * @param {{ manifest: import("../lib/api.js").Manifest, store: object, onReady?: () => void }} ctx
 */
export function mountPmfView(host, ctx) {
  const { manifest, store, onReady, compact = false, getSource = null } = ctx;
  linkStyle("views");
  linkStyle("pmf");

  const sec = h("section", { class: compact ? "v-section pmf-compact" : "v-section" });
  const line = h("div", { class: "v-line" });
  const titleEl = h("h2", { class: "v-title" });
  const head = h("header", { class: "v-head" }, titleEl, line);
  const progress = h("div", { class: "v-progress", "aria-hidden": "true" });
  const emptyEl = h("p", { class: "v-empty", hidden: true });
  const body = h("div", { class: "v-body" });
  const fig = h("div", { class: "pmf-fig" });
  const canvas = h("canvas", { class: "pmf-canvas", "aria-label": "Categorical probability chart" });
  const readout = h("div", { class: "c-readout v-readout", role: "status", hidden: true });
  const keyEl = h("div", { class: "pmf-key" });
  const tableWrap = h("div", { class: "pmf-table-wrap" });

  fig.append(canvas, readout);
  body.append(fig, keyEl, tableWrap);
  sec.append(head, progress, emptyEl, body);
  host.replaceChildren(sec);

  let data = null;
  let shapeMode = "matrix"; // "matrix" | "flow" | "bars"
  let viewMode = "all";     // "all" | "round"
  let roundIdx = 0;
  let horizon = 1;
  let focusModel = "";
  let defaultModel = "";
  let hoverHit = null;
  let hitTargets = [];
  let token = 0;
  let destroyed = false;
  let loadedReqKey = "";
  const offs = [];

  const setEmpty = (text, retry) => {
    emptyEl.hidden = !text;
    body.hidden = !!text;
    emptyEl.replaceChildren(text || "", retry ? h("span", null, " · ", h("button", { type: "button", class: "c-link", onclick: retry }, "Retry")) : "");
  };

  function pickInitialModel(modelIds) {
    if (!modelIds.length) return "";
    const s = store.get();
    const fromSel = s.sel.selected.find((id) => modelIds.includes(id));
    if (fromSel) return fromSel;
    const ens = modelIds.find((id) => manifest.modelById.get(id)?.ensemble)
      || modelIds.find((id) => /ens/i.test(id));
    return ens || modelIds[0];
  }

  function comparedModels() {
    if (!data?.modelIds?.length) return [];
    const s = store.get();
    const picks = [];
    const add = (id) => { if (id && data.modelIds.includes(id) && !picks.includes(id)) picks.push(id); };
    add(focusModel);
    for (const id of s.sel.selected) { add(id); if (picks.length >= 4) break; }
    for (const id of data.modelIds) { if (picks.length >= 4) break; add(id); }
    return picks;
  }

  function nearestIndex(rounds, targetIso) {
    if (!rounds.length) return 0;
    const exact = rounds.indexOf(targetIso);
    if (exact >= 0) return exact;
    if (!targetIso) return rounds.length - 1;
    let best = 0;
    for (let i = 1; i < rounds.length; i++) {
      if (rounds[i] <= targetIso) best = i;
    }
    return best;
  }

  const F = {
    shape: fragment({
      label: "View", title: "PMF representation",
      items: () => [
        { value: "matrix", label: "Matrix" },
        ...(data && data.ordinal === false ? [] : [{ value: "flow", label: "Flow" }]),
        { value: "bars", label: "Bars" },
      ],
      value: () => shapeMode,
      isDefault: () => shapeMode === "matrix",
      onSelect: (v) => { shapeMode = v; renderAll(); },
    }),
    mode: fragment({
      label: "Scope", title: "Round scope",
      items: () => [{ value: "all", label: "All rounds" }, { value: "round", label: "Single round" }],
      value: () => viewMode,
      isDefault: () => viewMode === "all",
      onSelect: (v) => { viewMode = v; renderAll(); },
    }),
    horizon: fragment({
      label: "Horizon", title: "Horizon",
      items: () => (data?.horizons || [0, 1, 2, 3]).map((x) => ({ value: x, label: `${x} wk ahead` })),
      value: () => horizon,
      isDefault: () => horizon === (data?.horizons?.includes(1) ? 1 : data?.horizons?.[0] ?? 1),
      onSelect: (v) => { horizon = v; renderAll(); },
    }),
    model: fragment({
      label: "Model", title: "Model",
      items: () => (data?.modelIds || []).map((id) => ({ value: id, label: manifest.label(id, data.modelIds) })),
      value: () => focusModel,
      isDefault: () => focusModel === defaultModel,
      onSelect: (v) => { focusModel = v; renderAll(); },
    }),
    round: fragment({
      label: "Round", title: "Reference round",
      items: () => (data?.rounds || []).map((d, i) => ({ value: i, label: d })),
      value: () => roundIdx,
      isDefault: () => data ? roundIdx === data.rounds.length - 1 : true,
      onSelect: (v) => { roundIdx = v; renderAll(); },
    }),
  };

  const prevBtn = action("‹", "Previous round", () => {
    if (!data?.rounds?.length) return;
    roundIdx = (roundIdx - 1 + data.rounds.length) % data.rounds.length;
    renderAll();
  });
  const nextBtn = action("›", "Next round", () => {
    if (!data?.rounds?.length) return;
    roundIdx = (roundIdx + 1) % data.rounds.length;
    renderAll();
  });

  function syncLine() {
    Object.values(F).forEach((b) => b.sync());
    const showHoriz = viewMode === "all" && shapeMode !== "bars";
    const parts = viewMode === "all"
      ? [F.shape, F.mode, showHoriz && F.horizon, F.model].filter(Boolean)
      : [F.shape, F.mode, F.round];
    setLine(line, parts);
    if (viewMode === "round" && data?.rounds?.length) {
      F.round.before(prevBtn);
      prevBtn.classList.add("v-tight");
      F.round.after(nextBtn);
      nextBtn.classList.add("v-tight");
    }
  }

  function renderKey() {
    if (!data) { keyEl.replaceChildren(); return; }
    const isLight = document.documentElement.dataset.theme === "light";
    if (shapeMode === "matrix") {
      const paperRgb = parseRgb(cssColor("var(--surface-paper)"), isLight ? [250, 250, 251] : [11, 11, 11]);
      const accentRgb = parseRgb(cssColor("var(--accent)"), [10, 132, 255]);
      const inkRgb = parseRgb(cssColor("var(--ink-primary)"), [230, 230, 230]);
      const peakRgb = mixRgb(accentRgb, inkRgb, isLight ? 0.12 : 0.05);
      keyEl.replaceChildren(
        h("span", { class: "pmf-key-item" },
          h("span", null, "0%"),
          h("span", {
            class: "pmf-key-ramp",
            style: { background: `linear-gradient(90deg, ${rgbaStr(paperRgb)}, ${rgbaStr(mixRgb(paperRgb, peakRgb, 0.35))}, ${rgbaStr(peakRgb)})`, boxShadow: "inset 0 0 0 1px var(--line-hairline)" },
          }),
          h("span", null, "100% probability")),
        h("span", { class: "pmf-key-item" }, "● Realized bin"),
      );
      return;
    }
    if (shapeMode === "flow") {
      const accentRgb = parseRgb(cssColor("var(--accent)"), [10, 132, 255]);
      const inkRgb = parseRgb(cssColor("var(--ink-secondary)"), [140, 145, 155]);
      keyEl.replaceChildren(
        h("span", { class: "pmf-key-item" }, h("i", { style: { background: rgbaStr(accentRgb, 0.72) } }), "Upper categories"),
        h("span", { class: "pmf-key-item" }, h("i", { style: { background: "var(--fill-field)", boxShadow: "inset 0 0 0 1px var(--line-hairline)" } }), "Midline"),
        h("span", { class: "pmf-key-item" }, h("i", { style: { background: rgbaStr(inkRgb, 0.58) } }), "Lower categories"),
        h("span", { class: "pmf-key-item" }, "● Realized"),
      );
      return;
    }
    keyEl.replaceChildren(
      h("span", { class: "pmf-key-item" }, h("i", { style: { background: "var(--accent)" } }), "Realized bin"),
      h("span", { class: "pmf-key-item" }, h("i", { style: { background: "var(--ink-tertiary)" } }), "Other bins"),
      h("span", { class: "pmf-key-item" }, "Dashed rule = 50%"),
    );
  }

  function renderTable() {
    if (!data?.modelIds?.length || !data?.rounds?.length) { tableWrap.replaceChildren(); return; }
    const activeDates = viewMode === "all" ? data.rounds : [data.rounds[roundIdx]];
    const targetHzs = viewMode === "all" && shapeMode !== "bars" ? [horizon] : data.horizons;
    const labelMap = new Map(data.modelIds.map((id) => [id, manifest.label(id, data.modelIds)]));

    const rows = data.modelIds.map((mid) => {
      let n = 0, rps = 0, logS = 0, brier = 0, hits = 0;
      for (const d of activeDates) {
        const rec = data.byRound[d];
        if (!rec) continue;
        for (const hVal of targetHzs) {
          const entry = rec.models[mid]?.[hVal];
          if (!entry || entry.obsIdx == null || !Number.isFinite(entry.rps)) continue;
          rps += entry.rps;
          logS += entry.logScore;
          brier += entry.brier;
          if (entry.modeHit) hits++;
          n++;
        }
      }
      return {
        id: mid,
        name: labelMap.get(mid) || mid,
        n,
        rps: n ? rps / n : NaN,
        logS: n ? logS / n : NaN,
        brier: n ? brier / n : NaN,
        hitPct: n ? Math.round((hits / n) * 100) : NaN,
      };
    });

    rows.sort((a, b) => {
      const af = Number.isFinite(a.rps), bf = Number.isFinite(b.rps);
      if (af !== bf) return af ? -1 : 1;
      if (af && a.rps !== b.rps) return a.rps - b.rps;
      return a.name.localeCompare(b.name);
    });

    const scopeHdr = viewMode === "all"
      ? `Model (${data.rounds.length} rounds · ${horizon} wk)`
      : `Model (${data.rounds[roundIdx]} · all horizons)`;

    tableWrap.replaceChildren(
      h("table", { class: "v-table" },
        h("thead", null,
          h("tr", null,
            h("th", null, scopeHdr),
            h("th", null, "RPS"),
            h("th", null, "Log score"),
            h("th", null, "Brier"),
            h("th", null, "Mode hit"),
          )),
        h("tbody", null,
          ...rows.map((r, idx) =>
            h("tr", {
              "data-model": r.id,
              class: r.id === focusModel ? "is-focus" : null,
              onclick: () => { focusModel = r.id; renderAll(); },
            },
            h("td", null, h("span", { class: "v-name", style: { "--c": r.id === focusModel ? "var(--accent)" : `var(--series-${(idx % 5) + 1})` } }, h("i"), r.name)),
            h("td", { class: "num" }, Number.isFinite(r.rps) ? r.rps.toFixed(3) : "–"),
            h("td", { class: "num" }, Number.isFinite(r.logS) ? r.logS.toFixed(2) : "–"),
            h("td", { class: "num" }, Number.isFinite(r.brier) ? r.brier.toFixed(3) : "–"),
            h("td", { class: "num" }, Number.isFinite(r.hitPct) ? `${r.hitPct}%` : "–"),
            )))),
    );
  }

  /* ---------------- Pointer & Readout ---------------- */
  function findHit(sx, sy) {
    for (let i = hitTargets.length - 1; i >= 0; i--) {
      const b = hitTargets[i];
      if (sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1) return b;
    }
    return null;
  }

  offs.push(on(canvas, "pointermove", (e) => {
    if (!data) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hit = findHit(sx, sy);
    if (hit) {
      hoverHit = hit;
      const cats = data.categories;
      const rows = [];
      for (let k = cats.length - 1; k >= 0; k--) {
        rows.push(
          h("tr", null,
            h("td", { class: "c-readout-name" },
              hit.obsIdx === k ? h("strong", { style: { color: "var(--accent)" } }, `${catName(cats[k])} ●`) : catName(cats[k])),
            h("td", { class: "num" }, `${((hit.probs[k] || 0) * 100).toFixed(1)}%`),
          ),
        );
      }
      readout.replaceChildren(
        h("div", { class: "c-readout-head" },
          h("span", { style: { fontWeight: "600", color: "var(--ink-primary)" } }, hit.title),
          h("span", { class: "quiet" }, hit.sub),
        ),
        h("table", null, h("tbody", null, ...rows)),
        Number.isFinite(hit.rps) ? h("div", { class: "c-readout-foot" },
          h("span", null, `RPS ${hit.rps.toFixed(3)}`),
          h("span", null, `Log ${hit.logScore.toFixed(2)}`),
        ) : null,
      );
      readout.hidden = false;
      const rx = Math.min(Math.max(8, sx + 14), Math.max(8, rect.width - 245));
      const ry = Math.min(Math.max(8, sy - 16), Math.max(8, rect.height - 160));
      readout.style.transform = `translate(${rx}px, ${ry}px)`;
    } else if (hoverHit) {
      hoverHit = null;
      readout.hidden = true;
    }
    scheduleDraw();
  }));

  offs.push(on(canvas, "pointerleave", () => {
    if (!hoverHit && readout.hidden) return;
    hoverHit = null;
    readout.hidden = true;
    scheduleDraw();
  }));

  offs.push(on(canvas, "click", () => {
    if (!hoverHit || hoverHit.roundIndex == null) return;
    roundIdx = hoverHit.roundIndex;
    if (shapeMode !== "bars" && viewMode === "all") viewMode = "round";
    renderAll();
  }));

  /* ---------------- Canvas Drawing ---------------- */
  const scheduleDraw = perFrame(draw);
  function draw() {
    if (destroyed || !data?.rounds?.length) return;
    const W = fig.clientWidth;
    if (W < 60) return;
    const cmp = comparedModels();
    const isBarsSingle = shapeMode === "bars" && viewMode === "round";
    const H = compact
      ? (isBarsSingle ? Math.max(176, cmp.length * 64 + 36) : shapeMode === "bars" ? 228 : shapeMode === "matrix" ? Math.max(184, data.categories.length * 32 + 52) : 228)
      : (isBarsSingle ? Math.max(220, cmp.length * 88 + 44) : shapeMode === "bars" ? 310 : shapeMode === "matrix" ? Math.max(240, data.categories.length * 42 + 64) : 300);
    const g = fitCanvas(canvas, W, H);

    const isLight = document.documentElement.dataset.theme === "light";
    const paperRgb = parseRgb(cssColor("var(--surface-paper)"), isLight ? [250, 250, 251] : [11, 11, 11]);
    const accentRgb = parseRgb(cssColor("var(--accent)"), [10, 132, 255]);
    const inkPrimaryRgb = parseRgb(cssColor("var(--ink-primary)"), isLight ? [17, 18, 22] : [238, 240, 244]);
    const inkSecondaryRgb = parseRgb(cssColor("var(--ink-secondary)"), [130, 134, 144]);
    const pal = {
      isLight, paperRgb, accentRgb, inkPrimaryRgb, inkSecondaryRgb,
      inkPrimary: cssColor("var(--ink-primary)"),
      inkSecondary: cssColor("var(--ink-secondary)"),
      inkTertiary: cssColor("var(--ink-tertiary)"),
      accent: cssColor("var(--accent)"),
      lineAxis: cssColor("var(--line-axis)"),
      hairline: cssColor("var(--line-hairline)"),
      surfPaper: cssColor("var(--surface-paper)"),
      fontMono: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
      fontSans: getComputedStyle(document.documentElement).getPropertyValue("--font-sans"),
    };

    hitTargets = [];
    if (shapeMode === "matrix") drawMatrix(g, W, H, cmp, pal);
    else if (shapeMode === "flow") drawFlow(g, W, H, cmp, pal);
    else drawBars(g, W, H, cmp, pal);
  }

  function drawMatrix(g, W, H, cmp, pal) {
    const padL = 82, padR = 14, padT = 26, padB = 30;
    const peakRgb = mixRgb(pal.accentRgb, pal.inkPrimaryRgb, pal.isLight ? 0.14 : 0.04);
    const cats = data.categories;
    const K = cats.length;
    const rowOrder = Array.from({ length: K }, (_, i) => K - 1 - i);
    const gridH = H - padT - padB;
    const rowH = gridH / K;
    const midCat = Math.floor(K / 2);

    g.font = `400 10.5px ${pal.fontSans}`;
    g.textAlign = "right";
    g.textBaseline = "middle";
    rowOrder.forEach((cat, rIdx) => {
      g.fillStyle = cat === midCat ? pal.inkPrimary : pal.inkSecondary;
      g.fillText(catName(cats[cat]), padL - 10, padT + (rIdx + 0.5) * rowH);
    });

    const paintCell = (x, y, w, hCell, p, isObs, isHovCol) => {
      const gap = w >= 24 ? 2 : 1.5;
      const cx = x + gap * 0.5, cy = y + gap * 0.5;
      const cw = Math.max(2, w - gap), ch = Math.max(4, hCell - gap);
      const t = Math.pow(Math.max(0, Math.min(1, p)), 0.78);
      g.fillStyle = rgbaStr(mixRgb(pal.paperRgb, peakRgb, t), 1);
      g.fillRect(cx, cy, cw, ch);

      if (isHovCol) {
        g.strokeStyle = rgbaStr(pal.inkPrimaryRgb, 0.35);
        g.lineWidth = 1;
        g.strokeRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
      }
      if (cw >= 28 && ch >= 20 && p >= 0.22) {
        g.font = `500 10px ${pal.fontMono}`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillStyle = t > 0.45 ? (pal.isLight ? "#ffffff" : "#0b0b0b") : pal.inkSecondary;
        g.fillText(`${Math.round(p * 100)}`, cx + cw * 0.5 + (isObs ? -7 : 0), cy + ch * 0.5);
      }
      if (isObs) {
        const mx = cw >= 28 && p >= 0.22 ? cx + cw * 0.5 + 10 : cx + cw * 0.5;
        const my = cy + ch * 0.5;
        g.beginPath();
        g.arc(mx, my, Math.min(4.2, cw * 0.16), 0, Math.PI * 2);
        g.fillStyle = t > 0.48 ? "#ffffff" : pal.inkPrimary;
        g.fill();
        g.strokeStyle = pal.surfPaper;
        g.lineWidth = 1.25;
        g.stroke();
      }
    };

    if (viewMode === "all") {
      const n = data.rounds.length;
      const colW = (W - padL - padR) / n;
      const tickStep = Math.max(1, Math.ceil(n / 8));
      const mLabel = manifest.label(focusModel, data.modelIds);
      data.rounds.forEach((date, i) => {
        const rec = data.byRound[date];
        const entry = rec?.models?.[focusModel]?.[horizon];
        const x0 = padL + i * colW;
        if (entry) {
          const isHov = hoverHit?.key === date;
          rowOrder.forEach((cat, rIdx) => {
            paintCell(x0, padT + rIdx * rowH, colW, rowH, entry.probs[cat] || 0, entry.obsIdx === cat, isHov);
          });
          hitTargets.push({
            key: date, roundIndex: i, x0, x1: x0 + colW, y0: padT, y1: padT + gridH,
            title: date, sub: `${horizon} wk · ${mLabel}`,
            probs: entry.probs, obsIdx: entry.obsIdx, rps: entry.rps, logScore: entry.logScore,
          });
        }
        if (i % tickStep === 0 || i === n - 1) {
          g.font = `400 10.5px ${pal.fontMono}`;
          g.textAlign = "center";
          g.textBaseline = "top";
          g.fillStyle = i === roundIdx ? pal.inkPrimary : pal.inkTertiary;
          g.fillText(date.slice(5), x0 + colW * 0.5, H - padB + 8);
        }
      });
    } else {
      const date = data.rounds[roundIdx];
      const rec = data.byRound[date];
      const hzs = data.horizons;
      const mCount = Math.max(1, cmp.length);
      const groupGap = 16;
      const groupW = (W - padL - padR - groupGap * (mCount - 1)) / mCount;
      const colW = groupW / Math.max(1, hzs.length);

      cmp.forEach((mid, mi) => {
        const gx0 = padL + mi * (groupW + groupGap);
        const mLabel = manifest.label(mid, cmp);
        g.font = `500 11px ${pal.fontSans}`;
        g.textAlign = "center";
        g.textBaseline = "bottom";
        g.fillStyle = mid === focusModel ? pal.inkPrimary : pal.inkSecondary;
        g.fillText(mLabel, gx0 + groupW * 0.5, padT - 7, groupW);

        hzs.forEach((hz, hi) => {
          const entry = rec?.models?.[mid]?.[hz];
          const x0 = gx0 + hi * colW;
          g.font = `400 10px ${pal.fontMono}`;
          g.textAlign = "center";
          g.textBaseline = "top";
          g.fillStyle = pal.inkTertiary;
          g.fillText(`${hz}w`, x0 + colW * 0.5, H - padB + 8);
          if (!entry) return;
          const key = `${mid}:${hz}`;
          const isHov = hoverHit?.key === key;
          rowOrder.forEach((cat, rIdx) => {
            paintCell(x0, padT + rIdx * rowH, colW, rowH, entry.probs[cat] || 0, entry.obsIdx === cat, isHov);
          });
          hitTargets.push({
            key, x0, x1: x0 + colW, y0: padT, y1: padT + gridH,
            title: mLabel, sub: `${hz} wk · ${date}`,
            probs: entry.probs, obsIdx: entry.obsIdx, rps: entry.rps, logScore: entry.logScore,
          });
        });
      });
    }
  }

  function flowColors(K, pal) {
    const mid = Math.floor(K / 2);
    return Array.from({ length: K }, (_, k) => {
      if (K % 2 === 1 && k === mid) return rgbaStr(pal.inkPrimaryRgb, pal.isLight ? 0.06 : 0.08);
      if (k >= mid) {
        const t = (k - mid) / Math.max(1, K - 1 - mid);
        return rgbaStr(pal.accentRgb, 0.28 + t * 0.5);
      }
      const t = (mid - k) / Math.max(1, mid);
      return rgbaStr(pal.inkSecondaryRgb, (pal.isLight ? 0.24 : 0.22) + t * 0.42);
    });
  }

  function drawFlow(g, W, H, cmp, pal) {
    const padL = 56, padR = 14, padT = 22, padB = 32;
    const plotH = H - padT - padB;
    const yZero = padT + plotH * 0.5;
    const halfH = plotH * 0.48;
    const yAt = (val) => yZero - val * halfH;
    const K = data.categories.length;
    const segFill = flowColors(K, pal);

    g.font = `400 10.5px ${pal.fontMono}`;
    g.textAlign = "right";
    g.textBaseline = "middle";
    for (const [val, lbl] of [[0.5, "+50%"], [0, "Mid"], [-0.5, "−50%"]]) {
      const y = yAt(val);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y);
      g.strokeStyle = val === 0 ? pal.lineAxis : pal.hairline;
      g.lineWidth = val === 0 ? 1.2 : 1;
      g.stroke();
      g.fillStyle = val === 0 ? pal.inkSecondary : pal.inkTertiary;
      g.fillText(lbl, padL - 8, y);
    }

    if (viewMode === "all") {
      const n = data.rounds.length;
      const slotW = (W - padL - padR) / n;
      const tickStep = Math.max(1, Math.ceil(n / 8));
      const mLabel = manifest.label(focusModel, data.modelIds);
      const series = data.rounds.map((date, i) => {
        const entry = data.byRound[date]?.models?.[focusModel]?.[horizon];
        return entry ? { date, i, x: padL + (i + 0.5) * slotW, entry, segs: verticalPmfSegments(entry.probs) } : null;
      }).filter(Boolean);

      for (let cat = 0; cat < K; cat++) {
        if (!series.length) break;
        g.beginPath();
        series.forEach((pt, idx) => { const y = yAt(pt.segs[cat].y1); if (idx === 0) g.moveTo(pt.x, y); else g.lineTo(pt.x, y); });
        for (let idx = series.length - 1; idx >= 0; idx--) g.lineTo(series[idx].x, yAt(series[idx].segs[cat].y0));
        g.closePath();
        g.fillStyle = segFill[cat];
        g.fill();
      }

      if (hoverHit?.x0 != null && hoverHit.roundIndex != null) {
        const xc = padL + (hoverHit.roundIndex + 0.5) * slotW;
        g.fillStyle = cssColor("var(--fill-hover)");
        g.fillRect(xc - slotW * 0.5, padT, slotW, plotH);
      }

      g.beginPath();
      let started = false;
      series.forEach((pt) => {
        if (pt.entry.obsIdx == null) return;
        const s = pt.segs[pt.entry.obsIdx];
        const my = yAt((s.y0 + s.y1) * 0.5);
        if (!started) { g.moveTo(pt.x, my); started = true; } else g.lineTo(pt.x, my);
      });
      g.strokeStyle = rgbaStr(pal.inkPrimaryRgb, 0.35);
      g.lineWidth = 1.25;
      g.setLineDash([3, 3]);
      g.stroke();
      g.setLineDash([]);

      series.forEach((pt) => {
        if (pt.entry.obsIdx != null) {
          const s = pt.segs[pt.entry.obsIdx];
          const my = yAt((s.y0 + s.y1) * 0.5);
          g.beginPath(); g.arc(pt.x, my, 3.6, 0, Math.PI * 2);
          g.fillStyle = pal.inkPrimary; g.fill();
          g.strokeStyle = pal.surfPaper; g.lineWidth = 1.4; g.stroke();
        }
        if (pt.i % tickStep === 0 || pt.i === n - 1) {
          g.font = `400 10.5px ${pal.fontMono}`;
          g.textAlign = "center";
          g.textBaseline = "top";
          g.fillStyle = pt.i === roundIdx ? pal.inkPrimary : pal.inkTertiary;
          g.fillText(pt.date.slice(5), pt.x, H - padB + 10);
        }
        const x0 = padL + pt.i * slotW;
        hitTargets.push({
          key: pt.date, roundIndex: pt.i, x0, x1: x0 + slotW, y0: padT, y1: padT + plotH,
          title: pt.date, sub: `${horizon} wk · ${mLabel}`,
          probs: pt.entry.probs, obsIdx: pt.entry.obsIdx, rps: pt.entry.rps, logScore: pt.entry.logScore,
        });
      });
    } else {
      const date = data.rounds[roundIdx];
      const rec = data.byRound[date];
      const hzs = data.horizons;
      const mCount = Math.max(1, cmp.length);
      const groupW = (W - padL - padR) / mCount;
      const colSlot = (groupW - 18) / Math.max(1, hzs.length);
      const colW = Math.max(8, Math.min(28, colSlot * 0.72));

      cmp.forEach((mid, mi) => {
        const gx0 = padL + mi * groupW + 9;
        const mLabel = manifest.label(mid, cmp);
        hzs.forEach((hz, hi) => {
          const entry = rec?.models?.[mid]?.[hz];
          const xc = gx0 + (hi + 0.5) * colSlot;
          g.font = `400 10px ${pal.fontMono}`;
          g.textAlign = "center";
          g.textBaseline = "top";
          g.fillStyle = pal.inkTertiary;
          g.fillText(`${hz}w`, xc, yZero + halfH + 4);
          if (!entry) return;
          const xLeft = xc - colW * 0.5;
          const key = `${mid}:${hz}`;
          if (hoverHit?.key === key) {
            g.fillStyle = cssColor("var(--fill-hover)");
            g.fillRect(xLeft - 2, padT, colW + 4, plotH);
          }
          const segs = verticalPmfSegments(entry.probs);
          segs.forEach((s) => {
            const yTop = yAt(s.y1), yBot = yAt(s.y0);
            g.fillStyle = segFill[s.cat];
            g.fillRect(xLeft, yTop, colW, Math.max(0.5, yBot - yTop));
          });
          if (entry.obsIdx != null) {
            const obsSeg = segs[entry.obsIdx];
            g.beginPath(); g.arc(xc, yAt((obsSeg.y0 + obsSeg.y1) * 0.5), 3.6, 0, Math.PI * 2);
            g.fillStyle = pal.inkPrimary; g.fill();
            g.strokeStyle = pal.surfPaper; g.lineWidth = 1.4; g.stroke();
          }
          hitTargets.push({
            key, x0: xc - colSlot * 0.5, x1: xc + colSlot * 0.5, y0: padT, y1: padT + plotH,
            title: mLabel, sub: `${hz} wk · ${date}`,
            probs: entry.probs, obsIdx: entry.obsIdx, rps: entry.rps, logScore: entry.logScore,
          });
        });
        g.font = `500 11px ${pal.fontSans}`;
        g.textAlign = "center";
        g.textBaseline = "top";
        g.fillStyle = mid === focusModel ? pal.inkPrimary : pal.inkSecondary;
        g.fillText(mLabel, padL + (mi + 0.5) * groupW, H - padB + 14, groupW - 8);
      });
    }
  }

  function drawBars(g, W, H, cmp, pal) {
    const K = data.categories.length;
    const cats = data.categories;
    const midCat = Math.floor(K / 2);

    const drawMiniHistogram = (x, y, w, hBox, probs, obsIdx, meta, showPctLabels) => {
      const innerPadT = 14, innerPadB = 16;
      const chartH = Math.max(24, hBox - innerPadT - innerPadB);
      const baseY = y + innerPadT + chartH;
      const midY = y + innerPadT + chartH * 0.5;
      const slotW = w / K;
      const barW = Math.max(6, Math.min(26, slotW * 0.62));
      if (hoverHit?.key === meta.key) {
        g.fillStyle = cssColor("var(--fill-hover)");
        g.fillRect(x - 2, y, w + 4, hBox);
      }

      g.beginPath(); g.moveTo(x, midY); g.lineTo(x + w, midY);
      g.strokeStyle = pal.hairline; g.lineWidth = 1; g.setLineDash([2, 3]); g.stroke(); g.setLineDash([]);

      g.beginPath(); g.moveTo(x, baseY); g.lineTo(x + w, baseY);
      g.strokeStyle = pal.lineAxis; g.lineWidth = 1; g.stroke();

      probs.forEach((p, cat) => {
        const bx = x + (cat + 0.5) * slotW - barW * 0.5;
        const bh = Math.max(1.5, p * chartH);
        const by = baseY - bh;
        const isObs = obsIdx === cat;
        g.fillStyle = isObs ? pal.accent : rgbaStr(pal.inkPrimaryRgb, pal.isLight ? 0.34 : 0.38);
        g.fillRect(bx, by, barW, bh);

        if (showPctLabels && p >= 0.04) {
          g.font = `400 10px ${pal.fontMono}`;
          g.textAlign = "center";
          g.textBaseline = "bottom";
          g.fillStyle = isObs ? pal.accent : pal.inkSecondary;
          g.fillText(`${Math.round(p * 100)}%`, bx + barW * 0.5, by - 3);
        }
        g.font = `${isObs ? "600" : "400"} 10px ${pal.fontMono}`;
        g.textAlign = "center";
        g.textBaseline = "top";
        g.fillStyle = isObs ? pal.accent : pal.inkTertiary;
        g.fillText(catShort(cats[cat], cat), bx + barW * 0.5, baseY + 4);
      });
      hitTargets.push({ ...meta, x0: x, x1: x + w, y0: y, y1: y + hBox, probs, obsIdx });
    };

    const hzs = data.horizons;
    if (viewMode === "all") {
      const stripT = 16, stripH = 74, padL = 56, padR = 16;
      const n = data.rounds.length;
      const slotW = (W - padL - padR) / n;
      const yMid = stripT + stripH * 0.5;
      const mLabel = manifest.label(focusModel, data.modelIds);
      const tickStep = Math.max(1, Math.ceil(n / 7));

      g.font = `400 10px ${pal.fontSans}`;
      g.textAlign = "right";
      g.textBaseline = "middle";
      g.fillStyle = pal.inkTertiary;
      g.fillText("Net ±", padL - 10, yMid);

      g.beginPath(); g.moveTo(padL, yMid); g.lineTo(W - padR, yMid);
      g.strokeStyle = pal.hairline; g.lineWidth = 1; g.stroke();

      data.rounds.forEach((date, i) => {
        const entry = data.byRound[date]?.models?.[focusModel]?.[horizon];
        if (!entry) return;
        let upper = 0, lower = 0;
        for (let k = 0; k < K; k++) {
          if (k > midCat || (K % 2 === 0 && k >= midCat)) upper += entry.probs[k] || 0;
          else if (k < midCat) lower += entry.probs[k] || 0;
        }
        const net = upper - lower;
        const xc = padL + (i + 0.5) * slotW;
        const bw = Math.max(6, Math.min(20, slotW * 0.62));
        const bh = Math.max(2, Math.abs(net) * (stripH * 0.42));
        const isSel = i === roundIdx;
        if (isSel) {
          g.fillStyle = cssColor("var(--fill-selected)");
          g.fillRect(padL + i * slotW, stripT, slotW, stripH);
        }
        g.fillStyle = net >= 0 ? rgbaStr(pal.accentRgb, isSel ? 0.9 : 0.45) : rgbaStr(pal.inkSecondaryRgb, isSel ? 0.8 : 0.42);
        g.fillRect(xc - bw * 0.5, net >= 0 ? yMid - bh : yMid, bw, bh);
        if (i % tickStep === 0 || i === n - 1 || isSel) {
          g.font = `400 9.5px ${pal.fontMono}`;
          g.textAlign = "center";
          g.textBaseline = "top";
          g.fillStyle = isSel ? pal.inkPrimary : pal.inkTertiary;
          g.fillText(date.slice(5), xc, stripT + stripH + 4);
        }
        hitTargets.push({
          key: `strip:${date}`, roundIndex: i,
          x0: padL + i * slotW, x1: padL + (i + 1) * slotW, y0: stripT, y1: stripT + stripH,
          title: date, sub: `Click to inspect · ${mLabel}`,
          probs: entry.probs, obsIdx: entry.obsIdx, rps: entry.rps, logScore: entry.logScore,
        });
      });

      const date = data.rounds[roundIdx];
      const rec = data.byRound[date];
      const cardsY = 128, cardsH = H - cardsY - 12, gap = 22;
      const nCards = Math.max(1, hzs.length);
      const cardW = (W - padL - padR - gap * (nCards - 1)) / nCards;
      hzs.forEach((hz, hi) => {
        const entry = rec?.models?.[focusModel]?.[hz];
        const cx0 = padL + hi * (cardW + gap);
        g.font = `500 11px ${pal.fontSans}`;
        g.textAlign = "left";
        g.textBaseline = "bottom";
        g.fillStyle = pal.inkPrimary;
        g.fillText(`${hz} wk ahead · ${date}`, cx0, cardsY + 8, cardW);
        if (!entry) return;
        drawMiniHistogram(cx0, cardsY + 12, cardW, cardsH - 12, entry.probs, entry.obsIdx, {
          key: `bar:${focusModel}:${hz}`, title: mLabel, sub: `${hz} wk · ${date}`, rps: entry.rps, logScore: entry.logScore,
        }, cardW >= 120);
      });
    } else {
      const date = data.rounds[roundIdx];
      const rec = data.byRound[date];
      const padL = 124, padR = 14, padT = 26, padB = 10;
      const colGap = 18, rowGap = 14;
      const nCols = Math.max(1, hzs.length);
      const colW = (W - padL - padR - colGap * (nCols - 1)) / nCols;
      const rowH = (H - padT - padB - rowGap * Math.max(0, cmp.length - 1)) / Math.max(1, cmp.length);

      hzs.forEach((hz, hi) => {
        g.font = `500 11px ${pal.fontMono}`;
        g.textAlign = "center";
        g.textBaseline = "bottom";
        g.fillStyle = pal.inkSecondary;
        g.fillText(`${hz} wk`, padL + hi * (colW + colGap) + colW * 0.5, padT - 6);
      });
      cmp.forEach((mid, mi) => {
        const ry0 = padT + mi * (rowH + rowGap);
        const mLabel = manifest.label(mid, cmp);
        g.font = `500 11.5px ${pal.fontSans}`;
        g.textAlign = "right";
        g.textBaseline = "middle";
        g.fillStyle = mid === focusModel ? pal.inkPrimary : pal.inkSecondary;
        g.fillText(mLabel, padL - 12, ry0 + rowH * 0.5, padL - 18);
        hzs.forEach((hz, hi) => {
          const entry = rec?.models?.[mid]?.[hz];
          if (!entry) return;
          const cx0 = padL + hi * (colW + colGap);
          drawMiniHistogram(cx0, ry0, colW, rowH, entry.probs, entry.obsIdx, {
            key: `grid:${mid}:${hz}`, title: mLabel, sub: `${hz} wk · ${date}`, rps: entry.rps, logScore: entry.logScore,
          }, colW >= 140);
        });
      });
    }
  }

  function renderAll() {
    syncLine();
    renderKey();
    renderTable();
    scheduleDraw();
  }

  async function loadCurrent(force = false) {
    const s = store.get();
    const src = getSource ? getSource() : {
      targetId: s.target,
      hubId: null,
      locationId: s.location,
      dims: s.dims,
      locationName: manifest.locationById.get(s.location)?.name || s.location,
      title: manifest.targetById.get(s.target)?.label || manifest.targetById.get(s.target)?.short || s.target,
    };
    const season = manifest.seasonOf(s.date) ?? manifest.latest?.season ?? manifest.seasons.at(-1)?.id;
    titleEl.textContent = src?.title || "Rate change";

    if (!src?.targetId || !src?.locationId) {
      loadedReqKey = "";
      data = null;
      sec.classList.remove("is-loading");
      setEmpty(src === null ? "No rate-change forecasts here" : "Choose a location");
      onReady?.();
      renderAll();
      return;
    }

    const reqKey = `${src.hubId || ""}|${src.targetId}|${season}|${src.locationId}|${JSON.stringify(src.dims || {})}`;
    if (!force && reqKey === loadedReqKey && data) {
      roundIdx = nearestIndex(data.rounds, s.date);
      renderAll();
      return;
    }
    loadedReqKey = reqKey;

    const tToken = ++token;
    const placeName = src.locationName || manifest.locationById.get(src.locationId)?.name || src.locationId;
    sec.classList.add("is-loading");
    setEmpty(null);
    readout.hidden = true;
    hoverHit = null;

    try {
      const raw = await loadPmf(src.targetId, season, src.locationId, { dims: src.dims, hub: src.hubId || undefined });
      if (destroyed || tToken !== token) return;
      sec.classList.remove("is-loading");
      onReady?.();
      const norm = normalizePmfPayload(raw, manifest);
      if (!norm.rounds.length || !norm.modelIds.length) {
        data = null;
        setEmpty(`No categorical forecasts for ${placeName} in ${season}`);
        renderAll();
        return;
      }
      data = norm;
      if (shapeMode === "flow" && !data.ordinal) shapeMode = "matrix";
      defaultModel = pickInitialModel(data.modelIds);
      if (!data.modelIds.includes(focusModel)) focusModel = defaultModel;
      if (!data.horizons.includes(horizon)) horizon = data.horizons.includes(1) ? 1 : (data.horizons[0] ?? 0);
      roundIdx = nearestIndex(data.rounds, s.date);
      setEmpty(null);
      renderAll();
    } catch {
      if (destroyed || tToken !== token) return;
      loadedReqKey = "";
      sec.classList.remove("is-loading");
      onReady?.();
      data = null;
      setEmpty(`Couldn't load categorical forecasts for ${placeName}`, () => loadCurrent(true));
      renderAll();
    }
  }

  const ro = new ResizeObserver(() => scheduleDraw());
  ro.observe(fig);
  offs.push(
    store.select(["target", "location", "dims"], () => loadCurrent()),
    store.select(["date"], (s) => {
      const season = manifest.seasonOf(s.date);
      if (data && season && season !== data.season) { loadCurrent(); return; }
      if (data?.rounds?.length) { roundIdx = nearestIndex(data.rounds, s.date); renderAll(); }
    }),
    store.select(["sel"], () => {
      if (!data) return;
      const fromSel = store.get().sel.selected.find((id) => data.modelIds.includes(id));
      if (fromSel && fromSel !== focusModel) focusModel = fromSel;
      renderAll();
    }),
    onThemeChange(() => { resetColors(); renderKey(); scheduleDraw(); }),
    onDprChange(() => scheduleDraw()),
  );

  loadCurrent();

  return {
    resize: scheduleDraw,
    update: () => loadCurrent(),
    destroy() {
      destroyed = true;
      token++;
      ro.disconnect();
      offs.forEach((off) => off());
      host.replaceChildren();
    },
  };
}
