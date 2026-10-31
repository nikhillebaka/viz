/**
 * Constants, Icons, Palettes, and Utility Helpers for FluSight Sandbox Lab.
 */

export const ICONS = {
  warning: `<svg class="ui-icon warning-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`,
  warningSmall: `<svg class="ui-icon warning-svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`,
  info: `<svg class="ui-icon info-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`,
  check: `<svg class="ui-icon check-svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
  play: `<svg class="ui-icon" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>`,
  rulers: `<svg class="ui-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="4" x2="6" y2="20"></line><line x1="12" y1="8" x2="12" y2="18"></line><line x1="18" y1="6" x2="18" y2="16"></line></svg>`,
  pause: `<svg class="ui-icon" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`,
  zap: `<svg class="ui-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`
};

export const SIMPLE_INFO_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;

export const PALETTE = [
  "#38bdf8", // Sky Blue
  "#fb7185", // Coral Pink
  "#34d399", // Emerald Mint
  "#fbbf24", // Warm Amber
  "#a78bfa", // Soft Lavender
  "#f97316", // Bright Tangerine
  "#2dd4bf", // Deep Teal
  "#ec4899", // Vivid Rose
  "#60a5fa", // Cornflower Blue
  "#a3e635", // Lime
  "#c084fc", // Orchid
  "#f43f5e", // Crimson
  "#06b6d4", // Electric Cyan
  "#eab308", // Sun Gold
  "#818cf8", // Indigo Periwinkle
  "#fdba74", // Light Peach
];

