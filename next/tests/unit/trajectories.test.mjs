import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseIso, DAY } from "../../lib/scale.js";
import { indexManifest } from "../../lib/api.js";
import {
  sampleScoresQuery,
  crpsEnsemble1D,
  energyScore,
  empiricalQuantile,
  sampleModelsForTarget,
  hasSampleModels,
  pickDefaultSampleModel,
  summarizeTrajectories,
  passesGate,
  gateStats,
  computeYAxis,
  SAMPLE_BOARD_SORTS,
  sortSampleBoardRows,
} from "../../sections/trajectories/model.js";
import { isSectionAvailable, targetLocationCount } from "../../sections/index.js";

describe("next/sections/trajectories/model.js", () => {
  it("crpsEnsemble1D satisfies exact analytical identities and shift invariance", () => {
    assert.equal(crpsEnsemble1D([5], 5), 0);
    assert.equal(crpsEnsemble1D([5, 5, 5], 5), 0);
    // Symmetric two-point ensemble {0, 2} against y = 1: E|X-1| - 0.5 E|X-X'| = 1.0 - 0.5 = 0.5
    assert.ok(Math.abs(crpsEnsemble1D([0, 2], 1) - 0.5) < 1e-12);
    // Shift invariance
    assert.ok(Math.abs(crpsEnsemble1D([100, 102], 101) - 0.5) < 1e-12);
    // Out-of-range check {0, 2} against y = 4: E|X-4| - 0.5 = 3.0 - 0.5 = 2.5
    assert.ok(Math.abs(crpsEnsemble1D([0, 2], 4) - 2.5) < 1e-12);
    assert.equal(crpsEnsemble1D([], 1), null);
    assert.equal(crpsEnsemble1D([1, 2], NaN), null);
  });

  it("energyScore computes multivariate Euclidean energy score cleanly", () => {
    assert.equal(energyScore([[1, 2], [1, 2]], [1, 2]), 0);
    // Reduces to 1D CRPS when spread lies along 1 coordinate axis
    assert.ok(Math.abs(energyScore([[0, 0], [2, 0]], [1, 0]) - 0.5) < 1e-12);
    const spread = energyScore([[0, 0], [2, 2], [0, 2], [2, 0]], [1, 1]);
    assert.ok(Number.isFinite(spread) && spread > 0);
    // Requires at least 2 horizons and 2 complete samples
    assert.equal(energyScore([[1], [2]], [1]), null);
    assert.equal(energyScore([[1, 2]], [1, 2]), null);
  });

  it("empiricalQuantile interpolates sorted values linearly", () => {
    const arr = [10, 20, 30, 40, 50];
    assert.equal(empiricalQuantile(arr, 0), 10);
    assert.equal(empiricalQuantile(arr, 0.5), 30);
    assert.equal(empiricalQuantile(arr, 1), 50);
    assert.equal(empiricalQuantile(arr, 0.25), 20);
    assert.ok(Number.isNaN(empiricalQuantile([], 0.5)));
  });

  it("summarizeTrajectories computes peaks, empirical quantiles, realized matches, and scores", () => {
    const refIso = "2026-11-21";
    const refT = parseIso(refIso);
    const entry = {
      horizons: [0, 1, 2],
      samples: [
        { id: "s1", values: [10, 30, 20] },
        { id: "s2", values: [12, 18, 26] },
        { id: "s3", values: [14, 22, 16] },
      ],
    };
    const obsByTime = new Map([
      [refT, 12],
      [refT + 7 * DAY, 22],
    ]);
    const sum = summarizeTrajectories(entry, { refT, horizonOffsetDays: 0, observedByTime: obsByTime });
    assert.deepEqual(sum.horizons, [0, 1, 2]);
    assert.equal(sum.samples[0].peakH, 1);
    assert.equal(sum.samples[0].peakValue, 30);
    assert.equal(sum.samples[1].peakH, 2);
    assert.equal(sum.samples[1].peakValue, 26);
    assert.equal(sum.quantiles[0].q50, 12);
    assert.equal(sum.quantiles[1].q50, 22);
    assert.equal(sum.scores.evaluatedWeeks, 2);
    assert.ok(Number.isFinite(sum.scores.crps) && sum.scores.crps > 0);
    assert.ok(Number.isFinite(sum.scores.energyScore) && sum.scores.energyScore > 0);

    // Conditioning gate at horizon index 1 in [20, 35] keeps s1 (30) and s3 (22), filters out s2 (18)
    const gate = { hIdx: 1, h: 1, lo: 20, hi: 35 };
    assert.equal(passesGate(sum.samples[0], gate), true);
    assert.equal(passesGate(sum.samples[1], gate), false);
    assert.equal(passesGate(sum.samples[2], gate), true);
    const st = gateStats(sum.samples, gate);
    assert.equal(st.active, 2);
    assert.equal(st.total, 3);
    assert.equal(st.pct, 67);
    assert.equal(st.medPeakH, 1);
    assert.equal(st.medPeakVal, 26);
  });

  it("sampleModelsForTarget, hasSampleModels, and pickDefaultSampleModel respect target scope", () => {
    const man = indexManifest({
      baseline: "Base-M",
      targets: [
        { id: "t-samp", output_types: ["quantile", "sample"] },
        { id: "t-pmf", is_categorical: true, output_types: ["pmf"] },
      ],
      models: [
        { id: "M-no", has_samples: false, targets: ["t-samp"], seasons: ["2026-2027"] },
        { id: "M-ens", has_samples: true, designated: true, targets: ["t-samp"], seasons: ["2025-2026", "2026-2027"] },
        { id: "M-long", has_samples: true, targets: ["t-samp"], seasons: ["2026-2027"] },
        { id: "Base-M", has_samples: true, targets: ["t-samp"], seasons: ["2025-2026", "2026-2027"] },
      ],
      seasons: [{ id: "2026-2027", rounds: ["2026-11-21"] }],
      locations: [{ id: "US", name: "US" }],
    });
    assert.equal(hasSampleModels(man, "t-samp"), true);
    assert.equal(hasSampleModels(man, "t-pmf"), false);
    assert.deepEqual(sampleModelsForTarget(man, "t-samp").map((m) => m.id), ["M-ens", "M-long", "Base-M"]);
    assert.deepEqual(sampleModelsForTarget(man, "t-samp", "2025-2026").map((m) => m.id), ["M-ens", "Base-M"]);

    // Picks charted sample model first
    assert.equal(pickDefaultSampleModel(sampleModelsForTarget(man, "t-samp"), { charted: [{ id: "M-long" }], baseline: true }, man), "M-long");
    // Falls back to baseline if enabled and no charted sample model
    assert.equal(pickDefaultSampleModel(sampleModelsForTarget(man, "t-samp"), { charted: [{ id: "M-no" }], baseline: true }, man), "Base-M");
    // Falls back to ensemble/designated when baseline disabled
    assert.equal(pickDefaultSampleModel(sampleModelsForTarget(man, "t-samp"), { charted: [], baseline: false }, man), "M-ens");

    // Declared output_types:["sample"] with 0 sample-bearing models still hides Trajectories tab
    const noActualSamples = indexManifest({
      targets: [{ id: "wk inc flu prop ili", output_types: ["quantile", "sample"], has_peaks: false }],
      models: [{ id: "GZNL-1", has_samples: false, targets: ["wk inc flu prop ili"] }],
      seasons: [{ id: "2026-2027", rounds: ["2026-11-16"] }],
      locations: [{ id: "CN", name: "China" }],
    });
    assert.equal(hasSampleModels(noActualSamples, "wk inc flu prop ili"), false);
    assert.equal(targetLocationCount(noActualSamples, "wk inc flu prop ili"), 1);
    assert.equal(isSectionAvailable("scores", { manifest: noActualSamples, target: "wk inc flu prop ili", location: "CN" }), true);
    assert.equal(isSectionAvailable("heatmap", { manifest: noActualSamples, target: "wk inc flu prop ili", location: "CN" }), true);
    assert.equal(isSectionAvailable("map", { manifest: noActualSamples, target: "wk inc flu prop ili", location: "CN" }), false);
    assert.equal(isSectionAvailable("peaks", { manifest: noActualSamples, target: "wk inc flu prop ili", location: "CN" }), false);
    assert.equal(isSectionAvailable("trajectories", { manifest: noActualSamples, target: "wk inc flu prop ili", location: "CN" }), false);

    // Multi-location target with peaks & samples shows all applicable tabs
    const richMan = indexManifest({
      targets: [{ id: "wk inc flu hosp", output_types: ["quantile", "sample"], has_peaks: true }],
      models: [{ id: "M-s", has_samples: true, targets: ["wk inc flu hosp"] }],
      seasons: [{ id: "2026-2027", rounds: ["2026-11-21"] }],
      locations: [{ id: "US", name: "US" }, { id: "25", name: "Massachusetts" }],
    });
    assert.equal(isSectionAvailable("map", { manifest: richMan, target: "wk inc flu hosp", location: "US" }), true);
    assert.equal(isSectionAvailable("peaks", { manifest: richMan, target: "wk inc flu hosp", location: "US" }), true);
    assert.equal(isSectionAvailable("trajectories", { manifest: richMan, target: "wk inc flu hosp", location: "US" }), true);
  });

  it("sampleScoresQuery formats current vs all-location sample leaderboard queries cleanly", () => {
    const qLoc = new URLSearchParams(sampleScoresQuery({
      target: "wk inc flu hosp",
      season: "2025-2026",
      location: "25",
      scopePlace: "current",
      dims: { age_group: "0-17" },
    }));
    assert.equal(qLoc.get("target"), "wk inc flu hosp");
    assert.equal(qLoc.get("location"), "25");
    assert.equal(qLoc.get("season"), "2025-2026");
    assert.equal(qLoc.get("date"), "all");
    assert.equal(qLoc.get("models"), "all");
    assert.equal(qLoc.get("age_group"), "0-17");

    const qAll = new URLSearchParams(sampleScoresQuery({
      target: "wk inc flu hosp",
      season: "2025-2026",
      location: "25",
      scopePlace: "all",
    }));
    assert.equal(qAll.get("location"), "all");
  });

  it("computeYAxis produces non-overlapping nice ticks across scales and compact heights", () => {
    for (const [rawMax, plotH] of [[0, 390], [0.004, 390], [120, 390], [245000, 390], [1800, 80]]) {
      const { yTop, ticks } = computeYAxis(rawMax, plotH);
      assert.ok(yTop > 0 && Number.isFinite(yTop), `positive yTop for rawMax=${rawMax}`);
      assert.ok(ticks.length >= 2 && ticks.length <= 8, `reasonable tick count (${ticks.length}) for rawMax=${rawMax}, plotH=${plotH}`);
      for (let i = 1; i < ticks.length; i++) {
        assert.ok(ticks[i] > ticks[i - 1], "strictly increasing ticks");
        const pyPrev = plotH * (1 - ticks[i - 1] / yTop);
        const pyCur = plotH * (1 - ticks[i] / yTop);
        assert.ok(pyPrev - pyCur >= 18 - 1e-6, `minimum vertical spacing (${pyPrev - pyCur}px) at rawMax=${rawMax}, plotH=${plotH}`);
      }
    }
  });

  it("sortSampleBoardRows sorts each column accurately with missing values last", () => {
    assert.equal(SAMPLE_BOARD_SORTS.rel.asc, true);
    assert.equal(SAMPLE_BOARD_SORTS.count.asc, false);
    const rows = [
      { model_id: "m-beta", relative_crps: 1.15, crps: 12.0, energy_score: 25.0, count: 10 },
      { model_id: "m-base", relative_crps: null, crps: 10.5, energy_score: 22.0, count: 14 },
      { model_id: "m-alpha", relative_crps: 0.85, crps: 8.9, energy_score: null, count: 12 },
      { model_id: "m-missing", relative_crps: null, crps: NaN, energy_score: 19.0, count: 4 },
    ];
    const lbl = (id) => ({ "m-alpha": "Alpha", "m-beta": "Beta", "m-base": "Base", "m-missing": "Zeta" }[id] || id);

    // Default rel asc: Alpha (0.85), Base (1.00 via baseId), Beta (1.15), missing last
    assert.deepEqual(
      sortSampleBoardRows(rows, { key: "rel", rev: false, baseId: "m-base", labelOf: lbl }).map((r) => r.model_id),
      ["m-alpha", "m-base", "m-beta", "m-missing"],
    );
    // Reversed rel desc still leaves missing last
    assert.deepEqual(
      sortSampleBoardRows(rows, { key: "rel", rev: true, baseId: "m-base", labelOf: lbl }).map((r) => r.model_id),
      ["m-beta", "m-base", "m-alpha", "m-missing"],
    );
    // Count defaults descending
    assert.deepEqual(
      sortSampleBoardRows(rows, { key: "count", rev: false, baseId: "m-base", labelOf: lbl }).map((r) => r.model_id),
      ["m-base", "m-alpha", "m-beta", "m-missing"],
    );
    // Model name asc/desc
    assert.deepEqual(
      sortSampleBoardRows(rows, { key: "model", rev: false, labelOf: lbl }).map((r) => r.model_id),
      ["m-alpha", "m-base", "m-beta", "m-missing"],
    );
    assert.deepEqual(
      sortSampleBoardRows(rows, { key: "energy", rev: false, labelOf: lbl }).map((r) => r.model_id),
      ["m-missing", "m-base", "m-beta", "m-alpha"],
    );
    // No-baseline fallback uses CRPS ascending when rel values are null
    assert.deepEqual(
      sortSampleBoardRows(rows, { key: "rel", rev: false, baseId: null, labelOf: lbl }).map((r) => r.model_id),
      ["m-alpha", "m-beta", "m-base", "m-missing"],
    );
  });
});
