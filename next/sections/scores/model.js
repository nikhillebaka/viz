/* The leaderboard's logic, without DOM: the /api/next/metrics request for a scope, rows from its response
 * (horizon subsets, log scale), sorting and ranks, score colors, the scope line's words, exports and the
 * CLI command. Pure (node tests run it). */
import { HORIZONS, seasonWeekEnd, startYearOf } from "../scope.js";

export const LEVELS = Object.freeze([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98]);
export const SMALL = 10;          // fewer scored forecasts than this: a small sample
export const DASH = "–";

/* ------------------------------------------------------------------ request */

/**
 * The /api/next/metrics query for a scope. With a horizon subset the server scores only those horizons
 * (`query`); `full` is the same scope on every horizon, for the by-horizon columns (null without a subset). When `query` scores every model,
 * `quick` is the same scope on just the selected models and the baseline: a fraction of the cost, so the
 * table can show them while the full pool loads, and the pool "Wins" is counted in (null otherwise:
 * `query` already is that).
 * @param {ReturnType<import("../scope.js").scopeOf>} scope
 * @param {{ target: string, selected: string[], allSeasons: string[] }} o
 * @returns {{ query: string, full: string | null, quick: string | null, key: string, models: "all" | string[] }}
 *   key identifies the response
 */
function applyScopeFilters(p, scope, { allSeasons = [], availableHorizons = HORIZONS } = {}) {
  const all = allSeasons.length > 1 && scope.seasons.length === allSeasons.length;
  p.set("season", all ? "all" : scope.seasons.join(","));
  p.set("fair", scope.fair ? "1" : "0");
  if (scope.weeks) p.set("weeks", `${scope.weeks[0]}-${scope.weeks[1]}`);
  if (scope.phase) p.set("phase", scope.phase);
  const hs = scope.horizons && scope.horizons.length < availableHorizons.length ? [...scope.horizons].sort((a, b) => a - b) : null;
  return hs;
}

export function metricsRequest(scope, { target, selected, allSeasons, availableHorizons = HORIZONS }) {
  const p = new URLSearchParams();
  p.set("target", target);
  p.set("location", scope.location);
  p.set("date", "all");
  const hs = applyScopeFilters(p, scope, { allSeasons, availableHorizons });
  // relative WIS among every model in scope, so adding a model never moves anyone else's number;
  // shared-only (common tasks) is defined among the selected models, so it scores just those
  const picked = [...new Set([...selected, scope.baseline].filter(Boolean))].sort();
  const models = scope.rank === "all" && !scope.fair ? "all" : picked;
  p.set("models", models === "all" ? "all" : models.join(","));
  if (scope.baseline) p.set("baseline", scope.baseline);
  const full = hs ? p.toString() : null;
  if (hs) p.set("horizons", hs.join(","));
  const query = p.toString();
  let quick = null;
  if (models === "all" && picked.length) { p.set("models", picked.join(",")); quick = p.toString(); }
  return { query, full, quick, key: query, models };
}

/**
 * Query string for `/api/next/model-locations` matching the active leaderboard evaluation scope.
 * @param {string} id
 * @param {ReturnType<import("../scope.js").scopeOf>} scope
 * @param {{ target: string, selected?: string[], allSeasons?: string[], availableHorizons?: number[], baseline?: string | null }} o
 * @returns {string}
 */
export function modelLocationsQuery(id, scope, { target, selected = [], allSeasons = [], availableHorizons = HORIZONS, baseline = null } = {}) {
  const p = new URLSearchParams();
  p.set("model", id);
  p.set("target", target);
  const hs = applyScopeFilters(p, scope, { allSeasons, availableHorizons });
  const effBase = baseline || scope.baseline;
  const picked = [...new Set([...selected, effBase, id].filter(Boolean))].sort();
  const models = scope.rank === "all" && !scope.fair ? "all" : picked;
  p.set("models", models === "all" ? "all" : models.join(","));
  if (effBase) p.set("baseline", effBase);
  if (hs) p.set("horizons", hs.join(","));
  return p.toString();
}

/* ------------------------------------------------------------------ rows */

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const calOf = (cal) => LEVELS.map((l) => {
  if (!cal) return null;
  const k = Object.keys(cal).find((x) => Math.abs(+x - l) < 1e-3);
  return k == null ? null : num(cal[k]);
});

