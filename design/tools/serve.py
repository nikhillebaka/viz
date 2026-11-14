# Static server for the design reference pages. Never lets the browser cache, so edits always show.
# Usage (from the repo root): python3 design/tools/serve.py design   → http://127.0.0.1:8770/
import functools
import http.server
import sys


class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


d = sys.argv[1] if len(sys.argv) > 1 else "design"
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8770
print(f"serving {d} at http://127.0.0.1:{port}/")
http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(H, directory=d)).serve_forever()
