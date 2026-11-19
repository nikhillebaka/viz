"""
Generalized epidemiological calendar abstraction for Hubverse infectious-disease hubs.

Replaces hardcoded CDC MMWR week-31 / Saturday assumptions with a declarative `CalendarSpec`
automatically inferred from `hub-config/tasks.json`, observed submission/target dates, or optional
`viz/config.json` overrides:
- MMWR (Sun–Sat) vs ISO-8601 (Mon–Sun) epiweeks (accurately handling 52/53-week years)
- Arbitrary round submission weekday vs target week-ending weekday (`horizon_offset_days`, e.g.,
  0 days for Sat->Sat FluSight/MetroCast, -3 days for Wed->Sun RespiCast)
- Seasonal NH respiratory years (`season_start_week=31`, e.g. '2025-2026') vs calendar years ('2025')
- Seasonal active months (e.g. Nov–Mar for flu/RSV vs year-round Jan–Dec for COVID-19)
"""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
import functools
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple, Union


DateLike = Union[str, date, datetime]

MMWR_SEASON_ACTIVE_MONTHS: Tuple[int, ...] = (11, 12, 1, 2, 3)
ALL_MONTHS: Tuple[int, ...] = tuple(range(1, 13))


def parse_iso_date(val: DateLike) -> date:
    """Coerce an ISO date/datetime string, datetime, or date into `datetime.date`."""
    if isinstance(val, datetime):
        return val.date()
    if isinstance(val, date):
        return val
    s = str(val).strip().split(" ", 1)[0][:10]
    return datetime.strptime(s, "%Y-%m-%d").date()


def _mmwr_year_start(year: int) -> date:
    """Sunday starting MMWR week 1 of `year` (the week containing Jan 4)."""
    jan4 = date(year, 1, 4)
    return jan4 - timedelta(days=(jan4.weekday() + 1) % 7)


def _iso_year_start(year: int) -> date:
    """Monday starting ISO week 1 of `year` (the week containing Jan 4)."""
    jan4 = date(year, 1, 4)
    return jan4 - timedelta(days=jan4.weekday())


def epiweek_year_start(year: int, week_system: str = "mmwr") -> date:
    return _iso_year_start(year) if week_system == "iso" else _mmwr_year_start(year)


def epiweek_for_date(dt: DateLike, week_system: str = "mmwr") -> Tuple[int, int]:
    """Return `(epi_year, epi_week)` (1..53) under MMWR (Sun–Sat) or ISO (Mon–Sun)."""
    d = parse_iso_date(dt)
    if week_system == "iso":
        iso = d.isocalendar()
        return int(iso.year), int(iso.week)

    start_sun = _mmwr_year_start(d.year)
    if d < start_sun:
        start_sun = _mmwr_year_start(d.year - 1)
        ew_year = d.year - 1
    else:
        next_start_sun = _mmwr_year_start(d.year + 1)
        if d >= next_start_sun:
            start_sun = next_start_sun
            ew_year = d.year + 1
        else:
            ew_year = d.year
    ew_week = (d - start_sun).days // 7 + 1
    return ew_year, ew_week


def weeks_in_epi_year(year: int, week_system: str = "mmwr") -> int:
    start = epiweek_year_start(year, week_system)
    nxt = epiweek_year_start(year + 1, week_system)
    return (nxt - start).days // 7


@functools.lru_cache(maxsize=8192)
def _cached_season_and_week(
    date_str: str,
    week_system: str,
    season_mode: str,
    season_start_week: int,
) -> Tuple[str, int]:
    d = parse_iso_date(date_str)
    ew_year, ew_week = epiweek_for_date(d, week_system=week_system)

    if season_mode == "calendar_year" or season_start_week <= 1:
        return str(ew_year), ew_week

    boundary = season_start_week - 1
    if ew_week <= boundary:
        season_start = ew_year - 1
        prior_weeks = weeks_in_epi_year(season_start, week_system)
        season_week = ew_week - boundary + prior_weeks
    else:
        season_start = ew_year
        season_week = ew_week - boundary
    return f"{season_start}-{season_start + 1}", season_week


