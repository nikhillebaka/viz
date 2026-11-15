/* The Guide: old viz's Guide & Methodology modal and glossary popovers, rewritten for everyone at once.
 * Each topic is one continuous page: it opens in plain language (what it is, how to read it here, what
 * good looks like), then flows into the definitions, formulas, hub conventions and caveats, with no
 * seam between the two. The one place on screen where prose is welcome.
 *
 * A large frosted sheet (kit popover, panel glass) anchored to the ⋯ bubble: parts and topics on the
 * left, one topic at a time on the right, a search field on top that filters topics and marks matches.
 * openGuide(topic) opens it anywhere; the URL hash follows the topic (#guide/<topic>), so a topic can be
 * linked, and More.js opens the Guide from that hash on load. Escape closes; ← → don't step the chart
 * while it is open (an open layer stands the time keys down). Content is authored HTML (trusted). */
import { h } from "../lib/dom.js";
import { openPopover, activeLayer, revealInList } from "../ui/floating.js";

/* ---------------------------------------------------------------- content helpers */
const L = (id, text) => `<a href="#guide/${id}" data-topic="${id}">${text}</a>`;
const F = (s) => `<span class="gd-f">${s}</span>`;
const EQ = (...lines) => `<div class="gd-eq">${lines.map((l) => `<div>${l}</div>`).join("")}</div>`;
const K = (k) => `<kbd>${k}</kbd>`;


/* A small density curve (normal, in viewBox units) for the WIS figure. */
function densityPath(cx, sd, x0, x1, base, height) {
  const pts = [];
  for (let x = x0; x <= x1; x += 4) pts.push(`${x},${(base - height * Math.exp(-0.5 * ((x - cx) / sd) ** 2)).toFixed(1)}`);
  return `M${x0},${base} L${pts.join(" L")} L${x1},${base} Z`;
}

/* WIS: a forecast distribution, its nested intervals and median, and an observation outside them. */
function wisFigure() {
  const cx = 220, sd = 52, base = 92, y = 372;
  const iv = (z) => [cx - z * sd, cx + z * sd];
  const [l95, u95] = iv(1.96), [l80, u80] = iv(1.2816), [l50, u50] = iv(0.6745);
  return `<svg class="gd-svg" viewBox="0 0 520 176" role="img" aria-label="A forecast distribution with nested 50, 80 and 95 percent intervals around its median, and an observation above the 95 percent interval; the distance outside each interval is the miss penalty.">
  <path class="f-area" d="${densityPath(cx, sd, 40, 400, base, 70)}"/>
  <line class="f-axis" x1="24" x2="500" y1="${base}" y2="${base}"/>
  <line class="f-med" x1="${cx}" x2="${cx}" y1="${base - 72}" y2="${base}"/>
  <text class="f-lab" x="${cx}" y="${base - 78}" text-anchor="middle">median m</text>
  <g class="f-bars">
    <line class="f-bar95" x1="${l95}" x2="${u95}" y1="114" y2="114"/>
    <line class="f-bar80" x1="${l80}" x2="${u80}" y1="130" y2="130"/>
    <line class="f-bar50" x1="${l50}" x2="${u50}" y1="146" y2="146"/>
    <line class="f-tick" x1="${cx}" x2="${cx}" y1="108" y2="152"/>
  </g>
  <text class="f-lab" x="${l95 - 8}" y="118" text-anchor="end">95%</text>
  <text class="f-lab" x="${l80 - 8}" y="134" text-anchor="end">80%</text>
  <text class="f-lab" x="${l50 - 8}" y="150" text-anchor="end">50%</text>
  <line class="f-miss" x1="${u95}" x2="${y}" y1="114" y2="114"/>
  <line class="f-miss" x1="${u80}" x2="${y}" y1="130" y2="130"/>
  <line class="f-miss" x1="${u50}" x2="${y}" y1="146" y2="146"/>
  <line class="f-obs-line" x1="${y}" x2="${y}" y1="${base - 40}" y2="152"/>
  <circle class="f-obs" cx="${y}" cy="${base}" r="4.5"/>
  <text class="f-lab f-strong" x="${y + 10}" y="${base - 30}">observed y</text>
  <text class="f-lab f-warn" x="${y + 10}" y="134">misses: penalty × 2/α</text>
  <text class="f-lab" x="${cx}" y="170" text-anchor="middle">widths: dispersion</text>
</svg>`;
}

/* Calibration: an overconfident model's curve under the diagonal. */
function calibrationFigure() {
  const x = (v) => 40 + v * 2, yy = (v) => 172 - v * 1.5;
  const pts = [[10, 6], [20, 12], [30, 19], [40, 27], [50, 36], [60, 46], [70, 56], [80, 66], [90, 79], [95, 86], [98, 92]];
  return `<svg class="gd-svg gd-svg-sm" viewBox="0 0 300 206" role="img" aria-label="Calibration: interval level on the horizontal axis, share of observations inside on the vertical; the diagonal is perfect calibration, and an overconfident model's curve falls below it.">
  <line class="f-axis" x1="${x(0)}" x2="${x(100)}" y1="${yy(0)}" y2="${yy(0)}"/>
  <line class="f-axis" x1="${x(0)}" x2="${x(0)}" y1="${yy(0)}" y2="${yy(100)}"/>
  <line class="f-diag" x1="${x(0)}" y1="${yy(0)}" x2="${x(100)}" y2="${yy(100)}"/>
  <polyline class="f-curve" points="${x(0)},${yy(0)} ${pts.map(([a, b]) => `${x(a)},${yy(b)}`).join(" ")}"/>
  ${pts.filter((_, i) => [4, 7, 9].includes(i)).map(([a, b]) => `<circle class="f-dot" cx="${x(a)}" cy="${yy(b)}" r="3"/>`).join("")}
  <text class="f-lab" x="${x(14)}" y="${yy(78)}">too cautious</text>
  <text class="f-lab" x="${x(60)}" y="${yy(22)}">too confident</text>
  <text class="f-lab" x="${x(100)}" y="${yy(100) - 6}" text-anchor="end">calibrated</text>
  <text class="f-lab" x="${x(0)}" y="${yy(0) + 16}">0</text>
  <text class="f-lab" x="${x(100)}" y="${yy(0) + 16}" text-anchor="end">interval level 100%</text>
  <text class="f-lab" x="${x(0) - 6}" y="${yy(100) + 4}" text-anchor="end">100%</text>
  <text class="f-lab" x="${x(0) - 6}" y="${yy(50) + 4}" text-anchor="end">inside</text>
</svg>`;
}

/* Fan chart anatomy: observed history to the data cutoff, then a median with nested 50/80/95 bands at
 * horizons −1…3 from the reference date; the observed line carries on, dotted with hollow points. */
