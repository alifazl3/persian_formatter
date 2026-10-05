/* Library: saved documents, folders, folder sharing and the passkey account.
   Unsaved texts live only in the document tabs (workspace.js). */
const libraryEl = id => document.getElementById(id);
const library = { folders: [], documents: [], loaded: false, query: "" };
const OPEN_FOLDERS_KEY = "pf_open_folders";
const openFolders = new Set(readOpenFolders());

function readOpenFolders() {
  try { return JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY) || "[]"); } catch (_) { return []; }
}
function rememberOpenFolders() {
  try { localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...openFolders])); } catch (_) { /* Optional convenience. */ }
}

// --- API ---

async function libraryApi(path, method = "GET", body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch("/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || data.message || `خطای ${response.status}`);
    error.status = response.status;
    error.code = data.error?.code;
    throw error;
  }
  return data;
}

// --- shared helpers ---

const ROLE_LABELS = { owner: "مالک", read: "فقط خواندن", edit: "ویرایش متن‌ها", full: "مدیریت پوشه" };
const accessLabel = access => ROLE_LABELS[access] || access;
const canEditRole = role => role === "owner" || role === "edit" || role === "full";
const canManageRole = role => role === "owner" || role === "full";
const libraryDate = value => value ? new Date(value).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" }) : "بدون پایان";
const folderById = id => library.folders.find(folder => folder.id === id);
const documentRole = doc => doc.folderId ? folderById(doc.folderId)?.role ?? "read" : "owner";

function libraryNotice(message, error = false, target = "libraryMessage") {
  const el = libraryEl(target);
  el.textContent = message;
  el.classList.toggle("error", error);
}
let libraryToastTimer;
function libraryToast(message, error = false) {
  const toast = libraryEl("libraryToast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  clearTimeout(libraryToastTimer);
  libraryToastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
}

/** Modal prompt: a confirmation, a text field (label) or a choice (options). */
function libraryAsk({ title, description = "", label = "", value = "", options = null, confirm = "تأیید", destructive = false, maxLength = 200 }) {
  const dialog = libraryEl("libraryDialog");
  const form = libraryEl("libraryDialogForm");
  const previous = libraryEl("libraryDialogInput");
  const field = options ? document.createElement("select") : document.createElement("input");
  field.id = "libraryDialogInput";
  if (options) for (const option of options) field.add(new Option(option.label, option.value));
  else { field.type = "text"; field.maxLength = maxLength; field.value = value; field.required = !!label; }
  previous.replaceWith(field);
  if (options && value) field.value = value;
  libraryEl("libraryDialogFieldLabel").hidden = !label;
  libraryEl("libraryDialogTitle").textContent = title;
  libraryEl("libraryDialogDescription").textContent = description;
  libraryEl("libraryDialogDescription").hidden = !description;
  libraryEl("libraryDialogLabel").textContent = label;
  const submit = libraryEl("libraryDialogSubmit");
  submit.textContent = confirm;
  submit.classList.toggle("destructive", destructive);
  dialog.showModal();
  if (label) { field.focus(); if (!options) field.select(); }
  return new Promise(resolve => {
    const finish = result => {
      form.removeEventListener("submit", onSubmit);
      libraryEl("libraryDialogCancel").removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      resolve(result);
    };
    const onSubmit = event => { event.preventDefault(); finish(label ? field.value.trim() : true); };
    const onCancel = event => { event.preventDefault(); finish(null); };
    form.addEventListener("submit", onSubmit);
    libraryEl("libraryDialogCancel").addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel);
  });
}

