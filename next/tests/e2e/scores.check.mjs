// Scores: the section mounts when scrolled to, ranks real models from /api/next/metrics with the baseline at
// 1.00, sorts, expands a row into its detail, opens the Dates popover, and logs no errors.
// SCORES_SHOTS=<dir> saves screenshots for a visual pass.
import { join } from "node:path";

const shot = (page, name) => (process.env.SCORES_SHOTS ? page.screenshot(join(process.env.SCORES_SHOTS, `scores-${name}.png`)) : null);
const ready = () => { const s = document.querySelector("#scores .sc"); return !!s && !s.classList.contains("is-loading") && document.querySelectorAll("#scores .sc-row[data-id]").length > 0; };

export default async function scores(page, t) {
  await t.step("page boots", async () => {
    await page.goto("/next/?models=UMass-flusion,UMass-gbqr_4src,UMass-AR2_nssp&date=2026-01-10");
    await page.waitFor(() => window.__viz?.chart?.fan, { timeout: 20000, message: "the chart never loaded" });
  });

  await t.step("shows ranked rows from real data", async () => {
    await page.eval(() => { document.getElementById("scores").scrollIntoView({ block: "start" }); scrollBy(0, -24); });
    await page.waitFor(ready, { timeout: 30000, message: "no leaderboard rows" });
    const s = await page.eval(() => ({
      scope: document.querySelector("#scores .sc-scope").textContent,
      ranked: [...document.querySelectorAll("#scores .sc-row[data-id]:not(.is-off)")].map((r) => r.dataset.id),
      base: document.querySelector("#scores .sc-row.is-base .sc-relnum")?.textContent,
      error: !!document.querySelector("#scores .app-section-error"),
      figs: document.querySelectorAll("#scores .sc-series").length,
    }));
    t.ok(!s.error, "mounted");
    t.ok(/2025–26/.test(s.scope), `scope follows the chart's season (${s.scope})`);
    t.ok(s.ranked.length >= 3, `ranked rows (${s.ranked.join(", ")})`);
    t.eq(s.base, "1.00", "baseline row at 1.00");
    t.ok(s.figs > 0, "figures drawn");
    await page.frames(3);
    await shot(page, "board");
  });

  await t.step("sorts by a header", async () => {
    await page.eval(() => [...document.querySelectorAll("#scores .sc-head")].find((b) => b.textContent.startsWith("WIS")).click());
    await page.frames(2);
    const st = await page.eval(() => window.__viz.store.get().scores);
    t.eq(st?.sort, "wis", "sort stored");
    await page.waitFor(() => /sort=wis/.test(location.search), { timeout: 2000, message: "sort not in the URL" });
  });

  await t.step("expands a row", async () => {
    await page.eval(() => document.querySelector("#scores .sc-row[data-id]:not(.is-base):not(.is-off) .sc-label").click());
    await page.waitFor(() => document.querySelectorAll("#scores .sc-detail .sc-tile").length > 40, { timeout: 20000, message: "no location tiles" });
    await page.waitFor(() => document.querySelectorAll("#scores .sc-detail .sc-tick-mark").length > 5, { timeout: 20000, message: "no submission ticks" });
    await page.eval(() => document.querySelector("#scores .sc-detail").scrollIntoView({ block: "center" }));
    await page.frames(3);
    await shot(page, "detail");
  });

  await t.step("Dates popover", async () => {
    await page.eval(() => { document.getElementById("scores").scrollIntoView({ block: "start" }); scrollBy(0, -200); });
    await page.frames(2);
    await page.eval(() => document.querySelector("#scores [data-frag=dates]").click());
    await page.waitFor(() => !!document.querySelector(".sc-dates .sc-curve"), { timeout: 15000, message: "no season curves" });
    await page.frames(3);
    await shot(page, "dates");
    const chips = await page.count(".sc-dates .c-chip");
    t.ok(chips >= 4, `season and phase chips (${chips})`);
    await page.key.press("Escape");
    await page.frames(2);
  });

  await t.step("no console errors", async () => {
    t.eq(page.errors, [], "uncaught exceptions and console errors");
  });
}
