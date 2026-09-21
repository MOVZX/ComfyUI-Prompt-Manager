import { state, refreshPresets, pmOn } from "./state.js";
import { api, downloadBlob, presetRelPath, assembleText, NEW_CATEGORY } from "./api.js";

let searchQuery = "";
let filterCategory = "";
let filterTags = new Set();
// Remember list filters across reloads and standalone visits. Stale values
// are pruned in renderFilters against the current library.
const PM_FILTERS_KEY = "pm.filters";
try {
    const saved = JSON.parse(localStorage.getItem(PM_FILTERS_KEY) || "{}");
    searchQuery = typeof saved.q === "string" ? saved.q : "";
    filterCategory = typeof saved.c === "string" ? saved.c : "";
    filterTags = new Set(Array.isArray(saved.tags) ? saved.tags.filter((t) => typeof t === "string") : []);
} catch {
    // Corrupt saved state: start clean
}

function persistFilters() {
    try {
        localStorage.setItem(
            PM_FILTERS_KEY,
            JSON.stringify({ q: searchQuery, c: filterCategory, tags: [...filterTags] }),
        );
    } catch {
        // Storage unavailable (private mode): filters simply won't persist
    }
}

// Pager + grid scroll position, also remembered across reloads.
const PM_VIEW_KEY = "pm.view";
const PAGE_SIZES = [20, 30, 40, 50];
const isMobileViewport = window.matchMedia("(max-width:720px)").matches;
let view = { page: 1, size: isMobileViewport ? 20 : 40, scroll: 0 };
let scrollRestored = false;
try {
    const saved = JSON.parse(localStorage.getItem(PM_VIEW_KEY) || "{}");
    view = {
        page: Math.max(1, parseInt(saved.page, 10) || 1),
        size: PAGE_SIZES.includes(saved.size) || saved.size === "all" ? saved.size : view.size,
        scroll: Math.max(0, parseInt(saved.scroll, 10) || 0),
    };
} catch {
    // Corrupt saved state: keep the defaults
}

function persistView() {
    try {
        localStorage.setItem(PM_VIEW_KEY, JSON.stringify(view));
    } catch {
        // Storage unavailable: view state simply won't persist
    }
}
let editing = null; // { name, slug } of the preset open in the editor, null for "new"
let pendingImage = null; // {type:"upload",dataUrl} | {type:"output",path} | {type:"remove"}
let suggestItems = [];
let suggestIndex = -1;
let statusTimer = null;
let formDirty = false;
// The standalone page (/prompt_manager/dashboard) sets this flag before the
// modules load: it is a full page, not a modal, so the close and mode-toggle
// buttons are hidden.
const STANDALONE = !!window.__PM_STANDALONE__;
let fullPage = STANDALONE || localStorage.getItem("pm.fullpage") === "1";
let sideOpen = localStorage.getItem("pm.sideopen") === "1";
let btnPageEl = null;
let pagerPrev, pagerSizeSel, pagerNext, pagerInfo, pagerEl;
let sideBtn = null;
let btnExportSel = null;
let btnDeleteSel = null;
let cardSel = new Set();

// ---------- DOM helpers ----------
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

