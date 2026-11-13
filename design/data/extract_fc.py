"""Forecasts for the fan chart, one file per season and location: data/fc/<season>/<loc>.json.

Usage (from the hub root): viz/.venv/bin/python design/data/extract_fc.py . design/data

Each file is { model: { round (YYYY-MM-DD): [h0, h1, h2, h3] } }, each horizon the 23 standard quantiles
(rounded, monotone) or null. Same shape as the older fc-US.json. One season is held at a time as a
float32 array (models × rounds × locations × 4 × 23), so memory stays small.
Season and location lists come from data/scores.json (run extract_scores.py first).
"""
import json
import sys
from pathlib import Path

import numpy as np
import polars as pl

HUB, OUT = Path(sys.argv[1]), Path(sys.argv[2])
TARGET = "wk inc flu hosp"
Q = [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.975, 0.99]
man = json.loads((OUT / "scores.json").read_text())
locs = [l["id"] for l in man["locations"]]
L = len(locs)
loc_index = {l: i for i, l in enumerate(locs)}


def rnd(v):
    return round(float(v), 1) if abs(v) >= 10 else round(float(v), 2)


for season in man["seasons"]:
    sid, models, rounds = season["id"], season["models"], season["rounds"]
    M, R = len(models), len(rounds)
    r_index = {d: i for i, d in enumerate(rounds)}
    arr = np.full((M, R, L, 4, len(Q)), np.nan, np.float32)
    for mi, m in enumerate(models):
        files = [f for f in sorted((HUB / "model-output" / m).glob("*.csv")) if f.name[:10] in r_index]
        frames = []
        for f in files:
            df = pl.read_csv(f, schema_overrides={"location": pl.Utf8, "output_type_id": pl.Utf8}, infer_schema_length=0)
            df = df.filter((pl.col("target") == TARGET) & (pl.col("output_type") == "quantile"))
            if df.height:
                frames.append(df.select("reference_date", "location", pl.col("horizon").cast(pl.Int64),
                                        pl.col("output_type_id").cast(pl.Float64).alias("q"), pl.col("value").cast(pl.Float64, strict=False)))
        if not frames:
            continue
        df = pl.concat(frames).filter(pl.col("horizon").is_between(0, 3)).drop_nulls("value").sort(["reference_date", "location", "horizon", "q"])
        for (rd, loc, h), g in df.group_by(["reference_date", "location", "horizon"], maintain_order=True):
            if loc not in loc_index or rd not in r_index:
                continue
            qs, vs = g["q"].to_numpy(), np.maximum.accumulate(np.maximum(g["value"].to_numpy(), 0))
            arr[mi, r_index[rd], loc_index[loc], h] = np.interp(Q, qs, vs)
        print(sid, m, file=sys.stderr)
    d = OUT / "fc" / sid
    d.mkdir(parents=True, exist_ok=True)
    total = 0
    for li, loc in enumerate(locs):
        obj = {}
        for mi, m in enumerate(models):
            per = {}
            for ri, rd in enumerate(rounds):
                hs = [None if np.isnan(arr[mi, ri, li, h, 0]) else [rnd(v) for v in arr[mi, ri, li, h]] for h in range(4)]
                if any(hs):
                    per[rd] = hs
            if per:
                obj[m] = per
        p = d / f"{loc}.json"
        p.write_text(json.dumps(obj, separators=(",", ":")))
        total += p.stat().st_size
    print(sid, M, "models", R, "rounds", f"{total / 1e6:.1f} MB", file=sys.stderr)
