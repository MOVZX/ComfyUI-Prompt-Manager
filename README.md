# ComfyUI Prompt Manager

A single node for saving, loading, importing and exporting prompt presets.

Each preset stores a **prefix**, **prompt** and **suffix** (assembled into the
final text, separated by blank lines), a **category**, **tags**, and an
optional **featured image**. Each preset is a plain JSON file named after its
slug, and **each category is its own folder** — the folder name is the
category, so the JSON files carry no category field of their own:
`Sitting on a bed` in category `Poses` → `presets/Poses/sitting-on-a-bed.json`.

## Storage

| OS      | Location                                               |
| ------- | ------------------------------------------------------ |
| Linux   | `~/.config/ComfyUI-Prompt-Manager`                     |
| Windows | `%LOCALAPPDATA%\ComfyUI-Prompt-Manager`                |
| macOS   | `~/Library/Application Support/ComfyUI-Prompt-Manager` |

```
ComfyUI-Prompt-Manager/
├── presets/
│   ├── loose-preset.json           # preset without a category
│   └── Poses/                      # one folder per category
│       └── sitting-on-a-bed.json   # preset data
└── images/sitting-on-a-bed.jpg     # featured image (max 512px, JPEG)
```

Renaming a category renames its folder; a category can only be deleted when
its folder is empty. Flat files from earlier versions migrate automatically on
load.

Presets can also be edited directly on disk (text editor, git): the UI polls a
cheap version token (newest file mtime) and refreshes itself automatically
within about a second of any change on disk.

## Node

**Prompt Manager** (menu category: `Prompt Manager`)

Inputs:

| Input              | Description                                                                           |
| ------------------ | ------------------------------------------------------------------------------------- |
| `category`         | Dropdown, A–Z. "All Categories" shows every preset.                                   |
| `preset`           | Dropdown, A–Z, filtered by the selected category. "None" leaves the fields untouched. |
| `prefix` / `text` / `suffix` | Editable fields. Selecting a preset fills them; edit freely afterwards. |

Behavior:

- The three fields are the source of truth: they are assembled
  prefix → text → suffix (separated by blank lines) into the output.
- Only when all three are empty is the selected preset assembled as the
  fallback.
- The node follows the manager: selecting a preset fills the fields, and
  while you have not edited them yourself, later edits to that preset's
  text or featured image in the manager update the node automatically.
- The node resizes freely: prefix, text and suffix share the lower area in
  a 3:10:3 ratio, and the featured-image cover fills up to 30% of the node
  height below them. The image is drawn at its natural aspect ratio (auto
  width, no crop), centered, with the standard 4px bottom padding.
- The `Cover` dropdown (Show/Hide, remembered per browser) toggles the image.

Buttons:

- The **Prompt Manager** button opens the preset manager.
- The **Save Preset** button opens the editor with the node's current fields,
  ready to save as a preset; when the fields still match the selected preset,
  that preset opens instead.

Outputs:

| Output   | Description    |
| -------- | -------------- |
| `STRING` | The text as-is |

## Manager

- **Full page mode**: open `http://localhost:8188/prompt_manager/dashboard` (or the "Full page" button in the header) to view the manager as a dedicated full-screen page; the choice is remembered.
- **Search** presets by name, text, category or tags. Filter by category
  (sidebar with counts, or the dropdown) and by tags ("Tags" button opens a
  searchable panel; selected tags stay visible as removable chips). Categories
  and tags sort A–Z; presets sort newest-created first.
- **Create / edit / delete** presets. Renaming a preset renames its JSON file
  and moves the image to follow the new slug. Preset names and categories are
  limited to 64 characters. Names are unique **within a category**; the same
  name may exist in different categories (the file slug then gets a `-2`,
  `-3`, … suffix to stay unique). Saving over an existing same-name,
  same-category preset asks for confirmation first.
- **Manage** page (Manage button): rename or delete categories (a category is
  its folder; only empty ones are deletable) and tags (renamed or removed
  across every preset that uses it), with each item's preset usage.
- The editor offers prefix (5 rows), prompt (21) and suffix (5) textareas, a
  live preview of the assembled text with a Copy button, a category dropdown
  with "+ Add new category…", and a comma-separated tag input with
  autocomplete from existing tags.
- Featured image: upload a file, drag it onto the editor, or pick a recent
  image from ComfyUI's output folder.
- Select presets with the card checkbox to **Export selected (N)**; single
  presets export from the card's export action.

## Import / Export

- **Export All** (or per-preset export) downloads a self-contained JSON file
  with images embedded as base64:

```json
{
    "format": "comfyui-prompt-manager",
    "version": 1,
    "exported_at": "2026-08-27T12:00:00+00:00",
    "presets": [
        {
            "name": "Sitting on a bed",
            "slug": "sitting-on-a-bed",
            "prefix": "",
            "prompt": "a woman sitting on a bed",
            "suffix": "",
            "category": "Poses",
            "tags": ["pose", "indoor"],
            "image_data": "data:image/jpeg;base64,..."
        }
    ]
}
```

- **Import** accepts that bundle, an array of presets, or a single preset
  object. A preset with the same name **in the same category** is overwritten
  (the status line says how many were replaced); the same name in another
  category is imported as a new preset. Invalid entries (missing name, empty,
  overlong) are skipped and reported.

## API

All routes under `/prompt_manager/` (also mirrored under `/api/`).

| Method | Path                 | Description                                                                                                                                                                            |
| ------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `list`               | Preset summaries (incl. `prefix`, `prompt`, `suffix`, `image_id` — mtime of the image file, 0 when none) + categories + tags + `version` (change token)                                                           |
| GET    | `version`            | Change token only: newest mtime_ns across preset files, category folders and images. Used for cheap change detection                                          |
| GET    | `tags`               | All available tags, A–Z                                                                                                                                                                |
| GET    | `categories`         | All category folders, incl. empty ones                                                                                                                                                 |
| GET    | `dashboard`          | Redirect to the ComfyUI page with the manager opened full page                                                                                                                     |
| GET    | `presets/{name}`     | Full preset (image as base64)                                                                                                                                                          |
| POST   | `save`               | Create/update. Body: preset fields + `old_slug`, optional `replace` (overwrite a same-name, same-category preset), and `image` (base64/data URI), `image_output_path` or `image_remove`. 400 on invalid image, overlong name/category, or a same-category duplicate name |
| POST   | `delete`             | Delete by slug or name (a slug match wins; the UI sends slugs)                                                                                                                                                                       |
| POST   | `rename_category`    | Rename a category folder (`name`, `new_name`); empty `new_name` deletes the folder — 400 while it still holds presets. Returns moved count                                             |
| POST   | `rename_tag`         | Rename a tag everywhere (`tag`, `new_tag`; empty `new_tag` deletes it). Returns changed count                                                                                          |
| GET    | `image/{name}`       | Featured image bytes                                                                                                                                                                   |
| POST   | `image/{name}`       | Set the featured image (`image`: base64 or data URI; stored as 512px JPEG with EXIF orientation applied) or remove it (`remove: true`)                                                 |
| GET    | `gallery`            | Recent images from the output folder                                                                                                                                                   |
| GET    | `gallery_file?file=` | One output-folder image                                                                                                                                                                |
| POST   | `export`             | JSON bundle download (`names` optional)                                                                                                                                                |
| POST   | `import`             | Import bundle / array / single preset. Returns `imported` and `skipped` names                                                                                                          |