/**
 * Leaderboard rows from a /api/next/metrics response.
 * @param {object} resp the response (scored on the scope's horizons)
 * @param {{ ids: string[], baseline: string, scale: "natural" | "log", full?: object | null,
 *           wins?: object | null, pending?: boolean, label(id: string): string, team?(id: string): string }} o
 *   ids: the models to show (the baseline is added); full: the response on every horizon, read for
 *   `byH` when `resp` covers a horizon subset (default `resp`); wins: the response "Wins" is read from
 *   (the selected models' own; default `resp`, null: not here yet); pending: `resp` is the quick
 *   (selected-only) response standing in for the full pool, so relative WIS is not shown yet
 * @returns {object[]} one row per id (and the baseline), in `ids` order, baseline last. A row: { id,
 *   label, team, baseline, active, pending, note, seasons, n, rounds: [available, total], q, rel, wis,
 *   mae, cov50, cov80, cov95, sharp, per100k, delta, wins, competed, comp: { spread, over, under },
 *   cal: (number|null)[] by LEVELS, byH: { [h]: { wis, rel, comp, cal, n } } }.
 *   byH's rel is the ratio of mean WIS to the baseline's at that horizon.
 */
export function rowsFrom(resp, { ids, baseline, scale, full = null, wins = resp, pending = false, label, team = () => "" }) {
  const byId = new Map((resp?.rankings || []).map((r) => [r.model_id, r]));
  const winsById = new Map((wins?.rankings || []).map((r) => [r.model_id, r]));
  const allH = full ? new Map((full.rankings || []).map((r) => [r.model_id, r])) : byId;
  const isCat = !!resp?.is_categorical || (resp?.rankings || []).some((r) => r.has_data_in_scope && r.wis == null && (r.rps != null || r.log_score != null));
  const ordinal = resp?.ordinal !== false;
  const rankMetric = resp?.rank_metric || (ordinal ? "rps" : "log_score");
  const log = scale === "log";
  const eff = resp?.baseline_model || baseline;
  const base = allH.get(full?.baseline_model || eff) || allH.get(baseline);
  const wisKey = log ? "wis_log" : "wis";
  const hValKey = isCat ? rankMetric : wisKey;
  const hSet = new Set(HORIZONS);
  for (const entry of allH.values()) {
    for (const k of Object.keys(entry?.by_horizon || {})) {
      const n = Number(k);
      if (Number.isInteger(n)) hSet.add(n);
    }
  }
  const hs = [...hSet].sort((a, b) => a - b);
  const baseH = {};
  for (const h of hs) baseH[h] = num(base?.by_horizon?.[h]?.[hValKey]);

  const want = [...ids.filter((id) => id !== baseline), baseline].filter((id, i, a) => id && a.indexOf(id) === i);
  return want.map((id) => {
    const r = byId.get(id);
    const isBase = id === baseline;
    const active = isCat
      ? !!(r && r.has_data_in_scope && r.count > 0 && (num(r.rps) != null || num(r.log_score) != null))
      : !!(r && r.has_data_in_scope && num(r.wis) != null && r.count > 0);
    const byH = {};
    const rh = allH.get(id);
    for (const h of hs) {
      const b = rh?.by_horizon?.[h];
      const w = num(b?.[hValKey]);
      byH[h] = b ? {
        wis: num(b?.[wisKey]),
        rps: num(b.rps),
        logScore: num(b.log_score),
        brier: num(b.brier),
        hitMode: num(b.hit_mode),
        n: num(b.count) || 0,
        rel: w != null && baseH[h] ? w / baseH[h] : null,
        comp: { spread: num(b.sharpness_component), over: num(b.overprediction_penalty), under: num(b.underprediction_penalty) },
        cal: calOf(b.calibration),
      } : null;
    }
    const row = {
      id, label: label(id), team: team(id), baseline: isBase, active,
      isCategorical: isCat, ordinal,
      pending: !!r?.pending_truth, note: r?.status_note || (r ? "" : "No forecasts in scope"),
      seasons: r?.active_seasons || [],
      n: active ? r.count : 0,
      rounds: [r?.scope_rounds_available ?? 0, r?.scope_rounds_total ?? 0],
      q: r?.quantile_count ?? null, q23: r ? r.has_23_quantiles !== false : true,
      rel: null, wis: null, mae: null, cov50: null, cov80: null, cov95: null, sharp: null, per100k: null,
      rps: null, logScore: null, brier: null, hitMode: null,
      delta: null, wins: null, competed: null, comp: { spread: null, over: null, under: null },
      cal: LEVELS.map(() => null), byH,
    };
    if (!active) return row;
    if (isCat) {
      row.rps = num(r.rps);
      row.logScore = num(r.log_score);
      row.brier = num(r.brier);
      row.hitMode = num(r.hit_mode);
    } else {
      row.wis = num(r[wisKey]);
      row.mae = num(r[log ? "mae_log" : "mae"]);
      row.cov50 = num(r.cov50); row.cov95 = num(r.cov95);
      row.sharp = num(r.sharpness); row.per100k = num(r.wis_per_100k);
      row.comp = { spread: num(r.decomp_sharpness), over: num(r.decomp_overpred), under: num(r.decomp_underpred) };
      row.cal = calOf(r.calibration);
      row.cov80 = row.cal[LEVELS.indexOf(0.8)];
    }
    row.rel = pending ? null : num(r[!isCat && log ? "relative_wis_log" : "relative_wis"]);
    if (isBase && id === eff && !pending) row.rel = 1;
    row.delta = num(r[!isCat && log ? "pct_diff_vs_baseline_log" : "pct_diff_vs_baseline"]);
    const w = winsById.get(id);
    row.wins = w ? num(w[!isCat && log ? "weeks_won_log" : "weeks_won"]) : null;
    row.competed = w ? num(w.weeks_competed) || null : null;
    if (row.n === 0) row.active = false;
    return row;
  });
}

