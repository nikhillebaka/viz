/* Linear scales, round tick steps and UTC calendar helpers (what next/ used d3 for).
 *
 * Times are UTC milliseconds everywhere; ISO "YYYY-MM-DD" strings only at the edges. */

export const DAY = 864e5;
export const WEEK = 7 * DAY;

/**
 * A linear map from a domain to a range. Called per frame per point, so it is a bare closure: no
 * allocation per call.
 * @param {[number, number]} domain
 * @param {[number, number]} range
 * @returns {((v: number) => number) & { invert(px: number): number, domain(): readonly number[], range(): readonly number[] }}
 *   `s(v)` maps a value to the range, `s.invert(px)` maps back; `domain()` and `range()` return the
 *   (frozen) arrays the scale was made with. A zero-width domain maps everything to r0.
 */
export function linear([d0, d1], [r0, r1]) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const ik = r1 === r0 ? 0 : (d1 - d0) / (r1 - r0);
  const s = (v) => r0 + (v - d0) * k;
  const dom = Object.freeze([d0, d1]), ran = Object.freeze([r0, r1]);
  s.invert = (px) => d0 + (px - r0) * ik;
  s.domain = () => dom;
  s.range = () => ran;
  return s;
}

// candidate mantissas for a step, with the log-midpoints between neighbours as thresholds
const STEPS = [1, 2, 2.5, 5, 10];
const CUTS = [Math.sqrt(2), Math.sqrt(5), Math.sqrt(12.5), Math.sqrt(50)];

/**
 * A round step for about `count` intervals over `span`: m × 10ⁿ with m in {1, 2, 2.5, 5}, the
 * candidate nearest span/count in log space.
 * @param {number} span  positive
 * @param {number} [count=5]
 * @returns {number} the step (NaN for a non-positive or non-finite span)
 */
export function niceStep(span, count = 5) {
  if (!(span > 0) || !Number.isFinite(span)) return NaN;
  const raw = span / count, p = Math.floor(Math.log10(raw)), e = raw / 10 ** p;
  let i = 0;
  while (i < CUTS.length && e >= CUTS[i]) i++;
  return round12(STEPS[i] * 10 ** p);
}

// d3's tick increment (1, 2, 5 × 10ⁿ), which its scale.nice() uses
function d3Step(span, count) {
  const raw = span / count, p = Math.floor(Math.log10(raw)), e = raw / 10 ** p;
  return (e >= Math.sqrt(50) ? 10 : e >= Math.sqrt(10) ? 5 : e >= Math.sqrt(2) ? 2 : 1) * 10 ** p;
}

/**
 * The axis maximum for data reaching `max`, rounded up as d3's `scaleLinear([0, max]).nice(count)`
 * rounds it (42626 → 50000, 116 → 120, 0.0842 → 0.1).
 * @param {number} max
 * @param {number} [count=5]
 * @returns {number} ≥ max; `max` itself when it is not a positive finite number
 */
export function niceMax(max, count = 5) {
  if (!(max > 0) || !Number.isFinite(max)) return max;
  let top = max, prev = NaN;
  for (let i = 0; i < 10; i++) {
    const step = d3Step(top, count);
    if (step === prev) break;
    top = round12(Math.ceil(top / step - 1e-9) * step);
    prev = step;
  }
  return top;
}

/**
 * Every multiple of `step` in [lo, hi], computed as k × step and cleaned of float noise
 * (0.1 × 3 is 0.3, not 0.30000000000000004).
 * @param {number} lo
 * @param {number} hi
 * @param {number} step positive
 * @returns {number[]} ascending; empty when the range or step is degenerate
 */
export function ticks(lo, hi, step) {
  const out = [];
  if (!(step > 0) || !(hi >= lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return out;
  const k0 = Math.ceil(lo / step - 1e-9), k1 = Math.floor(hi / step + 1e-9);
  for (let k = k0; k <= k1; k++) out.push(round12(k * step));
  return out;
}

const round12 = (v) => (v === 0 ? 0 : +v.toPrecision(12));

/**
 * @param {string} iso "YYYY-MM-DD"
 * @returns {number} UTC ms at midnight (NaN when malformed)
 */
export function parseIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}

/**
 * @param {number} ms UTC ms
 * @returns {string} "YYYY-MM-DD" of that UTC day
 */
export const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The first day of every UTC month in [t0, t1).
 * @param {number} t0 ms
 * @param {number} t1 ms
 * @returns {number[]} ascending ms
 */
export function monthStarts(t0, t1) {
  const out = [];
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return out;
  const d = new Date(t0);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  let t = Date.UTC(y, m, 1);
  if (t < t0) { m++; t = Date.UTC(y, m, 1); }
  while (t < t1) { out.push(t); m++; t = Date.UTC(y, m, 1); }
  return out;
}

/**
 * @param {number} ms
 * @param {number} n weeks (may be fractional or negative)
 * @returns {number} ms + n weeks
 */
export const addWeeks = (ms, n) => ms + n * WEEK;
