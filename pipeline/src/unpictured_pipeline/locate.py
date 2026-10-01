"""Finds where each source photo sits in its world, and writes the package's camera.json.

Marble builds a world around one 360-degree panorama (pano.png). The matcher cuts flat views
out of the panorama for many directions, tilts and fields of view, and keeps the view whose
edges correlate best with the photo's edges.
"""

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

PANO_WIDTH = 2048  # the panorama is scaled to this width before matching
COARSE_WIDTH = 80  # photo width in pixels for the first, wide search
FINE_WIDTH = 160  # and for the two finer searches around the best coarse match
# Measured 2026-10-01: real photos matched at 0.62 to 0.87, the same photos searched in the
# wrong place at 0.18 to 0.23, and random noise at 0.05.
WEAK_MATCH_SCORE = 0.4


class LocateError(Exception):
    pass


@dataclass(frozen=True)
class Placement:
    yaw: float  # degrees turned right from straight ahead (+z toward +x)
    pitch: float  # degrees tilted up
    hfov: float  # horizontal field of view in degrees
    score: float  # edge correlation; 1.0 is a perfect match


def rotate_ray(yaw: float, pitch: float, x, y, z):
    """Turns camera rays (x right, y down, z forward) into the raw splat frame: tilt up by
    pitch, then turn right by yaw. Works on numbers and arrays (tests/camera_vectors.json)."""
    tilt, turn = np.radians(pitch), np.radians(yaw)
    y, z = y * np.cos(tilt) - z * np.sin(tilt), y * np.sin(tilt) + z * np.cos(tilt)
    x, z = x * np.cos(turn) + z * np.sin(turn), -x * np.sin(turn) + z * np.cos(turn)
    return x, y, z


def render_view(pano: np.ndarray, yaw: float, pitch: float, hfov: float, size) -> np.ndarray:
    """A pinhole view of size (width, height) cut from an equirectangular panorama whose
    middle column looks straight ahead and whose top row looks straight up."""
    width, height = size
    focal = (width / 2) / np.tan(np.radians(hfov) / 2)
    u, v = np.meshgrid(np.arange(width) + 0.5, np.arange(height) + 0.5)
    x = (u - width / 2) / focal
    y = (v - height / 2) / focal
    x, y, z = rotate_ray(yaw, pitch, x, y, np.ones_like(x))
    longitude = np.arctan2(x, z)  # 0 ahead, positive to the right
    latitude = np.arctan2(-y, np.hypot(x, z))  # positive up
    pano_height, pano_width = pano.shape
    columns = ((longitude / (2 * np.pi) + 0.5) * pano_width).astype(np.int64) % pano_width
    rows = ((0.5 - latitude / np.pi) * pano_height).astype(np.int64)
    return pano[np.clip(rows, 0, pano_height - 1), columns]


