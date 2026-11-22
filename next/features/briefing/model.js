/* Pure headless data & geometry transformations for the Place-First Briefing view.
 * Kept 100% DOM-free so both BriefingView.js and unit tests import it directly. */

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function parseBriefingHash(hashStr = "") {
  const h = String(hashStr || "").trim();
  if (!h.startsWith("#briefing")) return { active: false, placeKey: null };
  const rest = h.slice("#briefing".length);
  if (!rest || rest === "/") return { active: true, placeKey: null };
  if (!rest.startsWith("/")) return { active: false, placeKey: null };
  const rawPlace = rest.slice(1).split("?")[0].trim();
  if (!rawPlace) return { active: true, placeKey: null };
  try {
    return { active: true, placeKey: decodeURIComponent(rawPlace) };
  } catch {
    return { active: true, placeKey: rawPlace };
  }
}

export function buildBriefingHash(placeKey) {
  const k = String(placeKey || "").trim();
  return k ? `#briefing/${encodeURIComponent(k)}` : "#briefing";
}

export function parseIsoUtcMs(iso) {
  if (!iso || typeof iso !== "string") return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function formatIsoShort(iso, includeYear = false) {
  const ms = parseIsoUtcMs(iso);
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const base = `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return includeYear ? `${base}, ${d.getUTCFullYear()}` : base;
}

export function formatMetricValue(val, { unit = "", per100k = false } = {}) {
  if (val == null || typeof val !== "number" || !Number.isFinite(val)) return "—";
  if (String(unit).includes("%")) return `${Math.abs(val) < 10 ? val.toFixed(2) : val.toFixed(1)}%`;
  const a = Math.abs(val);
  if (a >= 1000 && !per100k) return Math.round(val).toLocaleString("en-US");
  if (a >= 100) return Math.round(val).toString();
  if (a >= 10) return val.toFixed(1);
  if (a > 0 && a < 0.1) return val.toFixed(2);
  return Number.isInteger(val) ? String(val) : val.toFixed(2);
}

export function formatSignedPct(pct) {
  if (pct == null || typeof pct !== "number" || !Number.isFinite(pct)) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function formatTimeAgo(iso, nowMs = Date.now()) {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const diffSec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

function niceStep(maxVal, targetTicks = 4) {
  if (!(maxVal > 0)) return 1;
  const raw = maxVal / Math.max(1, targetTicks);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  const mult = norm <= 1.5 ? 1 : (norm <= 3 ? 2 : (norm <= 7 ? 5 : 10));
  return mult * pow;
}

export function formatAxisTick(v, isPct = false) {
  if (!Number.isFinite(v)) return "";
  if (isPct) return `${Number(v.toFixed(1))}%`;
  const a = Math.abs(v);
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
  if (a >= 10 || Number.isInteger(v)) return `${Math.round(v)}`;
  return `${+v.toFixed(2)}`;
}

export function buildSparklineGeometry(values, width = 92, height = 22, pad = 2) {
  const clean = (values || []).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!clean.length) return { path: "", areaPath: "", lastX: 0, lastY: height / 2, min: 0, max: 0 };
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min;
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  const pts = clean.map((v, i) => {
    const x = clean.length === 1 ? pad + innerW / 2 : pad + (i / (clean.length - 1)) * innerW;
    const normY = span > 0 ? (v - min) / span : 0.5;
    const y = pad + (1 - normY) * innerH;
    return [Number(x.toFixed(2)), Number(y.toFixed(2))];
  });
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ");
  const last = pts[pts.length - 1];
  const first = pts[0];
  const baseY = Number((height - pad).toFixed(2));
  const areaPath = `${path} L${last[0]},${baseY} L${first[0]},${baseY} Z`;
  return { path, areaPath, lastX: last[0], lastY: last[1], min, max };
}

function buildPolygonPath(xs, lowers, uppers) {
  if (xs.length < 2) return "";
  const top = [];
  const bot = [];
  for (let i = 0; i < xs.length; i++) {
    if (lowers[i] == null || uppers[i] == null) continue;
    top.push(`${top.length === 0 ? "M" : "L"}${xs[i]},${uppers[i]}`);
    bot.unshift(`L${xs[i]},${lowers[i]}`);
  }
  if (top.length < 2) return "";
  return `${top.join(" ")} ${bot.join(" ")} Z`;
}

export function buildOutlookGeometry(
  signal,
  {
    showPrior = false,
    width = 760,
    height = 264,
    pad = { t: 16, r: 18, b: 28, l: 48 },
  } = {},
) {
  const obsRaw = Array.isArray(signal?.observed) ? signal.observed : [];
  const fan = signal?.fan || null;
  const priorRaw = showPrior && Array.isArray(signal?.prior_seasons) ? signal.prior_seasons : [];

  const obsAll = obsRaw
    .map((p) => ({ ...p, ms: parseIsoUtcMs(p.date) }))
    .filter((p) => Number.isFinite(p.ms) && Number.isFinite(p.value))
    .sort((a, b) => a.ms - b.ms);

  const fanDates = (fan?.target_end_dates || []).map(parseIsoUtcMs);
  const fanEndMs = fanDates.length ? Math.max(...fanDates.filter(Number.isFinite)) : NaN;
  const obsEndMs = obsAll.length ? obsAll[obsAll.length - 1].ms : NaN;
  const maxObsOrFanMs = Number.isFinite(fanEndMs) && Number.isFinite(obsEndMs)
    ? Math.max(fanEndMs, obsEndMs)
    : (Number.isFinite(fanEndMs) ? fanEndMs : obsEndMs);

  // When prior seasons are overlaid, show fuller season trajectory; else focus cleanly on last ~22 wks + forecast
  const obsMinMs = obsAll.length ? obsAll[0].ms : NaN;
  const minDomainMs = Number.isFinite(obsMinMs) ? obsMinMs : (Number.isFinite(maxObsOrFanMs) ? maxObsOrFanMs - 140 * 86400000 : 0);
  const maxDomainMs = Number.isFinite(maxObsOrFanMs)
    ? (priorRaw.length ? Math.max(maxObsOrFanMs, minDomainMs + 28 * 7 * 86400000) : maxObsOrFanMs)
    : minDomainMs + 7 * 86400000;

  let yMaxRaw = 0;
  for (const p of obsAll) yMaxRaw = Math.max(yMaxRaw, p.value);
  if (fan) {
    for (const arr of [fan.q95_upper, fan.q80_upper, fan.median]) {
      for (const v of arr || []) {
        if (typeof v === "number" && Number.isFinite(v)) yMaxRaw = Math.max(yMaxRaw, v);
      }
    }
  }
  for (const ps of priorRaw) {
    for (const p of ps.points || []) {
      const ms = parseIsoUtcMs(p.date);
      if (Number.isFinite(ms) && ms <= maxDomainMs && Number.isFinite(p.value)) {
        yMaxRaw = Math.max(yMaxRaw, p.value);
      }
    }
  }

  const step = niceStep(yMaxRaw * 1.08 || 1, 4);
  const yMax = Math.max(step, Math.ceil((yMaxRaw * 1.08 || 1) / step) * step);
  const innerW = Math.max(1, width - pad.l - pad.r);
  const innerH = Math.max(1, height - pad.t - pad.b);
  const tSpan = Math.max(86400000, maxDomainMs - minDomainMs);

  const px = (ms) => Number((pad.l + ((ms - minDomainMs) / tSpan) * innerW).toFixed(2));
  const py = (val) => Number((pad.t + (1 - Math.max(0, Math.min(yMax, val)) / yMax) * innerH).toFixed(2));

  const yTicks = [];
  for (let v = 0; v <= yMax + step * 1e-6; v += step) {
    const cleanV = Number(v.toFixed(6));
    yTicks.push({ value: cleanV, y: py(cleanV), label: formatAxisTick(cleanV, String(signal?.unit || "").includes("%")) });
  }

  // Monthly UTC ticks across [minDomainMs, maxDomainMs]
  const xTicks = [];
  if (Number.isFinite(minDomainMs) && Number.isFinite(maxDomainMs)) {
    const d0 = new Date(minDomainMs);
    let yr = d0.getUTCFullYear();
    let mo = d0.getUTCMonth();
    if (d0.getUTCDate() > 10) { mo += 1; if (mo > 11) { mo = 0; yr += 1; } }
    for (let safety = 0; safety < 18; safety++) {
      const mMs = Date.UTC(yr, mo, 1);
      if (mMs > maxDomainMs) break;
      if (mMs >= minDomainMs) {
        xTicks.push({
          ms: mMs,
          x: px(mMs),
          label: mo === 0 ? `${MONTHS_SHORT[mo]} '${String(yr).slice(-2)}` : MONTHS_SHORT[mo],
        });
      }
      mo += 1;
      if (mo > 11) { mo = 0; yr += 1; }
    }
  }

  const observedPoints = obsAll.map((p) => ({
    x: px(p.ms),
    y: py(p.value),
    date: p.date,
    value: p.value,
    week: p.week,
  }));
  const observedPath = observedPoints.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");

  const priorSeries = priorRaw.map((ps, idx) => {
    const pts = (ps.points || [])
      .map((p) => ({ ...p, ms: parseIsoUtcMs(p.date) }))
      .filter((p) => Number.isFinite(p.ms) && p.ms >= minDomainMs && p.ms <= maxDomainMs && Number.isFinite(p.value))
      .sort((a, b) => a.ms - b.ms)
      .map((p) => ({ x: px(p.ms), y: py(p.value), date: p.date, origDate: p.orig_date, value: p.value }));
    return {
      season: ps.season,
      colorVar: `--season-${(idx % 4) + 1}`,
      path: pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" "),
      points: pts,
    };
  }).filter((s) => s.points.length >= 2);

  let fanGeom = null;
  if (fan && Array.isArray(fan.target_end_dates) && fan.target_end_dates.length) {
    const refMs = parseIsoUtcMs(fan.ref_date);
    // Anchor onto last observed point at or prior to earliest forecast date (or ref_date)
    const firstFcMs = parseIsoUtcMs(fan.target_end_dates[0]);
    const anchorTargetMs = Number.isFinite(refMs) ? refMs : firstFcMs;
    const anchorObs = obsAll.filter((p) => p.ms <= anchorTargetMs).at(-1) || obsAll.at(-1) || null;

    const xs = [];
    const yMed = [];
    const yLo95 = [];
    const yHi95 = [];
    const yLo80 = [];
    const yHi80 = [];
    const yLo50 = [];
    const yHi50 = [];
    const hoverPoints = [];

    if (anchorObs && (!Number.isFinite(firstFcMs) || anchorObs.ms < firstFcMs)) {
      const ax = px(anchorObs.ms);
      const ay = py(anchorObs.value);
      xs.push(ax);
      yMed.push(ay);
      yLo95.push(ay); yHi95.push(ay);
      yLo80.push(ay); yHi80.push(ay);
      yLo50.push(ay); yHi50.push(ay);
    }

    for (let i = 0; i < fan.target_end_dates.length; i++) {
      const ms = parseIsoUtcMs(fan.target_end_dates[i]);
      const m = fan.median?.[i];
      if (!Number.isFinite(ms) || !Number.isFinite(m)) continue;
      const x = px(ms);
      const ym = py(m);
      const l95 = fan.q95_lower?.[i]; const u95 = fan.q95_upper?.[i];
      const l80 = fan.q80_lower?.[i]; const u80 = fan.q80_upper?.[i];
      const l50 = fan.q50_lower?.[i]; const u50 = fan.q50_upper?.[i];
      xs.push(x);
      yMed.push(ym);
      yLo95.push(Number.isFinite(l95) ? py(l95) : null);
      yHi95.push(Number.isFinite(u95) ? py(u95) : null);
      yLo80.push(Number.isFinite(l80) ? py(l80) : null);
      yHi80.push(Number.isFinite(u80) ? py(u80) : null);
      yLo50.push(Number.isFinite(l50) ? py(l50) : null);
      yHi50.push(Number.isFinite(u50) ? py(u50) : null);
      hoverPoints.push({
        x, y: ym,
        date: fan.target_end_dates[i],
        horizon: fan.horizons?.[i],
        median: m,
        q95: [l95, u95],
        q50: [l50, u50],
      });
    }

    const refLineX = anchorObs ? px(anchorObs.ms) : (Number.isFinite(refMs) ? px(refMs) : pad.l);
    fanGeom = {
      modelId: fan.model_id,
      refDate: fan.ref_date,
      refX: refLineX,
      shadeRect: { x: refLineX, w: Math.max(0, pad.l + innerW - refLineX) },
      q95Path: buildPolygonPath(xs, yLo95, yHi95),
      q80Path: buildPolygonPath(xs, yLo80, yHi80),
      q50Path: buildPolygonPath(xs, yLo50, yHi50),
      medianPath: xs.map((x, i) => `${i === 0 ? "M" : "L"}${x},${yMed[i]}`).join(" "),
      points: hoverPoints,
    };
  }

  return {
    width,
    height,
    pad,
    innerW,
    innerH,
    yMax,
    xTicks,
    yTicks,
    observedPoints,
    observedPath,
    priorSeries,
    fan: fanGeom,
  };
}

