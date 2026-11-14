import { test } from "node:test";
import assert from "node:assert/strict";
import { indexManifest } from "../../lib/api.js";
import { parseLayers, seasonWeek1 } from "../../features/chart/layers.js";
import { parseUrl, writeUrl, defaults } from "../../features/url.js";

test("parseLayers keeps valid ids in canonical order, once", () => {
  assert.deepEqual(parseLayers("ili, asof,bogus,asof"), ["asof", "ili"]);
  assert.deepEqual(parseLayers(["peaks", "seasons", 3]), ["seasons", "peaks"]);
  assert.deepEqual(parseLayers(null), []);
  assert.deepEqual(parseLayers(""), []);
});

test("seasonWeek1 is the Saturday ending MMWR week 31", () => {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  assert.equal(iso(seasonWeek1(2025)), "2025-08-02");
  assert.equal(iso(seasonWeek1(2024)), "2024-08-03");
  assert.equal(iso(seasonWeek1(2021)), "2021-08-07");
  assert.equal(new Date(seasonWeek1(2026)).getUTCDay(), 6);
});

test("layers round-trip through the URL as lay=", () => {
  const m = indexManifest({
    default_target: "t", baseline: "B", recommended: ["A"], targets: [{ id: "t" }], locations: [{ id: "US" }],
    seasons: [{ id: "2025-2026", rounds: ["2025-11-22"] }], models: [{ id: "A" }, { id: "B" }],
  });
  const s = { ...defaults(m), layers: ["asof", "ili"] };
  const q = writeUrl(s, m);
  assert.equal(q, "?lay=asof,ili");
  assert.deepEqual(parseUrl(q, m).layers, ["asof", "ili"]);
  assert.equal(writeUrl({ ...s, layers: [] }, m), "");
  assert.deepEqual(parseUrl("?lay=nope", m).layers, []);
  assert.deepEqual(parseUrl("?indicators=ma2,season_2023/24,ilinet,unrevised", m).layers, ["asof", "seasons", "ili"]);
});
