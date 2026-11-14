"""Error paths.

The first test is the important one: it pins the *observed* live behaviour of the
real service (`POST {}` -> 400 {"error":"bad_mode"}). The rest are the same
envelope extended to the other validation steps, in the order the real service
applies them.

**Two error families, probed live on 2026-09-24.** A wrong JSON *type* never
reaches the application: ASP.NET model binding rejects it and answers with an
RFC 9110 problem+json document instead of the flat envelope. Only values that bind
are then judged by the app, which answers flat. The tests below assert both shapes,
and assert that binding stops at the first bad field in DTO order -- which is why
`{"mode": {}, "prompt": 123}` reports `$.mode` and not `$.prompt`.
"""

from __future__ import annotations

import pytest

from app.upstream import DEVICE_HEADER, GENERATE_PATH

ENDPOINT = GENERATE_PATH

PROBLEM_TYPE = "https://tools.ietf.org/html/rfc9110#section-15.5.1"


def binding_fields(response) -> list[str]:
    """The `$.<name>` keys of a problem+json response, in order."""
    return list((response.json().get("errors") or {}).keys())


def test_empty_body_matches_the_observed_real_response(client):
    """Probed live: POST /api/v1/media/ai/image with {} -> 400 {"error":"bad_mode"}."""
    response = client.post(ENDPOINT, json={}, headers={"Content-Type": "application/json"})

    assert response.status_code == 400
    assert response.json() == {"error": "bad_mode"}


@pytest.mark.parametrize("mode", ["video", "group", "", None])
def test_unsupported_modes_are_bad_mode(client, mode):
    """A *string* mode that is not in the enum: the app's own flat envelope."""
    body = {"prompt": "a prompt", "aspect": "4:3"}
    if mode is not None:
        body["mode"] = mode

    response = client.post(ENDPOINT, json=body, headers={"Content-Type": "application/json"})

    assert response.status_code == 400
    assert response.json()["error"] == "bad_mode"


def test_a_non_string_mode_is_a_binding_failure_not_bad_mode(client):
    """Probed live: {"mode": 7} -> problem+json, never the flat envelope.

    Worth its own test because it is the distinction a client is most likely to
    get wrong: `bad_mode` and a binding failure are different bodies.
    """
    response = client.post(
        ENDPOINT, json={"mode": 7, "prompt": "p"}, headers={"Content-Type": "application/json"}
    )

    assert response.status_code == 400
    assert "error" not in response.json()
    assert binding_fields(response) == ["$.mode"]
    assert response.json()["type"] == PROBLEM_TYPE
    assert response.headers["content-type"].startswith("application/problem+json")


def test_mode_is_checked_before_prompt(client):
    """Order matters: a body that is bad in two ways must fail on mode first."""
    response = client.post(
        ENDPOINT, json={"mode": "nope"}, headers={"Content-Type": "application/json"}
    )
    assert response.json()["error"] == "bad_mode"


@pytest.mark.parametrize("prompt", [None, "", "   "])
def test_an_empty_prompt_is_empty_prompt(client, prompt):
    """Probed live: the code is `empty_prompt`. It is *not* `bad_prompt`.

    `bad_prompt` was this suite's guess and it was wrong; the real service
    distinguishes "present but empty" (an app-level check) from "not a string"
    (a binding check).
    """
    body = {"mode": "image", "aspect": "4:3"}
    if prompt is not None:
        body["prompt"] = prompt

    response = client.post(ENDPOINT, json=body, headers={"Content-Type": "application/json"})

    assert response.status_code == 400
    assert response.json()["error"] == "empty_prompt"


