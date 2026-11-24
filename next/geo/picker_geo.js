/* Shared multi-hub geography classifier, U.S. tile layout, and interactive SVG HSA renderer.
 * Zero hardcoded hub IDs: every hub is classified strictly from manifest.locations + manifest.geo. */
import {
  EU_META,
  EU_TILES_PROPORTIONED,
  EU_TILES_PROPORTIONED_UK_SPLIT,
  US_STATE_META,
} from "./eu_tiles.js";
import {
  arcsToUnitSphere,
  buildMetroOverlays,
  decodeArcs,
  extractLonLatFeatures,
  extractMesh,
  extractPolygons,
} from "./topo.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The standard US tile grid: abbreviation -> [column, row], 11 x 8, DC and PR included. */
export const TILES = Object.freeze({
  AK: [0, 0], ME: [10, 0], VT: [9, 1], NH: [10, 1],
  WA: [0, 2], ID: [1, 2], MT: [2, 2], ND: [3, 2], MN: [4, 2], IL: [5, 2], WI: [6, 2], MI: [7, 2], NY: [8, 2], RI: [9, 2], MA: [10, 2],
  OR: [0, 3], NV: [1, 3], WY: [2, 3], SD: [3, 3], IA: [4, 3], IN: [5, 3], OH: [6, 3], PA: [7, 3], NJ: [8, 3], CT: [9, 3],
  CA: [0, 4], UT: [1, 4], CO: [2, 4], NE: [3, 4], MO: [4, 4], KY: [5, 4], WV: [6, 4], VA: [7, 4], MD: [8, 4], DE: [9, 4],
  AZ: [1, 5], NM: [2, 5], KS: [3, 5], AR: [4, 5], TN: [5, 5], NC: [6, 5], SC: [7, 5], DC: [8, 5],
  OK: [3, 6], LA: [4, 6], MS: [5, 6], AL: [6, 6], GA: [7, 6],
  HI: [0, 7], TX: [3, 7], FL: [8, 7], PR: [10, 7],
});
export const COLUMNS = 11;

const FIPS_BY_ABBR = new Map(
  Object.values(US_STATE_META)
    .filter((s) => s.id !== "US" && /^\d{2}$/.test(s.id))
    .map((s) => [s.abbr, s.id]),
);

const SUBSTATE_LEVELS = new Set(["hsa", "region", "borough", "metro", "county"]);

const NYC_BOROUGH_COUNTIES = Object.freeze({
  "36005": { id: "Bronx", abbr: "BX", name: "Bronx, NY" },
  "36047": { id: "Brooklyn", abbr: "BK", name: "Brooklyn, NY" },
  "36061": { id: "Manhattan", abbr: "MN", name: "Manhattan, NY" },
  "36081": { id: "Queens", abbr: "QN", name: "Queens, NY" },
  "36085": { id: "Staten Island", abbr: "SI", name: "Staten Island, NY" },
});

function parseFips(loc, byId) {
  if (!loc) return null;
  if (loc.state_fips && /^\d{2}$/.test(String(loc.state_fips))) return String(loc.state_fips);
  const cm = /^US:(\d{2})(?:$|:)/.exec(String(loc.canonical_id || ""));
  if (cm) return cm[1];
  if (/^\d{2}$/.test(String(loc.id || "")) && US_STATE_META[loc.id]) return String(loc.id);
  if (loc.level === "state" && loc.abbr && FIPS_BY_ABBR.has(loc.abbr)) return FIPS_BY_ABBR.get(loc.abbr);
  if (loc.parent_id && byId?.has(loc.parent_id)) {
    const pf = parseFips(byId.get(loc.parent_id), byId);
    if (pf) return pf;
  }
  if (loc.region && FIPS_BY_ABBR.has(loc.region)) return FIPS_BY_ABBR.get(loc.region);
  return null;
}

/**
 * Classify the loaded hub's geography purely from `manifest.locations` & `manifest.geo`.
 * Returns structured indexes for contextual pickers, choropleths, scores scope labels, and globe layers.
 */
