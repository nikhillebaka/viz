import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Fan,
  HUB_GONE_MESSAGE,
  busyRetryDelayMs,
  goneHubOf,
  hubFetch,
  indexManifest,
  isPrivateHubId,
  loadManifest,
  onHubGone,
  workspaceOfUrl,
} from "../../lib/api.js";
import { sanitizeScoresForTarget } from "../../features/url.js";
import { packSummaryForUpload, validateFolderSelection, vzb1FramingBytes } from "../../features/WebUpload.js";

const EPHEM = "ephem_0123456789ab_my-hub";
const USER = "user_0123456789ab_saved";

/* swap globalThis.fetch for one test */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/* ---------------------------------------------------------------- expired private hubs */

test("isPrivateHubId / goneHubOf recognise uploaded hubs and only 404/403 for them", () => {
  assert.equal(isPrivateHubId(EPHEM), true);
  assert.equal(isPrivateHubId(USER), true);
  assert.equal(isPrivateHubId("remote_flusight"), false);
  assert.equal(isPrivateHubId("ephem_xyz_hub"), false);
  assert.equal(isPrivateHubId(null), false);

  assert.equal(workspaceOfUrl(`/api/next/fan?target=t&workspace=${EPHEM}`), EPHEM);
  assert.equal(workspaceOfUrl("/api/next/manifest"), null);

  assert.equal(goneHubOf(404, `/api/next/metrics?workspace=${EPHEM}`), EPHEM);
  assert.equal(goneHubOf(403, `/api/next/metrics?workspace=${USER}`), USER);
  assert.equal(goneHubOf(500, `/api/next/metrics?workspace=${EPHEM}`), null);
  assert.equal(goneHubOf(404, "/api/next/metrics?workspace=remote_flusight"), null);
  assert.equal(goneHubOf(404, "/api/next/metrics"), null);
});

test("hubFetch reports an expired upload once, drops its cached manifest, and rejects readably", async () => {
  const gone = [];
  const stop = onHubGone((id) => gone.push(id));
  let manifestCalls = 0;
  let alive = true;
  await withFetch(async (url) => {
    if (String(url).startsWith("/api/next/manifest")) {
      manifestCalls++;
      return alive ? json({ hub_id: EPHEM, models: [], seasons: [] }) : json({ error: `Unknown workspace hub '${EPHEM}'` }, 404);
    }
    return json({ error: `Unknown workspace hub '${EPHEM}'` }, 404);
  }, async () => {
    await loadManifest(EPHEM);
    await loadManifest(EPHEM);
    assert.equal(manifestCalls, 1, "manifest is cached");

    alive = false;
    const errs = await Promise.all([1, 2, 3].map(() => hubFetch(`/api/next/metrics?workspace=${EPHEM}`).catch((e) => e)));
    for (const e of errs) {
      assert.equal(e.message, HUB_GONE_MESSAGE);
      assert.equal(e.hubGone, EPHEM);
      assert.equal(e.status, 404);
    }
    assert.deepEqual(gone, [EPHEM], "one report however many requests fail");

    await assert.rejects(loadManifest(EPHEM), (e) => e.hubGone === EPHEM);
    assert.equal(manifestCalls, 2, "the stale manifest was dropped, so Open asks the server again");

    // a public hub's 404 is an ordinary error response
    const r = await hubFetch("/api/next/metrics?workspace=remote_x");
    assert.equal(r.status, 404);
  });

  // Normal empty-slice 404/403 on a live private hub must NOT falsely trigger onHubGone or clear manifest cache
  const goneSlice = [];
  const stopSlice = onHubGone((id) => goneSlice.push(id));
  let manCount = 0;
  await withFetch(async (url) => {
    if (String(url).startsWith("/api/next/manifest")) {
      manCount++;
      return json({ hub_id: EPHEM, models: [], seasons: [] });
    }
    if (String(url).includes("trajectories")) {
      return json({ error: "No trajectory samples found for the requested slice" }, 404);
    }
    if (String(url).includes("gone_by_header")) {
      return json({ error: "Not found" }, 404, { "X-Viz-Hub-Gone": "1" });
    }
    return json({ error: "Forecast refreshes are disabled in public web mode." }, 403);
  }, async () => {
    await loadManifest(EPHEM);
    const miss = await hubFetch(`/api/next/trajectories?workspace=${EPHEM}`);
    assert.equal(miss.status, 404);
    const forbidden = await hubFetch(`/api/remote/refresh?workspace=${EPHEM}`);
    assert.equal(forbidden.status, 403);
    assert.deepEqual(goneSlice, []);

    await loadManifest(EPHEM);
    assert.equal(manCount, 1, "live private hub manifest stayed cached across slice 404/403");

    await assert.rejects(
      hubFetch(`/api/next/fan?workspace=${EPHEM}&gone_by_header=1`),
      (e) => e.hubGone === EPHEM && e.status === 404,
    );
    assert.deepEqual(goneSlice, [EPHEM]);
  });
  stopSlice();
  stop();
});

