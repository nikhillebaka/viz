// The page loads cleanly, the manifest has data, and the runner's input path works.
// Independent of app internals so it holds against a placeholder index page; the input self-test runs
// on about:blank.

export default async function smoke(page, t) {
  await t.step("loads without console errors", async () => {
    const { status } = await page.goto("/next/");
    t.eq(status, 200, "document status");
    const title = await page.eval(() => document.title);
    t.ok(typeof title === "string" && title.length > 0, "has a <title>");
    await page.frames(2);
    t.eq(page.errors, [], "uncaught exceptions and console errors");
  });

  await t.step("manifest has seasons and models", async () => {
    const m = await page.eval(async () => {
      const r = await fetch("/api/next/manifest");
      const j = await r.json();
      return { status: r.status, seasons: (j.seasons || []).length, models: (j.models || []).length };
    });
    t.eq(m.status, 200, "manifest status");
    t.ok(m.seasons >= 1, `at least one season (${m.seasons})`);
    t.ok(m.models >= 1, `at least one model (${m.models})`);
  });

  await t.step("viewport is 1440×900", async () => {
    const v = await page.eval(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
    t.eq(v, { w: 1440, h: 900, dpr: 2 }, "viewport");
  });

  await t.step("input helpers reach the page", async () => {
    // a blank page, so the app's own keys (← → step the date, = zooms) can't take the events
    await page.goto("about:blank");
    await page.eval(() => {
      document.body.innerHTML = "";
      document.body.style.margin = "0";
      const box = document.createElement("div");
      box.id = "pad";
      box.tabIndex = 0;
      box.style.cssText = "position:fixed;left:100px;top:100px;width:400px;height:300px;background:#ddd;touch-action:none";
      document.body.append(box);
      window.__log = [];
      const mods = (e) => ({ shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
      for (const type of ["pointerdown", "pointermove", "pointerup"]) {
        box.addEventListener(type, (e) => __log.push({ type, x: e.clientX, y: e.clientY, buttons: e.buttons, ...mods(e) }));
      }
      box.addEventListener("wheel", (e) => { e.preventDefault(); __log.push({ type: "wheel", x: e.clientX, y: e.clientY, dx: e.deltaX, dy: e.deltaY, ...mods(e) }); }, { passive: false });
      window.addEventListener("keydown", (e) => __log.push({ type: "keydown", key: e.key, code: e.code, ...mods(e) }));
      box.focus();
    });

    await page.mouse.drag(150, 150, 350, 300, { steps: 5 });
    await page.mouse.wheel(300, 250, { dy: 120, modifiers: ["Alt"] });
    await page.key.press("ArrowRight");
    await page.key.press("=", { modifiers: ["Shift"] });
    await page.frames(2);
    const log = await page.eval(() => window.__log);

    const down = log.findIndex((e) => e.type === "pointerdown");
    const up = log.findIndex((e) => e.type === "pointerup");
    t.ok(down >= 0 && up > down, "pointerdown before pointerup");
    if (down < 0 || up < 0) return;
    t.near(log[down].x, 150, 1, "down x"); t.near(log[down].y, 150, 1, "down y");
    t.near(log[up].x, 350, 1, "up x"); t.near(log[up].y, 300, 1, "up y");
    const moves = log.slice(down + 1, up).filter((e) => e.type === "pointermove");
    t.eq(moves.length, 5, "pointermoves during drag");
    t.ok(moves.every((e) => e.buttons === 1), "moves carry the pressed button");
    t.ok(moves.every((e, i) => i === 0 || (e.x > moves[i - 1].x && e.y > moves[i - 1].y)), "moves advance");
    t.near(moves.at(-1)?.x, 350, 1, "last move x");

    const wheel = log.find((e) => e.type === "wheel");
    t.ok(wheel, "wheel event");
    t.near(wheel?.x, 300, 1, "wheel x"); t.near(wheel?.y, 250, 1, "wheel y");
    t.eq(wheel?.dy, 120, "wheel deltaY");
    t.eq([wheel?.alt, wheel?.shift, wheel?.ctrl, wheel?.meta], [true, false, false, false], "wheel modifiers");

    const keys = log.filter((e) => e.type === "keydown").map((e) => [e.key, e.code, e.shift]);
    t.eq(keys, [["ArrowRight", "ArrowRight", false], ["=", "Equal", true]], "keydowns");
  });
}
