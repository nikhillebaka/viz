# Methodology

## Evaluation Metrics Summary

The scoring engine implements standard Hubverse evaluation rules:

- **Weighted Interval Score (WIS)**: Evaluates probabilistic forecasts across standard quantiles. Decomposes into Sharpness (interval width), Overprediction penalty, and Underprediction penalty (Bracher et al., 2021).
- **Log-Scale Scoring (`ln(y + 1)`)**: In addition to natural count scale scoring, the Leaderboard and Evaluation Engine provide log-scale scoring using $y_{\log} = \ln(\max(y, 0) + 1)$ and $\hat{y}_{\log} = \ln(\max(q, 0) + 1)$. This harmonizes evaluation across high- and low-incidence jurisdictions, computing log WIS, log MAE, and pairwise tournament Relative WIS on the transformed scale (Bosse et al., 2023). Users can seamlessly toggle between Natural and Log scales via the Leaderboard toolbar.
- **Pairwise Tournament Relative WIS**: Geometric mean of pairwise mean WIS ratios across models, normalized to 1.0 for the baseline (Cramer et al., 2022). Values $< 1.0$ indicate performance better than baseline. Evaluated independently on both natural and log scales. Rankings are ordered by relative WIS, which stays comparable when models cover different task sets. If the configured baseline has no forecasts in scope, scores are scaled to a fallback model, which is reported as the baseline and flagged in the validation warnings.
- **State vs. National Pooling**: National counts are orders of magnitude larger than state counts, so whenever a scope contains states (e.g. `--location all`), every leaderboard score (WIS, relative WIS, Δ%, coverage) is computed on the state pool only. The national score is reported separately (`us_wis`).
- **Mean Absolute Error (MAE)**: Absolute error of the predictive median ($q_{0.50}$) against observed truth (computed on both natural and log scales).
- **Prediction Interval Coverage**: Percentage of observations falling inside nominal intervals (95% interval $[q_{0.025}, q_{0.975}]$ and 50% interval $[q_{0.25}, q_{0.75}]$).
- **Population-Standardized Rate WIS**: Standardizes WIS per 100,000 population ($(\text{WIS} / \text{Population}) \times 100{,}000$) to enable balanced geographic comparisons. Not reported for targets that are already rates or proportions (`is_rate`, e.g. `wk inc flu prop ed visits`).
- **Evaluation Window (Leaderboard TIME → Season ▾)**: Toggle between a single **Date** and a **Season** window. The window menu combines any set of seasons, a week range dragged across a mini chart of the season curves (for the selected location, or the national curve when *All States* is selected), and a phase preset. The window applies to the forecast (target) week. **Phases** come from each location's own truth curve: *peak* is the contiguous run of weeks around the season maximum at ≥ 60% of it, and *pre-peak* / *post-peak* are the weeks before and after. Seasons that have not peaked yet count as pre-peak. With *All States*, every state is scored on its own phases rather than the national peak.
- **Wins (weeks ranked #1)**: For each round in scope, the model with the lowest mean WIS on the tasks every selected model forecast that week wins it (ties count for each tied model). Shown as `won/competed`. It complements relative WIS: a model can lead on total WIS through a few large weeks while rarely being the best week to week. Wins depend on which models are selected.
- **Common Tasks (`--fair`)**: Restricts evaluation strictly to the intersection of tasks ($reference\_date \times location \times horizon$) where all evaluated models submitted forecasts.
- **Nowcast Horizon ($h=0$)**: Due to weekly reporting schedules, the week ending on the reference date is evaluated as an operational nowcast.
- **As-of Surveillance Reports (Point-in-Time Data Cutoff)**: Real-time surveillance data streams display as-of reports capped at the forecast submission data cutoff date (`target_end_date < reference_date`), reflecting the exact state of knowledge available to modelers when forecasts were submitted.
- **HHS Region Visual Grouping**: In the Heatmap cross-sectional view, sorting jurisdictions by HHS Region delineates jurisdictions into distinct regional clusters (Regions 1 through 10) bounded by clean divider lines and labeled on the margin with their geographic names (e.g., "Region 1 (New England)") rather than appending repetitive codes to jurisdiction names.
- **Synthetic Ensemble Studio & Vincentization**: Interactive quantile ensemble builder supporting median and mean Vincentization across selected constituent models. Includes strict quantile monotonicity enforcement (rearrangement) to eliminate crossing quantiles, and operational spatial routing (separate constituent pools for states vs. US national) matching Hubverse production standards. Each task pools one consistent member set: under the *flexible* policy a task uses the members that forecast it (restricted to quantile levels all of them submitted); under the *strict* policy tasks missing any member are dropped. Ensembles can be audited via pre-flight checks, evaluated in the Leaderboard, and persisted to `local-output/synthetic/`.

*For full mathematical definitions, derivations, and wave tracking principles, refer to the in-app **Methodology** modal.*

## Data Considerations

- **Finalized vs. Real-Time Observations**: The visualizer evaluates forecasts against the latest available ground-truth oracle. Retrospective revisions in hospital reporting may cause aggregate scores here to differ slightly from real-time evaluation reports that scored against unrevised data.
- **Continuous vs. Categorical Targets**: The interval scoring engine (WIS) is designed for continuous quantile forecasts. Categorical targets (such as rate change categories) display probability distributions rather than interval scores.
- **Historical Surveillance Coverage**: Bundled ILINet and FluSurv-NET datasets cover seasons 2010–2023. For 2023–present, NHSN admissions and NSSP emergency department visits serve as the primary active signals.

## References

- **Weighted Interval Score**: Bracher, J., Ray, E. L., Gneiting, T., & Reich, N. G. (2021). Evaluating epidemic forecasts in an interval format. *PLOS Computational Biology*, 17(2), e1008618.
- **Hubverse Evaluation Standards**: Cramer, E. Y., et al. (2022). Evaluation of individual and ensemble probabilistic forecasts of COVID-19 mortality in the US. *Proceedings of the National Academy of Sciences*, 119(15), e2113561119.
- **Scale Transformations**: Bosse, N. I., et al. (2023). Scoring epidemiological forecasts on transformed scales. *PLOS Computational Biology*, 19(8), e1011393.
