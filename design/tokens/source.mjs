/* Single source of truth for the viz design tokens.
   Run `node design/tokens/build.mjs` to regenerate tokens.css and tokens.json.
   Every value here was chosen in the design sessions (Nov 2026); the comments say why. */

// --- spring easing -------------------------------------------------------
// Springs are expressed as CSS linear() curves so plain CSS transitions and
// the Web Animations API can both use them.
export function spring(stiffness, damping) {
  let x = 0, v = 0, t = 0;
  const dt = 1 / 120, pts = [0];
  for (let i = 1; i < 600; i++) {
    v += (-stiffness * (x - 1) - damping * v) * dt; x += v * dt; t += dt;
    if (i % 4 === 0) pts.push(+x.toFixed(4));
    if (t > 0.3 && Math.abs(x - 1) < 0.0015 && Math.abs(v) < 0.02) break;
  }
  pts.push(1);
  return { easing: `linear(${pts.join(", ")})`, duration: Math.round(t * 1000) };
}

// --- color ---------------------------------------------------------------
// Two themes with identical names. Dark is pure black (no blue tint, no gradients);
// light is the studies2 light theme. Model colors: pastel on black, vivid on light
// (same hues, same order). Past 8 models, colors repeat from 1. Baseline is always grey.
export const color = {
  dark: {
    "surface-page": "#000000",
    "surface-chart": "#0b0b0b",
    "surface-raised": "#171717",
    "ink-primary": "#f5f5f5",
    "ink-secondary": "#b3b3b3",
    "ink-tertiary": "#7a7a7a",
    "ink-faint": "#474747",
    "line-hairline": "#1f1f1f",
    "line-axis": "#2e2e2e",
    "glass-tint": "rgba(12, 12, 12, 0.28)",
    "glass-frost": "rgba(28, 28, 28, 0.55)",
    "glass-stroke": "rgba(255, 255, 255, 0.12)",
    "glass-highlight": "rgba(255, 255, 255, 0.22)",
    "glass-shade": "rgba(0, 0, 0, 0.18)",
    "glass-shadow": "0 18px 40px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.25)",
    "glass-text-shadow": "0 1px 8px rgba(0, 0, 0, 0.25)",
    "fill-hover": "rgba(255, 255, 255, 0.06)",
    "fill-selected": "rgba(255, 255, 255, 0.14)",
    "fill-field": "rgba(255, 255, 255, 0.08)",
    "accent": "#0a84ff",
    "series-1": "#83e5bc", "series-2": "#71c9fa", "series-3": "#ffb481", "series-4": "#f1a1ce",
    "series-5": "#f1d680", "series-6": "#f599a5", "series-7": "#c2a7f4", "series-8": "#bcdf90",
    "series-baseline": "#9a9a9a",
    // interval band fill strength: default (every model) and focused. Dark needs a touch more.
    "band-whisper": "0.075", "band-focus": "0.15",
    "heat-better": "#38bdf8",
    "heat-neutral": "#2b2b2b",
    "heat-worse": "#fb7185",
    "status-good": "#30d158",
    "status-warning": "#ff9f0a",
    "status-error": "#ff453a",
  },
  light: {
    "surface-page": "#f2f2f5",
    "surface-chart": "#fafafb",
    "surface-raised": "#ffffff",
    "ink-primary": "#1d1d1f",
    "ink-secondary": "#5d5d63",
    "ink-tertiary": "#8e8e93",
    "ink-faint": "#c7c7cc",
    "line-hairline": "#e3e3e8",
    "line-axis": "#d1d1d6",
    "glass-tint": "rgba(255, 255, 255, 0.44)",
    "glass-frost": "rgba(250, 250, 252, 0.72)",
    "glass-stroke": "rgba(0, 0, 0, 0.08)",
    "glass-highlight": "rgba(255, 255, 255, 0.9)",
    "glass-shade": "rgba(0, 0, 0, 0.06)",
    "glass-shadow": "0 18px 40px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.08)",
    "glass-text-shadow": "0 1px 8px rgba(255, 255, 255, 0.6)",
    "fill-hover": "rgba(0, 0, 0, 0.045)",
    "fill-selected": "rgba(0, 0, 0, 0.08)",
    "fill-field": "rgba(118, 118, 128, 0.12)",
    "accent": "#007aff",
    "series-1": "#05ac7d", "series-2": "#0891c9", "series-3": "#ec6f00", "series-4": "#de03a2",
    "series-5": "#d6a20a", "series-6": "#ec0050", "series-7": "#8738f8", "series-8": "#72ad04",
    "series-baseline": "#8a8a8f",
    "band-whisper": "0.06", "band-focus": "0.13",
    "heat-better": "#268bd2",
    "heat-neutral": "#e6e6ea",
    "heat-worse": "#cb4b16",
    "status-good": "#34c759",
    "status-warning": "#ff9500",
    "status-error": "#ff3b30",
  },
};
export const seriesNames = ["mint", "sky", "peach", "pink", "butter", "rose", "lavender", "lime"];

