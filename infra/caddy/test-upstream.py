"""A stand-in for a service, for infra/caddy/test.sh: it shows Caddy what an upstream does.

It answers three ways, so the test can check what Caddy does with each:

- most requests get a JSON echo of what reached it (method, path as received, the headers
  that matter), so the test can see exactly what Caddy forwarded and what it dropped;
- a path ending in /events streams three server-sent events half a second apart, so the
  test can tell a proxy that flushes from one that buffers;
- a WebSocket upgrade is accepted and answered with one text frame, so the test can tell
  that the upgrade passes through.

It also announces itself in a `Server` header, which Caddy is expected to remove.
"""

import base64
import hashlib
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NAME = os.environ.get("UPSTREAM_NAME", "upstream")
PORT = int(os.environ.get("UPSTREAM_PORT", "8000"))
# The constant every WebSocket handshake mixes into the key (RFC 6455).
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
# What the echo reports, so a test can see which headers reached the service.
ECHOED_HEADERS = ("host", "origin", "authorization", "x-forwarded-proto", "x-forwarded-for", "cf-connecting-ip")


class Handler(BaseHTTPRequestHandler):
    """Answers every method the same few ways."""

    protocol_version = "HTTP/1.1"
    server_version = "fake-upstream/1.0"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - the base class's signature
        """Say nothing: the test reads Caddy's log, not this one."""

    def handle_request(self) -> None:
        """Pick the answer: a WebSocket handshake, an event stream or the echo."""
        if self.headers.get("Upgrade", "").lower() == "websocket":
            self.accept_websocket()
        elif self.path.split("?")[0].endswith("/events"):
            self.stream_events()
        else:
            self.echo()

    do_GET = do_POST = do_PUT = do_DELETE = do_OPTIONS = do_PATCH = do_HEAD = handle_request  # noqa: N815 - the names http.server looks up

    def echo(self) -> None:
        """Answer with a JSON description of the request."""
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        headers = {name: self.headers[name] for name in ECHOED_HEADERS if self.headers.get(name) is not None}
        payload = json.dumps(
            {"upstream": NAME, "method": self.command, "path": self.path, "headers": headers, "body_bytes": len(body)}
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Powered-By", "fake-framework")
        self.end_headers()
        self.wfile.write(payload)

    def stream_events(self) -> None:
        """Send three events, half a second apart, as chunks the moment each is ready."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for number in range(1, 4):
            event = f"data: {number}\n\n".encode()
            self.wfile.write(f"{len(event):x}\r\n".encode() + event + b"\r\n")
            self.wfile.flush()
            time.sleep(0.5)
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def accept_websocket(self) -> None:
        """Complete the handshake and send one text frame, then hold the connection briefly."""
        key = self.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(hashlib.sha1((key + WEBSOCKET_GUID).encode()).digest()).decode()  # noqa: S324 - the protocol requires SHA-1
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        message = f"hello from {NAME}".encode()
        self.wfile.write(bytes([0x81, len(message)]) + message)
        self.wfile.flush()
        time.sleep(1)
        self.close_connection = True


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()  # noqa: S104 - a test double inside a throwaway network
