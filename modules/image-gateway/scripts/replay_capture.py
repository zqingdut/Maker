#!/usr/bin/env python3
"""Replay the captured session against a running image-gateway.

This is the end-to-end proof: the bytes sent are the ones from re.txt, with only
the host swapped.

    ./run.sh &                                  # or: uvicorn app.main:app
    python scripts/replay_capture.py
    python scripts/replay_capture.py --style url --variant placeholder

Exit code is 0 only if every replayed request landed where it should.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import re
import sys
import urllib.parse

import httpx

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPEC = ROOT / "capture" / "spec.json"
CAPTURE_TXT = ROOT.parent.parent / "re.txt"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.upstream import DEVICE_HEADER  # noqa: E402

# Colour only when a human is watching. Redirecting to a log file must not
# scatter escape sequences through it.
if sys.stdout.isatty() and not os.environ.get("NO_COLOR"):
    GREEN, RED, DIM, BOLD, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[1m", "\033[0m"
else:
    GREEN = RED = DIM = BOLD = RESET = ""


def ok(flag: bool, label: str) -> bool:
    print(f"  {GREEN + 'PASS' + RESET if flag else RED + 'FAIL' + RESET}  {label}")
    return flag


def summarise(payload: dict) -> str:
    if "image" in payload:
        return f"image data-url, {len(payload['image'])} chars"
    if "url" in payload:
        return f"url -> {payload['url']}"
    if "data" in payload:
        return f"openai b64_json, {len(payload['data'][0]['b64_json'])} chars"
    return json.dumps(payload)[:80]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:4399")
    parser.add_argument("--style", default=None, choices=["inline", "url", "openai"])
    parser.add_argument("--variant", default=None, choices=["captured", "placeholder"])
    parser.add_argument("--delay", type=int, default=120, help="X-Mock-Delay in ms")
    args = parser.parse_args()

    if not SPEC.exists():
        print(f"{RED}missing {SPEC}{RESET} -- run: python scripts/extract_capture.py", file=sys.stderr)
        return 2

    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    capture = spec["captures"][0]
    body = capture["body"]
    failures = 0

    headers = {
        "Content-Type": "application/json",
        "Origin": "https://upstream.example.com",
        "Referer": "https://upstream.example.com/",
        "User-Agent": capture["headers"]["User-Agent"],
        # The spec is redacted, so the device header key there is a stand-in; the
        # mock itself still reads the origin's own name, which comes from the
        # contract module.
        DEVICE_HEADER: capture["headers"]["X-Device-Id"],
        "X-Mock-Delay": str(args.delay),
    }
    if args.style:
        headers["X-Mock-Style"] = args.style
    if args.variant:
        headers["X-Mock-Variant"] = args.variant

    # trust_env=False: never let a corporate/sandbox HTTP_PROXY hijack a call to
    # 127.0.0.1 -- a localhost request must go straight to the mock.
    with httpx.Client(base_url=args.base_url, timeout=60.0, trust_env=False) as client:
        # --- 0. is it up? --------------------------------------------------
        print(f"\n{BOLD}[0] GET /__mock__/healthz{RESET}")
        try:
            health = client.get("/__mock__/healthz")
        except httpx.HTTPError as exc:
            print(f"{RED}cannot reach {args.base_url}: {exc}{RESET}")
            return 2
        state = health.json()
        failures += not ok(health.status_code == 200, f"200 OK, captured image present={state['capturedImagePresent']}")
        print(f"  {DIM}server: {health.headers.get('server')}  x-mock: {health.headers.get('x-mock')}{RESET}")

        # --- 1. the captured generation call ------------------------------
        print(f"\n{BOLD}[1] POST {capture['path']}  (replayed from re.txt){RESET}")
        print(f"  {DIM}mode={body['mode']} aspect={body['aspect']} prompt={len(body['prompt'])} chars{RESET}")
        response = client.post(capture["path"], json=body, headers=headers)
        print(f"  {DIM}HTTP {response.status_code}  {response.headers.get('content-type')}{RESET}")

        failures += not ok(response.status_code == 200, "200 OK")
        if response.status_code == 200:
            payload = response.json()
            if args.style == "openai":
                print(f"  {DIM}SKIP  flat-field checks -- openai style uses a different shape{RESET}")
            else:
                failures += not ok(payload["aspect"] == body["aspect"], f"aspect echoed: {payload['aspect']}")
                failures += not ok(
                    (payload["width"], payload["height"]) == (1184, 864),
                    f"dimensions {payload['width']}x{payload['height']} (real service: 1184x864)",
                )
                failures += not ok(
                    payload.get("deviceId") == headers[DEVICE_HEADER], "device header round-tripped"
                )
            print(f"  {DIM}payload: {summarise(payload)}{RESET}")

            image_ref = payload.get("image") or payload.get("url")
            if payload.get("data"):
                image_ref = "data:image/png;base64," + payload["data"][0]["b64_json"]

            # --- 1b. the image actually decodes ---------------------------
            if image_ref:
                fetched = (
                    client.get(urllib.parse.urlparse(image_ref).path)
                    if image_ref.startswith("http")
                    else None
                )
                if fetched is not None:
                    data = fetched.content
                    failures += not ok(fetched.status_code == 200, f"GET {fetched.request.url.path} -> 200")
                else:
                    data = base64.b64decode(image_ref.split(",", 1)[1])
                is_png = data[:8] == b"\x89PNG\r\n\x1a\n"
                failures += not ok(is_png, f"image decodes to a PNG ({len(data)} bytes)")
                if is_png:
                    import struct

                    w, h = struct.unpack(">II", data[16:24])
                    failures += not ok(w > 0 and h > 0, f"PNG header says {w}x{h}")
                    if args.variant == "placeholder":
                        print(
                            f"  {DIM}SKIP  C2PA check -- a synthesised placeholder has no manifest{RESET}"
                        )
                    else:
                        failures += not ok(
                            b"caBX" in data[:16384], "C2PA content credentials present"
                        )

            # --- 1c. a bad mode must fail exactly like the real service ----
            bad = client.post(capture["path"], json={}, headers=headers)
            failures += not ok(
                bad.status_code == 400 and bad.json() == {"error": "bad_mode"},
                f'POST {{}} -> 400 {{"error":"bad_mode"}}  (got {bad.status_code} {bad.text[:40]})',
            )

        # --- 2. the inlined PNG -> the upload endpoint ---------------------
        print(f"\n{BOLD}[2] POST /api/v1/media/upload  (the 2.88MB data URL from re.txt){RESET}")
        raw = CAPTURE_TXT.read_text(encoding="utf-8", errors="replace")
        match = re.search(r"curl 'data:image/png;base64,([A-Za-z0-9+/=]+)'", raw)
        if match:
            data_url = "data:image/png;base64," + match.group(1)
            upload = client.post(
                "/api/v1/media/upload",
                content=data_url.encode("ascii"),
                headers={"Content-Type": "text/plain", "X-Mock-Delay": "0"},
            )
            failures += not ok(upload.status_code == 200, f"200 OK ({len(data_url)} chars sent)")
            if upload.status_code == 200:
                uploaded = upload.json()
                failures += not ok(uploaded["size"] == 2160506, f"size reported: {uploaded['size']}")
                fetched = client.get(urllib.parse.urlparse(uploaded["url"]).path)
                failures += not ok(
                    fetched.content == base64.b64decode(match.group(1)),
                    "uploaded bytes fetched back identical",
                )
        else:
            failures += not ok(False, "could not find the data URL in re.txt")

        # --- 3. the captured static asset ---------------------------------
        print(f"\n{BOLD}[3] GET {spec['captures'][2]['path']}{RESET}")
        asset = client.get(spec["captures"][2]["path"], headers={"X-Mock-Delay": "0"})
        print(f"  {DIM}HTTP {asset.status_code}  {asset.text[:60]}{RESET}")
        failures += not ok(
            asset.status_code in (200, 404),
            f"handled predictably ({asset.status_code}) -- the real body was never captured",
        )

        # --- 4. routing parity with the real service ----------------------
        print(f"\n{BOLD}[4] routing parity{RESET}")
        fallback = client.get(capture["path"])
        failures += not ok(
            fallback.status_code == 200 and "text/html" in fallback.headers.get("content-type", ""),
            "GET on the API path -> 200 text/html (SPA fallback)",
        )
        not_allowed = client.post("/api/v1/__nope__", json={})
        failures += not ok(
            not_allowed.status_code == 405 and not_allowed.headers.get("allow") == "GET, HEAD",
            f"POST on an unknown path -> 405, Allow: {not_allowed.headers.get('allow')}",
        )
        preflight = client.options(capture["path"])
        failures += not ok(preflight.status_code in (200, 204), f"OPTIONS -> {preflight.status_code}")

        # --- 5. what the mock saw -----------------------------------------
        print(f"\n{BOLD}[5] GET /__mock__/requests{RESET}")
        logged = client.get("/__mock__/requests", params={"limit": 100}).json()
        ai_records = [r for r in logged["records"] if r.get("kind") == "ai-image"]
        failures += not ok(len(ai_records) >= 2, f"{len(ai_records)} ai-image requests logged")
        if ai_records:
            first = ai_records[0]
            failures += not ok(
                first["prompt"] == body["prompt"], "logged prompt is byte-identical to the capture"
            )
            failures += not ok(
                first["device"] == headers[DEVICE_HEADER], "logged device header matches"
            )
            print(f"  {DIM}log file: {logged['path']}{RESET}")

    print()
    if failures:
        print(f"{RED}{BOLD}{failures} check(s) failed{RESET}\n")
        return 1
    print(f"{GREEN}{BOLD}all checks passed{RESET}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
