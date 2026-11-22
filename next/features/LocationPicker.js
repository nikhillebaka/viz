/* The location picker: search, recent places, and the contextual geography map of the loaded hub
 * (U.S. tile grid, proportioned Europe squircles, MetroCast 15-state grid + interactive state HSA SVG,
 * or grouped list), plus a quiet link to open the interactive Globe.
 *
 * TILES, COLUMNS, matchLocations(), tileNeighbor() and nextRecent() are pure, for node tests. */
import { h, on, storage } from "../lib/dom.js";
import { openPopover } from "../ui/floating.js";
import { icon } from "../ui/controls.js";
import { prefetchFan } from "../lib/api.js";
import { EU_TILES_PROPORTIONED, EU_TILES_PROPORTIONED_UK_SPLIT, US_STATE_META, resolveEuLocation } from "../geo/eu_tiles.js";
import { TILES, COLUMNS, classifyHubGeo, loadUsGeoCache, renderHsaStateSvg } from "../geo/picker_geo.js";

export { TILES, COLUMNS };

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
 * the least distance along the direction plus twice the distance across it.
 * @param {Record<string, [number, number]>} tiles key -> [column, row]
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
 * Search across all canonical places in `catalog` (falling back to `manifest.locations` when no catalog).
 * Ranks exact abbr/id/name matches first, then starts-with, word-starts-with, then substring; ties
 * prefer places present in `activeHubId`, then alphabetical by name.
 * @param {object | null} catalog
 * @param {import("../lib/api.js").Manifest} manifest
 * @param {string} query
 * @param {string | null} activeHubId
 * @returns {Array<{ key: string, name: string, abbr: string, level: string, inActiveHub: boolean, targetHubId: string | null, targetLocationId: string, regionHint: string }>}
 */
export function matchCatalogPlaces(catalog, manifest, query, activeHubId) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];

  const rankPlace = (name, abbr, ids) => {
    const nl = (name || "").toLowerCase();
    const al = (abbr || "").toLowerCase();
    if (al === q || nl === q || ids.some((id) => (id || "").toLowerCase() === q)) return 0;
    if (nl.startsWith(q)) return 1;
    if (nl.split(/[\s-]+/).some((w) => w.startsWith(q))) return 2;
    if (nl.includes(q)) return 3;
    return -1;
  };

  if (catalog?.places && Object.keys(catalog.places).length) {
    const out = [];
    for (const p of Object.values(catalog.places)) {
      const hubs = Array.isArray(p.hubs) ? p.hubs : [];
      if (!hubs.length) continue;
      const ids = [p.key, ...hubs.map((h) => h.location_id)];
      const r = rankPlace(p.name, p.abbr, ids);
      if (r < 0) continue;
      const activeEnt = hubs.find((h) => h.hub_id === activeHubId) || null;
      const bestEnt = activeEnt || hubs[0];
      const regions = [...new Set(hubs.map((h) => h.region_label).filter(Boolean))];
      const pathogens = [...new Set(hubs.map((h) => h.pathogen_label).filter(Boolean))];
      const hintParts = [];
      if (!activeEnt && regions.length) hintParts.push(regions[0]);
      else if (p.level === "hsa") hintParts.push("MetroCast");
      else if (p.region) hintParts.push(p.region);
      if (pathogens.length) hintParts.push(pathogens.join(", "));
      out.push({
        key: p.key,
        name: p.name || p.key,
        abbr: p.abbr || p.key,
        level: p.level || "custom",
        inActiveHub: !!activeEnt,
        targetHubId: bestEnt?.hub_id || activeHubId || null,
        targetLocationId: bestEnt?.location_id || p.key,
        regionHint: hintParts.join(" · "),
        _rank: r,
      });
    }
    out.sort((a, b) => a._rank - b._rank || (a.inActiveHub === b.inActiveHub ? 0 : a.inActiveHub ? -1 : 1) || a.name.localeCompare(b.name));
    return out.map(({ _rank, ...rest }) => rest);
  }

  return matchLocations(manifest?.locations || [], q).map((l) => ({
    key: l.id,
    name: l.name || l.id,
    abbr: l.abbr || l.id,
    level: l.level || "custom",
    inActiveHub: true,
    targetHubId: activeHubId || null,
    targetLocationId: l.id,
    regionHint: [l.region, l.level].filter(Boolean).join(" · "),
  }));
}

