/* Pure TopoJSON decoder & 3D orthographic spherical geometry helpers.
 * Zero external dependencies; works identically in browsers and Node unit tests.
 *
 * Operating directly on unit-sphere (x, y, z) coordinates eliminates ±180°
 * antimeridian wrap artifacts and enables fast 3D bounding-cone frustum culling
 * when zooming down to 3,200+ U.S. county borders. */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_TAU = Math.PI * 2;

/** Convert geographic longitude/latitude (degrees) to unit-sphere [x, y, z]. */
export function lonLatToXYZ(lonDeg, latDeg, out = null, offset = 0) {
  const lam = lonDeg * DEG2RAD;
  const phi = latDeg * DEG2RAD;
  const cPhi = Math.cos(phi);
  const x = cPhi * Math.cos(lam);
  const y = cPhi * Math.sin(lam);
  const z = Math.sin(phi);
  if (out) {
    out[offset] = x;
    out[offset + 1] = y;
    out[offset + 2] = z;
    return out;
  }
  return [x, y, z];
}

/** Convert unit-sphere [x, y, z] back to [lonDeg, latDeg]. */
export function xyzToLonLat(x, y, z) {
  const lat = Math.asin(Math.max(-1, Math.min(1, z))) * RAD2DEG;
  const lon = Math.atan2(y, x) * RAD2DEG;
  return [lon, lat];
}

/**
 * Delta-decode quantized TopoJSON arcs into Float64Array([lon0, lat0, lon1, lat1, ...]).
 * Preserves non-quantized topologies cleanly.
 */
export function decodeArcs(topology) {
  const arcs = topology?.arcs || [];
  const tf = topology?.transform;
  const sx = tf?.scale?.[0] ?? 1;
  const sy = tf?.scale?.[1] ?? 1;
  const tx = tf?.translate?.[0] ?? 0;
  const ty = tf?.translate?.[1] ?? 0;

  return arcs.map((arc) => {
    const out = new Float64Array(arc.length * 2);
    let qx = 0;
    let qy = 0;
    for (let i = 0; i < arc.length; i++) {
      qx += arc[i][0];
      qy += arc[i][1];
      out[i * 2] = qx * sx + tx;
      out[i * 2 + 1] = qy * sy + ty;
    }
    return out;
  });
}

/**
 * Compute bounding cone { cx, cy, cz, sinAlpha, cosAlpha } for a Float32Array of unit-sphere XYZ points.
 * A bounding cone passes the visible cap test iff dot(forward, center) >= cos(min(PI, thetaMax + alpha)).
 */
export function computeBoundingCone(xyz) {
  const n = xyz.length / 3;
  if (!n) return { cx: 1, cy: 0, cz: 0, alpha: Math.PI, sinAlpha: 1, cosAlpha: -1 };
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let i = 0; i < xyz.length; i += 3) {
    sx += xyz[i];
    sy += xyz[i + 1];
    sz += xyz[i + 2];
  }
  const len = Math.hypot(sx, sy, sz);
  const cx = len > 1e-8 ? sx / len : xyz[0];
  const cy = len > 1e-8 ? sy / len : xyz[1];
  const cz = len > 1e-8 ? sz / len : xyz[2];

  let minDot = 1;
  for (let i = 0; i < xyz.length; i += 3) {
    const d = cx * xyz[i] + cy * xyz[i + 1] + cz * xyz[i + 2];
    if (d < minDot) minDot = d;
  }
  minDot = Math.max(-1, Math.min(1, minDot));
  const alpha = Math.acos(minDot);
  return {
    cx,
    cy,
    cz,
    alpha,
    cosAlpha: minDot,
    sinAlpha: Math.sqrt(Math.max(0, 1 - minDot * minDot)),
  };
}

/** Convert decoded [lon, lat] arcs to pre-baked unit-sphere Float32Array arcs with bounding cones. */
export function arcsToUnitSphere(decodedArcs) {
  return decodedArcs.map((lonLat) => {
    const n = lonLat.length / 2;
    const xyz = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      lonLatToXYZ(lonLat[i * 2], lonLat[i * 2 + 1], xyz, i * 3);
    }
    const cone = computeBoundingCone(xyz);
    return { xyz, ...cone };
  });
}

