#!/usr/bin/env python3
"""
Command-line evaluation utility for quick model scoring against oracle truth.
Useful for headless runs and instant feedback during model development.

Example:
    python3 viz/score_cli.py --models UMass-AR6_pooled,UMass-flusion_spatial2_prod --location states
"""

import argparse
import os
import sys
from pathlib import Path

# Auto-detect repository virtual environment if polars is not installed in current interpreter
try:
    import polars as pl
except ModuleNotFoundError:
    repo_root = Path(__file__).resolve().parent.parent
    candidate_pythons = []
    if "VIRTUAL_ENV" in os.environ:
        candidate_pythons.append(Path(os.environ["VIRTUAL_ENV"]) / "bin" / "python")
    candidate_pythons.extend([
        Path(__file__).resolve().parent / ".venv" / "bin" / "python",
        Path(__file__).resolve().parent / ".venv" / "Scripts" / "python.exe",
        repo_root / ".venv" / "bin" / "python",
        repo_root / "venv" / "bin" / "python",
        repo_root / ".venv" / "Scripts" / "python.exe",
        repo_root / "venv" / "Scripts" / "python.exe",
    ])
    current_prefix = Path(sys.prefix).resolve()
    for py_bin in candidate_pythons:
        venv_root = py_bin.parent.parent.resolve()
        if py_bin.exists() and venv_root != current_prefix:
            os.execv(str(py_bin), [str(py_bin)] + sys.argv)

    sys.stderr.write(
        "\n[FluSight Scorer CLI] ERROR: Dependency 'polars' is required but not found in:\n"
        f"  {sys.executable}\n\n"
        "To run the CLI evaluation tool, please either:\n"
        "  1. Run the one-time setup script:\n"
        "       ./viz/setup.sh   (Windows: viz\\setup.bat)\n"
        "  2. Or install dependencies via requirements file:\n"
        "       pip install -r viz/requirements.txt\n\n"
    )
    sys.exit(1)

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

from viz.core.data_loader import SandboxDataLoader
from viz.core.evaluation import EvaluationEngine, EvaluationParams


import csv
import io
import json


