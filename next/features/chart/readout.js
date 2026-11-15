/* The hover readout: exact numbers for the hovered week.
 * A solid kit panel (.c-readout), never glass. Built from hoverInfo() (chart/layout.js); its DOM is
 * rebuilt only when what it says changes, and moved only when its place changes. */
import { h, tokenNum } from "../../lib/dom.js";
import { fmtDay } from "../../lib/format.js";
import { seriesColor } from "../../chart/layout.js";

const DASH = "–";
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ok = (lo, hi) => Number.isFinite(lo) && Number.isFinite(hi);

/* "95 · 50%": the levels, named once */
export const levelsText = (levels) => levels.map((l) => Math.round(l * 100)).join(" · ") + "%";

/* A compact range for several levels: three significant digits above a thousand, the unit once
 * ("9.1–15.8k", "1.2–2.31%"). */
function tightRange(value, lo, hi) {
  const f = (v) => { const a = Math.abs(v); return a >= 1e6 ? `${+(v / 1e6).toPrecision(3)}M` : a >= 1e3 ? `${+(v / 1e3).toPrecision(3)}k` : value(v); };
  const a = f(lo), b = f(hi), unit = /[^\d.,]*$/.exec(b)[0];
  return `${unit && a.endsWith(unit) ? a.slice(0, -unit.length) : a}–${b}`;
}

export class Readout {
  /** @param {HTMLElement} parent the chart view */
  constructor(parent) {
    this.el = h("div", { class: "c-readout fc-readout", "aria-hidden": "true" });
    this.el.hidden = true;
    parent.append(this.el);
    this.key = "";
    this.pos = "";
    this.w = 0;
  }

  hide() { if (!this.el.hidden) this.el.hidden = true; }

  /**
   * Shows the readout for one hovered week, or hides it when there is nothing to say.
   * @param {ReturnType<import("../../chart/layout.js").hoverInfo>} info
   * @param {object} scene the scene just drawn
   * @param {{ value: (v: number) => string, levels: number[], rulers: boolean, showAll: boolean,
   *           more: number, focus: string | null, minX: number, layers?: object[] }} o  more: every grey
   *   (context) model in the selection; focus: the focused (or previewed) model on the chart; minX: the
   *   readout's leftmost x (right of a panel taking room at the left); layers: rows for the visible layers
   *   at this week (features/chart/layers.js rows())
   */
  show(info, scene, o) {
    const model = this.#model(info, o);
    if (!model) { this.hide(); return; }
    const key = JSON.stringify(model);
    if (key !== this.key) {
      this.key = key;
      this.el.replaceChildren(...this.#render(model));
      this.el.hidden = false;
      this.w = this.el.offsetWidth; // only when the content changed
    } else if (this.el.hidden) this.el.hidden = false;
    this.#place(scene, info.t, info.h != null, o.minX);
  }

  // what the readout says, as plain values (also its cache key)
  #model(info, o) {
    const m = this.#base(info, o), layers = o.layers?.length ? o.layers : null;
    if (!layers) return m;
    return m ? { ...m, layers } : { head: fmtDay(info.t), right: "", history: true, obs: null, layers };
  }

