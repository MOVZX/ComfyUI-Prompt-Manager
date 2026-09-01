import { app } from "../../scripts/app.js";
import { state, refreshPresets, checkVersion, pmOn, pmCoverMode, pmSetCoverMode } from "./state.js";
import { api, assembleText } from "./api.js";
import { openManager, closeManager, overlayVisible, closeGallery, galleryVisible, openEditorFromNodeText } from "./manager.js";

const NODE_NAME = "PromptManager";
const ALL_CATEGORIES = "All Categories";
const PM_MARGIN = 15; // matches LiteGraph BaseWidget.margin
const PM_ROW_GAP = 4; // LiteGraph widget spacing (NODE_WIDGET_HEIGHT + 4)
const PM_TEXT_ROWS = 10; // text field rows at the default node size
const PM_SIDE_ROWS = 3; // prefix/suffix rows of the 3:10:3 flex split
const PM_FLEX_Y = 166; // widgets start Y (46) + five fixed 24px rows (120)
const PM_COVER_MAX = 0.3; // cover: max 30% of the node height
const NO_PRESET = "None"; // "no preset selected" option in the preset combo
let graphRefreshTimer = null;
// Last preset value seen per node id; used to auto-fill text only when the
// user actually changes the preset (not on initial graph load).
const lastPresetByNode = new Map();
// Text last pushed into each node's field; while the user has not modified
// the field, preset content edits made in the manager follow to the node.
const lastPushedByNode = new Map();
// Preset featured images, cached by "slug:image_id" so a replaced image on
// the same slug refetches instead of serving the stale bytes.
const pmImageCache = new Map();

function filteredPresetNames(node) {
    const catW = node.widgets?.find((w) => w.name === "category");
    const cat = catW ? catW.value : ALL_CATEGORIES;
    const list = cat === ALL_CATEGORIES ? state.presets : state.presets.filter((p) => p.category === cat);
    return [NO_PRESET, ...list.map((p) => p.name)];
}

function syncNodeCombos() {
    if (!app.graph) return;
    for (const node of app.graph.nodes || []) {
        if (node.comfyClass !== NODE_NAME) continue;
        const w = node.widgets?.find((w) => w.name === "preset");
        if (!w) continue;
        const names = filteredPresetNames(node);
        if (w.value && !names.includes(w.value)) w.value = names[0] ?? "";
        node.setDirty?.(true, false);
    }
    app.graph.setDirtyCanvas?.(true, true);
}

// "Save text": open the manager's editor with the node's prefix/text/suffix
// verbatim so it can be stored as a preset (or to review the one it came
// from). No splitting is guessed: each field maps to its editor field.
function saveTextFromNode(node) {
    const g = (n) => String(node.widgets?.find((w) => w.name === n)?.value ?? "").trim();
    const prefix = g("prefix");
    const text = g("text");
    const suffix = g("suffix");
    if (!prefix && !text && !suffix) return;
    const pre = node.widgets?.find((w) => w.name === "preset");
    const catW = node.widgets?.find((w) => w.name === "category");
    const category = catW && catW.value !== ALL_CATEGORIES ? catW.value : "";
    const presetName = pre && pre.value && pre.value !== NO_PRESET ? pre.value : "";
    openEditorFromNodeText({ prefix, text, suffix }, presetName, category);
}

// Fill the node's prefix/text/suffix with the preset's parts and remember
// what was pushed, so the follow-edit logic knows when the user took over.
function pmApplyPreset(node, preset) {
    const t = assembleText(preset);
    if (!t) return;
    const w = (n) => node.widgets.find((x) => x.name === n);
    const prefixW = w("prefix");
    const textW = w("text");
    const suffixW = w("suffix");
    if (prefixW) prefixW.value = String(preset.prefix || "").trim();
    if (textW) textW.value = String(preset.prompt || "").trim();
    if (suffixW) suffixW.value = String(preset.suffix || "").trim();
    lastPushedByNode.set(node.id, t);
    node.setDirtyCanvas?.(true, true);
}

