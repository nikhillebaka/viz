/* Harness for the model and location pickers on the real manifest. Not part of the app. */
import { h } from "../lib/dom.js";
import { createStore } from "../lib/store.js";
import { loadManifest, loadFan } from "../lib/api.js";
import { parseIso } from "../lib/scale.js";
import { glass, Glass } from "../ui/glass.js";
import { icon, pill, timeKeys } from "../ui/controls.js";
import * as S from "../features/selection.js";
import { openModelPicker } from "../features/ModelPicker.js";
import { openLocationPicker } from "../features/LocationPicker.js";

const $ = (id) => document.getElementById(id);
const manifest = await loadManifest();
const rounds = manifest.allRounds;

// a realistic state: the latest round, three recommended models (not the baseline) and six more
const rec = manifest.recommended.filter((id) => id !== manifest.baseline && manifest.modelById.has(id)).slice(0, 3);
const more = ["UMass-gbqr", "UMass-AR2", "flusight:FluSight-ensemble", "flusight:ACCIDDA-Chromantis", "UMass-gbqr_1src", "axial-tfm_L4v5"].filter((id) => manifest.modelById.has(id));
const store = createStore({
  target: manifest.default_target, location: "US", date: rounds.at(-1).iso,
  sel: S.create({ selected: [...rec, ...more] }), level: 0.95, rulers: false, outcome: true, focus: null, theme: "dark",
});

/* ?chart=1: a stand-in for FanChart with the real fan for the store's target, season and place */
let chart = null;
if (new URLSearchParams(location.search).has("chart")) {
  const guide = $("guide");
  chart = {
    fan: null,
    week: () => parseIso(store.get().date),
    setInset: (px) => { guide.hidden = !px; guide.style.left = `${px}px`; chart.inset = px; render(); },
    preview: (on) => { chart.previewing = on; render(); },
  };
  const load = () => {
    const s = store.get(), season = manifest.seasonOf(s.date);
    loadFan(s.target, season, s.location).then((f) => { chart.fan = f; }, () => { chart.fan = null; });
  };
  store.select(["target", "date", "location"], load);
  load();
}
const ctx = { manifest, store, chart };

/* ---------- bubbles ---------- */
const models = pill({ chevron: true, label: " ", dots: [] });
const place = pill({ chevron: true, label: " " });
const theme = pill({ icon: icon.theme, ariaLabel: "Theme" });
models.addEventListener("click", () => openModelPicker(models, ctx));
place.addEventListener("click", () => openLocationPicker(place, ctx));
theme.addEventListener("click", toggleTheme);
$("tl").append(models, place);
$("tr").append(theme);

function renderPills() {
  const { sel, location: loc } = store.get();
  const dots = models.querySelector(".c-dots");
  dots.replaceChildren(...[...sel.charted].sort((a, b) => a.slot - b.slot).map((c) => h("i", { style: { background: `var(--series-${(c.slot % S.COLORS) + 1})` } })));
  dots.hidden = !sel.charted.length;
  models.querySelector(".c-pill-label").textContent = `${sel.selected.length} models`;
  place.querySelector(".c-pill-label").textContent = manifest.locationById.get(loc)?.name || loc;
}
renderPills();
[models, place, theme].forEach((p) => glass(p));

function toggleTheme() {
  const t = store.get().theme === "dark" ? "light" : "dark";
  store.set({ theme: t });
  document.documentElement.dataset.theme = t;
  Glass.refresh();
}

/* ---------- keys: t theme, a Show all, ← → the round (as the chart does, also while the picker is open) ---------- */
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "t") toggleTheme();
  else if (e.key === "a") store.set({ sel: S.setShowAll(store.get().sel, !store.get().sel.showAll) });
});
timeKeys((dir) => {
  const i = rounds.findIndex((r) => r.iso === store.get().date);
  const n = Math.max(0, Math.min(rounds.length - 1, i + dir));
  store.set({ date: rounds[n].iso });
});

/* ---------- the readout: what the store holds ---------- */
function render() {
  const { sel, location: loc, date, target } = store.get();
  const name = (id) => manifest.label(id);
  const rowsOf = [
    ["location", `${manifest.locationById.get(loc)?.name || loc} (${loc})`],
    ["date", `${date} · ${manifest.seasonOf(date)} · ${target}`],
    ["selected", `${sel.selected.length}: ${sel.selected.map(name).join(", ") || "none"}`],
    ["charted", S.chartedBySlot(sel).map((id, i) => `${i + 1} ${id ? name(id) : "–"}`).join(" · ") || "none"],
    ["taken off", sel.taken.map(name).join(", ") || "none"],
    ["show all · baseline", `${sel.showAll ? "on" : "off"} · ${sel.baseline ? "on" : "off"}`],
  ];
  if (chart) rowsOf.push(["chart", `inset ${chart.inset ?? 0} · preview ${chart.previewing ? "on" : "off"}`]);
  $("state").replaceChildren(h("table", null, rowsOf.map(([k, v]) => h("tr", null, h("td", null, k), h("td", null, v)))));
}
store.on(() => { render(); renderPills(); });
render();
