/* The chart core on its own, on real data: manifest → one fan → layoutFan + drawFan per frame, with a
 * TimeNav bound to the canvas. No controls, no glass.
 * ?date=2025-12-27 &location=US &season=2025-2026 &target= &models=a,b,c (charted by slot; default the
 * first three recommended) &chrome=70,70 (room for the top and bottom chrome, px)
 * Keys: ← → step, = - 0 zoom, t theme, l level (95 · 80 · 50 · none), r rulers, o outcome. */
import { loadManifest, loadFan } from "../lib/api.js";
import { layoutFan, labelAt } from "../chart/layout.js";
import { drawFan, canvasMeasure, chartFonts } from "../chart/render.js";
import { TimeNav } from "../chart/timenav.js";
import { niceMax, WEEK } from "../lib/scale.js";
import { valueFormat } from "../lib/format.js";

const q = new URLSearchParams(location.search);
const canvas = document.getElementById("chart"), status = document.getElementById("status");
// the room the prototype's chrome takes, so the two compare 1:1
const [CHROME_TOP, CHROME_BOTTOM] = (q.get("chrome") || "70,70").split(",").map(Number);
const LEVELS = [0.95, 0.8, 0.5, 0];

status.textContent = "Loading";
const manifest = await loadManifest();
const season = q.get("season") || "2025-2026", place = q.get("location") || "US";
const target = manifest.targetById.get(q.get("target")) || manifest.targetById.get(manifest.default_target);
const fan = await loadFan(target.id, season, place);
status.textContent = "";

const picks = q.get("models")?.split(",") ?? manifest.recommended.filter((id) => id !== manifest.baseline && fan.present.has(id)).slice(0, 3);
const ids = [...picks, manifest.baseline].filter((id) => fan.present.has(id));
const models = ids.map((id, i) => ({ id, slot: id === manifest.baseline ? "baseline" : i, label: manifest.label(id, ids) }));
const yTop = niceMax(fan.yMax(ids) * 1.08, 5);
const format = valueFormat(target), measure = canvasMeasure();
const state = { level: 0, rulers: false, outcome: true, hover: null };

let scene = null;
function draw() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  scene = layoutFan(fan, {
    models, t: nav.T, domain: nav.domain(), ymax: yTop / nav.heightZoom,
    pad: { l: 64, r: 168 + (56 - 168) * nav.mix, t: CHROME_TOP + 24, b: CHROME_BOTTOM + 48 }, topClear: CHROME_TOP,
    level: LEVELS[state.level], rulers: state.rulers ? 1 : 0, outcome: state.outcome,
    hover: nav.moving ? null : state.hover, format, measure, fonts: chartFonts(),
  }, w, h);
  drawFan(canvas, scene);
}

const start = fan.indexOf(q.get("date") || "2025-12-27");
const nav = new TimeNav({
  surface: canvas, dates: fan.dates, index: start >= 0 ? start : fan.dates.length - 1, season: fan.window,
  scale: () => scene.x,
  ignore: (e) => !!(scene && labelAt(scene, e.offsetX, e.offsetY)),
  onFrame: draw,
});
draw();

// hover snaps to the nearest week anywhere in the view
canvas.addEventListener("pointermove", (e) => {
  if (!scene || nav.moving) return;
  const t0 = fan.dates[0], t = t0 + Math.round((scene.x.invert(e.offsetX) - t0) / WEEK) * WEEK;
  if (state.hover?.t !== t) { state.hover = { t }; nav.request(); }
});
canvas.addEventListener("pointerleave", () => { state.hover = null; nav.request(); });

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); nav.step(k === "ArrowLeft" ? -1 : 1); }
  else if (k === "=" || k === "+") nav.zoomIn();
  else if (k === "-") nav.zoomOut();
  else if (k === "0") nav.reset();
  else if (k === "t") { const root = document.documentElement; root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light"; nav.request(); }
  else if (k === "l") { state.level = (state.level + 1) % LEVELS.length; nav.request(); }
  else if (k === "r") { state.rulers = !state.rulers; nav.request(); }
  else if (k === "o") { state.outcome = !state.outcome; nav.request(); }
});
new ResizeObserver(() => nav.request()).observe(canvas);
document.fonts?.ready.then(() => nav.request());

window.__viz = { manifest, fan, nav, chart: { get scene() { return scene; }, state, draw } };
