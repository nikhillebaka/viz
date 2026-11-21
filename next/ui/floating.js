/* Floating layers: popover, menu, tooltip. Desktop only. Layers live in document.body with
 * position: fixed, placed in viewport coordinates by lib/position.js.
 *
 * Behaviour shared by popovers and menus:
 *  - one layer open at a time; the anchor's own click toggles it (open* returns null when it just closed)
 *  - placement and size are settled at open and when the content or window changes size; when only the
 *    page scrolls, the layer keeps its side and size and follows its anchor, and closes once the anchor
 *    has left the screen
 *  - Escape and a pointerdown outside close it; focus goes into it on open (without a ring for pointer
 *    users) and back to the anchor on close; the anchor carries aria-expanded
 *  - opening fades in with a calm directional edge slide over --dur and fades out over --dur-fast.
 *    Instant with reduced motion. */
import { h, on, token, tokenNum, reducedMotion } from "../lib/dom.js";
import { computePosition, autoUpdate } from "../lib/position.js";
import { glass } from "./glass.js";
// controls.js imports this module too; the cycle is safe because icons are only read when a layer opens
import { icon } from "./controls.js";

const FOCUSABLE = ["button:not([disabled])", "[href]", "input:not([disabled])", "select", "textarea", "[tabindex]"].map((s) => `${s}:not([tabindex='-1'])`).join(", ");

const EDGE_ORIGIN = {
  bottom: "center top",
  top: "center bottom",
  right: "left center",
  left: "right center",
};

const SLIDE_FROM = {
  bottom: "translate3d(0, -5px, 0)",
  top: "translate3d(0, 5px, 0)",
  right: "translate3d(-5px, 0, 0)",
  left: "translate3d(5px, 0, 0)",
};

/* ---------- input modality ----------
 * Focus rings are for keyboard users. When we move focus ourselves (into a layer, back to its anchor),
 * the ring shows only if the last interaction was a key. Left/right don't count while on the pointer:
 * they step the chart's date from anywhere. */
let modality = "pointer";
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", () => (modality = "pointer"), true);
  document.addEventListener("keydown", (e) => { if (modality !== "pointer" || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) modality = "keyboard"; }, true);
}
/** @returns {"pointer" | "keyboard"} how the user last interacted */
export const inputModality = () => modality;
/** Focus without scrolling, with a ring only for keyboard users. */
export function focusQuietly(el) { el?.focus({ preventScroll: true, focusVisible: modality === "keyboard" }); }

/**
 * Bring an item into view inside its own scrolling list, never scrolling the page (scrollIntoView
 * scrolls every scrollable ancestor, which made open layers jump).
 * @param {Element | null} el
 */
export function revealInList(el) {
  if (!el) return;
  let box = el.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  if (!box || box === document.body || box === document.documentElement) return;
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
}

let openLayer = null;
/** @returns {object | null} the open layer, if any (e.g. to hide a hover readout while one is open) */
export const activeLayer = () => openLayer;

const dur = (name) => (reducedMotion() ? 0 : tokenNum(name, 200));
const rectOf = (el) => el.getBoundingClientRect();

