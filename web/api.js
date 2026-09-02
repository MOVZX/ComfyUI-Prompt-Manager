import { app } from "../../scripts/app.js";

// Matches the editor's "+ Add new category…" placeholder value; presets saved
// with it go to the category root.
const NEW_CATEGORY = "____new_category__";

function slugify(name) {
    return (
        (name || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "preset"
    );
}

// Mirrors storage._category_folder_name, for the file-path hint.
function categoryFolderName(category) {
    let name = (category || "")
        .trim()
        .replace(/[/\x00]+/g, "-")
        .replace(/^[\s.]+|[\s.]+$/g, "");
    if (!name || name === "." || name === "..") name = "uncategorized";
    return name;
}

function presetRelPath(name, category) {
    if (category === NEW_CATEGORY) category = "";
    const folder = (category || "").trim() ? categoryFolderName(category) : "";
    return (folder ? folder + "/" : "") + slugify(name) + ".json";
}

// Mirrors storage.assemble_text: strip each part, drop empties, join with
// blank lines.
function assembleText(p) {
    return [p.prefix, p.prompt, p.suffix]
        .map((s) => String(s || "").trim())
        .filter(Boolean)
        .join("\n\n");
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}
// ---------- API ----------
async function apiJson(path, opts = {}) {
    const res = await app.api.fetchApi(path, {
        method: opts.method ?? "GET",
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
        let msg = "HTTP " + res.status;
        try {
            const j = await res.json();
            if (j.error) msg = j.error;
        } catch {}
        throw new Error(msg);
    }
    return res.json();
}

const api = {
    list: () => apiJson("/prompt_manager/list"),
    version: () => apiJson("/prompt_manager/version"),
    get: (name) => apiJson("/prompt_manager/presets/" + encodeURIComponent(name)),
    save: (payload) => apiJson("/prompt_manager/save", { method: "POST", body: payload }),
    remove: (name) => apiJson("/prompt_manager/delete", { method: "POST", body: { name } }),  // name is actually the slug
    renameCategory: (name, newName) =>
        apiJson("/prompt_manager/rename_category", { method: "POST", body: { name, new_name: newName } }),
    renameTag: (tag, newTag) =>
        apiJson("/prompt_manager/rename_tag", { method: "POST", body: { tag, new_tag: newTag } }),
    import: (payload) => apiJson("/prompt_manager/import", { method: "POST", body: { payload } }),
    gallery: (limit) => apiJson("/prompt_manager/gallery" + (limit ? "?limit=" + limit : "")).then((j) => j.files),
    async exportBlob(names) {
        const res = await app.api.fetchApi("/prompt_manager/export", {
            method: "POST",
            body: JSON.stringify({ names }),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.blob();
    },
    imageSrc: (slug, fresh) => "/prompt_manager/image/" + encodeURIComponent(slug) + (fresh ? "?t=" + Date.now() : ""),
    gallerySrc: (file) => "/prompt_manager/gallery_file?file=" + encodeURIComponent(file),
};

export { api, NEW_CATEGORY, slugify, categoryFolderName, presetRelPath, assembleText, downloadBlob };
