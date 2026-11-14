"""The prompt box at GET /playground.

Two things are worth testing here and only two: that the page is *reachable*
before you have a token (otherwise you can never enter one), and that it is
*inert* -- a static file, same-origin only, carrying no secret and never relayed.

The page's own behaviour (does the button work?) is not tested here. It is a
single static file with no build step; the meaningful contract is the one the
server controls, which is what this module covers.
"""

from __future__ import annotations

import pathlib

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.routes.gateway import PLAYGROUND

ORIGIN = "https://upstream.example.com"

MANUAL_INDEX = pathlib.Path(__file__).resolve().parent.parent / "docs" / "manual" / "index.html"

#: A path that is not a route, used to prove the SPA catch-all still behaves.
NOT_A_ROUTE = "/definitely-not-a-route"


@pytest.fixture
def playground_file():
    """The page must exist; the route 404s without it, and these tests are about
    the route, so a missing file should fail loudly here rather than as a 404."""
    assert PLAYGROUND.is_file(), f"missing {PLAYGROUND}"
    return PLAYGROUND


# --- it is reachable ------------------------------------------------------
def test_playground_serves_the_page(client):
    response = client.get("/playground")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert 'id="prompt"' in response.text
    assert 'id="go"' in response.text


def test_a_trailing_slash_serves_the_same_page(client):
    """Not a redirect.

    Starlette's `redirect_slashes` only fires when *no* route matches, and the SPA
    catch-all matches `/playground/`. So the trailing-slash form has to be
    registered explicitly or it silently serves the mock landing page instead.
    """
    plain = client.get("/playground")
    slashed = client.get("/playground/")

    assert slashed.status_code == 200
    assert slashed.text == plain.text


def test_the_page_is_loadable_before_you_have_a_token(make_settings):
    """The chicken-and-egg case: the token is typed *into* this page.

    Gating it behind the token would make the gateway unusable from a browser.
    """
    settings = make_settings(upstream=ORIGIN, access_token="s3cret")
    with TestClient(create_app(settings)) as client:
        assert client.get("/playground").status_code == 200
        # ...while the API it talks to still refuses anonymous callers.
        assert client.get("/v1/images").status_code == 401


def test_no_token_is_baked_into_the_html(make_settings):
    settings = make_settings(upstream=ORIGIN, access_token="s3cret-token-value")
    with TestClient(create_app(settings)) as client:
        body = client.get("/playground").text

    assert "s3cret-token-value" not in body
    assert "s3cret" not in body


def test_the_page_does_not_leak_the_device_id(make_settings):
    """The device id is the upstream credential; the page is public."""
    settings = make_settings(upstream=ORIGIN, device_id="web-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    with TestClient(create_app(settings)) as client:
        body = client.get("/playground").text

    assert "web-aaaaaaaa" not in body


# --- it is inert ----------------------------------------------------------
def test_the_page_is_self_contained(client, playground_file):
    """No CDN, no build step, no second origin.

    A remote `<script src>` would put a third party in the path of a page whose
    whole job is to hold a credential, and would break the page offline.
    """
    body = playground_file.read_text(encoding="utf-8")

    assert "<script src" not in body
    assert "<link " not in body or "stylesheet" not in body
    for scheme in ("http://", "https://"):
        assert f'src="{scheme}' not in body
        assert f'href="{scheme}' not in body


def test_the_page_only_calls_this_gateway(client):
    """Every fetch target is a path on this host, so same-origin and no CORS."""
    response = client.get("/playground")
    body = response.text

    assert 'fetch("/v1/images"' in body
    assert 'fetch("/v1/config"' in body
    assert "location.origin" in body


def test_the_prompt_counter_takes_its_limit_from_the_gateway(client):
    """The counter is only honest if the number comes from the server.

    A 4000 baked into the page would silently disagree with
    `IMAGE_GATEWAY_MAX_PROMPT_CHARS` the moment an operator changed it, and the
    person typing would be told the wrong limit at the exact moment it mattered.
    So: the element exists, and the limit is *read*, not written.
    """
    body = client.get("/playground").text

    assert 'id="promptCount"' in body
    assert "maxPromptChars" in body


def test_the_counter_never_invents_a_limit(client):
    """`0` means "no limit", and `||` turns it into a lie.

    This exact mistake shipped three times in one sitting -- the counter fallback,
    the status chip, and the config lookup all coerced a legitimate 0 into 4000 or
    "?" -- so the absence of the pattern is asserted rather than trusted.
    """
    body = client.get("/playground").text

    assert 'maxPromptChars || "?"' not in body
    assert "maxPromptChars || 4000" not in body


def test_the_page_is_never_relayed(make_settings):
    """In relay mode this path must still be answered locally.

    `/playground` is outside `relay_paths`, so forwarding it would be both wrong
    and an open-proxy hole. The origin must see no request at all.
    """
    seen: list[httpx.Request] = []

    def transport_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    settings = make_settings(mode="relay", upstream=ORIGIN)
    app = create_app(settings, relay_transport=httpx.MockTransport(transport_handler))
    with TestClient(app) as client:
        response = client.get("/playground")

    assert response.status_code == 200
    assert 'id="prompt"' in response.text
    assert seen == [], "the prompt box must never be forwarded upstream"


def test_the_page_is_not_relayed_even_when_asked_to_be(make_settings):
    """`X-Mock-Mode: relay` is an explicit per-request opt-in.

    It is honoured for relayable paths, and *rejected* for paths that merely fall
    outside the allowlist (`path_not_relayable`). A page we serve ourselves is
    neither: like `/v1/*`, the directive is meaningless here, so it is ignored
    rather than turned into a 400 or a forward. The origin sees nothing.
    """
    seen: list[httpx.Request] = []

    def transport_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    settings = make_settings(mode="mock", upstream=ORIGIN)
    app = create_app(settings, relay_transport=httpx.MockTransport(transport_handler))
    with TestClient(app) as client:
        response = client.get("/playground", headers={"X-Mock-Mode": "relay"})

    assert response.status_code == 200
    assert 'id="prompt"' in response.text
    assert seen == []


# --- neighbours are unaffected -------------------------------------------
def test_the_spa_catch_all_still_answers_unrelated_get(client):
    """Registering /playground must not have displaced the SPA fallback."""
    response = client.get(NOT_A_ROUTE)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    # Not `id="prompt"`: the SPA fallback is the *captured real page*, and that
    # page has a prompt textarea of its own. Use a marker only our page carries.
    assert "提示词生图" not in response.text


def test_a_post_to_the_page_is_still_a_405(client):
    """The page is GET-only; POST falls through to the observed 405 behaviour."""
    response = client.post("/playground")

    assert response.status_code == 405
    assert response.headers.get("allow") == "GET, HEAD"


# --- the page's own footer link ------------------------------------------
def test_the_manual_is_mounted_and_not_swallowed_by_the_catch_all(client):
    """`/manual/` is served by the static mount, never by the SPA fallback.

    The manual is a generated artifact, so this passes either way -- but it must
    never quietly degrade into the mock landing page, which is what happens if the
    mount is dropped or registered after the catch-all.
    """
    response = client.get("/manual/")

    if MANUAL_INDEX.is_file():
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/html")
    else:
        assert response.status_code == 404
    assert "提示词生图" not in response.text
