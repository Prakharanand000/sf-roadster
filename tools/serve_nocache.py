"""Local static server for testing the game: tells the browser never to cache, so edited modules and
re-baked data show up on reload.  python tools/serve_nocache.py 8174 .
"""
import functools
import http.server
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port, root = int(sys.argv[1]), sys.argv[2]
    handler = functools.partial(NoCache, directory=root)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