export function classifyHubGeo(manifest) {
  const locs = manifest?.locations || [];
  const byId = manifest?.locationById instanceof Map
    ? manifest.locationById
    : new Map(locs.map((l) => [l.id, l]));

  const stateByFips = new Map();
  const stateByAbbr = new Map();
  const hsasByStateFips = new Map();
  const fipsById = new Map();
  const drcProvinces = [];
  const drcZonesByProvince = new Map();

  let stateMatchCount = 0;
  let subStateCount = 0;
  let euMatchCount = 0;
  let ukSplitAvailable = false;
  let hasOntarioRegions = false;
  let caMatchCount = 0;
  let hasDrc = false;
  let hasHealthZones = false;

  for (const loc of locs) {
    const cid = String(loc.canonical_id || "");
    if (loc.id === "GB-ENG" || loc.id === "GB-SCT" || loc.id === "GB-WLS" || loc.id === "GB-NIR") {
      ukSplitAvailable = true;
    }
    if (EU_TILES_PROPORTIONED[loc.id] || EU_TILES_PROPORTIONED_UK_SPLIT[loc.id] || EU_META[loc.id]) {
      euMatchCount++;
    }
    if (loc.id === "CD" || loc.level === "health_zone" || /^CD-[A-Z]{2}(?:-\d+)?$/.test(loc.id) || cid.startsWith("CD:")) {
      hasDrc = true;
      if (loc.level === "health_zone" || /^CD-[A-Z]{2}-\d+/.test(loc.id)) {
        hasHealthZones = true;
        const pid = loc.parent_id || (loc.id.length >= 5 ? loc.id.slice(0, 5) : null);
        if (pid) {
          let arr = drcZonesByProvince.get(pid);
          if (!arr) { arr = []; drcZonesByProvince.set(pid, arr); }
          arr.push(loc);
        }
      } else if (loc.id !== "CD" && (loc.level === "province" || /^CD-[A-Z]{2}$/.test(loc.id))) {
        drcProvinces.push(loc);
      }
      continue;
    }
    if (["Central", "East", "North East", "North West", "Toronto", "West"].includes(loc.id)) {
      hasOntarioRegions = true;
    }
    if (loc.id === "ca" || cid === "CA" || cid.startsWith("CA:")) {
      caMatchCount++;
    }
    if (loc.id === "US") continue;

    const fips = parseFips(loc, byId);
    if (fips) fipsById.set(loc.id, fips);

    const isSubState = SUBSTATE_LEVELS.has(loc.level) || /^US:\d{2}:/.test(cid);
    if (isSubState && fips) {
      subStateCount++;
      let arr = hsasByStateFips.get(fips);
      if (!arr) { arr = []; hsasByStateFips.set(fips, arr); }
      arr.push(loc);
    } else if (fips && (loc.level === "state" || loc.level === "territory" || TILES[loc.abbr])) {
      stateMatchCount++;
      stateByFips.set(fips, loc);
      if (loc.abbr) stateByAbbr.set(loc.abbr, loc);
    }
  }

  for (const arr of hsasByStateFips.values()) {
    arr.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  }
  drcProvinces.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  for (const arr of drcZonesByProvince.values()) {
    arr.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  }

  const coveredStateFips = new Set([...stateByFips.keys(), ...hsasByStateFips.keys()]);
  const stateFipsOf = (idOrLoc) => {
    const id = typeof idOrLoc === "string" ? idOrLoc : idOrLoc?.id;
    return (id && fipsById.get(id)) || (typeof idOrLoc === "object" ? parseFips(idOrLoc, byId) : null);
  };
  const drcProvinceOf = (idOrLoc) => {
    const id = typeof idOrLoc === "string" ? idOrLoc : idOrLoc?.id;
    if (!id || id === "CD") return null;
    if (/^CD-[A-Z]{2}$/.test(id)) return id;
    const loc = byId.get(id);
    if (loc?.parent_id && /^CD-[A-Z]{2}$/.test(loc.parent_id)) return loc.parent_id;
    const m = /^(CD-[A-Z]{2})-\d+/.exec(id);
    return m ? m[1] : null;
  };

  let kind = "generic";
  if (hasDrc) {
    kind = "cd-provinces";
  } else if (byId.has("Ontario") && hasOntarioRegions) {
    kind = "ca-ontario";
  } else if (caMatchCount >= 2 && !byId.has("US")) {
    kind = "ca-provinces";
  } else if (subStateCount >= 1 && hsasByStateFips.size >= 1) {
    kind = "us-metrocast";
  } else if (euMatchCount >= 5 && subStateCount === 0) {
    kind = "eu-countries";
  } else if (manifest?.geo?.uses_us_fips || stateMatchCount >= 10) {
    kind = "us-states";
  } else if (byId.has("CN") && !byId.has("US") && euMatchCount === 0) {
    kind = "cn-national";
  }

  const aggregateId = kind === "cd-provinces"
    ? (byId.has("CD") ? "CD" : null)
    : kind === "ca-ontario"
      ? (byId.has("Ontario") ? "Ontario" : null)
      : kind === "ca-provinces"
        ? (byId.has("ca") ? "ca" : null)
        : (byId.has("US") ? "US" : null);

  const aggregateLocs = locs.filter((l) => l.is_aggregate);

  return {
    kind,
    coveredStateFips,
    stateByFips,
    stateByAbbr,
    hsasByStateFips,
    drcProvinces,
    drcZonesByProvince,
    hasHealthZones,
    ukSplitAvailable,
    aggregateId,
    aggregateLocs,
    stateFipsOf,
    drcProvinceOf,
  };
}

