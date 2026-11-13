/* Fan chart data per season and location (studies/seasons-locations-goals.md).
 *
 * Reads data/scores.json (seasons, rounds, models, observed data per season and location, metadata) and
 * data/fc/<season>/<loc>.json (forecasts). loadFan() returns the same shape lib/chart.js has always drawn
 * (D, FC, DATES, Q, MED, truth, YMAX, DI0), one object per (season, location), cached.
 *
 * A season's timeline is every week from its first round to its last (weeks with no round simply have no
 * forecasts), so the time navigator can keep treating dates as weekly. Its full view runs from the season's
 * first observed week to its last (or the last round's forecasts, if later). */
export const WEEK = 7 * 864e5;
export const Q = [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.975, 0.99];
const parse = (s) => new Date(s + "T00:00:00Z");
export const isoDay = (d) => new Date(+d).toISOString().slice(0, 10);
export const seasonLabel = (id) => `${id.slice(0, 4)}–${id.slice(5)}`;

export function timeline(man, sid) {
  const s = man.seasonById.get(sid);
  const first = parse(s.rounds[0]), last = parse(s.rounds.at(-1));
  const dates = []; for (let t = +first; t <= +last; t += WEEK) dates.push(new Date(t));
  // the full view: the season's observed data (from late summer) through the last round's forecasts, the
  // same rule the chart has always used (panning into the quiet early weeks depends on it)
  const obs = (man.truth[sid]?.US || []).map(([d]) => parse(d));
  const window = [obs.length ? obs[0] : new Date(+first - 12 * WEEK), new Date(Math.max(obs.length ? +obs.at(-1) : 0, +last + 3 * WEEK))];
  return { sid, dates, iso: dates.map(isoDay), rounds: new Set(s.rounds), window };
}

/* Every round of every season, in order, for the date picker and for crossing seasons. */
export const allRounds = (man) => man.seasons.flatMap((s) => s.rounds.map((r) => ({ sid: s.id, iso: r, date: parse(r) })));
export const seasonOf = (man, date) => man.seasons.find((s) => { const tl = timeline(man, s.id); return +date >= +tl.dates[0] && +date <= +tl.dates.at(-1); })?.id ?? null;

const cache = new Map();
export function loadFan(man, sid, loc) {
  const key = `${sid}|${loc}`;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    const FC = await fetch(`${man.base}fc/${sid}/${loc}.json`).then((r) => (r.ok ? r.json() : {}));
    const tl = timeline(man, sid), s = man.seasonById.get(sid);
    const truth = (man.truth[sid]?.[loc] || []).map(([d, v]) => ({ date: parse(d), v }));
    const inWin = truth.filter((t) => +t.date >= +tl.window[0] && +t.date <= +tl.window[1]);
    let top = Math.max(0, ...inWin.map((t) => t.v));
    if (!top) { // no observed data yet this season: last season's peak for this place
      const prev = man.seasons[man.seasons.findIndex((x) => x.id === sid) - 1];
      top = Math.max(1, ...((prev && man.truth[prev.id]?.[loc]) || []).map(([, v]) => v));
    }
    const D = { dates: tl.iso, models: s.models, quantiles: Q, baseline: man.baseline, locations: man.locations };
    const DATES = tl.dates, MED = Q.indexOf(0.5);
    const fcPts = (m, di) => { const a = FC[m]?.[D.dates[di]]; return a ? a.map((x, h) => (x ? { date: new Date(+DATES[di] + h * WEEK), h, a: x } : null)).filter(Boolean) : null; };
    // which models forecast here at all this season (for "not in …" and the picker)
    const present = new Set(Object.keys(FC));
    // default date: the latest round with any forecast here
    let DI0 = DATES.length - 1;
    while (DI0 > 0 && !Object.values(FC).some((r) => r[D.dates[DI0]])) DI0--;
    return { sid, loc, D, FC, DATES, Q, MED, truth, YMAX: top * 1.08, fcPts, DI0, present, timeline: tl, STATES: [] };
  })();
  cache.set(key, p);
  return p;
}
