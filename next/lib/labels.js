/**
 * Labels along one line, kept from touching: the ones that fit, in their original order. Where two would
 * overlap (with `gap` between them), the higher `pri` stays (a month that carries its year, a season's
 * first month), then the earlier one. Nothing moves, so what fits looks exactly as before.
 * @param {{ x: number, text: string, pri?: number, align?: "left" | "center" | "right" }[]} items
 * @param {(text: string) => number} measure width in px
 * @param {number} [gap=6]
 * @returns {object[]} the items to draw
 */
export function fitLabels(items, measure, gap = 6) {
  const spans = items.map((it, i) => {
    const w = measure(it.text), x0 = it.align === "center" ? it.x - w / 2 : it.align === "right" ? it.x - w : it.x;
    return { it, i, a: x0, b: x0 + w };
  });
  const kept = [];
  for (const o of [...spans].sort((p, q) => (q.it.pri || 0) - (p.it.pri || 0) || p.i - q.i)) {
    if (kept.every((k) => o.b + gap <= k.a || o.a >= k.b + gap)) kept.push(o);
  }
  return kept.sort((p, q) => p.i - q.i).map((k) => k.it);
}
