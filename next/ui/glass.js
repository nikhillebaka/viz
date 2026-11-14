/* Liquid glass. One material, made one of four ways, chosen once by where the element lives
 * (DECISIONS #5) and never changed afterwards:
 *  - "canvas":   over a chart canvas and moving with it ({ canvas }, no fixed ancestor). One WebGL pass
 *                refracts the canvas's pixels inside every such element (class Compositor). Call
 *                Glass.frame() after each redraw of the canvas.
 *  - "backdrop": fixed to the screen, or over the page. The same refraction as an SVG filter applied with
 *                backdrop-filter: url() (Chromium).
 *  - "blur":     "backdrop" where SVG backdrop filters aren't supported: the filter's blur, saturation and
 *                brightness, without the bending.
 *  - "frost":    panels that hold text ({ panel: true }), and everywhere when the OS asks for reduced
 *                transparency.
 * Every mode shares the rim, tint, edge strokes, shadow and text shadow (styles/glass.css). The refraction
 * has the same rim width and bend in pixels whatever the element's size, so a 38px pill and a 360px panel
 * read as one material. No light/dark text adaptation: the tint keeps text readable (DECISIONS #6). */
import { tokenNum, clearTokens, onThemeChange, on } from "../lib/dom.js";

const NS = "http://www.w3.org/2000/svg";
let defsEl = null, uid = 0, themeHooked = false;
const mapCache = new Map();
const instances = new Set();

// Chrome, Edge, Arc, Opera. Safari and Firefox don't include "Chrome/" in their user agent.
const isChromium = () => (navigator.userAgentData?.brands || []).some((b) => /Chromium/.test(b.brand)) || /Chrome\//.test(navigator.userAgent);
const reducedTransparency = () => matchMedia("(prefers-reduced-transparency: reduce)").matches;
const insideFixed = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (getComputedStyle(n).position === "fixed") return true; return false; };
const rimFor = (w, h) => Math.max(4, Math.min(tokenNum("--glass-rim", 14), Math.min(w, h) / 2 - 1));

function defs() {
  if (defsEl) return defsEl;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "c-glass-defs");
  svg.setAttribute("aria-hidden", "true");
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

// Displacement map. Neutral is (128,128). Values below 128 sample toward the centre, which magnifies;
// the rim term is strongest at the edge and falls off inward. Cached per size.
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

class GlassElement {
  constructor(el, panel, canvas) {
    this.el = el;
    this.comp = null;
    let mode = "frost";
    if (!panel && !reducedTransparency()) {
      if (canvas && !insideFixed(el)) this.comp = Compositor.for(canvas);
      mode = this.comp ? "canvas" : isChromium() ? "backdrop" : "blur";
    }
    this.mode = mode;
    this.lastKey = "";
    el.classList.add("c-glass", `c-glass--${mode}`);
    // bare text can't be lifted above the layers, so give it an element of its own
    for (const n of [...el.childNodes]) {
      if (n.nodeType === 3 && n.textContent.trim()) { const s = document.createElement("span"); n.replaceWith(s); s.appendChild(n); }
    }
    for (const cls of ["c-glass-rim", "c-glass-tint"]) {
      const d = document.createElement("div");
      d.className = `c-glass-layer ${cls}`;
      d.setAttribute("aria-hidden", "true");
      el.prepend(d);
    }
    if (mode === "canvas") this.comp.add(this);
    else if (mode === "backdrop") {
      this.filter = document.createElementNS(NS, "filter");
      this.filter.id = `c-glass-f${++uid}`;
      this.filter.setAttribute("filterUnits", "userSpaceOnUse");
      this.filter.setAttribute("color-interpolation-filters", "sRGB");
      this.filter.innerHTML = FILTER;
      defs().appendChild(this.filter);
      el.style.backdropFilter = el.style.webkitBackdropFilter = `url(#${this.filter.id})`;
    }
    if (mode === "canvas" || mode === "backdrop") {
      this.ro = new ResizeObserver(() => this.update());
      this.ro.observe(el);
    }
    instances.add(this);
    if (!themeHooked) { themeHooked = true; onThemeChange(() => Glass.refresh()); }
    this.update();
  }

  update() {
    if (this.mode === "canvas") this.comp.watch();
    else if (this.mode === "backdrop") this.place();
  }

