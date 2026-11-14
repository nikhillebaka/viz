/* The kit page: every control in every state, over an animated canvas (WebGL glass) and the paper
 * (backdrop glass). Visual reference for consistency; not part of the app. */
import { h, cssColor } from "../lib/dom.js";
import { glass, Glass } from "../ui/glass.js";
import { openPopover, openMenu, tooltip } from "../ui/floating.js";
import { icon, pill, Stepper, Segmented, toast } from "../ui/controls.js";

const $ = (id) => document.getElementById(id);
const canvas = $("chart");
const series = [1, 2, 3, 4, 5].map((i) => `var(--series-${i})`);

/* ---------- data for the demos ---------- */
const WEEK = 7 * 864e5;
const weeks = Array.from({ length: 34 }, (_, i) => Date.UTC(2025, 9, 11) + i * WEEK);
const fmtLong = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const format = { long: (t) => fmtLong.format(t) };
const models = [
  { name: "flusion", sub: "UMass · ensemble", c: 0 },
  { name: "gbqr_4src", sub: "UMass · gradient boosting", c: 1 },
  { name: "ARIMA_pooled", sub: "CMU · statistical", c: 2 },
  { name: "axial-tfm", sub: "Local · transformer", c: 3 },
  { name: "FluSight-baseline", sub: "Hub · baseline", c: null },
];
const states = ["AK", "ME", "VT", "NH", "WA", "ID", "MT", "ND", "MN", "WI", "MI", "NY", "MA", "OR", "NV", "WY", "SD", "IA", "IL", "IN", "OH", "PA", "NJ", "CT"];

/* ---------- builders shared by the live popovers and the static panel ---------- */
const searchRow = (placeholder) => h("label", { class: "c-search", html: icon.search }, h("input", { type: "search", placeholder, "aria-label": placeholder, autocomplete: "off", spellcheck: "false" }));
const section = (title, { count, action, collapsible } = {}) => h("div", { class: "c-section" },
  h(collapsible ? "button" : "span", { class: "c-section-title", type: collapsible ? "button" : null, "aria-expanded": collapsible ? "true" : null,
    html: collapsible ? icon.chevronDown : null,
    onclick: collapsible ? (e) => { const b = e.currentTarget; b.setAttribute("aria-expanded", String(b.getAttribute("aria-expanded") !== "true")); } : null },
  h("span", null, title), count != null ? h("span", { class: "c-section-count" }, count) : null),
  action ? h("button", { type: "button", class: "c-section-action" }, action) : null);
const row = (m, selected, two = true) => h("button", {
  type: "button", class: ["c-row", two && "two"], "aria-checked": String(selected), role: "menuitemcheckbox",
  onclick: (e) => { const b = e.currentTarget; b.setAttribute("aria-checked", String(b.getAttribute("aria-checked") !== "true")); },
},
h("span", { class: "c-row-lead" }, h("i", { class: "c-dot", style: { background: m.c == null ? "var(--series-baseline)" : series[m.c] } })),
h("span", { class: "c-row-text" }, h("span", { class: "c-row-label" }, m.name), two ? h("span", { class: "c-row-sub" }, m.sub) : null),
h("span", { class: "c-row-check", html: icon.check }));
const modelList = (body) => body.append(
  searchRow("Search models"),
  section("Selected", { count: 3, action: "Clear" }),
  ...models.slice(0, 3).map((m) => row(m, true)),
  section("All models", { count: 12, collapsible: true }),
  row(models[3], false), row(models[4], false, false));
const toggleOn = (cls) => (e) => { const b = e.target.closest(cls); if (!b) return; b.parentElement.querySelectorAll(cls).forEach((x) => x.classList.toggle("on", x === b)); };
const placeList = (body) => body.append(
  searchRow("Search places"),
  section("Recent"),
  h("div", { class: "k-chips", onclick: toggleOn(".c-chip") }, ["US", "Massachusetts", "New York", "Texas"].map((p, i) => h("button", { type: "button", class: ["c-chip", i === 0 && "on"] }, p))),
  section("States"),
  h("div", { class: "c-tile-grid k-tiles", onclick: toggleOn(".c-tile") }, states.map((s) => h("button", { type: "button", class: ["c-tile", s === "MA" && "on"] }, s))));

/* ---------- fixed bubbles: backdrop glass ---------- */
const modelsPill = pill({ label: "5 models", dots: series, chevron: true });
const placePill = pill({ label: "United States", chevron: true });
const themePill = pill({ icon: icon.theme, ariaLabel: "Theme" });
const morePill = pill({ icon: icon.more, ariaLabel: "More" });
$("top-left").append(modelsPill, placePill);
$("top-right").append(themePill, morePill);
modelsPill.onclick = () => openPopover(modelsPill, { morph: true, content: modelList });
placePill.onclick = () => openPopover(placePill, { morph: true, content: placeList });
themePill.onclick = () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
  Glass.refresh();
};
morePill.onclick = () => openMenu(morePill, { placement: "bottom-end", label: "More", items: [
  { header: "Data" }, { label: "Sources", onSelect: () => toast("Sources") }, { label: "Download CSV", shortcut: "⌘S", onSelect: () => toast("Downloaded") },
  "-", { label: "Keyboard shortcuts", onSelect: () => toast("Shortcuts") }, { label: "Disabled item", disabled: true },
] });
tooltip(themePill, "Light or dark");
tooltip(morePill, "More", { placement: "bottom" });
[modelsPill, placePill, themePill, morePill].forEach((p) => glass(p));

