# Methodology

## Quantile Evaluation Metrics

For continuous targets (`output_type = "quantile"`), the scoring engine implements Hubverse evaluation conventions:

- **Weighted Interval Score (WIS)**: Evaluates probabilistic forecasts across symmetric central prediction intervals $1 - \alpha_k$ and predictive median $m$:
  $$\text{WIS} = \frac{1}{K + \tfrac{1}{2}} \left( \frac{1}{2}|y - m| + \sum_{k=1}^K \frac{\alpha_k}{2} \left[(u_k - l_k) + \frac{2}{\alpha_k}(l_k - y)\mathbf{1}(y < l_k) + \frac{2}{\alpha_k}(y - u_k)\mathbf{1}(y > u_k)\right] \right)$$
  Decomposes into **Dispersion** (interval width), **Overprediction** ($y < l_k$), and **Underprediction** ($y > u_k$) (Bracher et al., 2021).
- **Log-Scale Scoring ($\ln(\max(y, 0) + 1)$)**: Evaluates distributional calibration on relative rather than absolute scale across jurisdictions of varying population size (Bosse et al., 2023).
- **Pairwise Tournament Relative WIS**: Geometric mean of head-to-head mean score ratios over shared tasks, scaled so the baseline equals `1.00` (Cramer et al., 2022). Values `< 1.0` outperform the baseline. Also applied symmetrically to PMF (`Rel. RPS` / `Rel. Log`) and Sample (`Rel. CRPS` / `Rel. Energy`) leaderboards.
- **State vs. National Pooling**: When a scope includes sub-national units (e.g. `location=all` on a US or EU hub), primary aggregates exclude national aggregate units (`US`) so large national magnitudes do not swamp state/country errors.
- **Mean Absolute Error (MAE)**: Absolute error of the predictive median ($q_{0.50}$).
- **Prediction Interval Coverage & Per-100k WIS**: Empirical coverage inside nominal $50\%$, $80\%$, and $95\%$ central intervals, plus population-standardized $\text{WIS} / \text{pop} \times 100{,}000$ for count targets.
- **Weekly Wins & Common Tasks (`--fair`)**: Count of rounds won among the active pool on strictly common tasks; `--fair` intersects `(reference_date, location, horizon[, extra_task_ids])` across every compared model.

## Sample Trajectory Metrics (`CRPS` & `Energy Score`)

For joint trajectory forecasts (`output_type = "sample"`), implemented in `core/metrics.py` (`score_sample_forecasts`) and served via `/api/next/sample-scores`:

- **Empirical 1D CRPS**: Exact empirical Continuous Ranked Probability Score computed over sorted sample draws $x_{(0)} \le \dots \le x_{(M-1)}$ at each `(reference_date, location, horizon)` in $O(M \log M)$ time:
  $$\text{CRPS}(F_{\text{emp}}, y) = \frac{1}{M} \sum_{i=0}^{M-1} |x_i - y| - \frac{1}{2M^2} \sum_{i,j=0}^{M-1} |x_i - x_j|$$
- **Multivariate Energy Score (ES)**: Evaluates joint $D$-horizon sample trajectories $X_i \in \mathbb{R}^D$ against the realized trajectory vector $y \in \mathbb{R}^D$ (capped at up to `200` evenly strided draws per round/location for speed):
  $$\text{ES}(X, y) = \frac{1}{M} \sum_{i=0}^{M-1} \|X_i - y\|_2 - \frac{1}{2M^2} \sum_{i,j=0}^{M-1} \|X_i - X_j\|_2$$
- **Conditional Gates**: Interactive vertical dragging over any future horizon filters sample draws dynamically in the UI (`Trajectories`) to inspect peak timing and peak size conditional on intermediate trajectory realizations.

## Categorical PMF Metrics (`RPS`, `Log loss`, `Brier`, `Mode hit`)

For categorical/ordinal probability mass targets (`output_type = "pmf"`, e.g. `wk flu hosp rate change` and season peak week):

- **Ranked Probability Score (RPS)**: $\sum_{k} (F(k) - \mathbf{1}(y \le k))^2$ across cumulative ordered categories (or divided by $K - 1$ for normalized inline table view). Rewards probability mass concentrated near the realized category.
- **Log loss**: $-\ln \max(p(y), 10^{-3})$, strictly proper penalty on realized probability mass.
- **Brier Score**: $\sum_{k=1}^K (p_k - \mathbf{1}(y = k))^2$, Euclidean distance between the probability vector and one-hot truth.
- **Mode Hit Rate**: Share of scored tasks whose strictly most likely predicted category (`argmax p`) matched the observed bin.

## Calendar Conventions & Official Hub Ensembles

- **US Hubs (FluSight, COVID-19, RSV, MetroCast)**: Weekly Saturday `reference_date` with `target_end_date = reference_date + 7·h` (`-1 wk` cutoff week, `0 wk` nowcast, `1–3 wk` ahead).
- **European RespiCast**: Weekly mid-week `origin_date` submissions aligned via each target's inferred `horizon_offset_days` so `Reference date` displays the 0-horizon target week Sunday while retaining an `Origin date` submission tick.
- **Official Hub Ensemble Priority**: Ranking rules (`core/catalog.py:rank_ensemble_candidates`) prioritize canonical hub ensembles (`FluSight-ensemble`, `CovidHub-ensemble`, `RSVHub-ensemble`, `epiENGAGE-ensemble_short`, `respicast-hubEnsemble`) — including ensembles tagged `ensemble_of_hub_models: true` with `designated_model: false` — over single-team ensembles.

## References

- **Weighted Interval Score**: Bracher, J., Ray, E. L., Gneiting, T., & Reich, N. G. (2021). Evaluating epidemic forecasts in an interval format. *PLOS Computational Biology*, 17(2), e1008618.
- **Hubverse Evaluation Standards**: Cramer, E. Y., et al. (2022). Evaluation of individual and ensemble probabilistic forecasts of COVID-19 mortality in the US. *PNAS*, 119(15), e2113561119.
- **Log-Scale Forecasting Scores**: Bosse, N. I., et al. (2023). Scoring epidemiological forecasts on transformed scales. *PLOS Computational Biology*, 19(8), e1011393.
