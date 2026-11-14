/* The control kit: icons, pills, the date Stepper with its rolling label, Segmented, toast, and
 * the global ← → time keys. Desktop only. Looks live in styles/controls.css; glass is applied by
 * the caller (glass(el, …)) because only the caller knows where a control lives. Components append
 * their content, so glass may be applied before or after them. */
import { h, on, token, tokenNum, reducedMotion } from "../lib/dom.js";
import { openMenu, inputModality } from "./floating.js";
import { glass } from "./glass.js";

/* 24-unit icons, stroked in currentColor at one weight, round caps. Rendered at --size-icon by .c-icon. */
const svg = (body, extra = "") => `<svg class="c-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"${extra} aria-hidden="true">${body}</svg>`;
export const icon = {
  chevronDown: svg('<path d="M6 9l6 6 6-6"/>'),
  left: svg('<path d="M15 18l-6-6 6-6"/>'),
  right: svg('<path d="M9 18l6-6-6-6"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  close: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
  alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>'),
  theme: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none"/>'),
  more: svg('<circle cx="5.5" cy="12" r="1.75"/><circle cx="12" cy="12" r="1.75"/><circle cx="18.5" cy="12" r="1.75"/>', ' style="fill:currentColor;stroke:none"'),
};

/**
 * A pill button (class .c-pill), the shape of every floating control.
 * @param {{ label?: string, icon?: string, dots?: string[], chevron?: boolean, size?: "sm",
 *           pressed?: boolean, ariaLabel?: string, className?: string, onClick?: (e: Event) => void }} o
 *   icon: an `icon.*` string; with no label the pill is round (.icon). dots: CSS colors.
 *   pressed: sets aria-pressed (a toggle). chevron: a trailing ▾ (it opens something).
 * @returns {HTMLButtonElement}
 */
export function pill({ label = "", icon: ic = "", dots = null, chevron = false, size = "", pressed, ariaLabel, className = "", onClick } = {}) {
  return h("button", {
    type: "button",
    class: ["c-pill", size, ic && !label && !dots && "icon", className],
    "aria-pressed": pressed == null ? null : String(!!pressed),
    "aria-label": ariaLabel || null,
    onclick: onClick || null,
    html: ic || null,
  },
  dots ? h("span", { class: "c-dots" }, dots.map((c) => h("i", { style: { background: c } }))) : null,
  label ? h("span", { class: "c-pill-label" }, label) : null,
  chevron ? h("span", { class: "c-chev", html: icon.chevronDown }) : null);
}

/* ---------------------------------------------------------------- time keys
 * While a time chart is on screen, ← → move backward and forward in time wherever focus is. Text fields
 * and layers keep their own arrows, unless a layer opts in with data-time-keys (it only uses ↑ ↓).
 * Segmented options then become plain tab stops (Tab to one, Space to pick it), since their arrows are taken. */
let timeKeysOn = false;
/**
 * @param {(dir: -1 | 1, repeat: boolean) => void} step
 * @param {{ active?: () => boolean }} [opts] active() false stands the keys down
 * @returns {() => void} removes the keys
 */
export function timeKeys(step, { active = () => true } = {}) {
  timeKeysOn = true;
  document.querySelectorAll(".c-seg-item").forEach((b) => (b.tabIndex = 0));
  const off = on(document, "keydown", (e) => {
    if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const t = e.target;
    if (t.closest?.("input, textarea, select, [contenteditable], .c-float:not([data-time-keys])") || !active()) return;
    e.preventDefault(); e.stopPropagation();
    // a control that was clicked keeps focus, but an arrow shouldn't light up its ring
    if (inputModality() === "pointer" && t !== document.body && typeof t.blur === "function") t.blur();
    step(e.key === "ArrowRight" ? 1 : -1, e.repeat);
  }, true);
  return () => { off(); timeKeysOn = false; };
}

/* ---------------------------------------------------------------- rolling text
 * Changes a label's text so the direction and size of the change show, not just a swap. Each digit is a
 * 0–9 strip that rolls to its new value (the ones digit leads); a changed word slides out and the new one
 * in, up when moving forward (dir > 0), down when moving back. Fast repeats retarget smoothly. If the
 * shape of the text changes ("Dec 6" → "Dec 13") the whole label slides. --dur-move, --ease-spring, no
 * overshoot; instant with reduced motion. */
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const parts = (t) => t.match(/\d|[^\d]+/g) || [];
const shape = (t) => parts(t).map((p) => (/\d/.test(p) ? "d" : "w")).join("");
const strip = (d) => `<span class="c-roll-d"><span style="transform:translateY(calc(var(--roll-h) * -${d}))">${"0123456789".split("").map((n) => `<i>${n}</i>`).join("")}</span></span>`;
const build = (t) => parts(t).map((p) => (/\d/.test(p) ? strip(p) : `<span class="c-roll-w"><span>${esc(p)}</span></span>`)).join("");
const rolls = new WeakMap();

/**
 * @param {HTMLElement} el the element whose text rolls (its content is replaced)
 * @param {string} text
 * @param {number} [dir=1] > 0 forward (rolls up), < 0 back
 * @param {boolean} [animate=true]
 */
export function rollText(el, text, dir = 1, animate = true) {
  const prev = rolls.get(el);
  rolls.set(el, text);
  el.classList.add("c-rolling");
  if (prev === text) return;
  animate = animate && prev != null && !reducedMotion();
  const move = { duration: tokenNum("--dur-move", 300), easing: token("--ease-spring"), fill: "both" };
  if (prev == null || shape(prev) !== shape(text)) {
    const neu = h("span", { class: "c-roll", html: build(text) });
    el.querySelectorAll(".c-roll.out").forEach((n) => n.remove());
    const old = el.querySelector(".c-roll");
    if (!animate || !old) { el.replaceChildren(neu); return; }
    old.classList.add("out");
    el.appendChild(neu);
    old.animate([{ transform: "translateY(0)", opacity: 1 }, { transform: `translateY(${-dir * 100}%)`, opacity: 0 }], move).finished.then(() => old.remove(), () => {});
    neu.animate([{ transform: `translateY(${dir * 100}%)`, opacity: 0 }, { transform: "translateY(0)", opacity: 1 }], move);
    return;
  }
  const ps = parts(text), kids = [...el.querySelector(".c-roll:not(.out)").children];
  kids.forEach((c, i) => {
    const p = ps[i];
    if (c.classList.contains("c-roll-d")) {
      const s = c.firstElementChild;
      s.style.transition = animate ? `transform ${move.duration}ms ${move.easing} ${(ps.length - i) * 14}ms` : "none";
      s.style.transform = `translateY(calc(var(--roll-h) * -${p}))`;
    } else if (c.textContent !== p) {
      if (!animate) { c.innerHTML = `<span>${esc(p)}</span>`; return; }
      c.querySelectorAll(".out").forEach((n) => n.remove()); // a fast repeat: drop the one still leaving
      const old = c.firstElementChild, neu = h("span", null, p);
      old.classList.add("out");
      c.appendChild(neu);
      old.animate([{ transform: "translateY(0)", opacity: 1 }, { transform: `translateY(${-dir * 100}%)`, opacity: 0 }], move).finished.then(() => old.remove(), () => {});
      neu.animate([{ transform: `translateY(${dir * 100}%)`, opacity: 0 }, { transform: "translateY(0)", opacity: 1 }], move);
    }
  });
}

/* ---------------------------------------------------------------- date stepper
 * ‹ label ›. Previous / next step one value; holding repeats and speeds up; the label is a button (onLabel,
 * else a menu of every value). The label keeps the width of the widest value, so the arrows never move. */
export class Stepper {
  /**
   * @param {HTMLElement} el
   * @param {{ values: any[], index?: number, format: { long: (v: any) => string }, onChange?: (i: number, v: any) => void,
   *           label?: string, edge?: (dir: -1 | 1) => boolean, canEdge?: (dir: -1 | 1) => boolean,
   *           onLabel?: (button: HTMLButtonElement) => void }} o
   *   edge(dir): called when stepping past either end; return true if it handled it (e.g. crossed into another
   *   season). canEdge(dir): whether there is somewhere to go past that end, so the arrow stays enabled.
   */
  constructor(el, { values, index = 0, format, onChange, label = "Date", edge = null, canEdge = null, onLabel = null }) {
    Object.assign(this, { el, values, index, format, onChange, label, edge, canEdge });
    el.classList.add("c-stepper");
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", label);
    this.prev = h("button", { type: "button", class: "c-btn icon", "aria-label": "Previous", html: icon.left });
    this.next = h("button", { type: "button", class: "c-btn icon", "aria-label": "Next", html: icon.right });
    this.value = h("span", { class: "c-step-value" });
    this.lab = h("button", { type: "button", class: "c-btn c-step-label", "aria-haspopup": onLabel ? "dialog" : "menu", "aria-expanded": "false" }, this.value);
    this.live = h("span", { class: "sr-only", "aria-live": "polite" });
    el.append(this.prev, this.lab, this.next, this.live);
    this.hold(this.prev, -1);
    this.hold(this.next, 1);
    el.addEventListener("keydown", (e) => {
      const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (d) { e.preventDefault(); this.step(d); }
      else if (e.key === "Home") { e.preventDefault(); this.go(0); }
      else if (e.key === "End") { e.preventDefault(); this.go(this.values.length - 1); }
    });
    this.lab.addEventListener("click", () => onLabel ? onLabel(this.lab) : openMenu(this.lab, {
      label, placement: "top",
      items: this.values.map((v, i) => ({ label: format.long(v), value: i, checked: i === this.index, onSelect: (n) => this.go(n) })).reverse(),
    }));
    this.fixWidth();
    document.fonts?.ready.then(() => this.fixWidth());
    this.render(true);
  }
  // the widest value, measured in the label's own font and numerals
  fixWidth() {
    const m = h("span", { class: "c-step-value", style: { position: "absolute", visibility: "hidden", whiteSpace: "pre" } });
    this.lab.appendChild(m);
    let w = 0;
    for (const v of this.values) { m.textContent = this.format.long(v); w = Math.max(w, m.getBoundingClientRect().width); }
    m.remove();
    this.el.style.setProperty("--value-w", `${Math.ceil(w)}px`);
  }
  hold(btn, d) {
    let t = 0, delay = 0;
    const stop = () => clearTimeout(t);
    const rep = () => { this.step(d); delay = Math.max(tokenNum("--time-repeat", 90) / 2, delay * 0.86); t = setTimeout(rep, delay); };
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.step(d);
      delay = tokenNum("--time-repeat", 90);
      t = setTimeout(rep, tokenNum("--time-long-press", 400));
    });
    btn.addEventListener("click", (e) => { if (e.detail === 0) this.step(d); }); // Enter / Space
    for (const ev of ["pointerup", "pointerleave", "pointercancel", "blur"]) btn.addEventListener(ev, stop);
  }
  /** Step by d, handing the edges to `edge`. */
  step(d) {
    const i = this.index + d;
    if ((i < 0 || i >= this.values.length) && this.edge?.(d)) return;
    this.go(i);
  }
  /** Go to index i (clamped) and fire onChange; at an end, nudge instead. */
  go(i) {
    const n = Math.max(0, Math.min(this.values.length - 1, i));
    if (n === this.index) {
      if (i !== n && !reducedMotion()) this.el.animate([{ transform: "none" }, { transform: `translateX(${i < 0 ? -3 : 3}px)` }, { transform: "none" }], { duration: tokenNum("--dur", 200), easing: token("--ease-out") });
      return;
    }
    const dir = Math.sign(n - this.index);
    this.index = n;
    this.render(false, dir);
    this.onChange?.(n, this.values[n]);
  }
  /** Show index i without firing onChange (e.g. the chart scrubbing the date): the label rolls to it. */
  show(i) {
    i = Math.max(0, Math.min(this.values.length - 1, i));
    if (i === this.index) return;
    const dir = Math.sign(i - this.index);
    this.index = i;
    this.render(false, dir, false);
  }
  /** New values (another season), shown at index without a roll or onChange. */
  setValues(values, index) {
    this.values = values;
    this.index = Math.max(0, Math.min(values.length - 1, index));
    this.fixWidth();
    this.render(true);
  }
  render(initial, dir = 1, announce = true) {
    const text = this.format.long(this.values[this.index]);
    rollText(this.value, text, dir, !initial);
    this.lab.setAttribute("aria-label", `${this.label}: ${text}`);
    this.prev.setAttribute("aria-disabled", String(this.index === 0 && !this.canEdge?.(-1)));
    this.next.setAttribute("aria-disabled", String(this.index === this.values.length - 1 && !this.canEdge?.(1)));
    if (!initial && announce) this.live.textContent = text;
  }
}

