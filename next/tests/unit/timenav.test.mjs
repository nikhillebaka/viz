import { test } from "node:test";
import assert from "node:assert/strict";
import { springStep, rubber, unrubber, followAt, mixAt, camera, TimeNav } from "../../chart/timenav.js";
import { WEEK, linear } from "../../lib/scale.js";

const S0 = Date.UTC(2025, 7, 2), SEASON = [S0, S0 + 52 * WEEK], SPAN = 52;
const cam = (span, ref, pan = 0) => camera({ span, ref, season: SEASON, maxSpan: 20, forecastWeeks: 3, pan });

// the loop's rule (TimeNav #run): step at 60 fps until within 5e-4 and slower than 0.01, then land exactly
function settle(x, target, w, v = 0) {
  const path = [];
  for (let i = 0; i < 600; i++) {
    [x, v] = springStep(x, v, target, w, 1 / 60);
    if (Math.abs(x - target) < 5e-4 && Math.abs(v) < 0.01) { path.push(target); return path; }
    path.push(x);
  }
  return path;
}

test("springs from rest never overshoot and land exactly", () => {
  for (const w of [26, 30, 38]) for (const [from, to] of [[0, 1], [5, 2], [0, 12], [3.2, 3]]) {
    const p = settle(from, to, w);
    assert.equal(p.at(-1), to, "lands exactly");
    const dir = Math.sign(to - from);
    assert.ok(p.every((x) => (x - to) * dir <= 1e-12), "never past the target");
    assert.ok(p.every((x, i) => i === 0 || (x - p[i - 1]) * dir >= -1e-12), "monotone");
  }
  // a one-week glide looks settled in about 100 ms
  const p = settle(0, 1, 38);
  assert.ok(p.findIndex((x) => x > 0.95) * (1000 / 60) <= 120);
});

test("rubber bands top out at 1/k and invert", () => {
  assert.equal(rubber(0), 0);
  assert.ok(rubber(1e6) < 1 / 0.6 && rubber(1e6) > 1.6);
  for (const d of [0.1, 0.5, 1, 3]) assert.ok(Math.abs(unrubber(rubber(d)) - d) < 1e-9);
  assert.ok(Math.abs(unrubber(rubber(0.7, 4), 4) - 0.7) < 1e-9);
});

test("the camera keeps the reference date in place up to maxSpan", () => {
  const ref = S0 + 26 * WEEK; // mid-season, so the season's edges never clamp
  for (let E = 6; E <= 20; E += 0.5) {
    const [d0, d1] = cam(E, ref);
    assert.ok(Math.abs(d1 - d0 - E * WEEK) < 1, "exactly span weeks wide");
    assert.ok(Math.abs((ref - d0) / (d1 - d0) - (E - 3) / E) < 1e-9, `at ${E} weeks`);
  }
});

test("at the full season the view is the season; with no pan it never leaves it", () => {
  for (const ref of [S0, S0 + 10 * WEEK, S0 + 40 * WEEK, SEASON[1]]) assert.deepEqual(cam(SPAN, ref), SEASON);
  for (let E = 6; E <= SPAN; E += 1.5) for (let k = -2; k <= 54; k += 1) {
    const [d0, d1] = cam(E, S0 + k * WEEK);
    assert.ok(d0 >= SEASON[0] - 1 && d1 <= SEASON[1] + 1, `span ${E}, week ${k}`);
  }
  const [p0] = cam(10, S0 + 26 * WEEK, -3), [q0] = cam(10, S0 + 26 * WEEK);
  assert.equal(q0 - p0, 3 * WEEK, "pan adds on top");
});

test("follow goes 1 → 0 monotonically from maxSpan to the season", () => {
  assert.equal(followAt(6, 20, SPAN), 1);
  assert.equal(followAt(20, 20, SPAN), 1);
  assert.equal(followAt(SPAN, 20, SPAN), 0);
  assert.equal(mixAt(SPAN, 20, SPAN), 1);
  let prev = 1;
  for (let E = 20; E <= SPAN; E += 0.25) { const f = followAt(E, 20, SPAN); assert.ok(f <= prev + 1e-12 && f >= 0 && f <= 1); prev = f; }
});