function resolveRing(arcIndices, unitArcs) {
  let totalPts = 0;
  for (let i = 0; i < arcIndices.length; i++) {
    const idx = arcIndices[i];
    const arc = unitArcs[idx < 0 ? ~idx : idx];
    if (!arc) continue;
    const n = arc.xyz.length / 3;
    totalPts += i === 0 ? n : Math.max(0, n - 1);
  }
  const xyz = new Float32Array(totalPts * 3);
  let cursor = 0;
  for (let i = 0; i < arcIndices.length; i++) {
    const rawIdx = arcIndices[i];
    const rev = rawIdx < 0;
    const arc = unitArcs[rev ? ~rawIdx : rawIdx];
    if (!arc) continue;
    const n = arc.xyz.length / 3;
    if (n === 0) continue;
    const start = i === 0 ? 0 : 1;
    if (!rev) {
      for (let k = start; k < n; k++) {
        xyz[cursor++] = arc.xyz[k * 3];
        xyz[cursor++] = arc.xyz[k * 3 + 1];
        xyz[cursor++] = arc.xyz[k * 3 + 2];
      }
    } else {
      for (let k = n - 1 - start; k >= 0; k--) {
        xyz[cursor++] = arc.xyz[k * 3];
        xyz[cursor++] = arc.xyz[k * 3 + 1];
        xyz[cursor++] = arc.xyz[k * 3 + 2];
      }
    }
  }
  return xyz;
}

/**
 * Extract polygon features from a named TopoJSON object with 3D unit-sphere rings and cones.
 * @returns {Array<{ id: string, name: string, rings: Float32Array[], cx: number, cy: number, cz: number, alpha: number, centroidLonLat: [number, number] }>}
 */
export function extractPolygons(topology, objectName, unitArcs = null) {
  const obj = topology?.objects?.[objectName];
  if (!obj) return [];
  const arcs3 = unitArcs || arcsToUnitSphere(decodeArcs(topology));
  const geoms = obj.type === "GeometryCollection" ? obj.geometries : [obj];
  const features = [];

  for (const g of geoms) {
    if (!g) continue;
    let rawPolys = [];
    if (g.type === "Polygon") rawPolys = [g.arcs];
    else if (g.type === "MultiPolygon") rawPolys = g.arcs;
    else continue;

    // Preserve outer rings + holes; also pick largest ring for centroid estimation
    const rings = [];
    let bestRing = null;
    for (const polyArcs of rawPolys) {
      if (!polyArcs?.length) continue;
      const outer = resolveRing(polyArcs[0], arcs3);
      if (outer.length >= 9) {
        rings.push(outer);
        if (!bestRing || outer.length > bestRing.length) bestRing = outer;
      }
      for (let h = 1; h < polyArcs.length; h++) {
        const hole = resolveRing(polyArcs[h], arcs3);
        if (hole.length >= 9) rings.push(hole);
      }
    }
    if (!rings.length) continue;

    // Overall bounding cone from outer points
    let total = 0;
    for (const r of rings) total += r.length;
    const all = new Float32Array(total);
    let p = 0;
    for (const r of rings) { all.set(r, p); p += r.length; }
    const cone = computeBoundingCone(all);
    const bestCone = computeBoundingCone(bestRing);
    features.push({
      id: g.id != null ? String(g.id) : "",
      name: g.properties?.name || "",
      properties: g.properties || {},
      rings,
      cx: cone.cx,
      cy: cone.cy,
      cz: cone.cz,
      alpha: cone.alpha,
      cosAlpha: cone.cosAlpha,
      sinAlpha: cone.sinAlpha,
      centroidLonLat: xyzToLonLat(bestCone.cx, bestCone.cy, bestCone.cz),
    });
  }
  return features;
}

