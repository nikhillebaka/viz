import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeOf, seasonWeekEnd, seasonWeekOf } from "../../sections/scope.js";
import { metricsRequest, rowsFrom, sortRows, relLevel, coverageLevel, delimited, datesLabel, horizonsLabel, cliCommand } from "../../sections/scores/model.js";
import { parseUrl, writeUrl } from "../../features/url.js";

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const manifest = {
  baseline: "B", seasons: [{ id: "2024-2025" }, { id: "2025-2026" }],
  seasonOf: (d) => (d >= "2025-07-27" ? "2025-2026" : "2024-2025"),
};

test("season weeks: week 1 is MMWR week 31", () => {
  assert.equal(iso(seasonWeekEnd(2025, 1)), "2025-08-02");
  assert.equal(iso(seasonWeekEnd(2024, 1)), "2024-08-03");
  assert.equal(seasonWeekOf(2025, Date.UTC(2025, 7, 2)), 1);
  assert.equal(seasonWeekOf(2025, Date.UTC(2025, 11, 27)), 22);
});

test("scopeOf follows the chart, normalizes, and resolves the location", () => {
  const s = scopeOf({ date: "2026-01-10", location: "06" }, manifest);
  assert.deepEqual(s.seasons, ["2025-2026"]);
  assert.equal(s.following, true);
  assert.equal(s.location, "states");
  assert.equal(s.baseline, "B");
  assert.equal(s.horizons, null);
  const p = scopeOf({ date: "2026-01-10", location: "06", scope: { seasons: ["2024-2025", "2025-2026", "x"], weeks: [20, 10], horizons: [0, 1, 2, 3], place: "current" } }, manifest);
  assert.deepEqual(p.seasons, ["2025-2026", "2024-2025"]);
  assert.deepEqual(p.weeks, [10, 20]);
  assert.equal(p.from, "2025-10-04");
  assert.equal(p.horizons, null, "all four horizons is no subset");
  assert.equal(p.location, "06");
  assert.equal(scopeOf({ date: "2026-01-10", scope: { weeks: [1, 53] } }, manifest).weeks, null);
});

test("metricsRequest: every model unless shared-only or rank among selected", () => {
  const sc = scopeOf({ date: "2026-01-10" }, manifest);
  const a = metricsRequest(sc, { target: "t", selected: ["m2", "m1"], allSeasons: ["2024-2025", "2025-2026"] });
  assert.equal(a.models, "all");
  assert.equal(new URLSearchParams(a.query).get("season"), "2025-2026");
  const b = metricsRequest({ ...sc, fair: true }, { target: "t", selected: ["m2", "m1"], allSeasons: ["2025-2026"] });
  assert.deepEqual(b.models, ["B", "m1", "m2"]);
  assert.equal(new URLSearchParams(b.query).get("fair"), "1");
  const c = metricsRequest({ ...sc, seasons: ["2025-2026", "2024-2025"], weeks: [3, 9], phase: "peak" }, { target: "t", selected: [], allSeasons: ["2024-2025", "2025-2026"] });
  const q = new URLSearchParams(c.query);
  assert.equal(q.get("season"), "all");
  assert.equal(q.get("weeks"), "3-9");
  assert.equal(q.get("phase"), "peak");
  assert.equal(c.full, null);
  assert.equal(q.get("horizons"), null);
  const d = metricsRequest({ ...sc, horizons: [1, 0] }, { target: "t", selected: [], allSeasons: ["2025-2026"] });
  assert.equal(new URLSearchParams(d.query).get("horizons"), "0,1");
  assert.equal(new URLSearchParams(d.full).get("horizons"), null);
  assert.equal(d.key, d.query);
  // the quick request: the full-pool scope on the selected models and the baseline
  assert.equal(new URLSearchParams(a.quick).get("models"), "B,m1,m2");
  assert.equal(new URLSearchParams(a.quick).get("season"), "2025-2026");
  assert.equal(b.quick, null, "already selected-only");
  assert.equal(new URLSearchParams(d.quick).get("horizons"), "0,1");
});