export const DEFINITIONS = {
  top_performer: {
    title: "Top Performing Model",
    tag: "BENCHMARK LEADER",
    desc: "The model achieving the lowest overall mean Weighted Interval Score (WIS) in the current evaluation scope.",
    howCalculated: "Lowest mean WIS score among all evaluated models in active view",
    breakdown: "Identifies the lowest-scoring model in the active view. When Common Tasks is enabled, scores reflect shared test dates.",
    target: "Lowest mean WIS score in active view.",
    sectionId: "methodology-wis",
  },
  mean_wis: {
    title: "Cohort Average WIS",
    tag: "ENSEMBLE BENCHMARK",
    desc: "The unweighted arithmetic mean of Weighted Interval Scores across all currently selected models in the active evaluation view.",
    howCalculated: "Sum of mean WIS scores across selected models ÷ Count of selected models",
    breakdown: "Arithmetic mean of WIS scores across selected models.",
    target: "Lower is better.",
    sectionId: "methodology-wis",
  },
  cov95: {
    title: "95% Prediction Interval Coverage",
    tag: "CALIBRATION",
    desc: "The empirical percentage of observed ground-truth values falling within the model's nominal 95% interval (between the 2.5% and 97.5% quantiles).",
    howCalculated: "(Count of observations inside [q0.025, q0.975] ÷ Total observations) × 100%",
    breakdown: "Evaluates nominal 95% uncertainty interval coverage. Values below 95% indicate intervals are narrower than expected; values above indicate wider intervals.",
    target: "Nominal Target: 95.0%.",
    sectionId: "methodology-coverage",
  },
  cov50: {
    title: "50% Interquartile Range (IQR) Coverage",
    tag: "CENTRAL CALIBRATION",
    desc: "The percentage of observed ground-truth values falling within the central 50% interval (between the 25th and 75th percentiles).",
    howCalculated: "(Count of observations inside [q0.25, q0.75] ÷ Total observations) × 100%",
    breakdown: "Evaluates nominal 50% interquartile range coverage.",
    target: "Nominal Target: 50.0%.",
    sectionId: "methodology-coverage",
  },
  mae: {
    title: "Mean Absolute Error (Median MAE)",
    tag: "POINT ACCURACY",
    desc: "The average absolute difference between the model's median prediction (q = 0.50) and actual observed hospital admissions.",
    howCalculated: "Sum of |Actual Hospitalizations - Predicted Median| ÷ Total Forecasts",
    breakdown: "Measures absolute point error of the predictive median in weekly admissions.",
    target: "Lower is better.",
    sectionId: "methodology-wis",
  },
  sharpness: {
    title: "Forecast Sharpness (95% Interval Width)",
    tag: "UNCERTAINTY SPREAD",
    desc: "The average width of the model's nominal 95% prediction interval (q0.975 - q0.025).",
    howCalculated: "Average of (q0.975 - q0.025) across all evaluated dates and locations",
    breakdown: "Measures interval width (q0.975 - q0.025) independent of observed outcomes.",
    target: "Lower is better when nominal coverage is maintained.",
    sectionId: "methodology-coverage",
  },
  tasks: {
    title: "Evaluated Forecast Tasks (N)",
    tag: "SAMPLE SIZE",
    desc: "The total number of unique forecast targets (reference_date × location × horizon) included in the score calculation.",
    howCalculated: "Total count of scored forecast tasks (Evaluated Dates × Locations × Horizons)",
    breakdown: "Count of scored forecast units (reference_date × location × horizon).",
    target: "Larger task counts provide more stable evaluation estimates.",
    sectionId: "methodology-common",
  },
  delta_base: {
    title: "Relative Difference vs Baseline (Δ%)",
    tag: "BENCHMARK SKILL",
    desc: "Percentage difference in mean WIS relative to the benchmark baseline model on pairwise shared tasks.",
    howCalculated: "((Model WIS - Baseline WIS) ÷ Baseline WIS) × 100% computed strictly on pairwise shared tasks",
    breakdown: "Percentage difference in mean WIS relative to baseline on pairwise shared tasks.",
    target: "Negative is better (< 0% indicates lower error than baseline).",
    sectionId: "methodology-relative-wis",
  },
  season_phase: {
    title: "Season Phases (Pre-peak / Peak / Post-peak)",
    tag: "EVALUATION WINDOW",
    desc: "Restricts scoring to forecasts of weeks in a given phase of each location's own season, judged from its observed truth curve.",
    howCalculated: "Peak = contiguous weeks around the season maximum with values ≥ 60% of that maximum; pre-peak and post-peak are the weeks before and after",
    breakdown: "Phases are assigned per location and season, so with All States each state is scored on its own peak rather than the national one. A season whose highest week is still among its latest observations has not peaked yet and counts as pre-peak. Combine with seasons and a week range for windows like 'peak weeks of the last three seasons'.",
    target: "Typical peak: 3–6 weeks per location and season.",
    sectionId: "methodology-eval-window",
  },
  peak_forecasts: {
    title: "Season Peak Forecasts",
    tag: "SEASON PEAK",
    desc: "Two season-level targets submitted next to the weekly forecasts: when the season's highest week will be (peak week, a probability for every candidate week) and how high it will be (peak size, quantiles of the highest weekly count).",
    howCalculated: "Timing: median and central 50% / 90% windows read from the cumulative peak-week probabilities. Size: median and 50% / 90% intervals from the peak-size quantiles. ▲ marks both medians; the box spans both 50% ranges; whiskers span both 90% ranges",
    breakdown: "Peak forecasts have no horizon, so they never enter the weekly leaderboard. The observed peak is the highest reported week inside the hub's forecast window; it is provisional (◇ peak so far) until observations reach the window's last week, then final (★). Weeks tied at the maximum all count as the peak.",
    target: "A good forecast narrows onto the observed ★ as the season unfolds.",
    sectionId: "methodology-season-peak",
  },
  peak_evolution: {
    title: "Peak Call by Round",
    tag: "SEASON PEAK",
    desc: "One model's peak forecasts across every round of the season, one row per round: the probability it gave each week of being the peak (left) and its peak-size interval (right).",
    howCalculated: "Cell shade = probability of that peak week; the line traces the median peak week; ticks mark each round's data cutoff (weeks left of the tick were already observed); vertical lines mark the observed peak",
    breakdown: "Read top to bottom to see a model converge (or not) on the peak. Click a row to open that round everywhere in the dashboard.",
    target: "Mass should gather around the observed peak week well before it happens.",
    sectionId: "methodology-season-peak",
  },
  peak_scores: {
    title: "Peak Scores",
    tag: "SEASON PEAK",
    desc: "Scores for peak forecasts once the observed peak is final. Timing uses the ranked probability score and log score; size uses the same weighted interval score as the leaderboard.",
    howCalculated: "RPS = Σ_w (F(w) − 1[w ≥ observed week])² over the ordered candidate weeks, in weeks (a certain forecast scores its absolute week error). Log = −ln P(observed week), floored at P = 0.001. Size WIS is shown as % of the observed peak so states of different sizes can be pooled",
    breakdown: "This Round lists each model's call for the selected round (with errors once the peak is final). Season Skill averages every round of the season for the shown location, or pools all states with a final peak. Turn on the leaderboard's common-tasks toggle to score every model on the same rounds.",
    target: "Lower RPS, log score and WIS % are better; 50% / 90% windows should contain the observed peak about 50% / 90% of the time.",
    sectionId: "methodology-season-peak",
  },
  weekly_wins: {
    title: "Wins (Weeks Ranked #1)",
    tag: "WEEK-BY-WEEK",
    desc: "How many rounds in scope this model had the lowest WIS among the selected models, out of the rounds it competed in.",
    howCalculated: "Per round: mean WIS on the tasks every selected model forecast that week; the lowest wins (ties count for each tied model)",
    breakdown: "Relative WIS weights each forecast equally, so a few high-incidence weeks can decide it. Wins counts each week once, showing whether a lead is consistent or earned in a handful of weeks. It depends on which models are selected and follows the Natural/Log scale toggle.",
    target: "Higher is better; read alongside Rel WIS.",
    sectionId: "methodology-eval-window",
  },
  common_tasks: {
    title: "Common Tasks Intersection (Fair Backtest)",
    tag: "EVALUATION SCOPE",
    desc: "Restricts scoring strictly to identical (reference_date, location, horizon) forecast units shared across all evaluated models.",
    howCalculated: "Set intersection of task tuples across all active models in scope",
    breakdown: "Restricts scoring to the intersection of tasks shared across all evaluated models, eliminating coverage disparities.",
    target: "Enable when comparing models with differing submission schedules.",
    sectionId: "methodology-common",
  },
  relative_wis: {
    title: "Pairwise Tournament Relative WIS",
    tag: "HUBVERSE TOURNAMENT STANDARD",
    desc: "Geometric mean of pairwise mean WIS ratios across all models, normalized to 1.0 for the benchmark baseline (Cramer et al., 2022).",
    howCalculated: "Pairwise tournament geometric mean scaled relative to baseline: θ_m = (∏_m' θ_m,m')^(1/M), Rel WIS = θ_m / θ_baseline",
    breakdown: "Standard tournament evaluation metric adjusting for unequal task sets across models.",
    target: "Lower is better (< 1.0 indicates outperformance relative to baseline).",
    sectionId: "methodology-relative-wis",
  },
  wis_per_100k: {
    title: "Population-Standardized Rate WIS (per 100k)",
    tag: "POPULATION STANDARDIZATION",
    desc: "Weighted Interval Score standardized by jurisdiction population (WIS ÷ Population × 100,000).",
    howCalculated: "(WIS ÷ Population) × 100,000",
    breakdown: "Standardizes scores per 100,000 residents so state comparisons are not dominated by high-population jurisdictions.",
    target: "Lower is better.",
    sectionId: "methodology-wis",
  },
  model_type: {
    title: "Model Methodology Type",
    tag: "MODEL CLASSIFICATION",
    desc: "Classification of forecasting architecture: Baseline (official benchmark), Production Hub (submitted CDC ensemble/component), or Staged (experimental iteration).",
    howCalculated: "Assigned via model configuration metadata",
    breakdown: "Categorizes model provenance: baseline benchmark, repository submission, or local staging.",
    target: "Enables filtering by model category.",
    sectionId: "methodology-overview",
  },
  h0: {
    title: "Horizon 0 Nowcast (h=0)",
    tag: "REAL-TIME NOWCAST",
    desc: "Mean WIS evaluated specifically on the current reference week (h=0), isolating immediate real-time reporting lag error.",
    howCalculated: "Mean WIS for horizon = 0 across evaluated forecast dates and locations",
    breakdown: "Nowcasting evaluates real-time situational clarity independently from multi-week forward trajectory projections.",
    target: "Lower is better. Reflects rapid situational clarity.",
    sectionId: "methodology-wis",
  },
  horizons: {
    title: "Forecast Horizons (h=1 to h=3)",
    tag: "LEAD TIME HORIZONS",
    desc: "Lead-time evaluation across forward projection weeks: h=1 (1 week ahead), h=2 (2 weeks ahead), and h=3 (3 weeks ahead).",
    howCalculated: "Mean WIS stratified by target forecast horizon (h=1, 2, 3 weeks)",
    breakdown: "Quantifies how model predictive skill and uncertainty decay as the forecast horizon extends into the future.",
    target: "Lower is better across all horizons. Gradual skill decay demonstrates robust epidemic dynamic modeling.",
    sectionId: "methodology-wis",
  },
  h1: {
    title: "Horizon 1 Forecast (1-Week Ahead)",
    tag: "SHORT-TERM PROJECTION",
    desc: "Mean WIS evaluated on 1-week-ahead forecast horizon.",
    howCalculated: "Mean WIS for horizon = 1",
    breakdown: "Evaluates immediate short-term epidemic trajectory forecasting skill.",
    target: "Lower is better.",
    sectionId: "methodology-wis",
  },
  h2: {
    title: "Horizon 2 Forecast (2-Weeks Ahead)",
    tag: "MID-TERM PROJECTION",
    desc: "Mean WIS evaluated on 2-week-ahead forecast horizon.",
    howCalculated: "Mean WIS for horizon = 2",
    breakdown: "Evaluates mid-term epidemic trajectory and turning-point anticipation.",
    target: "Lower is better.",
    sectionId: "methodology-wis",
  },
  h3: {
    title: "Horizon 3 Forecast (3-Weeks Ahead)",
    tag: "EXTENDED PROJECTION",
    desc: "Mean WIS evaluated on 3-week-ahead forecast horizon.",
    howCalculated: "Mean WIS for horizon = 3",
    breakdown: "Evaluates extended trajectory skill at the limit of the standard FluSight horizon.",
    target: "Lower is better.",
    sectionId: "methodology-wis",
  },
  synth_vincentization: {
    title: "Quantile Vincentization",
    tag: "COMBINATION METHOD",
    desc: "Combines predictive probability distributions by aggregating across corresponding quantiles of constituent models.",
    howCalculated: "Pointwise Median: Median(q_alpha,1, ..., q_alpha,M) for each quantile level alpha in [0.01, ..., 0.99]",
    breakdown: "Hubverse standard for FluSight ensembles. Pointwise median is resilient to extreme outlier models; pointwise mean is an equal-weighted expectation.",
    target: "Ensemble predictive distribution.",
    sectionId: "methodology-wis",
  },
  synth_spatial_routing: {
    title: "Spatial Split Routing",
    tag: "SPATIAL RESOLUTION",
    desc: "Assigns separate model combination pools for state-level forecasts versus US national forecasts.",
    howCalculated: "States Pool: applied to 50 US States, DC, and PR. National Pool: applied to location 'US'.",
    breakdown: "Mirrors operational Hub models (e.g. UMass-flusion_spatial2_prod) where specialized spatial models forecast states while aggregate models forecast national volume.",
    target: "Location-tailored ensemble forecasts.",
    sectionId: "methodology-overview",
  },
  synth_missing_policy: {
    title: "Missing Submissions Handling",
    tag: "TASK INTEGRITY",
    desc: "Governs ensemble behavior when one or more constituent models did not submit forecasts for a specific reference date or task.",
    howCalculated: "Flexible: Each task (date × location × horizon) pools the members that forecast it, using only quantile levels all of them submitted. Strict: Drops tasks where any member is absent.",
    breakdown: "Flexible mode maximizes evaluation sample size. Strict mode guarantees an identical apples-to-apples cohort across every forecast horizon.",
    target: "Robust backtesting coverage.",
    sectionId: "methodology-wis",
  },
  synth_integrity: {
    title: "Monotonic Quantiles & Rearrangement",
    tag: "DATA INTEGRITY",
    desc: "Enforces non-decreasing quantile values within every forecast task to prevent quantile crossing.",
    howCalculated: "Monotonic Rearrangement: sort(q_k) over each (reference_date, horizon, location) group.",
    breakdown: "Pointwise quantile combination can occasionally cause crossing if constituent distributions have discordant tail shapes. Rearrangement mathematically guarantees valid prediction intervals (q_0.975 >= q_0.025).",
    target: "Mathematically consistent prediction intervals.",
    sectionId: "methodology-wis",
  },
  heatmap_matrix: {
    title: "Heatmap View",
    tag: "SPATIAL & TEMPORAL HEATMAP",
    desc: "A two-dimensional visualization showing surveillance data, forecast projections, and model evaluations across time, geography, and models.",
    howCalculated: "Bivariate grid aggregation across jurisdictions, horizons, dates, and models",
    breakdown: "Complements the Timeline Fan and US Spatial Map by showing nationwide wave timing, regional variations, and lead-time patterns.",
    target: "Multi-jurisdiction pattern discovery.",
    sectionId: "methodology-part4-heading",
  },
  heatmap_modes: {
    title: "Heatmap View Modes",
    tag: "VIEW MODES",
    desc: "Analytical views including Epidemic Wave (Location × Date), Forward Outlook (Location × Horizon), Model Breakdown (Model × Location), Horizon Decay (Model × Horizon), and Timeline (Model × Date).",
    howCalculated: "Preset query configurations mapped to data loader aggregations",
    breakdown: "Allows pivoting between epidemic wave tracking, near-term forecast horizons, and multi-model benchmarking.",
    target: "Exploratory forecasting workflows.",
    sectionId: "methodology-part4-heading",
  },
  heatmap_layers: {
    title: "Heatmap Metrics",
    tag: "METRIC LAYERS",
    desc: "Values displayed in the heatmap cells: Population Rate (admissions per 100k), Admissions Volume (patient counts), Weekly Change (% WoW growth), or Weighted Interval Score (WIS error).",
    howCalculated: "Rate per 100k = (Admissions ÷ Population) × 100,000; Weekly Change = ((Value_t - Value_t-1) ÷ Value_t-1) × 100%",
    breakdown: "Rates normalize across jurisdictions; weekly change shows acceleration; WIS evaluates model forecast accuracy.",
    target: "Situational awareness and evaluation.",
    sectionId: "methodology-part4-heading",
  },
  row_normalization: {
    title: "Peak Normalization",
    tag: "SCALING",
    desc: "Scales each row independently between 0.0 (off-peak baseline) and 1.0 (seasonal peak maximum): v' = (v - min) / (max - min).",
    howCalculated: "v_normalized = (v_row - min_row) ÷ (max_row - min_row) for each non-null cell",
    breakdown: "Removes magnitude differences between large and small states, aligning all jurisdictions on an equal 0–100% scale to highlight relative epidemic timing.",
    target: "Comparing epidemic timing across states.",
    sectionId: "methodology-part4-heading",
  },
  wave_cascade: {
    title: "Peak-Timing Sort",
    tag: "SORT ORDER",
    desc: "Sorts jurisdictions along the vertical axis by the week of their peak incidence, displaying the chronological progression of epidemic waves.",
    howCalculated: "Index of peak seasonal incidence for each state row",
    breakdown: "Reveals the geographic progression of respiratory waves across different regions of the country.",
    target: "Diagnosing wave progression and regional lag.",
    sectionId: "methodology-part4-heading",
  },
  hhs_regions: {
    title: "HHS Health Regions (1–10)",
    tag: "PUBLIC HEALTH JURISDICTIONS",
    desc: "The 10 official US Department of Health and Human Services (HHS) administrative regions grouping contiguous states with shared epidemiological surveillance networks.",
    howCalculated: "Grouping of 50 states, DC, and PR into federal health regions (Region 1 New England through Region 10 Pacific Northwest)",
    breakdown: "Groups geographically related states to distinguish broader regional trends from localized reporting fluctuations.",
    target: "Regional cluster analysis.",
    sectionId: "methodology-part4-heading",
  },
  actual_truth: {
    title: "Observed Ground Truth (NHSN)",
    tag: "SURVEILLANCE GROUND TRUTH",
    desc: "Official laboratory-confirmed weekly influenza hospital admissions reported by healthcare facilities and published by the CDC National Healthcare Safety Network (NHSN).",
    howCalculated: "Sum of laboratory-confirmed influenza admissions across hospital reporting facilities for the epi-week",
    breakdown: "Represents the official epidemiological ground truth used to evaluate forecast accuracy, calculate Weighted Interval Scores, and track retrospective epidemic curves.",
    target: "Official CDC NHSN surveillance baseline.",
    sectionId: "methodology-overview",
  },
  epidemic_trajectory: {
    title: "Weekly Change (% WoW Growth)",
    tag: "EPIDEMIC MOMENTUM",
    desc: "The week-over-week percentage change in weekly hospital admissions, capturing immediate transmission velocity.",
    howCalculated: "((Admissions_t - Admissions_t-1) ÷ Admissions_t-1) × 100%",
    breakdown: "Positive values (> 0%) reflect expanding epidemic transmission; negative values (< 0%) reflect decelerating transmission post-peak.",
    target: "> 0% = Surge / Expansion; < 0% = Decline.",
    sectionId: "methodology-part4-heading",
  },
  wis_evaluation: {
    title: "Model Evaluation (Weighted Interval Score)",
    tag: "PROBABILISTIC ACCURACY",
    desc: "A proper scoring rule evaluating the calibration and precision of probabilistic quantile forecasts against observed hospital admissions.",
    howCalculated: "WIS = (1 / (K + 0.5)) × (0.5 × |y - m| + ∑_k (α_k / 2) × IS_αk)",
    breakdown: "Penalizes interval spread as well as under-prediction and over-prediction. Lower scores indicate superior probabilistic accuracy.",
    target: "Lower is better.",
    sectionId: "methodology-wis",
  },
  ref_date: {
    title: "Forecast Reference Date",
    tag: "SUBMISSION TIMELINE",
    desc: "The official Saturday cutoff date anchoring the submission round. All forward projections (h=0 Nowcast through h=3 extended horizon) are evaluated relative to this date.",
    howCalculated: "CDC Epi-Week Saturday calendar date (YYYY-MM-DD)",
    breakdown: "Ensures uniform real-time comparison across all models submitting to the CDC FluSight Hub.",
    target: "Official weekly forecast anchor.",
    sectionId: "methodology-overview",
  },
  spatial_layers: {
    title: "Spatial Map Metric Layers",
    tag: "SPATIAL RESOLUTION",
    desc: "Selectable epidemiological metrics rendered on the interactive nationwide US choropleth map.",
    howCalculated: "Rate / 100k, Admissions Volume, WoW % Trend, or WIS Forecast Error",
    breakdown: "Enables switching between per-capita burden, absolute patient counts, transmission momentum, and model accuracy across jurisdictions.",
    target: "Multi-dimensional geographic situational awareness.",
    sectionId: "methodology-part2-heading",
  },
  forecast_horizons: {
    title: "Forecast Horizons (h=0 to h=3)",
    tag: "PROJECTION LEAD TIME",
    desc: "Evaluation across forward projection lead times: h=0 (current week nowcast), h=1 (1 week ahead), h=2 (2 weeks ahead), and h=3 (3 weeks ahead).",
    howCalculated: "Target End Date = Reference Date + (horizon × 7 days)",
    breakdown: "Quantifies how model skill and uncertainty evolve from real-time nowcasts to extended multi-week horizons.",
    target: "Lower error across all horizons.",
    sectionId: "methodology-wis",
  },
  projected_admissions: {
    title: "Projected Admissions (Median)",
    tag: "POINT FORECAST",
    desc: "The predictive median (quantile q = 0.50) forecast value for weekly influenza hospital admissions.",
    howCalculated: "50th percentile of model probabilistic forecast distribution",
    breakdown: "Represents the model's central estimate for admissions in the target week.",
    target: "Minimizes expected absolute error.",
    sectionId: "methodology-wis",
  },
  incidence_rate: {
    title: "Incidence Rate (per 100k)",
    tag: "POPULATION STANDARDIZATION",
    desc: "Weekly hospital admissions standardized by jurisdiction population: (Admissions ÷ Population) × 100,000.",
    howCalculated: "(Weekly Hospital Admissions ÷ State Population) × 100,000",
    breakdown: "Adjusts for population differences to enable fair epidemiological comparisons across states of varying sizes.",
    target: "Standardized burden metric.",
    sectionId: "methodology-part2-heading",
  },
  highest_incidence: {
    title: "Current Hotspot (Highest Incidence)",
    tag: "EPIDEMIC HOTSPOT",
    desc: "The jurisdiction with the highest population-standardized influenza admission rate for the active reference week.",
    howCalculated: "max(Admissions_i ÷ Population_i × 100,000) across all jurisdictions",
    breakdown: "Highlights the geographic area experiencing the highest per-capita healthcare demand.",
    target: "Identifies focal transmission centers.",
    sectionId: "methodology-part2-heading",
  },
  fastest_surge: {
    title: "Fastest Surge (% Growth)",
    tag: "ACCELERATION ALERT",
    desc: "The jurisdiction experiencing the steepest week-over-week percentage increase in admissions.",
    howCalculated: "max((Admissions_t - Admissions_t-1) ÷ Admissions_t-1 × 100%)",
    breakdown: "Provides early warning of rapidly developing regional epidemic waves.",
    target: "Early surge detection.",
    sectionId: "methodology-part2-heading",
  },
  national_sum: {
    title: "National Total Hospitalizations",
    tag: "US VOLUME",
    desc: "Total aggregate influenza hospital admissions summed across all 50 US states, DC, and Puerto Rico.",
    howCalculated: "Sum of weekly admissions across all reporting jurisdictions",
    breakdown: "Measures overall nationwide burden on the healthcare system.",
    target: "National capacity planning.",
    sectionId: "methodology-part2-heading",
  },
  wave_spread_status: {
    title: "Wave Spread Status",
    tag: "GEOGRAPHIC DISPERSION",
    desc: "Epidemiological classification of how widely transmission is accelerating across HHS regions.",
    howCalculated: "Proportion of jurisdictions showing expanding week-over-week trends (> 5% growth)",
    breakdown: "Distinguishes isolated regional clusters from broad nationwide epidemic waves.",
    target: "Nationwide propagation diagnosis.",
    sectionId: "methodology-part2-heading",
  },
  decomp_sharpness: {
    title: "WIS Sharpness (Interval Width)",
    tag: "UNCERTAINTY SPREAD",
    desc: "The sharpness component of the Weighted Interval Score, measuring the average width of forecast prediction intervals.",
    howCalculated: "Weighted sum of prediction interval widths: ∑_k (α_k / 2) × (q_upper,k - q_lower,k)",
    breakdown: "Evaluates how tight the model's predictions are, independent of observed outcomes. Narrower intervals produce lower scores.",
    target: "Lower is better when nominal coverage is maintained.",
    sectionId: "methodology-wis",
  },
  decomp_overpred: {
    title: "WIS Overprediction Penalty",
    tag: "BIAS PENALTY",
    desc: "Penalty assessed when observed admissions fall below the model's prediction intervals.",
    howCalculated: "∑_k (2 / α_k) × max(0, q_lower,k - actual)",
    breakdown: "Quantifies the frequency and magnitude of forecasts predicting higher admissions than occurred.",
    target: "Lower is better (0.0 indicates no under-shooting observations).",
    sectionId: "methodology-wis",
  },
  decomp_underpred: {
    title: "WIS Underprediction Penalty",
    tag: "BIAS PENALTY",
    desc: "Penalty assessed when observed admissions exceed the model's prediction intervals.",
    howCalculated: "∑_k (2 / α_k) × max(0, actual - q_upper,k)",
    breakdown: "Quantifies the severity of unanticipated epidemic surges that exceeded the model's upper bounds.",
    target: "Lower is better (0.0 indicates no surprise spikes).",
    sectionId: "methodology-wis",
  },
  reliability_diagram: {
    title: "Empirical Reliability Diagram",
    tag: "CALIBRATION DIAGNOSTIC",
    desc: "Plots nominal prediction interval coverage against observed empirical coverage across all scored forecast tasks.",
    howCalculated: "Observed Coverage % plotted against Nominal % (50%, 80%, 95%)",
    breakdown: "Curves tracking the 1:1 diagonal indicate well-calibrated probabilistic models. Curves below the line indicate overconfidence.",
    target: "Alignment along the 1:1 diagonal.",
    sectionId: "methodology-coverage",
  },
  horizon_decay: {
    title: "Lead-Time Horizon Decay",
    tag: "SKILL DEGRADATION",
    desc: "Quantifies the rate at which forecast accuracy decays and prediction interval uncertainty expands as lead time extends from h=0 to h=3.",
    howCalculated: "Stratified mean WIS and interval width evaluated separately for h=0, h=1, h=2, and h=3",
    breakdown: "Models with flatter degradation curves maintain dependable guidance further into the future.",
    target: "Gradual, predictable skill degradation.",
    sectionId: "methodology-wis",
  },
  ind_display_modes: {
    title: "Indicator Display Modes",
    tag: "VISUALIZATION MODE",
    desc: "Switch between Dual Y-Axis (displaying technical indicators on an auxiliary right axis) and Normalized % (scaling all signals to 0–100% of seasonal peak).",
    howCalculated: "Dual Y-Axis scales secondary signals independently; Normalized % divides each signal by its seasonal maximum",
    breakdown: "Normalized mode aligns signals with different units to enable direct visual inspection of lead and lag timing.",
    target: "Signal alignment and timing discovery.",
    sectionId: "methodology-part3-heading",
  },
  ind_nssp: {
    title: "NSSP Emergency Dept % CLI / ILI",
    tag: "SYNDROMIC SURVEILLANCE",
    desc: "Percentage of total emergency department visits diagnosed with influenza-like illness from the CDC National Syndromic Surveillance Program.",
    howCalculated: "(ED Visits with Influenza / Total ED Visits) × 100%",
    breakdown: "A rapid syndromic indicator that often leads laboratory-confirmed hospital admissions by 1 to 2 weeks.",
    target: "Early syndromic indicator.",
    sectionId: "methodology-part3-heading",
  },
  ind_ilinet: {
    title: "CDC ILINet Outpatient % ILI",
    tag: "OUTPATIENT SURVEILLANCE",
    desc: "Percentage of outpatient provider visits with influenza-like illness from the CDC Outpatient Influenza-like Illness Surveillance Network.",
    howCalculated: "(Outpatient ILI Patient Visits ÷ Total Outpatient Visits) × 100%",
    breakdown: "Captures community-level outpatient consultations, typically peaking prior to inpatient admissions.",
    target: "Community transmission indicator.",
    sectionId: "methodology-part3-heading",
  },
  ind_flusurvnet: {
    title: "CDC FluSurv-NET Rate / 100k",
    tag: "LABORATORY SURVEILLANCE",
    desc: "Laboratory-confirmed influenza hospitalization rates from participating sentinel surveillance network catchment areas.",
    howCalculated: "Hospitalizations per 100,000 population within participating network sites",
    breakdown: "High-specificity clinical surveillance providing confirmatory benchmarks for statewide admissions.",
    target: "Sentinel clinical confirmation.",
    sectionId: "methodology-part3-heading",
  },
  ind_ma2: {
    title: "2-Week Moving Average",
    tag: "TECHNICAL SMOOTHING",
    desc: "Short-term two-week arithmetic moving average of hospital admissions.",
    howCalculated: "(Value_t + Value_t-1) ÷ 2",
    breakdown: "Filters day-of-week reporting fluctuations while remaining responsive to turning points.",
    target: "Short-term trend smoothing.",
    sectionId: "methodology-part3-heading",
  },
  ind_ma4: {
    title: "4-Week Moving Average",
    tag: "TECHNICAL SMOOTHING",
    desc: "Medium-term four-week arithmetic moving average of weekly hospital admissions.",
    howCalculated: "(Value_t + Value_t-1 + Value_t-2 + Value_t-3) ÷ 4",
    breakdown: "Smooths seasonal curves to reveal underlying baseline epidemic trajectories.",
    target: "Medium-term trend identification.",
    sectionId: "methodology-part3-heading",
  },
  ind_ema3: {
    title: "3-Week Exponential Moving Average (EMA)",
    tag: "WEIGHTED SMOOTHING",
    desc: "Exponentially weighted moving average with multiplier α = 2 / (3 + 1) = 0.5.",
    howCalculated: "EMA_t = Value_t × 0.5 + EMA_t-1 × 0.5",
    breakdown: "Applies greater weight to recent observations, reducing lag compared to simple moving averages.",
    target: "Responsive curve smoothing.",
    sectionId: "methodology-part3-heading",
  },
  ind_velocity: {
    title: "Weekly Case Velocity",
    tag: "FIRST DERIVATIVE",
    desc: "First derivative of hospital admissions representing the week-over-week net change in patient volume.",
    howCalculated: "Velocity_t = Admissions_t - Admissions_t-1",
    breakdown: "Positive velocity marks epidemic expansion; crossing zero from positive to negative identifies seasonal peak inflection.",
    target: "Inflection point identification.",
    sectionId: "methodology-part3-heading",
  },
  ind_growth: {
    title: "Weekly Growth Rate (% WoW)",
    tag: "PERCENTAGE ACCELERATION",
    desc: "Percentage rate of change in hospital admissions from the preceding week.",
    howCalculated: "((Admissions_t - Admissions_t-1) ÷ Admissions_t-1) × 100%",
    breakdown: "Measures epidemic momentum independent of total patient counts.",
    target: "Transmission acceleration tracking.",
    sectionId: "methodology-part3-heading",
  },
  ind_prior_seasons: {
    title: "Historical Influenza Waves",
    tag: "EPIDEMIC CONTEXT",
    desc: "Overlays surveillance curves from prior influenza seasons (2022–2023, 2023–2024).",
    howCalculated: "Historic CDC surveillance curves aligned by CDC epi-week",
    breakdown: "Allows comparing current epidemic severity, wave timing, and peak magnitude against historical baselines.",
    target: "Multi-year historical benchmarking.",
    sectionId: "methodology-part3-heading",
  },
  ind_season_peak: {
    title: "Seasonal Peak Inflection",
    tag: "PEAK DIAGNOSTIC",
    desc: "The single highest weekly admission value recorded during the season.",
    howCalculated: "max(Admissions_t) over all weeks of the season",
    breakdown: "Pinpoints the apex of healthcare demand and anchors normalized scale comparisons.",
    target: "Seasonal maximum demand anchor.",
    sectionId: "methodology-part3-heading",
  },
  ind_unrevised: {
    title: "As-of Reports",
    tag: "POINT-IN-TIME SURVEILLANCE",
    desc: "Point-in-time surveillance observations as published as of the forecast reference date, capturing intermediate reporting revisions prior to finalized oracle truth.",
    howCalculated: "Weekly CDC snapshot archive (as_of <= reference_date)",
    breakdown: "Illustrates the reporting lag and retrospective adjustment trajectory, clarifying where model divergence is attributable to preliminary reporting delays versus forecast error.",
    target: "Diagnostic for reporting lag, retrospective adjustments, and real-time data revisions.",
    sectionId: "methodology-part3-heading",
  },
  log_scale: {
    title: "Log-Scale Evaluation ln(y + 1)",
    tag: "SCALE TRANSFORMATION",
    desc: "Evaluates predictive accuracy on transformed scale y_log = ln(max(y, 0) + 1) and q_log = ln(max(q, 0) + 1), mitigating scale distortion between high- and low-incidence jurisdictions.",
    howCalculated: "Scores pinball loss and MAE after applying ln(value + 1) to both forecast quantiles and observed ground truth",
    breakdown: "Computes Log WIS, Log Tournament Relative WIS, and Log MAE under the standard Hubverse Bosse et al. (2023) transformation.",
    target: "Harmonizes evaluation across jurisdictions of varying population size and incidence levels.",
    sectionId: "methodology-log-scale",
  },
  synthetic_ensemble: {
    title: "Synthetic Ensemble Studio",
    tag: "CUSTOM VINCENTIZATION",
    desc: "Interactive tool to combine individual forecasting models into custom quantile ensembles using Vincentization (median or mean quantile averaging) with strict monotonicity enforcement.",
    howCalculated: "Averages predictive quantiles across constituent models per task: q_ens(α) = Aggregate(q_1(α), ..., q_M(α)), followed by quantile rearrangement to prevent crossing",
    breakdown: "Supports optional spatial routing (separate constituent pools for states vs US national, matching Hubverse production standards).",
    target: "Enables researchers to test novel ensemble combinations, spatial routing hypotheses, and constituent weights.",
    sectionId: "methodology-ensemble-studio",
  },
};

