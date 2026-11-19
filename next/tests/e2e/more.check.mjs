// The ⋯ bubble: its menu opens, each panel opens with real data, the Guide opens, searches and deep-links
// (#guide/<topic>), there is no presentation mode, Combine opens
// from the model picker with a preview. Read-only against the hub: nothing is synced, added, removed,
// created or deleted (only GET endpoints and /api/ensemble/preview are called).
// Screenshots go to $SHOTS when set.

const shots = process.env.SHOTS;
const shot = (page, name) => (shots ? page.screenshot(`${shots}/more-${name}.png`) : null);

async function menuItem(page, label) {
  const r = await page.rect(".app-more");
  await page.mouse.click(r.cx, r.cy);
  await page.waitFor(() => !!document.querySelector(".c-menu"), { message: "menu opens" });
  await page.frames(2);
  const labels = await page.eval(() => [...document.querySelectorAll(".c-menu .c-menu-label")].map((n) => n.textContent));
  if (label) {
    await page.eval((l) => [...document.querySelectorAll(".c-menu .c-menu-item")].find((b) => b.textContent.startsWith(l))?.click(), label);
  }
  return labels;
}

async function closeLayer(page) {
  await page.key.press("Escape");
  await page.waitFor(() => !document.querySelector(".c-float"), { message: "layer closes", timeout: 2000 }).catch(() => {});
}