/* ------------------------------------------------------------------ sorting and ranks */

/** Sort keys: what they read, and whether a new sort starts best-first ascending. */
export const SORTS = Object.freeze({
  rel: { get: (r) => r.rel, asc: true, score: true },
  wis: { get: (r) => r.wis, asc: true, score: true },
  mae: { get: (r) => r.mae, asc: true, score: true },
  rps: { get: (r) => r.rps, asc: true, score: true },
  logScore: { get: (r) => r.logScore, asc: true, score: true },
  brier: { get: (r) => r.brier, asc: true, score: true },
  hitMode: { get: (r) => r.hitMode, asc: false, score: true },
  cov50: { get: (r) => (r.cov50 == null ? null : Math.abs(r.cov50 - 50)), asc: true, score: true },
  cov80: { get: (r) => (r.cov80 == null ? null : Math.abs(r.cov80 - 80)), asc: true, score: true },
  cov95: { get: (r) => (r.cov95 == null ? null : Math.abs(r.cov95 - 95)), asc: true, score: true },
  delta: { get: (r) => r.delta, asc: true, score: true },
  per100k: { get: (r) => r.per100k, asc: true, score: true },
  sharp: { get: (r) => r.sharp, asc: true, score: false },
  wins: { get: (r) => r.wins, asc: false, score: true },
  n: { get: (r) => r.n, asc: false, score: false },
  name: { get: (r) => r.label.toLowerCase(), asc: true, score: false },
  h0: { get: (r) => r.byH[0]?.rel ?? null, asc: true, score: true },
  h1: { get: (r) => r.byH[1]?.rel ?? null, asc: true, score: true },
  h2: { get: (r) => r.byH[2]?.rel ?? null, asc: true, score: true },
  h3: { get: (r) => r.byH[3]?.rel ?? null, asc: true, score: true },
  h4: { get: (r) => r.byH[4]?.rel ?? null, asc: true, score: true },
});
export const DEFAULT_SORT = "rel";

/**
 * Rows in table order: ranked rows by the sort (nulls last whatever the direction, ties by name), then
 * the unranked (no forecasts in scope) by name. Ranks only when the sort is a score; ties share one.
 * @param {object[]} rows from rowsFrom
 * @param {string} key a SORTS key
 * @param {boolean} [reversed=false] the opposite of the key's natural direction
 * @returns {{ ranked: object[], unranked: object[], ranks: Map<string, number> }}
 */