export const HHS_REGIONS = {
  1: { name: "Region 1 (New England)", short: "Reg 1", states: ["CT", "ME", "MA", "NH", "RI", "VT"] },
  2: { name: "Region 2 (NY/NJ/PR)", short: "Reg 2", states: ["NJ", "NY", "PR", "VI"] },
  3: { name: "Region 3 (Mid-Atlantic)", short: "Reg 3", states: ["DE", "DC", "MD", "PA", "VA", "WV"] },
  4: { name: "Region 4 (Southeast)", short: "Reg 4", states: ["AL", "FL", "GA", "KY", "MS", "NC", "SC", "TN"] },
  5: { name: "Region 5 (Great Lakes / Midwest)", short: "Reg 5", states: ["IL", "IN", "MI", "MN", "OH", "WI"] },
  6: { name: "Region 6 (South Central)", short: "Reg 6", states: ["AR", "LA", "NM", "OK", "TX"] },
  7: { name: "Region 7 (Central)", short: "Reg 7", states: ["IA", "KS", "MO", "NE"] },
  8: { name: "Region 8 (Mountain)", short: "Reg 8", states: ["CO", "MT", "ND", "SD", "UT", "WY"] },
  9: { name: "Region 9 (Pacific Southwest)", short: "Reg 9", states: ["AZ", "CA", "HI", "NV", "AS", "GU", "MP"] },
  10: { name: "Region 10 (Pacific Northwest)", short: "Reg 10", states: ["AK", "ID", "OR", "WA"] },
};

