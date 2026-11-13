"""All-model 2025-26 snapshot for the glass prototype: core.json + fc/<loc>.json (lazy per location)."""
import json
import sys
from pathlib import Path

import numpy as np
import polars as pl

HUB = Path(sys.argv[1])
OUT = Path(sys.argv[2])
TARGET = "wk inc flu hosp"
BAND_Q = [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.975, 0.99]
LO, HI = "2025-11-01", "2026-06-30"

locs = pl.read_csv(HUB / "auxiliary-data/locations.csv", schema_overrides={"location": pl.Utf8})
locs = locs.select("location", "abbreviation", "location_name", "population")
loc_ids = locs["location"].to_list()
loc_index = {l: i for i, l in enumerate(loc_ids)}

truth = (
    pl.read_csv(HUB / "target-data/oracle-output.csv", schema_overrides={"location": pl.Utf8}, infer_schema_length=0)
    .filter(pl.col("target") == TARGET)
    .select("location", "target_end_date", pl.col("oracle_value").cast(pl.Float64, strict=False))
    .drop_nulls("oracle_value")
    .unique(["location", "target_end_date"])
    .filter(pl.col("target_end_date") >= "2025-08-01")
    .sort("target_end_date")
)
truth_map = {(r[0], r[1]): r[2] for r in truth.iter_rows()}
truth_out = {}
for l, d, v in truth.iter_rows():
    truth_out.setdefault(l, []).append([d, v])

frames = []
for mdir in sorted((HUB / "model-output").iterdir()):
    if not mdir.is_dir():
        continue
    for f in sorted(mdir.glob("*.csv")):
        d = f.name[:10]
        if not (LO <= d <= HI):
            continue
        df = pl.read_csv(f, schema_overrides={"location": pl.Utf8, "output_type_id": pl.Utf8}, infer_schema_length=0)
        df = df.filter((pl.col("target") == TARGET) & (pl.col("output_type") == "quantile"))
        if df.height == 0:
            continue
        frames.append(df.select(
            pl.lit(mdir.name).alias("model"),
            pl.col("reference_date"),
            pl.col("location"),
            pl.col("horizon").cast(pl.Int64),
            pl.col("target_end_date"),
            pl.col("output_type_id").cast(pl.Float64).alias("q"),
            pl.col("value").cast(pl.Float64, strict=False),
        ))
fc = pl.concat(frames).filter((pl.col("horizon") >= 0) & (pl.col("horizon") <= 3)).drop_nulls("value")
models = sorted(fc["model"].unique().to_list())
dates = sorted(fc["reference_date"].unique().to_list())
date_index = {d: i for i, d in enumerate(dates)}

per_loc = {l: {} for l in loc_ids}
wis = {m: [[None] * len(loc_ids) for _ in dates] for m in models}

fc = fc.sort(["model", "reference_date", "location", "horizon", "q"])
for (m, rd, loc), g in fc.group_by(["model", "reference_date", "location"], maintain_order=True):
    if loc not in loc_index:
        continue
    per_h = [None] * 4
    scores = []
    for (h,), gh in g.group_by(["horizon"], maintain_order=True):
        qs = gh["q"].to_numpy()
        vs = np.maximum.accumulate(gh["value"].to_numpy())
        per_h[h] = [round(float(np.interp(q, qs, vs)), 1) for q in BAND_Q]
        y = truth_map.get((loc, gh["target_end_date"][0]))
        if y is not None:
            scores.append(float(np.mean(2 * ((y < vs).astype(float) - qs) * (vs - y))))
    per_loc[loc].setdefault(m, {})[rd] = per_h
    if len(scores) == 4:
        wis[m][date_index[rd]][loc_index[loc]] = round(float(np.mean(scores)), 3)

(OUT / "fc").mkdir(parents=True, exist_ok=True)
for loc, obj in per_loc.items():
    (OUT / "fc" / f"{loc}.json").write_text(json.dumps(obj, separators=(",", ":")))

core = {
    "target": TARGET,
    "baseline": "FluSight-baseline",
    "quantiles": BAND_Q,
    "models": models,
    "dates": dates,
    "locations": [{"id": r[0], "abbr": r[1], "name": r[2], "pop": r[3]} for r in locs.iter_rows()],
    "truth": truth_out,
    "wis": wis,
}
(OUT / "core.json").write_text(json.dumps(core, separators=(",", ":")))
print(f"{len(models)} models, {len(dates)} dates, core {(OUT / 'core.json').stat().st_size / 1e6:.2f} MB, "
      f"US fc {(OUT / 'fc' / 'US.json').stat().st_size / 1e6:.2f} MB")
