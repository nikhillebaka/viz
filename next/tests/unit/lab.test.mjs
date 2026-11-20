import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  arcsToUnitSphere,
  buildMetroOverlays,
  clipPolygonToHemisphere,
  clipPolylineToHemisphere,
  decodeArcs,
  extractLonLatFeatures,
  extractMesh,
  extractPolygons,
  lonLatToXYZ,
  makeRotationMatrix,
  pointInFlatRing,
  projectPoint,
  screenToLonLat,
  slerpLonLat,
  solveCameraForAnchor,
  splitDetachedTerritories,
} from "../../geo/topo.js";
import {
  EU_GRID_PROPORTIONED,
  EU_GRID_UNIFORM,
  EU_META,
  EU_TILES_PROPORTIONED,
  EU_TILES_PROPORTIONED_UK_SPLIT,
  EU_TILES_UNIFORM,
  EU_TILES_UNIFORM_UK_SPLIT,
  ISO_NUM_TO_ALPHA2,
  lookupPlaceMeta,
  validateTileLayout,
} from "../../geo/eu_tiles.js";
import {
  buildBriefingForPlace,
  buildPmfFixture,
  buildSpatialSnapshot,
  buildTrajectoriesFixture,
  deriveQuantilesFromTrajectories,
  metricForPlace,
  scorePmfEntry,
  verticalPmfSegments,
} from "../../lab/fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GEO_DIR = path.resolve(HERE, "../../geo");

