import { test } from "node:test";
import assert from "node:assert/strict";
import { safeHref } from "../../lib/dom.js";
import {
  MAX_METADATA_FILE_BYTES,
  isAllowedHubversePath,
  normalizeSelectedFiles,
  validateFolderSelection,
} from "../../features/WebUpload.js";
import { parseUrl } from "../../features/url.js";
import { indexManifest } from "../../lib/api.js";
import { sortSpecFor, sortRows, exportRows } from "../../sections/scores/model.js";

test("safeHref permits safe http/https URLs and blocks javascript/data/protocol-relative schemes", () => {
  assert.equal(safeHref("https://example.edu/path?a=1"), "https://example.edu/path?a=1");
  assert.equal(safeHref("http://localhost:8501/next/"), "http://localhost:8501/next/");
  assert.equal(safeHref("/oauth2/start?rd=/", { allowRelative: true }), "/oauth2/start?rd=/");
  assert.equal(safeHref("/oauth2/start?rd=/", { allowRelative: false }), null);

  for (const bad of [
    "javascript:alert(1)",
    "  JAVASCRIPT:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "//evil.example.com/phish",
    "https://example.edu/\nHeader: x",
    "",
    null,
  ]) {
    assert.equal(safeHref(bad, { allowRelative: true }), null, `expected null for ${String(bad)}`);
  }
});

test("WebUpload rejects viz.config.json, >64KB metadata files, and target-data-only uploads", () => {
  assert.equal(isAllowedHubversePath("viz.config.json"), null);

  const targetOnly = normalizeSelectedFiles([
    { webkitRelativePath: "my-hub/hub-config/tasks.json", size: 200 },
    { webkitRelativePath: "my-hub/target-data/oracle-output.csv", size: 500 },
  ]);
  assert.equal(targetOnly.valid, false);
  assert.match(targetOnly.error, /model-output/i);

  const bigMeta = normalizeSelectedFiles([
    { webkitRelativePath: "my-hub/hub-config/tasks.json", size: 200 },
    { webkitRelativePath: "my-hub/model-metadata/Team-A.yml", size: MAX_METADATA_FILE_BYTES + 1 },
    { webkitRelativePath: "my-hub/model-output/Team-A/2025-11-22-Team-A.csv", size: 400 },
  ]);
  assert.equal(bigMeta.valid, true);
  const check = validateFolderSelection(bigMeta);
  assert.equal(check.ok, false);
  assert.match(check.error, /exceeds/i);
});

test("URL ?pl=US is ignored on non-US hubs and extended/negative horizon sort/export columns work", () => {
  const canadaManifest = indexManifest({
    hub: "Canada RVDSS",
    targets: [{ id: "flu_pos", name: "Flu", horizons: { required: [-1, 0, 1, 2, 3, 4, 5], optional: [] } }],
    locations: [
      { id: "CA", abbr: "CA", name: "Canada", level: "country" },
      { id: "CA-ON", abbr: "ON", name: "Ontario", level: "province" },
    ],
    seasons: [{ id: "2025-2026", label: "2025–26", start: "2025-08-01", end: "2026-07-31" }],
    rounds: ["2025-11-22"],
    baseline: "Base",
    models: [
      { id: "Base", team: "Base", abbr: "B", recommended: false },
      { id: "ModelA", team: "T", abbr: "A", recommended: true },
    ],
  });

  const nonUs = parseUrl("?pl=US&cols=h5,h-1&sort=-h5", canadaManifest);
  assert.equal(nonUs.scope?.place, undefined);
  assert.deepEqual(nonUs.scores?.cols, ["h5", "h-1"]);
  assert.equal(nonUs.scores?.sort, "h5");
  assert.equal(nonUs.scores?.rev, true);

  const catSort = parseUrl("?sort=-rps", canadaManifest);
  assert.equal(catSort.scores?.sort, "rps");
  assert.equal(catSort.scores?.rev, true);

  assert.equal(sortSpecFor("h5").score, true);
  const rows = [
    { id: "A", label: "A", active: true, byH: { 5: { rel: 1.2 } } },
    { id: "B", label: "B", active: true, byH: { 5: { rel: 0.7 } } },
  ];
  const sorted = sortRows(rows, "h5", false);
  assert.deepEqual(sorted.ranked.map((r) => r.id), ["B", "A"]);

  const exported = exportRows(
    {
      baseline_model: "Base",
      rankings: [
        { model_id: "Base", has_data_in_scope: true, count: 10, wis: 10, relative_wis: 1.0, by_horizon: { "-1": { wis: 5 }, 0: { wis: 8 }, 5: { wis: 14 } } },
        { model_id: "ModelA", has_data_in_scope: true, count: 10, wis: 8, relative_wis: 0.8, by_horizon: { "-1": { wis: 4 }, 0: { wis: 7 }, 5: { wis: 11 } } },
      ],
    },
    {
      order: ["ModelA", "Base"],
      ranks: new Map([["ModelA", 1], ["Base", 2]]),
      scope: { location: "CA", seasons: ["2025-2026"], rank: "all", scale: "natural", fair: false, baseline: "Base" },
      target: "flu_pos",
      scopeLabel: "All provinces",
      sourceOf: () => "hub",
    },
  );
  assert.equal(exported[0]["h-1_wis"], 4);
  assert.equal(exported[0].h5_wis, 11);
});
