// Entry for the standalone page served at /prompt_manager/dashboard: the
// manager as a full page, without the ComfyUI frontend. The `pm` query param
// (carried on the script URL) tells manager.js to hide the modal-only
// controls.
import { registerManager, openManager } from "./manager.js";
import { checkVersion } from "./state.js";

registerManager();
openManager();

// The in-ComfyUI polling lives in node.js; run it here too so edits on disk
// reach the page.
setInterval(checkVersion, 1000);
window.addEventListener("focus", checkVersion);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkVersion();
});
