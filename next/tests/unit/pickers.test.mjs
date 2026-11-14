// The pickers' pure logic: model sections, search, row sub lines, panel width; location search and
// tile-map navigation. Runs on a small manifest shaped like the real one (core/next_api.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { indexManifest } from "../../lib/api.js";
import * as S from "../../features/selection.js";
import { groupModels, subLine, panelWidth, ONE_COLUMN_MAX, catalog, matcher } from "../../features/ModelPicker.js";
import { TILES, COLUMNS, matchLocations, tileNeighbor, nextRecent } from "../../features/LocationPicker.js";

const H = "wk inc flu hosp", ED = "wk inc flu prop ed visits";
const model = (id, o = {}) => ({
  id, abbr: id.replace(/^.*?:/, "").replace(/^[^-]+-/, ""), team: id.replace(/^.*?:/, "").split("-")[0], team_name: "",
  family: "", source: "repo", hub: null, designated: false, seasons: ["2024-2025", "2025-2026"], targets: [H], ...o,
});
const M = indexManifest({
  hub: "test", default_target: H, baseline: "FluSight-baseline", recommended: [],
  targets: [{ id: H }, { id: ED }],
  seasons: [
    { id: "2024-2025", label: "2024–25", rounds: ["2024-11-23", "2024-11-30"], start: "2024-08-01", end: "2025-07-31" },
    { id: "2025-2026", label: "2025–26", rounds: ["2025-11-22", "2025-11-29"], start: "2025-08-01", end: "2026-07-31" },
  ],
  hubs: [{ id: "flusight", label: "CDC FluSight", short_label: "FluSight" }],
  locations: [],
  models: [
    model("FluSight-baseline", { family: "Baseline", targets: [H, ED] }),
    model("UMass-gbqr", { family: "GBQR", team_name: "UMass-Amherst" }),
    model("UMass-gbqr_1src", { family: "GBQR" }),
    model("UMass-gbqr_2src", { family: "GBQR" }),
    model("UMass-gbqr_10src", { family: "GBQR", seasons: ["2024-2025"] }),
    model("UMass-AR2", { family: "AR" }),
    model("UMass-AR6", { family: "AR" }),
    model("UMass-AR6_pooled", { family: "AR" }),
    model("UMass-chronos_small", { family: "Chronos" }),
    model("UMass-trends_ensemble", { family: "Ensemble" }),
    model("UMass-flu_ed", { family: "Flu", targets: [ED] }),
    model("me-test_run", { source: "local", family: "Transformer" }),
    model("ens-mean", { source: "synthetic", family: "Ensemble" }),
    model("flusight:FluSight-ensemble", { source: "hub", hub: "flusight", team: "FluSight", team_name: "FluSight-ensemble", family: "Ensemble" }),
    model("flusight:ZTeam-alpha", { source: "hub", hub: "flusight", team: "ZTeam", designated: true }),
    model("flusight:ATeam-beta", { source: "hub", hub: "flusight", team: "ATeam", team_name: "A Team University" }),
    model("flusight:ATeam-alpha", { source: "hub", hub: "flusight", team: "ATeam" }),
    model("flusight:UMass-gbqr", { source: "hub", hub: "flusight", team: "UMass", family: "GBQR", designated: true }),
  ],
});
const titles = (g) => g.sections.map((s) => s.title);
const sec = (g, key) => g.sections.find((s) => s.key === key);

test("listing: the baseline never, models for other targets neither", () => {
  const c = catalog(M, H);
  assert.ok(!c.ids.includes("FluSight-baseline"));
  assert.ok(!c.ids.includes("UMass-flu_ed"));
  assert.equal(c.ids.length, 16);
  assert.ok(catalog(M, ED).ids.includes("UMass-flu_ed"));
});

test("sections: Local, families by size, Other, hubs, Not in <season>", () => {
  const g = groupModels(M, { target: H, season: "2025-2026" });
  assert.deepEqual(titles(g), ["Local", "GBQR", "AR", "Other", "FluSight", "Not in 2025–26"]);
  assert.deepEqual(sec(g, "local").ids, ["ens-mean", "me-test_run"]);
  // alphabetical by name, numbers in order; the absent one sank
  assert.deepEqual(sec(g, "family:GBQR").ids, ["UMass-gbqr", "UMass-gbqr_1src", "UMass-gbqr_2src"]);
  assert.deepEqual(sec(g, "away").ids, ["UMass-gbqr_10src"]);
  assert.deepEqual(sec(g, "other").ids, ["UMass-chronos_small", "UMass-trends_ensemble"]);
  // the hub's own models first, then designated, then by team and name
  assert.deepEqual(sec(g, "hub:flusight").ids, ["flusight:FluSight-ensemble", "flusight:UMass-gbqr", "flusight:ZTeam-alpha", "flusight:ATeam-alpha", "flusight:ATeam-beta"]);
  assert.equal(g.total, 16);
});

