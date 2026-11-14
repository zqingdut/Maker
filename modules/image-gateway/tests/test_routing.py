"""Routing behaviour observed on the real service.

    GET  <any unknown path>  -> 200 text/html   (SPA fallback, not 404)
    POST <any unknown path>  -> 405, Allow: GET, HEAD, empty body
    OPTIONS /api/v1/...      -> 204, no body
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

ENDPOINT = "/api/v1/media/ai/image"


def test_get_on_the_api_path_returns_the_spa_fallback(client):
    response = client.get(ENDPOINT)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-cache"


def test_get_on_an_unknown_path_returns_the_spa_fallback(client):
    response = client.get("/api/v1/__nope__")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")


def test_post_on_an_unknown_path_is_405_with_allow_header(client):
    response = client.post("/api/v1/__nope__", json={})

    assert response.status_code == 405
    assert response.headers["allow"] == "GET, HEAD"
    assert response.content == b""


def test_head_on_an_unknown_path_has_no_body(client):
    response = client.head("/anything")

    assert response.status_code == 200
    assert response.content == b""


def test_options_is_204_without_cors(make_settings):
    """The real service answered OPTIONS with 204 and no CORS headers."""
    with TestClient(create_app(make_settings(cors_origins=()))) as client:
        response = client.options(ENDPOINT)

    assert response.status_code == 204
    assert "access-control-allow-origin" not in response.headers


def test_cors_is_enabled_by_default_for_cross_origin_clients(client):
    response = client.get("/__mock__/healthz", headers={"Origin": "http://localhost:5173"})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"


def test_missing_asset_is_reported_honestly(client):
    response = client.get("/assets/Assistant-Regular-DVxZuzxb.woff2")

    assert response.status_code == 404
    assert response.json()["error"] == "asset_not_captured"


def test_asset_placeholder_policy_keeps_pages_alive(make_settings):
    with TestClient(create_app(make_settings(asset_miss="placeholder"))) as client:
        response = client.get("/assets/Assistant-Regular-DVxZuzxb.woff2")

    assert response.status_code == 200
    assert response.headers["x-mock-placeholder"] == "true"
    assert response.headers["content-type"] == "font/woff2"


def test_local_assets_are_served_from_disk(client):
    response = client.get("/assets/web/index.html")

    assert response.status_code == 200
    assert b"image-gateway" in response.content


def test_the_landing_page_carries_the_prompt_counter(client):
    """The page served by the catch-all is the one people actually type into.

    The playground at `/playground` is a second, separate page; a counter added
    to only one of them would look like a bug to whoever used the other. Both
    read the same `limits.maxPromptChars` from `/v1/config`, so neither can drift
    from `Settings` on its own.
    """
    response = client.get("/")

    assert response.status_code == 200
    assert 'id="promptCount"' in response.text
    assert "maxPromptChars" in response.text


def test_path_traversal_is_refused_over_http(client):
    response = client.get("/assets/%2e%2e/%2e%2e/%2e%2e/etc/passwd")

    assert b"root:" not in response.content
    assert response.status_code != 500


@pytest.mark.parametrize(
    "bad",
    ["../../etc/passwd", "../secrets.env", "web/../../../etc/hosts", "../../../etc/passwd"],
)
def test_safe_path_refuses_traversal(bad):
    from app.routes.assets import _safe_path

    assert _safe_path(bad) is None


def test_safe_path_allows_files_inside_the_assets_dir():
    from app.routes.assets import _safe_path

    resolved = _safe_path("web/index.html")
    assert resolved is not None and resolved.is_file()


@pytest.mark.parametrize("path", ["/assets/generated/nope.png", "/assets/uploaded/nope.bin"])
def test_unknown_stored_assets_are_404(client, path):
    response = client.get(path)

    assert response.status_code == 404
    assert response.json()["error"] == "unknown_generation"


def test_server_header_is_kestrel(client):
    assert client.get("/__mock__/healthz").headers["server"] == "Kestrel"


def test_every_response_is_marked_as_a_mock(client):
    assert client.get("/__mock__/healthz").headers["x-mock"] == "image-gateway"
    assert client.post(ENDPOINT, json={}).headers["x-mock"] == "image-gateway"
