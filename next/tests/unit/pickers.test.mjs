// The location picker's pure logic: location search, recent places and tile-map navigation. (The model
// picker's is in model-picker.test.mjs.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { TILES, COLUMNS, matchLocations, tileNeighbor, nextRecent } from "../../features/LocationPicker.js";

test("tile map: every position on the 11 × 8 grid, no two tiles in one cell", () => {
  const cells = Object.values(TILES).map(([x, y]) => `${x},${y}`);
  assert.equal(new Set(cells).size, cells.length);
  assert.equal(cells.length, 52); // 50 states, DC and PR
  assert.ok(Object.values(TILES).every(([x, y]) => x >= 0 && x < COLUMNS && y >= 0 && y < 8));
});

test("tile map: arrows move to the nearest tile that way, within 45°", () => {
  const go = (ab, dir) => tileNeighbor(TILES, TILES[ab], { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir]);
  assert.equal(go("CA", "up"), "OR");
  assert.equal(go("CA", "right"), "UT");
  assert.equal(go("TX", "up"), "OK");
  assert.equal(go("AK", "down"), "WA");
  assert.equal(go("ME", "down"), "NH");
  assert.equal(go("MA", "right"), null);
  assert.equal(go("HI", "down"), null);
  assert.equal(go("PR", "left"), "FL");
  assert.equal(go("NY", "up"), "VT");
  assert.equal(go("WI", "up"), null);                 // nothing within 45°: up goes to the United States
  assert.equal(go("FL", "left"), "GA");
  assert.equal(tileNeighbor(TILES, [5, -1], [0, 1]), "IL"); // down from the United States, middle column
  assert.equal(tileNeighbor(TILES, [0, -1], [0, 1]), "AK");
});

test("location search: exact abbreviation first, then name prefixes, words, substrings", () => {
  const L = [
    { id: "US", abbr: "US", name: "United States" }, { id: "25", abbr: "MA", name: "Massachusetts" },
    { id: "23", abbr: "ME", name: "Maine" }, { id: "24", abbr: "MD", name: "Maryland" },
    { id: "01", abbr: "AL", name: "Alabama" }, { id: "36", abbr: "NY", name: "New York" },
    { id: "54", abbr: "WV", name: "West Virginia" }, { id: "51", abbr: "VA", name: "Virginia" },
  ];
  const ab = (q) => matchLocations(L, q).map((l) => l.abbr);
  assert.deepEqual(ab("ma"), ["MA", "ME", "MD", "AL"]);
  assert.deepEqual(ab("mass"), ["MA"]);
  assert.deepEqual(ab("york"), ["NY"]);
  assert.deepEqual(ab("virginia"), ["VA", "WV"]);
  assert.deepEqual(ab("us"), ["US", "MA"]);
  assert.deepEqual(ab("36"), ["NY"]);
  assert.deepEqual(ab(""), []);
  assert.deepEqual(ab("zz"), []);
});

test("recent places: the chosen one first, then the one left, distinct, four at most", () => {
  assert.deepEqual(nextRecent([], "25", "US"), ["25", "US"]);
  assert.deepEqual(nextRecent(["36", "25", "06", "48"], "25", "36"), ["25", "36", "06", "48"]);
  assert.deepEqual(nextRecent(["1", "2", "3", "4"], "5", "6"), ["5", "6", "1", "2"]);
});
