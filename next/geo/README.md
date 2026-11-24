# Shared Geographic Geometry & Metadata (`next/geo/`)

Reusable offline TopoJSON atlases and pure ES geometry/layout helpers used by the spatial views (`next/`).

## Bundled TopoJSON & MetroCast Assets

- `world-countries-50m.json` — World national boundaries & land masses (`world-atlas@2/countries-50m.json`, Natural Earth 1:50m public domain data, TopoJSON packaging under ISC license; see `ISC-TopoJSON.txt`).
- `us-counties-10m.json` — U.S. nation, states/territories, and 3,231 counties/equivalents (`us-atlas@3/counties-10m.json`, U.S. Census Bureau TIGER/Line public domain data, TopoJSON packaging under ISC license; see `ISC-TopoJSON.txt`). Both files are pre-projected in WGS84 longitude/latitude coordinates and served gzipped (`Content-Encoding: gzip`) with weak `ETag` caching by `server.py`.
- `metrocast_hsas.json` — Real 95-location Flu MetroCast HSA & regional hierarchy mapped to exact 5-digit Census county FIPS codes across all 15 covered U.S. states (derived from `flu-metrocast/auxiliary-data/locations.csv` + `us-counties-10m.json`).
- `ca-provinces.json` — Canada's 10 provinces and 3 territories keyed by lowercase RVDSS postal abbreviation (`ab`..`yt`), quantized shared-arc TopoJSON built from Natural Earth 1:50m Admin-1 boundaries (Public Domain).
- `ca-ontario-oh.json` — Ontario's 6 Ontario Health Regions (`Central`, `East`, `North East`, `North West`, `Toronto`, `West`), quantized shared-arc TopoJSON built from Land Information Ontario's Ontario Health Region dataset (Open Government Licence – Ontario).
- `cd-provinces.json` — Democratic Republic of the Congo's 26 modern provinces keyed by ISO 3166-2 code (`CD-BC`..`CD-TU`), quantized shared-arc TopoJSON built from geoBoundaries `gbOpen/COD/ADM1` (ODbL 1.0).

## Pure ES Modules

- `topo.js` — Delta-decoded quantized TopoJSON reader, 3D unit-sphere `(x, y, z)` converter, deduplicated shared-arc mesh builder, `buildMetroOverlays()` (dissolves interior county lines inside multi-county HSAs while excluding uncovered counties), 3x3 orthographic rotation matrix, hemisphere limb clipper, slerp camera interpolation, and inverse orthographic screen-to-lon/lat picker.
- `eu_tiles.js` — European & US jurisdiction metadata tables, ISO numeric-to-alpha-2 mapping, MetroCast/European hub coordinates, proportioned and uniform European squircle tile layouts (with UK unified and UK split nation options), and grid collision validator.
