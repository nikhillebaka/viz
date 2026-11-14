import { test } from "node:test";
import assert from "node:assert/strict";
import { computePosition } from "../../lib/position.js";

const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const view = box(0, 0, 1000, 800);
const opts = (o = {}) => ({ boundary: view, offset: 8, padding: 16, ...o });

test("bottom-start sits under the anchor, left edges aligned", () => {
  const p = computePosition(box(100, 100, 80, 38), { width: 200, height: 300 }, opts());
  assert.equal(p.side, "bottom");
  assert.equal(p.x, 100);
  assert.equal(p.y, 146);
  assert.equal(p.maxHeight, 800 - 138 - 8 - 16);
  assert.equal(p.origin, "40px 0");
});

test("bottom-end and bottom (centre) align to the right edge and the centre", () => {
  const a = box(400, 100, 100, 38);
  assert.equal(computePosition(a, { width: 200, height: 100 }, opts({ placement: "bottom-end" })).x, 300);
  assert.equal(computePosition(a, { width: 200, height: 100 }, opts({ placement: "bottom" })).x, 350);
});

test("flips to the top when the bottom is too small and the top has more room", () => {
  const p = computePosition(box(100, 700, 80, 38), { width: 200, height: 300 }, opts());
  assert.equal(p.side, "top");
  assert.equal(p.y, 700 - 8 - 300);
  assert.equal(p.origin, "40px 100%");
});

test("doesn't flip when flip is false", () => {
  const p = computePosition(box(100, 700, 80, 38), { width: 200, height: 300 }, opts({ flip: false }));
  assert.equal(p.side, "bottom");
});

test("stays on its side when the other side is smaller still", () => {
  const p = computePosition(box(100, 380, 80, 38), { width: 200, height: 700 }, opts());
  assert.equal(p.side, "bottom");
  assert.equal(p.maxHeight, 800 - 418 - 8 - 16);
});

test("a top placement taller than the room is pinned under the boundary's padding", () => {
  const p = computePosition(box(100, 200, 80, 38), { width: 200, height: 500 }, opts({ placement: "top-start", flip: false }));
  assert.equal(p.y, 200 - 8 - (200 - 8 - 16));
  assert.equal(p.y, 16);
});

test("shifts horizontally to stay inside the padding", () => {
  assert.equal(computePosition(box(950, 100, 40, 38), { width: 200, height: 100 }, opts()).x, 1000 - 16 - 200);
  assert.equal(computePosition(box(0, 100, 40, 38), { width: 200, height: 100 }, opts({ placement: "bottom-end" })).x, 16);
});

test("right and left placements, with vertical shifting", () => {
  const r = computePosition(box(100, 100, 40, 40), { width: 200, height: 100 }, opts({ placement: "right" }));
  assert.equal(r.side, "right");
  assert.equal(r.x, 148);
  assert.equal(r.y, 70);
  assert.equal(r.origin, "0 50px");
  const l = computePosition(box(500, 10, 40, 40), { width: 200, height: 100 }, opts({ placement: "left-start" }));
  assert.equal(l.x, 292);
  assert.equal(l.y, 16);
  assert.equal(l.origin, "100% 14px");
});

test("right flips to left near the right edge", () => {
  const p = computePosition(box(900, 100, 40, 40), { width: 200, height: 100 }, opts({ placement: "right" }));
  assert.equal(p.side, "left");
  assert.equal(p.x, 900 - 8 - 200);
});

test("a negative offset puts a morphing panel in the anchor's place", () => {
  const a = box(100, 100, 120, 38);
  const p = computePosition(a, { width: 360, height: 400 }, opts({ offset: -38 }));
  assert.equal(p.side, "bottom");
  assert.equal(p.x, 100);
  assert.equal(p.y, 100);
});

test("maxHeight never drops below 120 and results are whole pixels", () => {
  const p = computePosition(box(10.4, 780, 10, 10), { width: 50.6, height: 50 }, opts({ placement: "bottom", flip: false }));
  assert.equal(p.maxHeight, 120);
  assert.equal(p.x, Math.round(p.x));
  assert.equal(p.y, Math.round(p.y));
});

test("respects a boundary that doesn't start at 0", () => {
  const b = box(200, 100, 400, 400);
  const p = computePosition(box(210, 120, 40, 20), { width: 100, height: 50 }, { boundary: b, padding: 10, offset: 4, placement: "top-end" });
  assert.equal(p.side, "bottom");
  assert.equal(p.x, 210);
});
