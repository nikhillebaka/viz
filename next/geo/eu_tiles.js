/* European & U.S. geographic metadata, Proportioned European Squircle Tile Layouts,
 * ISO numeric mapping, and MetroCast/European hub point catalogs.
 * Zero external dependencies; designed for reuse between /next/lab/ and /next/. */

/** Proportioned Europe tile map: 12 cols × 11 rows; [col, row, colSpan, rowSpan] (1-based). */
export const EU_GRID_PROPORTIONED = Object.freeze({ cols: 12, rows: 11 });

export const EU_TILES_PROPORTIONED = Object.freeze({
  IS: [1, 1, 2, 1],
  NO: [6, 1, 1, 3],
  SE: [7, 1, 2, 3],
  FI: [9, 1, 2, 3],
  GB: [3, 2, 2, 3],
  IE: [2, 3, 1, 2],
  NL: [5, 4, 1, 1],
  DK: [6, 4, 2, 1],
  PL: [8, 4, 2, 2],
  EE: [10, 4, 2, 1],
  BE: [5, 5, 1, 1],
  DE: [6, 5, 2, 2],
  LV: [10, 5, 2, 1],
  FR: [3, 6, 2, 2],
  LU: [5, 6, 1, 1],
  CZ: [8, 6, 2, 1],
  LT: [10, 6, 1, 1],
  UA: [11, 6, 2, 2],
  CH: [5, 7, 1, 1],
  LI: [6, 7, 1, 1],
  AT: [7, 7, 2, 1],
  SK: [9, 7, 2, 1],
  PT: [1, 8, 1, 2],
  ES: [2, 8, 2, 2],
  IT: [5, 8, 2, 2],
  SI: [7, 8, 1, 1],
  HU: [8, 8, 2, 1],
  RO: [10, 8, 2, 2],
  HR: [7, 9, 1, 2],
  MT: [6, 10, 1, 1],
  BG: [10, 10, 2, 1],
  GR: [9, 11, 2, 1],
  CY: [12, 11, 1, 1],
});

/** Alternate UK-split variant replacing GB (2×3) with SCT, NIR, WLS, ENG inside the exact same slot. */
export const EU_TILES_PROPORTIONED_UK_SPLIT = Object.freeze((() => {
  const { GB, ...rest } = EU_TILES_PROPORTIONED;
  void GB;
  return {
    ...rest,
    "GB-SCT": [3, 2, 2, 1],
    "GB-NIR": [3, 3, 1, 1],
    "GB-WLS": [3, 4, 1, 1],
    "GB-ENG": [4, 3, 1, 2],
  };
})());

/** Uniform 1×1 Europe tile map (10 cols × 8 rows) for direct comparison against proportioned sizing. */
export const EU_GRID_UNIFORM = Object.freeze({ cols: 9, rows: 8 });

export const EU_TILES_UNIFORM = Object.freeze({
  IS: [1, 1, 1, 1], NO: [5, 1, 1, 1], SE: [6, 1, 1, 1], FI: [7, 1, 1, 1],
  IE: [2, 2, 1, 1], GB: [3, 2, 1, 1], DK: [5, 2, 1, 1], EE: [8, 2, 1, 1],
  NL: [4, 3, 1, 1], DE: [5, 3, 1, 1], PL: [6, 3, 1, 1], LV: [8, 3, 1, 1],
  FR: [3, 4, 1, 1], BE: [4, 4, 1, 1], CZ: [6, 4, 1, 1], LT: [7, 4, 1, 1], UA: [9, 4, 1, 1],
  LU: [4, 5, 1, 1], CH: [5, 5, 1, 1], AT: [6, 5, 1, 1], SK: [7, 5, 1, 1],
  PT: [1, 6, 1, 1], ES: [2, 6, 1, 1], LI: [5, 6, 1, 1], SI: [6, 6, 1, 1], HU: [7, 6, 1, 1], RO: [8, 6, 1, 1],
  IT: [5, 7, 1, 1], HR: [6, 7, 1, 1], BG: [8, 7, 1, 1],
  MT: [5, 8, 1, 1], GR: [7, 8, 1, 1], CY: [9, 8, 1, 1],
});

export const EU_TILES_UNIFORM_UK_SPLIT = Object.freeze((() => {
  const { GB, ...rest } = EU_TILES_UNIFORM;
  void GB;
  return {
    ...rest,
    "GB-SCT": [3, 1, 1, 1],
    "GB-NIR": [2, 3, 1, 1],
    "GB-ENG": [3, 2, 1, 1],
    "GB-WLS": [3, 3, 1, 1],
  };
})());

