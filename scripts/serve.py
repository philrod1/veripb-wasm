#!/usr/bin/env python3
"""Serves web/ over HTTP with the headers every mode can use: cross-origin
isolation (needed by classic mode for SharedArrayBuffer) and no caching.

Usage: scripts/serve.py [port] [address]   (default: 8000 127.0.0.1)
"""

import functools
import http.server
import os
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
    }

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    address = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
    web = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
    server = http.server.ThreadingHTTPServer((address, port), functools.partial(Handler, directory=web))
    print(f"Serving {web} at http://{address}:{port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