// --- type ----------------------------------------------------------------
// Inter for the interface; Instrument Serif only for the rare big title (at most
// one per screen); Geist Mono for numbers on charts, tables, axes and code.
export const fontFamily = {
  serif: '"Instrument Serif", "Iowan Old Style", Georgia, serif',
  sans: '"Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  mono: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace',
};
// [family, weight, size px, line-height px, letter-spacing em, transform, style, use]
export const type = {
  "display-lg": ["serif", 400, 56, 60, -0.01, "none", "normal", "Big location name on the forecast view; page title of a major view. At most one per screen."],
  "display-sm": ["serif", 400, 36, 40, -0.005, "none", "normal", "Secondary hero, e.g. a model name heading its detail page."],
  "display-italic": ["serif", 400, 36, 40, -0.005, "none", "italic", "A single accent word or an empty-state line. Rare."],
  "title-1": ["sans", 700, 28, 34, -0.022, "none", "normal", "Section or panel heading."],
  "title-2": ["sans", 600, 20, 26, -0.015, "none", "normal", "Sub-section heading, popover title."],
  "title-3": ["sans", 600, 16, 22, -0.01, "none", "normal", "Card or group heading."],
  "body": ["sans", 400, 14, 21, 0, "none", "normal", "Running text, descriptions."],
  "body-strong": ["sans", 500, 14, 21, 0, "none", "normal", "Emphasis in body text, list rows."],
  "small": ["sans", 400, 12, 16, 0, "none", "normal", "Metadata, footnotes."],
  "label-control": ["sans", 500, 13, 16, 0, "none", "normal", "Pills, buttons, segmented controls, menu items."],
  "label-section": ["sans", 600, 11, 14, 0.08, "uppercase", "normal", "Small uppercase section labels, in ink-tertiary."],
  "label-chart": ["sans", 500, 11.5, 14, 0, "none", "normal", "Model names on the chart, month labels."],
  "numeric-hero": ["sans", 600, 32, 36, -0.02, "none", "normal", "Headline figures. Use tabular figures."],
  "numeric-value": ["mono", 500, 12, 16, 0, "none", "normal", "Values on the chart and in tables."],
  "numeric-axis": ["mono", 400, 10.5, 14, 0, "none", "normal", "Axis ticks and quiet numbers, in ink-tertiary."],
  "numeric-code": ["mono", 400, 12, 18, 0, "none", "normal", "CLI commands, file paths, model IDs."],
};

// --- dimensions ----------------------------------------------------------
export const space = [2, 4, 8, 12, 16, 20, 24, 32, 40, 56, 72];
export const radius = { tag: 6, field: 10, menu: 14, popover: 22, card: 28, pill: 999 };
export const size = { "control-sm": 30, control: 38, "control-lg": 44, icon: 16 };
export const stroke = { series: 1.75, observed: 1.25, hairline: 1, glass: 0.5 };

