#!/usr/bin/env python3
"""A stand-in for the real origin, so the gateway can be exercised for free.

Developing against `upstream.example.com` means paying for every call, and a *successful*
call is the one thing the test suite cannot make. This answers the same path with
the real captured PNG, so the whole re-hosting pipeline -- extract the image,
store it, hand back a short URL, serve it -- can be driven over real HTTP without
touching the network.

    python scripts/fake_origin.py 5001 &
    IMAGE_GATEWAY_UPSTREAM=http://127.0.0.1:5001 IMAGE_GATEWAY_ACCESS_TOKEN=dev ./run.sh

    curl -s -X POST localhost:4399/v1/images -H 'X-Relay-Token: dev' \\
      -H 'content-type: application/json' -d '{"mode":"image","prompt":"x"}'

Response shape is chosen per request, so every branch of `extract_image_ref` can
be reached -- see `SHAPES` below. Defaults to `inline`, which is what the captured
client actually received.

Zero dependencies: stdlib only, on purpose. This is a dev aid, not a service.
"""

from __future__ import annotations

import base64
import json
import pathlib
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
CAPTURED_PNG = ROOT / "assets" / "captured-generated.png"

GENERATE_PATH = "/api/v1/media/ai/image"

#: Every shape the gateway knows how to find an image in, plus two it must refuse.
SHAPES = (
    "inline",  # {"image": "data:image/png;base64,..."}   <- the captured shape
    "url",  # {"url": "http://host/cdn/result.png"}     <- fetched back from us
    "openai",  # {"data": [{"b64_json": "..."}]}
    "binary",  # raw image bytes, Content-Type: image/png
    "queued",  # {"status": "queued"}                   <- no image: expect 502
    "error",  # 400 {"error": "bad_mode"}               <- the observed envelope
    "foreign",  # {"url": "https://example.invalid/..."}  <- expect 502, no fetch
)

_counter = {"n": 0}


def image_bytes(salt: str) -> bytes:
    """The captured PNG, optionally salted so dedup does not hide a round trip."""
    data = CAPTURED_PNG.read_bytes()
    return data + salt.encode("utf-8") if salt else data


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "FakeOrigin/1.0"

    def log_message(self, fmt, *args):  # quieter, and prefixed
        sys.stderr.write("fake-origin: " + (fmt % args) + "\n")

    # --- routing ------------------------------------------------------
    def do_GET(self):
        if self.path.startswith("/cdn/"):
            return self._send(200, image_bytes(self._salt()), "image/png")
        self._send_json(404, {"error": "not_found"})

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        if self.path.split("?")[0] != GENERATE_PATH:
            return self._send_json(404, {"error": "not_found"})

        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self._send_json(400, {"error": "bad_body"})

        # The real service validates `mode` first -- reproduce that, since it is
        # the one behaviour that was actually observed.
        if not isinstance(body.get("mode"), str):
            return self._send_json(400, {"error": "bad_mode"})

        _counter["n"] += 1
        shape = self._shape()
        forced = self.headers.get("x-fake-status")
        salt = self._salt()

        if shape == "error":
            return self._send_json(400, {"error": "bad_mode"})
        if shape == "queued":
            return self._send_json(200, {"status": "queued"})
        if shape == "foreign":
            return self._send_json(200, {"url": "https://example.invalid/steal.png"})

        data = image_bytes(salt)
        host = self.headers.get("host") or "127.0.0.1"

        if shape == "binary":
            return self._send(200, data, "image/png")
        if shape == "url":
            payload = {"id": f"img_{_counter['n']}", "url": f"http://{host}/cdn/result.png"}
        elif shape == "openai":
            payload = {
                "created": 1,
                "data": [{"b64_json": base64.b64encode(data).decode("ascii")}],
            }
        else:
            payload = {
                "id": f"img_{_counter['n']}",
                "mode": body.get("mode"),
                "aspect": body.get("aspect") or "4:3",
                "width": 1184,
                "height": 864,
                "image": "data:image/png;base64," + base64.b64encode(data).decode("ascii"),
            }

        if forced and forced.isdigit():
            return self._send_json(int(forced), payload)
        self._send_json(200, payload)

    # --- helpers ------------------------------------------------------
    def _shape(self) -> str:
        shape = self.headers.get("x-fake-shape") or self._shape_param("shape") or "inline"
        if shape not in SHAPES:
            return "inline"
        return shape

    def _salt(self) -> str:
        """Anything here changes the bytes, which defeats content-addressed dedup.

        Needed because the gateway stores by sha256: without a salt, the second
        run of anything finds the first run's file still on disk and reports
        `cached: true` for a reason that has nothing to do with the gateway.
        """
        return self.headers.get("x-fake-salt") or self._shape_param("salt")

    def _shape_param(self, key: str) -> str:
        if "?" not in self.path:
            return ""
        for part in self.path.split("?", 1)[1].split("&"):
            name, _, value = part.partition("=")
            if name == key:
                return value
        return ""

    def _send_json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json")

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        # A distinct header per response makes it obvious in a log which one answered.
        self.send_header("x-fake-origin", uuid.uuid4().hex[:8])
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5001
    if not CAPTURED_PNG.exists():
        print(f"missing {CAPTURED_PNG} -- run scripts/extract_capture.py first", file=sys.stderr)
        return 1
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"fake origin on http://127.0.0.1:{port}  (POST {GENERATE_PATH})", flush=True)
    print(f"shapes: {', '.join(SHAPES)}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
