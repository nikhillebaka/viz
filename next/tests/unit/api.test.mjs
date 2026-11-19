import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFan, decodeTrajectories, indexManifest, loadFan, loadManifest, apiUrl, getActiveHub, setActiveHub } from "../../lib/api.js";
import { DAY, parseIso, WEEK } from "../../lib/scale.js";
import { buildFan, spread, weeks, isoAdd } from "./fixtures/synthetic.mjs";

// observed Aug 2 … Jan 31 every week, but Nov 22 missing
const OBS = weeks("2025-08-02", 27).filter((d) => d !== "2025-11-22").map((d, i) => [d, 100 + i * 10]);
// rounds Oct 18, then weekly from Nov 22 (a 4-week hole without rounds, as in the real 2025–26 season)
const ROUNDS = ["2025-10-18", ...weeks("2025-11-22", 8)];
const fan = decodeFan(buildFan({
  rounds: ROUNDS, observed: OBS, priorMax: 900,
  models: [
    spread("a", (r, h) => 1000 + r * 100 + h * 10),
    spread("b", (r, h) => (r === 2 ? NaN : 500 + h)),                         // no forecast on round 2
    spread("seven", (r, h) => 2000 + h, 0.3, { only: [0.025, 0.25, 0.75, 0.975] }), // lacks 0.1 / 0.9
    spread("partial", (r, h) => (h === 1 ? NaN : 300)),                       // no median for horizon 1
    { id: "empty", value: () => NaN },
  ],
}));

