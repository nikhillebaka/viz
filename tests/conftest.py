"""Pytest configuration and standalone test helpers."""

import os
from pathlib import Path
import sys
from typing import Optional

_VIZ_DIR = Path(__file__).resolve().parent.parent
if str(_VIZ_DIR) not in sys.path:
    sys.path.insert(0, str(_VIZ_DIR))

import _bootstrap  # noqa: E402

APP_DIR = _bootstrap.ensure_viz_package()

from viz.core.paths import detect_enclosing_hub  # noqa: E402


def resolve_sandbox_hub() -> Optional[Path]:
    """Return the enclosing FluSight sandbox repo when present (unless VIZ_HUB_DIR points away)."""
    env = os.environ.get("VIZ_HUB_DIR", "").strip()
    if env:
        p = Path(env).expanduser().resolve()
        return p if (p / "model-output" / "UMass-AR6_pooled").is_dir() else None
    enclosing = detect_enclosing_hub()
    if enclosing is not None and (enclosing / "model-output" / "UMass-AR6_pooled").is_dir():
        return enclosing
    return None
