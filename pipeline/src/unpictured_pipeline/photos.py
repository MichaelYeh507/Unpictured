"""Prepares a photo for upload: upright, and without metadata (phones often embed GPS)."""

from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

JPEG_QUALITY = 95


class PhotoError(Exception):
    pass


def write_clean_copy(photo: Path, destination: Path) -> Path:
    """Saves an upright JPEG of `photo` with no EXIF, XMP or comments. Keeps the colour profile."""
    try:
        with Image.open(photo) as image:
            color_profile = image.info.get("icc_profile")
            upright = ImageOps.exif_transpose(image).convert("RGB")
    except UnidentifiedImageError:
        raise PhotoError(f"{photo.name} is not an image this tool can read") from None
    upright.info = {}
    upright.save(destination, "JPEG", quality=JPEG_QUALITY, icc_profile=color_profile)
    return destination
