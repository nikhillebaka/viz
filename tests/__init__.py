"""Unit and integration tests for the viz package."""

from pathlib import Path
import sys

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

import conftest  # noqa: E402,F401
