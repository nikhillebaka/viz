# Tests

No dependencies: Node (v22+, for global `WebSocket`) and a local Chrome. Run from the repo root.

## Unit

```bash
node --test "next/tests/unit/**/*.test.mjs"
```

Pure modules only (scale, format, selection, fan decoding, layout rules).

## End to end

```bash
node next/tests/e2e/run.mjs                 # starts next/dev/serve.py on a free port, headless Chrome
node next/tests/e2e/run.mjs smoke           # only checks whose name contains "smoke"
node next/tests/e2e/run.mjs --base http://127.0.0.1:8610   # reuse a running dev server
node next/tests/e2e/run.mjs --headed --keep # watch it; leave the browser open
node next/tests/e2e/run.mjs --list
```

Options: `--shots <dir>` (failure screenshots, default `next/tests/e2e/.shots`, git-ignored),
`--timeout <ms>` per check (default 60000). Exit code 0 when everything passes, 1 otherwise.

Environment: `VIZ_PYTHON` (else the hub's `viz/.venv/bin/python`, else `python3`), `CHROME_PATH`.

### Writing a check

Each `next/tests/e2e/<name>.check.mjs` default-exports `async (page, t) => {}` and gets a fresh page
at 1440×900, deviceScaleFactor 2.

```js
export default async function (page, t) {
  await page.goto("/next/");
  await t.step("drag pans the chart", async () => {
    const r = await page.rect("canvas");
    await page.mouse.drag(r.cx, r.cy, r.cx - 200, r.cy, { steps: 12 });
    await page.settle();
    t.near(await page.eval(() => window.__viz.nav.offset), -200, 2, "offset");
  });
}
```

- `t.step(name, fn)` groups and times assertions (one report line each). `t.ok`, `t.eq` (JSON deep
  equality), `t.near`, `t.fail` record failures without throwing; a thrown error ends the check.
- `page`: `goto`, `reload`, `eval(fn, ...args)`, `waitFor`, `frames`, `sleep`, `settle`,
  `mouse.{move,down,up,click,drag,wheel}`, `key.{press,type}`, `pinch`, `rect`, `text`, `exists`,
  `count`, `screenshot`, `emulate({ reducedMotion, colorScheme })`, `send` (raw CDP), `errors`,
  `allowErrors()`. See `e2e/cdp.mjs`.
- A check fails if the page throws an uncaught exception, unless it calls `page.allowErrors()`.
  `page.errors` also holds `console.error` messages for checks that want to assert on them.