test("decodes the header, the timeline and the round index", () => {
  assert.equal(fan.target, "wk inc flu hosp");
  assert.equal(fan.season, "2025-2026");
  assert.equal(fan.priorMax, 900);
  assert.deepEqual([...fan.horizons], [0, 1, 2, 3]);
  // every week from Oct 18 to the last round (Jan 10)
  assert.equal(fan.dates[0], parseIso("2025-10-18"));
  assert.equal(fan.dates.at(-1), parseIso("2026-01-10"));
  assert.equal(fan.dates.length, 13);
  assert.ok(fan.dates.every((t, i) => i === 0 || t - fan.dates[i - 1] === WEEK));
  assert.deepEqual([...fan.roundAt], [0, -1, -1, -1, -1, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(fan.indexOf("2025-11-22"), 5);
  assert.equal(fan.indexOf("2025-11-23"), 5, "within half a week");
  assert.equal(fan.indexOf("2027-01-01"), -1);
});

test("observed values and the season window", () => {
  assert.equal(fan.observed.length, 26);
  assert.equal(fan.observedAt(parseIso("2025-08-02")), 100);
  assert.equal(fan.observedAt(parseIso("2025-11-22")), undefined);
  assert.ok(Object.isFrozen(fan.observed));
  // first observed week … max(last observed Jan 31, last round Jan 10 + 3 weeks = Jan 31)
  assert.deepEqual([...fan.window], [parseIso("2025-08-02"), parseIso("2026-01-31")]);
});

test("present and has", () => {
  assert.deepEqual([...fan.present].sort(), ["a", "b", "partial", "seven"]);
  assert.ok(fan.has("a", 5));
  assert.ok(!fan.has("a", 1), "a week without a round");
  assert.ok(!fan.has("b", 6), "b has no round 2");
  assert.ok(!fan.has("nope", 5));
});

test("points: the anchor, then each horizon at the level's quantiles", () => {
  const di = fan.indexOf("2025-11-29"); // round 2
  const p = fan.points("a", di, 0.95);
  // the anchor is the last observed week strictly before Nov 29: Nov 22 is missing, so Nov 15
  assert.deepEqual(p[0], { t: parseIso("2025-11-15"), h: -1, lo: fan.observedAt(parseIso("2025-11-15")), hi: fan.observedAt(parseIso("2025-11-15")), med: fan.observedAt(parseIso("2025-11-15")), anchor: true });
  assert.equal(p.length, 5);
  const med = 1000 + 200 + 10;
  assert.equal(p[2].t, parseIso("2025-12-06"));
  assert.equal(p[2].h, 1);
  assert.ok(Math.abs(p[2].med - med) < 1e-3);
  assert.ok(Math.abs(p[2].lo - med * (1 - 0.475 * 0.6)) < 1e-2, "0.025");
  assert.ok(Math.abs(p[2].hi - med * (1 + 0.475 * 0.6)) < 1e-2, "0.975");
  const p8 = fan.points("a", di, 0.8)[2], p5 = fan.points("a", di, 0.5)[2];
  assert.ok(Math.abs(p8.lo - med * (1 - 0.4 * 0.6)) < 1e-2, "0.1");
  assert.ok(Math.abs(p5.hi - med * (1 + 0.25 * 0.6)) < 1e-2, "0.75");
  assert.ok(Number.isNaN(fan.points("a", di, 0)[2].lo), "level 0 has no interval");
});

test("points are cached, frozen, and null where there is no median", () => {
  const di = fan.indexOf("2025-12-06");
  assert.equal(fan.points("a", di, 0.95), fan.points("a", di, 0.95));
  assert.ok(Object.isFrozen(fan.points("a", di, 0.95)));
  assert.ok(Object.isFrozen(fan.points("a", di, 0.95)[1]));
  assert.equal(fan.points("b", fan.indexOf("2025-11-29"), 0.95), null);
  assert.equal(fan.points("a", 2, 0.95), null, "a week without a round");
  assert.equal(fan.points("empty", di, 0.95), null);
  assert.equal(fan.points("nope", di, 0.95), null);
  const seven = fan.points("seven", di, 0.8);
  assert.ok(seven.slice(1).every((p) => Number.isFinite(p.med) && Number.isNaN(p.lo) && Number.isNaN(p.hi)), "lacks the 80% quantiles");
  assert.ok(fan.points("seven", di, 0.95).slice(1).every((p) => Number.isFinite(p.lo)));
  assert.deepEqual(fan.points("partial", di, 0.95).map((p) => p.h), [-1, 0, 2, 3], "a horizon without a median is skipped");
});

test("the first round has no anchor when nothing was observed before it", () => {
  const f = decodeFan(buildFan({ rounds: ["2025-10-18"], observed: [["2025-10-25", 5]], models: [spread("a", () => 10)] }));
  assert.deepEqual(f.points("a", 0, 0.95).map((p) => p.h), [0, 1, 2, 3]);
  assert.deepEqual([...f.window], [parseIso("2025-10-25"), parseIso("2025-11-08")]);
});

test("yMax: observed and the given models' medians; prior max for a season that has barely begun", () => {
  assert.equal(fan.yMax([]), 100 + 25 * 10);
  assert.ok(Math.abs(fan.yMax(["a"]) - (1000 + 8 * 100 + 30)) < 1e-3);
  assert.ok(Math.abs(fan.yMax(["seven", "a"]) - 2003) < 1e-3);
  assert.equal(fan.yMax(["a", "seven"]), fan.yMax(["seven", "a"]), "cached per set");
  const early = decodeFan(buildFan({ rounds: ["2025-10-18"], observed: [["2025-10-04", 40], ["2025-10-11", 60]], priorMax: 1000, models: [spread("a", () => 70)] }));
  assert.equal(early.yMax(["a"]), 500);
  const late = decodeFan(buildFan({ rounds: ["2025-10-18"], observed: weeks("2025-09-06", 6).map((d) => [d, 60]), priorMax: 1000 }));
  assert.equal(late.yMax([]), 60);
  const none = decodeFan(buildFan({ rounds: ["2025-10-18"] }));
  assert.equal(none.yMax([]), 1);
  assert.deepEqual([...none.window], [parseIso("2025-10-11"), parseIso("2025-11-08")]);
});

test("rounds off the weekly grid snap to the nearest week", () => {
  const f = decodeFan(buildFan({ rounds: ["2025-10-18", "2025-10-24", "2025-11-01"], models: [spread("a", (r) => 10 + r)] }));
  assert.equal(f.dates.length, 3);
  assert.deepEqual([...f.roundAt], [0, 1, 2]);
  assert.equal(f.points("a", 1, 0.95)[0].t, parseIso("2025-10-25"));
});

test("an unpadded header and a payload that isn't a fan", () => {
  const f = decodeFan(buildFan({ rounds: ["2025-10-18"], observed: [["2025-10-11", 7]], models: [spread("abc", () => 10)], pad: false }));
  assert.equal(f.observedAt(parseIso("2025-10-11")), 7);
  assert.ok(Math.abs(f.points("abc", 0, 0.95)[1].med - 10) < 1e-6);
  assert.throws(() => decodeFan(new ArrayBuffer(16)), /VZF1/);
});

const MANIFEST = {
  hub: "h", default_target: "t", baseline: "FluSight-baseline", recommended: [],
  targets: [{ id: "t", scale: "count" }],
  locations: [{ id: "US", abbr: "US", name: "United States" }],
  seasons: [
    { id: "2024-2025", rounds: ["2024-11-23", "2025-05-31"], start: "2024-07-28", end: "2025-07-26" },
    { id: "2025-2026", rounds: ["2025-10-18", "2025-11-22", "2026-05-30"], start: "2025-07-27", end: "2026-08-01" },
  ],
  hubs: [{ id: "flusight", label: "CDC FluSight", short_label: "FluSight" }],
  models: [
    { id: "UMass-flusion", abbr: "flusion", team: "UMass", source: "repo" },
    { id: "flusight:UMass-flusion", abbr: "flusion", team: "UMass", source: "hub", hub: "flusight" },
    { id: "flusight:CU-ensemble", abbr: "ensemble", team: "CU", source: "hub", hub: "flusight" },
    { id: "flusight:FluSight-Ensemble", abbr: "Ensemble", team: "FluSight", source: "hub", hub: "flusight" },
    { id: "UMass-AR2", abbr: "AR2", team: "UMass", source: "repo" },
    { id: "my-local", abbr: "local1", team: "", source: "local" },
    { id: "ens", abbr: "ens", team: "", source: "synthetic" },
  ],
};

test("manifest indexes, rounds and seasons", () => {
  const m = indexManifest(MANIFEST);
  assert.equal(m.modelById.get("UMass-AR2").abbr, "AR2");
  assert.equal(m.locationById.get("US").name, "United States");
  assert.equal(m.seasonById.get("2025-2026").rounds.length, 3);
  assert.equal(m.targetById.get("t").scale, "count");
  assert.equal(m.allRounds.length, 5);
  assert.deepEqual(m.allRounds[0], { season: "2024-2025", iso: "2024-11-23", t: parseIso("2024-11-23") });
  assert.ok(m.allRounds.every((r, i) => i === 0 || r.t > m.allRounds[i - 1].t));
  assert.equal(m.seasonOf("2025-12-27"), "2025-2026");
  assert.equal(m.seasonOf("2025-07-30"), "2025-2026", "by calendar, before the first round");
  assert.equal(m.seasonOf("2025-06-07"), "2024-2025");
  assert.equal(m.seasonOf("2019-01-05"), null);
  assert.equal(m.seasonOf("bad"), null);
  assert.ok(!("modelById" in MANIFEST), "the input is not modified");
});

test("display names: abbr, then team, then the hub", () => {
  const m = indexManifest(MANIFEST), all = MANIFEST.models.map((x) => x.id);
  assert.equal(m.label("UMass-AR2", all), "AR2");
  assert.equal(m.label("UMass-flusion"), "flusion");
  assert.equal(m.label("UMass-flusion", ["UMass-flusion", "UMass-AR2"]), "flusion");
  assert.equal(m.label("UMass-flusion", all), "UMass-flusion");
  assert.equal(m.label("flusight:UMass-flusion", all), "UMass-flusion · FluSight");
  assert.equal(m.label("flusight:CU-ensemble", all), "CU-ensemble", "clash is case-insensitive");
  assert.equal(m.label("flusight:FluSight-Ensemble", all), "FluSight-Ensemble");
  assert.equal(m.label("unknown", all), "unknown");
  assert.equal(m.sourceLabel("UMass-AR2"), "");
  assert.equal(m.sourceLabel(m.modelById.get("flusight:CU-ensemble")), "FluSight");
  assert.equal(m.sourceLabel("my-local"), "Local");
  assert.equal(m.sourceLabel("ens"), "Ensemble");
});

test("loadFan caches, shares in-flight requests, and drops failures", async () => {
  const buf = buildFan({ rounds: ["2025-10-18"], models: [spread("a", () => 10)] });
  const calls = [];
  let fail = false;
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (fail) return { ok: false, status: 500 };
    return { ok: true, arrayBuffer: async () => buf.slice(0), json: async () => MANIFEST };
  };
  const [x, y] = await Promise.all([loadFan("wk inc flu hosp", "2025-2026", "US"), loadFan("wk inc flu hosp", "2025-2026", "US")]);
  assert.equal(x, y);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "/api/next/fan?target=wk+inc+flu+hosp&season=2025-2026&location=US");
  await loadFan("wk inc flu hosp", "2025-2026", "US");
  assert.equal(calls.length, 1, "cached");
  fail = true;
  await assert.rejects(loadFan("t", "2025-2026", "01"));
  fail = false;
  await loadFan("t", "2025-2026", "01");
  assert.equal(calls.length, 3, "a failure is not cached");
  // least recently used goes first past 24
  for (let i = 0; i < 24; i++) await loadFan("t", "s", String(i));
  const before = calls.length;
  await loadFan("wk inc flu hosp", "2025-2026", "US");
  assert.equal(calls.length, before + 1, "evicted");
  const man = await loadManifest();
  assert.equal(man.modelById.size, MANIFEST.models.length);
  assert.equal(calls.at(-1), "/api/next/manifest");
  assert.equal(await loadManifest(), man);
});