function fanFigure() {
  const hx = (k) => 280 + 50 * k, base = 150;
  const med = [66, 60, 56, 62, 72];
  const hw = [[1, 2, 3], [4, 7, 10], [7, 12, 18], [11, 19, 28], [15, 26, 38]];   // half widths: 50, 80, 95
  const band = (j) => {
    const up = med.map((m, i) => `${hx(i - 1)},${m - hw[i][j]}`), lo = med.map((m, i) => `${hx(i - 1)},${m + hw[i][j]}`).reverse();
    return `M${up.join(" L")} L${lo.join(" L")} Z`;
  };
  const hist = [128, 122, 112, 102, 90, 78, 66].map((v, i) => `${40 + 30 * i},${v}`);
  const after = [54, 50, 58, 76];
  const row = (y, sw, label) => `${sw}<text class="f-lab" x="462" y="${y + 4}">${label}</text>`;
  return `<svg class="gd-svg" viewBox="0 0 520 184" role="img" aria-label="Anatomy of the fan chart: the observed line up to the data cutoff, then a shaded forecast area where a model's median line fans out into 50, 80 and 95 percent bands at horizons from minus one to three weeks from the reference date, with the observed line continuing as dotted hollow points.">
  <rect class="f-shade" x="${hx(-1)}" y="24" width="${hx(3) - hx(-1)}" height="${base - 24}"/>
  <line class="f-axis" x1="24" x2="440" y1="${base}" y2="${base}"/>
  <polyline class="f-hist" points="${hist.join(" ")}"/>
  <text class="f-lab" x="40" y="108">observed</text>
  <line class="f-guide" x1="${hx(-1)}" x2="${hx(-1)}" y1="24" y2="${base}"/>
  <line class="f-guide" x1="${hx(0)}" x2="${hx(0)}" y1="24" y2="${base}"/>
  <text class="f-lab f-strong" x="${hx(-1) - 6}" y="16" text-anchor="end">data cutoff</text>
  <text class="f-lab f-strong" x="${hx(0) + 6}" y="16">reference date</text>
  <path class="f-band95" d="${band(2)}"/>
  <path class="f-band80" d="${band(1)}"/>
  <path class="f-band50" d="${band(0)}"/>
  <polyline class="f-medline" points="${med.map((m, i) => `${hx(i - 1)},${m}`).join(" ")}"/>
  <polyline class="f-hist f-dotted" points="${hx(-1)},66 ${after.map((v, i) => `${hx(i)},${v}`).join(" ")}"/>
  ${after.map((v, i) => `<circle class="f-hollow" cx="${hx(i)}" cy="${v}" r="3.5"/>`).join("")}
  ${[-1, 0, 1, 2, 3].map((k) => `<text class="f-lab" x="${hx(k)}" y="${base + 18}" text-anchor="middle">${k < 0 ? "−1" : k} wk</text>`).join("")}
  <text class="f-lab" x="${hx(1)}" y="${base + 34}" text-anchor="middle">horizon: weeks from the reference date</text>
  ${row(40, `<rect class="f-band95 f-sw" x="446" y="34" width="10" height="12"/>`, "95%")}
  ${row(58, `<rect class="f-band80 f-sw" x="446" y="52" width="10" height="12"/>`, "80%")}
  ${row(76, `<rect class="f-band50 f-sw" x="446" y="70" width="10" height="12"/>`, "50%")}
  ${row(94, `<line class="f-medline" x1="446" x2="456" y1="94" y2="94"/>`, "median")}
  ${row(112, `<circle class="f-hollow" cx="451" cy="112" r="3.5"/>`, "observed later")}
</svg>`;
}

/* The weeks around a reference date: reported data up to the cutoff, a nowcast, then 1–3 wk ahead. */
function horizonFigure() {
  const x = (i) => 20 + 80 * i, w = 72, cells = ["earlier", "−1 wk", "0 wk", "1 wk", "2 wk", "3 wk"];
  const brace = (a, b, label) => `<line class="f-axis" x1="${x(a)}" x2="${x(b) + w}" y1="82" y2="82"/><text class="f-lab" x="${(x(a) + x(b) + w) / 2}" y="100" text-anchor="middle">${label}</text>`;
  return `<svg class="gd-svg" viewBox="0 0 520 110" role="img" aria-label="Weeks around a reference date: the data cutoff week at minus one, the reference date week at zero (a nowcast, not yet reported), then one to three weeks ahead.">
  ${cells.map((c, i) => `<rect class="${i < 2 ? "f-cell f-cell-data" : "f-cell"}" x="${x(i)}" y="30" width="${w}" height="30" rx="4"/><text class="f-lab ${i === 2 ? "f-strong" : ""}" x="${x(i) + w / 2}" y="49" text-anchor="middle">${c}</text>`).join("")}
  <text class="f-lab f-strong" x="${x(1) + w / 2}" y="20" text-anchor="middle">data cutoff</text>
  <text class="f-lab f-strong" x="${x(2) + w / 2}" y="20" text-anchor="middle">reference date</text>
  ${brace(0, 1, "reported")}${brace(2, 2, "nowcast")}${brace(3, 5, "forecast")}
</svg>`;
}

/* Relative WIS: two bars of mean WIS on the same tasks; the ratio to the baseline's is the number. */
function relativeFigure() {
  const x0 = 64, s = 180;
  return `<svg class="gd-svg gd-svg-sm" viewBox="0 0 300 112" role="img" aria-label="Two bars of mean WIS on the same forecasts: the baseline at 1.00 and a model at 0.80, which is 20 percent lower.">
  <text class="f-lab" x="0" y="37">baseline</text>
  <text class="f-lab f-strong" x="0" y="71">model</text>
  <rect class="f-area" x="${x0}" y="22" width="${s}" height="22" rx="3"/>
  <rect class="f-bar-mod" x="${x0}" y="56" width="${0.8 * s}" height="22" rx="3"/>
  <line class="f-diag" x1="${x0 + s}" x2="${x0 + s}" y1="12" y2="86"/>
  <text class="f-lab" x="${x0 + s + 6}" y="37">1.00</text>
  <text class="f-lab f-strong" x="${x0 + 0.8 * s + 6}" y="71">0.80</text>
  <text class="f-lab" x="${x0}" y="104">mean WIS on shared tasks: 20% lower</text>
</svg>`;
}

/* ---------------------------------------------------------------- topics
 * { id, title, body (HTML; "<!--fig-->" marks where the figure goes, else it follows the body),
 *   fig? () => SVG, caption? } */
