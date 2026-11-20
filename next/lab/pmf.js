/* Tab 3: Categorical / Ordinal Rate-Change PMF (/next/ print-on-paper craft).
 * Quiet 3-way view selector in .v-line:
 *   - Matrix (default): restrained 5-row monochrome/accent ordinal probability grid (all 20 weeks or 4x4 models x horizons)
 *   - Flow: calm 2-tone figure-ground diverging stream anchored on Stable (Rising accent vs Falling slate)
 *   - Bars: unmistakable 5-bin discrete distribution histograms (shape + sharpness per horizon) */
import { h, on, cssColor } from "../lib/dom.js";
import { fragment, action, setLine, fitCanvas, perFrame, resetColors } from "../sections/shared.js";
import { buildPmfFixture, PMF_CATEGORIES, verticalPmfSegments } from "./fixtures.js";

const SHORT_BINS = ["−−", "−", "0", "+", "++"];
const SHORT_CATS = ["Large dec", "Decrease", "Stable", "Increase", "Large inc"];

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

function rgbaStr(rgb, alpha = 1) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

export function mount(root, ctx) {
  const pmf = buildPmfFixture();
  const offs = [];

  const scopePlace = ctx.state.activeScope?.id || ctx.state.defaultScope?.id;
  let placeId = pmf.places.some((p) => p?.id === scopePlace) ? scopePlace : "US";
  let shapeMode = "matrix"; // "matrix" | "flow" | "bars"
  let viewMode = "all";     // "all" (20-wk season) | "round" (4 models x 4 horizons)
  let roundIdx = 7;
  let horizon = 1;
  let focusModel = pmf.models[0].id;
  let hoverHit = null;
  let hitTargets = [];

  const paper = h("div", { class: "lab-paper" });
  const sec = h("section", { class: "v-section" });
  const line = h("div", { class: "v-line" });
  const head = h("header", { class: "v-head" }, h("h2", { class: "v-title" }, "Rate change"), line);
  const progress = h("div", { class: "v-progress", "aria-hidden": "true" });
  const body = h("div", { class: "v-body" });
  const fig = h("div", { class: "pmf-fig" });
  const canvas = h("canvas", { class: "pmf-canvas", "aria-label": "Rate change probability chart" });
  const readout = h("div", { class: "c-readout v-readout", role: "status", hidden: true });
  const keyEl = h("div", { class: "pmf-key" });
  const tableWrap = h("div", { class: "pmf-table-wrap" });

  fig.append(canvas, readout);
  body.append(fig, keyEl, tableWrap);
  sec.append(head, progress, body);
  paper.append(sec);
  root.replaceChildren(paper);

  function setPlace(id, syncScope = false) {
    if (!pmf.byPlace[id]) return false;
    placeId = id;
    if (syncScope) ctx.setActiveScope(id);
    renderAll();
    return true;
  }

  const F = {
    shape: fragment({
      label: "View", title: "PMF representation",
      items: () => [
        { value: "matrix", label: "Matrix" },
        { value: "flow", label: "Flow" },
        { value: "bars", label: "Bars" },
      ],
      value: () => shapeMode, isDefault: () => shapeMode === "matrix",
      onSelect: (v) => { shapeMode = v; renderAll(); },
    }),
    place: fragment({
      label: "Place", title: "Place",
      items: () => pmf.places.filter(Boolean).map((p) => ({ value: p.id, label: p.name })),
      value: () => placeId, isDefault: () => placeId === "US",
      onSelect: (v) => setPlace(v, true),
    }),
    mode: fragment({
      label: "Scope", title: "Round scope",
      items: () => [{ value: "all", label: "All rounds" }, { value: "round", label: "Single round" }],
      value: () => viewMode, isDefault: () => viewMode === "all",
      onSelect: (v) => { viewMode = v; renderAll(); },
    }),
    horizon: fragment({
      label: "Horizon", title: "Horizon",
      items: () => [0, 1, 2, 3].map((x) => ({ value: x, label: `${x} wk ahead` })),
      value: () => horizon, isDefault: () => horizon === 1,
      onSelect: (v) => { horizon = v; renderAll(); },
    }),
    model: fragment({
      label: "Model", title: "Model",
      items: () => pmf.models.map((m) => ({ value: m.id, label: m.name })),
      value: () => focusModel, isDefault: () => focusModel === pmf.models[0].id,
      onSelect: (v) => { focusModel = v; renderAll(); },
    }),
    round: fragment({
      label: "Round", title: "Reference round",
      items: () => pmf.rounds.map((d, i) => ({ value: i, label: d })),
      value: () => roundIdx, isDefault: () => roundIdx === 7,
      onSelect: (v) => { roundIdx = v; renderAll(); },
    }),
  };

  const prevBtn = action("‹", "Previous round", () => { roundIdx = (roundIdx - 1 + pmf.rounds.length) % pmf.rounds.length; renderAll(); });
  const nextBtn = action("›", "Next round", () => { roundIdx = (roundIdx + 1) % pmf.rounds.length; renderAll(); });

  function syncLine() {
    Object.values(F).forEach((b) => b.sync());
    const showHoriz = viewMode === "all" && shapeMode !== "bars";
    const parts = viewMode === "all"
      ? [F.shape, F.place, F.mode, showHoriz && F.horizon, F.model].filter(Boolean)
      : [F.shape, F.place, F.mode, F.round];
    setLine(line, parts);
    if (viewMode === "round") {
      F.round.before(prevBtn);
      prevBtn.classList.add("v-tight");
      F.round.after(nextBtn);
      nextBtn.classList.add("v-tight");
    }
  }

  function renderKey() {
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
        h("span", { class: "pmf-key-item" }, h("i", { style: { background: rgbaStr(accentRgb, 0.72) } }), "Rising ↑ (Increase / Large inc)"),
        h("span", { class: "pmf-key-item" }, h("i", { style: { background: "var(--fill-field)", boxShadow: "inset 0 0 0 1px var(--line-hairline)" } }), "Stable (midline)"),
        h("span", { class: "pmf-key-item" }, h("i", { style: { background: rgbaStr(inkRgb, 0.58) } }), "Falling ↓ (Decrease / Large dec)"),
        h("span", { class: "pmf-key-item" }, "● Realized"),
      );
      return;
    }
    keyEl.replaceChildren(
      h("span", { class: "pmf-key-item" }, h("i", { style: { background: "var(--accent)" } }), "Realized category bin"),
      h("span", { class: "pmf-key-item" }, h("i", { style: { background: "var(--ink-tertiary)" } }), "Other bins (−− − 0 + ++)"),
      h("span", { class: "pmf-key-item" }, "Dashed rule = 50%"),
    );
  }

  function renderTable() {
    const placeData = pmf.byPlace[placeId];
    if (!placeData) return;
    const activeDates = viewMode === "all" ? pmf.rounds : [pmf.rounds[roundIdx]];
    const targetHzs = viewMode === "all" && shapeMode !== "bars" ? [horizon] : [0, 1, 2, 3];

    const rows = pmf.models.map((m, mIdx) => {
      let n = 0, rps = 0, logS = 0, brier = 0, hits = 0;
      for (const d of activeDates) {
        const rec = placeData.rounds[d];
        if (!rec || rec.observedCategory == null) continue;
        for (const hIdx of targetHzs) {
          const entry = rec.models[m.id]?.[hIdx];
          if (!entry || !Number.isFinite(entry.rps)) continue;
          rps += entry.rps;
          logS += entry.logScore;
          brier += entry.brier;
          const modeIdx = entry.probs.indexOf(Math.max(...entry.probs));
          if (modeIdx === rec.observedCategory) hits++;
          n++;
        }
      }
      return {
        model: m,
        slot: mIdx + 1,
        rps: n ? rps / n : NaN,
        logS: n ? logS / n : NaN,
        brier: n ? brier / n : NaN,
        hitPct: n ? Math.round((hits / n) * 100) : NaN,
      };
    });

    tableWrap.replaceChildren(
      h("table", { class: "v-table" },
        h("thead", null,
          h("tr", null,
            h("th", null, viewMode === "all" ? `Model (${pmf.rounds.length} rounds)` : `Model (${pmf.rounds[roundIdx]} · 0–3 wk)`),
            h("th", null, "RPS"),
            h("th", null, "Log score"),
            h("th", null, "Brier"),
            h("th", null, "Mode hit"),
          )),
        h("tbody", null,
          ...rows.map((r) =>
            h("tr", {
              "data-model": r.model.id,
              class: r.model.id === focusModel && viewMode === "all" ? "is-focus" : null,
              onclick: () => {
                focusModel = r.model.id;
                if (viewMode === "round") viewMode = "all";
                renderAll();
              },
            },
            h("td", null, h("span", { class: "v-name", style: { "--c": `var(--series-${r.slot})` } }, h("i"), r.model.name)),
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
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hit = findHit(sx, sy);
    if (hit) {
      hoverHit = hit;
      readout.replaceChildren(
        h("div", { class: "c-readout-head" },
          h("span", { style: { fontWeight: "600", color: "var(--ink-primary)" } }, hit.title),
          h("span", { class: "quiet" }, hit.sub),
        ),
        h("table", null,
          h("tbody", null,
            ...[4, 3, 2, 1, 0].map((k) =>
              h("tr", null,
                h("td", { class: "c-readout-name" },
                  hit.obsIdx === k ? h("strong", { style: { color: "var(--accent)" } }, `${PMF_CATEGORIES[k].label} ●`) : PMF_CATEGORIES[k].label),
                h("td", { class: "num" }, `${(hit.probs[k] * 100).toFixed(1)}%`),
              )),
          ),
        ),
        Number.isFinite(hit.rps) ? h("div", { class: "c-readout-foot" },
          h("span", null, `RPS ${hit.rps.toFixed(3)}`),
          h("span", null, `Log ${hit.logScore.toFixed(2)}`),
        ) : null,
      );
      readout.hidden = false;
      const rx = Math.min(Math.max(8, sx + 14), Math.max(8, rect.width - 235));
      const ry = Math.min(Math.max(8, sy - 16), Math.max(8, rect.height - 145));
      readout.style.transform = `translate(${rx}px, ${ry}px)`;
    } else if (hoverHit) {
      hoverHit = null;
      readout.hidden = true;
    }
    scheduleDraw();
  }));

  offs.push(on(canvas, "pointerleave", () => {
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

  /* ---------------- Shared Canvas Drawing ---------------- */
  const scheduleDraw = perFrame(draw);
  function draw() {
    const W = fig.clientWidth;
    if (W < 60) return;
    const isBarsSingle = shapeMode === "bars" && viewMode === "round";
    const H = isBarsSingle ? 380 : shapeMode === "bars" ? 310 : shapeMode === "matrix" ? (viewMode === "round" ? 260 : 280) : 300;
    const g = fitCanvas(canvas, W, H);
    const placeData = pmf.byPlace[placeId];
    if (!placeData) return;

    const isLight = document.documentElement.dataset.theme === "light";
    const paperRgb = parseRgb(cssColor("var(--surface-paper)"), isLight ? [250, 250, 251] : [11, 11, 11]);
    const accentRgb = parseRgb(cssColor("var(--accent)"), [10, 132, 255]);
    const inkPrimaryRgb = parseRgb(cssColor("var(--ink-primary)"), isLight ? [17, 18, 22] : [238, 240, 244]);
    const inkSecondaryRgb = parseRgb(cssColor("var(--ink-secondary)"), [130, 134, 144]);
    const inkPrimary = cssColor("var(--ink-primary)");
    const inkSecondary = cssColor("var(--ink-secondary)");
    const inkTertiary = cssColor("var(--ink-tertiary)");
    const accent = cssColor("var(--accent)");
    const lineAxis = cssColor("var(--line-axis)");
    const hairline = cssColor("var(--line-hairline)");
    const surfPaper = cssColor("var(--surface-paper)");
    const fontMono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono");
    const fontSans = getComputedStyle(document.documentElement).getPropertyValue("--font-sans");

    hitTargets = [];

    if (shapeMode === "matrix") {
      drawMatrix(g, W, H, placeData, {
        isLight, paperRgb, accentRgb, inkPrimaryRgb, inkPrimary, inkSecondary, inkTertiary,
        hairline, surfPaper, fontMono, fontSans,
      });
    } else if (shapeMode === "flow") {
      drawFlow(g, W, H, placeData, {
        isLight, paperRgb, accentRgb, inkPrimaryRgb, inkSecondaryRgb, inkPrimary, inkSecondary,
        inkTertiary, accent, lineAxis, hairline, surfPaper, fontMono, fontSans,
      });
    } else {
      drawBars(g, W, H, placeData, {
        isLight, paperRgb, accentRgb, inkPrimaryRgb, inkSecondaryRgb, inkPrimary, inkSecondary,
        inkTertiary, accent, lineAxis, hairline, surfPaper, fontMono, fontSans,
      });
    }
  }

  /* 1. MATRIX: Clean 5-row probability grid (single restrained ramp, zero rainbow chaos) */
  function drawMatrix(g, W, H, placeData, pal) {
    const padL = 78, padR = 14, padT = 26, padB = 30;
    const peakRgb = mixRgb(pal.accentRgb, pal.inkPrimaryRgb, pal.isLight ? 0.14 : 0.04);

    // Row labels top-to-bottom: Large inc (4) down to Large dec (0)
    const rowOrder = [4, 3, 2, 1, 0];
    const gridH = H - padT - padB;
    const rowH = gridH / 5;

    g.font = `400 10.5px ${pal.fontSans}`;
    g.textAlign = "right";
    g.textBaseline = "middle";
    rowOrder.forEach((cat, rIdx) => {
      g.fillStyle = cat === 2 ? pal.inkPrimary : pal.inkSecondary;
      g.fillText(SHORT_CATS[cat], padL - 10, padT + (rIdx + 0.5) * rowH);
    });

    const paintCell = (x, y, w, hCell, p, isObs, isHovCol) => {
      const gap = w >= 24 ? 2 : 1.5;
      const cx = x + gap * 0.5;
      const cy = y + gap * 0.5;
      const cw = Math.max(2, w - gap);
      const ch = Math.max(4, hCell - gap);
      const t = Math.pow(Math.max(0, Math.min(1, p)), 0.78);
      const fill = mixRgb(pal.paperRgb, peakRgb, t);
      g.fillStyle = rgbaStr(fill, 1);
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
      const n = pmf.rounds.length;
      const colW = (W - padL - padR) / n;
      pmf.rounds.forEach((date, i) => {
        const rec = placeData.rounds[date];
        const entry = rec?.models?.[focusModel]?.[horizon];
        if (!entry) return;
        const x0 = padL + i * colW;
        const key = date;
        const isHov = hoverHit?.key === key;
        rowOrder.forEach((cat, rIdx) => {
          paintCell(x0, padT + rIdx * rowH, colW, rowH, entry.probs[cat], rec.observedCategory === cat, isHov);
        });
        if (i % 3 === 0 || i === n - 1) {
          g.font = `400 10.5px ${pal.fontMono}`;
          g.textAlign = "center";
          g.textBaseline = "top";
          g.fillStyle = i === roundIdx ? pal.inkPrimary : pal.inkTertiary;
          g.fillText(date.slice(5), x0 + colW * 0.5, H - padB + 8);
        }
        hitTargets.push({
          key, roundIndex: i, x0, x1: x0 + colW, y0: padT, y1: padT + gridH,
          title: date, sub: `${horizon} wk · ${focusModel}`,
          probs: entry.probs, obsIdx: rec.observedCategory, rps: entry.rps, logScore: entry.logScore,
        });
      });
    } else {
      const date = pmf.rounds[roundIdx];
      const rec = placeData.rounds[date];
      const mCount = pmf.models.length;
      const groupGap = 16;
      const groupW = (W - padL - padR - groupGap * (mCount - 1)) / mCount;
      const colW = groupW / 4;

      pmf.models.forEach((m, mi) => {
        const gx0 = padL + mi * (groupW + groupGap);
        g.font = `500 11px ${pal.fontSans}`;
        g.textAlign = "center";
        g.textBaseline = "bottom";
        g.fillStyle = pal.inkPrimary;
        g.fillText(m.name, gx0 + groupW * 0.5, padT - 7);

        [0, 1, 2, 3].forEach((hz, hi) => {
          const entry = rec?.models?.[m.id]?.[hz];
          if (!entry) return;
          const x0 = gx0 + hi * colW;
          const key = `${m.id}:${hz}`;
          const isHov = hoverHit?.key === key;
          rowOrder.forEach((cat, rIdx) => {
            paintCell(x0, padT + rIdx * rowH, colW, rowH, entry.probs[cat], rec.observedCategory === cat, isHov);
          });
          g.font = `400 10px ${pal.fontMono}`;
          g.textAlign = "center";
          g.textBaseline = "top";
          g.fillStyle = pal.inkTertiary;
          g.fillText(`${hz}w`, x0 + colW * 0.5, H - padB + 8);

          hitTargets.push({
            key, x0, x1: x0 + colW, y0: padT, y1: padT + gridH,
            title: m.name, sub: `${hz} wk · ${date}`,
            probs: entry.probs, obsIdx: rec.observedCategory, rps: entry.rps, logScore: entry.logScore,
          });
        });
      });
    }
  }

  /* 2. FLOW: Calm 2-Tone Figure-Ground Stream anchored at Stable midline */
  function drawFlow(g, W, H, placeData, pal) {
    const padL = 56, padR = 14, padT = 22, padB = 32;
    const plotH = H - padT - padB;
    const yZero = padT + plotH * 0.5;
    const halfH = plotH * 0.48;
    const yAt = (val) => yZero - val * halfH;

    // 5 ordered tones collapsing into Rising (accent), Neutral Stable (barely there), Falling (slate)
    const segFill = [
      rgbaStr(pal.inkSecondaryRgb, pal.isLight ? 0.65 : 0.55), // 0 Large dec
      rgbaStr(pal.inkSecondaryRgb, pal.isLight ? 0.34 : 0.30), // 1 Decrease
      rgbaStr(pal.inkPrimaryRgb, pal.isLight ? 0.06 : 0.08),   // 2 Stable (quiet)
      rgbaStr(pal.accentRgb, 0.36),                            // 3 Increase
      rgbaStr(pal.accentRgb, 0.78),                            // 4 Large inc
    ];

    // Grid lines
    g.font = `400 10.5px ${pal.fontMono}`;
    g.textAlign = "right";
    g.textBaseline = "middle";
    for (const [val, lbl] of [[0.5, "+50%"], [0, "Stable"], [-0.5, "−50%"]]) {
      const y = yAt(val);
      g.beginPath();
      g.moveTo(padL, y);
      g.lineTo(W - padR, y);
      g.strokeStyle = val === 0 ? pal.lineAxis : pal.hairline;
      g.lineWidth = val === 0 ? 1.2 : 1;
      g.stroke();
      g.fillStyle = val === 0 ? pal.inkSecondary : pal.inkTertiary;
      g.fillText(lbl, padL - 8, y);
    }

    if (viewMode === "all") {
      const n = pmf.rounds.length;
      const slotW = (W - padL - padR) / n;
      const series = pmf.rounds.map((date, i) => {
        const rec = placeData.rounds[date];
        const entry = rec?.models?.[focusModel]?.[horizon];
        const segs = entry ? verticalPmfSegments(entry.probs) : null;
        return { date, i, x: padL + (i + 0.5) * slotW, rec, entry, segs };
      }).filter((d) => d.entry);

      // Draw each of the 5 ordered bands continuously across rounds
      for (let cat = 0; cat < 5; cat++) {
        g.beginPath();
        series.forEach((pt, idx) => {
          const y = yAt(pt.segs[cat].y1);
          if (idx === 0) g.moveTo(pt.x, y); else g.lineTo(pt.x, y);
        });
        for (let idx = series.length - 1; idx >= 0; idx--) {
          const pt = series[idx];
          g.lineTo(pt.x, yAt(pt.segs[cat].y0));
        }
        g.closePath();
        g.fillStyle = segFill[cat];
        g.fill();
      }

      // Hover rule & Realized outcome curve
      if (hoverHit?.x0 != null && hoverHit.roundIndex != null) {
        const xc = padL + (hoverHit.roundIndex + 0.5) * slotW;
        g.fillStyle = cssColor("var(--fill-hover)");
        g.fillRect(xc - slotW * 0.5, padT, slotW, plotH);
      }

      g.beginPath();
      let started = false;
      series.forEach((pt) => {
        if (pt.rec.observedCategory == null) return;
        const s = pt.segs[pt.rec.observedCategory];
        const my = yAt((s.y0 + s.y1) * 0.5);
        if (!started) { g.moveTo(pt.x, my); started = true; } else g.lineTo(pt.x, my);
      });
      g.strokeStyle = rgbaStr(pal.inkPrimaryRgb, 0.35);
      g.lineWidth = 1.25;
      g.setLineDash([3, 3]);
      g.stroke();
      g.setLineDash([]);

      series.forEach((pt) => {
        if (pt.rec.observedCategory != null) {
          const s = pt.segs[pt.rec.observedCategory];
          const my = yAt((s.y0 + s.y1) * 0.5);
          g.beginPath();
          g.arc(pt.x, my, 3.6, 0, Math.PI * 2);
          g.fillStyle = pal.inkPrimary;
          g.fill();
          g.strokeStyle = pal.surfPaper;
          g.lineWidth = 1.4;
          g.stroke();
        }
        if (pt.i % 3 === 0 || pt.i === n - 1) {
          g.font = `400 10.5px ${pal.fontMono}`;
          g.textAlign = "center";
          g.textBaseline = "top";
          g.fillStyle = pt.i === roundIdx ? pal.inkPrimary : pal.inkTertiary;
          g.fillText(pt.date.slice(5), pt.x, H - padB + 10);
        }
        const x0 = padL + pt.i * slotW;
        hitTargets.push({
          key: pt.date, roundIndex: pt.i, x0, x1: x0 + slotW, y0: padT, y1: padT + plotH,
          title: pt.date, sub: `${horizon} wk · ${focusModel}`,
          probs: pt.entry.probs, obsIdx: pt.rec.observedCategory, rps: pt.entry.rps, logScore: pt.entry.logScore,
        });
      });
    } else {
      const date = pmf.rounds[roundIdx];
      const rec = placeData.rounds[date];
      const mCount = pmf.models.length;
      const groupW = (W - padL - padR) / mCount;
      const colSlot = (groupW - 18) / 4;
      const colW = Math.max(8, Math.min(28, colSlot * 0.72));

      pmf.models.forEach((m, mi) => {
        const gx0 = padL + mi * groupW + 9;
        [0, 1, 2, 3].forEach((hz, hi) => {
          const entry = rec?.models?.[m.id]?.[hz];
          if (!entry) return;
          const xc = gx0 + (hi + 0.5) * colSlot;
          const xLeft = xc - colW * 0.5;
          const key = `${m.id}:${hz}`;
          if (hoverHit?.key === key) {
            g.fillStyle = cssColor("var(--fill-hover)");
            g.fillRect(xLeft - 2, padT, colW + 4, plotH);
          }
          const segs = verticalPmfSegments(entry.probs);
          segs.forEach((s) => {
            const yTop = yAt(s.y1);
            const yBot = yAt(s.y0);
            g.fillStyle = segFill[s.cat];
            g.fillRect(xLeft, yTop, colW, Math.max(0.5, yBot - yTop));
          });
          if (rec.observedCategory != null) {
            const obsSeg = segs[rec.observedCategory];
            g.beginPath();
            g.arc(xc, yAt((obsSeg.y0 + obsSeg.y1) * 0.5), 3.6, 0, Math.PI * 2);
            g.fillStyle = pal.inkPrimary;
            g.fill();
            g.strokeStyle = pal.surfPaper;
            g.lineWidth = 1.4;
            g.stroke();
          }
          g.font = `400 10px ${pal.fontMono}`;
          g.textAlign = "center";
          g.textBaseline = "top";
          g.fillStyle = pal.inkTertiary;
          g.fillText(`${hz}w`, xc, yZero + halfH + 4);
          hitTargets.push({
            key, x0: xc - colSlot * 0.5, x1: xc + colSlot * 0.5, y0: padT, y1: padT + plotH,
            title: m.name, sub: `${hz} wk · ${date}`,
            probs: entry.probs, obsIdx: rec.observedCategory, rps: entry.rps, logScore: entry.logScore,
          });
        });
        g.font = `500 11px ${pal.fontSans}`;
        g.textAlign = "center";
        g.textBaseline = "top";
        g.fillStyle = pal.inkSecondary;
        g.fillText(m.name, padL + (mi + 0.5) * groupW, H - padB + 14);
      });
    }
  }

  /* 3. BARS: Classic Unmistakable 5-Bin Discrete Histograms */
  function drawBars(g, W, H, placeData, pal) {
    const drawMiniHistogram = (x, y, w, hBox, probs, obsIdx, meta, showPctLabels) => {
      const innerPadT = 14;
      const innerPadB = 16;
      const chartH = Math.max(24, hBox - innerPadT - innerPadB);
      const baseY = y + innerPadT + chartH;
      const midY = y + innerPadT + chartH * 0.5;
      const slotW = w / 5;
      const barW = Math.max(6, Math.min(26, slotW * 0.62));
      const isHov = hoverHit?.key === meta.key;

      if (isHov) {
        g.fillStyle = cssColor("var(--fill-hover)");
        g.fillRect(x - 2, y, w + 4, hBox);
      }

      // 50% dotted guide + baseline
      g.beginPath();
      g.moveTo(x, midY);
      g.lineTo(x + w, midY);
      g.strokeStyle = pal.hairline;
      g.lineWidth = 1;
      g.setLineDash([2, 3]);
      g.stroke();
      g.setLineDash([]);

      g.beginPath();
      g.moveTo(x, baseY);
      g.lineTo(x + w, baseY);
      g.strokeStyle = pal.lineAxis;
      g.lineWidth = 1;
      g.stroke();

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
        g.fillText(SHORT_BINS[cat], bx + barW * 0.5, baseY + 4);
      });

      hitTargets.push({ ...meta, x0: x, x1: x + w, y0: y, y1: y + hBox, probs, obsIdx });
    };

    if (viewMode === "all") {
      // Top weekly net-direction strip (click any week) + bottom 4-horizon 5-bin histograms
      const stripT = 16, stripH = 74;
      const padL = 56, padR = 16;
      const n = pmf.rounds.length;
      const slotW = (W - padL - padR) / n;
      const yMid = stripT + stripH * 0.5;

      g.font = `400 10px ${pal.fontSans}`;
      g.textAlign = "right";
      g.textBaseline = "middle";
      g.fillStyle = pal.inkTertiary;
      g.fillText("Net ±", padL - 10, yMid);

      g.beginPath();
      g.moveTo(padL, yMid);
      g.lineTo(W - padR, yMid);
      g.strokeStyle = pal.hairline;
      g.lineWidth = 1;
      g.stroke();

      pmf.rounds.forEach((date, i) => {
        const rec = placeData.rounds[date];
        const entry = rec?.models?.[focusModel]?.[horizon];
        if (!entry) return;
        const net = (entry.probs[3] + entry.probs[4]) - (entry.probs[0] + entry.probs[1]);
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
        if (i % 4 === 0 || i === n - 1 || isSel) {
          g.font = `400 9.5px ${pal.fontMono}`;
          g.textAlign = "center";
          g.textBaseline = "top";
          g.fillStyle = isSel ? pal.inkPrimary : pal.inkTertiary;
          g.fillText(date.slice(5), xc, stripT + stripH + 4);
        }
        hitTargets.push({
          key: `strip:${date}`, roundIndex: i,
          x0: padL + i * slotW, x1: padL + (i + 1) * slotW, y0: stripT, y1: stripT + stripH,
          title: date, sub: `Click to inspect · ${focusModel}`,
          probs: entry.probs, obsIdx: rec.observedCategory, rps: entry.rps, logScore: entry.logScore,
        });
      });

      const date = pmf.rounds[roundIdx];
      const rec = placeData.rounds[date];
      const cardsY = 128;
      const cardsH = H - cardsY - 12;
      const gap = 22;
      const cardW = (W - padL - padR - gap * 3) / 4;

      [0, 1, 2, 3].forEach((hz, hi) => {
        const entry = rec?.models?.[focusModel]?.[hz];
        if (!entry) return;
        const cx0 = padL + hi * (cardW + gap);
        g.font = `500 11px ${pal.fontSans}`;
        g.textAlign = "left";
        g.textBaseline = "bottom";
        g.fillStyle = pal.inkPrimary;
        g.fillText(`${hz} wk ahead · ${date}`, cx0, cardsY + 8);
        drawMiniHistogram(cx0, cardsY + 12, cardW, cardsH - 12, entry.probs, rec.observedCategory, {
          key: `bar:${focusModel}:${hz}`,
          title: focusModel,
          sub: `${hz} wk · ${date}`,
          rps: entry.rps,
          logScore: entry.logScore,
        }, cardW >= 120);
      });
    } else {
      // Single round: clean 4 models (rows) x 4 horizons (columns) grid
      const date = pmf.rounds[roundIdx];
      const rec = placeData.rounds[date];
      const padL = 112, padR = 14, padT = 26, padB = 10;
      const colGap = 18, rowGap = 14;
      const colW = (W - padL - padR - colGap * 3) / 4;
      const rowH = (H - padT - padB - rowGap * (pmf.models.length - 1)) / pmf.models.length;

      [0, 1, 2, 3].forEach((hz, hi) => {
        g.font = `500 11px ${pal.fontMono}`;
        g.textAlign = "center";
        g.textBaseline = "bottom";
        g.fillStyle = pal.inkSecondary;
        g.fillText(`${hz} wk`, padL + hi * (colW + colGap) + colW * 0.5, padT - 6);
      });

      pmf.models.forEach((m, mi) => {
        const ry0 = padT + mi * (rowH + rowGap);
        g.font = `500 11.5px ${pal.fontSans}`;
        g.textAlign = "right";
        g.textBaseline = "middle";
        g.fillStyle = m.id === focusModel ? pal.inkPrimary : pal.inkSecondary;
        g.fillText(m.name, padL - 12, ry0 + rowH * 0.5);

        [0, 1, 2, 3].forEach((hz, hi) => {
          const entry = rec?.models?.[m.id]?.[hz];
          if (!entry) return;
          const cx0 = padL + hi * (colW + colGap);
          drawMiniHistogram(cx0, ry0, colW, rowH, entry.probs, rec.observedCategory, {
            key: `grid:${m.id}:${hz}`,
            title: m.name,
            sub: `${hz} wk · ${date}`,
            rps: entry.rps,
            logScore: entry.logScore,
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

  const ro = new ResizeObserver(() => scheduleDraw());
  ro.observe(fig);
  offs.push(ctx.onThemeChange(() => { resetColors(); renderKey(); scheduleDraw(); }));
  renderAll();

  return {
    setPlace(id) { return setPlace(id, false); },
    resize: scheduleDraw,
    destroy() {
      ro.disconnect();
      offs.forEach((off) => off());
    },
  };
}
