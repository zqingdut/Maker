"""Relay (中转) mode: forward matching requests to the real origin.

This is the half of the service that talks to the actual upstream. It is off by
default (`IMAGE_GATEWAY_MODE=mock`) because every relayed generation costs money.

Three things it deliberately does not do:

  * forward to a host taken from the request -- the origin comes from config only,
    so this can never become an open proxy
  * forward to a path outside `relay_paths`, or to `/__mock__/*`
  * leak upstream internals to the caller -- connection errors surface as the flat
    `{"error":"upstream_error"}` envelope and the detail goes to the log
"""

from __future__ import annotations

import logging
from urllib.parse import urlsplit

import httpx
from fastapi import Request
from fastapi.responses import Response

from .validation import ApiError

logger = logging.getLogger("image-gateway.relay")

CONTROL_PREFIX = "/__mock__/"
MOCK_HEADER_PREFIX = "x-mock-"

#: Paths the gateway serves itself. They do not exist on the origin, so the raw
#: relay must never forward them -- doing so would replace the gateway's own
#: answer with the origin's SPA fallback.
GATEWAY_PREFIXES = ("/v1/", "/files/")

#: Paths we own that are not API endpoints -- currently just the prompt box.
#: Listed separately from GATEWAY_PREFIXES because they are exact paths rather
#: than prefixes, but the rule is the same: ours, therefore never forwarded, and
#: a relay directive aimed at one is meaningless rather than contradictory.
UI_PATHS = ("/playground", "/playground/")

#: Dropped from the request we send upstream.
REQUEST_STRIP = frozenset(
    {
        "host",  # httpx derives it from the URL
        "content-length",  # recomputed
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "expect",
        "accept-encoding",  # let httpx negotiate and decode for us
    }
)

#: Dropped from the response we hand back. content-encoding goes because httpx has
#: already decoded the body; passing the header through would corrupt it. `date`
#: and `server` go because the ASGI server and our own middleware emit them, and
#: forwarding upstream's as well produces two of each on the wire.
RESPONSE_STRIP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",  # Starlette recomputes from the body
        "content-encoding",
        "date",
        "server",
    }
)


def path_allowed(path: str, settings) -> bool:
    for prefix in settings.relay_paths:
        if path == prefix.rstrip("/") or path.startswith(prefix if prefix.endswith("/") else prefix + "/"):
            return True
    return False


def should_relay(request: Request, settings) -> bool:
    """Decide whether this request goes upstream.

    Per-request `X-Mock-Mode` beats the global mode, so a single call can be
    relayed without restarting a mock-configured service (and vice versa).
    """
    if not settings.relay_enabled:
        return False

    path = request.url.path
    if path.startswith(CONTROL_PREFIX):
        return False  # the control plane never leaves the process
    if path.startswith(GATEWAY_PREFIXES) or path in UI_PATHS:
        # Ours, not the origin's. `X-Mock-Mode: relay` on a gateway path is
        # meaningless rather than contradictory, so it is ignored, not rejected.
        return False

    override = (request.headers.get("x-mock-mode") or "").strip().lower()
    if override:
        if override not in ("mock", "relay"):
            raise ApiError(400, "bad_mode_directive", "X-Mock-Mode must be 'mock' or 'relay'")
        if override == "mock":
            return False
        if not path_allowed(path, settings):
            # Asking explicitly for a relay of something we must not forward is an
            # error, not a silent fallback to the mock.
            raise ApiError(
                400,
                "path_not_relayable",
                f"{path} is outside relay_paths ({', '.join(settings.relay_paths)})",
            )
        return True

    if settings.mode != "relay":
        return False
    return path_allowed(path, settings)


def _request_headers(request: Request, settings) -> dict[str, str]:
    headers: dict[str, str] = {}
    if settings.relay_forward_client_headers:
        for name, value in request.headers.items():
            lower = name.lower()
            if lower in REQUEST_STRIP or lower.startswith(MOCK_HEADER_PREFIX):
                continue
            headers[name] = value
    # Config-injected headers win, so an auth token cannot be spoofed by a client.
    headers.update(settings.relay_headers)
    return headers


def _client(settings, transport) -> httpx.AsyncClient:
    kwargs: dict = {
        "timeout": settings.relay_timeout_s,
        "trust_env": settings.relay_trust_env,
        # A relay reports redirects; it does not chase them on the caller's behalf.
        "follow_redirects": False,
    }
    if transport is not None:
        kwargs["transport"] = transport
    return httpx.AsyncClient(**kwargs)


async def forward(request: Request, ctx, body: bytes) -> Response:
    settings = ctx.settings
    origin = urlsplit(settings.upstream)
    url = settings.upstream + request.url.path
    if request.url.query:
        url = f"{url}?{request.url.query}"

    headers = _request_headers(request, settings)

    request.state.log_extra = {
        "kind": "relay",
        "upstream": origin.netloc,
        "upstreamUrl": url,
    }

    try:
        async with _client(settings, ctx.relay_transport) as client:
            upstream = await client.request(
                request.method, url, headers=headers, content=body or None
            )
    except httpx.TimeoutException:
        logger.warning("relay timeout after %ss: %s %s", settings.relay_timeout_s, request.method, url)
        raise ApiError(504, "upstream_timeout") from None
    except httpx.HTTPError as exc:
        logger.warning("relay failed (%s): %s %s", type(exc).__name__, request.method, url)
        raise ApiError(502, "upstream_error") from None

    response_headers = {
        name: value
        for name, value in upstream.headers.items()
        if name.lower() not in RESPONSE_STRIP
    }
    # Make it unmistakable that these bytes came from the real service.
    response_headers["x-mock-relay"] = origin.netloc
    response_headers["x-mock-upstream-status"] = str(upstream.status_code)

    ctx.store.bump("relayed")
    ctx.store.bump(f"relay_status_{upstream.status_code}")
    request.state.log_extra["upstreamStatus"] = upstream.status_code
    request.state.log_extra["relayedBytes"] = len(upstream.content)

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=response_headers,
    )