/**
 * Open the location picker from the Location bubble (or close it, if it is open from there).
 * Renders only the geography belonging to the loaded hub while search indexes all connected places.
 */
export function openLocationPicker(anchor, ctx) {
  const { manifest, store, catalog } = ctx;
  const locs = manifest.locations || [];
  const totalCount = catalog?.places ? Object.keys(catalog.places).length : locs.length;
  const current = store.get().location;
  const nameOf = (id) => manifest.locationById.get(id)?.name || id;
  const geoCls = classifyHubGeo(manifest);
  const offs = [];

  return openPopover(anchor, {
    morph: true, width: 420, className: "lp-panel",
    onClose: () => offs.forEach((off) => off()),
    content(body, layer) {
      const input = h("input", {
        type: "search",
        placeholder: totalCount > locs.length ? `Search ${totalCount} places` : `Search ${locs.length} locations`,
        "aria-label": "Search locations",
        autocomplete: "off",
        spellcheck: "false",
      });
      const storedPlaces = (manifest.hub_id ? storage.get(`viz.h.${manifest.hub_id}.places`) : null) ?? storage.get(PLACES_KEY, []);
      const recent = (Array.isArray(storedPlaces) ? storedPlaces : []).filter((id) => id !== current && manifest.locationById.has(id)).slice(0, RECENT);
      const chips = recent.length ? h("div", { class: "lp-chips lp-recent", role: "group", "aria-label": "Recent" },
        recent.map((id) => h("button", {
          type: "button", class: "c-chip", "data-loc": id, title: nameOf(id), "aria-label": nameOf(id),
        }, nameOf(id)))) : null;

      const place = (l, cls, label) => h("button", {
        type: "button", class: cls, "data-loc": l.id, title: l.name || l.id, "aria-label": l.name || l.id,
        "aria-current": l.id === current ? "true" : null,
      }, label);

      const pick = (id) => {
        if (!manifest.locationById.has(id)) return;
        store.set({ location: id });
        layer.close(true);
      };

      const pickCatalogHit = (hit) => {
        if (!hit) return;
        if (hit.inActiveHub && manifest.locationById.has(hit.targetLocationId)) {
          pick(hit.targetLocationId);
          return;
        }
        if (ctx.switchContext && hit.targetHubId) {
          layer.close(false);
          ctx.switchContext({ hub: hit.targetHubId, location: hit.targetLocationId });
        }
      };

      const renderCatalogRows = (hits, box, compact = false, heading = null) => {
        box.classList.toggle("is-compact", compact);
        if (!hits.length) {
          box.replaceChildren();
          box.hidden = true;
          return;
        }
        const nodes = heading ? [h("div", { class: "lp-cross-head" }, heading)] : [];
        for (let i = 0; i < hits.length; i++) {
          const item = hits[i];
          const row = h("button", {
            type: "button",
            class: ["c-row two", i === 0 && !compact && "on"],
            onclick: () => pickCatalogHit(item),
          },
          h("span", { class: "c-row-text" },
            h("span", { class: "c-row-label" }, item.name),
            item.regionHint ? h("span", { class: "c-row-sub" }, item.regionHint) : null,
          ),
          h("span", { class: "c-row-sub mono" }, item.abbr || item.key));
          nodes.push(row);
        }
        box.replaceChildren(...nodes);
        box.hidden = false;
      };

      const globeFoot = typeof ctx.openGlobe === "function"
        ? h("div", { class: "lp-globe-foot" },
          h("button", {
            type: "button", class: "c-row",
            onclick: () => { layer.close(true); ctx.openGlobe(); },
          },
          h("span", { class: "c-row-text" },
            h("span", { class: "c-row-label" }, "Globe"),
          ),
          h("span", { class: "c-row-sub" }, "→")))
        : null;

      const season = manifest.seasonOf(store.get().date);
      const prefetch = (e) => {
        const b = e.target.closest?.("[data-loc]");
        const s = store.get();
        if (b?.dataset.loc && season) prefetchFan(s.target, season, b.dataset.loc, { dims: s.dims });
      };
      body.addEventListener("pointerover", prefetch);
      body.addEventListener("focusin", prefetch);

      if (geoCls.kind === "us-states") {
        // Classic 11x8 US tile map with full keyboard arrow navigation + cross-hub search results
        const resultsBox = h("div", { class: "lp-results", hidden: true });
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
          ...[
            usTile,
            h("div", { class: "c-tile-grid lp-tiles" }, tiles),
            offMap.length ? h("div", { class: "lp-chips" }, offMap.map((l) => place(l, ["c-chip", l.id === current && "on"], l.name || l.id))) : null,
          ].filter(Boolean));
        body.append(...[h("label", { class: "c-search", html: icon.search }, input), chips, resultsBox, map, globeFoot].filter(Boolean));

        const byAbbr = new Map(onMap.map((l, i) => [l.abbr, tiles[i]]));
        const mapItems = () => [...map.querySelectorAll("[data-loc]")];
        let col = 5;
        const rove = (el) => { for (const b of mapItems()) b.tabIndex = b === el ? 0 : -1; };
        rove(map.querySelector(".on") || usTile || tiles[0]);
        const focus = (el) => { if (!el) return; if (map.contains(el)) rove(el); el.focus({ preventScroll: true }); };

        let bestInHub = null;
        let topCrossHit = null;
        const filter = () => {
          const rawQ = input.value.trim();
          const ms = matchLocations(locs, rawQ), set = new Set(ms.map((l) => l.id));
          bestInHub = ms[0]?.id ?? null;
          layer.panel.classList.toggle("filtering", !!rawQ);
          for (const b of mapItems()) {
            b.classList.toggle("match", set.has(b.dataset.loc));
            b.classList.toggle("best", b.dataset.loc === bestInHub);
          }
          if (!rawQ) {
            topCrossHit = null;
            map.hidden = false;
            renderCatalogRows([], resultsBox);
            layer.place?.();
            return;
          }
          const catHits = matchCatalogPlaces(catalog, manifest, rawQ, manifest.hub_id || null);
          const crossHits = catHits.filter((h) => !h.inActiveHub);
          topCrossHit = catHits[0] || null;
          if (!ms.length) {
            map.hidden = true;
            if (!catHits.length) {
              resultsBox.classList.remove("is-compact");
              resultsBox.hidden = false;
              resultsBox.replaceChildren(h("p", { class: "pk-empty" }, `No match for “${rawQ}”`));
            } else {
              renderCatalogRows(catHits.slice(0, 12), resultsBox, false);
            }
          } else {
            map.hidden = false;
            if (crossHits.length) renderCatalogRows(crossHits.slice(0, 4), resultsBox, true, "Other connected hubs");
            else renderCatalogRows([], resultsBox);
          }
          layer.place?.();
        };
        input.addEventListener("input", filter);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (bestInHub) pick(bestInHub);
            else if (topCrossHit) pickCatalogHit(topCrossHit);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            focus((bestInHub && map.querySelector(`[data-loc="${CSS.escape(bestInHub)}"]`)) || resultsBox.querySelector("button") || chips?.firstElementChild || map.querySelector("[tabindex='0']"));
          }
        });
        body.addEventListener("click", (e) => { const b = e.target.closest("[data-loc]"); if (b) pick(b.dataset.loc); });
        map.addEventListener("focusin", (e) => { if (e.target.matches("[data-loc]")) rove(e.target); });

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
          if (!at) {
            if (d[0]) focus((d[0] > 0 ? el.nextElementSibling : el.previousElementSibling) || el);
            else if (d[1] < 0) focus(tiles.at(-1));
            return;
          }
          const next = tileNeighbor(TILES, at, d);
          if (next && byAbbr.has(next)) { col = TILES[next][0]; focus(byAbbr.get(next)); }
          else if (d[1] < 0) { col = at[0]; usTile ? focus(usTile) : up(); }
          else if (d[1] > 0 && offMap.length) focus(map.querySelector(".lp-chips [data-loc]"));
        });
        offs.push(on(layer.panel, "keydown", (e) => {
          if (e.key !== "Tab" || e.defaultPrevented) return;
          const stops = [input, ...(chips ? [...chips.children] : []), map.querySelector("[tabindex='0']")].filter(Boolean);
          const i = stops.indexOf(document.activeElement);
          e.preventDefault();
          stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
        }));
        queueMicrotask(() => input.focus({ preventScroll: true }));
        return;
      }

      // Contextual non-US-states modes (Europe squircles, MetroCast 15-state + SVG HSAs, or generic list)
      const resultsBox = h("div", { class: "lp-results", hidden: true });
      const map = h("div", { class: "lp-map", role: "group", "aria-label": "Locations" });
      body.append(...[h("label", { class: "c-search", html: icon.search }, input), chips, resultsBox, map, globeFoot].filter(Boolean));

      let mcStateFips = geoCls.kind === "us-metrocast"
        ? (geoCls.stateFipsOf(current) || (geoCls.coveredStateFips.size === 1 ? [...geoCls.coveredStateFips][0] : null))
        : null;
      let topHit = null;

      function renderContextual() {
        if (geoCls.kind === "eu-countries") {
          const tileSpec = geoCls.ukSplitAvailable ? EU_TILES_PROPORTIONED_UK_SPLIT : EU_TILES_PROPORTIONED;
          const onGrid = new Set();
          const euTiles = [];
          for (const [id, [col, row, cs = 1, rs = 1]] of Object.entries(tileSpec)) {
            const loc = resolveEuLocation(id, manifest.locationById);
            if (!loc) continue;
            onGrid.add(loc.id);
            const btn = place(loc, ["c-tile", loc.id === current && "on"], loc.abbr || id);
            btn.style.gridColumn = `${col} / span ${cs}`;
            btn.style.gridRow = `${row} / span ${rs}`;
            euTiles.push(btn);
          }
          const offEu = locs.filter((l) => !onGrid.has(l.id));
          map.replaceChildren(...[
            h("div", { class: "lp-eu-tiles" }, ...euTiles),
            offEu.length ? h("div", { class: "lp-chips" }, offEu.map((l) => place(l, ["c-chip", l.id === current && "on"], l.name || l.id))) : null,
          ].filter(Boolean));
          return;
        }

        if (geoCls.kind === "us-metrocast") {
          if (!mcStateFips) {
            const mcTiles = Object.entries(TILES).map(([abbr, [x, y]]) => {
              const stateLoc = geoCls.stateByAbbr.get(abbr);
              const fips = Object.entries(US_STATE_META).find(([, v]) => v.abbr === abbr)?.[0];
              const isAvail = fips && geoCls.coveredStateFips.has(fips);
              const hsas = isAvail ? (geoCls.hsasByStateFips.get(fips) || []) : [];
              const btn = h("button", {
                type: "button",
                class: ["c-tile", isAvail ? "is-mc-avail" : "is-muted", stateLoc?.id === current && "on"],
                disabled: !isAvail,
                title: isAvail ? `${US_STATE_META[fips]?.name || abbr} (${hsas.length} HSAs)` : `${abbr} (not covered)`,
                style: { gridColumn: String(x + 1), gridRow: String(y + 1) },
                onclick: () => {
                  if (!isAvail) return;
                  if (hsas.length) {
                    mcStateFips = fips;
                    renderContextual();
                  } else if (stateLoc) {
                    pick(stateLoc.id);
                  }
                },
              }, abbr);
              return btn;
            });
            map.replaceChildren(
              h("div", { class: "lp-ctx-bar" },
                h("span", { class: "lp-ctx-title" }, `Covered states · ${geoCls.coveredStateFips.size}`)),
              h("div", { class: "c-tile-grid lp-tiles" }, ...mcTiles),
            );
            return;
          }

          const stateLoc = geoCls.stateByFips.get(mcStateFips);
          const stateName = stateLoc?.name || US_STATE_META[mcStateFips]?.name || mcStateFips;
          const hsas = geoCls.hsasByStateFips.get(mcStateFips) || [];
          const hasBoroughs = hsas.some((m) => m.level === "borough");
          const cityLoc = hasBoroughs
            ? (hsas.find((m) => m.id === "nyc") || hsas.find((m) => m.level === "metro") || null)
            : null;
          const chipHsas = hasBoroughs
            ? hsas.filter((m) => m.id !== "nyc" && m.id !== "NYC" && m.level !== "metro")
            : hsas;
          const curHsa = hsas.find((m) => m.id === current);
          const caption = h("p", { class: "lp-hsa-cap" }, curHsa ? curHsa.name : `${chipHsas.length} MetroCast regions in ${stateName}`);
          const svgWrap = h("div", { class: "lp-hsa-wrap" });

          const scopeActions = [
            stateLoc ? h("button", {
              type: "button", class: ["c-link lp-ctx-act", current === stateLoc.id && "is-on"],
              onclick: () => pick(stateLoc.id),
            }, "Whole state") : null,
            cityLoc ? h("button", {
              type: "button", class: ["c-link lp-ctx-act", (current === cityLoc.id || current === "NYC") && "is-on"],
              onclick: () => pick(cityLoc.id),
            }, "Whole city") : null,
          ].filter(Boolean);

          map.replaceChildren(
            h("div", { class: "lp-ctx-bar" },
              ...[
                geoCls.coveredStateFips.size > 1 ? h("button", {
                  type: "button", class: "c-link",
                  onclick: () => { mcStateFips = null; renderContextual(); },
                }, `← ${geoCls.coveredStateFips.size} states`) : null,
                h("span", { class: "lp-ctx-title" }, stateName),
                scopeActions.length ? h("div", { class: "lp-ctx-actions" }, ...scopeActions) : null,
              ].filter(Boolean)),
            svgWrap,
            caption,
            h("div", { class: "lp-chips", style: { padding: "0" } },
              ...chipHsas.map((m) => place(m, ["c-chip", m.id === current && "on"], m.abbr || m.name))),
          );

          svgWrap.replaceChildren(h("p", { class: "pk-empty" }, "Loading boundaries…"));
          loadUsGeoCache().then((usGeo) => {
            if (!svgWrap.isConnected) return;
            const svg = renderHsaStateSvg(usGeo, mcStateFips, hsas, {
              activeId: current,
              onHover: (_id, label) => { caption.textContent = label; },
              onPick: (id) => pick(id),
            });
            svgWrap.replaceChildren(svg || h("p", { class: "pk-empty" }, "Select region below"));
          }).catch(() => {
            if (svgWrap.isConnected) svgWrap.replaceChildren(h("p", { class: "pk-empty" }, "Select region below"));
          });
          return;
        }

        // Generic hub fallback (grouped by region)
        const byReg = new Map();
        for (const l of locs) {
          const r = l.region || "Locations";
          if (!byReg.has(r)) byReg.set(r, []);
          byReg.get(r).push(l);
        }
        const nodes = [];
        for (const [reg, items] of byReg.entries()) {
          if (byReg.size > 1) nodes.push(h("div", { class: "c-section" }, h("span", { class: "c-section-title" }, reg)));
          nodes.push(h("div", { class: "lp-chips" }, items.map((l) => place(l, ["c-chip", l.id === current && "on"], l.name || l.id))));
        }
        map.replaceChildren(...nodes);
      }

      const drawSearch = () => {
        const q = input.value.trim();
        if (!q) {
          topHit = null;
          renderCatalogRows([], resultsBox);
          map.hidden = false;
          renderContextual();
          layer.place?.();
          return;
        }
        const hits = matchCatalogPlaces(catalog, manifest, q, manifest.hub_id || null).slice(0, 12);
        topHit = hits[0] ?? null;
        map.hidden = true;
        if (!hits.length) {
          resultsBox.classList.remove("is-compact");
          resultsBox.hidden = false;
          resultsBox.replaceChildren(h("p", { class: "pk-empty" }, `No match for “${q}”`));
          layer.place?.();
          return;
        }
        renderCatalogRows(hits, resultsBox, false);
        layer.place?.();
      };

      input.addEventListener("input", drawSearch);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && topHit) { e.preventDefault(); pickCatalogHit(topHit); }
      });
      body.addEventListener("click", (e) => {
        const b = e.target.closest("[data-loc]");
        if (b?.dataset.loc) pick(b.dataset.loc);
      });

      drawSearch();
      queueMicrotask(() => input.focus({ preventScroll: true }));
    },
  });
}
