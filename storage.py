import base64
import io
import json
import os
import re
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
import folder_paths
from PIL import Image, ImageOps

APP_NAME = "ComfyUI-Prompt-Manager"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
FEATURE_IMAGE_SIZE = (512, 512)
MAX_NAME_LENGTH = 64
MAX_TAG_LENGTH = 64

_lock = threading.Lock()
_migrated = False


def config_dir():
    if os.name == "nt":
        # Windows
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        # Mac
        base = Path.home() / "Library" / "Application Support"
    else:
        # GNU/Linux
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")

    root = base / APP_NAME

    (root / "presets").mkdir(parents=True, exist_ok=True)
    (root / "images").mkdir(parents=True, exist_ok=True)

    _migrate_to_folders()

    return root


def presets_dir():
    return config_dir() / "presets"


def slugify(name):
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")

    return slug or "preset"


def _category_folder_name(category):
    """Directory name for a category: the name itself, made filesystem-safe."""
    name = re.sub(r'[/\\\x00]+', "-", (category or "").strip()).strip(" .")

    if not name or name in (".", ".."):
        name = "uncategorized"

    return name


def category_dir(category):
    """Folder holding a category's presets; the presets root when no category."""
    if not (category or "").strip():
        return presets_dir()

    return presets_dir() / _category_folder_name(category)


def _preset_dirs():
    """Yield (directory, category) for the presets root and each category folder."""
    root = presets_dir()

    yield root, ""

    if root.is_dir():
        for entry in sorted(root.iterdir()):
            if entry.is_dir():
                yield entry, entry.name


def preset_file(slug, category=""):
    return category_dir(category) / (slug + ".json")


def image_file(slug):
    return config_dir() / "images" / (slug + ".jpg")


def _now():
    return datetime.now(timezone.utc).isoformat()


def _read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_json(path, data):
    tmp = path.with_name(path.name + ".tmp")

    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    tmp.replace(path)


def assemble_text(preset):
    parts = [str(preset.get(key, "")).strip() for key in ("prefix", "prompt", "suffix")]

    return "\n\n".join(p for p in parts if p)


def list_presets():
    presets = []

    for directory, category in _preset_dirs():
        if not directory.is_dir():
            continue

        for path in sorted(directory.glob("*.json")):
            try:
                preset = _read_json(path)
            except (OSError, json.JSONDecodeError):
                continue

            if not isinstance(preset, dict) or "name" not in preset or "prompt" not in preset:
                continue

            preset.setdefault("slug", path.stem)

            # The folder is the source of truth for the category; a stale key
            # left in an old file is ignored.
            preset["category"] = category

            if preset.get("image") and not (config_dir() / "images" / preset["image"]).exists():
                preset["image"] = None

            presets.append(preset)

    presets.sort(key=lambda p: str(p.get("created_at") or ""), reverse=True)

    return presets


def find_preset_by_name(name, category):
    """First preset with this name in exactly this category ("" = the
    uncategorized root). Names may repeat across categories."""
    for preset in list_presets():
        if preset["name"] == name and preset.get("category", "") == category:
            return preset

    return None


def find_preset_by_slug(slug):
    for preset in list_presets():
        if preset.get("slug") == slug:
            return preset

    return None


def load_preset(name_or_slug, category=""):
    """Load by name or slug. A name match wins over a slug match. Names may
    repeat across categories, so when `category` is given only that category
    matches by name; slugs stay globally unique."""
    if not name_or_slug:
        return None

    category = str(category or "").strip()
    by_slug = None

    for preset in list_presets():
        if preset["name"] == name_or_slug and (not category or preset.get("category", "") == category):
            return preset

        if by_slug is None and preset.get("slug") == name_or_slug:
            by_slug = preset

    return by_slug


