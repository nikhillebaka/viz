/* Core controls for viz. Plain ES modules, no framework. Pair with controls.css + glass.
 *
 * Every control:
 *  - sizes from tokens and reads its size class (compact / regular / wide) from the nearest
 *    [data-view] container, not the window, so it behaves the same in a page, a split view or an embed;
 *  - meets the 44px touch target on touch screens;
 *  - works fully by keyboard, with visible focus;
 *  - respects reduced motion and reduced transparency;
 *  - uses liquid glass only when it floats over the chart (pass `glass: { source, container }`).
 *
 * Floating layers (menu, popover, search results, tooltip) are placed by position.js inside the
 * nearest [data-view], flip and shift to stay visible, scroll when long, and become bottom sheets
 * in the compact size class. Only one menu/popover is open at a time.
 */
import { LiquidGlass } from "./glass.js";
import { computePosition, autoUpdate, sizeClass } from "./position.js";

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const num = (n, f) => { const v = parseFloat(css(n)); return Number.isFinite(v) ? v : f; };
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const spring = (soft) => ({ easing: css(soft ? "--ease-spring-soft" : "--ease-spring") || "ease", duration: reducedMotion() ? 0 : num(soft ? "--dur-spring-soft" : "--dur-spring", 400) });
const fade = () => ({ easing: css("--ease-fade") || "ease", duration: reducedMotion() ? 0 : num("--dur-fade", 160) });
let uidN = 0;
const uid = (p) => `${p}-${++uidN}`;
export const icon = {
  chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>',
};

/* ---------------------------------------------------------------- input modality
 * Focus rings are for keyboard users. Track whether the last interaction was a pointer or a key, and
 * when we move focus ourselves (returning it after a menu closes, focusing a menu's first item), only
 * show the ring if the user is on the keyboard. */
let modality = "pointer";
document.addEventListener("pointerdown", () => (modality = "pointer"), true);
document.addEventListener("keydown", (e) => { if (!["ArrowLeft", "ArrowRight"].includes(e.key) || modality !== "pointer") modality = "keyboard"; }, true);
const focusQuietly = (el) => el?.focus({ preventScroll: true, focusVisible: modality === "keyboard" });

/* ---------------------------------------------------------------- time keys
 * While a time chart is on screen, left and right always move backward and forward in time, wherever
 * focus is. Only text fields and open menus keep their own arrows. Segmented controls then become plain
 * tab stops (Tab to an option, Space or Enter to pick it), since their arrows are taken.
 * step(dir, repeat): dir is -1 or 1; repeat is true for a held key. active(): false to stand down. */
let timeKeysOn = false;
export function timeKeys(step, { active = () => true } = {}) {
  timeKeysOn = true;
  document.querySelectorAll(".c-seg-item").forEach((b) => (b.tabIndex = 0));
  document.addEventListener("keydown", (e) => {
    if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const t = e.target;
    // open menus keep their arrows, unless a panel opts in (data-time-keys) because it only uses up/down
    if (t.closest?.("input, textarea, select, [contenteditable], .c-float:not([data-time-keys])") || !active()) return;
    e.preventDefault(); e.stopPropagation();
    // a control that was clicked keeps focus, but pressing an arrow shouldn't light up its ring
    if (modality === "pointer" && t !== document.body && typeof t.blur === "function") t.blur();
    step(e.key === "ArrowRight" ? 1 : -1, e.repeat);
  }, true);
}

/* ---------------------------------------------------------------- glass helper */
export function glassify(el, glass) {
  if (!glass) return new LiquidGlass(el, { frosted: true });
  return new LiquidGlass(el, glass);
}

/* ---------------------------------------------------------------- floating layer
 * Shared by menu, popover and search results. Handles: portal into the view, anchored placement
 * or a bottom sheet, open/close animation from the anchor, outside-click and Escape, focus return. */
let openLayer = null;
function viewOf(el) { return el.closest("[data-view]") || document.body; }