const RATE_CAT_ORDER = [
  { key: "large_decrease", label: "Large decrease", shortLabel: "Lg dec", tone: "cool-2" },
  { key: "decrease", label: "Decrease", shortLabel: "Dec", tone: "cool-1" },
  { key: "stable", label: "Stable", shortLabel: "Stable", tone: "neutral" },
  { key: "increase", label: "Increase", shortLabel: "Inc", tone: "warm-1" },
  { key: "large_increase", label: "Large increase", shortLabel: "Lg inc", tone: "warm-2" },
];

export function normalizeRateChangePmf(pmf) {
  if (!pmf || !pmf.probs) return [];
  const probs = pmf.probs || {};
  const cats = Object.keys(probs);
  if (!cats.length) return [];

  const metaByKey = new Map(RATE_CAT_ORDER.map((c) => [c.key, c]));
  const ordered = [];
  for (const spec of RATE_CAT_ORDER) {
    if (spec.key in probs) ordered.push(spec.key);
  }
  for (const c of cats) {
    if (!metaByKey.has(c)) ordered.push(c);
  }

  const rawSum = ordered.reduce((acc, k) => acc + Math.max(0, Number(probs[k]) || 0), 0);
  const scale = rawSum > 0 ? 100 / rawSum : 0;

  return ordered.map((k) => {
    const p = Math.max(0, Number(probs[k]) || 0);
    const meta = metaByKey.get(k);
    return {
      key: k,
      label: meta?.label || k.replace(/_/g, " "),
      shortLabel: meta?.shortLabel || k.replace(/_/g, " "),
      tone: meta?.tone || "neutral",
      prob: p,
      pct: Number((p * scale).toFixed(1)),
    };
  });
}