def library_version():
    """Cheap change token: the newest mtime_ns across category dirs, preset
    files and images. Any edit, add, remove or move on disk bumps it, so the
    frontend can skip full library fetches until it changes."""
    newest = 0

    for directory, _ in _preset_dirs():
        if not directory.is_dir():
            continue
        newest = max(newest, directory.stat().st_mtime_ns)
        for path in directory.iterdir():
            if path.is_file():
                newest = max(newest, path.stat().st_mtime_ns)

    images = config_dir() / "images"

    if images.is_dir():
        newest = max(newest, images.stat().st_mtime_ns)
        for path in images.iterdir():
            if path.is_file():
                newest = max(newest, path.stat().st_mtime_ns)

    return newest


def list_categories():
    # The category folders themselves, so empty ones stay visible and can be
    # deleted (a category is its folder).
    root = presets_dir()

    if not root.is_dir():
        return []

    return sorted((e.name for e in root.iterdir() if e.is_dir()), key=str.lower)


def list_tags():
    counts = {}

    for preset in list_presets():
        for tag in preset.get("tags", []):
            tag = str(tag).strip()

            if tag:
                counts[tag] = counts.get(tag, 0) + 1

    return sorted(counts, key=str.lower)


def _iter_preset_files():
    for directory, _ in _preset_dirs():
        if not directory.is_dir():
            continue

        for path in sorted(directory.glob("*.json")):
            try:
                preset = _read_json(path)
            except (OSError, json.JSONDecodeError):
                continue

            if isinstance(preset, dict):
                yield path, preset


def rename_category(old, new):
    """Rename a category folder, or delete it when it holds no presets.

    The category is the folder name, so renaming just moves the directory and
    deleting removes it. Deleting a non-empty category is rejected. Returns the
    number of presets that moved (0 for a delete)."""
    old = str(old or "").strip()
    new = str(new or "").strip()

    if not old or old == new:
        return 0

    if len(new) > MAX_NAME_LENGTH:
        raise ValueError("Category must be at most {} characters".format(MAX_NAME_LENGTH))

    root = presets_dir()
    old_folder = root / old

    if not old_folder.is_dir():
        return 0

    with _lock:
        if not new:
            files = [e for e in old_folder.iterdir() if e.is_file()]

            if files:
                raise ValueError("Category '{}' still has {} preset(s)".format(old, len(files)))

            old_folder.rmdir()

            return 0

        new_folder = root / _category_folder_name(new)
        moved = sum(1 for e in old_folder.iterdir() if e.is_file())

        if new_folder != old_folder:
            if not new_folder.exists():
                old_folder.rename(new_folder)
            else:
                # Merging must not put two same-named presets in one folder
                # (names are unique per category).
                target_names = {p["name"] for p in list_presets() if p.get("category", "") == new_folder.name}

                for entry in old_folder.iterdir():
                    if not entry.is_file():
                        continue

                    try:
                        preset = _read_json(entry)
                    except (OSError, json.JSONDecodeError):
                        continue

                    if isinstance(preset, dict) and preset.get("name") in target_names:
                        raise ValueError("Category '{}' already contains preset '{}'".format(new_folder.name, preset["name"]))

                new_folder.mkdir(parents=True, exist_ok=True)

                for entry in old_folder.iterdir():
                    if entry.is_file():
                        entry.rename(new_folder / entry.name)

                old_folder.rmdir()

        return moved


def rename_tag(old, new):
    """Rename a tag on every preset that uses it, keeping its position in
    each tag list; an empty new name removes the tag. Returns the number of
    presets changed."""
    old = str(old or "").strip()
    new = str(new or "").strip()

    if not old or old == new:
        return 0

    if len(new) > MAX_NAME_LENGTH:
        raise ValueError("Tag must be at most {} characters".format(MAX_NAME_LENGTH))

    changed = 0

    with _lock:
        for path, preset in _iter_preset_files():
            tags = preset.get("tags") or []

            if old not in tags:
                continue

            if not new or new in tags:
                tags = [t for t in tags if t != old]
            else:
                tags = [new if t == old else t for t in tags]

            preset["tags"] = tags

            _write_json(path, preset)

            changed += 1

    return changed


