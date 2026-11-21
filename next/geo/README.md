# Shared Geographic Geometry & Metadata (`next/geo/`)

Reusable offline TopoJSON atlases and pure ES geometry/layout helpers used by the Design Lab (`/next/lab/`) and future spatial views (`/next/`).

## Bundled TopoJSON & MetroCast Assets

- `world-countries-50m.json` — World national boundaries & land masses (`world-atlas@2/countries-50m.json`, Natural Earth 1:50m public domain data, TopoJSON packaging under ISC license).
- `us-counties-10m.json` — U.S. nation, states/territories, and 3,231 counties/equivalents (`us-atlas@3/counties-10m.json`, U.S. Census Bureau TIGER/Line public domain data, TopoJSON packaging under ISC license). Both files are pre-projected in WGS84 longitude/latitude coordinates and served gzipped (`Content-Encoding: gzip`) with weak `ETag` caching by `server.py`.
- `metrocast_hsas.json` — Real 95-location Flu MetroCast HSA & regional hierarchy mapped to exact 5-digit Census county FIPS codes across all 15 covered U.S. states (derived from `flu-metrocast/auxiliary-data/locations.csv` + `us-counties-10m.json`).

## Pure ES Modules

- `topo.js` — Delta-decoded quantized TopoJSON reader, 3D unit-sphere `(x, y, z)` converter, deduplicated shared-arc mesh builder, `buildMetroOverlays()` (dissolves interior county lines inside multi-county HSAs while excluding uncovered counties), 3x3 orthographic rotation matrix, hemisphere limb clipper, slerp camera interpolation, and inverse orthographic screen-to-lon/lat picker.
- `eu_tiles.js` — European & US jurisdiction metadata tables, ISO numeric-to-alpha-2 mapping, MetroCast/European hub coordinates, proportioned and uniform European squircle tile layouts (with UK unified and UK split nation options), and grid collision validator.
