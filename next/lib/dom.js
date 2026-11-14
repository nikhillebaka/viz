/* DOM helpers shared by every module: an element builder, listeners that return their own
 * remover, design tokens read from CSS (cached per theme), and localStorage that never throws.
 * No knowledge of the app. */

/**
 * Build an element.
 * attrs: `class` (string or array, falsy entries dropped), `style` (object; `--x` keys become custom
 * properties), `html` (innerHTML, for trusted strings such as icons), `on<event>` (listener), and any
 * other attribute (`data-*`, `aria-*`, `type`, …). `true` sets an empty attribute; `false`, null and
 * undefined skip it. Children: nodes, strings, numbers, arrays (flattened), null/false (skipped).
 * @param {string} tag
 * @param {object} [attrs]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = Array.isArray(v) ? v.filter(Boolean).join(" ") : v;
      else if (k === "style") for (const [p, sv] of Object.entries(v)) { if (sv != null) el.style.setProperty(p.startsWith("--") ? p : p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), sv); }
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  append(el, children);
  return el;
}
function append(el, kids) {
  for (const c of kids) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/**
 * Add a listener.
 * @returns {() => void} removes exactly this listener
 */
export function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

/* ---------- tokens ----------
 * Cached per theme: the cache is keyed by the root's data-theme, so a read right after a theme switch
 * (before any observer has run) is never stale. */
const caches = new Map();
const themeOf = () => document.documentElement.dataset.theme || "dark";
function cacheFor() {
  const t = themeOf();
  let c = caches.get(t);
  if (!c) caches.set(t, (c = new Map()));
  watchTheme();
  return c;
}

/**
 * A design token's value, as written in tokens.css for the current theme (trimmed).
 * @param {string} name e.g. "--dur"
 * @returns {string} "" when the token doesn't exist
 */
export function token(name) {
  const c = cacheFor(), k = `t${name}`;
  let v = c.get(k);
  if (v === undefined) c.set(k, (v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()));
  return v;
}

/**
 * A token as a number: "200ms" → 200, "0.6" → 0.6, "16px" → 16.
 * @param {string} name
 * @param {number} [fallback=0] returned when the token is missing or not numeric
 * @returns {number}
 */
export function tokenNum(name, fallback = 0) {
  const v = parseFloat(token(name));
  return Number.isFinite(v) ? v : fallback;
}

let probe = null;
/**
 * Resolve any CSS color (including `var(--x)` and color-mix) to a string a canvas accepts.
 * Cached per theme.
 * @param {string} value
 * @returns {string} e.g. "rgb(10, 132, 255)"
 */
export function cssColor(value) {
  const c = cacheFor(), k = `c${value}`;
  let v = c.get(k);
  if (v === undefined) {
    if (!probe) { probe = document.createElement("span"); probe.hidden = true; document.documentElement.appendChild(probe); }
    probe.style.color = "";
    probe.style.color = value;
    c.set(k, (v = getComputedStyle(probe).color));
  }
  return v;
}

/** Forget every cached token and color (after tokens are changed at runtime). */
export function clearTokens() { caches.clear(); }

const themeFns = new Set();
let themeObserver = null;
function watchTheme() {
  if (themeObserver) return;
  let last = themeOf();
  themeObserver = new MutationObserver(() => {
    const t = themeOf();
    if (t === last) return;
    last = t;
    themeFns.forEach((fn) => fn(t));
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

/**
 * Run fn(theme) after the root's data-theme changes.
 * @param {(theme: string) => void} fn
 * @returns {() => void} unsubscribes
 */
export function onThemeChange(fn) {
  watchTheme();
  themeFns.add(fn);
  return () => themeFns.delete(fn);
}

/** @returns {boolean} the OS asks for reduced motion */
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** localStorage as JSON. Never throws (private mode, quota, bad JSON). */
export const storage = {
  /** @returns {any} the stored value, or fallback when absent or unreadable */
  get(key, fallback = null) {
    try { const s = localStorage.getItem(key); return s == null ? fallback : JSON.parse(s); } catch { return fallback; }
  },
  /** @returns {boolean} whether it was written */
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};
