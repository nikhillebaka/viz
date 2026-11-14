# Main chart panel: the four views (feature inventory of the old frontend)

Scope: the fan chart ("timeline"), spatial map, heatmap and season peak views of the old Plotly app in `static/`, plus the endpoints that feed them. App shell, modals, leaderboard, diagnostics, eval window, ensembles and live hubs are covered elsewhere.

File abbreviations: `fc` = `static/js/components/forecast_chart.js`, `sm` = `static/js/components/spatial_map.js`, `hm` = `static/js/components/heatmap_view.js`, `pv` = `static/js/components/peak_view.js`, `main` = `static/js/main.js`, `st` = `static/js/state.js`, `const` = `static/js/constants.js`, `ctl` = `static/js/components/controls.js`, `html` = `static/index.html`, `srv` = `server.py`, `dl` = `core/data_loader.py`, `pk` = `core/peaks.py`, `pd` = `core/peak_data.py`.

## Shared: view switching and panel chrome

- [ ] **Four views**: segmented control `#view-mode-segmented` with buttons "Timeline Fan", "US Spatial Map" (with a BETA badge), "Heatmap", "Season Peak"; values `timeline | spatial | heatmap | peak`; unknown value falls back to `timeline`. (html:310-328, sm:13-14)
- [ ] **Switch side effects**: sets `body.view-spatial|view-heatmap|view-peak`, marks the active segment, shows only the active container (`#forecast-plot`, `#spatial-container`, `#heatmap-container`, `#peak-container`), stops spatial playback when leaving spatial, updates the URL. (sm:15-55)
- [ ] **Signals & Indicators button/drawer are fan-chart only**: `#btn-indicators-toggle` and `#indicators-drawer` hidden in the other three views; the drawer's open/closed state is restored on return. (sm:38-46, main:445-449)
- [ ] **Per-view render on switch**: spatial fetches only if cached data is for another date/target, else re-renders; heatmap always refetches; peak always refetches; timeline refetches `/api/forecast`. Each triggers a Plotly resize. (sm:57-90)
- [ ] **Panel heading/subheading**: timeline and peak show the location name ("US National" for US, else "Name (AB)") and "Reference Date: YYYY-MM-DD (Cutoff: ref−7d) • Target: …"; peak shows "Season Peak · Round YYYY-MM-DD (Cutoff: …) • Target: <timing target> · <size target>" and maps aggregate locations to US; spatial shows "US Geographic Predictions & Epidemic Wave Tracking" / "State-Level Choropleth · Population-Adjusted Rates & Trajectories". (ctl:951-988, sm:58-59)
- [ ] **Heatmap heading is overwritten**: switchViewMode sets "Spatio-Temporal Epidemic Heatmap & Cross-Sectional Matrix", but the following `onHeaderUpdate` (updateHeaderContext) replaces it with the location heading because only spatial is special-cased. (sm:72-74, ctl:955)
- [ ] **Active-signal badge in subheading**: "N Signal(s)" plus " (Normalized)" in normalized mode, hidden when no indicators. (main:632-638)
- [ ] **Keyboard**: `H` → heatmap view; `P` → toggles peak ↔ timeline; `I` → toggles the spatial or heatmap inspector; `C` shuffles model colors and re-renders the active view; `T` theme; `F` presentation; `←/→` step date (all ignored while typing in inputs/selects). (main:1184-1249)
- [ ] **Theme re-render**: theme switch re-renders the active view; all four views read `body.theme-light` for colors. (main:714-739)
- [ ] **Fetch error banner**: `setFetchError(plotId, msg)` inserts a `.fetch-error-banner[role=alert]` above the plot (kept data stays visible below); cleared on next success. (const:843-858)
- [ ] **Global refresh**: any change of date, location, target or model selection (and date stepping) runs `refreshAll`: updates the URL, refetches only the active view (forecast, spatial, heatmap or peak) plus the leaderboard metrics. (main:301-313)
- [ ] **Color shuffle re-render**: shuffle re-renders whichever view is active from cached data (no refetch). (main:1215-1232, 1325-1341)
- [ ] **Initial view from URL**: a non-timeline `view` triggers switchViewMode at startup instead of the forecast fetch. (main:182-186)
- [ ] **Request guards**: every view fetch uses `createRequestGuard` so stale responses are dropped and `AbortError` is silent. (sm:124, hm:578, pv:29, main:323)
- [ ] **Presentation mode**: tighter margins in fan/map; heatmap fills 100% height; presentation bar PI menu shown only on timeline, Truth toggle hidden on spatial. (main:371-450)

# Fan chart

## Data and endpoint

- [ ] **GET /api/forecast**: params `target` (default config default target), `location` (default `US`), `date` (required, 400 "Missing 'date' parameter"), `models` (comma list). Response `{target, location, reference_date, truth, surveillance, models, peaks}`. Frontend sends the selected models only. (srv:371-407, api.js:35-37)
- [ ] **truth payload**: `{history, future, anchor, season_remainder, season_peak, peak_to_date, season_start_date, season_end_date}`; all `[{date, value}]`. (dl:827-954)
- [ ] **Truth source and vintage**: oracle rows for target+location, newest `as_of` per `target_end_date` (i.e. the latest revised value, not the value as known at the round); for targets containing "hosp" the admissions table fills dates missing from the oracle. (dl:836-874)
- [ ] **Focal season bounds**: MMWR week 31 to week 30 of the season containing the reference date; if no truth in the season the full series is used. (dl:888-903)
- [ ] **history**: last 16 observations with `season_start ≤ date < reference_date`. **future**: first 4 observations with `date ≥ reference_date` in season. **anchor**: last history point (or null). (dl:905-927)
- [ ] **season_remainder**: only when more in-season weeks exist after the 4 future weeks; starts at the last future date (overlapping it) to season end. (dl:929-936)
- [ ] **season_peak / peak_to_date**: season_peak = max over the whole focal season including weeks after the round (hindsight); peak_to_date = max of the 16-week history tail only. Empty truth returns zeros/nulls. (dl:938-943, 876-886)
- [ ] **models[]**: per selected model with quantile rows at that round/location/target, `horizon ≥ 0`: `{model_id, target_end_dates, horizons, median, q95_lower/upper (0.025/0.975), q80_lower/upper (0.10/0.90), q50_lower/upper (0.25/0.75)}`, sorted by horizon; missing quantile → nulls; models with no rows are omitted. (dl:1211-1274)
- [ ] **surveillance payload**: `{location, reference_date, nssp, ilinet, flusurvnet, prior_season, unrevised, as_of, historical_seasons}`; window = ref − 30 weeks to ref + 12 weeks (so indicator data after the round is included). (dl:956-988)
- [ ] **NSSP**: oracle target `wk inc flu prop ed visits`, newest as_of per date; each point `{date, value, pct = value×100 (2dp)}`; `peak`. (dl:990-1021)
- [ ] **ILINet**: `ilinet` table `inc` → `{date, pct (3dp)}` ("Scaled ILI+"). **FluSurv-NET**: `inc` → `{date, rate (2dp)}`. Both with `peak`. (dl:1023-1081)
- [ ] **historical_seasons**: every season other than the round's season, keyed like `"2023/24"`, values aligned onto the round season's calendar by season week (week 1 = MMWR 31 Saturday): `{season, label "'23–'24 Season", data [{date, value (1dp), season_week}], peak}`; ordered newest first. Built from the admissions table regardless of target (oracle filtered to target only if admissions is missing). (dl:1083-1138)
- [ ] **prior_season**: shortcut copy of the most recent historical season. (dl:1140-1150)
- [ ] **as_of / unrevised (same object)**: latest as-of snapshot with `as_of ≤ reference_date` for the target; points in the round's season with `date < reference_date`; `{available, data [{date, value 1dp}], label "Target as of <as_of>", as_of, season, peak}`. (dl:1152-1207)
- [ ] **peaks overlay** (null for location `states`/`all`, for targets without peak companions, or when no hub declares the peak targets): `{targets, models [{model_id, timing {median, mode, mode_prob, i50, i90, p_passed}, size {median, i50, i90, i95}}], observed, window}`; `p_passed` = probability on weeks ≤ ref − 7. Observed peak uses today's truth over the whole window (can lie after the round). (srv:391-397, pd:303-326)
- [ ] **GET /api/surveillance**: same surveillance payload standalone; `date` defaults to the latest model `max_date` (or "2024-01-13"). Not called by the frontend. (srv:437-445)

## Controls

