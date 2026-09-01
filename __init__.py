from . import server  # noqa: F401  registers /prompt_manager API routes
from .prompt_manager import PromptManager

NODE_CLASS_MAPPINGS = {
    "PromptManager": PromptManager,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptManager": "Prompt Manager",
}

WEB_DIRECTORY = "web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
