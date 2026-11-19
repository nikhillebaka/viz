/* Tab 3: Categorical / Ordinal PMF Studio Prototype (FluSight rate-change & generalized ordinal PMFs).
 * Showcases Centered Diverging Horizon Strips vs Probability Heatmap Matrix across 8 seasonal rounds. */
import { h, cssColor } from "../lib/dom.js";
import { Segmented } from "../ui/controls.js";
import { glass } from "../ui/glass.js";
import { action, setLine, inkOn, resetColors, sequential } from "../sections/shared.js";
import { buildPmfFixture, scorePmfEntry } from "./fixtures.js";
import { fetchLivePmf, probeLiveBackend } from "./liveBridge.js";

const CAT_SCORE_VARS = ["--score-1", "--score-3", "--score-5", "--score-7", "--score-9"];

export function mount(root, ctx) {
  const pmf = buildPmfFixture();
  const offs = [];
  let mode = "diverging"; // "diverging" | "matrix"
  let placeId = pmf.places.some((p) => p?.id === ctx.state.primaryLocation) ? ctx.state.primaryLocation : "US";
  let roundIdx = 3; // Peak ascent week 2025-12-27
  let horizon = 1;
  let focusModel = pmf.models[0].id;
  let liveNote = null;
  let liveRounds = null;

  const paper = h("div", { class: "lab-paper" });
  const sec = h("section", { class: "v-section" });
  const line = h("div", { class: "v-line" });
  const head = h("header", { class: "v-head" },
    h("h2", { class: "v-title" }, "Ordinal PMF"),
    line,
  );
  const body = h("div", { class: "v-body pmf-shell" });
  const readout = h("div", { class: "c-readout v-readout", role: "status", hidden: true });
  sec.append(head, body, readout);
  paper.append(sec);
  root.replaceChildren(paper);

  // ---------------- Controls ----------------
  const makeCycleFrag = (items, getVal, setVal) => {
    const b = h("button", { type: "button", class: "v-frag is-set" });
    b.sync = () => {
      const it = items().find((x) => x.value === getVal()) || items()[0];
      b.textContent = it.label;
    };
    b.addEventListener("click", () => {
      const list = items();
      const idx = list.findIndex((x) => x.value === getVal());
      setVal(list[(idx + 1) % list.length].value);
      syncLine();
      render();
    });
    return b;
  };

  const placeFrag = makeCycleFrag(
    () => pmf.places.filter(Boolean).map((p) => ({ value: p.id, label: p.name })),
    () => placeId,
    (v) => { placeId = v; },
  );
  const roundFrag = makeCycleFrag(
    () => (liveRounds?.dates || pmf.rounds).map((d, i) => ({ value: i, label: `Ref ${d}` })),
    () => roundIdx,
    (v) => { roundIdx = v; },
  );
  const horizonFrag = makeCycleFrag(
    () => [0, 1, 2, 3].map((x) => ({ value: x, label: `${x} wk ahead` })),
    () => horizon,
    (v) => { horizon = v; },
  );

  const prevBtn = action("‹", "Previous round", () => {
    const len = (liveRounds?.dates || pmf.rounds).length;
    roundIdx = (roundIdx - 1 + len) % len;
    syncLine();
    render();
  });
  const nextBtn = action("›", "Next round", () => {
    const len = (liveRounds?.dates || pmf.rounds).length;
    roundIdx = (roundIdx + 1) % len;
    syncLine();
    render();
  });

  function syncLine() {
    placeFrag.sync();
    roundFrag.sync();
    horizonFrag.sync();
  }
  syncLine();
  setLine(line, [placeFrag, roundFrag, horizonFrag]);
  roundFrag.before(prevBtn);
  prevBtn.classList.add("v-tight");
  roundFrag.after(nextBtn);
  nextBtn.classList.add("v-tight");

  const modeSeg = h("div");
  new Segmented(modeSeg, {
    items: [
      { value: "diverging", label: "Diverging strips" },
      { value: "matrix", label: "Season probability matrix" },
    ],
    value: mode,
    label: "PMF layout mode",
    onChange: (v) => { mode = v; render(); },
  });

  const barRow = h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-12)", flexWrap: "wrap" } });
  const obsBadge = h("span", { class: "lab-tag" });
  const statusTag = h("span", { class: "lab-tag" });
  barRow.append(modeSeg, h("div", { style: { display: "flex", gap: "var(--space-8)", flexWrap: "wrap" } }, obsBadge, statusTag));

  const legend = h("div", { class: "pmf-legend" });
  const card = h("div", { class: "lab-card" });
  const scrubber = h("div", { style: { display: "flex", gap: "var(--space-6)", flexWrap: "wrap", alignItems: "center" } });

  body.append(barRow, scrubber, card, legend);
  glass(modeSeg);

  function catColors() {
    return CAT_SCORE_VARS.map((v) => cssColor(`var(${v})`));
  }

  function showSegmentReadout(e, modelName, probs, obsIdx) {
    const rect = sec.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    readout.replaceChildren(
      h("div", { class: "c-readout-head" },
        h("span", { style: { fontWeight: "600", color: "var(--ink-primary)" } }, modelName),
        h("span", { class: "quiet" }, `${horizon} wk`),
      ),
      h("table", null,
        h("tbody", null,
          pmf.categories.map((cat, idx) =>
            h("tr", { class: obsIdx === idx ? "" : obsIdx != null ? "" : "" },
              h("td", { class: "c-readout-name" },
                obsIdx === idx ? h("strong", { style: { color: "var(--accent)" } }, `${cat.label} (obs)`) : cat.label),
              h("td", { class: "num" }, `${(probs[idx] * 100).toFixed(1)}%`),
            )),
        ),
      ),
    );
    readout.hidden = false;
    readout.style.transform = `translate(${Math.min(Math.max(12, x + 14), rect.width - 250)}px, ${Math.max(48, y - 40)}px)`;
  }

  function render() {
    const dates = liveRounds?.dates || pmf.rounds;
    const roundDate = dates[Math.min(roundIdx, dates.length - 1)];
    const cols = catColors();

    // Update legend
    legend.replaceChildren(
      h("span", { class: "quiet" }, "Rate change categories:"),
      ...pmf.categories.map((cat, i) =>
        h("span", { class: "pmf-swatch" }, h("i", { style: { background: cols[i] } }), cat.label)),
      h("span", { class: "pmf-swatch", style: { marginLeft: "auto" } },
        h("i", { style: { border: "2px solid var(--ink-primary)", background: "transparent" } }), "Realized observed bin"),
    );

    // Quick round scrubber chips
    scrubber.replaceChildren(
      h("span", { class: "lab-tag" }, "Rounds:"),
      ...dates.map((d, idx) =>
        h("button", {
          type: "button",
          class: ["c-chip", idx === roundIdx && "on"],
          "aria-label": `Select round ${d}`,
          onclick: () => { roundIdx = idx; syncLine(); render(); },
        }, d.slice(5))),
    );

    const activeData = liveRounds ? liveRounds.resolve(roundDate, horizon) : null;
    const roundRec = activeData || pmf.byPlace[placeId]?.rounds?.[roundDate];
    if (!roundRec) return;

    const obsIdx = roundRec.observedCategory;
    obsBadge.className = `lab-tag ${obsIdx != null ? "is-good" : "is-warn"}`;
    obsBadge.textContent = obsIdx != null
      ? `Observed (${roundRec.targetEndDate}): ${pmf.categories[obsIdx]?.label || obsIdx}`
      : `Pending truth (${roundRec.targetEndDate})`;

    statusTag.textContent = liveNote || `${pmf.target} · Showcasing ordinal calibration`;
    statusTag.className = `lab-tag ${liveRounds ? "is-accent" : ""}`;

    if (mode === "diverging") {
      renderDiverging(roundRec, cols, obsIdx);
    } else {
      renderMatrix(dates, cols);
    }
  }

  function renderDiverging(roundRec, cols, obsIdx) {
    const rows = [];
    const header = h("div", { class: "pmf-axis-row" },
      h("span", { class: "lab-card-title", style: { margin: 0 } }, "Model"),
      h("div", { class: "pmf-center-guide" },
        h("span", null, "← Decreasing rate"),
        h("span", { style: { fontWeight: "600", color: "var(--ink-secondary)" } }, "Centered on Stable"),
        h("span", null, "Increasing rate →"),
      ),
      h("div", { class: "pmf-scores", style: { color: "var(--ink-tertiary)", fontSize: "var(--text-micro)", fontFamily: "var(--font-sans)" } },
        h("span", null, "RPS"), h("span", null, "Log"), h("span", null, "Brier")),
    );

    const modelEntries = liveRounds ? Object.keys(roundRec.models).map((id, i) => ({ id, name: id, idx: i })) : pmf.models.map((m, i) => ({ ...m, idx: i }));

    for (const m of modelEntries) {
      const mRec = roundRec.models[m.id]?.[horizon];
      if (!mRec) continue;
      const probs = mRec.probs;
      // Compute split center on category 2 ("stable"): left weight = p0 + p1 + 0.5*p2
      // Map [0..1] total width cleanly into a 50%-centered span (width = 50% of track, left% = 50 - leftWeight * 50)
      const leftWeight = probs[0] + probs[1] + probs[2] * 0.5;
      const scaleW = 0.54; // occupies 54% of track width so full swing (-0.54..+0.54 around 50%) stays inside 0..100%!
      const leftPct = (0.5 - leftWeight * scaleW) * 100;
      const totalPct = scaleW * 100;
      const seriesColor = `var(--series-${(m.idx % 8) + 1})`;

      const segs = probs.map((p, k) => {
        const wPct = p * 100;
        const label = p >= 0.11 ? `${Math.round(p * 100)}%` : "";
        const seg = h("div", {
          class: ["pmf-seg", obsIdx === k && "is-obs"],
          style: {
            width: `${wPct.toFixed(2)}%`,
            background: cols[k],
            color: inkOn(cols[k]),
          },
          onPointermove: (e) => showSegmentReadout(e, m.name, probs, obsIdx),
          onPointerleave: () => { readout.hidden = true; },
        }, label);
        return seg;
      });

      const bar = h("div", {
        class: "pmf-bar-pos",
        style: { left: `${leftPct.toFixed(2)}%`, width: `${totalPct.toFixed(2)}%` },
      }, ...segs);

      const topIdx = probs.indexOf(Math.max(...probs));
      rows.push(h("div", { class: "pmf-row" },
        h("div", { class: "pmf-model-meta" },
          h("div", { class: "pmf-model-name" },
            h("i", { class: "c-dot", style: { background: seriesColor } }),
            h("span", null, m.name),
          ),
          h("span", { class: "pmf-model-sub mono" }, `Mode: ${pmf.categories[topIdx].short} (${Math.round(probs[topIdx] * 100)}%)`),
        ),
        h("div", { class: "pmf-track" },
          h("div", { class: "pmf-center-line" }),
          bar,
        ),
        h("div", { class: "pmf-scores" },
          h("div", null, Number.isFinite(mRec.rps) ? mRec.rps.toFixed(3) : "–", h("small", null, "RPS")),
          h("div", null, Number.isFinite(mRec.logScore) ? mRec.logScore.toFixed(2) : "–", h("small", null, "Log")),
          h("div", null, Number.isFinite(mRec.brier) ? mRec.brier.toFixed(3) : "–", h("small", null, "Brier")),
        ),
      ));
    }

    card.replaceChildren(header, h("div", { class: "pmf-strip-list" }, ...rows));
  }

  function renderMatrix(dates) {
    const modelIds = liveRounds ? liveRounds.modelIds : pmf.models.map((m) => m.id);
    if (!modelIds.includes(focusModel)) focusModel = modelIds[0];

    const switcher = h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--space-8)", marginBottom: "var(--space-12)" } },
      h("span", { class: "lab-card-title", style: { margin: 0 } }, `Probability mass across ${dates.length} rounds (${horizon} wk)`),
      h("div", { style: { display: "flex", gap: "var(--space-6)", flexWrap: "wrap" } },
        ...modelIds.map((id, i) =>
          h("button", {
            type: "button",
            class: ["c-chip", id === focusModel && "on"],
            onclick: () => { focusModel = id; render(); },
          }, h("i", { class: "c-dot", style: { background: `var(--series-${(i % 8) + 1})` } }), id))),
    );

    const table = h("table", { class: "pmf-matrix" },
      h("thead", null,
        h("tr", null,
          h("th", null, "Category"),
          ...dates.map((d, i) => h("th", { class: "mono" },
            h("button", {
              type: "button", class: ["c-chip", i === roundIdx && "on"],
              "aria-label": `Column round ${d}`,
              style: { height: "24px", padding: "0 var(--space-8)" },
              onclick: () => { roundIdx = i; syncLine(); render(); },
            }, d.slice(5)))),
        ),
      ),
      h("tbody", null,
        // Top to bottom: Large increase down to Large decrease so rising epidemic reads top-ward
        ...[4, 3, 2, 1, 0].map((catIdx) =>
          h("tr", null,
            h("th", null, pmf.categories[catIdx].label),
            ...dates.map((d) => {
              const rec = liveRounds ? liveRounds.resolve(d, horizon) : pmf.byPlace[placeId]?.rounds?.[d];
              const mRec = rec?.models?.[focusModel]?.[horizon];
              const p = mRec ? mRec.probs[catIdx] : 0;
              const isObs = rec?.observedCategory === catIdx;
              const fill = sequential(Math.sqrt(p));
              return h("td", {
                class: ["pmf-cell", isObs && "is-obs"],
                style: { background: fill, color: inkOn(fill) },
                title: `${pmf.categories[catIdx].label} (${d}): ${(p * 100).toFixed(1)}%${isObs ? " · Observed" : ""}`,
              }, `${Math.round(p * 100)}%`);
            }),
          )),
      ),
    );

    card.replaceChildren(switcher, table);
  }

  async function refreshMode() {
    liveRounds = null;
    liveNote = null;
    if (ctx.state.dataMode === "live") {
      const info = await probeLiveBackend();
      const res = await fetchLivePmf(info, placeId);
      if (res.live && res.data?.dates?.length) {
        const cats = pmf.categories.map((c) => c.id);
        const dates = res.data.dates.slice(-8);
        const mIds = Object.keys(res.data.models || {}).slice(0, 6);
        liveRounds = {
          dates,
          modelIds: mIds,
          resolve(date, hz) {
            const obsRaw = res.data.observed?.[date]?.[hz];
            const obsIdx = obsRaw ? cats.indexOf(obsRaw) : null;
            const modMap = {};
            for (const mid of mIds) {
              const probs = res.data.models[mid]?.[date]?.[hz] || res.data.models[mid]?.[date]?.[String(hz)];
              if (!probs) continue;
              const scores = obsIdx != null && obsIdx >= 0 ? scorePmfEntry(probs, obsIdx) : { rps: NaN, logScore: NaN, brier: NaN };
              modMap[mid] = { [hz]: { probs, ...scores } };
            }
            return {
              date,
              targetEndDate: date,
              observedCategory: obsIdx >= 0 ? obsIdx : null,
              models: modMap,
            };
          },
        };
        roundIdx = Math.max(0, dates.length - 1);
        liveNote = `Live API: ${info.hubName} (${mIds.length} PMF models)`;
      } else {
        liveNote = res.reason;
      }
    }
    syncLine();
    render();
  }

  offs.push(ctx.onThemeChange(() => { resetColors(); render(); }));
  offs.push(ctx.onModeChange(refreshMode));
  refreshMode();

  return {
    resize() {},
    destroy() { offs.forEach((off) => off()); },
  };
}