  // The filter is in the element's own (untransformed) pixels, so only a size change rebuilds it.
  place() {
    const w = Math.max(1, Math.round(this.el.offsetWidth)), h = Math.max(1, Math.round(this.el.offsetHeight));
    const key = `${w}|${h}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const [img, dR, dG, dB, , , , , , blur, sat, ct] = this.filter.children;
    const r = Math.min(parseFloat(getComputedStyle(this.el).borderTopLeftRadius) || 0, h / 2, w / 2);
    const scale = tokenNum("--glass-refraction", 28), disp = tokenNum("--glass-dispersion", 0.025);
    dR.setAttribute("scale", scale * (1 - disp)); dG.setAttribute("scale", scale); dB.setAttribute("scale", scale * (1 + disp));
    blur.setAttribute("stdDeviation", tokenNum("--glass-blur", 0.6));
    sat.setAttribute("values", tokenNum("--glass-saturate", 1.35));
    const br = tokenNum("--glass-brightness", 1.06);
    for (const f of ct.children) f.setAttribute("slope", br);
    img.setAttribute("href", displacementMap(w, h, r, rimFor(w, h), tokenNum("--glass-rim-power", 2), tokenNum("--glass-magnify", 0.1)));
    img.setAttribute("x", 0); img.setAttribute("y", 0);
    img.setAttribute("width", w); img.setAttribute("height", h);
    for (const [k, v] of [["x", 0], ["y", 0], ["width", w], ["height", h]]) this.filter.setAttribute(k, v);
  }

  destroy() {
    if (!instances.has(this)) return;
    instances.delete(this);
    this.comp?.remove(this);
    this.ro?.disconnect();
    this.filter?.remove();
    this.el.querySelectorAll(":scope > .c-glass-layer").forEach((n) => n.remove());
    this.el.style.backdropFilter = this.el.style.webkitBackdropFilter = "";
    this.el.classList.remove("c-glass", `c-glass--${this.mode}`);
  }
}

/**
 * Make an element liquid glass. The element must be in the document (its renderer depends on
 * where it lives). Text directly inside it is wrapped in a span so it sits above the glass layers.
 * @param {HTMLElement} el
 * @param {{ panel?: boolean, canvas?: HTMLCanvasElement | null }} [opts]
 *   panel: frosted, for surfaces that hold text (popovers, menus).
 *   canvas: the chart canvas this element floats over and moves with.
 * @returns {{ update(): void, destroy(): void }} update re-measures (a ResizeObserver already calls it on
 *   size changes); destroy removes every layer, filter, observer and compositor membership.
 */
export function glass(el, { panel = false, canvas = null } = {}) {
  const g = new GlassElement(el, panel, canvas);
  return { update: () => g.update(), destroy: () => g.destroy(), mode: g.mode };
}

export const Glass = {
  /** Re-render every compositor now. Call after redrawing a canvas that glass sits over. */
  frame() { Compositor.all.forEach((c) => c.render()); },
  /** Re-read tokens and rebuild filters. Call after a theme change (also runs on its own when data-theme changes). */
  refresh() {
    clearTokens();
    instances.forEach((g) => { g.lastKey = ""; g.update(); });
    Compositor.all.forEach((c) => c.watch());
  },
};

/* ---------- "canvas" mode: one WebGL pass for every glass over a chart canvas ----------
 * The refraction is the SVG filter's, evaluated per pixel in a shader:
 *  - the displacement map's value at each point (same rounded-rect SDF, rim falloff and magnify as
 *    displacementMap(), quantised to 8 bits like the map image), turned into an offset exactly as
 *    feDisplacementMap does: scale * (C - 0.5), with red, green and blue at scale * (1 -/0/+ dispersion);
 *  - then the Gaussian blur (σ = --glass-blur, 3×3 taps), saturation, and the brightness slope.
 * It draws into one canvas laid directly above the chart canvas and below the controls, only inside each
 * glass's rounded rectangle, faded with the glass's own and its ancestors' opacity. The chart canvas is
 * uploaded once per render. Positions are measured relative to the container at every render, so the
 * container may scroll with the page. */
class Compositor {
  static all = new Set();
  static for(source) {
    for (const c of Compositor.all) if (c.source === source) return c;
    try { const c = new Compositor(source); return c.gl ? c : null; } catch { return null; }
  }
  constructor(source) {
    this.source = source;
    this.container = source.parentElement;
    this.glass = new Set();
    this.raf = 0; this.still = 0; this.lastKey = "";
    this.quad = new Float32Array(12);
    const cv = document.createElement("canvas");
    cv.className = "c-glass-compositor";
    cv.setAttribute("aria-hidden", "true");
    const gl = cv.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) return;
    const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.u = {};
    for (const n of ["uView", "uDpr", "uTex", "uTexSize", "uRect", "uRadius", "uRim", "uPow", "uMag", "uScale", "uDisp", "uBlur", "uSat", "uBright", "uAlpha"]) this.u[n] = gl.getUniformLocation(prog, n);
    this.buf = gl.createBuffer(); this.aPos = gl.getAttribLocation(prog, "aPos");
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.gl = gl; this.cv = cv;
    if (getComputedStyle(this.container).position === "static") this.container.style.position = "relative";
    source.after(cv);
    // controls move by CSS transitions and animations (fades, the press scale, a pill morphing away);
    // while anything moves, follow it every frame, then stop
    const watch = () => this.watch();
    this.offs = [
      ...["transitionrun", "transitionend", "animationstart", "animationend"].map((ev) => on(document, ev, watch, true)),
      on(window, "resize", watch),
      on(window, "scroll", watch, { passive: true, capture: true }),
    ];
    Compositor.all.add(this);
  }
  add(g) { this.glass.add(g); this.watch(); }
  remove(g) {
    this.glass.delete(g);
    if (this.glass.size) { this.watch(); return; }
    // nothing left to draw: tear down completely
    cancelAnimationFrame(this.raf);
    this.offs.forEach((off) => off());
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.cv.remove();
    Compositor.all.delete(this);
  }
  /* render every frame until nothing has moved for 20 frames */
  watch() { this.still = 0; if (!this.raf) this.raf = requestAnimationFrame(() => this.tick()); }
  tick() {
    this.raf = 0;
    const key = this.render();
    this.still = key === this.lastKey ? this.still + 1 : 0;
    this.lastKey = key;
    if (this.still < 20) this.raf = requestAnimationFrame(() => this.tick());
  }
  render() {
    const { gl, cv, source, u } = this;
    const dpr = window.devicePixelRatio || 1, cr = this.container.getBoundingClientRect();
    const W = Math.round(cr.width * dpr), H = Math.round(cr.height * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!source.width || !source.height) return "";
    const sr = source.getBoundingClientRect();
    let key = "", uploaded = false;
    for (const g of this.glass) {
      const el = g.el;
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.right <= sr.left || r.left >= sr.right || r.bottom <= sr.top || r.top >= sr.bottom) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden") continue;
      // its own opacity and its ancestors' up to the container (fades, a pill morphing into a panel)
      let a = parseFloat(cs.opacity);
      for (let n = el.parentElement; n && n !== this.container && a >= 0.003; n = n.parentElement) a *= parseFloat(getComputedStyle(n).opacity);
      if (a < 0.003) continue;
      if (!uploaded) {
        uploaded = true;
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        gl.uniform2f(u.uView, cr.width, cr.height); gl.uniform1f(u.uDpr, dpr);
        gl.uniform1i(u.uTex, 0);
        // the source's box within the container, in CSS px (the texture covers it)
        gl.uniform4f(u.uTexSize, sr.left - cr.left, sr.top - cr.top, sr.width, sr.height);
        gl.uniform1f(u.uPow, tokenNum("--glass-rim-power", 2)); gl.uniform1f(u.uMag, tokenNum("--glass-magnify", 0.1));
        gl.uniform1f(u.uScale, tokenNum("--glass-refraction", 28)); gl.uniform1f(u.uDisp, tokenNum("--glass-dispersion", 0.025));
        gl.uniform1f(u.uBlur, tokenNum("--glass-blur", 0.6)); gl.uniform1f(u.uSat, tokenNum("--glass-saturate", 1.35)); gl.uniform1f(u.uBright, tokenNum("--glass-brightness", 1.06));
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
        gl.enableVertexAttribArray(this.aPos); gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
      }
      const x = r.left - cr.left, y = r.top - cr.top;
      // radius, rim and size in the element's own (untransformed) pixels; the press scale shrinks them all
      const w0 = el.offsetWidth || r.width, h0 = el.offsetHeight || r.height, k = r.width / w0;
      const rad = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, h0 / 2, w0 / 2) * k;
      gl.uniform4f(u.uRect, x, y, r.width, r.height); gl.uniform1f(u.uRadius, rad); gl.uniform1f(u.uRim, rimFor(w0, h0) * k); gl.uniform1f(u.uAlpha, a);
      const x0 = x - 1, y0 = y - 1, x1 = x + r.width + 1, y1 = y + r.height + 1, q = this.quad;
      q[0] = x0; q[1] = y0; q[2] = x1; q[3] = y0; q[4] = x0; q[5] = y1; q[6] = x0; q[7] = y1; q[8] = x1; q[9] = y0; q[10] = x1; q[11] = y1;
      gl.bufferData(gl.ARRAY_BUFFER, q, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      key += `${x.toFixed(1)},${y.toFixed(1)},${r.width.toFixed(1)},${a.toFixed(3)};`;
    }
    return key;
  }
}

const VERT = `attribute vec2 aPos; uniform vec2 uView; varying vec2 vP;
void main() { vP = aPos; gl_Position = vec4(aPos.x / uView.x * 2.0 - 1.0, 1.0 - aPos.y / uView.y * 2.0, 0.0, 1.0); }`;
const FRAG = `precision highp float;
varying vec2 vP;
uniform sampler2D uTex; uniform vec4 uTexSize; uniform vec4 uRect;
uniform float uRadius, uRim, uPow, uMag, uScale, uDisp, uBlur, uSat, uBright, uAlpha, uDpr;
float sdr(vec2 p, vec2 hb, float r) { vec2 q = abs(p) - (hb - r); return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
// the displacement map at a point (local, from the rect's top-left), as feDisplacementMap reads it (0..1)
vec2 mapAt(vec2 l) {
  vec2 hb = uRect.zw * 0.5, p = floor(l) + 0.5 - hb;
  float inside = -sdr(p, hb, uRadius), mr = min(hb.x, hb.y);
  vec2 d = vec2(0.0);
  if (inside > 0.0) {
    d += p / mr * uMag * 0.5;
    if (inside < uRim) {
      float e = 0.5;
      vec2 n = vec2(sdr(p + vec2(e, 0.0), hb, uRadius) - sdr(p - vec2(e, 0.0), hb, uRadius), sdr(p + vec2(0.0, e), hb, uRadius) - sdr(p - vec2(0.0, e), hb, uRadius));
      float nl = max(length(n), 1e-4);
      d += n / nl * pow(1.0 - inside / uRim, uPow);
    }
  }
  return floor(clamp(128.0 - d * 127.0, 0.0, 255.0) + 0.5) / 255.0;
}
vec3 refracted(vec2 p) {
  vec2 l = p - uRect.xy, o = mapAt(l) - 0.5;
  vec2 tr = (p + o * uScale * (1.0 - uDisp) - uTexSize.xy) / uTexSize.zw;
  vec2 tg = (p + o * uScale - uTexSize.xy) / uTexSize.zw;
  vec2 tb = (p + o * uScale * (1.0 + uDisp) - uTexSize.xy) / uTexSize.zw;
  return vec3(texture2D(uTex, tr).r, texture2D(uTex, tg).g, texture2D(uTex, tb).b);
}
void main() {
  vec2 p = vP;
  float s2 = 2.0 * uBlur * uBlur, wsum = 0.0;
  vec3 c = vec3(0.0);
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    vec2 o = vec2(float(i), float(j));
    float w = exp(-dot(o, o) / s2);
    c += refracted(p + o) * w; wsum += w;
  }
  c /= wsum;
  // feColorMatrix type=saturate, then the brightness slope
  float s = uSat;
  mat3 m = mat3(0.213 + 0.787 * s, 0.213 - 0.213 * s, 0.213 - 0.213 * s,
                0.715 - 0.715 * s, 0.715 + 0.285 * s, 0.715 - 0.715 * s,
                0.072 - 0.072 * s, 0.072 - 0.072 * s, 0.072 + 0.928 * s);
  c = clamp(m * c * uBright, 0.0, 1.0);
  // only inside the glass's rounded rectangle, antialiased over a pixel
  float cov = clamp(0.5 - sdr(p - uRect.xy - uRect.zw * 0.5, uRect.zw * 0.5, uRadius) * uDpr, 0.0, 1.0) * uAlpha;
  gl_FragColor = vec4(c * cov, cov);
}`;
