import io
import json

import pytest
from PIL import Image

from unpictured_pipeline import cli, worldlabs
from unpictured_pipeline.cli import main
from unpictured_pipeline.worldlabs import WorldLabsClient

GENERATE_PATH = "/marble/v1/worlds:generate"
PACKAGE_FILES = [
    "collider.glb",
    "meta.json",
    "pano.png",
    "source.jpg",
    "splats.spz",
    "splats_100k.spz",
    "splats_500k.spz",
    "thumbnail.webp",
]


def read_cost_log(path):
    lines = path.read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines]


def test_dry_run_spends_nothing(fake_api, photo, tmp_path, cost_log, capsys):
    worlds = tmp_path / "worlds"

    assert main(["generate", str(photo), "--worlds-dir", str(worlds)]) == 0

    output = capsys.readouterr().out
    assert "230 credits ($0.18)" in output
    assert f"Log:     {cost_log}" in output
    assert "Dry run: nothing was spent" in output
    assert fake_api.paths() == ["GET /marble/v1/credits"]
    assert not worlds.exists()


def test_generate_writes_package_and_logs_cost(fake_api, photo, tmp_path, cost_log):
    worlds = tmp_path / "worlds"

    assert main(["generate", str(photo), "--worlds-dir", str(worlds), "--yes"]) == 0

    package = worlds / "kitchen-photo-draft"
    assert sorted(path.name for path in package.iterdir()) == PACKAGE_FILES
    assert (package / "splats.spz").read_bytes() == b"fake full.spz"
    assert (package / "source.jpg").read_bytes() == fake_api.uploads["asset-1"]

    request = fake_api.generate_bodies[0]
    assert request["model"] == "marble-1.0-draft"
    assert request["permission"]["public"] is False
    assert request["world_prompt"]["is_pano"] is False
    assert request["world_prompt"]["image_prompt"] == {
        "source": "media_asset",
        "media_asset_id": "asset-1",
    }

    meta = json.loads((package / "meta.json").read_text(encoding="utf-8"))
    assert meta["world_id"] == "world-1"
    assert meta["display_name"] == "kitchen-photo-draft"
    assert meta["model"] == "marble-1.0-draft"
    assert meta["seed"] == request["seed"]
    assert meta["frame"] == "marble_raw_opencv"
    assert meta["metric_scale_factor"] == 1.5
    assert meta["ground_plane_offset"] == 0.8
    assert meta["credits"] == 230

    events = [(entry["event"], entry["credits"]) for entry in read_cost_log(cost_log)]
    assert events == [("started", 230), ("settled", 230)]


def test_world_without_semantics_metadata_gets_null_scale_and_offset(fake_api, photo, tmp_path):
    fake_api.semantics = None  # what a real draft world returned
    worlds = tmp_path / "worlds"

    assert main(["generate", str(photo), "--worlds-dir", str(worlds), "--yes"]) == 0

    meta = json.loads((worlds / "kitchen-photo-draft" / "meta.json").read_text(encoding="utf-8"))
    assert meta["metric_scale_factor"] is None
    assert meta["ground_plane_offset"] is None


def test_download_failure_after_billing_prints_the_free_fetch_command(
    fake_api, photo, tmp_path, cost_log, capsys
):
    fake_api.fail_downloads = True
    worlds = tmp_path / "worlds"

    assert main(["generate", str(photo), "--worlds-dir", str(worlds), "--yes"]) == 1

    error = capsys.readouterr().err
    assert "HTTP 503" in error
    assert "secret" not in error  # signed URL queries stay out of messages
    assert "fetch --world world-1 --name kitchen-photo-draft --photo" in error
    assert f'--worlds-dir "{worlds}"' in error
    assert not (worlds / "kitchen-photo-draft").exists()
    assert [entry["event"] for entry in read_cost_log(cost_log)] == ["started", "settled"]


def test_poll_failure_after_the_start_prints_the_free_fetch_command(
    fake_api, photo, tmp_path, capsys
):
    fake_api.broken["/marble/v1/operations/op-1"] = "unavailable"
    worlds = tmp_path / "worlds"

    assert main(["generate", str(photo), "--worlds-dir", str(worlds), "--yes"]) == 1

    error = capsys.readouterr().err
    assert "HTTP 503" in error
    assert "Do not run generate again" in error
    assert "fetch --operation op-1 --name kitchen-photo-draft" in error


def test_ctrl_c_while_waiting_prints_the_free_fetch_command(
    fake_api, photo, tmp_path, monkeypatch, capsys
):
    def press_ctrl_c(_seconds):
        raise KeyboardInterrupt

    monkeypatch.setattr(cli.time, "sleep", press_ctrl_c)

    assert main(["generate", str(photo), "--worlds-dir", str(tmp_path / "w"), "--yes"]) == 130

    assert "fetch --operation op-1 --name kitchen-photo-draft" in capsys.readouterr().err


