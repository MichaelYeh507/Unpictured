"""A small client for the World Labs World API: https://docs.worldlabs.ai/api"""

import http.client
import json
import shutil
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

API_BASE_URL = "https://api.worldlabs.ai"
USER_AGENT = "unpictured-pipeline"


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """urllib copies every header to a redirect target, so the API key would follow it."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # urllib then raises the 3xx as an HTTPError


_API_OPENER = urllib.request.build_opener(_RefuseRedirects)
_ASSET_OPENER = urllib.request.build_opener()


class WorldLabsError(Exception):
    """A request failed. `status` is the HTTP status, or None when no response arrived."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class WorldLabsClient:
    def __init__(self, api_key: str, base_url: str = API_BASE_URL, timeout_seconds: float = 60):
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds

    def get_credits(self) -> float:
        return self._call("GET", "/marble/v1/credits")["remaining_credits"]

    def upload_image(self, photo: Path) -> str:
        """Uploads a local image as a media asset and returns its media_asset_id."""
        prepared = self._call(
            "POST",
            "/marble/v1/media-assets:prepare_upload",
            {"file_name": photo.name, "kind": "image", "extension": photo.suffix.lstrip(".")},
        )
        upload_info = prepared["upload_info"]
        headers = {"User-Agent": USER_AGENT, **(upload_info.get("required_headers") or {})}
        request = urllib.request.Request(
            upload_info["upload_url"],
            data=photo.read_bytes(),
            method=upload_info["upload_method"],
            headers=headers,
        )
        _open(request, self._timeout_seconds, _ASSET_OPENER).close()
        return prepared["media_asset"]["media_asset_id"]

    def start_generation(
        self, media_asset_id: str, model: str, display_name: str, seed: int
    ) -> dict:
        body = {
            "display_name": display_name[:64],
            "model": model,
            "seed": seed,
            "permission": {"public": False, "allow_id_access": False},
            "world_prompt": {
                "type": "image",
                "image_prompt": {"source": "media_asset", "media_asset_id": media_asset_id},
                "is_pano": False,
            },
        }
        return self._call("POST", "/marble/v1/worlds:generate", body)

    def get_operation(self, operation_id: str) -> dict:
        return self._call("GET", f"/marble/v1/operations/{operation_id}")

    def get_world(self, world_id: str) -> dict:
        return self._call("GET", f"/marble/v1/worlds/{world_id}")

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        headers = {"WLT-Api-Key": self._api_key, "User-Agent": USER_AGENT}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        request = urllib.request.Request(
            self._base_url + path, data=data, method=method, headers=headers
        )
        with _open(request, self._timeout_seconds, _API_OPENER) as response:
            try:
                return json.load(response)
            except (OSError, http.client.HTTPException, ValueError) as error:
                raise WorldLabsError(f"Unreadable reply from {method} {path}: {error}") from None


def download(url: str, destination: Path, timeout_seconds: float = 300) -> None:
    """Downloads a world asset from its CDN URL. Asset hosts never receive the API key."""
    partial = destination.with_name(destination.name + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    source = _without_query(url)
    with _open(request, timeout_seconds, _ASSET_OPENER) as response, partial.open("wb") as file:
        try:
            shutil.copyfileobj(response, file)
        except (OSError, http.client.HTTPException) as error:
            raise WorldLabsError(f"Download of {source} failed: {error}") from None
        # urllib returns a short file without an error when the connection closes early.
        expected = response.headers.get("Content-Length")
        if expected is not None and file.tell() != int(expected):
            raise WorldLabsError(
                f"Download of {source} stopped after {file.tell():,} of {int(expected):,} bytes"
            )
    partial.replace(destination)


def _open(
    request: urllib.request.Request,
    timeout_seconds: float,
    opener: urllib.request.OpenerDirector,
):
    try:
        return opener.open(request, timeout=timeout_seconds)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:500]
        raise WorldLabsError(
            f"HTTP {error.code} from {request.get_method()} {_without_query(request.full_url)}: "
            f"{detail}",
            status=error.code,
        ) from None
    except (OSError, http.client.HTTPException) as error:
        # URLError, timeouts, and dropped connections (which urllib leaves unwrapped).
        raise WorldLabsError(
            f"No response from {request.get_method()} {_without_query(request.full_url)}: {error}"
        ) from None


def _without_query(url: str) -> str:
    # Signed upload URLs carry credentials in the query string.
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"
