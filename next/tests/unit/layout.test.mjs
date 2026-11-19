import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutFan, hoverInfo, lineUnder, labelAt, pointsAt, seriesColor } from "../../chart/layout.js";
import { decodeFan } from "../../lib/api.js";
import { valueFormat } from "../../lib/format.js";
import { parseIso, WEEK } from "../../lib/scale.js";
import { buildFan, spread, weeks } from "./fixtures/synthetic.mjs";

const W = 1440, H = 900;
const measure = (text) => text.length * 6.2;           // a fake: no canvas in node
const format = valueFormat({ scale: "count" });
// observed every week Aug 2 … Feb 28, except Sep 13 (a gap in the history) and Jan 17 (a gap after Dec 27)
const OBS = weeks("2025-08-02", 31).filter((d) => d !== "2025-09-13" && d !== "2026-01-17").map((d, i) => [d, 1000 + 400 * Math.sin(i / 5) + i * 30]);
const ROUNDS = weeks("2025-10-18", 16);
const near = (top) => (r, h) => top + h * 3;          // clustered medians, a few units apart
const fan = decodeFan(buildFan({
  rounds: ROUNDS, observed: OBS,
  models: [
    spread("m0", near(2200)), spread("m1", near(2205)), spread("m2", near(2210)), spread("m3", near(2215)),
    spread("seven", near(2220), 0.3, { only: [0.025, 0.25, 0.75, 0.975] }),  // lacks 0.1 / 0.9
    spread("narrow", (r, h) => 50 + h, 0.001),                                // misses everything
    spread("ghost1", (r, h) => (r < 3 ? 900 : NaN)), spread("ghost2", (r, h) => (r < 3 ? 950 : NaN)),
    spread("low1", () => 3), spread("low2", () => 4), spread("low3", () => 5),
    spread("ctx1", () => 1500), spread("ctx2", () => 1800),
  ],
}));
const di = fan.indexOf("2025-12-27");
const base = (o = {}) => ({
  t: di, ymax: 2400, pad: { l: 64, r: 168, t: 94, b: 118 }, topClear: 70, level: 0.95, format, measure,
  models: ["m0", "m1", "m2", "m3", "seven"].map((id, slot) => ({ id, slot, label: `${id} model` })).concat([{ id: "FluSight-baseline", slot: "baseline", label: "baseline" }]),
  ...o,
});
const isRound = (v, step) => Math.abs(v / step - Math.round(v / step)) < 1e-9;

test("y ticks are round, about five, whatever the height zoom", () => {
  for (let i = 0; i < 200; i++) {
    const ymax = 2400 * Math.exp(-Math.log(6.7) + (i / 199) * Math.log(6.7 * 3)); // 1/3× … 6.7×
    const s = layoutFan(fan, base({ ymax }), W, H);
    const vals = s.ticks.map((d) => d.v);
    const step = vals[0];
    const m = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
    assert.ok([1, 2, 2.5, 5].some((k) => Math.abs(m - k) < 1e-9), `step ${step} at ${ymax}`);
    assert.ok(vals.every((v, k) => isRound(v, step) && Math.abs(v - step * (k + 1)) < step * 1e-9), `ticks ${vals}`);
    const inAxis = vals.filter((v) => v <= ymax).length;
    assert.ok(inAxis >= 2 && inAxis <= 7, `${inAxis} ticks at ${ymax}`);
    assert.ok(s.ticks.at(-1).y > 0 && s.ticks.at(-1).y - (s.ay - s.pad.t) * (step / ymax) <= 0, "continues to the top edge");
    for (const d of s.ticks) assert.ok(d.text === null ? d.y - 6 <= s.topClear + 10 : d.text === format.axis(d.v));
  }
});

function checkLabels(s, msg) {
  const ys = s.labels.map((d) => d.y).sort((a, b) => a - b);
  ys.forEach((y, i) => {
    assert.ok(y >= s.topClear && y <= s.ay, `${msg}: label at ${y} leaves the plot`);
    if (i) assert.ok(y - ys[i - 1] >= 16 - 1e-9, `${msg}: labels ${ys[i - 1]} and ${y} overlap`);
  });
}

