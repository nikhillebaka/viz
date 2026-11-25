/* The evaluation scope: what the scores, heatmap, map and peaks are computed over. Stored as
 * `state.scope` (partial; anything missing takes its default). By default the scope follows the
 * chart: its season, every week, every horizon, every state.
 *
 * Read it only through scopeOf(); write it with setScope(). Pure apart from setScope (node tests run it). */

export const DEFAULT_SCOPE = Object.freeze({
  seasons: null,   // null: follow the chart's season. Else an array of season ids
  weeks: null,     // null: every week. Else [a, b], season weeks 1..53 (week 1 = MMWR week 31), applied to each season
  phase: null,     // null (full) | "pre" | "peak" | "post"
  horizons: null,  // null: all. Else an array of horizons (0..3)
  place: "all",    // "all" (every state, pooled) | "US" | "current" (the chart's location)
  fair: false,     // score only the forecasts every selected model shares
  baseline: null,  // null: the hub's baseline. Else a model id
  rank: "all",     // "all": relative WIS among every model with forecasts in scope | "selected"
  scale: "natural",// "natural" | "log"
});

export const PHASES = Object.freeze(["pre", "peak", "post"]);
export const HORIZONS = Object.freeze([0, 1, 2, 3]);
const DAY = 864e5, WEEK = 7 * DAY;

/** Whether the manifest includes the US national aggregate location (returns true for minimal test mocks lacking location metadata). */
export function hasUsLocation(manifest) {
  if (!manifest) return true;
  const hasMap = manifest.locationById && typeof manifest.locationById.has === "function";
  const hasArr = Array.isArray(manifest.locations);
  if (!hasMap && !hasArr) return true;
  if (hasMap && manifest.locationById.has("US")) return true;
  return hasArr ? manifest.locations.some((loc) => (loc?.id ?? loc) === "US") : false;
}

/**
 * Available non-negative weekly horizons for `targetId` from manifest metadata (fallback `[0, 1, 2, 3]`).
 * @param {object} manifest
 * @param {string} [targetId]
 * @returns {number[]}
 */
export function targetHorizons(manifest, targetId) {
  const id = targetId || manifest?.default_target || manifest?.targets?.[0]?.id;
  const hMeta = manifest?.targetById?.get?.(id)?.horizons || manifest?.targets?.find?.((t) => t.id === id)?.horizons;
  if (!hMeta) return HORIZONS;
  const all = [...new Set(
    [...(hMeta.required || []), ...(hMeta.optional || [])]
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= -4),
  )].sort((a, b) => a - b);
  if (!all.length) return HORIZONS;
  const nonNeg = all.filter((n) => n >= 0);
  return nonNeg.length ? nonNeg : all;
}

function hasManifestHorizons(manifest, targetId) {
  const id = targetId || manifest?.default_target || manifest?.targets?.[0]?.id;
  const hMeta = manifest?.targetById?.get?.(id)?.horizons || manifest?.targets?.find?.((t) => t.id === id)?.horizons;
  if (!hMeta) return false;
  return [...(hMeta.required || []), ...(hMeta.optional || [])]
    .some((x) => { const n = Number(x); return Number.isInteger(n) && n >= -4; });
}

/**
 * The Saturday ending a season week. Season week 1 is MMWR week 31 of the season's first year (the
 * backend's rule, core/data_loader.py), so week 1 of 2025–26 ends Aug 2, 2025.
 * @param {number} startYear the season's first year (2025 for "2025-2026")
 * @param {number} w season week, 1..53
 * @returns {number} UTC ms
 */
export function seasonWeekEnd(startYear, w) {
  const jan4 = Date.UTC(startYear, 0, 4);
  const sunday = jan4 - new Date(jan4).getUTCDay() * DAY;
  return sunday + 30 * WEEK + 6 * DAY + (w - 1) * WEEK;
}

/** The season week (1..53, clamped) a date falls in, for a season starting in `startYear`. */
export function seasonWeekOf(startYear, ms) {
  return Math.min(53, Math.max(1, Math.round((ms - seasonWeekEnd(startYear, 1)) / WEEK) + 1));
}

