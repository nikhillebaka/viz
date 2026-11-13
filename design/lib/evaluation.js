/* The scores section: scope line, leaderboard and heatmap (studies/evaluation-goals.md). Paper, not
 * chrome. Scoring is lib/scores.js; colors are the --score-1…9 tokens (1 better … 5 same … 9 worse).
 *
 * mountScores(el, opts) builds the section inside el and returns { update, redraw, highlight, scope }.
 * opts:
 *   man                 manifest from loadManifest (seasons loaded or loadable)
 *   seasons             default seasons (the chart's season)
 *   selected()          ids of selected models, in order
 *   slotOf(m)           color slot if charted, else null
 *   rows                "selected" (default) or "all"
 *   onPreview(m|null)   a row or heatmap row is hovered
 *   onChart(m)          the dot was clicked (chart or take off)
 *   onCell({ m, axis, col })  a heatmap cell was clicked
 *   currentRound()      the chart's forecast date as YYYY-MM-DD (outlined in weeks mode), or null
 *   seriesColor(slot)   CSS color for a slot */
import { openPopover, icon } from "./controls.js";
import { loadSeason, score, slices, seasonLabel } from "./scores.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (v, d = 2) => (v === v ? v.toFixed(d) : "–");
const fmtW = (v) => (v === v ? (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1)) : "–");
const short = (m) => (m.includes("-") ? m.split("-").slice(1).join("-") : m);
const hexRgb = (h) => (h.startsWith("#") ? [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) : (h.match(/\d+/g) || [0, 0, 0]).slice(0, 3).map(Number));
const DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>';
const AX = { lo: Math.log(0.4), hi: Math.log(1.6) };   // lollipop axis: 0.4× to 1.6× (log)
const HEAT = { row: 22, gap: 2, head: 30, seasonGap: 12 };

