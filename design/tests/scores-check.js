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
    check("the peek: the scope line shows at the bottom of the first screen", (() => { const r = ev.scopeEl.getBoundingClientRect(); return r.top < innerHeight && r.top > innerHeight - 80; })(), { top: Math.round(ev.scopeEl.getBoundingClientRect().top), h: innerHeight });

    // the lift, the tuck, frosted glass
    await go(document.getElementById("view").offsetHeight + 40);
    const bubble = document.getElementById("scope-bubble");
    check("scrolled to the scores, the scope line lifts into the top bubble", bubble.classList.contains("show") && ev.scopeEl.classList.contains("lifted"));
    check("…and the chart's own bubbles are tucked away", document.getElementById("chrome").classList.contains("tucked"));
    LiquidGlass.frame(); await sleep(50);
    check("…and the fixed top bubbles are frosted (off the chart)", document.getElementById("c-models").classList.contains("lg--paper"));
    await go(0);
    check("back at the top, the scope line is on the paper again", !bubble.classList.contains("show") && !ev.scopeEl.classList.contains("lifted") && !document.getElementById("chrome").classList.contains("tucked"));
    LiquidGlass.frame(); await sleep(50);
    check("…and the top bubbles refract the chart again", !document.getElementById("c-models").classList.contains("lg--paper"));
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