function trapFocus(e, root) {
  const f = [...root.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
}

/* The shared layer. role: "dialog" (popover) or "menu". */
function layerFor(anchor, { className, role, label, title, placement, width, trap, onClose }) {
  openLayer?.close(false);
  const panel = h("div", { class: ["c-panel c-float", className], role, "aria-label": label || title || null, tabindex: "-1" });
  if (title) {
    const head = h("div", { class: "c-float-head" },
      h("span", { class: "c-float-title" }, title),
      h("button", { type: "button", class: "c-btn icon filled sm", "aria-label": "Close", html: icon.close, onclick: () => layer.close(true) }));
    panel.appendChild(head);
  }
  const body = h("div", { class: "c-float-body" });
  panel.appendChild(body);
  if (width) panel.style.width = `${width}px`;
  panel.style.visibility = "hidden";
  document.body.appendChild(panel);
  const g = glass(panel, { panel: true });

  let side = placement, box = null;
  const inset = () => tokenNum("--inset", 16);
  const place = (why = "layout") => {
    if (!anchor.isConnected) { layer.close(false); return; }
    const ar = rectOf(anchor);
    if (why === "scroll") {
      if (ar.bottom < 0 || ar.top > innerHeight || ar.right < 0 || ar.left > innerWidth) { layer.close(false); return; }
      const p = computePosition(ar, box, { placement: side, offset: box.offset, padding: inset(), flip: false, boundary: { left: 0, right: innerWidth, top: -1e5, bottom: 1e5, width: innerWidth, height: 2e5 } });
      panel.style.left = `${p.x}px`; panel.style.top = `${p.y}px`;
      box.x = p.x; box.y = p.y;
      return;
    }
    panel.style.maxHeight = "";
    const offset = tokenNum("--gap", 8);
    const size = { width: panel.offsetWidth, height: panel.offsetHeight };
    const p = computePosition(ar, size, { placement, offset, padding: inset() });
    const chosenSide = p.side;
    side = `${chosenSide}-${placement.split("-")[1] || "center"}`;
    panel.style.maxHeight = `${Math.floor(p.maxHeight)}px`;
    panel.style.left = `${p.x}px`; panel.style.top = `${p.y}px`;
    panel.style.transformOrigin = EDGE_ORIGIN[chosenSide] || "center top";
    box = { x: p.x, y: p.y, width: size.width, height: Math.min(size.height, Math.floor(p.maxHeight)), offset, side: chosenSide };
  };

  const opener = document.activeElement;
  const animateOpen = () => {
    if (reducedMotion()) return;
    const fromTransform = SLIDE_FROM[box?.side || "bottom"] || "translate3d(0, -5px, 0)";
    panel.animate(
      [{ opacity: 0, transform: fromTransform }, { opacity: 1, transform: "none" }],
      { duration: dur("--dur"), easing: token("--ease-out") },
    );
  };

  const onDown = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target)) layer.close(true); };
  const onKey = (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); layer.close(true); }
    else if (e.key === "Tab" && trap) trapFocus(e, panel);
  };
  // Escape with focus outside the layer (e.g. it was opened by pointer and focus stayed behind)
  const onDocKey = (e) => { if (!panel.contains(e.target)) onKey(e); };
  const offs = [on(document, "pointerdown", onDown, true), on(panel, "keydown", onKey), on(document, "keydown", onDocKey, true)];
  anchor.setAttribute("aria-expanded", "true");
  if (!anchor.hasAttribute("aria-haspopup")) anchor.setAttribute("aria-haspopup", role === "menu" ? "menu" : "dialog");

  let closed = false, started = false, stop = () => {};
  const layer = {
    panel, body, anchor, place: () => place("layout"),
    /** @param {boolean} [restoreFocus=true] return focus to the anchor */
    close(restoreFocus = true) {
      if (closed) return;
      closed = true;
      if (openLayer === layer) openLayer = null;
      offs.forEach((off) => off());
      stop();
      anchor.setAttribute("aria-expanded", "false");
      const done = () => { g.destroy(); panel.remove(); };
      if (restoreFocus && anchor.isConnected) focusQuietly(anchor.matches(FOCUSABLE) ? anchor : opener);
      onClose?.();
      if (reducedMotion() || !box) { done(); return; }
      panel.getAnimations().forEach((a) => a.cancel());
      const anim = panel.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: dur("--dur-fast"), easing: token("--ease-out"), fill: "forwards" },
      );
      let finished = false;
      const fin = () => { if (!finished) { finished = true; done(); } };
      anim.onfinish = fin;
      setTimeout(fin, tokenNum("--dur-move", 300) + 200); // the browser may pause animations in a background tab
    },
  };
  openLayer = layer;
  const start = () => {
    if (closed || started) return;
    started = true;
    stop = autoUpdate(anchor, panel, place);
    panel.style.visibility = "";
    animateOpen();
  };
  return { layer, start };
}