let usGeoPromise = null;
/**
 * Lazily fetch and build cached U.S. state + 95-HSA exterior polygon geometry (`us-counties-10m.json` +
 * `metrocast_hsas.json`) so LocationPicker, Map section, and Globe share one decoded geometry bundle.
 */
export function loadUsGeoCache() {
  if (!usGeoPromise) {
    const usUrl = new URL("./us-counties-10m.json", import.meta.url).href;
    const hsasUrl = new URL("./metrocast_hsas.json", import.meta.url).href;
    usGeoPromise = Promise.all([
      fetch(usUrl).then((r) => { if (!r.ok) throw new Error(`us-counties: ${r.status}`); return r.json(); }),
      fetch(hsasUrl).then((r) => { if (!r.ok) throw new Error(`metrocast_hsas: ${r.status}`); return r.json(); }),
    ]).then(([usTopo, hsasData]) => {
      const decodedUsArcs = decodeArcs(usTopo);
      const usArcs = arcsToUnitSphere(decodedUsArcs);
      const states = extractPolygons(usTopo, "states", usArcs).map((f) => ({
        ...f,
        fips: String(f.id).padStart(2, "0"),
      }));
      const stateMesh = extractMesh(usTopo, "states", usArcs);
      const rawState2d = extractLonLatFeatures(usTopo, "states", decodedUsArcs);
      const stateLonLatByFips = new Map();
      for (const [k, v] of rawState2d.entries()) stateLonLatByFips.set(String(k).padStart(2, "0"), v);
      const { metroMesh, metroFeatures, coveredStates } = buildMetroOverlays(usTopo, usArcs, hsasData, decodedUsArcs);
      const metroById = new Map(metroFeatures.map((m) => [m.id, m]));
      const county2d = extractLonLatFeatures(usTopo, "counties", decodedUsArcs);
      const nycBoroughs = [];
      for (const [fips, meta] of Object.entries(NYC_BOROUGH_COUNTIES)) {
        const rings = county2d.get(fips) || county2d.get(String(Number(fips)));
        if (rings?.length) nycBoroughs.push({ ...meta, stateFips: "36", lonLatRings: rings });
      }
      return {
        states,
        stateMesh,
        stateLonLatByFips,
        metroMesh,
        metroFeatures,
        metroById,
        nycBoroughs,
        coveredStates,
        hsasData,
      };
    }).catch((err) => {
      usGeoPromise = null;
      throw err;
    });
  }
  return usGeoPromise;
}

