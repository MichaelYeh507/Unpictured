import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from unpictured_pipeline import locate
from unpictured_pipeline.cli import main

VECTORS_PATH = Path(__file__).parents[2] / "tests" / "camera_vectors.json"
VECTORS = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


def textured_pano(seed: int) -> np.ndarray:
    """A 1024 x 512 panorama of smooth random shapes, so views have edges to match."""
    rng = np.random.default_rng(seed)
    layers = []
    for cells in (16, 64):
        small = Image.fromarray((rng.random((cells // 2, cells)) * 255).astype(np.uint8))
        layers.append(np.asarray(small.resize((1024, 512), Image.Resampling.BICUBIC), float))
    return ((layers[0] + layers[1]) / 510).astype(np.float32)


def photo_from(pano: np.ndarray, yaw: float, pitch: float, hfov: float) -> Image.Image:
    view = locate.render_view(pano, yaw, pitch, hfov, (640, 480))
    return Image.fromarray((view * 255).astype(np.uint8))


def write_package(folder: Path, pano: np.ndarray, photos: list[Image.Image], azimuths) -> Path:
    folder.mkdir(parents=True)
    Image.fromarray((pano * 255).astype(np.uint8)).save(folder / "pano.png")
    files = {"pano": "pano.png"}
    for index, photo in enumerate(photos, start=1):
        name = "source.jpg" if len(photos) == 1 else f"source_{index}.jpg"
        photo.save(folder / name, quality=95)
        files["source_photo" if len(photos) == 1 else f"source_photo_{index}"] = name
    meta = {"frame": "marble_raw_opencv", "photo_azimuths": azimuths, "files": files}
    (folder / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return folder


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda case: case["label"])
def test_rays_turn_as_the_shared_vectors_say(case):
    turned = locate.rotate_ray(case["yaw"], case["pitch"], *case["ray"])

    assert [float(value) for value in turned] == pytest.approx(case["raw"], abs=1e-6)


def test_views_sample_the_panorama_where_the_camera_points():
    # Each panorama pixel holds its own column (or row), so a view shows where it sampled.
    rows, columns = np.mgrid[0:180, 0:360].astype(np.float32)

    def sampled(pano, yaw, pitch):
        return locate.render_view(pano, yaw, pitch, 60, (21, 21))

    assert sampled(columns, 0, 0)[10, 10] == pytest.approx(180, abs=1)  # ahead: middle column
    assert sampled(columns, 90, 0)[10, 10] == pytest.approx(270, abs=1)  # right: 3/4 across
    assert sampled(rows, 0, 30)[10, 10] == pytest.approx(60, abs=1)  # 30 up: row 90 - 30
    assert sampled(rows, 0, 0)[0, 10] == pytest.approx(61, abs=1)  # top edge: about 29 up
    assert sampled(columns, 0, 0)[10, 0] == pytest.approx(152, abs=1)  # left edge: about 28 left
    behind = sampled(columns, 180, 0)[10, 10]
    assert behind < 2 or behind > 357  # straight behind wraps around the seam


def test_finds_a_photo_cut_from_a_known_place_across_the_seam():
    pano = textured_pano(seed=1)
    photo = photo_from(pano, yaw=355, pitch=-8, hfov=75)

    found = locate.locate_photo(pano, photo, yaw_center=0)

    assert found.yaw == pytest.approx(355, abs=0.5)  # reported as 355, not -5
    assert found.pitch == pytest.approx(-8, abs=0.5)
    assert found.hfov == pytest.approx(75, abs=1)
    assert found.score > 0.8


def test_locate_writes_one_camera_per_photo(tmp_path, capsys):
    pano = textured_pano(seed=2)
    photos = [photo_from(pano, 3, -5, 80), photo_from(pano, 184, -10, 70)]
    package = write_package(tmp_path / "worlds" / "room", pano, photos, [0, 180])

    assert main(["locate", "--name", "room", "--worlds-dir", str(tmp_path / "worlds")]) == 0

    camera_file = json.loads((package / "camera.json").read_text(encoding="utf-8"))
    assert camera_file["frame"] == "marble_raw_opencv"
    first, second = camera_file["cameras"]
    assert first["photo"] == "source_1.jpg" and second["photo"] == "source_2.jpg"
    assert (first["yaw_deg"], first["pitch_deg"]) == pytest.approx((3, -5), abs=0.5)
    assert (second["yaw_deg"], second["pitch_deg"]) == pytest.approx((184, -10), abs=0.5)
    assert second["hfov_deg"] == pytest.approx(70, abs=1)
    assert first["position"] == [0, 0, 0]
    assert first["image_size"] == [640, 480]
    assert (first["cx"], first["cy"]) == (320, 240)
    focal = 320 / np.tan(np.radians(first["hfov_deg"]) / 2)
    assert first["fx"] == first["fy"] == pytest.approx(focal, abs=0.01)
    assert first["vfov_deg"] == pytest.approx(np.degrees(2 * np.arctan(240 / focal)), abs=0.01)
    output = capsys.readouterr()
    assert "source_2.jpg: turned 184" in output.out
    assert "warning" not in output.err


def test_a_photo_that_is_not_in_the_panorama_gets_a_warning(tmp_path, capsys):
    pano = textured_pano(seed=3)
    elsewhere = photo_from(textured_pano(seed=4), 0, 0, 80)
    write_package(tmp_path / "worlds" / "room", pano, [elsewhere], None)

    assert main(["locate", "--name", "room", "--worlds-dir", str(tmp_path / "worlds")]) == 0

    assert "source.jpg matched weakly" in capsys.readouterr().err


def small_package(tmp_path: Path) -> Path:
    pano = textured_pano(seed=5)
    return write_package(tmp_path / "worlds" / "room", pano, [photo_from(pano, 0, 0, 80)], None)


def run_locate(tmp_path: Path) -> int:
    return main(["locate", "--name", "room", "--worlds-dir", str(tmp_path / "worlds")])


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"files": {"pano": "pano.png"}}, "has no source photo"),
        ({"files": {"source_photo": "source.jpg"}}, "has no panorama"),
        ({"photo_azimuths": [0, 180]}, "lists 1 photos but 2 azimuths"),
        ({"files": None}, "meta.json has no files"),
        ({"photo_azimuths": 5}, "photo_azimuths must be a list of numbers"),
        ({"files": {"pano": "../pano.png"}}, "files.pano is not a plain file name"),
    ],
)
def test_incomplete_packages_are_refused(tmp_path, capsys, change, message):
    package = small_package(tmp_path)
    meta = json.loads((package / "meta.json").read_text(encoding="utf-8"))
    (package / "meta.json").write_text(json.dumps({**meta, **change}), encoding="utf-8")

    assert run_locate(tmp_path) == 1

    assert message in capsys.readouterr().err
    assert not (package / "camera.json").exists()


def test_unreadable_meta_json_is_a_clean_error(tmp_path, capsys):
    package = small_package(tmp_path)
    (package / "meta.json").write_text("{ not json", encoding="utf-8")

    assert run_locate(tmp_path) == 1

    assert "could not read room/meta.json" in capsys.readouterr().err


@pytest.mark.parametrize("broken", ["missing", "corrupt"])
def test_unreadable_images_are_a_clean_error(tmp_path, capsys, broken):
    package = small_package(tmp_path)
    if broken == "missing":
        (package / "pano.png").unlink()
    else:
        (package / "source.jpg").write_bytes(b"not an image")

    assert run_locate(tmp_path) == 1

    assert "could not read an image in room" in capsys.readouterr().err
    assert not (package / "camera.json").exists()


def test_missing_package_is_refused(tmp_path, capsys):
    assert main(["locate", "--name", "nowhere", "--worlds-dir", str(tmp_path)]) == 1

    assert "has no meta.json" in capsys.readouterr().err
