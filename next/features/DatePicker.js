/* The date picker: opened by the date
 * stepper's label. Season chips (newest first, the chart's season on), then that season's forecast rounds
 * as a calendar, one row per month; "Latest" goes to the newest round there is. Nothing else per date.
 * Keys: ← → ↑ ↓ move through the days (↑ ↓ by row, keeping the column where possible), a letter jumps to
 * the first month starting with it, Enter / Space go, Escape closes. The chart's ← → stand down meanwhile
 * (the popover doesn't opt in to time keys). */
import { h, on } from "../lib/dom.js";
import { parseIso, toIso } from "../lib/scale.js";
import { fmtLong } from "../lib/format.js";
import { openPopover, focusQuietly } from "../ui/floating.js";

const F_MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" });
const WIDTH = 340;

/**
 * @param {HTMLElement} anchor the stepper's label
 * @param {{ manifest: import("../lib/api.js").Manifest, store: object, chart: import("./FanChart.js").FanChart }} ctx
 * @returns {object | null} the layer, or null when this call closed it
 */
export function openDatePicker(anchor, { manifest, store, chart }) {
  const seasons = manifest.seasons.filter((s) => s.rounds?.length);
  // the store's date is the round itself (the chart's timeline snaps off-grid rounds to its weeks), and
  // it is already the destination while another season loads
  const current = () => {
    const iso = store.get().date || (chart?.fan ? toIso(chart.week()) : "");
    return { iso, season: manifest.seasonOf(iso) ?? chart?.fan?.season };
  };
  return openPopover(anchor, {
    width: WIDTH, placement: "top", className: "dp", title: "",
    content(body, layer) {
      let shown = current().season;
      const pick = (iso) => { layer.close(true); store.set({ date: iso }); };

      const chips = h("div", { class: "dp-seasons", role: "group", "aria-label": "Season" });
      const grid = h("div", { class: "dp-grid", role: "grid" });
      const latest = manifest.allRounds.at(-1)?.iso;
      const foot = h("div", { class: "dp-foot" },
        h("button", { type: "button", class: "c-link", onclick: () => latest && pick(latest), "aria-label": latest ? `Latest: ${fmtLong(parseIso(latest))}` : "Latest" }, "Latest"));
      body.append(chips, grid, foot);

      const paint = () => {
        const cur = current();
        chips.replaceChildren(...[...seasons].reverse().map((s) => h("button", {
          type: "button", class: ["c-chip", s.id === shown && "on"], "aria-pressed": String(s.id === shown),
          onclick: () => { if (shown !== s.id) { shown = s.id; paint(); } },
        }, s.label || s.id)));
        const season = seasons.find((s) => s.id === shown);
        grid.setAttribute("aria-label", `${season?.label ?? shown} forecast dates`);
        const months = new Map();
        for (const iso of season?.rounds ?? []) {
          const k = iso.slice(0, 7);
          if (!months.has(k)) months.set(k, []);
          months.get(k).push(iso);
        }
        grid.replaceChildren(...[...months].map(([ym, isos]) => h("div", { class: "dp-row", role: "row" },
          h("span", { class: "dp-month", role: "rowheader" }, F_MONTH.format(parseIso(`${ym}-01`))),
          isos.map((iso) => h("button", {
            type: "button", class: ["c-tile", "plain", iso === cur.iso && "on"], role: "gridcell",
            "data-iso": iso, "aria-label": fmtLong(parseIso(iso)), "aria-selected": String(iso === cur.iso),
            onclick: () => pick(iso),
          }, String(+iso.slice(8)))))));
      };
      paint();

      // ← → through the days in order; ↑ ↓ to the row above or below, same column (or its last day)
      on(body, "keydown", (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const rows = [...grid.querySelectorAll(".dp-row")].map((r) => [...r.querySelectorAll(".c-tile")]);
        const days = rows.flat(), at = days.indexOf(document.activeElement);
        const go = (el) => { if (el) { e.preventDefault(); e.stopPropagation(); focusQuietly(el); } };
        if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
          if (at < 0) { go(grid.querySelector(".c-tile.on") || days[0]); return; }
          if (e.key === "ArrowLeft") go(days[Math.max(0, at - 1)]);
          else if (e.key === "ArrowRight") go(days[Math.min(days.length - 1, at + 1)]);
          else {
            const r = rows.findIndex((row) => row.includes(document.activeElement)), c = rows[r].indexOf(document.activeElement);
            const to = rows[r + (e.key === "ArrowUp" ? -1 : 1)];
            go(to ? to[Math.min(c, to.length - 1)] : document.activeElement);
          }
        } else if (/^[a-z]$/i.test(e.key)) {
          const row = [...grid.querySelectorAll(".dp-row")].find((r) => r.firstChild.textContent.toLowerCase().startsWith(e.key.toLowerCase()));
          go(row?.querySelector(".c-tile"));
        }
      });
      // focus the chart's round (else the season's first) once the popover is placed
      requestAnimationFrame(() => focusQuietly(grid.querySelector(".c-tile.on") || grid.querySelector(".c-tile")));
    },
  });
}