def _resolve_slug(name, old_slug=None):
    """Pick a slug unique across all category folders; reuse the current one
    when re-saving the same preset."""
    base = slugify(name)
    candidate = base
    counter = 2

    while True:
        if old_slug is not None and candidate == old_slug:
            return candidate

        taken = False

        for directory, _ in _preset_dirs():
            if directory.is_dir() and (directory / (candidate + ".json")).exists():
                taken = True

                break

        if not taken:
            return candidate

        candidate = "{}-{}".format(base, counter)
        counter += 1


def encode_image(data):
    """Normalize an uploaded/output image to a small JPEG."""
    try:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))

        img.load()
    except (Image.UnidentifiedImageError, OSError) as e:
        raise ValueError("Not a valid image") from e

    if img.mode != "RGB":
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            rgba = img.convert("RGBA")
            background = Image.new("RGB", rgba.size, (255, 255, 255))

            background.paste(rgba, mask=rgba.getchannel("A"))

            img = background
        else:
            img = img.convert("RGB")

    img.thumbnail(FEATURE_IMAGE_SIZE, Image.LANCZOS)

    buf = io.BytesIO()

    img.save(buf, format="JPEG", quality=85)

    return buf.getvalue()


def image_data_uri(preset):
    if not preset.get("image"):
        return None

    path = config_dir() / "images" / preset["image"]

    if not path.exists():
        return None

    return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def set_preset_image(name_or_slug, data_uri=None, remove=False):
    """Set or remove one preset's featured image. Returns the updated preset."""
    with _lock:
        preset = load_preset(name_or_slug)

        if preset is None:
            return None

        path = preset_file(preset["slug"], preset.get("category", ""))

        if remove:
            if preset.get("image"):
                image_path = config_dir() / "images" / preset["image"]

                if image_path.exists():
                    image_path.unlink()

            preset["image"] = None
        else:
            if not data_uri:
                raise ValueError("image is required")

            data = data_uri.split(",", 1)[1] if data_uri.startswith("data:") else data_uri
            jpeg = encode_image(base64.b64decode(data))

            image_file(preset["slug"]).write_bytes(jpeg)

            preset["image"] = image_file(preset["slug"]).name

        preset.pop("category", None)  # the folder owns the category

        preset["updated_at"] = _now()

        _write_json(path, preset)

        return preset


