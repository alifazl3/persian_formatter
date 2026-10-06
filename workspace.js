/* Document tabs. Every text opens in its own tab. A tab is a local draft
   (kept in this browser only) until it is saved to the library; a saved tab
   stays linked to its document and shows when it has unsaved changes. */
const TABS_KEY = "pf_tabs_v1";
const LAST_FOLDER_KEY = "pf_last_folder";
const MAX_TABS = 30;
const workspace = { tabs: [], activeId: null, persistent: true };

const newTabId = () => (crypto.randomUUID ? crypto.randomUUID() : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
const activeTab = () => workspace.tabs.find(tab => tab.id === workspace.activeId);
/* Besides text tabs there are tool tabs (the date converter), at most one each. */
const isTextTab = tab => !tab.kind || tab.kind === "text";
const isDirty = tab => isTextTab(tab) && (tab.doc ? tab.content !== tab.doc.content : tab.content.trim() !== "");
const canEditTab = tab => !tab.doc || canEditRole(tab.doc.role);

function deriveTitle(content) {
  const line = content.split(/\r?\n/).map(part => part.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean);
  return line ? line.slice(0, 80) : "";
}
const shortTitle = title => title.length > 40 ? `${title.slice(0, 40).trim()}…` : title;
function tabTitle(tab) { if (tab.kind === "date") return "تبدیل تاریخ"; return tab.doc?.title || deriveTitle(tab.content) || "متن تازه"; }

/** The saved state a tab is linked to; `content` is the last saved body. */
function docState(doc) {
  return { id: doc.id, folderId: doc.folderId, title: doc.title, version: doc.version, content: doc.content, role: doc.role };
}

// --- persistence (drafts survive reloads, in this browser only) ---

function parseTabs(list) {
  const tabs = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw?.id !== "string" || typeof raw.content !== "string") continue;
    const tab = { id: raw.id, content: raw.content, doc: null };
    if (raw.kind === "date") tab.kind = "date";
    if (raw.doc && typeof raw.doc.id === "string") {
      // Clean tabs store their body once; the saved baseline equals the content.
      tab.doc = { ...raw.doc, content: typeof raw.doc.content === "string" ? raw.doc.content : raw.content };
    }
    tabs.push(tab);
  }
  return tabs;
}

function loadWorkspace() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(TABS_KEY) || "null"); } catch (_) { workspace.persistent = false; }
  workspace.tabs = parseTabs(stored?.tabs);
  if (!workspace.tabs.length) workspace.tabs.push({ id: newTabId(), content: "", doc: null });
  workspace.activeId = workspace.tabs.some(tab => tab.id === stored?.activeId) ? stored.activeId : workspace.tabs[0].id;
}

let persistTimer;
function persistWorkspace(now = false) {
  clearTimeout(persistTimer);
  const write = () => {
    const tabs = workspace.tabs.map(tab => ({
      id: tab.id,
      kind: tab.kind,
      content: tab.content,
      doc: tab.doc && { ...tab.doc, content: isDirty(tab) ? tab.doc.content : undefined },
    }));
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify({ activeId: workspace.activeId, tabs }));
      workspace.persistent = true;
    } catch (_) {
      if (workspace.persistent) libraryToast("فضای ذخیرهٔ مرورگر پر یا غیرفعال است؛ پیش‌نویس‌ها پس از بستن صفحه باقی نمی‌مانند.", true);
      workspace.persistent = false;
    }
  };
  if (now) write(); else persistTimer = setTimeout(write, 400);
}
window.addEventListener("pagehide", () => persistWorkspace(true));

/**
 * Several browser tabs share one saved workspace. When another one saves,
 * adopt its tabs but keep the tab being edited here, so neither page
 * overwrites the other's drafts with a stale copy.
 */
function workspaceStorageChanged(event) {
  if (event.key !== TABS_KEY || !event.newValue) return;
  let stored;
  try { stored = JSON.parse(event.newValue); } catch (_) { return; }
  const tabs = parseTabs(stored?.tabs);
  const current = activeTab();
  if (current) {
    const at = tabs.findIndex(tab => tab.id === current.id);
    if (at >= 0) tabs[at] = current; else tabs.push(current);
  }
  if (!tabs.length) return;
  workspace.tabs = tabs;
  renderTabs();
  renderLibrary();
}
window.addEventListener("storage", workspaceStorageChanged);

