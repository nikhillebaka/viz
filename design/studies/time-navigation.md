# Moving through time

Prototype: `studies/intervals-refine.html`. The drawing is `fanChart({ t })` in `lib/chart.js`.

## Decisions (Nov 12, 2026)

- **One continuous position.** The chart is drawn at a fractional date index `t`. Between two forecast
  dates, every forecast point (the anchor plus four weeks) moves from its position in one forecast to
  its position in the next. The fan slides and reshapes continuously, its root travels along the observed
  line, and the observed line splits from solid to dotted exactly at the moving cutoff. The view slides
  with it, and the y-axis never moves.
- **Drag scrubs the date.** It follows the pointer 1:1 (one week per week-width dragged, drag right for
  earlier). Past the first and last date it rubber-bands, with resistance topping out under two weeks.
  On release it snaps to a week, carrying a flick's momentum (~120 ms worth), in 200 ms.
- **Side scroll scrubs too** (trackpad swipe, or shift + mouse wheel): 1:1 with the scroll, the same
  rubber band at the ends, and a snap to the nearest week 140 ms after scrolling stops (so a trackpad's
  own momentum plays out first). Mostly-vertical scrolls are ignored. No scrollbars, and the page
  can't overscroll or trigger swipe-to-go-back.
- **Buttons and keys glide.** The stepper, its hold-to-repeat and the left/right keys move to the new
  week in 140 ms with an ease-out. Each press retargets from wherever the chart is; nothing queues, so
  fast clicking or a held key just moves faster. The stepper label changes instantly to the target week.
- **Performance:** at most one redraw per animation frame, with label text measurement cached. Reduced
  motion switches instantly. The hover readout hides while dragging, and misses only show on whole weeks.

## Open

- Whether the full redraw per frame stays smooth on slower machines once the liquid glass refracts the
  moving chart. If not: update persistent elements in place instead of rebuilding.
- A "Season" zoom to see the whole season with the current forecast in place (pinch / ⌘-scroll).