const FIG = "<!--fig-->";
const PARTS = [
  { title: "Start here", topics: [
    { id: "start", title: "What viz is",
      body: `<p>viz is a place to look at flu forecasts and see how good they turned out to be. Every week in the flu season, modeling teams send forecasts to a forecast hub: how many people will be admitted to hospital with flu in each state, and in the US, over the next few weeks, and how sure they are. viz draws those forecasts against what actually happened, and scores them so you can compare models fairly.</p>
<p>A short tour, top to bottom:</p>
<ol>
<li><b>The fan chart.</b> One place and one forecast round: each model's middle guess and range against the observed line. The bubbles at the top left choose the models, the place and the target; the date at the bottom steps through rounds. See ${L("fan-chart", "Reading the fan chart")}.</li>
<li><b>Scores.</b> Scroll down for a leaderboard of how well past forecasts did. Its title line is the scope: metric · places · dates · horizons · baseline. See ${L("scores", "Reading Scores")}.</li>
<li><b>Heatmap.</b> Many places, weeks or models at once, colored by a value or a score. See ${L("heatmap", "Heatmap")}.</li>
<li><b>Map.</b> One week across the states for one model. See ${L("map", "Map")}.</li>
<li><b>Peaks.</b> When each model expects the season to peak, and how high. See ${L("peaks", "Peaks")}.</li>
<li><b>⋯</b> at the top right: data sources, warnings, refresh, copy link and this Guide.</li>
</ol>
<p>If forecast evaluation is new to you, read ${L("forecast-hubs", "Forecast hubs")}, then ${L("fan-chart", "the fan chart")}, then ${L("wis", "WIS")} and ${L("relative-wis", "relative WIS")}. Each topic begins with the idea and what to look for, then gives the exact definitions.</p>
<p>Under the hood, viz reads a Hubverse-format hub (<code>model-output/</code>, <code>model-metadata/</code>, <code>hub-config/</code>, <code>target-data/</code>) plus <code>local-output/</code> and any synced hubs. It scores every quantile forecast against the latest target data with the hub's conventions: WIS on the submitted quantiles, pairwise relative WIS against a baseline, interval coverage. Everything you set is in the URL, so a link reproduces the view; <code>#guide/&lt;topic&gt;</code> links to a topic of this Guide. The ↓ menu in Scores copies the equivalent <code>score_cli.py</code> command.</p>` },
    { id: "forecast-hubs", title: "Forecast hubs, rounds and targets",
      body: `<p>A forecast hub collects forecasts from many teams in one shared format, so they can be compared and combined. FluSight, run by CDC, is the flu hub: each week of the season, teams forecast weekly flu hospital admissions for every state, DC, Puerto Rico and the US.</p>
<p>One week's set of forecasts is a <b>round</b>, named by its <b>reference date</b>, a Saturday. A forecast is not one number but a range of outcomes with probabilities, given as <b>quantiles</b>: "a 10% chance of fewer than 400 admissions, 50% of fewer than 520, 90% of fewer than 700." What actually happened, the <b>target data</b>, comes from hospitals reporting to CDC's NHSN. When a hub has more than one target, the Target bubble switches between them.</p>
<p>Hubverse rows are keyed by <code>reference_date</code>, <code>location</code> (FIPS; <code>US</code> national), <code>horizon</code>, <code>target</code>, <code>target_end_date</code>, <code>output_type</code>, <code>output_type_id</code>, <code>value</code>. Quantile forecasts use 23 levels:</p>
${EQ("τ ∈ {0.01, 0.025, 0.05, 0.10, 0.15, …, 0.90, 0.95, 0.975, 0.99}")}
<p>Some models (and local <code>--short_run</code> runs) submit 7: 0.025, 0.1, 0.25, 0.5, 0.75, 0.9, 0.975. Each model is scored on what it submitted. A <b>task</b> is one round × location × horizon (per target). ${F("target_end_date = reference_date + 7·horizon")} days. Season-level peak targets (<code>peak week inc flu hosp</code>, a pmf over weeks; <code>peak inc flu hosp</code>, quantiles) have no horizon and live in the ${L("peaks", "Peaks")} section. The national forecast is its own model output, not a sum of states. Numbers format per target: counts, or percent for proportion targets.</p>` },
  ] },

  { title: "The fan chart", topics: [
    { id: "fan-chart", title: "Reading the fan chart",
      body: `<p>The chart shows one place and one round. The solid line is what was observed: weekly admissions as reported today. The shade starts at the data cutoff, the last week the models had seen. From there each charted model fans out: a line through its <b>median</b> (its middle guess), with a dot per week, and a band for its <b>interval</b>, the range it expects the truth to land in with the stated probability. The observed line carries on past the cutoff (dotted, with hollow points), so you can see what happened next.</p>
${FIG}
<p>What good looks like: observed points near the medians and inside the bands, with bands narrow enough to be useful. Hover anywhere for exact values: in the forecast weeks, a row per model with its median and range; over history, the observed value for that week. Labels at the end of each fan name the models; there is no legend.</p>
<p>Medians are the 0.5 quantile; bands are central intervals from symmetric quantile pairs (95%: 0.025–0.975, 80%: 0.1–0.9, 50%: 0.25–0.75). Observed values are the newest vintage of the target data, so they include later revisions (${L("as-reported", "As reported")} shows the vintage of the round). Labels use the model's own abbreviation from its metadata and add the team or hub only when two would read the same.</p>
<p>The y-axis is fixed per season and place (observed data and charted medians, rounded up to a round value) and eases when either changes; a season with fewer than 4 observed weeks takes the larger of its own maximum and half of last season's. Gaps in the observed data break the line; it never bridges a missing week.</p>`,
      fig: fanFigure, caption: "One model's forecast: the median through its horizons, with 50%, 80% and 95% bands widening further ahead. The observed line continues past the cutoff." },
    { id: "dates-horizons", title: "Data cutoff, reference date and horizons",
      body: `<p>Hospital data arrives late. On a round's reference date (a Saturday) that week's counts aren't published yet, so a model's newest data ends a week earlier: the <b>data cutoff</b>, labelled on the axis beside the reference date.</p>
${FIG}
<p>The weeks a model forecasts are its <b>horizons</b>, counted from the reference date. <b>0 wk</b> is the week ending on the reference date: it has happened but isn't reported, so this is a nowcast. <b>1–3 wk</b> look one to three weeks ahead. <b>−1 wk</b> is the cutoff week itself, whose first report is often incomplete and revised. Further ahead is harder, so expect wider bands and higher scores at 3 wk than at 0 wk.</p>
<p>For reference date T: ${F("target_end_date = T + 7h")}, h ∈ {−1, 0, 1, 2, 3} (FluSight 2025–26). History on the chart stops at T − 7 days; the observed overlay after it uses today's revised data. NHSN reports are verified for 5–10 days before publication and revised for weeks after, which is why h = −1 and h = 0 are not trivial.</p>
<p>The score views (Scores, heatmap, map) use horizons 0–3; the Horizon figure under Scores shows relative WIS by lead time, and its per-horizon columns are ratios of mean WIS to the baseline's on shared tasks.</p>`,
      fig: horizonFigure, caption: "Weeks around a reference date. Horizons count from it; the cutoff week is −1." },
    { id: "intervals", title: "Intervals, medians and misses",
      body: `<p>The pill at the bottom left chooses which intervals are drawn: 95%, 80% and 50%, in any combination (nested, the narrowest darkest), or none. A 95% interval should contain the truth about 19 times in 20; a 50% interval, half the time. So an observed point outside a 50% band is expected now and then, while points outside 95% bands week after week mean the model is too sure of itself.</p>
<p>Levels map to α = 0.05, 0.2, 0.5 (central intervals [q<sub>α/2</sub>, q<sub>1−α/2</sub>]). A model missing a level's quantile pair draws its median only, and its readout row shows – for the range. The readout lists the median first, then the range of each chosen level.</p>
<p>When one model is in focus, or it's the only one charted, observed weeks outside its interval get a ring: a <b>miss</b>. Medians are always drawn. <b>Outcome</b> off hides everything observed after the cutoff, to see a forecast as it stood when it was made. <b>Width rulers</b> set each model's last-week intervals side by side at the right, so widths can be compared directly: thin for 95%, medium for 80%, thick for 50%, at the last horizon.</p>
<p>Levels, rulers and Outcome are kept in the URL; an old viz link's <code>pi=95,80</code> still works.</p>` },
    { id: "time-zoom", title: "Moving through time and zooming",
      body: `<p>The date at the bottom is the round. ‹ › or ${K("←")} ${K("→")} step one round, crossing into the next season; drag or side-scroll to scrub smoothly and watch the forecasts move. Click the date for a calendar of rounds. Zoom with ${K("=")} and ${K("−")} (${K("0")} resets), a pinch or ⌘-scroll; double-click for the whole season. ⌘-drag pans; if the forecast leaves the screen, a small pill brings it back. ⇧-scroll or ⇧-drag changes the chart's height. Ordinary vertical scrolling scrolls the page.</p>
<p>Time is one fractional date. Drag and side scroll scrub 1:1 with rubber bands at the season's ends and a momentum snap to a round; keys and the stepper glide on a critically damped spring. Zoom runs from 6 weeks to the whole season, the camera following the date less as it zooms out. Keys cross seasons as a short cut; drag never does.</p>
<p>Stops are forecast rounds; surveillance-only weeks appear on the observed line but are not stops. ← → step only while no picker, menu or this Guide is open.</p>` },
    { id: "focus-baseline", title: "Focus, Show all and the baseline",
      body: `<p>You can select many models; up to five are drawn in color, each keeping its color while it stays. Click a label or a line to <b>focus</b> a model: the others dim and its misses show. Click again, or press ${K("Esc")}, to clear. <b>Show all</b> (top right, "Showing 5 of 9") adds the rest of your selection as thin grey medians.</p>
<p>Charted models are a queue of five stable slots; series colors identify charted models and nothing else. Every selected model is evaluated in Scores whether charted or not.</p>
<p>The <b>baseline</b> is the plain reference forecast everything is compared with. FluSight's carries the last observed value forward, with a range drawn from past week-to-week changes. Beating it is the minimum bar for a useful model. It's drawn in grey with its own switch and never takes a color. Models with no forecast for this season or place collapse into one quiet line.</p>
<p>The baseline for relative scores is the last fragment of the Scores scope line; when the configured baseline has no forecasts in scope, a fallback is named and flagged. Focus, the charted five, Show all and the baseline are in the URL.</p>` },
  ] },

  { title: "Layers", topics: [
    { id: "as-reported", title: "As reported and revisions",
      body: `<p>Hospital counts change after they're first published: late reports arrive and mistakes are fixed, often raising the most recent weeks. The observed line shows today's numbers. The <b>As reported</b> layer (Layers pill, beside the interval pill) draws, dashed, the data as it was published on the round, which is what the models actually saw. Where the two differ near the cutoff, a model that seems to have missed may have been misled by numbers that were later revised.</p>
<p>The layer is the as-of vintage of the target data for each round, up to its data cutoff, values unrounded. Scores always use the latest vintage, as the hub's own evaluation does; reading a forecast against what was known then is a qualitative check, not a score.</p>` },
    { id: "past-seasons", title: "Past seasons",
      body: `<p><b>Past seasons</b> draws earlier seasons' observed curves faintly behind this one, lined up by week of the season so Thanksgiving and New Year fall in the same place. It shows how big and how early a season usually is here, and whether this year's forecasts are in a plausible range.</p>
<p>Curves are aligned by season week, built on MMWR weeks (Sunday–Saturday; season week 1 = MMWR week 31, early August), and end-labelled with the season. The y-axis grows to keep them in view.</p>` },
    { id: "peak-layer", title: "Peaks on the chart",
      body: `<p>For hubs that collect season peak forecasts, the <b>Peaks</b> layer marks each charted model's call for the round: ▲ at its median peak week and size, with whiskers for its 50% range in both. The observed peak so far is a diamond, hollow while it might still be beaten and filled once final. The ${L("peaks", "Peaks")} section has the full picture.</p>
<p>The median week and windows come from the cumulative peak-week distribution (median: first week with F ≥ 0.5; 50%: from F = 0.25 to 0.75); peak size comes from the submitted quantiles.</p>` },
    { id: "surveillance", title: "NSSP, ILINet and FluSurv-NET",
      body: `<p>Other flu signals, drawn beside hospital admissions to show timing: they often turn a week or two earlier.</p>
<ul>
<li><b>NSSP ED visits</b>: the share of emergency department visits diagnosed as flu, in percent. This is CDC's National Syndromic Surveillance Program, weekly by state, and it usually leads admissions by 1–2 weeks.</li>
<li><b>ILINet</b>: the share of outpatient visits for influenza-like illness, adjusted by lab positivity (ILI+), in percent. ${F("ILI+ = wILI × % positive / 100")}, aligned by MMWR week (2010–2023 in this build).</li>
<li><b>FluSurv-NET</b>: lab-confirmed flu hospitalizations per 100,000 people in its surveillance network, a population-based rate in 14 network states (2010–2023).</li>
</ul>
<p>With one signal on, it gets a right-hand axis in its own units. With several, each is scaled so its season peak meets the observed peak and is labelled scaled: compare shape and timing, not height. Hover for the raw values. The Layers menu lists only what exists for the place.</p>
<p>Scaled mode is ${F("v′ = v · max(observed) / max(v)")} within the season. Signals are context, never targets, and are never scored.</p>` },
  ] },

  { title: "Scores", topics: [
    { id: "scores", title: "Reading Scores",
      body: `<p>Under the chart, Scores ranks models on how well their past forecasts did. Its title line is the scope, read as a sentence: metric · places · dates · horizons · baseline. Each fragment is a menu; one reads in brighter ink when it isn't the default, so an unusual view shows at a glance.</p>
<p>Each row is a model, sorted by ${L("relative-wis", "relative WIS")} by default: lower is better, and the baseline reads 1.00. Click a row for that model's details: per-horizon scores, small plots, its team and method. Below the table, <b>Calibration</b> asks whether intervals are honest, <b>Horizon</b> how scores change with lead time, and <b>Anatomy</b> what WIS is made of. The ↓ menu exports CSV, TSV or JSON, or copies the equivalent command.</p>
<p>The default columns are <b>Rel. WIS</b> (pairwise tournament), <b>WIS</b> (mean), <b>MAE</b>, <b>50%</b> and <b>95%</b> coverage, and <b>N</b> (forecasts scored). Optional columns:</p>
<ul>
<li><b>vs base</b>: ${F("(WIS<sub>m</sub> − WIS<sub>base</sub>) / WIS<sub>base</sub>")} on tasks shared with the baseline.</li>
<li><b>Wins</b>: rounds with the lowest mean WIS among the selected models and baseline, on the tasks all of them forecast that round; ties count for each.</li>
<li><b>/100k</b>, <b>Width</b> (mean 95% width) and <b>80%</b> coverage.</li>
<li><b>0–3 wk</b>: the ratio of mean WIS to the baseline's at each horizon.</li>
</ul>
<p>A model can lead on total WIS through a few big weeks while rarely winning a round; Wins shows that, and depends on which models are selected. The Metric menu also holds the ${L("log-scale", "scale")}, ${L("shared-tasks", "shared tasks")} and the ranking pool.</p>` },
    { id: "wis", title: "Weighted interval score (WIS)",
      body: `<p>WIS is the main score. It asks how far the truth fell from the forecast, counting the whole range and not just the middle guess. Think of each interval as a bet. A narrow interval that contains the truth costs little. A wide one costs its width. One that misses costs its width plus a penalty for how far outside the truth fell, and the penalty is bigger for intervals that claimed more confidence. WIS averages these over all the intervals, together with the median's distance from the truth.</p>
${FIG}
<p>It's in the target's units (admissions): 0 is perfect and lower is better. But a WIS of 50 means very different things in California and in Vermont, or in a peak week and a quiet one, which is why models are compared with ${L("relative-wis", "relative WIS")}.</p>
<p>Formally, for K central intervals at levels 1 − α<sub>k</sub>, with bounds l<sub>k</sub>, u<sub>k</sub>, and median m:</p>
${EQ("IS<sub>α</sub>(y) = (u − l) + (2/α)·(l − y)·1(y &lt; l) + (2/α)·(y − u)·1(y &gt; u)", "WIS = (1/(K + ½)) · (½·|y − m| + Σ<sub>k</sub> (α<sub>k</sub>/2) · IS<sub>α<sub>k</sub></sub>(y))")}
<p>Equivalently, the mean pinball loss over the 2K + 1 quantiles: ${F("WIS = (2/(2K + 1)) · Σ<sub>τ</sub> (1(y &lt; q<sub>τ</sub>) − τ)·(q<sub>τ</sub> − y)")}. With 23 levels, K = 11. WIS is a proper score that approximates the CRPS (Bracher et al., 2021). Each model is scored on the levels it submitted (7-quantile models: K = 3), so compare those with care. Means are over the tasks in scope.</p>`,
      fig: wisFigure, caption: "A forecast and its 50%, 80% and 95% intervals. WIS adds up the intervals' widths, plus a penalty for each interval the observation fell outside." },
    { id: "wis-anatomy", title: "Dispersion, overprediction, underprediction",
      body: `<p>WIS splits into three parts that add up to it, shown in the Anatomy figure. <b>Dispersion</b> is the cost of the intervals' width: uncertainty the model admitted to. <b>Overprediction</b> is the penalty when the truth fell below the forecast; <b>underprediction</b>, when it came in above. A model whose score is mostly dispersion is cautious; one that is mostly underprediction kept forecasting too low, often on the way up a wave.</p>
<p>Each part carries the factor 1/(K + ½) (Bracher et al., 2021):</p>
${EQ("Dispersion = (1/(K + ½)) · Σ<sub>k</sub> (α<sub>k</sub>/2)·(u<sub>k</sub> − l<sub>k</sub>)", "Over = (1/(K + ½)) · [Σ<sub>k</sub> (l<sub>k</sub> − y)·1(y &lt; l<sub>k</sub>) + ½·(m − y)·1(y &lt; m)]", "Under = (1/(K + ½)) · [Σ<sub>k</sub> (y − u<sub>k</sub>)·1(y &gt; u<sub>k</sub>) + ½·(y − m)·1(y &gt; m)]")}
<p>Anatomy shows absolute values or each part's share. Over a handful of tasks (one date and place) the split is noisy; pool dates or places before reading much into it.</p>` },
    { id: "relative-wis", title: "Relative WIS and the pairwise tournament",
      body: `<p>Raw WIS depends on where and when you forecast: busy weeks and big states make big numbers. If one model skipped the hardest weeks, its average would look better without it being better. <b>Relative WIS</b> compares every pair of models only on the forecasts both made, then combines those head-to-head ratios into one number, scaled so the baseline is 1. Below 1 beats the baseline (0.80 means 20% lower WIS); above 1 is worse.</p>
${FIG}
<p>Because each comparison uses only shared forecasts, the set of models compared matters. The Metric menu's ranking pool chooses every model with forecasts in scope, or only your selection.</p>
<p>For models m, m′ with shared tasks S<sub>m,m′</sub> (Cramer et al., 2022):</p>
${EQ("θ<sub>m,m′</sub> = mean<sub>S</sub>(WIS<sub>m</sub>) / mean<sub>S</sub>(WIS<sub>m′</sub>)", "θ<sub>m</sub> = (Π<sub>m′</sub> θ<sub>m,m′</sub>)<sup>1/M</sup>", "Rel WIS<sub>m</sub> = θ<sub>m</sub> / θ<sub>baseline</sub>")}
<p>The geometric mean over the M models in the pool makes the ratios symmetric; dividing by the baseline gives a fixed, interpretable reference, a naive forecast that is hard to argue with. θ<sub>m</sub> depends on which other models are in the pool and which tasks each pair shares, so adding a model that forecast only easy weeks shifts everyone slightly; with ${L("shared-tasks", "shared tasks only")} every pair shares the same tasks and the tournament reduces to ratios of means. If the configured baseline has no forecasts in scope, a fallback model is named in the scope line and flagged. On the ${L("log-scale", "log scale")} the tournament runs on log WIS.</p>`,
      fig: relativeFigure, caption: "Relative WIS is a ratio to the baseline's WIS: 0.80 is 20% lower." },
    { id: "log-scale", title: "Log scale",
      body: `<p>On the natural scale, the busiest weeks and biggest places dominate an average: an error of 500 in a peak week outweighs a dozen good forecasts in small states. The <b>log scale</b> scores forecasts on the logarithm of the counts, so being 20% off counts about the same everywhere. Natural answers "who was best when numbers were largest?"; log answers "who got the shape right everywhere?"</p>
<p>Observation and every quantile are transformed ${F("x ↦ ln(max(x, 0) + 1)")} before scoring (Bosse et al., 2023); WIS, MAE and the tournament are then computed as usual. Coverage doesn't change (the transform is monotone). Log WIS behaves like a relative error, roughly comparable across places; the +1 keeps zeros defined and damps very small counts.</p>` },
    { id: "mae-width", title: "MAE, width and per 100k",
      body: `<p><b>MAE</b> is the average distance between the median and the truth: the accuracy of the middle guess alone, ignoring the intervals. <b>Width</b>, also called sharpness, is how wide the 95% interval is on average: narrow is good only if coverage holds. <b>Per 100k</b> divides WIS by population so states of different sizes can be compared. <b>vs base</b> is the plain percentage difference from the baseline's WIS.</p>
<p>In symbols: ${F("MAE = mean |y − q<sub>0.5</sub>|")} · ${F("Width = mean (q<sub>0.975</sub> − q<sub>0.025</sub>)")} · ${F("WIS/100k = WIS ÷ population × 100,000")} (count targets only, not rates or proportions) · ${F("vs base = (WIS<sub>m</sub> − WIS<sub>base</sub>) / WIS<sub>base</sub> × 100%")} on the tasks the model shares with the baseline, a direct comparison rather than the tournament.</p>` },
    { id: "coverage", title: "Coverage and calibration",
      body: `<p>Coverage asks whether a model's intervals are honest. Of all the times it drew a 95% interval, the truth should have landed inside about 95% of the time; for 50% intervals, about half. Lower than promised means the model was too confident, its bands too narrow. Higher means it was too cautious, its bands wider than needed. The Calibration figure under Scores plots each interval level against how often the truth was actually inside: a well-calibrated model follows the diagonal.</p>
${FIG}
<p>Formally, ${F("Coverage<sub>1−α</sub> = share of tasks with l<sub>α</sub> ≤ y ≤ u<sub>α</sub>")}, reported for 50% (q<sub>0.25</sub>–q<sub>0.75</sub>), 80% (q<sub>0.1</sub>–q<sub>0.9</sub>) and 95% (q<sub>0.025</sub>–q<sub>0.975</sub>). The calibration curve uses every central level the model submitted.</p>
<p>Coverage isn't a proper score: an always-wide model gets perfect 95% coverage and a poor WIS, so read it beside WIS. With few forecasts it moves in big steps: one miss in 10 is 10 points.</p>`,
      fig: calibrationFigure, caption: "An overconfident model's curve falls below the diagonal: its intervals contain the truth less often than they claim." },
    { id: "sample-size", title: "Sample size and small samples",
      body: `<p><b>N</b> is the number of forecasts scored for a model in the current scope. Averages over a few forecasts are noisy, and one bad week can swing them. When N is under 10, the row's numbers turn quiet and N is marked, a reminder not to read much into that rank.</p>
<p>N counts tasks (round × location × horizon) after the scope filters; the small-sample rule is N &lt; 10, per row. Small-sample rows are still ranked. Models that joined late or skipped places have fewer tasks; ${L("shared-tasks", "Shared only")} equalizes N.</p>` },
    { id: "shared-tasks", title: "Shared tasks only",
      body: `<p>By default each model is scored on every forecast it made in scope. If a model skipped the hardest weeks, its average looks better than it deserves. <b>Shared only</b> keeps just the forecasts every compared model made, so all are scored on the same weeks and places. It's the fairest comparison, at the cost of fewer forecasts: one model that joined late shrinks everyone's set.</p>
<p>Precisely, ${F("S = ∩<sub>m</sub> S<sub>m</sub>")} over (reference_date, location, horizon) for the models in the ranking pool and the baseline (<code>fair=True</code> on the command line). Without it, scoring is unconstrained and the ${L("relative-wis", "tournament")} adjusts for differences in coverage pair by pair.</p>` },
    { id: "eval-window", title: "Evaluation window",
      body: `<p>The scope line decides which forecasts are scored. <b>Dates</b>: one or more seasons (following the chart's season by default), a week range dragged across the seasons' curves, and a phase: before the peak, around it, or after it. <b>Horizons</b>: which lead times count, all four by default. <b>Places</b>: all states pooled, the US, or one place. A forecast counts when the week it forecast falls in the window. Try the peak phase to see who did well when it mattered most: models often agree in quiet weeks and part ways at turning points.</p>
<p>The window applies to <code>target_end_date</code>. Week ranges use season weeks (week 1 = MMWR week 31), so the same stretch is taken from every season.</p>
<p><b>Peak</b>: for each location and season, the contiguous run of weeks around the season maximum where observed values stay at or above 60% of it (typically 3–6 weeks); <b>pre-peak</b> and <b>post-peak</b> are the weeks either side. A season whose highest week is still among its latest observations hasn't peaked, so all its weeks are pre-peak. With All states each state uses its own phases; the curves in the Dates popover show the national one for orientation.</p>
<p>States and the US are scored separately because national counts (tens of thousands a week) would swamp state errors; All states pools the states.</p>` },
  ] },

  { title: "Views", topics: [
    { id: "heatmap", title: "Heatmap",
      body: `<p>The heatmap shows many numbers at once as a grid of colored cells. Choose what the rows and columns are (places, weeks, models or horizons) and what the color means: observed values, a model's forecasts, or a score. Places × weeks of observed values shows the season sweeping across the country; models × places of relative WIS shows where each model is strong. For scores, blue is better and orange worse; for values, stronger color is more. Hover a cell for its number.</p>
<p>The axes can be Locations × Weeks or Models; Models × Locations, Weeks or Horizons; Weeks × Locations or Models; Horizons × Models. Scores: Rel. WIS (ratio to the baseline), WIS, WIS/100k, MAE, 95% coverage, Sharpness. Values: Observed, Per 100k, Weekly change ${F("(y<sub>t</sub> − y<sub>t−1</sub>) / y<sub>t−1</sub>")}, Forecast, Forecast/100k, Error (median − observed).</p>
<p>Places sort by HHS region; by peak week, ${F("argmax<sub>t</sub> y<sub>t</sub>")} with ties by size, which lays the wave out as a diagonal; highest first; population; or A–Z. Models sort best first or A–Z. <b>Per row</b> scaling maps each row to [0, 1], ${F("v′ = (v − min) / (max − min)")}, to compare timing across places of very different size.</p>
<p>HHS regions: 1 CT ME MA NH RI VT · 2 NJ NY PR VI · 3 DE DC MD PA VA WV · 4 AL FL GA KY MS NC SC TN · 5 IL IN MI MN OH WI · 6 AR LA NM OK TX · 7 IA KS MO NE · 8 CO MT ND SD UT WY · 9 AZ CA HI NV AS GU MP · 10 AK ID OR WA.</p>` },
    { id: "map", title: "Map",
      body: `<p>The map shows one week across the states for one model: its forecast (in admissions or per 100k), what was observed, the error, the change it expects from the nowcast, or its WIS. Choose the model, layer and horizon in the heading. Per 100k evens out population and shows where flu is most intense; counts show where the most patients are. Hover a state for its numbers.</p>
<p>The layers are Forecast/100k, Forecast (median), Observed/100k, Observed, Error (median − observed, diverging), Change vs. nowcast ${F("(median<sub>h</sub> − median<sub>0</sub>) / median<sub>0</sub>")} (horizons ≥ 1) and WIS. Rates use ${F("value ÷ population × 100,000")} (count targets only).</p>
<p>The US forecast is a separate model output, and quantiles don't add (the median of a sum isn't the sum of medians), so a sum of state forecasts and the direct national forecast can legitimately differ.</p>` },
    { id: "peaks", title: "Peaks",
      body: `<p>Peaks answers two questions for each model: when will the season peak, and how high? Each model gets one row.</p>
<ul>
<li><b>When</b>: a strip of weeks, darker where the model puts more probability on the peak, with a tick at its median week. Two dark patches mean it sees two possible peaks, which is why this is drawn as a density rather than a single range.</li>
<li><b>How high</b>: the peak size, a thin line for the 90% range, a thick bar for 50%, a dot for the median.</li>
<li><b>Observed peak</b>: a line through both columns, dashed while it might still be beaten, solid once final.</li>
<li><b>How right</b>, once the peak is final: how far off the week and size were, and whether the 50% and 90% ranges covered them.</li>
</ul>
<p>The first row, All models, averages everyone; the headline reads its most likely window. The strip on top shows this season so far, with past seasons faint; hover a row to see its 50% box (week × size) there. Click a name to see how its call changed round by round. Click a column header to sort.</p>
<p>Peak week is a pmf over candidate Saturdays, renormalized (and flagged) if it doesn't sum to 1; median and windows come from its CDF (50%: F = 0.25 to 0.75). Peak size is quantiles. For All models, the pmf is the average and the size is the median of the models' size quantiles; the headline gives the 25–75% span of that pmf and the median of the 25% and 75% size quantiles.</p>
<p>The observed peak is the highest reported week in the forecast window, provisional until observations reach its last candidate week, then final; scores need a final peak. The peak week is scored two ways:</p>
${EQ("RPS = Σ<sub>w</sub> (F(w) − 1(w ≥ w*))²", "log score = −ln max(P(w*), 0.001)")}
<p>RPS is in weeks: a forecast certain of one week scores its absolute error, so near misses earn credit. Weeks tied at the maximum all count for the log score. Size is scored as WIS as a percentage of the observed peak (so states pool), median % error, and 50% / 90% coverage. Chance the peak is past is the probability a forecast put on weeks up to its own data cutoff. The size axis ignores the widest fifth of 90% upper ends so one wild model can't flatten the rest; whiskers past it end in a caret.</p>` },
  ] },

  { title: "Models and data", topics: [
    { id: "models", title: "Models: sources, families, designated",
      body: `<p>Open Models at the top left, or press ${K("/")}, to choose what to look at. Models are grouped by where they come from: this hub's own models (in families when a team runs several variants), local runs, each synced hub, and ensembles you made. Search by name, team or family, or type a filter such as <code>team:umass</code> or <code>data:nssp</code>. The chips under the search filter by source, family, team, kind (individual, ensemble, baseline) and the data a model says it uses; each option shows how many models it would leave. <b>This season</b> puts models that didn't forecast this season at the bottom (<b>This round</b>: those without a forecast on the chart's round; <b>Any time</b>: neither), and the last chip groups and sorts the list. The strip at the end of a row shows which of this season's rounds the model forecast. The models you've selected sit along the bottom: click one to put it on the chart or take it off, × to deselect it. A <b>designated</b> model is the one a team names as its official entry, the one a hub uses in its ensemble and official evaluation. Click a model's name in Scores, or the arrow beside it in the picker, to open its page.</p>
<p>The sources are <code>model-output/</code> (this hub), <code>local-output/</code> (Local: development runs, ignored by git, evaluated side by side), synced hubs (copied into the local cache) and Ensemble (saved combinations). Metadata comes from <code>model-metadata/*.yml</code>: team, abbreviation, <code>designated_model</code>, methods, license. Families group this hub's own models when several share one. Models with no forecasts in the current season are listed apart.</p>` },
    { id: "ensembles", title: "Ensembles and Combine",
      body: `<p>Combining models usually beats most of the models on their own, because their errors partly cancel. Select two or more models, then choose <b>Combine</b> in the Models picker: pick median or mean, and what to do when a member skipped a forecast. The preview shows how many forecasts the members share. The ensemble is saved and behaves like any other model, on the chart and in Scores.</p>
<p>The combination is quantile averaging (Vincentization): for each task and level τ, ${F("q<sub>ens</sub>(τ) = median or mean of q<sub>m</sub>(τ)")} over members, then sorted so quantiles never cross. A task keeps only the levels every present member submitted. <b>Pool present</b> combines whoever forecast the task; <b>All or none</b> drops tasks where any member is missing. The median resists one wild member; the mean is smoother. FluSight's own ensemble is a median of designated models.</p>` },
    { id: "data-sources", title: "Data sources, syncing and warnings",
      body: `<p>viz reads this hub's files and can also copy forecasts from other public hubs to compare against: ⋯ → Data sources lists them, and Sync fetches their seasons. Refresh data reloads everything from disk. When files have problems the ⋯ menu shows a Warnings count, and affected rows carry a small mark. A warning doesn't remove a model, but read it before trusting an odd score.</p>
<p>Synced hubs are copied from public Hubverse repositories into the local cache, per season. Each file is checked for schema drift, crossing quantiles, negative counts, unknown locations and duplicate rows; unreadable files are skipped, never half loaded. Warnings combine the dataset's validation warnings with each synced hub's quality notes (such as renormalized peak distributions). Refresh rebuilds the server's cache.</p>` },
  ] },

  { title: "Reference", topics: [
    { id: "glossary", title: "Glossary" },
    { id: "shortcuts", title: "Shortcuts" },
  ] },
];

