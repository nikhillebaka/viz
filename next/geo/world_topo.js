/* The 50m world-countries TopoJSON, fetched and decoded once for the whole page: GlobeView's country
 * layer and picker_geo's China map (`cn-national`) both read it. Depends only on topo.js, so either
 * side can import it without a cycle. */
import { arcsToUnitSphere, decodeArcs } from "./topo.js";

export const WORLD_TOPO_URL = new URL("./world-countries-50m.json", import.meta.url).href;

let worldP = null;

/**
 * @returns {Promise<{ topo: object, decodedArcs: Float64Array[], unitArcs: object[] }>} shared and
 *   read-only; a failed load is forgotten so the next call retries
 */
export function loadWorldTopo() {
  if (!worldP) {
    worldP = fetch(WORLD_TOPO_URL)
      .then((r) => { if (!r.ok) throw new Error(`world-countries: ${r.status}`); return r.json(); })
      .then((topo) => {
        const decodedArcs = decodeArcs(topo);
        return { topo, decodedArcs, unitArcs: arcsToUnitSphere(decodedArcs) };
      })
      .catch((err) => {
        worldP = null;
        throw err;
      });
  }
  return worldP;
}