// --- layout --------------------------------------------------------------
// Size classes are decided by the width of the view the chrome sits in (container queries),
// not the window, so a component behaves the same in a full page, a split view or an embed.
//   compact  < 600px  (phones, narrow panes)
//   regular  600–1023 (tablets, half-screen windows)
//   wide     >= 1024
export const layout = {
  compact: 600,
  wide: 1024,
  "inset-compact": 12,   // gap between floating chrome and the view edge (plus the safe area)
  "inset-regular": 16,
  "zone-gap": 8,         // gap between controls inside one placement zone
  "touch-target": 44,    // minimum hit area on touch screens (Apple HIG)
  "menu-max-width": 320,
  "popover-width": 360,
  "sheet-max-height": 0.85, // fraction of the view height a bottom sheet may take
};
// Layering, lowest to highest. Never invent new z-index values outside this list.
export const z = { chart: 0, chrome: 10, popover: 20, sheet: 30, toast: 40, tooltip: 50 };
// Interaction timing (ms)
export const timing = {
  "tooltip-delay": 500,   // hover before a tooltip appears; focus shows it at once
  "tooltip-skip": 300,    // moving between controls within this window skips the delay
  "toast": 3200,          // time a toast stays; paused while hovered or focused
  "long-press": 400,      // hold before a stepper starts repeating
  "repeat": 90,           // repeat interval once it has started
};

// --- glass ---------------------------------------------------------------
// Liquid glass = a refracted copy of the chart inside the control (study 01).
// Only on floating controls; never on content surfaces; never glass on glass.
// The edge is the same physical thickness on every control, so a 38px pill and a 68px lens
// read as the same material (tuned to the top bar).
export const glass = {
  refraction: 28,     // px: how far content is displaced at the very edge
  rim: 14,            // px: width of the refracting rim (capped at half the control's short side)
  rimPower: 2.0,      // how sharply refraction falls off from the edge
  magnify: 0.1,       // gentle convex magnification across the whole body
  dispersion: 0.025,  // red and blue bend this much more/less than green (barely-there color fringe at the rim)
  blur: 0.6,          // px blur on the refracted copy
  saturate: 1.35,     // saturation boost on what shows through
  brightness: 1.06,   // brightness boost on what shows through
  frostBlur: 24,      // px backdrop blur for the frosted fallback (panels with text)

  // Appearance (Apple's Liquid Glass behaviour)
  adaptLight: 0.22,   // smoothed luminance under a control above which it switches to dark text
  adaptDark: 0.14,    // ...and below which it switches back. Black and white text are equally
                      //    legible at ~0.18; the gap between the two is a dead zone against flicker
  adaptDwell: 220,    // ms the new state must hold before the text actually switches
  adaptSmoothing: 0.4,// weight of each new reading in the running average (lower = steadier)
  flipMaxHeight: 80,  // controls this tall or shorter flip text colour; larger glass (panels) never does
  veil: 2.2,          // how much the tint thickens per unit of contrast spread underneath
  veilMax: 0.6,       // cap on that extra tint
};
// When glass sits over content much lighter or darker than the theme, it borrows the
// other theme's ink so text stays readable (study 10).
export const glassAdapt = {
  light: { "ink-primary": "#1d1d1f", "ink-secondary": "#5d5d63", "ink-tertiary": "#8e8e93", "glass-tint": "rgba(255, 255, 255, 0.42)", "glass-frost": "rgba(250, 250, 252, 0.72)", "glass-text-shadow": "0 1px 8px rgba(255, 255, 255, 0.5)", "fill-selected": "rgba(0, 0, 0, 0.1)" },
  dark: { "ink-primary": "#f5f5f5", "ink-secondary": "#c9c9c9", "ink-tertiary": "#8a8a8a", "glass-tint": "rgba(12, 12, 12, 0.36)", "glass-frost": "rgba(28, 28, 28, 0.55)", "glass-text-shadow": "0 1px 8px rgba(0, 0, 0, 0.3)", "fill-selected": "rgba(255, 255, 255, 0.16)" },
};

// --- motion --------------------------------------------------------------
export const motion = {
  "spring": spring(210, 22),        // default: controls, morphs, panels
  "spring-soft": spring(170, 24),   // large movements, toolbars, page-level
  "fade": { easing: "cubic-bezier(0.2, 0, 0, 1)", duration: 160 },
};
