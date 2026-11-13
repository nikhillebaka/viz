/* Model selection: one selection, two uses (studies/models-goals.md).
 *  - selected: every model the user picked, in the order they were picked. All of them are evaluated.
 *  - charted: up to `max` (5) of them drawn in color on the fan chart, each holding a color slot (0–7)
 *    for as long as it stays charted. Default: the first five selected.
 *  - showAll: draw every other selected model as grey context.
 *  - baseline: whether the baseline is drawn (it is never in the list and never counts toward max).
 * Rules:
 *  - chart(m): puts m on the chart (selecting it if needed). If max are charted, the one charted longest
 *    comes off and m takes its color, so the others never change color.
 *  - unchart(m): takes m off and leaves the slot empty; an explicit choice, so nothing refills it.
 *  - select(m) fills a free slot with m. deselect(m) of a charted model frees its slot for the next
 *    selected model that isn't charted and wasn't explicitly taken off.
 *  - a charted model with no forecast keeps its slot (the chart decides how to show that). */
export class ModelSelection {
  constructor({ max = 5, colors = 8, selected = [], onChange = () => {} } = {}) {
    Object.assign(this, { max, colors, onChange });
    this.selected = []; this.charted = []; this.showAll = false; this.baseline = true;
    this.offByUser = new Set();
    for (const m of selected) this.select(m, { silent: true });
  }
  has(m) { return this.selected.includes(m); }
  slotOf(m) { return this.charted.find((c) => c.m === m)?.slot ?? null; }
  isCharted(m) { return this.slotOf(m) != null; }
  get context() { return this.showAll ? this.selected.filter((m) => !this.isCharted(m)) : []; }
  get hidden() { return this.selected.length - this.charted.length; }

  #freeSlot() { const used = new Set(this.charted.map((c) => c.slot)); for (let s = 0; s < this.colors; s++) if (!used.has(s)) return s; return 0; }
  #emit(silent) { if (!silent) this.onChange(this); }

  select(m, { silent = false } = {}) {
    if (this.has(m)) return;
    this.selected.push(m);
    if (this.charted.length < this.max) this.charted.push({ m, slot: this.#freeSlot() });
    this.#emit(silent);
  }
  deselect(m, { silent = false } = {}) {
    if (!this.has(m)) return;
    this.selected = this.selected.filter((x) => x !== m);
    this.offByUser.delete(m);
    if (this.isCharted(m)) {
      this.charted = this.charted.filter((c) => c.m !== m);
      const next = this.selected.find((x) => !this.isCharted(x) && !this.offByUser.has(x));
      if (next) this.charted.push({ m: next, slot: this.#freeSlot() });
    }
    this.#emit(silent);
  }
  toggle(m) { this.has(m) ? this.deselect(m) : this.select(m); }
  /* bulk: select or deselect a group (section checkbox, shift-click range). One change event. */
  setMany(ms, on) { for (const m of ms) on ? this.select(m, { silent: true }) : this.deselect(m, { silent: true }); this.#emit(); }

  chart(m) {
    if (this.isCharted(m)) return;
    if (!this.has(m)) this.selected.push(m);
    this.offByUser.delete(m);
    let slot;
    if (this.charted.length >= this.max) { const out = this.charted.shift(); slot = out.slot; } // longest charted comes off
    else slot = this.#freeSlot();
    this.charted.push({ m, slot });
    this.#emit();
  }
  unchart(m) {
    if (!this.isCharted(m)) return;
    this.charted = this.charted.filter((c) => c.m !== m);
    this.offByUser.add(m);
    this.#emit();
  }
  toggleChart(m) { this.isCharted(m) ? this.unchart(m) : this.chart(m); }
  setShowAll(on) { this.showAll = !!on; this.#emit(); }
  setBaseline(on) { this.baseline = !!on; this.#emit(); }
}

/* Families, teams and groups for the picker.
 * family: metadata `family` if present, else inferred from the name the way viz does now. A "family"
 * of one model isn't a family: those go to the last section, "By team", tagged with their team. */
export function inferFamily(id) {
  const name = id.includes("-") ? id.split("-").slice(1).join("-") : id;
  if (/(^|[_.\-])(ar\d*|autoreg)([_.\-]|$)/i.test(name)) return "AR";
  const first = name.split(/[_.\-]/)[0], lower = first.toLowerCase();
  const acronyms = ["gbqr", "ar", "arima", "lstm", "cnn", "gru", "eakf", "mobs", "cdc", "nhsn", "seir", "sir"];
  if (acronyms.includes(lower)) return first.toUpperCase();
  return first.charAt(0).toUpperCase() + first.slice(1);
}
export const teamOf = (id, meta) => meta?.team_abbr || (id.includes("-") ? id.split("-")[0] : id);

export function groupModels(ids, metaOf = () => ({})) {
  const fam = new Map();
  for (const id of ids) { const f = metaOf(id).family || inferFamily(id); if (!fam.has(f)) fam.set(f, []); fam.get(f).push(id); }
  const families = [], byTeam = new Map();
  for (const [f, ms] of fam) {
    if (ms.length > 1) families.push({ key: `fam:${f}`, title: f, models: ms.sort() });
    else for (const id of ms) { const t = teamOf(id, metaOf(id)); if (!byTeam.has(t)) byTeam.set(t, []); byTeam.get(t).push(id); }
  }
  families.sort((a, b) => a.title.localeCompare(b.title));
  const teams = [...byTeam].sort((a, b) => a[0].localeCompare(b[0])).map(([t, ms]) => ({ team: t, models: ms.sort() }));
  return { families, teams };
}
