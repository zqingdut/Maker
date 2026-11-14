"""The 中转站: auth, gating, the wrapped flow, and the bytes it hands back.

Everything here runs against a scripted stand-in for upstream.example.com injected as
the httpx transport, so no test touches the network -- and none of them can spend
money. Unlike the rest of the suite these *do* write to disk, because storing the
image is the feature under test; they write into pytest's own temp directory.
"""

from __future__ import annotations

import base64
import contextlib
import json
import socket
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.upstream import DEVICE_HEADER, DEVICE_HEADER_LOWER

ORIGIN = "https://upstream.example.com"

#: Stand-ins for real device ids. The captured value is a credential belonging to
#: whoever took the capture, so the committed tree carries placeholders instead --
#: and deliberately *two* of them, because using one value on both sides would
#: make `test_gateway_replaces_the_client_device_id` pass without proving anything.
DEVICE = "web-00000000-0000-0000-0000-000000000000"  # the gateway's own
CLIENT_DEVICE = "web-11111111-1111-1111-1111-111111111111"  # what a client sends

#: Minimal but structurally valid images -- enough for magic-byte sniffing.
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x00" * 64
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 64

PROMPT = "a lighthouse at dusk, long exposure"


def data_url(payload: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64," + base64.b64encode(payload).decode("ascii")


def ok_payload(**extra) -> dict:
    """The shape the origin is believed to answer with (reconstructed)."""
    payload = {
        "id": "img_5f3a1c",
        "mode": "image",
        "aspect": "4:3",
        "width": 1184,
        "height": 864,
        "image": data_url(PNG),
    }
    payload.update(extra)
    return payload


def generate_body(**extra) -> dict:
    body = {"mode": "image", "prompt": PROMPT, "aspect": "4:3"}
    body.update(extra)
    return body


class Origin:
    """A scriptable stand-in for the real service.

    Records every request it is handed, so a test can assert not just what came
    back but what actually went out -- which is how the credential-leak tests
    work.
    """

    def __init__(self, responder=None, salt: str = ""):
        self.salt = salt
        self.requests: list[httpx.Request] = []
        self.responder = responder or self.happy

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.responder(request)

    @property
    def count(self) -> int:
        return len(self.requests)

    @property
    def paths(self) -> list[str]:
        return [r.url.path for r in self.requests]

    def happy(self, request: httpx.Request) -> httpx.Response:
        # Salted with a value unique to this run: storage is content-addressed, so
        # unsalted bytes would already be on disk from a previous run and `cached`
        # would read true where the test expects false.
        return httpx.Response(200, json=ok_payload(image=data_url(PNG + self.salt.encode())))


class Harness:
    def __init__(self, app, origin: Origin, settings: Settings, client: TestClient):
        self.app = app
        self.origin = origin
        self.settings = settings
        self.client = client

    @property
    def ctx(self):
        return self.app.state.ctx

    @property
    def png(self) -> bytes:
        """The bytes the default origin hands back -- salted per run."""
        return PNG + self.origin.salt.encode()


@pytest.fixture
def harness(make_settings, work_dir):
    """Build a gateway wired to a scripted origin, and tear it down afterwards."""
    with contextlib.ExitStack() as stack:

        def _build(responder=None, salt=None, **overrides) -> Harness:
            origin = Origin(responder, salt=salt or uuid.uuid4().hex)
            base = dict(
                upstream=ORIGIN,
                files_dir=str(work_dir / "files"),
                gateway_enabled=True,
                device_id=DEVICE,
            )
            base.update(overrides)
            settings = make_settings(**base)
            app = create_app(settings, relay_transport=httpx.MockTransport(origin))
            client = stack.enter_context(TestClient(app))
            return Harness(app, origin, settings, client)

        yield _build


# --- access control ------------------------------------------------------
def test_open_gateway_needs_no_token(harness):
    h = harness()
    assert h.client.post("/v1/images", json=generate_body()).status_code == 200


def test_missing_token_is_rejected(harness):
    h = harness(access_token="s3cret")
    response = h.client.post("/v1/images", json=generate_body())

    assert response.status_code == 401
    assert response.json() == {"error": "missing_token"}
    assert h.origin.count == 0, "an unauthenticated call must not reach the origin"


def test_wrong_token_is_rejected(harness):
    h = harness(access_token="s3cret")
    response = h.client.post(
        "/v1/images", json=generate_body(), headers={"X-Relay-Token": "guess"}
    )

    assert response.status_code == 401
    assert response.json() == {"error": "invalid_token"}
    assert h.origin.count == 0


@pytest.mark.parametrize(
    "header",
    [
        {"X-Relay-Token": "s3cret"},
        {"Authorization": "Bearer s3cret"},
        {"Authorization": "bearer s3cret"},  # scheme is case-insensitive
    ],
)
def test_both_token_schemes_are_accepted(harness, header):
    h = harness(access_token="s3cret")
    response = h.client.post("/v1/images", json=generate_body(), headers=header)

    assert response.status_code == 200, response.text


def test_gateway_token_is_never_forwarded_upstream(harness):
    """The credential authenticates the client to *us*; the origin must not see it."""
    h = harness(access_token="s3cret")
    h.client.post(
        "/v1/images",
        json=generate_body(),
        headers={"X-Relay-Token": "s3cret", "Authorization": "Bearer s3cret"},
    )

    sent = h.origin.requests[0].headers
    assert "x-relay-token" not in sent
    assert "authorization" not in sent


def test_clients_own_authorization_is_forwarded_when_it_is_not_our_token(harness):
    """With no token configured, an Authorization header is the client's own."""
    h = harness()
    h.client.post(
        "/v1/images", json=generate_body(), headers={"Authorization": "Bearer upstream-key"}
    )

    assert h.origin.requests[0].headers["authorization"] == "Bearer upstream-key"


def test_gateway_replaces_the_client_device_id(harness):
    h = harness()
    h.client.post(
        "/v1/images",
        json=generate_body(),
        headers={DEVICE_HEADER: CLIENT_DEVICE},
    )

    assert h.origin.requests[0].headers[DEVICE_HEADER_LOWER] == h.settings.device_id
    assert h.settings.device_id != CLIENT_DEVICE


def test_device_override_can_be_turned_off(harness):
    h = harness(override_device=False)
    h.client.post("/v1/images", json=generate_body(), headers={DEVICE_HEADER: CLIENT_DEVICE})

    assert h.origin.requests[0].headers[DEVICE_HEADER_LOWER] == CLIENT_DEVICE


def test_override_with_no_device_id_passes_the_client_header_through(harness):
    """`override_device` with nothing to override with must not mean "delete".

    The shipped default for `device_id` is empty (the captured value is a
    credential, so it is not committed). If the drop were keyed on
    `override_device` alone, that default would strip the client's header and
    inject nothing -- sending the origin a request with no device at all.
    """
    h = harness(device_id="")
    h.client.post("/v1/images", json=generate_body(), headers={DEVICE_HEADER: CLIENT_DEVICE})

    assert h.origin.requests[0].headers[DEVICE_HEADER_LOWER] == CLIENT_DEVICE


# --- rate limiting -------------------------------------------------------
def test_rate_limit_returns_429_with_retry_after(harness):
    h = harness(rate_limit_per_minute=2)

    assert h.client.post("/v1/images", json=generate_body()).status_code == 200
    assert h.client.post("/v1/images", json=generate_body()).status_code == 200

    blocked = h.client.post("/v1/images", json=generate_body())
    assert blocked.status_code == 429
    assert blocked.json() == {"error": "rate_limited"}
    assert int(blocked.headers["retry-after"]) >= 1
    assert h.origin.count == 2, "a rate-limited call must not reach the origin"


def test_rate_limit_is_off_by_default(harness):
    h = harness()
    for _ in range(5):
        assert h.client.post("/v1/images", json=generate_body()).status_code == 200


def test_rate_limit_keys_on_the_credential(harness):
    """One shared token is one budget, and the token itself is never stored."""
    h = harness(rate_limit_per_minute=1, access_token="s3cret")
    auth = {"X-Relay-Token": "s3cret"}

    assert h.client.post("/v1/images", json=generate_body(), headers=auth).status_code == 200
    assert h.client.post("/v1/images", json=generate_body(), headers=auth).status_code == 429

    assert h.ctx.rate_limiter.snapshot()["trackedCallers"] == 1
    keys = list(h.ctx.rate_limiter._hits)
    assert keys and all(key.startswith("tok:") for key in keys)
    assert "s3cret" not in "".join(keys)


def test_rate_limit_falls_back_to_the_address_without_a_credential(harness):
    h = harness(rate_limit_per_minute=1)

    assert h.client.post("/v1/images", json=generate_body()).status_code == 200
    assert h.client.post("/v1/images", json=generate_body()).status_code == 429
    assert list(h.ctx.rate_limiter._hits)[0].startswith("ip:")


def test_read_only_endpoints_are_not_rate_limited(harness):
    """The limiter exists to protect the upstream bill, not to throttle reads."""
    h = harness(rate_limit_per_minute=1, access_token="s3cret")
    auth = {"X-Relay-Token": "s3cret"}
    h.client.post("/v1/images", json=generate_body(), headers=auth)

    for _ in range(3):
        assert h.client.get("/v1/images", headers=auth).status_code == 200


def test_a_locally_rejected_request_does_not_spend_rate_limit_budget(harness):
    """A bad payload costs the origin nothing, so it must not cost budget either."""
    h = harness(rate_limit_per_minute=1)

    for _ in range(5):
        assert h.client.post("/v1/images", json={}).status_code == 400

    assert h.ctx.rate_limiter.snapshot()["trackedCallers"] == 0
    assert h.client.post("/v1/images", json=generate_body()).status_code == 200


# --- concurrency gate ----------------------------------------------------
def test_concurrency_limit_answers_503(harness):
    import asyncio

    h = harness(queue_timeout_s=0.05)
    # Nothing can be acquired, so the very first caller queues and times out.
    h.ctx.upstream_semaphore = asyncio.Semaphore(0)

    response = h.client.post("/v1/images", json=generate_body())

    assert response.status_code == 503
    assert response.json() == {"error": "upstream_busy"}
    assert h.origin.count == 0


def test_semaphore_is_released_when_the_upstream_call_fails(harness):
    """A leaked permit would deadlock the gateway after one bad call."""
    calls = {"n": 0}

    def flaky(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(400, json={"error": "bad_mode"})
        return httpx.Response(200, json=ok_payload())

    h = harness(flaky, max_concurrent_upstream=1)

    assert h.client.post("/v1/images", json=generate_body()).status_code == 400
    # With one permit and a leak, this second call would answer 503.
    assert h.client.post("/v1/images", json=generate_body()).status_code == 200


# --- the wrapped flow ----------------------------------------------------
def test_generate_returns_a_short_url_not_a_base64_blob(harness):
    h = harness()
    response = h.client.post("/v1/images", json=generate_body())
    payload = response.json()

    assert response.status_code == 200
    assert payload["url"].startswith("http://testserver/files/")
    assert payload["path"].startswith("/files/")
    assert payload["mimeType"] == "image/png"
    assert payload["cached"] is False
    assert payload["prompt"] == PROMPT
    assert payload["width"] == 1184 and payload["height"] == 864

    # The whole point: the 2.9MB inline blob must not be in the response.
    assert "base64" not in response.text
    assert len(response.content) < 2000


def test_the_short_url_actually_serves_the_image(harness):
    h = harness()
    payload = h.client.post("/v1/images", json=generate_body()).json()

    served = h.client.get(payload["path"])

    assert served.status_code == 200
    assert served.content == h.png
    assert served.headers["content-type"] == "image/png"


def test_response_headers_describe_what_happened(harness):
    h = harness()
    response = h.client.post("/v1/images", json=generate_body())

    assert response.headers["x-relay-cache"] == "miss"
    assert response.headers["x-relay-upstream"] == "upstream.example.com"
    assert response.headers["x-relay-upstream-status"] == "200"
    assert response.headers["location"].endswith(".png")
    assert response.headers["x-relay-id"] == response.json()["id"]


def test_metadata_endpoint_round_trips(harness):
    h = harness()
    created = h.client.post("/v1/images", json=generate_body()).json()

    fetched = h.client.get(f"/v1/images/{created['id']}")

    assert fetched.status_code == 200
    # `cached` describes the creation event, not the stored image, so it is not
    # part of the resource and does not appear on a later read.
    assert {key: value for key, value in created.items() if key != "cached"} == fetched.json()


def test_listing_returns_newest_first(harness):
    salt = uuid.uuid4().hex
    h = harness(by_prompt(salt), salt=salt)
    before = h.ctx.filestore.stats()["files"]

    first = h.client.post("/v1/images", json=generate_body(prompt="one")).json()
    second = h.client.post("/v1/images", json=generate_body(prompt="two")).json()

    listing = h.client.get("/v1/images").json()
    ids = [item["id"] for item in listing["items"]]

    assert ids.index(second["id"]) < ids.index(first["id"]), "newest must come first"
    # A delta, not an absolute: the scratch directory is reused between runs and
    # nothing is ever deleted, so only the change is ours to assert.
    assert h.ctx.filestore.stats()["files"] == before + 2


def by_prompt(salt: str):
    """Different prompts must yield different bytes, or content addressing
    collapses them into one stored file and there is nothing to order."""

    def responder(request: httpx.Request) -> httpx.Response:
        prompt = json.loads(request.content or b"{}").get("prompt", "")
        payload = PNG + salt.encode("utf-8") + prompt.encode("utf-8")
        return httpx.Response(200, json=ok_payload(image=data_url(payload)))

    return responder


def test_unknown_id_is_404(harness):
    h = harness()
    response = h.client.get("/v1/images/00000000000000000000000000000000")

    assert response.status_code == 404
    assert response.json() == {"error": "not_found"}


# --- storage dedup -------------------------------------------------------
def test_identical_images_collapse_to_one_file(harness):
    h = harness()
    before = h.ctx.filestore.stats()["files"]

    first = h.client.post("/v1/images", json=generate_body()).json()
    second = h.client.post("/v1/images", json=generate_body()).json()

    assert first["id"] == second["id"]
    assert first["cached"] is False
    assert second["cached"] is True
    assert h.ctx.filestore.stats()["files"] == before + 1


def test_dedup_is_about_storage_not_about_skipping_the_call(harness):
    """We cannot know the image before generating it, and the origin is not
    deterministic, so both calls must go out. `cached` never means "free"."""
    h = harness()
    h.client.post("/v1/images", json=generate_body())
    h.client.post("/v1/images", json=generate_body())

    assert h.origin.count == 2


# --- upstream failures ---------------------------------------------------
def test_upstream_4xx_status_and_code_survive(harness):
    h = harness(lambda request: httpx.Response(400, json={"error": "bad_mode"}))
    response = h.client.post("/v1/images", json=generate_body())

    assert response.status_code == 400
    assert response.json() == {"error": "bad_mode"}


def test_upstream_5xx_is_passed_through(harness):
    h = harness(lambda request: httpx.Response(503, json={"error": "upstream_overloaded"}))
    response = h.client.post("/v1/images", json=generate_body())

    assert response.status_code == 503
    assert response.json() == {"error": "upstream_overloaded"}


def test_a_relayed_error_says_so_in_the_header_and_the_log(harness):
    """A 400 we produced and a 400 the origin produced must be tellable apart."""
    h = harness(lambda request: httpx.Response(400, json={"error": "bad_mode"}))
    response = h.client.post("/v1/images", json=generate_body())

    assert response.headers["x-mock-error-note"] == "relayed from upstream"

    record = h.client.get("/__mock__/requests").json()["records"][-1]
    assert record["kind"] == "gateway"
    assert record["upstreamStatus"] == 400
    assert record["relayed"] is True


def test_a_locally_rejected_request_is_not_recorded_as_relayed(harness):
    h = harness()
    h.client.post("/v1/images", json={})

    record = h.client.get("/__mock__/requests").json()["records"][-1]

    assert record["kind"] == "gateway"
    assert record.get("relayed") is None
    assert record.get("upstreamStatus") is None


def test_connect_failure_becomes_502(harness):
    def refuse(request):
        raise httpx.ConnectError("connection refused")

    h = harness(refuse)
    response = h.client.post("/v1/images", json=generate_body())

    assert response.status_code == 502
    assert response.json() == {"error": "upstream_error"}


def test_a_dns_failure_is_named_in_the_note(harness):
    """502 alone cannot distinguish a placeholder host from an outage.

    The body has to stay the flat `{"error": ...}` envelope -- that shape is the
    gateway's contract -- so the reason travels in `X-Mock-Error-Note`, which
    both pages already render.
    """

    def unresolvable(request):
        raise httpx.ConnectError("[Errno -2] Name or service not known") from socket.gaierror(
            -2, "Name or service not known"
        )

    h = harness(unresolvable)
    response = h.client.post("/v1/images", json=generate_body())

    assert response.status_code == 502
    assert response.json() == {"error": "upstream_error"}, "the envelope must not grow a field"
    assert "DNS" in response.headers["x-mock-error-note"]


def test_a_refused_connection_is_named_in_the_note(harness):
    def refused(request):
        raise httpx.ConnectError("[Errno 61] Connection refused") from ConnectionRefusedError(61, "refused")

    h = harness(refused)
    response = h.client.post("/v1/images", json=generate_body())

    assert "refused" in response.headers["x-mock-error-note"]


def test_a_proxy_failure_points_at_the_proxy_settings(harness):
    """`relay_trust_env` is True by default, so HTTP_PROXY in the service
    environment silently takes over every paid call. The note has to say so --
    otherwise a stray proxy looks exactly like the origin being down."""

    def proxied(request):
        raise httpx.ProxyError("502 Bad Gateway from proxy")

    h = harness(proxied)
    response = h.client.post("/v1/images", json=generate_body())

    assert "proxy" in response.headers["x-mock-error-note"]
    assert "RELAY_TRUST_ENV" in response.headers["x-mock-error-note"]


def test_a_proxy_in_the_environment_is_named_at_startup(make_settings, monkeypatch, caplog):
    """The same trap, caught before the first request instead of after it.

    Only the variable *name* is logged: a proxy URL can carry credentials.
    """
    from app.main import _warn_about_proxy_env

    monkeypatch.setenv("HTTPS_PROXY", "http://user:secret@127.0.0.1:9")
    with caplog.at_level("WARNING", logger="image-gateway"):
        _warn_about_proxy_env(make_settings())

    logged = " ".join(r.getMessage() for r in caplog.records)
    assert "HTTPS_PROXY" in logged
    assert "secret" not in logged, "the proxy URL can carry credentials"


def test_no_proxy_warning_when_the_environment_is_ignored(make_settings, monkeypatch, caplog):
    from app.main import _warn_about_proxy_env

    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9")
    with caplog.at_level("WARNING", logger="image-gateway"):
        _warn_about_proxy_env(make_settings(relay_trust_env=False))

    assert not [r for r in caplog.records if "proxy" in r.getMessage()]


def test_the_note_does_not_carry_the_upstream_host(harness):
    """httpx puts the request URL in its exception text; the note must not.

    A caller with a token can read `/v1/config` anyway, but an error message is
    the wrong place to discover where the gateway forwards to -- and it is the
    easiest place to leak it by accident.
    """

    def leaky(request):
        raise httpx.ConnectError("https://secret-origin.invalid/api/v1/media/ai/image failed")

    h = harness(leaky)
    response = h.client.post("/v1/images", json=generate_body())

    note = response.headers["x-mock-error-note"]
    assert "secret-origin" not in note
    assert "http" not in note


def test_read_timeout_is_never_retried_because_it_may_already_be_billed(harness):
    """A paid generation that timed out mid-flight may have produced an image."""

    def slow(request):
        raise httpx.ReadTimeout("too slow")

    h = harness(slow, relay_retries=3)
    response = h.client.post("/v1/images", json=generate_body())

    assert response.status_code == 504
    assert response.json() == {"error": "upstream_timeout"}
    assert h.origin.count == 1, "retrying a possibly-billed call would bill twice"


def test_connect_failures_are_retried_when_configured(harness):
    def refuse(request):
        raise httpx.ConnectError("connection refused")

    h = harness(refuse, relay_retries=2)
    response = h.client.post("/v1/images", json=generate_body())

    assert response.status_code == 502
    assert h.origin.count == 3, "1 attempt + 2 retries"


def test_connect_failures_are_not_retried_by_default(harness):
    def refuse(request):
        raise httpx.ConnectError("connection refused")

    h = harness(refuse)
    h.client.post("/v1/images", json=generate_body())

    assert h.origin.count == 1


# --- finding the image ---------------------------------------------------
def test_image_can_arrive_as_a_remote_url(harness):
    def url_style(request):
        if request.url.path == "/api/v1/media/ai/image":
            return httpx.Response(200, json={"url": f"{ORIGIN}/cdn/result.png"})
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

    h = harness(url_style)
    payload = h.client.post("/v1/images", json=generate_body()).json()

    assert payload["upstream"]["sourceField"] == "url"
    assert h.origin.paths == ["/api/v1/media/ai/image", "/cdn/result.png"]
    assert h.client.get(payload["path"]).content == PNG


def test_a_foreign_image_url_is_refused(harness):
    """SSRF guard: we fetch back only from the origin we already talk to."""

    def hostile(request):
        return httpx.Response(200, json={"url": "https://evil.example.com/steal.png"})

    h = harness(hostile)
    response = h.client.post("/v1/images", json=generate_body())

    assert response.status_code == 502
    assert response.json() == {"error": "upstream_bad_image_url"}
    assert h.origin.count == 1, "the foreign URL must never be fetched"


def test_image_can_arrive_as_a_raw_binary_body(harness):
    def binary(request):
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

    h = harness(binary)
    payload = h.client.post("/v1/images", json=generate_body()).json()

    assert payload["upstream"]["sourceField"] == "<binary body>"
    assert h.client.get(payload["path"]).content == PNG


def test_openai_style_b64_json_is_understood(harness):
    def openai(request):
        return httpx.Response(
            200,
            json={"created": 1, "data": [{"b64_json": base64.b64encode(PNG).decode("ascii")}]},
        )

    h = harness(openai)
    payload = h.client.post("/v1/images", json=generate_body()).json()

    assert payload["upstream"]["sourceField"] == "data[0].b64_json"
    assert h.client.get(payload["path"]).content == PNG


def test_a_long_bare_base64_in_a_generic_field_is_decoded(harness):
    """`image` is ambiguous, so a bare blob there must be long enough to believe."""
    big = PNG + b"\x00" * 512
    h = harness(lambda request: httpx.Response(200, json=ok_payload(image=base64.b64encode(big).decode("ascii"))))
    payload = h.client.post("/v1/images", json=generate_body()).json()

    assert payload["upstream"]["sourceField"] == "image"
    assert h.client.get(payload["path"]).content == big


def test_a_short_bare_string_in_a_generic_field_is_not_treated_as_base64(harness):
    h = harness(lambda request: httpx.Response(200, json={"image": "img_5f3a1c"}))
    response = h.client.post("/v1/images", json=generate_body())

    assert response.status_code == 502
    assert response.json() == {"error": "upstream_no_image"}


def test_a_response_with_no_image_is_an_error(harness):
    h = harness(lambda request: httpx.Response(200, json={"status": "queued"}))
    response = h.client.post("/v1/images", json=generate_body())

    assert response.status_code == 502
    assert response.json() == {"error": "upstream_no_image"}


def test_non_image_bytes_are_refused(harness):
    def html(request):
        return httpx.Response(200, content=b"<html>nope</html>", headers={"content-type": "text/html"})

    h = harness(html)
    response = h.client.post("/v1/images", json=generate_body())

    assert response.status_code == 502
    assert response.json() == {"error": "upstream_no_image"}


def test_magic_bytes_win_over_the_declared_mime(harness):
    """An origin that says PNG and sends a JPEG must not be believed."""
    h = harness(lambda request: httpx.Response(200, json=ok_payload(image=data_url(JPEG, "image/png"))))
    payload = h.client.post("/v1/images", json=generate_body()).json()

    assert payload["mimeType"] == "image/jpeg"
    assert payload["path"].endswith(".jpg")


def test_a_fake_image_that_is_not_an_image_is_refused(harness):
    h = harness(lambda request: httpx.Response(200, json=ok_payload(image=data_url(b"not an image"))))
    response = h.client.post("/v1/images", json=generate_body())

    assert response.status_code == 502
    assert response.json() == {"error": "upstream_bad_image"}


# --- local validation ----------------------------------------------------
def test_missing_mode_is_rejected_without_calling_the_origin(harness):
    h = harness()
    response = h.client.post("/v1/images", json={})

    assert response.status_code == 400
    assert response.json() == {"error": "bad_mode"}
    assert h.origin.count == 0


def test_empty_prompt_is_rejected_without_calling_the_origin(harness):
    h = harness()
    response = h.client.post("/v1/images", json={"mode": "image", "prompt": "   "})

    assert response.status_code == 400
    assert response.json() == {"error": "empty_prompt"}
    assert h.origin.count == 0


def test_an_aspect_we_do_not_know_is_left_to_the_origin(harness):
    """Our size table is a local guess; rejecting on it would fake a failure."""
    h = harness()
    response = h.client.post("/v1/images", json=generate_body(aspect="7:5"))

    assert response.status_code == 200
    assert h.origin.count == 1
    assert json.loads(h.origin.requests[0].content)["aspect"] == "7:5"


def test_an_over_long_prompt_is_cut_before_it_is_forwarded(harness):
    """Truncation has to happen *before* the upstream call, not after.

    Two reasons: the origin charges for the prompt it actually reads, so sending
    text it would reject is money spent for nothing; and the stored metadata must
    describe the prompt that produced the image, not the one the caller typed.
    """
    h = harness(max_prompt_chars=10)
    response = h.client.post("/v1/images", json=generate_body(prompt="x" * 40))

    assert response.status_code == 200
    assert json.loads(h.origin.requests[0].content)["prompt"] == "x" * 10
    assert response.headers["x-prompt-truncated"] == "true"
    assert response.json()["promptTruncated"] is True
    assert response.json()["prompt"] == "x" * 10


def test_an_in_range_prompt_carries_no_truncation_flag(harness):
    h = harness(max_prompt_chars=100)
    response = h.client.post("/v1/images", json=generate_body(prompt="x" * 40))

    assert "x-prompt-truncated" not in response.headers
    assert "promptTruncated" not in response.json()
    assert json.loads(h.origin.requests[0].content)["prompt"] == "x" * 40


def test_truncation_can_be_switched_off_in_favour_of_a_hard_failure(harness):
    h = harness(max_prompt_chars=10, prompt_overflow="reject")
    response = h.client.post("/v1/images", json=generate_body(prompt="x" * 40))

    assert response.status_code == 400
    assert response.json() == {"error": "prompt_too_long"}
    assert h.origin.count == 0


def test_local_validation_can_be_turned_off(harness):
    h = harness(gateway_validate=False)
    response = h.client.post("/v1/images", json={})

    # The origin is now the only judge -- and in this stub it says yes.
    assert response.status_code == 200
    assert h.origin.count == 1


def test_a_non_json_body_is_rejected(harness):
    h = harness()
    response = h.client.post(
        "/v1/images", content=b"definitely not json", headers={"content-type": "application/json"}
    )

    assert response.status_code == 400
    assert response.json() == {"error": "bad_body"}
    assert h.origin.count == 0


def test_the_prompt_is_forwarded_verbatim(harness):
    h = harness()
    h.client.post("/v1/images", json=generate_body())

    assert json.loads(h.origin.requests[0].content)["prompt"] == PROMPT


# --- serving files -------------------------------------------------------
def test_file_headers_make_the_url_immutable(harness):
    h = harness()
    path = h.client.post("/v1/images", json=generate_body()).json()["path"]

    response = h.client.get(path)

    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert response.headers["etag"].startswith('"')
    assert "last-modified" in response.headers
    assert response.headers["accept-ranges"] == "bytes"


def test_if_none_match_returns_304(harness):
    h = harness()
    path = h.client.post("/v1/images", json=generate_body()).json()["path"]
    etag = h.client.get(path).headers["etag"]

    response = h.client.get(path, headers={"If-None-Match": etag})

    assert response.status_code == 304
    assert response.content == b""
    assert response.headers["etag"] == etag


def test_if_none_match_star_returns_304(harness):
    h = harness()
    path = h.client.post("/v1/images", json=generate_body()).json()["path"]

    assert h.client.get(path, headers={"If-None-Match": "*"}).status_code == 304


def test_a_stale_etag_gets_the_body(harness):
    h = harness()
    path = h.client.post("/v1/images", json=generate_body()).json()["path"]

    response = h.client.get(path, headers={"If-None-Match": '"stale"'})

    assert response.status_code == 200
    assert response.content == h.png


def test_if_modified_since_returns_304(harness):
    h = harness()
    path = h.client.post("/v1/images", json=generate_body()).json()["path"]
    modified = h.client.get(path).headers["last-modified"]

    response = h.client.get(path, headers={"If-Modified-Since": modified})

    assert response.status_code == 304


def test_head_returns_the_headers_without_the_body(harness):
    h = harness()
    path = h.client.post("/v1/images", json=generate_body()).json()["path"]

    response = h.client.head(path)

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content == b""


def test_range_requests_are_served(harness):
    h = harness()
    path = h.client.post("/v1/images", json=generate_body()).json()["path"]

    response = h.client.get(path, headers={"Range": "bytes=0-7"})

    assert response.status_code == 206
    assert response.content == PNG[:8]


def test_path_traversal_is_refused(harness):
    h = harness()
    response = h.client.get("/files/..%2F..%2F..%2Fetc%2Fpasswd")

    assert response.status_code == 404
    assert response.json() == {"error": "not_found"}


def test_a_well_formed_but_absent_id_is_404(harness):
    h = harness()
    response = h.client.get("/files/0123456789abcdef0123456789abcdef.png")

    assert response.status_code == 404


def test_files_can_require_a_token(harness):
    h = harness(access_token="s3cret", files_require_token=True)
    path = h.client.post(
        "/v1/images", json=generate_body(), headers={"X-Relay-Token": "s3cret"}
    ).json()["path"]

    assert h.client.get(path).status_code == 401
    assert h.client.get(path, headers={"X-Relay-Token": "s3cret"}).status_code == 200


def test_files_are_open_by_default_so_img_tags_work(harness):
    h = harness(access_token="s3cret")
    path = h.client.post(
        "/v1/images", json=generate_body(), headers={"X-Relay-Token": "s3cret"}
    ).json()["path"]

    assert h.client.get(path).status_code == 200


# --- configuration and mode interactions ---------------------------------
def test_gateway_can_be_disabled(harness):
    h = harness(gateway_enabled=False)
    response = h.client.post("/v1/images", json=generate_body())

    assert response.status_code == 404
    assert response.json() == {"error": "gateway_disabled"}
    assert h.origin.count == 0


def test_missing_upstream_is_a_503_not_a_crash(harness):
    h = harness(upstream="")
    response = h.client.post("/v1/images", json=generate_body())

    assert response.status_code == 503
    assert response.json() == {"error": "no_upstream"}


def test_gateway_paths_are_never_handed_to_the_raw_relay(harness):
    """mode=relay plus an explicit relay request must still land on the gateway."""
    h = harness(mode="relay")
    response = h.client.post(
        "/v1/images", json=generate_body(), headers={"X-Mock-Mode": "relay"}
    )

    assert response.status_code == 200
    assert "url" in response.json(), "the gateway envelope, not the origin's raw answer"
    assert "x-mock-relay" not in response.headers


def test_raw_mode_hands_back_the_origin_payload_untouched(harness):
    h = harness(normalize_response=False)
    response = h.client.post("/v1/images", json=generate_body())

    payload = response.json()
    assert payload["image"].startswith("data:image/png;base64,")
    # The image was still re-hosted, and the URL is still advertised.
    assert response.headers["location"].endswith(".png")


def test_public_config_needs_no_token_but_hides_the_origin(harness):
    h = harness(access_token="s3cret")

    anonymous = h.client.get("/v1/config").json()
    assert anonymous["auth"]["required"] is True
    assert anonymous["upstream"] is None

    named = h.client.get("/v1/config", headers={"X-Relay-Token": "s3cret"}).json()
    assert named["upstream"] == ORIGIN


def test_public_config_reveals_the_origin_when_the_gateway_is_open(harness):
    h = harness()

    assert h.client.get("/v1/config").json()["upstream"] == ORIGIN


def test_public_config_advertises_the_prompt_budget(harness):
    """The browser counter can only be right if this endpoint tells it the truth.

    `/v1/config` is anonymous by design, and the prompt limit is not a secret --
    it is a number the caller needs *before* composing a prompt, not after being
    told the image ignored the second half of it.
    """
    h = harness(max_prompt_chars=1234, prompt_overflow="reject")

    limits = h.client.get("/v1/config").json()["limits"]

    assert limits["maxPromptChars"] == 1234
    assert limits["promptOverflow"] == "reject"


def test_control_plane_reports_the_gateway_and_warns_when_open(harness):
    h = harness()

    status = h.client.get("/__mock__/gateway").json()

    assert status["ready"] is True
    assert status["authRequired"] is False
    assert "OPEN" in status["warning"]
    assert status["deviceIdHint"] != h.settings.device_id


def test_control_plane_stops_warning_once_a_token_is_set(harness):
    h = harness(access_token="s3cret")

    status = h.client.get("/__mock__/gateway").json()

    assert status["warning"] is None
    assert status["authRequired"] is True


# --- dimensions are read from the bytes when the origin omits them --------
# Verified against the real origin: a successful generation returned the image
# and nothing else -- no `width`, no `height`, no `id`. The envelope is our own
# contract, so it should not be missing fields just because the origin was terse.
def real_png(width: int, height: int) -> bytes:
    """A structurally valid PNG whose IHDR actually carries a size."""
    import struct
    import zlib

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)

    def chunk(tag: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(tag)
        crc = zlib.crc32(payload, crc)
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", crc & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(b"\x00" * 8))
        + chunk(b"IEND", b"")
    )


def test_png_dimensions_come_from_the_ihdr():
    from app.filestore import image_dimensions

    assert image_dimensions(real_png(1184, 864)) == (1184, 864)
    assert image_dimensions(real_png(1, 1)) == (1, 1)


def test_gif_dimensions_are_little_endian():
    from app.filestore import image_dimensions

    data = b"GIF89a" + (320).to_bytes(2, "little") + (240).to_bytes(2, "little") + b"\x00" * 16
    assert image_dimensions(data) == (320, 240)


def test_webp_vp8x_dimensions_are_stored_minus_one():
    from app.filestore import image_dimensions

    data = bytearray(b"RIFF" + b"\x00" * 4 + b"WEBP" + b"VP8X" + b"\x00" * 8)
    data[24:27] = (639).to_bytes(3, "little")  # width  - 1
    data[27:30] = (479).to_bytes(3, "little")  # height - 1
    assert image_dimensions(bytes(data)) == (640, 480)


def test_jpeg_dimensions_come_from_the_start_of_frame():
    from app.filestore import image_dimensions

    import struct

    sof = b"\xff\xc0" + struct.pack(">H", 17) + b"\x08" + struct.pack(">HH", 720, 1280) + b"\x03" * 9
    data = b"\xff\xd8\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x00" * 9 + sof
    assert image_dimensions(data) == (1280, 720)


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"not an image at all",
        b"\x89PNG\r\n\x1a\n",  # magic only, no IHDR
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR",  # IHDR header, size truncated
        b"\xff\xd8\xff\xe0\x00\x10JFIF",  # JPEG with no frame header
        b"RIFF\x00\x00\x00\x00WEBP????",  # unknown WebP chunk
    ],
)
def test_unknown_or_truncated_headers_are_none_not_an_exception(data):
    from app.filestore import image_dimensions

    assert image_dimensions(data) is None


