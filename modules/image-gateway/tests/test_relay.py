"""Relay (中转) mode.

Nothing here touches the network: an `httpx.MockTransport` is injected as the
outbound leg, so we can assert exactly what would have been sent to the real
origin, and make it fail on demand.

`stub` and `relay_client` share one stub instance (pytest caches fixtures per
test), so a test can request both and inspect what went out.
"""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.upstream import DEVICE_HEADER_LOWER, GENERATE_PATH

UPSTREAM = "https://upstream.example.com"
ENDPOINT = GENERATE_PATH
DEVICE = "web-00000000-0000-0000-0000-000000000000"  # placeholder, not the captured value
JSON_HEADERS = {"Content-Type": "application/json"}


class UpstreamStub:
    """Records every outbound request and replies with whatever you tell it to."""

    def __init__(self, responder=None):
        self.calls: list[httpx.Request] = []
        self.responder = responder or (
            lambda request: httpx.Response(
                200,
                json={"id": "real-1", "aspect": "4:3", "width": 1184, "height": 864},
            )
        )

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        return self.responder(request)

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)


@pytest.fixture
def stub() -> UpstreamStub:
    return UpstreamStub()


@pytest.fixture
def relay_client(make_settings, stub):
    """Relay armed: matching requests go to the (stubbed) real origin."""
    settings = make_settings(mode="relay", upstream=UPSTREAM)
    with TestClient(create_app(settings, relay_transport=stub.transport)) as client:
        yield client


@pytest.fixture
def armed_client(make_settings, stub):
    """Relay configured and reachable, but the global mode is still `mock`."""
    settings = make_settings(mode="mock", upstream=UPSTREAM)
    with TestClient(create_app(settings, relay_transport=stub.transport)) as client:
        yield client


# --- the default is safe ------------------------------------------------
def test_mock_mode_never_calls_the_upstream(armed_client, stub, captured_body, device_headers):
    response = armed_client.post(ENDPOINT, json=captured_body, headers=device_headers)

    assert response.status_code == 200
    assert response.json()["source"] == "captured"  # the local mock answered
    assert stub.calls == []


def test_relay_is_disabled_without_an_upstream(make_settings, captured_body, device_headers):
    settings = make_settings(mode="mock", upstream="")
    with TestClient(create_app(settings)) as client:
        response = client.post(ENDPOINT, json=captured_body, headers=device_headers)

    assert response.status_code == 200
    assert response.json()["source"] == "captured"


# --- relaying -----------------------------------------------------------
def test_relay_forwards_and_returns_the_real_response(relay_client, stub, captured_body, device_headers):
    response = relay_client.post(ENDPOINT, json=captured_body, headers=device_headers)

    assert response.status_code == 200
    assert response.json()["id"] == "real-1"  # upstream bytes, not our reconstruction
    assert response.headers["x-mock-relay"] == "upstream.example.com"
    assert response.headers["x-mock-upstream-status"] == "200"

    assert len(stub.calls) == 1
    outbound = stub.calls[0]
    assert outbound.method == "POST"
    assert str(outbound.url) == f"{UPSTREAM}{ENDPOINT}"
    assert json.loads(outbound.content) == captured_body


def test_relay_preserves_the_query_string(relay_client, stub):
    relay_client.get("/api/v1/media/thing?a=1&b=two")

    assert str(stub.calls[0].url).endswith("/api/v1/media/thing?a=1&b=two")


def test_relay_forwards_the_device_header(relay_client, stub, captured_body, device_headers):
    relay_client.post(ENDPOINT, json=captured_body, headers=device_headers)

    assert stub.calls[0].headers[DEVICE_HEADER_LOWER] == DEVICE


def test_relay_forwards_auth_headers_to_the_real_origin(relay_client, stub, captured_body):
    headers = dict(JSON_HEADERS, Authorization="Bearer real-token")
    relay_client.post(ENDPOINT, json=captured_body, headers=headers)

    assert stub.calls[0].headers["authorization"] == "Bearer real-token"


def test_relay_strips_mock_only_headers(relay_client, stub, captured_body, device_headers):
    headers = dict(
        device_headers,
        **{"X-Mock-Style": "url", "X-Mock-Variant": "placeholder", "X-Mock-Delay": "0"},
    )
    relay_client.post(ENDPOINT, json=captured_body, headers=headers)

    sent = stub.calls[0].headers
    assert not [name for name in sent if name.lower().startswith("x-mock-")]


