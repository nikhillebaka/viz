// Checks lib/selection.js against the rules in studies/models-goals.md.  Run: node design/tests/selection-check.mjs
import { ModelSelection } from "../lib/selection.js";

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : "  " + detail}`); if (!ok) failed++; };
const ids = (s) => s.charted.map((c) => c.m).join(",");
const slots = (s) => Object.fromEntries(s.charted.map((c) => [c.m, c.slot]));

let s = new ModelSelection({ selected: ["a", "b", "c", "d", "e", "f", "g"] });
check("first five selected are charted", ids(s) === "a,b,c,d,e", ids(s));
check("all seven are selected (evaluated)", s.selected.length === 7);
s.select("h");
check("selecting a sixth+ never changes the chart", ids(s) === "a,b,c,d,e", ids(s));

let before = slots(s);
s.chart("f");
check("charting with five charted removes the longest charted", ids(s) === "b,c,d,e,f", ids(s));
check("the new model takes the freed color", slots(s).f === before.a, JSON.stringify(slots(s)));
check("the others keep their colors", ["b", "c", "d", "e"].every((m) => slots(s)[m] === before[m]));

s.unchart("c");
check("unchart leaves the slot empty", ids(s) === "b,d,e,f", ids(s));
s.select("i");
check("a newly selected model fills a free slot", ids(s) === "b,d,e,f,i", ids(s));

s.deselect("b");
check("deselecting a charted model frees its slot for the next selected not charted", s.charted.length === 5 && !s.isCharted("b"), ids(s));
check("…but not one the user explicitly took off", !s.isCharted("c"), ids(s));

s = new ModelSelection({ selected: ["a", "b"] });
s.chart("z");
check("charting an unselected model selects it too", s.has("z") && s.isCharted("z"));
s.setMany(["p", "q", "r", "t"], true);
check("bulk select fills free slots only, one change", ids(s) === "a,b,z,p,q", ids(s));
s.setShowAll(true);
check("show all: context is every selected model not charted", s.context.join(",") === "r,t", s.context.join(","));
s.setBaseline(false);
check("baseline is a flag, never in the selection", !s.has("FluSight-baseline") && s.baseline === false);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