// --- tab lifecycle ---

function createTab({ content = "", doc = null, kind = undefined } = {}) {
  if (workspace.tabs.length >= MAX_TABS) {
    libraryToast(`حداکثر ${MAX_TABS.toLocaleString("fa-IR")} زبانه می‌توانید باز کنید؛ چند زبانه را ببندید.`, true);
    return null;
  }
  const tab = { id: newTabId(), content, doc: doc && docState(doc) };
  if (kind) tab.kind = kind;
  const at = workspace.tabs.findIndex(item => item.id === workspace.activeId);
  workspace.tabs.splice(at + 1, 0, tab);
  return tab;
}

function newTab() {
  const tab = createTab();
  if (!tab) return;
  selectTab(tab.id);
  expandInput();
}

/** Sidebar "پرشین فرمتر": a fresh text tab (or the current one, if it is still empty). */
function openFormatterTab() {
  const tab = activeTab();
  if (isTextTab(tab) && !tab.doc && !tab.content.trim()) { selectTab(tab.id); input.focus(); return; }
  newTab();
}

/** Sidebar "تاریخ": the date converter tab, opened once and focused afterwards. */
function openDateTab() {
  const existing = workspace.tabs.find(tab => tab.kind === "date");
  const tab = existing || createTab({ kind: "date" });
  if (tab) selectTab(tab.id);
}

/** Opening the app starts on a blank tab: an existing empty draft, or a new one at the end. */
function startOnBlankTab() {
  const blank = workspace.tabs.find(tab => isTextTab(tab) && !tab.doc && !tab.content.trim());
  if (blank) return blank;
  if (workspace.tabs.length >= MAX_TABS) return workspace.tabs.find(isTextTab) || workspace.tabs[0];
  const tab = { id: newTabId(), content: "", doc: null };
  workspace.tabs.push(tab);
  return tab;
}

/** A text tab for new content: the active one if it is an empty draft, else a new tab. */
function textTabForNewContent() {
  const tab = activeTab();
  return isTextTab(tab) && !tab.doc && !tab.content.trim() ? tab : createTab();
}

/** Shows the tab: the date view, or its text in the editor and preview. */
function showTab(tab) {
  if (!isTextTab(tab)) { switchTab(tab.kind, false); return; }
  switchTab("format", false);
  input.value = tab.content;
  render();
  if (tab.content.trim()) collapseInput();
  else { document.getElementById("inputShell").classList.remove("collapsed"); editingInput = false; }
}

function selectTab(id) {
  const tab = workspace.tabs.find(item => item.id === id);
  if (!tab) return;
  workspace.activeId = id;
  showTab(tab);
  renderTabs();
  persistWorkspace();
  syncTab(tab);
}

async function closeTab(id) {
  const tab = workspace.tabs.find(item => item.id === id);
  if (!tab) return;
  if (isDirty(tab)) {
    const ok = await libraryAsk({
      title: `بستن «${shortTitle(tabTitle(tab))}»`,
      description: tab.doc ? "تغییرات ذخیره‌نشدهٔ این متن از بین می‌رود. نسخهٔ ذخیره‌شده در کتابخانه می‌ماند." : "این متن ذخیره نشده است و با بستن زبانه از بین می‌رود.",
      confirm: "بستن بدون ذخیره", destructive: true, skipKey: "close_unsaved",
    });
    if (!ok) return;
  }
  const index = workspace.tabs.indexOf(tab);
  workspace.tabs.splice(index, 1);
  if (!workspace.tabs.length) workspace.tabs.push({ id: newTabId(), content: "", doc: null });
  if (workspace.activeId === id) selectTab(workspace.tabs[Math.min(index, workspace.tabs.length - 1)].id);
  else { renderTabs(); persistWorkspace(); }
  renderLibrary();
}

