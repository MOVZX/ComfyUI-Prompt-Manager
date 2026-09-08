import base64
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
COMFYUI_ROOT = REPO_ROOT.parents[1]

sys.path.insert(0, str(COMFYUI_ROOT))  # folder_paths
sys.path.insert(0, str(REPO_ROOT))  # storage

from PIL import Image

import storage


def make_image_uri(size=(10, 10), color=(200, 30, 30)):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


class StorageTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._old_xdg = os.environ.get("XDG_CONFIG_HOME")
        os.environ["XDG_CONFIG_HOME"] = self._tmp.name

    def tearDown(self):
        if self._old_xdg is None:
            os.environ.pop("XDG_CONFIG_HOME", None)
        else:
            os.environ["XDG_CONFIG_HOME"] = self._old_xdg
        self._tmp.cleanup()

    def _fresh_dir(self):
        """Point the config dir at a new empty folder inside the temp area."""
        new_dir = Path(self._tmp.name) / "fresh"
        new_dir.mkdir(exist_ok=True)
        os.environ["XDG_CONFIG_HOME"] = str(new_dir)

    def save(self, name, prompt="a prompt", category="", **kw):
        data = {"name": name, "prompt": prompt, "category": category}
        data.update(kw)
        return storage.save_preset(data)

    # ---------- naming ----------
    def test_slugify(self):
        self.assertEqual(storage.slugify("Hello World"), "hello-world")
        self.assertEqual(storage.slugify("a/b  c"), "a-b-c")
        self.assertEqual(storage.slugify("???"), "preset")

    def test_category_folder_name(self):
        self.assertEqual(storage._category_folder_name("a/b\\c"), "a-b-c")
        self.assertEqual(storage._category_folder_name("   "), "uncategorized")
        self.assertEqual(storage._category_folder_name(".."), "uncategorized")
        self.assertEqual(storage._category_folder_name("Cat."), "Cat")

    # ---------- save / list ----------
    def test_save_and_list(self):
        p = self.save("Dune Sunset", category="Landscape")
        self.assertEqual(p["slug"], "dune-sunset")
        listed = storage.list_presets()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["category"], "Landscape")
        self.assertEqual(listed[0]["name"], "Dune Sunset")

    def test_empty_preset_rejected(self):
        with self.assertRaises(ValueError):
            storage.save_preset({"name": "Empty", "prefix": "", "prompt": "   ", "suffix": ""})

    def test_tag_too_long_rejected(self):
        with self.assertRaises(ValueError):
            storage.save_preset({"name": "Bad", "prompt": "x", "tags": ["t" * 65]})

    def test_list_skips_invalid_files(self):
        root = storage.presets_dir()
        root.mkdir(parents=True, exist_ok=True)
        (root / "broken.json").write_text("{not json", encoding="utf-8")
        (root / "notapreset.json").write_text(json.dumps({"hello": 1}), encoding="utf-8")
        self.assertEqual(storage.list_presets(), [])

    # ---------- name / slug uniqueness ----------
    def test_same_name_same_category_conflict(self):
        self.save("Twins", category="Cat A")
        with self.assertRaises(ValueError):
            self.save("Twins", category="Cat A")
        # replace=True overwrites the same record, no second file
        p = storage.save_preset({"name": "Twins", "prompt": "new", "category": "Cat A"}, replace=True)
        self.assertEqual(len(storage.list_presets()), 1)
        self.assertEqual(p["prompt"], "new")

    def test_same_name_other_category_gets_slug_suffix(self):
        a = self.save("Twins", category="Cat A")
        b = self.save("Twins", category="Cat B")
        self.assertEqual(a["slug"], "twins")
        self.assertEqual(b["slug"], "twins-2")

    def test_resave_keeps_slug_and_created_at(self):
        p = self.save("Keep Slug")
        again = storage.save_preset({"name": "Keep Slug", "prompt": "v2"}, old_slug=p["slug"])
        self.assertEqual(again["slug"], p["slug"])
        self.assertEqual(again["created_at"], p["created_at"])
        self.assertEqual(len(storage.list_presets()), 1)

    # ---------- images ----------
    def test_image_saved_and_moved_on_rename(self):
        p = self.save("With Image", image=make_image_uri())
        self.assertTrue(p["image"])
        old_path = storage.config_dir() / "images" / p["image"]
        self.assertTrue(old_path.exists())

        renamed = storage.save_preset({"name": "Renamed Image", "prompt": "x"}, old_slug=p["slug"])
        self.assertNotEqual(renamed["slug"], p["slug"])
        self.assertTrue(storage.image_file(renamed["slug"]).exists())
        self.assertFalse(old_path.exists())
        self.assertEqual(renamed["image"], storage.image_file(renamed["slug"]).name)
        self.assertEqual(len(storage.list_presets()), 1)

    def test_image_remove(self):
        p = self.save("Img", image=make_image_uri())
        self.assertTrue(p["image"])
        out = storage.set_preset_image(p["slug"], remove=True)
        self.assertIsNone(out["image"])
        self.assertFalse(storage.image_file(p["slug"]).exists())

    def test_bad_image_rejected(self):
        with self.assertRaises(ValueError):
            self.save("Nope", image="data:image/jpeg;base64," + base64.b64encode(b"not an image").decode())

    # ---------- delete ----------
    def test_delete_preset(self):
        p = self.save("Bye", image=make_image_uri())
        self.assertTrue(storage.delete_preset(p["slug"]))
        self.assertFalse(storage.preset_file(p["slug"], "").exists())
        self.assertFalse(storage.image_file(p["slug"]).exists())
        self.assertFalse(storage.delete_preset("does-not-exist"))

    # ---------- categories / tags ----------
    def test_rename_category(self):
        self.save("Move Me", category="Old")
        moved = storage.rename_category("Old", "New")
        self.assertEqual(moved, 1)
        self.assertEqual(storage.find_preset_by_slug("move-me")["category"], "New")

        # a non-empty category cannot be deleted
        with self.assertRaises(ValueError):
            storage.rename_category("New", "")

        storage.delete_preset("move-me")
        self.assertEqual(storage.rename_category("New", ""), 0)
        self.assertNotIn("New", storage.list_categories())

    def test_rename_tag(self):
        self.save("Tagged A", tags=["light", "indoor"])
        self.save("Tagged B", tags=["light"])
        self.assertEqual(storage.rename_tag("light", "studio"), 2)
        self.assertEqual(storage.find_preset_by_slug("tagged-a")["tags"], ["studio", "indoor"])
        self.assertEqual(storage.rename_tag("studio", ""), 2)
        self.assertEqual(storage.find_preset_by_slug("tagged-a")["tags"], ["indoor"])

    # ---------- export / import ----------
    def test_export_import_roundtrip(self):
        self.save("Round Trip", category="Cat", tags=["t1"], image=make_image_uri())
        self.save("Plain")
        bundle = storage.build_export()
        self.assertEqual(len(bundle["presets"]), 2)

        self._fresh_dir()
        imported, skipped, overwritten = storage.import_payload(bundle)
        self.assertEqual(len(imported), 2)
        self.assertEqual(skipped, [])
        self.assertEqual(overwritten, [])

        listed = {p["name"]: p for p in storage.list_presets()}
        self.assertEqual(listed["Round Trip"]["category"], "Cat")
        self.assertTrue(listed["Round Trip"]["image"])
        self.assertTrue((storage.config_dir() / "images" / listed["Round Trip"]["image"]).exists())

        # re-importing the same bundle overwrites instead of duplicating
        imported, skipped, overwritten = storage.import_payload(bundle)
        self.assertEqual(len(imported), 2)
        self.assertEqual(len(overwritten), 2)
        self.assertEqual(len(storage.list_presets()), 2)

    def test_import_dry_run_writes_nothing(self):
        self.save("Existing", category="Cat")
        items = [
            {"name": "Existing", "prompt": "v2", "category": "Cat"},
            {"name": "Fresh", "prompt": "v1", "category": "Cat"},
            {"prompt": "no name"},
        ]
        imported, skipped, overwritten = storage.import_payload(items, dry_run=True)
        self.assertEqual(imported, ["Fresh"])
        self.assertEqual(overwritten, ["Existing"])
        self.assertEqual(skipped, ["item 3"])

        # nothing changed on disk
        self.assertEqual(len(storage.list_presets()), 1)
        self.assertEqual(storage.find_preset_by_slug("existing")["prompt"], "a prompt")

    def test_import_bundle_and_single_shapes(self):
        self._fresh_dir()
        bundle = {"format": "comfyui-prompt-manager", "version": 1, "presets": [
            {"name": "One", "prompt": "p1"},
            {"name": "Two", "prompt": "p2"},
        ]}
        self.assertEqual(len(storage.import_payload(bundle)[0]), 2)
        self._fresh_dir()
        self.assertEqual(len(storage.import_payload({"name": "Solo", "prompt": "p"})[0]), 1)
        with self.assertRaises(ValueError):
            storage.import_payload({"unexpected": 1})

    # ---------- version token ----------
    def test_library_version_bumps(self):
        v1 = storage.library_version()
        self.save("Bump")
        self.assertGreater(storage.library_version(), v1)
        v2 = storage.library_version()
        self.assertEqual(storage.library_version(), v2)


if __name__ == "__main__":
    unittest.main()
