export const timeout = 240000; // ~60–90 s of real gestures and glides

// The fan chart's time navigation, every agreed behaviour (next/tests/time-nav-check.js), on real data.
// The run takes longer than one CDP call may, so it is started in the page and its result polled.
export default async function time(page, t) {
  await t.step("time navigation: every agreed behaviour", async () => {
    await page.goto("/next/?date=2026-01-10");
    await page.waitFor(() => window.__viz?.chart?.nav && document.querySelector(".app.is-ready"), { message: "chart ready", timeout: 30000 });
    await page.eval(() => {
      window.__timeNav = null;
      import("/next/tests/time-nav-check.js").then((m) => m.run()).then(
        (o) => { window.__timeNav = { passed: o.passed, failed: o.results.filter((x) => !x.ok).map((x) => `${x.name} ${JSON.stringify(x.detail)}`) }; },
        (e) => { window.__timeNav = { passed: 0, failed: [`error: ${e?.message || e}`] }; });
    });
    await page.waitFor(() => !!window.__timeNav, { message: "the time-navigation run to finish", timeout: 220000, interval: 500 });
    const r = await page.eval(() => window.__timeNav);
    t.eq(r.failed, [], `${r.passed} passed`);
  });
}
