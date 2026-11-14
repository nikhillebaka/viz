import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFan, indexManifest, loadFan, loadManifest } from "../../lib/api.js";
import { parseIso, WEEK } from "../../lib/scale.js";
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