/* [term, one line, topic] */
const GLOSSARY = [
  ["0 wk (nowcast)", "The week ending on the reference date: it has happened but isn't reported yet.", "dates-horizons"],
  ["All or none", "Combine drops tasks where any member is missing.", "ensembles"],
  ["All states", "The states pooled; the US is scored apart.", "eval-window"],
  ["Anatomy", "WIS split into dispersion, over- and underprediction.", "wis-anatomy"],
  ["As reported", "The target data as published on the round, before revisions.", "as-reported"],
  ["Baseline", "The plain reference forecast; relative scores divide by it.", "focus-baseline"],
  ["Calibration", "Whether intervals contain the truth as often as they claim.", "coverage"],
  ["Combine", "Make an ensemble from the selected models.", "ensembles"],
  ["Coverage", "The share of observations inside an interval.", "coverage"],
  ["Data cutoff", "The last week of data a model had seen.", "dates-horizons"],
  ["Designated", "The model a team names as its official hub entry.", "models"],
  ["Dispersion", "The part of WIS from the intervals' width.", "wis-anatomy"],
  ["Ensemble", "A model built by combining other models' quantiles.", "ensembles"],
  ["Family", "Related models of this hub, grouped in the picker.", "models"],
  ["FluSurv-NET", "Lab-confirmed flu hospitalizations per 100k in a surveillance network.", "surveillance"],
  ["Focus", "One model highlighted, with its misses marked.", "focus-baseline"],
  ["Forecast hub", "A shared repository of forecasts in one format.", "forecast-hubs"],
  ["Heatmap", "A grid of places, weeks, models or horizons, colored by a value or score.", "heatmap"],
  ["Horizon", "How many weeks after the reference date a forecast is for.", "dates-horizons"],
  ["ILINet", "Outpatient visits for influenza-like illness, adjusted by lab positivity.", "surveillance"],
  ["Interval", "A range expected to contain the truth with a stated probability.", "intervals"],
  ["Log scale", "Scores on ln(y + 1), weighing relative rather than absolute errors.", "log-scale"],
  ["MAE", "Mean absolute error of the median.", "mae-width"],
  ["Median", "The 0.5 quantile: the model's middle guess.", "intervals"],
  ["Miss", "An observed week outside the focused model's interval.", "intervals"],
  ["MMWR week", "CDC's epidemiological week, Sunday to Saturday.", "past-seasons"],
  ["N", "The number of forecasts scored.", "sample-size"],
  ["NHSN", "CDC's network whose hospital reports are the target data.", "forecast-hubs"],
  ["NSSP", "The share of emergency department visits diagnosed as flu.", "surveillance"],
  ["Outcome", "Shows or hides what was observed after the data cutoff.", "intervals"],
  ["Overprediction", "The part of WIS from forecasts above the truth.", "wis-anatomy"],
  ["Pairwise tournament", "Head-to-head WIS ratios on shared tasks, combined into relative WIS.", "relative-wis"],
  ["Peak phase", "The weeks around the season maximum at or above 60% of it.", "eval-window"],
  ["Peak week, peak size", "Season targets: when the season peaks and how high.", "peaks"],
  ["Per 100k", "Divided by population, times 100,000.", "mae-width"],
  ["Pool present", "Combine uses whichever members forecast a task.", "ensembles"],
  ["Provisional peak", "The highest week so far, which may still be beaten.", "peaks"],
  ["Quantile", "A value the outcome should fall below with a given probability.", "forecast-hubs"],
  ["Reference date", "The Saturday a round is named by.", "dates-horizons"],
  ["Relative WIS", "WIS relative to the baseline over shared tasks; below 1 is better.", "relative-wis"],
  ["Revision", "A change to data that was already published.", "as-reported"],
  ["Round", "One week's set of forecasts.", "forecast-hubs"],
  ["RPS", "Ranked probability score for the peak week, in weeks.", "peaks"],
  ["Season week", "Week of the season, aligned so seasons line up.", "past-seasons"],
  ["Shared only", "Score only the forecasts every compared model made.", "shared-tasks"],
  ["Show all", "Draws the rest of the selection as grey medians.", "focus-baseline"],
  ["Small sample", "Fewer than 10 forecasts scored.", "sample-size"],
  ["Target", "What is forecast, such as weekly flu admissions.", "forecast-hubs"],
  ["Task", "One round × place × horizon.", "forecast-hubs"],
  ["Underprediction", "The part of WIS from forecasts below the truth.", "wis-anatomy"],
  ["vs base", "Percent difference from the baseline's WIS on shared tasks.", "mae-width"],
  ["Width", "Mean width of the 95% interval (sharpness).", "mae-width"],
  ["Width rulers", "Each model's last-week intervals side by side.", "intervals"],
  ["Wins", "Rounds in which a model had the lowest WIS.", "scores"],
  ["WIS", "Weighted interval score: the main accuracy score; lower is better.", "wis"],
];