@pytest.mark.parametrize("prompt", [123, ["a"], {"a": 1}])
def test_a_non_string_prompt_is_a_binding_failure(client, prompt):
    response = client.post(
        ENDPOINT,
        json={"mode": "image", "prompt": prompt, "aspect": "4:3"},
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 400
    assert "error" not in response.json()
    assert binding_fields(response) == ["$.prompt"]


def test_binding_reports_only_the_first_bad_field_in_dto_order(client):
    """Probed live: two bad fields report only the earlier one.

    DTO order is `mode`, `prompt`, `aspect`. A client that fixes only the field it
    was told about, then retries, is walking the same path the real service walks.
    """
    response = client.post(
        ENDPOINT,
        json={"mode": {}, "prompt": 123, "aspect": 4.3},
        headers={"Content-Type": "application/json"},
    )

    assert binding_fields(response) == ["$.mode"]


def test_a_prompt_over_the_limit_is_truncated_not_rejected(make_settings):
    """The limit is a budget, not a validation rule: cut it, generate, flag the cut.

    Flagging matters more than the cut itself -- a silently shortened prompt
    produces an image that does not match what the caller asked for, with no way
    to tell why.
    """
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(make_settings(max_prompt_chars=10))) as client:
        response = client.post(
            ENDPOINT,
            json={"mode": "image", "prompt": "x" * 25, "aspect": "4:3"},
            headers={"Content-Type": "application/json"},
        )

    assert response.status_code == 200
    assert response.headers["x-prompt-truncated"] == "true"
    assert response.json()["prompt"] == "x" * 10


def test_the_limit_counts_characters_not_bytes(make_settings):
    """25 CJK characters are 75 bytes in UTF-8.

    A byte-based limit would cut this at 3 characters and look like a bug to
    anyone writing Chinese prompts.
    """
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(make_settings(max_prompt_chars=10))) as client:
        response = client.post(
            ENDPOINT,
            json={"mode": "image", "prompt": "画" * 25, "aspect": "4:3"},
            headers={"Content-Type": "application/json"},
        )

    assert response.json()["prompt"] == "画" * 10


def test_prompt_overflow_can_be_configured_to_reject(make_settings):
    """Rollback path: callers who would rather fail than ship half a prompt."""
    from fastapi.testclient import TestClient

    from app.main import create_app

    settings = make_settings(max_prompt_chars=10, prompt_overflow="reject")
    with TestClient(create_app(settings)) as client:
        response = client.post(
            ENDPOINT,
            json={"mode": "image", "prompt": "x" * 11, "aspect": "4:3"},
            headers={"Content-Type": "application/json"},
        )

    assert response.status_code == 400
    assert response.json()["error"] == "prompt_too_long"


def test_a_prompt_exactly_at_the_limit_is_untouched(make_settings):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(make_settings(max_prompt_chars=10))) as client:
        response = client.post(
            ENDPOINT,
            json={"mode": "image", "prompt": "x" * 10, "aspect": "4:3"},
            headers={"Content-Type": "application/json"},
        )

    assert response.status_code == 200
    assert "x-prompt-truncated" not in response.headers
    assert response.json()["prompt"] == "x" * 10


