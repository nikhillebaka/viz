/* Scoring for the evaluation section (studies/evaluation-goals.md).
 *
 * Data: data/scores.json (manifest) + data/scores-<season>.bin, written by data/extract_scores.py. Each
 * season holds, per (model, round, location, horizon), WIS and its three components (Float32, NaN when not
 * scored), coverage bits (Uint16, one per LEVELS entry) and a state byte (0 no forecast, 1 awaiting truth,
 * 2 scored).
 *
 * A scope picks seasons, a week-of-season window, locations and horizons. Scoring a scope gives one row per
 * model: forecasts scored, mean WIS and components, coverage at every level, relative WIS (pairwise, Cramer
 * et al. 2022) and relative WIS per horizon. Slices give the heatmap's cells.
 *
 * Speed: tasks are grouped in blocks (one round of one season: every location × horizon in scope). Per model
 * and block we keep the WIS sum, the count and whether the block is complete, so a pair of models that are
 * both complete in a block uses the sums directly, and only partial blocks are walked task by task.
 */
export const WEEK = 7 * 864e5;

export async function loadManifest(base = "data/") {
  const man = await (await fetch(base + "scores.json")).json();
  man.base = base;
  man.locIndex = new Map(man.locations.map((l, i) => [l.id, i]));
  man.seasonById = new Map(man.seasons.map((s) => [s.id, s]));
  man.loaded = new Map();
  return man;
}

/* Week of season: weeks since Aug 1 of the season's first year. Same for every season, so a window of weeks
 * applies to each season alike. */
export const weekOfSeason = (season, date) => Math.floor((Date.parse(date) - Date.parse(`${season.slice(0, 4)}-08-01`)) / WEEK);
export const seasonLabel = (id) => `${id.slice(0, 4)}–${id.slice(5)}`;

export async function loadSeason(man, id) {
  if (man.loaded.has(id)) return man.loaded.get(id);
  const s = man.seasonById.get(id);
  const p = fetch(`${man.base}scores-${id}.bin`).then((r) => r.arrayBuffer()).then((buf) => {
    const M = s.models.length, R = s.rounds.length, L = man.locations.length, N = M * R * L * 4;
    let o = 0;
    const f32 = () => { const a = new Float32Array(buf, o, N); o += 4 * N; return a; };
    const wis = f32(), disp = f32(), over = f32(), under = f32();
    const cov = new Uint16Array(buf, o, N); o += 2 * N;
    const state = new Uint8Array(buf, o, N);
    const season = { id, models: s.models, rounds: s.rounds, M, R, L, wis, disp, over, under, cov, state,
      mIndex: new Map(s.models.map((m, i) => [m, i])), weeks: s.rounds.map((d) => weekOfSeason(id, d)) };
    man.loaded.set(id, season);
    return season;
  });
  man.loaded.set(id, p);
  return p;
}

/* Location indices for a scope's locations: "states" (every non-US location), "US", or a list of ids.
 * Pooled like old viz: if any state is in scope, the US national forecast is left out. */
export function locationSet(man, locations) {
  const us = man.locIndex.get("US");
  if (locations === "US") return [us];
  if (locations === "states") return man.locations.map((_, i) => i).filter((i) => i !== us);
  const ids = locations.map((id) => man.locIndex.get(id)).filter((i) => i != null);
  return ids.some((i) => i !== us) ? ids.filter((i) => i !== us) : ids;
}

/* Build the task table for a scope. Returns models (union across seasons), blocks, and per model a Float64
 * WIS array over all tasks (NaN = not scored). */
function tasks(man, scope) {
  const seasons = scope.seasons.map((id) => man.loaded.get(id)).filter((s) => s && !(s instanceof Promise));
  const locs = locationSet(man, scope.locations), H = scope.horizons ?? [0, 1, 2, 3];
  const [w0, w1] = scope.weeks ?? [-Infinity, Infinity];
  const asOf = scope.asOf ? Date.parse(scope.asOf) : Infinity;   // pretend truth isn't in yet after this date
  const models = [...new Set(seasons.flatMap((s) => s.models))].sort();
  const blocks = [];  // { s, r, season, round, week }
  for (const s of seasons) s.rounds.forEach((d, r) => { if (s.weeks[r] >= w0 && s.weeks[r] <= w1) blocks.push({ s, r, season: s.id, round: d, week: s.weeks[r] }); });
  const per = locs.length * H.length, T = blocks.length * per;
  const tl = new Int16Array(T), th = new Int8Array(T), tb = new Int32Array(T);
  let t = 0;
  for (let b = 0; b < blocks.length; b++) for (const l of locs) for (const h of H) { tl[t] = l; th[t] = h; tb[t] = b; t++; }
  return { seasons, locs, H, blocks, per, T, tl, th, tb, models, asOf };
}

