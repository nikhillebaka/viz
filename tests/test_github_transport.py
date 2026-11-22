"""
Tests for GitHubTransport (single cached Git Trees API call + raw downloads)
and RemoteManager multi-repo / archive-source GitHub syncing against a local fake GitHub server.
"""

import http.server
import json
from pathlib import Path
import hashlib
import shutil
import tempfile
import threading
import time
import unittest
import urllib.parse

import polars as pl

import conftest  # noqa: F401
from viz.core.data_loader import SandboxDataLoader
from viz.remote.hubs import HubSpec
from viz.remote.sync import RemoteManager
from viz.remote.transports import GitHubTransport, TransportError, TransportNotFound, validate_github_repo


class FakeGitHub:
    """Serves GitHub Git Trees REST API and raw file downloads from memory."""

    def __init__(self):
        self.repos = {}  # (owner/repo, branch) -> {path: bytes}
        self.tree_calls = 0
        self.raw_calls = 0
        self.rate_limit = False
        parent = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                parsed = urllib.parse.urlparse(self.path)
                parts = [p for p in parsed.path.split("/") if p]
                # Git Trees API: /repos/<owner>/<repo>/git/trees/<branch>
                if len(parts) == 6 and parts[0] == "repos" and parts[3] == "git" and parts[4] == "trees":
                    parent.tree_calls += 1
                    if parent.rate_limit:
                        self._send(403, b'{"message":"API rate limit exceeded"}')
                        return
                    repo = f"{parts[1]}/{parts[2]}"
                    branch = urllib.parse.unquote(parts[5])
                    files = parent.repos.get((repo, branch))
                    if files is None:
                        self._send(404, b'{"message":"Not Found"}')
                        return
                    tree = [
                        {
                            "path": k,
                            "type": "blob",
                            "size": len(v),
                            "sha": hashlib.sha1(v).hexdigest(),
                        }
                        for k, v in sorted(files.items())
                    ]
                    self._send(200, json.dumps({"sha": "rootsha", "truncated": False, "tree": tree}).encode("utf-8"))
                    return

                # Raw file: /<owner>/<repo>/<branch>/<path...>
                if len(parts) >= 4:
                    parent.raw_calls += 1
                    repo = f"{parts[0]}/{parts[1]}"
                    branch = urllib.parse.unquote(parts[2])
                    rel_path = urllib.parse.unquote("/".join(parts[3:]))
                    data = parent.repos.get((repo, branch), {}).get(rel_path)
                    if data is None:
                        self._send(404, b"Not Found")
                    else:
                        self._send(200, data)
                    return
                self._send(404, b"Not Found")

            def _send(self, code, body):
                self.send_response(code)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def put(self, repo: str, path: str, data, branch: str = "main"):
        if isinstance(data, str):
            data = data.encode("utf-8")
        self.repos.setdefault((repo, branch), {})[path] = data

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class TestGitHubTransport(unittest.TestCase):
    def setUp(self):
        self.gh = FakeGitHub()
        self.base = Path(tempfile.mkdtemp())

    def tearDown(self):
        self.gh.close()
        shutil.rmtree(self.base, ignore_errors=True)

    def test_validate_github_repo(self):
        self.assertEqual(validate_github_repo("reichlab/flu-metrocast"), "reichlab/flu-metrocast")
        self.assertEqual(validate_github_repo("https://github.com/european-modelling-hubs/RespiCast-SyndromicIndicators.git"), "european-modelling-hubs/RespiCast-SyndromicIndicators")
        for bad in ("https://gitlab.com/a/b", "../etc/passwd", "onlyone", "a/b/c", ""):
            with self.assertRaises(ValueError):
                validate_github_repo(bad)

    def test_single_tree_call_cached_across_prefixes_and_errors(self):
        self.gh.put("org/hub", "hub-config/admin.json", '{"name":"Test"}')
        self.gh.put("org/hub", "model-output/M1/2025-11-05-M1.csv", "a,b\n1,2\n")
        tr = GitHubTransport("org/hub", api_base=self.gh.url, raw_base=self.gh.url, retries=0)
        self.assertEqual(len(tr.list("hub-config/")), 1)
        self.assertEqual(len(tr.list("model-output/")), 1)
        self.assertEqual(self.gh.tree_calls, 1)  # Cached across list() calls!
        self.assertIn(b'"Test"', tr.get("hub-config/admin.json"))
        with self.assertRaises(TransportNotFound):
            tr.get("missing.json")

        self.gh.rate_limit = True
        tr2 = GitHubTransport("org/hub", api_base=self.gh.url, raw_base=self.gh.url, retries=0)
        with self.assertRaises(TransportError) as ctx:
            tr2.list("model-output/")
        self.assertIn("GITHUB_TOKEN", str(ctx.exception))

    def test_respicast_github_sync_with_archive_sources_and_origin_date(self):
        primary_repo = "european-modelling-hubs/RespiCast-SyndromicIndicators"
        archive_repo = "european-modelling-hubs/flu-archive"
        tasks = {
            "rounds": [{
                "round_id": "origin_date",
                "model_tasks": [{
                    "task_ids": {
                        "origin_date": {"required": ["2025-11-05"]},
                        "target": {"required": ["ILI incidence"]},
                        "location": {"optional": ["DE", "FR"]},
                        "horizon": {"required": [1]},
                        "target_end_date": {"required": ["2025-11-09"]},
                    },
                    "output_type": {"quantile": {}},
                }],
            }]
        }
        self.gh.put(primary_repo, "hub-config/admin.json", json.dumps({"name": "RespiCast", "timezone": "Europe/Stockholm"}))
        self.gh.put(primary_repo, "hub-config/tasks.json", json.dumps(tasks))
        self.gh.put(
            primary_repo,
            "model-output/EU-ens/2025-11-05-EU-ens.csv",
            "origin_date,location,horizon,target,target_end_date,output_type,output_type_id,value\n"
            "2025-11-05,DE,1,ILI incidence,2025-11-09,quantile,0.5,220.0\n",
        )
        self.gh.put(
            primary_repo,
            "target-data/latest-ILI_incidence.csv",
            "target,location,truth_date,year_week,value,data_source\n"
            "ILI incidence,DE,2025-11-09,2025-W45,215.0,ERVISS\n",
        )
        # Archive has an earlier round that should merge cleanly alongside primary
        self.gh.put(
            archive_repo,
            "model-output/EU-ens/2025-10-29-EU-ens.csv",
            "origin_date,location,horizon,target,target_end_date,output_type,output_type_id,value\n"
            "2025-10-29,DE,1,ILI incidence,2025-11-02,quantile,0.5,180.0\n",
        )

        # Initialize local workspace with minimal locations
        (self.base / "viz").mkdir()
        (self.base / "auxiliary-data").mkdir()
        pl.DataFrame({
            "abbreviation": ["US"],
            "location": ["US"],
            "location_name": ["United States"],
            "population": [334_000_000],
        }).write_csv(self.base / "auxiliary-data" / "locations.csv")

        loader = SandboxDataLoader(self.base)
        gh_url = self.gh.url

        def transport_factory(spec: HubSpec, cancel_event=None):
            return GitHubTransport(
                spec.github_repo,
                branch=spec.branch,
                api_base=gh_url,
                raw_base=gh_url,
                cancel_event=cancel_event,
                retries=0,
            )

        # Register temporary spec with single archive_repo pointing to FakeGitHub
        custom_spec = HubSpec(
            id="respicast_test",
            label="RespiCast Test",
            short_label="RespiCast",
            transport="github",
            github_repo=primary_repo,
            archive_sources=[{"transport": "github", "github_repo": archive_repo, "branch": "main"}],
        )
        loader.remote_store.add_custom_hub(custom_spec)

        mgr = RemoteManager(
            loader.remote_store,
            known_locations=lambda: set(loader.get_locations()),
            is_non_negative=lambda t: True,
            local_as_of_max=lambda: None,
            on_inventory_change=lambda hub_id, models: loader.invalidate_inventory(),
            transport_factory=transport_factory,
        )

        mgr.start_sync("respicast_test", ["2025-2026"])
        deadline = time.time() + 15
        while time.time() < deadline:
            job = mgr.get_job("respicast_test")
            if job["status"] != "running":
                break
            time.sleep(0.05)
        self.assertEqual(job["status"], "done", job.get("error"))
        self.assertEqual(job["summary"]["added"], 2)  # primary + archive round merged!
        self.assertTrue(loader.remote_store.truth_path("respicast_test", "latest").exists())


if __name__ == "__main__":
    unittest.main()
