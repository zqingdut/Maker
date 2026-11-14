"""Response payload builders.

IMPORTANT: only the *request* side of this API was captured, so the success
payload below is a reconstruction. What is grounded in evidence:

  * the error envelope is flat: {"error": "<code>"}  (observed)
  * the captured session received the image as a base64 data URL (observed:
    a 2.88MB `data:image/png;base64,...` entry sits right next to the call),
    which is why `inline` is the default style
  * the real "4:3" response was a 1184x864 PNG with a C2PA manifest

Everything else is a design choice, isolated here so it is a one-file change if
the real contract turns out to differ. Three styles ship:

  inline   image bytes as a data URL, flat object           (default)
  url      image bytes served from this mock at /assets/... (lighter, easier to eyeball)
  openai   OpenAI images-compatible shape, for drop-in clients
"""

from __future__ import annotations

import base64
import time
from datetime import datetime, timezone

from .images import Rendered
from .validation import ImageRequest

C2PA_PRODUCER = "Google Media Processing Services"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _data_url(mime: str, data: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def build_success(
    *,
    style: str,
    item_id: str,
    request: ImageRequest,
    rendered: Rendered,
    base_url: str,
    request_id: str | None = None,
    report_credential: bool = True,
) -> dict:
    if style == "openai":
        return _openai_payload(item_id, request, rendered)

    payload: dict = {
        "id": item_id,
        "mode": request.mode,
        "prompt": request.prompt,
        "aspect": request.aspect,
        "width": rendered.width,
        "height": rendered.height,
        "mimeType": rendered.mime,
        "size": rendered.size,
        "source": rendered.source,
        "createdAt": _now_iso(),
    }

    # The real service returned 1184x864 for aspect="4:3"; when they disagree we
    # report both so a client can never be misled about what it actually got.
    if (rendered.width, rendered.height) != (request.width, request.height):
        payload["requestedWidth"] = request.width
        payload["requestedHeight"] = request.height

    if request.device:
        payload["deviceId"] = request.device
    if request_id:
        payload["requestId"] = request_id

    if style == "url":
        payload["url"] = f"{base_url}/assets/generated/{item_id}.png"
    else:
        payload["image"] = _data_url(rendered.mime, rendered.data)

    if report_credential:
        payload["credential"] = {
            "c2pa": b"caBX" in rendered.data[:16384],
            "producer": C2PA_PRODUCER,
            "note": "content credentials carried by the captured sample image",
        }

    if request.extras:
        # Echo anything we did not understand rather than silently dropping it --
        # that is usually how you discover a field the client depends on.
        payload["echoedFields"] = request.extras

    return payload


def _openai_payload(item_id: str, request: ImageRequest, rendered: Rendered) -> dict:
    return {
        "created": int(time.time()),
        "id": item_id,
        "data": [
            {
                "b64_json": base64.b64encode(rendered.data).decode("ascii"),
                "revised_prompt": request.prompt,
            }
        ],
    }


def item_metadata(item_id: str, request: ImageRequest, rendered: Rendered) -> dict:
    """Metadata without the bytes -- used by GET /assets/generated/<id>.json."""
    return {
        "id": item_id,
        "mode": request.mode,
        "prompt": request.prompt,
        "aspect": request.aspect,
        "width": rendered.width,
        "height": rendered.height,
        "mimeType": rendered.mime,
        "size": rendered.size,
        "source": rendered.source,
    }
