// The view sections (heatmap, map, peaks): each mounts when scrolled into view, shows real data from
// the hub (or its one quiet empty line), and nothing logs an error. VIEWS_SHOTS=<dir> saves a
// screenshot of each section for a visual pass.
import { join } from "node:path";

const SECTIONS = [
  // what counts as "shows real data" for each
  { id: "heatmap", ready: () => { const c = document.querySelector("#heatmap .hm-canvas"); return !!c?.getAttribute("aria-label"); } },
  { id: "map", ready: () => document.querySelectorAll("#map .mp-tile.has-value").length > 10 },
  { id: "peaks", ready: () => !!document.querySelector("#peaks .pk-row, #peaks .pk-none:not([hidden]), #peaks .v-empty:not([hidden])") },
];

export default async function views(page, t) {
  await t.step("page boots", async () => {
    await page.goto("/next/");
    await page.waitFor(() => window.__viz?.chart?.fan, { timeout: 20000, message: "the chart never loaded" });
  });

  for (const s of SECTIONS) {
    await t.step(`${s.id} shows real data`, async () => {
      await page.eval((id) => { document.getElementById(id)?.scrollIntoView({ block: "start" }); scrollBy(0, -24); }, s.id);
      await page.waitFor(s.ready, { timeout: 30000, message: `${s.id} never showed data` });
      const state = await page.eval((id) => {
        const el = document.getElementById(id);
        return {
          error: !!el.querySelector(".app-section-error"),
          loading: el.classList.contains("is-loading"),
          empty: el.querySelector(".v-empty:not([hidden])")?.textContent || "",
          title: el.querySelector(".v-title")?.textContent || "",
        };
      }, s.id);
      t.ok(!state.error, `${s.id} mounted`);
      t.ok(state.title.length > 0, `${s.id} has a heading`);
      t.ok(!/can't/i.test(state.empty), `${s.id} loaded (${state.empty})`);
      await page.frames(3);
      if (process.env.VIEWS_SHOTS) await page.screenshot(join(process.env.VIEWS_SHOTS, `views-${s.id}.png`));
    });
  }

  await t.step("heatmap readout and click-through", async () => {
    await page.eval(() => document.getElementById("heatmap").scrollIntoView({ block: "start" }));
    await page.frames(2);
    const pt = await page.eval(() => {
      const c = document.querySelector("#heatmap .hm-canvas"), r = c.getBoundingClientRect();
      return { x: r.left + r.width * 0.6, y: r.top + 51 };
    });
    await page.mouse.move(pt.x, pt.y);
    await page.frames(2);
    const shown = await page.eval(() => !document.querySelector("#heatmap .v-readout")?.hidden);
    t.ok(shown, "hovering a cell shows its readout");
    if (process.env.VIEWS_SHOTS) await page.screenshot(join(process.env.VIEWS_SHOTS, "views-heatmap-hover.png"));
  });

  await t.step("peaks rows: hover shows a readout and the row's box", async () => {
    await page.eval(() => document.getElementById("peaks").scrollIntoView({ block: "start" }));
    await page.frames(2);
    const pt = await page.eval(() => {
      const rows = [...document.querySelectorAll("#peaks .pk-row.is-model")];
      const c = rows.map((r) => r.querySelector(".pk-high")).find(Boolean);
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width * 0.3, y: r.top + r.height / 2, n: rows.length };
    });
    if (!pt) { t.ok(true, "no peak rows this round"); return; }
    await page.mouse.move(pt.x, pt.y);
    await page.frames(2);
    const st = await page.eval(() => ({
      readout: !document.querySelector("#peaks .v-readout")?.hidden,
      hover: !!document.querySelector("#peaks .pk-row.is-hover"),
      aligned: (() => {
        const s = document.querySelector("#peaks .pk-strip").getBoundingClientRect(), w = document.querySelector("#peaks .pk-row .pk-when").getBoundingClientRect();
        return Math.abs(s.right - w.right) < 1;
      })(),
    }));
    t.ok(st.hover, `hovering a row marks it (${pt.n} rows)`);
    t.ok(st.readout, "hovering a strip shows its readout");
    t.ok(st.aligned, "the season strip and the When column end at the same pixel");
    if (process.env.VIEWS_SHOTS) await page.screenshot(join(process.env.VIEWS_SHOTS, "views-peaks-hover.png"));
  });

  await t.step("no console errors", async () => {
    t.eq(page.errors, [], "uncaught exceptions and console errors");
  });
}