export function buildStackedSegments(items) {
  const valid = (items || []).filter((it) => typeof it?.value === "number" && Number.isFinite(it.value) && it.value > 0);
  const total = valid.reduce((s, it) => s + it.value, 0);
  if (!(total > 0)) return [];
  return valid.map((it, idx) => {
    const pct = (it.value / total) * 100;
    return {
      label: it.label,
      value: it.value,
      pct: Number(pct.toFixed(1)),
      widthPct: Number(pct.toFixed(2)),
      colorVar: it.colorVar || `--series-${(idx % 8) + 1}`,
    };
  });
}

export function buildCladeTimelineGeometry(
  cladeObj,
  { width = 820, height = 252, pad = { t: 12, r: 158, b: 26, l: 40 } } = {},
) {
  const dates = Array.isArray(cladeObj?.dates) ? cladeObj.dates : [];
  const clades = Array.isArray(cladeObj?.clades) ? cladeObj.clades : [];
  const byClade = cladeObj?.series_by_clade || {};
  if (dates.length < 2 || !clades.length) {
    return { width, height, pad, innerW: 0, innerH: 0, areas: [], rightLabels: [], columns: [], xTicks: [], yTicks: [] };
  }

  const innerW = Math.max(1, width - pad.l - pad.r);
  const innerH = Math.max(1, height - pad.t - pad.b);
  const xAt = (i) => Number((pad.l + (i / (dates.length - 1)) * innerW).toFixed(2));
  const yAt = (pct) => Number((pad.t + (1 - Math.max(0, Math.min(100, pct)) / 100) * innerH).toFixed(2));

  // Normalize clade proportions per date slice to 100%
  const colTotals = dates.map((_, di) => {
    let sum = 0;
    for (const c of clades) sum += Math.max(0, Number(byClade[c]?.[di]) || 0);
    return sum > 0 ? sum : 100;
  });

  const cumLower = dates.map(() => 0);
  const bandPositions = [];
  const areas = clades.map((c, idx) => {
    const arr = byClade[c] || [];
    const upper = dates.map((_, di) => {
      const share = ((Math.max(0, Number(arr[di]) || 0)) / colTotals[di]) * 100;
      return Math.min(100, cumLower[di] + share);
    });
    const xs = dates.map((_, di) => xAt(di));
    const yLo = cumLower.map((v) => yAt(v));
    const yHi = upper.map((v) => yAt(v));
    const path = buildPolygonPath(xs, yHi, yLo); // note SVG y goes down so upper pct has smaller y
    const lastIdx = dates.length - 1;
    const midY = (yHi[lastIdx] + yLo[lastIdx]) / 2;
    const latestPct = Number(((Math.max(0, Number(arr[lastIdx]) || 0) / colTotals[lastIdx]) * 100).toFixed(1));
    const colorVar = c === "Other" ? "--ink-faint" : `--series-${(idx % 8) + 1}`;
    bandPositions.push({ clade: c, pct: latestPct, anchorY: Number(midY.toFixed(2)), colorVar });
    for (let di = 0; di < dates.length; di++) cumLower[di] = upper[di];
    return {
      clade: c,
      colorVar,
      path,
      latestPct,
    };
  });

  // Resolve right-margin direct label collisions (sort top-to-bottom by anchorY)
  const visibleLabels = bandPositions
    .filter((b) => b.pct >= 2.0)
    .sort((a, b) => a.anchorY - b.anchorY);
  const minGap = 17;
  const topBound = pad.t + 7;
  const botBound = height - pad.b - 6;
  let prevY = topBound - minGap;
  for (const lb of visibleLabels) {
    lb.labelY = Math.max(lb.anchorY, prevY + minGap);
    prevY = lb.labelY;
  }
  // Backward pass so bottom labels stay within plot bottom bound
  let nextLimit = botBound;
  for (let i = visibleLabels.length - 1; i >= 0; i--) {
    if (visibleLabels[i].labelY > nextLimit) {
      visibleLabels[i].labelY = nextLimit;
    }
    nextLimit = visibleLabels[i].labelY - minGap;
  }
  const rightLabels = visibleLabels.map((lb) => ({
    ...lb,
    labelY: Number(Math.max(topBound, Math.min(botBound, lb.labelY)).toFixed(2)),
    xEdge: Number((pad.l + innerW).toFixed(2)),
    xText: Number((pad.l + innerW + 10).toFixed(2)),
  }));

  const tickIndices = dates.length <= 5
    ? dates.map((_, i) => i)
    : [0, Math.floor((dates.length - 1) / 3), Math.floor(((dates.length - 1) * 2) / 3), dates.length - 1];
  const xTicks = [...new Set(tickIndices)].map((i) => ({
    x: xAt(i),
    label: formatIsoShort(dates[i]),
  }));
  const yTicks = [0, 50, 100].map((v) => ({ value: v, y: yAt(v), label: `${v}%` }));

  const columns = dates.map((dt, di) => ({
    date: dt,
    x: xAt(di),
    shares: clades
      .map((c) => ({
        clade: c,
        pct: Number(((Math.max(0, Number(byClade[c]?.[di]) || 0) / colTotals[di]) * 100).toFixed(1)),
      }))
      .filter((s) => s.pct >= 1.0)
      .sort((a, b) => b.pct - a.pct),
  }));

  return { width, height, pad, innerW, innerH, areas, rightLabels, columns, xTicks, yTicks };
}