// ---------- CSS ----------
const CSS = `
.pm-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center}
.pm-overlay.pm-full .pm-modal{width:100vw;height:100vh;height:100dvh;border-radius:0;border:none}
.pm-overlay[hidden]{display:none}
.pm-modal{width:min(1280px,95vw);height:min(85vh);background:#16181d;border:1px solid #2a2e37;border-radius:10px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.5)}
.pm-header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #2a2e37;flex:none}
.pm-title{font-size:15px;font-weight:600;color:#e6e9ef;margin-right:auto}
.pm-btn{background:#23262e;border:1px solid #343945;color:#cfd6e0;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer}
.pm-btn:hover{background:#2c303a}
.pm-btn.primary{background:#3b82f6;border-color:#3b82f6;color:#fff}
.pm-btn.primary:hover{background:#2f6fe0}
.pm-btn.danger{background:transparent;border-color:#7f2a2a;color:#e08585}
.pm-btn.danger:hover{background:#3a1d1d}
.pm-btn.on{background:#27436e;border-color:#3b82f6;color:#d6e4ff}
.pm-btn.success{background:#15803d;border-color:#15803d;color:#fff}
.pm-btn.success:hover{background:#16a34a}
.pm-back{background:transparent;color:#8b93a1}
.pm-back:hover{background:#2c303a;color:#e6e9ef}
.pm-btn.close{padding:5px 10px;font-size:14px;line-height:1}
.pm-back{display:none}
.pm-overlay.pm-editing .pm-back,.pm-overlay.pm-managing .pm-back{display:inline-block}
.pm-body{display:flex;flex:1;min-height:0}
.pm-list-pane{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.pm-overlay.pm-editing .pm-list-pane{display:none}
.pm-side{flex:none;width:170px;border-right:1px solid #2a2e37;display:none;flex-direction:column;min-height:0}
.pm-overlay.pm-side-open .pm-side{display:flex}
.pm-overlay.pm-editing .pm-side{display:none}
.pm-side-list{flex:1;overflow-y:auto;padding:8px 6px}
.pm-side-item{display:flex;align-items:baseline;gap:6px;padding:5px 8px;border-radius:6px;font-size:12px;color:#cfd6e0;cursor:pointer}
.pm-side-item:hover{background:#23262e}
.pm-side-item.active{background:#27436e;color:#d6e4ff}
.pm-side-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-side-count{font-size:11px;color:#5b6370}
.pm-side-item.active .pm-side-count{color:#9db8e8}
.pm-manage-pane{flex:1;display:none;flex-direction:row;min-width:0;min-height:0}
.pm-overlay.pm-managing .pm-manage-pane{display:flex}
.pm-overlay.pm-managing .pm-list-pane,.pm-overlay.pm-managing .pm-editor-pane,.pm-overlay.pm-managing .pm-side{display:none}
.pm-manage-list{flex:none;width:280px;border-right:1px solid #2a2e37;display:flex;flex-direction:column;min-height:0;padding:10px 8px}
.pm-manage-list>input{background:#0f1115;border:1px solid #2a2e37;border-radius:6px;color:#e6e9ef;padding:6px 8px;font-size:12px;margin-bottom:8px}
.pm-manage-items{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:14px}
.pm-manage-sec{display:flex;flex-direction:column;gap:2px}
.pm-manage-item{padding:5px 8px;border-radius:6px;font-size:12px;color:#cfd6e0;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-manage-item:hover{background:#23262e}
.pm-manage-item.active{background:#27436e;color:#d6e4ff}
.pm-manage-edit{flex:1;min-width:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.pm-manage-title{font-size:15px;font-weight:600;color:#e6e9ef;display:flex;align-items:center;gap:8px}
.pm-manage-meta{font-size:12px;color:#8a93a2}
.pm-manage-row{display:flex;gap:8px;align-items:center}
.pm-manage-row input{flex:1;background:#0f1115;border:1px solid #2a2e37;border-radius:6px;color:#e6e9ef;padding:7px 9px;font-size:13px}
.pm-manage-preset{padding:5px 8px;border-radius:6px;font-size:12px;color:#cfd6e0;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-manage-preset:hover{background:#23262e}
.pm-filter-row{display:flex;gap:8px;padding:10px 10px 6px;flex:none}
.pm-filter-row input,.pm-filter-row select{background:#0f1115;border:1px solid #2a2e37;border-radius:6px;color:#e6e9ef;padding:6px 8px;font-size:12px}
.pm-filter-row input{flex:1}
.pm-filter-row select{max-width:170px}
.pm-pager{flex:none;display:flex;gap:6px;align-items:center;justify-content:center;padding:8px 10px;border-top:1px solid #2a2e37}
.pm-pager-btn{flex:none}
.pm-pager-info{font-size:11px;color:#8a93a2;flex:none}
.pm-tag-row{display:flex;flex-wrap:wrap;gap:4px;padding:0 10px 8px;flex:none}
.pm-tag-row[hidden]{display:none}
.pm-tag{background:#1d232e;border:1px solid #2a2e37;border-radius:999px;padding:2px 9px;font-size:11px;color:#9aa4b2;cursor:pointer}
.pm-tag.active{background:#27436e;border-color:#3b82f6;color:#d6e4ff}
.pm-tags-btn{padding:6px 10px;flex:none}
.pm-tagpanel{flex:none;border-top:1px solid #2a2e37;margin-top:6px;padding:8px 10px 6px;display:flex;flex-direction:column;gap:6px}
.pm-tagpanel[hidden]{display:none}
.pm-tagpanel input{background:#0f1115;border:1px solid #2a2e37;border-radius:6px;color:#e6e9ef;padding:5px 8px;font-size:12px}
.pm-taglist{display:flex;flex-wrap:wrap;gap:4px;max-height:150px;overflow-y:auto}
.pm-tag-x{margin-left:6px;color:#8b93a1;font-weight:600;cursor:pointer}
.pm-tag-x:hover{color:#e08585}
.pm-tagger-title{font-size:11px;font-weight:600;color:#8b93a1;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px}
.pm-tagger-empty{font-size:11px;color:#5b6370;font-style:italic;padding:2px 0}
.pm-grid{flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;padding:4px 10px 10px;align-content:start}
.pm-card{position:relative;background:#1e2128;border:1px solid #2a2e37;border-radius:8px;overflow:hidden;cursor:pointer;height:180px}
.pm-card:hover{border-color:#4a5160}
.pm-card.selected{border-color:#3b82f6}
.pm-card-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;background:#12141a}
.pm-card-noimg{position:absolute;inset:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#12141a;color:#3d434f;font-size:26px}
.pm-card-name{position:absolute;top:0;left:0;right:0;z-index:1;font-size:12px;font-weight:600;color:#e6e9ef;padding:6px 8px 14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:linear-gradient(180deg,rgba(0,0,0,.75) 30%,rgba(0,0,0,0))}
.pm-card-meta{position:absolute;bottom:0;left:0;right:0;z-index:1;display:flex;flex-wrap:wrap;gap:3px;padding:16px 8px 7px;background:linear-gradient(0deg,rgba(0,0,0,.75) 20%,rgba(0,0,0,0))}
.pm-badge{background:#232a36;border-radius:4px;padding:1px 6px;font-size:10px;color:#8fd3a6}
.pm-card-tag{font-size:10px;color:#6d7684}
.pm-card-actions{position:absolute;top:4px;right:4px;z-index:2;display:none;gap:3px}
.pm-card:hover .pm-card-actions{display:flex}
.pm-card-actions button{width:22px;height:22px;border-radius:5px;border:1px solid #343945;background:rgba(15,17,21,.85);color:#cfd6e0;font-size:11px;cursor:pointer;line-height:1}
.pm-card-actions button:hover{background:#2c303a}
.pm-editor-pane{flex:1;display:none;flex-direction:column;min-width:0;min-height:0}
.pm-overlay.pm-editing .pm-editor-pane{display:flex}
.pm-editor-holder{flex:1;min-height:0;display:flex;flex-direction:column}
.pm-editor{flex:1;width:100%;max-width:95%;margin:0 auto;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;box-sizing:border-box}
.pm-field label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8a93a2;margin-bottom:4px}
.pm-field input,.pm-field textarea,.pm-field select{width:100%;box-sizing:border-box;background:#0f1115;border:1px solid #2a2e37;border-radius:6px;color:#e6e9ef;padding:7px 9px;font-size:13px;font-family:inherit;resize:vertical}
.pm-field select{resize:none}
.pm-field input:focus,.pm-field textarea:focus{outline:none;border-color:#3b82f6}
.pm-hint{font-size:10px;color:#5b6370;margin-top:3px}
.pm-hint.warn{color:#e0a35b}
.pm-preview summary.pm-preview-head{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none}
.pm-preview summary.pm-preview-head::-webkit-details-marker{display:none}
.pm-preview summary.pm-preview-head .pm-btn{margin-left:auto}
.pm-preview-text{background:#0f1115;border:1px solid #2a2e37;border-radius:6px;color:#9aa4b2;padding:8px 10px;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow-y:auto;font-family:inherit;margin:0}
.pm-row2{display:flex;gap:12px}
.pm-row2 .pm-field{flex:1}
.pm-row2 .pm-field.wide{flex:2}
.pm-tag-wrap{position:relative}
.pm-suggest{position:absolute;left:0;right:0;top:100%;z-index:5;background:#1e2128;border:1px solid #343945;border-radius:6px;margin-top:2px;box-shadow:0 6px 18px rgba(0,0,0,.45);overflow:hidden;display:none}
.pm-suggest.open{display:block}
.pm-suggest div{padding:5px 10px;font-size:12px;color:#cfd6e0;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pm-suggest div.active{background:#27436e;color:#d6e4ff}
.pm-newcat{display:flex;gap:6px;margin-top:6px}
.pm-newcat[hidden]{display:none}
.pm-newcat input{flex:1;background:#0f1115;border:1px solid #2a2e37;border-radius:6px;color:#e6e9ef;padding:6px 8px;font-size:12px}
.pm-img-row{display:flex;gap:12px;align-items:flex-start}
.pm-img-row.pm-img-drop{outline:2px dashed #3b82f6;outline-offset:2px;border-radius:6px}
.pm-img-preview{width:110px;height:82px;object-fit:cover;border-radius:6px;border:1px solid #2a2e37;background:#12141a}
.pm-img-placeholder{width:110px;height:82px;border-radius:6px;border:1px dashed #343945;display:flex;align-items:center;justify-content:center;color:#5b6370;font-size:11px}
.pm-img-btns{display:flex;flex-direction:row;gap:6px}
.pm-footer{flex:none;display:flex;align-items:center;min-height:30px;padding:0 14px;border-top:1px solid #2a2e37;font-size:12px}
.pm-status{color:#8fd3a6}
.pm-status.error{color:#e08585}
.pm-gallery-grid{flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;padding:12px;align-content:start}
.pm-gallery-search{width:180px;background:#0f1115;border:1px solid #2a2e37;border-radius:6px;color:#e6e9ef;padding:6px 8px;font-size:12px}
.pm-gimg{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;border:1px solid #2a2e37;cursor:pointer}
.pm-gimg:hover{border-color:#3b82f6}
.pm-loading{grid-column:1/-1;color:#8a93a2;font-size:13px;padding:20px;text-align:center}

/* ---------- mobile / small screens ---------- */
@media (max-width:720px){
  .pm-overlay{align-items:stretch;justify-content:stretch}
  .pm-modal{width:100vw;height:100vh;height:100dvh;border-radius:0;border:none}
  .pm-header{padding:8px 10px;gap:6px;flex-wrap:wrap}
  .pm-title{font-size:14px}
  .pm-btn{padding:8px 12px;font-size:13px;touch-action:manipulation}
  .pm-overlay.pm-side-open .pm-side{display:none}
  .pm-filter-row{flex-wrap:wrap}
  .pm-filter-row input,.pm-filter-row select{font-size:16px}
  .pm-filter-row select{max-width:128px}
  .pm-gallery-search{width:100%;font-size:16px}
  .pm-manage-pane{flex-direction:column}
  .pm-manage-list{width:100%;border-right:none;border-bottom:1px solid #2a2e37;max-height:45%}
  .pm-manage-row input{font-size:16px}
  .pm-tagpanel input{font-size:16px}
  .pm-tag{padding:5px 12px;font-size:12px;touch-action:manipulation}
  .pm-grid{grid-template-columns:repeat(auto-fill,minmax(128px,1fr))}
  .pm-card{touch-action:manipulation}
  .pm-card-actions{display:flex}
  .pm-card-actions button{width:30px;height:30px;font-size:13px}
  .pm-row2{flex-direction:column;gap:8px}
  .pm-img-row{flex-wrap:wrap}
  .pm-editor{padding:10px;gap:8px}
  .pm-field input,.pm-field textarea,.pm-field select{font-size:16px}
  .pm-newcat input{font-size:16px}
  .pm-footer{padding:0 10px}
}
`;

