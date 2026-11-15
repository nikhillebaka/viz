/* What the three view sections (heatmap, map, peaks) share: the section frame on the paper (a heading,
 * one quiet line of fragment controls, a loading hairline, one quiet empty line), JSON loading with
 * cancellation, the score color ramps, HHS regions, canvas sizing, and on-screen / DPR watching. */
import { h, on, cssColor, storage } from "../lib/dom.js";
import { openMenu } from "../ui/floating.js";

/* ---------------------------------------------------------------- styles */
const linked = new Set();
/**
 * Adds styles/<name>.css once (import.meta-relative, so it works wherever next/ is served).
 * @param {string} name
 */
export function linkStyle(name) {
  if (linked.has(name)) return;
  linked.add(name);
  document.head.append(h("link", { rel: "stylesheet", href: new URL(`../styles/${name}.css`, import.meta.url).href }));
}

/* ---------------------------------------------------------------- frame */
/**
 * The section's skeleton on the paper.
 * @param {HTMLElement} el the section element
 * @param {string} title
 * @param {string} [guide] a Guide topic: a small ? beside the title opens it
 * @returns {{ line: HTMLElement, body: HTMLElement, empty(text: string | null, retry?: () => void): void, loading(on: boolean): void }}
 *   line: where the fragment controls go. empty(text) shows one quiet line instead of the body (null hides
 *   it); with `retry`, the line ends in a link (Retry, or linkText) that calls it.
 */
export function frame(el, title, guide) {
  linkStyle("views");
  const line = h("div", { class: "v-line" });
  const bar = h("div", { class: "v-progress", "aria-hidden": "true" });
  const body = h("div", { class: "v-body" });
  const msg = h("p", { class: "v-empty", hidden: true });
  el.classList.add("v-section");
  el.replaceChildren(h("header", { class: "v-head" }, h("h2", { class: "v-title" }, title, guide ? guideLink(guide, `${title} in the Guide`) : null), line), bar, msg, body);
  return {
    line, body,
    empty(text, retry, linkText = "Retry") {
      msg.hidden = !text; body.hidden = !!text;
      msg.replaceChildren(text || "", retry ? h("span", null, " · ", h("button", { type: "button", class: "c-link", onclick: retry }, linkText)) : "");
    },
    loading(on) { el.classList.toggle("is-loading", !!on); el.setAttribute("aria-busy", String(!!on)); },
  };
}

/**
 * A quiet ? that opens the Guide at a topic (the Guide module loads on first use).
 * @param {string} topic
 * @param {string} label its accessible name
 * @returns {HTMLButtonElement}
 */
export function guideLink(topic, label) {
  return h("button", {
    type: "button", class: "v-help", "aria-label": label,
    onclick: () => import("../features/Guide.js").then((m) => m.openGuide(topic)).catch((err) => console.error("viz: the Guide could not open", err)),
  }, "?");
}

/**
 * A fragment of the control line: quiet text that opens a small menu of choices. Primary ink when its
 * value differs from the default, so a non-standard view shows at a glance.
 * @param {{ label: string, items: () => { label: string, value: any }[], value: () => any,
 *           onSelect: (v: any) => void, isDefault?: () => boolean, title?: string }} o
 * @returns {HTMLButtonElement & { sync(): void }} sync() refreshes its label and ink
 */
export function fragment({ label, items, value, onSelect, isDefault = () => true, title = "" }) {
  const b = h("button", { type: "button", class: "v-frag", "aria-haspopup": "menu", "aria-label": title || null });
  b.sync = () => {
    const v = value(), it = items().find((x) => x.value === v);
    b.textContent = it?.short ?? it?.label ?? label;
    b.classList.toggle("is-set", !isDefault());
  };
  b.addEventListener("click", () => {
    const v = value();
    openMenu(b, {
      label: title || label,
      items: items().map((it) => it.header ? it : it === "-" ? it : ({ label: it.label, checked: it.value === v, disabled: it.disabled, onSelect: () => onSelect(it.value) })),
    });
  });
  b.sync();
  return b;
}

/**
 * A text button on the control line that acts in place (⇄, ▶).
 * @param {string} text @param {string} ariaLabel @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
export const action = (text, ariaLabel, onClick) => h("button", { type: "button", class: "v-frag v-act", "aria-label": ariaLabel, onclick: onClick }, text);

/** The " · " between fragments. */
export const sep = (text = "·") => h("span", { class: "v-sep", "aria-hidden": "true" }, text);

