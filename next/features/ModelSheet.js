/* The model sheet: one model's page, in a large frosted sheet like the Guide's. Opens from anywhere a
 * model appears (the leaderboard's names, the picker, the figures, the heatmap, Peaks, the map), steps
 * through models with ↑ ↓ in leaderboard order, and can be linked to (#model/<id>).
 *
 * Top to bottom: the header (name, team · source · family, badges, actions), its scores in the scope the
 * leaderboard shows, the detail blocks (anatomy by horizon, coverage, places, submissions; built by
 * sections/scores/detail.js), then what the model is (methods, team, licence, data details, ensemble
 * members). Scores come from the Scores section when it has them (ctx.scores), else one request of its own. */
import { h, on, safeHref } from "../lib/dom.js";
import { apiUrl, hubFetch, registerCacheClear } from "../lib/api.js";
import { openPopover, activeLayer, tooltip } from "../ui/floating.js";
import { icon, slideText, toast } from "../ui/controls.js";
import { seriesColor } from "../chart/layout.js";
import { isCharted, slotOf, chart as chartModel, unchart, select, deselect, setBaseline } from "./selection.js";
import { fmtDay } from "../lib/format.js";
import { parseIso } from "../lib/scale.js";

let open = null; // { layer, show(id), ctx } while the sheet is open
const sheetMetricsCache = new Map();
registerCacheClear(() => sheetMetricsCache.clear());
const fetchSheetMetrics = (q) => {
  const url = apiUrl(`/api/next/metrics?${q}`);
  if (!sheetMetricsCache.has(url)) {
    const p = hubFetch(url).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); });
    p.catch(() => { if (sheetMetricsCache.get(url) === p) sheetMetricsCache.delete(url); });
    sheetMetricsCache.set(url, p);
  }
  return sheetMetricsCache.get(url);
};
const DASH = "–";
const setHash = (id) => history.replaceState(history.state, "", `${location.pathname}${location.search}${id ? `#model/${encodeURIComponent(id)}` : ""}`);
/** the model a #model/<id> hash names, or null */
export const modelHash = () => (/^#model\//.test(location.hash) ? decodeURIComponent(location.hash.slice(7)) : null);

function linkScoresCss() {
  if (document.querySelector("link[data-scores-css]")) return;
  document.head.append(h("link", { rel: "stylesheet", href: new URL("../styles/scores.css", import.meta.url).href, "data-scores-css": "" }));
}

/**
 * Open (or move) the sheet to a model.
 * @param {string} id
 * @param {{ manifest: object, store: object, chart?: object, scores?: object }} ctx
 * @returns {object | null} the layer
 */
export function openModel(id, ctx) {
  if (!ctx.manifest.modelById.has(id)) { toast("That model isn't in this hub", { tone: "info" }); setHash(null); return null; }
  if (open && open.ctx === ctx) { open.show(id); return open.layer; }
  if (open) open.layer.close(false);
  linkScoresCss();
  const anchor = document.querySelector(".app-more") || document.querySelector("[data-zone='tr']");
  if (!anchor) return null;
  if (activeLayer()?.anchor === anchor) activeLayer().close(false);
  let show = () => {};
  const layer = openPopover(anchor, {
    title: "Model", placement: "bottom-end", width: 880, className: "ms-sheet",
    onClose() { open = null; if (modelHash()) setHash(null); },
    content(body) { show = build(body, ctx); },
  });
  if (!layer) return null;
  open = { layer, show, ctx };
  show(id);
  return layer;
}

function build(body, ctx) {
  const { manifest, store } = ctx;
  const head = h("header", { class: "ms-head" });
  const nums = h("section", { class: "ms-nums" });
  const blocks = h("section", { class: "ms-blocks" });
  const about = h("section", { class: "ms-about" });
  const scroller = h("div", { class: "ms-scroll" }, head, nums, blocks, about);
  body.append(scroller);
  let id = null, token = 0;
  let fallbackOrder = [];

  // ↑ ↓ step through the leaderboard's order (when the sheet has focus and no text field does)
  body.addEventListener("keydown", (e) => {
    if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.target.closest?.("input, textarea")) return;
    e.preventDefault();
    step(e.key === "ArrowDown" ? 1 : -1);
  });
  const order = () => {
    const live = ctx.scores?.order?.();
    return live?.length ? live : fallbackOrder;
  };
  function step(d) {
    const o = order(), i = o.indexOf(id);
    if (i < 0 || !o.length) return;
    show(o[(i + d + o.length) % o.length]);
  }

  // leave the sheet for the chart: close, change the store, bring the chart into view
  function goTo({ date, location: loc }) {
    open?.layer.close(false);
    if (loc) store.set({ location: loc });
    if (date) { if (ctx.chart?.goTo) ctx.chart.goTo(date); else store.set({ date }); }
    document.getElementById("view")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  function show(next) {
    id = next;
    const my = ++token;
    setHash(id);
    scroller.scrollTop = 0;
    header();
    nums.replaceChildren(h("p", { class: "ms-quiet" }, "Scoring"));
    blocks.replaceChildren();
    about.replaceChildren();
    // scores in the leaderboard's scope (from Scores section if mounted, else non-aborting direct metrics query)
    const resolveRow = async () => {
      if (!ctx.scores?.rowFor) await Promise.resolve();
      if (ctx.scores?.rowFor) return ctx.scores.rowFor(id);
      const [{ scopeOf, targetHorizons }, { metricsRequest, rowsFrom, sortRows }] = await Promise.all([
        import("../sections/scope.js"),
        import("../sections/scores/model.js"),
      ]);
      const st = store.get(), sc = scopeOf(st, manifest);
      const allSeasons = manifest.seasons.map((x) => x.id);
      const availH = targetHorizons(manifest, st.target);
      const selIds = [...new Set([...st.sel.selected, id])];
      const req = metricsRequest(sc, { target: st.target, selected: selIds, allSeasons, availableHorizons: availH });
      const [resp, full] = await Promise.all([
        fetchSheetMetrics(req.query),
        req.full ? fetchSheetMetrics(req.full) : Promise.resolve(null),
      ]);
      const label = (x) => manifest.label(x, [...st.sel.selected, sc.baseline, id]);
      const team = (x) => { const m = manifest.modelById.get(x); return m && m.team && m.team !== label(x) ? m.team : ""; };
      const allIds = [...new Set([...selIds, ...(resp?.rankings || []).map((x) => x.model_id)])];
      const rows = rowsFrom(resp, { ids: allIds, baseline: sc.baseline, full, wins: null, pending: false, scale: sc.scale, label, team });
      const sortKey = st.scores?.sort || (resp?.is_categorical ? (resp?.ordinal === false ? "logScore" : "rps") : "rel");
      const { ranked, unranked, ranks } = sortRows(rows, sortKey, !!st.scores?.rev);
      fallbackOrder = [...ranked, ...unranked].map((r) => r.id);
      const rank = ranks.get(id) ?? null;
      const locLabel = sc.place === "current" ? (manifest.locationById.get(st.location)?.name || st.location) : sc.place === "US" ? "US" : "All locations";
      const sText = [locLabel, sc.seasons.length === allSeasons.length ? "All seasons" : sc.seasons.map((x) => manifest.seasonById.get(x)?.label || x).join(", ")].filter(Boolean).join(" · ");
      return { row: rows.find((r) => r.id === id), base: rows.find((r) => r.baseline), scope: sc, baseline: resp?.baseline_model || sc.baseline, scopeText: sText, rank, of: rank != null ? ranked.length : null };
    };
    const ctxRow = resolveRow();
    ctxRow.then((r) => {
      if (my !== token) return;
      header(); // the leaderboard's order may only now be known (prev / next)
      numbers(r);
      if (r?.row) import("../sections/scores/detail.js").then(({ detail }) => {
        if (my !== token) return;
        blocks.replaceChildren(detail(r.row, r.base, { ctx, scope: r.scope, baseline: r.baseline, goTo }));
      });
    }, () => { if (my === token) nums.replaceChildren(h("p", { class: "ms-quiet" }, "Can't load scores for this slice")); });
    // what the model is
    import("../sections/scores/data.js").then(({ loadDetails }) => loadDetails(id)).then((d) => { if (my === token) aboutOf(d); },
      () => { if (my === token) about.replaceChildren(h("p", { class: "ms-quiet" }, "Can't load the model's details")); });
  }

  /* ---------------- header: name, line, badges, actions ---------------- */
  function header() {
    const st = store.get(), m = manifest.modelById.get(id) || {};
    const base = id === (manifest.baselineFor?.(st.target, st.date) ?? manifest.baseline);
    const drawn = base ? st.sel.baseline : isCharted(st.sel, id);
    const color = !drawn ? null : base ? seriesColor("baseline") : seriesColor(slotOf(st.sel, id));
    const selected = base || st.sel.selected.includes(id);
    const hub = m.source === "hub" ? manifest.hubs?.find((x) => x.id === m.hub)?.short_label || m.hub : null;
    const line = [m.team, hub ? `${hub} hub` : m.source === "local" ? "Local" : m.source === "synthetic" ? "Ensemble" : "This hub", m.family && `${m.family} family`].filter(Boolean);
    const badges = [m.designated && "designated", base && "baseline"].filter(Boolean);
    const o = order(), i = o.indexOf(id);
    const nav = o.length > 1 && i >= 0 ? h("span", { class: "ms-nav" },
      h("button", { type: "button", class: "c-pill sm icon", "aria-label": "Previous model", html: icon.left, onclick: () => step(-1) }),
      h("span", { class: "ms-nav-n mono" }, `${i + 1} / ${o.length}`),
      h("button", { type: "button", class: "c-pill sm icon", "aria-label": "Next model", html: icon.right, onclick: () => step(1) })) : null;

    const act = (label, on, fn, title) => { const b = h("button", { type: "button", class: ["c-pill sm", on && "on"], onclick: fn }, label); if (title) tooltip(b, title); return b; };
    const chartBtn = act(drawn ? "On the chart" : "Chart it", drawn, () => {
      const s = store.get();
      if (base) store.set({ sel: setBaseline(s.sel, !s.sel.baseline) });
      else store.set({ sel: isCharted(s.sel, id) ? unchart(s.sel, id) : chartModel(s.sel, id) });
      header();
    });
    const focusBtn = act("Focus", st.focus === id, () => {
      const s = store.get();
      if (!base && !isCharted(s.sel, id)) store.set({ sel: chartModel(s.sel, id), focus: id });
      else if (base && !s.sel.baseline) store.set({ sel: setBaseline(s.sel, true), focus: id });
      else store.set({ focus: s.focus === id ? null : id });
      header();
    }, "Focus it on the fan chart");
    const selBtn = base ? null : act(selected ? "Selected" : "Select", selected, () => {
      const s = store.get();
      store.set({ sel: s.sel.selected.includes(id) ? deselect(s.sel, id) : select(s.sel, id) });
      header();
    }, selected ? "Remove from the selection" : "Add to the selection (scored and listed)");

    head.replaceChildren(
      h("div", { class: "ms-title-row" },
        h("i", { class: "ms-dot", style: color ? { background: color } : null, hidden: !color }),
        h("h2", { class: "ms-title" }, slideText(manifest.label(id), "ms-title-text")),
        nav),
      h("p", { class: "ms-line" }, line.join(" · "), ...badges.map((b) => h("span", { class: "ms-badge" }, b))),
      h("div", { class: "ms-actions" }, chartBtn, focusBtn, selBtn),
    );
    head.classList.add("c-slide-host");
  }

  /* ---------------- scores in scope ---------------- */
  function numbers(r) {
    const row = r?.row;
    const scopeLine = h("p", { class: "ms-scope" }, r?.scopeText || "");
    if (!row) { nums.replaceChildren(scopeLine, h("p", { class: "ms-quiet" }, "Not scored here")); return; }
    if (!row.active) {
      const why = row.pending ? "Awaiting truth" : row.note || "No forecasts in scope";
      nums.replaceChildren(scopeLine, h("p", { class: "ms-quiet" }, why));
      return;
    }
    // as the table prints them: 3 significant figures under 10, one decimal above
    const f = (v) => (v == null ? DASH : Math.abs(v) < 10 && v !== 0 ? (+v.toPrecision(3)).toString() : v.toFixed(1));
    const cell = (k, v, sub) => h("div", { class: "ms-num" }, h("span", { class: "ms-num-k" }, k), h("span", { class: "ms-num-v mono" }, v), sub ? h("span", { class: "ms-num-s" }, sub) : null);
    if (row.isCategorical) {
      nums.replaceChildren(scopeLine, h("div", { class: "ms-num-row" },
        r.rank != null ? cell("Rank", `${r.rank}`, r.of ? `of ${r.of}` : null) : null,
        cell(row.ordinal === false ? "Rel. Log" : "Rel. RPS", row.rel == null ? DASH : row.rel.toFixed(2), row.rel == null ? null : row.rel < 1 ? "better than baseline" : row.rel > 1 ? "worse than baseline" : "baseline"),
        row.ordinal !== false ? cell("RPS", row.rps == null ? DASH : row.rps.toFixed(3)) : null,
        cell("Log loss", row.logScore == null ? DASH : row.logScore.toFixed(2)),
        cell("Brier", row.brier == null ? DASH : row.brier.toFixed(3)),
        cell("Mode hit", row.hitMode == null ? DASH : `${Math.round(row.hitMode)}%`),
        cell("N", row.n.toLocaleString(), "forecasts")));
      return;
    }
    nums.replaceChildren(scopeLine, h("div", { class: "ms-num-row" },
      r.rank != null ? cell("Rank", `${r.rank}`, r.of ? `of ${r.of}` : null) : null,
      cell("Rel. WIS", row.rel == null ? DASH : row.rel.toFixed(2), row.rel == null ? null : row.rel < 1 ? "better than baseline" : row.rel > 1 ? "worse than baseline" : "baseline"),
      cell("WIS", f(row.wis)),
      cell("MAE", f(row.mae)),
      cell("50%", row.cov50 == null ? DASH : `${Math.round(row.cov50)}%`, "coverage"),
      cell("95%", row.cov95 == null ? DASH : `${Math.round(row.cov95)}%`, "coverage"),
      cell("N", row.n.toLocaleString(), "forecasts")));
  }

  /* ---------------- what the model is ---------------- */
  function aboutOf(d) {
    const md = d.metadata || {}, m = manifest.modelById.get(id) || {};
    const block = (title, ...kids) => h("div", { class: "ms-block" }, h("div", { class: "sc-block-title" }, title), ...kids.filter(Boolean));
    const dl = (pairs) => h("dl", { class: "ms-dl" }, pairs.filter(([, v]) => v != null && v !== "" && v !== false).flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
    const rawContributors = md.model_contributors ?? md.contributors;
    const people = (Array.isArray(rawContributors) ? rawContributors : [])
      .filter((c) => c != null && c !== "")
      .map((c) => (typeof c === "string"
        ? c.trim()
        : (typeof c === "object" ? [c.name, c.affiliation].filter(Boolean).join(" · ") : String(c))))
      .filter(Boolean);
    const methods = md.methods_long || md.methods;
    const specs = d.specs || {};
    const hubInfo = m.source === "hub" ? manifest.hubs?.find((x) => x.id === m.hub) : null;
    const links = [md.website_url, md.repo_url].map((u) => safeHref(u)).filter(Boolean);
    const ens = md.ensemble_of_models || md.ensemble_of_hub_models;
    const out = [
      methods ? block("Methods", h("p", { class: "ms-prose" }, methods)) : null,
      block("About", dl([
        ["Team", md.team_name || m.team],
        ["Model", md.model_name],
        ["Family", m.family],
        ["Designation", (md.designated_model ?? d.designated) ? "Designated (hub ensemble eligible)" : "Not designated"],
        ["Ensemble", ens ? "An ensemble of models" : null],
        ["Version", md.model_version],
        ["Licence", md.license],
        ["Data inputs", md.data_inputs],
        ["Seasons", (d.active_seasons || m.seasons || []).map((x) => manifest.seasonById.get(x)?.label || x).join(", ")],
        ["Forecasting", d.first_date && d.last_date ? `${fmtDay(parseIso(d.first_date))} – ${fmtDay(parseIso(d.last_date))}` : null],
        ["Targets", (specs.targets || m.targets || []).map((t) => manifest.targetById.get(t)?.short || t).join(", ")],
      ]), links.length ? h("p", { class: "ms-links" }, links.map((u) => h("a", { class: "c-link", href: u, target: "_blank", rel: "noopener noreferrer" }, u.replace(/^https?:\/\//, "").replace(/\/$/, "")))) : null),
      people.length ? block(`People · ${people.length}`, h("ul", { class: "ms-people" }, people.map((p) => h("li", null, p)))) : null,
      block("Data", dl([
        ["Forecasts", d.forecasts_count != null ? `${d.forecasts_count.toLocaleString()} rounds` : null],
        ["Horizons", specs.horizons?.length ? specs.horizons.map((x) => `${x} wk`).join(", ") : null],
        ["Places", specs.locations_count != null ? String(specs.locations_count) : null],
        ["Files", specs.total_files != null ? `${specs.total_files.toLocaleString()} · ${specs.total_disk_human || ""}`.replace(/ · $/, "") : null],
        ["Rows", specs.total_predictions_est != null ? `~${specs.total_predictions_est.toLocaleString()}` : null],
        ["Peaks", specs.peak_rounds ? `${specs.peak_rounds} rounds${specs.peak_latest ? ` · latest ${fmtDay(parseIso(specs.peak_latest))}` : ""}` : specs.peak_targets ? "Not submitted" : null],
        ["Path", d.source === "repo" ? `model-output/${id}/` : d.source === "local" ? `local-output/${id}/` : null],
        ["Hub", hubInfo ? hubInfo.label : null],
      ])),
      ensembleBlock(d, m),
    ].filter(Boolean);
    about.replaceChildren(...out);
  }

  // an ensemble: its members (each opens its own sheet) and method
  function ensembleBlock(d, m) {
    const cfg = d.synthetic_config || null;
    if (m.source !== "synthetic" && !cfg) return null;
    const members = cfg?.models || cfg?.members || [];
    return h("div", { class: "ms-block" }, h("div", { class: "sc-block-title" }, `Ensemble · ${members.length} members`),
      h("p", { class: "ms-line" }, [cfg?.method && `${cfg.method === "mean" ? "Mean" : "Median"} of members' quantiles`, cfg?.missing_policy && (cfg.missing_policy === "strict" ? "All or none" : "Pool present")].filter(Boolean).join(" · ")),
      h("p", { class: "ms-members" }, members.map((mid) => h("button", { type: "button", class: "c-link", onclick: () => show(mid) }, manifest.label(mid)))));
  }

  // the sheet follows the selection and chart while open (the header's buttons)
  const off = store.on((s, prev, changed) => { if (id && (changed.has("sel") || changed.has("focus"))) header(); });
  const obs = new MutationObserver(() => { if (!body.isConnected) { off(); obs.disconnect(); } });
  obs.observe(document.body, { childList: true });
  return show;
}

/* Delegated: anything with data-model-sheet="<id>" opens the sheet (labels in figures, rows elsewhere). */
let delegated = false;
let activeLinkCtx = null;
export function installModelLinks(ctx) {
  activeLinkCtx = ctx;
  if (delegated) return;
  delegated = true;
  on(document, "click", (e) => {
    const t = e.target.closest?.("[data-model-sheet]");
    if (!t || !activeLinkCtx) return;
    e.preventDefault(); e.stopPropagation();
    openModel(t.dataset.modelSheet, activeLinkCtx);
  }, true);
}