export function sortRows(rows, key = DEFAULT_SORT, reversed = false) {
  const s = SORTS[key] || SORTS[DEFAULT_SORT];
  const asc = s.asc !== reversed;
  const byName = (a, b) => a.label.localeCompare(b.label);
  const ranked = rows.filter((r) => r.active), unranked = rows.filter((r) => !r.active).sort(byName);
  ranked.sort((a, b) => {
    const va = s.get(a), vb = s.get(b);
    if (va == null || vb == null) return va == null && vb == null ? byName(a, b) : va == null ? 1 : -1;
    const c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    return (asc ? c : -c) || byName(a, b);
  });
  const ranks = new Map();
  if (s.score) {
    let prev, rank = 0;
    ranked.forEach((r, i) => {
      const v = s.get(r);
      if (v == null) return;
      if (i === 0 || v !== prev) rank = i + 1;
      prev = v;
      ranks.set(r.id, rank);
    });
  }
  return { ranked, unranked, ranks };
}

/* ------------------------------------------------------------------ score colors */

/**
 * The --score-1..9 step for a ratio to the baseline: 1 (half or less) … 5 (equal) … 9 (twice or more),
 * on a log scale.
 * @param {number | null} rel
 * @returns {number | null}
 */
export function relLevel(rel) {
  if (!(rel > 0)) return null;
  const t = Math.max(-1, Math.min(1, Math.log2(rel)));
  return 5 + Math.round(t * 4);
}

/**
 * The --score step for a coverage against its target: on target 5; intervals too narrow (under) warm,
 * 6..9; too wide (over) cool, 4..1. One step per 5 percentage points, the first after 2.5.
 * @param {number | null} cov percent
 * @param {number} target percent
 * @returns {number | null}
 */
export function coverageLevel(cov, target) {
  if (cov == null) return null;
  const d = cov - target, k = Math.min(4, Math.round(Math.abs(d) / 5));
  return d < 0 ? 5 + k : 5 - k;
}

/* ------------------------------------------------------------------ numbers */

const F0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const F1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
/** A score: integers from 100, one decimal from 10, else 3 significant figures. */
export function fmtScore(v) {
  if (v == null || !Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 100) return F0.format(v);
  if (a >= 10) return F1.format(v);
  if (a === 0) return "0";
  return String(Number(v.toPrecision(3)));
}
export const fmtRel = (v) => (v == null || !Number.isFinite(v) ? DASH : v.toFixed(2));
export const fmtPct = (v) => (v == null || !Number.isFinite(v) ? DASH : F0.format(v));
export const fmtCount = (v) => (v == null || !Number.isFinite(v) ? DASH : F0.format(v));
export const fmtDelta = (v) => (v == null || !Number.isFinite(v) ? DASH : `${v > 0 ? "+" : v < 0 ? "−" : ""}${F0.format(Math.abs(v))}%`);

/* ------------------------------------------------------------------ the scope line's words */

const MON = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Nov 22 – Mar 7" for a week range in a season (the newest scoped one). */
export function weeksDates(seasonId, weeks) {
  const y = startYearOf(seasonId);
  if (!weeks || !Number.isFinite(y)) return "";
  return `${MON.format(seasonWeekEnd(y, weeks[0]))} – ${MON.format(seasonWeekEnd(y, weeks[1]))}`;
}

export const PHASE_LABEL = Object.freeze({ pre: "Pre-peak", peak: "Peak", post: "Post-peak" });

/**
 * The Dates fragment: "2025–26", "2025–26 · Nov 22 – Mar 7", "3 seasons · Peak", "All seasons".
 * @param {ReturnType<import("../scope.js").scopeOf>} scope
 * @param {(id: string) => string} seasonLabel
 * @param {number} seasonCount how many seasons exist
 */
export function datesLabel(scope, seasonLabel, seasonCount) {
  const n = scope.seasons.length;
  const parts = [n === 0 ? "No season" : n === 1 ? seasonLabel(scope.seasons[0]) : n === seasonCount ? "All seasons" : `${n} seasons`];
  if (scope.weeks) parts.push(weeksDates(scope.seasons[0], scope.weeks));
  if (scope.phase) parts.push(PHASE_LABEL[scope.phase]);
  return parts.join(" · ");
}