export function mountScores(el, opts) {
  const { man } = opts;
  const SEASONS = man.seasons.map((s) => s.id);
  const root = document.documentElement;
  const team = (m) => man.meta[m]?.team_abbr || (m.includes("-") ? m.split("-")[0] : "");
  const S = {
    rows: opts.rows || "selected",
    scope: { seasons: opts.seasons || [SEASONS.at(-1)], locations: "states", horizons: [0, 1, 2, 3], shared: false, among: "all" },
    defaults: null, sort: { key: "rel", dir: 1 }, heatAxis: "weeks", hot: null,
  };
  S.defaults = JSON.stringify({ ...S.scope });

  el.classList.add("ev");
  el.innerHTML = `<div class="ev-scope on-paper"></div>
    <section class="ev-board"><div class="ev-rows"></div><div class="ev-head ev-grid"></div></section>
    <section class="ev-heat"><div class="ev-heat-line"></div><canvas class="ev-heat-canvas"></canvas></section>
    <section class="ev-figs">
      <figure class="ev-fig" data-fig="cal"><figcaption><b>Calibration</b><span class="sub">coverage − nominal</span></figcaption><svg></svg></figure>
      <figure class="ev-fig" data-fig="hz"><figcaption><b>Horizon</b><span class="sub">rel. WIS by weeks ahead</span></figcaption><svg></svg></figure>
      <figure class="ev-fig" data-fig="an"><figcaption><b>Anatomy</b><button class="tog" data-v="abs">WIS</button><span class="dot">·</span><button class="tog" data-v="share">Share</button><span class="key"><i class="k1"></i>Spread<i class="k2"></i>Over<i class="k3"></i>Under</span></figcaption><svg></svg></figure>
    </section>`;
  const q = (s) => el.querySelector(s);
  const scopeEl = q(".ev-scope"), headEl = q(".ev-head"), rowsEl = q(".ev-rows"), heatLine = q(".ev-heat-line"), heatCv = q(".ev-heat-canvas");
  const readout = document.createElement("div"); readout.className = "ev-readout"; readout.hidden = true; document.body.appendChild(readout);

  /* ---------------- colors ---------------- */
  let ramp = [];
  const readRamp = () => { const cs = getComputedStyle(root); ramp = Array.from({ length: 9 }, (_, i) => hexRgb(cs.getPropertyValue(`--score-${i + 1}`).trim())); };
  const divColor = (x) => {
    if (!(x === x)) return null;
    const p = (Math.max(-1, Math.min(1, x)) + 1) * 4, i = Math.min(7, Math.floor(p)), f = p - i, a = ramp[i], b = ramp[i + 1];
    return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
  };
  const ratioColor = (r) => divColor(Math.log2(r));                // ½× → best, 2× → worst
  const covColor = (cov, target) => divColor((target - cov) / 25);   // 25 points under target → warm pole

  /* ---------------- scoring ---------------- */
  let result = null;
  async function compute() {
    await Promise.all(S.scope.seasons.map((id) => loadSeason(man, id)));
    result = score(man, { ...S.scope, selected: opts.selected() });
  }
  const shownRows = () => result.rows.filter((r) => S.rows === "all" || opts.selected().includes(r.m) || r.m === result.baseline);

  /* ---------------- scope line ---------------- */
  function fragments() {
    const sc = S.scope, d = JSON.parse(S.defaults), H = sc.horizons;
    const seasons = sc.seasons.length === SEASONS.length && SEASONS.length > 1 ? "All seasons" : sc.seasons.length > 1 ? `${sc.seasons.length} seasons` : seasonLabel(sc.seasons[0]);
    return [
      { k: "metric", t: "Relative WIS" + (sc.shared ? " · shared" : "") + (sc.among === "selected" ? " · among selected" : ""), set: sc.shared || sc.among !== "all" },
      { k: "loc", t: sc.locations === "states" ? "All states" : "US", set: sc.locations !== d.locations },
      { k: "dates", t: seasons, set: sc.seasons.join() !== d.seasons.join() },
      { k: "h", t: H.length === 4 ? "0–3 wk" : H.length === 1 ? `${H[0]} wk` : H.join(", ") + " wk", set: H.length !== 4 },
    ];
  }
  function renderScope(target = scopeEl) {
    // update in place when the fragments are the same: an open popover stays anchored to its button
    const fr = fragments(), btns = [...target.querySelectorAll(".f")];
    if (btns.length === fr.length && btns.every((b, i) => b.dataset.k === fr[i].k)) {
      fr.forEach((f, i) => { if (btns[i].textContent !== f.t) btns[i].textContent = f.t; btns[i].classList.toggle("set", f.set); });
      return;
    }
    target.innerHTML = fr.map((f, i) => `${i ? '<span class="dot">·</span>' : ""}<button class="f${f.set ? " set" : ""}" data-k="${f.k}">${esc(f.t)}</button>`).join("")
      + `<button class="exp" aria-label="Export">${DOWNLOAD}</button>`;
    target.querySelectorAll(".f").forEach((b) => b.addEventListener("click", () => openScope(b)));
  }
  function checklist(body, groups, onPick) {
    const box = document.createElement("div"); box.className = "ev-checks";
    groups.forEach((g, gi) => {
      if (gi) box.insertAdjacentHTML("beforeend", '<div class="sep"></div>');
      if (g.title) box.insertAdjacentHTML("beforeend", `<div class="hd">${esc(g.title)}</div>`);
      for (const it of g.items) {
        const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "menuitemcheckbox"); b.setAttribute("aria-checked", !!it.on);
        b.innerHTML = `<span>${esc(it.label)}</span><span class="ck">${it.on ? icon.check : ""}</span>`;
        b.addEventListener("click", () => onPick(it));
        box.appendChild(b);
      }
    });
    body.appendChild(box);
  }
  function openScope(btn) {
    const k = btn.dataset.k, sc = S.scope;
    const groups = () => k === "metric" ? [
        { items: [{ label: "Relative WIS", on: true, v: null }] },
        { items: [{ label: "Shared forecasts only", on: sc.shared, v: "shared" }] },
        { title: "Rank among", items: [{ label: "Every model in scope", on: sc.among === "all", v: "among:all" }, { label: "Selected", on: sc.among === "selected", v: "among:selected" }] },
      ] : k === "loc" ? [{ items: [{ label: "All states", on: sc.locations === "states", v: "states" }, { label: "US", on: sc.locations === "US", v: "US" }] }]
      : k === "dates" ? [{ title: "Seasons", items: [...SEASONS].reverse().map((s) => ({ label: seasonLabel(s), on: sc.seasons.includes(s), v: s })) }, { items: [{ label: "All", on: sc.seasons.length === SEASONS.length, v: "all" }] }]
      : [{ items: [0, 1, 2, 3].map((h) => ({ label: `${h} wk ahead`, on: sc.horizons.includes(h), v: h })) }];
    openPopover(btn, { width: 260, morph: false, content: (body) => {
      const paint = () => { body.innerHTML = ""; checklist(body, groups(), (it) => { apply(k, it.v); paint(); }); };
      paint();
    } });
  }
  function apply(k, v) {
    const sc = S.scope;
    if (k === "metric") { if (v === "shared") sc.shared = !sc.shared; else if (v?.startsWith("among:")) sc.among = v.slice(6); }
    else if (k === "loc") sc.locations = v;
    else if (k === "dates") {
      if (v === "all") sc.seasons = sc.seasons.length === SEASONS.length ? JSON.parse(S.defaults).seasons : [...SEASONS];
      else { const on = sc.seasons.includes(v); if (on && sc.seasons.length > 1) sc.seasons = sc.seasons.filter((s) => s !== v); else if (!on) sc.seasons = SEASONS.filter((s) => s === v || sc.seasons.includes(s)); }
    } else if (k === "h") { const on = sc.horizons.includes(v); if (on && sc.horizons.length > 1) sc.horizons = sc.horizons.filter((h) => h !== v); else if (!on) sc.horizons = [...sc.horizons, v].sort(); }
    update();
  }

  /* ---------------- leaderboard ---------------- */
  const COLS = [{ key: "rank" }, { key: "name", label: "Model", sort: "name" }, { key: "rel", label: "Rel. WIS", num: true, sort: "rel" }, { key: "lolli" },
    { key: "wis", label: "WIS", num: true, sort: "wis" }, { key: "c50", label: "50%", num: true, sort: "c50" }, { key: "c95", label: "95%", num: true, sort: "c95" }, { key: "plus" }];
  const lolliWidth = () => headEl.children[3]?.getBoundingClientRect().width || 168;
  const sortVal = (r, k) => k === "name" ? short(r.m).toLowerCase() : k === "c50" ? Math.abs(r.cov[50] - 50) : k === "c95" ? Math.abs(r.cov[95] - 95) : r[k];
  function renderHead() {
    const w = lolliWidth(), pos = (v) => ((Math.log(v) - AX.lo) / (AX.hi - AX.lo)) * w;
    headEl.innerHTML = COLS.map((c) => {
      if (c.key === "rank") return "<span></span>";
      if (c.key === "lolli") return `<div class="axis">${[0.5, 1, 1.5].map((v) => `<span style="left:${pos(v)}px">${v}</span>`).join("")}</div>`;
      if (c.key === "plus") return `<button class="plus" aria-label="Columns">${icon.plus || "+"}</button>`;
      const on = S.sort.key === c.sort, ar = on ? (S.sort.dir > 0 ? "▲" : "▼") : "";
      return `<button class="h${c.num ? " num" : ""}${on ? " on" : ""}" data-sort="${c.sort}">${c.num ? `<span class="ar">${ar}</span>` : ""}${c.label}${c.num ? "" : `<span class="ar">${ar}</span>`}</button>`;
    }).join("");
    headEl.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.sort; S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: 1 }; renderBoard();
    }));
  }
  function lolli(r, w) {
    if (!(r.rel === r.rel) || w < 20) return "";
    const x = (v) => Math.max(0, Math.min(w, ((Math.log(v) - AX.lo) / (AX.hi - AX.lo)) * w));
    const x1 = x(1), xv = x(r.rel), c = ratioColor(r.rel), base = r.m === result.baseline;
    return `<svg class="ev-lolli" width="${w}" height="30" viewBox="0 0 ${w} 30"><line x1="${x1}" x2="${x1}" y1="4" y2="26" stroke="var(--ink-faint)" stroke-width="1"/>`
      + (base ? "" : `<line x1="${x1}" x2="${xv}" y1="15" y2="15" stroke="${c}" stroke-width="1.5"/>`)
      + `<circle cx="${xv}" cy="15" r="3.5" fill="${base ? "var(--ink-tertiary)" : c}"/></svg>`;
  }
  function renderBoard() {
    if (!result) return;
    renderHead();
    const w = lolliWidth(), rows = shownRows();
    const ranked = rows.filter((r) => r.rel === r.rel), un = rows.filter((r) => !(r.rel === r.rel));
    const { key, dir } = S.sort;
    ranked.sort((a, b) => { const va = sortVal(a, key), vb = sortVal(b, key); return (va < vb ? -1 : va > vb ? 1 : a.m.localeCompare(b.m)) * dir; });
    let prev = null, rank = 0;
    const html = (r, i, isRanked) => {
      let rk = "";
      if (isRanked && key !== "name") { const v = sortVal(r, key); if (v !== prev) rank = i + 1; prev = v; rk = rank; }
      const slot = opts.slotOf(r.m), base = r.m === result.baseline, small = r.n && r.n < 10;
      const cov = (lv) => r.n ? `<span class="cv"><b style="background:${covColor(r.cov[lv], lv)}"></b>${Math.round(r.cov[lv])}</span>` : "–";
      const fr = r.possible ? r.n / r.possible : 1;
      const partial = r.n && fr < 1 ? `<svg width="10" height="10" viewBox="0 0 10 10" aria-label="${r.n} of ${r.possible} forecasts"><title>${r.n} of ${r.possible} forecasts</title><circle cx="5" cy="5" r="4" fill="none" stroke="var(--ink-tertiary)" stroke-width="1"/><path d="M5 5 L5 1 A4 4 0 ${fr > 0.5 ? 1 : 0} 1 ${5 + 4 * Math.sin(2 * Math.PI * fr)} ${5 - 4 * Math.cos(2 * Math.PI * fr)} Z" fill="var(--ink-tertiary)"/></svg>` : "";
      const why = r.status === "ok" ? "" : r.seasons.length ? "no forecasts in scope" : "other seasons only";
      const dot = base ? `<span class="cd"></span>` : `<button class="cd${slot != null ? " on" : ""}" style="--c:${slot != null ? opts.seriesColor(slot) : "transparent"}" aria-label="${slot != null ? "On the chart. Take off" : "Put on the chart"}: ${esc(short(r.m))}"><i></i></button>`;
      return `<div class="ev-row ev-grid${base ? " base" : ""}${small || !isRanked ? " dimmed" : ""}${S.hot === r.m ? " hot" : ""}" data-m="${esc(r.m)}" title="${esc(r.m)}${why ? " · " + why : ""}">
        <span class="rk">${rk}</span>
        <span class="nm">${dot}<span class="t">${esc(base ? "Baseline" : short(r.m))}</span>${base ? "" : `<span class="tm">${esc(team(r.m))}</span>`}${partial}</span>
        <span class="v">${fmt(r.rel)}</span><span class="ev-lolli-cell">${lolli(r, w)}</span>
        <span class="v">${fmtW(r.wis)}</span><span class="v">${cov(50)}</span><span class="v">${cov(95)}</span><span></span></div>`;
    };
    const empty = opts.selected().length ? "" : `<div class="ev-empty"><button type="button" data-act="add">Add models</button></div>`;
    rowsEl.innerHTML = ranked.map((r, i) => html(r, i, true)).join("") + empty + (un.length ? '<div class="ev-rule"></div>' + un.map((r, i) => html(r, i, false)).join("") : "");
  }
  rowsEl.addEventListener("click", (e) => {
    const cd = e.target.closest("button.cd"); if (cd) { opts.onChart?.(cd.closest(".ev-row").dataset.m); return; }
    if (e.target.closest("[data-act=add]")) opts.onAdd?.();
  });
  rowsEl.addEventListener("pointerover", (e) => { const r = e.target.closest(".ev-row"); opts.onPreview?.(r ? r.dataset.m : null); });
  rowsEl.addEventListener("pointerleave", () => opts.onPreview?.(null));

  /* ---------------- heatmap ---------------- */
  let heat = null, heatSl = null;
  // built once; later calls update it in place, so an open popover keeps its anchor
  function renderHeatLine() {
    const axisName = { weeks: "Weeks", locations: "Locations", horizons: "Horizons" }[S.heatAxis];
    if (!heatLine.firstChild) {
      heatLine.innerHTML = `<button class="f" data-k="axis"></button><span class="dot">·</span><button class="f">Rel. WIS</button>
        <span class="ev-legend">½×<canvas width="240" height="12"></canvas>2×</span>`;
      heatLine.querySelector("[data-k=axis]").addEventListener("click", (e) => openPopover(e.currentTarget, { width: 220, morph: false, content: (body) => {
        const paint = () => { body.innerHTML = ""; checklist(body, [{ title: "Columns", items: ["weeks", "locations", "horizons"].map((a) => ({ label: a[0].toUpperCase() + a.slice(1), on: S.heatAxis === a, v: a })) }], (it) => { S.heatAxis = it.v; heatSl = null; renderHeat(); renderHeatLine(); paint(); }); };
        paint();
      } }));
    }
    heatLine.querySelector("[data-k=axis]").textContent = `Models × ${axisName}`;
    const g = heatLine.querySelector("canvas").getContext("2d");
    for (let x = 0; x < 240; x++) { g.fillStyle = divColor((x / 239) * 2 - 1); g.fillRect(x, 0, 1, 12); }
  }
  function renderHeat() {
    if (!result) return;
    heatSl ||= slices(man, result, S.heatAxis);
    const sl = heatSl, cs = getComputedStyle(root), ink = (n) => cs.getPropertyValue(n).trim();
    const rows = shownRows().filter((r) => r.rel === r.rel).sort((a, b) => a.rel - b.rel);
    const W = heatCv.parentElement.clientWidth, dpr = devicePixelRatio || 1, cols = sl.cols, C = cols.length;
    const g = heatCv.getContext("2d");
    g.font = `13px ${ink("--font-sans")}`;
    const labelW = Math.min(300, 32 + 12 + 15 + Math.max(0, ...rows.map((r) => g.measureText(r.m === result.baseline ? "Baseline" : short(r.m)).width)) + 24);
    const breaks = cols.map((c, i) => (i && S.heatAxis === "weeks" && c.season !== cols[i - 1].season ? 1 : 0));
    const nb = breaks.reduce((a, b) => a + b, 0);
    const cw = Math.max(4, (W - labelW - nb * HEAT.seasonGap) / Math.max(1, C));
    const H = HEAT.head + rows.length * HEAT.row;
    heatCv.width = W * dpr; heatCv.height = H * dpr; heatCv.style.height = H + "px";
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const xs = []; let x = labelW; cols.forEach((c, i) => { x += breaks[i] * HEAT.seasonGap; xs.push(x); x += cw; });
    g.font = `10.5px ${ink("--font-mono")}`; g.fillStyle = ink("--ink-tertiary"); g.textBaseline = "alphabetic";
    if (S.heatAxis === "weeks") {
      let lastM = null, lastSeason = null;
      cols.forEach((c, i) => {
        const d = new Date(c.label + "T00:00:00Z"), m = d.getUTCMonth();
        if (c.season !== lastSeason) { g.fillStyle = ink("--ink-secondary"); g.font = `500 11px ${ink("--font-sans")}`; g.fillText(seasonLabel(c.season), xs[i], 11); g.font = `10.5px ${ink("--font-mono")}`; g.fillStyle = ink("--ink-tertiary"); lastSeason = c.season; lastM = m; return; }
        if (m !== lastM) { g.fillText(d.toLocaleString("en", { month: "short", timeZone: "UTC" }), xs[i], 24); lastM = m; }
      });
    } else {
      const every = Math.ceil(16 / cw); g.textAlign = "center";
      cols.forEach((c, i) => { if (i % every === 0) g.fillText(S.heatAxis === "horizons" ? `${c.label} wk` : c.label, xs[i] + cw / 2, 22); });
      g.textAlign = "left";
    }
    rows.forEach((r, ri) => {
      const y = HEAT.head + ri * HEAT.row, cells = sl.cells.get(r.m), slot = opts.slotOf(r.m);
      if (r.m === S.hot) { g.fillStyle = ink("--fill-hover"); g.beginPath(); g.roundRect(0, y, W, HEAT.row, 6); g.fill(); }
      if (slot != null) { g.fillStyle = cs.getPropertyValue(opts.seriesColor(slot).slice(4, -1)).trim() || opts.seriesColor(slot); g.beginPath(); g.arc(32 + 12 + 3.5, y + HEAT.row / 2, 3.5, 0, 7); g.fill(); }
      g.fillStyle = r.m === result.baseline ? ink("--ink-tertiary") : ink("--ink-primary"); g.font = `13px ${ink("--font-sans")}`; g.textBaseline = "middle";
      let label = r.m === result.baseline ? "Baseline" : short(r.m); const maxW = labelW - 32 - 12 - 15 - 16;
      while (g.measureText(label).width > maxW && label.length > 4) label = label.slice(0, -2) + "…";
      g.fillText(label, 32 + 12 + 15, y + HEAT.row / 2 + 0.5);
      cells.forEach((c, ci) => {
        const col = ratioColor(c.ratio); if (!col) return;
        g.fillStyle = col; g.beginPath(); g.roundRect(xs[ci], y + 1, cw - HEAT.gap, HEAT.row - HEAT.gap, Math.min(3, cw / 4)); g.fill();
      });
    });
    // the chart's current week, outlined down every row
    const cur = S.heatAxis === "weeks" ? opts.currentRound?.() : null, ci = cur ? cols.findIndex((c) => c.label === cur) : -1;
    if (ci >= 0) { g.strokeStyle = ink("--ink-primary"); g.lineWidth = 1.25; g.beginPath(); g.roundRect(xs[ci] - 1.5, HEAT.head - 1, cw - HEAT.gap + 3, rows.length * HEAT.row + 1, 4); g.stroke(); }
    heat = { xs, cw, rows, cols, cells: sl.cells, labelW };
  }
  const cellAt = (e) => {
    if (!heat) return null;
    const r = heatCv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const ri = Math.floor((y - HEAT.head) / HEAT.row);
    if (ri < 0 || ri >= heat.rows.length) return null;
    const ci = heat.xs.findIndex((x0) => x >= x0 && x < x0 + heat.cw);
    return { ri, ci, m: heat.rows[ri].m, onLabel: x < heat.labelW };
  };
  heatCv.addEventListener("pointermove", (e) => {
    const h = cellAt(e);
    opts.onPreview?.(h ? h.m : null);
    if (!h || h.ci < 0) { readout.hidden = true; heatCv.style.cursor = ""; return; }
    heatCv.style.cursor = "pointer";
    const c = heat.cells.get(h.m)[h.ci], col = heat.cols[h.ci];
    const what = S.heatAxis === "weeks" ? new Date(col.label + "T00:00:00Z").toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : S.heatAxis === "locations" ? man.locations.find((l) => l.abbr === col.label)?.name : `${col.label} wk ahead`;
    readout.innerHTML = `<div class="when">${esc(h.m === result.baseline ? "Baseline" : short(h.m))} · ${esc(what)}</div><table><tr><td>Rel. WIS</td><td>${fmt(c.ratio)}</td></tr><tr><td>WIS</td><td>${fmtW(c.wis)}</td></tr><tr><td>Baseline</td><td>${fmtW(c.base)}</td></tr><tr><td>Forecasts</td><td>${c.n}</td></tr></table>`;
    readout.hidden = false;
    const left = Math.min(innerWidth - readout.offsetWidth - 12, e.clientX + 14), top = e.clientY + 14 + readout.offsetHeight > innerHeight ? e.clientY - readout.offsetHeight - 10 : e.clientY + 14;
    readout.style.left = left + "px"; readout.style.top = top + "px";
  });
  heatCv.addEventListener("pointerleave", () => { readout.hidden = true; opts.onPreview?.(null); });
  heatCv.addEventListener("click", (e) => { const h = cellAt(e); if (h && h.ci >= 0) { readout.hidden = true; opts.onCell?.({ m: h.m, axis: S.heatAxis, col: heat.cols[h.ci] }); } });


  /* ---------------- figures: every selected model on one chart ----------------
   * Lines and bars are ink; the hovered model (a row, a line, the chart) comes up to full ink and the
   * rest recede. Line ends are labelled when every label fits (all or nothing, like grey lines on the
   * chart); otherwise a model is named on hover. Charted models carry their color dot in the label. */
  const figsEl = q(".ev-figs");
  S.anatomy = "abs";
  figsEl.querySelectorAll(".tog").forEach((b) => b.addEventListener("click", () => { S.anatomy = b.dataset.v; renderFigures(); }));
  const NS = "http://www.w3.org/2000/svg";
  const figRows = () => shownRows().filter((r) => r.rel === r.rel && r.n).sort((a, b) => a.rel - b.rel);
  const label = (m) => (m === result.baseline ? "Baseline" : short(m));
  // a name cut to fit max px at the figures' 12px label size (measured, cached)
  const mctx = document.createElement("canvas").getContext("2d"), fitCache = new Map();
  const fitName = (m, max) => {
    const k = `${m}|${max}`; if (fitCache.has(k)) return fitCache.get(k);
    mctx.font = `12px ${getComputedStyle(root).getPropertyValue("--font-sans")}`;
    let t = label(m); if (mctx.measureText(t).width > max) { while (t.length > 3 && mctx.measureText(t + "…").width > max) t = t.slice(0, -1); t += "…"; }
    fitCache.set(k, t); return t;
  };
  // stack labels so they never overlap: sorted by y, at least gap apart, kept inside [lo, hi]
  function dodge(items, gap, lo, hi) {
    const a = [...items].sort((p, q2) => p.y - q2.y);
    for (let i = 1; i < a.length; i++) a[i].ly = Math.max(a[i].y, (a[i - 1].ly ?? a[i - 1].y) + gap);
    if (a.length) a[0].ly ??= a[0].y;
    const over = (a.at(-1)?.ly ?? 0) - hi;
    if (over > 0) for (const d of a) d.ly -= over;
    for (let i = 0; i < a.length; i++) { a[i].ly = Math.max(a[i].ly, lo + i * gap); }
    return a;
  }
  function lineFigure(svg, rows, { xs, xLabel, y, yTicks, ref, pts, w, h, pad }) {
    const hot = S.hot, any = hot && rows.some((r) => r.m === hot);
    const sx = (i) => pad.l + ((xs[i] - xs[0]) / (xs.at(-1) - xs[0])) * (w - pad.l - pad.r);
    let html = "";
    for (const t of yTicks) html += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line-hairline)"/><text x="${pad.l - 8}" y="${y(t) + 3.5}" text-anchor="end" class="tk">${t.label ?? t}</text>`;
    html += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(ref)}" y2="${y(ref)}" stroke="var(--ink-tertiary)" stroke-width="1"/>`;
    xs.forEach((v, i) => { html += `<text x="${sx(i)}" y="${h - 8}" text-anchor="middle" class="tk">${xLabel(v)}</text>`; });
    const lines = rows.map((r) => ({ r, p: pts(r) })).filter((d) => d.p.every((v) => v === v));
    // draw: the hot line last, on top
    lines.sort((a, b) => (a.r.m === hot) - (b.r.m === hot));
    for (const { r, p } of lines) {
      const on = r.m === hot, base = r.m === result.baseline;
      const stroke = on ? "var(--ink-primary)" : any ? "var(--ink-faint)" : base ? "var(--ink-tertiary)" : "var(--ink-secondary)";
      const d = p.map((v, i) => `${i ? "L" : "M"}${sx(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
      html += `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${on ? 2 : 1.25}" stroke-linejoin="round" ${base && !on ? 'stroke-dasharray="3 3"' : ""}/>`
        + p.map((v, i) => `<circle cx="${sx(i)}" cy="${y(v)}" r="${on ? 2.75 : 2}" fill="${stroke}"/>`).join("")
        + `<path d="${d}" fill="none" stroke="transparent" stroke-width="12" data-m="${esc(r.m)}" class="hit"/>`;
    }
    // labels at the right end: all, if they fit; otherwise only the hot one
    const ends = lines.map(({ r, p }) => ({ m: r.m, y: y(p.at(-1)) }));
    const fit = ends.length * 14 <= h - pad.t - pad.b + 14;
    const show = fit ? ends : ends.filter((e) => e.m === hot);
    for (const e of dodge(show, 14, pad.t, h - pad.b)) {
      const slot = opts.slotOf(e.m), on = e.m === hot;
      html += `<g class="lb${on ? " on" : ""}${any && !on ? " dim" : ""}" data-m="${esc(e.m)}">${slot != null ? `<circle cx="${w - pad.r + 10}" cy="${e.ly}" r="3" fill="${opts.seriesColor(slot)}"/>` : ""}<text x="${w - pad.r + 17}" y="${e.ly + 4}">${esc(fitName(e.m, pad.r - 20))}</text><title>${esc(e.m)}</title></g>`;
    }
    svg.innerHTML = html;
  }
  function renderFigures() {
    if (!result) return;
    const rows = figRows();
    const figW = (f) => Math.max(260, f.clientWidth);
    // Calibration: empirical minus nominal coverage at every level; above 0 too wide, below too narrow
    { const f = figsEl.querySelector('[data-fig="cal"]'), svg = f.querySelector("svg"), w = figW(f), h = 240;
      const levels = man.levels, devs = rows.flatMap((r) => levels.map((l) => r.cov[l] - l));
      const lim = Math.max(10, Math.ceil(Math.max(...devs.map(Math.abs), 0) / 10) * 10);
      const pad = { l: 36, r: 150, t: 10, b: 26 };
      const y = (v) => pad.t + ((lim - v) / (2 * lim)) * (h - pad.t - pad.b);
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`); svg.setAttribute("height", h);
      const tk = [-lim, -lim / 2, lim / 2, lim].map((v) => ({ valueOf: () => v, label: (v > 0 ? "+" : "") + v }));
      lineFigure(svg, rows, { xs: levels, xLabel: (v) => (v % 20 === 10 || v === 98 ? `${v}` : ""), y: (v) => y(+v), yTicks: tk, ref: 0, pts: (r) => levels.map((l) => r.cov[l] - l), w, h, pad }); }
    // Horizon: relative WIS at each horizon, log scale, the baseline at 1
    { const f = figsEl.querySelector('[data-fig="hz"]'), svg = f.querySelector("svg"), w = figW(f), h = 240;
      const vals = rows.flatMap((r) => r.byH).filter((v) => v === v && v > 0);
      const lo = Math.min(0.5, ...vals), hi = Math.max(1.25, ...vals);
      const pad = { l: 36, r: 150, t: 10, b: 26 };
      const y = (v) => pad.t + ((Math.log(hi) - Math.log(v)) / (Math.log(hi) - Math.log(lo))) * (h - pad.t - pad.b);
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`); svg.setAttribute("height", h);
      const tk = [0.5, 0.75, 1.25, 1.5, 2].filter((v) => v >= lo && v <= hi).map((v) => ({ valueOf: () => v, label: `${v}` }));
      lineFigure(svg, rows, { xs: [0, 1, 2, 3], xLabel: (v) => `${v} wk`, y: (v) => y(+v), yTicks: tk, ref: 1, pts: (r) => r.byH, w, h, pad }); }
    // Anatomy: each model's WIS split into spread, over- and under-prediction; sorted like the leaderboard
    { const f = figsEl.querySelector('[data-fig="an"]'), svg = f.querySelector("svg"), w = figW(f);
      figsEl.querySelectorAll(".tog").forEach((b) => b.classList.toggle("on", b.dataset.v === S.anatomy));
      const rh = 18, pad = { l: 150, r: 48, t: 4, b: 4 }, h = pad.t + rows.length * rh + pad.b;
      const max = Math.max(...rows.map((r) => r.wis)), bw = w - pad.l - pad.r, hot = S.hot, any = hot && rows.some((r) => r.m === hot);
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`); svg.setAttribute("height", h);
      let html = "";
      rows.forEach((r, i) => {
        const yy = pad.t + i * rh, tot = r.disp + r.over + r.under, k = S.anatomy === "share" ? bw / tot : bw / max;
        const slot = opts.slotOf(r.m), on = r.m === hot, op = any && !on ? 0.35 : 1;
        html += `<g data-m="${esc(r.m)}" class="an${on ? " on" : ""}" opacity="${op}">`
          + (slot != null ? `<circle cx="8" cy="${yy + rh / 2}" r="3" fill="${opts.seriesColor(slot)}"/>` : "")
          + `<text x="18" y="${yy + rh / 2 + 4}" class="nm">${esc(fitName(r.m, pad.l - 26))}</text><title>${esc(r.m)}</title>`;
        let x = pad.l;
        for (const [v, cls] of [[r.disp, "k1"], [r.over, "k2"], [r.under, "k3"]]) {
          const ww = Math.max(0, v * k - 2);
          if (ww > 0) html += `<rect x="${x}" y="${yy + 4}" width="${ww}" height="${rh - 8}" rx="2" class="${cls}"/>`;
          x += v * k;
        }
        html += `<text x="${S.anatomy === "share" ? w - pad.r + 6 : x + 4}" y="${yy + rh / 2 + 4}" class="tk">${S.anatomy === "share" ? `${Math.round((100 * r.under) / tot)}% under` : fmtW(r.wis)}</text>`
          + `<rect x="0" y="${yy}" width="${w}" height="${rh}" fill="transparent" class="hit" data-m="${esc(r.m)}"/></g>`;
      });
      svg.innerHTML = html; }
  }
  figsEl.addEventListener("pointerover", (e) => { const t = e.target.closest("[data-m]"); opts.onPreview?.(t ? t.dataset.m : null); });
  figsEl.addEventListener("pointerleave", () => opts.onPreview?.(null));

  /* ---------------- public ---------------- */
  let seq = 0;
  async function update() {
    const my = ++seq;
    renderScope();
    await compute();
    if (my !== seq) return;
    heatSl = null;
    renderScope(); scopeClone && renderScope(scopeClone); redraw();
  }
  function redraw() { readRamp(); renderBoard(); renderHeatLine(); renderHeat(); renderFigures(); }
  function highlight(m) {
    if (m === S.hot) return;
    S.hot = m;
    rowsEl.querySelectorAll(".ev-row.hot").forEach((r) => r.classList.remove("hot"));
    if (m) rowsEl.querySelector(`.ev-row[data-m="${CSS.escape(m)}"]`)?.classList.add("hot");
    renderHeat(); renderFigures();
  }
  // a second copy of the scope line, for the floating bubble; kept in sync by update()
  let scopeClone = null;
  function cloneScope(target) { scopeClone = target; target.classList.add("ev-scope"); renderScope(target); return target; }
  let rz = 0;
  new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { renderBoard(); renderHeat(); renderFigures(); }); }).observe(el);
  return { update, redraw, highlight, renderHeat, cloneScope, scopeEl, get result() { return result; }, state: S };
}