/* ---------------------------------------------------------------- 503 retry */

test("busyRetryDelayMs honours Retry-After with jitter, defaults to 1 s, caps at 4 s", () => {
  assert.equal(busyRetryDelayMs("1", () => 0), 1000);
  assert.equal(busyRetryDelayMs("2", () => 1), 2250);
  assert.equal(busyRetryDelayMs(null, () => 0), 1000);
  assert.equal(busyRetryDelayMs("", () => 0), 1000);
  assert.equal(busyRetryDelayMs("Wed, 21 Oct 2015 07:28:00 GMT", () => 0), 1000);
  assert.equal(busyRetryDelayMs("30", () => 0.5), 4000);
  assert.equal(busyRetryDelayMs("0", () => 0), 0);
});

test("hubFetch retries a GET answered 503 up to 3 times, then returns the 503", async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return calls < 3 ? json({ error: "Server busy; please retry shortly." }, 503, { "Retry-After": "0" }) : json({ ok: true });
  }, async () => {
    const r = await hubFetch("/api/next/catalog");
    assert.equal(r.status, 200);
    assert.equal(calls, 3);
  });

  calls = 0;
  await withFetch(async () => { calls++; return json({ error: "busy" }, 503, { "Retry-After": "0" }); }, async () => {
    const r = await hubFetch("/api/next/catalog");
    assert.equal(r.status, 503);
    assert.equal(calls, 4, "one try plus three retries");
  });
});

test("hubFetch never retries a POST and stops waiting when aborted", async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return json({ error: "busy" }, 503, { "Retry-After": "0" }); }, async () => {
    const r = await hubFetch("/api/remote/add", { method: "POST", body: "{}" });
    assert.equal(r.status, 503);
    assert.equal(calls, 1);
  });

  calls = 0;
  await withFetch(async () => { calls++; return json({ error: "busy" }, 503, { "Retry-After": "3" }); }, async () => {
    const ctl = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ctl.abort(), 20);
    await assert.rejects(hubFetch("/api/next/catalog", { signal: ctl.signal }), (e) => e.name === "AbortError");
    assert.ok(Date.now() - t0 < 1500, "did not sit out the Retry-After wait");
    assert.equal(calls, 1);
  });
});

/* ---------------------------------------------------------------- monthly Fan */

test("monthly Fan keys rounds by their actual dates (two rounds in one month both reachable)", () => {
  const fan = new Fan({
    target: "mo inc", season: "2025-2026", location: "CN", start: "2025-07-01", end: "2026-06-30",
    time_unit: "month",
    rounds: ["2025-08-05", "2025-08-20", "2025-10-12"],
    horizons: [0, 1],
    quantiles: [0.5],
    observed: { dates: [], offset: 0, length: 0 },
    models: [{ id: "m", offset: 0, rounds: [0, 1, 2] }],
  }, new Float32Array([10, 11, 20, 21, 30, 31]));

  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  // Aug 5, Aug 20, a September fill step (no round), Oct 12
  assert.deepEqual(fan.dates.map(iso), ["2025-08-05", "2025-08-20", "2025-09-05", "2025-10-12"]);
  assert.deepEqual([...fan.roundAt], [0, 1, -1, 2]);
  assert.equal(fan.indexOf("2025-08-20"), 1);
  assert.equal(fan.indexOf("2025-10-12"), 3);
  assert.equal(fan.indexOf("2025-10-10"), 3, "nearest slot within half a month");
  assert.equal(fan.indexOf("2026-03-01"), -1);
  assert.equal(fan.has("m", 1), true);
  assert.equal(fan.has("m", 2), false);

  const second = fan.points("m", 1, 0);
  assert.equal(second[0].med, 20);
  assert.equal(iso(second[0].t), "2025-08-20", "forecasts and markers both sit on the round's own date");
  assert.equal(iso(fan.points("m", 3, 0)[1].t), "2025-11-12");
});

test("weekly Fan timeline is unchanged", () => {
  const fan = new Fan({
    target: "wk inc", season: "2025-2026", location: "US", start: "2025-10-01", end: "2026-06-30",
    rounds: ["2025-11-01", "2025-11-15"],
    horizons: [0],
    quantiles: [0.5],
    observed: { dates: [], offset: 0, length: 0 },
    models: [{ id: "m", offset: 0, rounds: [0, 1] }],
  }, new Float32Array([1, 2]));
  assert.equal(fan.dates.length, 3);
  assert.deepEqual([...fan.roundAt], [0, -1, 1]);
  assert.equal(fan.indexOf("2025-11-08"), 1);
});

/* ---------------------------------------------------------------- leaderboard sort */