/* [keys, action]; " · " separates alternatives, " " separate keys */
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
    ["G", "Guide"],
    ["?", "Shortcuts"],
    ["Esc", "Close · clear focus"],
  ]],
];

const keyCaps = (s) => s.split(" · ").flatMap((alt, i) => [i ? h("span", { class: "gd-or" }, "or") : null, ...alt.split(" ").map((k) => (k.length <= 3 ? h("kbd", null, k) : h("span", { class: "gd-gesture" }, k)))]);

const TOPICS = PARTS.flatMap((p) => p.topics.map((t) => ({ ...t, part: p.title })));
const byId = new Map(TOPICS.map((t) => [t.id, t]));

/* searchable text per topic, built once */
let haystack = null;
function textOf(html) { const d = document.createElement("div"); d.innerHTML = html; return d.textContent; }
function searchIndex() {
  if (haystack) return haystack;
  haystack = new Map(TOPICS.map((t) => {
    let s = `${t.title} ${t.part}`;
    if (t.id === "glossary") s += GLOSSARY.map(([a, b]) => ` ${a} ${b}`).join("");
    else if (t.id === "shortcuts") s += SHORTCUTS.flatMap(([g, rows]) => [g, ...rows.flat()]).join(" ");
    else s += ` ${textOf(t.body || "")} ${t.caption || ""}`;
    return [t.id, s.toLowerCase()];
  }));
  return haystack;
}

