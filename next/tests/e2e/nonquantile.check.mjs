// Non-quantile workflows: Sample Trajectories (canvas + CRPS/Energy Sample Leaderboard) and
// Categorical PMFs (Rate change Matrix/Flow/Bars + All-places seasonal score toggle).

export default async function nonquantile(page, t) {
  await t.step("boots onto workbench and inspects Trajectories section when present", async () => {
    await page.goto("/next/");
    await page.waitFor(() => window.__viz?.chart?.fan, { timeout: 20000, message: "chart never loaded" });

    const tabShown = await page.eval(() => {
      const b = document.getElementById("tab-trajectories");
      return !!b && !b.hidden;
    });
    if (!tabShown) {
      t.ok(true, "No sample trajectory models on active target; skipped");
      return;
    }

    await page.eval(() => {
      const b = document.getElementById("tab-trajectories");
      b?.scrollIntoView({ block: "start" });
      b?.click();
    });
    await page.waitFor(() => {
      const board = document.querySelector("#trajectories .tr-board-wrap");
      return !!board && (!!board.querySelector(".v-table") || !!board.querySelector(".tr-note"));
    }, { timeout: 30000, message: "Trajectories section or Sample Leaderboard never rendered" });

    const st = await page.eval(() => {
      const wrap = document.querySelector("#trajectories .tr-board-wrap");
      const headers = [...(wrap?.querySelectorAll("th") || [])].map((x) => x.textContent.trim());
      return { hasCanvas: !!document.querySelector("#trajectories .tr-canvas"), headers };
    });
    t.ok(st.hasCanvas, "trajectories canvas present");
    if (st.headers.length) {
      t.ok(st.headers.includes("CRPS") && st.headers.includes("Energy"), `leaderboard headers (${st.headers.join(", ")})`);
    }
  });

  await t.step("inspects Rate change PMF view and All-places seasonal scores toggle when present", async () => {
    const rcShown = await page.eval(() => {
      const b = document.getElementById("tab-rate_change");
      return !!b && !b.hidden;
    });
    if (!rcShown) {
      t.ok(true, "No companion Rate change target on active slice; skipped");
      return;
    }

    await page.eval(() => {
      const b = document.getElementById("tab-rate_change");
      b?.scrollIntoView({ block: "start" });
      b?.click();
    });
    await page.waitFor(() => {
      const c = document.querySelector("#rate_change .pmf-canvas");
      const tbl = document.querySelector("#rate_change .pmf-table-wrap .v-table");
      const empty = document.querySelector("#rate_change .v-empty:not([hidden])");
      return (!!c && !!tbl) || !!empty;
    }, { timeout: 30000, message: "Rate change PMF section did not settle" });

    const allBtnExists = await page.eval(() => {
      const btns = [...document.querySelectorAll("#rate_change .pmf-scope-btn")];
      const allBtn = btns.find((b) => b.textContent.startsWith("All places"));
      if (allBtn) { allBtn.click(); return true; }
      return false;
    });
    if (allBtnExists) {
      await page.waitFor(() => {
        const hdr = document.querySelector("#rate_change .pmf-table-wrap thead tr")?.textContent || "";
        return /RPS|Log loss/.test(hdr);
      }, { timeout: 30000, message: "All-places PMF metrics table did not load" });
      const hdr = await page.text("#rate_change .pmf-table-wrap thead tr");
      t.ok(/Rel\. RPS|Rel\. Log/.test(hdr) && /Mode hit/.test(hdr), `PMF seasonal table headers (${hdr})`);
    }
  });

  await t.step("no console errors", async () => {
    await page.eval(() => {
      document.getElementById("tab-scores")?.click();
      localStorage.removeItem("viz.section_tab");
    });
    t.eq(page.errors, [], "uncaught exceptions and console errors");
  });
}
