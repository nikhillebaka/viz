"""Per-forecast scores for the evaluation prototype, one binary file per season.

Usage: viz/.venv/bin/python design/data/extract_scores.py <hub> <out>

Writes <out>/scores.json (manifest: locations, levels, seasons, models per season, rounds, metadata, truth)
and <out>/scores-<season>.bin. Each .bin holds, for every (model, round, location, horizon), in that order
(index = ((m * R + r) * L + l) * 4 + h):
  wis, dispersion, overprediction, underprediction   Float32 (NaN when not scored)
  coverage bits                                      Uint16  (bit k set: y inside the LEVELS[k] interval)
  state                                              Uint8   (0 no forecast, 1 awaiting truth, 2 scored)
WIS is the standard interval score (Bracher et al.): with K intervals and the median,
WIS = (½|y−m| + Σ α_k/2 · IS_k) / (K + ½), which equals the mean of 2·pinball over the quantiles. Components
use the same normalisation, so wis = dispersion + overprediction + underprediction.
"""
import json
import sys
from pathlib import Path

import numpy as np
import polars as pl

HUB, OUT = Path(sys.argv[1]), Path(sys.argv[2])
TARGET = "wk inc flu hosp"
LEVELS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 98]


def season_of(d: str) -> str:
    y, m = int(d[:4]), int(d[5:7])
    a = y if m >= 8 else y - 1
    return f"{a}-{str(a + 1)[2:]}"


locs = pl.read_csv(HUB / "auxiliary-data/locations.csv", schema_overrides={"location": pl.Utf8})
loc_ids = locs["location"].to_list()
L = len(loc_ids)
loc_index = {l: i for i, l in enumerate(loc_ids)}

truth = (
    pl.read_csv(HUB / "target-data/oracle-output.csv", schema_overrides={"location": pl.Utf8}, infer_schema_length=0)
    .filter(pl.col("target") == TARGET)
    .select("location", "target_end_date", pl.col("oracle_value").cast(pl.Float64, strict=False))
    .drop_nulls("oracle_value").unique(["location", "target_end_date"]).sort("target_end_date")
)
truth_map = {(r[0], r[1]): r[2] for r in truth.iter_rows()}

# Collect per model, so memory stays bounded.
per_season = {}  # season -> {model -> DataFrame}
for mdir in sorted((HUB / "model-output").iterdir()):
    if not mdir.is_dir():
        continue
    files = sorted(mdir.glob("*.csv"))
    if not files:
        continue
    frames = []
    for f in files:
        df = pl.read_csv(f, schema_overrides={"location": pl.Utf8, "output_type_id": pl.Utf8}, infer_schema_length=0)
        df = df.filter((pl.col("target") == TARGET) & (pl.col("output_type") == "quantile"))
        if df.height:
            frames.append(df.select(
                "reference_date", "location", pl.col("horizon").cast(pl.Int64), "target_end_date",
                pl.col("output_type_id").cast(pl.Float64).alias("q"), pl.col("value").cast(pl.Float64, strict=False)))
    if not frames:
        continue
    df = pl.concat(frames).filter(pl.col("horizon").is_between(0, 3)).drop_nulls("value")
    df = df.with_columns(pl.col("reference_date").map_elements(season_of, return_dtype=pl.Utf8).alias("season"))
    for (s,), g in df.group_by(["season"]):
        per_season.setdefault(s, {})[mdir.name] = g
    print(mdir.name, df.height, file=sys.stderr)

manifest = {"target": TARGET, "baseline": "FluSight-baseline", "levels": LEVELS,
            "locations": [{"id": r[0], "abbr": r[1], "name": r[2], "pop": r[3]}
                          for r in locs.select("location", "abbreviation", "location_name", "population").iter_rows()],
            "seasons": [], "meta": {}, "truth": {}}

for s in sorted(per_season):
    models = sorted(per_season[s])
    rounds = sorted({d for g in per_season[s].values() for d in g["reference_date"].unique().to_list()})
    M, R = len(models), len(rounds)
    r_index = {d: i for i, d in enumerate(rounds)}
    N = M * R * L * 4
    wis, disp, over, under = (np.full(N, np.nan, np.float32) for _ in range(4))
    cov = np.zeros(N, np.uint16)
    state = np.zeros(N, np.uint8)
    quantiles = {}
    for mi, m in enumerate(models):
        g = per_season[s][m].sort(["reference_date", "location", "horizon", "q"])
        qs_all = sorted(g["q"].unique().to_list())
        quantiles[m] = len(qs_all)
        for (rd, loc, h, ted), gh in g.group_by(["reference_date", "location", "horizon", "target_end_date"], maintain_order=True):
            if loc not in loc_index:
                continue
            i = ((mi * R + r_index[rd]) * L + loc_index[loc]) * 4 + h
            qs = gh["q"].to_numpy()
            vs = np.maximum.accumulate(np.maximum(gh["value"].to_numpy(), 0))
            y = truth_map.get((loc, ted))
            if y is None:
                state[i] = 1
                continue
            state[i] = 2
            # Interval pairs (α/2, 1 − α/2) and the median.
            K, d_sum, o_sum, u_sum, bits = 0, 0.0, 0.0, 0.0, 0
            med = np.interp(0.5, qs, vs)
            for lo_q in qs[qs < 0.5]:
                hi_q = round(1 - lo_q, 4)
                j = np.where(np.isclose(qs, hi_q))[0]
                if not len(j):
                    continue
                lo, hi = vs[qs == lo_q][0], vs[j[0]]
                alpha = 2 * lo_q
                K += 1
                d_sum += alpha / 2 * (hi - lo)
                o_sum += max(lo - y, 0)
                u_sum += max(y - hi, 0)
                lvl = round((1 - alpha) * 100)
                if lvl in LEVELS and lo <= y <= hi:
                    bits |= 1 << LEVELS.index(lvl)
            norm = K + 0.5
            o_sum += 0.5 * max(med - y, 0)
            u_sum += 0.5 * max(y - med, 0)
            disp[i], over[i], under[i] = d_sum / norm, o_sum / norm, u_sum / norm
            wis[i] = disp[i] + over[i] + under[i]
            cov[i] = bits
    with open(OUT / f"scores-{s}.bin", "wb") as f:
        for a in (wis, disp, over, under, cov, state):
            f.write(a.tobytes())
    manifest["seasons"].append({"id": s, "models": models, "rounds": rounds, "quantiles": quantiles})
    # Observed weekly values for this season, per location (Aug 1 – Jul 31).
    a = int(s[:4])
    t = truth.filter(pl.col("target_end_date").is_between(pl.lit(f"{a}-08-01"), pl.lit(f"{a + 1}-07-31")))
    manifest["truth"][s] = {l: [[d, v] for d, v in g.select("target_end_date", "oracle_value").iter_rows()]
                            for (l,), g in t.group_by(["location"])}
    print(s, M, "models", R, "rounds", f"{N * 19 / 1e6:.1f} MB", file=sys.stderr)

for f in sorted((HUB / "model-metadata").glob("*.yml")):
    txt = f.read_text()
    def field(k):
        for line in txt.splitlines():
            if line.startswith(k + ":"):
                return line.split(":", 1)[1].strip().strip('"')
        return None
    manifest["meta"][f.stem] = {k: field(k) for k in ("team_abbr", "model_abbr", "license", "designated_model", "methods")}

(OUT / "scores.json").write_text(json.dumps(manifest, separators=(",", ":")))
