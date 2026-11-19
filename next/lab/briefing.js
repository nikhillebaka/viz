/* Tab 5: Full-Page Live Weekly Place Briefing Prototype.
 * An editorial, scannable weekly intelligence page covering everything known for one jurisdiction:
 * multi-pathogen signal cards, season wave vs prior season + fan, rate-change PMF gauge,
 * peak outlook, model consensus, weekly deltas, local model leaderboard, and peer drill-down. */
import { h, cssColor } from "../lib/dom.js";
import { pill } from "../ui/controls.js";
import { glass } from "../ui/glass.js";
import { fitCanvas, inkOn, perFrame, resetColors } from "../sections/shared.js";
import { PMF_CATEGORIES, buildBriefingForPlace } from "./fixtures.js";

const FEATURED = [
  { id: "US", label: "United States" },
  { id: "25", label: "Massachusetts" },
  { id: "provo", label: "Provo, UT (MetroCast)" },
  { id: "DE", label: "Germany (RespiCast)" },
];

const CAT_SCORE_VARS = ["--score-1", "--score-3", "--score-5", "--score-7", "--score-9"];

function parseRgb(str) {
  const m = str.match(/[\d.]+/g);
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [10, 132, 255];
}

function miniSparkSvg(wave) {
  const pts = [...wave.obs, ...wave.forecast.slice(1).map((f) => ({ w: f.w, val: f.med }))];
  const max = Math.max(1, ...pts.map((p) => p.val)) * 1.1;
  const W = 240, H = 34;
  const x = (w) => (w / 18) * W;
  const y = (v) => H - 3 - (v / max) * (H - 6);
  const obsD = wave.obs.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.w).toFixed(1)},${y(p.val).toFixed(1)}`).join(" ");
  const fD = wave.forecast.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.w).toFixed(1)},${y(p.med).toFixed(1)}`).join(" ");
  return `<svg class="br-sig-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <path d="${obsD}" fill="none" stroke="var(--ink-primary)" stroke-width="1.5" stroke-linecap="round"/>
    <path d="${fD}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="3 2" stroke-linecap="round"/>
  </svg>`;
}