export const STATE_TO_HHS_REGION = {};
for (const [rId, rInfo] of Object.entries(HHS_REGIONS)) {
  for (const st of rInfo.states) {
    STATE_TO_HHS_REGION[st] = Number(rId);
  }
}

export const HEATMAP_PALETTES = [
  { id: "YlOrRd", name: "Warm Amber / Red", type: "sequential" },
  { id: "Viridis", name: "Viridis (Uniform)", type: "sequential" },
  { id: "Blues", name: "Clean Blue", type: "sequential" },
  { id: "RdBu", name: "Red-Blue (Diverging)", type: "diverging" },
];

export const INDICATOR_META = {
  hosp_raw: { label: "Hospital Admissions (Unadjusted)", unit: "Patients/wk", color: "#38bdf8" },
  ed_pct: { label: "Emergency Dept Flu Visits (%)", unit: "% ED Visits", color: "#fb7185" },
  ili_activity: { label: "Outpatient ILI Activity Level", unit: "Level 1-13", color: "#34d399" },
  positivity: { label: "Clinical Lab Test Positivity (%)", unit: "% Positive", color: "#fbbf24" },
  unrevised: { label: "As-of Reports", name: "As-of Reports", shortLabel: "As-of", unit: "Patients/wk", pipClass: "pip-unrevised", color: "#94a3b8" },
  peak_forecasts: { label: "Peak Forecasts", name: "Peak Forecasts", shortLabel: "Peaks", unit: "", pipClass: "pip-peakfc", color: "#38bdf8" },
};