def test_a_zero_sized_header_is_not_reported_as_a_real_size():
    from app.filestore import image_dimensions

    # The suite's own PNG fixture has an all-zero IHDR; reporting 0x0 would be
    # worse than reporting nothing.
    assert image_dimensions(PNG) is None


def test_gateway_fills_in_dimensions_the_origin_did_not_send(harness):
    """The exact shape a real generation came back in: image, and nothing else."""
    h = harness(lambda request: httpx.Response(200, json={"image": data_url(real_png(1184, 864))}))

    payload = h.client.post("/v1/images", json=generate_body()).json()

    assert payload["width"] == 1184
    assert payload["height"] == 864


def test_upstream_dimensions_still_win_over_the_header(harness):
    """The origin is the authority when it does speak; the header is only a fallback."""
    h = harness(
        lambda request: httpx.Response(
            200, json={"image": data_url(real_png(1184, 864)), "width": 2048, "height": 1536}
        )
    )

    payload = h.client.post("/v1/images", json=generate_body()).json()

    assert (payload["width"], payload["height"]) == (2048, 1536)


def test_a_real_generation_envelope_is_complete(harness):
    """Everything the contract promises is present even for a terse origin."""
    h = harness(lambda request: httpx.Response(200, json={"image": data_url(real_png(1184, 864))}))

    payload = h.client.post("/v1/images", json=generate_body()).json()

    for key in ("id", "url", "path", "mimeType", "size", "sha256", "cached", "createdAt",
                "prompt", "aspect", "width", "height", "upstream"):
        assert key in payload, key
    assert payload["upstream"]["sourceField"] == "image"