const NYC_BOROUGH_IDS = new Set(Object.values(NYC_BOROUGH_COUNTIES).map((b) => b.id));

/**
 * Render an aspect-corrected interactive SVG map of a state's dissolved MetroCast HSA polygons
 * (`lp-hsa-svg` for pickers or `mp-hsa-svg` when `fillFor` provides data choropleth colors).
 */
export function renderHsaStateSvg(usGeo, stateFips, manifestHsas, opts = {}) {
  const {
    activeId = null,
    className = "lp-hsa-svg",
    bgClass = "lp-hsa-state-bg",
    polyClass = "lp-hsa-poly",
    fillFor = null,
    textColorFor = null,
    onPick = null,
    onHover = null,
    width = 360,
    height = 196,
  } = opts;

  const isNycBoroughView = stateFips === "36"
    && usGeo.nycBoroughs?.length
    && (manifestHsas || []).some((x) => NYC_BOROUGH_IDS.has(x.id));
  const hsas = isNycBoroughView
    ? usGeo.nycBoroughs
    : (usGeo.metroFeatures || []).filter((m) => m.stateFips === stateFips);
  const manifestById = new Map((manifestHsas || []).map((x) => [x.id, x]));
  const bgRings = usGeo.stateLonLatByFips?.get(stateFips) || [];
  const hsaRings = hsas.flatMap((m) => m.lonLatRings || []);
  if (!bgRings.length && !hsaRings.length) return null;

  const boundsOf = (rings) => {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const r of rings) {
      for (let i = 0; i < r.length; i += 2) {
        if (r[i] < minLon) minLon = r[i];
        if (r[i] > maxLon) maxLon = r[i];
        if (r[i + 1] < minLat) minLat = r[i + 1];
        if (r[i + 1] > maxLat) maxLat = r[i + 1];
      }
    }
    return { minLon, maxLon, minLat, maxLat };
  };

  const sb = bgRings.length ? boundsOf(bgRings) : boundsOf(hsaRings);
  const hb = hsaRings.length ? boundsOf(hsaRings) : sb;
  const compactSubarea = hsaRings.length > 0 && bgRings.length > 0
    && ((hb.maxLon - hb.minLon) < (sb.maxLon - sb.minLon) * 0.35 || (hb.maxLat - hb.minLat) < (sb.maxLat - sb.minLat) * 0.35);
  let { minLon, maxLon, minLat, maxLat } = compactSubarea
    ? hb
    : (bgRings.length && hsaRings.length ? boundsOf([...bgRings, ...hsaRings]) : hb);
  if (compactSubarea) {
    const px = Math.max(0.05, (maxLon - minLon) * 0.18);
    const py = Math.max(0.05, (maxLat - minLat) * 0.18);
    minLon -= px; maxLon += px; minLat -= py; maxLat += py;
  }

  const cosLat = Math.max(0.25, Math.cos(((minLat + maxLat) * 0.5) * (Math.PI / 180)));
  const spanX = Math.max(0.05, (maxLon - minLon) * cosLat);
  const spanY = Math.max(0.05, maxLat - minLat);
  const pad = 12;
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const ox = (width - spanX * scale) * 0.5;
  const oy = (height - spanY * scale) * 0.5;
  const ringsToPath = (rings) => rings.map((r) => {
    let d = "";
    for (let i = 0; i < r.length; i += 2) {
      const px = ox + (r[i] - minLon) * cosLat * scale;
      const py = oy + (maxLat - r[i + 1]) * scale;
      d += `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`;
    }
    return `${d}Z`;
  }).join(" ");

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", compactSubarea ? `${className} is-clipped` : className);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${US_STATE_META[stateFips]?.name || stateFips} MetroCast HSAs`);

  if (bgRings.length) {
    const bg = document.createElementNS(SVG_NS, "path");
    bg.setAttribute("class", bgClass);
    bg.setAttribute("fill-rule", "evenodd");
    bg.setAttribute("d", ringsToPath(bgRings));
    svg.append(bg);
  }

  for (const m of hsas) {
    if (!m.lonLatRings?.length) continue;
    const loc = manifestById.get(m.id);
    // When rendering from a hub manifest, keep every HSA clickable even if a fixture ID is used, or match by manifest id
    const targetId = loc?.id || m.id;
    const label = loc?.name || m.name;
    const path = document.createElementNS(SVG_NS, "path");
    const isOn = targetId === activeId || m.id === activeId;
    path.setAttribute("class", isOn ? `${polyClass} is-on` : polyClass);
    path.setAttribute("data-loc", targetId);
    path.setAttribute("fill-rule", "evenodd");
    path.setAttribute("d", ringsToPath(m.lonLatRings));
    path.setAttribute("aria-label", label);
    path.setAttribute("tabindex", "0");

    if (fillFor) {
      const f = fillFor(targetId, loc || m);
      if (f) path.style.fill = f;
      const tc = textColorFor?.(targetId, f);
      if (tc) path.style.color = tc;
    }

    const tip = document.createElementNS(SVG_NS, "title");
    tip.textContent = label;
    path.append(tip);
    if (onHover) {
      path.addEventListener("pointerenter", () => onHover(targetId, label));
      path.addEventListener("focus", () => onHover(targetId, label));
    }
    if (onPick) {
      path.addEventListener("click", () => onPick(targetId, loc || m));
      path.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(targetId, loc || m); }
      });
    }
    svg.append(path);
  }
  return svg;
}