def test_relay_does_not_send_a_stale_content_length(relay_client, stub, captured_body, device_headers):
    relay_client.post(ENDPOINT, json=captured_body, headers=device_headers)

    outbound = stub.calls[0]
    assert int(outbound.headers["content-length"]) == len(outbound.content)


# --- per-request override ----------------------------------------------
def test_one_request_can_be_relayed_while_mock_mode_is_on(armed_client, stub, captured_body, device_headers):
    headers = dict(device_headers, **{"X-Mock-Mode": "relay"})
    response = armed_client.post(ENDPOINT, json=captured_body, headers=headers)

    assert response.status_code == 200
    assert response.json()["id"] == "real-1"
    assert len(stub.calls) == 1


def test_one_request_can_be_mocked_while_relay_mode_is_on(relay_client, stub, captured_body, device_headers):
    headers = dict(device_headers, **{"X-Mock-Mode": "mock"})
    response = relay_client.post(ENDPOINT, json=captured_body, headers=headers)

    assert response.status_code == 200
    assert response.json()["source"] == "captured"
    assert stub.calls == []


def test_bad_mode_directive_is_rejected(relay_client, captured_body, device_headers):
    headers = dict(device_headers, **{"X-Mock-Mode": "yaml"})
    response = relay_client.post(ENDPOINT, json=captured_body, headers=headers)

    assert response.status_code == 400
    assert response.json()["error"] == "bad_mode_directive"


# --- the allowlist is not optional --------------------------------------
def test_paths_outside_the_allowlist_are_not_relayed(relay_client, stub):
    response = relay_client.get("/some/deep/link")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")  # SPA fallback
    assert stub.calls == []


def test_explicitly_relaying_a_disallowed_path_is_an_error(relay_client, stub):
    response = relay_client.get("/not/relayable", headers={"X-Mock-Mode": "relay"})

    assert response.status_code == 400
    assert response.json()["error"] == "path_not_relayable"
    assert stub.calls == []


def test_the_control_plane_is_never_relayed(relay_client, stub):
    response = relay_client.get("/__mock__/state")

    assert response.status_code == 200
    settings = response.json()["settings"]
    assert settings["mode"] == "relay"  # relay is armed...
    assert settings["upstream"] == UPSTREAM
    assert stub.calls == []  # ...but the control plane stayed local


def test_assets_are_relayable(relay_client, stub):
    relay_client.get("/assets/Assistant-Regular-DVxZuzxb.woff2")

    assert str(stub.calls[0].url).endswith("/assets/Assistant-Regular-DVxZuzxb.woff2")


def test_relay_paths_can_be_narrowed_at_runtime(relay_client, stub):
    relay_client.post("/__mock__/config", json={"relay_paths": ["/api/v1/media/"]})

    assert relay_client.get("/assets/x.woff2").status_code == 404  # back to mock policy
    assert stub.calls == []


# --- upstream failures --------------------------------------------------
def test_upstream_error_status_is_passed_through(make_settings, stub, captured_body, device_headers):
    stub.responder = lambda request: httpx.Response(429, json={"error": "real_rate_limit"})
    settings = make_settings(mode="relay", upstream=UPSTREAM)

    with TestClient(create_app(settings, relay_transport=stub.transport)) as client:
        response = client.post(ENDPOINT, json=captured_body, headers=device_headers)

    assert response.status_code == 429
    assert response.json() == {"error": "real_rate_limit"}  # the real envelope, untouched


def test_upstream_timeout_becomes_504(make_settings, captured_body, device_headers):
    def timeout(request):
        raise httpx.ReadTimeout("too slow", request=request)

    settings = make_settings(mode="relay", upstream=UPSTREAM)
    with TestClient(create_app(settings, relay_transport=httpx.MockTransport(timeout))) as client:
        response = client.post(ENDPOINT, json=captured_body, headers=device_headers)

    assert response.status_code == 504
    assert response.json() == {"error": "upstream_timeout"}
    assert "too slow" not in response.text


def test_connection_failure_becomes_502_without_leaking(make_settings, captured_body, device_headers):
    def refuse(request):
        raise httpx.ConnectError("dial tcp 10.0.0.5:443: connection refused", request=request)

    settings = make_settings(mode="relay", upstream=UPSTREAM)
    with TestClient(create_app(settings, relay_transport=httpx.MockTransport(refuse))) as client:
        response = client.post(ENDPOINT, json=captured_body, headers=device_headers)

    assert response.status_code == 502
    assert response.json() == {"error": "upstream_error"}
    assert "10.0.0.5" not in response.text