/**
 * Open a popover anchored to a control (or close it, if it is already open from this anchor).
 * @param {HTMLElement} anchor
 * @param {{ content: (body: HTMLElement, layer: object) => void, title?: string, placement?: string,
 *           width?: number, morph?: boolean, className?: string, timeKeys?: boolean, onClose?: () => void }} opts
 *   width defaults to --popover-width. timeKeys: ← → keep stepping the chart's date while it is open.
 * @returns {{ panel: HTMLElement, body: HTMLElement, close(restoreFocus?: boolean): void, place(): void } | null}
 *   null when this call closed it
 */
export function openPopover(anchor, { content, title = "", placement = "bottom-start", width, className = "", timeKeys = false, onClose } = {}) {
  if (openLayer?.anchor === anchor) { openLayer.close(true); return null; }
  const { layer, start } = layerFor(anchor, {
    className: ["c-popover", className].filter(Boolean).join(" "), role: "dialog", title, placement,
    width: width ?? tokenNum("--popover-width", 360), trap: true, onClose,
  });
  if (timeKeys) layer.panel.dataset.timeKeys = "";
  content?.(layer.body, layer);
  start();
  focusQuietly(layer.body.querySelector("input, button, [tabindex='0']") || layer.panel);
  return layer;
}

/**
 * Open a menu (or close it, if it is already open from this anchor).
 * Items: { label, value?, checked?, toggle?, icon?, shortcut?, disabled?, danger?, onSelect(value) },
 * "-" for a separator, { header } for a group label. When any item has `checked`, items are
 * menuitemradio (a check marks the current one); `toggle: true` makes an item a menuitemcheckbox, and a
 * menu with more than one thing to pick stays open when one is toggled (it closes on a plain item, a
 * radio, Escape, Tab or a click outside). `trailing`: a node at the end of the row (e.g. swatches; it
 * handles its own clicks); `onArrow(d)`: ← → on that row (d = -1 / 1), for those trailing controls.
 * Keys: ↑ ↓ Home End, type-ahead, Enter / Space, Escape, Tab closes.
 * @param {HTMLElement} anchor
 * @param {{ items: Array, placement?: string, label?: string, onClose?: () => void }} opts
 * @returns {{ panel: HTMLElement, body: HTMLElement, close(restoreFocus?: boolean): void, place(): void } | null}
 */
export function openMenu(anchor, { items, placement = "bottom-start", label = "", onClose } = {}) {
  if (openLayer?.anchor === anchor) { openLayer.close(true); return null; }
  const { layer, start } = layerFor(anchor, { className: "c-menu", role: "menu", label, placement, onClose });
  const checks = items.some((i) => i && typeof i === "object" && i.checked !== undefined);
  for (const it of items) {
    if (it === "-") { layer.body.appendChild(h("div", { class: "c-menu-sep", role: "separator" })); continue; }
    if (it.header) { layer.body.appendChild(h("div", { class: "c-menu-header", role: "presentation" }, it.header)); continue; }
    const role = it.toggle ? "menuitemcheckbox" : checks ? "menuitemradio" : "menuitem";
    const b = h("button", {
      type: "button", class: ["c-menu-item", it.danger && "danger"], role, tabindex: "-1",
      "aria-checked": role === "menuitem" ? null : String(!!it.checked), "aria-disabled": it.disabled ? "true" : null,
    },
    checks || it.toggle ? h("span", { class: "c-menu-check", html: it.checked ? icon.check : "" }) : null,
    it.icon ? h("span", { class: "c-menu-icon", html: it.icon }) : null,
    h("span", { class: "c-menu-label" }, it.label),
    it.shortcut ? h("kbd", null, it.shortcut) : null,
    it.trailing || null);
    b.addEventListener("click", (e) => {
      if (it.disabled || (it.trailing && it.trailing.contains(e.target))) return;
      if (!it.toggle) { layer.close(true); it.onSelect?.(it.value ?? it.label); return; }
      it.checked = !it.checked;
      b.setAttribute("aria-checked", String(it.checked));
      b.querySelector(".c-menu-check").innerHTML = it.checked ? icon.check : "";
      it.onSelect?.(it.value ?? it.label);
    });
    if (it.onArrow) b.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); it.onArrow(e.key === "ArrowLeft" ? -1 : 1); } });
    // the pointer and the keyboard share one highlight: hovering an item focuses it
    b.addEventListener("pointermove", () => { if (document.activeElement !== b && !it.disabled) focusQuietly(b); });
    layer.body.appendChild(b);
  }
  const list = () => [...layer.body.querySelectorAll(".c-menu-item:not([aria-disabled='true'])")];
  let typed = "", typedT = 0;
  layer.panel.addEventListener("keydown", (e) => {
    const all = list(), i = all.indexOf(document.activeElement);
    const go = (n) => { const t = all[(n + all.length) % all.length]; focusQuietly(t); revealInList(t); };
    if (e.key === "ArrowDown") { e.preventDefault(); go(i + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(i < 0 ? all.length - 1 : i - 1); }
    else if (e.key === "Home") { e.preventDefault(); go(0); }
    else if (e.key === "End") { e.preventDefault(); go(all.length - 1); }
    else if (e.key === "Tab") { e.preventDefault(); layer.close(true); }
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      clearTimeout(typedT); typed += e.key.toLowerCase(); typedT = setTimeout(() => (typed = ""), 600);
      const m = all.find((b) => b.textContent.trim().toLowerCase().startsWith(typed));
      if (m) { focusQuietly(m); revealInList(m); }
    }
  });
  start();
  const first = layer.body.querySelector(".c-menu-item[role='menuitemradio'][aria-checked='true']") || list()[0];
  focusQuietly(first);
  revealInList(first);
  return layer;
}