@pytest.mark.parametrize("aspect", ["7:5", "4:3:2", "wide", "99:1"])
def test_an_unknown_aspect_is_accepted_not_rejected(client, aspect):
    """Probed live: `aspect: "99:1"` -> 200 at 1184x864.

    This is the finding that justifies the mock's *deliberate* refusal to validate
    aspect. A local size table would have rejected these with `bad_aspect`, and the
    real service serves them.
    """
    response = client.post(
        ENDPOINT,
        json={"mode": "image", "prompt": "p", "aspect": aspect},
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 200


@pytest.mark.parametrize("aspect", [4, 4.3, [], {}])
def test_a_non_string_aspect_is_a_binding_failure(client, aspect):
    response = client.post(
        ENDPOINT,
        json={"mode": "image", "prompt": "p", "aspect": aspect},
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 400
    assert "error" not in response.json()
    assert binding_fields(response) == ["$.aspect"]


def test_blank_aspect_falls_back_to_the_default(client):
    """An empty string means "unset", not "invalid" -- same as an absent field."""
    for aspect in ("", "   ", None):
        body = {"mode": "image", "prompt": "p"}
        if aspect is not None:
            body["aspect"] = aspect
        response = client.post(ENDPOINT, json=body, headers={"Content-Type": "application/json"})

        assert response.status_code == 200, aspect
        assert response.json()["aspect"] == "4:3"


@pytest.mark.parametrize("raw", [b"", b"not json", b"[1,2,3]", b'"a string"', b"\xff\xfe"])
def test_malformed_bodies(client, raw):
    response = client.post(
        ENDPOINT, content=raw, headers={"Content-Type": "application/json"}
    )

    assert response.status_code == 400
    assert response.json()["error"] == "bad_body"


def test_oversized_body_is_rejected_before_parsing(make_settings):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(make_settings(max_body_bytes=64))) as client:
        response = client.post(
            ENDPOINT,
            json={"mode": "image", "prompt": "x" * 200, "aspect": "4:3"},
            headers={"Content-Type": "application/json"},
        )

    assert response.status_code == 413
    assert response.json()["error"] == "payload_too_large"


def test_forced_failure_injection(client, captured_body, device_headers):
    headers = dict(device_headers, **{"X-Mock-Fail": "429"})
    response = client.post(ENDPOINT, json=captured_body, headers=headers)

    assert response.status_code == 429
    assert response.json() == {"error": "rate_limited"}
    assert response.headers["x-mock-injected"] == "true"


def test_failure_injection_can_be_disabled_per_request(make_settings, captured_body, device_headers):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(make_settings(fail_rate=1.0))) as client:
        assert client.post(ENDPOINT, json=captured_body, headers=device_headers).status_code == 502
        headers = dict(device_headers, **{"X-Mock-Fail": "off"})
        assert client.post(ENDPOINT, json=captured_body, headers=headers).status_code == 200


def test_random_failure_rate_can_be_pinned_to_always(make_settings, captured_body, device_headers):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(make_settings(fail_rate=1.0, fail_status=503))) as client:
        response = client.post(ENDPOINT, json=captured_body, headers=device_headers)

    assert response.status_code == 503
    assert response.json()["error"] == "upstream_unavailable"


def test_device_header_can_be_required(make_settings, captured_body):
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app(make_settings(require_device=True))) as client:
        missing = client.post(ENDPOINT, json=captured_body, headers={"Content-Type": "application/json"})
        malformed = client.post(
            ENDPOINT, json=captured_body, headers={DEVICE_HEADER: "nope", "Content-Type": "application/json"}
        )
        good = client.post(
            ENDPOINT,
            json=captured_body,
            headers={DEVICE_HEADER: "web-00000000-0000-0000-0000-000000000000", "Content-Type": "application/json"},
        )

    assert (missing.status_code, missing.json()["error"]) == (401, "missing_device")
    assert (malformed.status_code, malformed.json()["error"]) == (401, "bad_device")
    assert good.status_code == 200


def test_unhandled_errors_do_not_leak_internals(client, monkeypatch, captured_body, device_headers):
    """A mock must fail the way a hardened service fails: flat, opaque, logged."""
    from app.routes import media

    def boom(*args, **kwargs):
        raise RuntimeError("upstream SDK said: ARK_API_KEY=sk-secret-leak")

    monkeypatch.setattr(media, "render", boom)

    response = client.post(ENDPOINT, json=captured_body, headers=device_headers)

    assert response.status_code == 500
    assert response.json() == {"error": "internal_error"}
    assert "sk-secret-leak" not in response.text
    assert "RuntimeError" not in response.text


def test_bad_mock_style_directive_is_reported(client, captured_body, device_headers):
    headers = dict(device_headers, **{"X-Mock-Style": "yaml"})
    response = client.post(ENDPOINT, json=captured_body, headers=headers)

    assert response.status_code == 400
    assert response.json()["error"] == "bad_style"


def test_bad_delay_directive_is_reported(client, captured_body, device_headers):
    headers = dict(device_headers, **{"X-Mock-Delay": "soon"})
    response = client.post(ENDPOINT, json=captured_body, headers=headers)

    assert response.status_code == 400
    assert response.json()["error"] == "bad_delay_directive"


def test_error_responses_carry_the_kestrel_server_header(client):
    response = client.post(ENDPOINT, json={}, headers={"Content-Type": "application/json"})
    assert response.headers["server"] == "Kestrel"