def main():
    parser = argparse.ArgumentParser(description="Forecast Sandbox Scorer CLI")
    parser.add_argument("--models", type=str, required=True, help="Comma-separated list of model IDs to evaluate, or 'all'")
    parser.add_argument("--target", type=str, default="", help="Forecast target (defaults to hub config)")
    parser.add_argument("--location", type=str, default="all", help="'all', 'states', 'US', or specific FIPS code (default: all)")
    parser.add_argument("--date", type=str, default="all", help="Specific reference date (YYYY-MM-DD) or 'all' (default: all)")
    parser.add_argument("--season", type=str, default="", help="Specific season ('2025-2026'), comma-separated seasons, 'current', or 'all'")
    parser.add_argument("--baseline", type=str, default="", help="Baseline model for delta comparisons (defaults to hub baseline)")
    parser.add_argument("--weeks", type=str, default="", help="Season-week window of the forecast (target) week, e.g. '10-24' (1 = early August)")
    parser.add_argument("--phase", type=str, default="", choices=["", "pre", "peak", "post"], help="Only score forecasts of pre-peak, peak, or post-peak weeks (per location)")
    parser.add_argument("--fair", action="store_true", help="Score models strictly on common shared tasks across all models (default: False)")
    parser.add_argument("--format", type=str, choices=["table", "csv", "json"], default="table", help="Output format: table, csv, or json (default: table)")
    parser.add_argument("--out", type=str, default=None, help="Optional file path to write results to")
    parser.add_argument("--export-tasks", type=str, default=None, help="Optional file path (.csv or .parquet) to export disaggregated task-level scores")
    args = parser.parse_args()

    # The CLI scores repository and local-output models only; hub data synced into the dashboard is ignored
    engine = EvaluationEngine(BASE_DIR, SandboxDataLoader(BASE_DIR, include_remote=False))

    if args.models.strip().lower() == "all":
        model_ids = list(engine.loader.scan_models().keys())
    else:
        model_ids = [m.strip() for m in args.models.split(",") if m.strip()]

    params = EvaluationParams(
        target=args.target if args.target else None,
        location=args.location,
        date=args.date,
        season=args.season,
        models=model_ids,
        baseline=args.baseline if args.baseline else None,
        fair=args.fair,
        weeks=args.weeks or None,
        phase=args.phase or None,
    )

    try:
        result = engine.evaluate(params)
    except Exception as exc:
        sys.stderr.write(f"\nERROR: Evaluation failed: {exc}\n\n")
        sys.exit(1)

    # Export disaggregated task-level scores if requested
    if args.export_tasks:
        task_df = engine.get_task_scores_dataframe(params)
        if task_df is not None and not task_df.is_empty():
            p = Path(args.export_tasks)
            p.parent.mkdir(parents=True, exist_ok=True)
            if p.suffix.lower() == ".parquet":
                task_df.write_parquet(p)
            else:
                task_df.write_csv(p)
            sys.stderr.write(f"Exported {len(task_df):,} task-level scores to {p}\n")
        else:
            sys.stderr.write("Warning: No task scores were available to export.\n")

    # Format output
    output_str = ""
    if args.format == "json":
        output_str = json.dumps(result.to_dict(), indent=2)
    elif args.format == "csv":
        out_buf = io.StringIO()
        fieldnames = [
            "model_id", "is_local", "has_data_in_scope", "wis", "relative_wis",
            "pct_diff_vs_baseline", "wis_per_100k", "mae", "cov95", "cov50",
            "sharpness", "decomp_sharpness", "decomp_overpred", "decomp_underpred",
            "count", "weeks_won", "weeks_competed", "status_note"
        ]
        writer = csv.DictWriter(out_buf, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for r in result.rankings:
            writer.writerow(r)
        output_str = out_buf.getvalue()
    else:
        # Table format
        scope_desc = f"Season: {result.season_filter}" if result.season_filter else f"Date Filter: {result.date_filter}"
        if result.window:
            wk = result.window.get("weeks")
            parts = [f"weeks {wk[0]}-{wk[1]}"] if wk else []
            if result.window.get("phase"):
                parts.append(f"{result.window['phase']}-peak weeks" if result.window["phase"] != "peak" else "peak weeks")
            scope_desc += f" ({', '.join(parts)})"
        lines = []
        lines.append("=" * 118)
        lines.append(f"  FORECAST EVALUATION REPORT")
        lines.append(f"  Target: {result.target} | Location Filter: {result.location_filter} | {scope_desc} | Common Tasks: {result.fair_intersection}")
        if result.baseline_model:
            lines.append(f"  Reference Baseline: {result.baseline_model} (Pairwise Tournament Rel WIS: 1.0 = baseline, <1.0 = better)")
        else:
            lines.append("  Reference Baseline: None (Pairwise comparisons disabled)")
        if result.common_task_message:
            lines.append(f"  Note: {result.common_task_message}")
        if result.validation_warnings:
            lines.append("  Validation Warnings:")
            for w in result.validation_warnings:
                lines.append(f"    • {w}")
        lines.append("=" * 118)

        if not result.rankings:
            lines.append("No forecasts matched the criteria.")
        else:
            lines.append(f"{'Model Name':<30} {'Type':<8} {'WIS':<9} {'Rel WIS':<9} {'Wins':<7} {'Δ% Base':<10} {'WIS/100k':<10} {'MAE':<8} {'Cov95%':<8} {'Sharp':<8}")
            lines.append("-" * 118)

            for r in result.rankings:
                mid = r["model_id"]
                mtype = "[LOCAL]" if r.get("is_local") else "[REPO]"

                if not r.get("has_data_in_scope"):
                    status_note = r.get("status_note") or "No data in scope"
                    lines.append(f"{mid:<30} {mtype:<8} {'—':<9} {'—':<9} {'—':<7} {'—':<10} {'—':<10} {'—':<8} {'—':<8} {status_note}")
                    continue

                wis = r.get("wis")
                rel_wis = r.get("relative_wis")
                pct = r.get("pct_diff_vs_baseline")
                rate_wis = r.get("wis_per_100k")
                mae = r.get("mae")
                cov95 = r.get("cov95")
                sharp = r.get("sharpness")

                delta_str = "-"
                if pct is not None:
                    sign = "+" if pct > 0 else ""
                    delta_str = f"{sign}{pct:.1f}%"

                wis_str = f"{wis:.2f}" if wis is not None else "N/A"
                rel_str = f"{rel_wis:.3f}" if rel_wis is not None else "—"
                rate_str = f"{rate_wis:.2f}" if rate_wis is not None else "—"
                mae_str = f"{mae:.2f}" if mae is not None else "N/A"
                cov95_str = f"{cov95:.1f}%" if cov95 is not None else "N/A"
                sharp_str = f"{sharp:.1f}" if sharp is not None else "N/A"
                wins_str = f"{r['weeks_won']}/{r['weeks_competed']}" if r.get("weeks_competed") else "—"

                lines.append(f"{mid:<30} {mtype:<8} {wis_str:<9} {rel_str:<9} {wins_str:<7} {delta_str:<10} {rate_str:<10} {mae_str:<8} {cov95_str:<8} {sharp_str:<8}")

            lines.append("=" * 118)
            lines.append("Lower WIS/MAE = Better. Rel WIS: Hubverse tournament standard (<1.0 is better than baseline).")
            lines.append("Wins = rounds where the model had the lowest WIS among the evaluated models (on the tasks all of them forecast that week).")
            lines.append("Cov95 target = 95.0%. Lower Sharpness = Tighter intervals. Rate WIS = per 100,000 population.\n")

        output_str = "\n".join(lines)

    if args.out:
        out_p = Path(args.out)
        out_p.parent.mkdir(parents=True, exist_ok=True)
        out_p.write_text(output_str, encoding="utf-8")
        sys.stderr.write(f"Results written to {out_p}\n")
    else:
        print(output_str)


if __name__ == "__main__":
    main()
