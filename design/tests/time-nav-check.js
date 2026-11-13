/* Regression check for lib/time.js on the fan chart page (studies/intervals-refine.html).
 * Every behaviour agreed in studies/time-navigation.md has a case here. Run it after any change to time
 * navigation, from the page's console:
 *     (await import("/tests/time-nav-check.js")).run()
 * It drives the page with synthetic wheel, pointer and key events and returns { passed, failed, results }.
 * run({ rulers: true }) runs everything with the width rulers on.
 * Things only a real hand can judge (smoothness, feel) are not covered. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

export async function run({ rulers = false } = {}) {
  const nav = window.__nav, el = document.getElementById("chart");
  if (!nav || !el) throw new Error("open studies/intervals-refine.html first");
  // a hidden tab throttles animation frames; tests need them to run
  const raf = window.requestAnimationFrame, caf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);

  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  // wait until every spring and gesture timer has finished (or ms passes)
  const settle = async (ms = 4000) => { const t0 = performance.now(); await sleep(250); while ((nav.raf || nav.moving) && performance.now() - t0 < ms) await sleep(50); };
  const key = (k) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const wheel = async (n, o) => { for (let i = 0; i < n; i++) { el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...o })); await sleep(16); } };
  const pinch = (n, dy) => wheel(n, { deltaY: dy, ctrlKey: true });
  const pan = (n, dx) => wheel(n, { deltaX: dx, metaKey: true });
  const scroll = (n, dx) => wheel(n, { deltaX: dx });
  const mid = () => { const [a, b] = nav.domain(); return (+a + +b) / 2; };
  const reset = async () => { key("0"); await settle(); nav.goTo(5, { recenter: true }); await settle(); };
  let id = 100;
  const drag = async (dx, steps = 10) => {
    const r = el.getBoundingClientRect(), x0 = r.left + r.width * 0.45, y = r.top + r.height * 0.6, p = ++id;
    el.dispatchEvent(new PointerEvent("pointerdown", { clientX: x0, clientY: y, pointerId: p, button: 0, bubbles: true, pointerType: "mouse" }));
    for (let i = 1; i <= steps; i++) { el.dispatchEvent(new PointerEvent("pointermove", { clientX: x0 + (dx * i) / steps, clientY: y, pointerId: p, bubbles: true, pointerType: "mouse" })); await sleep(16); }
    await sleep(200); // let go after stopping, so there's no flick
    el.dispatchEvent(new PointerEvent("pointerup", { clientX: x0 + dx, clientY: y, pointerId: p, button: 0, bubbles: true, pointerType: "mouse" }));
  };
  const pxw = () => { const [r0, r1] = nav.scale().range(); return (r1 - r0) / nav.span; };

  const rulersBtn = document.getElementById("c-rulers");
  const setRulers = async (on) => { if ((rulersBtn.getAttribute("aria-pressed") === "true") !== on) { rulersBtn.click(); await sleep(400); } };
  const rulerLabel = () => [...el.querySelectorAll("text")].find((t) => /^(\+\d wk|This wk)$/.test(t.textContent));
  try {
    await setRulers(rulers);
    await reset();
    // --- date: keys, stepper, glide
    { const T0 = nav.T, seen = []; key("ArrowRight"); for (let i = 0; i < 40; i++) { seen.push(nav.T); await sleep(8); } await settle(400);
      const back = seen.some((v, i) => i && v < seen[i - 1] - 1e-9);
      check("arrow: one week, exact landing, never backwards", nav.T === T0 + 1 && !back, { T: nav.T, back }); }
    { const T0 = nav.T; for (let i = 0; i < 5; i++) { key("ArrowRight"); await sleep(45); } await settle();
      check("five quick presses: five weeks", nav.T === T0 + 5, { T: nav.T }); }
    await reset();
    // --- side scroll scrub speed
    for (const [label, span, lo, hi] of [["home span", 11, 0.7, 1.1], ["20 weeks", 20, 0.9, 1.5], ["full season", 1e9, 0.8, 1.5]]) {
      nav.zoomTo(span); await settle(); const T0 = nav.T; await scroll(10, 10); const moved = nav.T - T0; await settle();
      check(`side scroll at ${label}: 100px ≈ a week`, moved >= lo && moved <= hi, { moved: +moved.toFixed(2) });
      nav.goTo(5, { recenter: true }); await settle();
    }
    await reset();
    // --- zoom
    await pinch(12, 8); await settle(); const rest = nav.span;
    check("pinch out a little: rests between 20 weeks and the season", rest > 20 && rest < nav.seasonSpan - 1, { span: +rest.toFixed(1) });
    await pinch(40, 10); await settle();
    check("pinch far out: hard stop at the season", near(nav.span, nav.seasonSpan, 0.01), { span: +nav.span.toFixed(1) });
    await pinch(60, -10); await settle(1200);
    check("pinch far in: springs back to 6 weeks", near(nav.span, 6, 0.01), { span: +nav.span.toFixed(2) });
    await reset();
    // --- pan works at every zoom short of the full season
    for (const span of [8, 11, 20, 30, 40]) {
      nav.zoomTo(span); await settle(); const m0 = mid(), T0 = nav.T; await pan(5, -20); await settle();
      const moved = (mid() - m0) / 864e5 / 7;
      check(`⌘ pan at ${span} weeks moves the view, not the date`, moved < -0.3 && nav.T === T0, { weeks: +moved.toFixed(2), T: nav.T });
      nav.recenter(); await settle();
    }
    nav.zoomTo(1e9); await settle(); { const m0 = mid(); await pan(5, -20); await settle();
      check("⌘ pan at the full season: nothing to pan", near(mid(), m0, 864e5), {}); }
    await reset();
    // --- pan is kept while the forecast is on screen
    await pan(5, -15); await settle(); { const vis = nav.refVisible(), x0 = nav.refX(), T0 = nav.T; await scroll(4, 30); await settle(); key("ArrowRight"); await settle();
      check("after a small pan (whole fan still on screen), scroll and keys change the date and leave the reference line put", vis && nav.T > T0 && near(nav.refX(), x0, 1.5), { vis, dx: +(nav.refX() - x0).toFixed(1), T: nav.T }); }
    await reset();
    // --- off-screen: plain scroll pans home first, from either side, then scrubs
    for (const [side, dir] of [["future (forecast off the left)", 1], ["past (forecast off the right)", -1]]) {
      await pan(40, 30 * dir); await settle(); const off = !nav.refVisible(), T0 = nav.T;
      await scroll(30, -30 * dir); await settle(); const midway = { P: nav.P, T: nav.T };
      await scroll(40, -30 * dir); await settle();
      check(`panned into the ${side}: plain scroll pans home, then scrubs`, off && midway.T === T0 && Math.abs(midway.P) > 0.5 && nav.P === 0 && nav.T !== T0, { midway, end: { P: nav.P, T: nav.T } });
      await reset();
    }
    await pan(40, 30); await settle(); key("ArrowRight"); await settle();
    check("arrow with the forecast off-screen brings it home", nav.P === 0 && nav.refVisible(), { P: nav.P });
    await reset();
    // --- zoom while panned keeps the middle still
    await pan(6, -25); await settle(); { const m0 = mid(); await pinch(6, 6); await settle();
      check("zoom while panned keeps the middle still", near(mid(), m0, 864e5 * 1.5), { driftDays: +((mid() - m0) / 864e5).toFixed(1) }); }
    await reset();
    // --- reset and double-click
    await pinch(10, 8); await pan(5, -20); await settle(); key("0"); await settle();
    check("0 returns to 11 weeks, unpanned", near(nav.span, 11, 0.01) && nav.P === 0, { span: nav.span, P: nav.P });
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await settle(1200);
    const full = near(nav.span, nav.seasonSpan, 0.01);
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await settle(1200);
    check("double-click: fully out, then back home", full && near(nav.span, 11, 0.01), { span: nav.span });
    await reset();
    // --- drag
    { const T0 = nav.T, w = pxw(); await drag(-w); await settle();
      check("drag close up: one week-width left = one week later (1:1)", nav.T === T0 + 1, { T: nav.T }); }
    nav.zoomTo(1e9); await settle(); { const T0 = nav.T; await drag(150); await settle();
      check("drag at the full season: the forecast follows the pointer (right = later)", nav.T > T0, { T: nav.T }); }
    await reset();
    // --- width rulers
    await setRulers(false); await reset(); const d0 = nav.domain().map(Number), x0 = nav.refX();
    await setRulers(true); await sleep(300);
    const d1 = nav.domain().map(Number);
    check("rulers: toggling them doesn't rescale or move the chart", d0[0] === d1[0] && d0[1] === d1[1] && near(nav.refX(), x0, 0.5), {});
    for (const span of [8, 11, 20, 30, 1e9]) {
      nav.zoomTo(span); await settle(); const lab = rulerLabel();
      const bars = lab ? lab.parentNode.querySelectorAll("g[transform] > line").length : 0;
      check(`rulers show at ${span > 100 ? "the full season" : span + " weeks"}`, !!lab && bars >= 3, { bars });
    }
    await reset();
    { // during a glide the rulers stay beside the fan (same offset from the reference line every frame)
      const offs = []; key("ArrowRight");
      // both read from the same drawn frame: the ruler label and the reference-date tick label
      const refTick = () => [...el.querySelectorAll("tspan")].find((t) => t.textContent === "Reference date");
      for (let i = 0; i < 25; i++) { const lab = rulerLabel(), rt = refTick(); if (lab && rt) offs.push(+lab.getAttribute("x") - +rt.getAttribute("x")); await sleep(12); }
      await settle(); const spread = Math.max(...offs) - Math.min(...offs);
      check("rulers move with the fan during a glide", offs.length > 5 && spread < 2, { frames: offs.length, spread: +spread.toFixed(2) });
    }
    await pan(5, -15); await settle(); check("rulers stay beside the fan when panned", !!rulerLabel() && near(+rulerLabel().getAttribute("x") - nav.scale()(nav.ref), 3 * pxw() + 14, 2), {});
    await reset();
    { // model labels step aside: they start after the last ruler
      const lab = rulerLabel(), xs = [...lab.parentNode.querySelectorAll("g[transform]")].map((g) => +g.getAttribute("transform").match(/translate\(([-\d.]+)/)[1]);
      const lx = Math.min(...[...el.querySelectorAll(".fc-label")].map((g) => +g.getAttribute("transform").match(/translate\(([-\d.]+)/)[1]));
      check("model labels sit clear of the rulers", lx > Math.max(...xs) + 4, { lastRuler: Math.round(Math.max(...xs)), labels: Math.round(lx) });
    }
    await setRulers(rulers); await reset();
  } finally {
    window.requestAnimationFrame = raf; window.cancelAnimationFrame = caf;
  }
  const failed = results.filter((r) => !r.ok);
  console.table(results.map((r) => ({ ok: r.ok ? "✓" : "✗", name: r.name, detail: JSON.stringify(r.detail) })));
  return { passed: results.length - failed.length, failed: failed.length, results };
}