test("rowsFrom: the quick response stands in with relative WIS pending; Wins from the selected pool", () => {
  const H = (wis, n) => ({ wis, count: n });
  const pool = { baseline_model: "B", rankings: [
    { model_id: "B", has_data_in_scope: true, count: 20, wis: 100, relative_wis: 1, weeks_won: 0, weeks_competed: 2, by_horizon: { 0: H(50, 10) } },
    { model_id: "m1", has_data_in_scope: true, count: 20, wis: 80, relative_wis: 0.8, weeks_won: 0, weeks_competed: 2, by_horizon: { 0: H(25, 10) } },
  ] };
  const sel = { baseline_model: "B", rankings: pool.rankings.map((r) => ({ ...r, relative_wis: 0.7, weeks_won: r.model_id === "m1" ? 9 : 1, weeks_competed: 10 })) };
  const o = { ids: ["m1"], baseline: "B", scale: "natural", label: (id) => id };
  const wait = rowsFrom(sel, { ...o, wins: sel, pending: true });
  assert.equal(wait[0].rel, null);
  assert.equal(wait[1].rel, null, "the baseline is not ranked first while the others wait");
  assert.equal(wait[0].wis, 80);
  const done = rowsFrom(pool, { ...o, wins: sel });
  assert.equal(done[0].rel, 0.8);
  assert.deepEqual([done[0].wins, done[0].competed], [9, 10]);
  assert.equal(rowsFrom(pool, { ...o, wins: null })[0].wins, null);
});

const H = (wis, count, comp = [1, 1, 1]) => ({ wis, wis_log: wis / 100, count, cov50: 50, cov95: 90, sharpness_component: comp[0], overprediction_penalty: comp[1], underprediction_penalty: comp[2], calibration: { "0.5": 50 } });
const resp = {
  baseline_model: "B",
  rankings: [
    { model_id: "B", has_data_in_scope: true, count: 20, wis: 100, relative_wis: 1, by_horizon: { 0: H(50, 10), 1: H(150, 10) } },
    { model_id: "m1", has_data_in_scope: true, count: 20, wis: 80, relative_wis: 0.8, cov95: 93, by_horizon: { 0: H(25, 10), 1: H(135, 10) } },
    { model_id: "m2", has_data_in_scope: true, count: 4, wis: 80, relative_wis: 0.8, by_horizon: {} },
    { model_id: "m3", has_data_in_scope: false, count: 0, wis: null, status_note: "x", active_seasons: ["2023-2024"] },
  ],
};
const opts = { ids: ["m1", "m2", "m3"], baseline: "B", scale: "natural", label: (id) => id };

test("rowsFrom: overall, then a horizon-subset response with by-horizon from the full one", () => {
  const rows = rowsFrom(resp, opts);
  assert.deepEqual(rows.map((r) => r.id), ["m1", "m2", "m3", "B"]);
  assert.equal(rows[0].rel, 0.8);
  assert.equal(rows[0].byH[0].rel, 0.5);
  assert.equal(rows[2].active, false);
  assert.equal(rows[3].rel, 1);
  // the server scored horizon 0 alone: its numbers are used as they are (relative WIS from the server)
  const h0 = {
    baseline_model: "B",
    rankings: [
      { model_id: "B", has_data_in_scope: true, count: 10, wis: 50, relative_wis: 1, by_horizon: { 0: H(50, 10) } },
      { model_id: "m1", has_data_in_scope: true, count: 10, wis: 25, relative_wis: 0.47, by_horizon: { 0: H(25, 10) } },
      { model_id: "m2", has_data_in_scope: false, count: 0, wis: null },
    ],
  };
  const sub = rowsFrom(h0, { ...opts, full: resp });
  assert.equal(sub[0].wis, 25);
  assert.equal(sub[0].rel, 0.47);
  assert.equal(sub[0].n, 10);
  assert.equal(sub[0].byH[1].wis, 135, "by-horizon columns read the full response");
  assert.equal(sub[0].byH[1].rel, 0.9);
  assert.equal(sub[1].active, false, "no forecasts at that horizon");
});

