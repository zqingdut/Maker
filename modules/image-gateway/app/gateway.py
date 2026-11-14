"""The 中转站 core: call the real origin on the client's behalf, then hand back
something nicer than what the origin returned.

Three jobs, in order:

  1. **Call upstream safely.** Inject the gateway's own credentials so the client
     never needs them; cap concurrency so the origin is not hammered; retry only
     where retrying is safe.
  2. **Find the image** in whatever shape the origin used -- an inline data URL, a
     remote URL, an OpenAI-style `b64_json`, or a raw binary body.
  3. **Re-host it** so the client gets a short immutable URL instead of a 2.9 MB
     base64 blob it has to carry around.

On retries: a generation is *paid work*. A `ReadTimeout` means the origin may well
have produced (and billed for) an image we never saw, so retrying it would bill
twice. Only connect-stage failures -- where the request provably never reached the
origin -- are ever retried, and even then only if `IMAGE_GATEWAY_RELAY_RETRIES > 0`.
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import json
import logging
import socket
import ssl
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx
from fastapi import Request

from .filestore import FileStore, FileStoreError, StoredFile, image_dimensions
from .relay import REQUEST_STRIP, MOCK_HEADER_PREFIX
from .upstream import DEVICE_HEADER, DEVICE_HEADER_LOWER, GENERATE_PATH
from .validation import ApiError, DATA_URL_RE
from . import security

logger = logging.getLogger("image-gateway.gateway")

#: Fields the origin might use to carry the image, in the order we prefer them.
INLINE_FIELDS = ("image", "dataUrl", "data_url", "b64_json", "imageBase64")
URL_FIELDS = ("url", "imageUrl", "image_url")

#: Fields whose *name* already says the value is base64, so a bare string in one
#: of them needs no length heuristic to be believed.
BARE_BASE64_FIELDS = frozenset({"b64_json", "imageBase64"})

#: Below this, a bare string is far more likely to be a word or an id than a
#: base64 image, so `image`/`dataUrl` are only decoded past this length.
MIN_BARE_BASE64 = 256

#: Headers that are the gateway's own and must never reach the origin.
#: `X-Relay-Token` is unambiguously ours -- the origin has no idea what it is,
#: and forwarding it would hand our credential to a third party.
GATEWAY_OWN_HEADERS = frozenset({"x-relay-token"})

#: Failures where the request never reached the origin -- safe to retry.
CONNECT_STAGE_ERRORS = (httpx.ConnectError, httpx.ConnectTimeout)


#: Substrings that survive httpx's wrapping. The real cause is one level deeper
#: than it looks -- `httpx.ConnectError` wraps `httpcore.ConnectError`, and the
#: original `socket.gaierror` is no longer reachable through `__cause__` -- so
#: the errno text is the only reliable signal. Covers Linux and macOS wording.
_DNS_HINTS = (
    "nodename nor servname",  # macOS getaddrinfo
    "name or service not known",  # Linux EAI_NONAME
    "temporary failure in name resolution",
    "no address associated with hostname",
    "getaddrinfo failed",
)
#: Deliberately narrow: bare "ssl"/"tls" would match a URL in the message and
#: mislabel a plain connection failure as a certificate problem.
_TLS_HINTS = ("certificate verify failed", "certificate", "ssl handshake")


def describe_connect_failure(exc: BaseException) -> str:
    """Say *why* the origin could not be reached, in one short clause.

    A bare `502 {"error":"upstream_error"}` is indistinguishable from "the origin
    is down", "your host is a placeholder", and "your TLS is broken" -- the
    caller has no way to tell a config mistake from an outage, which is exactly
    how a two-second fix becomes a bug report.

    The exception text is not usable as-is: it can carry the request URL, and the
    upstream host is the one thing a client should not have to infer from an
    error message. The full detail stays in the gateway log.
    """
    text = str(exc).lower()
    cause = exc.__cause__ or exc

    if isinstance(exc, httpx.ProxyError):
        # `relay_trust_env` defaults to True, so a stray HTTP_PROXY in the
        # service environment silently redirects every paid call through it.
        # Naming the proxy is the difference between a config fix and an outage.
        return "a proxy failed the upstream connection (check HTTP_PROXY / RELAY_TRUST_ENV)"
    if isinstance(cause, socket.gaierror) or any(hint in text for hint in _DNS_HINTS):
        return "cannot resolve the upstream host (DNS)"
    if isinstance(cause, ConnectionRefusedError) or "connection refused" in text:
        return "the upstream refused the connection"
    if isinstance(cause, ssl.SSLError) or any(hint in text for hint in _TLS_HINTS):
        return "TLS handshake with the upstream failed"
    if isinstance(exc, httpx.ConnectTimeout):
        return "timed out connecting to the upstream"
    if isinstance(exc, httpx.RemoteProtocolError):
        return "the upstream closed the connection mid-request"
    return f"could not reach the upstream ({type(cause).__name__})"


@dataclass
class ImageRef:
    """Where the origin put the image."""

    kind: str  # "bytes" | "url"
    source_field: str
    data: bytes | None = None
    mime: str | None = None
    url: str | None = None


def build_upstream_headers(request: Request, settings) -> dict[str, str]:
    """Client headers, minus ours, plus the gateway's own credentials.

    Two subtractions matter:

      * the device header is *replaced*, not merged -- holding it is the entire
        reason a client would use a gateway instead of talking to the origin.
        Replacement requires a configured `device_id`; without one the client's
        header survives, because "override" with nothing to override with would
        otherwise mean "delete"
      * our own token is dropped. `Authorization` is ambiguous (it may be the
        client's own credential for the origin), so it is dropped only when it is
        the one that authenticated *this* request.
    """
    presented = security.presented_token(request.headers)
    drop_authorization = bool(
        settings.auth_required
        and presented
        and hmac.compare_digest(presented, settings.access_token)
    )

    # Overriding only means *replace* when there is something to replace it with.
    # With no configured device id the client's own header is passed through --
    # silently dropping it and injecting nothing would send the origin a request
    # with no device at all, which fails in a much more confusing way.
    replacing_device = bool(settings.override_device and settings.device_id)

    headers: dict[str, str] = {}
    if settings.relay_forward_client_headers:
        for name, value in request.headers.items():
            lower = name.lower()
            if lower in REQUEST_STRIP or lower.startswith(MOCK_HEADER_PREFIX):
                continue
            if lower in GATEWAY_OWN_HEADERS:
                continue
            if lower == "authorization" and drop_authorization:
                continue
            if lower == DEVICE_HEADER_LOWER and replacing_device:
                continue
            headers[name] = value

    if replacing_device:
        headers[DEVICE_HEADER] = settings.device_id

    headers.update(settings.relay_headers)
    return headers


def _client_kwargs(settings, transport) -> dict:
    kwargs: dict = {
        "timeout": settings.relay_timeout_s,
        "trust_env": settings.relay_trust_env,
        "follow_redirects": False,
    }
    if transport is not None:
        kwargs["transport"] = transport
    return kwargs


async def call_upstream(
    ctx,
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    content: bytes | None = None,
    allow_retry: bool = True,
) -> httpx.Response:
    """One outbound call, behind the concurrency gate, with the safe-retry policy."""
    settings = ctx.settings

    try:
        await asyncio.wait_for(
            ctx.upstream_semaphore.acquire(), timeout=settings.queue_timeout_s
        )
    except asyncio.TimeoutError:
        ctx.store.bump("gateway_busy")
        raise ApiError(503, "upstream_busy", "concurrency limit reached") from None

    try:
        attempts = settings.relay_retries + 1 if allow_retry else 1
        last_error: Exception | None = None

        for attempt in range(attempts):
            try:
                async with httpx.AsyncClient(**_client_kwargs(settings, ctx.relay_transport)) as client:
                    return await client.request(method, url, headers=headers, content=content)
            except CONNECT_STAGE_ERRORS as exc:
                # Never reached the origin: nothing was billed, so a retry is safe.
                last_error = exc
                logger.warning(
                    "connect-stage failure (attempt %d/%d): %s %s", attempt + 1, attempts, method, url
                )
                if attempt + 1 < attempts:
                    ctx.store.bump("gateway_retries")
                    await asyncio.sleep(0.25 * (2**attempt))
                    continue
                ctx.store.bump("gateway_upstream_errors")
                raise ApiError(502, "upstream_error", describe_connect_failure(exc)) from None
            except httpx.TimeoutException:
                # The request may have been received and billed. Do not retry.
                logger.warning("upstream timeout after %ss: %s %s", settings.relay_timeout_s, method, url)
                ctx.store.bump("gateway_timeouts")
                raise ApiError(504, "upstream_timeout") from None
            except httpx.HTTPError as exc:
                logger.warning("upstream error (%s): %s %s", type(exc).__name__, method, url)
                ctx.store.bump("gateway_upstream_errors")
                raise ApiError(502, "upstream_error", describe_connect_failure(exc)) from None

        # Unreachable while `relay_retries >= 0` (config rejects a negative), but
        # if it ever is reached the note must not be the raw exception: that
        # string carries the upstream URL.
        raise ApiError(502, "upstream_error", describe_connect_failure(last_error) if last_error else None)
    finally:
        ctx.upstream_semaphore.release()


# --- finding the image ---------------------------------------------------
def extract_image_ref(response: httpx.Response) -> ImageRef | None:
    """Locate the image in an upstream response, whatever shape it took."""
    content_type = (response.headers.get("content-type") or "").split(";")[0].strip()

    payload = None
    if "json" in content_type:
        try:
            payload = response.json()
        except (json.JSONDecodeError, ValueError):
            payload = None

    if isinstance(payload, dict):
        candidates: list[tuple[str, dict]] = [("", payload)]
        data = payload.get("data")
        if isinstance(data, list) and data and isinstance(data[0], dict):
            candidates.append(("data[0].", data[0]))

        for prefix, scope in candidates:
            for field in INLINE_FIELDS:
                value = scope.get(field)
                ref = _inline_ref(value, f"{prefix}{field}")
                if ref:
                    return ref
            for field in URL_FIELDS:
                value = scope.get(field)
                if isinstance(value, str) and value.startswith(("http://", "https://")):
                    return ImageRef(kind="url", source_field=f"{prefix}{field}", url=value)

    if content_type.startswith("image/"):
        return ImageRef(
            kind="bytes",
            source_field="<binary body>",
            data=response.content,
            mime=content_type,
        )
    return None


def _inline_ref(value, field: str) -> ImageRef | None:
    if not isinstance(value, str) or not value:
        return None
    if value.startswith("data:"):
        match = DATA_URL_RE.match(value.strip())
        if not match:
            return None
        try:
            decoded = base64.b64decode(match.group("payload"), validate=False)
        except (ValueError, TypeError):
            return None
        return ImageRef(
            kind="bytes",
            source_field=field,
            data=decoded,
            mime=match.group("mime") or "image/png",
        )

    # A bare base64 blob, as OpenAI-style APIs return. The field name decides
    # whether to believe it: `b64_json` says so outright, whereas a bare string in
    # `image` could be anything, so it has to be long enough to be plausible.
    leaf = field.rsplit(".", 1)[-1]
    if leaf in BARE_BASE64_FIELDS or (len(value) > MIN_BARE_BASE64 and "://" not in value):
        try:
            return ImageRef(
                kind="bytes", source_field=field, data=base64.b64decode(value, validate=True)
            )
        except (ValueError, TypeError):
            return None
    return None


async def resolve_image(ctx, ref: ImageRef) -> tuple[bytes, str | None]:
    if ref.kind == "bytes" and ref.data is not None:
        return ref.data, ref.mime

    if ref.kind == "url" and ref.url:
        # SSRF guard: only ever fetch back from the origin we already trust.
        allowed = urlsplit(ctx.settings.upstream).netloc
        target = urlsplit(ref.url)
        if target.netloc != allowed:
            raise ApiError(
                502,
                "upstream_bad_image_url",
                f"refusing to fetch {target.netloc}, expected {allowed}",
            )
        try:
            async with httpx.AsyncClient(
                **_client_kwargs(ctx.settings, ctx.relay_transport)
            ) as client:
                fetched = await client.get(ref.url)
        except httpx.HTTPError:
            raise ApiError(502, "upstream_error", "could not fetch the image URL") from None
        if fetched.status_code != 200:
            raise ApiError(502, "upstream_error", f"image URL returned {fetched.status_code}")
        return fetched.content, fetched.headers.get("content-type")

    raise ApiError(502, "upstream_no_image", "the origin returned no usable image")


# --- the wrapped flow ----------------------------------------------------
@dataclass
class GenerationResult:
    stored: StoredFile
    cached: bool
    upstream_status: int
    upstream_id: str | None
    source_field: str
    upstream_payload: dict | None


async def generate(ctx, request: Request, body: dict) -> GenerationResult:
    """The captured flow, wrapped: prompt in, re-hosted image out."""
    settings = ctx.settings
    url = f"{settings.upstream}{GENERATE_PATH}"
    headers = build_upstream_headers(request, settings)
    headers.setdefault("Content-Type", "application/json")
    payload_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")

    response = await call_upstream(
        ctx, "POST", url, headers=headers, content=payload_bytes, allow_retry=True
    )

    if response.status_code >= 400:
        # Pass the origin's own error through untouched -- it is the authority on
        # why the call failed, and a client debugging it needs the real envelope.
        # Record that the call went out, though: "did this 400 come from us or
        # from upstream?" is the first question anyone asks.
        request.state.log_extra.update(
            {
                "upstreamStatus": response.status_code,
                "upstreamHost": urlsplit(settings.upstream).netloc,
                "relayed": True,
            }
        )
        raise _passthrough_error(response)

    ref = extract_image_ref(response)
    if ref is None:
        raise ApiError(
            502,
            "upstream_no_image",
            f"no image found in the {response.headers.get('content-type')} response",
        )

    data, mime = await resolve_image(ctx, ref)

    upstream_payload = None
    try:
        upstream_payload = response.json()
    except (json.JSONDecodeError, ValueError):
        pass

    meta = {
        "prompt": body.get("prompt"),
        "aspect": body.get("aspect"),
        "mode": body.get("mode"),
        "upstreamHost": urlsplit(settings.upstream).netloc,
        "upstreamPath": GENERATE_PATH,
        "upstreamStatus": response.status_code,
        "sourceField": ref.source_field,
        "c2pa": b"caBX" in data[:16384],
    }
    if isinstance(upstream_payload, dict):
        for key in ("id", "aspect", "width", "height"):
            if key in upstream_payload:
                meta.setdefault(f"upstream_{key}", upstream_payload[key])
    for key in ("width", "height"):
        if isinstance(upstream_payload, dict) and isinstance(upstream_payload.get(key), int):
            meta[key] = upstream_payload[key]

    # The origin does not have to report dimensions, and for a real generation it
    # did not -- the response carried the image and nothing else. We hold the bytes
    # either way, so read them off the header rather than shipping an envelope with
    # the size missing. Upstream values win when present; this only fills blanks.
    if not (isinstance(meta.get("width"), int) and isinstance(meta.get("height"), int)):
        measured = image_dimensions(data)
        if measured is not None:
            meta["width"], meta["height"] = measured

    try:
        stored, existed = ctx.filestore.put(data, mime, meta)
    except FileStoreError as exc:
        raise ApiError(502, "upstream_bad_image", str(exc)) from None

    ctx.store.bump("gateway_generated")
    ctx.store.bump("gateway_cache_hit" if existed else "gateway_cache_miss")

    return GenerationResult(
        stored=stored,
        cached=existed,
        upstream_status=response.status_code,
        upstream_id=upstream_payload.get("id") if isinstance(upstream_payload, dict) else None,
        source_field=ref.source_field,
        upstream_payload=upstream_payload if isinstance(upstream_payload, dict) else None,
    )


def _passthrough_error(response: httpx.Response) -> ApiError:
    """Surface the origin's status and its own error code, in our envelope shape.

    The origin is the authority on why its own call failed, so a 400 stays a 400
    and `{"error":"bad_mode"}` stays `bad_mode`. We only guarantee the *shape*
    (flat `{"error": "<code>"}`), which is what the origin already sends.
    """
    code = "upstream_error"
    try:
        payload = response.json()
        if isinstance(payload, dict) and isinstance(payload.get("error"), str):
            code = payload["error"]
    except (json.JSONDecodeError, ValueError):
        pass
    return ApiError(response.status_code, code, "relayed from upstream")