/** Closes every tab, asking once if any of them has unsaved text. */
async function closeAllTabs() {
  const unsaved = workspace.tabs.filter(isDirty);
  if (unsaved.length) {
    const ok = await libraryAsk({
      title: "بستن همهٔ زبانه‌ها",
      description: `${unsaved.length.toLocaleString("fa-IR")} زبانه تغییر ذخیره‌نشده دارد (${unsaved.slice(0, 3).map(t => `«${shortTitle(tabTitle(t))}»`).join("، ")}${unsaved.length > 3 ? "، …" : ""}) و با بستن از بین می‌رود. متن‌های ذخیره‌شده در کتابخانه می‌مانند.`,
      confirm: "بستن همه", destructive: true, skipKey: "close_unsaved",
    });
    if (!ok) return;
  }
  const fresh = { id: newTabId(), content: "", doc: null };
  workspace.tabs = [fresh];
  selectTab(fresh.id);
  persistWorkspace(true);
  renderLibrary();
  expandInput();
}

/** Editor input: the textarea always edits the active tab. */
function workspaceInput() {
  const tab = activeTab();
  if (!tab || !isTextTab(tab)) return;
  tab.content = input.value;
  updateTabChrome(tab);
  persistWorkspace();
}

/** New text (paste button, file, shared link) opens in a fresh tab unless the current one is empty. */
function placeText(text) {
  const tab = textTabForNewContent();
  if (!tab) return false;
  tab.content = text;
  selectTab(tab.id);
  return true;
}

/** "Clear": empties a draft; a saved text is left intact and a fresh tab opens instead. */
function clearActiveTab() {
  const tab = activeTab();
  if (tab.doc || !isTextTab(tab)) {
    const fresh = createTab();
    if (fresh) selectTab(fresh.id);
    return;
  }
  tab.content = "";
  selectTab(tab.id);
}

// --- tab bar ---

function renderTabs() {
  const list = document.getElementById("docTabList");
  list.replaceChildren();
  for (const tab of workspace.tabs) {
    const item = document.createElement("div");
    item.className = "doc-tab";
    item.dataset.tabId = tab.id;
    const main = document.createElement("button");
    main.type = "button";
    main.className = "doc-tab-main";
    main.setAttribute("role", "tab");
    main.innerHTML = '<span class="doc-tab-dot" aria-hidden="true"></span><span class="doc-tab-title"></span>';
    main.addEventListener("click", () => { if (workspace.activeId !== tab.id) selectTab(tab.id); });
    main.addEventListener("dblclick", () => renameTab(tab));
    main.addEventListener("keydown", event => moveTabFocus(event, tab));
    item.addEventListener("auxclick", event => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id); } });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "doc-tab-close";
    close.textContent = "×";
    close.addEventListener("click", () => closeTab(tab.id));
    item.append(main, close);
    list.append(item);
    updateTabChrome(tab, item);
  }
  const closeAll = document.getElementById("closeAllTabsBtn");
  if (closeAll) closeAll.hidden = workspace.tabs.length < 2;
  list.querySelector(".doc-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function updateTabChrome(tab, item = document.querySelector(`.doc-tab[data-tab-id="${tab.id}"]`)) {
  if (!item) return;
  const active = tab.id === workspace.activeId;
  const dirty = isDirty(tab);
  const title = tabTitle(tab);
  const text = isTextTab(tab);
  const state = !text ? "ابزار" : !tab.doc ? "پیش‌نویس ذخیره‌نشده" : dirty ? "تغییرات ذخیره‌نشده" : !canEditTab(tab) ? "فقط خواندنی" : "ذخیره‌شده";
  item.classList.toggle("active", active);
  item.classList.toggle("draft", text && !tab.doc);
  item.classList.toggle("tool", !text);
  item.classList.toggle("dirty", dirty);
  item.classList.toggle("readonly", text && !canEditTab(tab));
  const main = item.querySelector(".doc-tab-main");
  main.setAttribute("aria-selected", String(active));
  main.tabIndex = active ? 0 : -1;
  main.title = `${title} — ${state}${tab.doc ? " (دوبار کلیک برای تغییر نام)" : ""}`;
  item.querySelector(".doc-tab-title").textContent = title;
  item.querySelector(".doc-tab-close").setAttribute("aria-label", `بستن ${title}`);
  if (active && text) updateSaveButton(tab);
}