- [ ] **PI menu**: button `#btn-pi-menu` (and presentation copy `#pres-pi-menu`) opens "PREDICTION INTERVALS" multi-select: "95% PI" (q0.025 – q0.975), "80% PI" (q0.10 – q0.90), "50% PI" (q0.25 – q0.75); plus "COMPARE WIDTHS" → "Width rulers" ("last horizon"). Default `{95}`, rulers off. (main:491-540, st:21-22)
- [ ] **PI button label**: "95 · 80 · 50% PI" (selected levels, outermost first), "No PI" if none, a ruler icon when rulers on; button active if any level or rulers. Changing it forces the y-axis to re-fit. (main:542-548, 532-536)
- [ ] **Truth toggle**: `#btn-toggle-truth` / `#pres-toggle-truth` "Truth", default on; re-renders the fan chart only. (html:207, main:1255-1267)
- [ ] **Signals & Indicators drawer**: toggle button with active-count badge and ▾/▴ arrow; drawer title "SIGNALS & TECHNICAL INDICATORS". (html:302-307, 370-376, main:563-641)
- [ ] **Display mode**: "Dual Y-Axis (Right)" (`dual`, default) vs "Normalized Wave Timing (0–100%)" (`normalized`); switching resets user Y zoom and re-fits. (html:378-386, main:1750-1773)
- [ ] **Reset All**: clears every active indicator. (html:388, main:1808-1816)
- [ ] **SURVEILLANCE STREAMS**: checkboxes `nssp` "NSSP Emergency Dept / % ED Visits with Flu", `ilinet` "ILINet (ILI × % Lab-Pos) / Scaled Outpatient ILI+", `flusurvnet` "FluSurv-NET Lab Rate / Hospitalizations per 100k". (html:393-428)
- [ ] **TREND SMOOTHING**: `ma2` "2-Week Moving Avg", `ma4` "4-Week Moving Avg", `ema3` "3-Week Exponential MA". (html:430-465)
- [ ] **EPIDEMIC DYNAMICS**: `velocity` "WoW Case Velocity / Weekly Net Δ Cases (t - t-1)", `growth` "WoW Growth Rate (%) / Relative expansion rate (%/wk)". (html:467-493)
- [ ] **BENCHMARKS / ALIGNED SEASONS pills**: rebuilt from `surveillance.historical_seasons` after each forecast fetch; value `season_<key>`, label "'23–'24", pip class `pip-s1..s6` by recency; palette switch "Mono" (default) / "Tints". Static HTML pills (2023/24…2020/21) are only placeholders. (html:503-536, main:646-695, 1775-1792)
- [ ] **Season Peak Level** (`season_peak`), **Peak Forecasts** (`peak_forecasts`, sub "Each model's peak week × size (▲)"), **As-of Reports** (`unrevised`, "Data as published at forecast date"). (html:538-564)
- [ ] **Peak Forecasts availability**: checkbox disabled, item greyed, title "Season peak forecasts are made for hospital admissions only", sub "Hospital admissions only" when the target has no peak companions. (main:596-606)
- [ ] **Info buttons** (ⓘ) on each indicator and on display modes open methodology popovers (`data-term` ind_*). (html:386-563)
- [ ] **Model chips/selection** (shell) drive `state.selectedModels`; any selection change resets the stable y max. (ctl:747-748)

## What is drawn