/**
 * Fills the control line: fragments, with " · " between the visible ones (null entries are skipped).
 * @param {HTMLElement} line @param {(Node | null | false)[]} parts
 */
export function setLine(line, parts) {
  const out = [];
  for (const p of parts) {
    if (!p) continue;
    if (out.length && !p.classList?.contains("v-tight")) out.push(sep(p.dataset?.sep));
    out.push(p);
  }
  line.replaceChildren(...out);
}

/* ---------------------------------------------------------------- data */
const cache = new Map();
/**
 * GET JSON with a small cache (32 responses) and cancellation. A newer call with the same `slot`
 * aborts the older one (its promise then rejects with an AbortError, which callers ignore).
 * @param {string} url
 * @param {{ slot?: object }} [o] any object that identifies the caller
 * @returns {Promise<any>}
 */
export function getJson(url, { slot } = {}) {
  if (slot?._ctl) slot._ctl.abort();
  if (cache.has(url)) { const v = cache.get(url); cache.delete(url); cache.set(url, v); return Promise.resolve(v); }
  const ctl = new AbortController();
  if (slot) slot._ctl = ctl;
  return fetch(url, { signal: ctl.signal }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.error) throw new Error(j?.error || `HTTP ${r.status}`);
    cache.set(url, j);
    while (cache.size > 32) cache.delete(cache.keys().next().value);
    return j;
  }).finally(() => { if (slot?._ctl === ctl) slot._ctl = null; });
}

/** @returns {string} a query string from an object, skipping null/undefined/"" values */
export function query(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") p.set(k, String(v));
  return p.toString();
}

export const isAbort = (e) => e?.name === "AbortError";

/* ---------------------------------------------------------------- color */
const parseRgb = (s) => (s.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
let rampCache = null;
function scoreStops() {
  // cssColor caches per theme; this array is rebuilt when the theme changes (resetColors)
  return (rampCache ||= Array.from({ length: 9 }, (_, i) => parseRgb(cssColor(`var(--score-${i + 1})`))));
}
/** Forget the parsed score colors (after a theme change). */
export function resetColors() { rampCache = null; }

function mix(stops, t) {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = stops[i], b = stops[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)}, ${Math.round(a[1] + (b[1] - a[1]) * f)}, ${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

/**
 * A magnitude: t in [0, 1] from neutral (--score-5, near the paper) to warm (--score-9).
 * @param {number} t @returns {string} an rgb() color
 */
export const sequential = (t) => mix(scoreStops().slice(4), t);

/**
 * A signed score: t in [-1, 1]; −1 better (cool, --score-1), 0 neutral (--score-5), 1 worse (warm, --score-9).
 * @param {number} t @returns {string}
 */
export const diverging = (t) => mix(scoreStops(), (Math.max(-1, Math.min(1, t)) + 1) / 2);

/**
 * Text ink that reads on a score fill: primary ink unless the fill is far from the paper.
 * @param {string} rgb a fill from sequential()/diverging()
 * @returns {string} a CSS color
 */
export function inkOn(rgb) {
  const [r, g, b] = parseRgb(rgb), [pr, pg, pb] = parseRgb(cssColor("var(--surface-paper)"));
  const L = (x, y, z) => 0.2126 * x + 0.7152 * y + 0.0722 * z;
  const dark = L(pr, pg, pb) < 128;
  return (dark ? L(r, g, b) > 150 : L(r, g, b) < 110) ? (dark ? cssColor("var(--surface-paper)") : cssColor("var(--surface-raised)")) : cssColor("var(--ink-primary)");
}

/* ---------------------------------------------------------------- places */
/** HHS region (1–10) by location abbreviation. */
export const HHS = Object.freeze(Object.fromEntries([
  [1, "CT ME MA NH RI VT"], [2, "NJ NY PR VI"], [3, "DE DC MD PA VA WV"], [4, "AL FL GA KY MS NC SC TN"],
  [5, "IL IN MI MN OH WI"], [6, "AR LA NM OK TX"], [7, "IA KS MO NE"], [8, "CO MT ND SD UT WY"],
  [9, "AZ CA HI NV AS GU MP"], [10, "AK ID OR WA"],
].flatMap(([r, s]) => s.split(" ").map((a) => [a, r]))));

/**
 * Lookups between location ids (FIPS, "US"), abbreviations and names.
 * @param {object} manifest
 * @returns {{ byAbbr: Map<string, object>, abbrOf(id: string): string }}
 */
export function places(manifest) {
  if (manifest._places) return manifest._places;
  const byAbbr = new Map(manifest.locations.map((l) => [l.abbr, l]));
  return (manifest._places = { byAbbr, abbrOf: (id) => manifest.locationById.get(id)?.abbr ?? id });
}

/* ---------------------------------------------------------------- canvas */
/**
 * Sizes a canvas for the device pixel ratio and returns a context scaled to CSS pixels.
 * @param {HTMLCanvasElement} c @param {number} w @param {number} hgt CSS px
 * @returns {CanvasRenderingContext2D}
 */
export function fitCanvas(c, w, hgt) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(hgt * dpr));
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  c.style.width = `${w}px`; c.style.height = `${hgt}px`;
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, hgt);
  return g;
}