test("sortRows: ties share a rank, unranked last, ranks only for scores", () => {
  const { ranked, unranked, ranks } = sortRows(rowsFrom(resp, opts), "rel");
  assert.deepEqual(ranked.map((r) => r.id), ["m1", "m2", "B"]);
  assert.deepEqual(unranked.map((r) => r.id), ["m3"]);
  assert.equal(ranks.get("m1"), 1);
  assert.equal(ranks.get("m2"), 1);
  assert.equal(ranks.get("B"), 3);
  assert.equal(sortRows(rowsFrom(resp, opts), "rel", true).ranked[0].id, "B");
  assert.equal(sortRows(rowsFrom(resp, opts), "name").ranks.size, 0);
});

test("score colors", () => {
  assert.equal(relLevel(1), 5);
  assert.equal(relLevel(0.5), 1);
  assert.equal(relLevel(0.1), 1);
  assert.equal(relLevel(3), 9);
  assert.equal(relLevel(null), null);
  assert.equal(coverageLevel(95, 95), 5);
  assert.equal(coverageLevel(80, 95), 8, "too narrow is warm");
  assert.equal(coverageLevel(99, 95), 4, "too wide is cool");
});

test("labels, CSV, command", () => {
  const sc = scopeOf({ date: "2026-01-10" }, manifest);
  assert.equal(datesLabel(sc, (id) => id.slice(2, 4) + "–" + id.slice(-2), 2), "25–26");
  assert.equal(datesLabel({ ...sc, seasons: ["a", "b"], phase: "peak" }, (x) => x, 2), "All seasons · Peak");
  assert.equal(horizonsLabel(null), "0–3 wk");
  assert.equal(horizonsLabel([0, 2]), "0, 2 wk");
  assert.equal(delimited([{ a: 'x"y', b: 1, c: null }]), '﻿"a","b","c"\r\n"x""y",1,');
  assert.equal(delimited([{ a: "x\ty" }], "tsv"), "﻿a\r\nx y");
  const cmd = cliCommand({ ids: ["m1", "hub:x"], scope: { ...sc, fair: true, weeks: [2, 5] }, target: "wk inc flu hosp", defaultTarget: "wk inc flu hosp", isHub: (id) => id.startsWith("hub:"), hubBaseline: "B", allSeasons: 2 });
  assert.equal(cmd, "python3 viz/score_cli.py --models m1,B --season 2025-2026 --weeks 2-5 --location states --fair # hub models left out");
  const ranked = cliCommand({ ids: ["m1"], scope: { ...sc, horizons: [0, 1] }, target: "t", defaultTarget: "t", isHub: () => false, hubBaseline: "B", allSeasons: 2 });
  assert.match(ranked, /--models m1,B .* # Rel\. WIS among these only · 0–1 wk not in CLI$/);
});

test("URL: scope and leaderboard keys round-trip; defaults stay out", () => {
  const m = {
    ...manifest, seasonById: new Map([["2024-2025", {}], ["2025-2026", {}]]),
    modelById: new Map([["B", {}], ["m1", {}]]), targetById: new Map([["t", {}]]), locationById: new Map([["US", {}]]),
    default_target: "t", targets: [{ id: "t" }], locations: [{ id: "US" }], recommended: [], allRounds: [{ iso: "2026-01-10", t: Date.UTC(2026, 0, 10) }],
  };
  const out = parseUrl("ss=2024-2025,zz&wk=10-4&ph=peak&hz=1,2&pl=US&fair=1&bl=m1&rk=sel&sc=log&sort=-wis&cols=wins,bogus&open=m1", m);
  assert.deepEqual(out.scope, { seasons: ["2024-2025"], weeks: [4, 10], phase: "peak", horizons: [1, 2], place: "US", fair: true, baseline: "m1", rank: "selected", scale: "log" });
  assert.deepEqual(out.scores, { sort: "wis", rev: true, cols: ["wins"], open: ["m1"] });
  const q = writeUrl({ target: "t", location: "US", date: "2026-01-10", scope: out.scope, scores: out.scores }, m);
  assert.equal(q, "?ss=2024-2025&wk=4-10&ph=peak&hz=1,2&pl=US&fair=1&bl=m1&rk=sel&sc=log&sort=-wis&cols=wins&open=m1");
  assert.equal(writeUrl({ target: "t", location: "US", date: "2026-01-10", scope: {}, scores: { sort: "rel", rev: false, cols: [], open: [] } }, m), "");
});
