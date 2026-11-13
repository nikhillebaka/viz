/* Score study: the scores section on its own (lib/evaluation.js), on real scores for three seasons.
 * The same section sits under the fan chart on studies/intervals-refine.html. */
import { LiquidGlass } from "../lib/glass.js";
import { Segmented } from "../lib/controls.js";
import { loadManifest } from "../lib/scores.js";
import { mountScores } from "../lib/evaluation.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
root.dataset.theme = store.get("viz-ds-theme") || "dark";

const man = await loadManifest("../data/");
const CHARTED = { "UMass-flusion": 0, "UMass-gbqr_4src": 1, "UMass-AR2": 2, "UMass-timesfm3_nhsn": 3, "axial-tfm_L4v5": 4 };
const SELECTED = [...Object.keys(CHARTED), "UMass-gbqr_4src_spatial", "UMass-flusion_4src_spatial", "UMass-AR6_pooled", "UMass-trends_ensemble", "UMass-chronos_small", "UMass-gbqr_1src", "UMass-WISAR6_fourthroot_adaptive_t"];

const ev = mountScores($("ev"), {
  man, seasons: [man.seasons.at(-1).id],
  selected: () => SELECTED, slotOf: (m) => CHARTED[m] ?? null, seriesColor: (slot) => `var(--series-${slot + 1})`,
  onPreview: (m) => ev.highlight(m),
});
await ev.update();

for (const id of ["back", "theme"]) new LiquidGlass($(id), {});
new Segmented($("t-rows"), { label: "Rows", value: "selected", items: [{ value: "selected", label: `Selected ${SELECTED.length}` }, { value: "all", label: "All models" }], onChange: (v) => { ev.state.rows = v; ev.redraw(); } });
$("theme").addEventListener("click", () => { root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark"; store.set("viz-ds-theme", root.dataset.theme); ev.redraw(); requestAnimationFrame(() => LiquidGlass.updateAll()); });
window.__ev = ev;
