import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Fan, addMonthsUtc, decodeFan, indexManifest } from "../../lib/api.js";
import { horizonText, horizonUnit, valueFormat } from "../../lib/format.js";
import { ISO_NUM_TO_ALPHA2 } from "../../geo/eu_tiles.js";
import { classifyHubGeo } from "../../geo/picker_geo.js";
import { decodeArcs, extractLonLatFeatures, extractMesh, extractPolygons } from "../../geo/topo.js";
import { isAllowedHubversePath } from "../../features/WebUpload.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GEO_DIR = path.resolve(HERE, "../../geo");

function encodeFanV2(head, floatValues) {
  const headBytes = Buffer.from(JSON.stringify(head), "utf8");
  const pad = (-headBytes.length % 4 + 4) % 4;
  const hLen = headBytes.length + pad;
  const buf = Buffer.alloc(8 + hLen + floatValues.length * 4, 0x20);
  buf.write("VZF2", 0, "ascii");
  buf.writeUInt32LE(hLen, 4);
  headBytes.copy(buf, 8);
  floatValues.forEach((v, i) => buf.writeFloatLE(v, 8 + hLen + i * 4));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe("International Hubverse frontend support", () => {
  it("addMonthsUtc and Fan handle monthly time_unit and 35-day anchor bridges cleanly", () => {
    const tJan = Date.UTC(2025, 0, 31);
    assert.equal(new Date(addMonthsUtc(tJan, 1)).toISOString().slice(0, 10), "2025-02-28");
    assert.equal(new Date(addMonthsUtc(Date.UTC(2025, 9, 1), -2)).toISOString().slice(0, 10), "2025-08-01");

    const buf = encodeFanV2(
      {
        version: 2,
        target: "mo inc dengue cases",
        season: "2025-2026",
        location: "CN",
        start: "2025-07-01",
        end: "2026-06-30",
        time_unit: "month",
        horizon_offset_days: 0,
        rounds: ["2025-08-01", "2025-09-01", "2025-10-01"],
        horizons: [0, 1, 2],
        quantiles: [0.5],
        observed: { dates: ["2025-08-01", "2025-09-01"], offset: 0, length: 2 },
        models: [{ id: "CNCovidHub-ensemble", offset: 2, rounds: [2], horizons: [1, 2] }],
      },
      [410, 520, 610, 680],
    );
    const fan = decodeFan(buf);
    assert.ok(fan instanceof Fan);
    assert.equal(fan.timeUnit, "month");
    assert.equal(fan.dates.length, 3);
    assert.equal(fan.indexOf("2025-10-01"), 2);

    const pts = fan.points("CNCovidHub-ensemble", 2, 0.5);
    assert.equal(pts.length, 2);
    assert.equal(new Date(pts[0].t).toISOString().slice(0, 10), "2025-11-01");
    assert.equal(pts[0].med, 610);
  });

  it("monthly Fan bridges a 1-month observed anchor before first forecast point", () => {
    const buf = encodeFanV2(
      {
        version: 2,
        target: "mo inc dengue cases",
        season: "2025-2026",
        location: "CN",
        start: "2025-07-01",
        end: "2026-06-30",
        time_unit: "month",
        rounds: ["2025-09-01", "2025-10-01"],
        horizons: [0, 1],
        quantiles: [0.5],
        observed: { dates: ["2025-09-01", "2025-10-01"], offset: 0, length: 2 },
        models: [{ id: "m1", offset: 2, rounds: [1], horizons: [1] }],
      },
      [500, 580, 640],
    );
    const fan = decodeFan(buf);
    const pts = fan.points("m1", 1, 0);
    assert.equal(pts.length, 2);
    assert.equal(pts[0].anchor, true);
    assert.equal(pts[0].med, 580);
    assert.equal(new Date(pts[1].t).toISOString().slice(0, 10), "2025-11-01");
    assert.equal(pts[1].med, 640);
  });

  it("valueFormat and horizon labels handle R_t rates, percentages, and months", () => {
    const rtFmt = valueFormat({ scale: "rate", unit: "R\u209c" });
    assert.equal(rtFmt.value(0.964), "0.96");
    assert.equal(rtFmt.value(1.042), "1.04");
    assert.equal(valueFormat({ scale: "percentage" }).value(9.72), "9.72%");
    assert.equal(valueFormat({ scale: "percentage" }).value(33.24), "33.2%");

    const moTarget = { time_unit: "month" };
    assert.equal(horizonUnit(moTarget), "mo");
    assert.equal(horizonUnit(moTarget, true), "months");
    assert.equal(horizonText(0, moTarget), "this month");
    assert.equal(horizonText(2, moTarget), "2 mo ahead");
    assert.equal(horizonText(-1, { time_unit: "week" }), "-1 wk ahead");
  });

  it("classifyHubGeo identifies ca-provinces, ca-ontario, cd-provinces, and cn-national cleanly", () => {
    const caMan = indexManifest({
      locations: [
        { id: "ca", name: "Canada", level: "country", canonical_id: "CA", is_aggregate: true },
        { id: "atlantic", name: "Atlantic", level: "region", canonical_id: "CA:atlantic", parent_id: "ca", is_aggregate: true },
        { id: "on", name: "Ontario", level: "province", canonical_id: "CA:ON", parent_id: "ca" },
        { id: "nl", name: "Newfoundland and Labrador", level: "province", canonical_id: "CA:NL", parent_id: "atlantic" },
      ],
      targets: [{ id: "pct wk flu lab det" }],
      seasons: [{ id: "2025-2026", rounds: ["2025-11-15"] }],
      models: [],
    });
    const caCls = classifyHubGeo(caMan);
    assert.equal(caCls.kind, "ca-provinces");
    assert.equal(caCls.aggregateId, "ca");

    const onMan = indexManifest({
      locations: [
        { id: "Ontario", level: "province", canonical_id: "CA:ON", is_aggregate: true },
        { id: "Toronto", level: "region", canonical_id: "CA:ON:Toronto", parent_id: "Ontario" },
        { id: "Central", level: "region", canonical_id: "CA:ON:Central", parent_id: "Ontario" },
      ],
      targets: [{ id: "wk inc flu hosp" }],
      seasons: [{ id: "2025-2026", rounds: ["2025-11-15"] }],
      models: [],
    });
    assert.equal(classifyHubGeo(onMan).kind, "ca-ontario");

    const cdMan = indexManifest({
      locations: [
        { id: "CD", name: "DRC", level: "country", canonical_id: "CD", is_aggregate: true },
        { id: "CD-BU", name: "Bas Uele", level: "province", canonical_id: "CD:CD-BU", parent_id: "CD", is_aggregate: true },
        { id: "CD-BU-01", name: "Aketi", level: "health_zone", canonical_id: "CD:CD-BU-01", parent_id: "CD-BU" },
      ],
      targets: [{ id: "wk inc confirmed cases" }],
      seasons: [{ id: "2025-2026", rounds: ["2025-10-12"] }],
      models: [],
    });
    const cdCls = classifyHubGeo(cdMan);
    assert.equal(cdCls.kind, "cd-provinces");
    assert.equal(cdCls.hasHealthZones, true);
    assert.equal(cdCls.drcProvinceOf("CD-BU-01"), "CD-BU");
    assert.equal(cdCls.drcZonesByProvince.get("CD-BU").length, 1);

    const cnMan = indexManifest({
      locations: [{ id: "CN", name: "China", level: "country", canonical_id: "CN" }],
      targets: [{ id: "wk inc flu prop ili" }],
      seasons: [{ id: "2025-2026", rounds: ["2025-11-01"] }],
      models: [],
    });
    assert.equal(classifyHubGeo(cnMan).kind, "cn-national");
  });

  it("maps ISO numeric codes for Canada/China/DRC, allows nested upload paths, and validates new TopoJSON assets", () => {
    assert.equal(ISO_NUM_TO_ALPHA2["124"], "CA");
    assert.equal(ISO_NUM_TO_ALPHA2["156"], "CN");
    assert.equal(ISO_NUM_TO_ALPHA2["180"], "CD");

    assert.equal(
      isAllowedHubversePath("target-data/season_2025_2026/hospitalization-data.csv"),
      "target-data/season_2025_2026/hospitalization-data.csv",
    );
    assert.equal(
      isAllowedHubversePath("auxiliary-data/concatenated_rvdss_data.csv"),
      "auxiliary-data/concatenated_rvdss_data.csv",
    );
    assert.equal(
      isAllowedHubversePath("model-metadata/CNCovidHub-ensemble.yaml"),
      "model-metadata/CNCovidHub-ensemble.yaml",
    );
    assert.equal(
      isAllowedHubversePath("model-output/InsightNet-epinow2/2025-10-12-InsightNet-epinow2.parquet"),
      "model-output/InsightNet-epinow2/2025-10-12-InsightNet-epinow2.parquet",
    );

    for (const [file, objKey, expectedCount, expectedMinMesh] of [
      ["ca-provinces.json", "provinces", 13, 50],
      ["ca-ontario-oh.json", "regions", 6, 50],
      ["cd-provinces.json", "provinces", 26, 200],
    ]) {
      const topo = JSON.parse(fs.readFileSync(path.join(GEO_DIR, file), "utf8"));
      const decoded = decodeArcs(topo);
      const polys = extractPolygons(topo, objKey);
      const lonlat = extractLonLatFeatures(topo, objKey, decoded);
      const mesh = extractMesh(topo, objKey);
      assert.equal(polys.length, expectedCount, `${file} polygons`);
      assert.equal(lonlat.size, expectedCount, `${file} 2D features`);
      assert.ok(mesh.length >= expectedMinMesh, `${file} mesh segments`);
      for (const f of polys) {
        assert.ok(f.id, `${file} feature missing id`);
        assert.ok(Number.isFinite(f.centroidLonLat[0]) && Number.isFinite(f.centroidLonLat[1]));
      }
    }
  });
});