test("labels: five charted, two ghosts and the summary never overlap nor leave the plot", () => {
  const ghosts = [{ id: "ghost1", slot: 5, label: "ghost one" }, { id: "ghost2", slot: 6, label: "ghost two" }];
  for (const [name, ids, ymax] of [["clustered at the top", ["m0", "m1", "m2", "m3", "seven"], 2400], ["above the axis", ["m0", "m1", "m2", "m3", "seven"], 1200],
    ["clustered at zero", ["low1", "low2", "low3", "narrow", "seven"], 2400], ["clustered mid", ["m0", "m1", "m2", "m3", "seven"], 4400]]) {
    const models = ids.map((id, slot) => ({ id, slot, label: id })).concat(ghosts);
    const s = layoutFan(fan, base({ models, ymax, absent: "2 not in 2023–24 · 1 not in Wyoming" }), W, H);
    assert.equal(s.labels.length, 8, name);
    assert.equal(s.labels.filter((d) => d.ghost).length, 3, name);
    assert.equal(s.labels.filter((d) => d.summary).length, 1, name);
    assert.ok(s.labels.find((d) => d.id === "ghost1").full.includes("no forecast Dec 27"), name);
    checkLabels(s, name);
    // the summary has no hit box and no dot; the others are clickable
    assert.ok(s.labels.every((d) => (d.summary ? d.hit === null && d.dotR === 0 : Math.abs(d.hit.y1 - d.hit.y0 - 22) < 1e-9)));
  }
});

test("context labels: all or nothing; the hot one alone when they don't fit", () => {
  const context = [{ id: "ctx1", label: "ctx one" }, { id: "ctx2", label: "ctx two" }];
  let s = layoutFan(fan, base({ context }), W, H);
  assert.equal(s.labels.filter((d) => d.ctx).length, 2, "both fit");
  checkLabels(s, "context");
  s = layoutFan(fan, base({ context: [...context, { id: "m0", label: "crowded" }], models: base().models.slice(1) }), W, H);
  assert.equal(s.labels.filter((d) => d.ctx).length, 0, "one doesn't fit: none");
  s = layoutFan(fan, base({ context: [...context, { id: "m0", label: "crowded" }], models: base().models.slice(1), hot: "m0" }), W, H);
  assert.deepEqual(s.labels.filter((d) => d.ctx).map((d) => [d.id, d.hot]), [["m0", true]]);
  checkLabels(s, "hot");
  assert.equal(s.hot.id, "m0");
});

test("the observed line breaks where a week is missing", () => {
  const s = layoutFan(fan, base(), W, H);
  // known: through Dec 20, broken at Sep 13; all: broken at Sep 13 and Jan 17
  assert.equal(s.observed.known.length, 2);
  assert.equal(s.observed.all.length, 3);
  const firstKnown = s.observed.known[0];
  assert.equal(firstKnown.length / 2, 6, "Aug 2 … Sep 6");
  assert.equal(s.cutoff, parseIso("2025-12-20"));
  assert.equal(s.observed.known[1].at(-2), s.x(s.cutoff), "solid through the cutoff");
  // scrubbing: the solid part ends exactly at the moving cutoff
  const f = layoutFan(fan, base({ t: di + 0.4 }), W, H);
  assert.ok(Math.abs(f.observed.known.at(-1).at(-2) - f.x(f.cutoff)) < 1e-9);
  assert.equal(f.cutoff, fan.dates[0] + (di + 0.4) * WEEK - WEEK);
});

test("level 0: medians only, no bands, no misses", () => {
  const s = layoutFan(fan, base({ level: 0, focus: "m0" }), W, H);
  assert.equal(s.bands.length, 0);
  assert.equal(s.misses, null);
  assert.equal(s.medians.length, 5);
  assert.equal(s.rulers, null);
});