/** The Horizons fragment: "0–3 wk", "1–4 wk", "0, 2 wk", or "0–3 mo". */
export function horizonsLabel(horizons, availableHorizons = HORIZONS, unit = "wk") {
  const hs = horizons || availableHorizons;
  const run = hs.every((h, i) => i === 0 || h === hs[i - 1] + 1);
  if (hs.length === 1) return `${hs[0]} ${unit}`;
  return run ? `${hs[0]}–${hs.at(-1)} ${unit}` : `${hs.join(", ")} ${unit}`;
}

/* ------------------------------------------------------------------ exports */

/**
 * The export's rows, in table order with the table's ranks (old viz's columns, natural scale; on the log
 * scale the log columns the ranks follow are added).
 * @param {object} resp the /api/next/metrics response
 * @param {{ order: string[], ranks: Map<string, number>, scope: object, target: string, scopeLabel: string,
 *           sourceOf(id: string): string, full?: object | null, wins?: object | null }} o
 *   full, wins: as in rowsFrom (the h columns; weeks won among the selected models, as the table)
 * @returns {object[]}
 */
export function exportRows(resp, { order, ranks, scope, target, scopeLabel, sourceOf, full = null, wins = resp }) {
  const byId = new Map((resp?.rankings || []).map((r) => [r.model_id, r]));
  const winsById = new Map((wins?.rankings || []).map((r) => [r.model_id, r]));
  const isCat = !!resp?.is_categorical || (resp?.rankings || []).some((r) => r.has_data_in_scope && r.wis == null && (r.rps != null || r.log_score != null));
  const rankMetric = resp?.rank_metric || (resp?.ordinal === false ? "log_score" : "rps");
  const log = scope.scale === "log";
  const allH = full ? new Map((full.rankings || []).map((r) => [r.model_id, r])) : byId;
  const r2 = (v, d) => (typeof v === "number" && Number.isFinite(v) ? +v.toFixed(d) : null);
  return order.map((id) => {
    const r = byId.get(id) || {};
    if (isCat) {
      const bhCat = (h) => r2(allH.get(id)?.by_horizon?.[h]?.[rankMetric], 3);
      return {
        rank: ranks.get(id) ?? null, model_id: id, model_type: sourceOf(id),
        tasks_evaluated: r.count ?? 0,
        relative_score: r2(r.relative_wis, 3),
        rps: r2(r.rps, 4),
        log_loss: r2(r.log_score, 4),
        brier_score: r2(r.brier, 4),
        mode_hit_pct: r2(r.hit_mode, 1),
        pct_diff_vs_baseline: r2(r.pct_diff_vs_baseline, 1),
        baseline_model: resp?.baseline_model ?? scope.baseline,
        h0_score: bhCat(0), h1_score: bhCat(1), h2_score: bhCat(2), h3_score: bhCat(3),
        target, evaluation_location: scope.location, evaluation_scope: scopeLabel,
        seasons: scope.seasons.join(","), weeks: scope.weeks ? scope.weeks.join("-") : "", phase: scope.phase || "",
        horizons: scope.horizons ? scope.horizons.join(",") : "", rank_among: scope.rank,
        common_tasks_fair: scope.fair ? "true" : "false", has_data_in_scope: !!r.has_data_in_scope, status_note: r.status_note || "",
      };
    }
    const bh = (h) => r2(allH.get(id)?.by_horizon?.[h]?.wis, 2);
    const w = winsById.get(id) || {};
    return {
      rank: ranks.get(id) ?? null, model_id: id, model_type: sourceOf(id), quantiles: r.quantile_count ?? null,
      tasks_evaluated: r.count ?? 0, overall_wis: r2(r.wis, 2), relative_wis: r2(r.relative_wis, 3),
      ...(log ? { overall_wis_log: r2(r.wis_log, 4), relative_wis_log: r2(r.relative_wis_log, 3) } : {}),
      weeks_won: (log ? w.weeks_won_log : w.weeks_won) ?? null, weeks_competed: w.weeks_competed ?? null,
      pct_diff_vs_baseline: r2(r.pct_diff_vs_baseline, 1), wis_per_100k: r2(r.wis_per_100k, 2),
      baseline_model: resp?.baseline_model ?? scope.baseline, mae: r2(r.mae, 2),
      coverage_95_pct: r2(r.cov95, 1), coverage_50_pct: r2(r.cov50, 1), sharpness: r2(r.sharpness, 1),
      h0_wis_nowcast: bh(0), h1_wis_1wk: bh(1), h2_wis_2wk: bh(2), h3_wis_3wk: bh(3),
      target, evaluation_location: scope.location, evaluation_scope: scopeLabel,
      seasons: scope.seasons.join(","), weeks: scope.weeks ? scope.weeks.join("-") : "", phase: scope.phase || "",
      horizons: scope.horizons ? scope.horizons.join(",") : "", rank_among: scope.rank, scale: scope.scale,
      common_tasks_fair: scope.fair ? "true" : "false", has_data_in_scope: !!r.has_data_in_scope, status_note: r.status_note || "",
    };
  });
}

