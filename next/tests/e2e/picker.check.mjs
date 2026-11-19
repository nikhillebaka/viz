// The model picker: opens from the Models bubble, the rail filters and
// counts, a variant line opens and its name parts narrow it, the preview follows the pointer, a search
// suggests a filter, Select all / Clear all, and nothing logs an error.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const open = async (page) => {
  await page.eval(() => document.querySelector(".app-models").click());
  await page.waitFor(() => document.querySelectorAll(".mb-panel .pk-row").length > 5, { timeout: 10000, message: "no rows" });
};
export default async function browser(page, t) {
  await t.step("opens", async () => {
    await page.goto("/next/?models=UMass-flusion&date=2026-01-10");
    await page.waitFor(() => !!window.__viz?.chart?.fan, { timeout: 30000, message: "the chart never loaded" });
    await open(page);
    t.ok(await page.count(".mb-rail .mb-opt") > 10, "the rail has sets and filters");
  });

  await t.step("the rail filters and counts", async () => {
    const n = await page.eval(() => Number(document.querySelector('.mb-rail [data-facet="input"][data-v="NSSP ED visits"] .mb-opt-n').textContent));
    await page.eval(() => document.querySelector('.mb-rail [data-facet="input"][data-v="NSSP ED visits"]').click());
    await wait(150);
    t.ok((await page.eval(() => document.querySelector(".mb-shown").textContent)).startsWith(`${n} of`), `shows what the count said (${n})`);
    await page.eval(() => document.querySelector('.mb-rail [data-clear]').click());
    await wait(150);
  });

  await t.step("a line opens; a name part narrows it", async () => {
    await page.eval(() => [...document.querySelectorAll(".mb-line")].find((l) => l.textContent.includes("GBQR")).querySelector(".mb-lhead").click());
    await wait(150);
    const before = await page.eval(() => document.querySelectorAll(".mb-child").length);
    await page.eval(() => document.querySelector(".mb-parts [data-part]").click());
    await wait(150);
    const after = await page.eval(() => document.querySelectorAll(".mb-child").length);
    t.ok(before > 5 && after > 0 && after < before, `variants ${before} → ${after}`);
  });

  await t.step("the preview follows the pointer", async () => {
    await page.eval(() => document.querySelector(".mb-child").dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
    await wait(150);
    t.ok(await page.eval(() => !!document.querySelector(".mb-preview [data-model-sheet]")), "a model's preview with its page link");
  });

  await t.step("a search suggests a filter", async () => {
    await page.eval(() => { const i = document.querySelector(".mb-panel input"); i.value = "nss"; i.dispatchEvent(new Event("input")); });
    await wait(150);
    await page.eval(() => document.querySelector(".mb-sg").click());
    await wait(150);
    const s = await page.eval(() => ({ q: document.querySelector(".mb-panel input").value, on: !!document.querySelector('.mb-rail .mb-opt.on[data-facet="input"]') }));
    t.ok(s.q === "" && s.on, "the word became a Data filter");
    await page.eval(() => document.querySelector('.mb-rail [data-clear]').click());
  });

  await t.step("Select all and Clear all", async () => {
    await page.eval(() => document.querySelector('.mb-rail [data-facet="kind"][data-v="Baseline"]')?.click() || document.querySelector('.mb-rail [data-facet="kind"]').click());
    await wait(150);
    const shown = await page.eval(() => Number(document.querySelector(".mb-shown").textContent.split(" ")[0]));
    await page.eval(() => document.querySelector(".mb-bar [data-all]").click());
    await wait(150);
    t.ok((await page.eval(() => window.__viz.store.get().sel.selected.length)) >= shown, "selected what the list shows");
    await page.eval(() => document.querySelector(".mb-bar [data-none]").click());
    await wait(150);
    t.eq(await page.eval(() => window.__viz.store.get().sel.selected.length), 0, "none left");
    await page.key.press("Escape");
  });

  await t.step("no console errors", async () => { t.eq(page.errors, [], "uncaught exceptions and console errors"); });
  await page.eval(() => {
    localStorage.removeItem("viz.selection");
    for (const k of Object.keys(localStorage)) {
      if (/^viz\.h\..+\.selection$/.test(k)) localStorage.removeItem(k);
    }
  });
}