function updateSaveButton(tab) {
  const button = document.getElementById("saveBtn");
  if (!button) return;
  const saved = tab.doc && !isDirty(tab);
  button.classList.toggle("is-saved", !!saved);
  const label = button.querySelector("span");
  if (label) label.textContent = saved ? "ذخیره‌شده" : "ذخیره";
  button.title = !tab.doc ? "ذخیره در کتابخانه (Ctrl+S)" : !canEditTab(tab) ? "ذخیرهٔ یک نسخه در کتابخانهٔ خودتان (Ctrl+S)" : saved ? "همهٔ تغییرات ذخیره شده است" : "ذخیرهٔ تغییرات (Ctrl+S)";
}

function moveTabFocus(event, tab) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const index = workspace.tabs.indexOf(tab);
  const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
  const step = (event.key === "ArrowLeft") === rtl ? 1 : -1;
  const next = event.key === "Home" ? 0 : event.key === "End" ? workspace.tabs.length - 1 : (index + step + workspace.tabs.length) % workspace.tabs.length;
  selectTab(workspace.tabs[next].id);
  document.querySelector(`.doc-tab[data-tab-id="${workspace.tabs[next].id}"] .doc-tab-main`)?.focus();
}

async function renameTab(tab) {
  if (!isTextTab(tab)) return;
  if (!tab.doc) { libraryToast("عنوان متن هنگام ذخیره تعیین می‌شود."); return; }
  const doc = library.documents.find(item => item.id === tab.doc.id);
  if (doc) await renameDocument(doc);
}

// --- library links ---

function workspaceOpenDocumentIds() {
  return new Set(workspace.tabs.filter(tab => tab.doc).map(tab => tab.doc.id));
}

/** Opens a saved document, focusing its tab if it is already open. */
async function workspaceOpenDocument(id) {
  const existing = workspace.tabs.find(tab => tab.doc?.id === id);
  if (existing) { selectTab(existing.id); return; }
  try {
    const doc = await libraryApi(`/documents/${id}`);
    const tab = textTabForNewContent();
    if (!tab) return;
    tab.doc = docState(doc);
    tab.content = doc.content;
    selectTab(tab.id);
    renderLibrary();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    libraryToast(error.status === 404 ? "این متن دیگر در دسترس نیست." : error.message, true);
    refreshLibrarySafely();
  }
}

/**
 * Applies the server's copy of a document to the tabs showing it. A tab with
 * unsaved edits keeps them; it only adopts the new version when the saved
 * body did not change (a rename or move), so real conflicts still surface.
 */
function workspaceDocumentUpdated(doc) {
  for (const tab of workspace.tabs) {
    if (tab.doc?.id !== doc.id) continue;
    const clean = !isDirty(tab);
    if (clean || doc.content === undefined || doc.content === tab.doc.content) {
      tab.doc = { ...tab.doc, ...docState(doc), content: doc.content ?? tab.doc.content };
      if (clean && tab.content !== tab.doc.content) {
        tab.content = tab.doc.content;
        if (tab.id === workspace.activeId) showTab(tab);
      }
    } else {
      tab.doc = { ...tab.doc, title: doc.title, folderId: doc.folderId, role: doc.role ?? tab.doc.role };
    }
    updateTabChrome(tab);
  }
  persistWorkspace();
}

/** The document is gone (deleted, or access ended): its tabs become drafts. */
function workspaceDocumentRemoved(id) {
  for (const tab of workspace.tabs) if (tab.doc?.id === id) { tab.doc = null; updateTabChrome(tab); }
  persistWorkspace();
}

function workspaceForgetSavedDocuments() {
  workspace.tabs = workspace.tabs.filter(tab => !tab.doc);
  if (!workspace.tabs.length) workspace.tabs.push({ id: newTabId(), content: "", doc: null });
  if (!activeTab()) workspace.activeId = workspace.tabs[0].id;
  selectTab(workspace.activeId);
  persistWorkspace(true);
}

