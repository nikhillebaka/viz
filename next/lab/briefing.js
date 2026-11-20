/* Tab 5: Full-Page Editorial Place Briefing (/next/ print-on-paper design grammar).
 * Rebuilt from first principles with zero rounded boxes, zero pill clutter, and full multi-source coverage:
 * NHSN, NSSP, ILINet, NWSS, NREVSS, CDC CFA Rt, FluSurv-NET, Nextstrain, FluSight/MetroCast
 * (and European ERVISS / RespiCast / EuroMOMO / ECDC equivalents for European jurisdictions). */
import { h, cssColor } from "../lib/dom.js";
import { fragment, action, setLine, fitCanvas, perFrame, resetColors } from "../sections/shared.js";
import { EU_META, US_STATE_META } from "../geo/eu_tiles.js";
import { PMF_CATEGORIES, buildBriefingForPlace, verticalPmfSegments } from "./fixtures.js";

const CAT_SCORE_VARS = ["--score-1", "--score-3", "--score-5", "--score-7", "--score-9"];

function parseRgb(str) {
  const m = str.match(/[\d.]+/g);
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [10, 132, 255];
}

function inlineSparkSvg(vals) {
  if (!vals?.length) return "";
  const min = Math.min(...vals);
  const max = Math.max(...vals, min + 0.1);
  const W = 88, H = 22;
  const pts = vals.map((v, i) => {
    const x = (i / Math.max(1, vals.length - 1)) * (W - 4) + 2;
    const y = H - 3 - ((v - min) / (max - min)) * (H - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg class="br-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="var(--ink-primary)" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

export function mount(root, ctx) {
  const offs = [];
  let placeId = ctx.state.briefingPlace || (ctx.state.activeScope?.focusPlace || (ctx.state.activeScope?.kind !== "hub" && ctx.state.activeScope?.kind !== "region" ? ctx.state.activeScope?.id : null)) || "US";
  let hsasList = ctx.state.hsas?.hsas || [];
  let streamIdx = 0;
  let showPriors = true;
  let showSources = false;
  let briefing = buildBriefingForPlace(placeId, ctx.resolvePlace(placeId), hsasList);

  let waveCanvas = null, waveHost = null;
  let pmfCanvas = null, pmfHost = null;
  let viroCanvas = null, viroHost = null;
  let cladeCanvas = null, cladeHost = null;

  const paper = h("div", { class: "lab-paper" });
  root.replaceChildren(paper);

  function setPlace(id, syncScope = false) {
    placeId = id || "US";
    streamIdx = 0;
    const meta = ctx.resolvePlace(placeId);
    briefing = buildBriefingForPlace(placeId, meta, hsasList);
    if (syncScope) ctx.setActiveScope(meta || placeId);
    render();
  }

  function placeMenuChoices() {
    const curMeta = ctx.resolvePlace(briefing.placeId);
    let combined;
    if (curMeta?.stateFips) {
      const peers = hsasList.filter((m) => m.stateFips === curMeta.stateFips).map((m) => ({ value: m.id, label: m.name }));
      const stMeta = US_STATE_META[curMeta.stateFips];
      combined = [...peers, ...(stMeta ? [{ value: stMeta.id, label: stMeta.name }] : []), { value: "US", label: "United States" }];
    } else if (EU_META[briefing.placeId]) {
      combined = ["DE", "FR", "GB", "ES", "IT", "NL", "SE", "PL"]
        .filter((id) => EU_META[id])
        .map((id) => ({ value: id, label: EU_META[id].name }));
    } else {
      combined = [
        { value: "US", label: "United States" },
        { value: "25", label: "Massachusetts" },
        { value: "06", label: "California" },
        { value: "48", label: "Texas" },
        { value: "36", label: "New York" },
        { value: "13", label: "Georgia" },
      ];
    }
    if (!combined.some((x) => x.value === briefing.placeId)) {
      combined.unshift({ value: briefing.placeId, label: briefing.name });
    }
    return combined;
  }

  function render() {
    const activeStream = briefing.streams[streamIdx] || briefing.streams[0];
    const isDef = ctx.state.defaultScope?.id === briefing.placeId;

    // 1. Editorial Masthead (zero pills)
    const placeFrag = fragment({
      label: "Switch place", title: "Place",
      items: placeMenuChoices,
      value: () => briefing.placeId, isDefault: () => briefing.placeId === "US",
      onSelect: (v) => setPlace(v, true),
    });
    placeFrag.classList.add("br-title-btn");

    const masthead = h("header", { class: "br-head" },
      h("div", null,
        h("p", { class: "br-crumb" }, `${briefing.breadcrumbs.join(" · ")} · ${briefing.weekLabel} (${briefing.roundDate})`),
        h("div", { class: "br-title-row" },
          h("h1", { class: "br-title" }, placeFrag),
        ),
      ),
      h("div", { class: "br-acts" },
        h("button", {
          type: "button", class: "v-frag",
          onclick: () => {
            const m = ctx.resolvePlace(briefing.placeId);
            ctx.setDefaultScope({ kind: m?.stateFips ? "metro" : m?.level || "place", id: briefing.placeId, label: briefing.name, lon: m?.lon, lat: m?.lat });
            render();
          },
        }, isDef ? "Default scope" : "Set default"),
        h("span", { class: "v-sep" }, "·"),
        h("button", { type: "button", class: "v-frag", onclick: () => ctx.focusOnGlobe(briefing.placeId) }, "Globe"),
        h("span", { class: "v-sep" }, "·"),
        h("a", { class: "v-frag", style: { textDecoration: "none" }, href: `/next/#loc=${encodeURIComponent(briefing.placeId)}` }, "Chart ↗"),
      ),
    );

    // 2. Headline KPIs (.ms-num-row straight on paper)
    const kpiStrip = h("div", { class: "br-kpis" },
      h("div", { class: "ms-num-row" },
        ...briefing.kpis.map((item) =>
          h("div", { class: "ms-num" },
            h("span", { class: "ms-num-k" }, item.k),
            h("span", { class: "ms-num-v mono" }, item.v),
            h("span", { class: "ms-num-s" }, item.s),
          )),
      ),
    );

    // 3. Section 1: Burden over time (stream selector via plain text .v-frag + borderless wave canvas + peak outlook)
    const s1Line = h("div", { class: "v-line" });
    const streamFrags = briefing.streams.map((st, idx) =>
      h("button", {
        type: "button",
        class: ["v-frag", idx === streamIdx && "is-set"],
        "aria-pressed": String(idx === streamIdx),
        onclick: () => { streamIdx = idx; render(); },
      }, st.label));
    const priorToggle = action(showPriors ? "Prior seasons on" : "Prior seasons off", "Toggle prior seasons", () => {
      showPriors = !showPriors;
      render();
    });
    if (showPriors) priorToggle.classList.add("is-set");
    setLine(s1Line, [...streamFrags, priorToggle]);

    waveCanvas = h("canvas", { class: "br-wave-canvas", "aria-label": `${activeStream.label} curve` });
    waveHost = h("div", { class: "br-wave-wrap" },
      waveCanvas,
      h("div", { class: "br-legend" },
        h("span", { class: "br-legend-item" }, h("i", { style: { background: "var(--ink-primary)" } }), "Current observed"),
        activeStream.wave.forecast.length ? h("span", { class: "br-legend-item" }, h("i", { style: { background: "var(--accent)" } }), "Ensemble 50/95%") : null,
        ...(showPriors ? activeStream.wave.priors.map((pr, i) =>
          h("span", { class: "br-legend-item" }, h("i", { style: { background: `var(--season-${i + 1})` } }), pr.season)) : []),
      ),
    );

    pmfCanvas = h("canvas", { class: "br-pmf-canvas", "aria-label": "1-week rate change odds" });
    pmfHost = h("div", null,
      h("h3", { class: "sc-block-title" }, "1-wk rate change"),
      pmfCanvas,
      h("h3", { class: "sc-block-title", style: { marginTop: "var(--space-16)" } }, "Season peak outlook"),
      h("dl", { class: "ms-dl" },
        h("dt", null, "Median week"), h("dd", { class: "mono" }, briefing.peakOutlook.peakWeek),
        h("dt", null, "90% window"), h("dd", { class: "mono" }, briefing.peakOutlook.peakWindow),
        h("dt", null, "Projected peak"), h("dd", { class: "mono" }, briefing.peakOutlook.peakMedian),
        h("dt", null, "Peak passed"), h("dd", { class: "mono" }, `${briefing.peakOutlook.alreadyPassedProb}%`),
      ),
    );

    const sec1 = h("section", { class: "v-section" },
      h("header", { class: "v-head" }, h("h2", { class: "v-title" }, "Burden over time"), s1Line),
      h("div", { class: "v-body br-split" }, waveHost, pmfHost),
    );

    // 4. Section 2: Spread table (US metros / peer states / EU countries)
    const spreadTitle = briefing.isEU ? "Where it is spreading · Europe" : briefing.spread.some((r) => ctx.resolvePlace(r.id)?.stateFips) ? "Where it is spreading · MetroCast & State" : "Where it is spreading";
    const sec2 = h("section", { class: "v-section" },
      h("header", { class: "v-head" },
        h("h2", { class: "v-title" }, spreadTitle),
        h("div", { class: "v-line" }, h("span", { class: "v-sep" }, "Rt > 1 growing · Click place to inspect")),
      ),
      h("div", { class: "v-body br-table-scroll" },
        h("table", { class: "v-table" },
          h("thead", null,
            h("tr", null,
              h("th", null, "Place"),
              h("th", null, briefing.isEU ? "ILI / 100k" : "Admits / 100k"),
              h("th", null, "Wk Δ"),
              h("th", null, briefing.isEU ? "ARI / 100k" : "ED %"),
              h("th", null, "Last 10 wks"),
              h("th", null, "Rt"),
            )),
          h("tbody", null,
            ...briefing.spread.map((row) =>
              h("tr", null,
                h("td", null,
                  h("button", { type: "button", class: "lab-plain-btn", style: { color: "var(--ink-primary)" }, onclick: () => setPlace(row.id) }, row.name)),
                h("td", { class: "num" }, String(row.rate)),
                h("td", { class: "num", style: { color: row.wkChangePct > 8 ? "var(--status-warning)" : row.wkChangePct < -8 ? "var(--status-good)" : "var(--ink-primary)" } }, `${row.wkChangePct >= 0 ? "+" : ""}${row.wkChangePct}%`),
                h("td", { class: "num" }, briefing.isEU ? String(row.edPct) : `${row.edPct}%`),
                h("td", null, h("span", { html: inlineSparkSvg(row.spark10w) })),
                h("td", { class: "num" },
                  h("span", { class: "sc-cov-cell" },
                    h("i", { class: "sc-mark", style: { "--c": row.rt > 1.03 ? "var(--score-8)" : row.rt < 0.97 ? "var(--score-2)" : "var(--ink-faint)" } }),
                    row.rt.toFixed(2),
                  )),
              ))),
        ),
      ),
    );

    // 5. Section 3: Virology, Variants & Vaccine Match
    viroCanvas = h("canvas", { class: "br-viro-canvas", "aria-label": "Weekly influenza subtype distribution and test positivity" });
    viroHost = h("div", null,
      h("h3", { class: "sc-block-title" }, briefing.isEU ? "Sentinel subtype shares & % positive" : "Public health & clinical labs (FluView / NREVSS)"),
      viroCanvas,
      h("div", { class: "br-legend" },
        h("span", { class: "br-legend-item" }, h("i", { style: { background: "var(--series-1)" } }), "A(H1N1)pdm09"),
        h("span", { class: "br-legend-item" }, h("i", { style: { background: "var(--series-2)" } }), "A(H3N2)"),
        h("span", { class: "br-legend-item" }, h("i", { style: { background: "var(--ink-faint)" } }), "A (untyped)"),
        h("span", { class: "br-legend-item" }, h("i", { style: { background: "var(--series-3)" } }), "B/Victoria"),
        h("span", { class: "br-legend-item" }, h("i", { style: { background: "var(--ink-primary)" } }), "% positive"),
      ),
    );

    cladeCanvas = h("canvas", { class: "br-viro-canvas", "aria-label": "Nextstrain clade frequencies and forecast" });
    cladeHost = h("div", null,
      h("h3", { class: "sc-block-title" }, "Clade frequencies & projection (Nextstrain / GISAID)"),
      cladeCanvas,
      h("div", { class: "br-legend" },
        ...briefing.cladeNames.map((cn, idx) =>
          h("span", { class: "br-legend-item" }, h("i", { style: { background: `var(--series-${idx + 1})` } }), cn)),
      ),
    );

    const vaccineTable = h("div", { class: "br-table-scroll", style: { marginTop: "var(--space-24)" } },
      h("h3", { class: "sc-block-title" }, "Vaccine reference match"),
      h("table", { class: "v-table" },
        h("thead", null,
          h("tr", null, h("th", null, "Component"), h("th", null, "Reference strain"), h("th", null, "Match"), h("th", null, "Subclades"), h("th", null, "Leading"), h("th", null, "Growth"))),
        h("tbody", null,
          ...briefing.vaccineMatch.map((row) =>
            h("tr", null,
              h("td", null, row.component),
              h("td", { class: "quiet" }, row.strain),
              h("td", { class: "num lead" }, row.match),
              h("td", { class: "quiet" }, row.subclades),
              h("td", null, row.leading),
              h("td", { class: "num" }, row.growth),
            ))),
      ),
    );

    const sec3 = h("section", { class: "v-section" },
      h("header", { class: "v-head" }, h("h2", { class: "v-title" }, "Virology & variants")),
      h("div", { class: "v-body" },
        h("div", { class: "br-viro-grid" }, viroHost, cladeHost),
        vaccineTable,
      ),
    );

    // 6. Section 4: Context, Local Accuracy & Collapsible Sources
    const srcToggle = h("button", {
      type: "button", class: "v-frag is-set",
      onclick: () => { showSources = !showSources; render(); },
    }, showSources ? `Hide data sources (${briefing.sources.length})` : `Data sources (${briefing.sources.length}) ▾`);

    const sec4 = h("section", { class: "v-section" },
      h("header", { class: "v-head" }, h("h2", { class: "v-title" }, "Clinical context & model skill")),
      h("div", { class: "v-body" },
        h("div", { class: "ms-about", style: { paddingTop: 0, paddingBottom: "var(--space-24)", borderBottom: "var(--stroke-hairline) solid var(--line-hairline)" } },
          h("div", { class: "ms-block" },
            h("h3", { class: "sc-block-title" }, "Surveillance notes"),
            h("dl", { class: "ms-dl" },
              ...briefing.context.flatMap((c) => [h("dt", null, c.k), h("dd", null, c.v)])),
          ),
          h("div", { class: "ms-block" },
            h("h3", { class: "sc-block-title" }, `Local rolling calibration (${briefing.abbr})`),
            h("table", { class: "v-table" },
              h("thead", null, h("tr", null, h("th", null, "Model"), h("th", null, "WIS"), h("th", null, "Rel. WIS"), h("th", null, "95%"), h("th", null, "Bias"))),
              h("tbody", null,
                ...briefing.leaderboard.map((r) =>
                  h("tr", null,
                    h("td", null, h("span", { class: "v-name", style: r.slot ? { "--c": `var(--series-${r.slot})` } : null }, h("i"), r.model)),
                    h("td", { class: "num" }, r.wis.toFixed(2)),
                    h("td", { class: "num lead" }, `${r.relWis.toFixed(2)}×`),
                    h("td", { class: "num" }, `${r.cov95}%`),
                    h("td", { class: "num quiet" }, r.bias),
                  ))),
            ),
          ),
        ),
        h("div", { class: "br-src-wrap" },
          srcToggle,
          showSources ? h("table", { class: "v-table", style: { marginTop: "var(--space-12)" } },
            h("thead", null, h("tr", null, h("th", null, "Stream"), h("th", null, "Source"), h("th", null, "Latest"))),
            h("tbody", null, ...briefing.sources.map((s) =>
              h("tr", null, h("td", null, s.stream), h("td", { class: "quiet" }, s.source), h("td", { class: "num" }, s.latest)))),
          ) : null,
        ),
      ),
    );

    paper.replaceChildren(masthead, kpiStrip, sec1, sec2, sec3, sec4);
    scheduleAllDraws();
  }

  /* ---------------- Canvas Drawing Helpers ---------------- */
  function drawWave() {
    if (!waveCanvas || !waveHost) return;
    const W = waveHost.clientWidth;
    const H = 300;
    if (W < 60) return;
    const g = fitCanvas(waveCanvas, W, H);
    const wave = (briefing.streams[streamIdx] || briefing.streams[0]).wave;

    const inkPrimary = cssColor("var(--ink-primary)");
    const inkTertiary = cssColor("var(--ink-tertiary)");
    const hairline = cssColor("var(--line-hairline)");
    const lineAxis = cssColor("var(--line-axis)");
    const accentRgb = parseRgb(cssColor("var(--accent)"));
    const accent = `rgb(${accentRgb.join(",")})`;
    const shade = cssColor("var(--shade-forecast)");
    const fontMono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono");

    const padL = 44, padR = 12, padT = 16, padB = 28;
    const nW = 19;
    let yMax = 2;
    for (const p of wave.obs) yMax = Math.max(yMax, p.val);
    if (showPriors) for (const pr of wave.priors) for (const p of pr.pts) yMax = Math.max(yMax, p.val);
    for (const f of wave.forecast) yMax = Math.max(yMax, f.hi95);
    yMax *= 1.1;

    const xAt = (w) => padL + (w / (nW - 1)) * (W - padL - padR);
    const yAt = (v) => (H - padB) - (v / yMax) * (H - padB - padT);

    if (wave.forecast.length) {
      const xCut = xAt(13);
      g.fillStyle = shade;
      g.fillRect(xCut, padT, W - padR - xCut, H - padB - padT);
    }

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

    g.textAlign = "center";
    g.textBaseline = "top";
    for (let w = 0; w < nW; w += 3) {
      const mmwr = ((40 + w - 1) % 52) + 1;
      g.fillStyle = inkTertiary;
      g.fillText(`W${String(mmwr).padStart(2, "0")}`, xAt(w), H - padB + 8);
    }

    if (showPriors) {
      wave.priors.forEach((pr, idx) => {
        g.beginPath();
        pr.pts.slice(0, nW).forEach((p, i) => {
          const x = xAt(p.w), y = yAt(p.val);
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        });
        g.setLineDash([3, 3]);
        g.strokeStyle = cssColor(`var(--season-${idx + 1})`);
        g.globalAlpha = 0.65;
        g.lineWidth = 1.25;
        g.stroke();
        g.setLineDash([]);
        g.globalAlpha = 1;
      });
    }

    if (wave.forecast.length) {
      for (const [loKey, hiKey, alpha] of [["lo95", "hi95", 0.14], ["lo50", "hi50", 0.24]]) {
        g.beginPath();
        wave.forecast.forEach((p, i) => {
          const x = xAt(p.w), y = yAt(p[hiKey]);
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        });
        for (let i = wave.forecast.length - 1; i >= 0; i--) g.lineTo(xAt(wave.forecast[i].w), yAt(wave.forecast[i][loKey]));
        g.closePath();
        g.fillStyle = `rgba(${accentRgb.join(",")}, ${alpha})`;
        g.fill();
      }

      g.beginPath();
      wave.forecast.forEach((p, i) => {
        const x = xAt(p.w), y = yAt(p.med);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.setLineDash([5, 3]);
      g.strokeStyle = accent;
      g.lineWidth = 2;
      g.stroke();
      g.setLineDash([]);
    }

    g.beginPath();
    wave.obs.forEach((p, i) => {
      const x = xAt(p.w), y = yAt(p.val);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.strokeStyle = inkPrimary;
    g.lineWidth = 2.1;
    g.stroke();
    for (const p of wave.obs) {
      g.beginPath();
      g.arc(xAt(p.w), yAt(p.val), 2.4, 0, Math.PI * 2);
      g.fillStyle = inkPrimary;
      g.fill();
    }
  }

  function drawCompactVerticalPmf() {
    if (!pmfCanvas || !pmfHost) return;
    const W = pmfHost.clientWidth;
    const H = 150;
    if (W < 60) return;
    const g = fitCanvas(pmfCanvas, W, H);
    const cols = CAT_SCORE_VARS.map((v) => cssColor(`var(${v})`));
    const lineAxis = cssColor("var(--line-axis)");
    const inkSecondary = cssColor("var(--ink-secondary)");
    const inkTertiary = cssColor("var(--ink-tertiary)");
    const fontSans = getComputedStyle(document.documentElement).getPropertyValue("--font-sans");
    const fontMono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono");

    const padT = 14, padB = 14;
    const yZero = H * 0.5;
    const halfH = (H - padT - padB) * 0.48;
    const yAt = (v) => yZero - v * halfH;

    g.beginPath();
    g.moveTo(0, yZero);
    g.lineTo(W, yZero);
    g.strokeStyle = lineAxis;
    g.lineWidth = 1;
    g.stroke();

    const segs = verticalPmfSegments(briefing.pmfProbs);
    const barW = 36;
    const barX = 16;
    for (const s of segs) {
      const yTop = yAt(s.y1);
      const yBot = yAt(s.y0);
      g.fillStyle = cols[s.cat];
      g.fillRect(barX, yTop, barW, Math.max(1, yBot - yTop));
    }

    // List ordered odds cleanly to the right of the vertical column
    const startX = barX + barW + 18;
    [4, 3, 2, 1, 0].forEach((k, idx) => {
      const y = 20 + idx * 26;
      const pct = Math.round(briefing.pmfProbs[k] * 100);
      g.fillStyle = cols[k];
      g.fillRect(startX, y - 5, 8, 8);
      g.font = `400 12px ${fontSans}`;
      g.textAlign = "left";
      g.textBaseline = "middle";
      g.fillStyle = inkSecondary;
      g.fillText(PMF_CATEGORIES[k].label, startX + 14, y - 1);
      g.font = `500 12px ${fontMono}`;
      g.textAlign = "right";
      g.fillStyle = pct >= 30 ? cssColor("var(--ink-primary)") : inkTertiary;
      g.fillText(`${pct}%`, W - 4, y - 1);
    });
  }

  function drawVirology() {
    if (!viroCanvas || !viroHost) return;
    const W = viroHost.clientWidth;
    const H = 220;
    if (W < 60) return;
    const g = fitCanvas(viroCanvas, W, H);
    const inkPrimary = cssColor("var(--ink-primary)");
    const inkTertiary = cssColor("var(--ink-tertiary)");
    const hairline = cssColor("var(--line-hairline)");
    const lineAxis = cssColor("var(--line-axis)");
    const fontMono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono");
    const c1 = cssColor("var(--series-1)");
    const c2 = cssColor("var(--series-2)");
    const c3 = cssColor("var(--ink-faint)");
    const c4 = cssColor("var(--series-3)");

    const padL = 36, padR = 36, padT = 12, padB = 26;
    const rows = briefing.virology;
    const slotW = (W - padL - padR) / rows.length;
    const barW = Math.max(6, slotW * 0.72);
    const yAtShare = (s) => (H - padB) - s * (H - padT - padB);
    const yAtPos = (p) => (H - padB) - (p / 30) * (H - padT - padB);

    g.font = `400 10px ${fontMono}`;
    g.textBaseline = "middle";
    for (const s of [0, 0.5, 1]) {
      const y = yAtShare(s);
      g.beginPath();
      g.moveTo(padL, y);
      g.lineTo(W - padR, y);
      g.strokeStyle = s === 0 ? lineAxis : hairline;
      g.stroke();
      g.textAlign = "right";
      g.fillStyle = inkTertiary;
      g.fillText(`${Math.round(s * 100)}%`, padL - 6, y);
    }
    g.textAlign = "left";
    g.fillStyle = inkTertiary;
    g.fillText("30%+", W - padR + 6, yAtPos(30));

    rows.forEach((r, i) => {
      const x = padL + i * slotW + (slotW - barW) * 0.5;
      let acc = 0;
      for (const [val, col] of [[r.h1n1, c1], [r.h3n2, c2], [r.aUnsub, c3], [r.bVic, c4]]) {
        const y0 = yAtShare(acc + val);
        const y1 = yAtShare(acc);
        g.fillStyle = col;
        g.globalAlpha = 0.85;
        g.fillRect(x, y0, barW, Math.max(0.5, y1 - y0));
        acc += val;
      }
      g.globalAlpha = 1;
    });

    // % positive clinical line
    g.beginPath();
    rows.forEach((r, i) => {
      const x = padL + (i + 0.5) * slotW;
      const y = yAtPos(Math.min(30, r.posPct));
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.strokeStyle = inkPrimary;
    g.lineWidth = 1.75;
    g.stroke();
  }

  function drawClades() {
    if (!cladeCanvas || !cladeHost) return;
    const W = cladeHost.clientWidth;
    const H = 220;
    if (W < 60) return;
    const g = fitCanvas(cladeCanvas, W, H);
    const inkTertiary = cssColor("var(--ink-tertiary)");
    const hairline = cssColor("var(--line-hairline)");
    const lineAxis = cssColor("var(--line-axis)");
    const fontMono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono");

    const padL = 36, padR = 12, padT = 12, padB = 26;
    const pts = briefing.clades;
    const xAt = (i) => padL + (i / (pts.length - 1)) * (W - padL - padR);
    const yAt = (s) => (H - padB) - s * (H - padT - padB);

    g.font = `400 10px ${fontMono}`;
    g.textAlign = "right";
    g.textBaseline = "middle";
    for (const s of [0, 0.25, 0.5, 0.75]) {
      const y = yAt(s);
      g.beginPath();
      g.moveTo(padL, y);
      g.lineTo(W - padR, y);
      g.strokeStyle = s === 0 ? lineAxis : hairline;
      g.stroke();
      g.fillStyle = inkTertiary;
      g.fillText(`${Math.round(s * 100)}%`, padL - 6, y);
    }

    // Forecast separator at index 11
    g.beginPath();
    g.setLineDash([3, 3]);
    g.moveTo(xAt(11), padT);
    g.lineTo(xAt(11), H - padB);
    g.strokeStyle = lineAxis;
    g.stroke();
    g.setLineDash([]);

    for (let k = 0; k < 4; k++) {
      const col = cssColor(`var(--series-${k + 1})`);
      g.beginPath();
      pts.slice(0, 12).forEach((p, i) => {
        const x = xAt(i), y = yAt(p.shares[k]);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.strokeStyle = col;
      g.lineWidth = 1.9;
      g.stroke();

      g.beginPath();
      pts.slice(11).forEach((p, i) => {
        const x = xAt(11 + i), y = yAt(p.shares[k]);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.setLineDash([4, 3]);
      g.stroke();
      g.setLineDash([]);
    }
  }

  const scheduleAllDraws = perFrame(() => {
    drawWave();
    drawCompactVerticalPmf();
    drawVirology();
    drawClades();
  });

  const ro = new ResizeObserver(() => scheduleAllDraws());
  ro.observe(paper);

  ctx.loadHsas().then((d) => {
    hsasList = d?.hsas || [];
    briefing = buildBriefingForPlace(placeId, ctx.resolvePlace(placeId), hsasList);
    render();
  }).catch(() => {});

  offs.push(ctx.onThemeChange(() => { resetColors(); render(); }));
  offs.push(ctx.onDefaultChange(() => render()));
  render();

  return {
    setPlace,
    resize: scheduleAllDraws,
    destroy() {
      ro.disconnect();
      offs.forEach((off) => off());
    },
  };
}
