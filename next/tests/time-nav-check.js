/* Regression check for the fan chart's time navigation in next/ (chart/timenav.js + features/FanChart.js).
 * Every behaviour agreed in design/studies/time-navigation.md has a case here (ported from
 * design/tests/time-nav-check.js), plus what next/ added: crossing seasons by a pull, folding models and
 * proximity hover. Run it from the page's console on /next/ in a desktop-sized window:
 *     (await import("/next/tests/time-nav-check.js")).run()
 * or headless with `node next/tests/e2e/run.mjs --base http://127.0.0.1:8610 time`.
 * It drives the page with synthetic wheel, pointer and key events and returns { passed, failed, results }.
 * Things only a real hand can judge (smoothness, feel) are not covered. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const WEEK = 7 * 864e5;

export async function run() {
  const V = window.__viz, chart = V?.chart, nav = chart?.nav, el = document.querySelector(".fc-canvas");
  if (!nav || !el) throw new Error("open /next/ first");
  if (innerWidth < 1200) console.warn(`time-nav-check: window is ${innerWidth}px wide; the scroll-speed cases expect about 1280 or more`);
  // a hidden tab throttles animation frames; the checks need them to run
  const raf = window.requestAnimationFrame, caf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);

  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  const N = () => chart.nav; // the same TimeNav across seasons (setTimeline swaps its dates)
  const S = () => chart.scene;
  const settle = async (ms = 10000) => {
    const t0 = performance.now(); await sleep(250);
    while ((N().raf || N().moving || chart.loading) && performance.now() - t0 < ms) await sleep(50);
    chart.draw(true);
  };
  const key = (k) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const wheel = async (n, o) => { for (let i = 0; i < n; i++) { el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...o })); await sleep(16); } };
  const pinch = (n, dy) => wheel(n, { deltaY: dy, ctrlKey: true });
  const pan = (n, dx) => wheel(n, { deltaX: dx, metaKey: true });
  const scroll = (n, dx) => wheel(n, { deltaX: dx });
  const mid = () => { const [a, b] = N().domain(); return (a + b) / 2; };
  let id = 100;
  const drag = async (dx, steps = 10, metaKey = false) => {
    const r = el.getBoundingClientRect(), x0 = r.left + r.width * 0.45, y = r.top + r.height * 0.6, p = ++id;
    el.dispatchEvent(new PointerEvent("pointerdown", { clientX: x0, clientY: y, pointerId: p, button: 0, bubbles: true, pointerType: "mouse", metaKey }));
    for (let i = 1; i <= steps; i++) { el.dispatchEvent(new PointerEvent("pointermove", { clientX: x0 + (dx * i) / steps, clientY: y, pointerId: p, bubbles: true, pointerType: "mouse" })); await sleep(16); }
    await sleep(200); // let go after stopping, so there's no flick
    el.dispatchEvent(new PointerEvent("pointerup", { clientX: x0 + dx, clientY: y, pointerId: p, button: 0, bubbles: true, pointerType: "mouse" }));
  };
  const pxw = () => { const [r0, r1] = N().scale().range(); return (r1 - r0) / N().span; };
  const setRulers = async (on) => { V.store.set({ rulers: on }); await sleep(450); chart.draw(true); };

  // a mid-season round with room on both sides, in the season the page opened on
  const start = { date: V.store.get().date };
  const home = () => Math.min(N().N - 6, Math.max(5, Math.round(N().N / 2)));
  const reset = async () => {
    if (V.store.get().date.slice(0, 4) !== start.date.slice(0, 4) && chart.fan.season !== V.manifest.seasonOf(start.date)) { chart.goTo(start.date); await settle(); }
    key("0"); await settle(); N().goTo(home(), { recenter: true }); await settle();
  };
  try {
    await setRulers(false);
    await reset();
    // --- date: keys, stepper, glide
    { const T0 = N().T, seen = []; key("ArrowRight"); for (let i = 0; i < 40; i++) { seen.push(N().T); await sleep(8); } await settle(400);
      const back = seen.some((v, i) => i && v < seen[i - 1] - 1e-9);
      check("arrow: one round, exact landing, never backwards", N().T > T0 && Number.isInteger(N().T) && !back, { T: N().T, back }); }
    { const T0 = N().T; for (let i = 0; i < 3; i++) { key("ArrowRight"); await sleep(45); } await settle();
      check("three quick presses: three rounds on", N().T >= T0 + 3 && Number.isInteger(N().T), { T: N().T, from: T0 }); }
    { const stepLabel = document.querySelector(".c-step-label")?.getAttribute("aria-label") ?? document.querySelector(".fc-stepper")?.textContent ?? "";
      const d = new Date(chart.fan.dates[N().week]);
      check("the stepper names the round the chart is on", stepLabel.includes(String(d.getUTCDate())), { stepLabel, round: d.toISOString().slice(0, 10) }); }
    await reset();
    // --- side scroll scrub speed
    for (const [label, span, lo, hi] of [["home span", 11, 0.7, 1.1], ["20 weeks", 20, 0.9, 1.5], ["full season", 1e9, 0.8, 1.5]]) {
      N().zoomTo(span); await settle(); const T0 = N().T; await scroll(10, 10); const moved = N().T - T0; await settle();
      check(`side scroll at ${label}: 100px ≈ a week`, moved >= lo && moved <= hi, { moved: +moved.toFixed(2) });
      N().goTo(home(), { recenter: true }); await settle();
    }
    await reset();
    // --- a trackpad flick: it snaps during the coast's tail, not after it, and the tail can't move it
    { const T0 = N().T, seq = [...Array(8).fill(24), ...Array.from({ length: 30 }, (_, k) => 24 * 0.8 ** (k + 1))];
      let snappedAt = -1, landed = null;
      for (let i = 0; i < seq.length; i++) {
        el.dispatchEvent(new WheelEvent("wheel", { deltaX: seq[i], bubbles: true, cancelable: true })); await sleep(16);
        if (snappedAt < 0 && !N().busy && i > 8) { snappedAt = i; landed = N().week; }
      }
      await settle();
      check("trackpad flick: snaps while the coast is still tailing off, and the tail doesn't move it", snappedAt > 0 && snappedAt < seq.length - 5 && N().T === landed && N().T > T0, { snappedAt, of: seq.length, T: N().T, landed }); }
    await reset();
    // --- zoom
    await pinch(12, 8); await settle(); const rest = N().span;
    check("pinch out a little: rests between 20 weeks and the season", rest > 20 && rest < N().seasonSpan - 1, { span: +rest.toFixed(1) });
    await pinch(40, 10); await settle();
    check("pinch far out: hard stop at the season", near(N().span, N().seasonSpan, 0.01), { span: +N().span.toFixed(1) });
    await pinch(60, -10); await settle(1200);
    check("pinch far in: springs back to 6 weeks", near(N().span, 6, 0.01), { span: +N().span.toFixed(2) });
    await reset();
    // --- pan works at every zoom short of the full season
    for (const span of [8, 11, 20, 30]) {
      N().zoomTo(span); await settle(); const m0 = mid(), T0 = N().T; await pan(5, -20); await settle();
      const moved = (mid() - m0) / WEEK;
      check(`⌘ pan at ${span} weeks moves the view, not the date`, moved < -0.3 && N().T === T0, { weeks: +moved.toFixed(2), T: N().T });
      N().recenter(); await settle();
    }
    N().zoomTo(1e9); await settle(); { const m0 = mid(); await pan(5, -20); await settle();
      check("⌘ pan at the full season: nothing to pan", near(mid(), m0, 864e5), {}); }
    await reset();
    // --- pan is kept while the forecast is on screen
    await pan(5, -15); await settle(); { const vis = N().refVisible(), x0 = N().refX(), T0 = N().T; await scroll(4, 30); await settle(); key("ArrowRight"); await settle();
      check("after a small pan (whole fan still on screen), scroll and keys change the date and leave the reference line put", vis && N().T > T0 && near(N().refX(), x0, 1.5), { vis, dx: +(N().refX() - x0).toFixed(1), T: N().T }); }
    await reset();
    // --- off-screen: plain scroll pans home first, from either side, then scrubs; the recenter pill shows
    for (const [side, dir] of [["future (forecast off the left)", 1], ["past (forecast off the right)", -1]]) {
      await pan(40, 30 * dir); await settle(); const off = !N().refVisible(), T0 = N().T;
      const pill = document.querySelector(".fc-recenter.is-shown");
      const pillText = pill?.textContent.trim() ?? "", arrow = !!pill?.querySelector(".fc-recenter-arrow:not([hidden]) svg");
      await scroll(30, -30 * dir); await settle(); const midway = { P: N().P, T: N().T };
      await scroll(40, -30 * dir); await settle();
      check(`panned into the ${side}: the recenter pill shows with its arrow`, off && /forecast/.test(pillText) && arrow, { pillText, arrow });
      check(`panned into the ${side}: plain scroll pans home, then scrubs`, off && midway.T === T0 && Math.abs(midway.P) > 0.5 && N().P === 0 && N().T !== T0, { midway, end: { P: N().P, T: N().T } });
      await reset();
    }
    await pan(40, 30); await settle(); key("ArrowRight"); await settle();
    check("arrow with the forecast off-screen brings it home", N().P === 0 && N().refVisible(), { P: N().P });
    await reset();
    // --- zoom while panned keeps the middle still
    await pan(6, -25); await settle(); { const m0 = mid(); await pinch(6, 6); await settle();
      check("zoom while panned keeps the middle still", near(mid(), m0, 864e5 * 1.5), { driftDays: +((mid() - m0) / 864e5).toFixed(1) }); }
    await reset();
    // --- reset and double-click
    await pinch(10, 8); await pan(5, -20); await settle(); key("0"); await settle();
    check("0 returns to 11 weeks, unpanned", near(N().span, 11, 0.01) && N().P === 0, { span: N().span, P: N().P });
    N().setHeight(2.5); await settle();
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await settle();
    const full = near(N().span, N().seasonSpan, 0.01) && near(N().heightZoom, 1, 1e-6);
    N().setHeight(2.5); await settle();
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await settle();
    check("double-click: fully out, then back home, at normal height both times", full && near(N().span, 11, 0.01) && near(N().heightZoom, 1, 1e-6), { span: N().span, z: N().heightZoom });
    await reset();
    // --- drag
    { const T0 = N().T, w = pxw(); await drag(-w); await settle();
      check("drag close up: one week-width left = one week later (1:1)", N().T === T0 + 1, { T: N().T }); }
    for (const span of [11, 30]) { // ⌘ + drag pans like ⌘ + side scroll: content follows the pointer, date stays
      N().zoomTo(span); await settle(); const m0 = mid(), T0 = N().T, w = pxw(); await drag(w * 2, 10, true); await settle();
      const moved = (mid() - m0) / WEEK;
      check(`⌘ + drag at ${span} weeks pans 1:1, date unchanged`, near(moved, -2, 0.15) && N().T === T0, { weeks: +moved.toFixed(2), T: N().T });
      N().recenter(); await settle();
    }
    N().zoomTo(1e9); await settle(); { const T0 = N().T; await drag(150); await settle();
      check("drag at the full season: the forecast follows the pointer (right = later)", N().T > T0, { T: N().T }); }
    await reset();
    // --- height zoom: shift + scroll / shift + vertical drag, independent of date, zoom and pan
    { const top0 = S().y.domain()[1];
      check("the y-axis at normal height is a round number", +top0.toPrecision(2) === top0, { top: top0 });
      const before = { T: N().T, span: N().span, P: N().P };
      await wheel(8, { deltaY: -10, shiftKey: true }); await settle();
      const z1 = N().heightZoom, same = N().T === before.T && near(N().span, before.span, 1e-9) && near(N().P, before.P, 1e-9);
      check("shift + scroll up stretches height only (date, zoom and pan unchanged)", z1 > 1.5 && same, { z: +z1.toFixed(2), same });
      check("…and the y-axis maximum shrinks by the same factor", near(S().y.domain()[1], top0 / z1, top0 * 0.01), { top: Math.round(S().y.domain()[1]), expect: Math.round(top0 / z1) });
      check("…and its gridlines stay at round values", S().ticks.every((d) => +d.v.toPrecision(2) === d.v), { ticks: S().ticks.map((d) => d.v) });
      key("ArrowRight"); await settle();
      check("changing the date keeps the height zoom", near(N().heightZoom, z1, 1e-6), { z: +N().heightZoom.toFixed(2) });
      await wheel(80, { deltaY: 25, shiftKey: true }); await settle();
      check("height zoom stops at 1/3 (springs back from past it)", near(N().heightZoom, 1 / 3, 1e-3), { z: +N().heightZoom.toFixed(3) });
      await wheel(120, { deltaY: -25, shiftKey: true }); await settle();
      check("height zoom stops at ~6.7×", near(N().heightZoom, 1 / 0.15, 1e-2), { z: +N().heightZoom.toFixed(2) });
      key("0"); await settle();
      check("0 resets height", near(N().heightZoom, 1, 1e-6), { z: N().heightZoom });
      const r = el.getBoundingClientRect(), x0 = r.left + r.width * 0.45, y0 = r.top + r.height * 0.6, p = ++id;
      el.dispatchEvent(new PointerEvent("pointerdown", { clientX: x0, clientY: y0, pointerId: p, button: 0, bubbles: true, pointerType: "mouse", shiftKey: true }));
      for (let i = 1; i <= 10; i++) { el.dispatchEvent(new PointerEvent("pointermove", { clientX: x0, clientY: y0 - i * 10, pointerId: p, bubbles: true, pointerType: "mouse", shiftKey: true })); await sleep(16); }
      el.dispatchEvent(new PointerEvent("pointerup", { clientX: x0, clientY: y0 - 100, pointerId: p, button: 0, bubbles: true, pointerType: "mouse" }));
      await settle();
      check("shift + drag up stretches height, date unchanged", N().heightZoom > 1.5 && N().T === Math.round(N().T), { z: +N().heightZoom.toFixed(2) });
      key("0"); await settle(); }
    await reset();
    // --- focus: clicking a label focuses that model, and every frame still draws while focused
    { const l = S().labels.find((d) => d.id && d.hit), r = el.getBoundingClientRect(), cx = r.left + l.x + 20, cy = r.top + l.y, p = ++id;
      el.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, pointerId: p, button: 0, bubbles: true, pointerType: "mouse" }));
      el.dispatchEvent(new PointerEvent("pointerup", { clientX: cx, clientY: cy, pointerId: p, button: 0, bubbles: true, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("click", { clientX: cx, clientY: cy, bubbles: true }));
      await sleep(50); chart.draw(true);
      const focused = S().focus === l.id;
      key("ArrowRight"); await settle(); const stillDrawing = S().focus === l.id && S().di === N().week;
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await settle();
      check("clicking a label focuses it; focused frames keep drawing; Escape clears", focused && stillDrawing && S().focus == null, { focused, stillDrawing }); }
    await reset();
    // --- width rulers
    { const d0 = N().domain(), x0 = N().refX();
      await setRulers(true);
      const d1 = N().domain();
      check("rulers: toggling them doesn't rescale or move the chart", d0[0] === d1[0] && d0[1] === d1[1] && near(N().refX(), x0, 0.5), {}); }
    for (const span of [8, 11, 20, 30, 1e9]) {
      N().zoomTo(span); await settle(); const R = S().rulers;
      check(`rulers show at ${span > 100 ? "the full season" : span + " weeks"}`, !!R && R.rows.length >= 2, { bars: R?.rows.length ?? 0 });
    }
    await reset();
    { const offs = []; key("ArrowRight");
      for (let i = 0; i < 25; i++) { chart.draw(true); const G = S(); if (G?.rulers && G.dates) offs.push(G.rulers.labelX - G.dates.ref.x); await sleep(12); }
      await settle(); const spread = Math.max(...offs) - Math.min(...offs);
      check("rulers move with the fan during a glide", offs.length > 5 && spread < 2, { frames: offs.length, spread: +spread.toFixed(2) }); }
    await pan(5, -15); await settle();
    check("rulers stay beside the fan when panned", !!S().rulers && near(S().rulers.labelX - N().scale()(N().ref), 3 * pxw() + 14, 2), {});
    await reset();
    { const xs = S().rulers.rows.map((r) => r.x), lx = Math.min(...S().labels.filter((d) => !d.summary).map((d) => d.x));
      check("model labels sit clear of the rulers", lx > Math.max(...xs) + 4, { lastRuler: Math.round(Math.max(...xs)), labels: Math.round(lx) }); }
    await setRulers(false); await reset();

    // --- proximity hover: empty paper reads nothing; the observed line does
    { const ia = chart.interact, r = el.getBoundingClientRect(), s = S();
      const at = async (x, y) => { el.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerType: "mouse" })); await sleep(40); return ia.hoverT; };
      const emptyT = await at(s.pad.l + 30, s.pad.t + 6);
      const o = s.observed.known[0] || s.observed.all[0], i = Math.max(0, (o.length >> 1) - 4) * 2;
      const lineT = await at(o[i], o[i + 1]);
      el.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, pointerType: "mouse" })); await sleep(40);
      check("hover: empty paper shows nothing; on the observed line it reads that week", emptyT == null && lineT != null, { emptyT, lineT }); }

    // --- crossing seasons by a pull (and only by a pull)
    const before = chart.fan.season, prev = chart.neighbour(-1);
    if (prev) {
      // a flick from a few rounds in, hard enough to reach the start and keep going
      N().goTo(Math.min(3, N().N - 1), { recenter: true }); await settle();
      await scroll(25, -40); await settle();
      check("a scroll that reaches the season's start stops there (it never carries into the last season)", chart.fan.season === before && N().T === 0, { season: chart.fan.season, T: N().T });
      for (let i = 0; i < 10; i++) { el.dispatchEvent(new WheelEvent("wheel", { deltaX: -12, bubbles: true, cancelable: true })); await sleep(16); }
      chart.draw(true);
      const hint = document.querySelector(".fc-cross"), hintOn = hint.classList.contains("is-shown") && hint.textContent.includes(prev.label);
      for (let i = 0; i < 8; i++) { el.dispatchEvent(new WheelEvent("wheel", { deltaX: -12, bubbles: true, cancelable: true })); await sleep(16); }
      await settle(); await sleep(400); await settle();
      check("a pull that starts at the start shows the last season's name, and crosses into it when let go", hintOn && chart.fan.season === prev.id && N().T === N().N - 1, { hintOn, season: chart.fan.season, T: N().T });
      key("ArrowRight"); await settle(); await sleep(300); await settle();
      check("→ at the last round crosses back", chart.fan.season === before, { season: chart.fan.season });
    }
    await reset();

    // --- the model picker keeps the arrow keys and restores the view exactly on close
    const pill = document.querySelector(".app-models");
    if (pill) {
      N().zoomTo(8); await settle(); await pan(4, -15); await settle(); N().setHeight(2); await settle();
      const v0 = { span: N().span, P: N().P, x: N().refX(), H: N().heightZoom };
      pill.click(); await sleep(600); await settle(8000);
      const open = !!document.querySelector(".c-float");
      const T0 = N().T; key("ArrowRight"); await settle();
      check("picker: left/right still step the date while it's open", open && N().T > T0, { open, T: N().T });
      key("ArrowLeft"); await settle();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(600); await settle(8000);
      check("picker: closing restores the zoom, pan and height exactly", near(N().span, v0.span, 1e-6) && near(N().P, v0.P, 1e-6) && near(N().refX(), v0.x, 0.5) && near(N().heightZoom, v0.H, 1e-6), { span: N().span, P: N().P, z: N().heightZoom });
      N().setHeight(1); await settle();
    }
  } finally {
    window.requestAnimationFrame = raf; window.cancelAnimationFrame = caf;
  }
  const failed = results.filter((r) => !r.ok);
  console.table(results.map((r) => ({ ok: r.ok ? "✓" : "✗", name: r.name, detail: JSON.stringify(r.detail) })));
  return { passed: results.length - failed.length, failed: failed.length, results };
}