function floating(anchor, { className = "", role = "dialog", label = "", sheetTitle = "", placement = "bottom-start", width = null, morph = false, onClose = null, modal = false, sheet = true } = {}) {
  if (openLayer) openLayer.close(false);
  const view = viewOf(anchor);
  const compact = sheet && sizeClass(anchor) === "compact";
  const panel = document.createElement("div");
  panel.className = `c-float ${className}${compact ? " c-sheet" : ""}`;
  panel.setAttribute("role", role);
  if (label) panel.setAttribute("aria-label", label);
  panel.tabIndex = -1;
  panel.style.visibility = "hidden"; // revealed on the first animated frame, so it never flashes
  if (view === document.body) panel.style.position = "fixed";
  let backdrop = null, handle = null;
  if (compact) {
    backdrop = document.createElement("div");
    backdrop.className = "c-backdrop";
    view.appendChild(backdrop);
    handle = document.createElement("div");
    handle.className = "c-sheet-handle";
    handle.innerHTML = `<i></i>${sheetTitle ? `<span class="t-title-3">${sheetTitle}</span>` : ""}`;
    panel.appendChild(handle);
  }
  const body = document.createElement("div");
  body.className = "c-float-body";
  panel.appendChild(body);
  view.appendChild(panel);
  if (!compact && width) panel.style.width = `${width}px`;
  const g = new LiquidGlass(panel, { frosted: true });

  // placement
  let stop = () => {};
  const place = () => {
    const vr = view === document.body ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight } : view.getBoundingClientRect();
    const boundary = { left: Math.max(0, vr.left), top: Math.max(0, vr.top), right: Math.min(innerWidth, vr.right), bottom: Math.min(innerHeight, vr.bottom) };
    boundary.width = boundary.right - boundary.left; boundary.height = boundary.bottom - boundary.top;
    if (compact) {
      panel.style.maxHeight = `${vr.height * num("--layout-sheet-max-height", 0.85)}px`;
      return;
    }
    const ar = anchor.getBoundingClientRect();
    panel.style.maxHeight = "";
    const fr = { width: panel.offsetWidth, height: panel.offsetHeight };
    const p = computePosition(ar, fr, { placement, boundary, padding: num("--layout-inset-regular", 16) });
    panel.style.maxHeight = `${Math.floor(p.maxHeight)}px`;
    panel.style.left = `${p.x - vr.left}px`; panel.style.top = `${p.y - vr.top}px`;
    panel.style.transformOrigin = p.origin;
    g.update();
  };
  stop = compact ? (place(), () => {}) : autoUpdate(anchor, panel, place);

  // open animation
  const opener = document.activeElement;
  const anim = () => {
    if (compact) {
      backdrop.animate([{ opacity: 0 }, { opacity: 1 }], fade());
      return panel.animate([{ transform: "translateY(100%)" }, { transform: "none" }], spring(true));
    }
    if (morph) {
      const a = anchor.getBoundingClientRect(), p = panel.getBoundingClientRect();
      anchor.classList.add("c-morphing");
      const from = { transform: `translate(${a.left - p.left}px, ${a.top - p.top}px) scale(${a.width / p.width}, ${a.height / p.height})`, borderRadius: `${a.height / 2}px`, opacity: 0.5 };
      // the morph uses the soft spring: no overshoot, which on a large panel reads as a bounce
      body.animate([{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }], spring(true));
      return panel.animate([{ ...from, transformOrigin: "0 0" }, { transform: "none", borderRadius: getComputedStyle(panel).borderRadius, opacity: 1, transformOrigin: "0 0" }], spring(true));
    }
    return panel.animate([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }], spring());
  };

  // dismissal
  const onDown = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target)) layer.close(true); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); layer.close(true); }
    if (modal && e.key === "Tab") trapFocus(e, panel);
  };
  setTimeout(() => document.addEventListener("pointerdown", onDown, true));
  panel.addEventListener("keydown", onKey);
  anchor.setAttribute("aria-expanded", "true");

  // sheet drag-to-dismiss (handle or anywhere when scrolled to top)
  if (compact) {
    let start = null, dy = 0;
    const down = (e) => { if (e.target.closest("button, input, a, [role=option], [role^=menuitem]") && !e.target.closest(".c-sheet-handle")) return; start = e.clientY; dy = 0; panel.setPointerCapture(e.pointerId); panel.style.transition = "none"; };
    const move = (e) => { if (start == null) return; dy = Math.max(0, e.clientY - start); panel.style.transform = `translateY(${dy}px)`; backdrop.style.opacity = String(1 - dy / panel.offsetHeight); };
    const up = () => {
      if (start == null) return; start = null;
      if (dy > panel.offsetHeight * 0.3) layer.close(true);
      else { panel.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], spring()); panel.style.transform = ""; backdrop.style.opacity = ""; }
    };
    panel.addEventListener("pointerdown", down); panel.addEventListener("pointermove", move); panel.addEventListener("pointerup", up); panel.addEventListener("pointercancel", up);
    backdrop.addEventListener("click", () => layer.close(true));
  }

  let closed = false;
  const layer = {
    panel, body, compact, anchor, view, place,
    open() { requestAnimationFrame(() => { place(); panel.style.visibility = ""; anim(); }); return layer; },
    close(restoreFocus = true) {
      if (closed) return; closed = true;
      if (openLayer === layer) openLayer = null;
      document.removeEventListener("pointerdown", onDown, true);
      anchor.setAttribute("aria-expanded", "false");
      stop();
      const done = () => { g.destroy(); panel.remove(); backdrop?.remove(); anchor.classList.remove("c-morphing"); };
      let a;
      if (compact) { backdrop.animate([{ opacity: 1 }, { opacity: 0 }], fade()); a = panel.animate([{ transform: getComputedStyle(panel).transform }, { transform: "translateY(100%)" }], { ...fade(), duration: reducedMotion() ? 0 : 220 }); }
      else if (morph) {
        const ar = anchor.getBoundingClientRect(), p = panel.getBoundingClientRect();
        anchor.classList.remove("c-morphing");
        body.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reducedMotion() ? 0 : 90, fill: "forwards" });
        a = panel.animate([{ transform: "none", opacity: 1, transformOrigin: "0 0" }, { transform: `translate(${ar.left - p.left}px, ${ar.top - p.top}px) scale(${ar.width / p.width}, ${ar.height / p.height})`, borderRadius: `${ar.height / 2}px`, opacity: 0, transformOrigin: "0 0" }], { ...spring(true), duration: reducedMotion() ? 0 : 260 });
      } else a = panel.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.97)" }], fade());
      // remove when the exit animation ends, with a fallback in case the browser pauses animations
      let finished = false; const fin = () => { if (!finished) { finished = true; done(); } };
      a.onfinish = fin; setTimeout(fin, 400); if (!a.effect || reducedMotion()) fin();
      // return focus to the control that opened the layer (Safari never focuses clicked buttons, so don't rely on the opener)
      const back = anchor.matches("button, [tabindex], input, a[href]") ? anchor : opener;
      if (restoreFocus && back && document.contains(back) && !anchor.closest(".c-search")) focusQuietly(back);
      onClose?.();
    },
  };
  openLayer = layer;
  return layer;
}
function trapFocus(e, root) {
  const f = [...root.querySelectorAll("button, [href], input, [tabindex]:not([tabindex='-1'])")].filter((n) => !n.disabled && n.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* ---------------------------------------------------------------- menu
 * items: [{ label, value, icon, shortcut, checked, disabled, danger, onSelect } | "-" | { header }]
 * role "menu" with menuitem / menuitemradio. Arrow keys, Home/End, type-ahead, Enter/Space, Escape. */
export function openMenu(anchor, { items, placement = "bottom-start", label = "", title = "", onClose } = {}) {
  const layer = floating(anchor, { className: "c-menu", role: "menu", label: label || title, sheetTitle: title, placement, onClose });
  const radio = items.some((i) => i && i.checked !== undefined);
  for (const it of items) {
    if (it === "-") { const s = document.createElement("div"); s.className = "c-menu-sep"; s.setAttribute("role", "separator"); layer.body.appendChild(s); continue; }
    if (it.header) { const h = document.createElement("div"); h.className = "c-menu-header t-label-section"; h.textContent = it.header; layer.body.appendChild(h); continue; }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "c-menu-item t-label-control" + (it.danger ? " danger" : "");
    b.setAttribute("role", radio ? "menuitemradio" : "menuitem");
    if (radio) b.setAttribute("aria-checked", it.checked ? "true" : "false");
    b.tabIndex = -1;
    if (it.disabled) b.setAttribute("aria-disabled", "true");
    b.innerHTML = `${radio ? `<span class="ck">${it.checked ? icon.check : ""}</span>` : ""}${it.icon ? `<span class="ic">${it.icon}</span>` : ""}<span class="lb"></span>${it.shortcut ? `<kbd>${it.shortcut}</kbd>` : ""}`;
    b.querySelector(".lb").textContent = it.label;
    b.addEventListener("click", () => { if (it.disabled) return; layer.close(true); it.onSelect?.(it.value ?? it.label); });
    layer.body.appendChild(b);
  }
  const all = () => [...layer.body.querySelectorAll(".c-menu-item:not([aria-disabled=true])")];
  let typed = "", typedT = 0;
  layer.panel.addEventListener("keydown", (e) => {
    const list = all(), i = list.indexOf(document.activeElement);
    const go = (n) => { const t = list[(n + list.length) % list.length]; t?.focus(); t?.scrollIntoView({ block: "nearest" }); };
    if (e.key === "ArrowDown") { e.preventDefault(); go(i + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(i < 0 ? list.length - 1 : i - 1); }
    else if (e.key === "Home") { e.preventDefault(); go(0); }
    else if (e.key === "End") { e.preventDefault(); go(list.length - 1); }
    else if (e.key === "Tab") { layer.close(false); }
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey) {
      clearTimeout(typedT); typed += e.key.toLowerCase(); typedT = setTimeout(() => (typed = ""), 600);
      const m = list.find((b) => b.textContent.trim().toLowerCase().startsWith(typed)); m?.focus();
    }
  });
  layer.open();
  requestAnimationFrame(() => { const c = layer.body.querySelector("[aria-checked=true]") || all()[0]; focusQuietly(c); c?.scrollIntoView({ block: "nearest" }); });
  return layer;
}

/* ---------------------------------------------------------------- popover
 * content: an element or (body) => void. morph: the anchor pill grows into the panel (study 2). */
export function openPopover(anchor, { title = "", content, placement = "bottom-start", width = null, morph = true, onClose, className = "", timeKeys = false } = {}) {
  const w = width || num("--layout-popover-width", 360);
  const layer = floating(anchor, { className: `c-popover ${className}`.trim(), role: "dialog", label: title, sheetTitle: title, placement, width: w, morph, onClose, modal: true });
  if (title && !layer.compact) {
    const h = document.createElement("div"); h.className = "c-popover-head";
    h.innerHTML = `<span class="t-title-3"></span><button type="button" class="c-icon-btn" aria-label="Close">${icon.close}</button>`;
    h.querySelector("span").textContent = title;
    h.querySelector("button").addEventListener("click", () => layer.close(true));
    layer.body.appendChild(h);
  }
  if (timeKeys) layer.panel.dataset.timeKeys = "";
  const inner = document.createElement("div"); inner.className = "c-popover-content"; layer.body.appendChild(inner);
  if (typeof content === "function") content(inner, layer); else if (content) inner.appendChild(content);
  layer.open();
  requestAnimationFrame(() => focusQuietly(layer.panel.querySelector("input, button:not(.c-icon-btn), [tabindex='0']") || layer.panel));
  return layer;
}

/* ---------------------------------------------------------------- tooltip
 * Mouse hover after a short delay (skipped when moving between controls), keyboard focus at once.
 * Never on touch: anything that needs a tooltip there needs a visible label instead. */
let tipEl = null, tipTimer = 0, tipShownAt = 0, tipFor = null, tipStop = () => {};
export function tooltip(el, text, { placement = "top" } = {}) {
  const id = uid("tip");
  el.setAttribute("aria-describedby", id);
  const show = () => {
    clearTimeout(tipTimer);
    if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "c-tooltip t-small"; tipEl.setAttribute("role", "tooltip"); }
    tipEl.id = id; tipEl.textContent = text;
    const view = viewOf(el); view.appendChild(tipEl); tipFor = el;
    tipStop(); tipStop = autoUpdate(el, tipEl, () => {
      const vr = view === document.body ? { left: 0, top: 0 } : view.getBoundingClientRect();
      const p = computePosition(el.getBoundingClientRect(), { width: tipEl.offsetWidth, height: tipEl.offsetHeight }, { placement, offset: 8, padding: 8 });
      tipEl.style.left = `${p.x - vr.left}px`; tipEl.style.top = `${p.y - vr.top}px`;
    });
    tipEl.classList.add("show"); tipShownAt = performance.now();
  };
  const hide = () => { clearTimeout(tipTimer); if (tipFor === el && tipEl) { tipEl.classList.remove("show"); tipStop(); tipFor = null; tipShownAt = performance.now(); } };
  el.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse") return;
    const skip = performance.now() - tipShownAt < num("--time-tooltip-skip", 300);
    tipTimer = setTimeout(show, skip ? 0 : num("--time-tooltip-delay", 500));
  });
  el.addEventListener("pointerleave", hide);
  el.addEventListener("pointerdown", hide);
  el.addEventListener("focus", () => { if (el.matches(":focus-visible")) show(); });
  el.addEventListener("blur", hide);
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
}