test("decodes the live payload shape (real US 2025–26 header layout)", () => {
  // the real server pads its header with spaces and writes observed first; a two-season-long check
  const rounds = ["2025-10-18", ...weeks("2025-11-22", 28)];
  const f = decodeFan(buildFan({ rounds, observed: weeks("2025-08-02", 53).map((d, i) => [d, i]), models: [spread("m", (r, h) => r + h + 1)] }));
  assert.equal(f.dates.length, 33);
  assert.equal(f.roundAt.filter((r) => r >= 0).length, 29);
  assert.equal(f.window[1], parseIso(isoAdd("2025-08-02", 52 * 7)));
});

test("apiUrl appends workspace query parameter safely without colliding with remote hub=", () => {
  try {
    setActiveHub(null);
    assert.equal(getActiveHub(), null);
    assert.equal(apiUrl("/api/next/metrics?target=wk+inc+flu+hosp"), "/api/next/metrics?target=wk+inc+flu+hosp");

    setActiveHub("covid_hub");
    assert.equal(getActiveHub(), "covid_hub");
    assert.equal(apiUrl("/api/next/manifest"), "/api/next/manifest?workspace=covid_hub");
    assert.equal(
      apiUrl("/api/remote/job?hub=flusight"),
      "/api/remote/job?hub=flusight&workspace=covid_hub",
      "preserves remote S3 hub= parameter",
    );
    assert.equal(
      apiUrl("/api/next/manifest?workspace=flu_hub"),
      "/api/next/manifest?workspace=flu_hub",
      "does not duplicate an explicit workspace= param",
    );
    assert.equal(apiUrl("/api/workspace"), "/api/workspace");
    assert.equal(apiUrl("/api/workspace/add"), "/api/workspace/add");
    assert.equal(apiUrl("/next/index.html"), "/next/index.html");
  } finally {
    setActiveHub(null);
  }
});