@pytest.mark.parametrize(
    "failure",
    ["server error", "moved", "dropped", "not json", "no operation id", "not an object"],
)
def test_start_without_a_clear_answer_is_logged_as_unconfirmed(
    fake_api, photo, tmp_path, cost_log, capsys, failure
):
    fake_api.broken[GENERATE_PATH] = failure
    worlds = tmp_path / "worlds"

    assert main(["generate", str(photo), "--worlds-dir", str(worlds), "--yes"]) == 1

    assert "may have started anyway" in capsys.readouterr().err
    entries = [(entry["event"], entry["credits"]) for entry in read_cost_log(cost_log)]
    assert entries == [("unconfirmed", 230)]


def test_ctrl_c_during_the_start_is_logged_as_unconfirmed(
    fake_api, photo, tmp_path, cost_log, monkeypatch, capsys
):
    def press_ctrl_c(*_args):
        raise KeyboardInterrupt

    monkeypatch.setattr(WorldLabsClient, "start_generation", press_ctrl_c)
    worlds = tmp_path / "worlds"

    assert main(["generate", str(photo), "--worlds-dir", str(worlds), "--yes"]) == 130

    assert "may have started anyway" in capsys.readouterr().err
    assert [entry["event"] for entry in read_cost_log(cost_log)] == ["unconfirmed"]


def test_refused_start_is_not_logged(fake_api, photo, tmp_path, cost_log, capsys):
    fake_api.broken[GENERATE_PATH] = "refused"
    worlds = tmp_path / "worlds"

    assert main(["generate", str(photo), "--worlds-dir", str(worlds), "--yes"]) == 1

    assert "HTTP 400" in capsys.readouterr().err
    assert not cost_log.exists()


def test_invalid_name_is_refused_before_any_call(fake_api, photo, tmp_path, capsys):
    worlds = ["--worlds-dir", str(tmp_path / "w")]

    assert main(["generate", str(photo), "--name", "living room?", "--yes", *worlds]) == 1
    assert main(["fetch", "--world", "world-1", "--name", "Living-Room", *worlds]) == 1

    assert capsys.readouterr().err.count("--name") == 2
    assert fake_api.requests == []


def test_uploads_an_upright_copy_without_metadata(fake_api, photo, tmp_path):
    assert main(["generate", str(photo), "--worlds-dir", str(tmp_path / "w"), "--yes"]) == 0

    with Image.open(io.BytesIO(fake_api.uploads["asset-1"])) as uploaded:
        assert uploaded.format == "JPEG"
        assert uploaded.size == (30, 40)  # the rotate-90 flag was applied to the pixels
        assert len(uploaded.getexif()) == 0  # no GPS, no orientation, nothing
        assert "xmp" not in uploaded.info
        assert "comment" not in uploaded.info


def test_heic_photo_is_refused_with_a_hint(fake_api, tmp_path, capsys):
    heic = tmp_path / "IMG_0001.HEIC"
    heic.write_bytes(b"not decodable here")

    assert main(["generate", str(heic), "--worlds-dir", str(tmp_path / "w")]) == 1

    assert "convert HEIC photos to JPG first" in capsys.readouterr().err
    assert fake_api.requests == []


def test_api_key_is_sent_only_to_the_api(fake_api, photo, tmp_path):
    assert main(["generate", str(photo), "--worlds-dir", str(tmp_path / "w"), "--yes"]) == 0

    storage_requests = 0
    for _method, path, headers in fake_api.requests:
        if path.startswith("/marble/"):
            assert headers.get("wlt-api-key") == "test-key"
        else:
            assert "wlt-api-key" not in headers
            storage_requests += 1
    assert storage_requests == 7  # one upload and six downloads


def test_api_key_is_not_sent_on_a_redirect(fake_api, tmp_path, capsys):
    fake_api.redirect_worlds = True
    command = ["fetch", "--world", "world-1", "--name", "kitchen"]

    assert main([*command, "--worlds-dir", str(tmp_path / "w")]) == 1

    assert "HTTP 302" in capsys.readouterr().err
    assert fake_api.paths() == ["GET /marble/v1/worlds/world-1"]


def test_daily_cap_blocks_generation_before_any_paid_call(
    fake_api, photo, tmp_path, monkeypatch, capsys
):
    monkeypatch.setenv("UNPICTURED_DAILY_CAP_USD", "0.10")

    assert main(["generate", str(photo), "--worlds-dir", str(tmp_path / "w"), "--yes"]) == 1

    assert "over the $0.10 daily cap" in capsys.readouterr().err
    assert fake_api.paths() == ["GET /marble/v1/credits"]


def test_daily_cap_counts_spending_from_every_worlds_folder(
    fake_api, photo, tmp_path, monkeypatch, capsys
):
    assert main(["generate", str(photo), "--worlds-dir", str(tmp_path / "a"), "--yes"]) == 0
    monkeypatch.setenv("UNPICTURED_DAILY_CAP_USD", "0.30")

    assert main(["generate", str(photo), "--worlds-dir", str(tmp_path / "b"), "--yes"]) == 1

    assert "would bring today's spend to $0.37" in capsys.readouterr().err