describe("next/geo/topo.js + metrocast_hsas.json", () => {
  it("decodes quantized TopoJSON arcs, extracts polygons and deduplicates shared mesh edges", () => {
    const topo = {
      type: "Topology",
      transform: { scale: [1, 1], translate: [-10, 40] },
      arcs: [
        [[0, 0], [10, 0], [0, 10]],
        [[10, 10], [-10, 0], [0, -10]],
        [[10, 0], [10, 0], [0, 10], [-10, 0]],
      ],
      objects: {
        boxes: {
          type: "GeometryCollection",
          geometries: [
            { id: "A", type: "Polygon", arcs: [[0, 1]] },
            { id: "B", type: "Polygon", arcs: [[2]] },
          ],
        },
      },
    };
    const decoded = decodeArcs(topo);
    assert.equal(decoded.length, 3);
    assert.deepEqual(Array.from(decoded[0]), [-10, 40, 0, 40, 0, 50]);

    const arcs3 = arcsToUnitSphere(decoded);
    const polys = extractPolygons(topo, "boxes", arcs3);
    assert.equal(polys.length, 2);
    assert.equal(polys[0].id, "A");
    assert.ok(polys[0].rings[0].length >= 9);

    const meshAll = extractMesh(topo, "boxes", arcs3);
    assert.equal(meshAll.length, 3);
  });

  it("maps all 95 MetroCast HSAs onto us-counties-10m.json and dissolves interior borders cleanly", () => {
    const world = JSON.parse(fs.readFileSync(path.join(GEO_DIR, "world-countries-110m.json"), "utf8"));
    const us = JSON.parse(fs.readFileSync(path.join(GEO_DIR, "us-counties-10m.json"), "utf8"));
    const hsasData = JSON.parse(fs.readFileSync(path.join(GEO_DIR, "metrocast_hsas.json"), "utf8"));

    assert.equal(hsasData.states.length, 15);
    assert.equal(hsasData.hsas.length, 95);
    const totalCounties = hsasData.hsas.reduce((n, h) => n + h.counties.length, 0);
    assert.equal(totalCounties, 531);

    const countries = extractPolygons(world, "countries");
    const states = extractPolygons(us, "states");
    const usArcs = arcsToUnitSphere(decodeArcs(us));
    const { metroMesh, metroFeatures, coveredStates } = buildMetroOverlays(us, usArcs, hsasData);

    assert.equal(countries.length, 177);
    assert.equal(states.length, 56);
    assert.equal(coveredStates.size, 15);
    assert.equal(metroFeatures.length, 95);
    // MetroCast-only boundary mesh has far fewer segments than full 3,231-county interior mesh
    const fullCountyInterior = extractMesh(us, "counties", usArcs, (a, b) => a && b);
    assert.ok(metroMesh.length > 400 && metroMesh.length < fullCountyInterior.length * 0.4);
  });

  it("constructs orthonormal camera rotation matrix and round-trips screenToLonLat", () => {
    const lon = -71.8;
    const lat = 42.3;
    const R = makeRotationMatrix(lon, lat);
    const [wx, wy, wz] = lonLatToXYZ(lon, lat);
    const px = R[0] * wx + R[1] * wy + R[2] * wz;
    const py = R[3] * wx + R[4] * wy + R[5] * wz;
    const pz = R[6] * wx + R[7] * wy + R[8] * wz;
    assert.ok(Math.abs(px) < 1e-6);
    assert.ok(Math.abs(py) < 1e-6);
    assert.ok(Math.abs(pz - 1) < 1e-6);

    const picked = screenToLonLat(400, 300, 400, 300, 200, R);
    assert.ok(picked);
    assert.ok(Math.abs(picked[0] - lon) < 1e-3);
    assert.ok(Math.abs(picked[1] - lat) < 1e-3);
    assert.equal(screenToLonLat(10, 10, 400, 300, 200, R), null);
  });

  it("clips straddling polylines and polygons cleanly onto the sphere limb", () => {
    const R = makeRotationMatrix(0, 0);
    const arc = new Float32Array([
      ...lonLatToXYZ(-120, 0),
      ...lonLatToXYZ(0, 0),
      ...lonLatToXYZ(120, 0),
    ]);
    const runs = clipPolylineToHemisphere(arc, R);
    assert.equal(runs.length, 1);
    assert.ok(Math.hypot(runs[0][0], runs[0][1]) <= 1.001);

    const ring = new Float32Array([
      ...lonLatToXYZ(-110, 10),
      ...lonLatToXYZ(-20, 10),
      ...lonLatToXYZ(-20, -10),
      ...lonLatToXYZ(-110, -10),
    ]);
    const clipped = clipPolygonToHemisphere(ring, R);
    assert.ok(clipped && clipped.length >= 8);
    for (let i = 0; i < clipped.length; i += 2) {
      assert.ok(Math.hypot(clipped[i], clipped[i + 1]) <= 1.001);
    }

    assert.equal(pointInFlatRing(0, 0, [-1, -1, 1, -1, 1, 1, -1, 1]), true);
    assert.equal(pointInFlatRing(2, 0, [-1, -1, 1, -1, 1, 1, -1, 1]), false);
  });

  it("interpolates great-circle camera slerp cleanly", () => {
    const p0 = slerpLonLat([-71, 42], [10, 50], 0);
    const p1 = slerpLonLat([-71, 42], [10, 50], 1);
    const mid = slerpLonLat([-71, 42], [10, 50], 0.5);
    assert.ok(Math.abs(p0[0] + 71) < 1e-4 && Math.abs(p0[1] - 42) < 1e-4);
    assert.ok(Math.abs(p1[0] - 10) < 1e-4 && Math.abs(p1[1] - 50) < 1e-4);
    assert.ok(mid[0] > -71 && mid[0] < 10);
    assert.ok(mid[1] > 42);
  });

  it("stitches dissolved exterior HSA polygons (3D + 2D lon/lat) with zero open rings", () => {
    const us = JSON.parse(fs.readFileSync(path.join(GEO_DIR, "us-counties-10m.json"), "utf8"));
    const hsasData = JSON.parse(fs.readFileSync(path.join(GEO_DIR, "metrocast_hsas.json"), "utf8"));
    const decoded = decodeArcs(us);
    const usArcs = arcsToUnitSphere(decoded);
    const { metroFeatures } = buildMetroOverlays(us, usArcs, hsasData, decoded);
    const stateLonLat = extractLonLatFeatures(us, "states", decoded);

    assert.equal(metroFeatures.length, 95);
    let totalRings = 0;
    for (const h of metroFeatures) {
      assert.ok(h.rings.length >= 1, `${h.id} missing 3D exterior rings`);
      assert.equal(h.lonLatRings.length, h.rings.length, `${h.id} 2D/3D ring count mismatch`);
      totalRings += h.rings.length;
    }
    // Merged across 531 counties into <= 160 closed exterior polygons (Boston merges 7 counties)
    assert.ok(totalRings >= 95 && totalRings <= 165);
    const boston = metroFeatures.find((m) => m.id === "boston");
    assert.ok(boston && boston.rings.length < 7);
    assert.ok(stateLonLat.get("25")?.length >= 1);
  });

  it("pins cursor world coordinates accurately across cursor-anchored zoom jumps", () => {
    const cx = 640, cy = 430, baseR = 360;
    const sx = 760, sy = 380;
    const cam0 = [-94, 38.5];
    const R0 = makeRotationMatrix(cam0[0], cam0[1]);
    const hit = screenToLonLat(sx, sy, cx, cy, baseR * 2.0, R0);
    assert.ok(hit);

    for (const nextZoom of [25.0, 4.0]) {
      const anchored = solveCameraForAnchor(hit[0], hit[1], sx, sy, cx, cy, baseR * nextZoom, cam0[0], cam0[1]);
      assert.ok(anchored, `Failed anchor solve at zoom ${nextZoom}`);
      const R1 = makeRotationMatrix(anchored[0], anchored[1]);
      const [wx, wy, wz] = lonLatToXYZ(hit[0], hit[1]);
      const p1 = projectPoint(wx, wy, wz, R1);
      assert.ok(p1.pz > 0);
      const sx1 = cx + p1.px * baseR * nextZoom;
      const sy1 = cy - p1.py * baseR * nextZoom;
      assert.ok(Math.hypot(sx1 - sx, sy1 - sy) < 1e-2, `Anchor error too high: ${Math.hypot(sx1 - sx, sy1 - sy)}`);
    }
  });

  it("detaches overseas territories (French Guiana, Svalbard) from European country polygons", () => {
    const world = JSON.parse(fs.readFileSync(path.join(GEO_DIR, "world-countries-110m.json"), "utf8"));
    const countries = extractPolygons(world, "countries").map((f) => ({
      ...f,
      iso2: ISO_NUM_TO_ALPHA2[String(f.id).padStart(3, "0")] || ISO_NUM_TO_ALPHA2[String(f.id)] || null,
    }));
    const euBox = { minLon: -26, maxLon: 45, minLat: 33, maxLat: 73 };
    const boundsByIso = Object.fromEntries(Object.keys(EU_META).map((iso) => [iso, euBox]));
    const split = splitDetachedTerritories(countries, boundsByIso);

    const fr = split.find((c) => c.iso2 === "FR");
    const no = split.find((c) => c.iso2 === "NO");
    const detached = split.filter((c) => c.detached);

    assert.ok(fr && fr.rings.length === 2); // Mainland + Corsica only
    assert.ok(no && no.rings.length === 1); // Mainland Norway only
    assert.equal(detached.length, 4);        // French Guiana + 3 Svalbard islands
    for (const d of detached) assert.equal(d.iso2, null);
  });
});

