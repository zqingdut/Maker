"""The happy path: replay the captured call and check what comes back."""

from __future__ import annotations

import base64
import struct
import time
import urllib.parse

from conftest import CAPTURED_PNG

from app.upstream import DEVICE_HEADER, GENERATE_PATH

ENDPOINT = GENERATE_PATH


def decode_data_url(data_url: str) -> bytes:
    assert data_url.startswith("data:image/png;base64,")
    return base64.b64decode(data_url.split(",", 1)[1])


def png_size(data: bytes) -> tuple[int, int]:
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    return struct.unpack(">II", data[16:24])


def test_captured_call_returns_the_captured_image(client, captured_body, device_headers):
    response = client.post(ENDPOINT, json=captured_body, headers=device_headers)

    assert response.status_code == 200
    payload = response.json()

    assert payload["id"].startswith("img_")
    assert payload["mode"] == "image"
    assert payload["aspect"] == "4:3"
    assert payload["prompt"] == captured_body["prompt"]
    assert payload["mimeType"] == "image/png"
    assert payload["source"] == "captured"

    # The real service answered a "4:3" request with a 1184x864 PNG.
    assert (payload["width"], payload["height"]) == (1184, 864)
    assert payload["size"] == len(CAPTURED_PNG.read_bytes())

    # The real session received the image inline as a data URL.
    image = decode_data_url(payload["image"])
    assert image == CAPTURED_PNG.read_bytes()
    assert png_size(image) == (1184, 864)

    # C2PA content credentials are present in the captured sample.
    assert payload["credential"]["c2pa"] is True
    assert payload["deviceId"] == device_headers[DEVICE_HEADER]


def test_unknown_fields_are_echoed_not_dropped(client, captured_body, device_headers):
    body = dict(captured_body, seed=42, stylePreset="poster")
    response = client.post(ENDPOINT, json=body, headers=device_headers)

    assert response.status_code == 200
    assert response.json()["echoedFields"] == {"seed": 42, "stylePreset": "poster"}


def test_deterministic_mode_is_stable(client, captured_body, device_headers):
    first = client.post(ENDPOINT, json=captured_body, headers=device_headers).json()
    second = client.post(ENDPOINT, json=captured_body, headers=device_headers).json()

    assert first["id"] == second["id"]
    assert first["image"] == second["image"]


def test_deterministic_mode_distinguishes_prompts(client, captured_body, device_headers):
    other = dict(captured_body, prompt="a lighthouse at dusk, screenprint")
    first = client.post(ENDPOINT, json=captured_body, headers=device_headers).json()
    second = client.post(ENDPOINT, json=other, headers=device_headers).json()

    assert first["id"] != second["id"]


def test_non_deterministic_mode_varies(make_settings, captured_body, device_headers):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(make_settings(deterministic=False))) as client:
        first = client.post(ENDPOINT, json=captured_body, headers=device_headers).json()
        second = client.post(ENDPOINT, json=captured_body, headers=device_headers).json()

    assert first["id"] != second["id"]


def test_seed_override_pins_the_id(client, captured_body, device_headers):
    headers = dict(device_headers, **{"X-Mock-Seed": "deadbeef"})
    payload = client.post(ENDPOINT, json=captured_body, headers=headers).json()
    assert payload["id"] == "img_deadbeef"


def test_url_style_serves_real_bytes_from_the_mock(client, captured_body, device_headers):
    headers = dict(device_headers, **{"X-Mock-Style": "url"})
    payload = client.post(ENDPOINT, json=captured_body, headers=headers).json()

    assert "image" not in payload
    assert payload["url"].endswith(".png")

    path = urllib.parse.urlparse(payload["url"]).path
    fetched = client.get(path)

    assert fetched.status_code == 200
    assert fetched.headers["content-type"] == "image/png"
    assert fetched.content == CAPTURED_PNG.read_bytes()


def test_openai_style_is_decodable(client, captured_body, device_headers):
    headers = dict(device_headers, **{"X-Mock-Style": "openai"})
    payload = client.post(ENDPOINT, json=captured_body, headers=headers).json()

    assert isinstance(payload["created"], int)
    assert base64.b64decode(payload["data"][0]["b64_json"]) == CAPTURED_PNG.read_bytes()


def test_placeholder_variant_honours_the_requested_aspect(client, device_headers):
    headers = dict(device_headers, **{"X-Mock-Variant": "placeholder"})
    payload = client.post(
        ENDPOINT, json={"mode": "image", "prompt": "wide sky", "aspect": "16:9"}, headers=headers
    ).json()

    assert payload["source"] == "placeholder"
    assert (payload["width"], payload["height"]) == (1344, 768)
    assert png_size(decode_data_url(payload["image"])) == (1344, 768)


def test_placeholder_is_deterministic_per_prompt(client, device_headers):
    headers = dict(device_headers, **{"X-Mock-Variant": "placeholder"})

    def call(prompt):
        return client.post(
            ENDPOINT, json={"mode": "image", "prompt": prompt, "aspect": "1:1"}, headers=headers
        ).json()["image"]

    assert call("alpha") == call("alpha")
    assert call("alpha") != call("beta")


def test_captured_variant_reports_both_sizes_when_they_disagree(client, device_headers):
    """A 1:1 request still gets the fixed 1184x864 sample, and is told so."""
    payload = client.post(
        ENDPOINT, json={"mode": "image", "prompt": "square", "aspect": "1:1"}, headers=device_headers
    ).json()

    assert (payload["width"], payload["height"]) == (1184, 864)
    assert (payload["requestedWidth"], payload["requestedHeight"]) == (1024, 1024)


def test_aspect_token_variants_are_accepted(client, device_headers):
    for token in ("4:3", "4x3", "4/3"):
        payload = client.post(
            ENDPOINT, json={"mode": "image", "prompt": "p", "aspect": token}, headers=device_headers
        ).json()
        assert payload["aspect"] == "4:3", token


def test_missing_aspect_falls_back_to_the_default(client, device_headers):
    payload = client.post(
        ENDPOINT, json={"mode": "image", "prompt": "p"}, headers=device_headers
    ).json()
    assert payload["aspect"] == "4:3"


def test_latency_simulation_can_be_overridden_per_request(make_settings, captured_body):
    from fastapi.testclient import TestClient

    from app.main import create_app

    settings = make_settings(latency_min_ms=3000, latency_max_ms=3000)
    with TestClient(create_app(settings)) as client:
        started = time.perf_counter()
        response = client.post(
            ENDPOINT,
            json=captured_body,
            headers={"X-Mock-Delay": "0", "Content-Type": "application/json"},
        )
        elapsed = time.perf_counter() - started

    assert response.status_code == 200
    assert elapsed < 1.0, f"X-Mock-Delay was ignored ({elapsed:.2f}s)"


def test_request_id_is_echoed(client, captured_body, device_headers):
    headers = dict(device_headers, **{"X-Request-Id": "trace-123"})
    payload = client.post(ENDPOINT, json=captured_body, headers=headers).json()
    assert payload["requestId"] == "trace-123"
