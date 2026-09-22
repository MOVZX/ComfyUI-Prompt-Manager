from . import storage

ALL_CATEGORIES = "All Categories"
NO_PRESET = "None"


class PromptManager:
    """Holds the prompt in three editable fields - prefix, text and suffix -
    assembled in that order separated by blank lines. Pick a category (or
    "All Categories"), then a preset: the fields fill with the preset's
    parts; edit them freely afterwards. "None" leaves the fields untouched.
    When all three fields are empty, the selected preset's assembly is used.
    Outputs the assembled text.
    Presets are managed with the Prompt Manager button on this node."""

    @classmethod
    def INPUT_TYPES(cls):
        presets = storage.list_presets()
        categories = [ALL_CATEGORIES] + storage.list_categories()

        return {
            "required": {
                "category": (categories,),
                "preset": ([NO_PRESET] + [p["name"] for p in presets],),
            },
            "optional": {
                "prefix": ("STRING", {"multiline": True, "dynamicPrompts": True, "default": ""}),
                "text": ("STRING", {"multiline": True, "dynamicPrompts": True, "default": ""}),
                "suffix": ("STRING", {"multiline": True, "dynamicPrompts": True, "default": ""}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "Prompt Manager"

    def run(self, category=None, preset=None, text="", prefix="", suffix=""):
        # The three fields are the source of truth, assembled prefix -> text
        # -> suffix; the preset is the fallback when all three are empty.
        # Names may repeat across categories, so resolve by name within the
        # selected category; "All Categories" falls back to the global
        # name/slug lookup.
        parts = [str(p).strip() for p in (prefix, text, suffix)]
        out = "\n\n".join(p for p in parts if p)

        if not out and preset and preset != NO_PRESET:
            cat = "" if not category or category == ALL_CATEGORIES else str(category)
            data = storage.load_preset(preset, cat)
            out = storage.assemble_text(data) if data is not None else ""

        return (out,)
