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
      return !!board && (!!board.querySelector(".v-table") || !!board.querySelector(".v-note"));
    }, { timeout: 30000, message: "Trajectories section or Sample Leaderboard never rendered" });

    const st = await page.eval(() => {
      const wrap = document.querySelector("#trajectories .tr-board-wrap");
      const headers = [...(wrap?.querySelectorAll("th") || [])].map((x) => x.textContent.trim().replace(/[↑↓]/g, "").trim());
      const trText = document.querySelector("#trajectories")?.textContent || "";
      return {
        hasCanvas: !!document.querySelector("#trajectories .tr-canvas"),
        headers,
        legacyPills: document.querySelectorAll("#trajectories .tr-scope-btn, #trajectories .tr-cmp-btn, #trajectories .tr-board-sub").length,
        hasHintCopy: /Drag vertically|Click a row to plot/.test(trText),
      };
    });
    t.ok(st.hasCanvas, "trajectories canvas present");
    t.eq(st.legacyPills, 0, "canonical v-subhead and v-table without pill/button clutter");
    t.eq(st.hasHintCopy, false, "no tutorial/hint copy inside Trajectories section");
    if (st.headers.length) {
      t.ok(st.headers.includes("CRPS") && st.headers.includes("Energy"), `leaderboard headers (${st.headers.join(", ")})`);
      const crpsSort = await page.eval(() => {
        const findBtn = () => [...document.querySelectorAll("#trajectories .tr-board-wrap th button.v-sort")]
          .find((b) => b.textContent.replace(/[↑↓]/g, "").trim() === "CRPS");
        const b1 = findBtn();
        if (!b1) return null;
        b1.click();
        const first = findBtn()?.closest("th")?.getAttribute("aria-sort");
        findBtn()?.click();
        const second = findBtn()?.closest("th")?.getAttribute("aria-sort");
        return { first, second };
      });
      if (crpsSort) {
        t.eq(crpsSort.first, "ascending", "Trajectories CRPS column sorts ascending on click");
        t.eq(crpsSort.second, "descending", "Trajectories CRPS column toggles to descending on second click");
      }
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

    const openedScope = await page.eval(() => {
      const frag = document.querySelector("#rate_change .pmf-table-wrap .v-subhead .v-frag");
      if (!frag) return false;
      frag.click();
      return true;
    });
    if (openedScope) {
      await page.waitFor(() => [...document.querySelectorAll(".c-menu button")].some((b) => b.textContent.includes("All places")), {
        timeout: 10000,
        message: "Rate change scope menu never opened",
      });
      await page.eval(() => {
        const allOpt = [...document.querySelectorAll(".c-menu button")].find((b) => b.textContent.includes("All places"));
        allOpt?.click();
      });
      await page.waitFor(() => {
        const hdr = document.querySelector("#rate_change .pmf-table-wrap thead tr")?.textContent || "";
        return /RPS|Log loss/.test(hdr);
      }, { timeout: 30000, message: "All-places PMF metrics table did not load" });
      const hdr = await page.text("#rate_change .pmf-table-wrap thead tr");
      t.ok(/Rel\. RPS|Rel\. Log/.test(hdr) && /Mode hit/.test(hdr), `PMF seasonal table headers (${hdr})`);
      const pmfSort = await page.eval(() => {
        const findBtn = () => [...document.querySelectorAll("#rate_change .pmf-table-wrap th button.v-sort")]
          .find((b) => b.textContent.replace(/[↑↓]/g, "").trim() === "Log loss");
        const b1 = findBtn();
        if (!b1) return null;
        b1.click();
        const first = findBtn()?.closest("th")?.getAttribute("aria-sort");
        findBtn()?.click();
        const second = findBtn()?.closest("th")?.getAttribute("aria-sort");
        return { first, second };
      });
      if (pmfSort) {
        t.eq(pmfSort.first, "ascending", "Rate change Log loss column sorts ascending on click");
        t.eq(pmfSort.second, "descending", "Rate change Log loss column toggles to descending on second click");
      }
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
