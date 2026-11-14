import { test } from "node:test";
import assert from "node:assert/strict";
import { linear, niceStep, niceMax, ticks, parseIso, toIso, monthStarts, addWeeks, WEEK, DAY } from "../../lib/scale.js";

test("linear maps, inverts and exposes domain and range", () => {
  const s = linear([0, 100], [500, 100]);
  assert.equal(s(0), 500);
  assert.equal(s(100), 100);
  assert.equal(s(25), 400);
  assert.equal(s.invert(400), 25);
  assert.deepEqual([...s.domain()], [0, 100]);
  assert.deepEqual([...s.range()], [500, 100]);
  assert.ok(Object.isFrozen(s.domain()));
  assert.equal(s.domain(), s.domain(), "no allocation per call");
  const z = linear([5, 5], [0, 10]);
  assert.equal(z(7), 0, "zero-width domain maps to r0");
});

test("niceMax matches d3 scaleLinear().nice(5)", () => {
  const cases = [[42626, 50000], [55718, 60000], [116, 120], [82, 100], [0.0842, 0.1], [69, 70], [1, 1], [9, 10], [3541, 4000],
    [9395, 10000], [21057, 25000], [100, 100], [0.0012, 0.0012], [7, 7], [123456, 140000], [0.5, 0.5], [37, 40], [1234, 1400]];
  for (const [v, want] of cases) assert.equal(niceMax(v), want, `niceMax(${v})`);
  assert.equal(niceMax(0), 0);
  assert.ok(Number.isNaN(niceMax(NaN)));
});

test("niceStep picks 1, 2, 2.5 or 5 × 10ⁿ", () => {
  assert.equal(niceStep(50000, 5), 10000);
  assert.equal(niceStep(60000, 5), 10000);
  assert.equal(niceStep(100, 5), 20);
  assert.equal(niceStep(120, 5), 25);
  assert.equal(niceStep(0.1, 5), 0.02);
  assert.equal(niceStep(25000, 5), 5000);
  assert.equal(niceStep(12000, 5), 2500);
  for (let i = 0; i < 400; i++) {
    const span = 10 ** (-3 + i / 50);
    const st = niceStep(span, 5), m = st / 10 ** Math.floor(Math.log10(st) + 1e-9);
    assert.ok([1, 2, 2.5, 5].some((k) => Math.abs(m - k) < 1e-9), `step ${st} for ${span}`);
    const n = span / st;
    assert.ok(n >= 2.8 && n <= 7.2, `${n} intervals for ${span}`);
  }
  assert.ok(Number.isNaN(niceStep(0)));
});

test("ticks are exact multiples, free of float noise", () => {
  assert.deepEqual(ticks(0, 0.1, 0.02), [0, 0.02, 0.04, 0.06, 0.08, 0.1]);
  assert.deepEqual(ticks(0.1, 0.35, 0.1), [0.1, 0.2, 0.3]);
  assert.deepEqual(ticks(2500, 10000, 2500), [2500, 5000, 7500, 10000]);
  assert.deepEqual(ticks(1, 0, 1), []);
  assert.deepEqual(ticks(0, 1, 0), []);
});

test("UTC dates", () => {
  assert.equal(parseIso("2025-12-27"), Date.UTC(2025, 11, 27));
  assert.ok(Number.isNaN(parseIso("27/12/2025")));
  assert.equal(toIso(Date.UTC(2026, 0, 3)), "2026-01-03");
  assert.equal(addWeeks(parseIso("2025-12-27"), 1), parseIso("2026-01-03"));
  assert.equal(WEEK, 7 * DAY);
  assert.deepEqual(monthStarts(parseIso("2025-11-15"), parseIso("2026-02-01")).map(toIso), ["2025-12-01", "2026-01-01"]);
  assert.deepEqual(monthStarts(parseIso("2025-12-01"), parseIso("2025-12-02")).map(toIso), ["2025-12-01"], "a month start at t0 counts");
});