/* ---------------------------------------------------------------- segmented control
 * items: [{ value, label, short? }]. A radiogroup: Tab enters at the selected item, arrow keys move
 * the selection. When it no longer fits its zone it collapses into a pill + menu automatically. */
export class Segmented {
  constructor(el, { items, value, onChange, label = "", glass = null, size = "" }) {
    Object.assign(this, { el, items, value: value ?? items[0].value, onChange });
    el.classList.add("c-seg"); if (size) el.classList.add(size);
    el.innerHTML = `<div class="c-seg-items" role="radiogroup"><span class="c-seg-thumb" aria-hidden="true"></span></div>
      <button type="button" class="c-seg-compact" aria-haspopup="menu" aria-expanded="false"><span class="lb"></span>${icon.chevronDown}</button>`;
    this.group = el.querySelector(".c-seg-items");
    if (label) { this.group.setAttribute("aria-label", label); el.querySelector(".c-seg-compact").setAttribute("aria-label", label); }
    this.thumb = el.querySelector(".c-seg-thumb");
    this.btns = items.map((it) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "c-seg-item"; b.setAttribute("role", "radio"); b.dataset.value = it.value;
      b.textContent = it.label;
      b.addEventListener("click", () => this.set(it.value, true));
      this.group.appendChild(b);
      return b;
    });
    this.group.addEventListener("keydown", (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!d && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      const i = this.items.findIndex((x) => x.value === this.value);
      const n = e.key === "Home" ? 0 : e.key === "End" ? this.items.length - 1 : (i + d + this.items.length) % this.items.length;
      this.set(this.items[n].value, true); this.btns[n].focus();
    });
    this.compactBtn = el.querySelector(".c-seg-compact");
    this.compactBtn.addEventListener("click", () => openMenu(this.compactBtn, {
      title: label, label, items: this.items.map((it) => ({ label: it.label, value: it.value, checked: it.value === this.value, onSelect: (v) => this.set(v, true) })),
    }));
    this.glass = glassify(el, glass);
    this.set(this.value, false, true);
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(el.parentElement || el);
    document.fonts?.ready.then(() => { this.natural = 0; this.fit(); });
  }
  set(v, fire, instant) {
    this.value = v;
    this.btns.forEach((b) => { const on = b.dataset.value === String(v); b.setAttribute("aria-checked", on); b.tabIndex = on || timeKeysOn ? 0 : -1; });
    this.compactBtn.querySelector(".lb").textContent = this.items.find((x) => x.value === v)?.label ?? "";
    this.moveThumb(instant);
    if (fire) this.onChange?.(v);
  }
  moveThumb(instant) {
    const b = this.btns.find((x) => x.dataset.value === String(this.value));
    if (!b) return;
    this.thumb.style.transition = instant || reducedMotion() ? "none" : "";
    this.thumb.style.width = `${b.offsetWidth}px`;
    this.thumb.style.transform = `translateX(${b.offsetLeft}px)`;
  }
  // collapse into pill + menu when the full control doesn't fit the room its zone gives it
  fit() {
    const zone = this.el.parentElement;
    const others = [...zone.children].filter((c) => c !== this.el).reduce((s, c) => s + c.offsetWidth, 0);
    const gap = parseFloat(getComputedStyle(zone).columnGap) || 0;
    const room = zone.clientWidth - others - gap * (zone.children.length - 1);
    if (!this.natural) {
      // measure the full control even if it's currently collapsed
      const was = this.el.classList.contains("collapsed");
      this.el.classList.remove("collapsed");
      this.natural = this.group.scrollWidth + 6;
      if (was) this.el.classList.add("collapsed");
    }
    const natural = this.natural;
    const collapse = natural > room;
    if (collapse !== this.el.classList.contains("collapsed")) { this.el.classList.toggle("collapsed", collapse); this.glass.update(); }
    if (!collapse) this.moveThumb(true);
  }
}