function ensureStyles() {
    if (document.getElementById("prompt-manager-styles")) return;
    const style = document.createElement("style");
    style.id = "prompt-manager-styles";
    style.textContent = CSS;
    document.head.appendChild(style);
}

// ---------- manager overlay ----------
let overlay = null;
let titleEl,
    gridEl,
    searchEl,
    catFilterEl,
    tagRowEl,
    editorEl,
    statusEl,
    tagsBtn,
    tagPanelEl,
    tagSearchEl,
    tagListEl,
    sideListEl,
    manageItemsEl,
    manageEditEl,
    manageSearchEl;
let managing = false;
let manageSel = null; // {kind:"category"|"tag", name} selected on the manage page
let fName,
    fSlugHint,
    fPrefix,
    fPrompt,
    fSuffix,
    fCategory,
    fNewCatRow,
    fNewCatInput,
    fTagsInput,
    tagSuggest,
    fImgPreview,
    fImgUpload,
    fPreview;

function overlayVisible() {
    return overlay && !overlay.hidden;
}

function ensureOverlay() {
    if (overlay) return;
    ensureStyles();

    overlay = el("div", "pm-overlay");
    overlay.hidden = true;
    const modal = el("div", "pm-modal");

    const header = el("div", "pm-header");
    titleEl = el("div", "pm-title", "Prompt Manager");
    const btnBack = el("button", "pm-btn pm-back", "\u2190 Back");
    btnBack.onclick = () => {
        if (!confirmDiscard()) return;
        setManagingUI(false);
        showEmpty();
    };
    header.append(btnBack, titleEl);
    const btnNew = el("button", "pm-btn primary", "+ New");
    btnNew.onclick = () => {
        if (!confirmDiscard()) return;
        startNew();
    };
    const btnImport = el("button", "pm-btn", "Import");
    const importInput = document.createElement("input");
    importInput.type = "file";
    importInput.accept = ".json,application/json";
    importInput.hidden = true;
    importInput.onchange = () => {
        if (importInput.files[0]) importFile(importInput.files[0]);
        importInput.value = "";
    };
    btnImport.onclick = () => importInput.click();
    const btnExportAll = el("button", "pm-btn", "Export All");
    btnExportAll.onclick = () => exportAll();
    btnExportSel = el("button", "pm-btn", "Export selected");
    btnExportSel.hidden = true;
    btnExportSel.onclick = exportSelected;
    btnDeleteSel = el("button", "pm-btn danger", "Delete selected");
    btnDeleteSel.hidden = true;
    btnDeleteSel.onclick = deleteSelected;
    const btnManage = el("button", "pm-btn", "Manage");
    btnManage.onclick = () => {
        if (!confirmDiscard()) return;
        setEditingUI(false);
        setManagingUI(true);
    };
    const btnClose = el("button", "pm-btn close danger", "×");
    btnClose.onclick = closeManager;
    const btnPage = el("button", "pm-btn", fullPage ? "Modal" : "Full page");
    btnPage.title = "Toggle full page / modal";
    btnPage.onclick = () => {
        fullPage = !fullPage;
        localStorage.setItem("pm.fullpage", fullPage ? "1" : "0");
        applyFullPage();
    };
    btnPageEl = btnPage;
    // Standalone: there is no modal to switch back to and no overlay to close.
    if (STANDALONE) {
        btnClose.hidden = true;
        btnPage.hidden = true;
    }
    header.append(btnNew, btnImport, btnExportSel, btnDeleteSel, btnExportAll, btnManage, btnPage, btnClose);

    const body = el("div", "pm-body");

    const side = el("div", "pm-side");
    sideListEl = el("div", "pm-side-list");
    side.append(sideListEl);

    const listPane = el("div", "pm-list-pane");
    const filterRow = el("div", "pm-filter-row");
    searchEl = el("input", null, "");
    searchEl.placeholder = "Search presets, tags, text…";
    searchEl.value = searchQuery;
    searchEl.oninput = () => {
        searchQuery = searchEl.value.trim().toLowerCase();
        persistFilters();
        renderList();
    };
    catFilterEl = document.createElement("select");
    catFilterEl.onchange = () => {
        filterCategory = catFilterEl.value;
        renderFilters();
        renderList();
    };
    sideBtn = el("button", "pm-btn", "\u2630");
    sideBtn.title = "Show/hide category list";
    sideBtn.onclick = () => {
        sideOpen = !sideOpen;
        localStorage.setItem("pm.sideopen", sideOpen ? "1" : "0");
        applySide();
    };
    tagsBtn = el("button", "pm-btn pm-tags-btn", "Tags");
    tagsBtn.onclick = () => {
        tagPanelEl.hidden = !tagPanelEl.hidden;
        if (!tagPanelEl.hidden) renderTagPanel();
    };
    tagPanelEl = el("div", "pm-tagpanel");
    tagPanelEl.hidden = true;
    tagSearchEl = el("input", null);
    tagSearchEl.placeholder = "Filter tags…";
    tagSearchEl.oninput = () => renderTagPanel();
    tagListEl = el("div", "pm-taglist");
    tagPanelEl.append(tagSearchEl, tagListEl);
    tagRowEl = el("div", "pm-tag-row");
    // Pager: page size select + prev/next; hidden in "All" mode.
    pagerPrev = el("button", "pm-btn pm-pager-btn", "\u2039 Prev");
    pagerPrev.onclick = () => {
        view.page = Math.max(1, view.page - 1);
        scrollRestored = false;
        persistView();
        renderList();
    };
    pagerSizeSel = document.createElement("select");
    for (const s of [...PAGE_SIZES, "all"]) {
        pagerSizeSel.append(new Option(s === "all" ? "All" : String(s), String(s)));
    }
    pagerSizeSel.value = String(view.size);
    pagerSizeSel.onchange = () => {
        view.size = pagerSizeSel.value;
        view.page = 1;
        scrollRestored = false;
        persistView();
        renderList();
    };
    pagerInfo = el("div", "pm-pager-info", "");
    pagerNext = el("button", "pm-btn pm-pager-btn", "Next \u203a");
    pagerNext.onclick = () => {
        view.page += 1;
        scrollRestored = false;
        persistView();
        renderList();
    };
    pagerEl = el("div", "pm-pager");
    pagerEl.append(pagerPrev, pagerSizeSel, pagerInfo, pagerNext);
    filterRow.append(sideBtn, searchEl, catFilterEl, tagsBtn);
    gridEl = el("div", "pm-grid");
    gridEl.addEventListener("scroll", saveScroll);
    // The pager is a footer below the grid: always visible, never scrolled past.
    listPane.append(filterRow, tagPanelEl, tagRowEl, gridEl, pagerEl);

    const editorPane = el("div", "pm-editor-pane");
    editorEl = el("div", "pm-editor-holder");
    editorPane.append(editorEl);

    const managePane = el("div", "pm-manage-pane");
    const manageList = el("div", "pm-manage-list");
    manageSearchEl = el("input", null);
    manageSearchEl.placeholder = "Filter…";
    manageSearchEl.oninput = () => renderManageList();
    manageItemsEl = el("div", "pm-manage-items");
    manageList.append(manageSearchEl, manageItemsEl);
    manageEditEl = el("div", "pm-manage-edit");
    managePane.append(manageList, manageEditEl);

    body.append(side, listPane, editorPane, managePane);

    statusEl = el("div", "pm-footer");

    modal.append(header, body, statusEl);
    overlay.append(modal);
    document.body.appendChild(overlay);

    buildEditor();
    applySide();
}