export default async function more(page, t) {
  await t.step("⋯ bubble mounts", async () => {
    const { status } = await page.goto("/next/");
    t.eq(status, 200, "document status");
    await page.waitFor(() => !!document.querySelector(".app-more") && document.querySelector(".app").classList.contains("is-ready"), { timeout: 15000, message: "⋯ and chart ready" });
    await page.settle({ timeout: 3000 }).catch(() => {});
  });

  await t.step("menu lists its items", async () => {
    const labels = await menuItem(page);
    for (const l of ["Data sources", "Refresh data", "Copy link", "Guide", "Shortcuts"]) t.ok(labels.includes(l), `menu has ${l}`);
    t.ok(!labels.includes("Present") && !labels.includes("Methods"), "no Present or Methods");
    await shot(page, "menu");
    await closeLayer(page);
  });

  await t.step("Data sources shows synced hubs", async () => {
    await menuItem(page, "Data sources");
    await page.waitFor(() => document.querySelectorAll(".mo-src[data-hub]").length > 0 && document.querySelectorAll(".mo-src[data-local-hub]").length > 0, { timeout: 5000, message: "hub rows" });
    t.ok((await page.count(".mo-src[data-local-hub]")) > 0, "local hub rows");
    const meta = await page.text(".mo-src[data-hub] .mo-src-meta");
    t.ok(/model/.test(meta || ""), `hub meta (${meta})`);
    await page.frames(10);
    await shot(page, "hubs");
    await closeLayer(page);
  });

  await t.step("Warnings lists notes", async () => {
    const labels = await menuItem(page);
    await closeLayer(page);
    if (!labels.includes("Warnings")) { t.ok(true, "no warnings to show"); return; }
    await menuItem(page, "Warnings");
    await page.waitFor(() => document.querySelectorAll(".mo-warn").length > 0, { timeout: 10000, message: "warning rows" });
    t.ok((await page.count(".mo-warn")) > 0, "warning rows");
    await page.frames(10);
    await shot(page, "warnings");
    await closeLayer(page);
  });

  await t.step("Guide opens, searches, and Shortcuts is its last part", async () => {
    await menuItem(page, "Guide");
    await page.waitFor(() => document.querySelectorAll(".gd-sheet .gd-item").length > 20 && !!document.querySelector(".gd-read .gd-title"), { message: "guide topics" });
    t.ok(/^#guide\//.test(await page.eval(() => location.hash)), "hash follows the topic");
    const n = await page.eval(() => document.querySelectorAll(".gd-item:not([hidden])").length);
    await page.eval(() => { const i = document.querySelector(".gd-search input"); i.value = "calibration"; i.dispatchEvent(new Event("input")); });
    await page.frames(2);
    const m = await page.eval(() => document.querySelectorAll(".gd-item:not([hidden])").length);
    t.ok(m > 0 && m < n, `search filters topics (${n} → ${m})`);
    t.ok((await page.count(".gd-read mark.gd-mark")) > 0, "matches highlighted");
    const last = await page.eval(() => [...document.querySelectorAll(".gd-item")].at(-1).dataset.topic);
    t.eq(last, "shortcuts", "Shortcuts is the last topic");
    await page.eval(() => document.querySelector(".gd-search input").focus());
    await page.key.press("Escape");
    t.eq(await page.eval(() => document.querySelector(".gd-search input")?.value), "", "Escape clears the search first");
    await closeLayer(page);
    t.ok(!(await page.eval(() => location.hash)), "closing clears the hash");
    await page.eval(() => document.activeElement?.blur());
    await page.key.press("?");
    await page.waitFor(() => document.querySelector(".gd-item[aria-current]")?.dataset.topic === "shortcuts", { message: "? opens Shortcuts" });
    t.ok((await page.count(".gd-keys kbd")) > 5, "shortcut keys");
    t.ok(!(await page.eval(() => [...document.querySelectorAll(".gd-keys dd")].some((d) => /Present/.test(d.textContent)))), "no Present shortcut");
    await page.frames(10);
    await shot(page, "shortcuts");
    await closeLayer(page);
  });

  await t.step("no presentation mode: F does nothing", async () => {
    await page.eval(() => document.activeElement?.blur());
    await page.key.press("f");
    t.ok(!(await page.eval(() => document.documentElement.classList.contains("is-present"))), "no is-present");
  });

  await t.step("#guide/wis deep link opens WIS", async () => {
    // a fresh load with the hash (goto alone would be a same-document hash change)
    await page.goto("/next/#guide/wis");
    await page.waitFor(() => location.hash === "#guide/wis", { message: "hash set" });
    await page.frames(10);
    await page.reload();
    await page.waitFor(() => document.querySelector(".gd-item[aria-current]")?.dataset.topic === "wis", { timeout: 15000, message: "guide at WIS" });
    t.ok(/Weighted interval score/.test(await page.text(".gd-read .gd-title")), "WIS title");
    t.ok((await page.count(".gd-read .gd-fig svg")) === 1, "WIS figure");
    await page.frames(20);
    await shot(page, "guide-wis");
    await closeLayer(page);
    await page.waitFor(() => document.querySelector(".app").classList.contains("is-ready"), { timeout: 15000, message: "chart ready" });
  });

  await t.step("Combine opens from the model picker with a preview", async () => {
    const n = await page.eval(() => window.__viz.store.get().sel.selected.length);
    if (n < 2) { t.ok(true, `only ${n} selected; Combine hidden`); return; }
    await page.eval(() => document.activeElement?.blur());
    await page.key.press("/");
    await page.waitFor(() => { const b = document.querySelector(".pk-combine"); return b && !b.hidden; }, { timeout: 5000, message: "Combine… shown" });
    await page.eval(() => document.querySelector(".pk-combine").click());
    await page.waitFor(() => document.querySelectorAll(".mo-member").length >= 2, { timeout: 5000, message: "members" });
    await page.waitFor(() => /%|not found|Needs/.test(document.querySelector(".mo-preview")?.textContent || ""), { timeout: 10000, message: "preview answered" });
    const p = await page.text(".mo-preview");
    t.ok(/overlap/.test(p), `preview (${p})`);
    await page.frames(10);
    await shot(page, "combine");
    await closeLayer(page);
  });

  await t.step("no console errors", async () => {
    // sections are other lanes' work and may be mid-build; only this lane's errors count here
    t.eq(page.errors.filter((e) => !/section could not load/.test(e)), [], "uncaught exceptions and console errors");
  });
}
