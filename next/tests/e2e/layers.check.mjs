// Layers on the fan chart: each one turned on through the store draws something, the pill counts them,
// the menu lists what exists here, the readout gets rows, and nothing logs an error.

const IDS = ["asof", "seasons", "peaks", "nssp", "ili", "flusurv"];

export default async function layers(page, t) {
  const settle = () => page.waitFor(() => window.__viz?.chart?.idle(), { timeout: 15000, message: "chart idle" });

  await t.step("loads on the US, flu admissions, no layers", async () => {
    await page.goto("/next/?loc=US&target=wk%20inc%20flu%20hosp&date=2026-01-10");
    await page.eval(() => localStorage.removeItem("viz.layers"));
    await page.waitFor(() => !!window.__viz?.chart?.layers, { timeout: 15000, message: "layers mounted" });
    await page.eval(() => window.__viz.store.set({ layers: [] }));
    await settle();
    t.eq(await page.eval(() => !!window.__viz.chart.scene.layers), false, "nothing drawn with no layers");
    t.eq(await page.text(".fc-layers .c-pill-label"), "Layers", "pill label");
  });

  for (const id of IDS) {
    await t.step(`${id} draws`, async () => {
      await page.eval((id) => window.__viz.store.set({ layers: [id] }), id);
      await settle();
      await page.frames(2);
      const r = await page.eval(() => {
        const L = window.__viz.chart.scene.layers;
        return L ? { lines: L.lines.length, marks: L.marks.length, labels: L.labels.length } : null;
      });
      t.ok(r && r.lines + r.marks > 0, `${id}: ${JSON.stringify(r)}`);
      t.eq(await page.text(".fc-layers .c-pill-label"), "1 layer", "pill counts it");
    });
  }

  await t.step("all on: readout rows, URL, storage", async () => {
    await page.eval((ids) => window.__viz.store.set({ layers: ids }), IDS);
    await settle();
    const rows = await page.eval(() => {
      const c = window.__viz.chart, s = c.scene;
      return c.layers.rows(s.cutoff - 7 * 864e5, s, (v) => String(v)).map((r) => r.name);
    });
    t.ok(rows.includes("As reported") && rows.includes("ILINet"), `rows ${JSON.stringify(rows)}`);
    await page.sleep(300);
    t.ok((await page.eval(() => location.search)).includes("lay=asof,seasons,peaks,nssp,ili,flusurv"), "URL has lay=");
    t.eq(await page.eval(() => JSON.parse(localStorage.getItem("viz.layers"))), IDS, "stored");
  });

  await t.step("menu lists the layers", async () => {
    await page.eval(() => document.querySelector(".fc-layers").click());
    await page.waitFor(() => document.querySelector(".c-menu"), { message: "menu open" });
    const items = await page.eval(() => [...document.querySelectorAll(".c-menu [role=menuitemcheckbox]")].map((b) => [b.textContent.trim(), b.getAttribute("aria-checked")]));
    t.eq(items.length, 6, `items ${JSON.stringify(items)}`);
    t.ok(items.every(([, c]) => c === "true"), "all checked");
    await page.key.press("Escape");
  });

  await t.step("a scrub with layers on, then off again", async () => {
    await page.eval(() => window.__viz.chart.step(-1));
    await settle();
    t.ok(await page.eval(() => !!window.__viz.chart.scene.layers), "still drawn after a step");
    await page.eval(() => window.__viz.store.set({ layers: [] }));
    await settle();
    t.eq(await page.eval(() => !!window.__viz.chart.scene.layers), false, "gone");
    // sections below the chart are other lanes' work in progress; their load errors aren't this check's
    t.eq(page.errors.filter((e) => !/section could not load/.test(e)), [], "no console errors");
  });
}
