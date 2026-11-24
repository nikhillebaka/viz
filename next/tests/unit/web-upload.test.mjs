import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { apiUrl } from "../../lib/api.js";
import {
  isAllowedHubversePath,
  normalizeSelectedFiles,
  validateFolderSelection,
  buildVzb1Bytes,
} from "../../features/WebUpload.js";

test("isAllowedHubversePath enforces strict Hubverse directory and extension allowlist", () => {
  assert.equal(isAllowedHubversePath("hub-config/tasks.json"), "hub-config/tasks.json");
  assert.equal(isAllowedHubversePath("hub-config/admin.json"), "hub-config/admin.json");
  assert.equal(isAllowedHubversePath("model-metadata/Team-Mod.yml"), "model-metadata/Team-Mod.yml");
  assert.equal(
    isAllowedHubversePath("model-output/Team-Mod/2025-11-22-Team-Mod.parquet"),
    "model-output/Team-Mod/2025-11-22-Team-Mod.parquet",
  );
  assert.equal(isAllowedHubversePath("target-data/oracle-output.csv"), "target-data/oracle-output.csv");
  assert.equal(
    isAllowedHubversePath("auxiliary-data/target-data-archive/target-hospital-admissions_2025-11-01.csv"),
    "auxiliary-data/target-data-archive/target-hospital-admissions_2025-11-01.csv",
  );

  for (const bad of [
    "../secret.json",
    "/etc/passwd",
    "hub-config\\tasks.json",
    "hub-config/tasks.json\0.txt",
    ".git/HEAD",
    "README.md",
    "scripts/train.py",
    "model-output/Team-Mod/run.R",
    "model-output/synthetic/2025-11-22.parquet",
    "model-output/Team-Mod/nested/too-deep.parquet",
  ]) {
    assert.equal(isAllowedHubversePath(bad), null, `expected rejection for ${bad}`);
  }
});

test("normalizeSelectedFiles strips root folder name, filters noise, and flags structural errors", () => {
  const validFolder = normalizeSelectedFiles([
    { webkitRelativePath: "my-flu-hub/README.md", size: 500 },
    { webkitRelativePath: "my-flu-hub/.git/config", size: 200 },
    { webkitRelativePath: "my-flu-hub/hub-config/tasks.json", size: 1024 },
    { webkitRelativePath: "my-flu-hub/model-metadata/Team-Alpha.yml", size: 300 },
    { webkitRelativePath: "my-flu-hub/model-output/Team-Alpha/2025-11-22-Team-Alpha.parquet", size: 4096 },
    { webkitRelativePath: "my-flu-hub/target-data/oracle-output.csv", size: 800 },
  ]);
  assert.equal(validFolder.valid, true);
  assert.equal(validFolder.hubName, "my-flu-hub");
  assert.equal(validFolder.included.length, 4);
  assert.equal(validFolder.skippedCount, 2);
  assert.equal(validFolder.modelCount, 1);
  assert.equal(validFolder.totalBytes, 1024 + 300 + 4096 + 800);

  // Subfolder mistakenly chosen instead of hub root
  const wrongLevel = normalizeSelectedFiles([
    { webkitRelativePath: "hub-config/tasks.json", size: 1024 },
    { webkitRelativePath: "hub-config/admin.json", size: 256 },
  ]);
  assert.equal(wrongLevel.valid, false);
  assert.match(wrongLevel.error, /top-level hub folder/i);

  // Random non-Hubverse directory
  const unrelated = normalizeSelectedFiles([
    { webkitRelativePath: "photos/vacation.jpg", size: 10000 },
    { webkitRelativePath: "photos/notes.txt", size: 200 },
  ]);
  assert.equal(unrelated.valid, false);
  assert.match(unrelated.error, /does not match Hubverse/i);
});

test("validateFolderSelection enforces max file count and uncompressed byte cap", () => {
  const okSummary = { valid: true, included: [{}, {}], totalBytes: 5000 };
  assert.equal(validateFolderSelection(okSummary, { max_files: 10, max_uncompressed_bytes: 10000 }).ok, true);

  const tooMany = validateFolderSelection(okSummary, { max_files: 1, max_uncompressed_bytes: 10000 });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /Too many files/);

  const tooBig = validateFolderSelection(okSummary, { max_files: 10, max_uncompressed_bytes: 1000 });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /exceeds/);
});

test("buildVzb1Bytes emits exact little-endian VZB1 frame sequence", () => {
  const recA = { relPath: "hub-config/tasks.json", bytes: new Uint8Array([123, 125]) };
  const recB = { relPath: "target-data/oracle.csv", bytes: Buffer.from("a,b\n1,2\n") };
  const frame = buildVzb1Bytes([recA, recB]);
  const gz = zlib.gzipSync(frame);
  const raw = zlib.gunzipSync(gz);

  assert.equal(raw.subarray(0, 4).toString("utf8"), "VZB1");
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let pos = 4;

  const lenA = dv.getUint32(pos, true);
  pos += 4;
  assert.equal(raw.subarray(pos, pos + lenA).toString("utf8"), recA.relPath);
  pos += lenA;
  const bodyLenA = Number(dv.getBigUint64(pos, true));
  pos += 8;
  assert.deepEqual(raw.subarray(pos, pos + bodyLenA), Buffer.from(recA.bytes));
  pos += bodyLenA;

  const lenB = dv.getUint32(pos, true);
  pos += 4;
  assert.equal(raw.subarray(pos, pos + lenB).toString("utf8"), recB.relPath);
  pos += lenB;
  const bodyLenB = Number(dv.getBigUint64(pos, true));
  pos += 8;
  assert.equal(raw.subarray(pos, pos + bodyLenB).toString("utf8"), "a,b\n1,2\n");
  pos += bodyLenB;

  assert.equal(dv.getUint32(pos, true), 0);
  assert.equal(pos + 4, raw.length);
});

test("apiUrl leaves /api/web/* paths global (no workspace param appended)", () => {
  assert.equal(apiUrl("/api/web/status"), "/api/web/status");
  assert.equal(apiUrl("/api/web/upload"), "/api/web/upload");
});
