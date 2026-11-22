#!/usr/bin/env python3
"""
Run viz from a development checkout or standalone directory.

    python next/dev/serve.py [--hub /path/to/hub] [--port 8610] [--data-dir /path/to/data] [--no-auto-hub]
"""
import argparse
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[2]  # this copy of viz
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from core._bootstrap import ensure_viz_package

ensure_viz_package()

from viz import server  # noqa: E402

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--hub", type=str, default=None, help="Path to a local Hubverse hub")
parser.add_argument("--port", type=int, default=8610)
parser.add_argument("--host", type=str, default="127.0.0.1")
parser.add_argument("--data-dir", type=str, default=None, help="Override directory for workspace & caches")
parser.add_argument("--no-auto-hub", action="store_true", help="Do not auto-register an enclosing parent hub")
args = parser.parse_args()

env_hub = os.environ.get("VIZ_HUB_DIR", "").strip()
cli_hubs = [args.hub] if args.hub else ([env_hub] if env_hub and Path(env_hub).expanduser().is_dir() else None)
no_auto = args.no_auto_hub or bool(env_hub and not cli_hubs)

server.run_server(
    port=args.port,
    host=args.host,
    hubs=cli_hubs,
    data_dir=args.data_dir,
    no_auto_hub=no_auto,
)
