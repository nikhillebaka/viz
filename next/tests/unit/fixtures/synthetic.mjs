// Builds VZF1 fan payloads (the format of core/next_api.py) for tests.
export const Q23 = [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.975, 0.99];

const DAY = 864e5;
export const isoAdd = (iso, days) => new Date(Date.parse(iso + "T00:00:00Z") + days * DAY).toISOString().slice(0, 10);
export const weeks = (iso, n, step = 1) => Array.from({ length: n }, (_, i) => isoAdd(iso, 7 * i * step));

/**
 * @param {object} o
 * @param {string[]} o.rounds
 * @param {[string, number][]} o.observed
 * @param {{ id: string, value: (round: number, h: number, q: number) => number }[]} o.models  NaN = no value
 * @returns {ArrayBuffer}
 */
export function buildFan({ rounds, observed = [], models = [], horizons = [0, 1, 2, 3], quantiles = Q23, priorMax = null,
  target = "wk inc flu hosp", season = "2025-2026", location = "US", start = "2025-07-27", end = "2026-08-01", pad = true }) {
  const R = rounds.length, H = horizons.length, Qn = quantiles.length;
  const body = [...observed.map(([, v]) => v)];
  const head = { target, season, location, start, end, rounds, horizons, quantiles,
    observed: { dates: observed.map(([d]) => d), offset: 0, length: observed.length }, prior_max: priorMax, models: [] };
  for (const m of models) {
    const offset = body.length, has = [];
    for (let r = 0; r < R; r++) {
      let any = false;
      for (let hi = 0; hi < H; hi++) for (let qi = 0; qi < Qn; qi++) { const v = m.value(r, horizons[hi], quantiles[qi]); if (Number.isFinite(v)) any = true; body.push(v); }
      if (any) has.push(r);
    }
    head.models.push({ id: m.id, offset, rounds: has });
  }
  let json = new TextEncoder().encode(JSON.stringify(head));
  if (pad && json.length % 4) { const p = new Uint8Array(json.length + (4 - (json.length % 4))).fill(32); p.set(json); json = p; }
  const buf = new ArrayBuffer(8 + json.length + body.length * 4);
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  u8.set([86, 90, 70, 49], 0); // "VZF1"
  dv.setUint32(4, json.length, true);
  u8.set(json, 8);
  body.forEach((v, i) => dv.setFloat32(8 + json.length + 4 * i, v, true));
  return buf;
}

/** A model whose quantiles spread linearly around a median that follows f(round, h). */
export const spread = (id, f, width = 0.3, { only } = {}) => ({
  id,
  value: (r, h, q) => {
    if (only && !only.includes(q) && q !== 0.5) return NaN;
    const m = f(r, h);
    return Number.isFinite(m) ? m * (1 + (q - 0.5) * 2 * width) : NaN;
  },
});
