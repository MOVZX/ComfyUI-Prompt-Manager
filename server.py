import asyncio
import json
import os
from pathlib import Path
from aiohttp import web
from server import PromptServer
from . import storage

routes = PromptServer.instance.routes


async def _json_body(request):
    """The request body parsed as JSON, or None when it is not valid JSON."""
    try:
        return await request.json()
    except json.JSONDecodeError:
        return None


_GALLERY_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
}


def _preset_summary(preset):
    # mtime of the image file: lets the frontend detect a changed image on
    # the same slug (e.g. a replaced featured image) without extra requests
    image_id = 0

    if preset.get("image"):
        path = storage.config_dir() / "images" / preset["image"]

        if path.is_file():
            image_id = path.stat().st_mtime_ns

    return {
        "name": preset["name"],
        "slug": preset.get("slug", ""),
        "prefix": preset.get("prefix", ""),
        "prompt": preset["prompt"],
        "suffix": preset.get("suffix", ""),
        "category": preset.get("category", ""),
        "tags": preset.get("tags", []),
        "has_image": bool(preset.get("image")),
        "image_id": image_id,
        "updated_at": preset.get("updated_at", ""),
    }


@routes.get("/prompt_manager/list")
async def list_presets(request):
    presets = storage.list_presets()

    return web.json_response({
        "presets": [_preset_summary(p) for p in presets],
        "categories": storage.list_categories(),
        "tags": storage.list_tags(),
        "version": storage.library_version(),
    })


@routes.get("/prompt_manager/version")
async def library_version(request):
    return web.json_response({"version": storage.library_version()})


def dashboard_page(request):
    # The manager as a standalone page: no ComfyUI frontend, just the
    # manager UI talking to the /prompt_manager API.
    path = Path(__file__).parent / "web" / "standalone.html"
    return web.Response(body=path.read_bytes(), content_type="text/html")


routes.get("/prompts")(dashboard_page)
routes.get("/prompt_manager/dashboard")(dashboard_page)


@routes.get("/prompt_manager/tags")
async def list_tags(request):
    return web.json_response(storage.list_tags())


@routes.get("/prompt_manager/categories")
async def list_categories(request):
    return web.json_response(storage.list_categories())


@routes.get("/prompt_manager/presets/{name}")
async def get_preset(request):
    preset = storage.load_preset(request.match_info["name"])

    if preset is None:
        return web.json_response({"error": "Preset not found"}, status=404)

    preset = dict(preset)
    preset["image_data"] = storage.image_data_uri(preset)

    return web.json_response(preset)


def _save_payload(data):
    # Runs off the event loop: the image decode, the library scans and the
    # file writes are blocking work
    # If copying an image from another preset, fetch it first
    image_source = data.get("image_source")
    if image_source:
        source_preset = storage.load_preset(image_source)
        if source_preset and source_preset.get("image"):
            data["image"] = storage.image_data_uri(source_preset)
        del data["image_source"]

    return storage.save_preset(data, data.get("old_slug"), replace=bool(data.get("replace")))


@routes.post("/prompt_manager/save")
async def save_preset(request):
    data = await _json_body(request)

    if not isinstance(data, dict):
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        preset = await asyncio.to_thread(_save_payload, data)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except FileNotFoundError:
        return web.json_response({"error": "Output image not found"}, status=400)
    except OSError:
        return web.json_response({"error": "Invalid image"}, status=400)

    return web.json_response({"ok": True, "preset": preset})


@routes.post("/prompt_manager/delete")
async def delete_preset(request):
    data = await _json_body(request)
    name = data.get("name") if isinstance(data, dict) else None

    if not name:
        return web.json_response({"error": "name is required"}, status=400)

    if not storage.delete_preset(name):
        return web.json_response({"error": "Preset not found"}, status=404)

    return web.json_response({"ok": True})