/* ---------------------------------------------------------------- rolling text
 * Changes a label's text so you see the direction and size of the change, not just a swap (from study
 * 07, "rolling figures"). Each digit is a 0–9 strip that rolls to its new value; a changed word (a month)
 * slides out and the new one slides in, up when moving forward (dir > 0) and down when moving back. Fast
 * repeated changes retarget smoothly. If the shape of the text changes (e.g. "Dec 6" → "Dec 13"), the
 * whole label slides instead. No overshoot. Instant with reduced motion. */
const ROLL_MS = 300;
export function rollText(el, text, dir = 1, animate = true) {
  const parts = (t) => t.match(/\d|[^\d]+/g) || [];
  const shape = (t) => parts(t).map((p) => (/\d/.test(p) ? "d" : "w")).join("");
  const prev = el.__roll;
  animate = animate && prev != null && !reducedMotion();
  if (!prev || shape(prev) !== shape(text)) {
    const build = (t) => parts(t).map((p) => /\d/.test(p)
      ? `<span class="d"><span style="transform:translateY(${-p * 1.3}em)">${"0123456789".split("").map((n) => `<i>${n}</i>`).join("")}</span></span>`
      : `<span class="w"><span>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span></span>`).join("");
    if (animate) { slide(el, build(text), dir); }
    else el.innerHTML = `<span class="c-roll">${build(text)}</span>`;
    el.__roll = text; return;
  }
  const roll = el.querySelector(".c-roll"), ps = parts(text);
  [...roll.children].forEach((c, i) => {
    const p = ps[i];
    if (c.classList.contains("d")) {
      const strip = c.firstElementChild;
      strip.style.transition = animate ? `transform ${ROLL_MS}ms var(--ease-spring-soft)` : "none";
      strip.style.transitionDelay = animate ? `${(ps.length - i) * 14}ms` : "0ms"; // ones digit leads
      strip.style.transform = `translateY(${-p * 1.3}em)`;
    } else if (c.textContent !== p) {
      if (animate) slideWord(c, p, dir); else c.innerHTML = `<span>${p}</span>`;
    }
  });
  el.__roll = text;
}
function slideWord(box, text, dir) {
  box.querySelectorAll(".out").forEach((n) => n.remove());           // a fast repeat: drop the one still leaving
  const old = box.firstElementChild, neu = document.createElement("span");
  neu.textContent = text;
  old.classList.add("out"); old.style.position = "absolute"; old.style.left = "0"; old.style.top = "0";
  box.appendChild(neu);
  const o = { duration: ROLL_MS, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "both" };
  old.animate([{ transform: "translateY(0)", opacity: 1 }, { transform: `translateY(${-dir * 100}%)`, opacity: 0 }], o).onfinish = () => old.remove();
  neu.animate([{ transform: `translateY(${dir * 100}%)`, opacity: 0 }, { transform: "translateY(0)", opacity: 1 }], o);
}
function slide(el, html, dir) {
  el.querySelectorAll(".c-roll.out").forEach((n) => n.remove());
  const old = el.querySelector(".c-roll"), neu = document.createElement("span");
  neu.className = "c-roll"; neu.innerHTML = html;
  if (old) { old.classList.add("out"); old.style.position = "absolute"; old.style.left = "50%"; old.style.translate = "-50% 0"; }
  el.appendChild(neu);
  const o = { duration: ROLL_MS, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "both" };
  old?.animate([{ transform: "translateY(0)", opacity: 1 }, { transform: `translateY(${-dir * 100}%)`, opacity: 0 }], o).finished.then(() => old.remove(), () => {});
  neu.animate([{ transform: `translateY(${dir * 100}%)`, opacity: 0 }, { transform: "translateY(0)", opacity: 1 }], o);
}