// Shared by the Upload button and drag & drop.
function pmReadImageFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
        pendingImage = { type: "upload", dataUrl: reader.result };
        formDirty = true;
        updateImagePreview();
    };
    reader.readAsDataURL(file);
}

// Live preview of the assembled text; mirrors assemble_text over the three
// editor fields.
function updatePreview() {
    if (!fPreview) return;
    fPreview.textContent = [fPrefix.value, fPrompt.value, fSuffix.value]
        .map((s) => String(s || "").trim())
        .filter(Boolean)
        .join("\n\n");
}

// Live "file: …" hint under the name field; warns when the name already
// exists in the target category (saving overwrites it).
function updateNameHint() {
    const name = fName.value.trim();
    if (!name) {
        fSlugHint.className = "pm-hint";
        fSlugHint.textContent = "";
        return;
    }
    const cat = fCategory.value === NEW_CATEGORY ? "" : fCategory.value;
    const conflict = state.presets.some(
        (x) => x.name === name && (x.category || "") === cat && (!editing || x.slug !== editing.slug),
    );
    fSlugHint.className = conflict ? "pm-hint warn" : "pm-hint";
    fSlugHint.textContent =
        "file: " + presetRelPath(name, fCategory.value) + (conflict ? " · ⚠ same name in this category — saving overwrites it" : "");
}

function buildEditor() {
    const form = el("div", "pm-editor");

    const nameField = el("div", "pm-field");
    fName = el("input", null, "");
    fName.placeholder = "Preset name";
    fName.maxLength = 64;
    fSlugHint = el("div", "pm-hint", "");
    fName.oninput = updateNameHint;
    nameField.append(label("Name"), fName, fSlugHint);

    // Prefix and suffix sit side by side on desktop; the mobile media query
    // stacks them on their own lines.
    const psRow = el("div", "pm-row2");
    const prefixField = fieldArea("Prefix", 5, "Text before the prompt");
    fPrefix = prefixField.area;
    const suffixField = fieldArea("Suffix", 5, "Text after the prompt");
    fSuffix = suffixField.area;
    psRow.append(prefixField.field, suffixField.field);
    const promptField = fieldArea("Prompt", 21, "Prompt");
    fPrompt = promptField.area;

    // Live preview of the assembled text (what the node will produce).
    // Preview stays collapsed by default: it takes ~170px before any typing
    // happens, and it opens on demand from the head.
    const preview = document.createElement("details");
    preview.open = false;
    preview.className = "pm-preview";
    const previewHead = document.createElement("summary");
    previewHead.className = "pm-preview-head";
    const btnCopy = el("button", "pm-btn", "Copy");
    btnCopy.onclick = async (e) => {
        e.preventDefault();
        const t = fPreview.textContent;
        if (!t.trim()) return;
        try {
            await navigator.clipboard.writeText(t);
            showStatus("Copied assembled text", "ok");
        } catch {
            showStatus("Copy failed", "error");
        }
    };
    previewHead.append(label("Preview (assembled)"), btnCopy);
    fPreview = el("pre", "pm-preview-text", "");
    preview.append(previewHead, fPreview);

    const row2 = el("div", "pm-row2");
    const catField = el("div", "pm-field");
    fCategory = document.createElement("select");
    fCategory.onchange = () => {
        if (fCategory.value !== NEW_CATEGORY) {
            fNewCatRow.hidden = true;
        } else {
            fNewCatInput.value = "";
            fNewCatRow.hidden = false;
            fNewCatInput.focus();
        }
        updateNameHint();
    };
    fNewCatRow = el("div", "pm-newcat");
    fNewCatRow.hidden = true;
    fNewCatInput = el("input", null, "");
    fNewCatInput.placeholder = "New category name";
    fNewCatInput.maxLength = 64;
    const btnAddCat = el("button", "pm-btn", "Add");
    const addNewCategory = () => {
        const name = fNewCatInput.value.trim();
        if (!name) return;
        let opt = [...fCategory.options].find((o) => o.value === name);
        if (!opt) {
            opt = new Option(name, name);
            fCategory.add(opt, fCategory.options.length - 1);
        }
        fCategory.value = name;
        fNewCatRow.hidden = true;
    };
    btnAddCat.onclick = addNewCategory;
    fNewCatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            addNewCategory();
        } else if (e.key === "Escape") {
            fNewCatRow.hidden = true;
        }
    });
    fNewCatRow.append(fNewCatInput, btnAddCat);
    catField.append(label("Category"), fCategory, fNewCatRow);

    const tagField = el("div", "pm-field");
    const tagWrap = el("div", "pm-tag-wrap");
    fTagsInput = el("input", null, "");
    fTagsInput.placeholder = "pose, indoor, bed";
    tagSuggest = el("div", "pm-suggest");
    tagWrap.append(fTagsInput, tagSuggest);
    tagField.append(label("Tags"), tagWrap, el("div", "pm-hint", "comma separated · autocomplete from existing tags"));
    row2.append(catField, tagField);

    fTagsInput.addEventListener("input", updateTagSuggest);
    fTagsInput.addEventListener("blur", () => setTimeout(hideTagSuggest, 150));
    fTagsInput.addEventListener("keydown", (e) => {
        if (!tagSuggest.classList.contains("open")) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            suggestIndex =
                (suggestIndex + (e.key === "ArrowDown" ? 1 : -1) + suggestItems.length) % suggestItems.length;
            renderTagSuggest();
        } else if (e.key === "Enter") {
            e.preventDefault();
            applyTagSuggest(suggestItems[suggestIndex >= 0 ? suggestIndex : 0]);
        } else if (e.key === "Escape") {
            hideTagSuggest();
        }
    });

    const imgField = el("div", "pm-field");
    const imgRow = el("div", "pm-img-row");
    fImgPreview = el("img", "pm-img-preview");
    fImgPreview.onerror = () => fImgPreview.remove();
    const placeholder = el("div", "pm-img-placeholder", "drop or upload");
    const imgBtns = el("div", "pm-img-btns");
    fImgUpload = document.createElement("input");
    fImgUpload.type = "file";
    fImgUpload.accept = "image/*";
    fImgUpload.hidden = true;
    fImgUpload.onchange = () => {
        if (fImgUpload.files[0]) pmReadImageFile(fImgUpload.files[0]);
        fImgUpload.value = "";
    };
    const btnUpload = el("button", "pm-btn", "Upload");
    btnUpload.onclick = () => fImgUpload.click();
    const btnPick = el("button", "pm-btn", "From output");
    btnPick.onclick = () => openGalleryPicker();
    const btnRemove = el("button", "pm-btn danger", "Remove");
    btnRemove.onclick = () => {
        pendingImage = { type: "remove" };
        formDirty = true;
        updateImagePreview();
    };
    imgBtns.append(btnUpload, btnPick, btnRemove);
    imgRow.append(fImgPreview, placeholder, imgBtns);
    // drag & drop an image onto the row
    ["dragenter", "dragover"].forEach((ev) =>
        imgRow.addEventListener(ev, (e) => {
            e.preventDefault();
            imgRow.classList.add("pm-img-drop");
        }),
    );
    ["dragleave", "drop"].forEach((ev) =>
        imgRow.addEventListener(ev, (e) => {
            e.preventDefault();
            imgRow.classList.remove("pm-img-drop");
        }),
    );
    imgRow.addEventListener("drop", (e) => {
        const file = e.dataTransfer && e.dataTransfer.files[0];
        if (file && file.type.startsWith("image/")) pmReadImageFile(file);
    });
    imgField.append(label("Featured image"), imgRow, fImgUpload);
    imgField.className += " wide"; // the image row is the widest of the three
    row2.append(imgField);

    const actions = el("div", "pm-row2");
    const btnSave = el("button", "pm-btn success", "Save preset");
    btnSave.onclick = saveCurrent;
    const btnDuplicate = el("button", "pm-btn", "Duplicate");
    btnDuplicate.onclick = duplicateCurrent;
    const btnDelete = el("button", "pm-btn danger", "Delete");
    btnDelete.onclick = () => editing && deletePreset(editing);
    actions.append(btnSave, btnDuplicate, btnDelete);

    form.append(nameField, psRow, promptField.field, preview, row2, actions);
    form.dataset.built = "1";
    return form;
}