/** "2025-2026" → 2025 (NaN when the id has no leading year). */
export const startYearOf = (seasonId) => parseInt(String(seasonId), 10);

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The scope in force, every field resolved.
 * @param {{ scope?: object, date?: string, location?: string }} state
 * @param {{ seasonOf(iso: string): string | null, baseline?: string, seasons?: { id: string }[] }} manifest
 * @returns {{ seasons: string[], following: boolean, weeks: [number, number] | null, from: string | null,
 *   to: string | null, phase: string | null, horizons: number[] | null, place: string, location: string,
 *   fair: boolean, baseline: string, rank: string, scale: string }}
 *   seasons newest first; horizons null when all four; `location` is what /api/metrics takes
 *   ("states", "US" or a location id); from / to are the window's dates in the newest scoped season
 *   (null for an open end).
 */
export function scopeOf(state, manifest, availableHorizons = null) {
  const sc = { ...DEFAULT_SCOPE, ...(state.scope || {}) };
  const known = new Set((manifest.seasons || []).map((s) => s.id));
  const pinned = Array.isArray(sc.seasons) ? sc.seasons.filter((s) => !known.size || known.has(s)) : [];
  const following = !pinned.length;
  const chartSeason = manifest.seasonOf(state.date);
  const seasons = (following ? (chartSeason ? [chartSeason] : []) : [...new Set(pinned)]).sort().reverse();
  const weeks = Array.isArray(sc.weeks) && sc.weeks.length === 2 && !(sc.weeks[0] <= 1 && sc.weeks[1] >= 53)
    ? [Math.max(1, Math.min(sc.weeks[0], sc.weeks[1])), Math.min(53, Math.max(sc.weeks[0], sc.weeks[1]))] : null;
  const y = startYearOf(seasons[0]);
  const target = state.target || manifest.default_target || manifest.targets?.[0]?.id || "";
  const hasExplicitH = (Array.isArray(availableHorizons) && availableHorizons.length > 0)
    || hasManifestHorizons(manifest, target);
  const availH = Array.isArray(availableHorizons) && availableHorizons.length
    ? availableHorizons
    : targetHorizons(manifest, target);
  const availSet = new Set(availH);
  const hsRaw = Array.isArray(sc.horizons)
    ? [...new Set(sc.horizons.map(Number))].filter((h) => Number.isInteger(h) && h >= -4).sort((a, b) => a - b)
    : [];
  const hs = hasExplicitH ? hsRaw.filter((h) => availSet.has(h)) : hsRaw;
  const sameAsAvail = hs.length === availH.length && hs.every((h, i) => h === availH[i]);
  const place = sc.place === "current" ? "current" : (sc.place === "US" && hasUsLocation(manifest)) ? "US" : "all";
  const defaultLoc = manifest.geo?.default_location ?? manifest.default_location ?? (hasUsLocation(manifest) ? "US" : manifest.locations?.[0]?.id ?? "");
  const location = place === "US" ? "US" : place === "current" ? state.location || defaultLoc : "states";
  const defaultBaseline = typeof manifest.baselineFor === "function"
    ? manifest.baselineFor(target, seasons.length === 1 ? seasons[0] : null)
    : manifest.baseline;
  return {
    seasons, following, weeks,
    from: weeks && Number.isFinite(y) ? iso(seasonWeekEnd(y, weeks[0])) : null,
    to: weeks && Number.isFinite(y) ? iso(seasonWeekEnd(y, weeks[1])) : null,
    phase: PHASES.includes(sc.phase) ? sc.phase : null,
    horizons: hs.length && (hasExplicitH ? hs.length < availH.length : !sameAsAvail) ? hs : null,
    place, location,
    fair: !!sc.fair,
    baseline: sc.baseline || defaultBaseline || "",
    rank: sc.rank === "selected" ? "selected" : "all",
    scale: sc.scale === "log" ? "log" : "natural",
  };
}

/** Merge a change into the stored scope. */
export function setScope(store, patch) {
  store.set({ scope: { ...(store.get().scope || {}), ...patch } });
}
