#!/usr/bin/env bash
# ==============================================================================
# Launch FluSight Sandbox Forecast Visualizer & Evaluation Suite
# ==============================================================================

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
ROOT_DIR="$(dirname "$DIR")"

# Locate python with viz dependencies installed
if [ -n "$VIRTUAL_ENV" ] && [ -f "$VIRTUAL_ENV/bin/python" ]; then
    PYTHON_BIN="$VIRTUAL_ENV/bin/python"
elif [ -f "$ROOT_DIR/.venv/bin/python" ]; then
    PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
elif [ -f "$ROOT_DIR/venv/bin/python" ]; then
    PYTHON_BIN="$ROOT_DIR/venv/bin/python"
elif [ -f "$ROOT_DIR/env/bin/python" ]; then
    PYTHON_BIN="$ROOT_DIR/env/bin/python"
elif command -v python3 &> /dev/null; then
    PYTHON_BIN="python3"
else
    echo "ERROR: Could not locate Python. Please activate your virtual environment."
    exit 1
fi

PORT="${1:-8501}"
HOST="${2:-127.0.0.1}"

echo "Starting Sandbox Visualization Server on http://${HOST}:${PORT}..."
exec "$PYTHON_BIN" "$DIR/server.py" --port "$PORT" --host "$HOST"
