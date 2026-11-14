"""Absolute-URL construction, shared by the mock routes and the gateway.

Both halves of the service hand back absolute URLs (the mock's `url` response
style, the gateway's short file URLs), and both must agree on what "this host"
means. Behind a tunnel or a reverse proxy the request's own Host header is the
wrong answer, which is what `IMAGE_GATEWAY_PUBLIC_BASE_URL` exists for.
"""

from __future__ import annotations


def public_base(request, settings) -> str:
    """The base URL a client should use to reach us. No trailing slash."""
    if settings.public_base_url:
        return settings.public_base_url.rstrip("/")
    return str(request.base_url).rstrip("/")


def file_url(request, settings, file_id: str) -> str:
    return f"{public_base(request, settings)}/files/{file_id}"
