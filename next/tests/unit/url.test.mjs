import { test } from "node:test";
import assert from "node:assert/strict";
import { indexManifest } from "../../lib/api.js";
import { parseUrl, writeUrl, defaults, defaultDate, nearestRound } from "../../features/url.js";
import { create, fromLists, chart, unchart, chartedBySlot } from "../../features/selection.js";

const manifest = indexManifest({
  default_target: "wk inc flu hosp", baseline: "FluSight-baseline",
  recommended: ["FluSight-baseline", "UMass-flusion", "UMass-gbqr", "CMU-ar", "UMass-ar2"],
  targets: [{ id: "wk inc flu hosp", short: "Flu admissions" }, { id: "wk inc flu prop ed visits", short: "ED visits", scale: "proportion" }],
  locations: [{ id: "US", abbr: "US", name: "United States" }, { id: "25", abbr: "MA", name: "Massachusetts" }, { id: "56", abbr: "WY", name: "Wyoming" }],
  seasons: [
    { id: "2024-2025", rounds: ["2024-11-23", "2024-11-30", "2024-12-07"], start: "2024-07-28", end: "2025-07-26" },
    { id: "2025-2026", rounds: ["2025-10-18", "2025-11-22", "2025-11-29", "2025-12-27"], start: "2025-07-27", end: "2026-08-01" },
  ],
  models: ["FluSight-baseline", "UMass-flusion", "UMass-gbqr", "CMU-ar", "UMass-ar2", "X-a", "X-b", "X-c", "X-d"].map((id) => ({ id, abbr: id })),
});
const D = defaults(manifest);
const base = { ...D, outcome: true };
const state = (patch) => ({ ...base, ...patch });
const roundTrip = (s) => ({ ...base, ...parseUrl(writeUrl(s, manifest), manifest) });

test("defaults: manifest target, US, latest round, first three recommended without the baseline", () => {
  assert.equal(D.target, "wk inc flu hosp");
  assert.equal(D.location, "US");
  assert.equal(D.date, "2025-12-27");
  assert.deepEqual(D.sel.selected, ["UMass-flusion", "UMass-gbqr", "CMU-ar"]);
  assert.deepEqual(D.levels, [0.95]);
});

test("default date: the latest round a selected model forecast, else any model's, else the latest", () => {
  const m = indexManifest({
    ...manifest, models: [{ id: "A", last: "2024-12-01" }, { id: "B", last: "2025-11-29" }, { id: "C" }],
  });
  assert.equal(defaultDate(m, create({ selected: ["A"] })), "2024-11-30", "snapped to a round at or before it");
  assert.equal(defaultDate(m, create({ selected: ["A", "B"] })), "2025-11-29");
  assert.equal(defaultDate(m, create({ selected: [] })), "2025-11-29", "nothing selected: any model's last");
  assert.equal(defaultDate(m, create({ selected: ["C"] })), "2025-11-29", "selected models never forecast");
  assert.equal(defaultDate(manifest, create({ selected: ["X-a"] })), "2025-12-27", "no `last` anywhere: the latest round");
  // the URL leaves out the date that the selection would open on anyway
  const sel = create({ selected: ["A"] });
  assert.equal(writeUrl({ ...defaults(m), sel, date: "2024-11-30" }, m), "?models=A");
});

test("a default view has a clean URL", () => {
  assert.equal(writeUrl(base, manifest), "");
  assert.deepEqual(parseUrl("", manifest), {});
});

test("round trips every key", () => {
  let sel = create({ selected: ["X-a", "X-b", "X-c", "X-d", "UMass-ar2", "CMU-ar"], showAll: true, baseline: false });
  sel = chart(sel, "CMU-ar");          // the queue: X-a comes off, CMU-ar takes slot 0
  sel = unchart(sel, "X-c");            // a free slot in the middle
  const s = state({ target: "wk inc flu prop ed visits", location: "56", date: "2025-11-22", sel, levels: [0.8, 0.5], rulers: true, focus: "CMU-ar" });
  const q = writeUrl(s, manifest);
  assert.match(q, /^\?target=wk%20inc%20flu%20prop%20ed%20visits&loc=56&date=2025-11-22&models=X-a,X-b,X-c,X-d,UMass-ar2,CMU-ar&chart=CMU-ar,X-b,,X-d,UMass-ar2&all=1&base=0&pi=80,50&rulers=1&focus=CMU-ar$/);
  const back = roundTrip(s);
  assert.equal(back.target, s.target);
  assert.equal(back.location, "56");
  assert.equal(back.date, "2025-11-22");
  assert.deepEqual(back.sel.selected, sel.selected);
  assert.deepEqual(chartedBySlot(back.sel), chartedBySlot(sel));
  assert.equal(back.sel.showAll, true);
  assert.equal(back.sel.baseline, false);
  assert.deepEqual(back.levels, [0.8, 0.5]);
  assert.equal(back.rulers, true);
  assert.equal(back.focus, "CMU-ar");
  assert.equal(writeUrl(back, manifest), q, "writes the same URL again");
});

test("the charted list is written only when the model list alone wouldn't give it", () => {
  const sel = create({ selected: ["X-a", "X-b"] });
  assert.equal(writeUrl(state({ sel }), manifest), "?models=X-a,X-b");
  const off = unchart(sel, "X-a");
  assert.equal(writeUrl(state({ sel: off }), manifest), "?models=X-a,X-b&chart=,X-b");
  const none = fromLists({ selected: ["X-a"], charted: [] });
  assert.equal(writeUrl(state({ sel: none }), manifest), "?models=X-a&chart=");
  assert.deepEqual(roundTrip(state({ sel: none })).sel.charted, []);
});

