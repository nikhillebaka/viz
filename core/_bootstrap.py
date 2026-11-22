"""Bootstrap helper so viz runs from any folder name without PYTHONPATH=.."""

from pathlib import Path
import sys
import types

APP_DIR = Path(__file__).resolve().parent.parent


def ensure_viz_package() -> Path:
    """Register APP_DIR as the top-level `viz` package if not already loaded."""
    if str(APP_DIR) not in sys.path:
        sys.path.insert(0, str(APP_DIR))
    if "viz" not in sys.modules:
        pkg = types.ModuleType("viz")
        pkg.__file__ = str(APP_DIR / "core" / "__init__.py")
        pkg.__path__ = [str(APP_DIR)]
        pkg.__package__ = "viz"
        sys.modules["viz"] = pkg
    return APP_DIR
