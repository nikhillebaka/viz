/* The location picker: search, recent places, the United States, and a US tile map.
 * Decisions: design/studies/seasons-locations-goals.md §6. Any of 53 places is two keystrokes ("ma"
 * Enter) or one click away. Arrow keys move across the map by its geometry (this layer keeps its
 * arrows: no time keys). Hovering or focusing a place prefetches its fan.
 *
 * TILES, matchLocations() and tileNeighbor() are pure, for node tests. */
import { h, on, storage } from "../lib/dom.js";
import { openPopover } from "../ui/floating.js";
import { icon } from "../ui/controls.js";
import { prefetchFan } from "../lib/api.js";

/** The standard US tile grid: abbreviation → [column, row], 11 × 8, DC and PR included. */
export const TILES = Object.freeze({
  AK: [0, 0], ME: [10, 0], VT: [9, 1], NH: [10, 1],
  WA: [0, 2], ID: [1, 2], MT: [2, 2], ND: [3, 2], MN: [4, 2], IL: [5, 2], WI: [6, 2], MI: [7, 2], NY: [8, 2], RI: [9, 2], MA: [10, 2],
  OR: [0, 3], NV: [1, 3], WY: [2, 3], SD: [3, 3], IA: [4, 3], IN: [5, 3], OH: [6, 3], PA: [7, 3], NJ: [8, 3], CT: [9, 3],
  CA: [0, 4], UT: [1, 4], CO: [2, 4], NE: [3, 4], MO: [4, 4], KY: [5, 4], WV: [6, 4], VA: [7, 4], MD: [8, 4], DE: [9, 4],
  AZ: [1, 5], NM: [2, 5], KS: [3, 5], AR: [4, 5], TN: [5, 5], NC: [6, 5], SC: [7, 5], DC: [8, 5],
  OK: [3, 6], LA: [4, 6], MS: [5, 6], AL: [6, 6], GA: [7, 6],
  HI: [0, 7], TX: [3, 7], FL: [8, 7], PR: [10, 7],
});
export const COLUMNS = 11;
const RECENT = 4;
const PLACES_KEY = "viz.places";

/**
 * Locations matching a query, best first: an exact abbreviation, id or name; then names starting with
 * it; then names with a word starting with it; then names containing it. Ties by name.
 * @param {{ id: string, abbr?: string, name?: string }[]} locations
 * @param {string} query
 * @returns {object[]} [] for an empty query
 */
export function matchLocations(locations, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const rank = (l) => {
    const name = (l.name || "").toLowerCase();
    if ((l.abbr || "").toLowerCase() === q || l.id.toLowerCase() === q || name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.split(/[\s-]+/).some((w) => w.startsWith(q))) return 2;
    if (name.includes(q)) return 3;
    return -1;
  };
  return locations.map((l) => [l, rank(l)]).filter(([, r]) => r >= 0)
    .sort((a, b) => a[1] - b[1] || (a[0].name || "").localeCompare(b[0].name || ""))
    .map(([l]) => l);
}

/**
 * The nearest tile from `from` in a direction: among tiles that way and within 45° of it, the one with
 * the least distance along the direction plus twice the distance across it (so moving stays in its row
 * or column when it can, and never jumps sideways across the map).
 * @param {Record<string, [number, number]>} tiles key → [column, row]
 * @param {[number, number]} from [column, row]
 * @param {[number, number]} dir [-1|0|1, -1|0|1], one of them zero
 * @returns {string | null} the key, or null when there is nothing that way
 */
export function tileNeighbor(tiles, from, dir) {
  const [x, y] = from, [ux, uy] = dir;
  let best = null, bd = Infinity, bAcross = Infinity;
  for (const [k, [tx, ty]] of Object.entries(tiles)) {
    const dx = tx - x, dy = ty - y;
    const along = ux ? dx * ux : dy * uy, across = ux ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0 || across > along) continue;
    const d = along + 2 * across;
    if (d < bd || (d === bd && across < bAcross)) { bd = d; best = k; bAcross = across; }
  }
  return best;
}

/**
 * The recent places after choosing `id`: it first, then the place being left, then the rest; distinct;
 * at most four.
 * @param {string[]} recent
 * @param {string} id the place chosen
 * @param {string} [from] the place being left
 * @returns {string[]}
 */
export function nextRecent(recent, id, from) {
  return [...new Set([id, from, ...recent].filter(Boolean))].slice(0, RECENT);
}

/**
 * Open the location picker from the Location bubble (or close it, if it is open from there).
 * Writes only store.set({ location }); app.js keeps storage "viz.places" (with nextRecent's rule).
 * @param {HTMLElement} anchor
 * @param {{ manifest: object, store: object, chart?: object | null }} ctx chart is not used
 * @returns {object | null} the layer, or null when this call closed it
 */