@routes.post("/prompt_manager/rename_category")
async def rename_category(request):
    data = await _json_body(request)

    if not isinstance(data, dict) or not data.get("name"):
        return web.json_response({"error": "name is required"}, status=400)

    try:
        changed = storage.rename_category(data["name"], data.get("new_name", ""))
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)

    return web.json_response({"ok": True, "changed": changed})


@routes.post("/prompt_manager/rename_tag")
async def rename_tag(request):
    data = await _json_body(request)

    if not isinstance(data, dict) or not data.get("tag"):
        return web.json_response({"error": "tag is required"}, status=400)

    try:
        changed = storage.rename_tag(data["tag"], data.get("new_tag", ""))
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)

    return web.json_response({"ok": True, "changed": changed})


@routes.get("/prompt_manager/image/{name}")
async def preset_image(request):
    preset = storage.load_preset(request.match_info["name"])

    if preset is None or not preset.get("image"):
        return web.Response(status=404)

    path = storage.config_dir() / "images" / preset["image"]

    if not path.is_file():
        return web.Response(status=404)

    return web.Response(body=path.read_bytes(), content_type="image/jpeg",
                        headers={"Cache-Control": "no-store"})


@routes.post("/prompt_manager/image/{name}")
async def update_preset_image(request):
    name = request.match_info["name"]
    data = await _json_body(request)

    if not isinstance(data, dict):
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    if not data.get("remove"):
        image = data.get("image")

        if not isinstance(image, str) or not image:
            return web.json_response({"error": "image (base64 or data URI) is required"}, status=400)

    try:
        preset = storage.set_preset_image(name, data.get("image"), remove=bool(data.get("remove")))
    except (ValueError, OSError):
        return web.json_response({"error": "Invalid image"}, status=400)

    if preset is None:
        return web.json_response({"error": "Preset not found"}, status=404)

    return web.json_response({"ok": True, "image": preset.get("image")})


@routes.get("/prompt_manager/gallery")
async def gallery(request):
    try:
        limit = min(max(int(request.rel_url.query.get("limit", "100")), 0), 200)
    except ValueError:
        limit = 100

    files = await asyncio.to_thread(storage.list_gallery, limit)

    return web.json_response({"files": files})


@routes.get("/prompt_manager/gallery_file")
async def gallery_file(request):
    name = request.rel_url.query.get("file", "")

    try:
        data = storage.read_gallery_file(name)
    except (FileNotFoundError, OSError, ValueError):
        return web.Response(status=404)

    mime = _GALLERY_MIME.get(os.path.splitext(name)[1].lower(), "application/octet-stream")

    return web.Response(body=data, content_type=mime, headers={"Cache-Control": "no-store"})


def _export_body(names):
    # Runs off the event loop: base64-encoding every featured image is the
    # heavy part
    bundle = storage.build_export(names)

    return json.dumps(bundle, ensure_ascii=False).encode("utf-8")


@routes.post("/prompt_manager/export")
async def export_presets(request):
    data = await _json_body(request)
    names = data.get("names") if isinstance(data, dict) else None

    if names is not None and not isinstance(names, list):
        names = None

    body = await asyncio.to_thread(_export_body, names)
    response = web.Response(body=body, content_type="application/json")

    response.headers["Content-Disposition"] = 'attachment; filename="comfyui-prompt-presets.json"'

    return response


@routes.post("/prompt_manager/import")
async def import_presets(request):
    data = await _json_body(request)

    if data is None:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    payload = data.get("payload") if isinstance(data, dict) else data

    if payload is None and isinstance(data, dict):
        payload = data

    dry_run = bool(data.get("dry_run")) if isinstance(data, dict) else False

    try:
        imported, skipped, overwritten = await asyncio.to_thread(storage.import_payload, payload, dry_run=dry_run)
    except (ValueError, json.JSONDecodeError, TypeError) as e:
        return web.json_response({"error": str(e)}, status=400)

    return web.json_response(
        {"ok": True, "imported": imported, "skipped": skipped, "overwritten": overwritten, "dry_run": dry_run}
    )
