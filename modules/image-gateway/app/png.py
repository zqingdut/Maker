"""Minimal PNG encoder -- stdlib only (zlib + struct).

We need to synthesise placeholder images without pulling in Pillow, so that the
mock stays installable from three packages.
"""

from __future__ import annotations

import hashlib
import struct
import zlib

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _chunk(tag: bytes, payload: bytes) -> bytes:
    crc = zlib.crc32(tag)
    crc = zlib.crc32(payload, crc)
    return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", crc & 0xFFFFFFFF)


def encode_png(width: int, height: int, rows: list[bytes]) -> bytes:
    """Encode 8-bit RGB rows into a PNG.

    `rows` must contain exactly `height` byte strings, each `width * 3` long.
    """
    if len(rows) != height:
        raise ValueError(f"expected {height} rows, got {len(rows)}")
    raw = bytearray()
    for row in rows:
        if len(row) != width * 3:
            raise ValueError(f"row length {len(row)} != {width * 3}")
        raw.append(0)  # filter type: None
        raw += row

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"".join(
        [
            PNG_MAGIC,
            _chunk(b"IHDR", ihdr),
            _chunk(b"IDAT", zlib.compress(bytes(raw), 6)),
            _chunk(b"IEND", b""),
        ]
    )


def _palette(seed: bytes) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    """Two harmonious colours derived from the seed."""
    digest = hashlib.sha256(seed).digest()
    hue_a = digest[0] / 255.0
    hue_b = (hue_a + 0.18 + digest[1] / 255.0 * 0.2) % 1.0

    def to_rgb(h: float, sat: float, val: float) -> tuple[int, int, int]:
        i = int(h * 6.0)
        f = h * 6.0 - i
        p, q, t = val * (1 - sat), val * (1 - f * sat), val * (1 - (1 - f) * sat)
        r, g, b = [
            (val, t, p),
            (q, val, p),
            (p, val, t),
            (p, q, val),
            (t, p, val),
            (val, p, q),
        ][i % 6]
        return int(r * 255), int(g * 255), int(b * 255)

    return to_rgb(hue_a, 0.55, 0.92), to_rgb(hue_b, 0.62, 0.58)


def placeholder_png(seed: str, width: int, height: int) -> bytes:
    """A deterministic 'identicon' banner: gradient + mirrored blocks + frame.

    Same seed and same size always produce identical bytes, which is what makes
    the deterministic mode of the mock actually verifiable in a test.
    """
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    top, bottom = _palette(seed.encode("utf-8"))
    frame_rgb = bytes((15, 23, 42))
    frame = 3

    # 5x5 grid, mirrored horizontally so it reads as an identicon.
    cols = 5
    half = (cols + 1) // 2
    block = max(8, min(width, height) // 12)
    origin_x = (width - cols * block) // 2
    origin_y = (height - cols * block) // 2

    on_cells: set[tuple[int, int]] = set()
    for cy in range(cols):
        for cx in range(half):
            if digest[(cy * half + cx) % len(digest)] & 0x80:
                on_cells.add((cx, cy))
                on_cells.add((cols - 1 - cx, cy))

    grid_right = origin_x + cols * block
    grid_bottom = origin_y + cols * block

    rows: list[bytes] = []
    for y in range(height):
        if y < frame or y >= height - frame:
            rows.append(frame_rgb * width)
            continue

        blend = y / max(1, height - 1)
        base = bytes(int(top[c] + (bottom[c] - top[c]) * blend) for c in range(3))
        row = bytearray(base * width)

        # frame columns
        row[0 : frame * 3] = frame_rgb * frame
        row[(width - frame) * 3 :] = frame_rgb * frame

        if origin_y <= y < grid_bottom:
            cy = (y - origin_y) // block
            for cx in range(cols):
                if (cx, cy) not in on_cells:
                    continue
                x0 = origin_x + cx * block
                shaded = bytes(int(c * 0.45) for c in base)
                row[x0 * 3 : (x0 + block) * 3] = shaded * block

        rows.append(bytes(row))

    return encode_png(width, height, rows)
