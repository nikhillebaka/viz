import { test } from "node:test";
import assert from "node:assert/strict";
import { weekQuantile, poolWeeks, poolSize } from "../../sections/peaks/pool.js";

test("week quantile: first week reaching p of the total", () => {
  const d = ["a", "b", "c", "d"];
  assert.equal(weekQuantile(d, [0.1, 0.4, 0.4, 0.1], 0.5), "b");
  assert.equal(weekQuantile(d, [0.1, 0.4, 0.4, 0.1], 0.51), "c");
  assert.equal(weekQuantile(d, [1, 4, 4, 1], 0.05), "a");   // unnormalised
  assert.equal(weekQuantile(d, [0, 0, 0, 0], 0.5), null);
});

test("pooled weeks: normalised average over mismatched dates, bimodal kept", () => {
  const p = poolWeeks([
    { dates: ["2026-10-10", "2026-10-17"], probs: [0, 2] },            // sums to 2: normalised
    { dates: ["2026-10-17", "2027-01-09"], probs: [0.5, 0.5] },
    null,
  ]);
  assert.deepEqual(p.dates, ["2026-10-10", "2026-10-17", "2027-01-09"]);
  assert.deepEqual(p.probs, [0, 0.75, 0.25]);
  assert.equal(p.median, "2026-10-17");
  assert.deepEqual(p.i90, ["2026-10-17", "2027-01-09"]);
  assert.equal(poolWeeks([null, { dates: [], probs: [] }]), null);
});

test("pooled size: medians of each quantile over the models that give it", () => {
  const s = poolSize([
    { median: 100, i50: [80, 120], i90: [60, 200] },
    { median: 110, i50: [90, 140] },
    { median: 300, i50: [200, 400], i90: [100, 600] },
    { median: NaN },
  ]);
  assert.equal(s.median, 110);
  assert.deepEqual(s.i50, [90, 140]);
  assert.deepEqual(s.i90, [80, 400]);
  assert.equal(poolSize([]), null);
});
