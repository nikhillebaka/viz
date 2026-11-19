"""Bootstrap helper so viz runs from any folder name without PYTHONPATH=.."""

import importlib.util
from pathlib import Path
import sys

APP_DIR = Path(__file__).resolve().parent


def ensure_viz_package() -> Path:
    """Register APP_DIR as the top-level `viz` package if not already loaded."""
    if "viz" not in sys.modules:
        init_py = APP_DIR / "__init__.py"
        spec = importlib.util.spec_from_file_location(
            "viz",
            init_py,
            submodule_search_locations=[str(APP_DIR)],
        )
        if spec is None or spec.loader is None:  # pragma: no cover - defensive
            raise ImportError(f"Could not load viz package from {init_py}")
        pkg = importlib.util.module_from_spec(spec)
        sys.modules["viz"] = pkg
        spec.loader.exec_module(pkg)
    return APP_DIR
