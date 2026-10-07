"""Downloads a generated world into a local world package folder.

The layout is specified in docs/WORLD_PACKAGE.md; change it there first.
"""

import json
import shutil
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from unpictured_pipeline.worldlabs import download

SPLAT_FILE_NAMES = {"full_res": "splats.spz", "500k": "splats_500k.spz", "100k": "splats_100k.spz"}


def source_photo_name(index: int, count: int) -> str:
    """source.jpg for a one-photo world, else source_1.jpg, source_2.jpg and so on."""
    return "source.jpg" if count == 1 else f"source_{index}.jpg"


def write_package(
    world: dict,
    destination: Path,
    *,
    source_photos: list[Path] | None = None,
    photo_azimuths: list[float] | None = None,
    operation_id: str | None = None,
    seed: int | None = None,
    credits: float | None = None,
) -> Path:
    """Builds the package in a temporary folder, then renames it, so a failed
    download never leaves a folder that looks complete."""
    if destination.exists():
        raise FileExistsError(f"{destination} already exists")
    assets = world["assets"]
    # Draft worlds come back without semantics metadata, so scale and offset can be null.
    semantics = assets["splats"].get("semantics_metadata") or {}

    staging = destination.with_name(destination.name + ".partial")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)

    files = {}
    for resolution, file_name in SPLAT_FILE_NAMES.items():
        url = assets["splats"]["spz_urls"].get(resolution)
        if url:
            download(url, staging / file_name)
            files[f"splats_{resolution}"] = file_name
    optional_urls = {
        "collider": (assets.get("mesh") or {}).get("collider_mesh_url"),
        "pano": (assets.get("imagery") or {}).get("pano_url"),
        "thumbnail": assets.get("thumbnail_url"),
    }
    for key, url in optional_urls.items():
        if url:
            file_name = key + _extension_of(url)
            download(url, staging / file_name)
            files[key] = file_name
    photos = source_photos or []
    for index, photo in enumerate(photos, start=1):
        file_name = source_photo_name(index, len(photos))
        shutil.copyfile(photo, staging / file_name)
        role = "source_photo" if len(photos) == 1 else f"source_photo_{index}"
        files[role] = file_name

    meta = {
        "package_format": "provisional-m0",
        "world_id": world["world_id"],
        "display_name": world.get("display_name"),
        "model": world.get("model"),
        "seed": seed,
        "operation_id": operation_id,
        "credits": credits,
        "created_at": world.get("created_at"),
        "downloaded_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "world_marble_url": world.get("world_marble_url"),
        "caption": assets.get("caption"),
        "frame": "marble_raw_opencv",
        "metric_scale_factor": semantics.get("metric_scale_factor"),
        "ground_plane_offset": semantics.get("ground_plane_offset"),
        # Degrees, one per photo in the order of source_photo_1, source_photo_2 and so on.
        "photo_azimuths": photo_azimuths,
        "files": files,
    }
    (staging / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    staging.rename(destination)
    return destination


def _extension_of(url: str) -> str:
    return Path(urlsplit(url).path).suffix.lower() or ".bin"
