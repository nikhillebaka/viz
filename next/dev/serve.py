#!/usr/bin/env python3
"""
Run viz from a development copy that does not sit inside a hub (a git worktree, say).

    python next/dev/serve.py [--hub /path/to/hub] [--port 8610]

viz normally finds its hub as the folder it sits in and imports itself as `viz.*`. A worktree is
neither inside the hub nor named `viz`, so this launcher makes this copy importable as `viz` and
points it at the hub with VIZ_HUB_DIR. Without --hub it looks upward for a folder that contains
model-output/. The cache and surveillance data are the hub's own (hub/viz/.cache), so nothing is
rebuilt. Use a port other than the one your everyday viz runs on.
"""
import argparse
import importlib.util
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[2]  # this copy of viz


def find_hub(start: Path):
    for p in [start, *start.parents]:
        if (p / "model-output").is_dir():
            return p
    return None


parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--hub", type=str, default=os.environ.get("VIZ_HUB_DIR"))
parser.add_argument("--port", type=int, default=8610)
parser.add_argument("--host", type=str, default="127.0.0.1")
args = parser.parse_args()

hub = Path(args.hub).resolve() if args.hub else find_hub(HERE)
if hub is None:
    sys.exit("Could not find a hub (a folder with model-output/). Pass --hub.")
os.environ["VIZ_HUB_DIR"] = str(hub)

# this copy, importable as the package `viz`, whatever its folder is called
spec = importlib.util.spec_from_file_location("viz", HERE / "__init__.py", submodule_search_locations=[str(HERE)])
pkg = importlib.util.module_from_spec(spec)
sys.modules["viz"] = pkg
spec.loader.exec_module(pkg)

from viz import server  # noqa: E402

server.run_server(port=args.port, host=args.host)