export const CHART_CONSTANTS = {
  DEFAULT_WEEKS_PAST: 11,
  DEFAULT_WEEKS_FUTURE: 8,
  Y_CEILING_HEADROOM_MULTIPLIER: 1.08,
  // A held y-axis bound may be at most this much looser than the fitted bound before it eases inward
  Y_HOLD_RATIO: 1.5,
  COLLISION_SHIFT_PX: 15,
  DAY_MS: 86400000,
  WEEK_MS: 7 * 86400000,
};

export const TECHNICAL_INDICATORS = {
  nssp: {
    id: "nssp",
    label: "NSSP Flu ED Visits",
    shortLabel: "NSSP",
    unit: "% ED Visits",
    category: "rate",
    colorLight: "#ea580c",
    colorDark: "#f97316",
    dash: "dot",
    width: 2,
    defaultAxis: "y2",
  },
  ilinet: {
    id: "ilinet",
    label: "ILINet (ILI × % Lab-Pos)",
    shortLabel: "Scaled ILI+",
    unit: "Scaled ILI+",
    category: "rate",
    colorLight: "#059669",
    colorDark: "#10b981",
    dash: "dash",
    width: 2,
    defaultAxis: "y2",
  },
  flusurvnet: {
    id: "flusurvnet",
    label: "FluSurv-NET Rate",
    shortLabel: "FluSurv",
    unit: "Rate / 100k",
    category: "rate",
    colorLight: "#0891b2",
    colorDark: "#06b6d4",
    dash: "dashdot",
    width: 2,
    defaultAxis: "y2",
  },
  ma2: {
    id: "ma2",
    label: "2-Week Moving Average",
    shortLabel: "MA-2",
    unit: "",
    category: "smoothed",
    colorLight: "#0284c7",
    colorDark: "#38bdf8",
    dash: "dot",
    width: 1.8,
    defaultAxis: "y",
  },
  ma4: {
    id: "ma4",
    label: "4-Week Moving Average",
    shortLabel: "MA-4",
    unit: "",
    category: "smoothed",
    colorLight: "#4f46e5",
    colorDark: "#818cf8",
    dash: "dash",
    width: 1.8,
    defaultAxis: "y",
  },
  ema3: {
    id: "ema3",
    label: "3-Week EMA",
    shortLabel: "EMA-3",
    unit: "",
    category: "smoothed",
    colorLight: "#9333ea",
    colorDark: "#c084fc",
    dash: "dashdot",
    width: 1.8,
    defaultAxis: "y",
  },
  velocity: {
    id: "velocity",
    label: "WoW Case Velocity",
    shortLabel: "Velocity",
    unit: "Δ Cases/Wk",
    category: "derivative",
    colorLight: "#db2777",
    colorDark: "#ec4899",
    dash: "solid",
    width: 1.6,
    defaultAxis: "y2",
  },
  growth: {
    id: "growth",
    label: "WoW Growth Rate",
    shortLabel: "Growth",
    unit: "% WoW",
    category: "derivative",
    colorLight: "#ca8a04",
    colorDark: "#facc15",
    dash: "dot",
    width: 1.6,
    defaultAxis: "y2",
  },
  unrevised: {
    id: "unrevised",
    label: "As-of Reports",
    shortLabel: "As-of",
    unit: "",
    category: "benchmark",
    colorLight: "rgba(100, 116, 139, 0.55)",
    colorDark: "rgba(148, 163, 184, 0.45)",
    dash: "dash",
    width: 1.6,
    defaultAxis: "y",
  },
};

