// Multi-viewport responsive check: verifies ultrawide cap, zero chrome pill collisions or clipping,
// clean floating panels/sheets, zero document overflow across sections and Briefing, and zero errors.
export const timeout = 120000;

const VIEWPORTS = [
  { name: "2560x1440", w: 2560, h: 1440, mobile: false },
  { name: "1440x900",  w: 1440, h: 900,  mobile: false },
  { name: "1024x640",  w: 1024, h: 640,  mobile: false },
  { name: "720x500",   w: 720,  h: 500,  mobile: false },
  { name: "390x844",   w: 390,  h: 844,  mobile: true },
];

async function setVP(page, vp) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: vp.w, height: vp.h, deviceScaleFactor: 2, mobile: vp.mobile,
  });
  await page.frames(4);
}

async function closeFloat(page) {
  await page.key.press("Escape");
  await page.waitFor(() => !document.querySelector(".c-float"), { timeout: 5000, message: "float closed" });
}

async function openMorePanel(page, label, waitSel) {
  await page.eval(() => document.querySelector(".app-more")?.click());
  await page.waitFor(() => !!document.querySelector(".c-menu"), { timeout: 5000, message: "more menu" });
  await page.eval((lbl) => {
    [...document.querySelectorAll(".c-menu .c-menu-item")].find((b) => b.textContent.startsWith(lbl))?.click();
  }, label);
  await page.waitFor((s) => !!document.querySelector(s), { args: [waitSel], timeout: 10000, message: `${label} opened` });
  await page.sleep(250);
}

async function measureFloat(page, waitSel, scrollSel = ".c-float-body") {
  return page.eval((s, bSel) => {
    const f = document.querySelector(s);
    if (!f) return null;
    const r = f.getBoundingClientRect();
    const body = bSel ? f.querySelector(bSel) : null;
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      clipX: r.left < -1 || r.right > innerWidth + 1,
      clipY: r.top < -1 || r.bottom > innerHeight + 1,
      innerOverflowX: body ? Math.max(0, body.scrollWidth - body.clientWidth) : 0,
    };
  }, waitSel, scrollSel);
}