test("sections: a family keeps its section in a season where fewer of it forecast", () => {
  const g = groupModels(M, { target: H, season: "2024-2025" });
  assert.equal(sec(g, "family:GBQR").ids.length, 4);
  assert.ok(!sec(g, "away"));
});

test("default collapse: hubs only when there is something of our own to see; Not in always", () => {
  const g = groupModels(M, { target: H, season: "2025-2026" });
  assert.equal(sec(g, "hub:flusight").defaultCollapsed, true);
  assert.equal(sec(g, "away").defaultCollapsed, true);
  assert.equal(sec(g, "family:GBQR").defaultCollapsed, false);
  // a season only the hub's models forecast in: the hub section opens
  const only = indexManifest({ ...M, models: M.models.map((m) => (m.source === "hub" ? { ...m, seasons: ["2026-2027"] } : m)),
    seasons: [...M.seasons, { id: "2026-2027", label: "2026–27", rounds: ["2026-11-14"], start: "2026-08-01", end: "2027-07-31" }] });
  const g2 = groupModels(only, { target: H, season: "2026-2027" });
  assert.deepEqual(titles(g2), ["FluSight", "Not in 2026–27"]);
  assert.equal(sec(g2, "hub:flusight").defaultCollapsed, false);
});

test("search: every word must match name, id, team, team name, family or source", () => {
  const ids = (q, sel) => groupModels(M, { target: H, season: "2025-2026", query: q, sel }).sections.flatMap((s) => s.ids);
  assert.deepEqual(ids("GBQR").sort(), ["UMass-gbqr", "UMass-gbqr_1src", "UMass-gbqr_2src", "UMass-gbqr_10src", "flusight:UMass-gbqr"].sort());
  assert.deepEqual(ids("umass 2src"), ["UMass-gbqr_2src"]);
  assert.deepEqual(ids("amherst"), ["UMass-gbqr"]);
  assert.deepEqual(ids("team university"), ["flusight:ATeam-beta"]);
  assert.deepEqual(ids("flusight alpha"), ["flusight:ZTeam-alpha", "flusight:ATeam-alpha"]);
  assert.deepEqual(ids("nothing-like-this"), []);
  // the set words
  assert.deepEqual(ids("designated"), ["flusight:UMass-gbqr", "flusight:ZTeam-alpha"]);
  assert.deepEqual(ids("local").sort(), ["ens-mean", "me-test_run"]);
  const sel = S.chart(S.create({ selected: ["UMass-AR2", "UMass-AR6"] }), "UMass-gbqr");
  assert.deepEqual(ids("selected", S.unchart(sel, "UMass-AR6")).sort(), ["UMass-AR2", "UMass-AR6", "UMass-gbqr"]);
  assert.deepEqual(ids("charted", S.unchart(sel, "UMass-AR6")).sort(), ["UMass-AR2", "UMass-gbqr"]);
  assert.deepEqual(ids("charted ar", S.unchart(sel, "UMass-AR6")), ["UMass-AR2"]);
  assert.equal(matcher(M, catalog(M, H), "   ", null), null);
});

test("search: sections without matches vanish, Not in stays open-able", () => {
  const g = groupModels(M, { target: H, season: "2025-2026", query: "10src" });
  assert.deepEqual(titles(g), ["Not in 2025–26"]);
});

test("display names: unique among the listed models", () => {
  const g = groupModels(M, { target: H, season: "2025-2026" });
  assert.equal(g.labels.get("UMass-gbqr"), "UMass-gbqr");
  assert.equal(g.labels.get("flusight:UMass-gbqr"), "UMass-gbqr · FluSight");
  assert.equal(g.labels.get("UMass-AR2"), "AR2");
  assert.equal(g.labels.get("flusight:ZTeam-alpha"), "ZTeam-alpha");
});

