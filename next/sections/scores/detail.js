/* An expanded leaderboard row: one model's detail. Anatomy by horizon, coverage curve against the baseline's, a state tile grid in the score
 * colors, one tick per round, and facts from /api/model-details. Paper, not a panel. */
import { h } from "../../lib/dom.js";
import { linear } from "../../lib/scale.js";
import { tooltip } from "../../ui/floating.js";
import { TILES, COLUMNS } from "../../features/LocationPicker.js";
import { classifyHubGeo } from "../../geo/picker_geo.js";
import { EU_GRID_PROPORTIONED, EU_TILES_PROPORTIONED, EU_TILES_PROPORTIONED_UK_SPLIT } from "../../geo/eu_tiles.js";
import { LEVELS, fmtScore, fmtRel, relLevel } from "./model.js";
import { loadDetails, loadPlaces } from "./data.js";
import { s } from "./figures.js";
import { seriesColor } from "../../chart/layout.js";
import { slotOf } from "../../features/selection.js";

const MON = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const fmtIso = (iso) => MON.format(Date.parse(`${iso}T00:00:00Z`));

/**
 * @param {object} row the model's leaderboard row
 * @param {object | undefined} base the baseline's row
 * @param {{ ctx: object, scope: object, baseline: string, goTo(patch: { date?: string, location?: string }): void }} o
 *   baseline: the baseline the scores are relative to (the server's, when the scope's has no forecasts)
 * @returns {HTMLElement}
 */
export function detail(row, base, { ctx, scope, baseline, goTo }) {
  const { manifest, store } = ctx;
  const el = h("div", { class: "sc-detail", role: "region", "aria-label": `${row.label} detail` });
  const block = (title, ...kids) => h("div", { class: "sc-block" }, h("div", { class: "sc-block-title" }, title), ...kids);

  // anatomy by horizon: spread, over, under as one thin bar per horizon
  const hs = Object.keys(row.byH || {}).map(Number).filter((k) => Number.isFinite(k) && row.byH[k]?.wis != null).sort((a, b) => a - b);
  const tot = (c) => (c.spread || 0) + (c.over || 0) + (c.under || 0);
  const max = Math.max(1e-9, ...hs.map((k) => tot(row.byH[k].comp)));
  const anatomy = h("div", { class: "sc-anat" }, hs.length ? hs.map((k) => {
    const c = row.byH[k].comp, t = tot(c);
    return h("div", { class: "sc-anat-row" },
      h("span", { class: "sc-anat-h mono" }, `${k} wk`),
      h("span", { class: "sc-anat-bar", style: { "--w": `${(t / max) * 100}%` } },
        ...[["spread", "sc-c1"], ["over", "sc-c2"], ["under", "sc-c3"]].map(([key, cls]) => h("i", { class: cls, style: { flexGrow: String(t ? (c[key] || 0) / t : 0) } }))),
      h("span", { class: "sc-anat-v mono" }, fmtScore(t)));
  }) : h("span", { class: "sc-quiet" }, "–"));
  const key = h("div", { class: "sc-key" }, ...[["sc-c1", "spread"], ["sc-c2", "over"], ["sc-c3", "under"]].map(([c, l]) => h("span", null, h("i", { class: c }), l)));

  // coverage: empirical vs nominal at every level, the baseline in grey
  const cov = s("svg", { class: "sc-cov", role: "img", "aria-label": "Coverage by interval level" });
  // a model on the fan chart draws in its chart colour here too
  const slot = slotOf(ctx.store.get().sel, row.id);
  requestAnimationFrame(() => drawCoverage(cov, row, base, slot == null ? null : seriesColor(slot)));

  const byAbbr = new Map();
  for (const l of manifest.locations) {
    const prev = byAbbr.get(l.abbr);
    if (!prev || (l.level === "state" && prev.level !== "state")) byAbbr.set(l.abbr, l);
  }
  const geoCls = classifyHubGeo(manifest);
  const { tileClass, gridCols, items: tileItems } = buildTileLayout(geoCls, manifest, byAbbr);
  const tiles = h("div", {
    class: ["sc-tiles", tileClass],
    style: gridCols ? { "--cols": String(gridCols) } : undefined,
  });
  const subs = h("div", { class: "sc-subs" });
  const facts = h("div", { class: "sc-facts" });

  el.append(
    block("Anatomy", anatomy, key),
    block("Coverage", h("div", { class: "sc-cov-wrap" }, cov)),
    block(tilesTitle(scope, manifest), tiles),
    h("div", { class: "sc-block sc-wide" }, h("div", { class: "sc-block-title" }, "Submissions"), subs),
    h("div", { class: "sc-block sc-wide" }, facts),
  );

  // per location: shared-task mean WIS over the baseline's on the newest scoped season & active horizons
  const season = scope.seasons[0];
  if (season && !row.baseline) {
    tiles.append(h("span", { class: "sc-quiet" }, "Loading"));
    loadPlaces(store.get().target, season, row.id, baseline || scope.baseline, scope.horizons).then(({ model, base: b, counts }) => {
      tiles.replaceChildren(...tileItems.map((it) => {
        const { loc, key: k, label } = it;
        const m = loc ? (model.get(loc.abbr) ?? model.get(loc.id) ?? model.get(k)) : null;
        const bv = loc ? (b.get(loc.abbr) ?? b.get(loc.id) ?? b.get(k)) : null;
        const n = loc ? (counts?.get(loc.abbr) ?? counts?.get(loc.id) ?? counts?.get(k) ?? null) : null;
        const rel = m != null && bv > 0 ? m / bv : null, lvl = relLevel(rel);
        const gridStyle = it.col != null
          ? {
            gridColumn: it.w > 1 ? `${it.col} / span ${it.w}` : String(it.col),
            gridRow: it.h > 1 ? `${it.row} / span ${it.h}` : String(it.row),
          }
          : {};
        const t = h("button", {
          type: "button", class: ["sc-tile", lvl == null && "is-empty"], disabled: !loc || null,
          style: { ...gridStyle, "--c": lvl ? `var(--score-${lvl})` : null },
          "aria-label": label, onclick: () => loc && goTo({ location: loc.id }),
        });
        tooltip(t, `${label} · ${rel == null ? "–" : `${fmtRel(rel)}× baseline WIS · WIS ${fmtScore(m)}${n != null ? ` · ${n} ${n === 1 ? "forecast" : "forecasts"}` : ""}`}`);
        return t;
      }));
    }, () => tiles.replaceChildren(h("span", { class: "sc-quiet" }, "Can't load locations")));
  } else tiles.append(h("span", { class: "sc-quiet" }, row.baseline ? "Baseline · 1.00 everywhere" : "–"));

  loadDetails(row.id).then((d) => {
    renderSubs(subs, d, scope, manifest, goTo);
    renderFacts(facts, d, row, manifest);
  }, () => { subs.replaceChildren(h("span", { class: "sc-quiet" }, "Can't load details")); });
  return el;
}

