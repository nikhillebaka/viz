# Third-party notices

viz is MIT-licensed (see [LICENSE](LICENSE)). It bundles the following third-party
files, which remain under their own licenses:

| File | Project | License | License text |
| :--- | :--- | :--- | :--- |
| `next/fonts/inter-latin.woff2` | [Inter](https://github.com/rsms/inter) (Latin subset, as served by Google Fonts), © The Inter Project Authors | SIL OFL 1.1 | [next/fonts/OFL-Inter.txt](next/fonts/OFL-Inter.txt) |
| `next/fonts/geist-mono-latin.woff2` | [Geist Mono](https://github.com/vercel/geist-font) (Latin subset, as served by Google Fonts), © The Geist Project Authors | SIL OFL 1.1 | [next/fonts/OFL-GeistMono.txt](next/fonts/OFL-GeistMono.txt) |
| `next/geo/world-countries-50m.json` | [world-atlas](https://github.com/topojson/world-atlas) v2 (`countries-50m.json`; [Natural Earth](https://www.naturalearthdata.com/) 1:50m public-domain geometry, TopoJSON packaging © Mike Bostock) | ISC / Public Domain | [next/geo/ISC-TopoJSON.txt](next/geo/ISC-TopoJSON.txt) |
| `next/geo/us-counties-10m.json` | [us-atlas](https://github.com/topojson/us-atlas) v3 (`counties-10m.json`; U.S. Census Bureau TIGER/Line public-domain geometry, TopoJSON packaging © Mike Bostock) | ISC / Public Domain | [next/geo/ISC-TopoJSON.txt](next/geo/ISC-TopoJSON.txt) |
| `next/geo/ca-provinces.json` | [Natural Earth](https://www.naturalearthdata.com/) 1:50m Admin-1 States & Provinces (Canada subset, quantized TopoJSON) | Public Domain | [Natural Earth Terms](https://www.naturalearthdata.com/about/terms-of-use/) |
| `next/geo/ca-ontario-oh.json` | [Land Information Ontario](https://geohub.lio.gov.on.ca/) Ontario Health Region boundaries (quantized TopoJSON) | [Open Government Licence – Ontario](https://www.ontario.ca/page/open-government-licence-ontario) | Reproduced below |
| `next/geo/cd-provinces.json` | [geoBoundaries](https://www.geoboundaries.org/) (`gbOpen/COD/ADM1` DRC 26 provinces; Runfola et al., 2020, quantized TopoJSON) | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) | Reproduced below |

## License Attributions & Share-Alike Terms

- **Open Government Licence – Ontario (OGL-Ontario):** Contains information licensed under the [Open Government Licence – Ontario](https://www.ontario.ca/page/open-government-licence-ontario), covering Ontario Health Region boundaries (`next/geo/ca-ontario-oh.json`) derived from Land Information Ontario (`geohub.lio.gov.on.ca`) and Ontario respiratory hospital bed occupancy data synced on demand from Public Health Ontario / Ontario Data Catalogue (`data.ontario.ca`).
- **geoBoundaries / Open Database License (ODbL 1.0):** `next/geo/cd-provinces.json` is derived from [geoBoundaries](https://www.geoboundaries.org/) (`gbOpen/COD/ADM1`, Runfola et al., 2020, *"geoBoundaries: A global database of political administrative boundaries"*, PLOS ONE) and is licensed under the [Open Database License (ODbL) v1.0](https://opendatacommons.org/licenses/odbl/1-0/). Under ODbL 1.0 Share-Alike, any publicly used adapted database derived from these boundaries must also be offered under ODbL 1.0.

## Data

- `data/seed/` contains public historical surveillance data compiled from US government and academic sources (CDC ILINet and FluSurv-NET, via the [Delphi Epidata API](https://cmu-delphi.github.io/delphi-epidata/)).
- `next/geo/metrocast_hsas.json` maps Health Service Areas to U.S. Census county FIPS codes derived from [Flu MetroCast](https://github.com/reichlab/flu-metrocast) (`auxiliary-data/locations.csv`).
- Forecast files, truth tables, and external surveillance feeds synced on demand by the user (`rebuild_surveillance.py`, public Hubverse hubs on S3/GitHub, CDC NWSS/NSSP/NREVSS, CFA, Delphi FluView, ECDC ERVISS, WHO FluNet, UKHSA, Public Health Ontario / OGL-Ontario, and Nextstrain) come from their respective public repositories and APIs and remain subject to their own terms of use.

Python dependencies (`polars`, `numpy`) are installed from PyPI into `.venv` and are not bundled.
