/* The evaluation scope: what the scores, heatmap, map and peaks are computed over. Stored as
 * `state.scope` (partial; anything missing takes its default). By default the scope follows the
 * chart: its season, every week, every horizon, every location.
 *
 * Read it only through scopeOf(); write it with setScope(). */

export const DEFAULT_SCOPE = Object.freeze({
  seasons: null,   // null: follow the chart's season. Else an array of season ids
  from: null,      // ISO date or null (the season's start)
  to: null,        // ISO date or null (the season's end)
  phase: null,     // null (full) | "pre" | "peak" | "post"
  horizons: null,  // null: all. Else an array of horizons (0..3)
  place: "all",    // "all" | "states" | "current" (the chart's location)
});

/**
 * The scope in force.
 * @returns {{ seasons: string[], following: boolean, from: string|null, to: string|null,
 *   phase: string|null, horizons: number[]|null, place: string }}
 */
export function scopeOf(state, manifest) {
  const sc = { ...DEFAULT_SCOPE, ...(state.scope || {}) };
  const following = !Array.isArray(sc.seasons) || !sc.seasons.length;
  const chartSeason = manifest.seasonOf(state.date);
  return { ...sc, following, seasons: following ? (chartSeason ? [chartSeason] : []) : sc.seasons };
}

/** Merge a change into the stored scope. */
export function setScope(store, patch) {
  store.set({ scope: { ...(store.get().scope || {}), ...patch } });
}