test("a model without the level's quantiles has a median and no band", () => {
  const s = layoutFan(fan, base({ level: 0.8 }), W, H);
  assert.ok(s.medians.some((m) => m.id === "seven"));
  assert.ok(!s.bands.some((b) => b.id === "seven"));
  assert.equal(s.bands.length, 4);
  const s95 = layoutFan(fan, base(), W, H);
  assert.ok(s95.bands.some((b) => b.id === "seven"), "it has the 95% quantiles");
  const info = hoverInfo(fan, s, parseIso("2026-01-03"));
  const row = info.rows.find((r) => r.id === "seven");
  assert.ok(Number.isFinite(row.med) && Number.isNaN(row.lo) && row.missed === false);
});

test("several levels: nested bands, edges on the widest the model has; a range per level", () => {
  const s = layoutFan(fan, base({ levels: [0.95, 0.8, 0.5] }), W, H);
  const m0 = s.bands.find((b) => b.id === "m0"), seven = s.bands.find((b) => b.id === "seven");
  assert.equal(m0.inner.length, 2);
  assert.equal(seven.inner.length, 1, "seven lacks the 80% quantiles: that band is skipped");
  const info = hoverInfo(fan, s, parseIso("2026-01-03"));
  const r0 = info.rows.find((r) => r.id === "m0"), r7 = info.rows.find((r) => r.id === "seven");
  assert.equal(r0.ranges.length, 3);
  assert.ok(r0.ranges[0][0] < r0.ranges[1][0] && r0.ranges[1][0] < r0.ranges[2][0], "widest first");
  assert.deepEqual([r0.lo, r0.hi], r0.ranges[0]);
  assert.ok(Number.isNaN(r7.ranges[1][0]) && Number.isFinite(r7.ranges[2][0]));
  assert.equal(layoutFan(fan, base({ levels: [] }), W, H).bands.length, 0);
});

test("focus orders, fills and dims; misses ring the focused model's misses", () => {
  const models = [{ id: "narrow", slot: 0, label: "narrow" }, { id: "m0", slot: 1, label: "m0" }];
  const s = layoutFan(fan, base({ models, focus: "narrow" }), W, H);
  assert.equal(s.focus, "narrow");
  assert.deepEqual(s.bands.map((b) => [b.id, b.fill]), [["m0", null], ["narrow", "focus"]]);
  assert.deepEqual(s.medians.map((m) => [m.id, m.alpha]), [["m0", 0.55], ["narrow", 1]]);
  // scored weeks Dec 27, Jan 3, Jan 10 are observed (Jan 17 is the gap): three misses
  assert.equal(s.misses.list.length, 3);
  assert.equal(s.misses.c, seriesColor(0));
  assert.equal(layoutFan(fan, base({ models, focus: "narrow", t: di + 0.5 }), W, H).misses, null, "faded out between weeks");
  assert.equal(layoutFan(fan, base({ models }), W, H).misses, null, "two models, no focus: none");
  assert.equal(layoutFan(fan, base({ models: models.slice(0, 1) }), W, H).misses.list.length, 3, "the only model");
});

test("hover: a hairline anywhere; hoverInfo over history and over the forecast", () => {
  const t = parseIso("2025-10-04");
  const s = layoutFan(fan, base({ hover: { t }, focus: "m2" }), W, H);
  assert.equal(s.hoverX, s.x(t));
  const hist = hoverInfo(fan, s, t);
  assert.equal(hist.h, null);
  assert.equal(hist.observed, fan.observedAt(t));
  assert.deepEqual(hist.rows, []);
  const fc = hoverInfo(fan, s, parseIso("2026-01-03"));
  assert.equal(fc.h, 1);
  assert.equal(fc.rows.length, 5);
  assert.equal(fc.rows[0].id, "m2", "focused first");
  assert.equal(fc.rows[0].label, "m2 model");
  assert.equal(fc.observed, fan.observedAt(parseIso("2026-01-03")));
  assert.equal(hoverInfo(fan, s, parseIso("2026-01-17")).observed, undefined, "the gap");
  const ctx = hoverInfo(fan, layoutFan(fan, base({ context: [{ id: "ctx1", label: "c1" }, { id: "ctx2", label: "c2" }], hot: "ctx2" }), W, H), parseIso("2026-01-03"));
  assert.equal(ctx.context.n, 2);
  assert.ok(Math.abs(ctx.context.min - 1500) < 1e-3 && Math.abs(ctx.context.max - 1800) < 1e-3);
  assert.equal(ctx.hot.id, "ctx2");
});