/* ---------------------------------------------------------------- segmented control
 * A radiogroup with a sliding thumb. Tab enters at the selected option, arrows move the selection
 * (unless timeKeys has taken the arrows: then every option is a tab stop). */
export class Segmented {
  /**
   * @param {HTMLElement} el
   * @param {{ items: { value: any, label: string }[], value?: any, onChange?: (v: any) => void, label?: string }} o
   */
  constructor(el, { items, value, onChange, label = "" }) {
    Object.assign(this, { el, items, onChange });
    this.value = value ?? items[0].value;
    el.classList.add("c-seg");
    this.track = h("div", { class: "c-seg-track", role: "radiogroup", "aria-label": label || null });
    this.thumb = h("span", { class: "c-seg-thumb", "aria-hidden": "true" });
    this.btns = items.map((it) => h("button", { type: "button", class: "c-seg-item", role: "radio", onclick: () => this.set(it.value, true) }, it.label));
    this.track.append(this.thumb, ...this.btns);
    el.appendChild(this.track);
    this.track.addEventListener("keydown", (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!d && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      const i = this.items.findIndex((x) => x.value === this.value), n = this.items.length;
      const j = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + d + n) % n;
      this.set(this.items[j].value, true);
      this.btns[j].focus();
    });
    this.set(this.value, false, true);
    // fonts arriving or the control resizing move the thumb's target: follow without animating
    this.ro = new ResizeObserver(() => this.moveThumb(true));
    this.ro.observe(this.track);
  }
  /**
   * @param {any} v
   * @param {boolean} [fire=false] call onChange
   */
  set(v, fire = false, instant = false) {
    this.value = v;
    this.items.forEach((it, i) => {
      const b = this.btns[i], on = it.value === v;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on || timeKeysOn ? 0 : -1;
    });
    this.moveThumb(instant);
    if (fire) this.onChange?.(v);
  }
  moveThumb(instant) {
    const b = this.btns[this.items.findIndex((x) => x.value === this.value)];
    if (!b) return;
    this.thumb.style.transition = instant ? "none" : "";
    this.thumb.style.width = `${b.offsetWidth}px`;
    this.thumb.style.transform = `translateX(${b.offsetLeft}px)`;
  }
}

