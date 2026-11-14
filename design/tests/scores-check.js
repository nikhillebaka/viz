/* Regression check for the scores section under the fan chart (studies/evaluation-goals.md), on
 * studies/intervals-refine.html. Run from the page's console:
 *     (await import("/tests/scores-check.js")).run()
 * Covers the page-level behaviour: scrolling, the lift, frosted glass off the chart, and the links
 * between the scores and the chart. Run tests/time-nav-check.js too: the chart's own behaviour. */
import { LiquidGlass } from "../lib/glass.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run() {
  const nav = window.__nav, sel = window.__sel, ev = window.__ev, el = document.getElementById("chart");
  if (!nav || !ev) throw new Error("open studies/intervals-refine.html first");
  const raf = window.requestAnimationFrame, caf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  const settle = async (ms = 8000) => { const t0 = performance.now(); await sleep(250); while ((nav.raf || nav.moving) && performance.now() - t0 < ms) await sleep(50); };
  const go = async (y) => { scrollTo(0, y); dispatchEvent(new Event("scroll")); await sleep(450); };
  const wheel = (o) => { const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...o }); el.dispatchEvent(e); return e.defaultPrevented; };

  try {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); // start with nothing focused
    await go(0);
    nav.goTo(5, { recenter: true }); await settle();
    const padT = window.__G.pad.t;

    // scrolling: vertical scroll over the chart belongs to the page; the chart keeps its own gestures
    check("a vertical scroll over the chart scrolls the page (not cancelled)", !wheel({ deltaY: 40 }));
    check("shift + vertical scroll over the chart is still height zoom (cancelled)", wheel({ deltaY: 40, shiftKey: true }));
    nav.setHeight(1); await settle();
    check("side scroll over the chart is still the chart's", wheel({ deltaX: 40 }));
    await settle();

    // the section
    const rows = [...document.querySelectorAll("#scores .ev-row")].map((r) => r.dataset.m);
    const expect = new Set([...sel.selected, ev.result.baseline]);
    check("the leaderboard lists the selection and the baseline", rows.length === expect.size && rows.every((m) => expect.has(m)), { rows: rows.length, expect: expect.size });
    { const head = document.querySelector("#scores .ev-head"), rowsEl = document.querySelector("#scores .ev-rows");
      check("the column titles are a footer under the rows, sticky to the screen's bottom", head.previousElementSibling === rowsEl && getComputedStyle(head).position === "sticky" && getComputedStyle(head).bottom === "0px"); }
    check("the peek: the scope line shows at the bottom of the first screen", (() => { const r = ev.scopeEl.getBoundingClientRect(); return r.top < innerHeight && r.top > innerHeight - 80; })(), { top: Math.round(ev.scopeEl.getBoundingClientRect().top), h: innerHeight });

    // the footer rides the screen's bottom while the table is cut off by it, then rests under the last row
    { const board = document.querySelector("#scores .ev-board"), head = board.querySelector(".ev-head"), rowsEl = board.querySelector(".ev-rows");
      const y0 = scrollY + board.getBoundingClientRect().top;
      await go(Math.max(0, y0 - innerHeight + 140));
      const riding = Math.abs(head.getBoundingClientRect().bottom - innerHeight) < 2 && rowsEl.getBoundingClientRect().bottom > innerHeight;
      await go(y0 - 80);
      const resting = Math.abs(head.getBoundingClientRect().top - rowsEl.getBoundingClientRect().bottom) < 2;
      check("the column titles ride the bottom of the screen while the table runs past it", riding, { headBottom: Math.round(head.getBoundingClientRect().bottom), h: innerHeight });
      check("…and rest under the last row once the table ends", resting); }
    // figures: every selected model on each one; hovering a row brings that model up in every figure
    { const figs = [...document.querySelectorAll("#scores .ev-fig")], n = ev.result.rows.filter((r) => (sel.selected.includes(r.m) || r.m === ev.result.baseline) && r.rel === r.rel && r.n).length;
      const counts = figs.map((f) => f.dataset.fig === "an" ? f.querySelectorAll("g.an").length : f.querySelectorAll("path.hit").length);
      check("Calibration, Horizon and Anatomy each show every selected model", figs.length === 3 && counts.every((c) => c === n), { counts, n });
      const m = sel.selected[1];
      document.querySelector(`#scores .ev-row[data-m="${CSS.escape(m)}"]`).dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      await sleep(60);
      check("hovering a row brings that model up in every figure", figs.every((f) => f.querySelector(`.on[data-m="${CSS.escape(m)}"]`)), {});
      const hit = figs[0].querySelector(`path.hit[data-m="${CSS.escape(sel.selected[2])}"]`);
      hit?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); await sleep(60);
      check("hovering a figure line lights that model's leaderboard row", !!document.querySelector(`#scores .ev-row.hot[data-m="${CSS.escape(sel.selected[2])}"]`));
      document.querySelector("#scores .ev-figs").dispatchEvent(new PointerEvent("pointerleave")); await sleep(60); }
    // fixed glass never trails a scroll: once the page is scrolled at all (chart still under it), the browser refracts it
    await go(60); LiquidGlass.frame(); await sleep(50);
    { const m = document.getElementById("c-models"), back = document.getElementById("back");
      check("scrolled a little, with the chart still under them, the fixed bubbles use the browser's refraction", m.classList.contains("lg--paper") && /url\(/.test(m.style.backdropFilter) && back.classList.contains("lg--paper"));
      const rb = document.getElementById("c-rulers");
      check("…while the chart's own bubbles (which scroll with it) stay in the WebGL pass", !rb.classList.contains("lg--paper")); }
    await go(0); await sleep(350); LiquidGlass.frame(); await sleep(50);
    check("at the top again, the fixed bubbles go back to the WebGL pass", !document.getElementById("c-models").classList.contains("lg--paper"));
    // the lift, the tuck, frosted glass
    await go(document.getElementById("view").offsetHeight + 40);
    const bubble = document.getElementById("scope-bubble");
    check("scrolled to the scores, the scope line lifts into the top bubble", bubble.classList.contains("show") && ev.scopeEl.classList.contains("lifted"));
    check("…and the chart's own bubbles are tucked away", document.getElementById("chrome").classList.contains("tucked"));
    LiquidGlass.frame(); await sleep(50);
    { const m = document.getElementById("c-models"), sb = document.getElementById("scope-bubble");
      check("…and the fixed top bubbles switch to the page's glass (off the chart)", m.classList.contains("lg--paper"));
      check("…which is the same refraction filter as over the chart, not just a blur", /url\(/.test(m.style.backdropFilter) && /url\(/.test(sb.style.backdropFilter), { models: m.style.backdropFilter, scope: sb.style.backdropFilter }); }
    // changing the scope from the bubble: the popover stays by its button, the bubble keeps its glass
    const frag = bubble.querySelector('.f[data-k="h"]'), layers0 = bubble.querySelectorAll(":scope > .lg-layer").length;
    frag.click(); await sleep(400);
    const pop = document.querySelector(".c-float"), opt = pop?.querySelector(".ev-checks button");
    opt?.click(); await sleep(300);
    const fr = frag.getBoundingClientRect(), pr = pop?.getBoundingClientRect();
    check("after a choice in a scope popover, its button is still the same element", frag.isConnected && bubble.contains(frag));
    check("…the popover stays next to it (doesn't jump to a corner)", pr && Math.abs(pr.top - fr.bottom) < 40 && Math.abs(pr.left - fr.left) < 300, { frag: [Math.round(fr.left), Math.round(fr.bottom)], pop: pr && [Math.round(pr.left), Math.round(pr.top)] });
    check("the bubble's fragments are plain text buttons (no browser button chrome)", [...bubble.querySelectorAll("button")].every((b) => { const cs = getComputedStyle(b); return cs.borderTopWidth === "0px" && cs.backgroundColor === "rgba(0, 0, 0, 0)"; }));
    check("…and the bubble keeps its glass layers", bubble.querySelectorAll(":scope > .lg-layer").length === layers0 && layers0 > 0, { layers0, now: bubble.querySelectorAll(":scope > .lg-layer").length });
    opt?.click(); await sleep(200); // put the horizon back
    (pop?.querySelector("button") || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(400);
    check("the chart doesn't clip its bubbles' shadows", getComputedStyle(document.getElementById("view")).overflow === "visible");
    await go(0);
    check("back at the top, the scope line is on the paper again", !bubble.classList.contains("show") && !ev.scopeEl.classList.contains("lifted") && !document.getElementById("chrome").classList.contains("tucked"));
    LiquidGlass.frame(); await sleep(50);
    check("…and the top bubbles refract the chart again (WebGL pass, no backdrop filter)", !document.getElementById("c-models").classList.contains("lg--paper") && !document.getElementById("c-models").style.backdropFilter);
    window.__draw(); await sleep(50);
    check("the chart's top margin doesn't depend on the scroll position", Math.abs(window.__G.pad.t - padT) < 1, { before: padT, after: window.__G.pad.t });

    // links: hover a charted row → it previews on the chart; leaving clears it
    const charted = sel.charted[0].m, row = document.querySelector(`#scores .ev-row[data-m="${CSS.escape(charted)}"]`);
    row.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await sleep(80); window.__draw();
    check("hovering a charted model's row previews it on the chart", window.__G.focus === charted, { focus: window.__G.focus });
    document.querySelector("#scores .ev-rows").dispatchEvent(new PointerEvent("pointerleave"));
    await sleep(80); window.__draw();
    check("…and leaving the rows clears the preview", window.__G.focus == null, { focus: window.__G.focus });

    // the dot charts a model (queue of five)
    const un = sel.selected.find((m) => !sel.isCharted(m));
    if (un) {
      document.querySelector(`#scores .ev-row[data-m="${CSS.escape(un)}"] button.cd`).click();
      check("clicking the dot on a row charts that model", sel.isCharted(un));
      await sleep(80);
      check("…and its row then shows the color dot", !!document.querySelector(`#scores .ev-row[data-m="${CSS.escape(un)}"] .cd.on`));
    }

    // a heatmap cell shows that forecast on the chart
    await go(document.getElementById("view").offsetHeight + 200);
    const cv = document.querySelector("#scores .ev-heat-canvas"), r = cv.getBoundingClientRect();
    // the last column, first row
    const x = r.right - 6, y = r.top + 30 + 11;
    // smooth scrolling doesn't advance in a hidden pane: record the request and jump instead
    const realScrollTo = window.scrollTo; let asked = null;
    window.scrollTo = (o) => { asked = o; realScrollTo.call(window, { top: o.top ?? 0, behavior: "auto" }); };
    cv.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }));
    window.scrollTo = realScrollTo;
    await settle(); for (let i = 0; i < 40 && scrollY > 40; i++) await sleep(100); // smooth scroll (slow in a hidden pane)
    const lastRound = ev.result.blocks.at(-1).round, wk = window.__nav.week;
    check("clicking a heatmap cell moves the chart to that week", d3.utcFormat("%Y-%m-%d")(window.__nav.dates?.[wk] ?? new Date(0)) === lastRound || document.querySelector("#c-date")?.textContent.includes(new Date(lastRound + "T00:00:00Z").toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" })), { lastRound, wk });
    check("…focuses the model", window.__G.focus != null, { focus: window.__G.focus });
    check("…and scrolls the chart into view", asked?.top === 0 && scrollY < 40, { asked, scrollY });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  } finally {
    await go(0);
    window.requestAnimationFrame = raf; window.cancelAnimationFrame = caf;
  }
  const failed = results.filter((r) => !r.ok);
  console.table(results.map((r) => ({ ok: r.ok ? "✓" : "✗", name: r.name, detail: r.ok ? "" : JSON.stringify(r.detail ?? "") })));
  return { passed: results.length - failed.length, failed: failed.length, results };
}