/** Keeps titles, folders and roles of open tabs in step with the library list. */
function workspaceLibraryChanged() {
  for (const tab of workspace.tabs) {
    if (!tab.doc) continue;
    const summary = library.documents.find(doc => doc.id === tab.doc.id);
    if (!summary) continue;
    const role = summary.folderId ? folderById(summary.folderId)?.role ?? tab.doc.role : "owner";
    tab.doc = { ...tab.doc, title: summary.title, folderId: summary.folderId, role };
    if (summary.version !== tab.doc.version && tab.id === workspace.activeId) syncTab(tab);
    updateTabChrome(tab);
  }
  persistWorkspace();
}

/** Refreshes a linked tab from the server (someone may have edited it). */
async function syncTab(tab) {
  if (!tab.doc) return;
  const docId = tab.doc.id;
  try {
    await libraryReady; // the guest session cookie is settled first
    const doc = await libraryApi(`/documents/${docId}`);
    if (tab.doc?.id === docId) workspaceDocumentUpdated(doc);
  } catch (error) {
    if (error.status === 404 && tab.doc?.id === docId) {
      workspaceDocumentRemoved(docId);
      libraryToast(`«${tabTitle(tab)}» دیگر در کتابخانه در دسترس نیست؛ متن آن به‌صورت پیش‌نویس در همین زبانه ماند.`, true);
    }
  }
}

// --- saving ---

let savingTab = false;

async function saveActiveTab() {
  if (savingTab) return;
  const tab = activeTab();
  if (!isTextTab(tab)) return;
  if (!tab.content.trim()) { libraryToast("ابتدا متنی بنویسید.", true); input.focus(); return; }
  savingTab = true;
  try {
    await libraryReady;
    if (!tab.doc) await saveAsNew(tab);
    else if (!canEditTab(tab)) await saveAsNew(tab, "دسترسی شما به این متن فقط خواندنی است؛ یک نسخه از آن در کتابخانهٔ خودتان ذخیره می‌شود.");
    else if (!isDirty(tab)) libraryToast("همهٔ تغییرات ذخیره شده است.");
    else await saveChanges(tab);
  } catch (error) {
    libraryToast(`ذخیره انجام نشد: ${error.message}`, true);
  } finally { savingTab = false; }
}

async function saveChanges(tab) {
  const content = tab.content;
  try {
    const doc = await libraryApi(`/documents/${tab.doc.id}`, "PATCH", { content, version: tab.doc.version });
    tab.doc = docState(doc);
    updateTabChrome(tab);
    persistWorkspace();
    libraryToast("ذخیره شد.");
    refreshLibrarySafely();
  } catch (error) {
    if (error.code === "VERSION_CONFLICT") await resolveConflict(tab);
    else if (error.status === 404) {
      workspaceDocumentRemoved(tab.doc.id);
      await saveAsNew(tab, "این متن دیگر در کتابخانه در دسترس نیست. آن را به‌عنوان متن تازه ذخیره کنید.");
    } else throw error;
  }
}

async function saveAsNew(tab, description = "") {
  if (!library.loaded) await refreshLibrary();
  const choice = await askSaveDestination({ title: tabTitle(tab), description });
  if (!choice) return;
  let folderId = choice.folderId;
  if (choice.newFolderName) {
    const folder = await libraryApi("/folders", "POST", { name: choice.newFolderName });
    folderId = folder.id;
  }
  const doc = await libraryApi("/documents", "POST", { title: choice.title, content: tab.content, folderId });
  tab.doc = docState(doc);
  try { localStorage.setItem(LAST_FOLDER_KEY, folderId || ""); } catch (_) { /* Optional convenience. */ }
  if (folderId) { openFolders.add(folderId); rememberOpenFolders(); }
  updateTabChrome(tab);
  persistWorkspace();
  libraryToast("در کتابخانه ذخیره شد.");
  refreshLibrarySafely();
}