/* ---------------------------------------------------------------- toast
 * A brief confirmation, bottom centre above the bottom controls. Pauses while hovered or focused; at most
 * three at once; announced politely. tone: "ok" (a check, the default), "error" (an alert sign), "info"
 * (no sign, e.g. something under way). */
let toastHost = null;
const TOAST_ICON = { ok: () => icon.check, error: () => icon.alert, info: () => "" };
/**
 * @param {string} message
 * @param {{ action?: { label: string, onClick?: () => void }, duration?: number, tone?: "ok" | "error" | "info" }} [opts]
 *   duration defaults to --time-toast
 * @returns {{ dismiss(): void }}
 */
export function toast(message, { action = null, duration, tone = "ok" } = {}) {
  if (!toastHost?.isConnected) { toastHost = h("div", { class: "c-toasts", "aria-live": "polite" }); document.body.appendChild(toastHost); }
  // the oldest goes at once (with its glass) to make room
  while (toastHost.children.length >= 3) { const old = toastHost.firstChild; old._end ? old._end() : old.remove(); }
  const ic = (TOAST_ICON[tone] ?? TOAST_ICON.ok)();
  const t = h("div", { class: ["c-toast", tone !== "ok" && `is-${tone}`] },
    ic ? h("span", { class: "c-toast-icon", html: ic }) : null,
    h("span", { class: "c-toast-label" }, message),
    action ? h("button", { type: "button", class: "c-btn filled c-toast-action", onclick: () => { action.onClick?.(); dismiss(); } }, action.label) : null);
  toastHost.appendChild(t);
  const g = glass(t);
  if (!reducedMotion()) t.animate([{ opacity: 0, transform: `translateY(${tokenNum("--space-12", 12)}px) scale(${tokenNum("--scale-enter", 0.96)})` }, { opacity: 1, transform: "none" }], { duration: tokenNum("--dur-move", 300), easing: token("--ease-spring") });
  let left = duration ?? tokenNum("--time-toast", 3200), started = performance.now(), timer = setTimeout(dismiss, left);
  const pause = () => { clearTimeout(timer); left -= performance.now() - started; };
  const resume = () => { started = performance.now(); timer = setTimeout(dismiss, Math.max(tokenNum("--time-toast", 3200) / 4, left)); };
  t.addEventListener("pointerenter", pause); t.addEventListener("pointerleave", resume);
  t.addEventListener("focusin", pause); t.addEventListener("focusout", resume);
  let gone = false;
  t._end = () => { gone = true; clearTimeout(timer); g.destroy(); t.remove(); };
  function dismiss() {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    const end = () => { g.destroy(); t.remove(); };
    if (reducedMotion()) { end(); return; }
    t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: tokenNum("--dur", 200), easing: token("--ease-out"), fill: "forwards" }).onfinish = end;
  }
  return { dismiss };
}
