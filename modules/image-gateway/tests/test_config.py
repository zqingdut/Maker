"""Settings parsing.

These are the knobs a user is most likely to get wrong, so they get pinned here.
The trap that motivated this file: `IMAGE_GATEWAY_CORS=` (set but empty) has to mean
"no origins / CORS off", while an *unset* variable must keep the default.
"""

from __future__ import annotations

import pytest

from app.config import Settings


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for key in list(__import__("os").environ):
        if key.startswith("IMAGE_GATEWAY_"):
            monkeypatch.delenv(key, raising=False)


def test_defaults_when_nothing_is_set():
    settings = Settings.from_env()

    assert settings.port == 4399
    assert settings.response_style == "inline"
    assert settings.cors_origins == ("*",)
    assert settings.modes == ("image",)
    assert settings.fail_rate == 0.0


def test_empty_cors_disables_cors(monkeypatch):
    monkeypatch.setenv("IMAGE_GATEWAY_CORS", "")

    assert Settings.from_env().cors_origins == ()


def test_unset_cors_keeps_the_default(monkeypatch):
    assert Settings.from_env().cors_origins == ("*",)


def test_comma_separated_lists(monkeypatch):
    monkeypatch.setenv("IMAGE_GATEWAY_CORS", "http://localhost:5173, https://upstream.example.com")
    monkeypatch.setenv("IMAGE_GATEWAY_MODES", "image,video")

    settings = Settings.from_env()

    assert settings.cors_origins == ("http://localhost:5173", "https://upstream.example.com")
    assert settings.modes == ("image", "video")


def test_empty_server_header_disables_it(monkeypatch):
    monkeypatch.setenv("IMAGE_GATEWAY_SERVER_HEADER", "")

    assert Settings.from_env().server_header == ""


def test_numeric_overrides(monkeypatch):
    monkeypatch.setenv("IMAGE_GATEWAY_PORT", "5000")
    monkeypatch.setenv("IMAGE_GATEWAY_FAIL_RATE", "0.25")
    monkeypatch.setenv("IMAGE_GATEWAY_LATENCY_MIN_MS", "10")

    settings = Settings.from_env()

    assert (settings.port, settings.fail_rate, settings.latency_min_ms) == (5000, 0.25, 10)


def test_proxy_asset_policy_requires_an_upstream(monkeypatch):
    monkeypatch.setenv("IMAGE_GATEWAY_ASSET_MISS", "proxy")

    with pytest.raises(ValueError, match="ASSET_UPSTREAM"):
        Settings.from_env()


def test_proxy_asset_policy_accepts_an_upstream(monkeypatch):
    monkeypatch.setenv("IMAGE_GATEWAY_ASSET_MISS", "proxy")
    monkeypatch.setenv("IMAGE_GATEWAY_ASSET_UPSTREAM", "https://upstream.example.com/")

    assert Settings.from_env().asset_upstream == "https://upstream.example.com"


@pytest.mark.parametrize(
    "env,message",
    [
        ({"IMAGE_GATEWAY_RESPONSE_STYLE": "yaml"}, "response style"),
        ({"IMAGE_GATEWAY_VARIANT": "nope"}, "variant"),
        ({"IMAGE_GATEWAY_ASSET_MISS": "guess"}, "asset_miss"),
        ({"IMAGE_GATEWAY_FAIL_RATE": "2"}, "fail_rate"),
        ({"IMAGE_GATEWAY_LATENCY_MIN_MS": "900", "IMAGE_GATEWAY_LATENCY_MAX_MS": "100"}, "latency_max_ms"),
        # --- relay ---
        ({"IMAGE_GATEWAY_MODE": "relay"}, "requires IMAGE_GATEWAY_UPSTREAM"),
        ({"IMAGE_GATEWAY_MODE": "proxy"}, "mode must be"),
        ({"IMAGE_GATEWAY_UPSTREAM": "upstream.example.com"}, "absolute http"),
        ({"IMAGE_GATEWAY_RELAY_PATHS": ""}, "relay_paths must not be empty"),
        ({"IMAGE_GATEWAY_RELAY_PATHS": "api/v1"}, "must start with"),
        ({"IMAGE_GATEWAY_RELAY_HEADERS": "{oops"}, "must be JSON"),
        ({"IMAGE_GATEWAY_RELAY_HEADERS": '["a"]'}, "must be a JSON object"),
        ({"IMAGE_GATEWAY_RELAY_TIMEOUT_S": "0"}, "relay_timeout_s"),
    ],
)
def test_invalid_config_fails_fast(monkeypatch, env, message):
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    with pytest.raises(ValueError, match=message):
        Settings.from_env()


# --- relay configuration ------------------------------------------------
def test_relay_is_off_by_default():
    settings = Settings.from_env()

    assert settings.mode == "mock"
    assert settings.upstream == ""
    assert settings.relay_enabled is False


def test_relay_mode_requires_an_upstream(monkeypatch):
    monkeypatch.setenv("IMAGE_GATEWAY_MODE", "relay")
    monkeypatch.setenv("IMAGE_GATEWAY_UPSTREAM", "https://upstream.example.com")

    settings = Settings.from_env()

    assert settings.mode == "relay"
    assert settings.upstream == "https://upstream.example.com"
    assert settings.relay_enabled is True


def test_upstream_trailing_slash_is_normalised(monkeypatch):
    monkeypatch.setenv("IMAGE_GATEWAY_UPSTREAM", "https://upstream.example.com/")

    assert Settings.from_env().upstream == "https://upstream.example.com"


def test_relay_paths_are_parsed(monkeypatch):
    monkeypatch.setenv("IMAGE_GATEWAY_RELAY_PATHS", "/api/v1/media/, /assets/")

    assert Settings.from_env().relay_paths == ("/api/v1/media/", "/assets/")


def test_relay_headers_are_parsed_as_json(monkeypatch):
    monkeypatch.setenv(
        "IMAGE_GATEWAY_RELAY_HEADERS", '{"Authorization": "Bearer tok", "X-Tenant": "7"}'
    )

    assert Settings.from_env().relay_headers == {"Authorization": "Bearer tok", "X-Tenant": "7"}


def test_asset_proxy_can_borrow_the_relay_origin(monkeypatch):
    """One origin knob instead of two when both point at the same host."""
    monkeypatch.setenv("IMAGE_GATEWAY_ASSET_MISS", "proxy")
    monkeypatch.setenv("IMAGE_GATEWAY_UPSTREAM", "https://upstream.example.com")

    assert Settings.from_env().asset_upstream == "https://upstream.example.com"


def test_asset_proxy_prefers_its_own_origin_when_set(monkeypatch):
    monkeypatch.setenv("IMAGE_GATEWAY_ASSET_MISS", "proxy")
    monkeypatch.setenv("IMAGE_GATEWAY_UPSTREAM", "https://upstream.example.com")
    monkeypatch.setenv("IMAGE_GATEWAY_ASSET_UPSTREAM", "https://cdn.example.com")

    assert Settings.from_env().asset_upstream == "https://cdn.example.com"


def test_as_dict_redacts_injected_relay_headers(monkeypatch):
    """/__mock__/state is unauthenticated; an auth token must never be readable."""
    monkeypatch.setenv("IMAGE_GATEWAY_RELAY_HEADERS", '{"Authorization": "Bearer super-secret"}')

    reported = Settings.from_env().as_dict()

    assert reported["relay_headers"] == {"Authorization": "***"}
    assert "super-secret" not in str(reported)