@dataclass(frozen=True)
class CalendarSpec:
    """Complete calendar definition for one Hubverse hub."""

    week_system: str = "mmwr"  # "mmwr" (Sun-Sat) | "iso" (Mon-Sun)
    round_day_of_week: int = 5  # Python weekday 0=Mon..6=Sun (5=Sat, 2=Wed)
    target_day_of_week: int = 5  # 5=Sat, 6=Sun
    horizon_offset_days: int = 0  # target_end_date = reference_date + 7*h + horizon_offset_days
    season_mode: str = "respiratory_nh"  # "respiratory_nh" | "continuous" | "calendar_year"
    season_start_week: int = 31  # 31 for respiratory year (Aug..Jul), 1 for calendar year
    active_months: Tuple[int, ...] = MMWR_SEASON_ACTIVE_MONTHS
    round_id_col: str = "reference_date"  # "reference_date" | "origin_date"

    def date_to_season_and_week(self, dt: DateLike) -> Tuple[str, int]:
        """Return `(season_id, season_week)` for any date."""
        if isinstance(dt, str):
            s = dt.strip().split(" ", 1)[0][:10]
            return _cached_season_and_week(s, self.week_system, self.season_mode, self.season_start_week)
        iso = parse_iso_date(dt).strftime("%Y-%m-%d")
        return _cached_season_and_week(iso, self.week_system, self.season_mode, self.season_start_week)

    def season_for_date(self, dt: DateLike) -> str:
        try:
            return self.date_to_season_and_week(dt)[0]
        except Exception:
            return "Unknown"

    def season_bounds(self, season_or_year: Union[str, int]) -> Tuple[str, str]:
        """Return inclusive `(start_iso, end_iso)` for a season ID ('2025-2026' / '2025') or start year."""
        if isinstance(season_or_year, str):
            s = season_or_year.strip()
            start_year = int(s[:4])
        else:
            start_year = int(season_or_year)

        if self.season_mode == "calendar_year" or self.season_start_week <= 1:
            start = epiweek_year_start(start_year, self.week_system)
            end = epiweek_year_start(start_year + 1, self.week_system) - timedelta(days=1)
            return start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")

        wk_offset = self.season_start_week - 1
        start = epiweek_year_start(start_year, self.week_system) + timedelta(weeks=wk_offset)
        end = epiweek_year_start(start_year + 1, self.week_system) + timedelta(weeks=wk_offset - 1, days=6)
        return start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")

    def prev_season(self, season: str) -> str:
        """Return the immediately preceding season identifier."""
        s = str(season).strip()
        if "-" in s and len(s) >= 9:
            y = int(s[:4]) - 1
            return f"{y}-{y + 1}"
        if "/" in s and len(s) >= 7:
            y = int(s[:4]) - 1
            return f"{y}/{str(y + 1)[-2:]}"
        return str(int(s[:4]) - 1)

    def season_label(self, season: str) -> str:
        s = str(season).strip()
        if "-" in s and len(s) >= 9:
            return f"{s[:4]}–{s[7:9]}"
        return s

    def first_week_end_in_season(self, season_or_year: Union[str, int]) -> date:
        """Date of the week-ending day belonging to season week 1."""
        start_iso, _ = self.season_bounds(season_or_year)
        start = parse_iso_date(start_iso)
        offset = (self.target_day_of_week - start.weekday()) % 7
        return start + timedelta(days=offset)

    def derive_horizon(self, reference_date: DateLike, target_end_date: DateLike) -> Optional[int]:
        """Compute integer week horizon from `(reference_date, target_end_date)` using `horizon_offset_days`."""
        try:
            ref = parse_iso_date(reference_date)
            ted = parse_iso_date(target_end_date)
        except Exception:
            return None
        adjusted = (ted - ref).days - self.horizon_offset_days
        h = round(adjusted / 7.0)
        if abs(adjusted - 7 * h) <= 2:
            return int(h)
        return None

    def target_end_date_for(self, reference_date: DateLike, horizon: int) -> Optional[str]:
        """Compute canonical `target_end_date` ISO string for `(reference_date, horizon)`."""
        try:
            ref = parse_iso_date(reference_date)
        except Exception:
            return None
        ted = ref + timedelta(days=7 * int(horizon) + self.horizon_offset_days)
        return ted.strftime("%Y-%m-%d")

    def default_peak_window(self, season: str) -> Tuple[str, str]:
        """Season peak observation window aligned with the hub's target week-ending weekday."""
        y = int(str(season)[:4])
        if self.season_mode == "calendar_year" or self.season_start_week <= 1:
            return self.season_bounds(y)
        d = date(y, 10, 1)
        d += timedelta(days=(self.target_day_of_week - d.weekday()) % 7)
        e = date(y + 1, 5, 31)
        e -= timedelta(days=(e.weekday() - self.target_day_of_week) % 7)
        return d.strftime("%Y-%m-%d"), e.strftime("%Y-%m-%d")

    def to_dict(self) -> Dict[str, Any]:
        return {
            **asdict(self),
            "active_months": list(self.active_months),
        }