const SUBTYPE_SERIES_SPEC = [
  { key: "ah1n1pdm09", label: "A(H1N1)pdm09", colorVar: "--series-2" },
  { key: "ah3n2", label: "A(H3N2)", colorVar: "--series-3" },
  { key: "a_unsub_rem", label: "A (unsubtyped)", colorVar: "--ink-tertiary" },
  { key: "inf_b", label: "Influenza B", colorVar: "--series-4" },
];

export function buildSubtypeTimelineGeometry(
  series,
  { width = 820, height = 196, pad = { t: 12, r: 16, b: 28, l: 46 } } = {},
) {
  const rows = (Array.isArray(series) ? series : [])
    .filter((r) => r?.date)
    .slice(-16)
    .map((r) => {
      const h1 = Math.max(0, Number(r.ah1n1pdm09) || 0);
      const h3 = Math.max(0, Number(r.ah3n2) || 0);
      const infA = Math.max(0, Number(r.inf_a) || 0);
      const unsub = infA > h1 + h3 ? infA - h1 - h3 : Math.max(0, Number(r.a_unsubtyped) || 0);
      const infB = Math.max(0, Number(r.inf_b) || 0);
      const total = h1 + h3 + unsub + infB;
      return {
        date: String(r.date).slice(0, 10),
        specimens: Number(r.spec_processed ?? r.specimens) || 0,
        ah1n1pdm09: h1,
        ah3n2: h3,
        a_unsub_rem: unsub,
        inf_b: infB,
        total,
      };
    });

  if (!rows.length) {
    return { width, height, pad, innerW: 0, innerH: 0, bars: [], legend: [], xTicks: [], yTicks: [] };
  }

  const maxTotalRaw = Math.max(1, ...rows.map((r) => r.total));
  const step = niceStep(maxTotalRaw * 1.05, 4);
  const yMax = Math.max(step, Math.ceil((maxTotalRaw * 1.05) / step) * step);
  const innerW = Math.max(1, width - pad.l - pad.r);
  const innerH = Math.max(1, height - pad.t - pad.b);
  const slotW = innerW / rows.length;
  const barW = Number(Math.max(4, Math.min(34, slotW * 0.68)).toFixed(2));
  const yAt = (val) => Number((pad.t + (1 - Math.max(0, Math.min(yMax, val)) / yMax) * innerH).toFixed(2));
  const baseY = Number((pad.t + innerH).toFixed(2));

  const seenKeys = new Set();
  const bars = rows.map((row, idx) => {
    const cx = pad.l + (idx + 0.5) * slotW;
    const x = Number((cx - barW / 2).toFixed(2));
    let cumVal = 0;
    const segments = [];
    for (const sp of SUBTYPE_SERIES_SPEC) {
      const val = row[sp.key] || 0;
      if (val <= 0) continue;
      seenKeys.add(sp.key);
      const yBot = yAt(cumVal);
      cumVal += val;
      const yTop = yAt(cumVal);
      const pct = row.total > 0 ? Number(((val / row.total) * 100).toFixed(1)) : 0;
      segments.push({
        key: sp.key,
        label: sp.label,
        value: val,
        pct,
        x,
        w: barW,
        y: yTop,
        h: Number(Math.max(0.8, yBot - yTop).toFixed(2)),
        colorVar: sp.colorVar,
      });
    }
    return {
      date: row.date,
      cx: Number(cx.toFixed(2)),
      x,
      w: barW,
      total: row.total,
      specimens: row.specimens,
      baseY,
      segments,
    };
  });

  const yTicks = [];
  for (let v = 0; v <= yMax + step * 1e-6; v += step) {
    const cv = Number(v.toFixed(6));
    yTicks.push({ value: cv, y: yAt(cv), label: formatAxisTick(cv, false) });
  }
  const tickIdxs = rows.length <= 5
    ? rows.map((_, i) => i)
    : [0, Math.floor((rows.length - 1) / 3), Math.floor(((rows.length - 1) * 2) / 3), rows.length - 1];
  const xTicks = [...new Set(tickIdxs)].map((i) => ({
    x: bars[i].cx,
    label: formatIsoShort(rows[i].date),
  }));
  const legend = SUBTYPE_SERIES_SPEC.filter((sp) => seenKeys.has(sp.key));

  return { width, height, pad, innerW, innerH, yMax, bars, legend, xTicks, yTicks };
}
