#!/usr/bin/env python3
"""Parse the browser "Copy all as cURL" dump (re.txt) into a machine-readable spec.

The dump contains three entries:

  1. POST https://upstream.example.com/api/v1/media/ai/image   -> the AI image endpoint
  2. curl 'data:image/png;base64,...'                   -> an inlined PNG (the generated
                                                           image, C2PA-signed by Google).
                                                           The exporter clobbered the real
                                                           URL with the body, so the target
                                                           endpoint is unknowable from here.
  3. GET  https://upstream.example.com/assets/Assistant-Regular-00000000.woff2

The dump names the origin's host, its device header and its build hashes. None of
that is reproduced here: the committed spec records the *shape* of the call, with
those three identifiers replaced by stand-ins (see `redact_*` below).

Outputs:
  capture/spec.json              -- the parsed requests (no bulk payloads inlined)
  assets/captured-generated.png  -- the decoded PNG from entry 2

Usage:
  python scripts/extract_capture.py [path/to/re.txt]
"""

from __future__ import annotations

import base64
import hashlib
import json
import pathlib
import re
import struct
import sys
from urllib.parse import urlsplit

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT.parent.parent / "re.txt"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.upstream import DEVICE_HEADER  # noqa: E402

#: Written into the committed spec instead of the real identifiers. The host, the
#: device header name and the build hash in an asset filename are the three things
#: that would say *which* origin this came from. The spec records the call's shape,
#: not its address.
REDACTED_HOST = "upstream.example.com"
REDACTED_DEVICE_HEADER = "X-Device-Id"
#: The device id is a live credential, not just an identifier -- the origin accepts
#: it as proof of a device. Keeping the `web-` prefix records the *shape*; the uuid
#: itself is replaced, or re-running this script would put it back in the tree.
REDACTED_DEVICE_VALUE = "web-00000000-0000-0000-0000-000000000000"

_BUILD_HASH = re.compile(r"-[A-Za-z0-9_-]{8}(\.[A-Za-z0-9]+)$")


def redact_device_id(value: str) -> str:
    prefix = value.split("-", 1)[0] if "-" in value else "web"
    return f"{prefix}-00000000-0000-0000-0000-000000000000"


def redact_path(path: str) -> str:
    """`/assets/Assistant-Regular-DVxZuzxb.woff2` -> `...-00000000.woff2`."""
    return _BUILD_HASH.sub(r"-00000000\1", path)


def redact_url(url: str | None) -> str | None:
    if not url:
        return None
    return f"https://{REDACTED_HOST}{redact_path(urlsplit(url).path)}"