/* ---------- tooltip ----------
 * Solid (it may sit on glass, and glass never sits on glass). Mouse hover after --time-tooltip-delay,
 * at once when moving between controls within --time-tooltip-skip; keyboard focus at once; never touch. */
let tipEl = null, tipTimer = 0, tipHiddenAt = -Infinity, tipFor = null, tipStop = () => {}, tipN = 0;

/**
 * Give an element a tooltip.
 * @param {HTMLElement} el
 * @param {string} text
 * @param {{ placement?: string }} [opts]
 * @returns {{ set(text: string): void, destroy(): void }}
 */
export function tooltip(el, text, { placement = "top" } = {}) {
  const id = `c-tip-${++tipN}`;
  el.setAttribute("aria-describedby", id);
  const show = () => {
    clearTimeout(tipTimer);
    tipEl ||= h("div", { class: "c-tooltip", role: "tooltip" });
    tipEl.id = id; tipEl.textContent = text;
    if (!tipEl.isConnected) document.body.appendChild(tipEl);
    tipFor = el;
    tipStop();
    tipStop = autoUpdate(el, tipEl, () => {
      const p = computePosition(rectOf(el), { width: tipEl.offsetWidth, height: tipEl.offsetHeight }, { placement, offset: tokenNum("--gap", 8), padding: tokenNum("--gap", 8) });
      tipEl.style.left = `${p.x}px`; tipEl.style.top = `${p.y}px`;
    });
    tipEl.classList.add("show");
  };
  const hide = () => {
    clearTimeout(tipTimer);
    if (tipFor !== el || !tipEl) return;
    tipEl.classList.remove("show"); tipStop(); tipStop = () => {}; tipFor = null; tipHiddenAt = performance.now();
  };
  const offs = [
    on(el, "pointerenter", (e) => {
      if (e.pointerType !== "mouse") return;
      const skip = performance.now() - tipHiddenAt < tokenNum("--time-tooltip-skip", 300);
      clearTimeout(tipTimer);
      tipTimer = setTimeout(show, skip ? 0 : tokenNum("--time-tooltip-delay", 500));
    }),
    on(el, "pointerleave", hide),
    on(el, "pointerdown", hide),
    on(el, "focus", () => { if (el.matches(":focus-visible")) show(); }),
    on(el, "blur", hide),
    on(el, "keydown", (e) => { if (e.key === "Escape") hide(); }),
  ];
  return {
    set(t) { text = t; if (tipFor === el) tipEl.textContent = t; },
    destroy() { hide(); offs.forEach((off) => off()); el.removeAttribute("aria-describedby"); },
  };
}