function label(text) {
    const l = document.createElement("label");
    l.textContent = text;
    return l;
}

function fieldArea(name, rows, placeholder) {
    const field = el("div", "pm-field");
    const area = el("textarea", null, "");
    area.rows = rows;
    area.placeholder = placeholder;
    field.append(label(name), area);
    return { field, area };
}

function parseTags(value) {
    const tags = [];
    for (const t of String(value || "").split(",")) {
        const tag = t.trim();
        if (tag && !tags.includes(tag)) tags.push(tag);
    }
    return tags;
}

function updateTagSuggest() {
    const value = fTagsInput.value;
    const start = value.lastIndexOf(",") + 1;
    const word = value.slice(start).trim().toLowerCase();
    if (!word) {
        hideTagSuggest();
        return;
    }
    const existing = new Set(parseTags(value.slice(0, start)));
    const existingWord = value.slice(start).trim();
    suggestItems = state.tags
        .filter((t) => t.toLowerCase().includes(word) && !existing.has(t) && t !== existingWord)
        .slice(0, 8);
    if (!suggestItems.length) {
        hideTagSuggest();
        return;
    }
    suggestIndex = 0;
    renderTagSuggest();
}

function renderTagSuggest() {
    tagSuggest.innerHTML = "";
    suggestItems.forEach((t, i) => {
        const item = el("div", i === suggestIndex ? "active" : "", t);
        item.onmousedown = (e) => {
            e.preventDefault(); // keep input focus
            applyTagSuggest(t);
        };
        tagSuggest.append(item);
    });
    tagSuggest.classList.add("open");
}

function applyTagSuggest(tag) {
    if (!tag) return;
    const value = fTagsInput.value;
    const comma = value.lastIndexOf(",");
    const head = (comma >= 0 ? value.slice(0, comma) : "").replace(/\s+$/, "");
    fTagsInput.value = (head ? head + ", " : "") + tag;
    hideTagSuggest();
    fTagsInput.focus();
}

function hideTagSuggest() {
    tagSuggest.classList.remove("open");
    suggestItems = [];
    suggestIndex = -1;
}

function refreshCategoryOptions(selected) {
    const keep = new Set(state.categories);
    for (const opt of [...fCategory.options]) {
        if (opt.value && opt.value !== NEW_CATEGORY) keep.add(opt.value);
    }
    const wanted = selected ?? fCategory.value;
    fCategory.innerHTML = "";
    fCategory.append(new Option("None", ""));
    for (const c of [...keep].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
        fCategory.append(new Option(c, c));
    }
    fCategory.append(new Option("+ Add new category…", NEW_CATEGORY));
    if ([...fCategory.options].some((o) => o.value === wanted)) fCategory.value = wanted;
    // A library refresh must not swallow the open new-category row.
    fNewCatRow.hidden = fCategory.value !== NEW_CATEGORY;
}

// ---------- list rendering ----------
function visiblePresets() {
    return state.presets.filter((p) => {
        if (filterCategory && p.category !== filterCategory) return false;
        if (filterTags.size && ![...filterTags].every((t) => p.tags.includes(t))) return false;
        if (searchQuery) {
            const hay = [p.name, assembleText(p), p.category, ...p.tags].join(" ").toLowerCase();
            if (!hay.includes(searchQuery)) return false;
        }
        return true;
    });
}

// Category sidebar: "All" + every category A-Z with its preset count. Click
// filters the grid (clicking the active category goes back to All); the
// dropdown in the filter row stays in sync as the shared source of truth.
function renderSide() {
    sideListEl.innerHTML = "";
    const item = (name, count, active) => {
        const row = el("div", "pm-side-item" + (active ? " active" : ""));
        row.append(el("span", "pm-side-name", name), el("span", "pm-side-count", String(count)));
        return row;
    };
    const all = item("All", state.presets.length, filterCategory === "");
    all.onclick = () => {
        filterCategory = "";
        catFilterEl.value = "";
        renderFilters();
        renderList();
    };
    sideListEl.append(all);
    for (const c of [...state.categories].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
        const row = item(c, state.presets.filter((p) => p.category === c).length, filterCategory === c);
        row.onclick = () => {
            filterCategory = filterCategory === c ? "" : c;
            catFilterEl.value = filterCategory;
            renderFilters();
            renderList();
        };
        sideListEl.append(row);
    }
}

function renderFilters() {
    catFilterEl.innerHTML = "";
    catFilterEl.append(new Option("All categories", ""));
    for (const c of state.categories) catFilterEl.append(new Option(c, c));
    // filterCategory is the source of truth (it survives a page reload via
    // localStorage); validate it against the library and sync the dropdown.
    if (!state.categories.includes(filterCategory)) filterCategory = "";
    catFilterEl.value = filterCategory;

    // Drop filter tags that no longer exist (deleted outside the filter UI).
    for (const t of [...filterTags]) {
        if (!state.tags.includes(t)) filterTags.delete(t);
    }

    // Selected tags as removable chips; the full list lives in the Tags panel.
    tagRowEl.innerHTML = "";
    for (const t of [...filterTags]) {
        const chip = el("span", "pm-tag active", t);
        const x = el("span", "pm-tag-x", "×");
        x.onclick = (e) => {
            e.stopPropagation();
            filterTags.delete(t);
            renderFilters();
            renderList();
        };
        chip.append(x);
        tagRowEl.append(chip);
    }
    tagRowEl.hidden = !filterTags.size;
    tagsBtn.textContent = filterTags.size ? "Tags (" + filterTags.size + ")" : "Tags";
    if (!tagPanelEl.hidden) renderTagPanel();
    renderSide();
    persistFilters();
    persistView();
}

function renderTagPanel() {
    tagListEl.innerHTML = "";
    const q = (tagSearchEl.value || "").trim().toLowerCase();
    const tags = [...state.tags]
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
        .filter((t) => !q || t.toLowerCase().includes(q));
    if (!tags.length) {
        tagListEl.append(el("div", "pm-tagger-empty", state.tags.length ? "no tags match" : "no tags yet"));
        return;
    }
    for (const t of tags) {
        const chip = el("span", "pm-tag" + (filterTags.has(t) ? " active" : ""), t);
        chip.onclick = () => {
            if (filterTags.has(t)) filterTags.delete(t);
            else filterTags.add(t);
            renderFilters();
            renderList();
        };
        tagListEl.append(chip);
    }
}

// Manage page: pick a category or tag in the left list, edit it on the right.
function setManagingUI(on) {
    managing = on;
    if (overlay) overlay.classList.toggle("pm-managing", on);
    titleEl.textContent = on ? "Manage categories & tags" : editing ? "Edit: " + editing.name : "Prompt Manager";
    if (on) renderManage();
}

function renderManage() {
    renderManageList();
    renderManageEdit();
}