describe("next/geo/eu_tiles.js", () => {
  it("validates zero overlaps and bounds across all EU tile layouts", () => {
    for (const [tiles, grid] of [
      [EU_TILES_PROPORTIONED, EU_GRID_PROPORTIONED],
      [EU_TILES_PROPORTIONED_UK_SPLIT, EU_GRID_PROPORTIONED],
      [EU_TILES_UNIFORM, EU_GRID_UNIFORM],
      [EU_TILES_UNIFORM_UK_SPLIT, EU_GRID_UNIFORM],
    ]) {
      const check = validateTileLayout(tiles, grid.cols, grid.rows);
      assert.equal(check.ok, true, `Layout error: ${JSON.stringify(check)}`);
    }
    assert.equal(lookupPlaceMeta("DE")?.abbr, "DE");
    assert.equal(lookupPlaceMeta("25")?.abbr, "MA");
  });
});

describe("next/lab/fixtures.js", () => {
  it("builds spatial metrics and normalized seasonal intensity across states, EU, and MetroCast HSAs", () => {
    const s = buildSpatialSnapshot();
    assert.ok(s.us[1].US.rate_per_100k > 0);
    assert.ok(s.eu.eu_ili[1].DE.rate_per_100k > 0);

    const hsasData = JSON.parse(fs.readFileSync(path.join(GEO_DIR, "metrocast_hsas.json"), "utf8"));
    const boston = hsasData.hsas.find((h) => h.id === "boston");
    const m = metricForPlace(boston, "seasonal_intensity");
    assert.ok(m.value >= 1 && m.value <= 100);
    assert.equal(metricForPlace(boston, "none").value, null);
  });

  it("ensures 20-round PMF fixture sums to 1.0 and verticalPmfSegments centers around 0", () => {
    const pmf = buildPmfFixture();
    assert.equal(pmf.rounds.length, 20);
    for (const loc of Object.keys(pmf.byPlace)) {
      for (const date of pmf.rounds) {
        const r = pmf.byPlace[loc].rounds[date];
        for (const mId of Object.keys(r.models)) {
          for (const h of [0, 1, 2, 3]) {
            const entry = r.models[mId][h];
            const sum = entry.probs.reduce((a, b) => a + b, 0);
            assert.ok(Math.abs(sum - 1) < 1e-6);
          }
        }
      }
    }
    const segs = verticalPmfSegments([0.1, 0.2, 0.2, 0.3, 0.2]);
    // Decreasing segments below 0, stable symmetric at 0, increasing above 0
    assert.ok(segs[0].y1 <= 0 && segs[1].y1 <= 0);
    assert.ok(Math.abs(segs[2].y0 + segs[2].y1) < 1e-9);
    assert.ok(segs[3].y0 >= 0 && segs[4].y1 <= 1.0001);
    const perfect = scorePmfEntry([0, 0, 1, 0, 0], 2);
    assert.equal(perfect.rps, 0);
  });

  it("generates monotonic derived trajectory quantiles and finite sample scores", () => {
    const tr = buildTrajectoriesFixture();
    for (const id of tr.modelOrder) {
      const mod = tr.models[id];
      assert.equal(mod.samples.length, 100);
      assert.ok(mod.scores.crps > 0);
      assert.ok(mod.scores.energyScore > 0);
      for (const q of mod.quantiles) {
        assert.ok(q.q05 <= q.q10 && q.q10 <= q.q25 && q.q25 <= q.q50 && q.q50 <= q.q75 && q.q75 <= q.q90 && q.q90 <= q.q95);
      }
    }
    assert.deepEqual(deriveQuantilesFromTrajectories([]), []);
  });

  it("builds full multi-stream briefings across US, State, MetroCast HSA, and EU countries", () => {
    const hsasData = JSON.parse(fs.readFileSync(path.join(GEO_DIR, "metrocast_hsas.json"), "utf8"));
    const boston = hsasData.hsas.find((h) => h.id === "boston");
    for (const [id, meta] of [["US", null], ["25", null], ["boston", boston], ["DE", null], ["GB-ENG", null]]) {
      const b = buildBriefingForPlace(id, meta, hsasData.hsas);
      assert.equal(b.placeId, id);
      assert.ok(b.kpis.length === 5);
      assert.ok(b.streams.length >= 4);
      assert.ok(b.spread.length >= 5);
      assert.equal(b.virology.length, 18);
      assert.equal(b.clades.length, 18);
      assert.equal(b.vaccineMatch.length, 3);
      assert.ok(b.sources.length >= 4);
      for (const v of b.virology) {
        const s = v.h1n1 + v.h3n2 + v.aUnsub + v.bVic;
        assert.ok(Math.abs(s - 1) < 0.02);
      }
      assert.ok(!JSON.stringify(b).includes("undefined"));
    }
  });
});