/**
 * Calls fn at most once per animation frame.
 * @param {() => void} fn @returns {() => void} schedule
 */
export function perFrame(fn) {
  let raf = 0;
  return () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; fn(); }); };
}

/**
 * A solid readout that follows the pointer inside `host` (the kit's .c-readout).
 * @param {HTMLElement} host positioned ancestor
 * @returns {{ show(x: number, y: number, content: Node[]): void, hide(): void, el: HTMLElement }}
 */
export function pointerReadout(host) {
  const el = h("div", { class: "c-readout v-readout", role: "status", hidden: true });
  host.append(el);
  return {
    el,
    show(x, y, content) {
      el.replaceChildren(...content);
      el.hidden = false;
      const hw = host.clientWidth, w = el.offsetWidth, hh = el.offsetHeight;
      const left = x + 16 + w > hw ? x - 16 - w : x + 16;
      el.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, y - hh - 12)}px)`;
    },
    hide() { el.hidden = true; },
  };
}

/**
 * A readout table: [label, value, quiet?] rows.
 * @param {string} head @param {(Array | null)[]} rows @param {string} [foot]
 * @returns {Node[]}
 */
export function readoutContent(head, rows, foot) {
  return [
    h("div", { class: "c-readout-head" }, h("span", null, head)),
    h("table", null, rows.filter(Boolean).map(([k, v, quiet]) => h("tr", { class: quiet ? "dim" : null }, h("td", { class: "c-readout-name" }, k), h("td", { class: "num" }, v)))),
    foot ? h("div", { class: "c-readout-foot" }, h("span", null, foot)) : null,
  ].filter(Boolean);
}

/* ---------------------------------------------------------------- when to work */
/**
 * Runs work only while the section is on (or near) the screen. Work asked for while it is off screen
 * waits and runs once, when the section comes back; only the latest ask waits, so pass work that
 * covers everything (a load that re-renders). `onChange(visible)` hears each change.
 * @param {HTMLElement} el
 * @param {(visible: boolean) => void} [onChange]
 * @returns {{ visible(): boolean, run(fn: () => void): void, off(): void }}
 */
export function onScreen(el, onChange) {
  let vis = true, pending = null;  // mounted because it neared the viewport: visible until told otherwise
  const io = new IntersectionObserver((es) => {
    const v = es[es.length - 1].isIntersecting;
    if (v === vis) return;
    vis = v;
    onChange?.(v);
    if (v && pending) { const fn = pending; pending = null; fn(); }
  }, { rootMargin: "400px 0px" });
  io.observe(el);
  return {
    visible: () => vis,
    run(fn) { if (vis) { pending = null; fn(); } else pending = fn; },
    off() { io.disconnect(); pending = null; },
  };
}

/**
 * Calls fn when the device pixel ratio changes (a window moved to another screen, browser zoom), which a
 * ResizeObserver doesn't report.
 * @param {() => void} fn @returns {() => void} stops
 */
export function onDprChange(fn) {
  let mq = null;
  const arm = () => {
    mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener("change", fire, { once: true });
  };
  const fire = () => { arm(); fn(); };
  arm();
  return () => mq?.removeEventListener("change", fire);
}

/**
 * A section's settings in the store's `views` (the URL carries them) and in local storage: what the URL
 * says, else what was stored. write(v, isDefault) keeps both; a default view leaves the URL clean.
 * @param {{ get(): object, set(p: any): void }} store @param {string} name views key @param {string} key storage key
 * @returns {{ initial: object, write(v: object, isDefault: boolean): void }}
 */
export function viewState(store, name, key) {
  const fromUrl = store.get().views?.[name];
  return {
    initial: fromUrl || storage.get(key, {}) || {},
    write(v, isDefault) {
      storage.set(key, v);
      store.set((s) => ({ views: { ...(s.views || {}), [name]: isDefault ? null : v } }));
    },
  };
}

export { h, on };