export function getChartThemeColors(isLight) {
  return {
    axisColor: isLight ? "#586e75" : "#94a3b8",
    gridColor: isLight ? "rgba(101, 123, 131, 0.14)" : "rgba(255, 255, 255, 0.04)",
    lineColor: isLight ? "rgba(101, 123, 131, 0.25)" : "rgba(255, 255, 255, 0.08)",
    spikeColor: isLight ? "rgba(101, 123, 131, 0.35)" : "rgba(255, 255, 255, 0.15)",
    legendColor: isLight ? "#073642" : "#cbd5e1",
    hoverBg: isLight ? "#eee8d5" : "#1e1d1a",
    hoverBorder: isLight ? "rgba(101, 123, 131, 0.35)" : "rgba(255, 248, 240, 0.22)",
    hoverText: isLight ? "#073642" : "#f6f4ee",
    truthHistLine: isLight ? "#93a1a1" : "#52525b",
    truthHistMarker: isLight ? "#657b83" : "#71717a",
    truthFutLine: isLight ? "#073642" : "#bbbbbb",
    truthFutMarker: isLight ? "#073642" : "#dddddd",
    truthRestLine: isLight ? "rgba(7, 54, 66, 0.42)" : "rgba(220, 220, 225, 0.40)",
    cutoffFill: isLight ? "rgba(101, 123, 131, 0.08)" : "rgba(255, 255, 255, 0.03)",
    cutoffLine: isLight ? "rgba(7, 54, 66, 0.65)" : "rgba(255, 255, 255, 0.35)",
    refLine: isLight ? "rgba(7, 54, 66, 0.60)" : "rgba(255, 255, 255, 0.30)",
    badgeBg: isLight ? "rgba(253, 246, 227, 0.92)" : "rgba(19, 18, 17, 0.92)",
    textMuted: isLight ? "#657b83" : "#94a3b8",
    unrevisedLine: isLight ? "rgba(100, 116, 139, 0.42)" : "rgba(148, 163, 184, 0.38)",
    unrevisedMarker: isLight ? "rgba(100, 116, 139, 0.38)" : "rgba(148, 163, 184, 0.32)",
  };
}

