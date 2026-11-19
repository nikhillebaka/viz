#!/usr/bin/env bash
# ==============================================================================
# One-time setup for viz. Works either cloned anywhere (standalone) or inside
# a Hubverse hub folder. Safe to re-run.
#   1. Creates .venv inside this checkout (skipped if VIRTUAL_ENV is active)
#   2. Installs Python dependencies from requirements.txt
#   3. When inside a Hubverse hub, builds surveillance data, creates
#      local-output/, and updates the hub's .git/info/exclude
# ==============================================================================

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
DIRNAME="$(basename "$DIR")"
ROOT_DIR="$(dirname "$DIR")"

is_hub() {
    [ -f "$1/hub-config/tasks.json" ] || [ -d "$1/model-output" ] || [ -d "$1/target-data" ]
}

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
        echo "==> Creating virtual environment in $DIR/.venv"
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

echo
if is_hub "$ROOT_DIR"; then
    # 3. Surveillance data (inside enclosing hub)
    echo "==> Enclosing Hubverse hub detected: $ROOT_DIR"
    echo "==> Building surveillance data (falls back to local target-data/ if offline)"
    "$PYTHON_BIN" "$DIR/rebuild_surveillance.py" --hub "$ROOT_DIR" --force || \
        echo "WARNING: surveillance rebuild failed; the dashboard still runs without those streams."

    # 4. Staging folder for uncommitted model runs (shown as [LOCAL] in the dashboard)
    if [ ! -d "$ROOT_DIR/local-output" ]; then
        mkdir -p "$ROOT_DIR/local-output"
        echo "==> Created local-output/ (put uncommitted runs in local-output/<model_id>/)"
    fi

    # 5. Keep this tool folder and local-output/ out of the hub's git status
    if [ -d "$ROOT_DIR/.git" ]; then
        EXCLUDE="$ROOT_DIR/.git/info/exclude"
        mkdir -p "$(dirname "$EXCLUDE")"
        for entry in "${DIRNAME}/" "local-output/"; do
            if ! grep -qxF "$entry" "$EXCLUDE" 2>/dev/null; then
                echo "$entry" >> "$EXCLUDE"
                echo "==> Added $entry to .git/info/exclude"
            fi
        done
    fi

    echo
    echo "Setup complete. Start the dashboard with:  \"$DIR/run.sh\""
else
    echo "Setup complete (standalone mode)."
    echo "Start the dashboard and connect any local Hubverse hub in the UI:"
    echo "  \"$DIR/run.sh\""
    echo "Or launch directly against a local hub folder:"
    echo "  \"$DIR/run.sh\" --hub /path/to/your-hub"
fi