def test_cost_log_defaults_to_the_home_folder(tmp_path, monkeypatch):
    monkeypatch.delenv("UNPICTURED_COST_LOG")
    monkeypatch.setenv("HOME", str(tmp_path))  # Path.home() on Linux and macOS
    monkeypatch.setenv("USERPROFILE", str(tmp_path))  # and on Windows

    assert cli.cost_log_path() == tmp_path / ".unpictured" / "cost_log.jsonl"

    monkeypatch.setenv("UNPICTURED_COST_LOG", " ~/costs.jsonl ")
    assert cli.cost_log_path() == tmp_path / "costs.jsonl"


def test_relative_cost_log_is_refused(monkeypatch):
    # A relative path would give each working folder its own daily total.
    monkeypatch.setenv("UNPICTURED_COST_LOG", "costs.jsonl")

    with pytest.raises(cli.UsageError, match="absolute path"):
        cli.cost_log_path()


def test_failed_generation_leaves_no_package(fake_api, photo, tmp_path, cost_log, capsys):
    fake_api.fail_generation = True
    worlds = tmp_path / "worlds"

    assert main(["generate", str(photo), "--worlds-dir", str(worlds), "--yes"]) == 1

    error = capsys.readouterr().err
    assert "Generation failed (code 13)" in error
    assert "fetch" not in error  # nothing to download
    assert not worlds.exists()
    assert [entry["event"] for entry in read_cost_log(cost_log)] == ["started"]


def test_fetch_downloads_an_existing_world_for_free(fake_api, tmp_path, cost_log):
    worlds = tmp_path / "worlds"

    assert (
        main(["fetch", "--world", "world-1", "--name", "kitchen", "--worlds-dir", str(worlds)]) == 0
    )

    meta = json.loads((worlds / "kitchen" / "meta.json").read_text(encoding="utf-8"))
    assert meta["world_id"] == "world-1"
    assert fake_api.paths()[0] == "GET /marble/v1/worlds/world-1"
    assert "POST /marble/v1/worlds:generate" not in fake_api.paths()
    assert not cost_log.exists()


@pytest.mark.parametrize(
    ("reply", "message"),
    [("dropped", "No response from GET"), ("not json", "Unreadable reply from GET")],
)
def test_broken_reply_is_a_clean_error(fake_api, tmp_path, capsys, reply, message):
    fake_api.broken["/marble/v1/worlds/world-1"] = reply
    command = ["fetch", "--world", "world-1", "--name", "kitchen"]

    assert main([*command, "--worlds-dir", str(tmp_path / "w")]) == 1

    assert message in capsys.readouterr().err


def test_truncated_download_is_an_error(fake_api, tmp_path, capsys):
    fake_api.broken["/files/500k.spz"] = "truncated"
    worlds = tmp_path / "worlds"
    command = ["fetch", "--world", "world-1", "--name", "kitchen"]

    assert main([*command, "--worlds-dir", str(worlds)]) == 1

    assert "stopped after 21 of 121 bytes" in capsys.readouterr().err
    assert not (worlds / "kitchen").exists()


def test_download_dropped_mid_file_is_a_clean_error(fake_api, tmp_path, monkeypatch, capsys):
    def drop_connection(*_args):
        raise ConnectionResetError("connection reset by peer")

    monkeypatch.setattr(worldlabs.shutil, "copyfileobj", drop_connection)
    command = ["fetch", "--world", "world-1", "--name", "kitchen"]

    assert main([*command, "--worlds-dir", str(tmp_path / "w")]) == 1

    assert "connection reset by peer" in capsys.readouterr().err


def test_fetch_by_operation_downloads_the_full_world(fake_api, tmp_path, cost_log):
    worlds = tmp_path / "worlds"
    command = ["fetch", "--operation", "op-1", "--name", "kitchen", "--worlds-dir", str(worlds)]

    assert main(command) == 0

    package = worlds / "kitchen"
    assert (package / "pano.png").exists()
    meta = json.loads((package / "meta.json").read_text(encoding="utf-8"))
    assert meta["model"] == "marble-1.0-draft"
    assert meta["credits"] == 230
    assert [entry["event"] for entry in read_cost_log(cost_log)] == ["settled"]


def test_fetch_by_operation_logs_a_settled_cost_only_once(fake_api, photo, tmp_path, cost_log):
    worlds = tmp_path / "worlds"
    assert main(["generate", str(photo), "--worlds-dir", str(worlds), "--yes"]) == 0
    command = ["fetch", "--operation", "op-1", "--name", "again", "--worlds-dir", str(worlds)]

    assert main(command) == 0

    events = [entry["event"] for entry in read_cost_log(cost_log)]
    assert events == ["started", "settled"]
    meta = json.loads((worlds / "again" / "meta.json").read_text(encoding="utf-8"))
    assert meta["credits"] == 230


def test_missing_api_key_is_reported_without_calling_the_api(fake_api, monkeypatch, capsys):
    monkeypatch.delenv("WLT_API_KEY")

    assert main(["credits"]) == 1

    assert "WLT_API_KEY is not set" in capsys.readouterr().err
    assert fake_api.requests == []
