/* Dates and values as they read on screen. Dates are UTC ms; formatters are created once and reused. */

const DASH = "–";
const dtf = (o) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...o });
const F_DAY = dtf({ month: "short", day: "numeric" });
const F_LONG = dtf({ month: "short", day: "numeric", year: "numeric" });
const F_MON = dtf({ month: "short" });
const F_MON_Y = dtf({ month: "short", year: "numeric" });

/** @param {number} ms @returns {string} "Dec 27" ("–" when not a date) */
export const fmtDay = (ms) => (Number.isFinite(ms) ? F_DAY.format(ms) : DASH);
/** @param {number} ms @returns {string} "Dec 27, 2025" */
export const fmtLong = (ms) => (Number.isFinite(ms) ? F_LONG.format(ms) : DASH);
/** @param {number} ms @returns {string} "Dec", or "Jan 2026" for January (where the year turns) */
export const fmtMonth = (ms) => (!Number.isFinite(ms) ? DASH : new Date(ms).getUTCMonth() === 0 ? F_MON_Y.format(ms) : F_MON.format(ms));

const F_INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const F_ONE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const F_PCT2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const F_PCT1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const PREFIX = [[1e9, "G"], [1e6, "M"], [1e3, "k"]];

// a number with float noise removed and no trailing zeros: 2.5000000001 → "2.5"
const trim = (v, digits = 12) => String(+v.toPrecision(digits));

// SI-prefixed (like d3 "~s" from thousands up); below 1000 the plain number
function si(v, digits) {
  const r = +v.toPrecision(digits), a = Math.abs(r);
  for (const [k, p] of PREFIX) if (a >= k) return trim(r / k, digits) + p;
  return trim(r, digits);
}

/**
 * Value formatters for one target.
 * @param {{ scale?: "count" | "proportion" } | null | undefined} target a manifest target
 * @returns {{ value(v: number): string, axis(v: number): string, compact(v: number): string }}
 *   count: value "12,345" (one decimal under 10 when not whole), axis "10k" · "2.5k" · "500",
 *   compact "1.2k". proportion (values are fractions): value "1.23%" (2 decimals under 10%, 1 above),
 *   axis "0.5%" · "2%", compact as value. Every formatter returns "–" for a non-finite value.
 */
export function valueFormat(target) {
  const guard = (f) => (v) => (typeof v === "number" && Number.isFinite(v) ? f(v) : DASH);
  if (target?.scale === "proportion") {
    const value = guard((v) => { const p = v * 100; return (Math.abs(p) < 10 ? F_PCT2 : F_PCT1).format(p) + "%"; });
    return { value, axis: guard((v) => trim(v * 100) + "%"), compact: value };
  }
  if (target?.scale === "percentage") {
    const value = guard((v) => (Math.abs(v) < 10 ? F_PCT2 : F_PCT1).format(v) + "%");
    return { value, axis: guard((v) => trim(v) + "%"), compact: value };
  }
  return {
    value: guard((v) => (Math.abs(v) < 10 && !Number.isInteger(v) ? F_ONE : F_INT).format(v)),
    axis: guard((v) => si(v, 12)),
    compact: guard((v) => si(v, 2)),
  };
}
