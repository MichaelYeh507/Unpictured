"""Downloads a generated world into a local world package folder.

The layout is provisional until docs/WORLD_PACKAGE.md is written at the end of M0.
"""

import json
import shutil
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from unpictured_pipeline.worldlabs import download

SPLAT_FILE_NAMES = {"full_res": "splats.spz", "500k": "splats_500k.spz", "100k": "splats_100k.spz"}


def write_package(
    world: dict,
    destination: Path,
    *,
    source_photo: Path | None = None,
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
    if source_photo is not None:
        file_name = "source" + source_photo.suffix.lower()
        shutil.copyfile(source_photo, staging / file_name)
        files["source_photo"] = file_name

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
        "files": files,
    }
    (staging / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    staging.rename(destination)
    return destination


def _extension_of(url: str) -> str:
    return Path(urlsplit(url).path).suffix.lower() or ".bin"
