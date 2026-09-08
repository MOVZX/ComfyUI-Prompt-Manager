import { api } from "./api.js";

// Library state, shared by the manager and the node extension. `version` is
// the server-side change token (newest mtime on disk); see checkVersion.
export const state = { presets: [], categories: [], tags: [], loaded: false, version: null };

// Tiny sync emitter so the manager and the node extension do not need to
// import each other: refreshPresets announces library updates here.
const listeners = new Map();

export function pmOn(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
}

export function pmEmit(event, ...args) {
    for (const fn of listeners.get(event) ?? []) fn(...args);
}

// widget list contains a non-serialized button, so the index-aligned
// widgets_values array has a hole and the workflow-load path cannot restore
// combo values past it reliably.
export function pmCoverMode() {
    return localStorage.getItem("pm.covermode") === "Hide" ? "Hide" : "Show";
}
export function pmSetCoverMode(mode) {
    localStorage.setItem("pm.covermode", mode === "Hide" ? "Hide" : "Show");
}

export async function refreshPresets() {
    try {
        const data = await api.list();
        state.presets = data.presets;
        state.categories = data.categories;
        state.tags = data.tags;
        state.version = data.version;
        state.loaded = true;
    } catch (e) {
        pmEmit("library-error", e);
        return;
    }
    pmEmit("library");
}

// Cheap change detection: /version is a ~30 byte response, so it can be
// polled constantly. The full library is refetched only when the token
// changed — which is also how edits made directly to the JSON files on disk
// (editor, git) reach the UI.
export async function checkVersion() {
    if (!state.loaded) return refreshPresets();
    let version;
    try {
        version = (await api.version()).version;
    } catch {
        return; // the next tick retries
    }
    if (version !== state.version) refreshPresets();
}

// Recently used presets (newest first), shared by the node and the manager:
// [{slug, ts}] in localStorage, capped.
const PM_RECENT_KEY = "pm.recent";
const PM_RECENT_MAX = 12;

export function pmRecentList() {
    try {
        return JSON.parse(localStorage.getItem(PM_RECENT_KEY)) || [];
    } catch {
        return [];
    }
}

export function pmRecentAdd(slug) {
    if (!slug) return;
    const list = pmRecentList().filter((r) => r.slug !== slug);
    list.unshift({ slug, ts: Date.now() });
    localStorage.setItem(PM_RECENT_KEY, JSON.stringify(list.slice(0, PM_RECENT_MAX)));
}
