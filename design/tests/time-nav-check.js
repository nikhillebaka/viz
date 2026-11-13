/* Regression check for lib/time.js on the fan chart page (studies/intervals-refine.html).
 * Every behaviour agreed in studies/time-navigation.md has a case here. Run it after any change to time
 * navigation, from the page's console:
 *     (await import("/tests/time-nav-check.js")).run()
 * It drives the page with synthetic wheel, pointer and key events and returns { passed, failed, results }.
 * run({ rulers: true }) runs everything with the width rulers on.
 * Things only a real hand can judge (smoothness, feel) are not covered.
 * Run it in a desktop-sized window (about 1280 px wide or more): the scroll-speed and picker-width cases
 * assume one, and five of them fail in a narrow pane even when nothing is wrong. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

export async function run({ rulers = false } = {}) {
  const nav = window.__nav, el = document.getElementById("chart");
  if (!nav || !el) throw new Error("open studies/intervals-refine.html first");
  if (innerWidth < 1200) console.warn(`time-nav-check: window is ${innerWidth}px wide; the scroll-speed and picker-width cases expect about 1280 or more`);
  // a hidden tab throttles animation frames; tests need them to run
  const raf = window.requestAnimationFrame, caf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);

  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  // wait until every spring and gesture timer has finished (or ms passes)
  const settle = async (ms = 10000) => { const t0 = performance.now(); await sleep(250); while ((nav.raf || nav.moving) && performance.now() - t0 < ms) await sleep(50); };
  const key = (k) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const wheel = async (n, o) => { for (let i = 0; i < n; i++) { el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...o })); await sleep(16); } };
  const pinch = (n, dy) => wheel(n, { deltaY: dy, ctrlKey: true });
  const pan = (n, dx) => wheel(n, { deltaX: dx, metaKey: true });
  const scroll = (n, dx) => wheel(n, { deltaX: dx });
  const mid = () => { const [a, b] = nav.domain(); return (+a + +b) / 2; };
  const reset = async () => { key("0"); await settle(); nav.goTo(5, { recenter: true }); await settle(); };
  let id = 100;
  const drag = async (dx, steps = 10, metaKey = false) => {
    const r = el.getBoundingClientRect(), x0 = r.left + r.width * 0.45, y = r.top + r.height * 0.6, p = ++id;
    el.dispatchEvent(new PointerEvent("pointerdown", { clientX: x0, clientY: y, pointerId: p, button: 0, bubbles: true, pointerType: "mouse", metaKey }));
    for (let i = 1; i <= steps; i++) { el.dispatchEvent(new PointerEvent("pointermove", { clientX: x0 + (dx * i) / steps, clientY: y, pointerId: p, bubbles: true, pointerType: "mouse" })); await sleep(16); }
    await sleep(200); // let go after stopping, so there's no flick
    el.dispatchEvent(new PointerEvent("pointerup", { clientX: x0 + dx, clientY: y, pointerId: p, button: 0, bubbles: true, pointerType: "mouse" }));
  };
  const pxw = () => { const [r0, r1] = nav.scale().range(); return (r1 - r0) / nav.span; };

  const rulersBtn = document.getElementById("c-rulers");
  const setRulers = async (on) => { if ((rulersBtn.getAttribute("aria-pressed") === "true") !== on) { rulersBtn.click(); await sleep(400); } };
  // the chart is a canvas: read what was drawn from the last frame's layout (window.__G), not the DOM
  const drawnRulers = () => window.__G?.rulers || null;
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
    // --- a trackpad flick: it snaps during the coast's tail, not after it, and the tail can't move it
    { const T0 = nav.T, seq = [...Array(8).fill(24), ...Array.from({ length: 30 }, (_, k) => 24 * 0.8 ** (k + 1))];
      let snappedAt = -1, landed = null;
      for (let i = 0; i < seq.length; i++) {
        el.dispatchEvent(new WheelEvent("wheel", { deltaX: seq[i], bubbles: true, cancelable: true })); await sleep(16);
        if (snappedAt < 0 && !nav.busy && i > 8) { snappedAt = i; landed = nav.week; }
      }
      await settle();
      check("trackpad flick: snaps while the coast is still tailing off, and the tail doesn't move it", snappedAt > 0 && snappedAt < seq.length - 5 && nav.T === landed && nav.T > T0, { snappedAt, of: seq.length, T: nav.T, landed }); }
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
    nav.setHeight(2.5); await settle();
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await settle();
    const full = near(nav.span, nav.seasonSpan, 0.01) && near(nav.heightZoom, 1, 1e-6);
    nav.setHeight(2.5); await settle();
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await settle();
    check("double-click: fully out, then back home, at normal height both times", full && near(nav.span, 11, 0.01) && near(nav.heightZoom, 1, 1e-6), { span: nav.span, z: nav.heightZoom });
    await reset();
    // --- drag
    { const T0 = nav.T, w = pxw(); await drag(-w); await settle();
      check("drag close up: one week-width left = one week later (1:1)", nav.T === T0 + 1, { T: nav.T }); }
    for (const span of [11, 30]) { // ⌘ + drag pans like ⌘ + side scroll: content follows the pointer, date stays
      nav.zoomTo(span); await settle(); const m0 = mid(), T0 = nav.T, w = pxw(); await drag(w * 2, 10, true); await settle();
      const moved = (mid() - m0) / 864e5 / 7;
      check(`⌘ + drag at ${span} weeks pans 1:1, date unchanged`, near(moved, -2, 0.15) && nav.T === T0, { weeks: +moved.toFixed(2), T: nav.T });
      nav.recenter(); await settle();
    }
    nav.zoomTo(1e9); await settle(); { const T0 = nav.T; await drag(150); await settle();
      check("drag at the full season: the forecast follows the pointer (right = later)", nav.T > T0, { T: nav.T }); }
    await reset();
    // --- height zoom: shift + scroll / shift + vertical drag, independent of date, zoom and pan
    { const top0 = window.__G.y.domain()[1];
      // normal height: the season's peak observed value fits under a round axis maximum
      check("the drawn y-axis at normal height fits the season and is a round number", top0 > 42626 && top0 % 10000 === 0, { top: top0 });
      const before = { T: nav.T, span: nav.span, P: nav.P };
      await wheel(8, { deltaY: -10, shiftKey: true }); await settle();
      const z1 = nav.heightZoom, same = nav.T === before.T && near(nav.span, before.span, 1e-9) && near(nav.P, before.P, 1e-9);
      check("shift + scroll up stretches height only (date, zoom and pan unchanged)", z1 > 1.5 && same, { z: +z1.toFixed(2), same });
      check("…and the drawn y-axis maximum shrinks by the same factor", near(window.__G.y.domain()[1], top0 / z1, top0 * 0.01), { top: Math.round(window.__G.y.domain()[1]), expect: Math.round(top0 / z1) });
      key("ArrowRight"); await settle();
      check("changing the date keeps the height zoom", near(nav.heightZoom, z1, 1e-6), { z: +nav.heightZoom.toFixed(2) });
      await wheel(80, { deltaY: 25, shiftKey: true }); await settle();
      check("height zoom stops at 1/3 (springs back from past it)", near(nav.heightZoom, 1 / 3, 1e-3), { z: +nav.heightZoom.toFixed(3) });
      await wheel(120, { deltaY: -25, shiftKey: true }); await settle();
      check("height zoom stops at ~6.7×", near(nav.heightZoom, 1 / 0.15, 1e-2), { z: +nav.heightZoom.toFixed(2) });
      key("0"); await settle();
      check("0 resets height", near(nav.heightZoom, 1, 1e-6), { z: nav.heightZoom });
      // shift + drag up stretches
      const r = el.getBoundingClientRect(), x0 = r.left + r.width * 0.45, y0 = r.top + r.height * 0.6, p = ++id;
      el.dispatchEvent(new PointerEvent("pointerdown", { clientX: x0, clientY: y0, pointerId: p, button: 0, bubbles: true, pointerType: "mouse", shiftKey: true }));
      for (let i = 1; i <= 10; i++) { el.dispatchEvent(new PointerEvent("pointermove", { clientX: x0, clientY: y0 - i * 10, pointerId: p, bubbles: true, pointerType: "mouse", shiftKey: true })); await sleep(16); }
      el.dispatchEvent(new PointerEvent("pointerup", { clientX: x0, clientY: y0 - 100, pointerId: p, button: 0, bubbles: true, pointerType: "mouse" }));
      await settle();
      check("shift + drag up stretches height, date unchanged", nav.heightZoom > 1.5 && nav.T === Math.round(nav.T), { z: +nav.heightZoom.toFixed(2) });
      key("0"); await settle(); }
    await reset();
    // --- focus: clicking a label focuses that model, and every frame still draws while focused
    { const l = window.__G.labels[0], r = el.getBoundingClientRect(), cx = r.left + l.x + 20, cy = r.top + l.y, p = ++id;
      el.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, pointerId: p, button: 0, bubbles: true, pointerType: "mouse" }));
      el.dispatchEvent(new PointerEvent("pointerup", { clientX: cx, clientY: cy, pointerId: p, button: 0, bubbles: true, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("click", { clientX: cx, clientY: cy, bubbles: true }));
      const focused = window.__G.focus === l.m;
      key("ArrowRight"); await settle(); const stillDrawing = window.__G.focus === l.m && window.__G.di === nav.week;
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await settle();
      check("clicking a label focuses it; focused frames keep drawing; Escape clears", focused && stillDrawing && window.__G.focus == null, { focused, stillDrawing }); }
    await reset();
    // --- width rulers
    await setRulers(false); await reset(); const d0 = nav.domain().map(Number), x0 = nav.refX();
    await setRulers(true); await sleep(300);
    const d1 = nav.domain().map(Number);
    check("rulers: toggling them doesn't rescale or move the chart", d0[0] === d1[0] && d0[1] === d1[1] && near(nav.refX(), x0, 0.5), {});
    for (const span of [8, 11, 20, 30, 1e9]) {
      nav.zoomTo(span); await settle(); const R = drawnRulers();
      const bars = R ? R.rows.length : 0;
      check(`rulers show at ${span > 100 ? "the full season" : span + " weeks"}`, !!R && bars >= 3, { bars });
    }
    await reset();
    { // during a glide the rulers stay beside the fan (same offset from the reference line every frame)
      const offs = []; key("ArrowRight");
      // both read from the same drawn frame: the ruler label and the reference-date tick label
      for (let i = 0; i < 25; i++) { const G = window.__G; if (G?.rulers && G.dates) offs.push(G.rulers.labelX - G.dates.ref.x); await sleep(12); }
      await settle(); const spread = Math.max(...offs) - Math.min(...offs);
      check("rulers move with the fan during a glide", offs.length > 5 && spread < 2, { frames: offs.length, spread: +spread.toFixed(2) });
    }
    await pan(5, -15); await settle(); check("rulers stay beside the fan when panned", !!drawnRulers() && near(drawnRulers().labelX - nav.scale()(nav.ref), 3 * pxw() + 14, 2), {});
    await reset();
    { // model labels step aside: they start after the last ruler
      const xs = drawnRulers().rows.map((r) => r.x);
      const lx = Math.min(...window.__G.labels.map((d) => d.x));
      check("model labels sit clear of the rulers", lx > Math.max(...xs) + 4, { lastRuler: Math.round(Math.max(...xs)), labels: Math.round(lx) });
    }
    await setRulers(rulers); await reset();
    // --- model picker: previews most of the season, keeps arrow keys, restores the view exactly on close
    const pill = document.getElementById("c-models");
    if (pill) {
      nav.zoomTo(8); await settle(); await pan(4, -15); await settle(); nav.setHeight(2); await settle();
      const v0 = { span: nav.span, P: nav.P, x: nav.refX(), H: nav.heightZoom };
      pill.click(); await settle(8000);
      const panel = document.querySelector(".pk-panel");
      // layout size, not getBoundingClientRect: the open animation is a scale transform (frozen in hidden tabs)
      const sized = () => panel.offsetWidth > el.clientWidth * 0.4 && panel.offsetHeight > el.clientHeight - 40;
      for (let i = 0; i < 80 && !sized(); i++) await sleep(100); // the open morph
      const wide = panel.offsetWidth > el.clientWidth * 0.4;
      const half = Math.abs(panel.offsetHeight - el.clientHeight) < 40 && !!document.querySelector("#view.picker-open");
      check("picker: the left half, full height; chart previews at 14 weeks, normal height", wide && half && near(nav.span, 14, 0.01) && near(nav.heightZoom, 1, 1e-6), { span: +nav.span.toFixed(2), h: Math.round(panel.offsetHeight), z: nav.heightZoom });
      const T0 = nav.T; key("ArrowRight"); await settle();
      check("picker: left/right still step the date while it's open", nav.T === T0 + 1, { T: nav.T });
      const input = panel.querySelector("input"); input.value = "ar6"; input.dispatchEvent(new Event("input", { bubbles: true })); await sleep(400);
      // the width it was set to (its CSS transition is frozen in hidden tabs)
      const setW = parseFloat(panel.style.width);
      check("picker: a short list shrinks to one column", !panel.querySelector(".pk-list").classList.contains("two") && setW < el.clientWidth * 0.4, { w: Math.round(setW) });
      key("ArrowLeft"); await settle();
      panel.querySelector(".c-popover-head .c-icon-btn, .c-icon-btn")?.click(); await settle(8000);
      check("picker: closing restores the zoom, pan and height exactly", near(nav.span, v0.span, 1e-6) && near(nav.P, v0.P, 1e-6) && near(nav.refX(), v0.x, 0.5) && near(nav.heightZoom, v0.H, 1e-6), { span: nav.span, P: nav.P, z: nav.heightZoom });
      nav.setHeight(1); await settle();
      await reset();
    }
  } finally {
    window.requestAnimationFrame = raf; window.cancelAnimationFrame = caf;
  }
  const failed = results.filter((r) => !r.ok);
  console.table(results.map((r) => ({ ok: r.ok ? "✓" : "✗", name: r.name, detail: JSON.stringify(r.detail) })));
  return { passed: results.length - failed.length, failed: failed.length, results };
}