/**
 * Verify a tile layout has zero overlaps and stays within [1..cols, 1..rows].
 * @param {Record<string, [number, number, number?, number?]>} tiles
 * @param {number} cols
 * @param {number} rows
 */
export function validateTileLayout(tiles, cols, rows) {
  const occupied = new Map();
  const overlaps = [];
  const outOfBounds = [];
  for (const [id, spec] of Object.entries(tiles)) {
    const [c, r, w = 1, h = 1] = spec;
    if (c < 1 || r < 1 || w < 1 || h < 1 || c + w - 1 > cols || r + h - 1 > rows) {
      outOfBounds.push(id);
    }
    for (let dc = 0; dc < w; dc++) {
      for (let dr = 0; dr < h; dr++) {
        const key = `${c + dc},${r + dr}`;
        if (occupied.has(key)) overlaps.push([occupied.get(key), id, key]);
        else occupied.set(key, id);
      }
    }
  }
  return { ok: overlaps.length === 0 && outOfBounds.length === 0, overlaps, outOfBounds };
}

/** ISO 3166-1 numeric codes from Natural Earth world-110m mapped to ISO alpha-2 IDs. */
export const ISO_NUM_TO_ALPHA2 = Object.freeze({
  "040": "AT", "056": "BE", "100": "BG", "756": "CH", "196": "CY",
  "203": "CZ", "276": "DE", "208": "DK", "233": "EE", "724": "ES",
  "246": "FI", "250": "FR", "826": "GB", "300": "GR", "191": "HR",
  "348": "HU", "372": "IE", "352": "IS", "380": "IT", "440": "LT",
  "442": "LU", "428": "LV", "528": "NL", "578": "NO", "616": "PL",
  "620": "PT", "642": "RO", "752": "SE", "705": "SI", "703": "SK",
  "804": "UA", "840": "US",
});

