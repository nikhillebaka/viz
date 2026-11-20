/* The chart's own bubbles: they belong to the chart view and scroll away with it,
 * so they are glass in canvas mode (the WebGL pass refracts the chart under them).
 *  - bottom left: the interval pill, "95% interval ▾" / "95 · 50% intervals" / "No interval", and its
 *    menu (any combination of levels);
 *  - bottom centre: the date stepper, which walks forecast rounds and crosses seasons at its ends (its
 *    label opens the date picker);
 *  - under the top bubbles at the right: "Showing 5 of 9 · Show all", only when more are selected than charted;
 *  - at the left or right edge: "← Dec 27 forecast" while the forecast is panned off-screen. */
import { h } from "../../lib/dom.js";
import { fmtDay, fmtLong } from "../../lib/format.js";
import { glass } from "../../ui/glass.js";
import { openMenu } from "../../ui/floating.js";
import { pill, icon, Stepper } from "../../ui/controls.js";
import { setShowAll } from "../selection.js";
import { openDatePicker } from "../DatePicker.js";
import { LEVELS, parseLevels } from "../url.js";
import { levelsText } from "./readout.js";

/* The kit's Stepper, stepping through forecast rounds rather than every week of the timeline: the chart
 * decides where a step lands (the next week with a round, or the next season). */
class RoundStepper extends Stepper {
  constructor(el, o, stepBy) { super(el, o); this.stepBy = stepBy; }
  step(d) { this.stepBy(d); }
  /** the end-of-the-line nudge, when there is nowhere further to go */
  nudge(d) { this.go(d < 0 ? -1 : this.values.length); }
}

