/* Model selection: which models are selected (evaluated) and which five are charted in color.
 * Rules: design/studies/models-goals.md ("Which five are charted").
 *
 * A selection is a frozen plain value; every function returns a new one (or the same one when nothing
 * changes, so a store can skip a no-op):
 *   { selected: [id],                    every model picked, in the order picked; all are evaluated
 *     charted:  [{ id, slot, seq }],     at most MAX, each holding a color slot 0–7 while it stays charted;
 *                                        seq orders the queue (lowest = charted longest)
 *     showAll:  bool,                    grey context lines for the rest of the selection
 *     baseline: bool,                    the baseline is drawn (never in `selected`, never takes a slot)
 *     taken:    [id] }                   selected models explicitly taken off the chart: never auto-refilled
 *
 *  - chart(id) puts id on the chart (selecting it if needed). With MAX charted, the one charted longest
 *    comes off and id takes its color, so the others never change color.
 *  - unchart(id) takes it off and leaves the slot empty: an explicit choice, so nothing refills it.
 *  - select(id) fills a free slot. deselect(id) of a charted model frees its slot for the next selected
 *    model that isn't charted and wasn't taken off.
 *  - A charted model with no forecast keeps its slot (the chart decides how to show that). */

export const MAX = 5;
export const COLORS = 8;

const freeze = (s) => Object.freeze({
  selected: Object.freeze([...s.selected]),
  charted: Object.freeze(s.charted.map((c) => Object.freeze({ id: c.id, slot: c.slot, seq: c.seq }))),
  showAll: !!s.showAll,
  baseline: s.baseline !== false,
  taken: Object.freeze([...s.taken]),
});
const freeSlot = (charted) => { const used = new Set(charted.map((c) => c.slot)); for (let s = 0; s < COLORS; s++) if (!used.has(s)) return s; return 0; };
const nextSeq = (charted) => charted.reduce((m, c) => Math.max(m, c.seq), -1) + 1;

/** @param {object} sel @param {string} id @returns {boolean} */
export const isSelected = (sel, id) => sel.selected.includes(id);
/** @param {object} sel @param {string} id @returns {number | null} the model's color slot, or null when not charted */
export const slotOf = (sel, id) => sel.charted.find((c) => c.id === id)?.slot ?? null;
/** @param {object} sel @param {string} id @returns {boolean} */
export const isCharted = (sel, id) => sel.charted.some((c) => c.id === id);

/**
 * A new selection: `selected` in order, the first MAX charted in slots 0…
 * @param {{ selected?: string[], showAll?: boolean, baseline?: boolean }} [o]
 * @returns {object} a frozen selection
 */
export function create({ selected = [], showAll = false, baseline = true } = {}) {
  let s = freeze({ selected: [], charted: [], showAll, baseline, taken: [] });
  for (const id of selected) s = select(s, id);
  return s;
}

/**
 * A selection restored from lists (the URL): `charted` gives ids by color slot (null for a free slot).
 * Charted ids missing from `selected` are added to it; at most MAX are charted. The queue order is the
 * slot order. Unless `taken` is given, when fewer than MAX are charted, the selected models that are not
 * charted count as taken off (they would otherwise have filled the free slots), so nothing jumps onto
 * the chart that wasn't on it.
 * @param {{ selected?: string[], charted?: (string | null)[], showAll?: boolean, baseline?: boolean, taken?: string[] }} o
 * @returns {object} a frozen selection
 */
export function fromLists({ selected = [], charted = [], showAll = false, baseline = true, taken } = {}) {
  const sel = [...new Set(selected)], ch = [];
  charted.slice(0, COLORS).forEach((id, slot) => {
    if (id == null || id === "" || ch.length >= MAX || ch.some((c) => c.id === id)) return;
    if (!sel.includes(id)) sel.push(id);
    ch.push({ id, slot, seq: ch.length });
  });
  const off = taken ?? (ch.length < MAX ? sel.filter((id) => !ch.some((c) => c.id === id)) : []);
  return freeze({ selected: sel, charted: ch, showAll, baseline, taken: off.filter((id) => sel.includes(id) && !ch.some((c) => c.id === id)) });
}

