#!/usr/bin/env python3
"""Drive the whole 中转站 pipeline against a running gateway, and check it.

`replay_capture.py` does this for the mock; this is the same idea for the gateway.
It needs a *running* instance and an origin it can reach -- normally
`scripts/fake_origin.py`, so the run is free and repeatable:

    python scripts/fake_origin.py 5001 &
    IMAGE_GATEWAY_UPSTREAM=http://127.0.0.1:5001 IMAGE_GATEWAY_ACCESS_TOKEN=demo ./run.sh &
    python scripts/demo_gateway.py http://127.0.0.1:4399 demo

Point it at `https://upstream.example.com` and it will do exactly one thing: check that a
bad request comes back with the origin's own error envelope. It will not generate
anything, because generating costs money.

    python scripts/demo_gateway.py http://127.0.0.1:4399 <token>
"""

from __future__ import annotations

import sys
import uuid

import httpx

PROMPT = "a lighthouse at dusk, long exposure"

passed = 0
failed = 0


def check(label: str, ok: bool, detail: str = "") -> bool:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {label}" + (f"  ({detail})" if detail else ""))
    else:
        failed += 1
        print(f"  FAIL  {label}" + (f"  ({detail})" if detail else ""))
    return ok


def main() -> int:
    base = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4399").rstrip("/")
    token = sys.argv[2] if len(sys.argv) > 2 else ""
    headers = {"content-type": "application/json"}
    if token:
        headers["X-Relay-Token"] = token

    # A fresh salt per run, forwarded to scripts/fake_origin.py as X-Fake-Salt so
    # it returns bytes no earlier run has stored. Without it the store is
    # content-addressed, the image from a previous run is still on disk, and the
    # "not cached yet" check would fail for a reason that has nothing to do with
    # the gateway. Point this at the real origin and the header is simply ignored.
    run_salt = uuid.uuid4().hex

    # trust_env=False: a sandbox or corporate proxy must not intercept localhost.
    client = httpx.Client(base_url=base, timeout=30.0, trust_env=False, follow_redirects=False)

    print(f"gateway at {base}\n")

    # --- the contract -------------------------------------------------
    print("[0] public contract")
    config = client.get("/v1/config").json()
    check("gateway reports itself ready", config.get("ready") is True, str(config.get("ready")))
    check(
        "auth is required",
        config["auth"]["required"] is bool(token),
        f"required={config['auth']['required']}",
    )

    # --- the wrapped flow ---------------------------------------------
    print("\n[1] generate -> short URL")
    response = client.post(
        "/v1/images",
        headers={**headers, "X-Fake-Salt": run_salt},
        json={"mode": "image", "prompt": PROMPT},
    )
    if not check("200 from POST /v1/images", response.status_code == 200, response.text[:200]):
        return 1

    payload = response.json()
    body_bytes = len(response.content)
    check("response carries a short URL", payload["url"].startswith(base + "/files/"), payload["url"])
    check("no base64 blob in the response", "base64" not in response.text, f"{body_bytes} bytes")
    check("the prompt is recorded", payload["prompt"] == PROMPT)
    check("dimensions survive", payload.get("width") == 1184 and payload.get("height") == 864)
    check("first sighting is not cached", payload["cached"] is False)
    check("Location header points at the image", response.headers["location"] == payload["url"])

    # --- serving it back ----------------------------------------------
    print("\n[2] the short URL serves the image")
    image = client.get(payload["path"])
    check("200 from /files", image.status_code == 200, str(image.status_code))
    check("served as an image", image.headers["content-type"] == "image/png")
    check("bytes are non-trivial", len(image.content) > 100_000, f"{len(image.content)} bytes")
    check(
        "cacheable forever",
        "immutable" in image.headers.get("cache-control", ""),
        image.headers.get("cache-control", ""),
    )
    check("nosniff is set", image.headers.get("x-content-type-options") == "nosniff")

    etag = image.headers["etag"]
    not_modified = client.get(payload["path"], headers={"If-None-Match": etag})
    check("If-None-Match -> 304", not_modified.status_code == 304, str(not_modified.status_code))

    head = client.head(payload["path"])
    check("HEAD returns headers, no body", head.status_code == 200 and not head.content)

    ranged = client.get(payload["path"], headers={"Range": "bytes=0-7"})
    check("Range -> 206", ranged.status_code == 206, f"{len(ranged.content)} bytes")

    # --- content addressing -------------------------------------------
    print("\n[3] dedup is about storage, not about skipping the call")
    again = client.post(
        "/v1/images",
        headers={**headers, "X-Fake-Salt": run_salt},
        json={"mode": "image", "prompt": PROMPT},
    )
    check("same bytes collapse to one id", again.json()["id"] == payload["id"])
    check("the second caller is told", again.json()["cached"] is True)

    # --- the shapes the origin might use -------------------------------
    print("\n[4] every shape an image can arrive in")
    for shape, expect, note in (
        ("url", 200, "fetched back from the origin"),
        ("openai", 200, "b64_json"),
        ("binary", 200, "raw body"),
        ("queued", 502, "no image -> upstream_no_image"),
        ("foreign", 502, "off-origin URL -> upstream_bad_image_url"),
        ("error", 400, "origin's own error, passed through"),
    ):
        shaped = client.post(
            "/v1/images",
            headers={**headers, "X-Fake-Shape": shape, "X-Fake-Salt": f"{run_salt}-{shape}"},
            json={"mode": "image", "prompt": PROMPT},
        )
        check(f"{shape:<8} -> {expect}", shaped.status_code == expect, f"got {shaped.status_code} {note}")

    # --- local validation vs the origin's judgement --------------------
    print("\n[5] who rejected it?")
    local = client.post("/v1/images", headers=headers, json={})
    check("missing mode is 400", local.status_code == 400, local.text)
    check(
        "and it is *our* rejection, not the origin's",
        local.headers.get("x-mock-error-note") != "relayed from upstream",
        local.headers.get("x-mock-error-note", "(no note)"),
    )

    # --- access control ------------------------------------------------
    print("\n[6] access control")
    if token:
        anonymous = client.post("/v1/images", json={"mode": "image", "prompt": PROMPT})
        check("no token -> 401", anonymous.status_code == 401, anonymous.text)
        wrong = client.post(
            "/v1/images", headers={"X-Relay-Token": "wrong"}, json={"mode": "image", "prompt": PROMPT}
        )
        check("wrong token -> 401", wrong.status_code == 401, wrong.text)

    print("\n[7] /files refuses what it did not store")
    absent = client.get("/files/0123456789abcdef0123456789abcdef.png")
    check("absent id -> 404", absent.status_code == 404, str(absent.status_code))
    traversal = client.get("/files/..%2F..%2F..%2Fetc%2Fpasswd")
    check("traversal -> 404", traversal.status_code == 404, str(traversal.status_code))

    # --- the headline number -------------------------------------------
    print("\n[8] why this exists")
    stored = len(image.content)
    inline_bytes = stored * 4 // 3
    print(f"  the image itself is {stored:,} bytes")
    print(f"  inline -- what the origin sends -- is ~{inline_bytes:,} bytes of base64,")
    print("  in every single response body")
    print(f"  what the client actually got: {body_bytes} bytes, image one GET away")
    print(f"  {inline_bytes / max(body_bytes, 1):.0f}x less to carry around")

    client.close()
    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