test("rulers follow the hovered forecast week, else the last horizon", () => {
  let s = layoutFan(fan, base({ rulers: 1 }), W, H);
  assert.equal(s.rulers.label, "+3 wk");
  assert.equal(s.rulers.rows.length, 5);
  s = layoutFan(fan, base({ rulers: 1, hover: { t: parseIso("2025-12-27") } }), W, H);
  assert.equal(s.rulers.label, "This wk");
  s = layoutFan(fan, base({ rulers: 1, hover: { t: parseIso("2025-11-01") } }), W, H);
  assert.equal(s.rulers.label, "+3 wk", "hover over history");
  const off = layoutFan(fan, base({ rulers: 0 }), W, H), on = layoutFan(fan, base({ rulers: 1 }), W, H);
  assert.ok(on.labels[0].x > off.labels[0].x, "labels step aside");
  assert.equal(on.x(fan.dates[di]), off.x(fan.dates[di]), "the plot never narrows");
});

test("outcome off: nothing observed after the cutoff", () => {
  const models = [{ id: "narrow", slot: 0, label: "narrow" }];
  const on = layoutFan(fan, base({ models }), W, H);
  const s = layoutFan(fan, base({ models, outcome: false }), W, H);
  assert.deepEqual(s.observed.all, [], "no dotted line");
  assert.deepEqual(s.observed.known, on.observed.known, "the solid part stays");
  const xc = s.x(s.cutoff);
  assert.ok(s.observed.points.every((p) => p.x <= xc + 1e-9 && p.fill === 1), "no hollow scored points");
  assert.ok(s.observed.points.some((p) => Math.abs(p.x - xc) < 1e-9), "the cutoff point stays");
  assert.ok(on.observed.points.some((p) => p.x > xc && p.fill === 0), "they exist with the outcome");
  assert.equal(s.misses, null);
  assert.ok(on.misses);
  assert.equal(s.shade, on.shade);
  assert.deepEqual(s.dates, on.dates);
  const after = hoverInfo(fan, s, parseIso("2026-01-03"));
  assert.equal(after.observed, undefined);
  assert.ok(after.rows.every((r) => r.missed === false));
  assert.equal(hoverInfo(fan, s, parseIso("2025-12-20")).observed, fan.observedAt(parseIso("2025-12-20")), "at the cutoff");
  assert.equal(hoverInfo(fan, on, parseIso("2026-01-03")).rows[0].missed, true);
  // scrubbing: the point the cutoff approaches fades in; nothing beyond the cutoff's next week shows
  const f = layoutFan(fan, base({ models, outcome: false, t: di + 0.5 }), W, H);
  const fc = f.x(f.cutoff);
  assert.ok(f.observed.points.every((p) => p.x <= f.x(f.cutoff + WEEK) + 1e-9));
  assert.ok(f.observed.points.some((p) => p.x > fc && p.alpha > 0 && p.alpha < 1));
  assert.ok(Math.abs(f.observed.known.at(-1).at(-2) - fc) < 1e-9);
});

test("between weeks, medians interpolate; a model with one side only folds into its first point", () => {
  const a = pointsAt(fan, "m0", di, 0.95), z = pointsAt(fan, "m0", di + 1, 0.95), m = pointsAt(fan, "m0", di + 0.25, 0.95);
  assert.ok(Math.abs(m[2].t - (a[2].t + 0.25 * (z[2].t - a[2].t))) < 1e-6);
  assert.equal(pointsAt(fan, "m0", di + 0.00001, 0.95), a, "on a week: the cached array");
  const one = fan.points("ghost1", 2, 0.95), g = pointsAt(fan, "ghost1", 2.5, 0.95), o = one[0], q = one.at(-1);
  assert.ok(Math.abs(g.at(-1).t - (o.t + 0.5 * (q.t - o.t))) < 1e-6, "halfway: half as long");
  assert.ok(Math.abs(g.at(-1).med - (o.med + 0.5 * (q.med - o.med))) < 1e-6, "halfway: half as far from its first point");
  assert.equal(g[0].t, o.t, "the first point stays put");
  const near = pointsAt(fan, "ghost1", 2.9999, 0.95);
  assert.ok(Math.abs(near.at(-1).t - o.t) < 0.01 * (q.t - o.t), "nearly closed just before the week without it");
});

