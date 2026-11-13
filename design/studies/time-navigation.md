# Moving through time

Regression check: `tests/time-nav-check.js` covers every behaviour below (34 cases;
`run({ rulers: true })` repeats them with the width rulers on). Run it on the
prototype page after any change: `(await import("/tests/time-nav-check.js")).run()`.

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
- **The date label rolls** (`rollText` in `lib/controls.js`, from study 07). Each digit is a 0–9 strip
  that rolls to its new value (ones digit first); a changed word, like the month, slides up when going
  forward and down when going back. If the shape changes (Dec 27 → Jan 3), the whole label slides.
  300 ms, no overshoot, clipped to the pill; fast stepping retargets mid-roll. While scrubbing, the
  label rolls to each week as it's crossed (`Stepper.show`), without announcing every one.
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
- **One camera for date, zoom and pan.** The view is exactly `span` weeks wide. Its centre follows the
  date (keeping the reference date where it sits at that span; past 20 weeks, where it sits at 20),
  fading toward the season's centre as zoom approaches the full season, and kept inside the season.
  The pan is added on top, so ⌘ + side scroll works at every zoom short of the full season.
- **One continuous zoom, no modes.** Pinch anywhere from 6 weeks to the whole season (about 48
  weeks, a hard stop) and leave it at any span. Up to 20 weeks the camera follows the date. From 20
  weeks to the full season it gradually stops following (log space, smoothstep) until, fully out, it
  stands still and the forecast moves across it like a playhead. A drag moves whatever the camera
  moves more: the content while it mostly follows (drag right for earlier, 1:1 close up), the forecast
  once it mostly stands still (drag right for later, fan under the pointer, and a tap jumps to the week
  tapped). Side scroll always means "scroll right for later". Below 6 weeks it rubber-bands back.
  (A first version snapped to either "close up" or "Season" with a switch in the chrome; removed.)
- **Inputs:** trackpad pinch (ctrl + wheel) and Safari pinch gestures, ⌘/ctrl + mouse wheel (clamped
  per notch), bare = / - / 0 keys, double-click (zoom fully out; when fully out, zoom back in on the
  clicked week). Plain vertical wheel
  does nothing. Gestures are 1:1 while held; springs only settle them.
- **Pan: ⌘ + side scroll or ⌘ + drag** moves the view without moving the forecast (a camera offset in weeks), 1:1
  with the scroll, within the season, rubber-banding at its ends. Trackpad pinch (which arrives as
  ctrl + wheel) always zooms; ⌘ + vertical wheel zooms; ⌘ + horizontal pans. While panned, zoom keeps
  the middle of the view still.
- **The pan is kept.** While the forecast is on screen (its reference line and whole 3-week fan),
  scrubbing, arrow keys and the stepper change the date around it, and the reference line stays
  exactly where it was left. While it is off-screen, plain side scroll and drag pan as well, as if ⌘
  were held, until the view is back at its home position (where the recenter pill would put it); from
  that point the rest of the same gesture scrubs. Using home rather than "visible again" makes the
  hand-off happen at the same place from either side (visible-again came early from the left, where
  the reference line clears the edge first). A new ⌘ pan sets a new resting place. Arrow keys and
  the stepper with the forecast off-screen bring it back to its home position, as do Season,
  double-click and 0. A "← Dec 27 forecast" pill at the edge points to an off-screen forecast and
  brings it back.
- **Panning into the past was slow** because the model labels, pushed off the right edge, were being
  fitted into negative room one dropped letter (and one text measurement) at a time, every frame.
  Off-screen labels are now skipped; a frame costs under 1 ms in every pan position.
- **Scroll speed adapts to zoom.** Side-scroll scrubbing is 1:1 with the content at the home span,
  but never faster than 1 week per 3/4 of a home-span week's width, so wide zooms and Season don't fly
  through dates (Season went ~4 weeks per small flick; now 100 px ≈ 1.1 weeks, close to the home
  pace of 100 px ≈ 0.9). A pointer drag stays exactly 1:1, since it holds the content; panning stays 1:1.
- **Width rulers work at every zoom** and move with the fan every frame. They sit in the margin beside
  the fan and the model labels step aside for them, so turning them on never narrows the plot or
  rescales the chart. The toggle fades and slides them in over ~180 ms. (They had been switched off past
  20 weeks by a leftover from the two-mode zoom, and turning them on used to narrow the plot.)
- **A flick needs motion at release.** A drag that pauses before letting go settles where it is; the
  momentum used to be measured from the last moves even after a pause.
- Season is where the evaluation window brush should live, so time selection is one concept
  app-wide. Past-forecast trails are held out of the first version.

## Open

- Whether the full redraw per frame stays smooth on slower machines once the liquid glass refracts the
  moving chart. If not: update persistent elements in place instead of rebuilding.
