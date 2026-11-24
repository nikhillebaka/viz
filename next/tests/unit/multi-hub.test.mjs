import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { indexManifest } from "../../lib/api.js";
import { classifyHubGeo } from "../../geo/picker_geo.js";
import { targetHorizons, scopeOf } from "../../sections/scope.js";
import { scorePmfDistribution, verticalPmfSegments, PMF_TABLE_SORTS, sortPmfRows } from "../../features/PmfView.js";
import { parseUrl, writeUrl, defaults, targetDimSpecs, defaultDims, isCategoricalTarget } from "../../features/url.js";
import { buildTargetMenuGroups } from "../../features/TargetMenu.js";
import { matchCatalogPlaces } from "../../features/LocationPicker.js";
import { findRateChangeTarget } from "../../sections/rate_change/index.js";
import { formatStreamValue, GLOBE_ZOOM } from "../../features/GlobeView.js";

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
        { id: "flusight", horizons: { required: [], optional: [-1, 0, 1, 2, 3] } },
        { id: "hindcast", horizons: { required: [-2, -1], optional: [] } },
      ],
      locations: [{ id: "DE", abbr: "DE", name: "Germany" }, { id: "FR", abbr: "FR", name: "France" }],
      seasons: [{ id: "2025-2026", rounds: ["2025-11-26"] }],
      models: [],
    });
    assert.deepEqual(targetHorizons(man, "ari"), [0, 1, 2, 3, 4]);
    assert.deepEqual(targetHorizons(man, "flusight"), [0, 1, 2, 3]);
    assert.deepEqual(targetHorizons(man, "hindcast"), [-2, -1]);
    const sc = scopeOf({ target: "flusight", date: "2025-11-26", scope: { place: "current" } }, man);
    assert.equal(sc.location, "DE");
    assert.equal(sc.horizons, null);
    const scSub = scopeOf({ target: "flusight", date: "2025-11-26", location: "FR", scope: { horizons: [0], place: "current" } }, man);
    assert.deepEqual(scSub.horizons, [0]);
    assert.equal(scSub.location, "FR");
  });

  it("scorePmfDistribution and verticalPmfSegments compute accurate finite ordinal scores", () => {
    const perf = scorePmfDistribution([0, 0, 1, 0, 0], 2);
    assert.equal(perf.rps, 0);
    assert.equal(perf.brier, 0);
    assert.equal(perf.logScore, 0);
    assert.equal(perf.logLoss, 0);
    assert.equal(perf.modeHit, true);

    const unif = scorePmfDistribution([0.2, 0.2, 0.2, 0.2, 0.2], 2);
    assert.ok(Math.abs(unif.rps - 0.1) < 1e-12);
    assert.ok(Math.abs(unif.brier - 0.8) < 1e-12);
    assert.ok(Math.abs(unif.logScore - Math.log(0.2)) < 1e-12);
    assert.ok(Math.abs(unif.logLoss + Math.log(0.2)) < 1e-12);
    assert.equal(unif.modeHit, false);

    const zero = scorePmfDistribution([0, 0, 0, 0, 1], 0);
    assert.ok(Number.isFinite(zero.logScore));
    assert.ok(zero.logScore < -10);
    assert.ok(zero.logLoss > 10);
    assert.equal(zero.rps, 1);

    const segs = verticalPmfSegments([0.1, 0.2, 0.4, 0.2, 0.1]);
    assert.equal(segs.length, 5);
    assert.ok(Math.abs(segs[2].y0 + 0.2) < 1e-12 && Math.abs(segs[2].y1 - 0.2) < 1e-12);
    assert.ok(Math.abs(segs[4].y1 - 0.5) < 1e-12 && Math.abs(segs[0].y0 + 0.5) < 1e-12);

    assert.equal(PMF_TABLE_SORTS.hitMode.asc, false);
    assert.equal(PMF_TABLE_SORTS.logLoss.asc, true);
    const pmfRows = [
      { id: "b", name: "Beta", rel: 1.05, rps: 0.12, logLoss: 1.2, brier: 0.52, hitMode: 40, count: 20 },
      { id: "a", name: "Alpha", rel: 0.9, rps: 0.08, logLoss: 1.4, brier: 0.45, hitMode: 65, count: 25 },
      { id: "c", name: "Gamma", rel: NaN, rps: NaN, logLoss: 1.1, brier: 0.49, hitMode: 50, count: 10 },
    ];
    assert.deepEqual(sortPmfRows(pmfRows, { key: "rps", rev: false }).map((r) => r.id), ["a", "b", "c"]);
    assert.deepEqual(sortPmfRows(pmfRows, { key: "logLoss", rev: false }).map((r) => r.id), ["c", "b", "a"]);
    assert.deepEqual(sortPmfRows(pmfRows, { key: "hitMode", rev: false }).map((r) => r.id), ["a", "c", "b"]);
    assert.deepEqual(sortPmfRows(pmfRows, { key: "hitMode", rev: true }).map((r) => r.id), ["b", "c", "a"]);
    assert.deepEqual(sortPmfRows(pmfRows, { key: "model", rev: false }).map((r) => r.id), ["a", "b", "c"]);
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

  it("buildTargetMenuGroups and matchCatalogPlaces unify cross-hub targets and places cleanly", () => {
    const man = indexManifest({
      hub_id: "local_flu",
      default_target: "wk inc flu hosp",
      targets: [{ id: "wk inc flu hosp", short: "Flu admissions", label: "Incident Flu Admissions" }],
      locations: [
        { id: "US", abbr: "US", name: "United States" },
        { id: "25", abbr: "MA", name: "Massachusetts" },
      ],
      seasons: [{ id: "2025-2026", rounds: ["2025-11-22"] }],
      models: [{ id: "Ens", abbr: "Ens" }],
    });

    const catalog = {
      hubs: [
        { id: "local_flu", default_location: "US" },
        { id: "remote_flu_metrocast", default_location: "boston" },
        { id: "remote_covid19", default_location: "US" },
        { id: "remote_respicast_syndromic", default_location: "DE" },
      ],
      targets: [
        { key: "local_flu::wk inc flu hosp", hub_id: "local_flu", hub_short: "FluSight", target_id: "wk inc flu hosp", label: "Incident Flu Admissions", short: "Flu admissions", pathogen: "influenza", pathogen_label: "Influenza", geo_kind: "us-states", region_label: "US" },
        { key: "remote_flu_metrocast::Flu ED visits pct", hub_id: "remote_flu_metrocast", hub_short: "MetroCast", target_id: "Flu ED visits pct", label: "Flu ED Visits", short: "Flu ED %", pathogen: "influenza", pathogen_label: "Influenza", geo_kind: "us-metrocast", region_label: "US · MetroCast" },
        { key: "remote_covid19::wk inc covid hosp", hub_id: "remote_covid19", hub_short: "COVID-19", target_id: "wk inc covid hosp", label: "Incident COVID-19 Admissions", short: "COVID admissions", pathogen: "covid19", pathogen_label: "COVID-19", geo_kind: "us-states", region_label: "US" },
        { key: "remote_respicast_syndromic::ILI incidence", hub_id: "remote_respicast_syndromic", hub_short: "RespiCast", target_id: "ILI incidence", label: "ILI Incidence", short: "ILI / 100k", pathogen: "syndromic", pathogen_label: "ILI / ARI", geo_kind: "eu-countries", region_label: "Europe" },
      ],
      places: {
        "25": {
          key: "25", name: "Massachusetts", abbr: "MA", level: "state", state_fips: "25", parent_key: "US",
          hubs: [
            { hub_id: "local_flu", location_id: "25", pathogen_label: "Influenza", region_label: "US" },
            { hub_id: "remote_flu_metrocast", location_id: "massachusetts", pathogen_label: "Influenza", region_label: "US · MetroCast" },
            { hub_id: "remote_covid19", location_id: "25", pathogen_label: "COVID-19", region_label: "US" },
          ],
        },
        boston: {
          key: "boston", name: "Boston, MA", abbr: "Boston", level: "hsa", state_fips: "25", parent_key: "25",
          hubs: [{ hub_id: "remote_flu_metrocast", location_id: "boston", pathogen_label: "Influenza", region_label: "US · MetroCast" }],
        },
        FR: {
          key: "FR", name: "France", abbr: "FR", level: "country",
          hubs: [{ hub_id: "remote_respicast_syndromic", location_id: "FR", pathogen_label: "ILI / ARI", region_label: "Europe" }],
        },
        GB: {
          key: "GB", name: "United Kingdom", abbr: "UK", level: "country",
          hubs: [{ hub_id: "remote_respicast_syndromic", location_id: "UK", pathogen_label: "ILI / ARI", region_label: "Europe" }],
        },
      },
    };

    // At Massachusetts ("25"): only MA targets appear, with per-location targets respected and no Europe leak
    const maMenu = buildTargetMenuGroups(catalog, man, "25", "local_flu", "wk inc flu hosp");
    assert.equal(maMenu.findIndex((e) => e.type === "sep"), -1);
    const maItems = maMenu.filter((e) => e.type === "item");
    assert.equal(maItems.length, 3);
    assert.equal(maItems[1].shortcut, "MetroCast");
    assert.ok(maItems.every((e) => e.targetId !== "ILI incidence"));

    // Per-location h_ent.targets filtering excludes targets not valid at that location, and US country targets don't leak onto state "25"
    const scopedCat = structuredClone(catalog);
    scopedCat.places.US = {
      key: "US", name: "United States", abbr: "US", level: "country",
      hubs: [{ hub_id: "remote_respicast_syndromic", location_id: "US", targets: [{ target_id: "ILI incidence", id: "ILI incidence" }] }],
    };
    scopedCat.places["25"].hubs[1].targets = []; // MetroCast has zero targets at state "25" (e.g. MA only has ED% at HSAs)
    const strictMa = buildTargetMenuGroups(scopedCat, man, "25", "local_flu", "wk inc flu hosp").filter((e) => e.type === "item");
    assert.deepEqual(strictMa.map((x) => x.targetId).sort(), ["wk inc covid hosp", "wk inc flu hosp"]);

    // At Boston HSA (subnational): inherits parent Massachusetts state targets via parent_key="25"
    const bosMenu = buildTargetMenuGroups(catalog, man, "boston", "remote_flu_metrocast", "Flu ED visits pct");
    const bosItems = bosMenu.filter((e) => e.type === "item");
    assert.equal(bosItems.find((e) => e.hubId === "remote_covid19")?.shortcut, "MA");

    // Cross-hub place search while viewing US FluSight
    const frHits = matchCatalogPlaces(catalog, man, "france", "local_flu");
    assert.equal(frHits.length, 1);
    assert.equal(frHits[0].inActiveHub, false);
    assert.equal(frHits[0].targetHubId, "remote_respicast_syndromic");
    assert.equal(frHits[0].targetLocationId, "FR");

    const ukHits = matchCatalogPlaces(catalog, man, "uk", "local_flu");
    assert.equal(ukHits[0].targetLocationId, "UK");

    const bosHits = matchCatalogPlaces(catalog, man, "boston", "local_flu");
    assert.equal(bosHits[0].targetHubId, "remote_flu_metrocast");
    assert.equal(bosHits[0].targetLocationId, "boston");
  });

  it("buildTargetMenuGroups: deduplicates same-concept targets and leaves cross-region locations to smart resolver", () => {
    const man = indexManifest({
      hub_id: "local_flu",
      default_target: "proportion of ed visits due to flu",
      locations: [{ id: "25", name: "Massachusetts", abbr: "MA" }],
      targets: [{ id: "proportion of ed visits due to flu", label: "Flu ED Proportion", short: "Flu ED prop" }],
      seasons: [{ id: "2025-2026", rounds: ["2025-11-22"] }],
      models: [{ id: "Ens", abbr: "Ens" }],
    });

    const catalog = {
      hubs: [
        { id: "local_flu", kind: "local", model_count: 5, default_location: "US" },
        { id: "remote_flu_metrocast", kind: "remote", model_count: 8, default_location: "boston" },
        { id: "remote_respicast_syndromic", kind: "remote", model_count: 6, default_location: "FR" },
      ],
      targets: [
        {
          key: "local_flu::proportion of ed visits due to flu",
          hub_id: "local_flu", hub_short: "Local",
          target_id: "proportion of ed visits due to flu",
          label: "proportion of ed visits due to flu",
          concept_id: "flu_ed_share", concept_label: "Influenza ED visits share", ambiguous: false,
          pathogen: "influenza", pathogen_label: "Influenza", geo_kind: "us-states", region_label: "US",
        },
        {
          key: "remote_flu_metrocast::Flu ED visits pct",
          hub_id: "remote_flu_metrocast", hub_short: "MetroCast",
          target_id: "Flu ED visits pct",
          label: "Percentage of ED visits due to influenza",
          concept_id: "flu_ed_share", concept_label: "Influenza ED visits share", ambiguous: false,
          pathogen: "influenza", pathogen_label: "Influenza", geo_kind: "us-metrocast", region_label: "US · MetroCast",
        },
        {
          key: "remote_respicast_syndromic::ILI incidence",
          hub_id: "remote_respicast_syndromic", hub_short: "RespiCast",
          target_id: "ILI incidence",
          label: "ILI Incidence",
          concept_id: "ili_incidence", concept_label: "ILI incidence", ambiguous: false,
          pathogen: "syndromic", pathogen_label: "ILI / ARI", geo_kind: "eu-countries", region_label: "Europe",
        },
      ],
      places: {
        "25": {
          key: "25", name: "Massachusetts", abbr: "MA", level: "state", state_fips: "25", parent_key: "US",
          hubs: [
            { hub_id: "local_flu", location_id: "25" },
            { hub_id: "remote_flu_metrocast", location_id: "massachusetts" },
          ],
        },
        boston: {
          key: "boston", name: "Boston, MA", abbr: "Boston", level: "hsa", state_fips: "25", parent_key: "25",
          hubs: [{ hub_id: "remote_flu_metrocast", location_id: "boston" }],
        },
        FR: {
          key: "FR", name: "France", abbr: "FR", level: "country",
          hubs: [{ hub_id: "remote_respicast_syndromic", location_id: "FR" }],
        },
      },
    };

    const maMenu = buildTargetMenuGroups(catalog, man, "25", "local_flu", "proportion of ed visits due to flu");
    assert.equal(maMenu.findIndex((e) => e.type === "sep"), -1);
    const maItems = maMenu.filter((e) => e.type === "item");
    assert.equal(maItems.length, 1);
    assert.equal(maItems[0].hubId, "local_flu");
    assert.equal(maItems[0].label, "Influenza ED visits share");

    // Inside Boston HSA, active direct MetroCast match wins over parent FluSight match
    const bosMenu = buildTargetMenuGroups(catalog, man, "boston", "remote_flu_metrocast", "Flu ED visits pct");
    const bosItems = bosMenu.filter((e) => e.type === "item");
    assert.equal(bosItems.length, 1);
    assert.equal(bosItems[0].hubId, "remote_flu_metrocast");
    assert.equal(bosItems[0].locationId, "boston");
  });

  it("buildTargetMenuGroups excludes categorical targets while findRateChangeTarget resolves companion rate change", () => {
    const man = indexManifest({
      hub_id: "local_flu",
      default_target: "wk inc flu hosp",
      targets: [{ id: "wk inc flu hosp", label: "Flu admissions" }],
      locations: [{ id: "US" }, { id: "25", abbr: "MA" }],
      seasons: [{ id: "2025-2026", rounds: ["2025-11-22"] }],
      models: [{ id: "Ens", abbr: "Ens" }],
    });
    const catalog = {
      hubs: [
        { id: "local_flu", kind: "local", model_count: 5 },
        { id: "remote_flusight", kind: "remote", model_count: 20 },
        { id: "remote_covid19", kind: "remote", model_count: 10 },
      ],
      targets: [
        {
          key: "local_flu::wk inc flu hosp",
          hub_id: "local_flu", target_id: "wk inc flu hosp",
          label: "Flu admissions", pathogen: "influenza", pathogen_label: "Influenza", is_categorical: false,
        },
        {
          key: "remote_flusight::wk flu hosp rate change",
          hub_id: "remote_flusight", target_id: "wk flu hosp rate change",
          label: "Hospitalization rate change", pathogen: "influenza", pathogen_label: "Influenza", is_categorical: true,
        },
        {
          key: "remote_covid19::wk inc covid hosp",
          hub_id: "remote_covid19", target_id: "wk inc covid hosp",
          label: "COVID admissions", pathogen: "covid19", pathogen_label: "COVID-19", is_categorical: false,
        },
      ],
      places: {
        "25": {
          key: "25", name: "Massachusetts", abbr: "MA", level: "state", state_fips: "25", parent_key: "US",
          hubs: [
            { hub_id: "local_flu", location_id: "25" },
            { hub_id: "remote_flusight", location_id: "25" },
            { hub_id: "remote_covid19", location_id: "25" },
          ],
        },
        boston: {
          key: "boston", name: "Boston, MA", abbr: "Boston", level: "hsa", state_fips: "25", parent_key: "25",
          hubs: [{ hub_id: "remote_flu_metrocast", location_id: "boston" }],
        },
      },
    };

    const items = buildTargetMenuGroups(catalog, man, "25", "local_flu", "wk inc flu hosp").filter((e) => e.type === "item");
    assert.ok(items.every((e) => e.targetId !== "wk flu hosp rate change"));

    const rcDirect = findRateChangeTarget(catalog, man, "wk inc flu hosp", "25");
    assert.deepEqual(rcDirect?.targetId, "wk flu hosp rate change");
    assert.equal(rcDirect?.hubId, "remote_flusight");
    assert.equal(rcDirect?.locationId, "25");
    assert.equal(rcDirect?.viaParent, false);

    // Via parent state for sub-state Boston
    const mcMan = indexManifest({
      hub_id: "remote_flu_metrocast",
      targets: [{ id: "Flu ED visits pct", label: "Flu ED" }],
      locations: [{ id: "boston" }],
      seasons: [{ id: "2025-2026", rounds: ["2025-11-22"] }],
      models: [{ id: "Ens", abbr: "Ens" }],
    });
    catalog.targets.push({
      key: "remote_flu_metrocast::Flu ED visits pct",
      hub_id: "remote_flu_metrocast", target_id: "Flu ED visits pct",
      label: "Flu ED", pathogen: "influenza", pathogen_label: "Influenza", is_categorical: false,
    });
    const rcBos = findRateChangeTarget(catalog, mcMan, "Flu ED visits pct", "boston");
    assert.equal(rcBos?.targetId, "wk flu hosp rate change");
    assert.equal(rcBos?.locationId, "25");
    assert.equal(rcBos?.viaParent, true);

    // Non-flu target or null location returns null cleanly
    const covMan = { ...man, hub_id: "remote_covid19" };
    assert.equal(findRateChangeTarget(catalog, covMan, "wk inc covid hosp", "25"), null);
    assert.equal(findRateChangeTarget(catalog, man, "wk inc flu hosp", null), null);
  });

  it("formatStreamValue formats rate, percentage, proportion, count, and nullish values safely", () => {
    assert.equal(formatStreamValue(4.453, { use_rate: true, scale: "count" }), "4.45 /100k");
    assert.equal(formatStreamValue(12.34, { use_rate: true, scale: "count" }), "12.3 /100k");
    assert.equal(formatStreamValue(2.11, { use_rate: false, scale: "percentage", unit: "%" }), "2.11%");
    assert.equal(formatStreamValue(12.34, { use_rate: false, scale: "percentage", unit: "%" }), "12.3%");
    assert.equal(formatStreamValue(0.033, { use_rate: false, scale: "proportion", unit: "%" }), "3.30%");
    assert.equal(formatStreamValue(1324.9, { use_rate: false, scale: "rate", unit: "Cases / 100k" }), "1,325 /100k");
    assert.equal(formatStreamValue(4.567, { use_rate: false, scale: "rate", unit: "Cases / 100k" }), "4.57 /100k");
    assert.equal(formatStreamValue(1234, { use_rate: false, scale: "count" }), "1,234");
    assert.equal(formatStreamValue(null, { use_rate: false, scale: "count" }), "–");
    assert.equal(formatStreamValue(undefined, { use_rate: false, scale: "percentage" }), "–");
    assert.equal(formatStreamValue(NaN, { use_rate: true, scale: "count" }), "–");
  });

  it("GLOBE_ZOOM preserves a wide whole-state selection band before MetroCast HSAs fade in and intercept picks", () => {
    const z = GLOBE_ZOOM;
    assert.ok(z.MIN < z.STATE_FADE_START);
    assert.ok(z.STATE_FADE_START < z.STATE_FADE_END);
    assert.ok(z.STATE_FADE_END < z.US_DEFAULT);
    assert.ok(z.US_DEFAULT < z.STATE_INITIAL);
    assert.ok(z.STATE_INITIAL < z.METRO_FADE_START);
    assert.ok(z.METRO_FADE_START < z.METRO_PICK);
    assert.ok(z.METRO_PICK < z.METRO_FADE_END);
    assert.ok(z.METRO_FADE_END < z.METRO_LABEL);
    assert.ok(z.METRO_LABEL < z.METRO_FIT_MIN);
    assert.ok(z.METRO_FIT_MIN <= z.METRO_INITIAL);
    assert.ok(z.METRO_INITIAL < z.MAX);
    assert.ok(z.METRO_FADE_START >= 4.5);
    assert.ok(z.METRO_PICK >= 5.0);
  });
});