def redact_headers(headers: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, value in headers.items():
        if name.lower() == DEVICE_HEADER.lower():
            out[REDACTED_DEVICE_HEADER] = redact_device_id(value)
        elif name.lower() in ("origin", "referer"):
            out[name] = redact_url(value) or ""
        else:
            out[name] = value
    return out


def png_info(data: bytes) -> dict:
    """Read IHDR + the chunk list. C2PA lives in the caBX/jumb chunks."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    width, height = struct.unpack(">II", data[16:24])
    bit_depth, color_type = data[24], data[25]

    offset, chunks, has_c2pa = 8, [], False
    while offset + 8 <= len(data):
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        ctype = data[offset + 4 : offset + 8].decode("latin-1")
        if ctype in ("caBX", "jumb"):
            has_c2pa = True
        if ctype != "IDAT":  # collapse the ~260 IDAT chunks
            chunks.append({"type": ctype, "length": length})
        offset += 12 + length
        if ctype == "IEND":
            break

    return {
        "width": width,
        "height": height,
        "ratio": round(width / height, 6),
        "bitDepth": bit_depth,
        "colorType": color_type,
        "hasC2PA": has_c2pa,
        "chunks": chunks,
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def parse_headers(block: str) -> dict[str, str]:
    headers: dict[str, str] = {}
    malformed: list[str] = []
    for raw in re.findall(r"-H '([^']*)'", block):
        if ":" in raw:
            name, _, value = raw.partition(":")
            headers[name.strip()] = value.strip()
        else:
            # e.g. the exporter emitted a malformed "-H 'Referer;'"
            malformed.append(raw)
    if malformed:
        headers["__malformed__"] = "; ".join(malformed)
    return headers


def parse_body(block: str) -> dict | None:
    """`--data-raw '<json>' ;` -- note the trailing semicolon the exporter emits."""
    marker = "--data-raw '"
    if marker not in block:
        return None
    tail = block.split(marker, 1)[1]
    end = tail.rfind("'")
    return json.loads(tail[:end])


def main() -> int:
    source = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not source.exists():
        print(f"source not found: {source}", file=sys.stderr)
        return 1

    raw = source.read_text(encoding="utf-8", errors="replace")

    # --- entry 1: the image generation call -------------------------------
    start = raw.index("curl '")
    end = raw.index("curl 'data:image/png;base64,")
    first = raw[start:end]

    url = re.search(r"curl '([^']+)'", first).group(1)  # type: ignore[union-attr]
    headers = redact_headers(parse_headers(first))
    body = parse_body(first)

    # --- entry 2: the inlined PNG ----------------------------------------
    m = re.search(r"curl 'data:image/png;base64,([A-Za-z0-9+/=]+)'", raw)
    if not m:
        print("could not find the base64 payload", file=sys.stderr)
        return 1
    png_bytes = base64.b64decode(m.group(1))
    info = png_info(png_bytes)

    out_png = ROOT / "assets" / "captured-generated.png"
    out_png.parent.mkdir(parents=True, exist_ok=True)
    out_png.write_bytes(png_bytes)

    # --- entry 3: the static asset ---------------------------------------
    # Matched by shape, not by host: hard-coding the host here would both break
    # on a re-capture from a different origin and put the name back in the tree.
    asset_match = re.search(r"curl '(https?://[^']+/assets/[^']+)'", raw)
    if not asset_match:
        print("could not find the asset request", file=sys.stderr)
        return 1
    asset_block = raw[asset_match.start() :]
    asset_url = asset_match.group(1)

    spec = {
        "_comment": (
            "Parsed from a browser 'Copy all as cURL' dump. Requests only -- no "
            "responses were captured. Fields marked inferred are guesses. "
            "Redacted: the origin's host, its device header name and its build "
            "hashes are replaced by stand-ins, so the spec records the shape of "
            "the call rather than where it was aimed."
        ),
        "sourceFile": source.name,
        "captures": [
            {
                "id": "ai-image",
                "method": "POST",
                "url": redact_url(url),
                "path": redact_path(urlsplit(url).path),
                "headers": headers,
                "body": body,
                "observed": True,
            },
            {
                "id": "inlined-png",
                "method": "UNKNOWN",
                "url": None,
                "note": (
                    "Exporter replaced the request URL with the request body, so the real "
                    "target endpoint cannot be recovered. Most likely the generated image "
                    "being uploaded, or the response image inlined as a data URL."
                ),
                "bytes": len(png_bytes),
                "png": info,
                "observed": True,
            },
            {
                "id": "asset-font",
                "method": "GET",
                "url": redact_url(asset_url),
                "path": redact_path(urlsplit(asset_url).path),
                "headers": redact_headers(parse_headers(asset_block)),
                "note": "Response body not captured; the mock serves a configurable placeholder.",
                "observed": True,
            },
        ],
        "probe": {
            "_comment": "Live probes against the real service. No image was ever generated.",
            "server": "Kestrel",
            "backend": "ASP.NET Core",
            "observations": [
                {
                    "request": "OPTIONS /api/v1/media/ai/image",
                    "status": 204,
                    "note": "No CORS headers returned (same-origin app, none needed).",
                },
                {
                    "request": "POST /api/v1/media/ai/image  body={}",
                    "status": 400,
                    "body": {"error": "bad_mode"},
                    "note": "Flat snake_case error envelope, no wrapper. mode is validated first.",
                },
                {
                    "request": "POST /api/v1/__nope__",
                    "status": 405,
                    "headers": {"Allow": "GET, HEAD"},
                    "note": "Non-route POST is rejected by the static-file handler.",
                },
                {
                    "request": "GET /api/v1/__nope__",
                    "status": 200,
                    "contentType": "text/html",
                    "note": "SPA fallback: unmatched GET returns index.html, not 404/405.",
                },
            ],
        },
    }

    out_spec = ROOT / "capture" / "spec.json"
    out_spec.parent.mkdir(parents=True, exist_ok=True)
    out_spec.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {out_spec.relative_to(ROOT)}")
    print(f"wrote {out_png.relative_to(ROOT)}  ({info['width']}x{info['height']}, {len(png_bytes)} bytes)")
    print(f"  aspect requested : {body.get('aspect') if body else '?'}")
    print(f"  aspect returned  : {info['ratio']:.4f}  ({info['width']}x{info['height']})")
    print(f"  C2PA present     : {info['hasC2PA']}")
    print(f"  mode             : {body.get('mode') if body else '?'}")
    print(f"  device           : {headers.get(REDACTED_DEVICE_HEADER)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