/**
 * Delimited text: CSV (quoted strings, "" escaping) or TSV (tabs and newlines become spaces). CRLF rows,
 * with a UTF-8 BOM so spreadsheets read accents; null is empty.
 * @param {object[]} rows
 * @param {"csv" | "tsv"} kind
 * @returns {string}
 */
export function delimited(rows, kind = "csv") {
  if (!rows.length) return "\ufeff";
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    if (v == null) return "";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const s = String(v);
    return kind === "tsv" ? s.replace(/[\t\r\n]+/g, " ") : `"${s.replace(/"/g, '""')}"`;
  };
  const sep = kind === "tsv" ? "\t" : ",";
  return "\ufeff" + [cols.map((c) => cell(c)).join(sep), ...rows.map((r) => cols.map((c) => cell(r[c])).join(sep))].join("\r\n");
}

/** flusight_eval_{models}_{loc}_{scope}_{target}.{ext}, as old viz names it. */
export function exportName(ids, scope, target, ext) {
  const slug = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");
  const models = ids.length === 1 ? ids[0] : ids.length <= 3 ? ids.join("_") : `${ids.length}_models`;
  const tag = [scope.seasons.join("+"), scope.weeks && `wk${scope.weeks.join("-")}`, scope.phase].filter(Boolean).join("_") || "all";
  return `${slug(`flusight_eval_${models}_${scope.location}_${tag}`)}_${slug(String(target || "flusight").replace(/\s+/g, "_"))}.${ext}`;
}

/**
 * The command that reproduces these scores with viz/score_cli.py: the selected models and the baseline,
 * as the table's own selected-only request. Hub models are left out (the CLI scores repository and local
 * models only); with none left it scores `all`. What the CLI can't match (relative WIS ranked among
 * every model, a horizon subset, the log scale, hub models) is named in a trailing shell comment.
 * @param {{ ids: string[], scope: object, target: string, defaultTarget: string, isHub(id: string): boolean,
 *           hubBaseline: string, allSeasons: number }} o
 * @returns {string}
 */
export function cliCommand({ ids, scope, target, defaultTarget, isHub, hubBaseline, allSeasons }) {
  const wanted = [...new Set([...ids, scope.baseline].filter(Boolean))];
  const models = wanted.filter((id) => !isHub(id));
  const q = (s) => (/^[\w.,:+-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);
  const season = allSeasons > 1 && scope.seasons.length === allSeasons ? "all" : scope.seasons.join(",");
  const parts = ["python3 viz/score_cli.py", `--models ${models.length ? models.join(",") : "all"}`];
  if (season) parts.push(`--season ${season}`);
  if (scope.weeks) parts.push(`--weeks ${scope.weeks[0]}-${scope.weeks[1]}`);
  if (scope.phase) parts.push(`--phase ${scope.phase}`);
  parts.push(`--location ${q(scope.location)}`);
  if (target && target !== defaultTarget) parts.push(`--target ${q(target)}`);
  if (scope.baseline && scope.baseline !== hubBaseline) parts.push(`--baseline ${q(scope.baseline)}`);
  if (scope.fair) parts.push("--fair");
  const differs = [
    scope.rank === "all" && !scope.fair && "Rel. WIS among these only",
    scope.horizons && `${horizonsLabel(scope.horizons)} not in CLI`,
    scope.scale === "log" && "log scale not in CLI",
    models.length < wanted.length && "hub models left out",
  ].filter(Boolean);
  if (differs.length) parts.push(`# ${differs.join(" · ")}`);
  return parts.join(" ");
}
