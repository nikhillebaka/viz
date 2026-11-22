# Third-party notices

viz is MIT-licensed (see [LICENSE](LICENSE)). It bundles the following third-party
files, which remain under their own licenses:

| File | Project | License | License text |
| :--- | :--- | :--- | :--- |
| `next/fonts/inter-latin.woff2` | [Inter](https://github.com/rsms/inter) (Latin subset, as served by Google Fonts), © The Inter Project Authors | SIL OFL 1.1 | [next/fonts/OFL-Inter.txt](next/fonts/OFL-Inter.txt) |
| `next/fonts/geist-mono-latin.woff2` | [Geist Mono](https://github.com/vercel/geist-font) (Latin subset, as served by Google Fonts), © The Geist Project Authors | SIL OFL 1.1 | [next/fonts/OFL-GeistMono.txt](next/fonts/OFL-GeistMono.txt) |
| `next/geo/world-countries-50m.json` | [world-atlas](https://github.com/topojson/world-atlas) v2 (`countries-50m.json`; [Natural Earth](https://www.naturalearthdata.com/) 1:50m public-domain geometry, TopoJSON packaging © Mike Bostock) | ISC / Public Domain | [next/geo/ISC-TopoJSON.txt](next/geo/ISC-TopoJSON.txt) |
| `next/geo/us-counties-10m.json` | [us-atlas](https://github.com/topojson/us-atlas) v3 (`counties-10m.json`; U.S. Census Bureau TIGER/Line public-domain geometry, TopoJSON packaging © Mike Bostock) | ISC / Public Domain | [next/geo/ISC-TopoJSON.txt](next/geo/ISC-TopoJSON.txt) |

## Data

- `data/seed/` contains public historical surveillance data compiled from US government and academic sources (CDC ILINet and FluSurv-NET, via the [Delphi Epidata API](https://cmu-delphi.github.io/delphi-epidata/)).
- `next/geo/metrocast_hsas.json` maps Health Service Areas to U.S. Census county FIPS codes derived from [Flu MetroCast](https://github.com/reichlab/flu-metrocast) (`auxiliary-data/locations.csv`).
- Forecast files, truth tables, and external surveillance feeds synced on demand by the user (`rebuild_surveillance.py`, public Hubverse hubs on S3/GitHub, CDC NWSS/NSSP/NREVSS, CFA, Delphi FluView, ECDC ERVISS, WHO FluNet, UKHSA, and Nextstrain) come from their respective public repositories and APIs and remain subject to their own terms of use.

Python dependencies (`polars`, `pyarrow`, `numpy`, `pyyaml`) are installed from PyPI into `.venv` and are not bundled.
