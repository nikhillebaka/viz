// The rules for which five selected models are charted.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../../features/selection.js";

const ids = (s) => s.charted.map((c) => c.id).join(",");
const slots = (s) => Object.fromEntries(s.charted.map((c) => [c.id, c.slot]));

test("the prototype's 14 cases", () => {
  let s = S.create({ selected: ["a", "b", "c", "d", "e", "f", "g"] });
  assert.equal(ids(s), "a,b,c,d,e", "first five selected are charted");
  assert.equal(s.selected.length, 7, "all seven are selected (evaluated)");
  s = S.select(s, "h");
  assert.equal(ids(s), "a,b,c,d,e", "selecting a sixth+ never changes the chart");

  const before = slots(s);
  s = S.chart(s, "f");
  assert.equal(ids(s), "b,c,d,e,f", "charting with five charted removes the longest charted");
  assert.equal(slots(s).f, before.a, "the new model takes the freed color");
  assert.ok(["b", "c", "d", "e"].every((m) => slots(s)[m] === before[m]), "the others keep their colors");

  s = S.unchart(s, "c");
  assert.equal(ids(s), "b,d,e,f", "unchart leaves the slot empty");
  s = S.select(s, "i");
  assert.equal(ids(s), "b,d,e,f,i", "a newly selected model fills a free slot");

  s = S.deselect(s, "b");
  assert.ok(s.charted.length === 5 && !S.isCharted(s, "b"), "deselecting a charted model frees its slot for the next selected not charted");
  assert.ok(!S.isCharted(s, "c"), "…but not one the user explicitly took off");

  s = S.create({ selected: ["a", "b"] });
  s = S.chart(s, "z");
  assert.ok(S.isSelected(s, "z") && S.isCharted(s, "z"), "charting an unselected model selects it too");
  s = S.setMany(s, ["p", "q", "r", "t"], true);
  assert.equal(ids(s), "a,b,z,p,q", "bulk select fills free slots only");
  s = S.setShowAll(s, true);
  assert.deepEqual(S.context(s), ["r", "t"], "show all: context is every selected model not charted");
  s = S.setBaseline(s, false);
  assert.ok(!S.isSelected(s, "FluSight-baseline") && s.baseline === false, "baseline is a flag, never in the selection");
});

test("slots: first free; queue by seq; toggles", () => {
  let s = S.create({ selected: ["a", "b", "c"] });
  assert.deepEqual(slots(s), { a: 0, b: 1, c: 2 });
  s = S.unchart(s, "a");
  s = S.chart(s, "x");
  assert.equal(S.slotOf(s, "x"), 0, "the first free slot");
  assert.ok(!s.taken.includes("x"));
  s = S.setMany(s, ["y", "w"], true); // y fills slot 3, w slot 4: five charted (b c x y w)
  assert.equal(ids(s), "b,c,x,y,w");
  s = S.chart(s, "a");
  assert.equal(S.slotOf(s, "a"), 1, "takes b's slot: b was charted longest");
  assert.ok(!s.taken.includes("a"), "charting clears taken");
  s = S.chart(s, "b");
  assert.equal(S.slotOf(s, "b"), 2, "then c's");
  assert.equal(S.toggleChart(s, "b").charted.length, 4);
  assert.equal(S.toggle(S.toggle(s, "q"), "q").selected.join(), s.selected.join());
  assert.equal(S.slotOf(s, "nope"), null);
  assert.deepEqual(S.context(s), [], "showAll off: no context");
});

test("immutability: frozen values, inputs untouched, no-ops return the same value", () => {
  const s0 = S.create({ selected: ["a", "b", "c", "d", "e", "f"] });
  assert.ok(Object.isFrozen(s0) && Object.isFrozen(s0.selected) && Object.isFrozen(s0.charted) && Object.isFrozen(s0.charted[0]) && Object.isFrozen(s0.taken));
  const snap = JSON.stringify(s0);
  const s1 = S.chart(S.unchart(S.deselect(S.select(s0, "g"), "a"), "b"), "g");
  assert.equal(JSON.stringify(s0), snap, "the original never changes");
  assert.notEqual(s1, s0);
  assert.equal(S.select(s0, "a"), s0);
  assert.equal(S.deselect(s0, "zz"), s0);
  assert.equal(S.chart(s0, "a"), s0);
  assert.equal(S.unchart(s0, "f"), s0);
  assert.equal(S.setShowAll(s0, false), s0);
  assert.equal(S.setBaseline(s0, true), s0);
  assert.throws(() => { "use strict"; s0.selected.push("x"); });
});

test("restoring from the URL", () => {
  let s = S.fromLists({ selected: ["a", "b", "c", "d"], charted: ["c", null, "a"], showAll: true, baseline: false });
  assert.deepEqual(slots(s), { c: 0, a: 2 });
  assert.equal(s.showAll, true);
  assert.equal(s.baseline, false);
  assert.deepEqual([...s.taken].sort(), ["b", "d"], "free slots with uncharted selected: those were taken off");
  assert.deepEqual(S.chartedBySlot(s), ["c", null, "a"]);
  // deselecting a charted model refills nothing (the rest were taken off)
  assert.equal(ids(S.deselect(s, "c")), "a");
  // a new selection still fills a free slot, the first one
  assert.equal(S.slotOf(S.select(s, "e"), "e"), 1);
  // the queue runs in slot order
  s = S.fromLists({ selected: ["a", "b", "c", "d", "e", "f"], charted: ["e", "d", "c", "b", "a"] });
  assert.deepEqual(s.taken, [], "full: the rest are overflow, not taken");
  s = S.chart(s, "f");
  assert.equal(S.slotOf(s, "f"), 0, "replaces slot 0, first in the queue");
  // charted ids not in the selection are added; duplicates and a sixth are ignored
  s = S.fromLists({ selected: ["a"], charted: ["x", "x", "a", "b", "c", "d", "e"] });
  assert.deepEqual(s.selected, ["a", "x", "b", "c", "d"]);
  assert.equal(s.charted.length, 5);
  assert.deepEqual(S.chartedBySlot(s), ["x", null, "a", "b", "c", "d"]);
  // an explicit taken list wins
  s = S.fromLists({ selected: ["a", "b", "c"], charted: ["a"], taken: ["c"] });
  assert.deepEqual(s.taken, ["c"]);
  assert.equal(ids(S.deselect(s, "a")), "b");
  // round trip
  const t = S.chart(S.create({ selected: ["a", "b", "c", "d", "e", "f"] }), "f");
  const back = S.fromLists({ selected: t.selected, charted: S.chartedBySlot(t), showAll: t.showAll, baseline: t.baseline });
  assert.deepEqual(slots(back), slots(t));
  assert.deepEqual(back.selected, t.selected);
});
