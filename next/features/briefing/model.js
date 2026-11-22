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
    width = 680,
    height = 248,
    pad = { t: 16, r: 16, b: 28, l: 48 },
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
  { width = 560, height = 136, pad = { t: 8, r: 8, b: 22, l: 34 } } = {},
) {
  const dates = Array.isArray(cladeObj?.dates) ? cladeObj.dates : [];
  const clades = Array.isArray(cladeObj?.clades) ? cladeObj.clades : [];
  const byClade = cladeObj?.series_by_clade || {};
  if (dates.length < 2 || !clades.length) return { areas: [], xTicks: [], yTicks: [] };

  const innerW = Math.max(1, width - pad.l - pad.r);
  const innerH = Math.max(1, height - pad.t - pad.b);
  const xAt = (i) => Number((pad.l + (i / (dates.length - 1)) * innerW).toFixed(2));
  const yAt = (pct) => Number((pad.t + (1 - Math.max(0, Math.min(100, pct)) / 100) * innerH).toFixed(2));

  // Stack clade shares chronologically (normalized per date slice to 100% max)
  const colTotals = dates.map((_, di) => {
    let sum = 0;
    for (const c of clades) sum += Math.max(0, Number(byClade[c]?.[di]) || 0);
    return sum > 0 ? sum : 100;
  });

  const cumLower = dates.map(() => 0);
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
    for (let di = 0; di < dates.length; di++) cumLower[di] = upper[di];
    return {
      clade: c,
      colorVar: c === "Other" ? "--ink-faint" : `--series-${(idx % 8) + 1}`,
      path,
      latestPct: Number(arr[dates.length - 1] ?? 0),
    };
  });

  const tickIndices = dates.length <= 4
    ? dates.map((_, i) => i)
    : [0, Math.floor((dates.length - 1) / 2), dates.length - 1];
  const xTicks = [...new Set(tickIndices)].map((i) => ({
    x: xAt(i),
    label: formatIsoShort(dates[i]),
  }));
  const yTicks = [0, 50, 100].map((v) => ({ value: v, y: yAt(v), label: `${v}%` }));

  return { width, height, pad, innerW, innerH, areas, xTicks, yTicks };
}
