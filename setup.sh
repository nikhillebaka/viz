#!/usr/bin/env bash
# ==============================================================================
# One-time setup for viz. Run from anywhere:  ./viz/setup.sh
#   1. Creates viz/.venv (skipped if a virtual environment is already active)
#   2. Installs the Python dependencies
#   3. Builds the surveillance data (NHSN admissions, as-of snapshots)
#   4. Hides viz/ from the hub's git status via .git/info/exclude
# Safe to re-run.
# ==============================================================================

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
ROOT_DIR="$(dirname "$DIR")"

if [ "$(basename "$DIR")" != "viz" ]; then
    echo "ERROR: this folder must be named 'viz' (it is '$(basename "$DIR")')."
    echo "Clone it with:  git clone https://github.com/nikhillebaka/viz.git viz"
    exit 1
fi

if [ ! -d "$ROOT_DIR/model-output" ] && [ ! -d "$ROOT_DIR/target-data" ]; then
    echo "WARNING: $ROOT_DIR does not look like a Hubverse hub (no model-output/ or target-data/)."
    echo "         viz reads forecasts from the folder that contains it."
fi

# 1. Python environment
if [ -n "$VIRTUAL_ENV" ] && [ -f "$VIRTUAL_ENV/bin/python" ]; then
    PYTHON_BIN="$VIRTUAL_ENV/bin/python"
    echo "==> Using active virtual environment: $VIRTUAL_ENV"
else
    if ! command -v python3 &> /dev/null; then
        echo "ERROR: python3 not found. Install Python 3.10 or newer."
        exit 1
    fi
    if [ ! -f "$DIR/.venv/bin/python" ]; then
        echo "==> Creating virtual environment in viz/.venv"
        python3 -m venv "$DIR/.venv"
    fi
    PYTHON_BIN="$DIR/.venv/bin/python"
fi

if ! "$PYTHON_BIN" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
    echo "ERROR: Python 3.10 or newer is required ($("$PYTHON_BIN" --version))."
    exit 1
fi

# 2. Dependencies
echo "==> Installing dependencies"
"$PYTHON_BIN" -m pip install --quiet --upgrade pip
"$PYTHON_BIN" -m pip install --quiet -r "$DIR/requirements.txt"

# 3. Surveillance data
echo "==> Building surveillance data (falls back to local target-data/ if offline)"
"$PYTHON_BIN" "$DIR/rebuild_surveillance.py" --force || \
    echo "WARNING: surveillance rebuild failed; the dashboard still runs without those streams."

# 4. Keep viz/ out of the hub's git status
if [ -d "$ROOT_DIR/.git" ]; then
    EXCLUDE="$ROOT_DIR/.git/info/exclude"
    mkdir -p "$(dirname "$EXCLUDE")"
    if ! grep -qxF "viz/" "$EXCLUDE" 2>/dev/null; then
        echo "viz/" >> "$EXCLUDE"
        echo "==> Added viz/ to .git/info/exclude"
    fi
fi

echo
echo "Setup complete. Start the dashboard with:  ./viz/run.sh"
