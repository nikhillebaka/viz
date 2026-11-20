/* The page below the chart: each section is mounted when it nears the viewport. */
import { h } from "../lib/dom.js";

const SECTIONS = [
  { id: "scores", label: "Scores" },
  { id: "heatmap", label: "Heatmap" },
  { id: "map", label: "Map" },
  { id: "peaks", label: "Peaks" },
];

/** @returns {{ destroy(): void }} */
export function mountSections(root, ctx) {
  const wrap = h("div", { class: "app-sections" });
  root.append(wrap);
  const live = [];
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const el = e.target;
      import(`./${el.dataset.section}/index.js`)
        .then((m) => { el.classList.remove("is-pending"); live.push(m.mount(el, ctx)); })
        .catch((err) => {
          console.error(`viz: the ${el.dataset.section} section could not load`, err);
          el.replaceChildren(h("p", { class: "app-section-error" }, `Can't show ${el.getAttribute("aria-label").toLowerCase()}`));
        });
    }
  }, { rootMargin: "600px 0px" });
  for (const s of SECTIONS) {
    const el = h("section", { class: "app-section is-pending", id: s.id, "data-section": s.id, "aria-label": s.label });
    wrap.append(el);
    io.observe(el);
  }
  return { el: wrap, destroy() { io.disconnect(); live.forEach((l) => l?.destroy?.()); wrap.remove(); } };
}
