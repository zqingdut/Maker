"""Request validation, ordered to match the real service.

The probe showed that `POST {}` returns 400 {"error":"bad_mode"} -- i.e. `mode`
is checked before anything else. We reproduce that order exactly, and we do the
validation by hand rather than via FastAPI/pydantic models, because the real
service's error envelope is a flat {"error":"<code>"} rather than FastAPI's
{"detail":[...]} 422 payload.

Validation order:  body size -> JSON -> binding -> mode -> prompt -> aspect -> device

**There are two error families, and they are not interchangeable.** Probing the
real service (2026-09-24) showed that a *wrong JSON type* never reaches the
application at all: ASP.NET's model binding rejects it first and answers with an
RFC 9110 `ValidationProblemDetails` body, not the flat envelope. Only values that
bind successfully are then judged by the application, which answers flat:

    {"mode": {}}                      -> 400 problem+json, errors {"$.mode": [...]}
    {"prompt": 123}                   -> 400 problem+json, errors {"$.prompt": [...]}
    {"aspect": 4.3}                   -> 400 problem+json, errors {"$.aspect": [...]}
    {"mode": "video"}                 -> 400 {"error":"bad_mode"}
    {"prompt": "  "}                  -> 400 {"error":"empty_prompt"}

Model binding **stops at the first offending property in DTO order**, which is
`mode`, then `prompt`, then `aspect` -- so a body with two bad fields reports only
the earlier one. That is reproduced here, because a client debugging against the
mock must see the same first error the real service would give it.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import dataclass, field

from . import aspects
from .config import Settings

#: The problem+json `type` URI the real service emits. Not invented: copied from
#: the live response.
PROBLEM_TYPE = "https://tools.ietf.org/html/rfc9110#section-15.5.1"
PROBLEM_TITLE = "One or more validation errors occurred."

#: The order ASP.NET binds the request DTO in, which is the order errors surface.
#: Observed by sending two bad fields at once and seeing which one was reported.
BINDING_ORDER = ("mode", "prompt", "aspect")


class ApiError(Exception):
    """An error the real service would have produced.

    `note` is diagnostic and travels in the `X-Mock-Error-Note` header (never in
    the body -- the observed envelope is exactly `{"error": "<code>"}`). `headers`
    carries protocol headers the status implies, e.g. `Retry-After` on a 429.
    """

    def __init__(
        self,
        status: int,
        code: str,
        note: str | None = None,
        headers: dict[str, str] | None = None,
    ):
        super().__init__(code)
        self.status = status
        self.code = code
        self.note = note
        self.headers = dict(headers or {})

    def envelope(self) -> dict:
        """The observed real envelope is exactly {"error": "<code>"}."""
        return {"error": self.code}


class BindingError(ApiError):
    """A JSON type mismatch, rejected by model binding before the app sees it.

    A different *shape* from every other error, so it is a different class rather
    than a flag: the body is ASP.NET's `ValidationProblemDetails`, and a client
    that only understands `{"error": "..."}` will otherwise mis-parse it.
    """

    def __init__(self, field_name: str, expected: str = "a string"):
        super().__init__(400, "bad_request", f"{field_name} must be {expected}")
        self.field_name = field_name

    def envelope(self) -> dict:
        return {
            "type": PROBLEM_TYPE,
            "title": PROBLEM_TITLE,
            "status": 400,
            "errors": {f"$.{self.field_name}": [f"The JSON value could not be converted."]},
        }


#: Shared by the mock's upload route and the gateway's image extraction.
DATA_URL_RE = re.compile(
    r"^data:(?P<mime>[\w.+-]+/[\w.+-]+)?;base64,(?P<payload>[A-Za-z0-9+/=\s]+)$"
)


@dataclass
class ImageRequest:
    mode: str
    prompt: str
    aspect: str
    width: int
    height: int
    seed: str
    device: str | None = None
    extras: dict = field(default_factory=dict)
    #: True when `prompt` was cut down to `max_prompt_chars` before generation.
    prompt_truncated: bool = False


def fit_prompt(prompt: str, settings: Settings) -> tuple[str, bool]:
    """Apply `max_prompt_chars`; return `(prompt, was_truncated)`.

    Truncation counts **characters, not bytes**. The limit stands for a model-side
    budget, and CJK is one character per glyph but three bytes in UTF-8 -- a byte
    limit would cut a Chinese prompt at roughly a third of the advertised length.

    `max_prompt_chars <= 0` means no limit. `prompt_overflow="reject"` restores
    the old hard failure for callers who would rather not silently ship an image
    built from half a prompt.
    """
    limit = settings.max_prompt_chars
    if limit <= 0 or len(prompt) <= limit:
        return prompt, False
    if settings.prompt_overflow == "reject":
        raise ApiError(400, "prompt_too_long", f"{len(prompt)} chars > limit {limit}")
    return prompt[:limit], True


def parse_json_body(raw: bytes, settings: Settings) -> dict:
    if len(raw) > settings.max_body_bytes:
        raise ApiError(413, "payload_too_large")
    if not raw:
        raise ApiError(400, "bad_body", "empty request body")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ApiError(400, "bad_body", "body is not valid UTF-8 JSON") from None
    if not isinstance(parsed, dict):
        raise ApiError(400, "bad_body", "body must be a JSON object")
    return parsed


def check_device(device: str | None, settings: Settings) -> None:
    if not settings.require_device:
        return
    if not device:
        raise ApiError(401, "missing_device")
    if not re.match(settings.device_pattern, device):
        raise ApiError(401, "bad_device")


def validate_image_request(
    body: dict,
    settings: Settings,
    device: str | None,
    seed_override: str | None = None,
) -> ImageRequest:
    # 0. model binding. A wrong JSON type is rejected here, before `mode` is even
    #    looked at -- and only the first bad field in DTO order is reported, which
    #    is why this is a loop over BINDING_ORDER rather than three independent
    #    checks.
    for name in BINDING_ORDER:
        if name in body and body[name] is not None and not isinstance(body[name], str):
            raise BindingError(name)

    # 1. mode  (observed: the real service checks this first)
    mode = body.get("mode")
    if not isinstance(mode, str) or mode not in settings.modes:
        raise ApiError(
            400,
            "bad_mode",
            f"supported modes: {', '.join(settings.modes)}",
        )

    # 2. prompt  (observed code: "empty_prompt", not "bad_prompt")
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ApiError(400, "empty_prompt", "prompt must be a non-empty string")
    prompt, prompt_truncated = fit_prompt(prompt, settings)

    # 3. aspect
    #    Observed: an unknown but well-formed ratio is NOT rejected -- `"99:1"`
    #    returned 200 at the default 1184x864. So there is no `bad_aspect` code to
    #    emit for a string value; only a *non-string* fails, and that is binding.
    #    A malformed ratio ("4:3:2") is accepted here too, and fails further
    #    upstream as a 502 -- see the relay path, which passes it through.
    aspect_raw = body.get("aspect") or settings.default_aspect
    if not aspect_raw.strip():
        # "" or "   " means unset, not invalid -- same as an absent field.
        aspect_raw = settings.default_aspect
    try:
        width, height = aspects.size_for(aspect_raw)
        aspect_key = aspects.normalise(aspect_raw)
    except aspects.BadAspect:
        # Unknown ratio: the origin falls back to the default frame rather than
        # refusing. `aspect_key` keeps the caller's own string so the record shows
        # what was asked for, while the size shows what was delivered.
        aspect_key = aspect_raw
        width, height = aspects.size_for(settings.default_aspect)

    # 4. device
    check_device(device, settings)

    if seed_override:
        seed = seed_override
    elif settings.deterministic:
        seed = hashlib.sha256(f"{mode}\x00{prompt}\x00{aspect_key}".encode("utf-8")).hexdigest()[:32]
    else:
        seed = uuid.uuid4().hex

    known = {"mode", "prompt", "aspect"}
    extras = {k: v for k, v in body.items() if k not in known}

    return ImageRequest(
        mode=mode,
        prompt=prompt,
        aspect=aspect_key,
        width=width,
        height=height,
        seed=seed,
        device=device,
        extras=extras,
        prompt_truncated=prompt_truncated,
    )