export class ChartBubbles {
  /**
   * @param {import("../FanChart.js").FanChart} chart
   * @param {number} index the timeline week shown first
   */
  constructor(chart, index) {
    this.chart = chart;
    const { view, canvas, ctx } = chart;
    const zone = (z) => h("div", { class: "c-zone", "data-zone": z });
    this.zones = { bl: zone("bl"), bc: zone("bc"), br: zone("br") };
    this.chrome = h("div", { class: "c-chrome fc-chrome" }, this.zones.bl, this.zones.bc, this.zones.br);

    this.interval = pill({ label: "95% interval", chevron: true, className: "fc-interval", onClick: () => this.#openInterval() });
    this.interval.setAttribute("aria-haspopup", "menu");
    this.zones.bl.append(this.interval);

    this.stepEl = h("div", { class: "fc-stepper" });
    this.zones.bc.append(this.stepEl);

    this.noteText = h("span");
    this.noteLink = h("button", { type: "button", class: "c-link", onclick: () => this.#toggleAll() });
    this.note = h("div", { class: "c-note fc-note", inert: true }, this.noteText, this.noteLink);
    this.noteClear = -Infinity;

    // ← Dec 27 forecast  /  Dec 27 forecast →: the arrow points at where the forecast is
    this.recenter = pill({ label: " ", size: "sm", className: "fc-recenter", onClick: () => chart.nav?.recenter() });
    this.recenterIcons = [h("span", { class: "fc-recenter-arrow", html: icon.left, hidden: true }), h("span", { class: "fc-recenter-arrow", html: icon.right, hidden: true })];
    this.recenter.prepend(this.recenterIcons[0]);
    this.recenter.append(this.recenterIcons[1]);
    this.recenter.inert = true;
    this.recenterSide = null;
    this.recenterText = "";

    // the season a pull past the end will cross into (TimeNav `pull`); quiet ink until the pull is enough
    this.cross = h("div", { class: "fc-cross", "aria-hidden": "true" }, h("span", { class: "fc-cross-arrow" }), h("span", { class: "fc-cross-label" }));
    this.crossKey = "";
    view.append(this.chrome, this.note, this.recenter, this.cross);
    this.stepper = new RoundStepper(this.stepEl, {
      values: chart.fan.dates, index, label: "Forecast date",
      format: { long: fmtLong, short: fmtDay },
      onChange: (i) => chart.nav?.goTo(i),
      canEdge: (d) => !!chart.neighbour(d),
      onLabel: (btn) => openDatePicker(btn, ctx),
    }, (d) => chart.step(d));
    this.glass = [this.interval, this.stepEl, this.note, this.recenter].map((el) => glass(el, { canvas }));
    this.sync(ctx.store.get());
  }

  /** A new timeline (another season): the stepper's values, at week i, without a roll. */
  setDates(dates, i) { this.stepper.setValues(dates, i); }
  /** The chart is heading to week i: the stepper's label rolls to it. */
  show(i) { this.stepper.show(i); }
  /** Nowhere further to go in direction d. */
  nudge(d) { this.stepper.nudge(d); }

  /** The interval pill's label and the "Showing 5 of 9" note, from the store. */
  sync(s) {
    const L = s.levels || [];
    const label = !L.length ? "No interval" : `${levelsText(L)} interval${L.length > 1 ? "s" : ""}`;
    const lab = this.interval.querySelector(".c-pill-label");
    if (lab.textContent !== label) lab.textContent = label;
    const n = s.sel.selected.length, on = s.sel.charted.length, show = n > on;
    if (show) {
      const text = s.sel.showAll ? `Showing all ${n} ·` : `Showing ${on} of ${n} ·`;
      const link = s.sel.showAll ? `Show ${on}` : "Show all";
      if (this.noteText.textContent !== text) this.noteText.textContent = text;
      if (this.noteLink.textContent !== link) this.noteLink.textContent = link;
    }
    if (this.note.classList.contains("is-shown") !== show) {
      this.note.classList.toggle("is-shown", show);
      this.note.inert = !show;
      this.glass[2]?.update();
    }
    this.measureNote();
  }

  /** Cache the note pill's bottom offset outside animation frames (no DOM reads during draw). */
  measureNote() {
    this.noteClear = this.note.classList.contains("is-shown") ? this.note.offsetTop + this.note.offsetHeight : -Infinity;
  }

  /** After every frame: the recenter pill, when the forecast is panned off-screen; the crossing hint. */
  frame(scene) {
    this.#crossHint();
    const xr = scene.x(scene.ref);
    const side = xr < 0 ? "left" : xr > scene.w ? "right" : null;
    if (side) {
      const day = fmtDay(this.chart.week());
      const text = `${day} forecast`;
      if (text !== this.recenterText) { this.recenterText = text; this.recenter.querySelector(".c-pill-label").textContent = text; }
      if (side !== this.recenterSide) {
        this.recenter.classList.toggle("left", side === "left"); this.recenter.classList.toggle("right", side === "right");
        this.recenterIcons[0].hidden = side !== "left"; this.recenterIcons[1].hidden = side !== "right";
        this.recenter.setAttribute("aria-label", `Back to the ${day} forecast`);
        this.glass[3]?.update();
      }
    }
    const shown = !!side;
    if (shown !== !!this.recenterSide) {
      this.recenter.classList.toggle("is-shown", shown);
      this.recenter.inert = !shown;
      this.glass[3]?.update();
    }
    this.recenterSide = side;
  }

  #toggleAll() {
    const { store } = this.chart.ctx;
    store.set({ sel: setShowAll(store.get().sel, !store.get().sel.showAll) });
  }

  #openInterval() {
    const { store } = this.chart.ctx, s = store.get();
    openMenu(this.interval, {
      placement: "top-start", label: "Interval",
      items: [
        ...LEVELS.map((v) => ({
          label: `${Math.round(v * 100)}%`, toggle: true, checked: s.levels.includes(v),
          onSelect: () => { const cur = store.get().levels; store.set({ levels: parseLevels(cur.includes(v) ? cur.filter((l) => l !== v) : [...cur, v]) }); },
        })),
        "-",
        { label: "Width rulers", toggle: true, checked: s.rulers, onSelect: () => store.set({ rulers: !store.get().rulers }) },
        { label: "Outcome", toggle: true, checked: s.outcome, onSelect: () => store.set({ outcome: !store.get().outcome }) },
        ...(() => {
          const { manifest } = this.chart.ctx;
          const targetMeta = manifest.targetById.get(s.target);
          const anyMarkedSample = manifest.models.some((m) => m.has_samples);
          const anyChartedSample = s.sel.charted.some((c) => manifest.modelById.get(c.id)?.has_samples)
            || !!(s.sel.baseline && manifest.baseline && manifest.modelById.get(manifest.baseline)?.has_samples);
          const hasSamples = anyMarkedSample ? anyChartedSample : !!targetMeta?.output_types?.includes("sample");
          const sampleOnly = !!targetMeta?.output_types?.includes("sample") && !targetMeta?.output_types?.includes("quantile");
          return hasSamples && !sampleOnly
            ? [{ label: "Sample trajectories", toggle: true, checked: !!s.trajectories, onSelect: () => store.set({ trajectories: !store.get().trajectories }) }]
            : [];
        })(),
        "-",
        { label: "About intervals", onSelect: () => guide("intervals") },
      ],
    });
  }

  // the hint during a pull past the season's end: the next season's name, fading in with the pull
  #crossHint() {
    const p = this.chart.nav?.pull ?? 0, d = Math.sign(p), k = Math.min(1, Math.abs(p));
    const nb = d ? this.chart.neighbour(d) : null;
    const key = nb ? `${d}|${nb.id}|${Math.round(k * 20)}` : "";
    if (key === this.crossKey) return;
    this.crossKey = key;
    this.cross.classList.toggle("is-shown", !!nb && k > 0.05);
    if (!nb) return;
    this.cross.classList.toggle("left", d < 0); this.cross.classList.toggle("right", d > 0);
    this.cross.classList.toggle("is-ready", k >= 1);
    this.cross.style.setProperty("--pull", k.toFixed(2));
    this.cross.querySelector(".fc-cross-arrow").innerHTML = d < 0 ? icon.left : icon.right;
    this.cross.querySelector(".fc-cross-label").textContent = nb.label;
    if (d > 0) this.cross.append(this.cross.querySelector(".fc-cross-arrow")); else this.cross.prepend(this.cross.querySelector(".fc-cross-arrow"));
  }

  destroy() { this.glass.forEach((g) => g.destroy()); this.chrome.remove(); this.note.remove(); this.recenter.remove(); this.cross.remove(); }
}

/* The Guide is loaded on first use, so the chart doesn't pay for it. */
export const guide = (topic) => import("../Guide.js").then((m) => m.openGuide(topic)).catch((err) => console.error("viz: the guide could not open", err));