export function mount(root, ctx) {
  const offs = [];
  let placeId = ctx.state.briefingPlace || ctx.state.primaryLocation || "US";
  let activeSigIdx = 0;
  let briefing = buildBriefingForPlace(placeId);
  let waveCanvas = null;
  let waveHost = null;

  const paper = h("div", { class: "lab-paper" });
  const container = h("div", { class: "br-page" });
  paper.append(container);
  root.replaceChildren(paper);

  function setPlace(id) {
    placeId = id || "US";
    activeSigIdx = 0;
    briefing = buildBriefingForPlace(placeId);
    render();
  }

  function render() {
    const isCustom = !FEATURED.some((f) => f.id === briefing.placeId);
    const switcherButtons = [
      ...FEATURED.map((f) => ({ ...f })),
      ...(isCustom ? [{ id: briefing.placeId, label: briefing.name }] : []),
    ];

    const switcherBar = h("div", { class: "br-switcher" },
      h("div", { style: { display: "flex", gap: "var(--space-6)", flexWrap: "wrap", alignItems: "center" } },
        h("span", { class: "lab-tag" }, "Featured places:"),
        ...switcherButtons.map((item) =>
          pill({
            label: item.label,
            size: "sm",
            pressed: item.id === briefing.placeId,
            onClick: () => setPlace(item.id),
          })),
      ),
      h("span", { class: "lab-tag mono" }, `${briefing.weekLabel} · Issued ${briefing.roundDate}`),
    );

    const isPrimary = ctx.state.primaryLocation === briefing.placeId;
    const masthead = h("header", { class: "br-masthead" },
      h("div", null,
        h("div", { class: "br-crumb" },
          briefing.breadcrumbs.join("  ›  "),
          "  ",
          h("span", { class: "lab-tag is-accent" }, briefing.phase),
        ),
        h("h1", { class: "br-h1" }, briefing.name),
        h("p", { class: "br-headline" }, briefing.headline),
      ),
      h("div", { class: "br-mast-actions" },
        h("button", {
          type: "button", class: "c-btn filled",
          onclick: () => { ctx.setPrimaryLocation(briefing.placeId); render(); },
        }, isPrimary ? "Primary ★" : "Pin as Primary"),
        h("button", {
          type: "button", class: "c-btn filled",
          onclick: () => ctx.focusOnGlobe(briefing.placeId),
        }, "View on Globe"),
        h("a", {
          class: "c-btn filled",
          href: `/next/#loc=${encodeURIComponent(briefing.placeId)}`,
          style: { textDecoration: "none" },
        }, "Open Chart in /next/ ↗"),
      ),
    );

    // Multi-pathogen Signal Strip
    const sigStrip = h("div", { class: "br-signals" },
      ...briefing.signals.map((sig, i) =>
        h("button", {
          type: "button",
          class: ["br-sig", i === activeSigIdx && "is-active"],
          onclick: () => { activeSigIdx = i; render(); },
        },
        h("div", { class: "br-sig-top" },
          h("span", { class: "br-sig-label" }, sig.label),
          h("span", { class: `lab-tag ${sig.deltaPct > 8 ? "is-warn" : sig.deltaPct < -5 ? "is-good" : ""}` }, sig.tier),
        ),
        h("div", { class: "br-sig-num" },
          h("strong", null, sig.value),
          h("small", null, sig.unit),
          h("span", {
            class: "mono",
            style: { marginLeft: "auto", fontSize: "var(--text-small)", color: sig.deltaPct > 8 ? "var(--status-warning)" : "var(--ink-secondary)" },
          }, `${sig.deltaPct >= 0 ? "+" : ""}${sig.deltaPct}% WoW`),
        ),
        h("div", { html: miniSparkSvg(sig.wave) }))),
    );

    // Hero Left: Canvas Season Wave + Prior Reference + Fan
    const activeSig = briefing.signals[activeSigIdx] || briefing.signals[0];
    waveCanvas = h("canvas", { class: "br-wave-canvas", "aria-label": `${activeSig.label} season trajectory and forecast fan` });
    waveHost = h("div", { class: "lab-card", style: { display: "flex", flexDirection: "column", justifyContent: "space-between" } },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--space-8)", marginBottom: "var(--space-8)", flexWrap: "wrap" } },
        h("h3", { class: "lab-card-title", style: { margin: 0 } }, `${activeSig.label} — Current Wave vs Prior Season`),
        h("span", { class: "lab-tag" }, "Observed + 50/95% ensemble horizon"),
      ),
      waveCanvas,
    );

    // Hero Right: Compact PMF Gauge + Peak Outlook + Consensus
    const catCols = CAT_SCORE_VARS.map((v) => cssColor(`var(${v})`));
    const topPmfIdx = briefing.pmfProbs.indexOf(Math.max(...briefing.pmfProbs));
    const pmfCard = h("div", { class: "lab-card" },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-8)" } },
        h("h3", { class: "lab-card-title", style: { margin: 0 } }, "1-Wk Rate Change Outlook"),
        h("span", { class: "lab-tag is-accent" }, PMF_CATEGORIES[topPmfIdx].label, ` (${Math.round(briefing.pmfProbs[topPmfIdx] * 100)}%)`),
      ),
      h("div", { style: { display: "flex", height: "24px", borderRadius: "var(--radius-tag)", overflow: "hidden" } },
        ...briefing.pmfProbs.map((p, k) =>
          h("div", {
            style: {
              width: `${(p * 100).toFixed(1)}%`,
              background: catCols[k],
              color: inkOn(catCols[k]),
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: "var(--font-mono)", fontSize: "var(--text-axis)",
            },
            title: `${PMF_CATEGORIES[k].label}: ${(p * 100).toFixed(1)}%`,
          }, p >= 0.14 ? `${Math.round(p * 100)}%` : ""))),
      h("div", { style: { display: "flex", justifyContent: "space-between", marginTop: "var(--space-6)", fontSize: "var(--text-micro)", color: "var(--ink-tertiary)" } },
        h("span", null, "Large dec"), h("span", null, "Stable"), h("span", null, "Large inc")),
    );

    const peakCard = h("div", { class: "lab-card" },
      h("h3", { class: "lab-card-title", style: { margin: 0 } }, "Season Peak Outlook"),
      h("dl", { class: "br-peak-grid" },
        h("div", null, h("dt", null, "Median peak week"), h("dd", null, briefing.peakOutlook.peakWeek)),
        h("div", null, h("dt", null, "90% timing window"), h("dd", null, briefing.peakOutlook.peakWindow)),
        h("div", null, h("dt", null, "Projected peak"), h("dd", null, `${briefing.peakOutlook.peakMedian} ${briefing.peakOutlook.unit}`)),
        h("div", null, h("dt", null, "Peak passed odds"), h("dd", null, `${briefing.peakOutlook.alreadyPassedProb}%`)),
      ),
    );

    const consensusCard = h("div", { class: "lab-card" },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
        h("h3", { class: "lab-card-title", style: { margin: 0 } }, "Inter-Model Consensus"),
        h("strong", { class: "mono", style: { fontSize: "var(--text-small)" } }, `${briefing.consensusPct}% agreement`),
      ),
      h("div", { class: "br-consensus-bar" },
        h("div", { class: "br-consensus-fill", style: { width: `${briefing.consensusPct}%` } })),
      h("p", { class: "br-delta-desc" },
        briefing.consensusPct >= 82
          ? "Core ensemble members align tightly on trajectory direction over the next 2–3 weeks."
          : "Moderate model divergence around timing of peak inflection; watch trajectory tails."),
    );

    const hero = h("div", { class: "br-hero" }, waveHost, h("div", { class: "br-side-stack" }, pmfCard, peakCard, consensusCard));

    // Weekly Deltas
    const deltas = h("div", { class: "br-deltas" },
      ...briefing.whatChanged.map((c) =>
        h("div", { class: "lab-card" },
          h("h3", { class: "lab-card-title" }, c.title),
          h("div", { class: "br-delta-val" }, c.delta),
          h("p", { class: "br-delta-desc" }, c.detail))),
    );

    // Bottom Split: Leaderboard + Clickable Peer Places
    const leaderCard = h("div", { class: "lab-card" },
      h("h3", { class: "lab-card-title" }, `Local Rolling Calibration (${briefing.abbr})`),
      h("table", { class: "v-table" },
        h("thead", null,
          h("tr", null, h("th", null, "Model"), h("th", null, "WIS"), h("th", null, "Rel WIS"), h("th", null, "95% Cov"), h("th", null, "Bias"))),
        h("tbody", null,
          ...briefing.leaderboard.map((r) =>
            h("tr", null,
              h("td", null,
                h("span", {
                  class: "v-name",
                  style: r.slot ? { "--c": `var(--series-${r.slot})` } : null,
                }, h("i"), r.model)),
              h("td", { class: "num" }, r.wis.toFixed(2)),
              h("td", { class: "num lead" }, `${r.relWis.toFixed(2)}×`),
              h("td", { class: "num" }, `${r.cov95}%`),
              h("td", { class: "num quiet" }, r.bias),
            ))),
      ),
    );

    const peersCard = h("div", { class: "lab-card" },
      h("h3", { class: "lab-card-title" }, "Jurisdiction Context & Drill-Down"),
      h("div", { class: "br-peers" },
        ...briefing.peers.map((p) =>
          h("button", {
            type: "button", class: "br-peer-btn",
            onclick: () => setPlace(p.id),
          },
          h("div", null, h("strong", null, p.name), h("span", null, p.tier)),
          h("div", { class: "br-peer-rate" }, `${p.rate}`, h("div", { style: { fontSize: "var(--text-micro)", color: "var(--ink-tertiary)" } }, `${p.deltaPct >= 0 ? "+" : ""}${p.deltaPct}%`))))),
    );

    const bottom = h("div", { class: "br-bottom" }, leaderCard, peersCard);
    container.replaceChildren(switcherBar, masthead, sigStrip, hero, deltas, bottom);

    // Apply subtle glass to switcher pills
    switcherBar.querySelectorAll(".c-pill").forEach((b) => glass(b));
    scheduleWaveDraw();
  }

  const scheduleWaveDraw = perFrame(drawWave);
  function drawWave() {
    if (!waveCanvas || !waveHost) return;
    const activeSig = briefing.signals[activeSigIdx] || briefing.signals[0];
    const wave = activeSig.wave;
    const W = waveHost.clientWidth - 40;
    const H = 290;
    if (W < 80) return;

    const g = fitCanvas(waveCanvas, W, H);
    const inkPrimary = cssColor("var(--ink-primary)");
    const inkTertiary = cssColor("var(--ink-tertiary)");
    const hairline = cssColor("var(--line-hairline)");
    const lineAxis = cssColor("var(--line-axis)");
    const priorCol = cssColor("var(--season-1)");
    const accentRgb = parseRgb(cssColor("var(--accent)"));
    const accent = `rgb(${accentRgb.join(",")})`;
    const shade = cssColor("var(--shade-forecast)");
    const fontMono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono");

    const padL = 44, padR = 16, padT = 18, padB = 30;
    const nW = 19;
    let yMax = 5;
    for (const p of wave.obs) yMax = Math.max(yMax, p.val);
    for (const p of wave.prior) yMax = Math.max(yMax, p.val);
    for (const p of wave.forecast) yMax = Math.max(yMax, p.hi95);
    yMax *= 1.1;

    const xAt = (w) => padL + (w / (nW - 1)) * (W - padL - padR);
    const yAt = (v) => (H - padB) - (v / yMax) * (H - padB - padT);

    // Forecast window shade from w=13
    const xCut = xAt(13);
    g.fillStyle = shade;
    g.fillRect(xCut, padT, W - padR - xCut, H - padB - padT);

    // Y gridlines
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
      g.fillText(val >= 10 ? String(Math.round(val)) : val.toFixed(1), padL - 8, y);
    }

    // X week labels
    g.textAlign = "center";
    g.textBaseline = "top";
    for (let w = 0; w < nW; w += 3) {
      const mmwr = ((40 + w - 1) % 52) + 1;
      g.fillStyle = inkTertiary;
      g.fillText(`W${String(mmwr).padStart(2, "0")}`, xAt(w), H - padB + 8);
    }

    // Prior season dashed wave
    g.beginPath();
    wave.prior.slice(0, nW).forEach((p, i) => {
      const x = xAt(p.w), y = yAt(p.val);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.setLineDash([4, 4]);
    g.strokeStyle = priorCol;
    g.globalAlpha = 0.72;
    g.lineWidth = 1.5;
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;

    // 95% and 50% forecast bands
    for (const [loKey, hiKey, alpha] of [["lo95", "hi95", 0.14], ["lo50", "hi50", 0.24]]) {
      g.beginPath();
      wave.forecast.forEach((p, i) => {
        const x = xAt(p.w), y = yAt(p[hiKey]);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      for (let i = wave.forecast.length - 1; i >= 0; i--) {
        g.lineTo(xAt(wave.forecast[i].w), yAt(wave.forecast[i][loKey]));
      }
      g.closePath();
      g.fillStyle = `rgba(${accentRgb.join(",")}, ${alpha})`;
      g.fill();
    }

    // Forecast median
    g.beginPath();
    wave.forecast.forEach((p, i) => {
      const x = xAt(p.w), y = yAt(p.med);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.setLineDash([5, 3]);
    g.strokeStyle = accent;
    g.lineWidth = 2.1;
    g.stroke();
    g.setLineDash([]);

    // Current season observed wave
    g.beginPath();
    wave.obs.forEach((p, i) => {
      const x = xAt(p.w), y = yAt(p.val);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.strokeStyle = inkPrimary;
    g.lineWidth = 2.2;
    g.stroke();
    for (const p of wave.obs) {
      g.beginPath();
      g.arc(xAt(p.w), yAt(p.val), 2.8, 0, Math.PI * 2);
      g.fillStyle = inkPrimary;
      g.fill();
    }
  }

  const ro = new ResizeObserver(() => scheduleWaveDraw());
  ro.observe(paper);

  offs.push(ctx.onThemeChange(() => { resetColors(); render(); }));
  render();

  return {
    setPlace,
    resize: scheduleWaveDraw,
    destroy() {
      ro.disconnect();
      offs.forEach((off) => off());
    },
  };
}
