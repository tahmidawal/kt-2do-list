"""Storing the couple's photo.

Locally the two resized copies go in static/uploads/. On Vercel the filesystem
is thrown away between requests, so they go to Vercel Blob instead — set
BLOB_READ_WRITE_TOKEN and it switches over on its own.
"""

from __future__ import annotations

import os
from io import BytesIO
from pathlib import Path
from typing import Any

import httpx
from PIL import Image, ImageOps

UPLOADS = Path(__file__).resolve().parent.parent / "static" / "uploads"

# (name, longest side in px, JPEG quality)
SIZES = (("background", 2000, 84), ("portrait", 720, 90))


class PhotoError(Exception):
    """The uploaded file wasn't usable as a photo."""


def blob_token() -> str:
    return os.environ.get("BLOB_READ_WRITE_TOKEN", "")


def using_blob() -> bool:
    return bool(blob_token())


def _renditions(data: bytes) -> list[tuple[str, bytes]]:
    """Resize once per size. Phone photos carry rotation in EXIF, so honour it."""
    try:
        image = ImageOps.exif_transpose(Image.open(BytesIO(data))).convert("RGB")
    except Exception as exc:
        raise PhotoError("That file isn't a photo I can read.") from exc

    out = []
    for name, longest_side, quality in SIZES:
        copy = image.copy()
        copy.thumbnail((longest_side, longest_side), Image.LANCZOS)
        buffer = BytesIO()
        copy.save(buffer, "JPEG", quality=quality, optimize=True, progressive=True)
        out.append((name, buffer.getvalue()))
    return out


async def save(data: bytes) -> dict[str, str]:
    """Store both sizes and return their URLs, keyed 'background' and 'portrait'."""
    renditions = _renditions(data)
    return await _to_blob(renditions) if using_blob() else _to_disk(renditions)


def _to_disk(renditions: list[tuple[str, bytes]]) -> dict[str, str]:
    UPLOADS.mkdir(parents=True, exist_ok=True)
    urls = {}
    for name, payload in renditions:
        for old in UPLOADS.glob(f"{name}.*"):
            old.unlink()
        target = UPLOADS / f"{name}.jpg"
        target.write_bytes(payload)
        urls[name] = f"/static/uploads/{target.name}"
    return urls


async def _to_blob(renditions: list[tuple[str, bytes]]) -> dict[str, str]:
    urls: dict[str, str] = {}
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
        for name, payload in renditions:
            response = await client.put(
                f"https://blob.vercel-storage.com/{name}.jpg",
                content=payload,
                headers={
                    "authorization": f"Bearer {blob_token()}",
                    "x-content-type": "image/jpeg",
                    "x-api-version": "7",
                    # Same path each time, so the new photo replaces the old one.
                    "x-add-random-suffix": "0",
                    "x-allow-overwrite": "1",
                },
            )
            if response.status_code >= 400:
                raise PhotoError(f"Couldn't store the photo ({response.status_code}).")
            body: dict[str, Any] = response.json()
            urls[name] = body.get("url", "")
    return urls