test("lineUnder and labelAt", () => {
  const s = layoutFan(fan, base({ context: [{ id: "ctx1", label: "c1" }], focus: "m3" }), W, H);
  const t = parseIso("2026-01-03");
  const px = s.x(t);
  assert.deepEqual(lineUnder(s, px, s.y(1500)), { id: "ctx1", ctx: true });
  assert.deepEqual(lineUnder(s, px, s.y(2213)), { id: "m3", ctx: false }, "focused first among close lines");
  assert.equal(lineUnder(s, px, s.y(500)), null);
  assert.equal(lineUnder(s, s.x(parseIso("2025-12-23")), s.y(1500)), null, "the anchor stretch never counts");
  const l = s.labels[0];
  assert.equal(labelAt(s, l.x + 12, l.y), l);
  assert.equal(labelAt(s, 5, 5), null);
});

test("labels skip off-screen and fit the room with an ellipsis", () => {
  const s = layoutFan(fan, base({ domain: [fan.dates[0] - 60 * WEEK, fan.dates[0] - 40 * WEEK] }), W, H);
  assert.equal(s.labels.length, 0);
  const tight = layoutFan(fan, base({ models: [{ id: "m0", slot: 0, label: "a very long model name that cannot fit" }] }), 600, H);
  const lab = tight.labels[0];
  assert.ok(lab.text.endsWith("…") && lab.full === "a very long model name that cannot fit");
  assert.ok(lab.x + 10 + lab.len <= 600 - 8 + 1e-9);
});

test("cutoff interpolates smoothly when rounds extend past latest truth", () => {
  // Observed truth stops 3 weeks before the final round, with a mid-round transition beyond truth
  const lateRounds = weeks("2025-10-18", 12);
  const shortObs = weeks("2025-08-02", 20).map((d, i) => [d, 500 + i * 20]); // ends Dec 13, rounds run to Jan 3
  const lastObsT = parseIso("2025-12-13");
  const tailFan = decodeFan(buildFan({
    rounds: lateRounds, observed: shortObs, models: [spread("m0", () => 900)],
  }));
  const k = tailFan.indexOf("2025-12-20"); // observed < ref: cutoff clamped to Dec 13 on both k and k+1
  const s0 = layoutFan(tailFan, base({ t: k, models: [{ id: "m0", slot: 0, label: "m0" }] }), W, H);
  const sMid = layoutFan(tailFan, base({ t: k + 0.5, models: [{ id: "m0", slot: 0, label: "m0" }] }), W, H);
  const s1 = layoutFan(tailFan, base({ t: k + 1, models: [{ id: "m0", slot: 0, label: "m0" }] }), W, H);
  assert.equal(s0.cutoff, lastObsT);
  assert.equal(sMid.cutoff, lastObsT, "fractional scroll past truth stays pinned to last observed week");
  assert.equal(s1.cutoff, lastObsT);

  // Transition across the edge where truth runs out: Dec 13 (cutoff Dec 6) → Dec 20 (cutoff Dec 13)
  const kPrev = tailFan.indexOf("2025-12-13");
  const edge = layoutFan(tailFan, base({ t: kPrev + 0.5, models: [{ id: "m0", slot: 0, label: "m0" }] }), W, H);
  assert.equal(edge.cutoff, (parseIso("2025-12-06") + lastObsT) / 2);
});

test("layoutFan clamps scene.ref at the last round even when pulling past the end", () => {
  const lastIdx = fan.dates.length - 1;
  const s = layoutFan(fan, base({ t: lastIdx + 0.8 }), W, H);
  assert.equal(s.ref, fan.dates[lastIdx]);
  assert.equal(s.di, lastIdx);
});