test("sub lines: facts, never the section's title or what the name says", () => {
  const sub = (id, title) => subLine(M, M.modelById.get(id), M.label(id, catalog(M, H).ids), title);
  assert.equal(sub("UMass-AR2", "AR"), "UMass");
  assert.equal(sub("UMass-AR2", "Not in 2025–26"), "UMass");                // the name starts with its family
  assert.equal(sub("UMass-trends_ensemble", "Not in 2025–26"), "UMass · Ensemble");
  assert.equal(sub("UMass-chronos_small", "Other"), "UMass");             // family is the name's first word
  assert.equal(sub("UMass-trends_ensemble", "Other"), "UMass · Ensemble");
  assert.equal(sub("me-test_run", "Local"), "me · Transformer");
  assert.equal(sub("ens-mean", "Local"), "ens · Ensemble");
  assert.equal(sub("flusight:ZTeam-alpha", "FluSight"), "designated");      // the name already says ZTeam
  assert.equal(sub("flusight:ATeam-beta", "FluSight"), "ATeam");
  assert.equal(sub("flusight:ATeam-beta", "Not in 2025–26"), "ATeam · FluSight");
  assert.equal(sub("flusight:FluSight-ensemble", "FluSight"), "FluSight");  // never empty
  assert.equal(sub("flusight:UMass-gbqr", "FluSight"), "designated");
});

test("panel width: half the viewport past 24 rows, else a quarter, at least --popover-width", () => {
  assert.equal(panelWidth(1440, ONE_COLUMN_MAX + 1, 16, 360), 696);
  assert.equal(panelWidth(1440, ONE_COLUMN_MAX, 16, 360), 360);
  assert.equal(panelWidth(2400, 5, 16, 360), 576);
});

test("tile map: every position on the 11 × 8 grid, no two tiles in one cell", () => {
  const cells = Object.values(TILES).map(([x, y]) => `${x},${y}`);
  assert.equal(new Set(cells).size, cells.length);
  assert.equal(cells.length, 52); // 50 states, DC and PR
  assert.ok(Object.values(TILES).every(([x, y]) => x >= 0 && x < COLUMNS && y >= 0 && y < 8));
});

test("tile map: arrows move to the nearest tile that way, within 45°", () => {
  const go = (ab, dir) => tileNeighbor(TILES, TILES[ab], { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir]);
  assert.equal(go("CA", "up"), "OR");
  assert.equal(go("CA", "right"), "UT");
  assert.equal(go("TX", "up"), "OK");
  assert.equal(go("AK", "down"), "WA");
  assert.equal(go("ME", "down"), "NH");
  assert.equal(go("MA", "right"), null);
  assert.equal(go("HI", "down"), null);
  assert.equal(go("PR", "left"), "FL");
  assert.equal(go("NY", "up"), "VT");
  assert.equal(go("WI", "up"), null);                 // nothing within 45°: up goes to the United States
  assert.equal(go("FL", "left"), "GA");
  assert.equal(tileNeighbor(TILES, [5, -1], [0, 1]), "IL"); // down from the United States, middle column
  assert.equal(tileNeighbor(TILES, [0, -1], [0, 1]), "AK");
});

test("location search: exact abbreviation first, then name prefixes, words, substrings", () => {
  const L = [
    { id: "US", abbr: "US", name: "United States" }, { id: "25", abbr: "MA", name: "Massachusetts" },
    { id: "23", abbr: "ME", name: "Maine" }, { id: "24", abbr: "MD", name: "Maryland" },
    { id: "01", abbr: "AL", name: "Alabama" }, { id: "36", abbr: "NY", name: "New York" },
    { id: "54", abbr: "WV", name: "West Virginia" }, { id: "51", abbr: "VA", name: "Virginia" },
  ];
  const ab = (q) => matchLocations(L, q).map((l) => l.abbr);
  assert.deepEqual(ab("ma"), ["MA", "ME", "MD", "AL"]);
  assert.deepEqual(ab("mass"), ["MA"]);
  assert.deepEqual(ab("york"), ["NY"]);
  assert.deepEqual(ab("virginia"), ["VA", "WV"]);
  assert.deepEqual(ab("us"), ["US", "MA"]);
  assert.deepEqual(ab("36"), ["NY"]);
  assert.deepEqual(ab(""), []);
  assert.deepEqual(ab("zz"), []);
});

test("recent places: the chosen one first, then the one left, distinct, four at most", () => {
  assert.deepEqual(nextRecent([], "25", "US"), ["25", "US"]);
  assert.deepEqual(nextRecent(["36", "25", "06", "48"], "25", "36"), ["25", "36", "06", "48"]);
  assert.deepEqual(nextRecent(["1", "2", "3", "4"], "5", "6"), ["5", "6", "1", "2"]);
});
