import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeView, swapView, metricsFor, requestFor, buildGrid } from "../../sections/heatmap/model.js";

test("views snap to valid axes, metrics and sorts", () => {
  const v = normalizeView({ rows: "horizon", cols: "date", metric: "rate" }, true);
  assert.equal(v.cols, "model");
  assert.equal(v.metric, "relwis");
  assert.equal(v.sort, "");
  assert.deepEqual(metricsFor({ rows: "location", cols: "date", model: "truth" }, false), ["count", "trend"]);
  const s = swapView(normalizeView({ rows: "model", cols: "horizon" }, true), true);
  assert.deepEqual([s.rows, s.cols], ["horizon", "model"]);
});

test("request: one model or the candidates, the scope's seasons and place", () => {
  const p = requestFor(normalizeView({ rows: "location", cols: "date", model: "m1", metric: "error" }, true),
    { target: "t", seasons: ["2024-2025", "2025-2026"], place: "current", locationAbbr: "MA", models: ["a"] });
  assert.equal(p.model, "m1"); assert.equal(p.models, undefined);
  assert.equal(p.location, "MA"); assert.equal(p.season, "2024-2025,2025-2026"); assert.equal(p.metric, "error");
});

// a transposed response: models are columns, the server keyed details model:location
const resp = {
  y_keys: ["MA", "CA"], x_keys: ["base", "good", "bad"],
  raw_matrix: [[10, 5, 20], [4, 2, null]],
  cell_meta: { "good:MA": { cov95: 90 }, "base:CA": { cov95: 95 } },
};

test("details are found whichever way the axes are swapped", () => {
  const g = buildGrid(resp, { rows: "location", cols: "model", metric: "wis", sort: "alpha", scale: "none" }, { baseline: "base" });
  assert.deepEqual(g.rows.map((r) => r.key), ["CA", "MA"]);
  const r = g.rows.findIndex((x) => x.key === "MA"), c = g.cols.findIndex((x) => x.key === "good");
  assert.deepEqual(g.meta(r, c), { cov95: 90 });
});

test("relative WIS is over the baseline's cell in the same slice", () => {
  const g = buildGrid(resp, { rows: "location", cols: "model", metric: "relwis", sort: "alpha", scale: "none" }, { baseline: "base" });
  const nC = g.cols.length, at = (rk, ck) => g.values[g.rows.findIndex((x) => x.key === rk) * nC + g.cols.findIndex((x) => x.key === ck)];
  assert.equal(at("MA", "good"), 0.5);
  assert.equal(at("CA", "good"), 0.5);
  assert.equal(at("MA", "bad"), 2);
  assert.ok(Number.isNaN(at("CA", "bad")));
  assert.ok(g.tone(0, 0).kind === "div");
});

test("best first ranks coverage by distance from 95, not by its value", () => {
  const r = { y_keys: ["low", "near", "high"], x_keys: ["MA"], raw_matrix: [[60], [94], [99]], cell_meta: {} };
  const g = buildGrid(r, { rows: "model", cols: "location", metric: "cov95", sort: "score", scale: "none" }, {});
  assert.deepEqual(g.rows.map((x) => x.key), ["near", "high", "low"]);
});

test("per-row scale spans each row's own range", () => {
  const r = { y_keys: ["a"], x_keys: ["2025-01-04", "2025-01-11"], raw_matrix: [[100, 300]], cell_meta: {} };
  const g = buildGrid(r, { rows: "location", cols: "date", metric: "count", sort: "alpha", scale: "row" }, {});
  assert.deepEqual([g.tone(0, 0).t, g.tone(0, 1).t], [0, 1]);
});