function libraryButton(label, action, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener("click", action);
  return button;
}
const libraryIcons = {
  delete: '<path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v7m4-7v7"/>',
  rename: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4L16.5 3.5Z"/>',
  share: '<circle cx="18" cy="5" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="19" r="2"/><path d="m8 11 8-5M8 13l8 5"/>',
  move: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3V7Zm5 6h8m-3-3 3 3-3 3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  leave: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11"/>',
};
function libraryIconButton(icon, label, action) {
  const button = libraryButton("", event => { event.stopPropagation(); action(); }, `library-icon-button library-icon-${icon}`);
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${libraryIcons[icon]}</svg>`;
  return button;
}
function libraryText(parent, tag, value, className = "") {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

// --- library tree ---

async function refreshLibrary() {
  const data = await libraryApi("/library");
  library.folders = data.folders;
  library.documents = data.documents;
  library.loaded = true;
  renderLibrary();
  if (typeof workspaceLibraryChanged === "function") workspaceLibraryChanged();
}
async function refreshLibrarySafely() {
  try { await refreshLibrary(); } catch (error) { libraryNotice(error.message, true); }
}

function renderLibrary() {
  const root = libraryEl("libraryTree");
  root.replaceChildren();
  const query = library.query.trim().toLowerCase();
  const matches = doc => !query || doc.title.toLowerCase().includes(query);
  const docsIn = folderId => library.documents.filter(doc => doc.folderId === folderId && matches(doc));
  const own = library.folders.filter(folder => folder.role === "owner");
  const shared = library.folders.filter(folder => folder.role !== "owner");
  const unfiled = docsIn(null);

  if (!library.folders.length && !library.documents.length) {
    libraryText(root, "p", library.loaded ? "هنوز چیزی ذخیره نکرده‌اید. متن را بنویسید و «ذخیره» را بزنید تا اینجا بیاید." : "در حال بارگذاری…", "library-empty");
    return;
  }

  const section = (title, folders, emptyText) => {
    const visible = query ? folders.filter(folder => docsIn(folder.id).length || folder.name.toLowerCase().includes(query)) : folders;
    if (!visible.length && !emptyText) return;
    const box = document.createElement("section"); box.className = "library-section";
    libraryText(box, "h3", title);
    if (!visible.length) libraryText(box, "p", emptyText, "library-empty");
    for (const folder of visible) box.append(renderFolder(folder, docsIn(folder.id), !!query));
    root.append(box);
  };
  section("پوشه‌های من", own, query ? "" : "برای منظم کردن متن‌ها پوشه بسازید یا هنگام ذخیره یکی انتخاب کنید.");
  section("اشتراکی با من", shared, "");

  if (unfiled.length || !query) {
    const box = document.createElement("section"); box.className = "library-section library-unfiled";
    libraryText(box, "h3", "بدون پوشه");
    const list = document.createElement("div"); list.className = "library-documents";
    renderDocuments(list, unfiled);
    box.append(list);
    makeDropTarget(box, null);
    root.append(box);
  }
  if (query && !root.querySelector(".library-doc")) libraryText(root, "p", "متنی با این عنوان پیدا نشد.", "library-empty");
}

function renderFolder(folder, docs, expandForSearch) {
  const row = document.createElement("section"); row.className = "library-folder";
  row.dataset.folderId = folder.id;
  const heading = document.createElement("div"); heading.className = "library-folder-heading";
  const contents = document.createElement("div"); contents.className = "library-documents library-folder-items";
  contents.id = `library-folder-${folder.id}`;
  renderDocuments(contents, docs);
  const open = expandForSearch || openFolders.has(folder.id);
  contents.hidden = !open;

  const toggle = libraryButton("", () => {
    const expanded = contents.hidden;
    contents.hidden = !expanded;
    toggle.setAttribute("aria-expanded", String(expanded));
    if (expanded) openFolders.add(folder.id); else openFolders.delete(folder.id);
    rememberOpenFolders();
  }, "library-folder-toggle");
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-controls", contents.id);
  toggle.title = folder.name;
  toggle.innerHTML = '<span class="library-folder-chevron" aria-hidden="true">▸</span><span class="library-folder-name"></span><span class="library-badges"></span><span class="library-folder-count"></span>';
  toggle.querySelector(".library-folder-name").textContent = folder.name;
  const badges = toggle.querySelector(".library-badges");
  if (folder.role !== "owner") libraryText(badges, "span", accessLabel(folder.role), "library-badge");
  else if (folder.memberCount) libraryText(badges, "span", `${folder.memberCount.toLocaleString("fa-IR")} نفر`, "library-badge shared").title = "این پوشه با دیگران به اشتراک گذاشته شده است";
  toggle.querySelector(".library-folder-count").textContent = folder.documentCount.toLocaleString("fa-IR");

  const actions = document.createElement("div"); actions.className = "library-row-actions";
  if (folder.role === "owner") actions.append(libraryIconButton("share", `اشتراک پوشهٔ ${folder.name}`, () => openFolderShare(folder)));
  if (canManageRole(folder.role)) {
    actions.append(libraryIconButton("rename", `تغییر نام پوشهٔ ${folder.name}`, () => renameFolder(folder)));
    actions.append(libraryIconButton("delete", `حذف پوشهٔ ${folder.name}`, () => deleteFolder(folder)));
  }
  if (folder.role !== "owner") actions.append(libraryIconButton("leave", `خروج از پوشهٔ ${folder.name}`, () => leaveFolder(folder)));
  heading.append(toggle, actions);
  row.append(heading, contents);
  if (canEditRole(folder.role)) makeDropTarget(row, folder.id);
  return row;
}

function renderDocuments(root, docs) {
  if (!docs.length) { libraryText(root, "p", "خالی است.", "library-empty"); return; }
  const openIds = typeof workspaceOpenDocumentIds === "function" ? workspaceOpenDocumentIds() : new Set();
  for (const doc of docs) {
    const role = documentRole(doc);
    const row = document.createElement("div"); row.className = "library-doc";
    row.dataset.documentId = doc.id;
    if (openIds.has(doc.id)) row.classList.add("is-open");
    const main = libraryButton("", () => workspaceOpenDocument(doc.id), "library-doc-title");
    libraryText(main, "span", doc.title, "library-doc-name");
    libraryText(main, "small", libraryDate(doc.updatedAt), "library-doc-date");
    main.title = `${doc.title} — آخرین تغییر: ${libraryDate(doc.updatedAt)}`;
    main.setAttribute("aria-label", `باز کردن ${doc.title}`);
    const actions = document.createElement("div"); actions.className = "library-row-actions";
    actions.append(libraryIconButton("share", `لینک عمومی از ${doc.title}`, () => shareDocumentSnapshot(doc)));
    if (role === "owner") actions.append(libraryIconButton("move", `انتقال ${doc.title}`, () => moveDocument(doc)));
    actions.append(libraryIconButton("copy", role === "owner" ? `ساخت کپی از ${doc.title}` : `کپی ${doc.title} در کتابخانهٔ من`, () => copyDocument(doc)));
    if (canEditRole(role)) {
      actions.append(libraryIconButton("rename", `تغییر نام ${doc.title}`, () => renameDocument(doc)));
      actions.append(libraryIconButton("delete", `حذف ${doc.title}`, () => deleteDocument(doc)));
    }
    row.draggable = true;
    row.addEventListener("dragstart", event => {
      draggedDocument = doc;
      event.dataTransfer.setData("application/x-pf-document", doc.id);
      event.dataTransfer.effectAllowed = "copyMove";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => { draggedDocument = null; row.classList.remove("dragging"); });
    row.append(main, actions);
    root.append(row);
  }
}

let draggedDocument = null;

/** Own documents move between own folders; anything else dropped becomes a copy. */
const dropMoves = (doc, folderId) => documentRole(doc) === "owner" && (!folderId || folderById(folderId)?.role === "owner");

function makeDropTarget(element, folderId) {
  const accepts = event => event.dataTransfer?.types?.includes("application/x-pf-document") && draggedDocument?.folderId !== folderId;
  element.addEventListener("dragover", event => {
    if (!accepts(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = draggedDocument && !dropMoves(draggedDocument, folderId) ? "copy" : "move";
    element.classList.add("drop-target");
  });
  element.addEventListener("dragleave", event => {
    if (!element.contains(event.relatedTarget)) element.classList.remove("drop-target");
  });
  element.addEventListener("drop", event => {
    element.classList.remove("drop-target");
    if (!accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const doc = library.documents.find(item => item.id === event.dataTransfer.getData("application/x-pf-document"));
    if (!doc || doc.folderId === folderId) return;
    if (dropMoves(doc, folderId)) moveDocumentTo(doc, folderId);
    else copyDocument(doc, folderId, true);
  });
}

// --- document actions ---

async function renameDocument(doc) {
  const title = await libraryAsk({ title: "تغییر نام متن", label: "نام تازه", value: doc.title, confirm: "ذخیرهٔ نام" });
  if (!title || title === doc.title) return;
  try {
    const updated = await libraryApi(`/documents/${doc.id}`, "PATCH", { title, version: doc.version });
    workspaceDocumentUpdated(updated);
    await refreshLibrary();
  } catch (error) { libraryToast(conflictMessage(error), true); await refreshLibrarySafely(); }
}

async function moveDocument(doc) {
  const options = [{ label: "بدون پوشه", value: "" }, ...library.folders.filter(folder => folder.role === "owner").map(folder => ({ label: folder.name, value: folder.id }))];
  const choice = await libraryAsk({ title: "انتقال متن", label: "پوشهٔ مقصد", value: doc.folderId || "", options, confirm: "انتقال" });
  if (choice === null || (choice || null) === doc.folderId) return;
  await moveDocumentTo(doc, choice || null);
}

async function moveDocumentTo(doc, folderId) {
  const folder = folderId && folderById(folderId);
  if (folder?.memberCount && !await libraryAsk({ title: "انتقال به پوشهٔ اشتراکی", description: `پوشهٔ «${folder.name}» با ${folder.memberCount.toLocaleString("fa-IR")} نفر به اشتراک گذاشته شده است و آن‌ها این متن را خواهند دید.`, confirm: "انتقال" })) return;
  try {
    const updated = await libraryApi(`/documents/${doc.id}`, "PATCH", { folderId, version: doc.version });
    workspaceDocumentUpdated(updated);
    if (folderId) { openFolders.add(folderId); rememberOpenFolders(); }
    await refreshLibrary();
    libraryToast(folderId ? `به «${folder?.name ?? "پوشه"}» منتقل شد.` : "به «بدون پوشه» منتقل شد.");
  } catch (error) { libraryToast(conflictMessage(error), true); await refreshLibrarySafely(); }
}

async function deleteDocument(doc) {
  const folder = doc.folderId && folderById(doc.folderId);
  const shared = folder && (folder.role !== "owner" || folder.memberCount);
  if (!await libraryAsk({ title: "حذف متن", description: `«${doc.title}» از کتابخانه حذف شود؟${shared ? " این متن برای همهٔ اعضای پوشه حذف می‌شود." : ""} اگر در زبانه‌ای باز باشد، به‌صورت پیش‌نویس ذخیره‌نشده باقی می‌ماند.`, confirm: "حذف", destructive: true })) return;
  try {
    await libraryApi(`/documents/${doc.id}?version=${doc.version}`, "DELETE");
    workspaceDocumentRemoved(doc.id);
    await refreshLibrary();
    libraryToast("متن حذف شد.");
  } catch (error) { libraryToast(conflictMessage(error), true); await refreshLibrarySafely(); }
}

function conflictMessage(error) {
  return error.code === "VERSION_CONFLICT" ? "این متن همین حالا جای دیگری تغییر کرد؛ فهرست به‌روز شد، دوباره امتحان کنید." : error.message;
}

/**
 * Saves an independent copy of a document in a folder the user can write to.
 * Documents in someone else's folder cannot be moved out (they stay the
 * owner's), so copying is how a member keeps their own version.
 */
async function copyDocument(doc, folderId = undefined, dropped = false) {
  try {
    const full = await libraryApi(`/documents/${doc.id}`);
    const mine = documentRole(doc) === "owner";
    const choice = await askSaveDestination({
      title: mine ? `${full.title} (کپی)` : full.title,
      folderId,
      description: dropped && !mine
        ? "این متن مال صاحب پوشهٔ اشتراکی است و جابه‌جا نمی‌شود؛ یک نسخهٔ مستقل از آن ذخیره می‌شود و اصل متن سر جایش می‌ماند."
        : "یک نسخهٔ مستقل ذخیره می‌شود؛ تغییرات بعدی آن روی متن اصلی اثری ندارد.",
      confirm: "ذخیرهٔ کپی",
    });
    if (!choice) return;
    let target = choice.folderId;
    if (choice.newFolderName) target = (await libraryApi("/folders", "POST", { name: choice.newFolderName })).id;
    await libraryApi("/documents", "POST", { title: choice.title, content: full.content, folderId: target });
    if (target) { openFolders.add(target); rememberOpenFolders(); }
    await refreshLibrary();
    libraryToast("کپی ذخیره شد.");
  } catch (error) { libraryToast(error.message, true); }
}

/** A public, independent snapshot (/s/:id) of a saved document. */
async function shareDocumentSnapshot(doc) {
  try {
    if (!await libraryAsk({ title: "ساخت لینک عمومی", description: "یک نسخهٔ مستقل و عمومی از این متن ساخته می‌شود که هرکس با لینک می‌تواند ببیند. تغییر یا حذف بعدی متن، روی آن نسخه اثری ندارد.", confirm: "ساخت لینک" })) return;
    const full = await libraryApi(`/documents/${doc.id}`);
    const result = await libraryApi("/shares", "POST", { content: full.content });
    const url = `${location.origin}/s/${result.id}`;
    showShareToast(url);
    try { await navigator.clipboard.writeText(url); } catch (_) { /* The link stays visible for manual copy. */ }
  } catch (error) { libraryToast(error.message, true); }
}

// --- folder actions ---

async function createFolder(name) {
  name = name || await libraryAsk({ title: "پوشهٔ جدید", label: "نام پوشه", maxLength: 100, confirm: "ساخت پوشه" });
  if (!name) return null;
  try {
    const folder = await libraryApi("/folders", "POST", { name });
    openFolders.add(folder.id); rememberOpenFolders();
    await refreshLibrarySafely();
    return folder;
  } catch (error) { libraryToast(error.message, true); return null; }
}

async function renameFolder(folder) {
  const name = await libraryAsk({ title: "تغییر نام پوشه", label: "نام تازه", value: folder.name, maxLength: 100, confirm: "ذخیرهٔ نام" });
  if (!name || name === folder.name) return;
  try { await libraryApi(`/folders/${folder.id}`, "PATCH", { name }); await refreshLibrary(); }
  catch (error) { libraryToast(error.message, true); }
}

async function deleteFolder(folder) {
  const shared = folder.role !== "owner" || folder.memberCount;
  const choice = await libraryAsk({
    title: `حذف پوشهٔ «${folder.name}»`,
    description: `${shared ? "این پوشه برای همهٔ اعضای آن حذف می‌شود. " : ""}با متن‌های داخل آن چه کنیم؟`,
    label: "متن‌های داخل پوشه",
    options: [
      { label: "نگه‌داشتن در «بدون پوشه»", value: "keep" },
      { label: "حذف همراه پوشه", value: "delete" },
    ],
    value: "keep", confirm: "حذف پوشه", destructive: true,
  });
  if (!choice) return;
  try {
    await libraryApi(`/folders/${folder.id}${choice === "delete" ? "?documents=delete" : ""}`, "DELETE");
    if (choice === "delete") for (const doc of library.documents) if (doc.folderId === folder.id) workspaceDocumentRemoved(doc.id);
    openFolders.delete(folder.id); rememberOpenFolders();
    await refreshLibrary();
    libraryToast("پوشه حذف شد.");
  } catch (error) { libraryToast(error.message, true); }
}

async function leaveFolder(folder) {
  if (!await libraryAsk({ title: "خروج از پوشه", description: `پوشهٔ «${folder.name}» از کتابخانهٔ شما برداشته شود؟ برای بازگشت، لینک تازه از مالک لازم است.`, confirm: "خروج", destructive: true })) return;
  try {
    await libraryApi(`/folders/${folder.id}/membership`, "DELETE");
    for (const doc of library.documents) if (doc.folderId === folder.id) workspaceDocumentRemoved(doc.id);
    await refreshLibrary();
  } catch (error) { libraryToast(error.message, true); }
}

// --- folder sharing dialog (owner only) ---

let shareDialogFolder = null;

async function openFolderShare(folder) {
  shareDialogFolder = folder;
  libraryEl("folderShareTitle").textContent = `اشتراک پوشهٔ «${folder.name}»`;
  libraryEl("folderShareResult").hidden = true;
  libraryEl("folderShareLabel").value = "";
  libraryEl("folderShareMessage").textContent = "";
  libraryEl("folderShareDialog").showModal();
  await loadFolderShare();
}

async function loadFolderShare() {
  const folder = shareDialogFolder;
  if (!folder) return;
  try {
    const [{ links }, { members }] = await Promise.all([
      libraryApi(`/folders/${folder.id}/links`),
      libraryApi(`/folders/${folder.id}/members`),
    ]);
    renderShareLinks(links);
    renderShareMembers(members);
  } catch (error) { libraryNotice(error.message, true, "folderShareMessage"); }
}

function renderShareLinks(links) {
  const root = libraryEl("folderShareLinks");
  root.replaceChildren();
  if (!links.length) { libraryText(root, "p", "هنوز لینکی ساخته نشده است.", "library-empty"); return; }
  for (const link of links) {
    const expired = link.expiresAt && new Date(link.expiresAt) <= new Date();
    const used = link.singleUse && link.useCount > 0;
    const row = document.createElement("div"); row.className = "share-row";
    const info = document.createElement("div"); info.className = "share-row-info";
    libraryText(info, "strong", link.label || "لینک بدون نام");
    libraryText(info, "small", [accessLabel(link.access), link.singleUse ? "یک‌بارمصرف" : "چندبارمصرف", `${link.useCount.toLocaleString("fa-IR")} نفر وارد شده`, expired ? "منقضی‌شده" : `تا ${libraryDate(link.expiresAt)}`, used ? "مصرف‌شده" : ""].filter(Boolean).join(" · "));
    row.append(info, libraryButton("لغو", () => revokeLink(link), "share-row-action"));
    root.append(row);
  }
}

function renderShareMembers(members) {
  const root = libraryEl("folderShareMembers");
  root.replaceChildren();
  if (!members.length) { libraryText(root, "p", "هنوز کسی به این پوشه وارد نشده است.", "library-empty"); return; }
  for (const member of members) {
    const row = document.createElement("div"); row.className = "share-row";
    const info = document.createElement("div"); info.className = "share-row-info";
    libraryText(info, "strong", member.registered ? "کاربر با حساب" : "کاربر مهمان");
    libraryText(info, "small", [accessLabel(member.access), member.linkLabel ? `با لینک «${member.linkLabel}»` : "لینک ورود حذف شده", `ورود: ${libraryDate(member.joinedAt)}`].join(" · "));
    row.append(info, libraryButton("حذف", () => removeMember(member), "share-row-action"));
    root.append(row);
  }
}

async function createFolderLink(event) {
  event.preventDefault();
  const folder = shareDialogFolder;
  const access = libraryEl("folderShareAccess").value;
  const submit = libraryEl("folderShareCreate");
  submit.disabled = true;
  try {
    if (access === "full" && !await libraryAsk({ title: "دسترسی مدیریت پوشه", description: "دارندهٔ این لینک می‌تواند نام پوشه را عوض کند و آن را حذف کند. ادامه می‌دهید؟", confirm: "ساخت لینک" })) return;
    const result = await libraryApi(`/folders/${folder.id}/links`, "POST", {
      access,
      singleUse: libraryEl("folderShareUses").value === "single",
      label: libraryEl("folderShareLabel").value.trim(),
      expiresInDays: Number(libraryEl("folderShareExpiry").value),
    });
    const url = `${location.origin}/f/${result.token}`;
    libraryEl("folderShareUrl").value = url;
    libraryEl("folderShareResult").hidden = false;
    libraryEl("folderShareUrl").select();
    try { await navigator.clipboard.writeText(url); libraryNotice("لینک ساخته و کپی شد. این آدرس فقط همین حالا نمایش داده می‌شود.", false, "folderShareMessage"); }
    catch (_) { libraryNotice("لینک ساخته شد؛ آن را کپی کنید. این آدرس فقط همین حالا نمایش داده می‌شود.", false, "folderShareMessage"); }
    await loadFolderShare();
  } catch (error) { libraryNotice(error.message, true, "folderShareMessage"); }
  finally { submit.disabled = false; }
}

async function copyFolderLink() {
  const field = libraryEl("folderShareUrl");
  field.select();
  try { await navigator.clipboard.writeText(field.value); libraryNotice("لینک کپی شد.", false, "folderShareMessage"); }
  catch (_) { document.execCommand("copy"); }
}

async function revokeLink(link) {
  if (!await libraryAsk({ title: "لغو لینک", description: `لینک «${link.label || "بدون نام"}» لغو شود؟ کسانی که با این لینک وارد شده‌اند هم دسترسی‌شان را از دست می‌دهند.`, confirm: "لغو لینک", destructive: true })) return;
  try { await libraryApi(`/folders/${shareDialogFolder.id}/links/${link.id}`, "DELETE"); await loadFolderShare(); await refreshLibrarySafely(); }
  catch (error) { libraryNotice(error.message, true, "folderShareMessage"); }
}

async function removeMember(member) {
  if (!await libraryAsk({ title: "حذف عضو", description: "دسترسی این فرد به پوشه برداشته شود؟ اگر لینک هنوز معتبر باشد، می‌تواند دوباره با آن وارد شود؛ برای جلوگیری، لینک را هم لغو کنید.", confirm: "حذف دسترسی", destructive: true })) return;
  try { await libraryApi(`/folders/${shareDialogFolder.id}/members/${member.id}`, "DELETE"); await loadFolderShare(); await refreshLibrarySafely(); }
  catch (error) { libraryNotice(error.message, true, "folderShareMessage"); }
}

function closeFolderShare() {
  shareDialogFolder = null;
  if (libraryEl("folderShareDialog").open) libraryEl("folderShareDialog").close();
}

// --- opening a shared folder link (/f/:token) ---

async function openFolderLink(token) {
  const docId = new URLSearchParams(location.search).get("item");
  history.replaceState(null, "", "/");
  try {
    const preview = await libraryApi(`/folder-links/${token}`);
    let role = preview.role;
    if (!role) {
      const accepted = await libraryAsk({
        title: `پوشهٔ «${preview.name}»`,
        description: `این پوشه با شما به اشتراک گذاشته شده است (${accessLabel(preview.access)}). با پذیرفتن، پوشه در بخش «اشتراکی با من» کتابخانهٔ شما می‌ماند.${preview.singleUse ? " این لینک یک‌بارمصرف است و با پذیرفتن مصرف می‌شود." : ""}`,
        confirm: "افزودن به کتابخانه",
      });
      if (!accepted) return;
      role = (await libraryApi(`/folder-links/${token}/join`, "POST")).role;
    }
    openFolders.add(preview.folderId); rememberOpenFolders();
    await refreshLibrary();
    libraryEl("libraryBackdrop").scrollIntoView({ behavior: "smooth", block: "nearest" });
    libraryToast(role === "owner" ? "این پوشهٔ خودتان است." : `پوشهٔ «${preview.name}» در کتابخانهٔ شماست.`);
    if (docId) await workspaceOpenDocument(docId);
  } catch (error) { libraryToast(error.message, true); }
}

// --- account (passkey) ---

function b64decode(value) { return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)); }
function b64encode(value) { return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function accountEmail() { const value = libraryEl("accountEmail").value.trim(); if (!value) throw new Error("ایمیل را وارد کنید."); return value; }
async function refreshIdentity() {
  const identity = await libraryApi("/identity");
  libraryEl("accountDialog").classList.toggle("authenticated", !!identity.email);
  libraryEl("accountSummary").textContent = identity.email || "لاگین";
  libraryEl("accountState").textContent = identity.email ? `واردشده با ${identity.email}` : "بدون ورود هم می‌توانید متن‌ها را ذخیره کنید؛ آن‌ها در همین مرورگر می‌مانند. برای دسترسی از دستگاه‌های دیگر، با ایمیل و passkey ادامه دهید.";
  libraryEl("logoutBtn").hidden = !identity.email;
  libraryEl("accountEmail").value = identity.email || "";
}
async function openAccount() {
  libraryEl("accountMessage").textContent = "";
  libraryEl("accountDialog").showModal();
  try { await refreshIdentity(); } catch (error) { libraryNotice(error.message, true, "accountMessage"); }
  if (libraryEl("accountDialog").open && !libraryEl("accountDialog").classList.contains("authenticated")) libraryEl("accountEmail").focus();
}
function closeAccount() { if (libraryEl("accountDialog").open) libraryEl("accountDialog").close(); }
async function passkeyFlow() {
  if (!window.PublicKeyCredential || !navigator.credentials) { libraryNotice("این مرورگر از passkey پشتیبانی نمی‌کند یا صفحه با اتصال امن باز نشده است.", true, "accountMessage"); return; }
  const buttons = [...libraryEl("accountDialog").querySelectorAll("button")]; buttons.forEach(b => b.disabled = true);
  try {
    const email = accountEmail();
    let mode = "login";
    let options;
    try { options = await libraryApi("/auth/login/options", "POST", { email }); }
    catch (error) {
      if (error.code !== "ACCOUNT_NOT_FOUND") throw error;
      mode = "register";
      options = await libraryApi("/auth/register/options", "POST", { email });
    }
    options.challenge = b64decode(options.challenge);
    let credential;
    if (mode === "register") {
      options.user.id = b64decode(options.user.id);
      credential = await navigator.credentials.create({ publicKey: options });
    } else {
      options.allowCredentials = options.allowCredentials.map(c => ({ ...c, id: b64decode(c.id) }));
      credential = await navigator.credentials.get({ publicKey: options });
    }
    if (!credential) throw new Error("درخواست passkey لغو شد.");
    const response = { id: credential.id, type: credential.type, response: { clientDataJSON: b64encode(credential.response.clientDataJSON) } };
    if (mode === "register") response.response.attestationObject = b64encode(credential.response.attestationObject);
    else { response.response.authenticatorData = b64encode(credential.response.authenticatorData); response.response.signature = b64encode(credential.response.signature); }
    await libraryApi(`/auth/${mode}/verify`, "POST", response);
    await refreshIdentity(); await refreshLibrary();
    closeAccount();
    libraryToast("حساب آماده است.");
  } catch (error) { libraryNotice(error.message, true, "accountMessage"); }
  finally { buttons.forEach(b => b.disabled = false); }
}
async function logoutAccount() {
  try {
    await libraryApi("/auth/logout", "POST");
    // Saved documents belong to the account; keep only unsaved drafts here.
    workspaceForgetSavedDocuments();
    await refreshIdentity(); await refreshLibrary();
    closeAccount(); libraryToast("خارج شدید.");
  } catch (error) { libraryNotice(error.message, true, "accountMessage"); }
}

// --- startup ---

async function initLibrary() {
  libraryEl("librarySearch").addEventListener("input", event => { library.query = event.target.value; renderLibrary(); });
  libraryEl("folderShareForm").addEventListener("submit", createFolderLink);
  renderLibrary();
  try {
    await refreshIdentity();
    const match = location.pathname.match(/^\/f\/([A-Za-z0-9_-]+)$/);
    if (match) await openFolderLink(match[1]);
    else await refreshLibrary();
  } catch (error) { libraryNotice(error.message, true); }
}
const libraryReady = initLibrary();