/* Adapt mini-map tile grid to the active hub's geography (US states, Europe countries, or generic list). */
function buildTileLayout(geoCls, manifest, byAbbr) {
  if (geoCls.kind === "eu-countries") {
    const spec = geoCls.ukSplitAvailable ? EU_TILES_PROPORTIONED_UK_SPLIT : EU_TILES_PROPORTIONED;
    return {
      tileClass: "is-eu",
      gridCols: EU_GRID_PROPORTIONED.cols,
      items: Object.entries(spec).map(([id, [c, r, w = 1, hSpan = 1]]) => {
        const loc = manifest.locationById.get(id) || byAbbr.get(id) || null;
        return { key: loc?.abbr || id, loc, label: loc?.name || id, col: c, row: r, w, h: hSpan };
      }),
    };
  }
  if (geoCls.kind === "generic") {
    return {
      tileClass: "is-generic",
      gridCols: null,
      items: (manifest.locations || [])
        .filter((l) => l.level !== "country" && l.level !== "national")
        .map((loc) => ({ key: loc.abbr || loc.id, loc, label: loc.name || loc.id, col: null, row: null, w: 1, h: 1 })),
    };
  }
  return {
    tileClass: null,
    gridCols: COLUMNS,
    items: Object.entries(TILES).map(([abbr, [cx, cy]]) => {
      const loc = byAbbr.get(abbr) || null;
      return { key: abbr, loc, label: loc?.name || abbr, col: cx + 1, row: cy + 1, w: 1, h: 1 };
    }),
  };
}

/* "Locations", plus where the tiles' scope is wider than the table's: one season and every week */
function tilesTitle(scope, manifest) {
  return [
    "Locations",
    scope.seasons.length > 1 && (manifest.seasonById.get(scope.seasons[0])?.label || scope.seasons[0]),
    (scope.weeks || scope.phase) && "whole season",
  ].filter(Boolean).join(" · ");
}

