import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../../lib/store.js";

test("get returns a frozen copy of the initial state", () => {
  const init = { a: 1 };
  const s = createStore(init);
  assert.deepEqual(s.get(), { a: 1 });
  assert.notEqual(s.get(), init);
  assert.ok(Object.isFrozen(s.get()));
});

test("set merges shallowly and notifies once with the changed keys", () => {
  const s = createStore({ a: 1, b: 2, c: 3 });
  const calls = [];
  s.on((st, prev, changed) => calls.push({ st, prev, changed: [...changed].sort() }));
  assert.equal(s.set({ a: 10, b: 2, d: 4 }), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].st, { a: 10, b: 2, c: 3, d: 4 });
  assert.deepEqual(calls[0].prev, { a: 1, b: 2, c: 3 });
  assert.deepEqual(calls[0].changed, ["a", "d"]);
  assert.ok(Object.isFrozen(s.get()));
});

test("set is a no-op when nothing changed", () => {
  const s = createStore({ a: 1, o: { x: 1 } });
  const before = s.get();
  let n = 0;
  s.on(() => n++);
  assert.equal(s.set({ a: 1 }), false);
  assert.equal(s.set({ o: before.o }), false);
  assert.equal(s.set(null), false);
  assert.equal(n, 0);
  assert.equal(s.get(), before);
});

test("NaN is equal to NaN; a new object with the same contents is a change", () => {
  const s = createStore({ v: NaN, o: { x: 1 } });
  assert.equal(s.set({ v: NaN }), false);
  assert.equal(s.set({ o: { x: 1 } }), true);
});

test("set accepts a function of the state", () => {
  const s = createStore({ n: 1 });
  s.set((st) => ({ n: st.n + 1 }));
  assert.equal(s.get().n, 2);
});

test("on returns an unsubscribe", () => {
  const s = createStore({ n: 0 });
  let n = 0;
  const off = s.on(() => n++);
  s.set({ n: 1 });
  off();
  s.set({ n: 2 });
  assert.equal(n, 1);
});

test("select fires only for its keys", () => {
  const s = createStore({ a: 0, b: 0 });
  const seen = [];
  s.select(["a"], (st, prev) => seen.push([prev.a, st.a]));
  s.set({ b: 1 });
  s.set({ a: 1 });
  s.set({ a: 1, b: 2 });
  assert.deepEqual(seen, [[0, 1]]);
});

test("a set inside a listener is applied at once and announced after the round", () => {
  const s = createStore({ a: 0, b: 0 });
  const log = [];
  s.on((st, prev, changed) => {
    log.push(["L1", [...changed].join(), st.a, st.b]);
    if (changed.has("a")) s.set({ b: st.a * 10 });
    // fresh immediately
    if (changed.has("a")) assert.equal(s.get().b, 10);
  });
  s.on((st, prev, changed) => log.push(["L2", [...changed].join(), st.a, st.b]));
  s.set({ a: 1 });
  assert.deepEqual(log, [
    ["L1", "a", 1, 0],
    ["L2", "a", 1, 0],
    ["L1", "b", 1, 10],
    ["L2", "b", 1, 10],
  ]);
});

test("unsubscribing during notification skips that listener", () => {
  const s = createStore({ n: 0 });
  let second = 0, off2;
  s.on(() => off2());
  off2 = s.on(() => second++);
  s.set({ n: 1 });
  assert.equal(second, 0);
});

test("a throwing listener doesn't leave the store stuck", () => {
  const s = createStore({ n: 0 });
  const off = s.on(() => { throw new Error("boom"); });
  assert.throws(() => s.set({ n: 1 }));
  off();
  let n = 0;
  s.on(() => n++);
  s.set({ n: 2 });
  assert.equal(n, 1);
});
