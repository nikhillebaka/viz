import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBriefingHash,
  buildCladeTimelineGeometry,
  buildOutlookGeometry,
  buildSparklineGeometry,
  buildStackedSegments,
  buildSubtypeTimelineGeometry,
  formatIsoShort,
  formatMetricValue,
  formatSignedPct,
  formatTimeAgo,
  normalizeRateChangePmf,
  parseBriefingHash,
} from "../../features/briefing/model.js";
import { apiUrl, clearAllCaches, setActiveHub } from "../../lib/api.js";

test("parseBriefingHash and buildBriefingHash roundtrip cleanly", () => {
  assert.deepEqual(parseBriefingHash("#briefing"), { active: true, placeKey: null });
  assert.deepEqual(parseBriefingHash("#briefing/"), { active: true, placeKey: null });
  assert.deepEqual(parseBriefingHash("#briefing/25"), { active: true, placeKey: "25" });
  assert.deepEqual(parseBriefingHash("#briefing/boston-ma"), { active: true, placeKey: "boston-ma" });
  assert.deepEqual(parseBriefingHash("#briefing/GB%2DENG"), { active: true, placeKey: "GB-ENG" });
  assert.deepEqual(parseBriefingHash("#globe"), { active: false, placeKey: null });
  assert.equal(buildBriefingHash(null), "#briefing");
  assert.equal(buildBriefingHash("PL"), "#briefing/PL");
  assert.equal(buildBriefingHash("GB-ENG"), "#briefing/GB-ENG");
});

test("apiUrl leaves briefing endpoints workspace-free", () => {
  setActiveHub("flusight");
  try {
    assert.equal(apiUrl("/api/next/briefing?place=PL"), "/api/next/briefing?place=PL");
    assert.equal(apiUrl("/api/next/briefing/status"), "/api/next/briefing/status");
    assert.equal(apiUrl("/api/briefing/refresh"), "/api/briefing/refresh");
    assert.ok(apiUrl("/api/next/fan?target=flu").includes("workspace=flusight"));
  } finally {
    setActiveHub(null);
    clearAllCaches();
  }
});

test("factual formatting helpers format numbers, deltas, and dates", () => {
  assert.equal(formatMetricValue(12345), "12,345");
  assert.equal(formatMetricValue(42.34), "42.3");
  assert.equal(formatMetricValue(3.456), "3.46");
  assert.equal(formatMetricValue(4.2, { unit: "%" }), "4.20%");
  assert.equal(formatMetricValue(11.8, { unit: "%" }), "11.8%");
  assert.equal(formatMetricValue(null), "—");
  assert.equal(formatSignedPct(12.34), "+12.3%");
  assert.equal(formatSignedPct(-5.2), "-5.2%");
  assert.equal(formatSignedPct(NaN), "—");
  assert.equal(formatIsoShort("2026-11-14"), "Nov 14");
  assert.equal(formatIsoShort("2026-11-14", true), "Nov 14, 2026");
  assert.equal(formatTimeAgo("2026-11-21T10:00:00Z", Date.parse("2026-11-21T13:00:00Z")), "3h ago");
});

test("buildSparklineGeometry handles normal, flat, single, and empty series", () => {
  const g = buildSparklineGeometry([10, 20, 15, 30]);
  assert.ok(g.path.startsWith("M2,"));
  assert.ok(g.areaPath.endsWith("Z"));
  assert.equal(g.min, 10);
  assert.equal(g.max, 30);

  const flat = buildSparklineGeometry([5, 5, 5], 92, 22, 2);
  assert.equal(flat.lastY, 11);

  const one = buildSparklineGeometry([42], 92, 22, 2);
  assert.equal(one.lastX, 46);

  const empty = buildSparklineGeometry([]);
  assert.equal(empty.path, "");
});