/* ---------------------------------------------------------------- the sheet */
let open = null;      // { layer, go(id) } while the Guide is open
let lastTopic = "start";

const setHash = (id) => history.replaceState(history.state, "", `${location.pathname}${location.search}${id ? `#guide/${id}` : ""}`);

/**
 * Open the Guide (or, if it is open, go to a topic in it).
 * @param {string | null} [topicId] a topic id (e.g. "wis"); unknown or null opens the last topic read, else Start here
 * @param {HTMLElement} [anchor] defaults to the ⋯ bubble
 * @returns {object | null} the layer
 */
export function openGuide(topicId = null, anchor = null) {
  const id = byId.has(topicId) ? topicId : lastTopic;
  if (open) { open.go(id); return open.layer; }
  anchor = anchor || document.querySelector(".app-more") || document.querySelector("[data-zone='tr']");
  if (!anchor) return null;
  // another layer on the same anchor would make openPopover toggle it closed instead
  if (activeLayer()?.anchor === anchor) activeLayer().close(false);
  let go = () => {};
  const layer = openPopover(anchor, {
    title: "Guide", placement: "bottom-end", width: 760, className: "gd-sheet",
    onClose() { open = null; if (/^#guide/.test(location.hash)) setHash(null); },
    content(body) { go = build(body); },
  });
  if (!layer) return null;
  open = { layer, go };
  go(id);
  return layer;
}

function build(body) {
  const input = h("input", { type: "search", placeholder: "Search the guide", "aria-label": "Search the guide", autocomplete: "off", spellcheck: "false" });
  const search = h("label", { class: "c-search gd-search" }, input);
  const nav = h("nav", { class: "gd-nav", "aria-label": "Guide topics" });
  const read = h("article", { class: "gd-read", tabindex: "-1" });
  body.append(search, h("div", { class: "gd-cols" }, nav, read));

  let current = null, query = "", visible = TOPICS;
  const items = new Map();
  for (const p of PARTS) {
    const group = h("div", { class: "gd-part" }, h("div", { class: "gd-part-title" }, p.title));
    for (const t of p.topics) {
      const b = h("button", { type: "button", class: "gd-item", "data-topic": t.id, onclick: () => go(t.id, true) }, t.title);
      items.set(t.id, b);
      group.append(b);
    }
    nav.append(group);
  }
  const none = h("p", { class: "gd-none", hidden: true }, "No matches");
  nav.append(none);

  function filter() {
    const q = query.toLowerCase(), idx = searchIndex();
    visible = q ? TOPICS.filter((t) => idx.get(t.id).includes(q)) : TOPICS;
    const ids = new Set(visible.map((t) => t.id));
    for (const [id, b] of items) b.hidden = !ids.has(id);
    for (const g of nav.querySelectorAll(".gd-part")) g.hidden = ![...g.querySelectorAll(".gd-item")].some((b) => !b.hidden);
    none.hidden = visible.length > 0;
  }

  function go(id, focusRead = false) {
    if (!byId.has(id)) return;
    current = id; lastTopic = id;
    for (const [tid, b] of items) b.toggleAttribute("aria-current", tid === id);
    if (!items.get(id).hidden) revealInList(items.get(id));
    render(byId.get(id));
    setHash(id);
    if (focusRead) read.focus({ preventScroll: true });
  }

  function render(t) {
    const kids = [h("div", { class: "gd-crumb" }, t.part), h("h2", { class: "gd-title" }, t.title)];
    if (t.id === "glossary") {
      const q = query.toLowerCase();
      const rows = GLOSSARY.filter(([a, b]) => !q || `${a} ${b}`.toLowerCase().includes(q));
      kids.push(h("p", { class: "gd-lede" }, "Every term on the site in one line. Each term opens its topic."),
        h("dl", { class: "gd-gloss" }, rows.map(([a, b, to]) => [h("dt", null, h("a", { href: `#guide/${to}`, "data-topic": to }, a)), h("dd", null, b)])));
    } else if (t.id === "shortcuts") {
      kids.push(...SHORTCUTS.map(([g, rows]) => [h("h3", { class: "gd-sub" }, g),
        h("dl", { class: "gd-keys" }, rows.map(([k, a]) => [h("dt", null, keyCaps(k)), h("dd", null, a)]))]).flat());
    } else {
      const [before, after = ""] = t.body.split(FIG);
      const fig = t.fig ? h("figure", { class: "gd-fig", html: t.fig() }, h("figcaption", null, t.caption || "")) : null;
      kids.push(h("div", { class: "gd-body", html: before }));
      if (fig) kids.push(fig);
      if (after) kids.push(h("div", { class: "gd-body", html: after }));
    }
    // previous / next among the visible topics
    const list = visible.some((x) => x.id === t.id) ? visible : TOPICS;
    const i = list.findIndex((x) => x.id === t.id), prev = list[i - 1], next = list[i + 1];
    kids.push(h("div", { class: "gd-pager" },
      prev ? h("button", { type: "button", class: "c-link gd-prev", onclick: () => go(prev.id, true) }, `← ${prev.title}`) : h("span"),
      next ? h("button", { type: "button", class: "c-link gd-next", onclick: () => go(next.id, true) }, `${next.title} →`) : null));
    read.replaceChildren(...kids);
    read.scrollTop = 0;
    if (query) mark(read, query);
  }

  // cross-links inside the reading column
  read.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[data-topic]");
    if (!a) return;
    e.preventDefault();
    go(a.dataset.topic, true);
  });

  input.addEventListener("input", () => {
    query = input.value.trim();
    filter();
    if (visible.length && !visible.some((t) => t.id === current)) go(visible[0].id);
    else render(byId.get(current));
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ""; input.dispatchEvent(new Event("input")); }
    else if (e.key === "Enter" && visible.length) { e.preventDefault(); go(visible[0].id); }
  });

  return go;
}

/* Wrap every case-insensitive match of `q` in the element's text (not inside SVG) in <mark>, and bring
 * the first into view. */
function mark(root, q) {
  const needle = q.toLowerCase(), hits = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest("svg, .gd-pager, .gd-crumb") || !n.nodeValue.toLowerCase().includes(needle) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const s = n.nodeValue, lower = s.toLowerCase(), frag = document.createDocumentFragment();
    let i = 0, j;
    while ((j = lower.indexOf(needle, i)) !== -1) {
      if (j > i) frag.append(s.slice(i, j));
      const m = h("mark", { class: "gd-mark" }, s.slice(j, j + needle.length));
      hits.push(m); frag.append(m);
      i = j + needle.length;
    }
    if (i < s.length) frag.append(s.slice(i));
    n.replaceWith(frag);
  }
  const first = hits[0];
  if (first) {
    const r = first.getBoundingClientRect(), b = root.getBoundingClientRect();
    if (r.bottom > b.bottom - 24) root.scrollTop += r.top - b.top - b.height / 3;
  }
}
