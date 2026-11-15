#!/usr/bin/env node
// Headless end-to-end checks for next/, driving the local Chrome over CDP. No dependencies.
//
//   node next/tests/e2e/run.mjs [--base <url>] [--headed] [--keep] [--shots <dir>]
//                               [--timeout <ms>] [--list] [name filters...]
//
// Without --base it starts next/dev/serve.py on a free port. Every *.check.mjs here default-exports
// async (page, t) => {}; each gets a fresh 1440×900 page at deviceScaleFactor 2. Exit code 0/1.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect, Page } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => paint(32, s), red = (s) => paint(31, s), dim = (s) => paint(2, s);

// ---------- options ----------

function parseArgs(argv) {
  const o = { base: null, headed: false, keep: false, shots: join(HERE, ".shots"), timeout: 60000, list: false, filters: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--base") o.base = val().replace(/\/+$/, "");
    else if (a === "--headed") o.headed = true;
    else if (a === "--keep") o.keep = true;
    else if (a === "--shots") o.shots = resolve(val());
    else if (a === "--timeout") o.timeout = Number(val());
    else if (a === "--list") o.list = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else o.filters.push(a);
  }
  if (!Number.isFinite(o.timeout) || o.timeout <= 0) throw new Error("--timeout must be a positive number of ms");
  return o;
}

function discover(filters) {
  return readdirSync(HERE)
    .filter((f) => f.endsWith(".check.mjs"))
    .sort()
    .map((f) => ({ name: f.slice(0, -".check.mjs".length), file: join(HERE, f) }))
    .filter((c) => !filters.length || filters.some((s) => c.name.includes(s)));
}

// ---------- cleanup ----------

const cleanups = [];
let cleaning = null;
/** Runs every registered cleanup once, newest first. */
function cleanup() {
  if (!cleaning) cleaning = (async () => {
    for (const fn of cleanups.reverse()) { try { await fn(); } catch {} }
  })();
  return cleaning;
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, async () => {
    console.log(red(`\n${sig}: stopping`));
    await Promise.race([cleanup(), sleep(8000)]);
    process.exit(130);
  });
}

/** Kills a detached child's process group; resolves when it exits (SIGKILL after `grace` ms). */
async function killTree(child, grace = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
  kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), sleep(grace).then(() => false)])) return;
  kill("SIGKILL");
  await Promise.race([exited, sleep(2000)]);
}

// ---------- server ----------

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

function findPython() {
  if (process.env.VIZ_PYTHON) return process.env.VIZ_PYTHON;
  for (let p = REPO; ; p = dirname(p)) {
    if (existsSync(join(p, "model-output"))) {
      const py = join(p, "viz", ".venv", "bin", "python");
      if (existsSync(py)) return py;
      break;
    }
    if (dirname(p) === p) break;
  }
  return "python3";
}

