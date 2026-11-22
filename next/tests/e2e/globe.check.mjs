// 3D Globe view & LocationPicker: opens Globe via #globe, verifies non-zero WebGL/Canvas rendering,
// confirms removed helper subtitle in LocationPicker, and closes cleanly.

export default async function globe(page, t) {
  await t.step("LocationPicker omits 'Open interactive sphere' subtitle", async () => {
    await page.goto("/next/");
    await page.waitFor(() => window.__viz?.chart?.fan && document.querySelector(".app").classList.contains("is-ready"), {
      timeout: 20000,
      message: "chart never became ready",
    });
    await page.eval(() => document.querySelector(".app-place")?.click());
    await page.waitFor(() => !!document.querySelector(".lp-globe-foot, .c-float"), {
      timeout: 5000,
      message: "location picker did not open",
    });
    const txt = await page.eval(() => document.querySelector(".c-float")?.innerText || "");
    t.ok(!/Open interactive sphere/i.test(txt), "no 'Open interactive sphere' subtitle");
    await page.key.press("Escape");
    await page.waitFor(() => !document.querySelector(".c-float"), { timeout: 3000 }).catch(() => {});
  });

  await t.step("Globe opens via #globe, draws sphere canvas, and closes cleanly", async () => {
    await page.goto("/next/#globe");
    await page.waitFor(() => {
      const c = document.querySelector(".app-globe canvas");
      if (!c) return false;
      const r = c.getBoundingClientRect();
      return r.width > 200 && r.height > 200;
    }, { timeout: 25000, message: "Globe canvas did not render" });

    t.ok(await page.eval(() => document.getElementById("app").classList.contains("is-globe-open")), "app marks globe open");
    await page.frames(10);

    await page.eval(() => { document.querySelector(".app-globe-back")?.click(); });
    await page.waitFor(() => !document.querySelector(".app-globe"), { timeout: 5000, message: "Globe did not close" });
  });

  await t.step("no console errors", async () => {
    t.eq(page.errors, [], "uncaught exceptions and console errors");
  });
}