test("an explicitly empty selection is models=none", () => {
  const empty = create({ selected: [] });
  assert.equal(writeUrl(state({ sel: empty }), manifest), "?models=none");
  assert.deepEqual(parseUrl("?models=none", manifest).sel.selected, []);
});

test("show all and the baseline switch without a model list apply to the starting selection", () => {
  assert.equal(writeUrl(state({ sel: create({ selected: D.sel.selected, showAll: true }) }), manifest), "?all=1");
  assert.deepEqual(parseUrl("?all=1&base=0", manifest).selFlags, { showAll: true, baseline: false });
  assert.equal(parseUrl("?all=1", manifest).sel, undefined);
});

test("invalid values are dropped", () => {
  const p = parseUrl("?target=nope&loc=99&date=garbage&models=X-a,ghost,FluSight-baseline&chart=ghost,X-a&pi=33&focus=ghost", manifest);
  assert.equal(p.target, undefined);
  assert.equal(p.location, undefined);
  assert.equal(p.date, undefined);
  assert.deepEqual(p.sel.selected, ["X-a"], "unknown ids and the baseline are not selectable");
  assert.deepEqual(chartedBySlot(p.sel), [null, "X-a"]);
  assert.equal(p.levels, undefined);
  assert.equal(p.focus, undefined);
});

test("a date that isn't a round snaps to the nearest round", () => {
  assert.equal(parseUrl("?date=2025-12-20", manifest).date, "2025-12-27");
  assert.equal(parseUrl("?date=2025-11-08", manifest).date, "2025-11-22", "ties go to the later round");
  assert.equal(parseUrl("?date=2019-01-01", manifest).date, "2024-11-23");
  assert.equal(nearestRound("2030-01-01", manifest), "2025-12-27");
  assert.equal(nearestRound("x", manifest), null);
});

test("old viz links", () => {
  assert.equal(parseUrl("?loc=25", manifest).location, "25");
  assert.deepEqual(parseUrl("?pi=95,80", manifest).levels, [0.95, 0.8]);
  assert.deepEqual(parseUrl("?pi=50,95,33", manifest).levels, [0.95, 0.5], "sorted widest first; unknown levels dropped");
  assert.deepEqual(parseUrl("?pi=none", manifest).levels, []);
  assert.deepEqual(parseUrl("?pi=0", manifest).levels, []);
  assert.deepEqual(parseUrl("?models=none", manifest).sel.selected, []);
  assert.equal(parseUrl("?rulers=1", manifest).rulers, true);
  assert.equal(parseUrl("?rulers=yes", manifest).rulers, false);
  assert.equal(parseUrl("?target=wk+inc+flu+prop+ed+visits", manifest).target, "wk inc flu prop ed visits", "spaces as +");
  assert.equal(writeUrl(state({ levels: [] }), manifest), "?pi=none");
  assert.equal(writeUrl(state({ levels: [0.95] }), manifest), "", "the default stays out of the URL");
  assert.equal(writeUrl(state({ levels: [0.95, 0.8, 0.5] }), manifest), "?pi=95,80,50");
});

test("unknown parameters are preserved, after this module's own", () => {
  const q = writeUrl(state({ location: "25" }), manifest, "?view=heatmap&loc=US&hm_rows=model");
  assert.equal(q, "?loc=25&view=heatmap&hm_rows=model");
  assert.equal(writeUrl(base, manifest, "?view=peak"), "?view=peak");
});

test("the view sections' settings round-trip through hm, mp and pk", () => {
  const views = {
    heatmap: { rows: "model", cols: "date", metric: "wis", sort: "score", scale: "row", horizon: 2, model: "truth" },
    map: { layer: "error", horizon: 3 },
    peaks: { sort: "high", rev: true, scope: "states", layer: "size" },
  };
  const d = defaults(manifest);
  const qs = writeUrl({ ...d, views }, manifest);
  assert.match(qs, /hm=model,date,wis,score,row,2,truth/);
  assert.match(qs, /pk=-high,states,size/);
  assert.deepEqual(parseUrl(qs, manifest).views, views);
  assert.equal(writeUrl({ ...d, views: { heatmap: null } }, manifest), "");
});

test("hub URL parameter validates against workspace_hubs and stays omitted on single-hub defaults", () => {
  const single = indexManifest({
    ...manifest,
    hub_id: "flusight",
    workspace_hubs: [{ id: "flusight", label: "FluSight" }],
  });
  const multi = indexManifest({
    ...manifest,
    hub_id: "flusight",
    workspace_hubs: [{ id: "flusight", label: "FluSight" }, { id: "covid", label: "COVID-19" }],
  });

  assert.equal(parseUrl("?hub=flusight", single).hub, "flusight");
  assert.equal(parseUrl("?hub=unknown_hub", single).hub, undefined);
  assert.equal(parseUrl("?hub=covid", multi).hub, "covid");

  const dSingle = defaults(single);
  assert.equal(writeUrl({ ...dSingle, hub: "flusight" }, single), "", "single-hub default stays clean");

  const dMulti = defaults(multi);
  const qMulti = writeUrl({ ...dMulti, hub: "covid" }, multi);
  assert.equal(qMulti, "?hub=covid");
  assert.equal(parseUrl(qMulti, multi).hub, "covid");
});