def save_preset(data, old_slug=None, replace=False):
    name = str(data.get("name") or "").strip()

    if not name:
        raise ValueError("Name is required")

    if len(name) > MAX_NAME_LENGTH:
        raise ValueError("Name must be at most {} characters".format(MAX_NAME_LENGTH))

    prefix = str(data.get("prefix") or "")
    prompt = str(data.get("prompt") or "")
    suffix = str(data.get("suffix") or "")

    if not (prefix.strip() or prompt.strip() or suffix.strip()):
        raise ValueError("Preset is empty: prefix, prompt and suffix are all empty")

    category = str(data.get("category") or "").strip()

    if len(category) > MAX_NAME_LENGTH:
        raise ValueError("Category must be at most {} characters".format(MAX_NAME_LENGTH))

    tags = []

    for tag in data.get("tags") or []:
        tag = str(tag).strip()

        if tag and tag not in tags:
            if len(tag) > MAX_TAG_LENGTH:
                raise ValueError(
                    "Tag must be at most {} characters: '{}'".format(MAX_TAG_LENGTH, tag)
                )
            tags.append(tag)

    with _lock:
        editing = find_preset_by_slug(old_slug) if old_slug else None
        # A conflict is the same name in the same category; the same name in
        # another category is a different preset.
        same_name = find_preset_by_name(name, category)
        is_self = same_name is not None and editing is not None and same_name.get("slug") == editing.get("slug")

        if same_name is not None and not (replace or is_self):
            raise ValueError("A preset named '{}' already exists in this category".format(name))

        # Overwriting a conflicting preset replaces that record: take its
        # slug, so the write replaces its file instead of leaving two
        # presets with the same name in one category.
        conflict = same_name if (replace and editing is not None and not is_self) else None

        existing = editing if editing is not None else same_name
        slug = _resolve_slug(name, existing.get("slug") if existing else None)

        if conflict is not None:
            slug = _resolve_slug(name, conflict.get("slug"))
        folder = category_dir(category)

        folder.mkdir(parents=True, exist_ok=True)

        path = folder / (slug + ".json")
        created_at = existing.get("created_at") if existing else _now()

        # decode the new featured image up front so a bad upload fails before
        # any existing file is touched
        jpeg = None
        data_uri = data.get("image")

        if isinstance(data_uri, str) and data_uri:
            jpeg = encode_image(
                base64.b64decode(data_uri.split(",", 1)[1] if data_uri.startswith("data:") else data_uri)
            )
        elif data.get("image_output_path"):
            jpeg = encode_image(read_gallery_file(str(data["image_output_path"])))

        image = existing.get("image") if existing else None

        # move the image file to follow a changed slug
        if existing and existing.get("slug") and existing["slug"] != slug:
            old_image = image_file(existing["slug"])

            if old_image.exists():
                old_image.rename(image_file(slug))

            if image:
                image = image_file(slug).name

        preset = {
            "name": name,
            "slug": slug,
            "prefix": prefix,
            "prompt": prompt,
            "suffix": suffix,
            "tags": tags,
            "image": image,
            "created_at": created_at,
            "updated_at": _now(),
        }

        if jpeg is not None:
            preset["image"] = image_file(slug).name

            image_file(slug).write_bytes(jpeg)
        elif data.get("image_remove"):
            old_image = image_file(slug)

            if old_image.exists():
                old_image.unlink()

            preset["image"] = None

        if conflict is not None and not preset.get("image"):
            # the overwritten preset's image does not carry over
            leftover = image_file(slug)

            if leftover.exists():
                leftover.unlink()

        _write_json(path, preset)

        # remove the old file if the preset moved (slug or category changed);
        # its (possibly emptied) category folder stays and is deleted
        # explicitly via the category-delete operation
        old_path = None

        if existing and existing.get("slug"):
            old_path = preset_file(existing["slug"], str(existing.get("category") or ""))

        if old_path is not None and old_path.exists() and old_path.resolve() != path.resolve():
            old_path.unlink()

        return preset


def delete_preset(name_or_slug):
    with _lock:
        # slugs are globally unique and the API sends them, so a slug match
        # wins: a different preset's name must not shadow it
        preset = find_preset_by_slug(name_or_slug)

        if preset is None:
            preset = load_preset(name_or_slug)

        if preset is None:
            return False

        category = str(preset.get("category") or "")
        path = preset_file(preset["slug"], category)

        if path.exists():
            path.unlink()

        if preset.get("image"):
            image_path = config_dir() / "images" / preset["image"]

            if image_path.exists():
                image_path.unlink()
        # the category folder is left in place (possibly empty); it is removed
        # by the category-delete operation, which guards on it being empty

    return True


def list_gallery(limit=100):
    out_dir = Path(folder_paths.get_output_directory())

    if not out_dir.is_dir():
        return []

    files = [f for f in out_dir.iterdir() if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS]

    for sub in out_dir.iterdir():
        if sub.is_dir():
            files.extend(f for f in sub.iterdir() if f.is_file() and f.suffix.lower() in IMAGE_EXTENSIONS)

    files.sort(key=lambda f: f.stat().st_mtime, reverse=True)

    return [
        {"name": f.relative_to(out_dir).as_posix(), "size": f.stat().st_size, "mtime": f.stat().st_mtime}
        for f in files[:limit]
    ]


def read_gallery_file(name):
    out_dir = Path(folder_paths.get_output_directory()).resolve()
    path = (out_dir / name).resolve()

    if not path.is_relative_to(out_dir) or not path.is_file():
        raise FileNotFoundError(name)

    return path.read_bytes()


def build_export(names=None):
    presets = list_presets()

    if names is not None:
        wanted = set(names)
        presets = [p for p in presets if p["name"] in wanted or p.get("slug") in wanted]

    exported = []

    for preset in presets:
        item = dict(preset)
        item["image_data"] = image_data_uri(preset)

        exported.append(item)

    return {
        "format": "comfyui-prompt-manager",
        "version": 1,
        "exported_at": _now(),
        "presets": exported,
    }


