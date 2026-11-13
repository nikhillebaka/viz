/* Anchored positioning for menus, popovers and tooltips.
 *
 * computePosition(anchorRect, floatingSize, options) places a floating element next to an anchor:
 *   - placement "bottom-start" | "bottom" | "bottom-end" | "top-…" | "left-…" | "right-…"
 *   - flips to the opposite side when the preferred side doesn't fit and the other side has more room
 *   - shifts along the edge so it never leaves the boundary (minus `padding`)
 *   - returns maxHeight / maxWidth for the side it chose, so long lists scroll instead of overflowing
 *   - returns the transform-origin pointing back at the anchor, so open/close animations grow from it
 *
 * autoUpdate(anchor, floating, fn) re-runs fn on scroll, resize and size changes, once per frame.
 * No layout thrash: reads happen in fn, writes are a single transform.
 */
const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" };

export function viewportRect() {
  const vv = window.visualViewport;
  return vv ? { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height, width: vv.width, height: vv.height }
            : { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
}

export function computePosition(a, f, { placement = "bottom-start", offset = 8, padding = 12, boundary = viewportRect() } = {}) {
  let [side, align = "center"] = placement.split("-");
  const space = {
    top: a.top - boundary.top - offset - padding,
    bottom: boundary.bottom - a.bottom - offset - padding,
    left: a.left - boundary.left - offset - padding,
    right: boundary.right - a.right - offset - padding,
  };
  const need = side === "top" || side === "bottom" ? f.height : f.width;
  if (space[side] < need && space[opposite[side]] > space[side]) side = opposite[side];

  let x, y;
  const vertical = side === "top" || side === "bottom";
  if (vertical) {
    y = side === "bottom" ? a.bottom + offset : a.top - offset - Math.min(f.height, space.top);
    x = align === "start" ? a.left : align === "end" ? a.right - f.width : a.left + a.width / 2 - f.width / 2;
    x = Math.max(boundary.left + padding, Math.min(boundary.right - padding - f.width, x));
  } else {
    x = side === "right" ? a.right + offset : a.left - offset - f.width;
    y = align === "start" ? a.top : align === "end" ? a.bottom - f.height : a.top + a.height / 2 - f.height / 2;
    y = Math.max(boundary.top + padding, Math.min(boundary.bottom - padding - f.height, y));
  }
  const maxHeight = vertical ? Math.max(120, space[side]) : boundary.height - padding * 2;
  const maxWidth = vertical ? boundary.width - padding * 2 : Math.max(160, space[side]);
  // origin: the point of the floating element nearest the anchor's centre
  const ox = Math.max(0, Math.min(f.width, a.left + a.width / 2 - x));
  const oy = Math.max(0, Math.min(f.height, a.top + a.height / 2 - y));
  const origin = vertical ? `${ox}px ${side === "bottom" ? 0 : "100%"}` : `${side === "right" ? 0 : "100%"} ${oy}px`;
  return { x: Math.round(x), y: Math.round(y), side, maxHeight, maxWidth, origin };
}

export function autoUpdate(anchor, floating, fn) {
  let raf = 0;
  const run = () => { raf = 0; fn(); };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(run); };
  addEventListener("scroll", schedule, { passive: true, capture: true });
  addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  const ro = new ResizeObserver(schedule);
  ro.observe(anchor); ro.observe(floating);
  fn();
  return () => {
    cancelAnimationFrame(raf);
    removeEventListener("scroll", schedule, { capture: true });
    removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
    ro.disconnect();
  };
}

/* Size class of the view an element lives in: "compact" | "regular" | "wide".
   Uses the nearest [data-view] ancestor (the stage or page), falling back to the window. */
export function sizeClass(el) {
  const view = el?.closest?.("[data-view]");
  const w = view ? view.clientWidth : innerWidth;
  const css = getComputedStyle(document.documentElement);
  const compact = parseFloat(css.getPropertyValue("--layout-compact")) || 600;
  const wide = parseFloat(css.getPropertyValue("--layout-wide")) || 1024;
  return w < compact ? "compact" : w < wide ? "regular" : "wide";
}
