# Command-line tools

Run these from the hub root with the viz environment active (`source viz/.venv/bin/activate`, or `viz\.venv\Scripts\activate` on Windows).

## Headless CLI (`score_cli.py`)

`score_cli.py` computes evaluation metrics directly from the terminal and can export results to tables, CSV, JSON, or Parquet.

### Common Examples

```bash
# Evaluate specific models for a reference date across all states
python3 viz/score_cli.py --models UMass-flusion_spatial2_prod,UMass-AR6_pooled --date 2024-01-13 --location states

# Evaluate models strictly on common shared tasks (fair comparison)
python3 viz/score_cli.py --models UMass-gbqr_4src,UMass-gbqr_1src --season 2024-2025 --location states --fair

# Export rankings to JSON or CSV
python3 viz/score_cli.py --models all --season 2024-2025 --location US --format json --out scores.json
python3 viz/score_cli.py --models all --season 2024-2025 --location US --format csv --out scores.csv

# Score only each state's peak weeks across three seasons, within mid-November to early February
python3 viz/score_cli.py --models all --season 2023-2024,2024-2025,2025-2026 --location states --phase peak --weeks 16-28

# Export full disaggregated task-level scores (location × date × horizon)
python3 viz/score_cli.py --models UMass-flusion_spatial2_prod,FluSight-baseline --season 2024-2025 --export-tasks tasks.parquet
```

### CLI Arguments

| Flag | Default | Description |
| :--- | :---: | :--- |
| `--models` | *Required* | Comma-separated model IDs, or `'all'` |
| `--target` | Hub default | Target variable name (defaults to hub config or incidence target) |
| `--location` | `'all'` | `'all'`, `'states'`, `'US'`, or a specific two-digit FIPS code |
| `--date` | `'all'` | Reference date (`YYYY-MM-DD`) or `'all'` |
| `--season` | `''` | Specific season (`'2024-2025'`), comma-separated list, `'current'`, or `'all'` |
| `--baseline` | Hub default | Baseline model ID for relative comparisons |
| `--weeks` | `''` | Only score forecasts of season weeks in this range, e.g. `16-28` (season week 1 = MMWR week 31, early August) |
| `--phase` | `''` | Only score forecasts of `pre`-peak, `peak`, or `post`-peak weeks, judged per location from its own truth curve |
| `--fair` | `False` | Restrict evaluation strictly to common shared tasks |
| `--format` | `'table'` | Output format: `table`, `csv`, or `json` |
| `--out` | `None` | Output file path for summary results |
| `--export-tasks` | `None` | File path to export disaggregated task-level scores (`.csv` or `.parquet`), using the same locations, dates, and common tasks as the summary |

### Example Output

```text
==============================================================================================================
  FORECAST EVALUATION REPORT
  Target: wk inc flu hosp | Location Filter: states | Date Filter: 2024-01-13 | Common Tasks: False
  Reference Baseline: FluSight-baseline (Pairwise Tournament Rel WIS: 1.0 = baseline, <1.0 = better)
==============================================================================================================
Model Name                     Type     WIS       Rel WIS   Δ% Base    WIS/100k   MAE      Cov95%   Sharp   
--------------------------------------------------------------------------------------------------------------
UMass-flusion_spatial2_prod    [REPO]   31.70     0.359     -64.1%     0.58       44.23    98.6%    423.1   
UMass-AR6_pooled               [REPO]   59.76     0.677     -32.3%     1.14       96.95    91.3%    429.6   
FluSight-baseline              [REPO]   88.26     1.000     0.0%       1.50       119.46   67.8%    299.8   
==============================================================================================================
Lower WIS/MAE = Better. Rel WIS: Hubverse tournament standard (<1.0 is better than baseline).
Cov95 target = 95.0%. Lower Sharpness = Tighter intervals. Rate WIS = per 100,000 population.
```

## Surveillance Data Management (`rebuild_surveillance.py`)

The visualizer supports four surveillance data streams:
1. **Hospital Admissions (NHSN)**: Weekly laboratory-confirmed influenza admissions (`wk inc flu hosp`).
2. **Emergency Department Visits (NSSP)**: Weekly percentage of emergency department visits with diagnosed influenza.
3. **Outpatient ILI (ILINet)**: Historical scaled ILI+ signal ($w\text{ILI} \times \%\text{ positive}$, 2010–2023).
4. **Hospitalization Rates (FluSurv-NET)**: Population-based laboratory-confirmed admission rates per 100,000 (2010–2023).

### Commands

```bash
# Check surveillance data freshness and record counts
python3 viz/rebuild_surveillance.py --check-freshness

# Update from upstream or re-synthesize from local target-data/oracle-output
python3 viz/rebuild_surveillance.py --force
```

If upstream network access is unavailable, the script automatically synthesizes admissions from local `target-data/oracle-output.csv`.

`setup.sh` / `setup.bat` runs `--force` once for you; re-run it whenever you want newer surveillance data. Everything in `data/surveillance/` is git-ignored and rebuilt by the script. The 2010–2023 ILINet and FluSurv-NET history it cannot recreate ships read-only in `data/seed/` and is copied into `data/surveillance/` on first run, so updates never touch tracked files.

The dashboard never downloads surveillance data while serving requests: if a bundled file is missing, the affected stream is simply unavailable and the server log points to this script.