DEFAULT_FLUSIGHT_CALENDAR = CalendarSpec()


def _collect_task_dates(tasks_config: Optional[Dict[str, Any]]) -> Tuple[str, List[str], List[str], List[Tuple[str, int, str]]]:
    round_id_col = "reference_date"
    ref_dates: List[str] = []
    ted_dates: List[str] = []
    triples: List[Tuple[str, int, str]] = []
    if not isinstance(tasks_config, dict):
        return round_id_col, ref_dates, ted_dates, triples

    for rnd in tasks_config.get("rounds") or []:
        if not isinstance(rnd, dict):
            continue
        rid = rnd.get("round_id")
        if isinstance(rid, str) and rid.strip():
            round_id_col = rid.strip()
        for mt in rnd.get("model_tasks") or []:
            if not isinstance(mt, dict):
                continue
            tids = mt.get("task_ids") or {}
            ref_spec = tids.get(round_id_col) or tids.get("reference_date") or tids.get("origin_date") or {}
            ted_spec = tids.get("target_end_date") or {}
            h_spec = tids.get("horizon") or {}

            mt_refs: List[str] = []
            for bucket, spec in ((mt_refs, ref_spec), (ted_dates, ted_spec)):
                if isinstance(spec, dict):
                    for k in ("required", "optional"):
                        vals = spec.get(k)
                        if isinstance(vals, list):
                            bucket.extend(str(x).strip()[:10] for x in vals if x is not None and len(str(x).strip()) >= 10)
            ref_dates.extend(mt_refs)

            if isinstance(h_spec, dict) and isinstance(ted_spec, dict):
                mt_teds: List[str] = []
                for k in ("required", "optional"):
                    vals = ted_spec.get(k)
                    if isinstance(vals, list):
                        mt_teds.extend(str(x).strip()[:10] for x in vals if x is not None and len(str(x).strip()) >= 10)
                hs: List[int] = []
                for k in ("required", "optional"):
                    vals = h_spec.get(k)
                    if isinstance(vals, list):
                        for x in vals:
                            try:
                                hs.append(int(x))
                            except (TypeError, ValueError):
                                pass
                if mt_refs and mt_teds and hs:
                    triples.append((min(mt_refs), min(hs), min(mt_teds)))
    return round_id_col, ref_dates, ted_dates, triples