def load_pano(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        gray = image.convert("L").resize((PANO_WIDTH, PANO_WIDTH // 2), Image.Resampling.LANCZOS)
    # A slight blur, because views sample the nearest panorama pixel.
    return _as_float(gray.filter(ImageFilter.GaussianBlur(1)))


def locate_photo(pano: np.ndarray, photo: Image.Image, yaw_center: float) -> Placement:
    """Searches 40 degrees either side of yaw_center, then twice more around the best match."""
    coarse = _edges(_as_float(_shrink(photo, COARSE_WIDTH)))
    fine = _edges(_as_float(_shrink(photo, FINE_WIDTH)))
    best = _search(
        pano,
        coarse,
        yaws=np.arange(yaw_center - 40, yaw_center + 40.1, 4),
        pitches=np.arange(-24, 24.1, 4),
        hfovs=np.arange(30, 130.1, 5),
    )
    for step in (1.0, 0.25):
        nearby = step * np.arange(-4, 5)
        best = _search(pano, fine, best.yaw + nearby, best.pitch + nearby, best.hfov + nearby)
    return Placement(best.yaw % 360, best.pitch, best.hfov, best.score)


def write_camera_file(package: Path) -> list[dict]:
    """Locates every source photo listed in the package's meta.json and writes camera.json."""
    meta = json.loads((package / "meta.json").read_text(encoding="utf-8"))
    files = meta.get("files", {})
    photos = _source_photos(files)
    azimuths = meta.get("photo_azimuths") or [0.0] * len(photos)
    if not photos:
        raise LocateError(f"{package.name} has no source photo; fetch it again with --photo")
    if len(azimuths) != len(photos):
        raise LocateError(f"meta.json lists {len(photos)} photos but {len(azimuths)} azimuths")
    if "pano" not in files:
        raise LocateError(f"{package.name} has no panorama to match against")

    pano = load_pano(package / files["pano"])
    cameras = []
    for file_name, azimuth in zip(photos, azimuths, strict=True):
        with Image.open(package / file_name) as photo:
            placement = locate_photo(pano, photo, azimuth)
            cameras.append(_camera_entry(file_name, placement, photo.size))
    camera_file = {
        "format": "provisional-m0",
        "frame": "marble_raw_opencv",
        "convention": (
            "Rays use the frame's axes (x right, y down, z forward). Pitch tilts the camera "
            "up first, then yaw turns it right from +z toward +x. position is where the "
            "panorama was taken, assumed to be the world's origin."
        ),
        "cameras": cameras,
    }
    text = json.dumps(camera_file, indent=2) + "\n"
    (package / "camera.json").write_text(text, encoding="utf-8")
    return cameras


def _source_photos(files: dict) -> list[str]:
    """source.jpg for a one-photo world, else source_photo_1, source_photo_2 and so on."""
    if "source_photo" in files:
        return [files["source_photo"]]
    photos = []
    while f"source_photo_{len(photos) + 1}" in files:
        photos.append(files[f"source_photo_{len(photos) + 1}"])
    return photos


def _camera_entry(file_name: str, placement: Placement, size: tuple[int, int]) -> dict:
    width, height = size
    hfov = round(placement.hfov, 2)
    focal = (width / 2) / np.tan(np.radians(hfov) / 2)
    vfov = np.degrees(2 * np.arctan((height / 2) / focal))
    return {
        "photo": file_name,
        "position": [0.0, 0.0, 0.0],
        "yaw_deg": round(placement.yaw, 2),
        "pitch_deg": round(placement.pitch, 2),
        "hfov_deg": hfov,
        "vfov_deg": round(float(vfov), 2),
        "image_size": [width, height],
        "fx": round(float(focal), 2),
        "fy": round(float(focal), 2),
        "cx": width / 2,
        "cy": height / 2,
        "match_score": round(placement.score, 3),
    }


def _search(pano, photo_edges, yaws, pitches, hfovs) -> Placement:
    height, width = photo_edges.shape
    best = Placement(0.0, 0.0, 0.0, -1.0)
    for yaw in yaws:
        for pitch in pitches:
            for hfov in hfovs:
                view = render_view(pano, yaw, pitch, hfov, (width, height))
                score = _correlation(_edges(view), photo_edges)
                if score > best.score:
                    best = Placement(float(yaw), float(pitch), float(hfov), score)
    return best


def _shrink(photo: Image.Image, width: int) -> Image.Image:
    height = max(1, round(width * photo.height / photo.width))
    return photo.convert("L").resize((width, height), Image.Resampling.LANCZOS)


def _as_float(image: Image.Image) -> np.ndarray:
    return np.asarray(image, dtype=np.float32) / 255


def _edges(image: np.ndarray) -> np.ndarray:
    # Edges rather than brightness, so exposure differences between photo and panorama matter less.
    rows, columns = np.gradient(image)
    return np.hypot(rows, columns)


def _correlation(a: np.ndarray, b: np.ndarray) -> float:
    a = a - a.mean()
    b = b - b.mean()
    return float((a * b).sum() / (np.sqrt((a * a).sum() * (b * b).sum()) + 1e-9))
