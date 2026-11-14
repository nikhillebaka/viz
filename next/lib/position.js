/* Anchored placement for floating layers (menus, popovers, tooltips), in viewport coordinates.
 * Pure geometry in computePosition (tested in node); autoUpdate is the browser glue. */

const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" };

/** @returns {{left, top, right, bottom, width, height}} the visible viewport */
export function viewportRect() {
  const vv = window.visualViewport;
  return vv ? { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height, width: vv.width, height: vv.height }
            : { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
}

/**
 * Place a floating box next to an anchor.
 * - placement "bottom-start" | "bottom" | "bottom-end" | "top-…" | "left-…" | "right-…"
 * - flips to the opposite side when the preferred side is too small and the other has more room
 * - shifts along the side so it stays inside `boundary` minus `padding`
 * - maxHeight / maxWidth: the room on the chosen side, so long content scrolls instead of overflowing
 * - origin: transform-origin pointing back at the anchor, for open/close animations
 * @param {{left, top, right, bottom, width, height}} a anchor rect
 * @param {{width, height}} f floating size
 * @returns {{ x: number, y: number, side: string, maxHeight: number, maxWidth: number, origin: string }}
 */
export function computePosition(a, f, { placement = "bottom-start", offset = 8, padding = 12, boundary = viewportRect(), flip = true } = {}) {
  let [side, align = "center"] = placement.split("-");
  const space = {
    top: a.top - boundary.top - offset - padding,
    bottom: boundary.bottom - a.bottom - offset - padding,
    left: a.left - boundary.left - offset - padding,
    right: boundary.right - a.right - offset - padding,
  };
  const need = side === "top" || side === "bottom" ? f.height : f.width;
  if (flip && space[side] < need && space[opposite[side]] > space[side]) side = opposite[side];

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
  // the point of the floating box nearest the anchor's centre
  const ox = Math.max(0, Math.min(f.width, a.left + a.width / 2 - x));
  const oy = Math.max(0, Math.min(f.height, a.top + a.height / 2 - y));
  const origin = vertical ? `${ox}px ${side === "bottom" ? 0 : "100%"}` : `${side === "right" ? 0 : "100%"} ${oy}px`;
  return { x: Math.round(x), y: Math.round(y), side, maxHeight, maxWidth, origin };
}

/**
 * Re-run fn at most once per frame when the page scrolls, the window resizes, or either element
 * changes size. fn("scroll") when only something scrolled, fn("layout") otherwise. Runs fn("layout")
 * once immediately.
 * @returns {() => void} stops
 */
export function autoUpdate(anchor, floating, fn) {
  let raf = 0, layout = false;
  const run = () => { raf = 0; const why = layout ? "layout" : "scroll"; layout = false; fn(why); };
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(run); };
  const onLayout = () => { layout = true; if (!raf) raf = requestAnimationFrame(run); };
  addEventListener("scroll", onScroll, { passive: true, capture: true });
  addEventListener("resize", onLayout);
  window.visualViewport?.addEventListener("resize", onLayout);
  const ro = new ResizeObserver(onLayout);
  ro.observe(anchor); ro.observe(floating);
  fn("layout");
  return () => {
    cancelAnimationFrame(raf);
    removeEventListener("scroll", onScroll, { capture: true });
    removeEventListener("resize", onLayout);
    window.visualViewport?.removeEventListener("resize", onLayout);
    ro.disconnect();
  };
}
