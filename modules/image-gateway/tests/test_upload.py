"""The upload endpoint.

Mock extension: the second capture entry was a 2.88MB data URL whose target URL
the exporter destroyed, so the real endpoint is unknown. This pins the shape the
mock promises, and proves the round trip works.
"""

from __future__ import annotations

import base64

from conftest import CAPTURED_PNG

ENDPOINT = "/api/v1/media/upload"


def data_url() -> str:
    return "data:image/png;base64," + base64.b64encode(CAPTURED_PNG.read_bytes()).decode("ascii")


def test_raw_data_url_body_is_accepted(client):
    response = client.post(
        ENDPOINT, content=data_url().encode("ascii"), headers={"Content-Type": "text/plain"}
    )

    assert response.status_code == 200
    payload = response.json()

    assert payload["id"].startswith("up_")
    assert payload["mimeType"] == "image/png"
    assert payload["size"] == len(CAPTURED_PNG.read_bytes())
    assert payload["url"].endswith(".bin")


def test_uploaded_bytes_can_be_fetched_back(client):
    payload = client.post(ENDPOINT, content=data_url().encode("ascii")).json()

    import urllib.parse

    fetched = client.get(urllib.parse.urlparse(payload["url"]).path)

    assert fetched.status_code == 200
    assert fetched.content == CAPTURED_PNG.read_bytes()
    assert fetched.headers["content-type"] == "image/png"


def test_json_wrapper_is_accepted(client):
    for key in ("dataUrl", "data_url", "image", "file"):
        response = client.post(ENDPOINT, json={key: data_url()})
        assert response.status_code == 200, key


def test_plain_payload_is_rejected(client):
    response = client.post(ENDPOINT, json={"dataUrl": "https://example.com/a.png"})

    assert response.status_code == 400
    assert response.json()["error"] == "bad_payload"


def test_broken_base64_is_rejected(client):
    response = client.post(ENDPOINT, content=b"data:image/png;base64,!!!!")

    assert response.status_code == 400
    assert response.json()["error"] == "bad_payload"


def test_empty_body_is_rejected(client):
    response = client.post(ENDPOINT, content=b"")

    assert response.status_code == 400
    assert response.json()["error"] == "bad_body"
