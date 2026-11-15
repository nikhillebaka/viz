// The old model picker (features/ModelPicker.js): filters narrow the list and count what each value would show, the view drawer
// groups and sorts, typed search filters by key, the tray lists the selection, Escape closes a drawer
// before the picker, and nothing logs an error.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export default async function picker(page, t) {
  await t.step("opens", async () => {
    await page.goto("/next/?models=UMass-flusion,UMass-gbqr_4src&date=2026-01-10");
    await page.waitFor(() => !!window.__viz?.chart?.fan, { timeout: 30000, message: "the chart never loaded" });
    // the old picker (the ⋯ menu's "New model picker" off)
    await page.eval(() => { localStorage.removeItem("viz.next.picker"); localStorage.setItem("viz.next.browser", "false"); });
    await page.eval(() => document.querySelector(".app-models").click());
    await page.waitFor(() => document.querySelectorAll(".pk-panel .pk-row").length > 10, { timeout: 10000, message: "no rows" });
    t.eq(await page.count(".pk-tray .pk-tchip"), 2, "the tray lists the two selected");
  });

  await t.step("a filter narrows the list and counts", async () => {
    await page.eval(() => document.querySelector('.pk-fchip[data-drawer="family"]').click());
    await wait(150);
    const n = await page.eval(() => Number(document.querySelector('.pk-drawer [data-v="GBQR"] .pk-n').textContent));
    await page.eval(() => document.querySelector('.pk-drawer [data-v="GBQR"]').click());
    await wait(200);
    const s = await page.eval(() => ({ shown: document.querySelector(".pk-shown").textContent, chip: document.querySelector('.pk-fchip[data-drawer="family"]').textContent }));
    t.ok(new RegExp(`^${n} of `).test(s.shown), `shows what the count said (${n}; ${s.shown})`);
    t.eq(s.chip, "Family · GBQR", "the chip names the filter");
  });

  await t.step("Escape closes the drawer, then Clear filters", async () => {
    await page.key.press("Escape");
    await wait(150);
    t.ok(await page.eval(() => document.querySelector(".pk-drawer").hidden && !!document.querySelector(".pk-panel")), "drawer closed, picker open");
    await page.eval(() => document.querySelector(".pk-fclear").click());
    await wait(150);
    t.eq(await page.eval(() => document.querySelector(".pk-fclear")), null, "no filters left");
  });

  await t.step("group, sort, typed search", async () => {
    await page.eval(() => document.querySelector('.pk-fchip[data-drawer="view"]').click());
    await page.eval(() => document.querySelector('.pk-drawer [data-group="team"]').click());
    await wait(200);
    t.ok(await page.eval(() => !!document.querySelector('.pk-panel .c-section[data-key="team:UMass"]')), "grouped by team");
    t.eq((await page.eval(() => JSON.parse(localStorage.getItem("viz.next.picker")))).group, "team", "the view is kept");
    await page.eval(() => document.querySelector('.pk-drawer [data-group="source"]').click());
    await page.eval(() => { const i = document.querySelector(".pk-panel input"); i.value = "team:cu"; i.dispatchEvent(new Event("input")); });
    await wait(200);
    const ids = await page.eval(() => [...document.querySelectorAll(".pk-row")].map((r) => r.dataset.id));
    t.ok(ids.length > 0 && ids.every((id) => /(^|:)CU-/.test(id)), `team:cu is CU's models (${ids.slice(0, 3).join(", ")})`);
  });

  await t.step("the tray takes a model off", async () => {
    await page.eval(() => document.querySelector('.pk-tray .pk-tchip[data-id="UMass-gbqr_4src"] .pk-tx').click());
    await wait(150);
    t.eq(await page.eval(() => window.__viz.store.get().sel.selected), ["UMass-flusion"], "deselected");
    await page.key.press("Escape");
  });

  await t.step("Select all takes what the list shows; Clear all, everything", async () => {
    await page.eval(() => document.querySelector(".app-models").click());
    await page.waitFor(() => !!document.querySelector(".pk-panel .pk-row"), { timeout: 10000, message: "picker did not reopen" });
    await page.eval(() => { const i = document.querySelector(".pk-panel input"); i.value = "family:gbqr"; i.dispatchEvent(new Event("input")); });
    await wait(200);
    const shown = await page.eval(() => Number(document.querySelector(".pk-shown").textContent.split(" ")[0]));
    const before = await page.eval(() => window.__viz.store.get().sel.selected.length);
    await page.eval(() => document.querySelector(".pk-bulk [data-all]").click());
    await wait(150);
    const sel = await page.eval(() => window.__viz.store.get().sel.selected);
    t.ok(sel.length >= shown && sel.length <= shown + before && sel.filter((id) => /gbqr/i.test(id)).length >= shown, `the ${shown} shown GBQR models selected (${sel.length})`);
    await page.eval(() => document.querySelector(".pk-bulk [data-none]").click());
    await wait(150);
    await page.key.press("Escape");
    t.eq(await page.eval(() => window.__viz.store.get().sel.selected.length), 0, "none left");
    t.ok(await page.eval(() => document.querySelector(".pk-bulk [data-none]").disabled), "Clear all is off with nothing selected");
  });

  await t.step("no console errors", async () => { t.eq(page.errors, [], "uncaught exceptions and console errors"); });

  // the app remembers the selection in the browser: leave none behind for the checks after this one
  await page.eval(() => { localStorage.removeItem("viz.selection"); localStorage.removeItem("viz.next.picker"); localStorage.removeItem("viz.next.browser"); });
}