export function parseIsoDateToMs(dateStr) {
  if (!dateStr) return NaN;
  if (typeof dateStr !== "string") return new Date(dateStr).getTime();
  const clean = dateStr.split(" ")[0];
  const parts = clean.split("-").map(Number);
  if (parts.length === 3) {
    return Date.UTC(parts[0], parts[1] - 1, parts[2]);
  }
  return new Date(dateStr).getTime();
}

export function formatMsToIsoDate(ms) {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Wire a button to a popover menu: toggles on click, closes on outside click or Escape.
 */
export function bindDropdownMenu(button, menu) {
  const setOpen = (open) => {
    menu.classList.toggle("open", open);
    button.setAttribute("aria-expanded", String(open));
  };
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!menu.classList.contains("open"));
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && !button.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });
}

/**
 * Show an error strip above a plot (or clear it with an empty message), so a failed
 * fetch is visible instead of silently leaving stale data on screen.
 */
export function setFetchError(plotId, message) {
  const plotEl = document.getElementById(plotId);
  if (!plotEl || !plotEl.parentElement) return;
  let banner = plotEl.parentElement.querySelector(`.fetch-error-banner[data-for="${plotId}"]`);
  if (!message) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "fetch-error-banner";
    banner.dataset.for = plotId;
    banner.setAttribute("role", "alert");
    plotEl.parentElement.insertBefore(banner, plotEl);
  }
  banner.textContent = message;
}

