/* Liquid glass (from study 01, extended).
 *
 * Three ways to render, chosen automatically. All three share one look: the same filter, the
 * same rim width and bend in pixels whatever the control's size, so a 38px pill and a 68px lens
 * read as the same material.
 *  - "refract":  bends a copy of an SVG `source` (the chart) inside the element. Works in every
 *                browser. Requirements: the source <svg> fills `container` from its top-left, and
 *                the source paints its own opaque background.
 *  - "backdrop": bends whatever is behind the element on the page, using backdrop-filter: url().
 *                Chromium only (Chrome, Edge, Arc). Used when there is no `source`.
 *  - "frost":    a plain backdrop blur. The fallback for other browsers, for { frosted: true }
 *                (panels that hold text), and when the OS asks for reduced transparency.
 *
 * Appearance follows Apple's Liquid Glass behaviour (see #adapt). It is change-driven, not polled:
 * it runs when the glass moves or resizes, when the page scrolls, and when anything outside the
 * glass changes in the DOM, at most once per animation frame, and only for glass on screen.
 *
 *   import { LiquidGlass } from "./lib/glass.js";
 *   const g = new LiquidGlass(pill, { source: "#chart-root", container: stage });
 *   g.update();   // after moving the element yourself; resizes and scrolling are handled
 */
const NS = "http://www.w3.org/2000/svg";
let defsEl = null, uid = 0;
const mapCache = new Map();
const all = new Set();

// Token values are read once (they don't change with the theme); call LiquidGlass.updateAll()
// after changing them at runtime.
const tokCache = new Map();
const tok = (name, fallback) => {
  if (!tokCache.has(name)) {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
    tokCache.set(name, Number.isFinite(v) ? v : fallback);
  }
  return tokCache.get(name);
};
// Chrome, Edge, Arc, Opera. Safari and Firefox don't include "Chrome/" in their user agent.
const isChromium = () => (navigator.userAgentData?.brands || []).some((b) => /Chromium/.test(b.brand)) || /Chrome\//.test(navigator.userAgent);
const reducedTransparency = () => matchMedia("(prefers-reduced-transparency: reduce)").matches;

function defs() {
  if (defsEl) return defsEl;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "lg-defs");
  svg.style.position = "absolute";
  defsEl = document.createElementNS(NS, "defs");
  svg.appendChild(defsEl);
  document.body.appendChild(svg);
  return defsEl;
}