/* Gather one field for one model over the task table. */
function gather(tk, m, field, out) {
  out.fill(NaN);
  const { blocks, per, locs, H, asOf } = tk;
  let t = 0;
  for (const bl of blocks) {
    const s = bl.s, mi = s.mIndex.get(m);
    if (mi == null) { t += per; continue; }
    const arr = s[field], st = s.state;
    const pending = asOf < Date.parse(bl.round) + 7 * 864e5;   // rough: rounds after asOf count as awaiting truth
    for (const l of locs) {
      const base = ((mi * s.R + bl.r) * s.L + l) * 4;
      for (const h of H) {
        const i = base + h;
        if (st[i] === 2 && !(pending && Date.parse(bl.round) + h * WEEK > asOf)) out[t] = arr[i];
        t++;
      }
    }
  }
  return out;
}

/* Score a scope. scope: { seasons, weeks: [w0, w1] | null, locations, horizons, shared, among: "all" |
 * "selected", selected: [...ids], baseline }. Returns { rows, baseline, blocks, models }. */
export function score(man, scope) {
  const tk = tasks(man, scope);
  const { T, blocks, per, models, th } = tk;
  const baseline = scope.baseline ?? man.baseline;
  // Tournament set
  let set = models;
  if (scope.among === "selected") set = models.filter((m) => m === baseline || scope.selected?.includes(m));
  const W = set.map((m) => gather(tk, m, "wis", new Float64Array(T)));
  // Shared forecasts only: keep tasks every model in the set has.
  let keep = null;
  if (scope.shared) {
    const sel = set.map((m, i) => i).filter((i) => set[i] === baseline || !scope.selected || scope.selected.includes(set[i]));
    keep = new Uint8Array(T).fill(1);
    for (const i of sel) for (let t = 0; t < T; t++) if (Number.isNaN(W[i][t])) keep[t] = 0;
    for (const w of W) for (let t = 0; t < T; t++) if (!keep[t]) w[t] = NaN;
  }
  // Per model, per block: sum, count, complete.
  const B = blocks.length, M = set.length;
  const bs = new Float64Array(M * B), bc = new Int32Array(M * B);
  for (let i = 0; i < M; i++) for (let t = 0; t < T; t++) { const v = W[i][t]; if (v === v) { const k = i * B + tk.tb[t]; bs[k] += v; bc[k]++; } }
  // Pairwise ratios on shared tasks.
  const logTheta = new Float64Array(M), nPartners = new Int32Array(M);
  for (let i = 0; i < M; i++) {
    let acc = 0, n = 0;
    for (let j = 0; j < M; j++) {
      if (i === j) { n++; continue; }   // ratio 1 with itself, as in old viz
      let si = 0, sj = 0, c = 0;
      for (let b = 0; b < B; b++) {
        const ci = bc[i * B + b], cj = bc[j * B + b];
        if (!ci || !cj) continue;
        if (ci === per && cj === per) { si += bs[i * B + b]; sj += bs[j * B + b]; c += per; continue; }
        const wi = W[i], wj = W[j];
        for (let t = b * per, e = t + per; t < e; t++) { const a = wi[t], z = wj[t]; if (a === a && z === z) { si += a; sj += z; c++; } }
      }
      if (c && si > 0 && sj > 0) { acc += Math.log(si / sj); n++; }
    }
    logTheta[i] = n > 1 ? acc / n : NaN;
    nPartners[i] = n - 1;
  }
  let bi = set.indexOf(baseline), refName = baseline;
  if (bi < 0 || Number.isNaN(logTheta[bi])) {   // baseline missing in scope: fall back like old viz
    bi = set.findIndex((m, i) => /baseline/i.test(m) && !Number.isNaN(logTheta[i]));
    if (bi < 0) bi = set.findIndex((m, i) => /ensemble/i.test(m) && !Number.isNaN(logTheta[i]));
    if (bi < 0) bi = logTheta.findIndex((v) => !Number.isNaN(v));
    refName = set[bi] ?? null;
  }
  const levels = man.levels;
  const tmp = new Float64Array(T), covTmp = new Float64Array(T);
  const rows = set.map((m, i) => {
    const w = W[i];
    let n = 0, sw = 0;
    for (let t = 0; t < T; t++) if (w[t] === w[t]) { n++; sw += w[t]; }
    const mean = (field) => { gather(tk, m, field, tmp); let s = 0; for (let t = 0; t < T; t++) if (w[t] === w[t]) s += tmp[t]; return n ? s / n : NaN; };
    const cov = {};
    if (n) {
      gather(tk, m, "cov", covTmp);
      levels.forEach((lv, k) => { let c = 0; for (let t = 0; t < T; t++) if (w[t] === w[t] && (covTmp[t] & (1 << k))) c++; cov[lv] = (100 * c) / n; });
    }
    // Relative WIS per horizon, direct vs the reference on shared tasks.
    const byH = [0, 1, 2, 3].map((h) => {
      if (bi < 0) return NaN;
      const r = W[bi]; let a = 0, z = 0;
      for (let t = 0; t < T; t++) if (th[t] === h && w[t] === w[t] && r[t] === r[t]) { a += w[t]; z += r[t]; }
      return z > 0 ? a / z : NaN;
    });
    // Forecasts possible: tasks the reference has scored (a stand-in for "rounds × locations in scope").
    let possible = 0; if (bi >= 0) for (let t = 0; t < T; t++) if (W[bi][t] === W[bi][t]) possible++;
    const seasonsActive = tk.seasons.filter((s) => s.mIndex.has(m)).map((s) => s.id);
    return {
      m, n, possible, wis: n ? sw / n : NaN,
      disp: n ? mean("disp") : NaN, over: n ? mean("over") : NaN, under: n ? mean("under") : NaN,
      rel: bi >= 0 && !Number.isNaN(logTheta[i]) ? Math.exp(logTheta[i] - logTheta[bi]) : NaN,
      partners: nPartners[i], cov, byH, seasons: seasonsActive,
      status: n ? "ok" : seasonsActive.length ? "none-in-scope" : "other-season",
    };
  });
  return { rows, baseline: refName, requestedBaseline: baseline, blocks, models: set, tk, W, keep };
}