test("buildOutlookGeometry projects observed, ensemble fan bands, and prior seasons", () => {
  const sig = {
    unit: "Hospitalizations",
    observed: [
      { week: 1, date: "2026-10-31", value: 100 },
      { week: 2, date: "2026-11-07", value: 140 },
      { week: 3, date: "2026-11-14", value: 200 },
    ],
    prior_seasons: [
      {
        season: "2025-26",
        points: [
          { week: 1, date: "2026-10-31", orig_date: "2025-11-01", value: 90 },
          { week: 3, date: "2026-11-14", orig_date: "2025-11-15", value: 160 },
        ],
      },
    ],
    fan: {
      model_id: "FluSight-ensemble",
      ref_date: "2026-11-14",
      horizons: [0, 1, 2],
      target_end_dates: ["2026-11-14", "2026-11-21", "2026-11-28"],
      median: [210, 260, 310],
      q50_lower: [180, 210, 240],
      q50_upper: [240, 310, 380],
      q80_lower: [150, 180, 200],
      q80_upper: [270, 360, 440],
      q95_lower: [120, 140, 150],
      q95_upper: [310, 420, 520],
    },
  };

  const g = buildOutlookGeometry(sig, { showPrior: true });
  assert.equal(g.observedPoints.length, 3);
  assert.ok(g.observedPath.startsWith("M"));
  assert.equal(g.priorSeries.length, 1);
  assert.ok(g.fan);
  assert.ok(g.fan.q95Path.startsWith("M") && g.fan.q95Path.endsWith("Z"));
  assert.ok(g.fan.medianPath.startsWith("M"));
  assert.equal(g.fan.points.length, 3);
  assert.ok(g.yTicks.length >= 3);
});

test("normalizeRateChangePmf, buildStackedSegments, and buildCladeTimelineGeometry normalize cleanly", () => {
  const bars = normalizeRateChangePmf({
    probs: { increase: 0.4, stable: 0.4, decrease: 0.2 },
  });
  assert.deepEqual(bars.map((b) => b.key), ["decrease", "stable", "increase"]);
  assert.equal(bars.reduce((s, b) => s + b.pct, 0), 100);

  const segs = buildStackedSegments([
    { label: "H3N2", value: 75 },
    { label: "H1N1", value: 25 },
    { label: "B", value: 0 },
  ]);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].pct, 75);
  assert.equal(segs[1].pct, 25);

  const cg = buildCladeTimelineGeometry({
    dates: ["2026-09-15", "2026-10-15", "2026-11-15"],
    clades: ["XFG", "LP.8.1", "BA.3.2", "XFJ"],
    series_by_clade: {
      XFG: [40, 65, 86],
      "LP.8.1": [50, 25, 6],
      "BA.3.2": [5, 5, 4],
      XFJ: [5, 5, 4],
    },
  });
  assert.equal(cg.areas.length, 4);
  assert.ok(cg.areas[0].path.startsWith("M") && cg.areas[0].path.endsWith("Z"));
  assert.equal(cg.yTicks.length, 3);
  assert.equal(cg.rightLabels.length, 4);
  for (let i = 1; i < cg.rightLabels.length; i++) {
    assert.ok(cg.rightLabels[i].labelY - cg.rightLabels[i - 1].labelY >= 16.9, "Right-margin labels must not overlap");
  }

  const sg = buildSubtypeTimelineGeometry([
    { date: "2026-11-02", spec_processed: 1000, ah1n1pdm09: 20, ah3n2: 10, a_unsubtyped: 5, inf_a: 35, inf_b: 5 },
    { date: "2026-11-09", spec_processed: 1200, ah1n1pdm09: 30, ah3n2: 20, a_unsubtyped: 10, inf_a: 60, inf_b: 10 },
  ]);
  assert.equal(sg.bars.length, 2);
  assert.equal(sg.bars[1].total, 70);
  assert.equal(sg.bars[1].segments.length, 4);
  assert.ok(sg.legend.length >= 3);
});
