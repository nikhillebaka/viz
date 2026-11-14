import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtDay, fmtLong, fmtMonth, valueFormat } from "../../lib/format.js";

const d = (y, m, day) => Date.UTC(y, m - 1, day);

test("dates in UTC", () => {
  assert.equal(fmtDay(d(2025, 12, 27)), "Dec 27");
  assert.equal(fmtDay(d(2026, 1, 3)), "Jan 3");
  assert.equal(fmtLong(d(2025, 12, 27)), "Dec 27, 2025");
  assert.equal(fmtMonth(d(2025, 12, 1)), "Dec");
  assert.equal(fmtMonth(d(2026, 1, 1)), "Jan 2026");
  assert.equal(fmtDay(NaN), "–");
});

test("counts", () => {
  const f = valueFormat({ scale: "count" });
  assert.equal(f.value(12345), "12,345");
  assert.equal(f.value(12345.6), "12,346");
  assert.equal(f.value(3.42), "3.4");
  assert.equal(f.value(3), "3");
  assert.equal(f.value(0), "0");
  assert.equal(f.axis(10000), "10k");
  assert.equal(f.axis(2500), "2.5k");
  assert.equal(f.axis(500), "500");
  assert.equal(f.axis(12500), "12.5k");
  assert.equal(f.axis(1e6), "1M");
  assert.equal(f.axis(0.5), "0.5");
  assert.equal(f.compact(1234), "1.2k");
  assert.equal(f.compact(12345), "12k");
  assert.equal(f.compact(999), "1k");
  assert.equal(f.compact(42), "42");
  assert.equal(f.compact(123), "120");
});

test("proportions read as percent", () => {
  const f = valueFormat({ scale: "proportion" });
  assert.equal(f.value(0.0123), "1.23%");
  assert.equal(f.value(0.0842), "8.42%");
  assert.equal(f.value(0.1234), "12.3%");
  assert.equal(f.axis(0.005), "0.5%");
  assert.equal(f.axis(0.02), "2%");
  assert.equal(f.axis(0.06), "6%");
  assert.equal(f.axis(0.1), "10%");
  assert.equal(f.compact(0.0123), "1.23%");
});

test("never NaN", () => {
  for (const f of [valueFormat({ scale: "count" }), valueFormat({ scale: "proportion" }), valueFormat(undefined)])
    for (const k of ["value", "axis", "compact"]) for (const v of [NaN, Infinity, undefined, null]) assert.equal(f[k](v), "–");
});