/* Heatmap cells: for each model, the ratio of its mean WIS to the reference's on their shared tasks, per
 * column. axis: "weeks" (one column per round), "locations", "horizons". */
export function slices(man, result, axis) {
  const { tk, W, models, baseline } = result;
  const bi = models.indexOf(baseline), ref = W[bi];
  const cols = axis === "weeks" ? result.blocks.map((b, i) => ({ key: i, label: b.round, season: b.season, week: b.week }))
    : axis === "locations" ? tk.locs.map((l) => ({ key: l, label: man.locations[l].abbr }))
    : tk.H.map((h) => ({ key: h, label: `${h}` }));
  const colOf = (t) => axis === "weeks" ? tk.tb[t] : axis === "locations" ? tk.locs.indexOf(tk.tl[t]) : tk.H.indexOf(tk.th[t]);
  const C = cols.length, colIdx = new Int32Array(tk.T);
  for (let t = 0; t < tk.T; t++) colIdx[t] = colOf(t);
  const cells = new Map();
  models.forEach((m, i) => {
    const a = new Float64Array(C), z = new Float64Array(C), n = new Int32Array(C), w = W[i];
    for (let t = 0; t < tk.T; t++) { const v = w[t], r = ref ? ref[t] : NaN; if (v === v && r === r) { const c = colIdx[t]; a[c] += v; z[c] += r; n[c]++; } }
    cells.set(m, Array.from({ length: C }, (_, c) => ({ ratio: z[c] > 0 ? a[c] / z[c] : NaN, wis: n[c] ? a[c] / n[c] : NaN, base: n[c] ? z[c] / n[c] : NaN, n: n[c] })));
  });
  return { cols, cells };
}