/* ---------------------------------------------------------------- date stepper
 * values: Date[] in order. format: { long: fn, short: fn }. Previous/next step one value; holding
 * repeats and accelerates; the label opens a menu of every value. The label keeps a fixed width
 * (the widest value) so the arrows never jump as the date changes. */
export class Stepper {
  constructor(el, { values, index = 0, format, onChange, label = "Date", glass = null }) {
    Object.assign(this, { el, values, index, format, onChange, label });
    el.classList.add("c-stepper");
    el.setAttribute("role", "group"); el.setAttribute("aria-label", label);
    el.innerHTML = `<button type="button" class="c-step prev" aria-label="Previous">${icon.left}</button>
      <button type="button" class="c-step-label" aria-haspopup="menu" aria-expanded="false"><span class="long"></span><span class="short"></span></button>
      <button type="button" class="c-step next" aria-label="Next">${icon.right}</button>
      <span class="c-sr" aria-live="polite"></span>`;
    this.prev = el.querySelector(".prev"); this.next = el.querySelector(".next");
    this.lab = el.querySelector(".c-step-label"); this.live = el.querySelector(".c-sr");
    this.hold(this.prev, -1); this.hold(this.next, 1);
    el.addEventListener("keydown", (e) => {
      if (e.target.closest(".c-float")) return;
      const k = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (k) { e.preventDefault(); this.step(k); }
      if (e.key === "Home") { e.preventDefault(); this.go(0); }
      if (e.key === "End") { e.preventDefault(); this.go(this.values.length - 1); }
    });
    this.lab.addEventListener("click", () => openMenu(this.lab, {
      title: label, label, placement: "top",
      items: this.values.map((v, i) => ({ label: format.long(v), value: i, checked: i === this.index, onSelect: (i) => this.go(i) })).reverse(),
    }));
    this.glass = glassify(el, glass);
    this.fixWidth(); document.fonts?.ready.then(() => this.fixWidth());
    this.render(true);
  }
  fixWidth() {
    // widest formatted value, measured in the label's font, so the control never changes width
    const ctx = (Stepper.c ||= document.createElement("canvas").getContext("2d"));
    const cs = getComputedStyle(this.lab);
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const w = (f) => Math.ceil(Math.max(...this.values.map((v) => ctx.measureText(f(v)).width)));
    this.el.style.setProperty("--long-w", `${w(this.format.long) + 2}px`);
    this.el.style.setProperty("--short-w", `${w(this.format.short) + 2}px`);
  }
  hold(btn, d) {
    let t = 0, iv = 0, delay;
    const stop = () => { clearTimeout(t); clearTimeout(iv); };
    const rep = () => { this.step(d); delay = Math.max(40, delay * 0.86); iv = setTimeout(rep, delay); };
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.step(d); delay = num("--time-repeat", 90);
      t = setTimeout(rep, num("--time-long-press", 400));
    });
    btn.addEventListener("click", (e) => { if (e.detail === 0) this.step(d); }); // keyboard Enter/Space
    ["pointerup", "pointerleave", "pointercancel", "blur"].forEach((ev) => btn.addEventListener(ev, stop));
  }
  step(d) { this.go(this.index + d); }
  go(i) {
    const n = Math.max(0, Math.min(this.values.length - 1, i));
    if (n === this.index) { this.el.animate([{ transform: "translateX(0)" }, { transform: `translateX(${i < 0 ? -3 : 3}px)` }, { transform: "translateX(0)" }], { duration: reducedMotion() ? 0 : 180 }); return; }
    const dir = Math.sign(n - this.index); this.index = n; this.render(false, dir); this.onChange?.(n, this.values[n]);
  }
  /* show a value without firing onChange (e.g. a chart scrubbing the date): the label rolls to it */
  show(i) {
    i = Math.max(0, Math.min(this.values.length - 1, i));
    if (i === this.index) return;
    const dir = Math.sign(i - this.index); this.index = i; this.render(false, dir, false);
  }
  render(initial, dir = 1, announce = true) {
    const v = this.values[this.index];
    rollText(this.el.querySelector(".long"), this.format.long(v), dir, !initial);
    rollText(this.el.querySelector(".short"), this.format.short(v), dir, !initial);
    this.lab.setAttribute("aria-label", `${this.label}: ${this.format.long(v)}. Open list`);
    this.prev.setAttribute("aria-disabled", this.index === 0); this.next.setAttribute("aria-disabled", this.index === this.values.length - 1);
    if (!initial && announce) this.live.textContent = this.format.long(v);
  }
}