// Per-node tick: keeps category/preset values valid against the library,
// fills the editable text field when the user picks a preset (comparing a
// per-node last-seen value, so a loaded workflow's saved text is never
// overwritten), and syncs the cover widget. Runs from a 300ms poll, independent
// of how the frontend signals widget changes.
function syncPresetToText() {
    if (!app.graph) return;
    const liveIds = new Set();
    for (const node of app.graph.nodes || []) {
        if (node.comfyClass !== NODE_NAME) continue;
        liveIds.add(node.id);
        const presetW = node.widgets?.find((w) => w.name === "preset");
        const textW = node.widgets?.find((w) => w.name === "text");
        const catW = node.widgets?.find((w) => w.name === "category");
        const cat = catW ? catW.value : ALL_CATEGORIES;
        if (!presetW || !textW) continue;
        const prefixW = node.widgets?.find((w) => w.name === "prefix");
        const suffixW = node.widgets?.find((w) => w.name === "suffix");
        pmSyncCover(node);
        if (state.loaded) {
            if (catW && cat !== ALL_CATEGORIES && !state.categories.includes(cat)) {
                catW.value = ALL_CATEGORIES;
                node.setDirtyCanvas?.(true, true);
            }
            const names = filteredPresetNames(node);
            if (presetW.value && !names.includes(presetW.value)) {
                presetW.value = names[0] ?? "";
                node.setDirtyCanvas?.(true, true);
            }
        }
        const current = presetW.value ?? "";
        if (!lastPresetByNode.has(node.id)) {
            lastPresetByNode.set(node.id, current);
            continue;
        }
        // Names may repeat across categories; scope the lookup to the node's
        // category (global when "All Categories").
        const preset = state.presets.find(
            (p) => p.name === current && (cat === ALL_CATEGORIES || p.category === cat),
        );
        if (lastPresetByNode.get(node.id) !== current) {
            lastPresetByNode.set(node.id, current);
            // No preset (or "None"): keep whatever is in the text field.
            if (!current || current === NO_PRESET) {
                lastPushedByNode.delete(node.id);
                continue;
            }
            if (preset) pmApplyPreset(node, preset);
            else
                api.get(current)
                    .then((p) => pmApplyPreset(node, p))
                    .catch(() => {});
            continue;
        }
        // Same selection: follow content edits made in the manager, but only
        // while the user has not modified the fields themselves (the
        // 3-part assembly no longer equals what was last pushed).
        const pushed = lastPushedByNode.get(node.id);
        if (pushed === undefined || !preset) continue;
        const parts = [prefixW?.value, textW.value, suffixW?.value]
            .map((s) => String(s ?? "").trim())
            .filter(Boolean);
        if (parts.join("\n\n") !== pushed) continue;
        if (assembleText(preset) !== pushed) pmApplyPreset(node, preset);
    }
    for (const id of [...lastPresetByNode.keys()]) {
        if (!liveIds.has(id)) {
            lastPresetByNode.delete(id);
            lastPushedByNode.delete(id);
        }
    }
}
// ---------- node layout: category row, preset row, text, cover image ----------
function pmLoadImage(slug, key, onReady) {
    const cached = pmImageCache.get(key);
    if (cached) {
        onReady(cached);
        return;
    }
    const img = new Image();
    pmImageCache.set(key, img);
    img.onload = () => onReady(img);
    img.src = api.imageSrc(slug, true);
}

// Line metrics of the text field (1 row and PM_TEXT_ROWS rows) in the
// frontend's own .comfy-multiline-input font. Measured once per widget via a
// throwaway textarea (computeLayoutSize runs every frame, so cache it on the
// widget).
function pmTextLines(widget) {
    if (widget._pmLines) return widget._pmLines;
    const el = widget.element;
    let min = 0;
    let max = 0;
    if (el && el.tagName === "TEXTAREA") {
        const probe = document.createElement("textarea");
        probe.className = el.className;
        probe.style.cssText = "position:fixed;visibility:hidden;width:300px";
        document.body.appendChild(probe);
        probe.rows = 1;
        probe.value = "x";
        min = probe.scrollHeight;
        probe.rows = PM_TEXT_ROWS;
        probe.value = "x\n".repeat(PM_TEXT_ROWS - 1) + "x";
        max = probe.scrollHeight;
        probe.remove();
    }
    widget._pmLines = { min: min || 14, max: max || PM_TEXT_ROWS * 14 };
    return widget._pmLines;
}