/* ---------- chart bubbles: canvas glass ---------- */
let level = 95, rulers = false;
const levelLabel = () => (level ? `${level}% interval` : "No interval");
const intervalPill = pill({ label: levelLabel(), chevron: true });
intervalPill.onclick = () => openMenu(intervalPill, { placement: "top-start", label: "Interval", items: [
  ...[95, 80, 50, 0].map((v) => ({ label: v ? `${v}%` : "None", value: v, checked: level === v, onSelect: (x) => { level = x; intervalPill.querySelector(".c-pill-label").textContent = levelLabel(); } })),
  "-", { label: "Width rulers", toggle: true, checked: rulers, onSelect: () => (rulers = !rulers) },
] });
$("stage-bl").append(intervalPill);
const stepEl = h("div");
$("stage-bc").append(stepEl);
new Stepper(stepEl, { values: weeks, index: 11, format, label: "Forecast date" });
const note = h("div", { class: "c-note" }, h("span", null, "Showing 5 of 9"), h("button", { type: "button", class: "c-link", onclick: () => toast("All 9 shown", { action: { label: "Undo" } }) }, "Show all"));
$("stage-tr").append(note);
const segEl = h("div");
$("stage-br").append(segEl);
new Segmented(segEl, { label: "Scale", items: [{ value: "lin", label: "Linear" }, { value: "log", label: "Log" }, { value: "rate", label: "Per 100k" }], value: "lin" });
[intervalPill, stepEl, note, segEl].forEach((el) => glass(el, { canvas }));

/* ---------- pill states (over the paper) ---------- */
const variants = [
  ["Text", () => pill({ label: "Flu admissions" })],
  ["Dots · chevron", () => pill({ label: "5 models", dots: series, chevron: true })],
  ["Icon", () => pill({ icon: icon.theme, ariaLabel: "Theme" })],
  ["Small", () => pill({ label: "Show all", size: "sm" })],
  ["Small icon", () => pill({ icon: icon.close, size: "sm", ariaLabel: "Close" })],
];
const statesEl = $("states");
statesEl.append(h("span"), ...["Default", "Hover", "Pressed", "On", "Disabled"].map((s) => h("span", { class: "k-h" }, s)));
for (const [name, make] of variants) {
  statesEl.append(h("span", { class: "k-h" }, name));
  const cells = [make(), make(), make(), make(), make()];
  cells[1].classList.add("is-hover");
  cells[2].classList.add("is-pressed");
  cells[3].setAttribute("aria-pressed", "true");
  cells[4].setAttribute("aria-disabled", "true");
  statesEl.append(...cells.map((c) => h("span", null, c)));
  cells.forEach((c) => glass(c));
}

/* ---------- stepper and segmented on the paper ---------- */
const s2 = h("div"), g2 = h("div");
$("inline-controls").append(s2, g2);
new Stepper(s2, { values: weeks, index: 0, format, label: "Date", canEdge: (d) => d < 0, edge: (d) => { toast(d < 0 ? "Previous season" : "Next season"); return true; } });
new Segmented(g2, { label: "View", items: [{ value: "fan", label: "Fan" }, { value: "scores", label: "Scores" }], value: "fan" });
glass(s2); glass(g2);

/* ---------- layer triggers ---------- */
const triggers = [
  pill({ label: "Menu", chevron: true, onClick: (e) => openMenu(e.currentTarget, { label: "Sort", items: [
    { label: "Relative WIS", value: "wis", checked: true }, { label: "Coverage", value: "cov", checked: false }, { label: "Name", value: "name", checked: false },
    "-", { label: "Show baseline", toggle: true, checked: true },
  ] }) }),
  pill({ label: "Popover", onClick: (e) => openPopover(e.currentTarget, { title: "Location", content: placeList }) }),
  pill({ label: "Morph popover", chevron: true, onClick: (e) => openPopover(e.currentTarget, { morph: true, content: modelList }) }),
  pill({ label: "Hover for tooltip" }),
  pill({ label: "Toast", onClick: () => toast("Copied link") }),
  pill({ label: "Toast with action", onClick: () => toast("3 models removed", { action: { label: "Undo" } }) }),
];
tooltip(triggers[3], "Tooltips are solid · 500 ms delay");
$("layers").append(...triggers);
triggers.forEach((t) => glass(t));

