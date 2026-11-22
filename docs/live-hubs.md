# Live Hub Data & External Surveillance Feeds

viz connects to multiple public Hubverse repositories via **S3** and **GitHub** (configured in [remote/hubs.py](../remote/hubs.py)) as well as open public surveillance/genomic APIs used in Place-First Briefings.

## Built-in Public Hubs

Open **⋯ → Data sources** in the top-right bar to browse, inspect, sync, or toggle any provider:

| Hub | Source | Geography | Output Types |
| :--- | :--- | :--- | :--- |
| **CDC FluSight** | S3 `cdcepi-flusight-forecast-hub` | US National + States/Territories | `quantile`, `pmf`, `sample` |
| **Flu MetroCast** | GitHub `reichlab/flu-metrocast` | US Sub-state / 95 HSAs & States | `quantile`, `sample` |
| **US COVID-19 Forecast Hub** | S3 `covid19-forecast-hub` | US National + States/Territories | `quantile`, `sample` |
| **US RSV Forecast Hub** | S3 `rsv-forecast-hub` | US National + States/Territories | `quantile`, `sample` |
| **RespiCast Syndromic (ILI/ARI)** | GitHub `european-modelling-hubs/RespiCast-SyndromicIndicators` (+ 2023–24 Flu/ARI archives) | EU/EEA + UK countries | `quantile` |
| **RespiCast COVID-19** | GitHub `european-modelling-hubs/RespiCast-Covid19` | EU/EEA + UK countries | `quantile` |

Additional public Hubverse S3 buckets or GitHub `owner/repo` repositories can be added from **Data sources** in `local` mode.

### Sync & Storage Behavior
- **On-demand & incremental:** Nothing downloads until you press *Sync* (or *Check*). Only upstream changes (matching ETag / git tree SHA) are pulled per season.
- **Validation:** Schema drift, crossing quantiles, negative counts, unknown locations, and duplicate rows are normalized and surfaced under **⋯ → Warnings**. Unreadable files are skipped without corrupting the store.
- **Truth reconciliation:** Oracle outputs and target time series are merged across available vintages so the chart displays continuous history while *Pending truth* marks rounds whose target weeks are not yet reported.
- **Cache paths:** Synced forecasts live under `.cache/remote/<hub_id>/`, with per-model Parquet caches in `.cache/models/` (or `.cache/remote_cache/` when run standalone).

## External Briefing Surveillance & Virology Feeds

Briefings ([core/briefing_feeds.py](../core/briefing_feeds.py)) fetch unauthenticated open feeds asynchronously on demand via **Refresh feeds** and persist Parquet tables under `.cache/briefings/`:

- **US Feeds:** CDC NWSS Wastewater (`cdc_nwss`), CDC CFA $R_t$ (`cdc_cfa_rt`), CDC NSSP ED Visits (`cdc_nssp_ed`), CDC NREVSS Lab Positivity (`cdc_nrevss`), CMU Delphi FluView Clinical (`delphi_fluview`).
- **European & UK Feeds:** ECDC ERVISS Weekly Surveillance CSVs (`ecdc_erviss`: `sentinelTestsDetectionsPositivity.csv`, `ILIARIRates.csv`, `SARIRates.csv`), WHO RespiMart FluNet (`who_flunet`), and UKHSA Respiratory PCR Positivity (`ukhsa_resp`).
- **Genomic Clades:** Nextstrain North America & Europe Auspice v2 frequencies (`nextstrain_clades`) for Influenza A(H3N2), A(H1N1)pdm09, and SARS-CoV-2, alongside Northern Hemisphere WHO/FDA reference vaccine compositions.