/** Built-in European EEA/EU/UK reference metadata matching core/geo.py `EUROPE_REF`. */
export const EU_META = Object.freeze({
  AT: { id: "AT", abbr: "AT", name: "Austria", level: "country", region: "Western Europe", population: 9158750, lat: 47.52, lon: 14.55 },
  BE: { id: "BE", abbr: "BE", name: "Belgium", level: "country", region: "Western Europe", population: 11825551, lat: 50.50, lon: 4.47 },
  BG: { id: "BG", abbr: "BG", name: "Bulgaria", level: "country", region: "Eastern Europe", population: 6445481, lat: 42.73, lon: 25.49 },
  CH: { id: "CH", abbr: "CH", name: "Switzerland", level: "country", region: "Western Europe", population: 8962300, lat: 46.82, lon: 8.23 },
  CY: { id: "CY", abbr: "CY", name: "Cyprus", level: "country", region: "Southern Europe", population: 933505, lat: 35.13, lon: 33.43 },
  CZ: { id: "CZ", abbr: "CZ", name: "Czechia", level: "country", region: "Eastern Europe", population: 10900555, lat: 49.82, lon: 15.47 },
  DE: { id: "DE", abbr: "DE", name: "Germany", level: "country", region: "Western Europe", population: 83445000, lat: 51.17, lon: 10.45 },
  DK: { id: "DK", abbr: "DK", name: "Denmark", level: "country", region: "Northern Europe", population: 5961249, lat: 56.26, lon: 9.50 },
  EE: { id: "EE", abbr: "EE", name: "Estonia", level: "country", region: "Northern Europe", population: 1374687, lat: 58.60, lon: 25.01 },
  ES: { id: "ES", abbr: "ES", name: "Spain", level: "country", region: "Southern Europe", population: 48619695, lat: 40.46, lon: -3.75 },
  FI: { id: "FI", abbr: "FI", name: "Finland", level: "country", region: "Northern Europe", population: 5603851, lat: 61.92, lon: 25.75 },
  FR: { id: "FR", abbr: "FR", name: "France", level: "country", region: "Western Europe", population: 68373433, lat: 46.23, lon: 2.21 },
  GB: { id: "GB", abbr: "GB", name: "United Kingdom", level: "country", region: "Northern Europe", population: 68265209, lat: 54.00, lon: -2.50 },
  "GB-ENG": { id: "GB-ENG", abbr: "ENG", name: "England", level: "nation", parent_id: "GB", region: "Northern Europe", population: 57690300, lat: 52.36, lon: -1.17 },
  "GB-NIR": { id: "GB-NIR", abbr: "NIR", name: "Northern Ireland", level: "nation", parent_id: "GB", region: "Northern Europe", population: 1920400, lat: 54.79, lon: -6.49 },
  "GB-SCT": { id: "GB-SCT", abbr: "SCT", name: "Scotland", level: "nation", parent_id: "GB", region: "Northern Europe", population: 5490100, lat: 56.49, lon: -4.20 },
  "GB-WLS": { id: "GB-WLS", abbr: "WLS", name: "Wales", level: "nation", parent_id: "GB", region: "Northern Europe", population: 3164400, lat: 52.13, lon: -3.78 },
  GR: { id: "GR", abbr: "GR", name: "Greece", level: "country", region: "Southern Europe", population: 10397193, lat: 39.07, lon: 21.82 },
  HR: { id: "HR", abbr: "HR", name: "Croatia", level: "country", region: "Southern Europe", population: 3861967, lat: 45.10, lon: 15.20 },
  HU: { id: "HU", abbr: "HU", name: "Hungary", level: "country", region: "Eastern Europe", population: 9584627, lat: 47.16, lon: 19.50 },
  IE: { id: "IE", abbr: "IE", name: "Ireland", level: "country", region: "Northern Europe", population: 5351681, lat: 53.14, lon: -7.69 },
  IS: { id: "IS", abbr: "IS", name: "Iceland", level: "country", region: "Northern Europe", population: 383726, lat: 64.96, lon: -19.02 },
  IT: { id: "IT", abbr: "IT", name: "Italy", level: "country", region: "Southern Europe", population: 58989749, lat: 41.87, lon: 12.57 },
  LI: { id: "LI", abbr: "LI", name: "Liechtenstein", level: "country", region: "Western Europe", population: 40023, lat: 47.17, lon: 9.56 },
  LT: { id: "LT", abbr: "LT", name: "Lithuania", level: "country", region: "Northern Europe", population: 2885891, lat: 55.17, lon: 23.88 },
  LU: { id: "LU", abbr: "LU", name: "Luxembourg", level: "country", region: "Western Europe", population: 672050, lat: 49.82, lon: 6.13 },
  LV: { id: "LV", abbr: "LV", name: "Latvia", level: "country", region: "Northern Europe", population: 1871882, lat: 56.88, lon: 24.60 },
  MT: { id: "MT", abbr: "MT", name: "Malta", level: "country", region: "Southern Europe", population: 563443, lat: 35.94, lon: 14.38 },
  NL: { id: "NL", abbr: "NL", name: "Netherlands", level: "country", region: "Western Europe", population: 17942942, lat: 52.13, lon: 5.29 },
  NO: { id: "NO", abbr: "NO", name: "Norway", level: "country", region: "Northern Europe", population: 5550203, lat: 60.47, lon: 8.47 },
  PL: { id: "PL", abbr: "PL", name: "Poland", level: "country", region: "Eastern Europe", population: 36620970, lat: 51.92, lon: 19.15 },
  PT: { id: "PT", abbr: "PT", name: "Portugal", level: "country", region: "Southern Europe", population: 10639726, lat: 39.40, lon: -8.22 },
  RO: { id: "RO", abbr: "RO", name: "Romania", level: "country", region: "Eastern Europe", population: 19064409, lat: 45.94, lon: 24.97 },
  SE: { id: "SE", abbr: "SE", name: "Sweden", level: "country", region: "Northern Europe", population: 10551707, lat: 60.13, lon: 18.64 },
  SI: { id: "SI", abbr: "SI", name: "Slovenia", level: "country", region: "Southern Europe", population: 2123949, lat: 46.15, lon: 14.99 },
  SK: { id: "SK", abbr: "SK", name: "Slovakia", level: "country", region: "Eastern Europe", population: 5424687, lat: 48.67, lon: 19.70 },
  UA: { id: "UA", abbr: "UA", name: "Ukraine", level: "country", region: "Eastern Europe", population: 37000000, lat: 48.38, lon: 31.17 },
});