/**
 * Selects id (appended) and charts it in the first free slot if fewer than MAX are charted.
 * @param {object} sel @param {string} id @returns {object}
 */
export function select(sel, id) {
  if (isSelected(sel, id)) return sel;
  const charted = sel.charted.length < MAX ? [...sel.charted, { id, slot: freeSlot(sel.charted), seq: nextSeq(sel.charted) }] : sel.charted;
  return freeze({ ...sel, selected: [...sel.selected, id], charted });
}

/**
 * Deselects id. If it was charted, its slot goes to the next selected model that is neither charted nor
 * taken off.
 * @param {object} sel @param {string} id @returns {object}
 */
export function deselect(sel, id) {
  if (!isSelected(sel, id)) return sel;
  const selected = sel.selected.filter((x) => x !== id), taken = sel.taken.filter((x) => x !== id);
  let charted = sel.charted;
  if (isCharted(sel, id)) {
    charted = charted.filter((c) => c.id !== id);
    const next = selected.find((x) => !charted.some((c) => c.id === x) && !taken.includes(x));
    if (next) charted = [...charted, { id: next, slot: freeSlot(charted), seq: nextSeq(charted) }];
  }
  return freeze({ ...sel, selected, charted, taken });
}

/** @param {object} sel @param {string} id @returns {object} */
export const toggle = (sel, id) => (isSelected(sel, id) ? deselect(sel, id) : select(sel, id));

/**
 * Selects or deselects a group, in order, as one change.
 * @param {object} sel @param {Iterable<string>} ids @param {boolean} on @returns {object}
 */
export function setMany(sel, ids, on) {
  let s = sel;
  for (const id of ids) s = on ? select(s, id) : deselect(s, id);
  return s;
}

/**
 * Charts id (selecting it if needed). With MAX charted, the one charted longest comes off and id takes
 * its slot.
 * @param {object} sel @param {string} id @returns {object}
 */
export function chart(sel, id) {
  if (isCharted(sel, id)) return sel;
  const selected = isSelected(sel, id) ? sel.selected : [...sel.selected, id];
  const taken = sel.taken.filter((x) => x !== id);
  let charted = sel.charted, slot;
  if (charted.length >= MAX) {
    const out = charted.reduce((a, c) => (c.seq < a.seq ? c : a));
    slot = out.slot;
    charted = charted.filter((c) => c !== out);
  } else slot = freeSlot(charted);
  charted = [...charted, { id, slot, seq: nextSeq(sel.charted) }];
  return freeze({ ...sel, selected, charted, taken });
}

/**
 * Takes id off the chart; the slot stays empty and id is remembered as taken off.
 * @param {object} sel @param {string} id @returns {object}
 */
export function unchart(sel, id) {
  if (!isCharted(sel, id)) return sel;
  return freeze({ ...sel, charted: sel.charted.filter((c) => c.id !== id), taken: [...sel.taken, id] });
}

/** @param {object} sel @param {string} id @returns {object} */
export const toggleChart = (sel, id) => (isCharted(sel, id) ? unchart(sel, id) : chart(sel, id));

/** @param {object} sel @param {boolean} on @returns {object} */
export const setShowAll = (sel, on) => (sel.showAll === !!on ? sel : freeze({ ...sel, showAll: !!on }));

/** @param {object} sel @param {boolean} on @returns {object} */
export const setBaseline = (sel, on) => (sel.baseline === !!on ? sel : freeze({ ...sel, baseline: !!on }));

/**
 * The grey context models: selected and not charted, when showAll is on.
 * @param {object} sel @returns {string[]} in selection order (empty when showAll is off)
 */
export const context = (sel) => (sel.showAll ? sel.selected.filter((id) => !isCharted(sel, id)) : []);

/**
 * Charted ids by color slot, null for a free slot, trailing nulls dropped (for the URL).
 * @param {object} sel @returns {(string | null)[]}
 */
export function chartedBySlot(sel) {
  const out = [];
  for (const c of sel.charted) out[c.slot] = c.id;
  return Array.from(out, (x) => x ?? null);
}