function renderManageList() {
    const q = (manageSearchEl.value || "").trim().toLowerCase();
    manageItemsEl.innerHTML = "";
    const section = (title, items, kind) => {
        const sec = el("div", "pm-manage-sec");
        sec.append(el("div", "pm-tagger-title", title + " (" + items.length + ")"));
        for (const name of items) {
            const it = el(
                "div",
                "pm-manage-item" + (manageSel && manageSel.kind === kind && manageSel.name === name ? " active" : ""),
                name,
            );
            it.title = name;
            it.onclick = () => {
                manageSel = { kind, name };
                renderManage();
            };
            sec.append(it);
        }
        manageItemsEl.append(sec);
    };
    const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });
    const cats = [...state.categories].sort(byName).filter((c) => !q || c.toLowerCase().includes(q));
    const tags = [...state.tags].sort(byName).filter((t) => !q || t.toLowerCase().includes(q));
    section("Categories", cats, "category");
    section("Tags", tags, "tag");
    if (!cats.length && !tags.length) manageItemsEl.append(el("div", "pm-tagger-empty", "nothing to show"));
}

function renderManageEdit() {
    manageEditEl.innerHTML = "";
    if (!manageSel) {
        manageEditEl.append(el("div", "pm-tagger-empty", "Select a category or tag on the left to edit it"));
        return;
    }
    const kind = manageSel.kind;
    const name = manageSel.name;
    if (!(kind === "category" ? state.categories : state.tags).includes(name)) {
        manageSel = null;
        renderManage();
        return;
    }
    const uses = kind === "category"
        ? state.presets.filter((p) => p.category === name)
        : state.presets.filter((p) => p.tags.includes(name));

    const title = el("div", "pm-manage-title");
    title.append(el("span", null, name), el("span", "pm-badge", kind));
    manageEditEl.append(title, el("div", "pm-manage-meta", "Used in " + uses.length + " preset(s)"));

    const row = el("div", "pm-manage-row");
    const input = el("input", null);
    input.value = name;
    input.maxLength = 64;
    input.spellcheck = false;
    const btnRename = el("button", "pm-btn primary", "Rename");
    const doRename = () => manageRename(kind, name, input.value.trim());
    btnRename.onclick = doRename;
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            doRename();
        }
    });
    const btnDelete = el("button", "pm-btn danger", kind === "category" ? "Delete category" : "Delete tag");
    btnDelete.onclick = () => manageDelete(kind, name);
    row.append(input, btnRename, btnDelete);
    manageEditEl.append(row);

    const list = el("div", "pm-manage-sec");
    list.append(el("div", "pm-tagger-title", "Presets (" + uses.length + ")"));
    for (const p of uses) {
        const r = el("div", "pm-manage-preset", p.name);
        r.title = "Open in editor";
        r.onclick = () => {
            setManagingUI(false);
            openInEditor(p);
        };
        list.append(r);
    }
    if (!uses.length) list.append(el("div", "pm-tagger-empty", "no presets use this"));
    manageEditEl.append(list);
}

async function manageRename(kind, name, next) {
    if (!next || next === name) return;
    try {
        const j = kind === "category" ? await api.renameCategory(name, next) : await api.renameTag(name, next);
        showStatus('Renamed "' + name + '" → "' + next + '" in ' + j.changed + " preset(s)", "ok");
        manageSel = { kind, name: next };
        await refreshPresets();
        renderManage();
    } catch (e) {
        showStatus(e.message, "error");
    }
}

async function manageDelete(kind, name) {
    // a category is its folder: only an empty one can be deleted
    if (kind === "category") {
        const count = state.presets.filter((p) => p.category === name).length;
        if (count) return showStatus('"' + name + '" still has ' + count + " preset(s) — delete them first", "error");
    }
    const hint = kind === "category" ? 'Delete category "' + name + '" and its folder?' : 'Delete "' + name + '" from all presets?';
    if (!confirm(hint)) return;
    try {
        await (kind === "category" ? api.renameCategory(name, "") : api.renameTag(name, ""));
        if (kind === "tag") filterTags.delete(name);
        else if (filterCategory === name) filterCategory = "";
        manageSel = null;
        showStatus(kind === "category" ? 'Deleted category "' + name + '"' : 'Deleted "' + name + '"', "ok");
        await refreshPresets();
        renderManage();
    } catch (e) {
        showStatus(e.message, "error");
    }
}


function renderList() {
    gridEl.innerHTML = "";
    // drop selections for presets that no longer exist
    for (const slug of [...cardSel]) {
        if (!state.presets.some((p) => p.slug === slug)) cardSel.delete(slug);
    }
    const all = visiblePresets();
    if (!all.length) {
        gridEl.append(
            el("div", "pm-loading", state.presets.length ? "No presets match" : "No presets yet — click “+ New”"),
        );
        pagerEl.hidden = true;
        updateSelBtn();
        return;
    }
    // Paginate the filtered list; "all" disables pagination.
    let pagePresets = all;
    if (view.size !== "all") {
        const count = Math.max(1, Math.ceil(all.length / view.size));
        view.page = Math.min(Math.max(1, view.page), count);
        const start = (view.page - 1) * view.size;
        pagePresets = all.slice(start, start + view.size);
        pagerPrev.disabled = view.page === 1;
        pagerNext.disabled = view.page === count;
        pagerInfo.textContent = "" + view.page + "/" + count;
    }
    pagerEl.hidden = view.size === "all";

    for (const p of pagePresets) {
        const card = el(
            "div",
            "pm-card" + ((editing && editing.slug === p.slug) || cardSel.has(p.slug) ? " selected" : ""),
        );
        card.title = p.name;
        card.append(el("div", "pm-card-name", p.name));
        if (p.has_image) {
            const img = el("img", "pm-card-img");
            img.loading = "lazy";
            img.alt = p.name;
            img.src = api.imageSrc(p.slug);
            img.onerror = () => img.replaceWith(el("div", "pm-card-noimg", "•"));
            card.append(img);
        } else {
            card.append(el("div", "pm-card-noimg", "•"));
        }
        const meta = el("div", "pm-card-meta");
        if (p.category) meta.append(el("span", "pm-badge", p.category));
        for (const t of p.tags.slice(0, 4)) meta.append(el("span", "pm-card-tag", "#" + t));
        card.append(meta);

        const actions = el("div", "pm-card-actions");
        const btnSelect = el("button", null, cardSel.has(p.slug) ? "☑" : "☐");
        btnSelect.title = "Select for export";
        btnSelect.onclick = (e) => {
            e.stopPropagation();
            cardSel.has(p.slug) ? cardSel.delete(p.slug) : cardSel.add(p.slug);
            btnSelect.textContent = cardSel.has(p.slug) ? "☑" : "☐";
            card.classList.toggle("selected", cardSel.has(p.slug) || (!!editing && editing.slug === p.slug));
            updateSelBtn();
        };
        const btnExport = el("button", null, "⤓");
        btnExport.title = "Export";
        btnExport.onclick = (e) => {
            e.stopPropagation();
            exportPreset(p);
        };
        const btnDelete = el("button", null, "✕");
        btnDelete.title = "Delete";
        btnDelete.onclick = (e) => {
            e.stopPropagation();
            deletePreset(p);
        };
        actions.append(btnSelect, btnExport, btnDelete);
        card.append(actions);

        card.onclick = () => {
            if (!confirmDiscard()) return;
            openInEditor(p);
        };
        gridEl.append(card);
    }
    updateSelBtn();
    restoreScroll();
    if (!scrollRestored) {
        scrollRestored = true;
        persistView();
    }
}

// Remember where the user scrolled in the grid and restore it after reload.
let scrollSaveTimer = null;
function saveScroll() {
    const top = gridEl.scrollTop;
    if (scrollSaveTimer) return;
    scrollSaveTimer = setTimeout(() => {
        scrollSaveTimer = null;
        view.scroll = top;
        persistView();
    }, 250);
}
function restoreScroll() {
    if (view.scroll > 0) {
        const max = Math.max(0, gridEl.scrollHeight - gridEl.clientHeight);
        gridEl.scrollTop = Math.min(view.scroll, max);
    }
}