/**
 * Extract deduplicated shared-arc mesh segments for a TopoJSON object so interior borders
 * (e.g. U.S. counties or states) are stroked once per edge.
 * @param {Function} [filterFn] optional `(a, b) => boolean` given sharing geometries `(geomA, geomB | null)`
 * @returns {Array<{ xyz: Float32Array, cx: number, cy: number, cz: number, alpha: number, sinAlpha: number, cosAlpha: number }>}
 */
export function extractMesh(topology, objectName, unitArcs = null, filterFn = null) {
  const obj = topology?.objects?.[objectName];
  if (!obj) return [];
  const arcs3 = unitArcs || arcsToUnitSphere(decodeArcs(topology));
  const geomsByArc = new Map();

  function record(g, ring) {
    for (const idx of ring) {
      const k = idx < 0 ? ~idx : idx;
      let list = geomsByArc.get(k);
      if (!list) { list = []; geomsByArc.set(k, list); }
      list.push(g);
    }
  }
  function walk(g, type, arcs) {
    if (!arcs) return;
    if (type === "GeometryCollection") {
      for (const child of arcs) walk(child, child.type, child.arcs || child.geometries);
    } else if (type === "Polygon") {
      for (const r of arcs) record(g, r);
    } else if (type === "MultiPolygon") {
      for (const poly of arcs) for (const r of poly) record(g, r);
    }
  }
  walk(obj, obj.type, obj.arcs || obj.geometries);

  const selected = [];
  for (const [arcIdx, owners] of geomsByArc.entries()) {
    const a = owners[0];
    const b = owners.length > 1 ? owners[1] : null;
    if (!filterFn || filterFn(a, b)) {
      const seg = arcs3[arcIdx];
      if (seg && seg.xyz.length >= 6) selected.push(seg);
    }
  }
  return selected;
}

/**
 * Construct a row-major 3×3 orthonormal rotation matrix aligning `[lonDeg, latDeg]`
 * with camera `+Z` (toward viewer), East along `+X`, North along `+Y`.
 */
export function makeRotationMatrix(lonDeg, latDeg) {
  const lam = lonDeg * DEG2RAD;
  const phi = latDeg * DEG2RAD;
  const cLam = Math.cos(lam);
  const sLam = Math.sin(lam);
  const cPhi = Math.cos(phi);
  const sPhi = Math.sin(phi);

  return new Float32Array([
    -sLam, cLam, 0,
    -sPhi * cLam, -sPhi * sLam, cPhi,
    cPhi * cLam, cPhi * sLam, sPhi,
  ]);
}

/** Check whether a bounding cone can intersect the current screen viewport cone (`thetaMaxRad` in [0, PI/2]). */
export function coneVisibleInViewport(cone, R, thetaMaxRad = null) {
  // Dot of cone center with forward vector (row 2 of R)
  const dot = R[6] * cone.cx + R[7] * cone.cy + R[8] * cone.cz;
  if (thetaMaxRad != null) {
    const angleLim = Math.min(Math.PI, thetaMaxRad + cone.alpha);
    return dot >= Math.cos(angleLim);
  }
  return dot >= -cone.sinAlpha;
}

/**
 * Project a 3D unit-sphere point through R into camera coordinates `{ px, py, pz }`.
 * Note `pz >= 0` is on the visible front hemisphere.
 */
export function projectPoint(x, y, z, R) {
  return {
    px: R[0] * x + R[1] * y + R[2] * z,
    py: R[3] * x + R[4] * y + R[5] * z,
    pz: R[6] * x + R[7] * y + R[8] * z,
  };
}

/** Inverse orthographic projection: screen `[sx, sy]` -> `[lonDeg, latDeg]` or `null` if off-sphere. */
export function screenToLonLat(sx, sy, cx, cy, radiusPx, R) {
  const px = (sx - cx) / radiusPx;
  const py = (cy - sy) / radiusPx;
  const r2 = px * px + py * py;
  if (r2 > 1) return null;
  const pz = Math.sqrt(Math.max(0, 1 - r2));
  // World = R^T * [px, py, pz]
  const wx = R[0] * px + R[3] * py + R[6] * pz;
  const wy = R[1] * px + R[4] * py + R[7] * pz;
  const wz = R[2] * px + R[5] * py + R[8] * pz;
  return xyzToLonLat(wx, wy, wz);
}

