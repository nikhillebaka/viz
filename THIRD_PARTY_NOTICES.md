# Third-party notices

viz is MIT-licensed (see [LICENSE](LICENSE)). It bundles the following third-party
files, which remain under their own licenses:

| File | Project | License | License text |
| :--- | :--- | :--- | :--- |
| `static/vendor/plotly-2.35.2.min.js` | [plotly.js](https://github.com/plotly/plotly.js) v2.35.2, © Plotly, Inc. | MIT | [licenses/plotly-MIT.txt](licenses/plotly-MIT.txt) |
| `static/vendor/xlsx.full.min.js` | [SheetJS Community Edition](https://git.sheetjs.com/sheetjs/sheetjs) v0.18.5, © SheetJS LLC | Apache-2.0 | [licenses/sheetjs-Apache-2.0.txt](licenses/sheetjs-Apache-2.0.txt) |
| `next/fonts/inter-latin.woff2` | [Inter](https://github.com/rsms/inter) (Latin subset, as served by Google Fonts), © The Inter Project Authors | SIL OFL 1.1 | [next/fonts/OFL-Inter.txt](next/fonts/OFL-Inter.txt) |
| `next/fonts/geist-mono-latin.woff2` | [Geist Mono](https://github.com/vercel/geist-font) (Latin subset, as served by Google Fonts), © The Geist Project Authors | SIL OFL 1.1 | [next/fonts/OFL-GeistMono.txt](next/fonts/OFL-GeistMono.txt) |

## Data

`data/seed/` contains public surveillance data compiled from US government and academic sources
(CDC ILINet and FluSurv-NET, via the [Delphi Epidata API](https://cmu-delphi.github.io/delphi-epidata/)).
Files that `rebuild_surveillance.py` downloads come from the
[CDC FluSight Forecast Hub](https://github.com/cdcepi/FluSight-forecast-hub) and the
[Reich Lab FluSight dashboard](https://github.com/reichlab/flusight-dashboard). These sources have
their own terms of use, and the MIT license above does not apply to them.

Python dependencies (`polars`, `pyarrow`, `numpy`, `pyyaml`) are installed from PyPI, not bundled.
