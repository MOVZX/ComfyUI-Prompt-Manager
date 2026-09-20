import { app } from "../../scripts/app.js";
import { openManager, closeManager, overlayVisible } from "./manager.js";

const DASHBOARD_PATH = "/prompt_manager/dashboard";
const BUTTON_TOOLTIP = "Prompt Manager (opens in a new tab)";
const MIN_VERSION_FOR_ACTION_BAR = [1, 33, 9];
const MAX_ATTACH_ATTEMPTS = 120;

const openInNewTab = () => {
    window.open(`${window.location.origin}${DASHBOARD_PATH}`, "_blank");
};

const getFrontendVersion = async () => {
    try {
        if (window["__COMFYUI_FRONTEND_VERSION__"]) return window["__COMFYUI_FRONTEND_VERSION__"];
    } catch (e) {}
    try {
        const res = await fetch("/system_stats");
        const data = await res.json();
        if (data?.system?.comfyui_frontend_version) return data.system.comfyui_frontend_version;
        if (data?.system?.required_frontend_version) return data.system.required_frontend_version;
    } catch (e) {}
    return "0.0.0";
};

const parseVersion = (v) => {
    if (!v || typeof v !== "string") return [0, 0, 0];
    const parts = v.replace(/^[vV]/, "").split("-")[0].split(".").map((p) => parseInt(p, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return parts;
};

const compareVersions = (a, b) => {
    const v1 = parseVersion(a);
    const v2 = parseVersion(b);
    for (let i = 0; i < 3; i++) {
        if (v1[i] > v2[i]) return 1;
        if (v1[i] < v2[i]) return -1;
    }
    return 0;
};

const supportsActionBar = async () => compareVersions(await getFrontendVersion(), MIN_VERSION_FOR_ACTION_BAR) >= 0;

// Color logo: gradient bookmark + amber spark. Fixed colors (a logo, not a
// line icon); the gradient id is unique so multiple instances stay valid.
const getIcon = () =>
    '<svg xmlns="http://www.w3.org/2000/svg" width="1.2rem" height="1.2rem" viewBox="0 0 24 24" aria-hidden="true">' +
    '<defs><linearGradient id="pm-top-grad" x1="4" y1="3" x2="17" y2="22" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="#5aa2ff"/><stop offset="0.55" stop-color="#7c6cf6"/><stop offset="1" stop-color="#c65dd6"/>' +
    '</linearGradient></defs>' +
    '<path fill="url(#pm-top-grad)" d="M5 3.5h12a2 2 0 0 1 2 2V21l-8-4.6L3 21V5.5a2 2 0 0 1 2-2Z"/>' +
    '<path fill="#ffffff" opacity="0.9" d="M6.2 5.2c0-.4.3-.7.7-.7h5.4a.7.7 0 0 1 0 1.4H6.9a.7.7 0 0 1-.7-.7Z"/>' +
    '<path fill="#ffc94d" d="M19.6 2.4l1.1 3 3 1.1-3 1.1-1.1 3-1.1-3-3-1.1 3-1.1Z"/>' +
    '<path fill="#ffc94d" opacity="0.85" d="M22.8 9.4l.55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55Z"/>' +
    '</svg>';

const patchIcon = (el) => {
    if (!el || el.dataset.pmIcon) return;
    el.dataset.pmIcon = "1";
    el.innerHTML = getIcon();
    el.style.width = "1.2rem";
    el.style.height = "1.2rem";
};

const attachLegacy = async (attempt = 0) => {
    if (document.querySelector("[data-pm-icon]")) return;
    const group = app.menu?.settingsGroup;
    if (!group?.element?.parentElement) {
        if (attempt >= MAX_ATTACH_ATTEMPTS) return;
        requestAnimationFrame(() => attachLegacy(attempt + 1));
        return;
    }
    const button = await createButton();
    if (!button) return;
    const { ComfyButtonGroup } = await import("../../scripts/ui/components/buttonGroup.js");
    const groupEl = new ComfyButtonGroup(button).element;
    group.element.parentElement.insertBefore(groupEl, group.element);
};

const createButton = async () => {
    try {
        const { ComfyButton } = await import("../../scripts/ui/components/button.js");
        const button = new ComfyButton({ icon: "bookmark", tooltip: BUTTON_TOOLTIP, app, enabled: true });
        button.element.setAttribute("aria-label", BUTTON_TOOLTIP);
        button.element.title = BUTTON_TOOLTIP;
        if (button.iconElement) patchIcon(button.iconElement);
        button.element.addEventListener("click", openInNewTab);
        return button;
    } catch (e) {
        console.warn("Prompt Manager: top menu button unavailable:", e);
        return null;
    }
};

(async () => {
    if (await supportsActionBar()) {
        app.registerExtension({
            name: "prompt-manager.topmenu",
            actionBarButtons: [
                {
                    icon: "icon-[lucide--bookmark] size-4",
                    tooltip: BUTTON_TOOLTIP,
                    onClick: openInNewTab,
                },
            ],
        });
        // The icon library name can be absent from older lucide builds;
        // replace a non-rendered <i> with the inline SVG.
        const poll = () => {
            const btn = document.querySelector(`[aria-label="${BUTTON_TOOLTIP}"]`);
            if (btn && btn.querySelector("i")) {
                patchIcon(btn);
                return;
            }
            requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
    } else {
        await attachLegacy();
    }
})();

// Ctrl/Cmd+P opens the manager in this tab (browser print dialog suppressed).
document.addEventListener(
    "keydown",
    (e) => {
        if (!(e.ctrlKey || e.metaKey) || (e.key !== "p" && e.key !== "P")) return;
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        e.preventDefault();
        e.stopPropagation();
        if (overlayVisible()) closeManager();
        else openManager();
    },
    true,
);
