# Parity with old viz

Every feature of old viz (`static/`, and the backend behind it), where it lives in `next/`, and
whether it is done. The line-by-line inventory (831 items, each with its source `file:line`) is in
`next/parity/`:

| File | Covers | Items |
|---|---|---|
| [parity/shell.md](parity/shell.md) | page shell, target, location, date, model bar, colors, theme, presentation mode, share, CLI, toasts, keys, URL, storage, startup, glossary, Guide, model detail, warnings | 246 |
| [parity/views.md](parity/views.md) | fan chart (and signals), spatial map, heatmap, season peak, with their endpoints | 326 |
| [parity/evaluation.md](parity/evaluation.md) | leaderboard, diagnostics, evaluation window, scoring rules, ensemble studio, live hubs, CLI parity, exports | 259 |

**How to use it.** A line is checked (`- [x]`) when the behaviour exists in `next/`, has a test, and has
been looked at. A line that is deliberately changed or dropped is marked `- [~]` with the reason
(a row below). Items tagged (bug), (quirk) or (dead) in the inventory are not ported as they are: the
intended behaviour is, and the row below says so.

## Where each area goes

| Old viz | In `next/` | Phase | Status |
|---|---|---|---|
| Target switch | Target bubble (only with more than one target) | 1 | built, first pass |
| Location quick picks + dropdown | Location bubble: search, recent places, tile map | 1 | built, first pass |
| Date stepper, date popover (search, season tabs, badges) | Date stepper + picker: season chips, a calendar of rounds | 1 | built, first pass |
| Model bar: search, family and season filters, chips, hub shelves, Select all / Clear | Model picker: search, sections (Local, families, hubs, not this season), bulk select | 1 | built, first pass |
| Fan chart: truth, forecasts, PI levels, width rulers, Truth toggle | The fan chart (`design/fan-chart.md`) | 1 | built, first pass |
| URL parameters, share link | `features/url.js`; Copy link in the ↓ menu | 1 (chart keys), 3 (rest) | built, first pass |
| Theme | Theme bubble | 1 | built, first pass |
| Signals & Indicators drawer (as-of reports, NSSP, ILINet, FluSurv-NET, past seasons, peaks; modes, palettes) | Layers on the fan chart | 2 | built, first pass |
| Leaderboard, telemetry strip, scope toolbar | Scores section: scope line, leaderboard | 3 | built, first pass |
| Diagnostics tabs (anatomy, calibration, horizon) | Figures under the leaderboard; expanded rows | 3 | built, first pass |
| Evaluation window popover | Dates popover in the scope line | 3 | built, first pass |
| Heatmap view | Heatmap section, sharing the scope | 3 | built, first pass |
| Exports, Copy CLI | ↓ menu in the scope line | 3 | built, first pass |
| Model detail modal | Expanded leaderboard row; details in the picker | 3 | built, first pass |
| Spatial map view | Map section | 4 | built, first pass |
| Season peak view | Peaks section | 4 | built, first pass |
| Ensemble studio | "Combine" on a selection, from the picker | 4 | built, first pass |
| Live hubs modal, brand menu | ⋯ bubble | 4 | built, first pass |
| Validation warnings | ⋯ bubble count; a glyph on affected rows | 4 | built, first pass |
| Guide / Methodology modal, glossary popovers | The Guide (⋯ → Guide, G, `#guide/<topic>`), ? links beside section headings | 4 | built, first pass |
| Presentation mode | — | 4 | deferred: owner wants a real design, not hidden buttons |
| Keyboard shortcuts | Kept where the action exists; modifier keys respected | 1–4 | built, first pass |

## Deliberate changes

From the brief (`design/HANDOFF.md` §5) plus what the inventory surfaced. **owner** = to confirm.

| Old viz | Now | Why |
|---|---|---|
| Shuffle colors (button, key C); 16-color palette for every model | Removed | Color means "on the chart": five stable slots, chosen to be distinct. Nothing to shuffle. |
| Stepper and ← → walk every date, including surveillance-only and off-season weeks | They walk forecast rounds; the observed line shows every week | Tried and set aside with the owner (HANDOFF §5). |
| Date popover: search grammar, model-count and Off-Season badges, Recent | Season chips and a calendar of rounds; "Latest" | Same. |
| Location quick picks (US, CA, NY, TX, FL, MA) | The last four places you used | The same shortcut, without a fixed list. |
| Truth is today's revised data everywhere except the As-of line | Same; As reported is a layer, and forecasts start from it while it is on | Scoring against the data as known at the time is not wanted (owner). |
| No hover values on the fan chart | Exact values for every week, model and interval | A gap in old viz. |
| Chart heading and sub-heading text | None: the bubbles name the target, place and date | Controls are the labels of what they control. |
| Telemetry strip, generated advice, calibration status words | Dropped | HANDOFF §5. |

## Old bugs not carried over

Recorded so nobody "restores" them: the model Season filter's missing import; `setEvalScope("all")`
setting TIME to Date; the season-curve spinner that never stops on a failed fetch; heatmap detail
lookups that miss whenever the axes are swapped (and the sorts, scaling and dividers that then act on
the wrong axis); "Best Performance" sorting by whatever metric is selected; the spatial map rounding
proportions to 0.0; shortcuts that fire with ⌘/Ctrl held (⌘C shuffled colors); the export ranking
inactive rows in sort order; `hm_pal` read from the URL but never written; "7Q" shown for any model
without all 23 quantiles; the small-sample text saying "N ≤ 10" for a rule of N < 10.
