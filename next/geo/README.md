# Shared Geographic Geometry & Metadata (`next/geo/`)

Reusable offline TopoJSON atlases and pure ES geometry/layout helpers used by the Design Lab (`/next/lab/`) and future spatial views (`/next/`).

## Bundled TopoJSON Assets

- `world-countries-110m.json` — World national boundaries & land masses (`world-atlas@2/countries-110m.json`, Natural Earth 1:110m public domain data, TopoJSON packaging under ISC license).
- `us-counties-10m.json` — U.S. nation, states/territories, and 3,231 counties/equivalents (`us-atlas@3/counties-10m.json`, U.S. Census Bureau TIGER/Line public domain data, TopoJSON packaging under ISC license). Both files are pre-projected in WGS84 longitude/latitude coordinates and served gzipped (`Content-Encoding: gzip`) with weak `ETag` caching by `server.py`.

## Pure ES Modules

- `topo.js` — Delta-decoded quantized TopoJSON reader, 3D unit-sphere `(x, y, z)` converter, deduplicated shared-arc mesh builder, 3x3 orthographic rotation matrix, hemisphere limb clipper, slerp camera interpolation, and inverse orthographic screen-to-lon/lat picker.
- `eu_tiles.js` — European & US jurisdiction metadata tables, ISO numeric-to-alpha-2 mapping, MetroCast/European hub coordinates, proportioned and uniform European squircle tile layouts (with UK unified and UK split nation options), and grid collision validator.
