/* Methods (old viz's Guide & Methodology and glossary, rewritten short) and the Shortcuts list.
 * The one place prose is allowed on screen. */
import { h } from "../lib/dom.js";
import { openPopover } from "../ui/floating.js";

/* [term, definition] pairs per topic. Definitions are plain strings; keep each to two sentences. */
const METHODS = [
  ["Forecasts", [
    ["Round", "A Saturday reference date. Each team submits quantiles (23 levels; some submit 7) of weekly hospital admissions for the weeks after it."],
    ["Horizon", "Weeks after the reference date. h0 is a nowcast of the week ending on the reference date, which is not yet reported; h1–h3 are one to three weeks ahead."],
    ["Observed", "NHSN admissions, newest vintage per week. As-of shows the data as published when the forecast was made."],
  ]],
  ["Scores", [
    ["WIS", "Weighted interval score: the average quantile (pinball) loss over every level, in the target's units. It rewards a narrow interval that still contains what happened; lower is better."],
    ["Anatomy", "WIS splits into dispersion (interval width), overprediction and underprediction (Bracher et al., 2021)."],
    ["Relative WIS", "For every pair of models, the ratio of their mean WIS on the tasks both forecast; a model's score is the geometric mean of its ratios, scaled so the baseline is 1. Below 1 beats the baseline."],
    ["Δ baseline", "Percent difference in WIS from the baseline on shared tasks."],
    ["MAE", "Mean absolute error of the median."],
    ["Coverage", "Share of observations inside the 50% and 95% intervals. Calibrated is 50% and 95%; above means too wide, below too confident."],
    ["Sharpness", "Mean width of the 95% interval."],
    ["Per 100k", "WIS per 100,000 people, to compare places of different size (count targets only)."],
    ["Log scale", "Scores on ln(y + 1), which weighs relative rather than absolute errors (Bosse et al., 2023)."],
  ]],
  ["Fair comparison", [
    ["Tasks", "A task is one round × location × horizon. By default each model is scored on every task it forecast."],
    ["Common tasks", "Only the tasks every compared model forecast, so no model gains from skipping hard weeks."],
    ["Places", "States and US national are scored separately; All states pools the states."],
    ["Wins", "Rounds where a model had the lowest mean WIS on common tasks, out of the rounds it took part in."],
  ]],
  ["Season", [
    ["Season weeks", "Seasons are aligned by MMWR week, so the same week of different seasons lines up."],
    ["Phases", "The peak is the contiguous run of weeks at or above 60% of the season's maximum; pre-peak and post-peak lie either side. With All states, each state has its own phases."],
    ["Peak forecasts", "Peak week as probabilities, scored with the ranked probability and log scores; peak size as quantiles, scored with WIS as a share of the peak. ◇ marks a provisional observed peak, ★ a final one."],
  ]],
  ["Ensembles", [
    ["Combine", "The median or mean of each quantile across members, then sorted so quantiles never cross. A task keeps only the levels every present member submitted."],
    ["Missing", "Pool present averages whoever forecast a task; All or none drops tasks that lack any member."],
  ]],
  ["Data sources", [
    ["Repository", "model-output and local-output in this hub, plus saved ensembles."],
    ["Live hubs", "Forecasts copied from public Hubverse hubs into the local cache on Sync. Each file is checked for schema drift, crossing quantiles, negative counts, unknown locations and duplicates; unreadable files are skipped, never half loaded."],
  ]],
];

/* [keys, action]; keys separated by " " render as separate caps, "/" between alternatives */
const SHORTCUTS = [
  ["Chart", [
    ["← →", "Previous or next round"],
    ["Drag · side scroll", "Scrub through time"],
    ["= − 0", "Zoom in, out, reset"],
    ["⌘ scroll · pinch", "Zoom"],
    ["⌘ drag", "Pan"],
    ["⇧ scroll · ⇧ drag", "Chart height"],
    ["Double-click", "Whole season"],
  ]],
  ["Page", [
    ["/", "Models"],
    ["T", "Light or dark"],
    ["F", "Present"],
    ["?", "Shortcuts"],
    ["Esc", "Close · clear focus · leave Present"],
  ]],
];

const keyCaps = (s) => s.split(" · ").flatMap((alt, i) => [i ? h("span", { class: "mo-or" }, "or") : null, ...alt.split(" ").map((k) => (k.length <= 3 ? h("kbd", null, k) : h("span", { class: "mo-gesture" }, k)))]);

/**
 * The Methods panel.
 * @param {HTMLElement} anchor
 * @returns {object | null}
 */
export function openMethods(anchor) {
  return openPopover(anchor, {
    title: "Methods", placement: "bottom-end", width: 560, className: "mo-panel mo-tall",
    content(body) {
      body.classList.add("mo-prose");
      for (const [topic, terms] of METHODS) {
        body.append(h("h3", { class: "mo-topic" }, topic),
          h("dl", { class: "mo-dl" }, terms.map(([t, d]) => [h("dt", null, t), h("dd", null, d)])));
      }
    },
  });
}

/**
 * The Shortcuts panel.
 * @param {HTMLElement} anchor
 * @returns {object | null}
 */
export function openShortcuts(anchor) {
  return openPopover(anchor, {
    title: "Shortcuts", placement: "bottom-end", width: 380, className: "mo-panel",
    content(body) {
      for (const [topic, rows] of SHORTCUTS) {
        body.append(h("h3", { class: "mo-topic" }, topic),
          h("dl", { class: "mo-keys" }, rows.map(([k, a]) => [h("dt", null, keyCaps(k)), h("dd", null, a)])));
      }
    },
  });
}