/** The save dialog: title plus destination folder, optionally a new folder. */
function askSaveDestination({ title, description, folderId = undefined, confirm = "ذخیره" }) {
  const dialog = document.getElementById("saveDialog");
  const form = document.getElementById("saveDialogForm");
  const titleField = document.getElementById("saveTitle");
  const folderField = document.getElementById("saveFolder");
  const newFolderLabel = document.getElementById("saveNewFolderLabel");
  const newFolderField = document.getElementById("saveNewFolder");
  document.getElementById("saveDialogDescription").textContent = description;
  document.getElementById("saveDialogDescription").hidden = !description;
  titleField.value = title;
  newFolderField.value = "";
  folderField.replaceChildren(new Option("بدون پوشه", ""));
  const group = (label, folders) => {
    if (!folders.length) return;
    const node = document.createElement("optgroup");
    node.label = label;
    for (const folder of folders) node.append(new Option(folder.name, folder.id));
    folderField.append(node);
  };
  group("پوشه‌های من", library.folders.filter(folder => folder.role === "owner"));
  group("اشتراکی با من", library.folders.filter(folder => folder.role !== "owner" && canEditRole(folder.role)));
  folderField.append(new Option("＋ پوشهٔ تازه…", "__new__"));
  let last = "";
  try { last = localStorage.getItem(LAST_FOLDER_KEY) || ""; } catch (_) { /* Optional. */ }
  const preferred = folderId === undefined ? last : folderId || "";
  folderField.value = [...folderField.options].some(option => option.value === preferred) ? preferred : "";
  document.getElementById("saveSubmit").textContent = confirm;
  const toggleNewFolder = () => {
    newFolderLabel.hidden = folderField.value !== "__new__";
    newFolderField.required = !newFolderLabel.hidden;
  };
  toggleNewFolder();
  folderField.onchange = () => { toggleNewFolder(); if (!newFolderLabel.hidden) newFolderField.focus(); };
  dialog.showModal();
  titleField.focus();
  titleField.select();
  return new Promise(resolve => {
    const finish = result => {
      form.removeEventListener("submit", onSubmit);
      document.getElementById("saveCancel").removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      resolve(result);
    };
    const onSubmit = event => {
      event.preventDefault();
      const value = titleField.value.trim();
      if (!value) return;
      const creating = folderField.value === "__new__";
      finish({ title: value, folderId: creating ? null : folderField.value || null, newFolderName: creating ? newFolderField.value.trim() : null });
    };
    const onCancel = event => { event.preventDefault(); finish(null); };
    form.addEventListener("submit", onSubmit);
    document.getElementById("saveCancel").addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel);
  });
}

async function resolveConflict(tab) {
  const choice = await libraryAsk({
    title: "این متن جای دیگری تغییر کرده است",
    description: "از وقتی این زبانه باز شده، نسخهٔ کتابخانه تغییر کرده است. نوشتهٔ شما در این زبانه سالم است.",
    label: "چه کنیم؟",
    options: [
      { label: "نسخهٔ تازه در زبانهٔ دیگر باز شود؛ نوشتهٔ من پیش‌نویس بماند", value: "open" },
      { label: "نوشتهٔ من جایگزین نسخهٔ کتابخانه شود", value: "overwrite" },
      { label: "نوشتهٔ من به‌عنوان متن جدا ذخیره شود", value: "copy" },
    ],
    confirm: "ادامه",
  });
  if (!choice) { libraryToast("نوشتهٔ شما در زبانه ماند و ذخیره نشد."); return; }
  const docId = tab.doc.id;
  if (choice === "overwrite") {
    const latest = await libraryApi(`/documents/${docId}`);
    tab.doc = { ...tab.doc, version: latest.version };
    await saveChanges(tab);
    return;
  }
  workspaceDocumentRemoved(docId);
  if (choice === "copy") await saveAsNew(tab);
  else await workspaceOpenDocument(docId);
}

// --- startup ---

loadWorkspace();
input.addEventListener("input", workspaceInput);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && activeTab()) syncTab(activeTab()); });
if (location.pathname === "/date") openDateTab();
else {
  // Every page load opens on a blank tab; earlier tabs stay in the tab bar.
  selectTab(startOnBlankTab().id);
  if (isTextTab(activeTab()) && !activeTab().content.trim()) input.focus();
}