async function startServer() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const python = findPython();
  const child = spawn(python, [join(REPO, "next", "dev", "serve.py"), "--port", String(port)], {
    cwd: REPO, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  cleanups.push(() => killTree(child));
  let tail = "";
  const keep = (b) => { tail = (tail + b.toString()).slice(-4000); };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  let spawnErr = null;
  child.on("error", (e) => { spawnErr = e; });
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (spawnErr) throw new Error(`could not start ${python}: ${spawnErr.message}`);
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}) before answering\n${tail}`);
    try {
      const r = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return { base, python };
      throw new Error(`server answered ${r.status} on /api/status\n${tail}`);
    } catch (e) {
      if (e.message.startsWith("server answered")) throw e;
    }
    await sleep(250);
  }
  throw new Error(`server did not answer ${base}/api/status within 60 s\n${tail}`);
}

// ---------- chrome ----------

function onPath(name) {
  for (const dir of (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":")) {
    const p = join(dir, name);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [];
  if (process.platform === "darwin") {
    for (const app of ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser"]) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
      candidates.push(join(process.env.HOME || "", `Applications/${app}.app/Contents/MacOS/${app}`));
    }
  } else if (process.platform === "win32") {
    for (const root of [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(join(root, "Google/Chrome/Application/chrome.exe"));
      candidates.push(join(root, "Chromium/Application/chrome.exe"));
      candidates.push(join(root, "Microsoft/Edge/Application/msedge.exe"));
      candidates.push(join(root, "BraveSoftware/Brave-Browser/Application/brave.exe"));
    }
  } else {
    for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
      const p = onPath(n);
      if (p) candidates.push(p);
    }
  }
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("Chrome not found; set CHROME_PATH");
  return found;
}

async function startChrome({ headed }) {
  const exe = findChrome();
  const profile = mkdtempSync(join(tmpdir(), "viz-e2e-chrome-"));
  const args = [
    ...(headed ? [] : ["--headless=new"]),
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=1440,900",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--force-color-profile=srgb",
    "--hide-scrollbars",
    "about:blank",
  ];
  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  const state = { child, profile, client: null };
  cleanups.push(async () => {
    if (state.client && !state.client.closed) {
      await state.client.send("Browser.close", {}, undefined, { timeout: 3000 }).catch(() => {});
      state.client.close();
    }
    await killTree(child);
    for (let i = 0; i < 10; i++) {
      try { rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(200); }
    }
  });
  let spawnErr = null;
  child.on("error", (e) => { spawnErr = e; });
  const portFile = join(profile, "DevToolsActivePort");
  const end = Date.now() + 30000;
  let lines = null;
  while (Date.now() < end) {
    if (spawnErr) throw new Error(`could not start Chrome (${exe}): ${spawnErr.message}`);
    if (child.exitCode !== null) throw new Error(`Chrome exited (${child.exitCode}) on startup`);
    if (existsSync(portFile)) {
      const l = readFileSync(portFile, "utf8").trim().split("\n");
      if (l.length >= 2 && l[0] && l[1]) { lines = l; break; }
    }
    await sleep(50);
  }
  if (!lines) throw new Error("Chrome did not write DevToolsActivePort within 30 s");
  state.client = await connect(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
  return state;
}

// ---------- the t helper ----------

const show = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

/** Builds the assertion helper for one check; failures go into the current group. */
function makeT(check, report) {
  let group = null; // { name, failures: [] }
  const loose = { name: "assertions", failures: [], used: false };
  const cur = () => group || (loose.used = true, loose);
  const fail = (msg) => { cur().failures.push(msg); return false; };
  const t = {
    ok(cond, message = "expected truthy") {
      cur();
      return cond ? true : fail(`${message} (got ${show(cond)})`);
    },
    eq(actual, expected, message = "not equal") {
      cur();
      return show(actual) === show(expected) ? true : fail(`${message}: expected ${show(expected)}, got ${show(actual)}`);
    },
    near(actual, expected, tolerance, message = "not near") {
      cur();
      const ok = typeof actual === "number" && Math.abs(actual - expected) <= tolerance;
      return ok ? true : fail(`${message}: expected ${expected} ±${tolerance}, got ${show(actual)}`);
    },
    fail(message = "failed") { return fail(message); },
    async step(name, fn) {
      if (group) throw new Error(`t.step("${name}") inside t.step("${group.name}")`);
      group = { name, failures: [] };
      const t0 = Date.now();
      let thrown = null;
      try { await fn(); } catch (e) { thrown = e; group.failures.push(e?.stack || String(e)); }
      const g = group;
      group = null;
      await report(g.name, g.failures, Date.now() - t0);
      if (thrown) { thrown.reported = true; throw thrown; }
    },
  };
  t._loose = loose;
  t._current = () => group?.name;
  return t;
}

// ---------- main ----------

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log("node next/tests/e2e/run.mjs [--base <url>] [--headed] [--keep] [--shots <dir>] [--timeout <ms>] [--list] [filters...]");
    return 0;
  }
  const checks = discover(o.filters);
  if (o.list) {
    for (const c of checks) console.log(c.name);
    return 0;
  }
  if (!checks.length) {
    console.log(red(`no checks match ${o.filters.join(" ")}`));
    return 1;
  }

  let base = o.base;
  if (!base) {
    process.stdout.write(dim("starting server… "));
    const s = await startServer();
    base = s.base;
    console.log(dim(base));
  }
  const chrome = await startChrome({ headed: o.headed });
  const client = chrome.client;

  let passed = 0, failed = 0;
  const shotsReady = () => {
    mkdirSync(o.shots, { recursive: true });
    const gi = join(o.shots, ".gitignore");
    if (!existsSync(gi)) writeFileSync(gi, "*\n");
  };

  for (const check of checks) {
    let shotN = 0;
    let page = null;
    const shoot = async () => {
      if (!page) return;
      try {
        shotsReady();
        const file = join(o.shots, `${check.name}-${++shotN}.png`);
        await page.screenshot(file);
        console.log(dim(`    screenshot: ${file}`));
      } catch (e) {
        console.log(dim(`    screenshot failed: ${e.message}`));
      }
    };
    let reported = 0;
    const report = async (name, failures, ms) => {
      reported++;
      if (!failures.length) {
        passed++;
        console.log(`${green("✓")} ${check.name} › ${name} ${dim(`(${ms} ms)`)}`);
      } else {
        failed++;
        console.log(`${red("✗")} ${check.name} › ${name} ${dim(`(${ms} ms)`)}`);
        for (const f of failures) {
          // drop the runner's own stack frames; keep the check's and cdp.mjs's
          const lines = String(f).split("\n").filter((l) => !/^\s+at .*\/e2e\/run\.mjs:/.test(l));
          console.log(red(`    ${lines.join("\n    ")}`));
        }
        await shoot();
      }
    };

    const t0 = Date.now();
    try {
      page = await Page.open(client, { base });
      const t = makeT(check, report);
      const mod = await import(pathToFileURL(check.file).href);
      if (typeof mod.default !== "function") throw new Error(`${check.file} has no default-exported function`);
      let timer;
      // a check may need longer than the default (export const timeout = ms); --timeout still caps the rest
      const limit = Math.max(o.timeout, Number(mod.timeout) || 0);
      try {
        await Promise.race([
          mod.default(page, t),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`check timed out after ${limit} ms${t._current() ? ` in step "${t._current()}"` : ""}`)), limit); }),
        ]);
      } finally { clearTimeout(timer); }
      if (t._loose.used) await report(t._loose.name, t._loose.failures, Date.now() - t0);
    } catch (e) {
      if (!e?.reported) await report("error", [e?.stack || String(e)], Date.now() - t0);
    }
    try {
      if (page?.exceptions.length && !page.errorsAllowed) {
        await report("no uncaught page exceptions", page.exceptions, Date.now() - t0);
      }
      if (!reported) await report("completed", [], Date.now() - t0);
    } finally {
      if (page && !(o.keep && o.headed)) await page.close();
    }
  }

  console.log(`\n${failed ? red(`${passed} passed, ${failed} failed`) : green(`${passed} passed, ${failed} failed`)}`);
  if (o.keep && o.headed) {
    console.log(dim("--keep: browser left open; Ctrl+C to stop"));
    await new Promise((r) => chrome.child.once("exit", r));
  }
  return failed ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(red(e?.stack || String(e)));
  code = 1;
} finally {
  await Promise.race([cleanup(), sleep(10000)]);
}
process.exit(code);
