/* Performance benchmark for the fan chart page (studies/intervals-refine.html).
 *     (await import("/tests/perf-check.js")).run()
 * For 5, 20 and 140 selected models (or as many as the data has) (5 charted, the rest as Show all context), it drives synthetic frames
 * of a scrub (date between weeks), a pan and a pinch, and times each frame's work:
 *   script: building the chart (data, d3, DOM), readout and hover checks
 *   layout: the style and layout that work forces
 * Paint and the liquid glass's re-rendering happen after this and can't be timed from script; when the
 * tab is visible, `real: true` also runs a live 2 s scrub and reports actual frame intervals, which include
 * them (and glass on vs off).
 * Returns { rows } and logs a table. Restores the page's selection and view afterwards. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

export async function run({ counts = [5, 20, 140], frames = 60, real = !document.hidden } = {}) {
  const nav = window.__nav, sel = window.__sel, draw = window.__draw, ALL = window.__models;
  if (!nav || !sel || !draw) throw new Error("open studies/intervals-refine.html first");
  const saved = { selected: [...sel.selected], charted: sel.charted.map((c) => ({ ...c })), showAll: sel.showAll, view: nav.view(), T: nav.T };
  const rows = [];
  const time = (label, n, step) => {
    const sc = [], ly = [];
    for (let i = 0; i < frames; i++) {
      step(i / frames);
      const t0 = performance.now(); draw(); const t1 = performance.now();
      void document.body.offsetHeight; void document.getElementById("chart").getBoundingClientRect(); const t2 = performance.now();
      sc.push(t1 - t0); ly.push(t2 - t1);
    }
    rows.push({ models: n, gesture: label, "script ms (median)": +q(sc, 0.5).toFixed(2), "script ms (p95)": +q(sc, 0.95).toFixed(2), "layout ms (median)": +q(ly, 0.5).toFixed(2), "total p95": +(q(sc, 0.95) + q(ly, 0.95)).toFixed(2) });
  };
  try {
    for (const want of counts) {
      const pick = ALL.slice(0, want), n = pick.length; // the data may have fewer models than asked for
      sel.setMany(sel.selected.filter((m) => !pick.includes(m)), false);
      sel.setMany(pick, true);
      sel.setShowAll(true);
      nav.setView({ Z: Math.log(11), P: 0 }); await sleep(600);
      const T0 = Math.round(nav.T);
      time("scrub", n, (u) => { nav.T = T0 + u * 2; });
      nav.T = T0;
      time("pan", n, (u) => { nav.P = -3 * u; });
      nav.P = 0;
      time("pinch", n, (u) => { nav.Z = Math.log(8 + 30 * u); });
      nav.Z = Math.log(11);
      if (real) {
        for (const glass of [true, false]) {
          document.getElementById("view").classList.toggle("no-glass", !glass);
          const iv = []; let last = performance.now(), t0 = last;
          await new Promise((done) => {
            const f = (now) => { iv.push(now - last); last = now; nav.T = T0 + ((now - t0) / 2000) * 2; draw(); if (now - t0 < 2000) requestAnimationFrame(f); else done(); };
            requestAnimationFrame(f);
          });
          rows.push({ models: n, gesture: `live scrub, glass ${glass ? "on" : "off"}`, "frame ms (median)": +q(iv.slice(2), 0.5).toFixed(1), "frame ms (p95)": +q(iv.slice(2), 0.95).toFixed(1) });
        }
        document.getElementById("view").classList.remove("no-glass");
      }
    }
  } finally {
    sel.setShowAll(saved.showAll);
    sel.setMany(sel.selected.filter((m) => !saved.selected.includes(m)), false);
    sel.setMany(saved.selected, true);
    sel.selected = saved.selected; sel.charted = saved.charted; sel.setShowAll(saved.showAll); // exact original order and colors
    nav.T = saved.T; nav.setView(saved.view);
    draw();
  }
  console.table(rows);
  return { rows };
}
