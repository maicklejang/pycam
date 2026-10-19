#!/usr/bin/env python3
"""Serve the PyCAM Viewer web app on the local network.

Point your phone's browser at the printed address (both devices need to be on
the same Wi-Fi) and use "Add to home screen" to install it.

    python3 mobile/serve.py [--port 8000] [--bind 0.0.0.0]

Note: service workers, and therefore offline use, require either localhost or
HTTPS.  Over plain HTTP on a LAN address the viewer still works, it simply is
not installable until the files are served from an HTTPS origin.
"""

import argparse
import http.server
import os
import socket
import socketserver


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map)
    extensions_map.update({
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".webmanifest": "application/manifest+json",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".stl": "model/stl",
        ".step": "application/step",
        ".stp": "application/step",
        ".dxf": "image/vnd.dxf",
    })

    def end_headers(self):
        # Never cache during development - the service worker is confusing enough.
        self.send_header("Cache-Control", "no-store")
        self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "--verbose" in os.environ.get("PYCAM_SERVE_FLAGS", ""):
            super().log_message(fmt, *args)


def local_address():
    """Best guess at the address other devices can reach."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("10.255.255.255", 1))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    if args.verbose:
        os.environ["PYCAM_SERVE_FLAGS"] = "--verbose"

    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((args.bind, args.port), Handler) as httpd:
        print("PyCAM Viewer is being served from %s" % os.getcwd())
        print("  on this machine:  http://localhost:%d/" % args.port)
        print("  on your phone:    http://%s:%d/" % (local_address(), args.port))
        print("Press Ctrl-C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