/**
 * Clip an open 3D polyline (`Float32Array`) onto the visible front hemisphere `pz >= 0`.
 * Returns an array of flat Float64Array polylines `[px0, py0, px1, py1, ...]` in normalized
 * orthographic units (`px, py in [-1, 1]`).
 */
export function clipPolylineToHemisphere(xyz, R) {
  const n = xyz.length / 3;
  if (n < 2) return [];
  const out = [];
  let run = [];

  const r0 = R[0], r1 = R[1], r2 = R[2];
  const r3 = R[3], r4 = R[4], r5 = R[5];
  const r6 = R[6], r7 = R[7], r8 = R[8];

  let x = xyz[0], y = xyz[1], z = xyz[2];
  let prevX = r0 * x + r1 * y + r2 * z;
  let prevY = r3 * x + r4 * y + r5 * z;
  let prevZ = r6 * x + r7 * y + r8 * z;
  if (prevZ >= 0) run.push(prevX, prevY);

  for (let i = 3; i < xyz.length; i += 3) {
    x = xyz[i]; y = xyz[i + 1]; z = xyz[i + 2];
    const cx = r0 * x + r1 * y + r2 * z;
    const cy = r3 * x + r4 * y + r5 * z;
    const cz = r6 * x + r7 * y + r8 * z;

    if (prevZ >= 0 && cz >= 0) {
      run.push(cx, cy);
    } else if (prevZ >= 0 && cz < 0) {
      const t = prevZ / (prevZ - cz);
      let hx = prevX + t * (cx - prevX);
      let hy = prevY + t * (cy - prevY);
      const hl = Math.hypot(hx, hy) || 1;
      run.push(hx / hl, hy / hl);
      if (run.length >= 4) out.push(run);
      run = [];
    } else if (prevZ < 0 && cz >= 0) {
      const t = prevZ / (prevZ - cz);
      let hx = prevX + t * (cx - prevX);
      let hy = prevY + t * (cy - prevY);
      const hl = Math.hypot(hx, hy) || 1;
      run = [hx / hl, hy / hl, cx, cy];
    }
    prevX = cx;
    prevY = cy;
    prevZ = cz;
  }
  if (run.length >= 4) out.push(run);
  return out;
}

/**
 * Clip a closed polygon ring (`Float32Array`) onto the visible front hemisphere `pz >= 0`.
 * Segments straddling the horizon insert smooth limb arc vertices so filled polygons
 * hug the curved limb of the globe instead of slicing chords across it.
 * @returns {number[] | null} flat `[px0, py0, px1, py1, ...]` or `null` if wholly hidden
 */