def infer_calendar(
    tasks_config: Optional[Dict[str, Any]] = None,
    *,
    observed_rounds: Optional[Sequence[str]] = None,
    observed_target_dates: Optional[Sequence[str]] = None,
    observed_pairs: Optional[Sequence[Tuple[str, int, str]]] = None,
    targets: Optional[Iterable[str]] = None,
    user_override: Optional[Dict[str, Any]] = None,
) -> CalendarSpec:
    """
    Infer a hub's CalendarSpec from Hubverse `tasks.json`, observed data, and optional user overrides.
    Zero external hardcoding: handles MMWR/Sat, ISO/Wed->Sun (-3d), seasonal vs year-round COVID.
    """
    round_id_col, cfg_refs, cfg_teds, cfg_triples = _collect_task_dates(tasks_config)

    all_refs = list(cfg_refs) + [str(d)[:10] for d in (observed_rounds or []) if d]
    all_teds = list(cfg_teds) + [str(d)[:10] for d in (observed_target_dates or []) if d]

    ref_dows: Counter[int] = Counter()
    for s in all_refs:
        try:
            ref_dows[parse_iso_date(s).weekday()] += 1
        except Exception:
            pass
    ted_dows: Counter[int] = Counter()
    for s in all_teds:
        try:
            ted_dows[parse_iso_date(s).weekday()] += 1
        except Exception:
            pass

    round_dow = ref_dows.most_common(1)[0][0] if ref_dows else 5
    target_dow = ted_dows.most_common(1)[0][0] if ted_dows else round_dow

    # Week system: Sunday target_end_date (6) or origin_date convention implies ISO Mon-Sun
    if target_dow == 6 or round_id_col == "origin_date":
        week_system = "iso"
        if not ted_dows:
            target_dow = 6
    else:
        week_system = "mmwr"

    # Horizon offset at h == 0: empirical pairs > tasks.json min-bound match > signed weekday delta
    offset_counts: Counter[int] = Counter()
    for ref_s, h, ted_s in (observed_pairs or ()):
        try:
            diff = (parse_iso_date(ted_s) - parse_iso_date(ref_s)).days - 7 * int(h)
            if -6 <= diff <= 6:
                offset_counts[diff] += 1
        except Exception:
            pass
    if offset_counts:
        horizon_offset_days = offset_counts.most_common(1)[0][0]
    else:
        cfg_offsets: Counter[int] = Counter()
        for ref_s, h, ted_s in cfg_triples:
            try:
                diff = (parse_iso_date(ted_s) - parse_iso_date(ref_s)).days - 7 * int(h)
                if -6 <= diff <= 6:
                    cfg_offsets[diff] += 1
            except Exception:
                pass
        if cfg_offsets:
            horizon_offset_days = cfg_offsets.most_common(1)[0][0]
        elif target_dow == round_dow:
            horizon_offset_days = 0
        else:
            horizon_offset_days = ((target_dow - round_dow + 3) % 7) - 3

    # Season mode & active months: detect continuous / year-round vs seasonal winter pathogens
    target_list = [str(t).lower() for t in (targets or ())]
    round_months_by_year: Dict[int, set[int]] = {}
    for s in all_refs:
        try:
            dt = parse_iso_date(s)
            round_months_by_year.setdefault(dt.year, set()).add(dt.month)
        except Exception:
            pass
    has_year_round_rounds = any(len(ms) >= 10 for ms in round_months_by_year.values())
    has_covid_only = bool(target_list) and all("covid" in t for t in target_list)

    if has_year_round_rounds or has_covid_only:
        season_mode = "continuous"
        active_months = ALL_MONTHS
    else:
        season_mode = "respiratory_nh"
        active_months = MMWR_SEASON_ACTIVE_MONTHS

    season_start_week = 31

    if isinstance(user_override, dict):
        if user_override.get("week_system") in ("mmwr", "iso"):
            week_system = str(user_override["week_system"])
        if user_override.get("round_day_of_week") is not None:
            round_dow = int(user_override["round_day_of_week"]) % 7
        if user_override.get("target_day_of_week") is not None:
            target_dow = int(user_override["target_day_of_week"]) % 7
        if user_override.get("horizon_offset_days") is not None:
            horizon_offset_days = int(user_override["horizon_offset_days"])
        if user_override.get("season_mode") in ("respiratory_nh", "continuous", "calendar_year"):
            season_mode = str(user_override["season_mode"])
        if user_override.get("season_start_week") is not None:
            season_start_week = int(user_override["season_start_week"])
        elif season_mode == "calendar_year":
            season_start_week = 1
        if isinstance(user_override.get("active_months"), (list, tuple)) and user_override["active_months"]:
            active_months = tuple(sorted({int(m) for m in user_override["active_months"] if 1 <= int(m) <= 12}))

    return CalendarSpec(
        week_system=week_system,
        round_day_of_week=round_dow,
        target_day_of_week=target_dow,
        horizon_offset_days=horizon_offset_days,
        season_mode=season_mode,
        season_start_week=season_start_week,
        active_months=active_months,
        round_id_col=round_id_col,
    )
