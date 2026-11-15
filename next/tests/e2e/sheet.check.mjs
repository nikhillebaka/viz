// The model sheet (features/ModelSheet.js): a link opens it, ↓ steps, Escape closes, leaderboard names
// and the picker's details glyph open it, and rows no longer expand in the table.
export default async function sheet(page, t) {
  await t.step("a #model link opens the sheet with scores and details", async () => {
    await page.goto("/next/?date=2026-01-10#model/UMass-flusion");
    await page.waitFor(() => document.querySelector(".app.is-ready"), { timeout: 30000 });
    await page.waitFor(() => document.querySelector(".ms-sheet .ms-num-row") && document.querySelector(".ms-sheet .sc-detail"), { timeout: 30000, message: "sheet filled" });
    const a = await page.eval(() => ({ title: document.querySelector(".ms-title").textContent, rel: /Rel\. WIS/.test(document.querySelector(".ms-num-row").textContent), about: !!document.querySelector(".ms-about .ms-dl") }));
    t.eq(a.title, "flusion", "title"); t.ok(a.rel, "scores shown"); t.ok(a.about, "about shown");
  });
  await t.step("↓ steps to the next model; Escape closes and clears the link", async () => {
    const before = await page.eval(() => location.hash);
    await page.eval(() => document.querySelector(".ms-sheet .c-float-body").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await page.waitFor((b) => location.hash !== b, { args: [before], timeout: 10000, message: "stepped" });
    await page.eval(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await page.waitFor(() => !document.querySelector(".ms-sheet") && !location.hash, { timeout: 5000, message: "closed" });
  });
  await t.step("a leaderboard name opens it; rows don't expand", async () => {
    await page.eval(() => document.getElementById("scores").scrollIntoView());
    await page.waitFor(() => document.querySelector(".sc-row[data-id] .sc-label"), { timeout: 30000 });
    await page.eval(() => document.querySelector(".sc-row[data-id] .sc-label").click());
    await page.waitFor(() => document.querySelector(".ms-sheet .ms-title"), { timeout: 10000 });
    t.eq(await page.eval(() => document.querySelectorAll(".sc-board .sc-detail").length), 0, "no expanded rows");
    await page.eval(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  });
  await t.step("the picker's details glyph opens an unselected model", async () => {
    await page.eval(() => { window.scrollTo(0, 0); document.querySelector(".app-models").click(); });
    await page.waitFor(() => document.querySelector(".pk-info"), { timeout: 10000 });
    await page.eval(() => [...document.querySelectorAll(".pk-row")].find((r) => !r.querySelector(".pk-name[aria-checked='true']")).querySelector(".pk-info").click());
    await page.waitFor(() => document.querySelector(".ms-sheet .ms-num-row, .ms-sheet .ms-nums .ms-quiet"), { timeout: 60000, message: "scored or explained" });
    t.eq(page.errors, [], "no console errors");
  });
}
