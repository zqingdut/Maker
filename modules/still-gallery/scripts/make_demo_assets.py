#!/usr/bin/env python3
"""Generate the procedural placeholder artwork used by the gallery demo data.

Pure standard library: writes 24-bit RGB PNGs with zlib + struct, so the repo
needs no image dependencies at all.

    python3 scripts/make_demo_assets.py
"""
from __future__ import annotations

import math
import os
import random
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "public", "assets")

WIDTH, HEIGHT = 900, 675

PALETTES = {
    "greenhouse": ["#eef4ec", "#c8dcc6", "#8fb996", "#4f7d68", "#2c4a44"],
    "neon": ["#120a24", "#3b1d63", "#7a2b8f", "#e0489b", "#2ad4d4"],
    "desert": ["#f7e6cd", "#e8b98a", "#c9703f", "#8c3f2e", "#20494a"],
    "abyss": ["#04121f", "#0a2a44", "#12557a", "#28a0a8", "#8ff0d8"],
    "sunset": ["#fbe3d6", "#f2a9a0", "#c96f92", "#6d4b8f", "#2b2b57"],
    "noir": ["#0d1014", "#22303c", "#4a5b6a", "#c98a3c", "#f0d9b0"],
}


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def make_palette_lookup(stops: list[str], size: int = 512) -> list[tuple[int, int, int]]:
    colors = [hex_to_rgb(stop) for stop in stops]
    segments = len(colors) - 1
    table = []
    for index in range(size):
        position = index / (size - 1) * segments
        left = min(int(position), segments - 1)
        frac = position - left
        # smoothstep between neighbouring stops keeps banding invisible
        frac = frac * frac * (3 - 2 * frac)
        a, b = colors[left], colors[left + 1]
        table.append(
            (
                int(a[0] + (b[0] - a[0]) * frac),
                int(a[1] + (b[1] - a[1]) * frac),
                int(a[2] + (b[2] - a[2]) * frac),
            )
        )
    return table


def build_field(seed: int, grid: int = 7, octaves: int = 5) -> list[list[float]]:
    """Layered value noise, bilinearly sampled with smoothstep interpolation."""
    rng = random.Random(seed)
    field = [[0.0] * WIDTH for _ in range(HEIGHT)]
    amplitude = 1.0
    total = 0.0

    for octave in range(octaves):
        nodes = grid * (2**octave)
        layer = [[rng.random() for _ in range(nodes + 1)] for _ in range(nodes + 1)]
        scale_x = nodes / WIDTH
        scale_y = nodes / HEIGHT
        for y in range(HEIGHT):
            fy = y * scale_y
            y0 = int(fy)
            ty = fy - y0
            ty = ty * ty * (3 - 2 * ty)
            row = field[y]
            layer_a = layer[y0]
            layer_b = layer[min(y0 + 1, nodes)]
            for x in range(WIDTH):
                fx = x * scale_x
                x0 = int(fx)
                tx = fx - x0
                tx = tx * tx * (3 - 2 * tx)
                x1 = min(x0 + 1, nodes)
                top = layer_a[x0] + (layer_a[x1] - layer_a[x0]) * tx
                bottom = layer_b[x0] + (layer_b[x1] - layer_b[x0]) * tx
                row[x] += (top + (bottom - top) * ty) * amplitude
        total += amplitude
        amplitude *= 0.52

    inverse = 1.0 / total
    return [[value * inverse for value in row] for row in field]


def render(name: str, seed: int) -> bytes:
    table = make_palette_lookup(PALETTES[name])
    table_max = len(table) - 1
    field = build_field(seed)
    rng = random.Random(seed * 7919)

    # A soft directional light gives the flat noise a sense of relief.
    light_x, light_y = rng.uniform(0.25, 0.75), rng.uniform(0.15, 0.45)
    glow = rng.uniform(0.55, 0.85)

    # Pass 1 — build the scalar field (noise + relief shading + light falloff).
    values: list[list[float]] = []
    low, high = float("inf"), float("-inf")
    for y in range(HEIGHT):
        ny = y / HEIGHT
        fy = field[y]
        prev = field[max(y - 1, 0)]
        nxt = field[min(y + 1, HEIGHT - 1)]
        row = []
        for x in range(WIDTH):
            value = fy[x]
            dx = fy[min(x + 1, WIDTH - 1)] - fy[max(x - 1, 0)]
            dy = nxt[x] - prev[x]
            shade = 1.0 - (dx + dy) * 2.4

            distance = math.hypot(x / WIDTH - light_x, ny - light_y)
            falloff = max(0.0, 1.0 - distance * 1.25) ** 2
            value = value * (1.0 - glow * 0.35) + falloff * glow * 0.45
            value = max(0.0, value * shade)
            row.append(value)
            if value < low:
                low = value
            if value > high:
                high = value
        values.append(row)

    # Pass 2 — stretch to the full range so the palette's extremes actually show.
    span = (high - low) or 1.0
    rows = []
    for y in range(HEIGHT):
        row = bytearray()
        row.append(0)  # PNG filter type: none
        for value in values[y]:
            index = int((value - low) / span * table_max)
            index = 0 if index < 0 else (table_max if index > table_max else index)
            r, g, b = table[index]
            grain = rng.randint(-2, 2)
            row.append(min(255, max(0, r + grain)))
            row.append(min(255, max(0, g + grain)))
            row.append(min(255, max(0, b + grain)))
        rows.append(bytes(row))

    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    os.makedirs(ASSETS, exist_ok=True)
    for index, name in enumerate(PALETTES, start=1):
        path = os.path.join(ASSETS, f"demo-{index}.png")
        data = render(name, seed=1000 + index * 37)
        with open(path, "wb") as handle:
            handle.write(data)
        print(f"wrote {path} ({len(data) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