export function clipPolygonToHemisphere(xyz, R) {
  const n = xyz.length / 3;
  if (n < 3) return null;

  const r0 = R[0], r1 = R[1], r2 = R[2];
  const r3 = R[3], r4 = R[4], r5 = R[5];
  const r6 = R[6], r7 = R[7], r8 = R[8];

  const cam = new Float32Array(n * 3);
  let visibleCount = 0;
  for (let i = 0; i < n; i++) {
    const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
    const cz = r6 * x + r7 * y + r8 * z;
    cam[i * 3] = r0 * x + r1 * y + r2 * z;
    cam[i * 3 + 1] = r3 * x + r4 * y + r5 * z;
    cam[i * 3 + 2] = cz;
    if (cz >= 0) visibleCount++;
  }
  if (visibleCount === 0) return null;

  // Fast path: wholly visible on front hemisphere
  if (visibleCount === n) {
    const pts = new Array(n * 2);
    for (let i = 0; i < n; i++) {
      pts[i * 2] = cam[i * 3];
      pts[i * 2 + 1] = cam[i * 3 + 1];
    }
    return pts;
  }

  // Horizon clipping with short-arc limb stitching
  const pts = [];
  let limbExit = null;
  let px = cam[(n - 1) * 3];
  let py = cam[(n - 1) * 3 + 1];
  let pz = cam[(n - 1) * 3 + 2];

  const pushLimbArc = (ax, ay, bx, by) => {
    const a0 = Math.atan2(ay, ax);
    const a1 = Math.atan2(by, bx);
    let d = a1 - a0;
    if (d > Math.PI) d -= EARTH_TAU;
    if (d < -Math.PI) d += EARTH_TAU;
    const steps = Math.max(1, Math.min(16, Math.ceil(Math.abs(d) / 0.12)));
    for (let s = 1; s <= steps; s++) {
      const a = a0 + (d * s) / steps;
      pts.push(Math.cos(a), Math.sin(a));
    }
  };

  for (let i = 0; i < n; i++) {
    const cx = cam[i * 3];
    const cy = cam[i * 3 + 1];
    const cz = cam[i * 3 + 2];

    if (pz >= 0 && cz >= 0) {
      pts.push(cx, cy);
    } else if (pz >= 0 && cz < 0) {
      const t = pz / (pz - cz);
      const hx = px + t * (cx - px);
      const hy = py + t * (cy - py);
      const hl = Math.hypot(hx, hy) || 1;
      const ex = hx / hl;
      const ey = hy / hl;
      pts.push(ex, ey);
      limbExit = [ex, ey];
    } else if (pz < 0 && cz >= 0) {
      const t = pz / (pz - cz);
      const hx = px + t * (cx - px);
      const hy = py + t * (cy - py);
      const hl = Math.hypot(hx, hy) || 1;
      const sx = hx / hl;
      const sy = hy / hl;
      if (limbExit) {
        pushLimbArc(limbExit[0], limbExit[1], sx, sy);
        limbExit = null;
      } else {
        pts.push(sx, sy);
      }
      pts.push(cx, cy);
    }
    px = cx;
    py = cy;
    pz = cz;
  }

  // If loop ended while clipped at limbExit, close around to the first clipped vertex
  if (limbExit && pts.length >= 2) {
    pushLimbArc(limbExit[0], limbExit[1], pts[0], pts[1]);
  }
  return pts.length >= 6 ? pts : null;
}

/** Smooth great-circle interpolation (SLERP) between two [lonDeg, latDeg] viewpoints. */
export function slerpLonLat(fromLonLat, toLonLat, t) {
  const u = Math.max(0, Math.min(1, t));
  if (u <= 0) return [fromLonLat[0], fromLonLat[1]];
  if (u >= 1) return [toLonLat[0], toLonLat[1]];
  const a = lonLatToXYZ(fromLonLat[0], fromLonLat[1]);
  const b = lonLatToXYZ(toLonLat[0], toLonLat[1]);
  let dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  if (dot > 0.99995) {
    const x = a[0] + u * (b[0] - a[0]);
    const y = a[1] + u * (b[1] - a[1]);
    const z = a[2] + u * (b[2] - a[2]);
    const l = Math.hypot(x, y, z) || 1;
    return xyzToLonLat(x / l, y / l, z / l);
  }
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);
  const wa = Math.sin((1 - u) * omega) / sinOmega;
  const wb = Math.sin(u * omega) / sinOmega;
  return xyzToLonLat(
    wa * a[0] + wb * b[0],
    wa * a[1] + wb * b[1],
    wa * a[2] + wb * b[2],
  );
}

/** 2D point-in-polygon ray cast against `[x0, y0, x1, y1, ...]` flat ring. */
export function pointInFlatRing(x, y, pts) {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2], yi = pts[i * 2 + 1];
    const xj = pts[j * 2], yj = pts[j * 2 + 1];
    if ((yi > y) !== (yj > y)) {
      const ix = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (x < ix) inside = !inside;
    }
  }
  return inside;
}
