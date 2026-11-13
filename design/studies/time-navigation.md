# Moving through time

Prototype: `studies/intervals-refine.html`. Motion, gestures and zoom live in `lib/time.js` (`TimeNav`);
the drawing is `fanChart({ t, domain })` in `lib/chart.js`.

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
- **Buttons and keys glide** on a critically damped spring that chases the target week (about 100 ms to
  look settled). It starts from the current position and velocity, so a new press mid-motion bends the
  path instead of restarting it: no speed surge per press, no backward step, and an exact landing. The
  snap after a drag or side scroll uses a softer spring and carries the flick's speed. The stepper label
  changes instantly to the target week. (A timed ease-out tween before this stepped backwards on its
  first frame, because the frame timestamp was earlier than the key press, and surged on every press.)
- **The dotted observed line is pinned to the data.** It starts at the first observed week and is
  clipped at the cutoff, so its dots travel with the data instead of crawling as the cutoff moves.
- **Performance:** at most one redraw per animation frame, with label text measurement cached. Reduced
  motion switches instantly. The hover readout hides while dragging, and misses only show on whole weeks.

- **Nothing pops when an animation lands.** Observed points follow the moving cutoff continuously: a
  point fills in over the week before the cutoff reaches it, and points fade out over the week past the
  scored window. Misses fade out and back in around each whole week. (Before this, the cutoff point and
  the point 3 weeks ahead appeared only on the final frame, which read as a flash forward.)
- **Desktop only** for now. Mobile will be a separate, simpler site or a "use desktop" page, so zoom and
  layout don't need phone-width rules.

## Zoom (built)

- **The camera follows the date.** Zoom state is a span in weeks, never absolute dates, so it survives
  date, model and location changes. Close up, the reference date keeps its place with 3 forecast weeks to
  its right, and zoom pivots on it, never the cursor. The y-axis stays fixed.
- **Two regimes.** Close up spans 6 to 20 weeks, continuously, and drag or side scroll scrubs the date.
  Season shows the whole season (first to last observed week, about 48 weeks) with the camera still; the
  forecast moves across it like a playhead, and a drag or tap places the date under the pointer.
  Between 20 weeks and Season the camera blends (log-space span, smoothstep on the endpoints) and is
  only passed through: on release it settles on the nearer end, weighted toward staying close up.
  Below 6 weeks it rubber-bands back.
- **Inputs:** trackpad pinch (ctrl + wheel) and Safari pinch gestures, ⌘/ctrl + mouse wheel (clamped
  per notch), bare = / - / 0 keys, double-click (close up → Season; in Season, zoom back in on the
  clicked week), and a Forecast / Season control in the bottom-right chrome. Plain vertical wheel
  does nothing. Gestures are 1:1 while held; springs only settle them.
- **Pan: ⌘ + side scroll** moves the view without moving the forecast (a camera offset in weeks), 1:1
  with the scroll, within the season, rubber-banding at its ends. Trackpad pinch (which arrives as
  ctrl + wheel) always zooms; ⌘ + vertical wheel zooms; ⌘ + horizontal pans. While panned, zoom keeps
  the middle of the view still. Changing the date with keys or the stepper, going to Season, double-
  clicking or pressing 0 glides the view back to the forecast; scrubbing keeps the pan. When the
  forecast is off-screen, a "← Dec 27 forecast" pill at that edge points to it and brings it back.
- **In Season,** the model labels ride at the fan's end, rulers are hidden, and the right margin
  shrinks from 168px to 56px with the blend.
- Season is where the evaluation window brush should live, so time selection is one concept
  app-wide. Past-forecast trails are held out of the first version.

## Open

- Whether the full redraw per frame stays smooth on slower machines once the liquid glass refracts the
  moving chart. If not: update persistent elements in place instead of rebuilding.