// Custom draw for the pmCover widget: a growable widget, so the layout engine
// assigns it whatever vertical space is left after the other widgets and it
// spans the full node width — the cover always follows the node size.
// The image itself is fitted to the height with its natural aspect ratio
// (auto width, no crop); if that width exceeds the node it is scaled down.
function pmDrawCoverWidget(ctx, node, width, y, H, lowQuality) {
    const cover = node.widgets?.find((w) => w.name === "pmCover");
    const pre = node.widgets?.find((w) => w.name === "preset");
    const catW = node.widgets?.find((w) => w.name === "category");
    const cat = catW ? catW.value : ALL_CATEGORIES;
    const preset = state.presets.find((p) => p.name === pre?.value && (cat === ALL_CATEGORIES || p.category === cat));
    // Leave the standard widget gap below the cover (the row above already
    // carries it on top, so only the node-bottom side needs insetting).
    const h = (cover?.computedHeight ?? 0) - PM_ROW_GAP;
    if (!preset || !preset.has_image || h <= 0) return;
    const x0 = PM_MARGIN;
    const w = node.size[0] - PM_MARGIN * 2;
    ctx.save();
    ctx.fillStyle = "#222";
    ctx.beginPath();
    ctx.roundRect(x0, y, w, h, [6]);
    ctx.fill();
    const img = node._pmImage;
    if (img && img.complete && img.naturalWidth) {
        const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
        const dw = img.naturalWidth * scale;
        const dh = img.naturalHeight * scale;
        ctx.drawImage(img, x0 + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
        ctx.fillStyle = "#5b6370";
        ctx.font = "12px monospace";
        ctx.textAlign = "center";
        ctx.fillText("\u2026", x0 + w / 2, y + h / 2);
    }
    ctx.restore();
}

// Keep the cover widget in sync with the selected preset and the Show/Hide
// toggle. Never touches the node size — the layout engine owns it.
function pmSyncCover(node) {
    const pre = node.widgets?.find((w) => w.name === "preset");
    const cover = node.widgets?.find((w) => w.name === "pmCover");
    if (!pre || !cover) return;
    // Re-wire custom members if a node clone lost them.
    if (typeof cover.computeLayoutSize !== "function")
        cover.computeLayoutSize = (node) => ({
            minHeight: 0,
            maxHeight: node.size[1] * PM_COVER_MAX,
            minWidth: 0,
        });
    if (typeof cover.draw !== "function") cover.draw = pmDrawCoverWidget;
    if (typeof cover.mouse !== "function") cover.mouse = () => null;
    const catW = node.widgets?.find((w) => w.name === "category");
    const cat = catW ? catW.value : ALL_CATEGORIES;
    const preset = state.presets.find((p) => p.name === pre.value && (cat === ALL_CATEGORIES || p.category === cat));
    const coverT = node.widgets?.find((w) => w.name === "Cover");
    if (coverT && coverT.value !== pmCoverMode()) {
        coverT.value = pmCoverMode();
        node.setDirtyCanvas?.(true, true);
    }
    const shown = !coverT || coverT.value !== "Hide";
    const hasImage = !!(preset && preset.has_image);
    if (hasImage && shown) {
        // image_id changes when the featured image is replaced on the same slug,
        // so any manager-side update reaches the node within one poll.
        const key = preset.slug + ":" + (preset.image_id ?? 0);
        if (node._pmKey !== key) {
            node._pmKey = key;
            pmLoadImage(preset.slug, key, () => {
                node._pmImage = pmImageCache.get(key);
                node.setDirtyCanvas?.(true, true);
            });
            node._pmImage = pmImageCache.get(key);
        }
        if (cover.hidden) {
            cover.hidden = false;
            node.setDirtyCanvas?.(true, true);
        }
    } else {
        if (node._pmKey || node._pmImage) {
            node._pmKey = null;
            node._pmImage = null;
        }
        if (!cover.hidden) {
            cover.hidden = true;
            node.setDirtyCanvas?.(true, true);
        }
    }
}

export function registerNode() {
    pmOn("library", syncNodeCombos);
    app.registerExtension({
        name: "prompt-manager.manager",

        async beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData.name !== NODE_NAME) return;
            nodeData.icon = "fa-solid fa-bookmark";

            const origOnNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                origOnNodeCreated?.apply(this, arguments);

                const btnSave = this.addWidget("button", "Save Preset", "", () => saveTextFromNode(this));
                btnSave.options.serialize = false;
                btnSave.serialize = false;
                const btn = this.addWidget("button", "Preset Manager", "", () => openManager());
                btn.options.serialize = false;
                btn.serialize = false;

                const cat = this.widgets?.find((w) => w.name === "category");
                const pre = this.widgets?.find((w) => w.name === "preset");
                const textW = this.widgets?.find((w) => w.name === "text");
                // Text field: min 1 row; it is the growable field, so the layout
                // engine hands it all leftover space (the cover is capped at
                // PM_COVER_MAX of the node height).
                if (textW) textW.options.getMinHeight = () => pmTextLines(textW).min;
                // prefix/suffix: PM_SIDE_ROWS of the node's flex area each, text
                // gets the rest (3 : 10 : 3). Fixed via computeLayoutSize (the
                // frontend clobbers options.getMinHeight on textareas), scaled
                // with the node height, so resizing the node shrinks/grows all
                // three fields together - it is a default, not a minimum.
                const flexArea = (node) => Math.max(0, node.size[1] - PM_FLEX_Y);
                const sideHeight = (node) => (flexArea(node) * PM_SIDE_ROWS) / 16;
                const fixSideHeight = (name) => {
                    const sw = this.widgets?.find((x) => x.name === name);
                    if (!sw) return;
                    sw.computeLayoutSize = (node) => {
                        const h = Math.max(0, sideHeight(node));
                        return { minHeight: h, maxHeight: h, minWidth: 0 };
                    };
                };
                fixSideHeight("prefix");
                fixSideHeight("suffix");
                if (cat && cat.options) {
                    cat.options.values = () => [ALL_CATEGORIES, ...state.categories];
                }
                if (pre) pre.options.values = () => filteredPresetNames(this);
                // Cover show/hide (UI-only; localStorage is the source of truth,
                // so it survives page reloads and new nodes).
                const coverT = this.addWidget("combo", "Cover", pmCoverMode(), (v) => pmSetCoverMode(v), {
                    values: ["Show", "Hide"],
                });
                coverT.options.serialize = false;
                coverT.serialize = false;
                // Cover image: a growable widget taking the vertical space left after
                // the other widgets, capped at PM_COVER_MAX of the node height; the
                // layout engine owns the node size.
                const cover = this.addWidget("pmcover", "pmCover", "", () => {});
                cover.options.serialize = false;
                cover.serialize = false;
                cover.mouse = () => null;
                cover.hidden = true;
                cover.computeLayoutSize = (node) => ({
                    minHeight: 0,
                    maxHeight: node.size[1] * PM_COVER_MAX,
                    minWidth: 0,
                });
                cover.draw = pmDrawCoverWidget;
                pmSyncCover(this);
                // New nodes: default size so the flex area is 16 rows tall -
                // prefix/suffix get their 3 rows each and text the remaining 10:
                // H = PM_FLEX_Y + 16*rowH. Loaded workflows restore their own
                // size via configure(), which runs after onNodeCreated.
                const lines = textW ? pmTextLines(textW) : { min: 14, max: PM_TEXT_ROWS * 14 };
                const rowH = lines.max / PM_TEXT_ROWS;
                const w = Math.max(this.size[0], 400);
                const h = Math.ceil(PM_FLEX_Y + 16 * rowH);
                this.setSize([w, h]);
            };

            await refreshPresets();
        },

        async setup() {
            // /prompt_manager/dashboard redirects here: open the manager as a
            // dedicated full page once the app is up.
            if (new URLSearchParams(location.search).has("pm")) {
                const t = setInterval(() => {
                    if (app.graph) {
                        clearInterval(t);
                        openManager(true);
                    }
                }, 200);
                setTimeout(() => clearInterval(t), 15000);
            }
            app.api.addEventListener("graphChanged", () => {
                syncPresetToText();
                clearTimeout(graphRefreshTimer);
                graphRefreshTimer = setTimeout(checkVersion, 400);
            });
            // Polling: 300ms node sync (primary auto-fill path, independent of
            // how this frontend version signals widget changes) + 1s version
            // token for on-disk library edits (a full refetch only on change).
            // Both pause while the tab is hidden.
            let syncTimer = null;
            let versionTimer = null;
            const startPolling = () => {
                if (syncTimer === null) syncTimer = setInterval(syncPresetToText, 300);
                if (versionTimer === null) versionTimer = setInterval(checkVersion, 1000);
            };
            const stopPolling = () => {
                if (syncTimer !== null) {
                    clearInterval(syncTimer);
                    syncTimer = null;
                }
                if (versionTimer !== null) {
                    clearInterval(versionTimer);
                    versionTimer = null;
                }
            };
            startPolling();
            syncPresetToText();
            window.addEventListener("focus", checkVersion);
            document.addEventListener("visibilitychange", () => {
                if (document.hidden) stopPolling();
                else {
                    startPolling();
                    syncPresetToText();
                    checkVersion();
                }
            });
            document.addEventListener("keydown", (e) => {
                if (e.key !== "Escape") return;
                // Inputs keep Escape for their own handlers (tag suggestions,
                // new-category row, search fields).
                const t = e.target;
                if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable))
                    return;
                if (galleryVisible()) closeGallery();
                else if (overlayVisible()) closeManager();
            });
        },
    });
}