export function hexToRgba(hex, alpha) {
  const clean = hex.replace("#", "");
  const num = parseInt(clean, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}


/**
 * Source tag for a model chip / table row: SYNTHETIC, a hub's short label (e.g. FLUSIGHT), LOCAL, or REPO.
 */
export function sourceTag(meta = {}) {
  if (meta.is_synthetic) return { cls: "synth", text: "SYNTHETIC", title: "Synthetic ensemble" };
  if (meta.source === "hub") {
    const label = meta.hub_label || "Hub";
    return { cls: "hub", text: label.toUpperCase(), title: `Live forecast copied from the ${label} hub` };
  }
  return meta.is_local
    ? { cls: "local", text: "LOCAL", title: "Local run in local-output/" }
    : { cls: "repo", text: "REPO", title: "Repository model in model-output/" };
}

export function sourceTagHtml(meta = {}, text) {
  const t = sourceTag(meta);
  return `<span class="chip-tag ${t.cls}" title="${escapeHtml(t.title)}">${escapeHtml(text || t.text)}</span>`;
}

/**
 * Human label for a model id. Hub models drop their '<hub>:' namespace (the source tag carries it);
 * pass { withHub: true } where no tag is shown (chart legends, select options) to keep them distinct.
 */
export function modelLabel(id, meta, { withHub = false } = {}) {
  if (!meta) return id;
  if (meta.is_synthetic && (meta.name || meta.synthetic_config?.name)) return meta.name || meta.synthetic_config.name;
  if (meta.source === "hub") {
    const name = meta.display_name || id.slice(id.indexOf(":") + 1);
    return withHub ? `${name} · ${meta.hub_label || "Hub"}` : name;
  }
  return id;
}

/**
 * Lightweight transient notification. kind: "info" | "success" | "warning" | "error".
 * Optional action: { label, onClick }. Returns a function that dismisses the toast.
 */
export function showToast(message, { kind = "info", action = null, duration = 5200 } = {}) {
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    host.className = "toast-host";
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.setAttribute("role", kind === "error" || kind === "warning" ? "alert" : "status");
  const text = document.createElement("span");
  text.className = "toast-text";
  text.textContent = message;
  toast.appendChild(text);
  let timer = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    toast.classList.add("leaving");
    setTimeout(() => toast.remove(), 180);
  };
  if (action && action.label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      dismiss();
      if (action.onClick) action.onClick();
    });
    toast.appendChild(btn);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss");
  close.innerHTML = "&times;";
  close.addEventListener("click", dismiss);
  toast.appendChild(close);
  host.appendChild(toast);
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return dismiss;
}

export function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`;
  return `${b} B`;
}

export function formatAgo(isoTs) {
  if (!isoTs) return "never";
  const t = Date.parse(isoTs.endsWith("Z") || isoTs.includes("+") ? isoTs : `${isoTs}Z`);
  if (Number.isNaN(t)) return isoTs;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
