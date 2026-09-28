/* Saved texts, folders, passkeys, and folder links. The formatter itself stays public. */
let libraryData = { folders: [], items: [] };
let sharedFolder = null;
let availableSharedFolder = null;
let activeSavedItem = null;
const libraryEl = id => document.getElementById(id);

async function libraryApi(path, method = "GET", body, shared = false) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (shared && sharedFolder) headers["X-Folder-Grant"] = sharedFolder.grant;
  const response = await fetch("/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || data.message || `خطای ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
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
function libraryAsk({ title, description = "", label = "", value = "", options = null, confirm = "تأیید", destructive = false }) {
  const dialog = libraryEl("libraryDialog");
  const form = libraryEl("libraryDialogForm");
  const field = libraryEl("libraryDialogFieldLabel");
  const previous = libraryEl("libraryDialogInput");
  const input = options ? document.createElement("select") : document.createElement("input");
  input.id = "libraryDialogInput";
  if (options) for (const option of options) input.add(new Option(option.label, option.value));
  else { input.type = "text"; input.maxLength = 200; input.value = value; input.required = !!label; }
  previous.replaceWith(input);
  if (options && value) input.value = value;
  field.hidden = !label;
  libraryEl("libraryDialogTitle").textContent = title;
  libraryEl("libraryDialogDescription").textContent = description;
  libraryEl("libraryDialogDescription").hidden = !description;
  libraryEl("libraryDialogLabel").textContent = label;
  const submit = libraryEl("libraryDialogSubmit");
  submit.textContent = confirm;
  submit.classList.toggle("destructive", destructive);
  dialog.showModal();
  if (label) input.focus();
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      form.removeEventListener("submit", onSubmit);
      libraryEl("libraryDialogCancel").removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      resolve(result);
    };
    const onSubmit = event => { event.preventDefault(); finish(label ? input.value.trim() : true); };
    const onCancel = event => { event.preventDefault(); finish(null); };
    form.addEventListener("submit", onSubmit);
    libraryEl("libraryDialogCancel").addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel);
  });
}
function libraryButton(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}
function libraryText(parent, tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  parent.append(node);
  return node;
}
async function refreshLibrary() {
  libraryEl("libraryScopeBtn").hidden = !availableSharedFolder;
  libraryEl("libraryScopeBtn").textContent = sharedFolder ? "کتابخانهٔ من" : "فولدر اشتراکی";
  if (sharedFolder) {
    const data = await libraryApi(`/folders/${sharedFolder.folderId}`, "GET", undefined, true);
    libraryData = { folders: [data.folder], items: data.items };
    libraryEl("librarySubtitle").textContent = `${data.folder.name} · دسترسی ${sharedFolder.access === "full" ? "کامل" : "فقط خواندن"}`;
  } else {
    libraryData = await libraryApi("/library");
    libraryEl("librarySubtitle").textContent = "متن‌های ذخیره‌شده و فولدرها";
  }
  renderLibrary();
}
function renderLibrary() {
  const filter = libraryEl("libraryFolderFilter");
  const previous = filter.value;
  filter.replaceChildren(new Option("همه", "all"));
  if (!sharedFolder) filter.add(new Option("بدون فولدر", "none"));
  for (const folder of libraryData.folders) filter.add(new Option(folder.name, folder.id));
  filter.value = [...filter.options].some(o => o.value === previous) ? previous : "all";
  libraryEl("libraryControls").hidden = !!sharedFolder;
  const folderRoot = libraryEl("libraryFolders");
  folderRoot.replaceChildren();
  if (!libraryData.folders.length) libraryText(folderRoot, "p", "هنوز فولدری ساخته نشده است.").className = "library-empty";
  for (const folder of libraryData.folders) {
    const row = document.createElement("div"); row.className = "library-row";
    const main = document.createElement("div"); main.className = "library-row-main";
    libraryText(main, "strong", folder.name);
    libraryText(main, "small", `${libraryData.items.filter(item => item.folder_id === folder.id).length} متن`);
    const actions = document.createElement("div"); actions.className = "library-row-actions";
    if (!sharedFolder) actions.append(libraryButton("نمایش", () => { filter.value = folder.id; renderLibraryItems(); }));
    if (!sharedFolder) actions.append(libraryButton("لینک اشتراک", () => showFolderLinks(folder)));
    if (!sharedFolder || sharedFolder.access === "full") {
      actions.append(libraryButton("تغییر نام", () => renameFolder(folder)));
      actions.append(libraryButton("حذف", () => deleteFolder(folder)));
    }
    row.append(main, actions); folderRoot.append(row);
  }
  renderLibraryItems();
}
function renderLibraryItems() {
  const root = libraryEl("libraryItems"); root.replaceChildren();
  const filter = libraryEl("libraryFolderFilter").value;
  const items = libraryData.items.filter(item => filter === "all" || (filter === "none" ? !item.folder_id : item.folder_id === filter));
  if (!items.length) libraryText(root, "p", "هنوز متنی در این بخش ذخیره نشده است.").className = "library-empty";
  for (const item of items) {
    const row = document.createElement("div"); row.className = "library-row";
    const main = document.createElement("div"); main.className = "library-row-main";
    libraryText(main, "strong", item.title);
    libraryText(main, "small", item.content.replace(/\s+/g, " ").slice(0, 120));
    const actions = document.createElement("div"); actions.className = "library-row-actions";
    actions.append(libraryButton("باز کردن", () => openSavedItem(item)));
    if (!sharedFolder || sharedFolder.access === "full") {
      if (!sharedFolder) actions.append(libraryButton("انتقال", () => moveSavedItem(item)));
      actions.append(libraryButton("حذف", () => deleteSavedItem(item)));
    }
    row.append(main, actions); root.append(row);
  }
}
async function openLibrary() {
  await libraryReady;
  libraryEl("libraryBackdrop").scrollIntoView({ behavior: "smooth", block: "nearest" });
  try { await refreshLibrary(); } catch (error) { libraryNotice(error.message, true); }
}
async function switchLibraryScope() {
  sharedFolder = sharedFolder ? null : availableSharedFolder;
  activeSavedItem = null;
  try { await refreshLibrary(); libraryNotice(""); }
  catch (error) { libraryNotice(error.message, true); }
}
async function createFolder() {
  const name = await libraryAsk({ title: "فولدر جدید", label: "نام فولدر", confirm: "ساخت فولدر" }); if (!name) return;
  try { await libraryApi("/folders", "POST", { name }); await refreshLibrary(); libraryNotice("فولدر ساخته شد."); }
  catch (error) { libraryNotice(error.message, true); }
}
async function renameFolder(folder) {
  const name = await libraryAsk({ title: "تغییر نام فولدر", label: "نام جدید", value: folder.name, confirm: "ذخیره نام" }); if (!name || name === folder.name) return;
  try { await libraryApi(`/folders/${folder.id}`, "PATCH", { name }, !!sharedFolder); await refreshLibrary(); libraryNotice("نام فولدر تغییر کرد."); }
  catch (error) { libraryNotice(error.message, true); }
}
async function deleteFolder(folder) {
  if (!await libraryAsk({ title: "حذف فولدر", description: `فولدر «${folder.name}» حذف شود؟ متن‌های آن بدون فولدر باقی می‌مانند.`, confirm: "حذف فولدر", destructive: true })) return;
  try { await libraryApi(`/folders/${folder.id}`, "DELETE", undefined, !!sharedFolder); if (sharedFolder) { sharedFolder = null; availableSharedFolder = null; history.replaceState(null, "", "/"); } await refreshLibrary(); libraryNotice("فولدر حذف شد."); }
  catch (error) { libraryNotice(error.message, true); }
}
async function moveSavedItem(item) {
  const choice = await libraryAsk({ title: "انتقال متن", label: "فولدر مقصد", options: [{ label: "بدون فولدر", value: "" }, ...libraryData.folders.map(folder => ({ label: folder.name, value: folder.id }))], confirm: "انتقال" });
  if (choice === null) return;
  const folderId = choice || null;
  try { await libraryApi(`/items/${item.id}`, "PATCH", { folderId }); await refreshLibrary(); libraryNotice("متن منتقل شد."); }
  catch (error) { libraryNotice(error.message, true); }
}
async function deleteSavedItem(item) {
  if (!await libraryAsk({ title: "حذف متن", description: `متن «${item.title}» حذف شود؟`, confirm: "حذف متن", destructive: true })) return;
  try { await libraryApi(`/items/${item.id}`, "DELETE", undefined, !!sharedFolder); if (activeSavedItem?.id === item.id) activeSavedItem = null; await refreshLibrary(); libraryNotice("متن حذف شد."); }
  catch (error) { libraryNotice(error.message, true); }
}
function openSavedItem(item) {
  input.value = item.content;
  activeSavedItem = item;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
async function saveCurrent() {
  await libraryReady;
  const content = input.value;
  if (!content.trim()) { libraryToast("ابتدا متنی وارد کنید.", true); input.focus(); return; }
  // A read-only folder cannot be changed, but its text can be copied into the
  // visitor's own library. Do not send the folder grant for that personal save.
  const personalCopy = sharedFolder?.access === "read";
  const currentTitle = activeSavedItem?.title || content.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 200) || "متن بدون عنوان";
  const title = await libraryAsk({ title: "ذخیره متن", label: "عنوان متن", value: currentTitle, confirm: "ذخیره" }); if (!title) return;
  const folderId = personalCopy ? null : sharedFolder?.folderId || (libraryEl("libraryFolderFilter").value !== "all" && libraryEl("libraryFolderFilter").value !== "none" ? libraryEl("libraryFolderFilter").value : null);
  try {
    if (activeSavedItem && (personalCopy ? activeSavedItem.folder_id === null : (!sharedFolder || activeSavedItem.folder_id === sharedFolder.folderId))) {
      activeSavedItem = await libraryApi(`/items/${activeSavedItem.id}`, "PATCH", { title, content }, !!sharedFolder && !personalCopy);
    } else {
      activeSavedItem = await libraryApi("/items", "POST", { title, content, folderId }, !!sharedFolder && !personalCopy);
    }
    await refreshLibrary();
    libraryToast(personalCopy ? "یک نسخه در کتابخانهٔ خودتان ذخیره شد." : "متن ذخیره شد.");
  } catch (error) { libraryToast(`ذخیره انجام نشد: ${error.message}`, true); }
}
async function showFolderLinks(folder) {
  libraryEl("libraryFolders").querySelector(".library-share-box")?.remove();
  const box = document.createElement("div"); box.className = "library-share-box";
  libraryText(box, "strong", `اشتراک فولدر «${folder.name}»`);
  const options = document.createElement("div"); options.className = "library-share-options";
  const access = document.createElement("select"); access.add(new Option("فقط خواندن", "read")); access.add(new Option("دسترسی کامل", "full"));
  const uses = document.createElement("select"); uses.add(new Option("چندبارمصرف", "multi")); uses.add(new Option("یک‌بارمصرف", "single"));
  options.append(access, uses, libraryButton("ساخت لینک", async () => {
    try {
      const result = await libraryApi(`/folders/${folder.id}/links`, "POST", { access: access.value, singleUse: uses.value === "single" });
      const url = `${location.origin}/f/${result.token}`;
      const line = document.createElement("div"); line.className = "library-link-result";
      const field = document.createElement("input"); field.value = url; field.readOnly = true; field.setAttribute("aria-label", "لینک اشتراک");
      line.append(field, libraryButton("کپی", async () => { await navigator.clipboard.writeText(url); libraryNotice("لینک کپی شد."); }));
      box.append(line); await listFolderLinks(folder, box);
    } catch (error) { libraryNotice(error.message, true); }
  }));
  box.append(options);
  const root = libraryEl("libraryFolders"); root.prepend(box);
  try { await listFolderLinks(folder, box); }
  catch (error) { libraryNotice(error.message, true); }
}
async function listFolderLinks(folder, box) {
  const old = box.querySelector(".library-existing-links"); old?.remove();
  const area = document.createElement("div"); area.className = "library-existing-links";
  const data = await libraryApi(`/folders/${folder.id}/links`);
  if (data.links.length) libraryText(area, "small", "لینک‌های ساخته‌شده (آدرس فقط هنگام ساخت نمایش داده می‌شود)");
  for (const link of data.links) {
    const row = document.createElement("div"); row.className = "library-row";
    libraryText(row, "span", `${link.access === "full" ? "دسترسی کامل" : "فقط خواندن"} · ${link.max_uses === 1 ? "یک‌بارمصرف" : "چندبارمصرف"} · ${link.use_count} بار استفاده${link.max_uses === 1 && link.use_count > 0 ? " · مصرف‌شده" : ""}`);
    row.append(libraryButton("لغو", async () => { try { await libraryApi(`/folders/${folder.id}/links/${link.token_hash}`, "DELETE"); await listFolderLinks(folder, box); } catch (error) { libraryNotice(error.message, true); } }));
    area.append(row);
  }
  box.append(area);
}
function b64decode(value) { return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)); }
function b64encode(value) { return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function accountEmail() { const value = libraryEl("accountEmail").value.trim(); if (!value) throw new Error("ایمیل را وارد کنید."); return value; }
async function refreshIdentity() {
  const identity = await libraryApi("/identity");
  libraryEl("accountBackdrop").classList.toggle("authenticated", !!identity.email);
  libraryEl("accountState").textContent = identity.email ? `واردشده با ${identity.email}` : "می‌توانید بدون ورود از همه قابلیت‌ها استفاده کنید. برای دسترسی در دستگاه‌های دیگر، حساب بسازید.";
  libraryEl("logoutBtn").hidden = !identity.email;
  if (identity.email) libraryEl("accountEmail").value = identity.email;
}
async function openAccount() { await libraryReady; libraryEl("accountBackdrop").scrollIntoView({ behavior: "smooth", block: "nearest" }); try { await refreshIdentity(); } catch (error) { libraryNotice(error.message, true, "accountMessage"); } }
async function passkeyFlow(mode) {
  if (!window.PublicKeyCredential || !navigator.credentials) { libraryNotice("این مرورگر از passkey پشتیبانی نمی‌کند یا صفحه با اتصال امن باز نشده است.", true, "accountMessage"); return; }
  const buttons = [...libraryEl("accountBackdrop").querySelectorAll("button")]; buttons.forEach(b => b.disabled = true);
  try {
    const email = accountEmail();
    const options = await libraryApi(`/auth/${mode}/options`, "POST", { email });
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
    libraryNotice("حساب آماده است.", false, "accountMessage");
  } catch (error) { libraryNotice(error.message, true, "accountMessage"); }
  finally { buttons.forEach(b => b.disabled = false); }
}
function registerPasskey() { return passkeyFlow("register"); }
function loginPasskey() { return passkeyFlow("login"); }
async function logoutAccount() {
  try { await libraryApi("/auth/logout", "POST"); activeSavedItem = null; await refreshIdentity(); await refreshLibrary(); libraryNotice("خارج شدید.", false, "accountMessage"); }
  catch (error) { libraryNotice(error.message, true, "accountMessage"); }
}
async function initLibrary() {
  try {
    await refreshIdentity();
    const match = location.pathname.match(/^\/f\/([A-Za-z0-9_-]+)$/);
    if (match) {
      const key = `pf_folder_${match[1]}`;
      sharedFolder = JSON.parse(sessionStorage.getItem(key) || "null");
      const hadGrant = !!sharedFolder;
      if (!sharedFolder) { sharedFolder = await libraryApi(`/folder-links/${match[1]}/redeem`, "POST"); sessionStorage.setItem(key, JSON.stringify(sharedFolder)); }
      availableSharedFolder = sharedFolder;
      try { await refreshLibrary(); }
      catch (error) {
        if (!hadGrant || error.status !== 403) throw error;
        sessionStorage.removeItem(key);
        sharedFolder = await libraryApi(`/folder-links/${match[1]}/redeem`, "POST");
        availableSharedFolder = sharedFolder;
        sessionStorage.setItem(key, JSON.stringify(sharedFolder));
        await refreshLibrary();
      }
    }
    else await refreshLibrary();
  } catch (error) { libraryNotice(error.message, true); }
}
const libraryReady = initLibrary();