const REGION_TOPO_SPECS = Object.freeze({
  "ca-provinces": { file: "./ca-provinces.json", object: "provinces", label: "Canada provinces" },
  "ca-ontario": { file: "./ca-ontario-oh.json", object: "regions", label: "Ontario Health regions" },
  "cd-provinces": { file: "./cd-provinces.json", object: "provinces", label: "DRC provinces" },
  "cn-national": { file: "./world-countries-50m.json", object: "countries", onlyIsoNum: "156", fixedId: "CN", fixedName: "China", label: "China" },
});

const regionGeoCache = new Map();

/**
 * Lazily fetch and cache a regional TopoJSON asset (`ca-provinces`, `ca-ontario`, `cd-provinces`, `cn-national`),
 * decoding both 2D `[lon, lat]` rings for SVG maps and 3D unit-sphere polygons/mesh for GlobeView.
 */
export function loadRegionGeo(kind) {
  const spec = REGION_TOPO_SPECS[kind];
  if (!spec) return Promise.resolve(null);
  let p = regionGeoCache.get(kind);
  if (!p) {
    const url = new URL(spec.file, import.meta.url).href;
    p = fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`${kind}: ${r.status}`); return r.json(); })
      .then((topo) => {
        const decodedArcs = decodeArcs(topo);
        const unitArcs = arcsToUnitSphere(decodedArcs);
        const raw2d = extractLonLatFeatures(topo, spec.object, decodedArcs);
        let features3d = extractPolygons(topo, spec.object, unitArcs);
        if (spec.onlyIsoNum) {
          features3d = features3d
            .filter((f) => String(f.id) === spec.onlyIsoNum)
            .map((f) => ({ ...f, id: spec.fixedId || f.id, name: spec.fixedName || f.name }));
        }
        const features = features3d.map((f) => {
          const srcKey = spec.onlyIsoNum || f.id;
          return {
            id: f.id,
            name: f.name || f.properties?.name || f.id,
            abbr: f.properties?.abbr || f.id,
            props: f.properties || {},
            lonLatRings: raw2d.get(String(srcKey)) || [],
            rings: f.rings,
            cx: f.cx,
            cy: f.cy,
            cz: f.cz,
            alpha: f.alpha,
            cosAlpha: f.cosAlpha,
            sinAlpha: f.sinAlpha,
            centroidLonLat: f.centroidLonLat,
          };
        });
        const mesh = spec.onlyIsoNum ? [] : extractMesh(topo, spec.object, unitArcs);
        return { kind, label: spec.label, features, byId: new Map(features.map((f) => [f.id, f])), mesh };
      })
      .catch((err) => {
        regionGeoCache.delete(kind);
        throw err;
      });
    regionGeoCache.set(kind, p);
  }
  return p;
}

