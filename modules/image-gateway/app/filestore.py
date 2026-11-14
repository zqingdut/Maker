"""Content-addressed store for re-hosted images.

The id *is* the sha256 of the bytes, which buys three things for free:

  * identical images collapse to one file, so a repeated prompt costs one disk
    copy and one upstream call at most (the caller sees `cached: true`)
  * a URL is immutable, so it can carry a one-year `Cache-Control` and an ETag
    that never needs revalidating
  * there is nothing to keep in sync -- no database, no index to corrupt

Writes are atomic (temp file + `os.replace`), so a crash mid-write can never
leave a half-written PNG behind a valid-looking URL.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import struct
import time
from dataclasses import dataclass

#: Only these are ever written or served. Anything else is refused outright.
MIME_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
}
EXTENSION_MIMES = {v: k for k, v in MIME_EXTENSIONS.items()}

#: A file id is a hex digest, optionally with a known extension. Nothing else --
#: this is what stops `/files/../../etc/passwd` from being a thing.
ID_RE = re.compile(r"^(?P<digest>[0-9a-f]{16,64})(?P<ext>\.[a-z0-9]{2,5})?$")

MAGIC_BY_MIME = {
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"\xff\xd8\xff": "image/jpeg",
    b"GIF87a": "image/gif",
    b"GIF89a": "image/gif",
}


class FileStoreError(RuntimeError):
    pass


@dataclass
class StoredFile:
    file_id: str
    path: pathlib.Path
    meta: dict

    @property
    def mime(self) -> str:
        return self.meta.get("mimeType", "application/octet-stream")

    @property
    def size(self) -> int:
        return int(self.meta.get("size", 0))


def sniff_mime(data: bytes, declared: str | None) -> str:
    """Trust the magic bytes, not the header.

    We can detect every format we support, so a declared type we cannot confirm
    is a *mismatch* rather than a format we are unable to sniff -- and it is
    refused. Falling back to the header would let an upstream that says
    `image/png` and sends HTML have those bytes stored, and later served, under
    an image content type.
    """
    for magic, mime in MAGIC_BY_MIME.items():
        if data.startswith(magic):
            return mime
    if data[4:12] == b"ftypavif":
        return "image/avif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"

    declared_type = (declared or "").split(";")[0].strip()
    if declared_type in MIME_EXTENSIONS:
        raise FileStoreError(f"declared {declared_type} but the bytes are not that format")
    raise FileStoreError("unrecognised image format")


def image_dimensions(data: bytes) -> tuple[int, int] | None:
    """Read width/height out of an image header, or None if we cannot tell.

    Worth doing locally because the origin is not obliged to report dimensions
    and, for a real generation, does not: the response carried the image and
    nothing else, so the envelope went out without `width`/`height` even though
    the bytes were right there. Reading the header costs a few microseconds and
    makes the envelope complete whatever shape the origin replied in.

    Only the formats `sniff_mime` accepts are attempted; anything else is None
    rather than an exception, because this is decoration, not validation.
    """
    try:
        if data.startswith(b"\x89PNG\r\n\x1a\n") and data[12:16] == b"IHDR":
            # magic(8) + length(4) + "IHDR"(4), then two big-endian uint32.
            width, height = struct.unpack(">II", data[16:24])
            return (width, height) if width and height else None

        if data[:6] in (b"GIF87a", b"GIF89a"):
            # Logical screen descriptor: two little-endian uint16 right after the
            # version string.
            width, height = struct.unpack("<HH", data[6:10])
            return (width, height) if width and height else None

        if data.startswith(b"\xff\xd8\xff"):
            return _jpeg_dimensions(data)

        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return _webp_dimensions(data)
    except (struct.error, IndexError):
        return None
    return None


def _jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    """Walk JPEG segments to the start-of-frame, which carries the size."""
    offset = 2
    end = len(data)
    while offset + 9 < end:
        if data[offset] != 0xFF:
            return None
        marker = data[offset + 1]
        # Fill bytes and standalone markers carry no length.
        if marker in (0xFF, 0x01) or 0xD0 <= marker <= 0xD9:
            offset += 2
            continue
        (length,) = struct.unpack(">H", data[offset + 2 : offset + 4])
        if length < 2:
            return None
        # SOF0-SOF15, excluding the non-frame markers in that range.
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height, width = struct.unpack(">HH", data[offset + 5 : offset + 9])
            return (width, height) if width and height else None
        offset += 2 + length
    return None


def _webp_dimensions(data: bytes) -> tuple[int, int] | None:
    """Three container variants, each storing the size differently."""
    chunk = data[12:16]
    if chunk == b"VP8X":
        # 24-bit little-endian, stored as (width-1, height-1).
        width = int.from_bytes(data[24:27], "little") + 1
        height = int.from_bytes(data[27:30], "little") + 1
        return (width, height)
    if chunk == b"VP8 ":
        # Lossy: 14-bit dimensions inside the keyframe header.
        width = int.from_bytes(data[26:28], "little") & 0x3FFF
        height = int.from_bytes(data[28:30], "little") & 0x3FFF
        return (width, height) if width and height else None
    if chunk == b"VP8L":
        # Lossless: 14 bits each, packed across four bytes after the signature.
        bits = int.from_bytes(data[21:25], "little")
        width = (bits & 0x3FFF) + 1
        height = ((bits >> 14) & 0x3FFF) + 1
        return (width, height)
    return None


def digest_id(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:32]


class FileStore:
    def __init__(self, root: pathlib.Path):
        self.root = pathlib.Path(root)

    # --- writing --------------------------------------------------------
    def put(self, data: bytes, declared_mime: str | None = None, meta: dict | None = None) -> tuple[StoredFile, bool]:
        """Store bytes; returns (file, already_existed)."""
        mime = sniff_mime(data, declared_mime)
        extension = MIME_EXTENSIONS[mime]
        file_id = digest_id(data)

        self.root.mkdir(parents=True, exist_ok=True)
        target = self.root / f"{file_id}{extension}"
        meta_path = self.root / f"{file_id}.json"

        existed = target.exists()

        record = {
            "id": file_id,
            "mimeType": mime,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "storedAt": _iso_now(),
        }
        record.update(meta or {})

        if not existed:
            _atomic_write(target, data)
        # Meta is refreshed even on a hit: a later call may know the prompt that
        # the first one did not.
        _atomic_write(meta_path, json.dumps(record, ensure_ascii=False).encode("utf-8"))

        return StoredFile(f"{file_id}{extension}", target, record), existed

    # --- reading --------------------------------------------------------
    def resolve(self, name: str) -> StoredFile | None:
        """Map a URL path segment to a file, refusing anything outside the store."""
        match = ID_RE.match(name)
        if not match:
            return None
        digest = match.group("digest")
        extension = match.group("ext")

        if extension:
            candidates = [self.root / f"{digest}{extension}"]
        else:
            candidates = [self.root / f"{digest}{ext}" for ext in MIME_EXTENSIONS.values()]

        for path in candidates:
            if not path.is_file():
                continue
            try:
                path.resolve().relative_to(self.root.resolve())
            except ValueError:
                return None  # belt and braces; ID_RE already rules this out
            meta = self._read_meta(digest)
            meta.setdefault("mimeType", EXTENSION_MIMES.get(path.suffix, "application/octet-stream"))
            meta.setdefault("size", path.stat().st_size)
            return StoredFile(path.name, path, meta)
        return None

    def _read_meta(self, digest: str) -> dict:
        meta_path = self.root / f"{digest}.json"
        if not meta_path.is_file():
            return {"id": digest}
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"id": digest}

    def stats(self) -> dict:
        if not self.root.is_dir():
            return {"dir": str(self.root), "files": 0, "bytes": 0}
        files = [p for p in self.root.iterdir() if p.suffix in EXTENSION_MIMES]
        return {
            "dir": str(self.root),
            "files": len(files),
            "bytes": sum(p.stat().st_size for p in files),
        }

    def list(self, limit: int = 50) -> list[dict]:
        """Metadata for the most recent images, newest first.

        Reads the `.json` sidecars rather than the images: the sidecar is what
        carries the prompt and the upstream id, which is the interesting part.
        A sidecar with no image next to it is skipped, so a half-written entry
        never shows up in a listing.

        One directory scan, partitioned -- probing five extensions per digest
        instead would mean five stat calls per record for no benefit.
        """
        if not self.root.is_dir():
            return []

        images: set[str] = set()
        sidecars: list[pathlib.Path] = []
        for entry in self.root.iterdir():
            if entry.suffix in EXTENSION_MIMES:
                images.add(entry.stem)
            elif entry.suffix == ".json":
                sidecars.append(entry)

        records: list[dict] = []
        for meta_path in sidecars:
            if meta_path.stem not in images:
                continue
            try:
                record = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(record, dict):
                continue
            record.setdefault("id", meta_path.stem)
            records.append(record)

        records.sort(key=lambda r: str(r.get("storedAt") or ""), reverse=True)
        return records[: max(1, limit)]

    def delete(self, name: str) -> bool:
        """Remove one stored image and its sidecar. Returns False if absent.

        Content-addressed storage means the same bytes may be referenced by more
        than one record, so this is only ever called with an explicit id.
        """
        stored = self.resolve(name)
        if stored is None:
            return False
        stored.path.unlink(missing_ok=True)
        (self.root / f"{stored.path.stem}.json").unlink(missing_ok=True)
        return True


def _atomic_write(path: pathlib.Path, data: bytes) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def _iso_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def etag_for(file: StoredFile) -> str:
    digest = file.meta.get("sha256") or file.path.stem
    return f'"{digest[:32]}"'


def last_modified(file: StoredFile) -> str:
    stamp = file.meta.get("storedAt") or _iso_now()
    # HTTP-date, e.g. Wed, 23 Sep 2026 09:51:14 GMT
    try:
        from email.utils import format_datetime
        from datetime import datetime

        parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        return format_datetime(parsed, usegmt=True)
    except ValueError:
        from email.utils import formatdate

        return formatdate(time.time(), usegmt=True)