test("indexManifest resolves per-target and per-season baselines with fallback", () => {
  const m = indexManifest({
    ...MANIFEST,
    baseline: "FluSight-baseline",
    baselines: {
      default: "FluSight-baseline",
      by_target: {
        "wk inc flu hosp": "FluSight-baseline",
        "wk inc flu prop ed visits": "ed-baseline",
      },
      by_target_season: {
        "wk inc flu hosp": {
          "2023-2024": "flusight:FluSight-baseline",
          "2026-2027": "FluSight-baseline",
        },
      },
      candidates: ["FluSight-baseline", "flusight:FluSight-baseline", "ed-baseline"],
    },
  });
  assert.equal(m.baselineFor("wk inc flu hosp", "2023-2024"), "flusight:FluSight-baseline");
  assert.equal(m.baselineFor("wk inc flu hosp", "2025-2026"), "FluSight-baseline");
  assert.equal(m.baselineFor("wk inc flu prop ed visits", "2026-2027"), "ed-baseline");
  assert.equal(m.baselineFor("unknown-target", "2026-2027"), "FluSight-baseline");

  const legacy = indexManifest({ ...MANIFEST, baseline: "Legacy-baseline" });
  assert.equal(legacy.baselineFor("wk inc flu hosp", "2026-2027"), "Legacy-baseline");
});