test("sanitizeScoresForTarget drops a horizon sort the target doesn't have", () => {
  const manifest = indexManifest({
    targets: [
      { id: "wk", horizons: { required: [0, 1, 2, 3, 4, 5], optional: [] } },
      { id: "short", horizons: { required: [0, 1], optional: [] } },
      { id: "neg", horizons: { required: [-1, 0, 1], optional: [] } },
    ],
    models: [], seasons: [],
  });
  const s = { sort: "h5", rev: true, cols: ["h5", "wins", "bogus"], open: [] };
  assert.deepEqual(sanitizeScoresForTarget(s, manifest, "wk"), { sort: "h5", rev: true, cols: ["h5", "wins"], open: [] });
  assert.deepEqual(sanitizeScoresForTarget(s, manifest, "short"), { sort: "rel", rev: false, cols: ["h5", "wins"], open: [] });
  assert.equal(sanitizeScoresForTarget({ sort: "h-1", rev: false }, manifest, "neg").sort, "h-1");
  assert.equal(sanitizeScoresForTarget({ sort: "wis", rev: true }, manifest, "short").sort, "wis");
  assert.equal(sanitizeScoresForTarget(undefined, manifest, "wk"), undefined);
});

/* ---------------------------------------------------------------- upload pre-checks */

const summaryOf = (files) => ({
  valid: true,
  included: files.map(([relPath, size]) => ({ relPath, size })),
  totalBytes: files.reduce((n, [, size]) => n + size, 0),
});

test("validateFolderSelection counts VZB1 framing toward the uncompressed limit", () => {
  const sum = summaryOf([["hub-config/tasks.json", 100], ["model-output/a/2025-01-01-a.csv", 100]]);
  const framing = vzb1FramingBytes(sum.included);
  assert.equal(framing, 8 + (12 + 21) + (12 + 31));
  assert.equal(validateFolderSelection(sum, { max_uncompressed_bytes: 200 + framing }).ok, true);
  assert.equal(validateFolderSelection(sum, { max_uncompressed_bytes: 200 + framing - 1 }).ok, false);
});

test("validateFolderSelection checks saved-hub count and remaining quota for the persistent tier", () => {
  const sum = summaryOf([["model-output/a/2025-01-01-a.csv", 60 * 1024 * 1024]]);
  const lim = { max_uncompressed_bytes: 1e9, user_max_hubs: 5 };

  const full = validateFolderSelection(sum, lim, { tier: "persistent", ownedCount: 5, usedBytes: 0, quotaBytes: 250 * 1024 * 1024 });
  assert.equal(full.ok, false);
  assert.match(full.error, /Account limit reached \(5 saved hubs\)/);

  const noRoom = validateFolderSelection(sum, lim, { tier: "persistent", ownedCount: 1, usedBytes: 200 * 1024 * 1024, quotaBytes: 250 * 1024 * 1024 });
  assert.equal(noRoom.ok, false);
  assert.match(noRoom.error, /remaining account storage/);

  assert.equal(validateFolderSelection(sum, lim, { tier: "persistent", ownedCount: 1, usedBytes: 10, quotaBytes: 250 * 1024 * 1024 }).ok, true);
  // fields the status didn't expose are skipped
  assert.equal(validateFolderSelection(sum, { max_uncompressed_bytes: 1e9 }, { tier: "persistent" }).ok, true);
  assert.equal(validateFolderSelection(sum, lim, { tier: "persistent", ownedCount: 1, quotaBytes: 0, usedBytes: 0 }).ok, true);
});

test("validateFolderSelection warns (not fails) when a temporary upload will replace the oldest hub", () => {
  const sum = summaryOf([["model-output/a/2025-01-01-a.csv", 10]]);
  const r = validateFolderSelection(sum, { ephem_max_hubs_per_session: 2 }, { tier: "ephem", ownedCount: 2 });
  assert.equal(r.ok, true);
  assert.match(r.warning, /oldest will be replaced/);
  assert.equal(validateFolderSelection(sum, { ephem_max_hubs_per_session: 2 }, { tier: "ephem", ownedCount: 1 }).warning, undefined);
  assert.equal(validateFolderSelection(sum, {}, { tier: "ephem", ownedCount: 9 }).warning, undefined);
});

test("packSummaryForUpload stops as soon as the compressed size passes the limit", async () => {
  let reads = 0;
  const n = 40;
  const included = Array.from({ length: n }, (_, i) => ({
    relPath: `model-output/a/2025-01-${String(i + 1).padStart(2, "0")}-a.csv`,
    size: 256 * 1024,
    file: {
      async arrayBuffer() {
        reads++;
        const b = new Uint8Array(256 * 1024);
        for (let k = 0; k < b.length; k++) b[k] = (Math.random() * 256) | 0; // incompressible
        return b.buffer;
      },
    },
  }));
  await assert.rejects(
    packSummaryForUpload({ included }, { maxBytes: 512 * 1024 }),
    (e) => /exceeds the 512 KB upload limit/.test(e.message),
  );
  assert.ok(reads < n, `stopped early (read ${reads} of ${n} files)`);

  const ok = await packSummaryForUpload({ included: included.slice(0, 1) }, { maxBytes: 4 * 1024 * 1024 });
  assert.ok(ok.size > 0);
});