// Signed distance to a rounded rectangle centred at the origin (negative inside).
function sdRoundRect(px, py, hw, hh, r) {
  const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Displacement map. Neutral is (128,128). Values below 128 sample toward the centre, which
// magnifies; the rim term is strongest at the edge and falls off inward. Cached per size.
function displacementMap(w, h, r, rim, power, magnify) {
  const key = [w, h, r, rim, power, magnify].join("|");
  if (mapCache.has(key)) return mapCache.get(key);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d"), img = ctx.createImageData(w, h);
  const hw = w / 2, hh = h / 2, e = 0.5, mr = Math.min(hw, hh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = x + 0.5 - hw, py = y + 0.5 - hh;
    const inside = -sdRoundRect(px, py, hw, hh, r);
    let dx = 0, dy = 0;
    if (inside > 0) {
      dx += (px / mr) * magnify * 0.5; dy += (py / mr) * magnify * 0.5;
      if (inside < rim) {
        const nx = sdRoundRect(px + e, py, hw, hh, r) - sdRoundRect(px - e, py, hw, hh, r);
        const ny = sdRoundRect(px, py + e, hw, hh, r) - sdRoundRect(px, py - e, hw, hh, r);
        const nl = Math.hypot(nx, ny) || 1, s = Math.pow(1 - inside / rim, power);
        dx += (nx / nl) * s; dy += (ny / nl) * s;
      }
    }
    const k = (y * w + x) * 4;
    img.data[k] = Math.max(0, Math.min(255, 128 - dx * 127));
    img.data[k + 1] = Math.max(0, Math.min(255, 128 - dy * 127));
    img.data[k + 2] = 128; img.data[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const url = c.toDataURL();
  mapCache.set(key, url);
  return url;
}

// Per-channel displacement for dispersion, then a gentle blur, saturation and brightness lift.
const FILTER = `<feImage preserveAspectRatio="none" result="map"/>
  <feDisplacementMap in="SourceGraphic" in2="map" xChannelSelector="R" yChannelSelector="G" result="dR"/>
  <feDisplacementMap in="SourceGraphic" in2="map" xChannelSelector="R" yChannelSelector="G" result="dG"/>
  <feDisplacementMap in="SourceGraphic" in2="map" xChannelSelector="R" yChannelSelector="G" result="dB"/>
  <feColorMatrix in="dR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r"/>
  <feColorMatrix in="dG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g"/>
  <feColorMatrix in="dB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b"/>
  <feComposite in="r" in2="g" operator="arithmetic" k2="1" k3="1" result="rg"/>
  <feComposite in="rg" in2="b" operator="arithmetic" k2="1" k3="1" result="rgb"/>
  <feGaussianBlur in="rgb" result="bl"/>
  <feColorMatrix in="bl" type="saturate" result="sat"/>
  <feComponentTransfer in="sat"><feFuncR type="linear"/><feFuncG type="linear"/><feFuncB type="linear"/></feComponentTransfer>`;

export class LiquidGlass {
  constructor(el, { source = null, container = null, frosted = false, highlight = false, adaptive = true } = {}) {
    this.el = el;
    this.container = container || el.offsetParent || el.parentElement;
    this.source = typeof source === "string" ? source : source ? `#${source.id}` : null;
    this.mode = frosted || reducedTransparency() ? "frost" : this.source ? "refract" : isChromium() ? "backdrop" : "frost";
    this.adaptive = adaptive;
    this.visible = true;
    this.L = null;            // smoothed luminance underneath
    this.pending = null;      // { state, since } while a switch waits out its dwell time
    this.lastAdapt = 0;
    this.lastKey = "";
    el.classList.add("lg", `lg--${this.mode}`);
    // bare text can't be lifted above the glass layers, so give it an element of its own
    for (const n of [...el.childNodes]) {
      if (n.nodeType === 3 && n.textContent.trim()) { const s = document.createElement("span"); n.replaceWith(s); s.appendChild(n); }
    }

    const layer =(cls) => { const d = document.createElement("div"); d.className = `lg-layer ${cls}`; el.prepend(d); return d; };
    layer("lg-rim");
    if (highlight) {
      layer("lg-spec");
      el.addEventListener("pointermove", (e) => {
        const r = el.getBoundingClientRect();
        el.style.setProperty("--lg-mx", `${e.clientX - r.left}px`);
        el.style.setProperty("--lg-my", `${e.clientY - r.top}px`);
      });
    }
    layer("lg-veil");
    layer("lg-tint");
    if (this.mode !== "frost") {
      const id = `lg-f${++uid}`;
      this.filter = document.createElementNS(NS, "filter");
      this.filter.setAttribute("id", id);
      this.filter.setAttribute("filterUnits", "userSpaceOnUse");
      this.filter.setAttribute("color-interpolation-filters", "sRGB");
      this.filter.innerHTML = FILTER;
      defs().appendChild(this.filter);
      if (this.mode === "refract") {
        this.refr = document.createElementNS(NS, "svg");
        this.refr.setAttribute("class", "lg-layer lg-refr");
        this.refr.setAttribute("aria-hidden", "true");
        this.refr.innerHTML = `<use href="${this.source}" filter="url(#${id})"/>`;
        el.prepend(this.refr);
      } else {
        el.style.backdropFilter = el.style.webkitBackdropFilter = `url(#${id})`;
      }
    }
    this.ro = new ResizeObserver(() => this.update());
    this.ro.observe(el); if (this.container) this.ro.observe(this.container);
    visibility.observe(el);
    all.add(this);
    this.update();
  }

  /** Re-position the lens and re-check appearance. Call after moving the element yourself. */
  update() {
    if (this.mode !== "frost") this.#place();
    schedule(this, true);
  }

  #place() {
    const w = Math.max(1, Math.round(this.el.offsetWidth)), h = Math.max(1, Math.round(this.el.offsetHeight));
    let x = 0, y = 0, W = w, H = h;
    if (this.mode === "refract") {
      const cr = this.container.getBoundingClientRect(), er = this.el.getBoundingClientRect();
      x = er.left - cr.left + (er.width - w) / 2; y = er.top - cr.top + (er.height - h) / 2;
      W = Math.round(cr.width); H = Math.round(cr.height);
    }
    // skip the DOM writes entirely if nothing moved
    const key = `${x}|${y}|${w}|${h}|${W}|${H}`;
    if (key === this.lastKey) return;
    const sizeChanged = !this.lastKey || !this.lastKey.endsWith(`|${w}|${h}|${W}|${H}`);
    this.lastKey = key;
    const [img, dR, dG, dB, , , , , , blur, sat, ct] = this.filter.children;
    if (sizeChanged) {
      const r = Math.min(parseFloat(getComputedStyle(this.el).borderTopLeftRadius) || 0, h / 2, w / 2);
      const rim = Math.max(4, Math.min(tok("--glass-rim", 14), Math.min(w, h) / 2 - 1));
      const scale = tok("--glass-refraction", 28), disp = tok("--glass-dispersion", 0.025);
      dR.setAttribute("scale", scale * (1 - disp)); dG.setAttribute("scale", scale); dB.setAttribute("scale", scale * (1 + disp));
      blur.setAttribute("stdDeviation", tok("--glass-blur", 0.6));
      sat.setAttribute("values", tok("--glass-saturate", 1.35));
      const br = tok("--glass-brightness", 1.06);
      for (const f of ct.children) f.setAttribute("slope", br);
      img.setAttribute("href", displacementMap(w, h, r, rim, tok("--glass-rim-power", 2), tok("--glass-magnify", 0.1)));
      img.setAttribute("width", w); img.setAttribute("height", h);
      this.filter.setAttribute("x", 0); this.filter.setAttribute("y", 0);
      this.filter.setAttribute("width", W); this.filter.setAttribute("height", H);
      if (this.refr) {
        // inline + !important so no page style (e.g. "svg { width: 16px }" for icons) can resize this layer
        this.refr.setAttribute("width", W); this.refr.setAttribute("height", H);
        this.refr.style.setProperty("width", `${W}px`, "important");
        this.refr.style.setProperty("height", `${H}px`, "important");
      }
    }
    img.setAttribute("x", x); img.setAttribute("y", y);
    if (this.refr) this.refr.style.transform = `translate(${-x}px, ${-y}px)`;
  }

  /* Appearance, following Apple's Liquid Glass behaviour:
   *  - Controls (up to --glass-flip-max-height tall) flip between light and dark text to suit what's
   *    underneath. Larger glass (panels, menus) never flips; a big surface changing colour distracts.
   *  - Every glass thickens its tint a little over busy, high-contrast content (the "veil").
   * Steadiness, so an ambiguous background never makes it flicker:
   *  - readings are smoothed with a running average,
   *  - there is a dead zone between the two thresholds where nothing changes,
   *  - a switch only happens once the new state has held for --glass-adapt-dwell ms,
   *  - text colour and veil fade over ~250ms in CSS, never jump. */
  adapt(now = performance.now()) {
    if (!this.adaptive || !this.visible) return;
    this.lastAdapt = now;
    const r = this.el.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > innerHeight) return;
    const ls = [];
    for (let i = 1; i <= 3; i++) for (let j = 1; j <= 2; j++) {
      const px = r.left + (r.width * i) / 4, py = r.top + (r.height * j) / 3;
      if (px >= 0 && py >= 0 && px < innerWidth && py < innerHeight) ls.push(luminanceAt(px, py));
    }
    if (!ls.length) return;
    const mean = ls.reduce((a, b) => a + b, 0) / ls.length;
    const k = tok("--glass-adapt-smoothing", 0.4);
    this.L = this.L == null ? mean : this.L + (mean - this.L) * k;
    // keep reading (at the normal rate) until the running average has settled on what's there
    if (Math.abs(mean - this.L) > 0.005) schedule(this);

    // veil: spread of perceived lightness, quantised so tiny changes cause no style writes
    const pl = ls.map(Math.cbrt), pm = pl.reduce((a, b) => a + b, 0) / pl.length;
    const spread = Math.sqrt(pl.reduce((a, b) => a + (b - pm) ** 2, 0) / pl.length);
    const veil = Math.round(Math.min(tok("--glass-veil-max", 0.6), spread * tok("--glass-veil", 2.2)) * 20) / 20;
    if (veil !== this.veil) { this.veil = veil; this.el.style.setProperty("--lg-veil", veil); }

    const themeDark = document.documentElement.dataset.theme !== "light";
    if (this.el.offsetHeight > tok("--glass-flip-max-height", 80)) { this.#setUnder(themeDark ? "dark" : "light", themeDark); return; }
    const cur = this.el.dataset.under || (themeDark ? "dark" : "light");
    const want = cur === "dark" ? (this.L > tok("--glass-adapt-light", 0.22) ? "light" : "dark") : this.L < tok("--glass-adapt-dark", 0.14) ? "dark" : "light";
    if (want === cur) { this.pending = null; return; }
    if (!this.pending || this.pending.state !== want) this.pending = { state: want, since: now };
    const dwell = tok("--glass-adapt-dwell", 220);
    if (now - this.pending.since >= dwell) { this.pending = null; this.#setUnder(want, themeDark); }
    else if (!this.dwellTimer) this.dwellTimer = setTimeout(() => { this.dwellTimer = 0; schedule(this, true); }, dwell - (now - this.pending.since) + 16);
  }

  #setUnder(state, themeDark) {
    // only mark the element when it differs from the theme's own ink
    if ((state === "dark") === themeDark) delete this.el.dataset.under; else this.el.dataset.under = state;
  }

  destroy() {
    this.ro?.disconnect();
    visibility.unobserve(this.el);
    this.filter?.remove();
    all.delete(this);
    this.el.querySelectorAll(":scope > .lg-layer").forEach((n) => n.remove());
    this.el.style.backdropFilter = "";
    this.el.classList.remove("lg", `lg--${this.mode}`);
    delete this.el.dataset.under;
  }

  /** After a theme change or a token change. */
  static updateAll() {
    tokCache.clear();
    all.forEach((g) => { g.L = null; g.pending = null; g.lastKey = ""; g.update(); });
  }
}

/* ---------- scheduling ----------
 * Appearance never competes with drawing: readings run in idle time (requestIdleCallback), at
 * most ~12 a second per glass (plenty, given the smoothing and dwell), only for glass on screen,
 * and only when something changed. Nothing runs while the page is still. Positioning the lens
 * itself (#place) stays synchronous so the refraction tracks the pointer exactly. */
const queue = new Set();
let pumping = false;
const MIN_GAP = 1000 / 12;
const idle = window.requestIdleCallback ? (cb) => requestIdleCallback(cb, { timeout: 120 }) : (cb) => setTimeout(cb, 16);
function schedule(g, force = false) {
  if (!g.adaptive) return;
  if (force) g.forceNext = true;
  queue.add(g);
  if (!pumping) { pumping = true; idle(pump); }
}
function pump() {
  const now = performance.now();
  let wait = Infinity;
  for (const g of queue) {
    const due = g.lastAdapt + MIN_GAP - now;
    if (g.forceNext || due <= 0) { queue.delete(g); g.forceNext = false; g.adapt(now); }
    else wait = Math.min(wait, due);
  }
  pumping = queue.size > 0;
  if (pumping) setTimeout(() => idle(pump), Math.max(0, wait));
}
const visibility = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const g = [...all].find((x) => x.el === e.target);
    if (!g) continue;
    g.visible = e.isIntersecting;
    if (g.visible) schedule(g, true);
  }
});
// Re-check when the page scrolls or anything outside the glass changes (a chart redraw, a theme
// switch, a list update). Mutations inside glass, and our own filter edits, are ignored.
addEventListener("scroll", () => all.forEach((g) => g.visible && schedule(g)), { passive: true, capture: true });
new MutationObserver((records) => {
  for (const m of records) {
    const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
    if (t && !t.closest(".lg, .lg-defs")) { all.forEach((g) => g.visible && schedule(g)); return; }
  }
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "fill", "d", "transform", "data-theme", "x", "y", "width", "height"] });

/* ---------- sampling helpers ---------- */
function cssColor(s) {
  const m = s && s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
function over(top, under) { const a = top[3]; return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]; }

// Composite the stack of elements under a point (ignoring glass) down to an opaque colour.
function luminanceAt(x, y) {
  const layers = [];
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.closest(".lg")) continue;
    const cs = getComputedStyle(el);
    let c;
    if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) {
      c = cs.fill !== "none" ? cssColor(cs.fill) : cssColor(cs.stroke);
      if (c) c[3] *= parseFloat(cs.fillOpacity || 1) * parseFloat(cs.opacity || 1);
    } else c = cssColor(cs.backgroundColor);
    if (c && c[3] > 0.02) { layers.push(c); if (c[3] > 0.98) break; }
  }
  let col = cssColor(getComputedStyle(document.body).backgroundColor) || [0, 0, 0, 1];
  for (let i = layers.length - 1; i >= 0; i--) col = over(layers[i], col);
  return lum(col);
}
