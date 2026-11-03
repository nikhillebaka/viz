#!/usr/bin/env bash
# ==============================================================================
# Launch the FluSight Sandbox dashboard.
#   Usage: ./viz/run.sh [PORT] [HOST]        (defaults: 8501 127.0.0.1)
# Run ./viz/setup.sh once first.
# ==============================================================================

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
ROOT_DIR="$(dirname "$DIR")"

# Locate a Python that has the viz dependencies installed
if [ -n "$VIRTUAL_ENV" ] && [ -f "$VIRTUAL_ENV/bin/python" ]; then
    PYTHON_BIN="$VIRTUAL_ENV/bin/python"
elif [ -f "$DIR/.venv/bin/python" ]; then
    PYTHON_BIN="$DIR/.venv/bin/python"
elif [ -f "$ROOT_DIR/.venv/bin/python" ]; then
    PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
elif [ -f "$ROOT_DIR/venv/bin/python" ]; then
    PYTHON_BIN="$ROOT_DIR/venv/bin/python"
elif [ -f "$ROOT_DIR/env/bin/python" ]; then
    PYTHON_BIN="$ROOT_DIR/env/bin/python"
elif command -v python3 &> /dev/null; then
    PYTHON_BIN="python3"
else
    echo "ERROR: Could not locate Python. Run ./viz/setup.sh first."
    exit 1
fi

if ! "$PYTHON_BIN" -c "import polars, pyarrow, yaml" &> /dev/null; then
    echo "ERROR: viz dependencies are not installed for $PYTHON_BIN."
    echo "Run ./viz/setup.sh first (or: pip install -r viz/requirements.txt)."
    exit 1
fi

PORT="${1:-8501}"
HOST="${2:-127.0.0.1}"

echo "Starting viz on port ${PORT} (the server prints its URL once it is listening)..."
exec "$PYTHON_BIN" "$DIR/server.py" --port "$PORT" --host "$HOST"
