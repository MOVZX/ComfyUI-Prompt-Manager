// Entry for the standalone page served at /prompt_manager/dashboard: the
// manager as a full page, without the ComfyUI frontend. standalone.html sets
// window.__PM_STANDALONE__ before this module loads.
//
// Guarded: ComfyUI's extension loader also loads every web/*.js file as an
// extension in the normal frontend, where __PM_STANDALONE__ is unset — in
// that context this module must be a no-op.
import { registerManager, openManager } from "./manager.js";
import { checkVersion } from "./state.js";

if (window.__PM_STANDALONE__) {
    registerManager();
    openManager();
    // The in-ComfyUI polling lives in node.js; run it here too so edits on
    // disk reach the page.
    setInterval(checkVersion, 1000);
    window.addEventListener("focus", checkVersion);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) checkVersion();
    });
}