/** U.S. national + state/DC/PR FIPS metadata matching core/geo.py `US_STATES_REF`. */
export const US_STATE_META = Object.freeze({
  US: { id: "US", abbr: "US", name: "United States", level: "country", region: "National", population: 334914895, lat: 39.83, lon: -98.58 },
  "01": { id: "01", abbr: "AL", name: "Alabama", level: "state", parent_id: "US", region: "HHS-4", population: 5108468, lat: 32.78, lon: -86.83 },
  "02": { id: "02", abbr: "AK", name: "Alaska", level: "state", parent_id: "US", region: "HHS-10", population: 733406, lat: 64.07, lon: -152.28 },
  "04": { id: "04", abbr: "AZ", name: "Arizona", level: "state", parent_id: "US", region: "HHS-9", population: 7431344, lat: 34.27, lon: -111.66 },
  "05": { id: "05", abbr: "AR", name: "Arkansas", level: "state", parent_id: "US", region: "HHS-6", population: 3067732, lat: 34.89, lon: -92.44 },
  "06": { id: "06", abbr: "CA", name: "California", level: "state", parent_id: "US", region: "HHS-9", population: 38965193, lat: 37.18, lon: -119.47 },
  "08": { id: "08", abbr: "CO", name: "Colorado", level: "state", parent_id: "US", region: "HHS-8", population: 5877610, lat: 38.99, lon: -105.55 },
  "09": { id: "09", abbr: "CT", name: "Connecticut", level: "state", parent_id: "US", region: "HHS-1", population: 3617176, lat: 41.62, lon: -72.73 },
  "10": { id: "10", abbr: "DE", name: "Delaware", level: "state", parent_id: "US", region: "HHS-3", population: 1031890, lat: 38.99, lon: -75.51 },
  "11": { id: "11", abbr: "DC", name: "District of Columbia", level: "state", parent_id: "US", region: "HHS-3", population: 678972, lat: 38.91, lon: -77.01 },
  "12": { id: "12", abbr: "FL", name: "Florida", level: "state", parent_id: "US", region: "HHS-4", population: 22610726, lat: 28.63, lon: -82.45 },
  "13": { id: "13", abbr: "GA", name: "Georgia", level: "state", parent_id: "US", region: "HHS-4", population: 11029227, lat: 32.64, lon: -83.44 },
  "15": { id: "15", abbr: "HI", name: "Hawaii", level: "state", parent_id: "US", region: "HHS-9", population: 1435138, lat: 20.29, lon: -156.37 },
  "16": { id: "16", abbr: "ID", name: "Idaho", level: "state", parent_id: "US", region: "HHS-10", population: 1964726, lat: 44.35, lon: -114.61 },
  "17": { id: "17", abbr: "IL", name: "Illinois", level: "state", parent_id: "US", region: "HHS-5", population: 12549689, lat: 40.04, lon: -89.20 },
  "18": { id: "18", abbr: "IN", name: "Indiana", level: "state", parent_id: "US", region: "HHS-5", population: 6862199, lat: 39.89, lon: -86.28 },
  "19": { id: "19", abbr: "IA", name: "Iowa", level: "state", parent_id: "US", region: "HHS-7", population: 3207004, lat: 42.08, lon: -93.50 },
  "20": { id: "20", abbr: "KS", name: "Kansas", level: "state", parent_id: "US", region: "HHS-7", population: 2940546, lat: 38.49, lon: -98.38 },
  "21": { id: "21", abbr: "KY", name: "Kentucky", level: "state", parent_id: "US", region: "HHS-4", population: 4526154, lat: 37.53, lon: -85.30 },
  "22": { id: "22", abbr: "LA", name: "Louisiana", level: "state", parent_id: "US", region: "HHS-6", population: 4573749, lat: 31.07, lon: -92.00 },
  "23": { id: "23", abbr: "ME", name: "Maine", level: "state", parent_id: "US", region: "HHS-1", population: 1395722, lat: 45.37, lon: -69.24 },
  "24": { id: "24", abbr: "MD", name: "Maryland", level: "state", parent_id: "US", region: "HHS-3", population: 6180253, lat: 39.05, lon: -76.79 },
  "25": { id: "25", abbr: "MA", name: "Massachusetts", level: "state", parent_id: "US", region: "HHS-1", population: 7001399, lat: 42.26, lon: -71.81 },
  "26": { id: "26", abbr: "MI", name: "Michigan", level: "state", parent_id: "US", region: "HHS-5", population: 10037261, lat: 44.35, lon: -85.41 },
  "27": { id: "27", abbr: "MN", name: "Minnesota", level: "state", parent_id: "US", region: "HHS-5", population: 5737915, lat: 46.28, lon: -94.31 },
  "28": { id: "28", abbr: "MS", name: "Mississippi", level: "state", parent_id: "US", region: "HHS-4", population: 2939690, lat: 32.74, lon: -89.67 },
  "29": { id: "29", abbr: "MO", name: "Missouri", level: "state", parent_id: "US", region: "HHS-7", population: 6196156, lat: 38.36, lon: -92.46 },
  "30": { id: "30", abbr: "MT", name: "Montana", level: "state", parent_id: "US", region: "HHS-8", population: 1132812, lat: 47.05, lon: -109.63 },
  "31": { id: "31", abbr: "NE", name: "Nebraska", level: "state", parent_id: "US", region: "HHS-7", population: 1978379, lat: 41.54, lon: -99.80 },
  "32": { id: "32", abbr: "NV", name: "Nevada", level: "state", parent_id: "US", region: "HHS-9", population: 3194176, lat: 39.33, lon: -116.63 },
  "33": { id: "33", abbr: "NH", name: "New Hampshire", level: "state", parent_id: "US", region: "HHS-1", population: 1402054, lat: 43.68, lon: -71.58 },
  "34": { id: "34", abbr: "NJ", name: "New Jersey", level: "state", parent_id: "US", region: "HHS-2", population: 9290841, lat: 40.19, lon: -74.67 },
  "35": { id: "35", abbr: "NM", name: "New Mexico", level: "state", parent_id: "US", region: "HHS-6", population: 2114371, lat: 34.41, lon: -106.11 },
  "36": { id: "36", abbr: "NY", name: "New York", level: "state", parent_id: "US", region: "HHS-2", population: 19571216, lat: 42.95, lon: -75.53 },
  "37": { id: "37", abbr: "NC", name: "North Carolina", level: "state", parent_id: "US", region: "HHS-4", population: 10835491, lat: 35.56, lon: -79.39 },
  "38": { id: "38", abbr: "ND", name: "North Dakota", level: "state", parent_id: "US", region: "HHS-8", population: 783926, lat: 47.45, lon: -100.47 },
  "39": { id: "39", abbr: "OH", name: "Ohio", level: "state", parent_id: "US", region: "HHS-5", population: 11785935, lat: 40.29, lon: -82.79 },
  "40": { id: "40", abbr: "OK", name: "Oklahoma", level: "state", parent_id: "US", region: "HHS-6", population: 4053824, lat: 35.59, lon: -97.49 },
  "41": { id: "41", abbr: "OR", name: "Oregon", level: "state", parent_id: "US", region: "HHS-10", population: 4233358, lat: 43.93, lon: -120.56 },
  "42": { id: "42", abbr: "PA", name: "Pennsylvania", level: "state", parent_id: "US", region: "HHS-3", population: 12961683, lat: 40.88, lon: -77.80 },
  "44": { id: "44", abbr: "RI", name: "Rhode Island", level: "state", parent_id: "US", region: "HHS-1", population: 1095962, lat: 41.68, lon: -71.56 },
  "45": { id: "45", abbr: "SC", name: "South Carolina", level: "state", parent_id: "US", region: "HHS-4", population: 5373555, lat: 33.92, lon: -80.90 },
  "46": { id: "46", abbr: "SD", name: "South Dakota", level: "state", parent_id: "US", region: "HHS-8", population: 919318, lat: 44.44, lon: -100.23 },
  "47": { id: "47", abbr: "TN", name: "Tennessee", level: "state", parent_id: "US", region: "HHS-4", population: 7126489, lat: 35.86, lon: -86.35 },
  "48": { id: "48", abbr: "TX", name: "Texas", level: "state", parent_id: "US", region: "HHS-6", population: 30503301, lat: 31.48, lon: -99.33 },
  "49": { id: "49", abbr: "UT", name: "Utah", level: "state", parent_id: "US", region: "HHS-8", population: 3417734, lat: 39.31, lon: -111.67 },
  "50": { id: "50", abbr: "VT", name: "Vermont", level: "state", parent_id: "US", region: "HHS-1", population: 647464, lat: 44.07, lon: -72.67 },
  "51": { id: "51", abbr: "VA", name: "Virginia", level: "state", parent_id: "US", region: "HHS-3", population: 8715698, lat: 37.52, lon: -78.85 },
  "53": { id: "53", abbr: "WA", name: "Washington", level: "state", parent_id: "US", region: "HHS-10", population: 7812880, lat: 47.38, lon: -120.45 },
  "54": { id: "54", abbr: "WV", name: "West Virginia", level: "state", parent_id: "US", region: "HHS-3", population: 1770071, lat: 38.64, lon: -80.62 },
  "55": { id: "55", abbr: "WI", name: "Wisconsin", level: "state", parent_id: "US", region: "HHS-5", population: 5910955, lat: 44.62, lon: -89.99 },
  "56": { id: "56", abbr: "WY", name: "Wyoming", level: "state", parent_id: "US", region: "HHS-8", population: 584057, lat: 43.00, lon: -107.55 },
  "72": { id: "72", abbr: "PR", name: "Puerto Rico", level: "territory", parent_id: "US", region: "HHS-2", population: 3205691, lat: 18.22, lon: -66.59 },
});