/* ---------- static panels ---------- */
const panel = h("div", { class: "c-panel k-panel" }, h("div", { class: "c-float-body" }));
modelList(panel.firstChild);
panel.firstChild.append(
  section("Chips"),
  h("div", { class: "k-chips", onclick: toggleOn(".c-chip") }, ["2025–26", "2024–25", "2023–24"].map((s, i) => h("button", { type: "button", class: ["c-chip", i === 0 && "on"] }, s))),
  section("Tiles"),
  h("div", { class: "c-tile-grid k-tiles", onclick: toggleOn(".c-tile") }, [...states.slice(0, 6).map((s) => [s, ""]), ["13", "plain"], ["20", "plain"]].map(([s, v], i) => h("button", { type: "button", class: ["c-tile", v, i === 2 && "on"] }, s))),
  section("Checks"),
  h("div", { class: "k-checks" },
    ...[["Baseline", true], ["Rulers", false]].map(([l, on]) => h("label", { "aria-checked": String(on), onclick: (e) => { const x = e.currentTarget; x.setAttribute("aria-checked", String(x.getAttribute("aria-checked") !== "true")); } }, h("span", { class: "c-check" }), l))));
const menu = h("div", { class: "c-panel c-menu k-menu", role: "menu" }, h("div", { class: "c-float-body" },
  h("div", { class: "c-menu-header" }, "Interval"),
  ...["95%", "80%", "50%", "None"].map((l, i) => h("button", { type: "button", class: "c-menu-item", role: "menuitemradio", "aria-checked": String(i === 0) },
    h("span", { class: "c-menu-check", html: i === 0 ? icon.check : "" }), h("span", { class: "c-menu-label" }, l))),
  h("div", { class: "c-menu-sep" }),
  h("button", { type: "button", class: "c-menu-item", role: "menuitemcheckbox", "aria-checked": "true" }, h("span", { class: "c-menu-check", html: icon.check }), h("span", { class: "c-menu-label" }, "Width rulers"), h("kbd", null, "R")),
  h("button", { type: "button", class: "c-menu-item danger", role: "menuitem" }, h("span", { class: "c-menu-check" }), h("span", { class: "c-menu-label" }, "Remove all"))));
$("parts").append(panel, menu);
glass(panel, { panel: true }); glass(menu, { panel: true });

/* ---------- solid parts ---------- */
const readout = h("div", { class: "c-readout" },
  h("div", { class: "c-readout-head" }, h("span", null, "Jan 3 · 1 wk ahead"), h("span", null, "95%")),
  h("table", null, models.slice(0, 4).map((m, i) => h("tr", { class: i === 3 ? "dim" : null },
    h("td", null, h("span", { class: "c-readout-name" }, h("i", { class: "c-dot", style: { background: series[m.c] } }), m.name)),
    h("td", { class: "num" }, (24310 + i * 1873).toLocaleString("en-US")),
    h("td", { class: "num quiet" }, `${(18200 + i * 900).toLocaleString("en-US")}–${(31400 + i * 1200).toLocaleString("en-US")}`)))),
  h("div", { class: "c-readout-foot" }, h("span", null, "Observed"), h("span", { class: "num" }, "26,118")));
const note2 = h("div", { class: "c-note" }, h("span", null, "2 not in 2023–24"), h("button", { type: "button", class: "c-link" }, "Show"));
const tip = h("div", { class: "c-tooltip k-tip" }, "Light or dark");
$("solid").append(readout, note2, tip);
glass(note2);

/* ---------- the animated chart ---------- */
function resize() {
  const dpr = devicePixelRatio || 1, r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
}
function draw(t) {
  const ctx = canvas.getContext("2d"), dpr = devicePixelRatio || 1;
  const w = canvas.width / dpr, hgt = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = cssColor("var(--surface-paper)"); ctx.fillRect(0, 0, w, hgt);
  ctx.lineWidth = 1; ctx.strokeStyle = cssColor("var(--line-hairline)");
  ctx.fillStyle = cssColor("var(--ink-tertiary)"); ctx.font = `10.5px "Geist Mono", monospace`;
  for (let i = 1; i < 6; i++) { const y = Math.round((hgt * i) / 6) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); ctx.fillText(`${(6 - i) * 10}k`, 12, y - 4); }
  for (let x = 80; x < w; x += 160) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, hgt); ctx.stroke(); }
  ctx.fillStyle = cssColor("var(--ink-secondary)"); ctx.font = `600 22px Inter, sans-serif`;
  ctx.fillText("Refraction check · text bends at the rim", w / 2 - 210, hgt - 90);
  ctx.lineWidth = 1.75;
  series.forEach((c, k) => {
    ctx.strokeStyle = cssColor(c); ctx.beginPath();
    for (let x = 0; x <= w; x += 6) { const y = hgt * (0.3 + k * 0.1) + Math.sin(x / 90 + t / 900 + k) * 40 * Math.cos(t / 2500 + k); x ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
  });
  const ox = (t / 12) % w;
  ctx.strokeStyle = cssColor("var(--ink-primary)"); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(ox, 0); ctx.lineTo(ox, hgt); ctx.stroke();
  Glass.frame();
  requestAnimationFrame(draw);
}
new ResizeObserver(resize).observe(canvas);
resize();
requestAnimationFrame(draw);
