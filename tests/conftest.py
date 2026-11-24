"""Shared test bootstrap, synthetic Hubverse fixtures, and live test HTTP server helper."""

from contextlib import contextmanager
from datetime import date, timedelta
import http.server
import json
from pathlib import Path
import shutil
import socketserver
import sys
import tempfile
import threading
from typing import Iterator, List, Optional, Tuple

import polars as pl

_TESTS_DIR = Path(__file__).resolve().parent
_VIZ_DIR = _TESTS_DIR.parent
for _p in (str(_TESTS_DIR), str(_VIZ_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from core._bootstrap import ensure_viz_package  # noqa: E402

APP_DIR = ensure_viz_package()

SYNTH_TARGET = "wk inc flu hosp"
SYNTH_ED_TARGET = "wk inc flu prop ed visits"
SYNTH_QUANTILES = [0.025, 0.1, 0.25, 0.5, 0.75, 0.9, 0.975]
SYNTH_LOCATIONS = [
    ("US", "US", "United States", 330_000_000, 12000.0),
    ("25", "MA", "Massachusetts", 7_000_000, 320.0),
    ("36", "NY", "New York", 19_500_000, 820.0),
    ("42", "PA", "Pennsylvania", 13_000_000, 540.0),
    ("13", "GA", "Georgia", 11_000_000, 480.0),
    ("06", "CA", "California", 39_000_000, 1100.0),
    ("53", "WA", "Washington", 7_800_000, 340.0),
]

# Two 10-week seasons peaking at index 5 (2024-01-13 and 2025-01-11).
# Model reference dates cover indices 1..6 so every horizon 0..3 stays inside the oracle
# while leaving leading/trailing oracle dates to exercise shoulder-date pruning.
SYNTH_SEASONS = {
    "2023-2024": [date(2023, 12, 9) + timedelta(weeks=i) for i in range(10)],
    "2024-2025": [date(2024, 12, 7) + timedelta(weeks=i) for i in range(10)],
}


def _wave_value(peak: float, week_idx: int) -> float:
    mult = max(0.15, 1.0 - abs(week_idx - 5) * 0.17)
    return round(peak * mult, 1)


def _write_forecast_file(
    path: Path,
    ref_date: date,
    oracle_lookup: dict[Tuple[str, str], float],
    *,
    scale: float,
    spread: float,
    exclude_locs: set[str] | None = None,
) -> None:
    rows = []
    excluded = exclude_locs or set()
    ref_iso = ref_date.isoformat()
    for loc, _, _, _, _ in SYNTH_LOCATIONS:
        if loc in excluded:
            continue
        for h in (0, 1, 2, 3):
            ted_iso = (ref_date + timedelta(weeks=h)).isoformat()
            truth = oracle_lookup[(loc, ted_iso)]
            center = truth * scale
            for q in SYNTH_QUANTILES:
                rows.append({
                    "reference_date": ref_iso,
                    "target": SYNTH_TARGET,
                    "horizon": h,
                    "target_end_date": ted_iso,
                    "location": loc,
                    "output_type": "quantile",
                    "output_type_id": q,
                    "value": round(max(0.0, center * (1.0 + spread * (q - 0.5) * 2.0)), 4),
                })
    pl.DataFrame(rows).write_csv(path)


def build_synthetic_hub(
    hub_dir: Path,
    *,
    with_surveillance_vintages: bool = False,
) -> Path:
    """Create a deterministic, multi-season, self-contained Hubverse hub directory."""
    hub_dir = Path(hub_dir).resolve()
    (hub_dir / "hub-config").mkdir(parents=True, exist_ok=True)
    (hub_dir / "auxiliary-data").mkdir(parents=True, exist_ok=True)
    (hub_dir / "target-data").mkdir(parents=True, exist_ok=True)
    (hub_dir / "model-metadata").mkdir(parents=True, exist_ok=True)
    (hub_dir / "model-output").mkdir(parents=True, exist_ok=True)

    (hub_dir / "hub-config" / "admin.json").write_text(
        json.dumps({
            "name": "Synthetic FluSight Hub",
            "maintainer": "viz tests",
            "repository": {"host": "github", "owner": "synthetic", "name": hub_dir.name or "flusight"},
        }),
        encoding="utf-8",
    )

    all_refs = [d.isoformat() for weeks in SYNTH_SEASONS.values() for d in weeks[1:7]]
    loc_ids = [loc for loc, _, _, _, _ in SYNTH_LOCATIONS]
    (hub_dir / "hub-config" / "tasks.json").write_text(
        json.dumps({
            "schema_version": "https://raw.githubusercontent.com/hubverse-org/schemas/main/v3.0.0/tasks-schema.json",
            "rounds": [{
                "round_id_from_variable": True,
                "round_id": "reference_date",
                "model_tasks": [{
                    "task_ids": {
                        "reference_date": {"required": None, "optional": all_refs},
                        "location": {"required": None, "optional": loc_ids},
                        "horizon": {"required": None, "optional": [0, 1, 2, 3]},
                        "target": {"required": [SYNTH_TARGET], "optional": [SYNTH_ED_TARGET]},
                    },
                    "output_type": {
                        "quantile": {"output_type_id": {"required": SYNTH_QUANTILES}}
                    },
                }],
            }],
        }),
        encoding="utf-8",
    )

    pl.DataFrame({
        "abbreviation": [abbr for _, abbr, _, _, _ in SYNTH_LOCATIONS],
        "location": [loc for loc, _, _, _, _ in SYNTH_LOCATIONS],
        "location_name": [name for _, _, name, _, _ in SYNTH_LOCATIONS],
        "population": [pop for _, _, _, pop, _ in SYNTH_LOCATIONS],
    }).write_csv(hub_dir / "auxiliary-data" / "locations.csv")

    oracle_rows = []
    oracle_lookup: dict[Tuple[str, str], float] = {}
    for weeks in SYNTH_SEASONS.values():
        for w_idx, d in enumerate(weeks):
            d_iso = d.isoformat()
            for loc, _, _, _, peak in SYNTH_LOCATIONS:
                val = _wave_value(peak, w_idx)
                oracle_lookup[(loc, d_iso)] = val
                oracle_rows.append({
                    "as_of": "2025-06-01",
                    "target": SYNTH_TARGET,
                    "target_end_date": d_iso,
                    "location": loc,
                    "horizon": 0,
                    "output_type": "quantile",
                    "output_type_id": None,
                    "oracle_value": val,
                })
                ed_val = round(0.01 + 0.04 * max(0.0, 1.0 - abs(w_idx - 5) / 5.0), 5)
                oracle_rows.append({
                    "as_of": "2025-06-01",
                    "target": SYNTH_ED_TARGET,
                    "target_end_date": d_iso,
                    "location": loc,
                    "horizon": 0,
                    "output_type": "quantile",
                    "output_type_id": None,
                    "oracle_value": ed_val,
                })
    pl.DataFrame(oracle_rows).write_csv(hub_dir / "target-data" / "oracle-output.csv")

    (hub_dir / "model-metadata" / "FluSight-baseline.yml").write_text(
        "team_abbr: FluSight\nmodel_abbr: baseline\nbaseline_model: true\n",
        encoding="utf-8",
    )

    model_specs = [
        ("FluSight-baseline", 1.55, 0.55, False, set()),
        ("Model-Alpha", 1.03, 0.14, False, set()),
        ("Model-Beta", 1.24, 0.25, False, {"2024-01-13", "2025-01-11"}),
        ("Model-Legacy", 1.35, 0.30, True, set()),
    ]
    for model_id, scale, spread, legacy_only, partial_refs in model_specs:
        mdir = hub_dir / "model-output" / model_id
        mdir.mkdir(parents=True, exist_ok=True)
        for season_id, weeks in SYNTH_SEASONS.items():
            if legacy_only and season_id != "2023-2024":
                continue
            for ref_date in weeks[1:7]:
                ref_iso = ref_date.isoformat()
                excluded = {"53"} if ref_iso in partial_refs else set()
                _write_forecast_file(
                    mdir / f"{ref_iso}-{model_id}.csv",
                    ref_date,
                    oracle_lookup,
                    scale=scale,
                    spread=spread,
                    exclude_locs=excluded,
                )

    if with_surveillance_vintages:
        archive_dir = hub_dir / "auxiliary-data" / "target-data-archive"
        archive_dir.mkdir(parents=True, exist_ok=True)
        weeks_24 = SYNTH_SEASONS["2024-2025"]
        vintages = [
            ("2025-01-04", 0.78),
            ("2025-01-11", 0.88),
            ("2025-01-18", 0.96),
        ]
        for snap_date, rev_factor in vintages:
            snap_rows = []
            for d in weeks_24:
                d_iso = d.isoformat()
                if d_iso >= snap_date:
                    continue
                for loc, _, _, _, _ in SYNTH_LOCATIONS:
                    settled = oracle_lookup[(loc, d_iso)]
                    # Newly reported recent weeks revise upward cleanly across successive snapshots.
                    age_weeks = (date.fromisoformat(snap_date) - d).days // 7
                    factor = min(1.0, rev_factor + 0.015 * max(0, age_weeks - 1))
                    snap_rows.append({
                        "date": d_iso,
                        "location": loc,
                        "value": round(settled * factor, 1),
                    })
            pl.DataFrame(snap_rows).write_csv(
                archive_dir / f"target-hospital-admissions_{snap_date}.csv"
            )

    return hub_dir


@contextmanager
def start_test_server(
    hub_dirs: List[Path],
    *,
    mode: str = "local",
) -> Iterator[Tuple[int, object]]:
    """Run SandboxRequestHandler on an ephemeral localhost port backed by an isolated HubManager."""
    from viz.core.workspace import HubManager
    from viz.server import SandboxRequestHandler

    data_dir = Path(tempfile.mkdtemp(prefix="viz-test-srv-")).resolve()
    mgr = HubManager(
        data_dir=data_dir,
        cli_hubs=list(hub_dirs),
        include_enclosing=False,
        mode=mode,
    )

    class _TestHandler(SandboxRequestHandler):
        hub_manager = mgr

        def log_message(self, format: str, *args) -> None:
            pass

    class _ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

    srv = _ThreadedServer(("127.0.0.1", 0), _TestHandler)
    port = srv.server_address[1]
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield port, mgr
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join(timeout=2)
        shutil.rmtree(data_dir, ignore_errors=True)
