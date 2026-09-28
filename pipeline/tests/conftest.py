"""A local fake of the World API, built from the documented request and response shapes.

It proves the code matches our reading of the docs, not that the docs match the real API.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import pytest

from unpictured_pipeline import cli


class FakeWorldApi:
    def __init__(self):
        self.base_url = ""
        self.requests: list[tuple[str, str, dict]] = []
        self.generate_bodies: list[dict] = []
        self.uploads: dict[str, bytes] = {}
        self.fail_generation = False
        self._operation_polls = 0

    def paths(self) -> list[str]:
        return [f"{method} {path}" for method, path, _ in self.requests]

    def world(self) -> dict:
        files = f"{self.base_url}/files"
        return {
            "world_id": "world-1",
            "display_name": "kitchen-photo-draft",
            "model": "marble-1.0-draft",
            "world_marble_url": "https://marble.worldlabs.ai/world/world-1",
            "assets": {
                "caption": "A small kitchen.",
                "thumbnail_url": f"{files}/thumb.webp?signature=secret",
                "imagery": {"pano_url": f"{files}/pano.png?signature=secret"},
                "mesh": {"collider_mesh_url": f"{files}/collider.glb?signature=secret"},
                "splats": {
                    "spz_urls": {
                        "full_res": f"{files}/full.spz?signature=secret",
                        "500k": f"{files}/500k.spz?signature=secret",
                        "100k": f"{files}/100k.spz?signature=secret",
                    },
                    "semantics_metadata": {"metric_scale_factor": 1.5, "ground_plane_offset": 0.8},
                },
            },
        }

    def route(self, method: str, path: str, body: bytes) -> tuple[int, bytes | dict]:
        if (method, path) == ("GET", "/marble/v1/credits"):
            return 200, {"remaining_credits": 6250}
        if (method, path) == ("POST", "/marble/v1/media-assets:prepare_upload"):
            return 200, {
                "media_asset": {"media_asset_id": "asset-1", "file_name": "photo.jpg"},
                "upload_info": {
                    "upload_url": f"{self.base_url}/upload/asset-1?signature=secret",
                    "upload_method": "PUT",
                    "required_headers": {"x-goog-content-length-range": "0,1048576000"},
                },
            }
        if (method, path) == ("PUT", "/upload/asset-1"):
            self.uploads["asset-1"] = body
            return 200, b""
        if (method, path) == ("POST", "/marble/v1/worlds:generate"):
            self.generate_bodies.append(json.loads(body))
            return 200, {"operation_id": "op-1", "done": False}
        if (method, path) == ("GET", "/marble/v1/operations/op-1"):
            return 200, self._next_operation_state()
        if (method, path) == ("GET", "/marble/v1/worlds/world-1"):
            return 200, self.world()
        if method == "GET" and path.startswith("/files/"):
            return 200, b"fake " + path.removeprefix("/files/").encode()
        return 404, {"detail": "not found"}

    def _next_operation_state(self) -> dict:
        self._operation_polls += 1
        if self._operation_polls == 1:
            progress = {"status": "IN_PROGRESS", "description": "World generation in progress"}
            return {"operation_id": "op-1", "done": False, "metadata": {"progress": progress}}
        if self.fail_generation:
            error = {"code": 13, "message": "generation failed"}
            return {"operation_id": "op-1", "done": True, "error": error}
        cost = {"total_credits": 230, "line_items": [{"name": "Draft world", "credits": 230}]}
        return {"operation_id": "op-1", "done": True, "response": self.world(), "cost": cost}


def make_handler(fake: FakeWorldApi) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self._respond()

        def do_POST(self):
            self._respond()

        def do_PUT(self):
            self._respond()

        def _respond(self):
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            path = urlsplit(self.path).path
            headers = {name.lower(): value for name, value in self.headers.items()}
            fake.requests.append((self.command, path, headers))
            status, payload = fake.route(self.command, path, body)
            data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    return Handler


@pytest.fixture
def fake_api(monkeypatch):
    fake = FakeWorldApi()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(fake))
    fake.base_url = f"http://127.0.0.1:{server.server_address[1]}"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("WLT_API_KEY", "test-key")
    monkeypatch.setenv("UNPICTURED_API_BASE_URL", fake.base_url)
    monkeypatch.delenv("UNPICTURED_DAILY_CAP_USD", raising=False)
    monkeypatch.setattr(cli, "POLL_SECONDS", 0)
    yield fake
    server.shutdown()
    server.server_close()


@pytest.fixture
def photo(tmp_path):
    path = tmp_path / "Kitchen Photo.jpg"
    path.write_bytes(b"\xff\xd8 stand-in for a real JPEG")
    return path