export function openLocationPicker(anchor, { manifest, store }) {
  const locs = manifest.locations || [];
  const current = store.get().location;
  const nameOf = (id) => manifest.locationById.get(id)?.name || id;
  const offs = [];

  return openPopover(anchor, {
    morph: true, width: 420, className: "lp-panel",
    onClose: () => offs.forEach((off) => off()),
    content(body, layer) {
      const input = h("input", { type: "search", placeholder: `Search ${locs.length} locations`, "aria-label": "Search locations", autocomplete: "off", spellcheck: "false" });
      const recent = (storage.get(PLACES_KEY, []) || []).filter((id) => id !== current && manifest.locationById.has(id)).slice(0, RECENT);
      const place = (l, cls, label) => h("button", {
        type: "button", class: cls, "data-loc": l.id, title: l.name || l.id, "aria-label": l.name || l.id,
        "aria-current": l.id === current ? "true" : null,
      }, label);

      const us = locs.find((l) => l.id === "US");
      const onMap = locs.filter((l) => l.id !== "US" && TILES[l.abbr]);
      const offMap = locs.filter((l) => l.id !== "US" && !TILES[l.abbr]);
      const tiles = onMap.map((l) => {
        const [x, y] = TILES[l.abbr];
        const b = place(l, ["c-tile", l.id === current && "on"], l.abbr);
        b.style.gridColumn = String(x + 1);
        b.style.gridRow = String(y + 1);
        return b;
      });
      const usTile = us ? place(us, ["c-tile lp-us", us.id === current && "on"], us.name || "United States") : null;
      const map = h("div", { class: "lp-map", role: "group", "aria-label": "Map" },
        usTile,
        h("div", { class: "c-tile-grid lp-tiles" }, tiles),
        offMap.length ? h("div", { class: "lp-chips" }, offMap.map((l) => place(l, ["c-chip", l.id === current && "on"], l.name || l.id))) : null);
      const chips = recent.length ? h("div", { class: "lp-chips lp-recent", role: "group", "aria-label": "Recent" },
        recent.map((id) => place(manifest.locationById.get(id), "c-chip", nameOf(id)))) : null;
      body.append(...[h("label", { class: "c-search", html: icon.search }, input), chips, map].filter(Boolean));

      const byAbbr = new Map(onMap.map((l, i) => [l.abbr, tiles[i]]));
      const mapItems = () => [...map.querySelectorAll("[data-loc]")];
      let col = 5; // the column ↓ from the United States lands in: the one last left

      // roving tabindex: the map is one tab stop (the current place, or the last focused)
      const rove = (el) => { for (const b of mapItems()) b.tabIndex = b === el ? 0 : -1; };
      rove(map.querySelector(".on") || usTile || tiles[0]);
      const focus = (el) => { if (!el) return; if (map.contains(el)) rove(el); el.focus({ preventScroll: true }); };

      const pick = (id) => {
        if (!manifest.locationById.has(id)) return;
        store.set({ location: id });
        layer.close(true);
      };
      let best = null;
      const filter = () => {
        const ms = matchLocations(locs, input.value), set = new Set(ms.map((l) => l.id));
        best = ms[0]?.id ?? null;
        layer.panel.classList.toggle("filtering", !!input.value.trim());
        for (const b of mapItems()) {
          b.classList.toggle("match", set.has(b.dataset.loc));
          b.classList.toggle("best", b.dataset.loc === best);
        }
      };

      input.addEventListener("input", filter);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); if (best) pick(best); }
        else if (e.key === "ArrowDown") {
          e.preventDefault();
          focus((best && map.querySelector(`[data-loc="${CSS.escape(best)}"]`)) || chips?.firstElementChild || map.querySelector("[tabindex='0']"));
        }
      });
      body.addEventListener("click", (e) => { const b = e.target.closest("[data-loc]"); if (b) pick(b.dataset.loc); });
      const season = manifest.seasonOf(store.get().date);
      const prefetch = (e) => { const b = e.target.closest?.("[data-loc]"); if (b && season) prefetchFan(store.get().target, season, b.dataset.loc); };
      body.addEventListener("pointerover", prefetch);
      body.addEventListener("focusin", prefetch);
      map.addEventListener("focusin", (e) => { if (e.target.matches("[data-loc]")) rove(e.target); });

      // arrows: across the chips in a row; across the map by geometry; between search, chips and map
      body.addEventListener("keydown", (e) => {
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        const el = e.target;
        if (!d || !el.dataset?.loc) return;
        e.preventDefault();
        const up = () => { if (chips) focus(chips.querySelector("[data-loc]")); else input.focus(); };
        if (chips?.contains(el)) {
          if (d[0]) focus((d[0] > 0 ? el.nextElementSibling : el.previousElementSibling) || el);
          else if (d[1] < 0) input.focus();
          else focus(map.querySelector("[tabindex='0']"));
          return;
        }
        if (el === usTile) {
          if (d[1] < 0) up();
          else if (d[1] > 0) focus(byAbbr.get(tileNeighbor(TILES, [col, -1], [0, 1])));
          return;
        }
        const ab = manifest.locationById.get(el.dataset.loc)?.abbr, at = TILES[ab];
        if (!at) { // a chip under the map
          if (d[0]) focus((d[0] > 0 ? el.nextElementSibling : el.previousElementSibling) || el);
          else if (d[1] < 0) focus(tiles.at(-1));
          return;
        }
        const next = tileNeighbor(TILES, at, d);
        if (next && byAbbr.has(next)) { col = TILES[next][0]; focus(byAbbr.get(next)); }
        else if (d[1] < 0) { col = at[0]; usTile ? focus(usTile) : up(); }
        else if (d[1] > 0 && offMap.length) focus(map.querySelector(".lp-chips [data-loc]"));
      });
      // Tab: search → recent chips → the map (one stop) → search
      offs.push(on(layer.panel, "keydown", (e) => {
        if (e.key !== "Tab" || e.defaultPrevented) return;
        const stops = [input, ...(chips ? [...chips.children] : []), map.querySelector("[tabindex='0']")].filter(Boolean);
        const i = stops.indexOf(document.activeElement);
        e.preventDefault();
        stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
      }));
    },
  });
}
