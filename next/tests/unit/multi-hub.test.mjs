import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { indexManifest } from "../../lib/api.js";
import { classifyHubGeo } from "../../geo/picker_geo.js";
import { targetHorizons, scopeOf } from "../../sections/scope.js";
import { scorePmfDistribution, verticalPmfSegments } from "../../features/PmfView.js";
import { parseUrl, writeUrl, defaults, targetDimSpecs, defaultDims, isCategoricalTarget } from "../../features/url.js";

describe("Phase 3 multi-hub frontend helpers", () => {
  it("classifyHubGeo identifies us-states, us-metrocast, eu-countries (UK split), and generic", () => {
    const usMan = indexManifest({
      geo: { uses_us_fips: true },
      locations: [
        { id: "US", abbr: "US", name: "United States", level: "country" },
        ...["01", "02", "04", "05", "06", "08", "09", "10", "12", "13", "25"].map((id, i) => ({
          id, abbr: ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "MA"][i], name: id, level: "state",
        })),
      ],
      targets: [{ id: "t" }], seasons: [{ id: "2025-2026", rounds: ["2025-11-22"] }], models: [],
    });
    assert.equal(classifyHubGeo(usMan).kind, "us-states");

    const mcMan = indexManifest({
      locations: [
        { id: "massachusetts", abbr: "MA", name: "Massachusetts", level: "state", state_fips: "25", canonical_id: "US:25" },
        { id: "boston", abbr: "BOS", name: "Boston", level: "hsa", state_fips: "25", canonical_id: "US:25:boston" },
        { id: "portland", abbr: "PTL", name: "Portland", level: "hsa", state_fips: "23", canonical_id: "US:23:portland" },
        { id: "portland-or", abbr: "PTL", name: "Portland (OR)", level: "hsa", state_fips: "41", canonical_id: "US:41:portland" },
      ],
      targets: [{ id: "t" }], seasons: [{ id: "2025-2026", rounds: ["2025-11-22"] }], models: [],
    });
    const mcCls = classifyHubGeo(mcMan);
    assert.equal(mcCls.kind, "us-metrocast");
    assert.ok(mcCls.coveredStateFips.has("25"));
    assert.equal(mcCls.stateFipsOf("portland"), "23");
    assert.equal(mcCls.stateFipsOf("portland-or"), "41");

    const euMan = indexManifest({
      locations: [
        { id: "DE", name: "Germany" }, { id: "FR", name: "France" }, { id: "ES", name: "Spain" },
        { id: "IT", name: "Italy" }, { id: "NL", name: "Netherlands" }, { id: "GB-ENG", name: "England" },
      ],
      targets: [{ id: "t" }], seasons: [{ id: "2025-2026", rounds: ["2025-11-26"] }], models: [],
    });
    const euCls = classifyHubGeo(euMan);
    assert.equal(euCls.kind, "eu-countries");
    assert.equal(euCls.ukSplitAvailable, true);

    const genericMan = indexManifest({
      locations: [{ id: "loc-1", name: "Clinic A" }, { id: "loc-2", name: "Clinic B" }],
      targets: [{ id: "t" }], seasons: [{ id: "2025-2026", rounds: ["2025-11-22"] }], models: [],
    });
    assert.equal(classifyHubGeo(genericMan).kind, "generic");
  });

  it("targetHorizons and scopeOf adapt dynamically across multi-horizon and non-US hubs", () => {
    const man = indexManifest({
      default_target: "ari",
      geo: { default_location: "DE" },
      targets: [
        { id: "ari", horizons: { required: [0, 1, 2, 3], optional: [4] } },
        { id: "short", horizons: { required: [-1, 0], optional: [] } },
      ],
      locations: [{ id: "DE", abbr: "DE", name: "Germany" }, { id: "FR", abbr: "FR", name: "France" }],
      seasons: [{ id: "2025-2026", rounds: ["2025-11-26"] }],
      models: [],
    });
    assert.deepEqual(targetHorizons(man, "ari"), [0, 1, 2, 3, 4]);
    assert.deepEqual(targetHorizons(man, "short"), [-1, 0]);
    const sc = scopeOf({ target: "short", date: "2025-11-26", scope: { place: "current" } }, man);
    assert.equal(sc.location, "DE");
    assert.equal(sc.horizons, null);
    const scSub = scopeOf({ target: "short", date: "2025-11-26", location: "FR", scope: { horizons: [0], place: "current" } }, man);
    assert.deepEqual(scSub.horizons, [0]);
    assert.equal(scSub.location, "FR");
  });

  it("scorePmfDistribution and verticalPmfSegments compute accurate finite ordinal scores", () => {
    const perf = scorePmfDistribution([0, 0, 1, 0, 0], 2);
    assert.equal(perf.rps, 0);
    assert.equal(perf.brier, 0);
    assert.equal(perf.logScore, 0);
    assert.equal(perf.modeHit, true);

    const unif = scorePmfDistribution([0.2, 0.2, 0.2, 0.2, 0.2], 2);
    assert.ok(Math.abs(unif.rps - 0.1) < 1e-12);
    assert.ok(Math.abs(unif.brier - 0.8) < 1e-12);
    assert.ok(Math.abs(unif.logScore - Math.log(0.2)) < 1e-12);
    assert.equal(unif.modeHit, false);

    const zero = scorePmfDistribution([0, 0, 0, 0, 1], 0);
    assert.ok(Number.isFinite(zero.logScore));
    assert.ok(zero.logScore < -10);
    assert.equal(zero.rps, 1);

    const segs = verticalPmfSegments([0.1, 0.2, 0.4, 0.2, 0.1]);
    assert.equal(segs.length, 5);
    assert.ok(Math.abs(segs[2].y0 + 0.2) < 1e-12 && Math.abs(segs[2].y1 - 0.2) < 1e-12);
    assert.ok(Math.abs(segs[4].y1 - 0.5) < 1e-12 && Math.abs(segs[0].y0 + 0.5) < 1e-12);
  });

  it("targetDimSpecs, isCategoricalTarget, dims (dim_*), and traj=1 round-trip cleanly in URLs", () => {
    const rsvMan = indexManifest({
      default_target: "wk inc rsv hosp",
      targets: [
        {
          id: "wk inc rsv hosp",
          dimensions: { age_group: { values: ["0-130", "0-4", "65+"], default: "0-130" } },
          output_types: ["quantile", "sample"],
        },
        {
          id: "wk flu hosp rate change",
          is_categorical: true,
          output_types: ["pmf"],
        },
      ],
      locations: [{ id: "US", abbr: "US", name: "United States" }],
      seasons: [{ id: "2025-2026", rounds: ["2025-11-22"] }],
      models: [{ id: "Ens", abbr: "Ens" }],
    });

    assert.equal(isCategoricalTarget(rsvMan.targetById.get("wk inc rsv hosp")), false);
    assert.equal(isCategoricalTarget(rsvMan.targetById.get("wk flu hosp rate change")), true);
    assert.deepEqual(defaultDims(rsvMan, "wk inc rsv hosp"), { age_group: "0-130" });
    assert.equal(targetDimSpecs(rsvMan.targetById.get("wk inc rsv hosp")).length, 1);

    const base = defaults(rsvMan);
    // Clean URL when dims match defaults and traj is off
    assert.equal(writeUrl({ ...base, dims: { age_group: "0-130" }, trajectories: false }, rsvMan), "");
    // Round-trip non-default dim & traj while preserving unknown params and dropping invalid dim values
    const q = writeUrl({ ...base, dims: { age_group: "65+" }, trajectories: true }, rsvMan, "?foo=bar");
    assert.equal(q, "?traj=1&dim_age_group=65%2B&foo=bar");
    const back = parseUrl(q, rsvMan);
    assert.equal(back.trajectories, true);
    assert.deepEqual(back.dims, { age_group: "65+" });
    assert.equal(parseUrl("?dim_age_group=invalid", rsvMan).dims, undefined);
  });
});
