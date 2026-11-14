"""Where the mock's image bytes come from.

Two variants:

  captured     the real 1184x864 PNG lifted out of re.txt (C2PA-signed by Google).
               Highest fidelity: it is byte-for-byte what the real service returned
               for the captured prompt. It is a fixed size, so `width`/`height` in
               the response always report its real dimensions.
  placeholder  a deterministic identicon synthesised at the size mapped from the
               requested aspect, so you can exercise every aspect ratio.
"""

from __future__ import annotations

import functools
import pathlib
import struct

from .png import placeholder_png

ASSETS_DIR = pathlib.Path(__file__).resolve().parent.parent / "assets"
CAPTURED_PATH = ASSETS_DIR / "captured-generated.png"

CAPTURED_SOURCE = "captured"
PLACEHOLDER_SOURCE = "placeholder"


class ImageSourceError(RuntimeError):
    pass


@functools.lru_cache(maxsize=1)
def _load_captured() -> bytes:
    if not CAPTURED_PATH.exists():
        raise ImageSourceError(
            f"missing {CAPTURED_PATH}. Run: python scripts/extract_capture.py"
        )
    return CAPTURED_PATH.read_bytes()


def png_dimensions(data: bytes) -> tuple[int, int]:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ImageSourceError("not a PNG")
    return struct.unpack(">II", data[16:24])


@functools.lru_cache(maxsize=64)
def _placeholder(seed: str, width: int, height: int) -> bytes:
    return placeholder_png(seed, width, height)


class Rendered:
    """The bytes the mock hands back, plus the truth about them."""

    __slots__ = ("data", "mime", "width", "height", "source")

    def __init__(self, data: bytes, mime: str, width: int, height: int, source: str):
        self.data = data
        self.mime = mime
        self.width = width
        self.height = height
        self.source = source

    @property
    def size(self) -> int:
        return len(self.data)


def render(variant: str, seed: str, width: int, height: int) -> Rendered:
    if variant == CAPTURED_SOURCE:
        data = _load_captured()
        w, h = png_dimensions(data)
        return Rendered(data, "image/png", w, h, CAPTURED_SOURCE)

    if variant == PLACEHOLDER_SOURCE:
        data = _placeholder(seed, width, height)
        return Rendered(data, "image/png", width, height, PLACEHOLDER_SOURCE)

    raise ImageSourceError(f"unknown variant: {variant}")


def captured_metadata() -> dict:
    data = _load_captured()
    w, h = png_dimensions(data)
    return {
        "path": str(CAPTURED_PATH),
        "width": w,
        "height": h,
        "bytes": len(data),
        "c2pa": b"caBX" in data[:16384],
    }