def test_binary_responses_survive_the_relay_byte_for_byte(make_settings):
    """A relay that mangles bytes is worse than no relay."""
    payload = bytes(range(256)) * 40
    settings = make_settings(mode="relay", upstream=UPSTREAM)
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, content=payload, headers={"content-type": "image/png"})
    )

    with TestClient(create_app(settings, relay_transport=transport)) as client:
        response = client.get("/api/v1/media/whatever")

    assert response.status_code == 200
    assert response.content == payload
    assert response.headers["content-type"] == "image/png"


def test_a_gzipped_upstream_response_is_not_double_encoded(make_settings):
    """httpx decodes the body, so content-encoding must not be passed through."""
    import gzip

    payload = json.dumps({"id": "gz"}).encode()
    settings = make_settings(mode="relay", upstream=UPSTREAM)
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            content=gzip.compress(payload),
            headers={"content-type": "application/json", "content-encoding": "gzip"},
        )
    )

    with TestClient(create_app(settings, relay_transport=transport)) as client:
        response = client.get("/api/v1/media/x")

    assert response.json() == {"id": "gz"}
    assert "content-encoding" not in response.headers


def test_upstream_headers_do_not_duplicate_the_servers_own(make_settings, captured_body):
    """Forwarding upstream's `date`/`server` as well puts two of each on the wire."""
    settings = make_settings(mode="relay", upstream=UPSTREAM)
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={"ok": True},
            headers={
                "content-type": "application/json",
                "date": "Mon, 01 Jan 2001 00:00:00 GMT",
                "server": "Kestrel",
                "x-real-upstream-header": "kept",
            },
        )
    )

    with TestClient(create_app(settings, relay_transport=transport)) as client:
        response = client.get("/api/v1/media/x")

    # Upstream's `date` is dropped; the ASGI server adds its own, so at most one.
    assert len(response.headers.get_list("date")) <= 1
    assert response.headers.get_list("server") == ["Kestrel"]  # ours, not upstream's
    assert response.headers["x-real-upstream-header"] == "kept"  # only the noisy ones go


# --- observability ------------------------------------------------------
def test_relayed_calls_are_logged_with_the_upstream_status(relay_client, captured_body, device_headers):
    relay_client.post(ENDPOINT, json=captured_body, headers=device_headers)

    record = relay_client.get("/__mock__/requests").json()["records"][0]

    assert record["kind"] == "relay"
    assert record["upstream"] == "upstream.example.com"
    assert record["upstreamStatus"] == 200
    assert record["upstreamUrl"].startswith(UPSTREAM)


def test_relay_status_endpoint_is_explicit_about_the_risk(relay_client):
    status = relay_client.get("/__mock__/relay").json()

    assert status["enabled"] is True
    assert status["mode"] == "relay"
    assert status["upstream"] == UPSTREAM
    assert "real origin" in status["warning"]


def test_relay_status_is_quiet_when_mock_mode_is_on(armed_client):
    status = armed_client.get("/__mock__/relay").json()

    assert status["enabled"] is True  # configured...
    assert status["mode"] == "mock"  # ...but not armed
    assert status["warning"] is None


def test_injected_relay_headers_are_never_readable_over_http(make_settings, stub):
    settings = make_settings(
        mode="relay", upstream=UPSTREAM, relay_headers={"Authorization": "Bearer super-secret"}
    )
    with TestClient(create_app(settings, relay_transport=stub.transport)) as client:
        state = client.get("/__mock__/state").json()
        status = client.get("/__mock__/relay").json()
        client.get("/api/v1/media/x")

    assert state["settings"]["relay_headers"] == {"Authorization": "***"}
    assert "super-secret" not in json.dumps(state)
    assert "super-secret" not in json.dumps(status)
    # ...but it IS sent upstream, which is the entire point
    assert stub.calls[0].headers["authorization"] == "Bearer super-secret"


def test_relay_headers_cannot_be_set_through_the_config_api(relay_client):
    response = relay_client.post(
        "/__mock__/config", json={"relay_headers": {"Authorization": "Bearer injected"}}
    )

    assert response.status_code == 400


def test_mode_can_be_switched_at_runtime(armed_client, stub, captured_body, device_headers):
    first = armed_client.post(ENDPOINT, json=captured_body, headers=device_headers)
    assert first.json()["source"] == "captured"

    armed_client.post("/__mock__/config", json={"mode": "relay"})
    relayed = armed_client.post(ENDPOINT, json=captured_body, headers=device_headers)

    assert relayed.json()["id"] == "real-1"
    assert len(stub.calls) == 1
