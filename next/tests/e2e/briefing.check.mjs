// Place-First Live Briefings: loads KPIs, outlook fan SVG, sub-regions, surveillance & clades,
// tests Open in Chart handoff, and checks Europe/Poland briefing when RespiCast is connected.

export default async function briefing(page, t) {
  await t.step("US briefing renders cleanly without boilerplate", async () => {
    const { status } = await page.goto("/next/#briefing/US");
    t.eq(status, 200, "document status");
    await page.waitFor(() => {
      const h1 = document.querySelector(".br-page .br-h1")?.textContent?.trim() || "";
      return h1 && h1 !== "Loading…" && h1 !== "No synced forecast hubs";
    }, { timeout: 25000, message: "US briefing never rendered" });

    const info = await page.eval(() => {
      const text = document.querySelector(".br-page")?.innerText || "";
      const kpis = document.querySelectorAll(".br-kpi").length;
      const svgs = document.querySelectorAll(".br-page svg").length;
      const openChartBtn = [...document.querySelectorAll(".br-page button")].some((b) => b.textContent.includes("Open in Chart"));
      const openScoresBtn = [...document.querySelectorAll(".br-page button")].some((b) => b.textContent.includes("Scores"));
      return { text, kpis, svgs, openChartBtn, openScoresBtn };
    });

    t.ok(info.kpis >= 1 && info.kpis <= 4, `KPI strip balanced (1..4, got ${info.kpis})`);
    t.ok(info.svgs >= 1, `at least 1 outlook/variant SVG rendered (${info.svgs})`);
    t.ok(info.openChartBtn && info.openScoresBtn, "Open in Chart and Scores buttons present");
    t.ok(!/Epidemiological Briefing/i.test(info.text), "no 'Epidemiological Briefing' kicker");
    t.ok(!/Reporting week\s*·/i.test(info.text), "no 'Reporting week ·' prefix");
    t.ok(!/Local Forecast Calibration/i.test(info.text), "no Local Forecast Calibration section");
  });

  await t.step("Open in Chart hands off from Briefing to workbench", async () => {
    await page.eval(() => {
      const btn = [...document.querySelectorAll(".br-page .br-head-meta button")].find((b) => b.textContent.includes("Open in Chart"));
      btn?.click();
    });
    await page.waitFor(() => !document.querySelector(".app-briefing") && !!window.__viz?.chart?.fan, {
      timeout: 20000,
      message: "handoff to fan chart failed",
    });
    const loc = await page.eval(() => window.__viz.store.get().location);
    t.ok(typeof loc === "string" && loc.length > 0, `active location set (${loc})`);
  });

  await t.step("European briefing (Poland) renders cleanly when connected", async () => {
    const hasPl = await page.eval(async () => {
      const r = await fetch("/api/next/catalog");
      const j = await r.json();
      return !!j?.places?.PL;
    });
    if (!hasPl) {
      t.ok(true, "PL not in single-hub catalog; skipped European check");
      return;
    }
    await page.goto("/next/#briefing/PL");
    await page.waitFor(() => {
      const h1 = document.querySelector(".br-page .br-h1")?.textContent?.trim() || "";
      return h1 === "Poland";
    }, { timeout: 25000, message: "Poland briefing never rendered" });
    const st = await page.eval(() => ({
      h1: document.querySelector(".br-page .br-h1")?.textContent?.trim(),
      peerTables: document.querySelectorAll('.br-section[aria-label="By State"], .br-section[aria-label="Sub-regions"]').length,
      tabs: [...document.querySelectorAll('.br-page .br-section[aria-label="Forecast outlook"] .br-tab')].map((b) => b.textContent.trim()),
    }));
    t.eq(st.h1, "Poland", "Poland masthead");
    t.eq(st.peerTables, 0, "no neighbor country peer table on Poland");
    t.ok(st.tabs.length <= 2, `clean deduped tabs (${st.tabs.join(", ")})`);
  });

  await t.step("no console errors", async () => {
    t.eq(page.errors, [], "uncaught exceptions and console errors");
  });
}