function buildVzf2({ target = "ILI incidence", season = "2025-2026", location = "DE", rounds, horizons, quantiles = [0.025, 0.5, 0.975], horizonOffsetDays = -3, dims = null, models }) {
  const headerModels = [];
  const chunks = [[0, 100]];
  let offset = 1;
  const obsArr = new Float32Array([42.5]);
  for (const m of models) {
    const mRounds = m.rounds;
    const mHorizons = m.horizons;
    const Q = quantiles.length;
    const arr = new Float32Array(mRounds.length * mHorizons.length * Q);
    mRounds.forEach((r, ri) => mHorizons.forEach((h, hi) => quantiles.forEach((q, qi) => {
      arr[(ri * mHorizons.length + hi) * Q + qi] = m.fn(r, h, q);
    })));
    headerModels.push({ id: m.id, offset, rounds: mRounds, horizons: mHorizons });
    chunks.push(arr);
    offset += arr.length;
  }
  const head = {
    version: 2,
    target,
    season,
    location,
    start: "2025-07-28",
    end: "2026-07-26",
    horizon_offset_days: horizonOffsetDays,
    dims,
    rounds,
    horizons,
    quantiles,
    observed: { dates: ["2025-11-02"], offset: 0, length: 1 },
    prior_max: 200,
    models: headerModels,
  };
  let headBytes = new TextEncoder().encode(JSON.stringify(head));
  const pad = (-headBytes.length) & 3;
  const padded = new Uint8Array(headBytes.length + pad);
  padded.set(headBytes);
  padded.fill(32, headBytes.length);
  const bodyFloats = new Float32Array(offset);
  bodyFloats.set(obsArr, 0);
  let pos = 1;
  for (let i = 1; i < chunks.length; i++) { bodyFloats.set(chunks[i], pos); pos += chunks[i].length; }
  const out = new Uint8Array(8 + padded.length + bodyFloats.byteLength);
  out.set(new TextEncoder().encode("VZF2"), 0);
  new DataView(out.buffer).setUint32(4, padded.length, true);
  out.set(padded, 8);
  out.set(new Uint8Array(bodyFloats.buffer), 8 + padded.length);
  return out.buffer;
}

test("decodes VZF2 sparse blocks with horizon_offset_days (-3d RespiCast Wed -> Sun) and mixed horizons", () => {
  const buf = buildVzf2({
    rounds: ["2025-11-05", "2025-11-12"],
    horizons: [1, 2, 3, 4],
    horizonOffsetDays: -3,
    dims: { age_group: "0-130" },
    models: [
      { id: "short", rounds: [1], horizons: [1, 2], fn: (r, h, q) => 100 + h * 10 + (q === 0.5 ? 0 : (q < 0.5 ? -5 : 5)) },
      { id: "long", rounds: [0, 1], horizons: [1, 2, 3, 4], fn: (r, h, q) => 200 + r * 20 + h },
    ],
  });
  const f = decodeFan(buf);
  assert.equal(f.version, 2);
  assert.equal(f.horizonOffsetDays, -3);
  assert.deepEqual(f.dims, { age_group: "0-130" });
  assert.ok(!f.has("short", 0), "sparse model absent on round 0");
  assert.ok(f.has("short", 1));
  const pts = f.points("short", 1, 0.95);
  assert.deepEqual(pts.map((p) => p.h), [-1, 1, 2]);
  // 2025-11-12 (Wed) + 1*7d - 3d = 2025-11-16 (Sun)
  assert.equal(pts[1].t, parseIso("2025-11-12") + WEEK - 3 * DAY);
  assert.equal(pts[1].t, parseIso("2025-11-16"));
  assert.ok(Math.abs(pts[1].med - 110) < 1e-4);
  assert.ok(Math.abs(f.yMax(["short"]) - 120) < 1e-4);
});

test("decodeTrajectories decodes VZT1 binary sample blocks", () => {
  const head = {
    version: 1, target: "Flu ED visits pct", season: "2025-2026", location: "provo",
    reference_date: "2025-11-22", horizon_offset_days: 0, horizons: [0, 1, 2],
    models: [{ id: "m-sample", offset: 0, n_samples: 2, sample_ids: ["0", "1"], horizons: [0, 1, 2] }],
  };
  let headBytes = new TextEncoder().encode(JSON.stringify(head));
  const pad = (-headBytes.length) & 3;
  const padded = new Uint8Array(headBytes.length + pad);
  padded.set(headBytes);
  padded.fill(32, headBytes.length);
  const floats = new Float32Array([1.5, 2.5, 3.5, 2.0, 3.0, 4.0]);
  const out = new Uint8Array(8 + padded.length + floats.byteLength);
  out.set(new TextEncoder().encode("VZT1"), 0);
  new DataView(out.buffer).setUint32(4, padded.length, true);
  out.set(padded, 8);
  out.set(new Uint8Array(floats.buffer), 8 + padded.length);
  const decoded = decodeTrajectories(out.buffer);
  const tm = decoded.modelTrajectories.get("m-sample");
  assert.equal(tm.samples.length, 2);
  assert.deepEqual(tm.samples[0].values, [1.5, 2.5, 3.5]);
});
