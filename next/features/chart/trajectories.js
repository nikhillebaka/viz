/* Live VZT1 sample trajectories overlay for FanChart.
 * Loads draws lazily per (target, season, location, settled round, dims) when toggled on
 * (or automatically on sample-only targets) and lays out faint per-series spaghetti paths
 * underneath the charted medians and above the interval bands. */
import { addMonthsUtc, getActiveHub, loadTrajectories, registerCacheClear } from "../../lib/api.js";
import { DAY, parseIso, toIso } from "../../lib/scale.js";

const horizonTime = (refT, h, offDays, isMonthly) => (isMonthly ? addMonthsUtc(refT, h) : refT + (h * 7 + offDays) * DAY);

const TRAJ_CACHE = 12;
const MAX_DRAWS_PER_MODEL = 36;
const cache = new Map(); // key -> Promise<decoded | null>
registerCacheClear(() => cache.clear());

function cacheKey(target, season, location, date, modelsKey, dims) {
  const hub = getActiveHub() || "";
  const dimsKey = dims ? Object.entries(dims).sort().map(([k, v]) => `${k}=${v}`).join("&") : "";
  return `${hub}\n${target}\n${season}\n${location}\n${date}\n${modelsKey}\n${dimsKey}`;
}

/** Cached trajectory fetch (returns null cleanly on 404/empty). Pure per key, LRU capped. */
export function loadRoundTrajectories(target, season, location, date, { models, dims } = {}) {
  const sortedModels = [...(models || [])].filter(Boolean).sort();
  if (!target || !season || !location || !date || !sortedModels.length) return Promise.resolve(null);
  const modelsKey = sortedModels.join(",");
  const key = cacheKey(target, season, location, date, modelsKey, dims);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = loadTrajectories(target, season, location, date, { models: sortedModels, dims })
    .catch(() => null);
  cache.set(key, p);
  while (cache.size > TRAJ_CACHE) cache.delete(cache.keys().next().value);
  return p;
}

/** True when a target emits sample outputs without precomputed quantiles. */
export function isSampleOnlyTarget(targetMeta) {
  const ot = targetMeta?.output_types;
  return Array.isArray(ot) && ot.includes("sample") && !ot.includes("quantile");
}

export class ChartTrajectories {
  /** @param {import("../FanChart.js").FanChart} chart */
  constructor(chart) {
    this.chart = chart;
    this.data = null;
    this.loadedKey = "";
    this._token = 0;
  }

  isActive() {
    const { manifest, store } = this.chart.ctx;
    const s = store.get();
    const tMeta = manifest.targetById.get(s.target);
    return !!s.trajectories || (isSampleOnlyTarget(tMeta) && !(this.chart.fan?.quantiles?.length > 0));
  }

  /** Max forecast target-end timestamp (ms) across loaded sample trajectories, or null. */
  maxEnd() {
    if (!this.isActive() || !this.data?.modelTrajectories?.size) return null;
    const refT = parseIso(this.data.reference_date);
    if (!Number.isFinite(refT)) return null;
    const offDays = Number(this.data.horizon_offset_days) || 0;
    let maxH = -Infinity;
    for (const entry of this.data.modelTrajectories.values()) {
      for (const h of entry.horizons || []) {
        if (Number.isFinite(h) && h > maxH) maxH = h;
      }
    }
    const tMeta = this.chart.ctx.manifest.targetById.get(this.chart.fan?.target);
    const isMonthly = (this.chart.fan?.timeUnit || tMeta?.time_unit) === "month";
    return Number.isFinite(maxH) ? horizonTime(refT, maxH, offDays, isMonthly) : null;
  }

  /** Ensures sample trajectories for the currently settled round are loaded when active. */
  sync() {
    const fan = this.chart.fan;
    if (!fan || !this.isActive()) {
      this._token++;
      if (this.data) { this.data = null; this.loadedKey = ""; this.chart.syncSeasonBounds?.(); this.chart.request(); }
      return;
    }
    const { manifest, store } = this.chart.ctx;
    const s = store.get();
    const targetMeta = manifest.targetById.get(fan.target);
    const base = manifest.baselineFor?.(fan.target, fan.season) ?? manifest.baseline;
    const chartedIds = s.sel.charted.map((c) => c.id);
    if (s.sel.baseline && base && !chartedIds.includes(base)) chartedIds.push(base);

    const anyMarkedSample = manifest.models.some((m) => m.has_samples);
    const eligible = chartedIds.filter((id) => {
      if (!fan.present.has(id)) return false;
      const m = manifest.modelById.get(id);
      if (anyMarkedSample) return !!m?.has_samples;
      return true;
    });
    if (!eligible.length) {
      this._token++;
      if (this.data) { this.data = null; this.loadedKey = ""; this.chart.syncSeasonBounds?.(); this.chart.request(); }
      else { this.data = null; this.loadedKey = ""; }
      return;
    }

    const idx = this.chart.nav?.week ?? Math.max(0, fan.dates.length - 1);
    const r = fan.roundAt[idx];
    const settledIso = r >= 0 ? fan.rounds[r] : toIso(fan.dates[idx]);
    if (!settledIso) return;

    const key = cacheKey(fan.target, fan.season, fan.location, settledIso, [...eligible].sort().join(","), s.dims);
    if (key === this.loadedKey && this.data !== undefined) return;

    const token = ++this._token;
    loadRoundTrajectories(fan.target, fan.season, fan.location, settledIso, { models: eligible, dims: s.dims })
      .then((res) => {
        if (token !== this._token) return;
        this.loadedKey = key;
        this.data = res;
        this.chart.syncSeasonBounds?.();
        this.chart.request();
      });
  }