def _import_check(item):
    """Preflight one import item with save_preset's validation rules.
    Raises ValueError for an item the save would skip."""
    name = str(item.get("name") or "").strip()

    if not name:
        raise ValueError("Name is required")

    if len(name) > MAX_NAME_LENGTH:
        raise ValueError("Name must be at most {} characters".format(MAX_NAME_LENGTH))

    if not (
        str(item.get("prefix") or "").strip()
        or str(item.get("prompt") or "").strip()
        or str(item.get("suffix") or "").strip()
    ):
        raise ValueError("Preset is empty: prefix, prompt and suffix are all empty")

    category = str(item.get("category") or "").strip()

    if len(category) > MAX_NAME_LENGTH:
        raise ValueError("Category must be at most {} characters".format(MAX_NAME_LENGTH))

    for tag in item.get("tags") or []:
        tag = str(tag).strip()

        if tag and len(tag) > MAX_TAG_LENGTH:
            raise ValueError("Tag must be at most {} characters: '{}'".format(MAX_TAG_LENGTH, tag))


def import_payload(payload, dry_run=False):
    """Import a bundle dict, a list of presets, or a single preset dict.
    Returns (imported, skipped, overwritten). With dry_run nothing is
    written: the lists predict what a real import would do."""
    if isinstance(payload, str):
        payload = json.loads(payload)

    if isinstance(payload, dict) and isinstance(payload.get("presets"), list):
        items = payload["presets"]
    elif isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict) and ("prompt" in payload or "prefix" in payload):
        items = [payload]
    else:
        raise ValueError("Unrecognized import format")

    imported = []
    skipped = []
    overwritten = []
    seen = set()

    for index, item in enumerate(items):
        label = str(item.get("name") or "item {}".format(index + 1)) if isinstance(item, dict) else "item {}".format(index + 1)

        if not isinstance(item, dict):
            skipped.append(label)

            continue

        try:
            _import_check(item)
        except ValueError:
            skipped.append(label)

            continue

        name = str(item.get("name") or "").strip()
        category = str(item.get("category") or "").strip()
        is_overwrite = find_preset_by_name(name, category) is not None or (category, name) in seen

        if dry_run:
            (overwritten if is_overwrite else imported).append(name)
            seen.add((category, name))

            continue

        payload = {
            "name": item.get("name"),
            "prefix": item.get("prefix"),
            "prompt": item.get("prompt"),
            "suffix": item.get("suffix"),
            "category": item.get("category"),
            "tags": item.get("tags"),
        }

        image_data = item.get("image_data") or item.get("image")

        if isinstance(image_data, str) and image_data:
            try:
                raw = base64.b64decode(image_data.split(",", 1)[1] if image_data.startswith("data:") else image_data)

                encode_image(raw)  # validate before the save so a bad image doesn't drop the preset

                payload["image"] = image_data
            except Exception:
                pass

        try:
            preset = save_preset(payload, replace=True)
        except ValueError:
            skipped.append(label)

            continue

        imported.append(preset["name"])

        if is_overwrite:
            overwritten.append(preset["name"])
        seen.add((category, name))

    return imported, skipped, overwritten


def _migrate_to_folders():
    """Move flat preset files into their category folder and drop the now-
    useless "category" key from the JSON. Idempotent; runs once on first use."""
    global _migrated

    if _migrated:
        return

    _migrated = True
    root = presets_dir()

    if not root.is_dir():
        return

    for path in sorted(root.glob("*.json")):
        try:
            preset = _read_json(path)
        except (OSError, json.JSONDecodeError):
            continue

        if not isinstance(preset, dict):
            continue

        category = str(preset.pop("category", "") or "").strip()

        if category:
            folder = category_dir(category)
            folder.mkdir(parents=True, exist_ok=True)
            dest = folder / path.name
            path.rename(dest)
            path = dest

        _write_json(path, preset)  # persists with the category key removed