function drawCoverage(svg, row, base, color) {
  const w = svg.clientWidth || 220, hh = svg.clientHeight || 150;
  svg.setAttribute("viewBox", `0 0 ${w} ${hh}`);
  const pad = { l: 28, r: 8, t: 6, b: 18 };
  const X = linear([0, 100], [pad.l, w - pad.r]), Y = linear([0, 100], [hh - pad.b, pad.t]);
  const g = s("g", { class: "sc-axis" });
  for (const t of [0, 50, 100]) {
    g.append(s("line", { x1: pad.l, x2: w - pad.r, y1: Y(t), y2: Y(t), class: "sc-grid" }));
    g.append(s("text", { x: pad.l - 6, y: Y(t), class: "sc-tick", "text-anchor": "end", "dominant-baseline": "middle", text: String(t) }));
    g.append(s("text", { x: X(t), y: hh - 4, class: "sc-tick", "text-anchor": "middle", text: `${t}%` }));
  }
  g.append(s("line", { x1: X(0), y1: Y(0), x2: X(100), y2: Y(100), class: "sc-ref" }));
  svg.append(g);
  const line = (r, cls) => {
    const pts = LEVELS.map((l, i) => [l * 100, r?.cal[i]]).filter(([, v]) => v != null);
    if (!pts.length) return;
    const style = cls.includes("is-emph") && color ? `stroke:${color}` : null;
    svg.append(s("path", { d: pts.map(([x, y], i) => `${i ? "L" : "M"}${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(""), class: cls, style }));
    if (cls.includes("is-emph")) for (const [x, y] of pts) svg.append(s("circle", { cx: X(x), cy: Y(y), r: 2, class: "sc-pt-solid", style: color ? `fill:${color}` : null }));
  };
  if (base && base.id !== row.id) line(base, "sc-line-base");
  line(row, "sc-line-solid is-emph");
}

/* one tick per hub round in the scoped seasons: full, partial (some locations), missing */
function renderSubs(el, d, scope, manifest, goTo) {
  const label = (id) => manifest.seasonById.get(id)?.label || id;
  const rows = (d.seasons || []).filter((x) => scope.seasons.includes(x.season)).sort((a, b) => b.season.localeCompare(a.season));
  if (!rows.length) { el.replaceChildren(h("span", { class: "sc-quiet" }, "No rounds in scope")); return; }
  el.replaceChildren(...rows.map((x) => {
    const dates = [...(x.dates || [])].sort((a, b) => a.date.localeCompare(b.date));
    return h("div", { class: "sc-sub-row" },
      h("span", { class: "sc-sub-season mono" }, label(x.season)),
      h("span", { class: "sc-ticks" }, dates.map((dt) => {
        const full = dt.submitted && dt.loc_info?.is_full_coverage !== false;
        const kind = !dt.submitted ? "is-missing" : full ? "is-full" : "is-partial";
        const miss = dt.loc_info?.missing_locations?.length;
        const b = h("button", { type: "button", class: ["sc-tick-mark", kind], "aria-label": fmtIso(dt.date), onclick: () => goTo({ date: dt.date }) });
        tooltip(b, `${fmtIso(dt.date)} · ${!dt.submitted ? "missing" : full ? "submitted" : `${miss} locations missing`}`);
        return b;
      })),
      h("span", { class: "sc-sub-n mono" }, `${x.submitted_count}/${x.total_hub_rounds}`));
  }));
}

function renderFacts(el, d, row, manifest) {
  const md = d.metadata || {}, m = manifest.modelById.get(row.id) || {};
  const hub = d.hub ? manifest.hubs?.find((x) => x.id === d.hub)?.short_label || d.hub : null;
  const line = [
    md.team_name || m.team_name || m.team,
    md.model_name,
    (d.family || m.family) && `${d.family || m.family} family`,
    hub ? `${hub} hub` : d.source,
    row.q && `${row.q} quantiles`,
    md.license,
    (md.designated_model ?? d.designated) ? "designated" : null,
  ].filter(Boolean);
  const methods = md.methods || md.methods_long;
  el.replaceChildren(...[
    h("div", { class: "sc-fact-line" }, line.join(" · ")),
    methods ? h("p", { class: "sc-methods" }, methods) : null,
    md.website_url ? h("a", { class: "c-link sc-fact-link", href: md.website_url, target: "_blank", rel: "noopener" }, "Website") : null,
  ].filter(Boolean));
}