/**
 * Aspect-corrected monochrome SVG vector choropleth for Canada provinces, Ontario Health regions,
 * DRC 26 provinces, or China national boundaries.
 */
export function renderRegionSvg(regionGeo, manifestLocations, opts = {}) {
  const {
    activeId = null,
    className = "lp-hsa-svg",
    polyClass = "lp-hsa-poly",
    ariaLabel = regionGeo?.label || "Region map",
    fillFor = null,
    textColorFor = null,
    onPick = null,
    onHover = null,
    width = 360,
    height = 196,
  } = opts;

  const features = (regionGeo?.features || []).filter((f) => f.lonLatRings?.length);
  if (!features.length) return null;

  const manifestById = manifestLocations instanceof Map
    ? manifestLocations
    : new Map((manifestLocations || []).map((l) => [l.id, l]));

  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const f of features) {
    for (const r of f.lonLatRings) {
      for (let i = 0; i < r.length; i += 2) {
        if (r[i] < minLon) minLon = r[i];
        if (r[i] > maxLon) maxLon = r[i];
        if (r[i + 1] < minLat) minLat = r[i + 1];
        if (r[i + 1] > maxLat) maxLat = r[i + 1];
      }
    }
  }
  if (!Number.isFinite(minLon)) return null;

  const cosLat = Math.max(0.25, Math.cos(((minLat + maxLat) * 0.5) * (Math.PI / 180)));
  const spanX = Math.max(0.1, (maxLon - minLon) * cosLat);
  const spanY = Math.max(0.1, maxLat - minLat);
  const pad = 12;
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const ox = (width - spanX * scale) * 0.5;
  const oy = (height - spanY * scale) * 0.5;
  const ringsToPath = (rings) => rings.map((r) => {
    let d = "";
    for (let i = 0; i < r.length; i += 2) {
      const px = ox + (r[i] - minLon) * cosLat * scale;
      const py = oy + (maxLat - r[i + 1]) * scale;
      d += `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`;
    }
    return `${d}Z`;
  }).join(" ");

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", ariaLabel);

  for (const f of features) {
    const loc = manifestById.get(f.id);
    const targetId = loc?.id || f.id;
    const label = loc?.name || f.name || targetId;
    const isSelected = targetId === activeId
      || (activeId && loc && String(activeId).startsWith(`${targetId}-`));
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", isSelected ? `${polyClass} is-on` : polyClass);
    path.setAttribute("data-loc", targetId);
    path.setAttribute("fill-rule", "evenodd");
    path.setAttribute("d", ringsToPath(f.lonLatRings));
    path.setAttribute("aria-label", label);
    path.setAttribute("tabindex", "0");

    if (fillFor) {
      const fill = fillFor(targetId, loc || f);
      if (fill) path.style.fill = fill;
      const tc = textColorFor?.(targetId, fill);
      if (tc) path.style.color = tc;
    }

    const tip = document.createElementNS(SVG_NS, "title");
    tip.textContent = label;
    path.append(tip);
    if (onHover) {
      path.addEventListener("pointerenter", () => onHover(targetId, label));
      path.addEventListener("focus", () => onHover(targetId, label));
    }
    if (onPick) {
      path.addEventListener("click", () => onPick(targetId, loc || f));
      path.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(targetId, loc || f); }
      });
    }
    svg.append(path);
  }
  return svg;
}