test("TimeNav: step, zoom, reset, destroy (reduced motion: targets apply at once)", () => {
  globalThis.matchMedia = () => ({ matches: true });
  let frames = 0;
  globalThis.requestAnimationFrame = (fn) => { frames++; queueMicrotask(fn); return frames; };
  globalThis.cancelAnimationFrame = () => {};
  const listeners = [];
  const surface = { clientWidth: 1440, style: {}, addEventListener: (type, fn, o) => listeners.push({ type, signal: o?.signal }) };
  const dates = Array.from({ length: 30 }, (_, i) => S0 + (11 + i) * WEEK);
  let nav;
  const weeksSeen = [];
  nav = new TimeNav({ surface, dates, index: 10, season: SEASON, scale: () => linear(nav.domain(), [64, 1440 - 168]), onWeek: (i) => weeksSeen.push(i) });
  assert.ok(listeners.length >= 8 && listeners.every((l) => l.signal), "every listener is removable");
  assert.equal(nav.ref, dates[10]);
  nav.step(1);
  assert.equal(nav.week, 11);
  assert.equal(nav.T, 11);
  assert.deepEqual(weeksSeen, [11]);
  nav.step(-20);
  assert.equal(nav.week, 0, "clamped without onEdge");
  let edge = 0;
  nav.onEdge = (d) => { edge = d; return true; };
  nav.step(-1);
  assert.equal(edge, -1);
  assert.equal(nav.week, 0, "onEdge took over");
  nav.zoomIn();
  assert.ok(Math.abs(nav.span - 11 / 1.25) < 1e-9);
  nav.zoomOut(); nav.zoomOut();
  assert.ok(Math.abs(nav.span - 11 * 1.25) < 1e-9);
  nav.setHeight(2);
  assert.ok(Math.abs(nav.heightZoom - 2) < 1e-9);
  nav.reset();
  assert.ok(Math.abs(nav.span - 11) < 1e-9 && nav.heightZoom === 1 && nav.P === 0);
  nav.setSeason(true);
  assert.deepEqual(nav.domain(), SEASON);
  nav.destroy();
  assert.ok(listeners.every((l) => l.signal.aborted));
});

test("side scroll stops hard at the latest round when no next season exists, while cmd+scroll still pans", () => {
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const handlers = {};
  const surface = {
    clientWidth: 1440,
    style: {},
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
  };
  const dates = Array.from({ length: 8 }, (_, i) => S0 + (11 + i) * WEEK);
  const wheel = (deltaX, opts = {}) => handlers.wheel.forEach((fn) => fn({
    target: surface, deltaX, deltaY: 0, deltaMode: 0,
    metaKey: false, ctrlKey: false, shiftKey: false,
    timeStamp: 100, preventDefault() {},
    ...opts,
  }));

  // Without a next season: hard-stopped at dates.length - 1
  let nav;
  nav = new TimeNav({
    surface, dates, index: dates.length - 1, season: SEASON,
    scale: () => linear(nav.domain(), [64, 1440 - 168]),
    canCross: () => false,
  });
  wheel(80, { timeStamp: 100 });
  wheel(80, { timeStamp: 116 });
  assert.equal(nav.T, dates.length - 1, "does not overshoot past latest round");
  assert.equal(nav.pull, 0);
  assert.equal(nav.busy, false);

  // Command + side-scroll still pans smoothly across the season
  wheel(80, { metaKey: true, timeStamp: 140 });
  assert.ok(nav.P > 0, "cmd+scroll pans right");
  assert.equal(nav.T, dates.length - 1, "date stays put during cmd+pan");
  nav.destroy();

  // With a neighbouring season: pull still stretches past the end to cross
  let crossNav;
  crossNav = new TimeNav({
    surface, dates, index: dates.length - 1, season: SEASON,
    scale: () => linear(crossNav.domain(), [64, 1440 - 168]),
    canCross: (d) => d > 0,
  });
  wheel(80, { timeStamp: 200 });
  assert.ok(crossNav.T > dates.length - 1, "rubber-bands when crossing is available");
  assert.ok(crossNav.pull > 0);
  crossNav.destroy();
});