  /**
   * Maps loaded sample draws to canvas coordinates aligned with `scene`.
   * @param {object} scene
   * @returns {{ xy: number[], c: string, alpha: number, w: number }[] | null}
   */
  layout(scene) {
    if (!this.isActive() || !this.data?.modelTrajectories?.size || !scene?.series?.length) return null;
    const fan = this.chart.fan;
    if (!fan) return null;
    const settledIso = scene.settle != null && fan.roundAt[scene.settle] >= 0
      ? fan.rounds[fan.roundAt[scene.settle]]
      : toIso(fan.dates[scene.settle ?? 0]);
    if (this.data.reference_date && settledIso && this.data.reference_date !== settledIso) return null;

    const scrubFade = 1 - Math.min(1, Math.abs((scene.t ?? 0) - (scene.settle ?? 0)) / 0.35);
    if (scrubFade <= 0.02) return null;

    const refT = parseIso(this.data.reference_date || settledIso);
    const offDays = Number(this.data.horizon_offset_days) || 0;
    const hasFocus = scene.focus != null && scene.series.some((s) => s.id === scene.focus);
    const out = [];

    const ordered = hasFocus
      ? [...scene.series.filter((s) => s.id !== scene.focus), ...scene.series.filter((s) => s.id === scene.focus)]
      : scene.series;

    const nonNegFan = fan.horizons?.length ? Math.min(...fan.horizons) >= 0 : true;
    const isMonthly = fan.timeUnit === "month";
    const maxAnchorGap = isMonthly ? 35 * DAY : 7 * DAY;

    for (const ser of ordered) {
      const entry = this.data.modelTrajectories.get(ser.id);
      if (!entry?.samples?.length || !entry.horizons?.length) continue;
      const anchor = ser.pts?.[0]?.anchor && Number.isFinite(ser.pts[0].med) ? ser.pts[0] : null;
      const anchorX = anchor ? scene.x(anchor.t) : NaN;
      const anchorY = anchor ? scene.y(anchor.med) : NaN;
      const firstH = nonNegFan ? entry.horizons.find((h) => h >= 0) : entry.horizons[0];
      const firstT = Number.isFinite(firstH) ? horizonTime(refT, firstH, offDays, isMonthly) : NaN;
      const useAnchor = anchor && Number.isFinite(anchorX) && Number.isFinite(anchorY) && Number.isFinite(firstT)
        && anchor.t < firstT && (firstT - anchor.t) <= maxAnchorGap;

      const alpha = (hasFocus ? (ser.id === scene.focus ? 0.28 : 0.045) : 0.16) * scrubFade * (ser.open ?? 1);
      const w = ser.id === scene.focus ? 1.15 : 0.9;
      const samples = entry.samples;
      const cap = Math.min(MAX_DRAWS_PER_MODEL, samples.length);
      const stride = samples.length <= cap ? 1 : samples.length / cap;

      for (let i = 0; i < cap; i++) {
        const samp = samples[Math.min(samples.length - 1, Math.floor(i * stride))];
        const xy = [];
        if (useAnchor) xy.push(anchorX, anchorY);
        for (let k = 0; k < entry.horizons.length; k++) {
          if (nonNegFan && entry.horizons[k] < 0) continue;
          const val = samp.values[k];
          if (!Number.isFinite(val)) continue;
          const pt = horizonTime(refT, entry.horizons[k], offDays, isMonthly);
          xy.push(scene.x(pt), scene.y(val));
        }
        if (xy.length >= 4) out.push({ xy, c: ser.c, alpha, w });
      }
    }
    return out.length ? out : null;
  }

  destroy() {
    this._token++;
    this.data = null;
    this.loadedKey = "";
  }
}
