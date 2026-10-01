"""A stand-in for a service, for infra/caddy/test.sh: it shows Caddy what an upstream does.

It answers four ways, so the test can check what Caddy does with each:

- most requests get a JSON echo of what reached it (method, path as received, the headers
  that matter), so the test can see exactly what Caddy forwarded and what it dropped;
- a path ending in /events streams three server-sent events half a second apart, so the
  test can tell a proxy that flushes from one that buffers;
- a path ending in /slow?seconds=N waits N seconds before it answers, so the test can tell
  how long Caddy is willing to wait for a service's first byte;
- a WebSocket upgrade is accepted and answered with one text frame, and then every text
  frame the client sends is answered with `echo: <text>`, however long the client was silent
  before it, so the test can tell that the upgrade passes through and that a quiet
  connection is not cut.

It also announces itself in a `Server` header, which Caddy is expected to remove.
"""

import base64
import hashlib
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

NAME = os.environ.get("UPSTREAM_NAME", "upstream")
PORT = int(os.environ.get("UPSTREAM_PORT", "8000"))
# The constant every WebSocket handshake mixes into the key (RFC 6455).
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
# What the echo reports, so a test can see which headers reached the service.
ECHOED_HEADERS = ("host", "origin", "authorization", "x-forwarded-proto", "x-forwarded-for", "cf-connecting-ip")
# How long a WebSocket may stay silent before the stand-in gives up on it.
WEBSOCKET_PATIENCE_SECONDS = 60
# The WebSocket frame types the stand-in understands (RFC 6455, section 5.2).
TEXT_FRAME = 0x1
CLOSE_FRAME = 0x8


class Handler(BaseHTTPRequestHandler):
    """Answers every method the same few ways."""

    protocol_version = "HTTP/1.1"
    server_version = "fake-upstream/1.0"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - the base class's signature
        """Say nothing: the test reads Caddy's log, not this one."""

    def handle_request(self) -> None:
        """Pick the answer: a WebSocket handshake, an event stream, a slow answer or the echo."""
        route = urlsplit(self.path)
        if self.headers.get("Upgrade", "").lower() == "websocket":
            self.accept_websocket()
        elif route.path.endswith("/events"):
            self.stream_events()
        elif route.path.endswith("/slow"):
            self.answer_slowly(parse_qs(route.query))
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

    def answer_slowly(self, query: dict[str, list[str]]) -> None:
        """Wait for the number of seconds the query asks for (at most two minutes), then echo."""
        seconds = min(int((query.get("seconds") or ["0"])[0]), 120)
        time.sleep(seconds)
        self.echo()

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
        """Complete the handshake, greet, and then echo every text frame until the client leaves."""
        key = self.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(hashlib.sha1((key + WEBSOCKET_GUID).encode()).digest()).decode()  # noqa: S324 - the protocol requires SHA-1
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.send_text(f"hello from {NAME}")
        self.connection.settimeout(WEBSOCKET_PATIENCE_SECONDS)
        try:
            while True:
                frame = self.read_frame()
                if frame is None or frame[0] == CLOSE_FRAME:
                    break
                if frame[0] == TEXT_FRAME:
                    self.send_text(f"echo: {frame[1].decode(errors='replace')}")
        except OSError:
            pass
        self.close_connection = True

    def send_text(self, text: str) -> None:
        """Send one short text frame (the stand-in never sends more than 125 bytes)."""
        message = text.encode()
        self.wfile.write(bytes([0x80 | TEXT_FRAME, len(message)]) + message)
        self.wfile.flush()

    def read_frame(self) -> tuple[int, bytes] | None:
        """Read one frame from the client: its type and its unmasked payload, or None when the client is gone."""
        header = self.rfile.read(2)
        if len(header) < 2:
            return None
        frame_type = header[0] & 0x0F
        length = header[1] & 0x7F
        if length == 126:
            length = int.from_bytes(self.rfile.read(2), "big")
        elif length == 127:
            length = int.from_bytes(self.rfile.read(8), "big")
        mask = self.rfile.read(4)
        payload = bytearray(self.rfile.read(length))
        for index in range(len(payload)):
            payload[index] ^= mask[index % 4]
        return frame_type, bytes(payload)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()  # noqa: S104 - a test double inside a throwaway network
