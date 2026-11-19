import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  arcsToUnitSphere,
  clipPolygonToHemisphere,
  clipPolylineToHemisphere,
  decodeArcs,
  extractMesh,
  extractPolygons,
  lonLatToXYZ,
  makeRotationMatrix,
  pointInFlatRing,
  screenToLonLat,
  slerpLonLat,
} from "../../geo/topo.js";
import {
  EU_GRID_PROPORTIONED,
  EU_GRID_UNIFORM,
  EU_TILES_PROPORTIONED,
  EU_TILES_PROPORTIONED_UK_SPLIT,
  EU_TILES_UNIFORM,
  EU_TILES_UNIFORM_UK_SPLIT,
  lookupPlaceMeta,
  validateTileLayout,
} from "../../geo/eu_tiles.js";
import {
  buildBriefingForPlace,
  buildPmfFixture,
  buildSpatialSnapshot,
  buildTrajectoriesFixture,
  deriveQuantilesFromTrajectories,
  scorePmfEntry,
} from "../../lab/fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GEO_DIR = path.resolve(HERE, "../../geo");

describe("next/geo/topo.js", () => {
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
            // Reverse arc 0? Share arc 2 + reversed [10,0]->[10,10] edge via shared arc index ~2 etc.
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

  it("reads bundled world-countries-110m.json and us-counties-10m.json cleanly", () => {
    const world = JSON.parse(fs.readFileSync(path.join(GEO_DIR, "world-countries-110m.json"), "utf8"));
    const us = JSON.parse(fs.readFileSync(path.join(GEO_DIR, "us-counties-10m.json"), "utf8"));
    const countries = extractPolygons(world, "countries");
    const states = extractPolygons(us, "states");
    const countyMesh = extractMesh(us, "counties", null, (a, b) => a && b);
    assert.equal(countries.length, 177);
    assert.equal(states.length, 56);
    assert.ok(countyMesh.length > 7000);
  });

  it("constructs orthonormal camera rotation matrix and round-trips screenToLonLat", () => {
    const lon = -71.8;
    const lat = 42.3;
    const R = makeRotationMatrix(lon, lat);
    const [wx, wy, wz] = lonLatToXYZ(lon, lat);
    // Rotated center must equal [0, 0, 1]
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
    const run = runs[0];
    assert.ok(Math.hypot(run[0], run[1]) <= 1.001);

    // Polygon crossing -110 deg longitude limb
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
    assert.equal(lookupPlaceMeta("provo")?.name, "Provo, UT");
    assert.equal(lookupPlaceMeta("DE")?.abbr, "DE");
    assert.equal(lookupPlaceMeta("25")?.abbr, "MA");
  });
});

describe("next/lab/fixtures.js", () => {
  it("builds spatial metrics for US states, EU jurisdictions, and MetroCast hubs", () => {
    const s = buildSpatialSnapshot();
    assert.ok(s.us[1].US.rate_per_100k > 0);
    assert.ok(s.us[1]["25"].median > 0);
    assert.ok(s.eu.eu_ili[1].DE.rate_per_100k > 0);
    assert.ok(s.cities[1].provo.rate_per_100k > 0);
  });

  it("ensures every PMF distribution sums to 1.0 and computes valid RPS/Brier/Log scores", () => {
    const pmf = buildPmfFixture();
    for (const loc of Object.keys(pmf.byPlace)) {
      for (const date of pmf.rounds) {
        const r = pmf.byPlace[loc].rounds[date];
        for (const mId of Object.keys(r.models)) {
          for (const h of [0, 1, 2, 3]) {
            const entry = r.models[mId][h];
            const sum = entry.probs.reduce((a, b) => a + b, 0);
            assert.ok(Math.abs(sum - 1) < 1e-6, `PMF sum ${sum} for ${loc}/${date}/${mId}/${h}`);
          }
        }
      }
    }
    const perfect = scorePmfEntry([0, 0, 1, 0, 0], 2);
    assert.equal(perfect.rps, 0);
    assert.equal(perfect.brier, 0);
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

  it("builds complete place briefings across US, State, MetroCast HSA, and European places", () => {
    for (const id of ["US", "25", "provo", "DE", "GB-ENG"]) {
      const b = buildBriefingForPlace(id);
      assert.equal(b.placeId, id);
      assert.ok(b.signals.length === 3);
      assert.ok(b.leaderboard.length === 4);
      assert.ok(b.peers.length > 0, `Expected non-empty peers for ${id}`);
      assert.ok(!b.headline.includes("undefined"), `Unexpected undefined in headline: ${b.headline}`);
      for (const d of b.whatChanged) {
        assert.ok(!String(d.delta).includes("undefined"), `Unexpected undefined in delta: ${d.delta}`);
      }
      const pSum = b.pmfProbs.reduce((x, y) => x + y, 0);
      assert.ok(Math.abs(pSum - 1) < 1e-6);
    }
  });
});