- [ ] **Reported History**: `lines+markers`, line `truthHistLine` width 2, markers size 5 `truthHistMarker`; name "Reported History" / "Reported History (Norm)"; only when Truth on and history non-empty; margin badge "History". (fc:212-230, const:775-776)
- [ ] **Oracle Outcome (Truth)**: anchor + 4 future weeks, dashed line `truthFutLine` width 2, diamond markers size 7 (anchor marker size 0); name "Oracle Outcome (Truth)" / "(Norm)"; Truth on only. (fc:232-254)
- [ ] **Rest of Season (Truth)**: thin line width 1.2 `truthRestLine`, only when Truth on and remainder has >1 point. (fc:256-272)
- [ ] **Model fan per selected model**: for each selected level 95 → 80 → 50 (outer first) a transparent upper line then lower line with `fill: tonexty`, fill = model color at alpha 0.10 / 0.12 / 0.18; every series is prefixed with the anchor point so the fan starts at the last observation. (fc:192-197, 274-320)
- [ ] **Model median**: `lines+markers`, model color width 2.5, markers size 6 (anchor size 0); legend name `modelLabel(id, meta, {withHub:true})`; legendgroup = model id so legend clicks hide the bands, peak markers and rulers too. (fc:322-339)
- [ ] **Model color**: `state.modelColors[id]` else `PALETTE[0]` (rulers fall back to `PALETTE[i]`). (fc:280, 853)
- [ ] **Peak overlay: condition**: indicator `peak_forecasts` on, payload `peaks.models` present, model selected and having both timing and size (timing-only or size-only models are skipped here, unlike the peak view). (fc:716-719)
- [ ] **Peak overlay: 50% box**: rectangle from 50% timing start − 3.5 d to end + 3.5 d by 50% size interval; fill model color alpha .12, outline alpha .5 width 1; legendgroup = model. (fc:731-739)
- [ ] **Peak overlay: 90% whiskers**: horizontal line at median size across the 90% timing window (±3.5 d) and vertical line at the median week across the 90% size interval; alpha .65, width 1.1. (fc:740-745)
- [ ] **Peak overlay: ▲ median**: `triangle-up` size 12 at (median week, median size) in model color with a `badgeBg` outline 1.5; carries the peak hover. Sizes are normalized like truth in normalized mode. (fc:746-752)
- [ ] **Observed peak marker** (with ≥1 peak model drawn and Truth on): final → ★ `star` size 14 (#073642 light / #f6f4ee dark); provisional → ◇ `diamond-open` size 10. (fc:754-766)
- [ ] **NSSP line**: `pct` values, dotted, orange (#ea580c light / #f97316 dark), width 2; badge "NSSP"; axis y2 (dual) or y (normalized, scaled to own max ×100). (fc:359-382, const:655-666)
- [ ] **ILINet line**: dashed green (#059669/#10b981), badge "Scaled ILI+". (fc:384-407, const:667-678)
- [ ] **FluSurv-NET line**: `rate` values, dashdot cyan (#0891b2/#06b6d4), badge "FluSurv". (fc:409-432, const:679-690)
- [ ] **MA-2 / MA-4**: trailing means of `truth.history` (needs ≥2 / ≥4 points), dotted sky width 1.8 / dashed indigo; badges "MA-2" / "MA-4"; primary axis, normalized by truthMax in normalized mode. (fc:434-491)
- [ ] **EMA-3**: alpha = 0.5 seeded with the first value, over all history points; dashdot purple; badge "EMA-3". (fc:493-521)
- [ ] **Velocity**: week-over-week difference of history values, `lines+markers` (size 4) pink (#db2777/#ec4899); never normalized; derivative axis. (fc:523-550)
- [ ] **Growth**: `(v_t − v_{t−1}) / v_{t−1} × 100`, skipped where previous ≤ 0; dotted yellow (#ca8a04/#facc15); derivative axis. (fc:552-580)
- [ ] **Derivative axis rule**: derivatives on y3 when mode is dual and any rate indicator (nssp/ilinet/flusurvnet) is active, else y2. (fc:351-357)
- [ ] **Aligned historical seasons**: one solid line (width 1.2) per active `season_<key>` (or the newest season when legacy `prior_season` is active), plotted on the round's calendar by season week; name = season label. (fc:582-631)
- [ ] **Season palette Mono** (default): slate, alpha `max(0.20, 0.52 − 0.08·idx)` by recency (+0.05 in light theme); badge text slate. (fc:609-619)
- [ ] **Season palette Tints**: five cycling tints by recency: rose, amber, purple, emerald, sky (separate light/dark rgba and badge colors). (fc:587-594, 614-619)
- [ ] **Seasons in normalized mode**: each season divided by its own peak (`peak` or max) ×100. (fc:603-606)
- [ ] **As-of Reports**: dashed slate line width 1.6; data filtered to `date ≤ anchor.date` and `< selectedDate`; name "Target as of <as_of>" (or "As-of Reports (Norm)"); badge "As-of" in muted color; scaled like truth. (fc:641-673, const:751-762)
- [ ] **Invisible Date tracker**: transparent line over the union of all truth and selected-model dates carrying the x hover label. (fc:675-710)
- [ ] **Width rulers: condition**: rulers on, ≥1 PI level selected, and the selected model has finite lower/upper at its last horizon for at least one selected level. (fc:825-839)
- [ ] **Width rulers: placement**: per model a solid vertical bar per selected level spanning that level's interval at the final horizon, placed 32 px right of the latest final-horizon date; models side by side at pitch `clamp(gutter/n, 5, 16)` px, gutter `clamp(12% of plot width, 60, 180)` px (plot width = container − 90, min 200). (fc:841-854, 1283)
- [ ] **Width rulers: strokes**: 95% 2.5 px, 80% 4.5 px, 50% 7 px, scaled by pitch/16 (min 1), in model color, so nested levels read as thicker inner bars; a background-colored halo (widest + 3 px) behind the outermost interval. (fc:845-873)
- [ ] **Width rulers: resize**: spacing is in screen pixels, so the chart re-renders on container resize while rulers are on. (fc:1468-1471)
- [ ] **Season peak reference line** (indicator `season_peak`): red dashed horizontal line `rgba(239,68,68,.65)` across the plot with right label "Season Peak: N" (dual) or "Full Season Peak (100%)" (normalized); value = `truth.season_peak` (fallback: max of all truth arrays). (fc:795-818, 890-917)
- [ ] **Data cutoff definition**: the cutoff drawn on the fan chart is the anchor (last revised truth week strictly before the reference date), not ref − 7; the header shows ref − 7. They differ when the latest week is missing. (fc:883-884, ctl:978-981)
- [ ] **Data cutoff band** (anchor date ≠ ref date): shaded rect anchor → ref (`cutoffFill`) full height; dotted cutoff line width 1.5 (`cutoffLine`) labelled "Data Cutoff" right-anchored at 97% height. (fc:920-950)
- [ ] **Reference date line**: dotted line width 1 (`refLine`) labelled "Ref Date (h=0)" left-anchored; with no anchor (no history) a width-1.5 dotted ref line only, no labels. (fc:952-981)
- [ ] **Margin badges: who gets one**: Reported History ("History"), NSSP, ILINet ("Scaled ILI+"), FluSurv-NET ("FluSurv"), MA-2, MA-4, EMA-3, Velocity, Growth, each aligned season ("'23–'24"), As-of ("As-of"); models, truth outcome and peaks have none. (fc:224-228, 376-380, 453-457, 632-636, 666-670)
- [ ] **Margin badges: placement**: boxed mono label (8.5 px, trace-colored text and 0.8 px border, `badgeBg`, opacity .94) at the trace's first point inside the left edge of the x window (else its first point), on that trace's axis; skipped if that point is null. (fc:984-1014, 1038-1058)
- [ ] **Margin badges: collision avoidance**: sorted by y; a badge within 4.5% of the y-axis top of the previous one is shifted up a further 15 px (cumulative). (fc:1016-1036, const:649)
- [ ] **Legend**: horizontal, centered below the plot (y −0.14, −0.10 in presentation), 10 px; contains the truth traces (Plotly default show) and one entry per model median; bands, indicators, seasons, peaks, rulers hidden from legend. (fc:1132-1140)
- [ ] **Legend click**: toggling a model hides its median, bands, peak box/whiskers/▲ and rulers together (shared legendgroup); hidden traces no longer count toward the y range. (fc:303-328, 738-749, 856, 147)
- [ ] **uirevision** `${location}_${target}`: Plotly UI state (legend toggles, etc.) persists across dates and resets on location/target change. (fc:1129)
- [ ] **Axes**: x date axis with dotted spikes across; y title "Normalized Amplitude (% of Peak)" (normalized) or "`display_name` (`unit`)" from targets_meta (fallbacks "Incident Flu Admissions (Patients / Wk)" / "ED Visits Proportion (% ED Visits)"); `%` tick suffix and dtick 20 when normalized and top ≤ 115. (fc:1086-1128)
- [ ] **y2 axis**: right side, no grid, teal/sky color; title/format: "Surveillance Rate (% ED / % ILI)" `.1f%` (nssp/ilinet), "FluSurv-NET Rate / 100k" `.1f`, "Growth Rate (% WoW)" `+.1f%`, "Case Velocity (Δ Cases/Wk)" `+,d`; zero line only when it carries derivatives. (fc:1155-1191)
- [ ] **y3 axis** (dual, rate + derivative both active): free axis at x 0.96, amber, zero line, "Growth Rate (% WoW)" `+.1f%` or "Velocity (Δ/Wk)" `+,d`, default "WoW Dynamics". (fc:1193-1220)
- [ ] **Margins**: left 60, right 25 / 65 (y2) / 100 (y3), top 25, bottom 65; presentation 48/16/55/90, 15, 50. (fc:1102-1104)
- [ ] **Modebar**: shown, no logo, lasso/select removed; responsive. (fc:1332-1337)

## Hover/inspector

- [ ] **Hover mode `x`** with a centered date banner "%b %d, %Y" from the Date tracker; truth, bands, medians and indicators are `hoverinfo: skip` (no values shown on hover). (fc:701-709, 1141-1152)
- [ ] **Peak ▲ hover**: bold model name; "Peak week · median <Mon D> · most likely <Mon D> (NN%)"; "50% a – b · 90% c – d"; "Chance the peak is already past: NN%" when > 0.5%; "Peak size · median N"; "50% … · 90% …"; italic "Plotted as % of the season peak" in normalized mode. (pv:246-261, fc:750)
- [ ] **Observed peak hover**: "**Observed season peak**" or "**Highest week so far**" + "<Mon D, YYYY>: N". (fc:764)
- [ ] **Ruler hover**: "**id**<br>95% PI on YYYY-MM-DD: lo – hi<br>Width: w", numbers at ≤4 significant digits with locale grouping. (fc:842, 871)

## Options and their values

- [ ] **Normalized scale**: truth/medians/bands/peaks/MAs divided by truthMax×100 where truthMax = `truth.season_peak` (fallback max of truth arrays; 1 if ≤0); `normBaseline: "history"` (peak_to_date) is coded but has no UI (always `full_season`). (fc:1237-1256, st:121)
- [ ] **X window**: default ref − 11 weeks to ref + 8 weeks; widened to include every drawn peak model's 90% timing window and the observed peak ± 1 week unless the user zoomed. (const:644-645, fc:51-95, 774-790)
- [ ] **Sticky user zoom**: a user x-zoom is stored as day offsets from the ref date and re-applied when stepping dates (y zoom cleared on date change); x/y user zoom kept on re-render of the same date. (fc:57-83, 1404-1437)
- [ ] **Reset axes** (double-click / autoscale): clears zoom, recomputes default x window and a fresh y range including horizontal reference lines. (fc:1369-1402)
- [ ] **Smart y range: accuracy**: covers every visible value on that axis inside the x window ±2 days (legend-hidden traces ignored; rulers and peak boxes included) plus horizontal reference levels (season peak line), so nothing is clipped. (fc:124-160, 1286-1302)
- [ ] **Smart y range: rounding**: ×1.08 headroom then a nice ceiling (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 9, 10 × 10^k; 1.2…10 steps with extra precision below 1); the % axis rounds up to tens and always includes 100. (fc:27-46, 100-102, 171-174)
- [ ] **Smart y range: sign**: primary axis floors at 0; y2/y3 may extend below zero symmetrically fitted for velocity/growth. (fc:178-185)
- [ ] **Secondary axes**: y2/y3 ranges are computed and stabilized separately and fixed (autorange off); an axis with nothing visible gets no range. (fc:1305-1330)
- [ ] **Y stability (hysteresis)**: previous top is kept while it still fits and is ≤ 1.5× the fitted top, otherwise eased to the geometric mean; reset on location/target change, model selection change, PI change, mode change, inventory change. (fc:104-113, 1268-1304)
- [ ] **Empty-axis defaults**: normalized [0,110]; rate target [0,0.1]; counts [0,100]. (fc:164-169)

## Notices/empty/error states

- [ ] **No models selected**: centered boxed annotation "No models selected · Click model chips above or 'Select All' to display fan forecasts". (fc:1061-1080)
- [ ] **Fetch error**: banner "Could not load forecasts for <date>; the chart below is out of date. (<msg>)". Metadata failure: "Could not load hub metadata. Check that the viz server is running, then reload." (main:349, 255)

## URL parameters and persisted state

- [ ] **URL shared keys**: `loc`, `target`, `date`, `models` (comma list, or `none` so a zero-model link does not fall back to the recommended 3); `view` absent for timeline. (st:209-269, 342-388)
- [ ] **URL `pi`**: omitted when exactly `95`; otherwise comma levels in 95,80,50 order, or `none` when empty; parsing keeps only 95/80/50. (st:327-329, 375-380)
- [ ] **URL `rulers=1`** when width rulers are on. (st:330, 381-385)
- [ ] **URL `indicators`**: comma list of active keys (e.g. `nssp,ma2,season_2023/24,peak_forecasts`), each validated by `^[a-z0-9_]+(\/\d{2})?$`; legacy `prior_season` still honored (first aligned season). (st:316-325, 390-391, fc:598)
- [ ] **URL `ind_mode=normalized`, `ind_palette=tints|mono`**: written only while ≥1 indicator is active (dropped otherwise, so normalized mode without indicators is lost on reload). (st:332-339, 392-406)
- [ ] **Not persisted**: Truth toggle, drawer open state, zoom. (st:342-409)

## Edge cases

- [ ] **Rate targets**: truth comes from the oracle only (no admissions fill); empty y default [0,0.1]; velocity title still says "Δ Cases/Wk"; Season Peak label uses `toLocaleString()` of the raw value. (dl:858, fc:168, 895)
- [ ] **Indicator data beyond the round**: NSSP/ILINet/FluSurv-NET include up to 12 weeks after the ref date (no as-of cap), unlike As-of Reports. (dl:983-984)
- [ ] **Historical seasons on non-hosp targets**: built from hospital admissions, so on the ED-visits target they plot admissions counts. (dl:1096-1101)
- [ ] **y3 without y2**: if a rate indicator is active but has no data while a derivative is active, derivatives go to y3 and no y2 is created. (fc:357, 1083-1084)
- [ ] **Aggregate locations** (`states`/`all`): no peak overlay. (srv:393)
- [ ] **Indicator already active but disabled**: `peak_forecasts` from a URL stays in the active set on a non-peak target; server returns `peaks: null`, so nothing draws. (main:596-606, srv:391-397)
- [ ] **Presentation active-signals ribbon**: chips with "×" remove buttons, but no click handler is bound (dead control). (main:452-489)
- [ ] **Resize**: ResizeObserver debounced 40 ms on the fan and map; fullscreen change resizes the active view's plot. (fc:1443-1500)

# Spatial map

## Data and endpoint

- [ ] **GET /api/spatial**: params `target`, `date` (required), `models` (comma; defaults to every model), `horizon` (default `all`, unused by frontend). Frontend sends selected models, or all models when none selected. (srv:447-462, sm:126-140)
- [ ] **Response**: `{target, reference_date, horizons [sorted], dates_by_horizon {h: target_end_date}, states {ABBR: {fips, name, population, truth {ted: value}, truth_rate {ted: per100k}, models {model: {h: {median, rate_per_100k, q025, q975, q25, q75, trend_pct, wis, error, target_end_date}}}}}, selected_horizon}`; every non-US location is listed (incl. PR and territories). (dl:1293-1450)
- [ ] **Values**: quantiles rounded to 1 decimal; `rate_per_100k = median/pop×1e5` (2dp; null for rate targets); `trend_pct = (median − h0 median)/h0 median × 100` (1dp; null when h0 ≤ 0 or missing); `wis` = leaderboard task WIS (2dp); `error = median − truth`. (dl:1408-1440)
- [ ] **Truth**: oracle newest as_of per (location, date) for dates ≥ ref date. (dl:1304-1342)
- [ ] **GET /api/peak-map**: params `target`, `date`, `model` (both required). Response `{model_id, reference_date, targets, window [start, end], locations {fips: {timing {median, mode, mode_prob, i50, i90, p_passed}, size {median, i50, i90}, size_per_100k, observed}}}`. (srv:428-435, pd:330-353)
- [ ] **Frontend uses**: `states[*].models[mid][h]`, `.name`, `.population`, `.fips`, `.truth[dates_by_horizon[h]]`, `dates_by_horizon`; `reference_date`/`target` for cache check; peak map `locations`, `window`. Unused: `horizons`, `truth_rate`, `selected_horizon`, `q25/q75`, `error`. (sm:195-237, 618-751)

## Controls

- [ ] **MODEL select**: options = selected models (or all), labelled by raw id; default keeps the current one if present else the first; "No models available" when none. Change re-renders map, inspector, insights (no refetch). (sm:93-122, main:1699-1707)
- [ ] **LAYER select**: "Rate / 100k (Incidence)" `rate` (default), "Admissions (Volume)" `count`, "Trend (% Growth)" `trend`, "WIS Error (Evaluation)" `wis`, optgroup "Season Peak": "Peak Week (Median)" `peak_week`, "Peak Size / 100k (Median)" `peak_size`. Change re-renders map + inspector. (html:600-610, main:1709-1716)
- [ ] **Rate-target layer rules**: `rate` hidden and disabled; selecting/holding `rate` switches to `count`; `count` relabelled "Value (<unit>)". (sm:162-171)
- [ ] **Peak layer availability**: Season Peak optgroup hidden/disabled when the target has no peak companions; an active peak layer falls back to `count` (rate target) or `rate`. (sm:175-184)
- [ ] **HORIZON segmented**: h=0 ("Nowcast Baseline"), h=1 (default), h=2, h=3; click re-renders map, inspector and header (not the insight cards). (html:620-626, main:1675-1687)
- [ ] **Play/Pause**: cycles h 0→1→2→3→0 every 1200 ms, updating segment highlight, map, inspector, insights and header; button shows pause icon + "Pause" while playing. (sm:912-963)
- [ ] **Peak layer disables the horizon group**: `.spatial-player-group.is-disabled`, playback stopped, h0 notice hidden. (sm:185-192)
- [ ] **Guide** button opens the methodology modal at the spatial section; ⓘ buttons for layers and horizons. (html:597, 618, 636-640, main:1725-1726)
- [ ] **Inspector collapse**: "⇤" in the inspector header or key `I`; collapsed rail button shows "<ST> Inspector" or "State Inspector" with "⇥"; map resized after 40 ms. (sm:753-785, html:674, 753-758)
- [ ] **h0 notice button** "Jump to h=1 (+1 Wk)" clicks the h=1 segment. (html:654-657, main:1718-1723)
- [ ] **Open State Timeline Fan**: switches to the timeline view and sets the location select to the inspected state's FIPS (fires change). (html:743-747, main:1729-1738)

## What is drawn

- [ ] **Choropleth**: Plotly `choropleth`, `locationmode: USA-states`, Albers USA projection, lakes shown, land/lake/background themed, state borders 1 px; US and PR rows skipped; states with no value stay unfilled (null z), not zero. (sm:205-237, 355-381, 559-583)
- [ ] **Rate layer scale**: 0 → max over all 4 horizons of the model ×1.05 (rounded up to 0.1; 5 if none); 6-stop scale cream→light blue→sky→blue→rose→wine (light) or near-black→navy→blue→sky→rose→pink (dark); colorbar "Rate / 100k". (sm:246-275)
- [ ] **Count layer scale**: 0 → max over horizons ×1.05 (ceil; 500 if none); 5-stop sequential blues; colorbar "Admissions" or the target unit. (sm:276-303)
- [ ] **Trend layer scale**: fixed −50…+50 with mid 0; teal (falling) → neutral → rose (rising); colorbar "% Trend", tick suffix "%". (sm:304-324)
- [ ] **WIS layer scale**: 0 → max over horizons ×1.05 (500 if none); green → amber → red; colorbar "WIS Error". (sm:325-353)
- [ ] **Fixed scale across horizons**: rate/count/wis maxima span h 0..3 so animation does not rescale. (sm:252, 282, 331)
- [ ] **Peak Week layer**: z = days from window start to the state's median peak week; teal→sky→indigo→purple→rose scale; range = state medians ± 14 days clamped to [0, window length] and at least 28 days wide; colorbar "Peak week (median)" with month ticks on the 1st and 15th ("Mon D"), only the 1st when span > 120 days. (sm:439-518)
- [ ] **Peak Size layer**: z = median peak size per 100k; same scale as Rate; 0 → max ×1.05 (0.1 rounding; 10 if none); colorbar "Peak size / 100k". Iterates `state.locations` with 2-letter abbreviations (not US/PR). (sm:459-470, 519-525)
- [ ] **Colorbar**: right side (x 0.98), thickness 14, length 72%, themed background. Map margins t/b/l 10, r 85 (presentation 8/8/8/75). No modebar, no drag, no scroll zoom. (sm:382-398, 559-589)
- [ ] **Insight strip**: four cards under the map, computed for the active model and horizon over every state with data, each with an ⓘ. (html:761-814, sm:810-857)
- [ ] **HIGHEST INCIDENCE STATE**: max `rate_per_100k` → "AB: r.rr" / "Name · per 100k residents"; none → "--" / "Admissions per 100k". (sm:859-867)
- [ ] **FASTEST EPIDEMIC SURGE**: max `trend_pct` if > 0 → "AB: +x.x%" / "Name · fastest accelerating"; else "Flat / Decelerating" / "No states surging > 0%". (sm:869-877)
- [ ] **NATIONAL TOTAL (STATES)**: sum of medians rounded with grouping / "Sum across N states & territories"; zero → "--" / "Sum of state medians". (sm:879-887)
- [ ] **WAVE SPREAD STATUS**: states rising (trend > +5%), falling (< −5%), steady otherwise; "Surge (N Rising)" coral when rising > 1.5× falling, "Receding (N Falling)" mint when falling > 1.5× rising, else "Plateau / Mixed" sky; sub "R rising · F falling · S steady"; no rising/falling (e.g. h=0) → "Nowcast Baseline" / "Trajectory starts at Horizon 0". (sm:889-909)

## Hover/inspector

- [ ] **Map hover (forecast layers)**: "**Name (AB)**", "Pop: 1,234,567" (or N/A), small "Click for details"; no values in the hover. (sm:229-236)
- [ ] **Map hover (peak layers)**: name; "No peak forecast from this model" when absent; else "Peak week <Mon D> · 50% a – b", "Most likely <Mon D> (NN%) · already past NN%", "Peak size N (r.r / 100k) · 90% lo – hi", "Observed peak|Peak so far: N · <Mon D>". (sm:471-487)
- [ ] **Click a state**: selects it and opens the inspector if collapsed (else refreshes it). (sm:593-607)
- [ ] **Inspector default state**: highest `rate_per_100k` at the current model/horizon, fallback "CA". (sm:637-650)
- [ ] **Inspector header**: badge = abbreviation; name; "1,234,567 residents · Horizon h=N" (or "Horizon h=N"). (sm:659-665)
- [ ] **PROJECTED**: median rounded with grouping; sub "95% PI: [lo – hi]" rounded, or "95% PI: [-- – --]". (sm:668-677)
- [ ] **ACTUAL TRUTH**: truth at the horizon's target end date rounded, sub "Observed truth"; else "Pending" (muted) / "Pending truth". (sm:679-690)
- [ ] **INCIDENCE RATE**: `rate_per_100k` 2dp or "--", sub "Per 100k residents". (sm:692-694)
- [ ] **TRAJECTORY**: h>0 with trend → "▲ +x.x%" coral / "▼ −x.x%" mint / "▶ 0.0%"; h=0 → "0.0% (Anchor)"; sub "Nowcast anchor" (h=0) or "vs Nowcast (h=0)". (sm:696-709)
- [ ] **WIS EVALUATION & CALIBRATION**: WIS 2dp amber or "--"; badge "Within 95% PI" (covered) + "Observed within 95% corridor", or "Interval Miss" + "Overpredicted outcome" (truth < q025) / "Underpredicted outcome"; "Unscored" + "Awaiting NHSN observations" when no WIS or truth. (sm:711-737)
- [ ] **No model data for state**: all "--", badge "Pending", "Awaiting model data". (sm:738-750)

## Options and their values

- [ ] **Layers** `rate | count | trend | wis | peak_week | peak_size`; **horizons** 0–3; **play interval** 1200 ms. (st:72-75, sm:417, 946)

## Notices/empty/error states

- [ ] **h0 trend notice**: shown when layer = trend and h = 0: "Horizon 0 is the Nowcast Baseline (0.0% Growth): …" with jump button. (html:644-658, sm:403-410)
- [ ] **Peak layer empty**: boxed annotation "<model> has no peak-week|peak-size forecasts for the round of <date>". (sm:553-556, 577-582)
- [ ] **Peak layer loading**: peak map fetched lazily, cached by `target|date|model`; with no cache yet nothing is redrawn until it arrives. (sm:420-452)
- [ ] **Errors**: "Could not load map data for <date>; the map below is out of date. (<msg>)"; "Could not load peak forecasts for the map (<msg>)." (sm:152, 435)

## URL parameters and persisted state

- [ ] **URL**: only `view=spatial` (plus shared loc/target/date/models). Layer, horizon, model, selected state and inspector state are not persisted. (st:356-357)

## Edge cases

- [ ] **Rate/proportion targets**: backend rounds medians to 1 decimal, so proportions (≈0.0x) become 0.0; inspector and "National total" round to integers; insight "Highest incidence" is "--" (no per-100k) and the inspector default state becomes CA. (dl:1430, sm:669, 640-648)
- [ ] **Territories**: GU/VI/AS/MP etc. are sent as locations; Plotly ignores unknown codes; they still count in insight sums ("states & territories"). (sm:209-237, 834-857)
- [ ] **Stale insights**: clicking a horizon segment or changing layer does not refresh the insight cards (play does). (main:1678-1685)
- [ ] **Dead code**: `jumpToStateTimeline` and `resetSpatialInspector` are exported but never called. (sm:787-808)

# Heatmap

## Data and endpoint

- [ ] **GET /api/heatmap** params: `rows`, `cols` (or legacy `mode`), `location` (or `loc`; default `states`), `target`, `metric` (default `rate`), `date`, `season`, `horizon` (default 1), `model`, `models` (comma), `sort_by` (default `hhs_region`), `normalize` (default `none`), `include_inactive` (1/true/yes). 500 `{error}` on exception. (srv:464-503, api.js:68-88)
- [ ] **Frontend request**: rows/cols from state; `location` = `states` or the selected location; `metric`; time scope → `date` or `season`; `horizon` = heatmapActiveHorizon (1); `model` = heatmapActiveModel or `truth`; `models` = selected or all; `sort_by`; `normalize`; `include_inactive`. (hm:612-653)
- [ ] **Response fields used**: `x_keys, x_labels, y_keys, y_labels, matrix` (normalized z), `raw_matrix`, `text_matrix` (Plotly `text`, not displayed), `cell_meta {"row:col": {...}}`, `row_groups`, `col_groups`, `inactive_models`, `include_inactive`. Unused: `summary` (min/max/mean/completeness/hotspot/fastest_surge), `mode`, echoes. (dl:2572-2598, hm:688-697)
- [ ] **Axis → mode map**: location×date = `wave`; date×location = wave transposed; model×location = `model_loc`; location×model = model_loc transposed; model×horizon = `model_h`; horizon×model = transposed; model×date = `model_date`; date×model = transposed; also `horizon` (location×horizon) and `date_h` (date×horizon) exist but the UI never offers them; unknown → wave. (dl:1503-1554)
- [ ] **Location scope**: `states`/`all`/empty → every non-US location; `Region N` → HHS region; abbreviation or FIPS → that state; `US` → US national only; anything else → all states. (dl:1559-1588)
- [ ] **Time scope**: `season` = comma list (or `current` = season of latest date) → available dates in those seasons (fallback all dates); `date` → that date if available else the latest; neither / `all` → all dates. Available dates = hub rounds ∪ model dates ∪ admissions dates. (dl:1596-1617, 2670-2681)
- [ ] **wave, truth model**: cell = oracle value at (location, target_end_date in scope) with rate per 100k (null for rate targets), `trend` = % change vs previous non-null scope date (prev > 0); oracle rows not de-duplicated by as_of. (dl:1635-1663, 1728-1740)
- [ ] **wave, single model**: cells keyed by reference_date at the chosen horizon: median, rate, q025, q975, truth (oracle at target_end_date), error (median − truth), task WIS, trend of medians. (dl:1664-1740)
- [ ] **Model modes**: each candidate model scored over scope dates with the leaderboard scorer (population map for counts; restricted to scope locations, all-states excludes US); cell = mean over tasks grouped by location / horizon / reference_date of `wis`, `wis_rate` (wis_per_100k), `mae`, `cov95` (×100), `sharpness`; plus `task_count`; unknown metric falls back to wis. (dl:2022-2197)
- [ ] **Shoulder pruning**: wave/model_date drop leading/trailing all-empty date columns (internal gaps kept); date_h drops empty leading/trailing rows. (dl:2199-2241)
- [ ] **Cell meta**: wave/horizon cells carry `row, row_name, col, region_id, region_name, metric_name, metric_value, population` + cell fields; model modes carry `row, col, metric_name, metric_value` + metrics (`location_name` for model_loc, `horizon` for model_h). (dl:1773-1784, 1902-1914, 2094-2102, 2142-2150, 2189-2196)
- [ ] **Text matrix**: "No Data"; rate "x.xx / 100k"; count "N,NNN adm" (or "x.xx%" ×100 for rate targets); trend "+x.x%"; cov95 "x.x%"; else 2dp. (dl:2498-2515)

## Controls

- [ ] **ROWS select**: Location (default), Model, Date, Horizon. Change repopulates COLS, metric, sort, toolbar visibility, URL, refetch. (html:825-833, hm:38-50)
- [ ] **COLS select (depends on rows)**: Location → "Date (Epidemic Wave)" | "Model (Performance by State)"; Model → "Horizon (Lead Decay h=0..3)" | "Location (State Breakdown)" | "Date (Timeline Error)"; Date → "Location (Epidemic Wave)" | "Model (Timeline Error)"; Horizon → "Model (Lead Decay h=0..3)"; invalid current value snaps to the first. (hm:289-333)
- [ ] **Swap ⇄**: swaps rows and cols (the new cols must be valid for the new rows, else snaps). (hm:65-83)
- [ ] **LOC**: "All States" (`states`, default) | "Current" (selected location). (html:851-857, hm:94-102)
- [ ] **TIME**: "Date" (selected date) | "Season ('24–'25)" (focal season = evalFocalSeason or latestSeason; title "Evaluate all rounds in the focal <s> season"; default) | "Seasons ▾" (custom) | "All Time". (html:860-881, hm:104-125, 385-392)
- [ ] **Seasons ▾ menu**: "HEATMAP SEASONS" checklist of forecast seasons (else all seasons, else a fixed 3-season list) newest first, label "<season> Season", all checked initially; "Select All"; "Apply" (empty → focal season) sets scope `custom`, button text "'24–'25 ▾" or "N Seasons ▾"; outside click closes. (hm:127-174, 353-380)
- [ ] **MODEL select** (only when Model is not an axis): "Observed Ground Truth (CDC/NHSN)" (`truth`, default) + candidate models (hub models via `modelLabel` with hub, others "id [LOCAL]"); invalid value falls back to truth. (hm:176-184, 397-406, 433-466)
- [ ] **HORIZON segmented** h=0..3 (default 1): shown only for Location×Date with a model (not truth). (html:898-906, hm:85-92, 408-414)
- [ ] **METRIC select**: options rebuilt whenever axes or model change; an invalid current metric snaps to the first option. (hm:471-528)
- [ ] **Metrics when Model is an axis** (model×location, model×horizon, model×date and transposes): `wis` "Weighted Interval Score (WIS)", `wis_rate` "Rate WIS / 100k (Standardized)" (removed for rate targets), `mae` "Mean Absolute Error (MAE)", `cov95` "95% Interval Coverage (%)", `sharpness` "Sharpness (Interval Width)". (hm:484-492)
- [ ] **Metrics for observed truth** (location×date, model = truth): `rate` "Rate / 100k (Incidence)", `count` "Admissions (Volume)", `trend` "Trend (% Weekly Change)". (hm:493-498)
- [ ] **Metrics for one model** (location×date, model chosen): `rate` "Forecast Rate / 100k", `count` "Forecast Admissions (Volume)", `error` "Absolute Error (Forecast - Truth)" (signed median − truth despite the label), `wis` "WIS Error (Calibration)". (hm:499-507, dl:1722)
- [ ] **Rate-target metric rules**: when Model is not an axis, `rate` is removed and `count` becomes "Observed Value (<unit>)" / "Forecast Value (<unit>)". (hm:508-513)
- [ ] **Display ▾ popover** with SORT, SCALE, PALETTE (SORT and SCALE shown only when rows is Location or Model). (html:924-972, hm:416-427)
- [ ] **SORT for Location rows**: `hhs_region` "HHS Region (1–10 Geographical)" (default), `peak_timing` "Peak Timing (Wave Cascade)", `magnitude` "Incidence Magnitude (Highest First)", `population` "Population (Largest First)", `alphabetical` "Alphabetical (A–Z)". (hm:540-547)
- [ ] **SORT for Model rows**: `performance` "Best Performance (Lowest Mean WIS)", `alphabetical` "Alphabetical (A–Z)"; invalid current value snaps to the first. (hm:548-572)
- [ ] **SORT for other rows**: single "Default Order" (`alphabetical`), but the group is hidden then. (hm:553-557, 419-421)
- [ ] **Every axis/scope/metric/sort/scale change refetches** (sort and scale are applied server-side); palette and invert only re-render. (hm:38-230)
- [ ] **SCALE**: "None (Raw Values)" | "Row Min-Max (0 → 1 Peak Timing)". (html:953-956)
- [ ] **PALETTE**: "Warm Amber / Red" (`YlOrRd`, default), "Viridis (Uniform)", "Clean Blue" (`Blues`), "Red-Blue (Diverging)" (`RdBu`); "Invert" toggle reverses; both re-render without refetch. (const:627-632, hm:213-230)
- [ ] **Inspector collapse**: "→" button, rail "Data Inspector ←", key `I`. (html:1023, 1098-1102, hm:1581-1598)
- [ ] **Jump buttons**: "Open State Timeline Fan" sets location (by abbreviation) and date (if the column is a date) and switches to timeline; "View on US Spatial Map" sets date and spatial horizon from the cell, switches to spatial. (hm:1469-1523)

## What is drawn

- [ ] **Heatmap trace**: Plotly `heatmap`, z = `matrix` (normalized or raw), 1 px gaps, chosen colorscale, auto z range, `hoverongaps: false`; y axis reversed (first row at top). (hm:846-886, 1028-1038)
- [ ] **Colorbar title**: "Peak Timing (0 → 1)" when row min-max; else rate "Admissions / 100k", count "Admissions Volume", trend "WoW % Growth", wis/wis_rate "WIS (Error)", mae "MAE Error", cov95 "Coverage %", sharpness "Sharpness (Width)", else upper-case metric (e.g. "ERROR"). (hm:820-839)
- [ ] **HHS region row dividers** (rows Location, sort HHS region, row_groups present): 2.5 px solid line between regions (#002b36 light / #f8fafc dark) and right-margin badges "REGION N / **Reg N**"; colorbar moved to x 1.15 and right margin 165. (hm:841-843, 891-940, 1003)
- [ ] **HHS region column dividers** (col_groups, i.e. Model×Location): vertical 2.5 px lines between region groups (columns sorted by region). (hm:942-963, dl:2399-2431)
- [ ] **Non-reporting divider** (include_inactive with inactive models): dotted amber line above the inactive rows and label "Non-Reporting Models ↓"; inactive row labels prefixed "[No Data] ". (hm:965-999, dl:2300-2311)
- [ ] **Axis styling**: x ticks rotated −45° when > 8 columns, font 8.5 when > 35 columns; y font 11/10/9 by row count (≤20 / ≤40 / more); left margin 75/115/140/160 by longest label (>7/>12/>18 chars); bottom 70 or 45. (hm:1001-1039)
- [ ] **Canvas height**: inspector open → ≥ inspector height (min 460; 480 for 13–25 rows; else `min(680, max(inspector, 12·rows + 60))`); collapsed → 230 (≤2 rows), 290 (≤5), 380 (≤12), 480 (≤25), else `min(680, max(540, 12·rows+60))`; presentation 100%. (hm:1532-1576)
- [ ] **Non-reporting tray**: shown below the plot only when `inactive_models` is non-empty; title "Non-Reporting Models in Scope" with a count badge. (hm:1067-1092)
- [ ] **Tray subtitle**: "Displaying N non-reporting models at the bottom of the heatmap" (included) or "Excluded from the plot above to preserve continuous rows. Click any model to inspect why." (hm:1093-1097)
- [ ] **Tray include toggle**: "Show in Heatmap (N)" / "Clean View (Active Only)" (active style when included); flips `include_inactive` and refetches. (hm:253-259, 1099-1106)
- [ ] **Tray collapse**: "Hide List" / "Show List (N)" collapses the chip list. (hm:261-275)
- [ ] **Tray chips**: one per inactive model, name + tag "<seasons> only" (if seasons known), "No submissions" (count 0) or "0 in scope"; tooltip "name: reason"; click inspects it (opens inspector); selected chip highlighted. (hm:1108-1135, 1141-1165)
- [ ] **Inactive model detection** (model modes): rows with no values; reason "No forecast submissions found" (count 0), "Active in <seasons> only (no forecasts in <season>)", "No forecast submissions recorded for <season>", "Active in <seasons> (no forecast for <date>)", "No forecast for <date>", or "No forecasts in selected scope"; single-model wave with no values also yields one inactive entry. (dl:2243-2330)

## Hover/inspector

- [ ] **Hover title**: "**row label** · **col label**". (hm:760-761)
- [ ] **Hover metric line**: name rate "Incidence Rate", count "Admissions", trend "Weekly Change", wis "WIS Error", mae "MAE Error", cov95 "95% Coverage", sharpness "Sharpness", else (wis_rate, error) "Value"; value rate "x.xx / 100k", count "N,NNN adm", trend "+x.x%", wis/wis_rate 2dp, cov95 "x.x%", else 2dp; formatted from the raw (un-normalized) value. (hm:771-796)
- [ ] **Hover extras**: "**Peak Timing:** NN%" (row min-max normalized value); "**Observed Truth:** N adm"; "**WoW Growth:** ±x.x%" unless the metric is trend; "**WIS Error:** x.xx" unless the metric is wis. (hm:798-810)
- [ ] **Empty-cell hover text** ("Did not forecast in this scope" + reason, or "No Data") is built but unreachable because `hoverongaps: false`. (hm:763-770, 858)
- [ ] **Click a cell**: selects it (customdata incl. cell meta) and updates the inspector; first cell auto-selected when none. (hm:660-670, 1049-1058)
- [ ] **Inspector header**: badge = row key when ≤ 3 chars (state), hidden otherwise; title = row name/label; meta = "<col label> · <region name>". (hm:1242-1258)
- [ ] **SEASON TRAJECTORY sparkline**: canvas 65 px tall, the selected row's raw values across columns with gradient fill, sky line (#38bdf8, 2.2 px), dashed guide and ringed dot at the selected column; "Insufficient trend points" when < 2 values. (hm:1340-1464)
- [ ] **CELL VALUE**: rate 2dp, count rounded with grouping, trend "+x.x%", cov95 "x.x%", else 2dp, "--" when null; sub "Admissions / 100k population", "Weekly admissions volume", "Week-over-week velocity" or "Active cell metric". (hm:1260-1278)
- [ ] **OBSERVED ADMISSIONS**: truth rounded, else median rounded, else "--"; sub "Observed admissions volume (Δ: ±err)", or "95% PI: [lo – hi]", or "Observed admissions / projection". (hm:1280-1300)
- [ ] **WEEKLY CHANGE**: "+x.x%", rose when > 15, emerald when < −15, else "--". (hm:1302-1312)
- [ ] **MODEL EVALUATION**: WIS 2dp + badge "Scored" (verified) or "--" + "Unscored". (hm:1314-1331)
- [ ] **Inactive model inspector header**: badge "OFF", title = model name, meta "Excluded from Heatmap · <reason>". (hm:1192-1202)
- [ ] **Inactive model inspector cards**: CELL VALUE "0 files" with the reason as sub; OBSERVED card shows recorded seasons (or "None") with sub "Recorded seasons"; WEEKLY CHANGE card shows the submission count; MODEL EVALUATION shows the "YYYY–YYYY" active span (or "--") with badge "Inactive". (hm:1203-1215)
- [ ] **Inactive model sparkline**: replaced by centered text "Model did not forecast in this scope" and the reason in mono. (hm:1348-1369)
- [ ] **Inactive model jump**: primary button relabelled "Switch Season to <first recorded season>" (sets focal season and season scope, refetches); hidden when the model has no seasons. (hm:1217-1228, 1474-1482)

## Options and their values

- [ ] **State defaults**: rows `location`, cols `date`, loc `states`, time `season`, metric `rate`, sort `hhs_region`, normalize `none`, palette `YlOrRd`, invert off, horizon 1, model `truth`, include inactive off, inspector open. (st:78-94)
- [ ] **Location sorts (backend)**: hhs_region = (region, abbr); peak_timing = (column index of row max, −max), empty rows last; magnitude = descending row mean; population = descending; alphabetical = by key. Applied before transpose. (dl:2338-2371)
- [ ] **Model sorts (backend)**: `performance`/`magnitude` = ascending mean of the row's current metric; `alphabetical`; inactive rows kept at the bottom sorted by id. (dl:2433-2461)
- [ ] **Normalization (backend)**: row_min_max per (pre-transpose) row, constant rows → 0; `percentile` (global rank / n) still supported server-side but removed from the UI. (dl:2466-2493, html:947)

## Notices/empty/error states

- [ ] **Loading overlay**: spinner + "Computing heatmap data..." while fetching. (html:981-984, hm:1603-1606)
- [ ] **Empty state**: icon, "No Active Forecasts in Scope", "No valid data points found for <rows> × <cols> in the selected scope." or, with inactive models, "None of the candidate models submitted forecasts for the <b><heatmapSeason></b> season." plus "Switch Season to <s>" button (sets focal season + scope season, refetch). (hm:699-729)
- [ ] **Error state**: "Failed to Load Heatmap Data", message, "Retry" button (`window.__retryHeatmap`). (hm:1611-1621, main:425)

## URL parameters and persisted state

- [ ] **URL (only when view=heatmap)**: `view=heatmap`, `hm_rows`, `hm_cols`, `hm_loc`, `hm_time`, `hm_metric`, `hm_season` (always written from `heatmapSeason`), `hm_sort` (omitted when hhs_region), `hm_norm` (omitted when none). `hm_pal` is read but never written. Not persisted: custom seasons, horizon, model, invert, include inactive, selected cell. (st:288-314, 353-367)

## Edge cases

- [ ] **Transposed views lose cell meta**: cell_meta keys are pre-transpose `row:col`, but hover/click look up `displayedRow:displayedCol`, so in date×location, location×model, date×model, horizon×model the hover lacks truth/trend/WIS lines and the inspector shows "--" values, no sparkline, and broken jump targets. (hm:744-757, dl:2520-2526)
- [ ] **Location×Model sorting**: the "location" sort options act on model rows before transpose; HHS dividers never appear; row min-max normalizes per model (displayed column). (dl:2336-2371, 2468-2476)
- [ ] **Date×Location**: locations become columns in inventory order with no region dividers. (dl:2399-2431, 2520-2526)
- [ ] **Non-reporting divider in transposed Location×Model** is drawn horizontally among locations (wrong axis). (hm:965-982)
- [ ] **"Best Performance (Lowest Mean WIS)"** actually sorts by the mean of the current metric, so for coverage the lowest coverage ranks first. (dl:2437-2442)
- [ ] **Rate targets**: hover says "N adm" and inspector "Observed admissions" even for proportions (backend text_matrix uses %). (hm:777, 1294)
- [ ] **Empty-state season text** uses `state.heatmapSeason` (default "2024-2025", only updated by switch buttons/URL), not the focal season actually queried. (hm:705, st:85)
- [ ] **Switch-season buttons change the global focal season** (`evalFocalSeason`) used by other panels. (hm:721-723, 1476)
- [ ] **Selected cell is kept across refetches**, so the inspector can describe a cell from a previous scope. (hm:660-671)
- [ ] **Unreachable modes**: `horizon` (location×horizon) and `date_h` (date×horizon) are implemented server-side but no rows/cols choice reaches them. (hm:289-317, dl:1787-2017)

# Season peak

## Data and endpoint

- [ ] **GET /api/peaks**: params `target`, `location` (`states`/`all` → `US`), `date` (required), `models` (comma), `skill_scope` `location|states` (else 400), `common` (1/true/yes). Frontend sends selected models only, `skillScope = state.peakSkillScope`, `common = state.fairCommonTasks`. (srv:409-426, pv:98-106)
- [ ] **Response**: `{base_target, targets {size, timing}, available, location, location_name, reference_date, data_cutoff (ref − 7), season "YYYY-YYYY", models [{model_id, has_round, timing, size, scores?}], rounds {model: [{reference_date, timing {dates, probs, median, mode, mode_prob, i50, i90}, size {median, i50, i90, i95}}]}, missing [model ids with no peak rows], peak_rounds [ref dates with forecasts at this location], latest_peak_round, window [start,end], observed, truth [{date, value}], skill}`. (pd:159-243)
- [ ] **Peak targets**: weekly `wk X` pairs with size `peak X` (quantiles) and timing `peak week X` (pmf over Saturdays); a target "has peaks" only if a hub config or synced hub declares them; metadata `peak_targets` maps weekly target → companions. (pk:57-62, pd:41-60, srv:323-340)
- [ ] **Timing summary**: pmf renormalized (negatives → 0); median/i50/i90 = first week whose CDF reaches 0.5 / 0.25–0.75 / 0.05–0.95; mode + mode_prob; `p_passed` = mass on weeks ≤ data cutoff. (pk:161-192)
- [ ] **Size summary**: quantiles sorted and made monotone; median, i50, i90, i95 by exact level or linear interpolation (null outside range). (pk:195-224)
- [ ] **Window**: earliest of (first Saturday of October, earliest candidate week) to the latest candidate week across models' pmfs; default first Saturday of October → last Saturday of May. (pd:146-152, pk:324-331)
- [ ] **Observed peak**: from latest-vintage weekly truth inside the window: `{value, date (earliest tie), dates (all ties), last_observed, final (last observation ≥ window end), window}`; uses today's data, not data as of the round. (pk:296-321, pd:154-155)
- [ ] **Season truth**: latest-vintage weekly truth (oracle newest as_of, admissions filling gaps for hosp) over the MMWR season calendar. (pd:129-143, dl:258-286)
- [ ] **Round scores** (only when observed is final): timing `{log_score (−ln P(obs), floor 0.001), p_observed, rps (weeks), week_error (median − observed, weeks), in50, in90}`; size `{wis (mean pinball ×2), error, pct_error, in50, in90}`. (pd:223-227, pk:235-289)
- [ ] **Season skill**: over every round in the season (and every state with a final peak for scope `states`, the shown location otherwise): per model `n_timing, n_size, rps, log_score, abs_week_error, timing_in50, timing_in90, size_wis, size_wis_pct (wis / observed × 100), size_abs_pct_error, size_in50, size_in90`; `common` restricts to (round, location) tasks every model has; sorted by RPS (nulls last); `{scope, final, locations, pending_locations, window_end, common, models}`. (pd:245-299)

## Controls

- [ ] **Location**: uses the global location; aggregates ("states"/"all") fall back to US with a "Showing US National" chip. (pv:65-69, 214-219)
- [ ] **SCORECARD mode**: "This Round" (`round`, default) | "Season Skill" (`skill`); re-renders only. (html:1132-1135, pv:770-777)
- [ ] **Skill scope** (visible only in Season Skill): "Location" (default) | "All States"; change refetches. (html:1136-1139, pv:778-786)
- [ ] **PEAK CALL BY ROUND model select**: models with ≥1 round; default prefers an id matching /ensemble/i, then the first model with this round, then the first; disabled "No peak forecasts" when none; persisted as `peak_model`. (pv:464-478, 759-769)
- [ ] **Click a round row** in the evolution plot selects that reference date (refreshes everything). (pv:608-621, main:317)
- [ ] **ⓘ** for "peak_forecasts", "peak_scores", "peak_evolution". (html:1116, 1140, 1150)

## What is drawn

- [ ] **Toolbar chip**: "SEASON 2024–25", "ROUND <Mon D, YYYY>", observed text "Observed peak **N** · <Mon D>" or "Peak so far **N** · <Mon D> provisional until <window end>" or "No observations yet"; static key: ▲ median, box "50% × 50%", whisker "90%", ★ observed peak. (pv:200-220, html:1108-1117)
- [ ] **PEAK OUTLOOK card** (subtitle "When will the season peak, and how high? …"): main panel + ridgeline panel sharing the date axis. (html:1120-1126, pv:263-458)
- [ ] **Reported truth**: weeks ≤ data cutoff, `lines+markers` (size 4) in `truthHistMarker`, always drawn; **Rest of season**: from the last reported week onward, dashed `truthRestLine` width 1.3, only when Truth on and > 1 point. (pv:285-305)
- [ ] **Target zones** (models with timing and size): box 50% timing (±3.5 d) × 50% size, fill alpha .13, outline .55; whiskers (90% timing at median size, 90% size at median week) alpha .7 width 1.2; ▲ size 12 in model color, legend entry per model. (pv:307-329)
- [ ] **Size-only models**: dashed horizontal line at the median size across the window, legend "<name> (size only)", hover adds "No peak-week forecast". (pv:330-337)
- [ ] **Observed peak** (Truth on): ★ size 15 (final) or ◇ open size 11 (provisional) with legend "Observed peak"/"Peak so far"; plus a vertical line through the ridgeline panel (solid final, dotted provisional). (pv:340-358)
- [ ] **Ridgeline lanes**: one lane per model with a timing forecast, in model order with the first model at the top; separate y2 panel below the main panel, no ticks, fixed range. (pv:360-366, 443-448)
- [ ] **Ridge shape**: stepped pmf outline (each candidate week spans ±3.5 days around its Saturday), closed along the lane baseline, filled with model color at alpha .32, 1 px outline. (pv:231-244, 366-371)
- [ ] **Ridge scale**: heights = prob × 1.7 / pmax, pmax = max(.05, largest probability across all models), so lanes overlap up to 1.7 lane heights. (pv:361-366)
- [ ] **Ridge median tick**: vertical model-color line (width 2) at the median week, 0.85 lane high. (pv:379-383)
- [ ] **Ridge lane label**: model label truncated to 34 chars, at the left edge in model color on a badge background; 8 px when lanes < 17 px, else 9 px. (pv:384-389)
- [ ] **Ridge panel caption**: "PEAK WEEK PROBABILITY" right-aligned above the lanes. (pv:402-407)
- [ ] **Cutoff/round marks**: shaded band data cutoff → round date (`cutoffFill`), dotted round line (`refLine`), label " Round" at the top. (pv:392-401)
- [ ] **Outlook x range**: window start − 21 days to window end + 10 days (falls back to the first truth date / reference date). (pv:409-412)
- [ ] **Outlook y range**: 0 → 1.1 × max(1, truth inside the x range, every model's 90% size upper, observed peak); y title "Peak weekly admissions" (hard-coded). (pv:413-435)
- [ ] **Outlook geometry**: lane height clamp(300/n, 13, 40) px, ridge band n·lane + 34 px, main panel 340 px, total height main + ridge + 70; main panel domain starts at min(.62, ridgeTop + .07). (pv:277-283)
- [ ] **Outlook chrome**: horizontal legend below (▲ per model, size-only lines, observed peak), hover `closest`, modebar without logo/lasso/select, uirevision per location+season. (pv:436-457)
- [ ] **PEAK CALL BY ROUND card**: one model's peak calls across every round of the season at the shown location; subtitle "N round(s) · click a row to open that round". (html:1144-1154, pv:480-503)
- [ ] **Round rows**: categorical y axis of rounds labelled "Mon D", earliest at top (reversed), every 2nd label when > 24 rounds. (pv:497-500, 590-594)
- [ ] **Timing heatmap** (left, x domain 0–0.62 when sizes exist): probability per candidate week (union of all rounds' weeks; missing week = 0; round without timing = empty row), colorscale model color alpha .03 → .22 → .62 → 1 at 0/.08/.4/1, zmin 0, zmax max(.05, max prob), no colorbar. (pv:507-519)
- [ ] **Data-through tick**: per round a vertical tick (`line-ns`, size 11, muted) at ref − 7. (pv:520-525)
- [ ] **Median path**: line + markers (size 5, #073642 / #f6f4ee) through each round's median peak week. (pv:526-533)
- [ ] **Size intervals** (right, x2 domain 0.69–1, range 0 → 1.08 × max(90% upper, observed)): per round a 90% bar (model color alpha .55, width 2), 50% bar (width 6) and median dot (background fill, model-color ring). (pv:536-557, 585-589)
- [ ] **Observed peak lines** on both panels (date on timing, value on size), solid when final, dotted when provisional. (pv:559-565)
- [ ] **Current round highlight**: faint band behind the selected round's row. (pv:566-572)
- [ ] **Evolution layout**: height clamp(80 + 17·rounds, 240, 560); panel headers "TIMING (probability per week)" and "SIZE (median · 50% · 90%)"; no legend, no modebar; uirevision per model+location+season. (pv:574-606)
- [ ] **Scorecard rows (This Round)**: models with timing or size this round, sorted by median peak week, timing-less rows last. (pv:639-646)
- [ ] **Model cell**: color swatch (model color) + short label (`modelLabel` without hub), full label with hub as tooltip. (pv:667)
- [ ] **This Round columns**: "Peak week" (median, Mon D), "50% window" (a – b), "Past?" (p_passed %, 0dp), "Peak size" (fmtCount), "90% range" (lo – hi); missing → "—"; header tooltips explain each. (pv:648-672)
- [ ] **This Round score columns** (only when the observed peak is final): "Δ wks" (signed weeks, `+N`, highlighted `.lead` when 0), "RPS" (2dp), "Size err" (signed %, 0dp). (pv:656, 673-676)
- [ ] **This Round footer**: "Observed peak: **N** in the week ending <Mon D, YYYY>." or "Peak so far: N (<Mon D>); scores appear once the window closes <date>.", then "No forecast this round: …" and "No peak forecasts at all: …" (first 6 names, "+N more"). (pv:679-695)
- [ ] **Season Skill columns**: Model, "N" (forecasts scored = n_timing or n_size), "RPS" 2dp, "Log" 2dp, "|Δ| wks" 1dp, "Hit 50/90" (x% / y%), "WIS %" 1dp, "|Err|" 0dp %, "Cov 50/90"; each header has a tooltip definition. (pv:734-747)
- [ ] **Season Skill best values**: lowest RPS, Log, |Δ| wks and WIS % are highlighted (`.lead`); hit/coverage columns not ranked. (pv:710-731)
- [ ] **Season Skill footer**: "Pooled over N states with a final peak" (scope states) or "Every round", " in 2024–25", then ", on the rounds all models forecast" (common) or ", each model on its own rounds", then " N location(s) still provisional are left out." when any. (pv:749-752)

## Hover/inspector

- [ ] **▲ / size-only hover**: `peakHoverHtml` (see fan chart). (pv:246-261, 328, 335)
- [ ] **Truth hover**: "<Mon D, YYYY><br>Reported: N" / "Observed later: N" (integers with grouping). (pv:295, 303)
- [ ] **Observed hover**: "**Observed season peak**" or "**Highest week so far**", "<date>: N", plus "Provisional until the window closes (<date>)". (pv:349)
- [ ] **Ridge hover**: "**model**<br>Peak in week ending <Mon D>: p.p%". (pv:373-378)
- [ ] **Evolution hovers**: "Round <Mon D><br>Peak in week ending <Mon D>: p.p%"; "Round …: data through <Mon D>"; "Median peak week: <Mon D>"; "Peak size median N<br>50% a – b · 90% c – d". (pv:518, 524, 532, 554)
- [ ] **Number formats**: `fmtCount` ≥ 100 → rounded with grouping, else 3 significant digits, null → "—"; `fmtWeek` "Mon D" (UTC), with year "Mon D, YYYY"; `fmtPct` ×100 with given digits; season label "2024–25". (pv:40-55)

## Options and their values

- [ ] **State**: `peakScoreMode` round|skill, `peakSkillScope` location|states, `peakEvolutionModel`, `fairCommonTasks` (from the eval window) → `common`. (st:66-70, 32)

## Notices/empty/error states

- [ ] **Notice banner**: one notice at a time in `#peak-notice` (`data-kind` target|empty|round|info), title + HTML body + optional action button; hidden when nothing applies. Checked in the order below. (pv:180-198)
- [ ] **Notice: target without peaks** (checked before fetching): "Season peak forecasts belong to hospital admissions" / "**<target display name>** has no peak targets. Peak timing and peak size are forecast for weekly flu hospital admissions." + "Switch to Flu Hosp" (clicks the first peak-capable target); all plots, scorecard, select and chip cleared, no request sent. (pv:80-93, 167-178)
- [ ] **Notice: no models selected**: "No models selected" / "Select models in the model bar to compare their season peak forecasts." (pv:129-134)
- [ ] **Notice: no selected model has peak data**: "None of the selected models submit season peak forecasts"; body names enabled synced hubs with `peak_outdated > 0` ("… was synced before peak forecasts were supported. Update it from the **FluSight Sandbox** menu to bring them in.") or the generic "Peak forecasts come from models that submit the hub's peak targets, for example the FluSight ensemble and many teams on the live hub shelf." (pv:135-139)
- [ ] **Notice: no forecasts this round**: "No peak forecasts for the round of <Mon D, YYYY>" / "The selected models submitted peak forecasts for N round(s) of 2024–25." or "The selected models have no peak forecasts in this season."; button "Go to <nearest peak round>" (nearest by date among `peak_rounds`, else `latest_peak_round`) selects that date. (pv:140-150)
- [ ] **Notice: outdated hubs** (info, when everything else is fine): "Some hub data predates peak support" / "<hubs> has files synced before peak forecasts were kept. Update it from the **FluSight Sandbox** menu to fill in the missing rounds." (pv:151-156)
- [ ] **Outlook empty annotation**: "No peak forecasts for this round" or "No peak forecasts for the selected models". (pv:449-455)
- [ ] **Evolution empty**: "No round-by-round peak forecasts to show for 2024–25." (pv:489-494)
- [ ] **Scorecard empties**: "No peak forecasts for this round." + footnote; skill not final: "The 2024–25 peak is not final yet for <location|all states>. Peak forecasts are scored once observations reach the end of the forecast window (<date>)." + "Highest week so far: N (<date>)."; no skill rows: "No peak forecasts from the selected models in 2024–25." (pv:643-645, 700-709)
- [ ] **Loading/error**: container `.is-loading` while fetching; banner "Could not load season peak forecasts (<msg>)." (pv:95-117)

## URL parameters and persisted state

- [ ] **URL**: `view=peak`, `peak_model` (when set). Score mode and skill scope are not persisted. (st:284-286, 368-370)

## Edge cases

- [ ] **Truth toggle does not re-render the peak view** (handler only re-renders the fan chart); the change shows on the next peak render. (main:1255-1263)
- [ ] **"Reported" truth ignores the Truth toggle** and uses revised (latest) values, not as-of data. (pv:290-297)
- [ ] **Historical rounds show the hindsight observed peak** (final ★ after the round date) because observed is computed from today's truth. (pk:296-321)
- [ ] **No timing but sizes in evolution**: x domain stays [0, .62] while x2 takes [0, 1], overlapping. (pv:582-588)
- [ ] **Ensemble/synthetic models** have no peak tables (`_scan` returns None) and appear under "No peak forecasts at all". (pd:64-67)

# /api/season-curves (shared truth endpoint)

- [ ] **GET /api/season-curves**: params `target`, `location` (`states`/`all` → US), `seasons` (comma; default all forecast seasons). Response `{location, target, peak_fraction: 0.6, curves [{season, points [{week, date, value, phase pre|peak|post}], peak_weeks [first, last] | null, peaked}], month_ticks [{week, label "Aug"…}], reference_season, week_dates [53 Saturdays]}`; curves newest season first. Used by the eval-window picker, not by these four views. (srv:505-513, dl:343-383, api.js:237)
- [ ] **Phase rule**: peak = contiguous weeks around the season max at ≥ 60% of it; pre/post before/after; a still-open season (season end > 21 days after the last observation) whose max is one of its last two weeks is all "pre"; seasons with < 3 points or zero max get null phases. (dl:288-341)
