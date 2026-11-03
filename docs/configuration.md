# Configuration

Everything works without a config file: targets, baseline, and locations are discovered from the hub (`hub-config/tasks.json`, `auxiliary-data/locations.csv`). To override defaults, copy the example and edit it:

```bash
cp viz/config.example.json viz/config.json
```

`viz/config.json` (or `viz/config.toml`) is git-ignored, so your settings survive `git pull`. A `config.json` at the hub root with a top-level `"viz"` key also works.

```json
{
  "default_target": "wk inc flu hosp",
  "targets": [
    "wk inc flu hosp",
    "wk flu hosp rate change"
  ],
  "default_baseline": "FluSight-baseline",
  "recommended_models": [
    "UMass-flusion_spatial2_prod",
    "FluSight-baseline"
  ],
  "port": 8501,
  "host": "127.0.0.1",
  "allowed_origins": [
    "http://127.0.0.1:8501",
    "http://localhost:8501"
  ],
  "target_metadata": {
    "wk inc flu hosp": {
      "display_name": "Incident Flu Admissions",
      "unit": "Patients / Wk",
      "is_rate": false,
      "is_categorical": false,
      "non_negative": true
    }
  }
}
```

`target_metadata.<target>.non_negative` also controls scoring: negative forecast values are clipped to 0 before scoring non-negative targets.

*Note: For security on shared multi-user environments, keep `host` bound to `127.0.0.1`.*

## Staging Local Experiments (`local-output/`)
Uncommitted model runs can be placed in `local-output/<model_id>/<date>-<model_id>.csv`. The suite tags them as `[LOCAL]` and scores them side-by-side with Git-tracked `[REPO]` models in `model-output/`.

`setup.sh` / `setup.bat` create this folder and add both `viz/` and `local-output/` to the hub's `.git/info/exclude`, so nothing in it shows up in `git status`. To ignore it for everyone who clones the hub, add `local-output/` to the hub's `.gitignore` as well.

Saved Ensemble Studio ensembles are written to `local-output/synthetic/<ensemble_id>/`.