function renderAll() {
    renderFilters();
    renderList();
    if (editorEl.querySelector(".pm-editor")) refreshCategoryOptions();
}

// ---------- editor ----------
function setEditingUI(on) {
    if (overlay) overlay.classList.toggle("pm-editing", on);
}

function confirmDiscard() {
    if (!formDirty) return true;
    return confirm("Discard unsaved changes?");
}

function showEmpty() {
    editing = null;
    pendingImage = null;
    formDirty = false;
    editorEl.innerHTML = "";
    titleEl.textContent = "Prompt Manager";
    setEditingUI(false);
    renderList();
}

function startNew() {
    editing = null;
    pendingImage = null;
    showForm({ name: "", prefix: "", prompt: "", suffix: "", category: "", tags: [] });
}

// The /list summary already carries everything the editor needs, so the
// editor opens straight from state — no fetch, no base64 image round-trip.
function openInEditor(p) {
    editing = { name: p.name, slug: p.slug };
    pendingImage = null;
    showForm({
        name: p.name,
        prefix: p.prefix ?? "",
        prompt: p.prompt ?? "",
        suffix: p.suffix ?? "",
        category: p.category || "",
        tags: [...(p.tags || [])],
    });
}

function showForm(data) {
    const old = editorEl.querySelector(".pm-editor");
    if (old) old.remove();
    const form = buildEditor();
    formDirty = false;
    titleEl.textContent = data.name ? "Edit: " + data.name : "New preset";
    const markDirty = () => {
        formDirty = true;
        updatePreview();
    };
    form.addEventListener("input", markDirty);
    form.addEventListener("change", markDirty);
    fName.value = data.name;
    fPrefix.value = data.prefix;
    fPrompt.value = data.prompt;
    fSuffix.value = data.suffix;
    refreshCategoryOptions(data.category || "");
    fTagsInput.value = (data.tags || []).join(", ");
    updateNameHint();
    updatePreview();
    pendingImage = null;
    editorEl.append(form);
    setEditingUI(true);
    updateImagePreview();
    renderList();
    fName.focus();
}

function updateImagePreview() {
    const form = editorEl.querySelector(".pm-editor");
    if (!form) return;
    const preview = form.querySelector(".pm-img-preview");
    const placeholder = form.querySelector(".pm-img-placeholder");
    const show = (src) => {
        if (src) {
            if (!preview.parentNode) form.querySelector(".pm-img-row").prepend(preview);
            preview.onerror = null;
            preview.src = src;
            placeholder.style.display = "none";
        } else {
            preview.removeAttribute("src");
            if (placeholder.parentNode) placeholder.style.display = "";
        }
    };
    if (pendingImage?.type === "upload") show(pendingImage.dataUrl);
    else if (pendingImage?.type === "output") show(api.gallerySrc(pendingImage.path));
    else if (pendingImage?.type === "existing") show(api.imageSrc(pendingImage.slug));
    else if (pendingImage?.type === "remove") show(null);
    else if (editing) {
        // slug first: it is globally unique, names may repeat across categories
        const p =
            state.presets.find((x) => x.slug === editing.slug) || state.presets.find((x) => x.name === editing.name);
        show(p?.has_image ? api.imageSrc(p.slug) : null);
    } else show(null);
}

function editorPayload() {
    return {
        name: fName.value.trim(),
        prefix: fPrefix.value,
        prompt: fPrompt.value,
        suffix: fSuffix.value,
        category: fCategory.value === NEW_CATEGORY ? "" : fCategory.value,
        tags: parseTags(fTagsInput.value),
        old_slug: editing ? editing.slug : null,
        image: pendingImage?.type === "upload" ? pendingImage.dataUrl : null,
        image_output_path: pendingImage?.type === "output" ? pendingImage.path : null,
        image_source: pendingImage?.type === "existing" ? pendingImage.slug : null,
        image_remove: pendingImage?.type === "remove" ? true : null,
    };
}

// ---------- actions ----------
async function duplicateCurrent() {
    if (!editing) return;
    const p = state.presets.find((x) => x.slug === editing.slug);
    if (!p) return;

    // " (copy)", then " (copy) 2", …: the first name that is free in the
    // preset's own category (names may repeat across categories)
    const taken = new Set(
        state.presets
            .filter((x) => (x.category || "") === (p.category || ""))
            .map((x) => x.name),
    );
    let name = p.name + " (copy)";
    for (let n = 2; taken.has(name); n++) name = `${p.name} (copy) ${n}`;

    const copy = {
        name,
        prefix: p.prefix,
        prompt: p.prompt,
        suffix: p.suffix,
        category: p.category,
        tags: [...p.tags],
        // Copy the image via the source preset's slug
        image_source: p.slug,
    };

    showStatus("Duplicating…", "");
    try {
        const res = await api.save(copy);
        editing = { name: res.preset.name, slug: res.preset.slug };
        pendingImage = null;
        formDirty = false;
        await refreshPresets();
        const newP = state.presets.find((x) => x.slug === editing.slug);
        if (newP) openInEditor(newP);
        showStatus("Duplicated “" + editing.name + "”", "ok");
    } catch (e) {
        showStatus(e.message, "error");
    }
}

async function saveCurrent() {
    let payload = editorPayload();
    // Same name in the same category is a conflict (names may repeat across
    // categories). Warn before submitting; confirming = explicit overwrite.
    const conflict = state.presets.find(
        (x) =>
            x.name === payload.name &&
            (x.category || "") === payload.category &&
            (!editing || x.slug !== editing.slug),
    );
    if (
        conflict &&
        !confirm('A preset named "' + payload.name + '" already exists in this category. Overwrite it?')
    )
        return;
    if (conflict) payload.replace = true;
    showStatus("Saving…", "");
    try {
        const res = await api.save(payload);
        editing = { name: res.preset.name, slug: res.preset.slug };
        pendingImage = null;
        formDirty = false;
        await refreshPresets();
        const p = state.presets.find((x) => x.slug === editing.slug);
        if (p) openInEditor(p);
        showStatus("Saved “" + editing.name + "”", "ok");
    } catch (e) {
        showStatus(e.message, "error");
    }
}

async function deletePreset(p) {
    if (!confirm('Delete preset "' + p.name + '"?')) return;
    try {
        await api.remove(p.slug);
        if (editing && editing.slug === p.slug) showEmpty();
        await refreshPresets();
        showStatus("Deleted", "ok");
    } catch (e) {
        showStatus(e.message, "error");
    }
}

async function exportPreset(p) {
    try {
        const blob = await api.exportBlob([p.slug]);
        downloadBlob(blob, p.slug + ".json");
        showStatus("Exported", "ok");
    } catch (e) {
        showStatus(e.message, "error");
    }
}

async function exportAll() {
    try {
        const blob = await api.exportBlob(null);
        downloadBlob(blob, "comfyui-prompt-presets.json");
        showStatus("Exported " + state.presets.length + " presets", "ok");
    } catch (e) {
        showStatus(e.message, "error");
    }
}

function updateSelBtn() {
    if (!btnExportSel) return;
    btnExportSel.hidden = !cardSel.size;
    btnExportSel.textContent = "Export selected (" + cardSel.size + ")";
    btnDeleteSel.hidden = !cardSel.size;
    btnDeleteSel.textContent = "Delete selected (" + cardSel.size + ")";
}

async function exportSelected() {
    const slugs = [...cardSel];
    if (!slugs.length) return;
    try {
        const blob = await api.exportBlob(slugs);
        downloadBlob(blob, "comfyui-prompt-presets.json");
        showStatus("Exported " + slugs.length + " presets", "ok");
        cardSel.clear();
        updateSelBtn();
        renderList();
    } catch (e) {
        showStatus(e.message, "error");
    }
}