/* ---------------------------------------------------------------- search
 * A combobox. source(query) -> [{ label, sub?, value, group? }]. "/" or ⌘K focuses it from anywhere.
 * In the compact size class it shows as an icon and expands across the top when opened. */
export class Search {
  constructor(el, { placeholder = "Search", source, onSelect, shortcut = true, glass = null, label = "Search" }) {
    Object.assign(this, { el, source, onSelect });
    const lid = uid("lb");
    el.classList.add("c-search");
    el.innerHTML = `<button type="button" class="c-search-icon" aria-label="${label}">${icon.search}</button>
      <input type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${lid}" autocomplete="off" spellcheck="false">
      <kbd class="c-search-kbd" aria-hidden="true">/</kbd>
      <button type="button" class="c-search-clear" aria-label="Clear">${icon.close}</button>`;
    this.input = el.querySelector("input"); this.input.placeholder = placeholder; this.input.setAttribute("aria-label", label);
    this.lid = lid; this.active = -1; this.results = [];
    this.glass = glassify(el, glass);
    el.querySelector(".c-search-icon").addEventListener("click", () => this.focus());
    el.querySelector(".c-search-clear").addEventListener("click", () => { this.input.value = ""; this.update(); this.input.focus(); });
    this.input.addEventListener("focus", () => { el.classList.add("focused"); this.update(); });
    this.input.addEventListener("input", () => this.update());
    this.input.addEventListener("blur", () => setTimeout(() => { if (!el.contains(document.activeElement)) this.collapse(); }, 120));
    this.input.addEventListener("keydown", (e) => this.key(e));
    if (shortcut) addEventListener("keydown", (e) => {
      const typing = /input|textarea/i.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if ((e.key === "/" && !typing) || (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); this.focus(); }
    });
  }
  focus() { this.el.classList.add("expanded"); this.glass.update(); this.input.focus(); }
  collapse() { this.close(); this.el.classList.remove("expanded", "focused"); this.glass.update(); }
  update() {
    const q = this.input.value.trim();
    this.el.classList.toggle("has-value", !!q);
    this.results = this.source(q).slice(0, 50);
    this.active = this.results.length ? 0 : -1;
    if (!this.layer) {
      this.layer = floating(this.el, { className: "c-results", role: "presentation", placement: "bottom-start", sheet: false, width: Math.max(this.el.offsetWidth, 300), onClose: () => { this.layer = null; this.input.setAttribute("aria-expanded", "false"); } });
      this.layer.panel.removeAttribute("tabindex");
      this.list = document.createElement("div"); this.list.id = this.lid; this.list.setAttribute("role", "listbox");
      this.layer.body.appendChild(this.list);
      this.layer.open();
      this.input.setAttribute("aria-expanded", "true");
    }
    this.renderList(q);
  }
  renderList(q) {
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const mark = (s) => { if (!q) return esc(s); const i = s.toLowerCase().indexOf(q.toLowerCase()); return i < 0 ? esc(s) : esc(s.slice(0, i)) + "<mark>" + esc(s.slice(i, i + q.length)) + "</mark>" + esc(s.slice(i + q.length)); };
    let html = "", lastGroup = null;
    this.results.forEach((r, i) => {
      if (r.group && r.group !== lastGroup) { html += `<div class="c-menu-header t-label-section" role="presentation">${esc(r.group)}</div>`; lastGroup = r.group; }
      html += `<div class="c-option t-label-control" role="option" id="${this.lid}-${i}" data-i="${i}" aria-selected="${i === this.active}">${r.swatch ? `<i style="background:${r.swatch}"></i>` : ""}<span class="lb">${mark(r.label)}</span>${r.sub ? `<span class="sub t-numeric-axis">${esc(r.sub)}</span>` : ""}</div>`;
    });
    if (!this.results.length) html = `<div class="c-empty t-small">No matches for “${esc(q)}”</div>`;
    this.list.innerHTML = html;
    this.input.setAttribute("aria-activedescendant", this.active >= 0 ? `${this.lid}-${this.active}` : "");
    this.list.querySelectorAll(".c-option").forEach((o) => {
      o.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus in the input
      o.addEventListener("click", () => this.choose(+o.dataset.i));
    });
    this.layer.place();
  }
  key(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); if (!this.results.length) return;
      this.active = (this.active + (e.key === "ArrowDown" ? 1 : -1) + this.results.length) % this.results.length;
      this.list.querySelectorAll(".c-option").forEach((o) => o.setAttribute("aria-selected", +o.dataset.i === this.active));
      this.input.setAttribute("aria-activedescendant", `${this.lid}-${this.active}`);
      this.list.querySelector(`[data-i="${this.active}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") { if (this.active >= 0) { e.preventDefault(); this.choose(this.active); } }
    else if (e.key === "Escape") { e.preventDefault(); if (this.input.value) { this.input.value = ""; this.update(); } else { this.collapse(); this.input.blur(); } }
  }
  choose(i) { const r = this.results[i]; if (!r) return; this.input.value = ""; this.collapse(); this.input.blur(); this.onSelect?.(r); }
  close() { this.layer?.close(false); this.layer = null; }
}

/* ---------------------------------------------------------------- status island
 * One place for background work. set({ state: "idle"|"busy"|"done"|"error", title, detail, progress }).
 * Changes size with a spring; announces changes politely to screen readers; "done" settles back to idle. */
export class StatusIsland {
  constructor(el, { idle = { title: "Up to date" }, glass = null } = {}) {
    Object.assign(this, { el, idleState: idle });
    el.classList.add("c-island");
    el.setAttribute("role", "status");
    el.innerHTML = `<div class="c-island-in"></div>`;
    this.inner = el.firstChild;
    this.glass = glassify(el, glass);
    this.set({ state: "idle", ...idle }, true);
  }
  set(s, instant) {
    clearTimeout(this.t);
    const w0 = this.el.offsetWidth, h0 = this.el.offsetHeight;
    const esc = (x) => String(x ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
    const lead = s.state === "busy" ? `<svg class="ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="trk" cx="10" cy="10" r="8"/><circle class="val" cx="10" cy="10" r="8" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${1 - (s.progress ?? 0)}"/></svg>`
      : s.state === "done" ? `<span class="c-island-ic good">${icon.check}</span>` : s.state === "error" ? `<span class="c-island-ic bad">${icon.alert}</span>` : `<i class="dot"></i>`;
    this.inner.className = `c-island-in ${s.state}`;
    this.inner.innerHTML = `${lead}<span class="tx"><span class="t1 t-label-control">${esc(s.title)}</span>${s.detail ? `<span class="t2 t-small">${esc(s.detail)}</span>` : ""}</span>`;
    const w1 = this.el.offsetWidth, h1 = this.el.offsetHeight;
    if (!instant && (w0 !== w1 || h0 !== h1)) {
      this.el.animate([{ width: `${w0}px`, height: `${h0}px` }, { width: `${w1}px`, height: `${h1}px` }], spring());
      this.inner.animate([{ opacity: 0 }, { opacity: 1 }], fade());
    }
    this.glass.update();
    if (s.state === "done") this.t = setTimeout(() => this.set({ state: "idle", ...this.idleState }), 2400);
  }
}

/* ---------------------------------------------------------------- toast
 * Brief confirmations, bottom-centre above the bottom controls. Pauses while hovered or focused,
 * swipe down to dismiss, at most three at once, announced politely. */
export function toast(viewEl, { message, action = null, duration, glass = null } = {}) {
  let host = viewEl.querySelector(":scope > .c-toasts");
  if (!host) { host = document.createElement("div"); host.className = "c-toasts"; host.setAttribute("aria-live", "polite"); viewEl.appendChild(host); }
  while (host.children.length >= 3) host.firstChild.remove();
  const t = document.createElement("div");
  t.className = "c-toast t-label-control";
  t.innerHTML = `<span class="c-toast-ic">${icon.check}</span><span class="lb"></span>`;
  t.querySelector(".lb").textContent = message;
  if (action) { const b = document.createElement("button"); b.type = "button"; b.className = "c-toast-act"; b.textContent = action.label; b.addEventListener("click", () => { action.onClick?.(); dismiss(); }); t.appendChild(b); }
  host.appendChild(t);
  const g = glassify(t, glass);
  t.animate([{ opacity: 0, transform: "translateY(12px) scale(0.98)" }, { opacity: 1, transform: "none" }], spring());
  const life = duration ?? num("--time-toast", 3200);
  let left = life, started = performance.now(), timer = setTimeout(dismiss, life);
  const pause = () => { clearTimeout(timer); left -= performance.now() - started; };
  const resume = () => { started = performance.now(); timer = setTimeout(dismiss, Math.max(800, left)); };
  t.addEventListener("pointerenter", pause); t.addEventListener("pointerleave", resume);
  t.addEventListener("focusin", pause); t.addEventListener("focusout", resume);
  let sy = null;
  t.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") { sy = e.clientY; t.setPointerCapture(e.pointerId); } });
  t.addEventListener("pointermove", (e) => { if (sy != null) t.style.transform = `translateY(${Math.max(0, e.clientY - sy)}px)`; });
  t.addEventListener("pointerup", (e) => { if (sy != null && e.clientY - sy > 30) dismiss(); else t.style.transform = ""; sy = null; });
  let gone = false;
  function dismiss() {
    if (gone) return; gone = true; clearTimeout(timer);
    const a = t.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(8px)" }], { ...fade(), duration: reducedMotion() ? 0 : 200 });
    let fin = false; const end = () => { if (fin) return; fin = true; g.destroy(); t.remove(); };
    a.onfinish = end; setTimeout(end, 400);
  }
  return { dismiss };
}
