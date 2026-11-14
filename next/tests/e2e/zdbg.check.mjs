const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export default async function zdbg(page, t) {
  await t.step("dbg", async () => {
    await page.goto("/next/");
    await page.eval(() => localStorage.setItem("viz.heatmap", JSON.stringify({ rows: "model", cols: "location", metric: "relwis" })));
    await page.goto("/next/");
    await page.waitFor(() => window.__viz?.chart?.fan, { timeout: 20000 });
    await page.eval(() => { document.getElementById("heatmap").scrollIntoView(); scrollBy(0,-20); });
    await sleep(5000);
    await page.screenshot("/private/tmp/claude-501/-Users-nikhillebaka-Github-forecast-sandbox-2025-2026-viz--claude-worktrees-data-viz-redesign-review-f3697d/4ae09eef-283e-463c-ad04-4ceba699db7c/scratchpad/h1.png");
    await page.eval(() => window.__viz.store.set({ target: "wk inc flu prop ed visits" }));
    await sleep(5000);
    await page.screenshot("/private/tmp/claude-501/-Users-nikhillebaka-Github-forecast-sandbox-2025-2026-viz--claude-worktrees-data-viz-redesign-review-f3697d/4ae09eef-283e-463c-ad04-4ceba699db7c/scratchpad/h2.png");
    await page.eval(() => { document.getElementById("map").scrollIntoView(); scrollBy(0,-20); });
    await sleep(4000);
    await page.screenshot("/private/tmp/claude-501/-Users-nikhillebaka-Github-forecast-sandbox-2025-2026-viz--claude-worktrees-data-viz-redesign-review-f3697d/4ae09eef-283e-463c-ad04-4ceba699db7c/scratchpad/h3.png");
    console.log(await page.eval(() => [document.querySelector("#peaks")?.innerText.slice(0,200)]));
    console.log(page.errors);
    await page.eval(() => localStorage.removeItem("viz.heatmap"));
  });
}
