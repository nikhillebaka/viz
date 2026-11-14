/* Regression check for seasons and locations on the fan chart page (studies/seasons-locations-goals.md),
 * studies/intervals-refine.html. Run from the page's console:
 *     (await import("/tests/seasons-check.js")).run()
 * Needs data/fc/ (extract_fc.py). Run time-nav-check.js and scores-check.js too. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => new Date(+d).toISOString().slice(0, 10);

export async function run() {
  const nav = window.__nav, sel = window.__sel, ev = window.__ev, el = document.getElementById("chart");
  if (!nav) throw new Error("open studies/intervals-refine.html first");
  const raf = window.requestAnimationFrame, caf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  const settle = async (ms = 6000) => { const t0 = performance.now(); await sleep(250); while ((nav.raf || nav.moving) && performance.now() - t0 < ms) await sleep(50); await sleep(450); };
  const key = (k) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const date = () => iso(nav.dates[nav.week]);
  const top = () => window.__G.y.domain()[1];
  const scrollWheel = async (n, dx) => { for (let i = 0; i < n; i++) { el.dispatchEvent(new WheelEvent("wheel", { deltaX: dx, bubbles: true, cancelable: true })); await sleep(16); } };
  try {
    scrollTo(0, 0);
    // start in 2025–26, US
    if (document.querySelector("#c-place .label").textContent !== "US") { await window.__setPlace("US"); await settle(); }
    nav.goTo(0); await settle();
    check("starts at the first round of 2025–26", date() === "2025-11-22", { date: date() });
    const top26 = top();

    // ← at the first round crosses into the previous season's last round, as a cut
    const t0 = performance.now(); key("ArrowLeft"); await settle();
    check("← at a season's first round crosses to the previous season's last round", date() === "2025-05-17" && nav.N === 25, { date: date(), N: nav.N, ms: Math.round(performance.now() - t0) });
    check("…the stepper shows the new date and the scores follow the season", document.querySelector("#c-date .c-step-label").getAttribute("aria-label").includes("May 17, 2025") && /2024–25/.test(ev.scopeEl.textContent));
    check("…the axis eased to the new season's maximum (US 2024–25 peaked higher)", top() > top26, { before: top26, after: top() });
    check("…the stepper's next arrow stays enabled (there's a next season)", document.querySelector("#c-date .next").getAttribute("aria-disabled") === "false");
    check("…no copies of the old frame are left behind", document.querySelectorAll("#view > canvas").length === 2, { canvases: document.querySelectorAll("#view > canvas").length });

    // drag and side scroll never cross: at the last round, scroll forward rubber-bands and stays
    const n0 = nav.N; await scrollWheel(20, 60); await settle();
    check("side scroll at a season's end rubber-bands and never crosses", nav.N === n0 && date() === "2025-05-17", { date: date(), N: nav.N });

    // → crosses forward again
    key("ArrowRight"); await settle();
    check("→ at the last round crosses to the next season's first round", date() === "2025-11-22" && nav.N === 28, { date: date() });
    nav.goTo(nav.N - 1); await settle();
    key("ArrowRight"); await settle();
    check("→ at the very last round does nothing (no next season)", date() === iso(nav.dates[nav.N - 1]) && nav.N === 28);
    check("…and the next arrow is disabled", document.querySelector("#c-date .next").getAttribute("aria-disabled") === "true");

    // height zoom resets on a season change; zoom carries over
    nav.goTo(0); await settle();
    nav.setHeight(2); await settle(); nav.zoomTo(8); await settle();
    const span = nav.span;
    key("ArrowLeft"); await settle();
    check("crossing seasons resets the height zoom", Math.abs(nav.heightZoom - 1) < 0.02, { h: nav.heightZoom });
    check("…and keeps the zoom", Math.abs(nav.span - span) < 0.5, { before: span, after: nav.span });
    key("ArrowRight"); await settle(); key("0"); await settle();

    // models missing from a season: one line, not a ghost each
    nav.goTo(0); await settle(); key("ArrowLeft"); await settle(); // 2024–25
    const gone = sel.charted.filter((c) => !window.__data().D.models.includes(c.m)).length;
    const summary = window.__G.labels.find((l) => l.summary);
    check("charted models not in this season collapse into one quiet line", gone ? summary && summary.text.includes(`${gone} not in 2024–25`) : !summary, { gone, summary: summary?.text });
    check("…and none of them gets its own ghost label", !window.__G.labels.some((l) => l.ghost && !l.summary && !window.__data().present.has(l.m)));
    key("ArrowRight"); await settle();

    // the date picker: season chips, then that season's rounds as a calendar; nothing else per date
    document.querySelector("#c-date .c-step-label").click(); await sleep(700);
    const chips = [...document.querySelectorAll(".dp-chip[data-sid]")].map((b) => b.textContent);
    check("the date label opens a picker with a chip per season, newest first", chips.join() === "2025–26,2024–25,2023–24", { chips });
    check("…the chart's season shows as a calendar, a row per month, the chart's round marked", document.querySelectorAll(".dp-row").length >= 6 && document.querySelector(".dp-day.on")?.dataset.r === date(), { on: document.querySelector(".dp-day.on")?.dataset.r });
    check("…with nothing per date but the day", [...document.querySelectorAll(".dp-day")].every((b) => /^\d{1,2}$/.test(b.textContent)));
    { const panel = document.querySelector(".dp-panel"), h0 = panel.offsetHeight, t0 = panel.getBoundingClientRect().top;
      scrollTo(0, 120); dispatchEvent(new Event("scroll")); await sleep(300);
      const h1 = panel.offsetHeight, t1 = panel.getBoundingClientRect().top;
      check("scrolling a little keeps the picker's size and moves it with its button", Math.abs(h1 - h0) < 1 && Math.abs((t0 - t1) - 120) < 4, { h0, h1, moved: Math.round(t0 - t1) });
      scrollTo(0, innerHeight * 1.5); dispatchEvent(new Event("scroll"));
      for (let i = 0; i < 20 && document.querySelector(".dp-panel"); i++) await sleep(100); // removed after its exit animation (timers are slow in a hidden pane)
      check("…and once its button scrolls off screen, it closes", !document.querySelector(".dp-panel"));
      scrollTo(0, 0); await sleep(300); }
    document.querySelector("#c-date .c-step-label").click(); await sleep(700);
    [...document.querySelectorAll(".dp-chip[data-sid]")].find((b) => b.textContent === "2023–24").click(); await sleep(300);
    const day = document.querySelector('.dp-day[data-r="2024-01-13"]');
    check("…a season chip shows that season's calendar", !!day && !document.querySelector(".dp-day.on"));
    day?.click(); await settle();
    check("…and a day goes there, crossing seasons", date() === "2024-01-13" && /2023–24/.test(ev.scopeEl.textContent), { date: date() });

    // a popover's own button closes it (no reopening, no second open animation)
    for (const [name, sel2, panelSel] of [["date", "#c-date .c-step-label", ".dp-panel"], ["location", "#c-place", ".lp-panel"], ["models", "#c-models", ".pk-panel"]]) {
      const v0 = nav.view();
      document.querySelector(sel2).click(); await sleep(700);
      const opened = !!document.querySelector(panelSel);
      document.querySelector(sel2).click();
      for (let i = 0; i < 20 && document.querySelector(panelSel); i++) await sleep(100);
      await settle();
      const v1 = nav.view();
      check(`clicking the ${name} button again closes its popover`, opened && !document.querySelector(panelSel) && document.querySelectorAll(".c-float").length === 0, { opened });
      if (name === "models") check("…and closing the Models picker that way restores the chart's view", Math.abs(v1.Z - v0.Z) < 0.01 && Math.abs(v1.P - v0.P) < 0.05, { v0, v1 });
    }

    // places: search + Enter; the date, zoom and focus stay; the axis rescales
    const d0 = date(), topUS = top();
    document.getElementById("c-place").click(); await sleep(500);
    const input = document.querySelector('input[aria-label="Search locations"]');
    check("the location picker has 52 tiles and a US button", document.querySelectorAll(".lp-tile").length === 52 && !!document.querySelector(".lp-us"));
    input.value = "mass"; input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await settle();
    check("typing and Enter goes to the place", document.querySelector("#c-place .label").textContent === "Massachusetts");
    check("…the date stays", date() === d0, { d0, now: date() });
    check("…and the axis rescales to the place (far smaller than the US)", top() < topUS / 5, { us: topUS, ma: top() });
    await window.__setPlace("US"); await settle();
    check("back to the US", document.querySelector("#c-place .label").textContent === "US" && top() > topUS * 0.5);

    // a heatmap cell in Locations mode sets the chart's place
    ev.setHeatAxis("locations"); await sleep(200);
    const cv = document.querySelector("#scores .ev-heat-canvas"), r = cv.getBoundingClientRect();
    cv.dispatchEvent(new MouseEvent("click", { clientX: r.right - 4, clientY: r.top + 30 + 11, bubbles: true })); await settle();
    check("a Locations heatmap cell moves the chart to that place", document.querySelector("#c-place .label").textContent !== "US");
    ev.setHeatAxis("weeks");
    await window.__setPlace("US"); await settle();
  } finally {
    // leave the page as the other checks expect it: 2025–26, the US, the default date, nothing focused
    scrollTo(0, 0);
    try { if (window.__data().sid !== "2025-26") { window.__goToRound("2025-26", "2025-12-27"); await settle(); } } catch {}
    try { await window.__setPlace("US"); } catch {}
    nav.goTo(Math.max(0, window.__data().D.dates.indexOf("2025-12-27"))); await settle();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    window.requestAnimationFrame = raf; window.cancelAnimationFrame = caf;
  }
  const failed = results.filter((r) => !r.ok);
  console.table(results.map((r) => ({ ok: r.ok ? "✓" : "✗", name: r.name, detail: r.ok ? "" : JSON.stringify(r.detail ?? "") })));
  return { passed: results.length - failed.length, failed: failed.length, results };
}