async function deleteSelected() {
    const slugs = [...cardSel];
    if (!slugs.length) return;
    const names = slugs.map((s) => state.presets.find((p) => p.slug === s)?.name || s);
    if (!confirm("Delete " + slugs.length + " preset(s)?\n\n" + names.join(", "))) return;
    const wasEditing = editing && cardSel.has(editing.slug);
    try {
        await Promise.all(slugs.map((s) => api.remove(s)));
        cardSel.clear();
        if (wasEditing) showEmpty();
        await refreshPresets();
        showStatus("Deleted " + slugs.length + " preset(s)", "ok");
        renderList();
    } catch (e) {
        showStatus(e.message, "error");
    }
}

async function importFile(file) {
    try {
        const payload = JSON.parse(await file.text());
        // Preview first: nothing is written until the user confirms.
        const dry = await api.import(payload, true);
        let msg =
            "Import " + file.name + "?\n\n" +
            "new: " + dry.imported.length +
            " · overwrite: " + (dry.overwritten || []).length +
            " · skipped: " + (dry.skipped || []).length;
        if (dry.overwritten && dry.overwritten.length) msg += "\n\nOverwritten:\n" + dry.overwritten.join(", ");
        if (dry.skipped && dry.skipped.length) msg += "\n\nSkipped:\n" + dry.skipped.join(", ");
        if (!confirm(msg)) return;
        const res = await api.import(payload, false);
        await refreshPresets();
        let msg2 = "Imported " + res.imported.length + " preset" + (res.imported.length === 1 ? "" : "s");
        if (res.overwritten && res.overwritten.length) msg2 += " (" + res.overwritten.length + " replaced)";
        const skipped = res.skipped || [];
        if (skipped.length) msg2 += " — skipped " + skipped.length + ": " + skipped.join(", ");
        showStatus(msg2, res.imported.length ? "ok" : "error");
    } catch (e) {
        showStatus("Import failed: " + e.message, "error");
    }
}

function showStatus(msg, kind) {
    statusEl.innerHTML = "";
    statusEl.append(el("span", "pm-status" + (kind ? " " + kind : ""), msg));
    clearTimeout(statusTimer);
    // errors stay visible until the next action; everything else clears after 4s
    statusTimer = kind === "error" ? null : setTimeout(() => (statusEl.innerHTML = ""), 4000);
}

// ---------- gallery picker ----------
let gOverlay = null;
let gGrid = null;
let gSearchEl = null;
let gFiles = [];
let gLoading = false;

function ensureGallery() {
    if (gOverlay) return;
    gOverlay = el("div", "pm-overlay");
    gOverlay.hidden = true;
    gOverlay.style.zIndex = 10000;
    const modal = el("div", "pm-modal");
    const header = el("div", "pm-header");
    header.append(el("div", "pm-title", "Pick from output"));
    gSearchEl = el("input", "pm-gallery-search", "");
    gSearchEl.placeholder = "Filter images…";
    gSearchEl.oninput = () => renderGallery();
    header.append(gSearchEl);
    const close = el("button", "pm-btn close danger", "×");
    close.onclick = closeGallery;
    header.append(close);
    gGrid = el("div", "pm-gallery-grid");
    modal.append(header, gGrid);
    gOverlay.append(modal);
    document.body.appendChild(gOverlay);
}

function renderGallery() {
    const q = ((gSearchEl ? gSearchEl.value : "") || "").trim().toLowerCase();
    gGrid.innerHTML = "";
    if (gLoading) {
        gGrid.append(el("div", "pm-loading", "Loading…"));
        return;
    }
    const files = gFiles.filter((f) => !q || f.name.toLowerCase().includes(q));
    if (!files.length) {
        gGrid.append(el("div", "pm-loading", gFiles.length ? "No images match" : "No images in the output folder"));
        return;
    }
    for (const f of files) {
        const img = new Image();
        img.className = "pm-gimg";
        img.loading = "lazy";
        img.src = api.gallerySrc(f.name);
        img.title = f.name;
        img.onclick = () => {
            pendingImage = { type: "output", path: f.name };
            formDirty = true;
            updateImagePreview();
            closeGallery();
        };
        gGrid.append(img);
    }
}

function openGalleryPicker() {
    ensureGallery();
    gOverlay.hidden = false;
    if (gSearchEl) gSearchEl.value = "";
    gFiles = [];
    gLoading = true;
    renderGallery();
    api.gallery(200)
        .then((files) => {
            gFiles = files;
            gLoading = false;
            renderGallery();
        })
        .catch((e) => {
            gLoading = false;
            gGrid.innerHTML = "";
            gGrid.append(el("div", "pm-loading", e.message));
        });
}

function closeGallery() {
    if (gOverlay) gOverlay.hidden = true;
}
function applyFullPage() {
    if (overlay) overlay.classList.toggle("pm-full", fullPage);
    if (btnPageEl) btnPageEl.textContent = fullPage ? "Modal" : "Full page";
}

function applySide() {
    if (overlay) overlay.classList.toggle("pm-side-open", sideOpen);
    if (sideBtn) sideBtn.classList.toggle("on", sideOpen);
}

function openManager(full) {
    ensureOverlay();

    if (full) {
        fullPage = true;
        localStorage.setItem("pm.fullpage", "1");
    }
    applyFullPage();
    overlay.hidden = false;
    refreshPresets();
    if (!editing && !editorEl.querySelector(".pm-editor")) showEmpty();
}

function closeManager() {
    if (!confirmDiscard()) return;
    showEmpty();
    managing = false;
    setManagingUI(false);
    if (gOverlay) gOverlay.hidden = true;
    overlay.hidden = true;
    refreshPresets();
}

// "Save Preset" from a node: open the editor with the node's prefix/text/
// suffix verbatim. If all three match the selected preset's parts, open
// that preset; else open a new preset with the parts in place.
// (Name left for the user.)
export function openEditorFromNodeText(fields, presetName, category) {
    openManager();
    const { prefix, text, suffix } = fields;
    const t = (s) => String(s || "").trim();
    const preset =
        presetName &&
        state.presets.find((p) => p.name === presetName && (!category || p.category === category));
    const same =
        preset && t(preset.prefix) === prefix && t(preset.prompt) === text && t(preset.suffix) === suffix;
    if (same) {
        openInEditor(preset);
        return;
    }
    startNew();
    if (preset) {
        fName.value = preset.name + " (edited)";
        fCategory.value = preset.category || "";
        // Inherit the cover image from the original preset
        if (preset.has_image) {
            pendingImage = { type: "existing", slug: preset.slug };
        }
    } else if (category && state.categories.includes(category)) {
        fCategory.value = category;
    }
    fPrefix.value = prefix;
    fPrompt.value = text;
    fSuffix.value = suffix;
    updateNameHint();
    updateImagePreview();
    [fPrefix, fPrompt, fSuffix].forEach((f) => f.dispatchEvent(new Event("input")));
    showStatus("Text loaded from the node — give it a name and save", "ok");
}

// Library listeners: re-render the open manager on refresh, surface fetch
// errors. Wired here (not at import time) so a bare import of this module has
// no side effects — the frontend loads every web/*.js file as an extension.
export function registerManager() {
    pmOn("library", () => {
        if (!overlayVisible()) return;
        renderAll();
        if (managing) renderManage();
    });
    pmOn("library-error", (e) => {
        if (overlayVisible()) showStatus("Failed to load presets: " + e.message, "error");
    });
    // Ctrl/Cmd+S saves the open editor (the browser page-save is useless here).
    document.addEventListener("keydown", (e) => {
        if (!(e.ctrlKey || e.metaKey) || (e.key !== "s" && e.key !== "S")) return;
        if (overlayVisible() && overlay.classList.contains("pm-editing")) {
            e.preventDefault();
            e.stopPropagation();
            saveCurrent();
        }
    });
}

export function galleryVisible() {
    return gOverlay && !gOverlay.hidden;
}

export { openManager, closeManager, overlayVisible, closeGallery };