/** MetroCast HSAs / cities and major European sentinel hubs shown as interactive globe dots. */
export const METROCAST_CITIES = Object.freeze([
  { id: "provo", abbr: "Provo", name: "Provo, UT", level: "hsa", parentId: "49", region: "UT", hub: "Flu MetroCast", lat: 40.2338, lon: -111.6585, population: 685000 },
  { id: "salt-lake-city", abbr: "Salt Lake", name: "Salt Lake City, UT", level: "hsa", parentId: "49", region: "UT", hub: "Flu MetroCast", lat: 40.7608, lon: -111.8910, population: 1265000 },
  { id: "ogden", abbr: "Ogden", name: "Ogden, UT", level: "hsa", parentId: "49", region: "UT", hub: "Flu MetroCast", lat: 41.2230, lon: -111.9738, population: 520000 },
  { id: "boston", abbr: "Boston", name: "Boston, MA", level: "hsa", parentId: "25", region: "MA", hub: "Flu MetroCast", lat: 42.3601, lon: -71.0589, population: 2150000 },
  { id: "amherst", abbr: "Amherst", name: "Amherst / Pioneer Valley, MA", level: "hsa", parentId: "25", region: "MA", hub: "Flu MetroCast", lat: 42.3732, lon: -72.5199, population: 620000 },
  { id: "worcester", abbr: "Worcester", name: "Worcester, MA", level: "hsa", parentId: "25", region: "MA", hub: "Flu MetroCast", lat: 42.2626, lon: -71.8023, population: 862000 },
  { id: "nyc", abbr: "NYC", name: "New York City, NY", level: "metro", parentId: "36", region: "NY", hub: "Flu MetroCast", lat: 40.7128, lon: -74.0060, population: 8335897 },
  { id: "Austin", abbr: "Austin", name: "Austin, TX", level: "hsa", parentId: "48", region: "TX", hub: "Flu MetroCast", lat: 30.2672, lon: -97.7431, population: 2350000 },
  { id: "Houston", abbr: "Houston", name: "Houston, TX", level: "hsa", parentId: "48", region: "TX", hub: "Flu MetroCast", lat: 29.7604, lon: -95.3698, population: 4728000 },
  { id: "Dallas", abbr: "Dallas", name: "Dallas, TX", level: "hsa", parentId: "48", region: "TX", hub: "Flu MetroCast", lat: 32.7767, lon: -96.7970, population: 3820000 },
  { id: "San Antonio", abbr: "San Antonio", name: "San Antonio, TX", level: "hsa", parentId: "48", region: "TX", hub: "Flu MetroCast", lat: 29.4241, lon: -98.4936, population: 2059000 },
  { id: "El Paso", abbr: "El Paso", name: "El Paso, TX", level: "hsa", parentId: "48", region: "TX", hub: "Flu MetroCast", lat: 31.7619, lon: -106.4850, population: 868000 },
  { id: "bay-area", abbr: "Bay Area", name: "San Francisco Bay Area, CA", level: "region", parentId: "06", region: "CA", hub: "Flu MetroCast", lat: 37.7749, lon: -122.4194, population: 4620000 },
  { id: "los-angeles", abbr: "Los Angeles", name: "Los Angeles, CA", level: "hsa", parentId: "06", region: "CA", hub: "Flu MetroCast", lat: 34.0522, lon: -118.2437, population: 9829000 },
  { id: "san-diego", abbr: "San Diego", name: "San Diego, CA", level: "hsa", parentId: "06", region: "CA", hub: "Flu MetroCast", lat: 32.7157, lon: -117.1611, population: 3286000 },
  { id: "raleigh", abbr: "Triangle", name: "Raleigh-Durham, NC", level: "region", parentId: "37", region: "NC", hub: "Flu MetroCast", lat: 35.7796, lon: -78.6382, population: 2144000 },
  { id: "charlotte", abbr: "Charlotte", name: "Charlotte, NC", level: "region", parentId: "37", region: "NC", hub: "Flu MetroCast", lat: 35.2271, lon: -80.8431, population: 2701000 },
  { id: "chicago", abbr: "Chicago", name: "Chicago, IL", level: "hsa", parentId: "17", region: "IL", hub: "Flu MetroCast", lat: 41.8781, lon: -87.6298, population: 5150000 },
  { id: "denver", abbr: "Denver", name: "Denver, CO", level: "hsa", parentId: "08", region: "CO", hub: "Flu MetroCast", lat: 39.7392, lon: -104.9903, population: 2985000 },
  { id: "seattle", abbr: "Seattle", name: "Seattle, WA", level: "hsa", parentId: "53", region: "WA", hub: "Flu MetroCast", lat: 47.6062, lon: -122.3321, population: 2269000 },
  { id: "atlanta", abbr: "Atlanta", name: "Atlanta, GA", level: "hsa", parentId: "13", region: "GA", hub: "Flu MetroCast", lat: 33.7490, lon: -84.3880, population: 3410000 },
  { id: "miami", abbr: "Miami", name: "Miami, FL", level: "hsa", parentId: "12", region: "FL", hub: "Flu MetroCast", lat: 25.7617, lon: -80.1918, population: 2716000 },
  { id: "minneapolis", abbr: "Twin Cities", name: "Minneapolis-St. Paul, MN", level: "hsa", parentId: "27", region: "MN", hub: "Flu MetroCast", lat: 44.9778, lon: -93.2650, population: 2320000 },
  { id: "phoenix", abbr: "Phoenix", name: "Phoenix, AZ", level: "hsa", parentId: "04", region: "AZ", hub: "Flu MetroCast", lat: 33.4484, lon: -112.0740, population: 4496000 },
  // European sentinel hub anchors (for RespiCast zoom context)
  { id: "eu-berlin", abbr: "Berlin", name: "Berlin Sentinel, DE", level: "city", parentId: "DE", region: "DE", hub: "RespiCast", lat: 52.5200, lon: 13.4050, population: 3755000 },
  { id: "eu-paris", abbr: "Paris", name: "Paris Sentinel, FR", level: "city", parentId: "FR", region: "FR", hub: "RespiCast", lat: 48.8566, lon: 2.3522, population: 2102000 },
  { id: "eu-london", abbr: "London", name: "London, UK", level: "city", parentId: "GB", region: "GB-ENG", hub: "RespiCast", lat: 51.5072, lon: -0.1276, population: 8866000 },
  { id: "eu-madrid", abbr: "Madrid", name: "Madrid, ES", level: "city", parentId: "ES", region: "ES", hub: "RespiCast", lat: 40.4168, lon: -3.7038, population: 3332000 },
  { id: "eu-rome", abbr: "Rome", name: "Rome, IT", level: "city", parentId: "IT", region: "IT", hub: "RespiCast", lat: 41.9028, lon: 12.4964, population: 2748000 },
  { id: "eu-stockholm", abbr: "Stockholm", name: "Stockholm, SE", level: "city", parentId: "SE", region: "SE", hub: "RespiCast", lat: 59.3293, lon: 18.0686, population: 984000 },
  { id: "eu-warsaw", abbr: "Warsaw", name: "Warsaw, PL", level: "city", parentId: "PL", region: "PL", hub: "RespiCast", lat: 52.2297, lon: 21.0122, population: 1861000 },
  { id: "eu-vienna", abbr: "Vienna", name: "Vienna, AT", level: "city", parentId: "AT", region: "AT", hub: "RespiCast", lat: 48.2082, lon: 16.3738, population: 2005000 },
]);

/** Fast combined metadata lookup for any ID (US national/state, EU country/nation, MetroCast city). */
export function lookupPlaceMeta(placeId) {
  if (!placeId) return null;
  if (US_STATE_META[placeId]) return US_STATE_META[placeId];
  if (EU_META[placeId]) return EU_META[placeId];
  return METROCAST_CITIES.find((c) => c.id === placeId) || null;
}