export default async function responsive(page, t) {
  try {
    for (const vp of VIEWPORTS) {
      await t.step(`${vp.name}: chrome, floats, and sections`, async () => {
        await setVP(page, vp);
        await page.goto("/next/?loc=US&target=wk%20inc%20flu%20hosp&date=2026-01-10");
        await page.waitFor(() => !!window.__viz?.chart?.fan && document.querySelector(".app.is-ready"), {
          timeout: 25000, message: "workbench ready",
        });
        await page.frames(3);

        const base = await page.eval(() => {
          const iw = innerWidth;
          const docOverflow = Math.max(0, document.documentElement.scrollWidth - iw);
          const issues = [];
          for (const barSel of [".app-fixed", ".fc-chrome"]) {
            const bar = document.querySelector(barSel);
            if (!bar) continue;
            const els = [...bar.querySelectorAll(".c-zone > *")].filter((el) => {
              const cs = getComputedStyle(el);
              const r = el.getBoundingClientRect();
              return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.1 && r.width > 0 && r.height > 0;
            });
            for (let i = 0; i < els.length; i++) {
              const a = els[i].getBoundingClientRect();
              if (a.left < -1 || a.right > iw + 1) {
                issues.push(`${barSel} clipped: ${els[i].textContent.trim().slice(0, 20)}`);
              }
              for (let j = i + 1; j < els.length; j++) {
                const b = els[j].getBoundingClientRect();
                const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                if (ox > 1 && oy > 1) {
                  issues.push(`${barSel} overlap (${Math.round(ox)}x${Math.round(oy)}px): "${els[i].textContent.trim().slice(0, 20)}" vs "${els[j].textContent.trim().slice(0, 20)}"`);
                }
              }
            }
          }
          const secW = Math.round(document.querySelector(".app-sections")?.getBoundingClientRect()?.width || 0);
          return { docOverflow, issues, secW };
        });

        t.eq(base.docOverflow, 0, `${vp.name} workbench docOverflow`);
        t.eq(base.issues, [], `${vp.name} chrome collisions/clipping`);
        if (vp.w === 1440) t.eq(base.secW, 1440, "1440x900 sections stay full 1440px");
        if (vp.w === 2560) t.ok(base.secW <= 1760 && base.secW >= 1600, `2560x1440 sections capped (got ${base.secW})`);

        // Floating pickers and panels
        const floats = [
          {
            name: "ModelPicker",
            open: async () => {
              await page.eval(() => document.querySelector(".app-models")?.click());
              await page.waitFor(() => !!document.querySelector(".mb-panel"), { timeout: 10000, message: "ModelPicker" });
              await page.sleep(250);
            },
            sel: ".mb-panel",
            bodySel: ".mb-panel .c-float-body",
          },
          {
            name: "LocationPicker",
            open: async () => {
              await page.eval(() => document.querySelector(".app-place")?.click());
              await page.waitFor(() => !!document.querySelector(".lp-panel"), { timeout: 10000, message: "LocationPicker" });
              await page.sleep(250);
            },
            sel: ".lp-panel",
            bodySel: ".lp-panel .c-float-body",
          },
          {
            name: "DatePicker",
            open: async () => {
              await page.eval(() => document.querySelector(".c-stepper .c-step-label")?.click());
              await page.waitFor(() => !!document.querySelector(".dp"), { timeout: 10000, message: "DatePicker" });
              await page.sleep(250);
            },
            sel: ".dp",
            bodySel: ".dp .c-float-body",
          },
          {
            name: "Hubs",
            open: () => openMorePanel(page, "Data sources", ".mo-sources"),
            sel: ".mo-sources",
            bodySel: ".mo-sources .c-float-body",
          },
          {
            name: "Guide",
            open: () => openMorePanel(page, "Guide", ".gd-sheet"),
            sel: ".gd-sheet",
            bodySel: ".gd-sheet .c-float-body",
          },
        ];

        for (const f of floats) {
          await f.open();
          const m = await measureFloat(page, f.sel, f.bodySel);
          t.ok(m && !m.clipX && !m.clipY, `${vp.name} ${f.name} fits viewport (${JSON.stringify(m)})`);
          t.ok(m && m.innerOverflowX <= 2, `${vp.name} ${f.name} body no horiz overflow (${m?.innerOverflowX})`);
          await closeFloat(page);
        }

        // Lower sections: scores, heatmap, map, peaks
        for (const tab of ["scores", "heatmap", "map", "peaks"]) {
          await page.eval((id) => {
            document.getElementById(`tab-${id}`)?.click();
            document.getElementById(id)?.scrollIntoView({ block: "start" });
          }, tab);
          await page.waitFor((id) => {
            const el = document.getElementById(id);
            return el && !el.hidden && !el.classList.contains("is-pending");
          }, { args: [tab], timeout: 15000, message: `${tab} visible` });
          await page.sleep(400);
          const ov = await page.eval((id) => {
            const el = document.getElementById(id);
            return {
              docX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
              secX: el ? Math.max(0, el.scrollWidth - el.clientWidth) : 0,
            };
          }, tab);
          t.eq(ov.docX, 0, `${vp.name} ${tab} docOverflow`);
          t.ok(ov.secX <= 2, `${vp.name} ${tab} section overflow (${ov.secX})`);
        }
        await page.eval(() => {
          document.getElementById("tab-scores")?.click();
          localStorage.removeItem("viz.section_tab");
        });
      });
    }

    await t.step("ModelSheet and Briefing across viewports", async () => {
      for (const vp of VIEWPORTS) {
        await setVP(page, vp);
        await page.goto("/next/?date=2026-01-10#model/UMass-flusion");
        await page.waitFor(() => !!document.querySelector(".ms-sheet"), { timeout: 20000, message: "ModelSheet open" });
        await page.sleep(300);
        const ms = await measureFloat(page, ".ms-sheet", ".ms-sheet .ms-scroll");
        t.ok(ms && !ms.clipX && !ms.clipY, `${vp.name} ModelSheet fits viewport (${JSON.stringify(ms)})`);

        await page.goto("/next/#briefing/US");
        await page.waitFor(() => {
          const h1 = document.querySelector(".br-page .br-h1")?.textContent?.trim() || "";
          return h1 && h1 !== "Loading…" && h1 !== "No synced forecast hubs";
        }, { timeout: 20000, message: "Briefing loaded" });
        await page.sleep(250);
        const br = await page.eval(() => ({
          docX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
          brX: (() => {
            const p = document.querySelector(".br-page");
            return p ? Math.max(0, p.scrollWidth - p.clientWidth) : 0;
          })(),
        }));
        t.eq(br.docX, 0, `${vp.name} Briefing docOverflow`);
        t.ok(br.brX <= 2, `${vp.name} Briefing page overflow (${br.brX})`);
      }
    });

    await t.step("no console errors", async () => {
      t.eq(page.errors, [], "uncaught exceptions and console errors");
    });
  } finally {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
    }).catch(() => {});
  }
}