  #base(info, o) {
    const v = o.value, inWindow = info.h != null;
    const obs = info.observed;
    if (!inWindow) return obs === undefined ? null : { head: fmtDay(info.t), right: "", obs: v(obs), history: true };
    const L = o.levels || [], range = L.length > 0, width = range && o.rulers;
    // one level: "9,120 – 15,800" as ever; several: one compact range each, widest first
    const ranges = (r) => (L.length === 1
      ? [ok(r.lo, r.hi) ? `${v(r.lo)} – ${v(r.hi)}` : DASH]
      : L.map((_, k) => { const [lo, hi] = r.ranges?.[k] ?? [NaN, NaN]; return ok(lo, hi) ? tightRange(v, lo, hi) : DASH; }));
    const rows = [];
    const row = (r, c, dim) => ({
      c, name: r.label, med: v(r.med),
      ranges: range ? ranges(r) : null,
      width: width ? (ok(r.lo, r.hi) ? v(r.hi - r.lo) : DASH) : null,
      dim,
    });
    if (info.hot) rows.push(row(info.hot, "var(--ink-tertiary)", false));
    // hoverInfo puts the focused model first; the others dim while one is focused (or previewed)
    for (const r of info.rows) rows.push(row(r, seriesColor(r.slot), o.focus != null && r.id !== o.focus));
    let more = null;
    if (o.showAll && o.more > 0) {
      const missing = o.more - info.context.n;
      more = {
        name: `and ${o.more} more selected${missing > 0 ? ` (${missing} with no forecast)` : ""}`,
        span: info.context.n ? `${v(info.context.min)} – ${v(info.context.max)}` : "",
      };
    }
    const hasObs = obs !== undefined;
    if (!rows.length && !more && !hasObs) return null;
    return {
      head: `${fmtDay(info.t)} · ${info.h === 0 ? "this week" : `${info.h} wk ahead`}`,
      right: range ? levelsText(L) : "",
      range: range ? L.length : 0, width, rows, more,
      obs: hasObs ? v(obs) : null,
      misses: hasObs ? info.rows.filter((r) => r.missed).map((r) => seriesColor(r.slot)) : [],
    };
  }

  #render(m) {
    const out = this.#main(m);
    if (m.layers) {
      out.push(h("table", { class: out.length > 1 ? "fc-readout-layers" : "fc-readout-layers fc-readout-only" }, m.layers.map((r) => h("tr", null,
        h("td", null, h("span", { class: "c-readout-name" },
          h("i", { class: `fc-swatch is-${r.mark}`, style: { color: r.c } }),
          h("span", { class: "fc-readout-label" }, r.name))),
        h("td", { class: "num quiet" }, r.value)))));
    }
    return out;
  }

  #main(m) {
    const head = h("div", { class: "c-readout-head" }, h("span", null, m.head), m.right ? h("span", null, m.right) : null);
    if (m.history) {
      return m.obs == null ? [head] : [head, h("table", null, h("tr", null,
        h("td", null, h("span", { class: "c-readout-name" }, "Observed")),
        h("td", { class: "num" }, m.obs)))];
    }
    const rc = m.range > 2 ? "num quiet fc-readout-tight" : "num quiet";
    const cells = (r) => [
      h("td", null, h("span", { class: "c-readout-name" }, h("i", { class: "c-dot", style: { background: r.c } }), h("span", { class: "fc-readout-label" }, r.name))),
      h("td", { class: "num" }, r.med),
      ...(m.range ? r.ranges.map((x) => h("td", { class: rc }, x)) : []),
      m.width ? h("td", { class: "num quiet" }, r.width) : null,
    ];
    const rows = m.rows.map((r) => h("tr", { class: r.dim ? "dim" : null }, cells(r)));
    if (m.more) {
      rows.push(h("tr", { class: "fc-readout-more" },
        h("td", null, h("span", { class: "c-readout-name quiet" }, m.more.name)),
        m.range ? h("td") : null,
        h("td", { class: "num quiet", colspan: m.range > 1 ? String(m.range) : null }, m.more.span),
        m.width ? h("td") : null));
    }
    const out = [head];
    if (rows.length) out.push(h("table", null, rows));
    if (m.obs != null) {
      out.push(h("div", { class: rows.length ? "c-readout-foot" : "c-readout-foot fc-readout-only" },
        h("span", null, "Observed"),
        h("span", { class: "num" }, m.obs,
          m.misses.length ? h("span", { class: "fc-readout-misses", title: "Outside these intervals" }, m.misses.map((c) => h("i", { class: "c-dot", style: { background: c } }))) : null)));
    }
    return out;
  }

  /* In the forecast window: left of the reference date, over the history, so it never covers a band; if
   * there is no room, right of the hovered week. Over the history: left of the hovered week (right of it if
   * there is no room). Past the forecast window: right of the hovered week (else left). Always under the
   * top bubbles. */
  #place(scene, t, inWindow, minX) {
    const gap = tokenNum("--space-20", 20), edge = tokenNum("--inset", 16), w = this.w;
    const xt = scene.x(t), xr = scene.x(scene.ref), maxX = scene.w - edge - w;
    let x;
    if (inWindow) { x = xr - tokenNum("--space-24", 24) - w; if (x < minX) x = xt + gap; }
    else if (t < scene.ref) { x = xt - gap - w; if (x < minX) x = xt + gap; }
    else { x = xt + gap; if (x > maxX) x = xt - gap - w; }
    x = Math.round(clamp(x, minX, Math.max(minX, maxX)));
    const y = Math.round(scene.pad.t);
    const pos = `translate(${x}px, ${y}px)`;
    if (pos !== this.pos) { this.pos = pos; this.el.style.transform = pos; }
  }
}
