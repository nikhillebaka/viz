// The model picker's pure logic: typed search, filter values, variant lines, name parts, rail filters, sets, and the bottom section.
// Uses a small manifest shaped like the real one (core/next_api.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { indexManifest } from "../../lib/api.js";
import * as S from "../../features/selection.js";
import { browse, nameParts, linesOf, rowLine, designatedMarks, catalog, parseQuery, facetsOf } from "../../features/ModelPicker.js";

const H = "wk inc flu hosp";
const model = (id, o = {}) => ({
  id, abbr: id.replace(/^.*?:/, "").replace(/^[^-]+-/, ""), team: id.replace(/^.*?:/, "").split("-")[0], team_name: "",
  family: "", source: "repo", hub: null, designated: false, seasons: ["2025-2026"], targets: [H], kind: "individual", inputs: [], ...o,
});
const M = indexManifest({
  hub: "test", default_target: H, baseline: "FluSight-baseline", recommended: ["UMass-gbqr_1src"],
  targets: [{ id: H }],
  seasons: [{ id: "2025-2026", label: "2025–26", rounds: ["2025-11-22"], start: "2025-08-01", end: "2026-07-31" }],
  hubs: [{ id: "flusight", label: "CDC FluSight", short_label: "FluSight" }],
  locations: [],
  models: [
    model("FluSight-baseline", { family: "Baseline" }),
    model("UMass-gbqr_1src", { family: "GBQR", inputs: ["NHSN admissions"], name: "GBQR with NHSN" }),
    model("UMass-gbqr_4src_spatial", { family: "GBQR", inputs: ["NHSN admissions", "NSSP ED visits"] }),
    model("UMass-gbqr_4src", { family: "GBQR", inputs: ["NHSN admissions", "NSSP ED visits"] }),
    model("UMass-gbqr_old", { family: "GBQR", seasons: ["2024-2025"] }),
    model("UMass-AR2", { family: "AR" }),
    model("flusight:CU-ensemble", { source: "hub", hub: "flusight", team: "CU", kind: "ensemble", designated: true }),
    model("flusight:CU-base", { source: "hub", hub: "flusight", team: "CU" }),
    model("flusight:ZTeam-alpha", { source: "hub", hub: "flusight", team: "ZTeam", designated: true }),
  ],
});
const items = (g) => g.groups.flatMap((x) => x.items);

test("name parts: split at _, without a leading part that is the family", () => {
  assert.deepEqual(nameParts({ abbr: "gbqr_4src_spatial", family: "GBQR" }), ["4src", "spatial"]);
  assert.deepEqual(nameParts({ abbr: "AR2_nc_none", family: "AR" }), ["AR2", "nc", "none"]);
  assert.deepEqual(nameParts({ abbr: "gbqr", family: "GBQR" }), ["gbqr"]);
});

test("lines: three or more of one team and family from one source", () => {
  const { lines } = linesOf(M, catalog(M, H));
  assert.deepEqual([...lines.values()].map((l) => [l.title, l.ids.length]), [["GBQR", 4]]);
});

test("browse: sections by source; a line holds its shown variants and the parts that tell them apart", () => {
  const g = browse(M, { target: H, season: "2025-2026" });
  assert.deepEqual(g.groups.map((x) => x.title), ["This repo", "FluSight"]);
  const line = items(g).find((x) => x.type === "line");
  assert.equal(line.all, 3, "the one not in season is not in the line");
  assert.deepEqual(line.parts.map((p) => p.part), ["4src", "1src", "spatial"]);
  assert.deepEqual(g.away.ids, ["UMass-gbqr_old"]);
  assert.equal(g.away.title, "Not in 2025–26");
});

test("browse: chosen parts narrow a line; rail filters any-of within, all-of across; counts skip their own filter", () => {
  const key = [...linesOf(M, catalog(M, H)).lines.keys()][0];
  const g = browse(M, { target: H, season: "2025-2026", parts: new Map([[key, new Set(["4src"])]]) });
  assert.deepEqual(items(g).find((x) => x.type === "line").ids.sort(), ["UMass-gbqr_4src", "UMass-gbqr_4src_spatial"]);
  const f = (o) => ({ source: new Set(), kind: new Set(), input: new Set(), family: new Set(), team: new Set(), ...o });
  const nssp = browse(M, { target: H, season: "2025-2026", filters: f({ input: new Set(["NSSP ED visits"]) }) });
  assert.equal(nssp.shown, 2);
  assert.equal(nssp.counts.input.get("NHSN admissions"), 3, "Data counts ignore the Data filter");
  assert.equal(browse(M, { target: H, season: "2025-2026", filters: f({ source: new Set(["FluSight"]), kind: new Set(["Ensemble"]) }) }).shown, 1);
});

test("sets: designated, recommended, selected", () => {
  const sel = S.create({ selected: ["UMass-AR2"] });
  const g = (set) => browse(M, { target: H, season: "2025-2026", set, sel }).ids;
  assert.deepEqual(g("designated").sort(), ["flusight:CU-ensemble", "flusight:ZTeam-alpha"]);
  assert.deepEqual(g("recommended"), ["UMass-gbqr_1src"]);
  assert.deepEqual(g("selected"), ["UMass-AR2"]);
});

test("rows: the readable name when there is one; designated marked only where it tells a team's models apart", () => {
  assert.equal(rowLine(M.modelById.get("UMass-gbqr_1src")), "GBQR with NHSN");
  assert.equal(rowLine(M.modelById.get("flusight:CU-ensemble")), "CU · ensemble");
  const d = designatedMarks(M);
  assert.ok(d.has("flusight:CU-ensemble"));
  assert.ok(!d.has("flusight:ZTeam-alpha"), "ZTeam's only model");
});

test("typed search: key:value; an unknown key is a word", () => {
  assert.deepEqual(parseQuery("team:umass gbqr data:nssp"), { words: ["gbqr"], tokens: [{ key: "team", value: "umass" }, { key: "input", value: "nssp" }] });
  assert.deepEqual(parseQuery("foo:bar").words, ["foo:bar"]);
  const ids = (q) => browse(M, { target: H, season: "2025-2026", query: q }).ids;
  assert.deepEqual(ids("team:cu").sort(), ["flusight:CU-base", "flusight:CU-ensemble"]);
  assert.ok(ids("team:u").length && !ids("team:u").some((id) => id.includes("CU-")), "from the start of a word: team:u is UMass, not CU");
});

test("filter values: source, a family of one is Other, kind, data or Not stated", () => {
  const f = facetsOf(M, M.modelById.get("flusight:CU-ensemble"));
  assert.deepEqual(f.source, ["FluSight"]);
  assert.deepEqual(f.kind, ["Ensemble"]);
  assert.deepEqual(f.input, ["Not stated"]);
  assert.deepEqual(catalog(M, H).facets.get("UMass-AR2").family, ["Other"], "AR has one model here");
});
